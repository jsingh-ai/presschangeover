import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import { createApp } from '../src/app.js'
import { canonicalSpeedConfiguration, stopIdentityAssociationConfiguration } from '../src/stop-intelligence/configuration.js'
import { classifyStop } from '../src/stop-intelligence/classification-engine.js'
import type { CanonicalSpeedObservation, PhysicalStopAnalysisInput, PhysicalStopSegment, StopFamilyEvidence, StopIdentityEvidence, StopRadiusOverlay, TelemetryAvailabilityInterval } from '../src/stop-intelligence/contracts.js'
import { buildStopEvidence } from '../src/stop-intelligence/evidence-model.js'
import { analyzePhysicalStops, normalizeSpeedQuality } from '../src/stop-intelligence/physical-stop-engine.js'
import { overlayRadius } from '../src/stop-intelligence/radius-overlay.js'
import { downsampleFleetSpeed, StopIntelligenceService, stopIntelligenceStopId } from '../src/stop-intelligence/service.js'
import { buildChangeoverActions } from '../src/stop-intelligence/action-engine.js'
import type { PressSemanticSignalWithIdentity, TelemetryFoundationService } from '../src/telemetry/telemetry-foundation-service.js'
import type { TelemetrySample } from '../src/telemetry/telemetry-contracts.js'
import type { TelemetryClient } from '../src/telemetry/telemetry-api-client.js'
import type { RadiusStatusSegment } from '../src/radius/models.js'

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

test('uses the validated Press 14 and Press 15 canonical production-speed mapping', () => {
  assert.deepEqual(canonicalSpeedConfiguration('press14'), { pressKey: 'press14', sourceId: 1, canonicalSpeedSignalId: 204, canonicalId: 'machine.speed.actual', stopThreshold: 1, recoveryThreshold: 595, recoveryConfirmationSeconds: 300 })
  assert.deepEqual(canonicalSpeedConfiguration('press15'), { pressKey: 'press15', sourceId: 34, canonicalSpeedSignalId: 222, canonicalId: 'machine.speed.actual', stopThreshold: 1, recoveryThreshold: 595, recoveryConfirmationSeconds: 300 })
  assert.equal(canonicalSpeedConfiguration('press5'), undefined)
  assert.deepEqual(stopIdentityAssociationConfiguration('press14'), { pressKey: 'press14', identityContextBeforeSeconds: 3_600, identityContextAfterSeconds: 3_600, identitySettlingSeconds: 300 })
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
  const [segment] = analyze([[0, 1_000], [1, 0], [3, 0], [4, 700], [9, 700]])
  assert.equal(segment?.startAt, at(1))
  assert.equal(segment?.endAt, at(4))
  assert.equal(segment?.physicalDurationSeconds, 180)
  assert.equal(segment?.zeroSpeedSeconds, 180)
  assert.equal(segment?.movementAttempts.length, 1)
  assert.equal(segment?.movementAttempts[0]?.reachedRecoveryThreshold, true)
})

test('keeps slow movement inside the same stop and records the micro-start attempt', () => {
  const [segment] = analyze([[0, 1_000], [1, 0], [2, 100], [3, 300], [4, 0], [5, 700], [10, 700]])
  assert.equal(segment?.startAt, at(1))
  assert.equal(segment?.endAt, at(5))
  assert.equal(segment?.movementAttempts.length, 2)
  assert.deepEqual(segment?.movementAttempts[0], { startAt: at(2), endAt: at(4), durationSeconds: 120, averageSpeed: 200, peakSpeed: 300, reachedRecoveryThreshold: false, failedRecoveryCount: 0, sequenceNumber: 1 })
})

test('keeps a failed high-speed recovery inside the same stop', () => {
  const [segment] = analyze([[0, 1_000], [1, 0], [2, 800], [4, 0], [5, 700], [10, 700]])
  assert.equal(segment?.endAt, at(5))
  assert.equal(segment?.failedRecoveryCount, 1)
  assert.deepEqual(segment?.failedRecoveryStreaks[0], { startAt: at(2), endAt: at(4), durationSeconds: 120, reason: 'DROPPED_BELOW_RECOVERY', movementAttemptSequenceNumber: 1 })
})

test('does not treat a short above-1000 excursion as recovery', () => {
  const [segment] = analyze([[0, 1_000], [1, 0], [2, 1_200], [6, 0], [7, 800], [12, 800]])
  assert.equal(segment?.endAt, at(7))
  assert.equal(segment?.failedRecoveryCount, 1)
  assert.equal(segment?.movementAttempts[0]?.peakSpeed, 1_200)
})

test('retains multiple movement attempts, including the final successful recovery attempt', () => {
  const [segment] = analyze([[0, 0], [1, 100], [2, 0], [3, 400], [4, 0], [5, 750], [10, 750]])
  assert.equal(segment?.leftCensored, true)
  assert.equal(segment?.movementAttempts.length, 3)
  assert.deepEqual(segment?.movementAttempts.map(({ sequenceNumber, startAt, endAt }) => [sequenceNumber, startAt, endAt]), [[1, at(1), at(2)], [2, at(3), at(4)], [3, at(5), at(5)]])
})

test('right-censors a stop on bad quality and never carries it through the bad value', () => {
  const [segment] = analyze([[0, 1_000], [1, 0], [2, 0, 'bad']], undefined, 5)
  assert.equal(segment?.endAt, at(2))
  assert.equal(segment?.rightCensored, true)
  assert.equal(segment?.rightCensorReason, 'UNKNOWN_SPEED_QUALITY')
  assert.equal(segment?.physicalDurationSeconds, 60)
})

test('splits rather than bridges a collection outage during a stop', () => {
  const segments = analyze([[0, 1_000], [1, 0], [5, 0], [6, 700], [11, 700]], [{ fromUtc: at(2), toUtc: at(5), state: 'UNKNOWN_COLLECTION' }])
  assert.equal(segments.length, 2)
  assert.deepEqual(segments.map(({ startAt, endAt, leftCensorReason, rightCensorReason }) => [startAt, endAt, leftCensorReason, rightCensorReason]), [[at(1), at(2), null, 'UNKNOWN_COLLECTION'], [at(5), at(6), 'UNKNOWN_COLLECTION', null]])
})

test('does not invent a stop for an outage while the press is running', () => {
  assert.deepEqual(analyze([[0, 1_000], [5, 1_000]], [{ fromUtc: at(1), toUtc: at(5), state: 'UNKNOWN_COLLECTION' }]), [])
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
    toUtc: at(12),
    observations: [
      { atUtc: at(0), speed: 1_000, qualityState: 'GOOD' },
      { atUtc: at(1), speed: 0, qualityState: 'GOOD' },
      { atUtc: at(2), speed: 700, qualityState: 'GOOD' },
      { atUtc: new Date(Date.parse(at(7)) - 1_000).toISOString(), speed: 500, qualityState: 'GOOD' },
    ],
  }
  const [segment] = analyzePhysicalStops(input).segments
  assert.equal(segment?.endAt, null)
  assert.equal(segment?.failedRecoveryCount, 1)
  assert.equal(segment?.failedRecoveryStreaks[0]?.durationSeconds, 299)
})

test('uses exact threshold comparisons: <1 stopped, 1-<595 movement, and >=595 recovery', () => {
  const [segment] = analyze([[0, 1_000], [1, 0.999], [2, 1], [3, 594.999], [4, 595], [9, 595]])
  assert.equal(segment?.startAt, at(1))
  assert.equal(segment?.endAt, at(4))
  assert.equal(segment?.zeroSpeedSeconds, 60)
  assert.equal(segment?.lowMovementSeconds, 120)
  assert.equal(analyze([[0, 1_000], [1, -0.01], [2, 700], [7, 700]])[0]?.startAt, at(1))
})

test('integrates transition-first intervals by elapsed time rather than averaging rows', () => {
  const [segment] = analyze([[0, 1_000], [1, 0], [3, 100], [4, 300], [8, 0], [9, 700], [14, 700]])
  assert.equal(segment?.lowMovementSeconds, 300)
  assert.equal(segment?.movementAttempts[0]?.averageSpeed, 260)
  assert.equal(segment?.movementAttempts[0]?.peakSpeed, 300)
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
          { canonicalId: 'machine.speed.actual', deckNumber: null, historianSignalId: 204, seed: null, samples: telemetrySamples([[0, 1_000], [1, 0], [2, 700], [7, 700]]), changes: [] },
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

test('service clamps live identity evidence to now and can strengthen the same stop retrospectively', async () => {
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
      return { pressKey: 'press14', sourceKey: 'press14', displayName: 'Press 14', fromUtc: at(-60), toUtc: query.toUtc, includeSeed: true, signals: [{ canonicalId: 'machine.speed.actual', deckNumber: null, historianSignalId: 204, seed: null, samples: telemetrySamples([[0, 1_000], [1, 0], [2, 700], [7, 700]]), changes: [] }, recipe], readDiagnostics: { gaps: [], sourceGaps: [] } }
    },
  } as unknown as TelemetryFoundationService
  const request = { pressKey: 'press14' as const, fromUtc: at(0), toUtc: at(10) }
  const live = await new StopIntelligenceService(telemetry, undefined, () => Date.parse(at(30))).analyze(request)
  assert.equal(requestedToUtc, at(30))
  assert.equal(live.classifiedStops[0]?.identities.find(({ field }) => field === 'recipe')?.changed, false)
  assert.notEqual(live.classifiedStops[0]?.classification, 'CHANGEOVER')
  const retrospective = await new StopIntelligenceService(telemetry, undefined, () => Date.parse(at(50))).analyze(request)
  assert.equal(requestedToUtc, at(50))
  assert.deepEqual([retrospective.classifiedStops[0]?.classification, retrospective.classifiedStops[0]?.confidence], ['CHANGEOVER', 'HIGH'])
})

test('keeps the physical engine independent from Radius and all Stop Intelligence paths free of persistence or writes', () => {
  const engine = readFileSync(new URL('../src/stop-intelligence/physical-stop-engine.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(engine, /radius/i)
  const sources = readdirSync(new URL('../src/stop-intelligence/', import.meta.url)).filter((value) => value.endsWith('.ts')).map((value) => readFileSync(new URL(`../src/stop-intelligence/${value}`, import.meta.url), 'utf8')).join('\n')
  for (const forbidden of [/new Pool/, /from 'pg'/, /INSERT\s+INTO/i, /UPDATE\s+\w+\s+SET/i, /DELETE\s+FROM/i, /TRUNCATE/i, /CREATE\s+TABLE/i, /rawChanges\(/, /rawCatalog\(/, /rawHistory\(/]) assert.doesNotMatch(sources, forbidden)
})

function physical(overrides: Partial<PhysicalStopSegment> = {}): PhysicalStopSegment {
  return { pressKey: 'press14', sourceId: 1, speedSignalId: 204, startAt: at(10), endAt: at(20), leftCensored: false, rightCensored: false, leftCensorReason: null, rightCensorReason: null, physicalDurationSeconds: 600, zeroSpeedSeconds: 600, lowMovementSeconds: 0, movementAttempts: [], failedRecoveryCount: 0, failedRecoveryStreaks: [], algorithmVersion: 'test', configVersion: 'test', ...overrides }
}

const noRadius = (): StopRadiusOverlay => ({ alignment: 'RADIUS_UNAVAILABLE', firstNonProductionAtUtc: null, firstProductionReturnAtUtc: null, physicalStartOffsetSeconds: null, physicalEndOffsetSeconds: null, coveredSeconds: 0, physicalSeconds: 0, coveragePercent: 0, states: [], reason: 'Unavailable in test.' })
const identity = (field: StopIdentityEvidence['field'], usefulness: StopIdentityEvidence['usefulness'], changed = false): StopIdentityEvidence => ({ field, usefulness, available: true, canonicalId: `production.${field}`, beforeValue: 'A', afterValue: changed ? 'B' : 'A', changed, settled: changed, firstChangeAtUtc: changed ? at(12) : null, lastChangeAtUtc: changed ? at(12) : null, settledAtUtc: changed ? at(17) : null, associationOffsetSeconds: changed ? 0 : null, intermediateValues: changed ? ['B'] : [], reason: 'Synthetic research evidence.' })
const family = (name: StopFamilyEvidence['family'], observed = true, coordinated = false): StopFamilyEvidence => ({ family: name, available: true, observed, coordinated, changeCount: observed ? coordinated ? 3 : 1 : 0, deckNumbers: coordinated ? [1, 2] : [], canonicalIds: observed ? [`test.${name.toLowerCase()}`] : [], firstObservedAtUtc: observed ? at(12) : null, lastObservedAtUtc: observed ? at(14) : null, reason: 'Synthetic research evidence.' })
const classify = (values: { segment?: PhysicalStopSegment; identities?: StopIdentityEvidence[]; families?: StopFamilyEvidence[]; identityCoverageAdequate?: boolean; familyCoverageAdequate?: boolean; evidenceIntegrity?: 'VALID' | 'LIMITED' | 'INVALID'; radius?: StopRadiusOverlay }) => classifyStop({ segment: values.segment ?? physical(), identities: values.identities ?? [identity('recipe', 'STRONG')], families: values.families ?? [], identityCoverageAdequate: values.identityCoverageAdequate ?? true, familyCoverageAdequate: values.familyCoverageAdequate ?? true, evidenceIntegrity: values.evidenceIntegrity ?? 'VALID', radius: values.radius ?? noRadius() })

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

test('research P14 E072/E075 remain DOWNTIME without coordinated setup evidence', () => {
  assert.equal(classify({ families: [] }).classification, 'DOWNTIME')
  const pumpOnly = classify({ families: [family('WASH_PUMP_INK')] })
  assert.equal(pumpOnly.classification, 'DOWNTIME')
  assert.equal(pumpOnly.confidence, 'LOW')
  assert.equal(classify({ families: [family('WASH_PUMP_INK'), family('ANILOX')] }).classification, 'DOWNTIME')
})

test('multiple independent setup families classify MEDIUM while one isolated setup anchor stays UNCERTAIN', () => {
  assert.deepEqual([classify({ families: [family('IMPRESSION'), family('REGISTRATION')] }).classification, classify({ families: [family('IMPRESSION'), family('REGISTRATION')] }).confidence], ['CHANGEOVER', 'MEDIUM'])
  assert.equal(classify({ families: [family('DECK')] }).classification, 'UNCERTAIN')
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
  assert.equal(result.classification, 'UNCERTAIN')
  assert.ok(['PREVIOUS_ORDER_CHANGED', 'COORDINATED_DECK_MOVEMENT', 'WASH_PUMP_INK_ACTIVITY', 'REGISTRATION_ACTIVITY', 'RESTART_ATTEMPTS_CONTEXT'].every((code) => result.supportingEvidence.some((value) => value.code === code)))
  assert.ok(['UNSETTLED_IDENTITY_TRANSITION', 'RADIUS_RUN_PRODUCTION'].every((code) => result.conflictingEvidence.some((value) => value.code === code)))
  assert.ok(['RELEVANT_IDENTITY_COVERAGE', 'SETUP_FAMILY_COVERAGE'].every((code) => result.missingEvidence.includes(code)))
})

test('collection censorship is UNCERTAIN and invalid quality evidence is IGNORE_BAD_DATA', () => {
  const censored = physical({ rightCensored: true, rightCensorReason: 'UNKNOWN_COLLECTION' })
  assert.equal(classify({ segment: censored, evidenceIntegrity: 'LIMITED' }).classification, 'UNCERTAIN')
  const invalid = classify({ evidenceIntegrity: 'INVALID' })
  assert.equal(invalid.classification, 'IGNORE_BAD_DATA')
  assert.ok(invalid.conflictingEvidence.some(({ code }) => code === 'INVALID_SPEED_EVIDENCE'))
})

test('duration, restart attempts, anilox, and Radius Make Ready never classify a changeover alone', () => {
  const segment = physical({ physicalDurationSeconds: 7_200, failedRecoveryCount: 3 })
  const result = classify({ segment, families: [family('ANILOX')], radius: { ...noRadius(), alignment: 'AGREES', reason: 'Make Ready aligned.' } })
  assert.equal(result.classification, 'DOWNTIME')
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

test('rejects an unconfigured press before telemetry source access', async () => {
  const app = createApp({ telemetryClient: {} as TelemetryClient, logger: false })
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const port = (server.address() as AddressInfo).port
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/stop-intelligence/presses/press5?fromUtc=${encodeURIComponent(at(0))}&toUtc=${encodeURIComponent(at(10))}`)
    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { error: 'stop_intelligence_press_not_configured' })
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

test('bounds the Stop Intelligence API to one day before telemetry source access', async () => {
  const app = createApp({ telemetryClient: {} as TelemetryClient, logger: false })
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const port = (server.address() as AddressInfo).port
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/stop-intelligence/presses/press14?fromUtc=${encodeURIComponent(at(0))}&toUtc=${encodeURIComponent(new Date(Date.parse(at(0)) + 25 * 60 * 60_000).toISOString())}`)
    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { error: 'stop_intelligence_range_too_large' })
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

test('builds lightweight fleet summaries sequentially and loads bounded detail only for the selected stop', async () => {
  const readOrder: string[] = []
  const telemetry = {
    sources: { resolve: async (pressKey: 'press14' | 'press15') => ({ pressKey, source: { id: pressKey === 'press14' ? 1 : 34, sourceKey: pressKey, displayName: pressKey === 'press14' ? 'Press 14' : 'Press 15', enabled: true }, metadataStatus: 'FRESH' }) },
    capabilities: { get: async (pressKey: 'press14' | 'press15') => ({ pressKey, sourceId: pressKey === 'press14' ? 1 : 34, sourceKey: pressKey, displayName: pressKey === 'press14' ? 'Press 14' : 'Press 15', metadataStatus: 'FRESH', capabilities: [] }) },
    semanticHistoryWithIdentity: async (pressKey: 'press14' | 'press15') => {
      readOrder.push(pressKey)
      const historianSignalId = pressKey === 'press14' ? 204 : 222
      return {
        pressKey, sourceKey: pressKey, displayName: pressKey === 'press14' ? 'Press 14' : 'Press 15', fromUtc: at(-60), toUtc: at(90), includeSeed: true,
        signals: [{ canonicalId: 'machine.speed.actual', deckNumber: null, historianSignalId, seed: null, samples: telemetrySamples([[-10, 800], [8, 800, 'BAD'], [10, 0], [15, 100], [18, 0], [20, 700], [25, 700], [30, 800]]), changes: [] }],
        readDiagnostics: { gaps: [], sourceGaps: [{ startUtc: at(5), endUtc: at(8) }] },
      }
    },
  } as unknown as TelemetryFoundationService
  const service = new StopIntelligenceService(telemetry, undefined, () => Date.parse(at(120)))
  const range = { fromUtc: at(0), toUtc: at(40) }
  const fleet = await service.fleet(range)
  assert.deepEqual(readOrder, ['press14', 'press15'])
  assert.equal(fleet.presses.length, 2)
  assert.deepEqual(fleet.presses.map(({ stopCount, totalPhysicalStopSeconds, longestPhysicalStopSeconds }) => [stopCount, totalPhysicalStopSeconds, longestPhysicalStopSeconds]), [[1, 600, 600], [1, 600, 600]])
  assert.ok(fleet.presses.every(({ dataAvailabilityWarning }) => dataAvailabilityWarning))
  const episode = fleet.presses[0]!.episodes[0]!
  assert.equal(episode.stopId, stopIntelligenceStopId({ pressKey: 'press14', startAt: at(10) }))
  assert.equal(episode.radiusStatusDescription, null)
  assert.equal('supportingEvidence' in episode, false)
  assert.deepEqual([fleet.presses[0]!.speedContext.fromUtc, fleet.presses[0]!.speedContext.toUtc], [at(0), at(40)])
  assert.ok(fleet.presses[0]!.speedContext.observations.some(({ atUtc, speed }) => atUtc === at(0) && speed === 800))
  assert.ok(fleet.presses[0]!.speedContext.unknownIntervals.some(({ state }) => state === 'UNKNOWN_COLLECTION'))
  assert.ok(fleet.presses[0]!.speedContext.unknownIntervals.some(({ state }) => state === 'UNKNOWN_SPEED_QUALITY'))

  const detail = await service.detail({ pressKey: 'press14', ...range, stopId: episode.stopId })
  assert.ok(detail)
  assert.deepEqual([detail!.speedContext.fromUtc, detail!.speedContext.toUtc], [at(-5), at(35)])
  assert.deepEqual([detail!.speedContext.stopThreshold, detail!.speedContext.recoveryThreshold], [1, 595])
  assert.ok(detail!.speedContext.unknownIntervals.some(({ state }) => state === 'UNKNOWN_COLLECTION'))
  assert.ok(detail!.speedContext.unknownIntervals.some(({ state }) => state === 'UNKNOWN_SPEED_QUALITY'))
  assert.equal(detail!.stop.physicalSegment.movementAttempts.length, 2)
  assert.equal(detail!.changeoverActions.eligible, false)
  assert.deepEqual(detail!.changeoverActions.actions, [])
  assert.equal('changeoverActions' in episode, false)
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

test('validates fleet and selected-stop API bounds and identifiers before any source read', async () => {
  const app = createApp({ telemetryClient: {} as TelemetryClient, logger: false })
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const port = (server.address() as AddressInfo).port
  try {
    const tooLong = new Date(Date.parse(at(0)) + 25 * 60 * 60_000).toISOString()
    const fleet = await fetch(`http://127.0.0.1:${port}/api/stop-intelligence/fleet?fromUtc=${encodeURIComponent(at(0))}&toUtc=${encodeURIComponent(tooLong)}`)
    assert.equal(fleet.status, 400)
    assert.deepEqual(await fleet.json(), { error: 'stop_intelligence_range_too_large' })
    const detail = await fetch(`http://127.0.0.1:${port}/api/stop-intelligence/presses/press14/stops/not-a-stop?fromUtc=${encodeURIComponent(at(0))}&toUtc=${encodeURIComponent(at(10))}`)
    assert.equal(detail.status, 400)
    assert.deepEqual(await detail.json(), { error: 'invalid_stop_intelligence_stop_id' })
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

function actionSignal(canonicalId: string, deckNumber: number | null, historianSignalId: number, rawSignalId: string, transitions: Array<[number, string | number | boolean, string | number | boolean]>): PressSemanticSignalWithIdentity {
  const point = (minute: number, value: string | number | boolean) => ({ observedAtUtc: at(minute), receivedAtUtc: at(minute), sourceTimestampUtc: at(minute), qualityState: 'GOOD', valueKind: typeof value === 'number' ? 'numeric' as const : typeof value === 'boolean' ? 'boolean' as const : 'string' as const, value })
  return { canonicalId, deckNumber, capabilityState: 'SUPPORTED', observationState: 'SUPPORTED_WITH_OBSERVATIONS', mappingStatus: 'MAPPED', historianSignalId, rawSignalId, sourceSelector: deckNumber === null ? null : `[${deckNumber}]`, selectedVariant: 'primary', sourceUnit: null, canonicalUnitStatus: 'not_applicable', representation: 'changes', seed: null, samples: [], changes: transitions.map(([minute, previousValue, value]) => ({ ...point(minute, value), previousObservedAtUtc: at(minute - 1), previousReceivedAtUtc: at(minute - 1), previousSourceTimestampUtc: at(minute - 1), previousQualityState: 'GOOD', previousValueKind: typeof previousValue === 'number' ? 'numeric' as const : typeof previousValue === 'boolean' ? 'boolean' as const : 'string' as const, previousValue })) }
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
    actionSignal('deck.active', 1, 301, 'P15.Color[1].Position', [[14, 1, 2]]), actionSignal('deck.active', 2, 302, 'P15.Color[2].Position', [[15, 1, 2]]),
    actionSignal('ink.washup.state', 1, 311, 'P15.Ink[1].WASHING', [[18, 0, 512]]), actionSignal('ink.pump.status', 1, 312, 'P15.Ink[1].PUMPING', [[22, 1, 11]]),
    actionSignal('impression.anilox.drive_side', 1, 321, 'P15.Impression[1]', [[28, 0, 20]]), actionSignal('impression.plate_cylinder.drive_side', 2, 322, 'P15.Impression[2]', [[29, 0, 18]]),
    actionSignal('register.long.actual_or_correction', 1, 331, 'P15.RegisterLong[1]', [[31, 0, 0.2], [33, 0.2, 0.3]]), actionSignal('register.side.actual_or_correction', 2, 332, 'P15.RegisterSide[2]', [[32, 0, -0.1]]),
  ]
  return { stop, signals, segment }
}

test('Phase 4 orders P15 E148-like actions chronologically without requiring a fixed sequence', () => {
  const fixture = actionFixture(); const analysis = buildChangeoverActions({ stop: fixture.stop, allStops: [fixture.stop], signals: fixture.signals, speedSignal: actionSignal('machine.speed.actual', null, 222, 'P15.ActualSpeed', []), rangeEndUtc: at(90), evidenceCutoffUtc: at(90) })
  assert.equal(analysis.eligible, true)
  const times = analysis.actions.map(({ startAt }) => Date.parse(startAt!))
  assert.deepEqual(times, [...times].sort((left, right) => left - right))
  for (const code of ['PREVIOUS_JOB_FINISHED', 'JOB_IDENTITY_TRANSITION', 'DECK_MOVEMENT', 'WASH_ACTIVITY', 'INK_PUMP_ACTIVITY', 'SLOW_SETUP_RUN', 'IMPRESSION_ADJUSTMENT', 'REGISTRATION_ADJUSTMENT', 'TRIAL_RUN', 'FAILED_RECOVERY', 'PHYSICAL_RECOVERY']) assert.ok(analysis.actions.some((item) => item.actionCode === code && ['DETECTED', 'INFERRED'].includes(item.confidence)), code)
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

test('P14 Recipe changeover can expose deck/anilox/impression/register actions without requiring wash', () => {
  const segment = physical({ startAt: at(10), endAt: at(30), physicalDurationSeconds: 1_200 }); const stop = classify({ segment, identities: [identity('recipe', 'STRONG', true)], families: [family('DECK', true, true), family('ANILOX'), family('IMPRESSION'), family('REGISTRATION')] })
  const signals = [actionSignal('production.recipe', null, 205, 'P14.Recipe', [[12, 'R1', 'R2']]), actionSignal('deck.active', 1, 401, 'P14.Deck[1]', [[14, 1, 2]]), actionSignal('deck.active', 2, 402, 'P14.Deck[2]', [[14, 1, 2]]), actionSignal('anilox.drive.torque.actual', 1, 403, 'P14.Anilox[1]', [[16, 10, 14]]), actionSignal('impression.anilox.drive_side', 1, 404, 'P14.Impression[1]', [[18, 0, 12]]), actionSignal('register.long.actual_or_correction', 1, 405, 'P14.Register[1]', [[20, 0, 0.2]])]
  const analysis = buildChangeoverActions({ stop, allStops: [stop], signals, rangeEndUtc: at(60), evidenceCutoffUtc: at(60) })
  for (const code of ['DECK_MOVEMENT', 'ANILOX_ACTIVITY', 'IMPRESSION_ADJUSTMENT', 'REGISTRATION_ADJUSTMENT']) assert.ok(analysis.actions.some((item) => item.actionCode === code), code)
  assert.equal(analysis.actions.some(({ actionCode }) => actionCode === 'WASH_ACTIVITY'), false)
  assert.equal(analysis.notDirectlyConfirmed.find(({ actionCode }) => actionCode === 'WASH_ACTIVITY')?.confidence, 'UNKNOWN')
})

test('P15 E161/E162-like evidence retains identity, coordinated deck, later pump, impression, register, and recovery actions', () => {
  const fixture = actionFixture()
  const withoutWash = fixture.signals.filter(({ canonicalId }) => canonicalId !== 'ink.washup.state')
  const analysis = buildChangeoverActions({ stop: fixture.stop, allStops: [fixture.stop], signals: withoutWash, rangeEndUtc: at(90), evidenceCutoffUtc: at(90) })
  for (const code of ['JOB_IDENTITY_TRANSITION', 'DECK_MOVEMENT', 'INK_PUMP_ACTIVITY', 'IMPRESSION_ADJUSTMENT', 'REGISTRATION_ADJUSTMENT', 'PHYSICAL_RECOVERY']) assert.ok(analysis.actions.some((item) => item.actionCode === code), code)
  assert.equal(analysis.actions.some(({ actionCode }) => actionCode === 'WASH_ACTIVITY'), false)
})

test('P15 E166-E168-like restart-heavy evidence keeps wash/pump/register actions and Radius contradiction separate', () => {
  const fixture = actionFixture({ ...noRadius(), alignment: 'CONTRADICTORY', reason: 'Radius Run Production overlaps the telemetry stop.' })
  const analysis = buildChangeoverActions({ stop: fixture.stop, allStops: [fixture.stop], signals: fixture.signals, rangeEndUtc: at(90), evidenceCutoffUtc: at(90) })
  for (const code of ['JOB_IDENTITY_TRANSITION', 'WASH_ACTIVITY', 'INK_PUMP_ACTIVITY', 'REGISTRATION_ADJUSTMENT', 'SLOW_SETUP_RUN', 'TRIAL_RUN', 'FAILED_RECOVERY']) assert.ok(analysis.actions.some((item) => item.actionCode === code), code)
  assert.equal(fixture.stop.radiusAlignment, 'CONTRADICTORY')
  assert.equal(analysis.actions.some(({ actionCode }) => actionCode === 'COLOR_RELATED_ACTIVITY'), false)
})

test('ordinary P14 E072-like downtime does not receive full Changeover Actions analysis', () => {
  const downtime = classify({ identities: [identity('recipe', 'STRONG')], families: [family('WASH_PUMP_INK')] })
  const analysis = buildChangeoverActions({ stop: downtime, allStops: [downtime], signals: [actionSignal('ink.pump.status', 1, 500, 'P14.Pump[1]', [[12, 0, 1]])], rangeEndUtc: at(30), evidenceCutoffUtc: at(30) })
  assert.equal(analysis.eligible, false)
  assert.deepEqual([analysis.actions, analysis.notDirectlyConfirmed], [[], []])
})

test('action comparison remains bounded descriptive support, never statistical certainty', () => {
  const fixture = actionFixture(); const downtime = { ...classify({ families: [] }), classification: 'DOWNTIME' as const, families: [family('REGISTRATION')] }
  const analysis = buildChangeoverActions({ stop: fixture.stop, allStops: [fixture.stop, downtime], signals: fixture.signals, rangeEndUtc: at(90), evidenceCutoffUtc: at(90) })
  const comparison = analysis.actions.find(({ actionCode }) => actionCode === 'REGISTRATION_ADJUSTMENT')?.comparison
  assert.deepEqual(comparison && [comparison.changeoverStopsObserved, comparison.changeoverStopsTotal, comparison.downtimeStopsObserved, comparison.downtimeStopsTotal], [1, 1, 1, 1])
  assert.match(comparison?.interpretation ?? '', /descriptive only/)
})
