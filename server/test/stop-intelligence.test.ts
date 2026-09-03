import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import { createApp } from '../src/app.js'
import { canonicalSpeedConfiguration, hasStopIntelligenceCanonicalPolicy, stopIdentityAssociationConfiguration } from '../src/stop-intelligence/configuration.js'
import { classifyStop, hasInStopSpeedTest, type RequiredChangeoverEvidence } from '../src/stop-intelligence/classification-engine.js'
import { STOP_INTELLIGENCE_ACTION_VERSION, type CanonicalSpeedObservation, type ChangeoverAction, type PhysicalStopAnalysisInput, type PhysicalStopSegment, type StopDeckStatusContext, type StopFamilyEvidence, type StopIdentityEvidence, type StopRadiusOverlay, type TelemetryAvailabilityInterval } from '../src/stop-intelligence/contracts.js'
import { buildStopEvidence, isDirectAniloxActivitySignal, STOP_FAMILY_CANONICAL_PATTERNS, stopIdentityDefinitions } from '../src/stop-intelligence/evidence-model.js'
import { analyzePhysicalStops, bridgeMatchingSpeedStateEvidence, normalizeSpeedQuality } from '../src/stop-intelligence/physical-stop-engine.js'
import { overlayRadius } from '../src/stop-intelligence/radius-overlay.js'
import { buildDeckStatusContext, candidateClassificationSelectors, deckStatusRawCandidates, downsampleFleetRollLength, downsampleFleetSpeed, evidenceSelectors, latestSustainedGoodRunAnchor, overviewEvidenceSelectors, productionAttributeDisplayUnit, productionAttributeHistoryRanges, productionAttributeRawCandidates, pumpFrequencySelectors, selectBoundedRawEvidenceCandidates, STOP_DETAIL_RAW_EVIDENCE_LIMIT, StopIntelligenceService, stopIntelligenceStopId, uncanonicalizedRawCandidates } from '../src/stop-intelligence/service.js'
import { buildChangeoverActions, buildUncanonicalizedRawActions, detectRequiredChangeoverActivity } from '../src/stop-intelligence/action-engine.js'
import { InMemoryStopIntelligenceCorrectionRepository, STOP_OPERATOR_DECISION_STATES, StopIntelligenceCorrectionService } from '../src/stop-intelligence/correction-service.js'
import { buildChangeoverActivityWindows } from '../src/stop-intelligence/changeover-stage-engine.js'
import type { PressSemanticSignalWithIdentity, TelemetryFoundationService } from '../src/telemetry/telemetry-foundation-service.js'
import type { PressEvidenceCapabilities, RawTelemetryHistoryResponse, TelemetrySample, TelemetrySourceSignal } from '../src/telemetry/telemetry-contracts.js'
import type { TelemetryClient } from '../src/telemetry/telemetry-api-client.js'
import type { RadiusStatusSegment } from '../src/radius/models.js'
import type { RadiusService } from '../src/radius/radius-service.js'

const at = (minute: number, second = 0) => new Date(Date.UTC(2026, 7, 1, 0, minute, second)).toISOString()
const configuration = canonicalSpeedConfiguration('press14')!

function observations(values: Array<[minute: number, speed: number | null, quality?: string]>): CanonicalSpeedObservation[] {
  return values.map(([minute, speed, quality = 'GOOD']) => ({ atUtc: at(minute), speed, qualityState: quality }))
}

function telemetrySamples(values: Array<[minute: number, speed: number, quality?: string]>): TelemetrySample[] {
  return values.map(([minute, speed, qualityState = 'GOOD']) => ({ observedAtUtc: at(minute), receivedAtUtc: at(minute), sourceTimestampUtc: at(minute), qualityState, valueKind: 'numeric', value: speed }))
}

function analyze(values: Array<[minute: number, speed: number | null, quality?: string]>, availabilityIntervals?: TelemetryAvailabilityInterval[], toMinute = 20) {
  const input: PhysicalStopAnalysisInput = { configuration, fromUtc: at(0), toUtc: at(toMinute), observations: observations(values), availabilityIntervals }
  return analyzePhysicalStops(input).segments
}

test('preserves validated Press 14/15 speed identities and enables dynamic canonical policy for all registered presses', () => {
  assert.deepEqual(canonicalSpeedConfiguration('press14'), { pressKey: 'press14', sourceId: 1, canonicalSpeedSignalId: 204, canonicalId: 'machine.speed.actual', stopThreshold: 1, recoveryThreshold: 595, recoveryConfirmationSeconds: 420, matchingStateGapBridgeSeconds: 900 })
  assert.deepEqual(canonicalSpeedConfiguration('press15'), { pressKey: 'press15', sourceId: 34, canonicalSpeedSignalId: 222, canonicalId: 'machine.speed.actual', stopThreshold: 1, recoveryThreshold: 595, recoveryConfirmationSeconds: 420, matchingStateGapBridgeSeconds: 900 })
  assert.equal(canonicalSpeedConfiguration('press5'), undefined)
  assert.deepEqual(canonicalSpeedConfiguration('press5', { sourceId: 50, canonicalSpeedSignalId: 500 }), { pressKey: 'press5', sourceId: 50, canonicalSpeedSignalId: 500, canonicalId: 'machine.speed.actual', stopThreshold: 1, recoveryThreshold: 595, recoveryConfirmationSeconds: 420, matchingStateGapBridgeSeconds: 900 })
  assert.equal(canonicalSpeedConfiguration('press14', { sourceId: 99, canonicalSpeedSignalId: 999 }), undefined)
  for (const pressKey of ['press3', 'press5', 'press6', 'press7', 'press8', 'press9', 'press10', 'press11', 'press12', 'press13', 'press14', 'press15'] as const) {
    assert.equal(hasStopIntelligenceCanonicalPolicy(pressKey), true)
    assert.equal(stopIdentityAssociationConfiguration(pressKey)?.pressKey, pressKey)
  }
  assert.deepEqual(stopIdentityAssociationConfiguration('press14'), { pressKey: 'press14', identityContextBeforeSeconds: 3_600, identityContextAfterSeconds: 3_600, identitySettlingSeconds: 300 })
})

test('uses canonical Order and Recipe as primary generic identities while preserving validated Press 14/15 exceptions', () => {
  assert.deepEqual(stopIdentityDefinitions('press5').filter(({ usefulness }) => usefulness === 'STRONG').map(({ field, canonicalId }) => [field, canonicalId]), [['order', 'production.order'], ['recipe', 'production.recipe']])
  assert.deepEqual(stopIdentityDefinitions('press14').filter(({ usefulness }) => usefulness === 'STRONG').map(({ field }) => field), ['recipe'])
  assert.deepEqual(stopIdentityDefinitions('press15').filter(({ usefulness }) => usefulness === 'STRONG').map(({ field }) => field), ['order'])
})

test('normalizes both historical quality encodings without treating bad telemetry as speed', () => {
  assert.equal(normalizeSpeedQuality('true'), 'GOOD')
  assert.equal(normalizeSpeedQuality('good'), 'GOOD')
  assert.equal(normalizeSpeedQuality('false'), 'BAD')
  assert.equal(normalizeSpeedQuality('bad'), 'BAD')
  assert.equal(analyze([[0, 1_000], [1, 0, 'BAD'], [2, 0], [3, 700], [8, 700]])[0]!.startAt, at(2))
  assert.deepEqual(analyze([[0, 1_000], [1, 0, 'BAD'], [2, 1_000]]), [])
})

test('finds a simple physical stop and ends it at the successful recovery streak start', () => {
  const [segment] = analyze([[0, 1_000], [1, 0], [3, 0], [4, 700], [11, 700]])
  assert.equal(segment?.startAt, at(1))
  assert.equal(segment?.endAt, at(4))
  assert.equal(segment?.physicalDurationSeconds, 180)
  assert.equal(segment?.zeroSpeedSeconds, 180)
  assert.equal(segment?.movementAttempts.length, 1)
  assert.equal(segment?.movementAttempts[0]?.reachedRecoveryThreshold, true)
})

test('keeps slow movement inside the same stop and records the micro-start attempt', () => {
  const [segment] = analyze([[0, 1_000], [1, 0], [2, 100], [3, 300], [4, 0], [5, 700], [12, 700]])
  assert.equal(segment?.startAt, at(1))
  assert.equal(segment?.endAt, at(5))
  assert.equal(segment?.movementAttempts.length, 2)
  assert.deepEqual(segment?.movementAttempts[0], { startAt: at(2), endAt: at(4), durationSeconds: 120, averageSpeed: 200, peakSpeed: 300, reachedRecoveryThreshold: false, failedRecoveryCount: 0, sequenceNumber: 1 })
})

test('keeps a failed high-speed recovery inside the same stop', () => {
  const [segment] = analyze([[0, 1_000], [1, 0], [2, 800], [4, 0], [5, 700], [12, 700]])
  assert.equal(segment?.endAt, at(5))
  assert.equal(segment?.failedRecoveryCount, 1)
  assert.deepEqual(segment?.failedRecoveryStreaks[0], { startAt: at(2), endAt: at(4), durationSeconds: 120, reason: 'DROPPED_BELOW_RECOVERY', movementAttemptSequenceNumber: 1 })
})

test('does not treat a short above-1000 excursion as recovery', () => {
  const [segment] = analyze([[0, 1_000], [1, 0], [2, 1_200], [6, 0], [7, 800], [14, 800]])
  assert.equal(segment?.endAt, at(7))
  assert.equal(segment?.failedRecoveryCount, 1)
  assert.equal(segment?.movementAttempts[0]?.peakSpeed, 1_200)
})

test('retains multiple movement attempts, including the final successful recovery attempt', () => {
  const [segment] = analyze([[0, 0], [1, 100], [2, 0], [3, 400], [4, 0], [5, 750], [12, 750]])
  assert.equal(segment?.leftCensored, true)
  assert.equal(segment?.movementAttempts.length, 3)
  assert.deepEqual(segment?.movementAttempts.map(({ sequenceNumber, startAt, endAt }) => [sequenceNumber, startAt, endAt]), [[1, at(1), at(2)], [2, at(3), at(4)], [3, at(5), at(5)]])
})

test('requires an observed positive-speed return to zero inside the stop as the changeover speed test', () => {
  const segment = physical({ startAt: at(1), endAt: at(12) })
  assert.equal(hasInStopSpeedTest(segment, observations([[1, 0], [2, .1], [3, 0], [5, 700], [12, 700]])), true)
  assert.equal(hasInStopSpeedTest(segment, observations([[1, 0], [5, 700], [12, 700]])), false)
  assert.equal(hasInStopSpeedTest(segment, observations([[1, 0], [2, .1, 'BAD'], [3, 0]])), false)
})

test('right-censors a stop on bad quality and never carries it through the bad value', () => {
  const [segment] = analyze([[0, 1_000], [1, 0], [2, 0, 'bad']], undefined, 5)
  assert.equal(segment?.endAt, at(2))
  assert.equal(segment?.rightCensored, true)
  assert.equal(segment?.rightCensorReason, 'UNKNOWN_SPEED_QUALITY')
  assert.equal(segment?.physicalDurationSeconds, 60)
})

test('bridges a source-specific gap under 15 minutes when trusted speed is stopped on both sides', () => {
  const segments = analyze([[0, 1_000], [1, 0], [5, 0], [6, 700], [13, 700]], [{ fromUtc: at(2), toUtc: at(5), state: 'SOURCE_TELEMETRY_UNAVAILABLE' }])
  assert.equal(segments.length, 1)
  assert.deepEqual([segments[0]?.startAt, segments[0]?.endAt, segments[0]?.leftCensorReason, segments[0]?.rightCensorReason], [at(1), at(6), null, null])
  assert.equal(segments[0]?.physicalDurationSeconds, 300)
})

test('bridges bad quality under 15 minutes when trusted speed is running on both sides', () => {
  const input: PhysicalStopAnalysisInput = { configuration, fromUtc: at(0), toUtc: at(5), observations: observations([[0, 800], [2, 0, 'BAD'], [3, 900], [5, 900]]) }
  const bridged = bridgeMatchingSpeedStateEvidence(input)
  assert.deepEqual(bridged.availabilityIntervals, [])
  assert.equal(bridged.bridgedIntervals[0]?.state, 'UNKNOWN_SPEED_QUALITY')
  assert.equal(bridged.observations.some(({ qualityState }) => qualityState === 'BAD'), false)
  assert.deepEqual(analyzePhysicalStops(input).segments, [])
})

test('retains unknown separation for mixed states and gaps of exactly 15 minutes', () => {
  const mixed = bridgeMatchingSpeedStateEvidence({ configuration, fromUtc: at(0), toUtc: at(8), observations: observations([[0, 800], [5, 0], [8, 0]]), availabilityIntervals: [{ fromUtc: at(1), toUtc: at(5), state: 'SOURCE_TELEMETRY_UNAVAILABLE' }] })
  assert.equal(mixed.availabilityIntervals.length, 1)
  const exactLimit = bridgeMatchingSpeedStateEvidence({ configuration, fromUtc: at(0), toUtc: at(20), observations: observations([[0, 0], [16, 0], [20, 0]]), availabilityIntervals: [{ fromUtc: at(1), toUtc: at(16), state: 'SOURCE_TELEMETRY_UNAVAILABLE' }] })
  assert.equal(exactLimit.availabilityIntervals.length, 1)
})

test('does not invent a stop for an outage while the press is running', () => {
  assert.deepEqual(analyze([[0, 1_000], [5, 1_000]], [{ fromUtc: at(1), toUtc: at(5), state: 'SOURCE_TELEMETRY_UNAVAILABLE' }]), [])
})

test('left-censors a stop that begins at the export boundary', () => {
  const [segment] = analyze([[0, 0], [5, 0]], undefined, 8)
  assert.equal(segment?.leftCensored, true)
  assert.equal(segment?.leftCensorReason, 'RANGE_START')
  assert.equal(segment?.rightCensorReason, 'RANGE_END')
})

test('fails a recovery interrupted one second before confirmation', () => {
  const input: PhysicalStopAnalysisInput = {
    configuration,
    fromUtc: at(0),
    toUtc: at(14),
    observations: [
      { atUtc: at(0), speed: 1_000, qualityState: 'GOOD' },
      { atUtc: at(1), speed: 0, qualityState: 'GOOD' },
      { atUtc: at(2), speed: 700, qualityState: 'GOOD' },
      { atUtc: new Date(Date.parse(at(9)) - 1_000).toISOString(), speed: 500, qualityState: 'GOOD' },
    ],
  }
  const [segment] = analyzePhysicalStops(input).segments
  assert.equal(segment?.endAt, null)
  assert.equal(segment?.failedRecoveryCount, 1)
  assert.equal(segment?.failedRecoveryStreaks[0]?.durationSeconds, 419)
})

test('uses exact threshold comparisons: <1 stopped, 1-<595 movement, and >=595 recovery', () => {
  const [segment] = analyze([[0, 1_000], [1, 0.999], [2, 1], [3, 594.999], [4, 595], [11, 595]])
  assert.equal(segment?.startAt, at(1))
  assert.equal(segment?.endAt, at(4))
  assert.equal(segment?.zeroSpeedSeconds, 60)
  assert.equal(segment?.lowMovementSeconds, 120)
  assert.equal(analyze([[0, 1_000], [1, -0.01], [2, 700], [9, 700]])[0]?.startAt, at(1))
})

test('integrates transition-first intervals by elapsed time rather than averaging rows', () => {
  const [segment] = analyze([[0, 1_000], [1, 0], [3, 100], [4, 300], [8, 0], [9, 700], [16, 700]])
  assert.equal(segment?.lowMovementSeconds, 300)
  assert.equal(segment?.movementAttempts[0]?.averageSpeed, 260)
  assert.equal(segment?.movementAttempts[0]?.peakSpeed, 300)
})

test('finds only a fully observed seven-minute Good Run as a leading-stop lookback anchor', () => {
  assert.equal(latestSustainedGoodRunAnchor({ observations: observations([[-20, 800], [-10, 0]]), unavailable: [], fromUtc: at(-20), toUtc: at(0), recoveryThreshold: 595, confirmationSeconds: 420 }), at(-17))
  assert.equal(latestSustainedGoodRunAnchor({ observations: observations([[-20, 800], [-10, 0]]), unavailable: [{ fromUtc: at(-16), toUtc: at(-15), state: 'SOURCE_TELEMETRY_UNAVAILABLE' }], fromUtc: at(-20), toUtc: at(0), recoveryThreshold: 595, confirmationSeconds: 420 }), null)
  assert.equal(latestSustainedGoodRunAnchor({ observations: observations([[-6, 800], [0, 0]]), unavailable: [], fromUtc: at(-6), toUtc: at(0), recoveryThreshold: 595, confirmationSeconds: 420 }), null)
})

test('recovers a range-leading stop from hidden history and reapplies normal downtime classification', async () => {
  const requestedFromUtc: string[] = []
  const allSpeed = telemetrySamples([[-110, 800], [-90, 0], [-20, 80], [-19, 0], [20, 700], [27, 700]])
  const telemetry = {
    sources: { resolve: async () => ({ pressKey: 'press14', source: { id: 1, sourceKey: 'press14', displayName: 'Press 14', enabled: true }, metadataStatus: 'FRESH' }) },
    capabilities: { get: async () => ({ pressKey: 'press14', sourceId: 1, sourceKey: 'press14', displayName: 'Press 14', metadataStatus: 'FRESH', capabilities: [{ canonicalId: 'machine.speed.actual', state: 'SUPPORTED', deckNumbers: [], historyQueryable: true, evidenceKind: 'semantic_history' }] }) },
    semanticHistoryWithIdentity: async (_pressKey: string, query: { fromUtc: string; toUtc: string; includeSeed: boolean }) => {
      requestedFromUtc.push(query.fromUtc)
      const from = Date.parse(query.fromUtc); const to = Date.parse(query.toUtc)
      const seed = allSpeed.filter((item) => Date.parse(item.observedAtUtc) < from).at(-1) ?? null
      const samples = allSpeed.filter((item) => Date.parse(item.observedAtUtc) >= from && Date.parse(item.observedAtUtc) <= to)
      return { pressKey: 'press14', sourceKey: 'press14', displayName: 'Press 14', fromUtc: query.fromUtc, toUtc: query.toUtc, includeSeed: query.includeSeed, signals: [{ canonicalId: 'machine.speed.actual', deckNumber: null, historianSignalId: 204, seed, samples, changes: [] }], readDiagnostics: { gaps: [], sourceGaps: [], historicalAvailability: { state: 'DETAILED_AVAILABLE', detailedTelemetryAvailable: true, intervals: [], reason: 'Detailed history available.' } } }
    },
  } as unknown as TelemetryFoundationService
  const report = await new StopIntelligenceService(telemetry, undefined, () => Date.parse(at(60))).analyze({ pressKey: 'press14', fromUtc: at(0), toUtc: at(45) })
  assert.deepEqual([report.fromUtc, report.toUtc], [at(0), at(45)])
  assert.deepEqual([report.segments[0]?.startAt, report.segments[0]?.endAt, report.segments[0]?.leftCensored], [at(-90), at(20), false])
  assert.deepEqual([report.classifiedStops[0]?.classification, report.classifiedStops[0]?.confidence], ['DOWNTIME', 'HIGH'])
  assert.ok(requestedFromUtc.some((value) => Date.parse(value) <= Date.parse(at(-360))))
})

test('uses the configured speed plus bounded evidence selectors through the shared read-only telemetry foundation', async () => {
  let requestedCanonicalIds: string[] = []
  const telemetry = {
    sources: { resolve: async () => ({ pressKey: 'press14', source: { id: 1, sourceKey: 'press14', displayName: 'Press 14', enabled: true }, metadataStatus: 'FRESH' }) },
    capabilities: { get: async () => ({ pressKey: 'press14', sourceId: 1, sourceKey: 'press14', displayName: 'Press 14', metadataStatus: 'FRESH', capabilities: [
      { canonicalId: 'production.recipe', state: 'SUPPORTED', deckNumbers: [], historyQueryable: true, evidenceKind: 'semantic_history' },
      { canonicalId: 'deck.active', state: 'SUPPORTED', deckNumbers: [1, 2], historyQueryable: true, evidenceKind: 'semantic_history' },
      { canonicalId: 'register.long.actual_or_correction', state: 'SUPPORTED', deckNumbers: [1], historyQueryable: true, evidenceKind: 'semantic_history' },
      { canonicalId: 'ink.pump.status', state: 'SUPPORTED', deckNumbers: [1], historyQueryable: true, evidenceKind: 'semantic_history' },
    ] }) },
    semanticHistoryWithIdentity: async (_pressKey: string, query: { signals: Array<{ canonicalId: string }> }) => {
      requestedCanonicalIds = query.signals.map(({ canonicalId }) => canonicalId)
      return {
        pressKey: 'press14', sourceKey: 'press14', displayName: 'Press 14', fromUtc: at(0), toUtc: at(10), includeSeed: true,
        signals: [
          { canonicalId: 'machine.speed.actual', deckNumber: null, historianSignalId: 204, seed: null, samples: telemetrySamples([[0, 1_000], [1, 0], [2, 700], [9, 700]]), changes: [] },
          { canonicalId: 'production.recipe', deckNumber: null, historianSignalId: 205, seed: { ...telemetrySamples([[0, 1]])[0]!, valueKind: 'string', value: 'R1' }, samples: [], changes: [] },
        ],
        readDiagnostics: { gaps: [], sourceGaps: [] },
      }
    },
  } as unknown as TelemetryFoundationService
  const report = await new StopIntelligenceService(telemetry).analyze({ pressKey: 'press14', fromUtc: at(0), toUtc: at(10) })
  assert.equal(requestedCanonicalIds[0], 'machine.speed.actual')
  assert.ok(requestedCanonicalIds.includes('production.recipe'))
  assert.equal(report.segments[0]?.speedSignalId, 204)
  assert.equal(report.segments[0]?.endAt, at(2))
  assert.equal(report.classifiedStops[0]?.classification, 'DOWNTIME')
})

test('reconstructs a 14-day-old stop from detailed history when raw snapshots have expired', async () => {
  let rawCalls = 0
  const telemetry = {
    sources: { resolve: async () => ({ pressKey: 'press14', source: { id: 1, sourceKey: 'press14', displayName: 'Press 14', enabled: true }, metadataStatus: 'FRESH' }) },
    capabilities: { get: async () => ({ pressKey: 'press14', sourceId: 1, sourceKey: 'press14', displayName: 'Press 14', metadataStatus: 'FRESH', capabilities: [{ canonicalId: 'machine.speed.actual', state: 'SUPPORTED', deckNumbers: [], historyQueryable: true, evidenceKind: 'semantic_history' }] }) },
    semanticHistoryWithIdentity: async () => ({
      pressKey: 'press14', sourceKey: 'press14', displayName: 'Press 14', fromUtc: at(-60), toUtc: at(80), includeSeed: true,
      signals: [{ canonicalId: 'machine.speed.actual', deckNumber: null, historianSignalId: 204, seed: null, samples: telemetrySamples([[0, 900], [5, 0], [35, 700], [42, 700]]), changes: [] }],
      readDiagnostics: { gaps: [], sourceGaps: [], historicalAvailability: { state: 'DETAILED_AVAILABLE', detailedTelemetryAvailable: true, intervals: [], reason: 'Detailed transition-first historian evidence is available for this range.' } },
    }),
    rawCatalog: async () => { rawCalls += 1; throw new Error('RAW_HISTORY_EXPIRED') },
    rawChanges: async () => { rawCalls += 1; throw new Error('RAW_HISTORY_EXPIRED') },
    rawHistory: async () => { rawCalls += 1; throw new Error('RAW_HISTORY_EXPIRED') },
  } as unknown as TelemetryFoundationService
  const now = () => Date.parse(at(0)) + 14 * 24 * 60 * 60_000
  const report = await new StopIntelligenceService(telemetry, undefined, now).analyze({ pressKey: 'press14', fromUtc: at(0), toUtc: at(45) })
  assert.equal(report.telemetryEvidenceState, 'AVAILABLE')
  assert.deepEqual([report.segments[0]?.startAt, report.segments[0]?.endAt], [at(5), at(35)])
  assert.equal(report.segments[0]?.physicalDurationSeconds, 1_800)
  assert.equal(rawCalls, 0)
})

test('reports insufficient detailed telemetry instead of a collection outage when exact speed history is absent', async () => {
  const telemetry = {
    sources: { resolve: async () => ({ pressKey: 'press14', source: { id: 1, sourceKey: 'press14', displayName: 'Press 14', enabled: true }, metadataStatus: 'FRESH' }) },
    capabilities: { get: async () => ({ pressKey: 'press14', sourceId: 1, sourceKey: 'press14', displayName: 'Press 14', metadataStatus: 'FRESH', capabilities: [{ canonicalId: 'machine.speed.actual', state: 'SUPPORTED', deckNumbers: [], historyQueryable: true, evidenceKind: 'semantic_history' }] }) },
    semanticHistoryWithIdentity: async () => ({ pressKey: 'press14', sourceKey: 'press14', displayName: 'Press 14', fromUtc: at(-60), toUtc: at(80), includeSeed: true, signals: [{ canonicalId: 'machine.speed.actual', deckNumber: null, historianSignalId: 204, seed: null, samples: [], changes: [] }], readDiagnostics: { gaps: [], sourceGaps: [], historicalAvailability: { state: 'INSUFFICIENT_DETAILED_TELEMETRY', detailedTelemetryAvailable: false, intervals: [], reason: 'Supported signals exist, but detailed historian observations are unavailable for this period.' } } }),
  } as unknown as TelemetryFoundationService
  const report = await new StopIntelligenceService(telemetry, undefined, () => Date.parse(at(120))).analyze({ pressKey: 'press14', fromUtc: at(0), toUtc: at(45) })
  assert.equal(report.telemetryEvidenceState, 'INSUFFICIENT_DETAILED_TELEMETRY')
  assert.deepEqual(report.segments, [])
})

test('resolves canonical speed identity dynamically but does not let Order bypass required changeover activity', async () => {
  const telemetry = {
    sources: { resolve: async () => ({ pressKey: 'press5', source: { id: 50, sourceKey: 'press5', displayName: 'Press 5', enabled: true }, metadataStatus: 'FRESH' }) },
    capabilities: { get: async () => ({ pressKey: 'press5', sourceId: 50, sourceKey: 'press5', displayName: 'Press 5', metadataStatus: 'FRESH', capabilities: [
      { canonicalId: 'machine.speed.actual', state: 'SUPPORTED', deckNumbers: [], historyQueryable: true, evidenceKind: 'semantic_history' },
      { canonicalId: 'production.order', state: 'SUPPORTED', deckNumbers: [], historyQueryable: true, evidenceKind: 'semantic_history' },
      { canonicalId: 'production.recipe', state: 'SUPPORTED', deckNumbers: [], historyQueryable: true, evidenceKind: 'semantic_history' },
      { canonicalId: 'production.roll', state: 'SUPPORTED', deckNumbers: [], historyQueryable: true, evidenceKind: 'semantic_history' },
    ] }) },
    semanticHistoryWithIdentity: async () => ({
      pressKey: 'press5', sourceKey: 'press5', displayName: 'Press 5', fromUtc: at(-60), toUtc: at(75), includeSeed: true,
      signals: [
        { canonicalId: 'machine.speed.actual', deckNumber: null, historianSignalId: 500, seed: null, samples: telemetrySamples([[0, 1_000], [1, 0], [8, 700], [15, 700]]), changes: [] },
        actionSignal('production.order', null, 501, 'press5.Order', [[2, 'ORDER-A', 'ORDER-B']], 'ORDER-A'),
        actionSignal('production.recipe', null, 502, 'press5.Recipe', [], 'RECIPE-A'),
        actionSignal('production.roll', null, 503, 'press5.Roll', [[3, 'ROLL-A', 'ROLL-B']], 'ROLL-A'),
      ],
      readDiagnostics: { gaps: [], sourceGaps: [] },
    }),
  } as unknown as TelemetryFoundationService
  const service = new StopIntelligenceService(telemetry, undefined, () => Date.parse(at(120)))
  const report = await service.analyze({ pressKey: 'press5', fromUtc: at(0), toUtc: at(20) })
  assert.deepEqual([report.configuration.sourceId, report.configuration.canonicalSpeedSignalId], [50, 500])
  assert.equal(report.classifiedStops[0]?.classification, 'DOWNTIME')
  assert.equal(report.classifiedStops[0]?.confidence, 'HIGH')
  assert.ok(report.classifiedStops[0]?.supportingEvidence.some(({ code }) => code === 'ORDER_CHANGED'))
  assert.equal((await service.fleet({ pressKey: 'press5', fromUtc: at(0), toUtc: at(20) })).presses[0]?.speedContext.unit, null)
})

test('service clamps live identity evidence to now but identity cannot bypass required changeover activity', async () => {
  let requestedToUtc = ''
  const recipe = identityHistory('production.recipe', [[40, 'R1', 'R2']], 'R1')
  const telemetry = {
    sources: { resolve: async () => ({ pressKey: 'press14', source: { id: 1, sourceKey: 'press14', displayName: 'Press 14', enabled: true }, metadataStatus: 'FRESH' }) },
    capabilities: { get: async () => ({ pressKey: 'press14', sourceId: 1, sourceKey: 'press14', displayName: 'Press 14', metadataStatus: 'FRESH', capabilities: [
      { canonicalId: 'production.recipe', state: 'SUPPORTED', deckNumbers: [], historyQueryable: true, evidenceKind: 'semantic_history' },
      { canonicalId: 'deck.active', state: 'SUPPORTED', deckNumbers: [1], historyQueryable: true, evidenceKind: 'semantic_history' },
      { canonicalId: 'register.long.actual_or_correction', state: 'SUPPORTED', deckNumbers: [1], historyQueryable: true, evidenceKind: 'semantic_history' },
      { canonicalId: 'impression.anilox.drive_side', state: 'SUPPORTED', deckNumbers: [1], historyQueryable: true, evidenceKind: 'semantic_history' },
    ] }) },
    semanticHistoryWithIdentity: async (_pressKey: string, query: { toUtc: string }) => {
      requestedToUtc = query.toUtc
      return { pressKey: 'press14', sourceKey: 'press14', displayName: 'Press 14', fromUtc: at(-60), toUtc: query.toUtc, includeSeed: true, signals: [{ canonicalId: 'machine.speed.actual', deckNumber: null, historianSignalId: 204, seed: null, samples: telemetrySamples([[0, 1_000], [1, 0], [2, 700], [9, 700]]), changes: [] }, recipe], readDiagnostics: { gaps: [], sourceGaps: [] } }
    },
  } as unknown as TelemetryFoundationService
  const request = { pressKey: 'press14' as const, fromUtc: at(0), toUtc: at(10) }
  const live = await new StopIntelligenceService(telemetry, undefined, () => Date.parse(at(30))).analyze(request)
  assert.equal(requestedToUtc, at(30))
  assert.equal(live.classifiedStops[0]?.identities.find(({ field }) => field === 'recipe')?.changed, false)
  assert.notEqual(live.classifiedStops[0]?.classification, 'CHANGEOVER')
  const retrospective = await new StopIntelligenceService(telemetry, undefined, () => Date.parse(at(50))).analyze(request)
  assert.equal(requestedToUtc, at(50))
  assert.equal(retrospective.classifiedStops[0]?.identities.find(({ field }) => field === 'recipe')?.changed, true)
  assert.deepEqual([retrospective.classifiedStops[0]?.classification, retrospective.classifiedStops[0]?.confidence], ['DOWNTIME', 'HIGH'])
})

test('keeps physical analysis read-only while isolating operator corrections to the application document store', () => {
  const engine = readFileSync(new URL('../src/stop-intelligence/physical-stop-engine.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(engine, /radius/i)
  const sources = readdirSync(new URL('../src/stop-intelligence/', import.meta.url)).filter((value) => value.endsWith('.ts') && value !== 'correction-service.ts').map((value) => readFileSync(new URL(`../src/stop-intelligence/${value}`, import.meta.url), 'utf8')).join('\n')
  for (const forbidden of [/new Pool/, /from 'pg'/, /INSERT\s+INTO/i, /UPDATE\s+\w+\s+SET/i, /DELETE\s+FROM/i, /TRUNCATE/i, /CREATE\s+TABLE/i]) assert.doesNotMatch(sources, forbidden)
  assert.match(sources, /rawCatalog\(/)
  assert.match(sources, /rawChanges\(/)
  assert.match(sources, /rawHistory\(/)
  const corrections = readFileSync(new URL('../src/stop-intelligence/correction-service.ts', import.meta.url), 'utf8')
  assert.match(corrections, /public\.classification_documents/)
  assert.doesNotMatch(corrections, /press_radius_db|machine_status|telemetry/i)
})

function physical(overrides: Partial<PhysicalStopSegment> = {}): PhysicalStopSegment {
  return { pressKey: 'press14', sourceId: 1, speedSignalId: 204, startAt: at(10), endAt: at(20), leftCensored: false, rightCensored: false, leftCensorReason: null, rightCensorReason: null, physicalDurationSeconds: 600, zeroSpeedSeconds: 600, lowMovementSeconds: 0, movementAttempts: [], failedRecoveryCount: 0, failedRecoveryStreaks: [], algorithmVersion: 'test', configVersion: 'test', ...overrides }
}

const noRadius = (): StopRadiusOverlay => ({ alignment: 'RADIUS_UNAVAILABLE', firstNonProductionAtUtc: null, firstProductionReturnAtUtc: null, physicalStartOffsetSeconds: null, physicalEndOffsetSeconds: null, coveredSeconds: 0, physicalSeconds: 0, coveragePercent: 0, states: [], reason: 'Unavailable in test.' })
const identity = (field: StopIdentityEvidence['field'], usefulness: StopIdentityEvidence['usefulness'], changed = false): StopIdentityEvidence => ({ field, usefulness, available: true, canonicalId: `production.${field}`, beforeValue: 'A', afterValue: changed ? 'B' : 'A', changed, settled: changed, firstChangeAtUtc: changed ? at(12) : null, lastChangeAtUtc: changed ? at(12) : null, settledAtUtc: changed ? at(17) : null, associationOffsetSeconds: changed ? 0 : null, intermediateValues: changed ? ['B'] : [], reason: 'Synthetic research evidence.' })
const family = (name: StopFamilyEvidence['family'], observed = true, coordinated = false): StopFamilyEvidence => ({ family: name, available: true, observed, coordinated, changeCount: observed ? coordinated ? 3 : 1 : 0, deckNumbers: coordinated ? [1, 2] : [], canonicalIds: observed ? [`test.${name.toLowerCase()}`] : [], firstObservedAtUtc: observed ? at(12) : null, lastObservedAtUtc: observed ? at(14) : null, reason: 'Synthetic research evidence.' })
const completeRequiredEvidence = (): RequiredChangeoverEvidence => ({ washActivity: true, pumpInkActivity: true, impressionAdjustment: true, speedTestReturnedToZero: true })
const classify = (values: { segment?: PhysicalStopSegment; identities?: StopIdentityEvidence[]; families?: StopFamilyEvidence[]; identityCoverageAdequate?: boolean; familyCoverageAdequate?: boolean; evidenceIntegrity?: 'VALID' | 'LIMITED' | 'INVALID'; radius?: StopRadiusOverlay; requiredChangeoverEvidence?: RequiredChangeoverEvidence }) => classifyStop({ segment: values.segment ?? physical(), identities: values.identities ?? [identity('recipe', 'STRONG')], families: values.families ?? [], identityCoverageAdequate: values.identityCoverageAdequate ?? true, familyCoverageAdequate: values.familyCoverageAdequate ?? true, evidenceIntegrity: values.evidenceIntegrity ?? 'VALID', radius: values.radius ?? noRadius(), requiredChangeoverEvidence: values.requiredChangeoverEvidence ?? completeRequiredEvidence() })

test('derives overlapping activity windows only for backend-classified Changeovers', () => {
  const action = (actionCode: ChangeoverAction['actionCode'], displayName: string, startAt: string, canonicalId: string, oldValue: number | boolean | string = 0, newValue: number | boolean | string = 1): ChangeoverAction => ({ actionCode, displayName, operatorConcept: null, confidence: 'DETECTED', startAt, endAt: new Date(Date.parse(startAt) + 30_000).toISOString(), explanation: `${displayName} telemetry.`, evidence: [{ signalId: 1, canonicalId, rawIdentity: canonicalId, component: null, deckNumber: null, atUtc: startAt, oldValue, newValue, originalQuality: 'GOOD', normalizedQuality: 'GOOD', explanation: 'Changed.' }], evidenceCount: 1, evidenceLimited: false, comparison: null, detectorVersion: STOP_INTELLIGENCE_ACTION_VERSION })
  const stop = classify({ segment: physical({ movementAttempts: [
    { startAt: at(14, 20), endAt: at(16), durationSeconds: 100, averageSpeed: 200, peakSpeed: 300, reachedRecoveryThreshold: false, failedRecoveryCount: 0, sequenceNumber: 1 },
    { startAt: at(16, 20), endAt: at(18), durationSeconds: 100, averageSpeed: 220, peakSpeed: 340, reachedRecoveryThreshold: false, failedRecoveryCount: 0, sequenceNumber: 2 },
  ] }) })
  const deckStatus: StopDeckStatusContext = {
    fromUtc: at(9), toUtc: at(21), availability: 'AVAILABLE', reason: 'Synthetic normalized deck status.', sourceIdentities: [],
    decks: Array.from({ length: 10 }, (_, index) => index === 0 ? { deckNumber: 1, intervals: [
      { startUtc: at(9), endUtc: at(11), state: 'READY' as const, active: true, printing: false, out: false },
      { startUtc: at(11), endUtc: at(14), state: 'OUT' as const, active: false, printing: false, out: true },
      { startUtc: at(14), endUtc: at(15), state: 'READY' as const, active: true, printing: false, out: false },
      { startUtc: at(15), endUtc: at(16), state: 'PRINTING' as const, active: true, printing: true, out: false },
      { startUtc: at(16), endUtc: at(17), state: 'READY' as const, active: true, printing: false, out: false },
      { startUtc: at(17), endUtc: at(18), state: 'PRINTING' as const, active: true, printing: true, out: false },
      { startUtc: at(18), endUtc: at(21), state: 'READY' as const, active: true, printing: false, out: false },
    ], events: [] } : { deckNumber: index + 1, intervals: [{ startUtc: at(9), endUtc: at(21), state: 'INACTIVE' as const, active: false, printing: false, out: false }], events: [] }),
  }
  const washSignals = Array.from({ length: 10 }, (_, index) => ({ canonicalId: 'ink.washup.state', deckNumber: index + 1, seed: { observedAtUtc: at(9), qualityState: 'GOOD', value: 1 }, samples: [], changes: [{ observedAtUtc: index === 9 ? at(13, 30) : at(13), qualityState: 'GOOD', value: 0 }] })) as unknown as PressSemanticSignalWithIdentity[]
  const speedObservations: CanonicalSpeedObservation[] = [
    { atUtc: at(14), speed: 0, qualityState: 'GOOD' },
    { atUtc: at(14, 20), speed: 30, qualityState: 'GOOD' },
    { atUtc: at(16), speed: 0, qualityState: 'GOOD' },
    { atUtc: at(16, 20), speed: 35, qualityState: 'GOOD' },
    { atUtc: at(18), speed: 0, qualityState: 'GOOD' },
  ]
  const actions = [
    action('WASH_ACTIVITY', 'Wash activity', at(12), 'ink.washup.state'),
    action('REGISTRATION_ADJUSTMENT', 'Zero-speed registration noise', at(13, 30), 'register.long.actual_or_correction'),
    action('REGISTRATION_ADJUSTMENT', 'Registration adjustment 1', at(14, 30), 'register.long.actual_or_correction'),
    action('WASH_ACTIVITY', 'Wash activity 2', at(15), 'ink.washup.state'),
    action('IMPRESSION_ADJUSTMENT', 'Impression adjustment 1', at(15, 10), 'impression.print_side'),
    action('INK_PUMP_ACTIVITY', 'Color-check pump activity 1', at(16, 10), 'ink.pump.status', 1, 0),
    action('REGISTRATION_ADJUSTMENT', 'Registration adjustment 2', at(16, 30), 'register.long.actual_or_correction'),
    action('IMPRESSION_ADJUSTMENT', 'Impression adjustment 2', at(17, 10), 'impression.print_side'),
    action('INK_PUMP_ACTIVITY', 'Color-check pump activity 2', at(18, 10), 'ink.pump.status', 1, 0),
  ]
  const stages = buildChangeoverActivityWindows({ stop, actions, signals: washSignals, speedObservations, deckStatus, rangeEndUtc: at(30) })
  assert.deepEqual(stages.map(({ label }) => label), ['Job Out', 'Deck Out', 'Washing of Ink', 'Ink Up', 'Deck In', 'Registration Setup', 'Impression Setup', 'Color Check', 'Color Check', 'Good Run'])
  assert.equal(stages.some(({ label }) => /Previous Job/i.test(label)), false)
  assert.equal(stages.some(({ explanation }) => /predicted boundary|predicted sequence/i.test(explanation)), false)
  assert.equal(stages.filter(({ kind }) => kind === 'wash').length, 1)
  assert.deepEqual([stages.find(({ kind }) => kind === 'wash')?.startAt, stages.find(({ kind }) => kind === 'wash')?.endAt], [at(12), at(15, 30)])
  assert.deepEqual([stages.find(({ kind }) => kind === 'ink-up')?.startAt, stages.find(({ kind }) => kind === 'ink-up')?.endAt], [at(16, 10), at(18, 40)])
  assert.deepEqual([stages.find(({ kind }) => kind === 'register')?.startAt, stages.find(({ kind }) => kind === 'register')?.endAt], [at(13, 30), at(17)])
  assert.deepEqual([stages.find(({ kind }) => kind === 'impression')?.startAt, stages.find(({ kind }) => kind === 'impression')?.endAt], [at(15, 10), at(17, 40)])
  assert.deepEqual(stages.filter(({ kind }) => kind === 'color-check').map(({ startAt, endAt }) => [startAt, endAt]), [[at(16), at(16, 20)], [at(18), at(20)]])
  assert.ok(Date.parse(stages.find(({ kind }) => kind === 'register')!.endAt) > Date.parse(stages.find(({ kind }) => kind === 'impression')!.startAt))
  assert.deepEqual(buildChangeoverActivityWindows({ stop, actions, signals: washSignals.slice(0, 9), speedObservations, deckStatus, rangeEndUtc: at(30) }).map(({ label }) => label), ['Job Out', 'Deck Out', 'Washing of Ink', 'Ink Up', 'Registration Setup', 'Impression Setup', 'Color Check', 'Color Check', 'Good Run'])
  const oneDeckStillOut: StopDeckStatusContext = { ...deckStatus, decks: deckStatus.decks.map((deck) => deck.deckNumber === 2 ? { ...deck, intervals: [{ startUtc: at(9), endUtc: at(21), state: 'OUT', active: false, printing: false, out: true }] } : deck) }
  assert.deepEqual(buildChangeoverActivityWindows({ stop, actions, signals: washSignals, speedObservations, deckStatus: oneDeckStillOut, rangeEndUtc: at(30) }).map(({ label }) => label), ['Job Out', 'Deck Out', 'Washing of Ink', 'Ink Up', 'Registration Setup', 'Impression Setup', 'Color Check', 'Color Check', 'Good Run'])
  const downtime = { ...stop, classification: 'DOWNTIME' as const }
  assert.deepEqual(buildChangeoverActivityWindows({ stop: downtime, actions, signals: washSignals, speedObservations, deckStatus, rangeEndUtc: at(30) }), [])
})

test('research P14 E030/E031 classify HIGH CHANGEOVER from settled Recipe identity', () => {
  for (const event of ['E030', 'E031']) {
    const result = classify({ identities: [identity('recipe', 'STRONG', true)] })
    assert.deepEqual([event, result.classification, result.confidence], [event, 'CHANGEOVER', 'HIGH'])
    assert.ok(result.supportingEvidence.some(({ code }) => code === 'RECIPE_CHANGED'))
  }
})

test('research P14 E038 stays HIGH CHANGEOVER despite contradictory Radius annotation', () => {
  const contradictory = { ...noRadius(), alignment: 'CONTRADICTORY' as const, reason: 'Radius says Run Production.' }
  const result = classify({ identities: [identity('recipe', 'STRONG', true), identity('customer', 'WEAK', true)], families: [family('IMPRESSION'), family('REGISTRATION')], radius: contradictory })
  assert.equal(result.classification, 'CHANGEOVER')
  assert.equal(result.confidence, 'HIGH')
  assert.equal(result.radius.alignment, 'CONTRADICTORY')
  assert.ok(result.supportingEvidence.some(({ code, strength }) => code === 'CUSTOMER_CHANGED' && strength === 'WEAK'))
  assert.ok(result.conflictingEvidence.some(({ code }) => code === 'RADIUS_RUN_PRODUCTION'))
})

test('requires wash, pump or ink, impression, and an in-stop positive-speed return to zero before predicting CHANGEOVER', () => {
  const qualifying = classify({ identities: [identity('recipe', 'STRONG', true)], families: [family('WASH_PUMP_INK'), family('IMPRESSION')], requiredChangeoverEvidence: completeRequiredEvidence() })
  assert.deepEqual([qualifying.classification, qualifying.confidence], ['CHANGEOVER', 'HIGH'])
  for (const key of Object.keys(completeRequiredEvidence()) as Array<keyof RequiredChangeoverEvidence>) {
    const requiredChangeoverEvidence = { ...completeRequiredEvidence(), [key]: false }
    const result = classify({ identities: [identity('recipe', 'STRONG', true)], families: [family('WASH_PUMP_INK'), family('IMPRESSION')], requiredChangeoverEvidence })
    assert.deepEqual([key, result.classification, result.confidence], [key, 'DOWNTIME', 'HIGH'])
    assert.ok(result.conflictingEvidence.some(({ code }) => code.startsWith('CHANGEOVER_REQUIRES_')))
  }
  assert.equal(classify({ evidenceIntegrity: 'LIMITED', requiredChangeoverEvidence: { ...completeRequiredEvidence(), washActivity: false } }).classification, 'UNCERTAIN')
})

test('the same four-condition rule classifies every configured press without press-specific legacy scoring', () => {
  const pressKeys = ['press3', 'press5', 'press6', 'press7', 'press8', 'press9', 'press10', 'press11', 'press12', 'press13', 'press14', 'press15'] as const
  for (const pressKey of pressKeys) {
    const qualifying = classify({ segment: physical({ pressKey }), identities: [], families: [], identityCoverageAdequate: false, familyCoverageAdequate: false })
    assert.deepEqual([pressKey, qualifying.classification, qualifying.confidence], [pressKey, 'CHANGEOVER', 'HIGH'])
    const missingWash = classify({ segment: physical({ pressKey }), identities: [identity('order', 'STRONG', true)], families: [family('DECK', true, true), family('IMPRESSION'), family('REGISTRATION')], requiredChangeoverEvidence: { ...completeRequiredEvidence(), washActivity: false } })
    assert.deepEqual([pressKey, missingWash.classification, missingWash.confidence], [pressKey, 'DOWNTIME', 'HIGH'])
  }
})

test('identity and setup-family evidence remains descriptive and cannot raise or lower the four-condition decision', () => {
  const sparse = classify({ identities: [], families: [], identityCoverageAdequate: false, familyCoverageAdequate: false })
  const broad = classify({ identities: [identity('order', 'STRONG', true)], families: [family('DECK', true, true), family('WASH_PUMP_INK'), family('IMPRESSION'), family('REGISTRATION')] })
  assert.deepEqual([sparse.classification, sparse.confidence], ['CHANGEOVER', 'HIGH'])
  assert.deepEqual([broad.classification, broad.confidence], ['CHANGEOVER', 'HIGH'])
})

test('research P15 E148 is HIGH CHANGEOVER from settled Order identity', () => {
  const result = classify({ identities: [identity('order', 'STRONG', true)] })
  assert.deepEqual([result.classification, result.confidence], ['CHANGEOVER', 'HIGH'])
})

test('research P15 E155 is HIGH telemetry-only CHANGEOVER from broad independent setup families', () => {
  const result = classify({ families: [family('DECK', true, true), family('WASH_PUMP_INK'), family('IMPRESSION'), family('REGISTRATION')], radius: { ...noRadius(), alignment: 'CONTRADICTORY', reason: 'Radius remained Run Production.' } })
  assert.deepEqual([result.classification, result.confidence, result.radius.alignment], ['CHANGEOVER', 'HIGH', 'CONTRADICTORY'])
})

test('research E166/E167/E168 expose supporting, conflicting, and missing evidence instead of hiding uncertainty', () => {
  const unsettledOrder = { ...identity('order', 'STRONG', true), settled: false, settledAtUtc: null }
  const result = classify({ segment: physical({ failedRecoveryCount: 2 }), identities: [unsettledOrder, identity('previous_order', 'MEDIUM', true)], families: [family('DECK', true, true), family('WASH_PUMP_INK'), family('REGISTRATION')], identityCoverageAdequate: false, familyCoverageAdequate: false, radius: { ...noRadius(), alignment: 'CONTRADICTORY', reason: 'Radius remained Run Production.' } })
  assert.deepEqual([result.classification, result.confidence], ['CHANGEOVER', 'HIGH'])
  assert.ok(['PREVIOUS_ORDER_CHANGED', 'COORDINATED_DECK_MOVEMENT', 'WASH_PUMP_INK_ACTIVITY', 'REGISTRATION_ACTIVITY', 'RESTART_ATTEMPTS_CONTEXT'].every((code) => result.supportingEvidence.some((value) => value.code === code)))
  assert.ok(['UNSETTLED_IDENTITY_TRANSITION', 'RADIUS_RUN_PRODUCTION'].every((code) => result.conflictingEvidence.some((value) => value.code === code)))
  assert.ok(['RELEVANT_IDENTITY_COVERAGE', 'SETUP_FAMILY_COVERAGE'].every((code) => result.missingEvidence.includes(code)))
})

test('collection censorship is UNCERTAIN and invalid quality evidence is IGNORE_BAD_DATA', () => {
  const censored = physical({ rightCensored: true, rightCensorReason: 'SOURCE_TELEMETRY_UNAVAILABLE' })
  assert.equal(classify({ segment: censored, evidenceIntegrity: 'LIMITED' }).classification, 'UNCERTAIN')
  const invalid = classify({ evidenceIntegrity: 'INVALID' })
  assert.equal(invalid.classification, 'IGNORE_BAD_DATA')
  assert.ok(invalid.conflictingEvidence.some(({ code }) => code === 'INVALID_SPEED_EVIDENCE'))
})

test('duration, restart attempts, anilox, and Radius Make Ready never classify a changeover alone', () => {
  const segment = physical({ physicalDurationSeconds: 7_200, failedRecoveryCount: 3 })
  const result = classify({ segment, families: [family('ANILOX')], radius: { ...noRadius(), alignment: 'AGREES', reason: 'Make Ready aligned.' }, requiredChangeoverEvidence: { ...completeRequiredEvidence(), impressionAdjustment: false } })
  assert.deepEqual([result.classification, result.confidence], ['DOWNTIME', 'HIGH'])
  assert.ok(result.supportingEvidence.some(({ code }) => code === 'LONG_DURATION_CONTEXT'))
  assert.ok(result.supportingEvidence.some(({ code }) => code === 'RESTART_ATTEMPTS_CONTEXT'))
})

test('press-aware identity mapping settles P14 Recipe, ignores P14 Order, and settles P15 Order', () => {
  const sample = (value: string) => ({ observedAtUtc: at(0), receivedAtUtc: at(0), sourceTimestampUtc: at(0), qualityState: 'GOOD', valueKind: 'string' as const, value })
  const changed = (canonicalId: string, previousValue: string, value: string): PressSemanticSignalWithIdentity => ({ canonicalId, deckNumber: null, capabilityState: 'SUPPORTED', observationState: 'SUPPORTED_WITH_OBSERVATIONS', mappingStatus: 'MAPPED', historianSignalId: 999, rawSignalId: 'test', sourceSelector: null, selectedVariant: 'test', sourceUnit: null, canonicalUnitStatus: null, representation: 'changes', seed: sample(previousValue), samples: [], changes: [{ ...sample(value), observedAtUtc: at(12), receivedAtUtc: at(12), sourceTimestampUtc: at(12), previousObservedAtUtc: at(0), previousReceivedAtUtc: at(0), previousSourceTimestampUtc: at(0), previousQualityState: 'GOOD', previousValueKind: 'string', previousValue }] })
  const p14Segment = physical(); const p14 = buildStopEvidence({ pressKey: 'press14', segment: p14Segment, allSegments: [p14Segment], signals: [changed('production.recipe', 'R1', 'R2'), changed('production.order', 'O1', 'O2')], physicalRangeEndUtc: at(30), identityEvidenceCutoffUtc: at(30), identityAssociationConfiguration: stopIdentityAssociationConfiguration('press14')!, supportedFamilies: ['DECK', 'IMPRESSION', 'REGISTRATION'] })
  assert.equal(p14.identities.find(({ field }) => field === 'recipe')?.changed, true)
  assert.equal(p14.identities.find(({ field }) => field === 'order')?.changed, false)
  const p15Segment = { ...physical(), pressKey: 'press15' as const, sourceId: 34, speedSignalId: 222 }; const p15 = buildStopEvidence({ pressKey: 'press15', segment: p15Segment, allSegments: [p15Segment], signals: [changed('production.order', 'O1', 'O2')], physicalRangeEndUtc: at(30), identityEvidenceCutoffUtc: at(30), identityAssociationConfiguration: stopIdentityAssociationConfiguration('press15')!, supportedFamilies: ['DECK', 'IMPRESSION', 'REGISTRATION'] })
  assert.equal(p15.identities.find(({ field }) => field === 'order')?.settled, true)
})

test('identity evidence retains a transition shortly before the physical stop', () => {
  const sample = (value: string, minute: number) => ({ observedAtUtc: at(minute), receivedAtUtc: at(minute), sourceTimestampUtc: at(minute), qualityState: 'GOOD', valueKind: 'string' as const, value })
  const recipe: PressSemanticSignalWithIdentity = { canonicalId: 'production.recipe', deckNumber: null, capabilityState: 'SUPPORTED', observationState: 'SUPPORTED_WITH_OBSERVATIONS', mappingStatus: 'MAPPED', historianSignalId: 999, rawSignalId: 'test', sourceSelector: null, selectedVariant: 'test', sourceUnit: null, canonicalUnitStatus: null, representation: 'changes', seed: sample('R1', 0), samples: [], changes: [{ ...sample('R2', 8), previousObservedAtUtc: at(0), previousReceivedAtUtc: at(0), previousSourceTimestampUtc: at(0), previousQualityState: 'GOOD', previousValueKind: 'string', previousValue: 'R1' }] }
  const segment = physical(); const evidence = buildStopEvidence({ pressKey: 'press14', segment, allSegments: [segment], signals: [recipe], physicalRangeEndUtc: at(30), identityEvidenceCutoffUtc: at(30), identityAssociationConfiguration: stopIdentityAssociationConfiguration('press14')!, supportedFamilies: [] })
  assert.deepEqual([evidence.identities[0]?.beforeValue, evidence.identities[0]?.afterValue, evidence.identities[0]?.settled], ['R1', 'R2', true])
})

function identityHistory(canonicalId: string, transitions: Array<[number, string, string]>, seedValue: string): PressSemanticSignalWithIdentity {
  const point = (value: string, minute: number) => ({ observedAtUtc: at(minute), receivedAtUtc: at(minute), sourceTimestampUtc: at(minute), qualityState: 'GOOD', valueKind: 'string' as const, value })
  return { canonicalId, deckNumber: null, capabilityState: 'SUPPORTED', observationState: transitions.length ? 'SUPPORTED_WITH_OBSERVATIONS' : 'SUPPORTED_WITH_SEED_ONLY', mappingStatus: 'MAPPED', historianSignalId: 999, rawSignalId: 'test', sourceSelector: null, selectedVariant: 'test', sourceUnit: null, canonicalUnitStatus: null, representation: 'changes', seed: point(seedValue, -120), samples: [], changes: transitions.map(([minute, previousValue, value]) => ({ ...point(value, minute), previousObservedAtUtc: at(minute - 1), previousReceivedAtUtc: at(minute - 1), previousSourceTimestampUtc: at(minute - 1), previousQualityState: 'GOOD', previousValueKind: 'string', previousValue })) }
}

function associatedEvidence(pressKey: 'press14' | 'press15', segment: PhysicalStopSegment, allSegments: PhysicalStopSegment[], signal: PressSemanticSignalWithIdentity, cutoffMinute: number) {
  return buildStopEvidence({ pressKey, segment, allSegments, signals: [signal], physicalRangeEndUtc: at(120), identityEvidenceCutoffUtc: at(cutoffMinute), identityAssociationConfiguration: stopIdentityAssociationConfiguration(pressKey)!, supportedFamilies: ['DECK', 'IMPRESSION', 'REGISTRATION'] })
}

test('settled strong Recipe and Order transitions forty minutes before a stop can support the uniquely linked stop', () => {
  for (const [pressKey, canonicalId, field] of [['press14', 'production.recipe', 'recipe'], ['press15', 'production.order', 'order']] as const) {
    const segment = { ...physical(), pressKey, sourceId: pressKey === 'press14' ? 1 : 34, speedSignalId: pressKey === 'press14' ? 204 : 222 }
    const evidence = associatedEvidence(pressKey, segment, [segment], identityHistory(canonicalId, [[-30, 'A', 'B']], 'A'), 30)
    const result = classify({ segment, identities: evidence.identities, families: evidence.families, identityCoverageAdequate: evidence.identityCoverageAdequate, familyCoverageAdequate: evidence.familyCoverageAdequate })
    assert.equal(evidence.identities.find((value) => value.field === field)?.associationOffsetSeconds, -2_400)
    assert.deepEqual([result.classification, result.confidence], ['CHANGEOVER', 'HIGH'])
    assert.deepEqual([result.physicalSegment.startAt, result.physicalSegment.endAt], [segment.startAt, segment.endAt])
  }
})

test('a strong identity transition forty minutes after recovery supports retrospective classification', () => {
  const segment = { ...physical(), pressKey: 'press15' as const, sourceId: 34, speedSignalId: 222 }
  const evidence = associatedEvidence('press15', segment, [segment], identityHistory('production.order', [[60, 'A', 'B']], 'A'), 70)
  const result = classify({ segment, identities: evidence.identities, families: evidence.families, identityCoverageAdequate: evidence.identityCoverageAdequate, familyCoverageAdequate: evidence.familyCoverageAdequate })
  assert.equal(evidence.identities.find(({ field }) => field === 'order')?.associationOffsetSeconds, 2_400)
  assert.deepEqual([result.classification, result.confidence], ['CHANGEOVER', 'HIGH'])
  assert.deepEqual([result.physicalSegment.startAt, result.physicalSegment.endAt], [at(10), at(20)])
})

test('identity association keeps the independent five-minute settling requirement', () => {
  const segment = physical(); const signal = identityHistory('production.recipe', [[60, 'A', 'B']], 'A')
  const pending = associatedEvidence('press14', segment, [segment], signal, 64).identities.find(({ field }) => field === 'recipe')!
  const settled = associatedEvidence('press14', segment, [segment], signal, 65).identities.find(({ field }) => field === 'recipe')!
  assert.deepEqual([pending.changed, pending.settled, pending.settledAtUtc], [true, false, null])
  assert.deepEqual([settled.changed, settled.settled, settled.settledAtUtc], [true, true, at(65)])
})

test('an identity transition outside the configured one-hour association context does not attach', () => {
  const segment = physical(); const evidence = associatedEvidence('press14', segment, [segment], identityHistory('production.recipe', [[-51, 'A', 'B']], 'A'), 30)
  const recipe = evidence.identities.find(({ field }) => field === 'recipe')!
  assert.deepEqual([recipe.changed, recipe.associationOffsetSeconds], [false, null])
})

test('a transition assigned to a nearer intervening stop is not reused by a later stop', () => {
  const earlier = physical({ startAt: at(20), endAt: at(30) }); const later = physical({ startAt: at(70), endAt: at(80) }); const signal = identityHistory('production.recipe', [[15, 'A', 'B']], 'A')
  const earlierRecipe = associatedEvidence('press14', earlier, [earlier, later], signal, 100).identities.find(({ field }) => field === 'recipe')!
  const laterRecipe = associatedEvidence('press14', later, [earlier, later], signal, 100).identities.find(({ field }) => field === 'recipe')!
  assert.deepEqual([earlierRecipe.changed, laterRecipe.changed], [true, false])
})

test('live identity evidence never consumes a future transition', () => {
  const segment = physical(); const signal = identityHistory('production.recipe', [[60, 'A', 'B']], 'A')
  const live = associatedEvidence('press14', segment, [segment], signal, 50).identities.find(({ field }) => field === 'recipe')!
  const retrospective = associatedEvidence('press14', segment, [segment], signal, 70).identities.find(({ field }) => field === 'recipe')!
  assert.deepEqual([live.changed, live.afterValue], [false, 'A'])
  assert.deepEqual([retrospective.changed, retrospective.afterValue, retrospective.settled], [true, 'B', true])
})

test('Radius overlay reports agreement and contradiction without changing physical boundaries', () => {
  const segment = physical()
  const radiusBase = { machineId: 14, pressKey: 'press14' as const, displayName: 'Press 14', durationSeconds: 600, isOpen: false, sourceGeneration: 'compact' as const }
  const agreeingSegments: RadiusStatusSegment[] = [
    { ...radiusBase, kind: 'radius', startUtc: at(10), endUtc: at(20), eventType: 'M', statusCode: 'MR', statusDescription: 'Make Ready', isProduction: false },
    { ...radiusBase, kind: 'radius', startUtc: at(20), endUtc: at(30), eventType: 'G', statusCode: 'RUN', statusDescription: 'Run Production', isProduction: true },
  ]
  const agreeing = overlayRadius(segment, at(30), agreeingSegments)
  assert.equal(agreeing.alignment, 'AGREES')
  const contradiction = overlayRadius(segment, at(30), [{ ...radiusBase, kind: 'radius', startUtc: at(9), endUtc: at(21), eventType: 'G', statusCode: 'RUN', statusDescription: 'Run Production', isProduction: true }])
  assert.equal(contradiction.alignment, 'CONTRADICTORY')
  assert.deepEqual([segment.startAt, segment.endAt], [at(10), at(20)])
})

test('Radius overlay exposes unavailable, partial, late, and early timing states', () => {
  const segment = physical(); const base = { machineId: 14, pressKey: 'press14' as const, displayName: 'Press 14', durationSeconds: 600, isOpen: false, sourceGeneration: 'compact' as const }
  const state = (start: number, end: number, production: boolean): RadiusStatusSegment => ({ ...base, kind: 'radius', startUtc: at(start), endUtc: at(end), eventType: production ? 'G' : 'M', statusCode: production ? 'RUN' : 'MR', statusDescription: production ? 'Run Production' : 'Make Ready', isProduction: production })
  assert.equal(overlayRadius(segment, at(30)).alignment, 'RADIUS_UNAVAILABLE')
  assert.equal(overlayRadius(segment, at(30), [{ ...base, kind: 'offline', startUtc: at(10), endUtc: at(20), eventType: null, statusCode: null, statusDescription: null, isProduction: false }]).alignment, 'PARTIAL')
  assert.equal(overlayRadius(segment, at(30), [state(12, 22, false), state(22, 30, true)]).alignment, 'RADIUS_LATE')
  assert.equal(overlayRadius(segment, at(30), [state(8, 18, false), state(18, 30, true)]).alignment, 'RADIUS_EARLY')
  assert.equal(overlayRadius(segment, at(30), [state(8, 22, false), state(22, 30, true)]).alignment, 'PARTIAL')
})

test('Radius PM can explain source-unavailable downtime without fabricating an exact speed boundary', () => {
  const segment = physical({ endAt: at(15), rightCensored: true, rightCensorReason: 'SOURCE_TELEMETRY_UNAVAILABLE' })
  const pm: RadiusStatusSegment = { machineId: 14, pressKey: 'press14', displayName: 'Press 14', durationSeconds: 1_200, isOpen: false, sourceGeneration: 'compact', kind: 'radius', startUtc: at(10), endUtc: at(30), eventType: 'B', statusCode: 'PM', statusDescription: 'Planned Maintenance', isProduction: false }
  const overlaid = overlayRadius(segment, at(30), [pm])
  assert.deepEqual([segment.startAt, segment.endAt, segment.rightCensorReason], [at(10), at(15), 'SOURCE_TELEMETRY_UNAVAILABLE'])
  assert.equal(overlaid.states[0]?.statusDescription, 'Planned Maintenance')
})

test('rejects an unregistered press before telemetry source access', async () => {
  const app = createApp({ telemetryClient: {} as TelemetryClient, logger: false })
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const port = (server.address() as AddressInfo).port
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/stop-intelligence/presses/press4?fromUtc=${encodeURIComponent(at(0))}&toUtc=${encodeURIComponent(at(10))}`)
    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { error: 'invalid_press_key' })
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

test('bounds the Stop Intelligence API to 72 hours before telemetry source access', async () => {
  const app = createApp({ telemetryClient: {} as TelemetryClient, logger: false })
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const port = (server.address() as AddressInfo).port
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/stop-intelligence/presses/press14?fromUtc=${encodeURIComponent(at(0))}&toUtc=${encodeURIComponent(new Date(Date.parse(at(0)) + 73 * 60 * 60_000).toISOString())}`)
    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { error: 'stop_intelligence_range_too_large' })
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

test('builds a lightweight single-press summary and loads bounded detail only for the selected stop', async () => {
  const readOrder: string[] = []
  const radiusReads: Array<{ pressKey: string; fromUtc: string; toUtc: string }> = []
  let rawDiscoveryReads = 0
  let rawCatalogReads = 0
  const telemetry = {
    sources: { resolve: async (pressKey: 'press14' | 'press15') => ({ pressKey, source: { id: pressKey === 'press14' ? 1 : 34, sourceKey: pressKey, displayName: pressKey === 'press14' ? 'Press 14' : 'Press 15', enabled: true }, metadataStatus: 'FRESH' }) },
    capabilities: { get: async (pressKey: 'press14' | 'press15') => ({ pressKey, sourceId: pressKey === 'press14' ? 1 : 34, sourceKey: pressKey, displayName: pressKey === 'press14' ? 'Press 14' : 'Press 15', metadataStatus: 'FRESH', capabilities: [
      { canonicalId: 'production.roll', state: 'SUPPORTED', deckNumbers: [], historyQueryable: true, evidenceKind: 'semantic_history' },
      { canonicalId: 'production.roll.length.actual', state: 'SUPPORTED', deckNumbers: [], historyQueryable: true, evidenceKind: 'semantic_history' },
      { canonicalId: 'production.order', state: 'SUPPORTED', deckNumbers: [], historyQueryable: true, evidenceKind: 'semantic_history' },
      { canonicalId: 'production.recipe', state: 'SUPPORTED', deckNumbers: [], historyQueryable: true, evidenceKind: 'semantic_history' },
      { canonicalId: 'production.material', state: 'SUPPORTED', deckNumbers: [], historyQueryable: true, evidenceKind: 'semantic_history' },
      { canonicalId: 'ink.pump.frequency.supply', state: 'SUPPORTED', deckNumbers: [1], historyQueryable: true, evidenceKind: 'semantic_history' },
    ] }) },
    semanticHistoryWithIdentity: async (pressKey: 'press14' | 'press15') => {
      readOrder.push(pressKey)
      const historianSignalId = pressKey === 'press14' ? 204 : 222
      return {
        pressKey, sourceKey: pressKey, displayName: pressKey === 'press14' ? 'Press 14' : 'Press 15', fromUtc: at(-60), toUtc: at(90), includeSeed: true,
        signals: [{ canonicalId: 'machine.speed.actual', deckNumber: null, historianSignalId, seed: null, samples: telemetrySamples([[-10, 800], [8, 800, 'BAD'], [10, 0], [15, 100], [18, 0], [20, 700], [25, 700], [30, 800]]), changes: [] }, actionSignal('production.roll', null, historianSignalId + 1, `${pressKey}.Roll`, [[12, 'R100', 'R101']]), actionSignal('production.roll.length.actual', null, historianSignalId + 5, `${pressKey}.RollLength`, [[5, 0, 100], [15, 100, 300], [22, 300, 0], [30, 0, 120]]), actionSignal('ink.pump.frequency.supply', 1, historianSignalId + 2, `${pressKey}.PumpSupply[1]`, [[14, 0, 20], [15, 20, 18], [16, 18, 0]]), actionSignal('production.order', null, historianSignalId + 3, `${pressKey}.Order`, [], 'ORD-100'), actionSignal('production.recipe', null, historianSignalId + 4, `${pressKey}.Recipe`, [], 'RECIPE-A'), actionSignal('production.material', null, historianSignalId + 6, `${pressKey}.Material`, [[18, 'MAT-A', 'MAT-B']], 'MAT-A')],
        readDiagnostics: { gaps: [], sourceGaps: [{ startUtc: at(5), endUtc: at(8) }] },
      }
    },
    rawCatalog: async () => { rawCatalogReads += 1; return Array.from({ length: 10 }, (_, index) => index + 1).flatMap((deckNumber, index) => [
      { id: index * 2 + 1, sourceId: 1, signalId: `Ruby.Press14.Line14.ProcessData.Color deck ${deckNumber}.Status [0/1]`, displayName: 'Status', sourceUnit: null, valueKind: 'boolean', enabled: true },
      { id: index * 2 + 2, sourceId: 1, signalId: `Ruby.Press14.Line14.ProcessData.Color deck ${deckNumber}.Position [#]`, displayName: 'Position', sourceUnit: null, valueKind: 'integer', enabled: true },
    ]) },
    rawChanges: async () => { rawDiscoveryReads += 1; throw new Error('RAW_HISTORY_EXPIRED') },
    rawHistory: async (_pressKey: string, rawIdentity: string) => rawHistory(rawIdentity, rawIdentity, /\.Status \[0\/1\]$/.test(rawIdentity) ? [[-20, true]] : [[-20, 3]]),
  } as unknown as TelemetryFoundationService
  const radius = { getRawTimeline: async (pressKey: 'press14' | 'press15', fromUtc: string, toUtc: string) => {
    radiusReads.push({ pressKey, fromUtc, toUtc })
    return { pressKey, displayName: pressKey === 'press14' ? 'Press 14' : 'Press 15', fromUtc, toUtc, segments: [{ kind: 'radius', machineId: pressKey === 'press14' ? 14 : 15, pressKey, displayName: pressKey === 'press14' ? 'Press 14' : 'Press 15', startUtc: fromUtc, endUtc: toUtc, durationSeconds: (Date.parse(toUtc) - Date.parse(fromUtc)) / 1_000, isOpen: false, sourceGeneration: 'current', eventType: 'G', statusCode: '150', statusDescription: 'Run Production', isProduction: true }] }
  } } as unknown as RadiusService
  const service = new StopIntelligenceService(telemetry, radius, () => Date.parse(at(120)))
  const range = { fromUtc: at(0), toUtc: at(40) }
  const fleet = await service.fleet({ pressKey: 'press14', ...range })
  assert.deepEqual(readOrder, ['press14'])
  assert.equal(rawCatalogReads, 0)
  assert.equal(fleet.presses.length, 1)
  assert.deepEqual(fleet.presses.map(({ stopCount, totalPhysicalStopSeconds, longestPhysicalStopSeconds }) => [stopCount, totalPhysicalStopSeconds, longestPhysicalStopSeconds]), [[1, 600, 600]])
  assert.ok(fleet.presses.every(({ dataAvailabilityWarning }) => dataAvailabilityWarning))
  const episode = fleet.presses[0]!.episodes[0]!
  assert.equal(episode.stopId, stopIntelligenceStopId({ pressKey: 'press14', startAt: at(10) }))
  assert.equal(episode.radiusStatusDescription, 'Run Production')
  assert.equal('supportingEvidence' in episode, false)
  assert.deepEqual([fleet.presses[0]!.speedContext.fromUtc, fleet.presses[0]!.speedContext.toUtc], [at(0), at(40)])
  assert.ok(fleet.presses[0]!.speedContext.observations.some(({ atUtc, speed }) => atUtc === at(0) && speed === 800))
  assert.ok(fleet.presses[0]!.speedContext.unknownIntervals.some(({ state }) => state === 'SOURCE_TELEMETRY_UNAVAILABLE'))
  assert.ok(fleet.presses[0]!.speedContext.unknownIntervals.some(({ state }) => state === 'UNKNOWN_SPEED_QUALITY'))
  assert.equal(fleet.presses[0]!.radiusContext.states[0]?.statusCode, '150')
  assert.deepEqual(fleet.presses[0]!.identityContext.map(({ canonicalId, observations }) => [canonicalId, observations.map(({ value }) => value)]), [['production.order', ['ORD-100']], ['production.recipe', ['RECIPE-A']], ['production.material', ['MAT-A', 'MAT-B']]])
  assert.deepEqual(fleet.presses[0]!.rollLengthContext?.observations.map(({ value }) => value), [0, 100, 300, 0, 120])
  assert.equal(fleet.presses[0]!.rollLengthContext?.canonicalId, 'production.roll.length.actual')

  const detail = await service.detail({ pressKey: 'press14', ...range, stopId: episode.stopId })
  assert.ok(detail)
  assert.deepEqual(readOrder, ['press14'])
  assert.deepEqual([detail!.speedContext.fromUtc, detail!.speedContext.toUtc], [at(-5), at(35)])
  assert.deepEqual([detail!.speedContext.stopThreshold, detail!.speedContext.recoveryThreshold], [1, 595])
  assert.ok(detail!.speedContext.unknownIntervals.some(({ state }) => state === 'SOURCE_TELEMETRY_UNAVAILABLE'))
  assert.ok(detail!.speedContext.unknownIntervals.some(({ state }) => state === 'UNKNOWN_SPEED_QUALITY'))
  assert.equal(detail!.stop.physicalSegment.movementAttempts.length, 2)
  assert.equal(detail!.changeoverActions.eligible, true)
  assert.match(detail!.changeoverActions.reason, /every selected physical stop/i)
  assert.ok(detail!.changeoverActions.actions.some(({ actionCode }) => actionCode === 'ROLL_TRANSITION'))
  assert.ok(detail!.changeoverActions.actions.some(({ actionCode }) => actionCode === 'INK_PUMP_ACTIVITY'))
  assert.deepEqual([detail!.radiusContext.fromUtc, detail!.radiusContext.toUtc], [at(-5), at(35)])
  assert.equal(detail!.radiusContext.states[0]?.startUtc, at(-5))
  assert.ok(detail!.actionSignalContext.some(({ canonicalId }) => canonicalId === 'machine.speed.actual'))
  assert.ok(detail!.actionSignalContext.some(({ canonicalId }) => canonicalId === 'production.roll'))
  assert.ok(detail!.actionSignalContext.some(({ canonicalId }) => canonicalId === 'ink.pump.frequency.supply'))
  assert.equal(detail!.deckStatusContext.availability, 'AVAILABLE')
  assert.equal(rawCatalogReads, 1)
  assert.deepEqual(detail!.deckStatusContext.decks.map(({ deckNumber }) => deckNumber), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  assert.equal(detail!.rawUnmappedContext.availability, 'NOT_LOADED')
  assert.equal(rawDiscoveryReads, 0)
  assert.equal(detail!.actionSignalContext.find(({ canonicalId }) => canonicalId === 'production.roll')?.observations[0]?.atUtc, at(-5))
  assert.equal(detail!.actionSignalContext.find(({ canonicalId }) => canonicalId === 'production.roll')?.observations[0]?.value, 'R100')
  assert.deepEqual(detail!.actionSignalContext.find(({ canonicalId }) => canonicalId === 'ink.pump.frequency.supply')?.observations.map(({ value }) => value), [0, 20, 18, 0])
  assert.ok(radiusReads.some((read) => read.pressKey === 'press14' && read.fromUtc === at(-5) && read.toUtc === at(35)))
  assert.equal('changeoverActions' in episode, false)

  const enriched = await service.detail({ pressKey: 'press14', ...range, stopId: episode.stopId, includeRaw: true })
  assert.deepEqual(readOrder, ['press14'])
  assert.equal(rawDiscoveryReads, 1)
  assert.equal(enriched!.rawUnmappedContext.availability, 'UNAVAILABLE')
})

test('fleet speed display projection is bounded while preserving bucket extrema', () => {
  const dense = Array.from({ length: 3_000 }, (_, index): CanonicalSpeedObservation => ({ atUtc: new Date(Date.UTC(2026, 7, 1, 0, 0, index)).toISOString(), speed: index % 5 === 2 ? 0 : index % 5 === 3 ? 900 : 400, qualityState: 'GOOD' }))
  const projected = downsampleFleetSpeed(dense)
  assert.ok(projected.length <= 2_400)
  assert.ok(projected.some(({ speed }) => speed === 0))
  assert.ok(projected.some(({ speed }) => speed === 900))
  assert.equal(projected[0]?.atUtc, dense[0]?.atUtc)
  assert.equal(projected.at(-1)?.atUtc, dense.at(-1)?.atUtc)
})

test('fleet roll-length display projection is bounded while preserving build peaks and resets', () => {
  const values = Array.from({ length: 4_000 }, (_, index) => ({ atUtc: new Date(Date.parse(at(0)) + index * 1_000).toISOString(), value: index % 500, qualityState: 'GOOD' }))
  values[1_999] = { ...values[1_999]!, value: 9_999 }
  values[2_000] = { ...values[2_000]!, value: 0 }
  const projected = downsampleFleetRollLength(values)
  assert.ok(projected.length <= 720 * 4)
  assert.ok(projected.some(({ value }) => value === 9_999))
  assert.ok(projected.some(({ value }) => value === 0))
})

test('records append-only operator corrections separately from immutable predictions', async () => {
  const corrections = new StopIntelligenceCorrectionService(new InMemoryStopIntelligenceCorrectionRepository())
  await corrections.initialize()
  const input = { pressKey: 'press15' as const, segmentKey: 'fleet-running:100:200', fromUtc: at(0), toUtc: at(10), predictedState: 'OBSERVABLE_NON_STOP' as const }
  const first = await corrections.append({ ...input, correctedState: 'CHANGEOVER', comment: 'Test run followed by setup confirmation.' })
  const second = await corrections.append({ ...input, correctedState: 'ROUTINE' })
  const stored = await corrections.list('press15', at(-1), at(11))
  assert.equal(stored.length, 2)
  assert.deepEqual(stored.map(({ predictedState, correctedState }) => [predictedState, correctedState]), [['OBSERVABLE_NON_STOP', 'CHANGEOVER'], ['OBSERVABLE_NON_STOP', 'ROUTINE']])
  assert.notEqual(first.correctionId, second.correctionId)
  assert.equal(first.comment, 'Test run followed by setup confirmation.')
  assert.equal(second.comment, null)
  assert.equal(corrections.persistence, 'memory')
  assert.deepEqual(STOP_OPERATOR_DECISION_STATES, ['CHANGEOVER', 'DOWNTIME', 'ROUTINE', 'GOOD_PRODUCTION'])
})

test('authorizes, validates, and records Stop Intelligence corrections through the application write boundary', async () => {
  const corrections = new StopIntelligenceCorrectionService(new InMemoryStopIntelligenceCorrectionRepository())
  await corrections.initialize()
  const app = createApp({ telemetryClient: {} as TelemetryClient, stopIntelligenceCorrectionService: corrections, classificationAuthorizer: () => ({ id: 'classification.admin', canEdit: true }), logger: false })
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const port = (server.address() as AddressInfo).port
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/stop-intelligence/corrections`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pressKey: 'press5', segmentKey: 'fleet:press5-123:123', fromUtc: at(0), toUtc: at(10), predictedState: 'CHANGEOVER', correctedState: 'DOWNTIME', comment: '  Web break confirmed by operator.  ' }) })
    assert.equal(response.status, 201)
    const body = await response.json() as { predictedState: string; correctedState: string; comment: string | null }
    assert.deepEqual([body.predictedState, body.correctedState], ['CHANGEOVER', 'DOWNTIME'])
    assert.equal(body.comment, 'Web break confirmed by operator.')
    const invalid = await fetch(`http://127.0.0.1:${port}/api/stop-intelligence/corrections`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pressKey: 'press14', segmentKey: 'unsafe segment', fromUtc: at(0), toUtc: at(10), predictedState: 'CHANGEOVER', correctedState: 'ROUTINE' }) })
    assert.equal(invalid.status, 400)
    assert.deepEqual(await invalid.json(), { error: 'invalid_stop_intelligence_segment_key' })
    const invalidComment = await fetch(`http://127.0.0.1:${port}/api/stop-intelligence/corrections`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pressKey: 'press14', segmentKey: 'fleet:press14-123:123', fromUtc: at(0), toUtc: at(10), predictedState: 'CHANGEOVER', correctedState: 'ROUTINE', comment: 'x'.repeat(1_001) }) })
    assert.equal(invalidComment.status, 400)
    assert.deepEqual(await invalidComment.json(), { error: 'invalid_stop_intelligence_correction_comment' })
    const operatorUncertain = await fetch(`http://127.0.0.1:${port}/api/stop-intelligence/corrections`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pressKey: 'press14', segmentKey: 'fleet:press14-123:123', fromUtc: at(0), toUtc: at(10), predictedState: 'UNCERTAIN', correctedState: 'UNCERTAIN' }) })
    assert.equal(operatorUncertain.status, 400)
    assert.deepEqual(await operatorUncertain.json(), { error: 'invalid_stop_intelligence_corrected_state' })
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) }
})

test('rejects unauthorized Stop Intelligence corrections without protecting read-only Stop routes', async () => {
  const corrections = new StopIntelligenceCorrectionService(new InMemoryStopIntelligenceCorrectionRepository())
  await corrections.initialize()
  const app = createApp({ telemetryClient: {} as TelemetryClient, stopIntelligenceCorrectionService: corrections, classificationAuthorizer: () => ({ id: 'viewer', canEdit: false }), logger: false })
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const port = (server.address() as AddressInfo).port
  try {
    const correction = await fetch(`http://127.0.0.1:${port}/api/stop-intelligence/corrections`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pressKey: 'press5', segmentKey: 'fleet:press5-123:123', fromUtc: at(0), toUtc: at(10), predictedState: 'CHANGEOVER', correctedState: 'DOWNTIME' }) })
    assert.equal(correction.status, 403)
    assert.deepEqual(await correction.json(), { error: 'classification_forbidden' })
    assert.deepEqual(await corrections.list('press5', at(-1), at(11)), [])

    const tooLong = new Date(Date.parse(at(0)) + 73 * 60 * 60_000).toISOString()
    const readOnly = await fetch(`http://127.0.0.1:${port}/api/stop-intelligence/fleet?pressKey=press5&fromUtc=${encodeURIComponent(at(0))}&toUtc=${encodeURIComponent(tooLong)}`)
    assert.equal(readOnly.status, 400)
    assert.deepEqual(await readOnly.json(), { error: 'stop_intelligence_range_too_large' })
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) }
})

test('validates fleet and selected-stop API bounds and identifiers before any source read', async () => {
  const app = createApp({ telemetryClient: {} as TelemetryClient, logger: false })
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const port = (server.address() as AddressInfo).port
  try {
    const tooLong = new Date(Date.parse(at(0)) + 73 * 60 * 60_000).toISOString()
    const fleet = await fetch(`http://127.0.0.1:${port}/api/stop-intelligence/fleet?pressKey=press14&fromUtc=${encodeURIComponent(at(0))}&toUtc=${encodeURIComponent(tooLong)}`)
    assert.equal(fleet.status, 400)
    assert.deepEqual(await fleet.json(), { error: 'stop_intelligence_range_too_large' })
    const detail = await fetch(`http://127.0.0.1:${port}/api/stop-intelligence/presses/press14/stops/not-a-stop?fromUtc=${encodeURIComponent(at(0))}&toUtc=${encodeURIComponent(at(10))}`)
    assert.equal(detail.status, 400)
    assert.deepEqual(await detail.json(), { error: 'invalid_stop_intelligence_stop_id' })
    const invalidRaw = await fetch(`http://127.0.0.1:${port}/api/stop-intelligence/presses/press14/stops/press14-123?fromUtc=${encodeURIComponent(at(0))}&toUtc=${encodeURIComponent(at(10))}&includeRaw=1`)
    assert.equal(invalidRaw.status, 400)
    assert.deepEqual(await invalidRaw.json(), { error: 'invalid_include_raw' })
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

function actionSignal(canonicalId: string, deckNumber: number | null, historianSignalId: number, rawSignalId: string, transitions: Array<[number, string | number | boolean, string | number | boolean]>, seedValue?: string | number | boolean): PressSemanticSignalWithIdentity {
  const point = (minute: number, value: string | number | boolean) => ({ observedAtUtc: at(minute), receivedAtUtc: at(minute), sourceTimestampUtc: at(minute), qualityState: 'GOOD', valueKind: typeof value === 'number' ? 'numeric' as const : typeof value === 'boolean' ? 'boolean' as const : 'string' as const, value })
  return { canonicalId, deckNumber, capabilityState: 'SUPPORTED', observationState: 'SUPPORTED_WITH_OBSERVATIONS', mappingStatus: 'MAPPED', historianSignalId, rawSignalId, sourceSelector: deckNumber === null ? null : `[${deckNumber}]`, selectedVariant: 'primary', sourceUnit: null, canonicalUnitStatus: 'not_applicable', representation: 'changes', seed: seedValue === undefined ? null : point(-60, seedValue), samples: [], changes: transitions.map(([minute, previousValue, value]) => ({ ...point(minute, value), previousObservedAtUtc: at(minute - 1), previousReceivedAtUtc: at(minute - 1), previousSourceTimestampUtc: at(minute - 1), previousQualityState: 'GOOD', previousValueKind: typeof previousValue === 'number' ? 'numeric' as const : typeof previousValue === 'boolean' ? 'boolean' as const : 'string' as const, previousValue })) }
}

function actionFixture(radius = noRadius()) {
  const segment = physical({ pressKey: 'press15', sourceId: 34, speedSignalId: 222, startAt: at(10), endAt: at(60), physicalDurationSeconds: 3_000, zeroSpeedSeconds: 2_100, lowMovementSeconds: 300, movementAttempts: [
    { startAt: at(25), endAt: at(27), durationSeconds: 120, averageSpeed: 250, peakSpeed: 400, reachedRecoveryThreshold: false, failedRecoveryCount: 0, sequenceNumber: 1 },
    { startAt: at(35), endAt: at(38), durationSeconds: 180, averageSpeed: 800, peakSpeed: 900, reachedRecoveryThreshold: true, failedRecoveryCount: 1, sequenceNumber: 2 },
    { startAt: at(50), endAt: at(50), durationSeconds: 0, averageSpeed: 700, peakSpeed: 700, reachedRecoveryThreshold: true, failedRecoveryCount: 0, sequenceNumber: 3 },
  ], failedRecoveryCount: 1, failedRecoveryStreaks: [{ startAt: at(35), endAt: at(38), durationSeconds: 180, reason: 'DROPPED_BELOW_RECOVERY', movementAttemptSequenceNumber: 2 }] })
  const stop = classify({ segment, identities: [identity('order', 'STRONG', true)], families: [family('DECK', true, true), family('WASH_PUMP_INK'), family('IMPRESSION'), family('REGISTRATION')], radius })
  const signals: PressSemanticSignalWithIdentity[] = [
    actionSignal('production.order', null, 230, 'P15.Order', [[12, '1853', '1854']]),
    actionSignal('production.roll', null, 231, 'P15.Roll', [[13, 'R100', 'R101']]),
    actionSignal('deck.active', 1, 301, 'P15.Color[1].Position', [[14, 1, 2]]), actionSignal('deck.active', 2, 302, 'P15.Color[2].Position', [[15, 1, 2]]),
    actionSignal('ink.washup.state', 1, 311, 'P15.Ink[1].WASHING', [[18, 0, 512]]), actionSignal('ink.pump.status', 1, 312, 'P15.Ink[1].PUMPING', [[22, 1, 11]]),
    actionSignal('impression.anilox.drive_side', 1, 321, 'P15.Impression[1]', [[28, 0, 20]]), actionSignal('impression.plate_cylinder.drive_side', 2, 322, 'P15.Impression[2]', [[29, 0, 18]]),
    actionSignal('register.long.actual_or_correction', 1, 331, 'P15.RegisterLong[1]', [[31, 0, 0.2], [33, 0.2, 0.3]]), actionSignal('register.side.actual_or_correction', 2, 332, 'P15.RegisterSide[2]', [[32, 0, -0.1]]),
  ]
  return { stop, signals, segment }
}

function rawHistory(rawIdentity: string, displayName: string, values: Array<[number, string | number | boolean]>): RawTelemetryHistoryResponse {
  return {
    press: 'press15', displayName: 'Press 15', rawIdentity, signalDisplayName: displayName,
    dataType: values.some(([, value]) => typeof value === 'number') ? 'numeric' : 'boolean', dataKind: values.some(([, value]) => typeof value === 'number') ? 'numeric' : 'state',
    sourceUnit: null, plottable: true, fromUtc: at(-5), toUtc: at(75), historianReadCount: 1, alternateRepresentationCount: 0, alternateRawIdentities: [],
    observations: values.map(([minute, rawValue]) => ({ timestampUtc: at(minute), receivedAtUtc: at(minute), sourceTimestampUtc: at(minute), qualityState: 'GOOD', dataType: typeof rawValue, rawValue })),
  }
}

test('detects each required canonical changeover activity separately and only inside the physical stop', () => {
  const fixture = actionFixture()
  const detected = detectRequiredChangeoverActivity({ segment: fixture.segment, signals: fixture.signals, rangeEndUtc: at(90), evidenceCutoffUtc: at(90) })
  assert.deepEqual(detected, { washActivity: true, pumpInkActivity: true, impressionAdjustment: true })
  const without = (prefix: string) => fixture.signals.filter(({ canonicalId }) => !canonicalId.startsWith(prefix))
  assert.equal(detectRequiredChangeoverActivity({ segment: fixture.segment, signals: without('ink.washup.'), rangeEndUtc: at(90), evidenceCutoffUtc: at(90) }).washActivity, false)
  assert.equal(detectRequiredChangeoverActivity({ segment: fixture.segment, signals: without('ink.pump.'), rangeEndUtc: at(90), evidenceCutoffUtc: at(90) }).pumpInkActivity, false)
  assert.equal(detectRequiredChangeoverActivity({ segment: fixture.segment, signals: without('impression.'), rangeEndUtc: at(90), evidenceCutoffUtc: at(90) }).impressionAdjustment, false)
  const beforeOnly = [...fixture.signals.filter(({ canonicalId }) => canonicalId !== 'ink.washup.state'), actionSignal('ink.washup.state', 1, 999, 'P15.Ink[1].WASHING', [[5, 0, 512]])]
  assert.equal(detectRequiredChangeoverActivity({ segment: fixture.segment, signals: beforeOnly, rangeEndUtc: at(90), evidenceCutoffUtc: at(90) }).washActivity, false)
})

test('discovers Press 12 and 13 array deck containers and derives only Decks 1-10', () => {
  for (const pressNumber of [12, 13]) {
    const catalog = ['active', 'deck_out', 'print_on', 'print_off'].map((displayName, index) => ({ id: index + 1, sourceId: pressNumber, signalId: `Press${pressNumber}.PLC.deck.${displayName}`, displayName, sourceUnit: null, valueKind: 'string', enabled: true }))
    catalog.push({ id: 9, sourceId: pressNumber, signalId: `Press${pressNumber}.PLC.gravure.print_on`, displayName: 'print_on', sourceUnit: null, valueKind: 'string', enabled: true })
    assert.deepEqual(deckStatusRawCandidates(catalog).map(({ role }) => role).sort(), ['active', 'deck_out', 'print_off', 'print_on'])
    const arrayHistory = (role: 'active' | 'deck_out' | 'print_on' | 'print_off', values: Array<[number, number[]]>): { role: typeof role; history: RawTelemetryHistoryResponse } => ({ role, history: {
      press: `press${pressNumber}` as 'press12' | 'press13', displayName: `Press ${pressNumber}`, rawIdentity: `Press${pressNumber}.PLC.deck.${role}`, signalDisplayName: role, dataType: 'container', dataKind: 'container', sourceUnit: null, plottable: false, fromUtc: at(-5), toUtc: at(75), historianReadCount: 1, alternateRepresentationCount: 0, alternateRawIdentities: [],
      observations: values.map(([minute, rawValue]) => ({ timestampUtc: at(minute), receivedAtUtc: at(minute), sourceTimestampUtc: at(minute), qualityState: 'GOOD', dataType: 'container', rawValue })),
    } })
    const off = [0, ...Array(10).fill(0), 0, 0]; const on = [0, ...Array(10).fill(1), 0, 0]
    const context = buildDeckStatusContext([
      arrayHistory('active', [[-5, on]]), arrayHistory('print_on', [[-5, on], [10, off], [60, on]]),
      arrayHistory('deck_out', [[-5, off], [10, on], [20, off]]), arrayHistory('print_off', [[-5, off], [10, on], [11, off]]),
    ], at(0), at(75))
    assert.equal(context.availability, 'AVAILABLE')
    assert.deepEqual(context.decks.map(({ deckNumber }) => deckNumber), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    assert.deepEqual(context.decks[0]?.intervals.map(({ state }) => state), ['PRINTING', 'OUT', 'READY', 'PRINTING'])
    assert.deepEqual(context.decks[0]?.events, [{ atUtc: at(10), kind: 'PRINT_OFF_COMMAND', label: 'Print-off command' }])
  }
})

test('normalizes scalar indexed deck status used by presses 3-11 and ignores auxiliary indexes', () => {
  for (const pressNumber of [3, 5, 6, 7, 8, 9, 10, 11]) {
    const catalog = ['active', 'deck_out', 'print_on', 'print_off'].flatMap((role, roleIndex) => Array.from({ length: 13 }, (_, index) => ({
      id: roleIndex * 20 + index, sourceId: pressNumber, signalId: `DA.BuRServer.Press${pressNumber}.deck_${role}[${index}]`, displayName: `deck_${role}`, sourceUnit: null, valueKind: 'integer', enabled: true,
    })))
    const candidates = deckStatusRawCandidates(catalog)
    assert.equal(candidates.length, 40)
    assert.deepEqual([...new Set(candidates.map(({ deckNumber }) => deckNumber))], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    const scalarHistory = (role: 'active' | 'deck_out' | 'print_on' | 'print_off', deckNumber: number, values: Array<[number, boolean]>) => ({
      role, deckNumber, history: rawHistory(`DA.BuRServer.Press${pressNumber}.deck_${role}[${deckNumber}]`, `deck_${role}`, values),
    })
    const histories = Array.from({ length: 10 }, (_, index) => index + 1).flatMap((deckNumber) => [
      scalarHistory('active', deckNumber, [[-5, true]]),
      scalarHistory('print_on', deckNumber, [[-5, true], [10, false], [60, true]]),
      scalarHistory('deck_out', deckNumber, [[-5, false], [10, true], [20, false]]),
      scalarHistory('print_off', deckNumber, [[-5, false], [10, true], [11, false]]),
    ])
    const context = buildDeckStatusContext(histories, at(0), at(75))
    assert.equal(context.availability, 'AVAILABLE')
    assert.deepEqual(context.decks[9]?.intervals.map(({ state }) => state), ['PRINTING', 'OUT', 'READY', 'PRINTING'])
  }
})

test('normalizes the validated Ruby Status and Position contract for Presses 14 and 15', () => {
  for (const pressNumber of [14, 15]) {
    const catalog = Array.from({ length: 10 }, (_, index) => index + 1).flatMap((deckNumber, index) => [
      { id: index * 2 + 1, sourceId: pressNumber, signalId: `Ruby.Press${pressNumber}.Line${pressNumber}.ProcessData.Color deck ${deckNumber}.Status [0/1]`, displayName: `Color deck ${deckNumber}.Status`, sourceUnit: null, valueKind: 'boolean', enabled: true },
      { id: index * 2 + 2, sourceId: pressNumber, signalId: `Ruby.Press${pressNumber}.Line${pressNumber}.ProcessData.Color deck ${deckNumber}.Position [#]`, displayName: `Color deck ${deckNumber}.Position`, sourceUnit: null, valueKind: 'number', enabled: true },
    ])
    catalog.push({ id: 99, sourceId: pressNumber, signalId: `Ruby.Press${pressNumber}.Line${pressNumber}.ProcessData.Color deck 11.Position [#]`, displayName: 'Color deck 11.Position', sourceUnit: null, valueKind: 'number', enabled: true })
    const candidates = deckStatusRawCandidates(catalog)
    assert.equal(candidates.length, 20)
    assert.deepEqual([...new Set(candidates.map(({ role }) => role))].sort(), ['position', 'status'])
    assert.deepEqual([...new Set(candidates.map(({ deckNumber }) => deckNumber))], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])

    const histories = candidates.map((candidate) => ({
      ...candidate,
      history: rawHistory(candidate.rawIdentity, candidate.rawIdentity, candidate.role === 'status'
        ? [[-5, true], [40, false], [50, true]]
        : [[-5, 3], [10, 1], [20, 2], [30, 3], [40, 1], [50, 0]]),
    }))
    const context = buildDeckStatusContext(histories, at(0), at(75))
    assert.equal(context.availability, 'AVAILABLE')
    assert.match(context.reason, /Validated Ruby Status\/Position telemetry/)
    assert.deepEqual(context.decks[0]?.intervals.map(({ state }) => state), ['PRINTING', 'OUT', 'READY', 'PRINTING', 'INACTIVE', 'UNKNOWN'])
    assert.deepEqual(context.decks[0]?.intervals.map(({ active, printing, out }) => ({ active, printing, out })), [
      { active: true, printing: true, out: false },
      { active: true, printing: false, out: true },
      { active: true, printing: false, out: false },
      { active: true, printing: true, out: false },
      { active: false, printing: false, out: false },
      { active: true, printing: null, out: null },
    ])
  }
})

test('selects complete per-deck wash, pump, impression, and deck evidence beyond the former fleet cap', () => {
  const ids = [
    'ink.washup.state', 'ink.pump.status', 'ink.pump.sequence', 'ink.pump.frequency.supply', 'ink.pump.frequency.return', 'ink.viscosity.mode', 'ink.viscosity.status',
    ...Array.from({ length: 14 }, (_, index) => `impression.test_${index + 1}`),
    'deck.active', 'deck.print_on', 'deck.print_off', 'register.long.actual_or_correction',
  ]
  const capabilities = { pressKey: 'press3', sourceId: 3, sourceKey: 'press3', displayName: 'Press 3', metadataStatus: 'FRESH', capabilities: ids.map((canonicalId) => ({ canonicalId, state: 'SUPPORTED', deckNumbers: Array.from({ length: 10 }, (_, index) => index + 1), historyQueryable: true, evidenceKind: 'semantic_history' })) } as PressEvidenceCapabilities
  const selection = evidenceSelectors('press3', capabilities)
  assert.ok(selection.selectors.length > 120)
  for (const prefix of ['ink.washup.', 'ink.pump.', 'ink.viscosity.', 'impression.', 'deck.']) assert.ok(selection.selectors.some(({ canonicalId, deckNumber }) => canonicalId.startsWith(prefix) && deckNumber === 10), prefix)
})

test('uses typed staged selectors instead of full-day dense analog and investigation evidence', () => {
  const ids = [
    'production.order', 'production.recipe', 'production.roll', 'production.roll.length.actual',
    'ink.washup.state', 'ink.pump.status', 'ink.pump.sequence', 'ink.pump.frequency.supply', 'ink.pump.frequency.return', 'ink.viscosity.mode', 'ink.viscosity.status',
    'impression.plate_cylinder.drive_side', 'deck.active', 'register.long.actual_or_correction',
  ]
  const capabilities = { pressKey: 'press11', sourceId: 25, sourceKey: 'press11', displayName: 'Press 11', metadataStatus: 'FRESH', capabilities: ids.map((canonicalId) => ({ canonicalId, state: 'SUPPORTED', deckNumbers: canonicalId.startsWith('production.') ? [] : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], historyQueryable: true, evidenceKind: 'semantic_history' })) } as PressEvidenceCapabilities
  const full = evidenceSelectors('press11', capabilities)
  const overview = overviewEvidenceSelectors('press11', capabilities)
  const followup = candidateClassificationSelectors('press11', capabilities)
  const frequency = pumpFrequencySelectors('press11', capabilities)

  assert.equal(full.selectors.find(({ canonicalId }) => canonicalId === 'production.roll.length.actual')?.representation, 'samples')
  assert.ok(overview.selectors.some(({ canonicalId, deckNumber }) => canonicalId === 'ink.washup.state' && deckNumber === 10))
  assert.ok(!overview.selectors.some(({ canonicalId }) => canonicalId.startsWith('impression.') || canonicalId.startsWith('deck.') || canonicalId.startsWith('register.') || canonicalId.startsWith('ink.pump.')))
  assert.ok(followup.selectors.some(({ canonicalId }) => canonicalId.startsWith('impression.')))
  assert.ok(followup.selectors.some(({ canonicalId }) => canonicalId === 'ink.pump.status'))
  assert.ok(!followup.selectors.some(({ canonicalId }) => canonicalId.startsWith('ink.pump.frequency.')))
  assert.equal(frequency.length, 20)
  assert.ok(frequency.every(({ representation }) => representation === 'samples'))
})

test('loads only wash on the overview, then direct pump and impression evidence for a viable stop', async () => {
  const queries: Array<Array<{ canonicalId: string; deckNumber?: number | null; representation: string }>> = []
  const capabilities = [
    ['production.order', []], ['production.recipe', []], ['production.roll', []], ['production.roll.length.actual', []],
    ['ink.washup.state', [1]], ['ink.pump.status', [1]], ['ink.pump.frequency.supply', [1]],
    ['impression.plate_cylinder.drive_side', [1]], ['deck.active', [1]], ['register.long.actual_or_correction', [1]],
  ].map(([canonicalId, deckNumbers]) => ({ canonicalId, state: 'SUPPORTED', deckNumbers, historyQueryable: true, evidenceKind: 'semantic_history' }))
  const availableSignals = [
    { canonicalId: 'machine.speed.actual', deckNumber: null, historianSignalId: 204, seed: null, samples: telemetrySamples([[-10, 800], [10, 0], [15, 100], [18, 0], [20, 700], [27, 700], [30, 800]]), changes: [] },
    actionSignal('ink.washup.state', 1, 205, 'Press14.Wash[1]', [[12, false, true]], false),
    actionSignal('ink.pump.status', 1, 206, 'Press14.PumpStatus[1]', [[14, false, true]], false),
    actionSignal('impression.plate_cylinder.drive_side', 1, 207, 'Press14.Impression[1]', [[16, 0, 4]], 0),
  ]
  const telemetry = {
    sources: { resolve: async () => ({ pressKey: 'press14', source: { id: 1, sourceKey: 'press14', displayName: 'Press 14', enabled: true }, metadataStatus: 'FRESH' }) },
    capabilities: { get: async () => ({ pressKey: 'press14', sourceId: 1, sourceKey: 'press14', displayName: 'Press 14', metadataStatus: 'FRESH', capabilities }) },
    semanticHistoryWithIdentity: async (_pressKey: string, query: { fromUtc: string; toUtc: string; includeSeed: boolean; signals: Array<{ canonicalId: string; deckNumber?: number | null; representation: string }> }) => {
      queries.push(query.signals)
      const signals = availableSignals.filter((candidate) => query.signals.some((selector) => selector.canonicalId === candidate.canonicalId && (selector.deckNumber ?? null) === candidate.deckNumber))
      return { pressKey: 'press14', sourceKey: 'press14', displayName: 'Press 14', fromUtc: query.fromUtc, toUtc: query.toUtc, includeSeed: query.includeSeed, signals, readDiagnostics: { gaps: [], sourceGaps: [] } }
    },
  } as unknown as TelemetryFoundationService
  const service = new StopIntelligenceService(telemetry, undefined, () => Date.parse(at(120)))

  const report = await service.fleet({ pressKey: 'press14', fromUtc: at(0), toUtc: at(40) })

  assert.equal(report.presses[0]?.episodes[0]?.classification, 'CHANGEOVER')
  assert.equal(queries.length, 2)
  assert.ok(queries[0]!.some(({ canonicalId }) => canonicalId === 'ink.washup.state'))
  assert.ok(!queries[0]!.some(({ canonicalId }) => canonicalId.startsWith('ink.pump.') || canonicalId.startsWith('impression.')))
  assert.ok(queries[1]!.some(({ canonicalId }) => canonicalId === 'ink.pump.status'))
  assert.ok(queries[1]!.some(({ canonicalId }) => canonicalId.startsWith('impression.')))
  assert.ok(queries.every((selectors) => !selectors.some(({ canonicalId }) => canonicalId.startsWith('ink.pump.frequency.') || canonicalId.startsWith('deck.') || canonicalId.startsWith('register.'))))
})

test('keeps raw/unmapped observations visible below the chronology even when behavior repeats in all phases', () => {
  const fixture = actionFixture()
  const actions = buildUncanonicalizedRawActions({ stop: fixture.stop, allStops: [fixture.stop], histories: [rawHistory('P15.unique.unmapped', 'Unmapped analog', [[0, 0], [5, 1], [12, 2], [65, 3]])] })
  assert.deepEqual(actions.map(({ startAt }) => startAt), [at(5), at(12), at(65)])
})

test('keeps every changing raw identity independently selectable within its stop phase', () => {
  const fixture = actionFixture()
  const actions = buildUncanonicalizedRawActions({ stop: fixture.stop, allStops: [fixture.stop], histories: [
    rawHistory('P15.unique.first', 'First unmapped signal', [[10, 0], [12, 1], [14, 2]]),
    rawHistory('P15.unique.second', 'Second unmapped signal', [[10, false], [13, true]]),
  ] })
  assert.equal(actions.length, 2)
  assert.deepEqual(actions.map(({ evidence }) => [...new Set(evidence.map(({ rawIdentity }) => rawIdentity))]), [['P15.unique.first'], ['P15.unique.second']])
  assert.deepEqual(actions.map(({ displayName }) => displayName), ['First unmapped signal', 'Second unmapped signal'])
  assert.ok(actions.every(({ startAt }) => startAt && Date.parse(startAt) >= Date.parse(fixture.stop.physicalSegment.startAt)))
})

test('separates raw numeric transitions into before, during, and after chronology markers', () => {
  const fixture = actionFixture()
  const actions = buildUncanonicalizedRawActions({ stop: fixture.stop, allStops: [fixture.stop], histories: [rawHistory('P15.unique.level', 'Unmapped phase level', [[0, 10], [2, 11], [4, 10], [6, 11], [12, 50], [14, 51], [16, 50], [18, 51], [65, 10], [67, 11], [69, 10], [71, 11]])] })
  assert.equal(actions.length, 3)
  assert.ok(actions.every(({ displayName }) => displayName === 'Unmapped phase level'))
  assert.ok(actions.some(({ evidence }) => evidence.every(({ atUtc }) => Date.parse(atUtc) < Date.parse(fixture.stop.physicalSegment.startAt))))
  assert.ok(actions.some(({ evidence }) => evidence.every(({ atUtc }) => Date.parse(atUtc) >= Date.parse(fixture.stop.physicalSegment.endAt!))))
})

test('applies phase-context behavior filtering to canonical action variables, not only pump frequency', () => {
  const fixture = actionFixture()
  const repeatedImpression = actionSignal('impression.anilox.drive_side', 1, 350, 'P15.ImpressionRepeated[1]', [[2, 0, 1], [20, 1, 2], [65, 2, 3]])
  const signals = [...fixture.signals.filter(({ canonicalId }) => !canonicalId.startsWith('impression.')), repeatedImpression]
  const analysis = buildChangeoverActions({ stop: fixture.stop, allStops: [fixture.stop], signals, rangeEndUtc: at(90), evidenceCutoffUtc: at(90) })
  assert.equal(analysis.actions.some(({ actionCode }) => actionCode === 'IMPRESSION_ADJUSTMENT'), false)
  assert.equal(analysis.actions.some(({ actionCode }) => actionCode === 'WASH_ACTIVITY'), true)
})

test('discovers every eligible unmapped signal but bounds eager raw-history enrichment to the most active candidates', () => {
  const candidate = (index: number) => ({ rawIdentity: `P15.unique.raw_${index}`, displayName: `Raw ${index}`, dataKind: 'numeric', plottable: true, changeCount: index + 1, unavailableObservationCount: 0, alternateRawIdentities: [] })
  const eligible = Array.from({ length: 30 }, (_, index) => candidate(index))
  const inputs = [
    ...eligible,
    { ...candidate(31), rawIdentity: 'P15.mapped.direct' },
    { ...candidate(32), rawIdentity: 'P15.unique.alternate', alternateRawIdentities: ['P15.mapped.alternate'] },
    { ...candidate(33), rawIdentity: 'P15.unique.unavailable', unavailableObservationCount: 1 },
    { ...candidate(34), rawIdentity: 'P15.unique.container', dataKind: 'container' },
  ] as Parameters<typeof uncanonicalizedRawCandidates>[0]
  const selected = uncanonicalizedRawCandidates(inputs, ['P15.mapped.direct', 'P15.mapped.alternate'])
  assert.equal(selected.length, 30)
  assert.ok(selected.every(({ rawIdentity }) => rawIdentity.startsWith('P15.unique.raw_')))
  const bounded = selectBoundedRawEvidenceCandidates(inputs, ['P15.mapped.direct', 'P15.mapped.alternate'])
  assert.equal(bounded.discovered.length, 30)
  assert.equal(bounded.selected.length, STOP_DETAIL_RAW_EVIDENCE_LIMIT)
  assert.deepEqual(bounded.selected.map(({ changeCount }) => changeCount), [...bounded.selected.map(({ changeCount }) => changeCount)].sort((left, right) => right - left))
})

test('represents complementary raw print on/off transitions once', () => {
  const fixture = actionFixture()
  const actions = buildUncanonicalizedRawActions({ stop: fixture.stop, allStops: [fixture.stop], histories: [
    rawHistory('P15.unique.deck.print_on', 'deck.print_on', [[10, false], [12, true]]),
    rawHistory('P15.unique.deck.print_off', 'deck.print_off', [[10, true], [12, false]]),
  ] })
  assert.equal(actions.length, 1)
  assert.equal(actions[0]?.evidenceCount, 1)
  assert.equal(actions[0]?.evidence[0]?.rawIdentity, 'P15.unique.deck.print_on')
  assert.match(actions[0]?.evidence[0]?.explanation ?? '', /represented once/i)
})

test('Phase 4 orders component actions chronologically without duplicating speed-derived physical context', () => {
  const fixture = actionFixture(); const analysis = buildChangeoverActions({ stop: fixture.stop, allStops: [fixture.stop], signals: fixture.signals, speedSignal: actionSignal('machine.speed.actual', null, 222, 'P15.ActualSpeed', []), rangeEndUtc: at(90), evidenceCutoffUtc: at(90) })
  assert.equal(analysis.eligible, true)
  const times = analysis.actions.map(({ startAt }) => Date.parse(startAt!))
  assert.deepEqual(times, [...times].sort((left, right) => left - right))
  for (const code of ['PREVIOUS_JOB_FINISHED', 'JOB_IDENTITY_TRANSITION', 'ROLL_TRANSITION', 'DECK_MOVEMENT', 'WASH_ACTIVITY', 'INK_PUMP_ACTIVITY', 'IMPRESSION_ADJUSTMENT', 'REGISTRATION_ADJUSTMENT']) assert.ok(analysis.actions.some((item) => item.actionCode === code && ['DETECTED', 'INFERRED'].includes(item.confidence)), code)
  for (const code of ['TRIAL_RUN', 'FAILED_RECOVERY', 'PHYSICAL_RECOVERY']) {
    assert.equal(analysis.actions.some((item) => item.actionCode === code), false)
    assert.equal(analysis.notDirectlyConfirmed.some((item) => item.actionCode === code), false)
  }
  assert.equal(fixture.segment.movementAttempts.length, 3)
  assert.equal(fixture.segment.failedRecoveryStreaks.length, 1)
  assert.equal(analysis.actions.some((item) => item.displayName === 'Slow Setup Run'), false)
})

test('uses direct pump sequence, frequency on/off boundaries, and viscosity mode without treating analog drift as activity', () => {
  const fixture = actionFixture()
  const signals = [...fixture.signals,
    actionSignal('ink.pump.sequence', 1, 340, 'P15.Ink[1].PumpSequence', [[16, 0, 1]]),
    actionSignal('ink.pump.frequency.supply', 1, 341, 'P15.Ink[1].SupplyFrequency', [[17, 0, 20], [18, 20, 18], [19, 18, 0]]),
    actionSignal('ink.viscosity.mode', 1, 342, 'P15.Ink[1].ViscosityMode', [[20, 'AUTO', 'MANUAL']]),
  ]
  const analysis = buildChangeoverActions({ stop: fixture.stop, allStops: [fixture.stop], signals, rangeEndUtc: at(90), evidenceCutoffUtc: at(90) })
  const evidence = analysis.actions.filter(({ actionCode }) => actionCode === 'INK_PUMP_ACTIVITY').flatMap((item) => item.evidence)
  assert.ok(evidence.some(({ canonicalId }) => canonicalId === 'ink.pump.sequence'))
  assert.ok(evidence.some(({ canonicalId }) => canonicalId === 'ink.viscosity.mode'))
  assert.deepEqual(evidence.filter(({ canonicalId }) => canonicalId === 'ink.pump.frequency.supply').map(({ newValue }) => newValue), [20, 0])
  assert.equal(STOP_FAMILY_CANONICAL_PATTERNS.some(({ matches }) => matches('ink.viscosity.actual')), false)
  assert.equal(STOP_FAMILY_CANONICAL_PATTERNS.some(({ matches }) => matches('ink.temperature.actual')), false)
})

test('rejects pump-frequency cycling repeated before and after the stop while retaining direct wash evidence', () => {
  const fixture = actionFixture()
  const repeatedFrequency = actionSignal('ink.pump.frequency.supply', 1, 341, 'P15.Ink[1].SupplyFrequency', [
    [2, 0, 20], [4, 20, 0],
    [20, 0, 20], [22, 20, 0],
    [65, 0, 20], [67, 20, 0],
  ])
  const signals = [...fixture.signals.filter(({ canonicalId }) => canonicalId !== 'ink.pump.status'), repeatedFrequency]
  const analysis = buildChangeoverActions({ stop: fixture.stop, allStops: [fixture.stop], signals, rangeEndUtc: at(90), evidenceCutoffUtc: at(90) })
  assert.equal(analysis.actions.some(({ actionCode }) => actionCode === 'INK_PUMP_ACTIVITY'), false)
  assert.equal(analysis.actions.some(({ actionCode }) => actionCode === 'WASH_ACTIVITY'), true)

  const evidence = buildStopEvidence({ pressKey: 'press15', segment: fixture.segment, allSegments: [fixture.segment], signals, physicalRangeEndUtc: at(90), identityEvidenceCutoffUtc: at(90), identityAssociationConfiguration: stopIdentityAssociationConfiguration('press15')!, supportedFamilies: ['WASH_PUMP_INK'] })
  const washPump = evidence.families.find(({ family }) => family === 'WASH_PUMP_INK')!
  assert.equal(washPump.observed, true)
  assert.deepEqual(washPump.canonicalIds, ['ink.washup.state'])
})

test('groups coordinated deck, impression, and registration bursts while retaining exact evidence identities', () => {
  const fixture = actionFixture(); const duplicateAlias = { ...fixture.signals.find(({ historianSignalId }) => historianSignalId === 331)!, rawSignalId: 'P15.RegisterLongAlias[1]' }
  const analysis = buildChangeoverActions({ stop: fixture.stop, allStops: [fixture.stop], signals: [...fixture.signals, duplicateAlias], rangeEndUtc: at(90), evidenceCutoffUtc: at(90) })
  const deck = analysis.actions.filter(({ actionCode }) => actionCode === 'DECK_MOVEMENT'); const impression = analysis.actions.filter(({ actionCode }) => actionCode === 'IMPRESSION_ADJUSTMENT'); const registration = analysis.actions.filter(({ actionCode }) => actionCode === 'REGISTRATION_ADJUSTMENT')
  assert.deepEqual([deck.length, impression.length, registration.length], [1, 1, 1])
  assert.equal(deck[0]?.evidenceCount, 2)
  assert.equal(registration[0]?.evidenceCount, 3)
  assert.deepEqual(registration[0]?.evidence.map(({ signalId, rawIdentity, deckNumber }) => [signalId, rawIdentity, deckNumber]), [[331, 'P15.RegisterLong[1]', 1], [332, 'P15.RegisterSide[2]', 2], [331, 'P15.RegisterLong[1]', 1]])
  assert.ok(registration[0]?.evidence.every(({ originalQuality, normalizedQuality }) => originalQuality === 'GOOD' && normalizedQuality === 'GOOD'))
})

test('keeps Deck Out/In directional semantics inferred and branded or unmapped stages UNKNOWN', () => {
  const fixture = actionFixture(); const analysis = buildChangeoverActions({ stop: fixture.stop, allStops: [fixture.stop], signals: fixture.signals, rangeEndUtc: at(90), evidenceCutoffUtc: at(90) })
  assert.match(analysis.actions.find(({ actionCode }) => actionCode === 'DECK_MOVEMENT')?.operatorConcept ?? '', /Likely Deck Out \/ Deck In; direction is not established/)
  for (const code of ['VISTAPORT_ACTIVITY', 'CHOPOVER', 'KNIFE_CUTTING_ACTIVITY', 'MASTER_IMAGE_RUN']) assert.equal(analysis.notDirectlyConfirmed.find((item) => item.actionCode === code)?.confidence, 'UNKNOWN')
})

test('treats Radius-only color evidence as INFERRED and separate from direct telemetry actions', () => {
  const radius = { ...noRadius(), alignment: 'PARTIAL' as const, states: [{ kind: 'radius' as const, startUtc: at(40), endUtc: at(45), eventType: 'M', statusCode: 'CM', statusDescription: 'Color Match', isProduction: false }] }
  const fixture = actionFixture(radius); const analysis = buildChangeoverActions({ stop: fixture.stop, allStops: [fixture.stop], signals: fixture.signals, rangeEndUtc: at(90), evidenceCutoffUtc: at(90) })
  const color = analysis.actions.find(({ actionCode }) => actionCode === 'COLOR_RELATED_ACTIVITY')!
  assert.equal(color.confidence, 'INFERRED')
  assert.equal(color.evidence[0]?.signalId, null)
  assert.equal(color.evidence[0]?.originalQuality, 'RADIUS_ANNOTATION')
})

test('P14 Recipe changeover excludes natural Anilox torque and temperature decay from direct Anilox activity', () => {
  const segment = physical({ startAt: at(10), endAt: at(30), physicalDurationSeconds: 1_200 }); const stop = classify({ segment, identities: [identity('recipe', 'STRONG', true)], families: [family('DECK', true, true), family('ANILOX'), family('IMPRESSION'), family('REGISTRATION')] })
  const signals = [actionSignal('production.recipe', null, 205, 'P14.Recipe', [[12, 'R1', 'R2']]), actionSignal('deck.active', 1, 401, 'P14.Deck[1]', [[14, 1, 2]]), actionSignal('deck.active', 2, 402, 'P14.Deck[2]', [[14, 1, 2]]), actionSignal('anilox.drive.torque.actual', 1, 403, 'P14.AniloxTorque[1]', [[16, 14, 10]]), actionSignal('anilox.drive.temperature.actual', 1, 406, 'P14.AniloxTemperature[1]', [[17, 90, 70]]), actionSignal('impression.anilox.drive_side', 1, 404, 'P14.Impression[1]', [[18, 0, 12]]), actionSignal('register.long.actual_or_correction', 1, 405, 'P14.Register[1]', [[20, 0, 0.2]])]
  const analysis = buildChangeoverActions({ stop, allStops: [stop], signals, rangeEndUtc: at(60), evidenceCutoffUtc: at(60) })
  for (const code of ['DECK_MOVEMENT', 'IMPRESSION_ADJUSTMENT', 'REGISTRATION_ADJUSTMENT']) assert.ok(analysis.actions.some((item) => item.actionCode === code), code)
  assert.equal(analysis.actions.some((item) => item.actionCode === 'ANILOX_ACTIVITY'), false)
  assert.equal(analysis.notDirectlyConfirmed.find((item) => item.actionCode === 'ANILOX_ACTIVITY')?.confidence, 'UNKNOWN')
  assert.equal(isDirectAniloxActivitySignal('anilox.drive.torque.actual'), false)
  assert.equal(isDirectAniloxActivitySignal('anilox.drive.temperature.actual'), false)
  assert.equal(isDirectAniloxActivitySignal('anilox.active'), true)
  assert.equal(STOP_FAMILY_CANONICAL_PATTERNS.some(({ matches }) => matches('ink.temperature.actual')), false)
  assert.equal(STOP_FAMILY_CANONICAL_PATTERNS.some(({ matches }) => matches('ink.viscosity.actual')), false)
  assert.equal(analysis.actions.some(({ actionCode }) => actionCode === 'WASH_ACTIVITY'), false)
  assert.equal(analysis.notDirectlyConfirmed.find(({ actionCode }) => actionCode === 'WASH_ACTIVITY')?.confidence, 'UNKNOWN')
})

test('P15 E161/E162-like evidence retains identity, coordinated deck, later pump, impression, and register actions', () => {
  const fixture = actionFixture()
  const withoutWash = fixture.signals.filter(({ canonicalId }) => canonicalId !== 'ink.washup.state')
  const analysis = buildChangeoverActions({ stop: fixture.stop, allStops: [fixture.stop], signals: withoutWash, rangeEndUtc: at(90), evidenceCutoffUtc: at(90) })
  for (const code of ['JOB_IDENTITY_TRANSITION', 'DECK_MOVEMENT', 'INK_PUMP_ACTIVITY', 'IMPRESSION_ADJUSTMENT', 'REGISTRATION_ADJUSTMENT']) assert.ok(analysis.actions.some((item) => item.actionCode === code), code)
  assert.equal(analysis.actions.some(({ actionCode }) => ['TRIAL_RUN', 'FAILED_RECOVERY', 'PHYSICAL_RECOVERY'].includes(actionCode)), false)
  assert.equal(analysis.actions.some(({ actionCode }) => actionCode === 'WASH_ACTIVITY'), false)
})

test('P15 E166-E168-like restart-heavy evidence keeps component actions and Radius contradiction separate from speed context', () => {
  const fixture = actionFixture({ ...noRadius(), alignment: 'CONTRADICTORY', reason: 'Radius Run Production overlaps the telemetry stop.' })
  const analysis = buildChangeoverActions({ stop: fixture.stop, allStops: [fixture.stop], signals: fixture.signals, rangeEndUtc: at(90), evidenceCutoffUtc: at(90) })
  for (const code of ['JOB_IDENTITY_TRANSITION', 'WASH_ACTIVITY', 'INK_PUMP_ACTIVITY', 'REGISTRATION_ADJUSTMENT']) assert.ok(analysis.actions.some((item) => item.actionCode === code), code)
  assert.equal(analysis.actions.some(({ actionCode }) => ['TRIAL_RUN', 'FAILED_RECOVERY', 'PHYSICAL_RECOVERY'].includes(actionCode)), false)
  assert.equal(fixture.stop.radiusAlignment, 'CONTRADICTORY')
  assert.equal(analysis.actions.some(({ actionCode }) => actionCode === 'COLOR_RELATED_ACTIVITY'), false)
})

test('ordinary P14 E072-like downtime receives the same bounded action discovery for classification review', () => {
  const downtime = classify({ identities: [identity('recipe', 'STRONG')], families: [family('WASH_PUMP_INK')], requiredChangeoverEvidence: { ...completeRequiredEvidence(), washActivity: false } })
  const analysis = buildChangeoverActions({ stop: downtime, allStops: [downtime], signals: [actionSignal('ink.pump.status', 1, 500, 'P14.Pump[1]', [[12, 0, 1]])], rangeEndUtc: at(30), evidenceCutoffUtc: at(30) })
  assert.equal(downtime.classification, 'DOWNTIME')
  assert.equal(analysis.eligible, true)
  assert.match(analysis.reason, /every selected physical stop/i)
  assert.ok(analysis.actions.some(({ actionCode }) => actionCode === 'INK_PUMP_ACTIVITY'))
  assert.ok(analysis.notDirectlyConfirmed.some(({ actionCode }) => actionCode === 'WASH_ACTIVITY'))
})

test('raw and unmapped action discovery also runs for downtime predictions', () => {
  const fixture = actionFixture()
  const downtime = { ...fixture.stop, classification: 'DOWNTIME' as const, confidence: 'HIGH' as const }
  const actions = buildUncanonicalizedRawActions({ stop: downtime, allStops: [downtime], histories: [rawHistory('P15.review.raw', 'Review-only unmapped signal', [[10, 0], [12, 1], [14, 2]])] })
  assert.ok(actions.some(({ displayName }) => displayName === 'Review-only unmapped signal'))
})

test('action comparison remains bounded descriptive support, never statistical certainty', () => {
  const fixture = actionFixture(); const downtime = { ...classify({ families: [] }), classification: 'DOWNTIME' as const, families: [family('REGISTRATION')] }
  const analysis = buildChangeoverActions({ stop: fixture.stop, allStops: [fixture.stop, downtime], signals: fixture.signals, rangeEndUtc: at(90), evidenceCutoffUtc: at(90) })
  const comparison = analysis.actions.find(({ actionCode }) => actionCode === 'REGISTRATION_ADJUSTMENT')?.comparison
  assert.deepEqual(comparison && [comparison.changeoverStopsObserved, comparison.changeoverStopsTotal, comparison.downtimeStopsObserved, comparison.downtimeStopsTotal], [1, 1, 1, 1])
  assert.match(comparison?.interpretation ?? '', /descriptive only/)
})

test('finds one preferred machine-level web, film, and plate value without collapsing per-deck repeat corrections', () => {
  const source = (id: number, signalId: string, sourceUnit = ''): TelemetrySourceSignal => ({ id, sourceId: 34, signalId, displayName: signalId.split('.').at(-1)!, sourceUnit, valueKind: 'numeric', enabled: true })
  const selected = productionAttributeRawCandidates([
    source(1, 'Ruby.Press15.Line15.ProcessData.Unwind.Web width [mm]', 'mm'),
    source(2, 'Ruby.Press15.Line15.ProcessData.Unwind.Web width [inch]', 'inch'),
    source(3, 'Ruby.Press15.Line15.ProcessData.Unwind.thickness [um]', 'um'),
    source(4, 'Ruby.Press15.Line15.ProcessData.Unwind.thickness [mil]', 'mil'),
    source(5, 'Ruby.Press15.Line15.ProcessData.Unwind.Density [lb/in3]', 'lb/in3'),
    source(6, 'Ruby.Press15.Line15.ProcessData.PrintUnit.Print repeat [inch]', 'inch'),
    source(7, 'Ruby.Press15.Line15.ProcessData.Color deck 1.Repeat length correct_ [inch]', 'inch'),
  ])
  assert.deepEqual(selected.map(({ definition, signal }) => [definition.attribute, signal.id]), [
    ['WEB_WIDTH', 2], ['FILM_THICKNESS', 4], ['FILM_DENSITY', 5], ['PLATE_REPEAT', 6],
  ])
  assert.equal(productionAttributeDisplayUnit('FILM_DENSITY', 'g/cm�'), 'g/cm³')
  assert.equal(productionAttributeDisplayUnit('FILM_DENSITY', 'lb/in3'), 'lb/in³')
})

test('splits production-attribute raw history into mergeable windows through the full 72-hour range', () => {
  assert.deepEqual(productionAttributeHistoryRanges('2026-08-01T00:00:00.000Z', '2026-08-04T00:00:00.000Z'), [
    { fromUtc: '2026-08-01T00:00:00.000Z', toUtc: '2026-08-02T00:00:00.000Z' },
    { fromUtc: '2026-08-02T00:00:00.000Z', toUtc: '2026-08-03T00:00:00.000Z' },
    { fromUtc: '2026-08-03T00:00:00.000Z', toUtc: '2026-08-04T00:00:00.000Z' },
  ])
  assert.deepEqual(productionAttributeHistoryRanges('2026-08-01T00:00:00.000Z', '2026-08-03T02:00:00.000Z').at(-1), {
    fromUtc: '2026-08-03T00:00:00.000Z', toUtc: '2026-08-03T02:00:00.000Z',
  })
})
