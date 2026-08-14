import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { RadiusService } from '../src/radius/radius-service.js'
import type { RadiusStatusSegment } from '../src/radius/models.js'
import { ENGINEERING_CLUE_CATALOG } from '../src/telemetry/engineering-clue-analysis.js'
import type { CapabilityAssessment, PressSemanticSignalEvidence, TelemetryChange, TelemetrySample, TelemetrySemanticSelector } from '../src/telemetry/telemetry-contracts.js'
import type { TelemetryFoundationService } from '../src/telemetry/telemetry-foundation-service.js'
import { normalizeHistorianNumber, numericSummary, RawRadiusExplorerService, RAW_EXPLORER_MAX_WINDOW_MINUTES, samplesWithSeed, stateSummary, type RawExplorerOccurrence } from '../src/raw-radius-explorer/raw-radius-explorer-service.js'

const startUtc = '2026-08-13T12:00:00.000Z'
const endUtc = '2026-08-13T12:10:00.000Z'

function sample(observedAtUtc: string, value: number | string): TelemetrySample {
  return { observedAtUtc, receivedAtUtc: observedAtUtc, sourceTimestampUtc: observedAtUtc, qualityState: 'GOOD', valueKind: typeof value === 'number' ? 'numeric' : 'string', value }
}

function change(observedAtUtc: string, previousValue: number | string, value: number | string): TelemetryChange {
  return { ...sample(observedAtUtc, value), previousObservedAtUtc: new Date(Date.parse(observedAtUtc) - 1_000).toISOString(), previousReceivedAtUtc: new Date(Date.parse(observedAtUtc) - 1_000).toISOString(), previousSourceTimestampUtc: new Date(Date.parse(observedAtUtc) - 1_000).toISOString(), previousQualityState: 'GOOD', previousValueKind: typeof previousValue === 'number' ? 'numeric' : 'string', previousValue }
}

const occurrence: RawExplorerOccurrence = {
  occurrenceId: 'press3:2026-08-13T12:00:00.000Z:0', pressKey: 'press3', displayName: 'Press 3', pressOccurrenceIndex: 1, pressOccurrenceCount: 1,
  eventType: 'B', statusCode: '400', statusDescription: 'Recorded B state', startUtc, endUtc, durationSeconds: 600,
  chartFromUtc: '2026-08-13T11:20:00.000Z', chartToUtc: '2026-08-13T12:50:00.000Z',
}

function radiusSegment(start = startUtc, end = endUtc): RadiusStatusSegment {
  return { kind: 'radius', machineId: 3, pressKey: 'press3', displayName: 'Press 3', startUtc: start, endUtc: end, durationSeconds: (Date.parse(end) - Date.parse(start)) / 1_000, isOpen: false, sourceGeneration: 'legacy', eventType: 'B', statusCode: '400', statusDescription: 'Recorded B state', isProduction: false }
}

function radiusService(): RadiusService {
  return {
    getHealth: async () => ({ status: 'healthy', configured: true }),
    getOverview: async () => { throw new Error('classified overview must not be used') },
    getAnalysisOverview: async () => ({ presses: [{ pressKey: 'press3', displayName: 'Press 3', timelineSegments: [radiusSegment()] }] }) as never,
    getRawTimeline: async (pressKey, fromUtc, toUtc) => ({ pressKey, displayName: 'Press 3', fromUtc, toUtc, segments: [radiusSegment()] }),
    getObservedIdentities: async () => [{ identity: 'B|400|Recorded B state', eventType: 'B', statusCode: '400', statusDescription: 'Recorded B state', eventCount: 2, lastSeenUtc: startUtc }],
    getPressEpisodes: async () => { throw new Error('not used') },
    getEpisode: async () => { throw new Error('not used') },
  }
}

function evidence(selector: TelemetrySemanticSelector, seedValue: TelemetrySample | null = null, changes: TelemetryChange[] = [], samples: TelemetrySample[] = []): PressSemanticSignalEvidence {
  return { canonicalId: selector.canonicalId, deckNumber: selector.deckNumber ?? null, capabilityState: 'SUPPORTED', observationState: samples.length || changes.length ? 'SUPPORTED_WITH_OBSERVATIONS' : seedValue ? 'SUPPORTED_WITH_SEED_ONLY' : 'SUPPORTED_WITH_NO_SAMPLES_IN_RANGE', mappingStatus: 'MAPPED', sourceUnit: null, canonicalUnitStatus: 'UNVERIFIED', representation: selector.representation, seed: seedValue, samples, changes }
}

describe('Raw Radius Code Explorer', () => {
  it('uses raw exact identity, phase labels, press order, and preserves a long occurrence', async () => {
    const longEnd = '2026-08-13T15:00:00.000Z'
    const source = radiusService()
    source.getAnalysisOverview = async () => ({ presses: [{ pressKey: 'press3', displayName: 'Press 3', timelineSegments: [radiusSegment(startUtc, longEnd)] }] }) as never
    const telemetry = { capabilities: { get: async () => ({ capabilities: [] }) } } as unknown as TelemetryFoundationService
    const explorer = new RawRadiusExplorerService(source, telemetry)
    const identities = await explorer.identities(startUtc, longEnd)
    assert.deepEqual(identities.map(({ eventType, statusCode, statusDescription }) => ({ eventType, statusCode, statusDescription })), [{ eventType: 'B', statusCode: '400', statusDescription: 'Recorded B state' }])
    const result = await explorer.explore({ fromUtc: startUtc, toUtc: longEnd, identity: { eventType: 'B', statusCode: '400', statusDescription: 'Recorded B state' }, changeLookbackMinutes: 15, chartContextMinutes: 40 })
    assert.equal(result.summary.totalOccurrences, 1)
    assert.equal(result.occurrences[0]?.durationSeconds, 10_800)
    assert.equal(result.occurrences[0]?.chartFromUtc, '2026-08-13T11:20:00.000Z')
    assert.equal(result.occurrences[0]?.chartToUtc, '2026-08-13T15:40:00.000Z')
  })

  it('discovers the exact 15-to-40 change in a 15-minute half-open lookback with 40-minute context', async () => {
    const setpoint: CapabilityAssessment = { canonicalId: 'machine.speed.setpoint', state: 'SUPPORTED', deckNumbers: [], historyQueryable: true, evidenceKind: 'semantic_history' }
    const calls: Array<{ fromUtc: string; toUtc: string; includeSeed: boolean; signals: TelemetrySemanticSelector[] }> = []
    const telemetry = {
      capabilities: { get: async () => ({ capabilities: [setpoint] }) },
      semanticHistory: async (_pressKey: string, query: { fromUtc: string; toUtc: string; includeSeed: boolean; signals: TelemetrySemanticSelector[] }) => {
        calls.push(query)
        return { signals: query.signals.map((selector) => selector.canonicalId === 'machine.speed.actual'
          ? evidence(selector, sample('2026-08-13T11:19:00.000Z', 10), [], [sample('2026-08-13T11:55:00.000Z', 20), sample('2026-08-13T12:05:00.000Z', 30)])
          : evidence(selector, sample('2026-08-13T11:44:00.000Z', 15), [change('2026-08-13T11:55:00.000Z', 15, 40), change(startUtc, 40, 50)])) }
      },
    } as unknown as TelemetryFoundationService
    const detail = await new RawRadiusExplorerService(radiusService(), telemetry).detail({ occurrence, changeLookbackMinutes: 15 })
    assert.deepEqual(detail.lookback, { fromUtc: '2026-08-13T11:45:00.000Z', toUtc: startUtc, halfOpen: true })
    const changed = detail.changedSignals.find(({ canonicalId }) => canonicalId === 'machine.speed.setpoint')
    assert.equal(changed?.summary.kind, 'numeric')
    if (changed?.summary.kind === 'numeric') {
      assert.equal(changed.summary.firstValue, 15)
      assert.equal(changed.summary.lastValue, 40)
      assert.equal(changed.summary.netDelta, 25)
      assert.equal(changed.summary.maximum, 40)
    }
    assert.ok(calls.every((call) => Date.parse(call.toUtc) - Date.parse(call.fromUtc) <= 2 * 60 * 60_000))
    assert.ok(calls.every((call) => call.signals.length <= 50))
    assert.equal(calls.find((call) => call.signals.some(({ canonicalId }) => canonicalId === 'machine.speed.actual'))?.includeSeed, true)
    assert.deepEqual(detail.speed.samples.map(({ observedAtUtc, value }) => ({ observedAtUtc, value })), [
      { observedAtUtc: '2026-08-13T11:19:00.000Z', value: 10 },
      { observedAtUtc: '2026-08-13T11:55:00.000Z', value: 20 },
      { observedAtUtc: '2026-08-13T12:05:00.000Z', value: 30 },
    ])
  })

  it('chunks the maximum 1,440-minute discovery window and batches mapped supported selectors only', async () => {
    assert.equal(RAW_EXPLORER_MAX_WINDOW_MINUTES, 1_440)
    const capabilities: CapabilityAssessment[] = ENGINEERING_CLUE_CATALOG.map(({ canonicalId, scope }) => ({ canonicalId, state: 'SUPPORTED', deckNumbers: scope === 'deck' ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] : [], historyQueryable: true, evidenceKind: 'semantic_history' }))
    const calls: Array<{ fromUtc: string; toUtc: string; signals: TelemetrySemanticSelector[] }> = []
    const telemetry = {
      capabilities: { get: async () => ({ capabilities }) },
      semanticHistory: async (_pressKey: string, query: { fromUtc: string; toUtc: string; signals: TelemetrySemanticSelector[] }) => { calls.push(query); return { signals: query.signals.map((selector) => evidence(selector)) } },
    } as unknown as TelemetryFoundationService
    await new RawRadiusExplorerService(radiusService(), telemetry).detail({ occurrence, changeLookbackMinutes: 1_440 })
    assert.ok(calls.length > 12)
    assert.ok(calls.every((call) => call.signals.length <= 50))
    assert.ok(calls.every((call) => Date.parse(call.toUtc) - Date.parse(call.fromUtc) <= 2 * 60 * 60_000))
    assert.ok(!calls.flatMap(({ signals }) => signals).some(({ canonicalId }) => canonicalId === 'physical.motion_state'))
  })

  it('removes serialization tails without introducing a process threshold', () => {
    assert.equal(normalizeHistorianNumber(0.30000000000000004), .3)
    assert.notEqual(normalizeHistorianNumber(15), normalizeHistorianNumber(15.0000000001))
  })

  it('preserves the actual seed observation for held change-only display without inventing samples', () => {
    const selector = { canonicalId: 'machine.speed.actual', representation: 'samples' as const }
    const seed = sample('2026-08-13T11:19:00.000Z', 900)
    const next = sample('2026-08-13T12:05:00.000Z', 700)
    assert.deepEqual(samplesWithSeed(evidence(selector, seed, [], [next])), [seed, next])
  })

  it('detects state transitions strictly before entry and omits unchanged or entry-time values', () => {
    const selector = { canonicalId: 'ink.pump.status', deckNumber: 4, representation: 'changes' as const }
    const signal = evidence(selector, sample('2026-08-13T11:40:00.000Z', 1), [
      change('2026-08-13T11:55:00.000Z', 1, 11),
      change('2026-08-13T11:56:00.000Z', 11, 11),
      change(startUtc, 11, 0),
      change('2026-08-13T12:01:00.000Z', 0, 1),
    ])
    assert.deepEqual(stateSummary(signal, Date.parse('2026-08-13T11:45:00.000Z'), Date.parse(startUtc)), { kind: 'state', firstValue: 1, lastValue: 11, transitions: [{ atUtc: '2026-08-13T11:55:00.000Z', previousValue: 1, value: 11 }] })
    assert.equal(stateSummary(evidence(selector, sample('2026-08-13T11:40:00.000Z', 1), [change('2026-08-13T11:55:00.000Z', 1, 1)]), Date.parse('2026-08-13T11:45:00.000Z'), Date.parse(startUtc)), null)
  })

  it('retains a numeric spike and return while omitting unchanged and sparse histories', () => {
    const selector = { canonicalId: 'dryer.tunnel.temperature.actual', representation: 'samples' as const }
    const spike = evidence(selector, sample('2026-08-13T11:44:00.000Z', 10), [], [sample('2026-08-13T11:50:00.000Z', 20), sample('2026-08-13T11:59:00.000Z', 10), sample(startUtc, 99)])
    assert.deepEqual(numericSummary(spike, Date.parse('2026-08-13T11:45:00.000Z'), Date.parse(startUtc)), { kind: 'numeric', firstValue: 10, lastValue: 10, netDelta: 0, minimum: 10, maximum: 20, largestPositiveExcursion: 10, largestNegativeExcursion: 0, largestAbsoluteExcursion: 10, observationCount: 3 })
    assert.equal(numericSummary(evidence(selector, sample('2026-08-13T11:44:00.000Z', 10), [], [sample('2026-08-13T11:50:00.000Z', 10)]), Date.parse('2026-08-13T11:45:00.000Z'), Date.parse(startUtc)), null)
    assert.equal(numericSummary(evidence(selector, null, [], [sample('2026-08-13T11:50:00.000Z', 10)]), Date.parse('2026-08-13T11:45:00.000Z'), Date.parse(startUtc)), null)
  })
})
