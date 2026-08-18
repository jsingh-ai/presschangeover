import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { RadiusService } from '../src/radius/radius-service.js'
import type { RadiusStatusSegment } from '../src/radius/models.js'
import { ENGINEERING_CLUE_CATALOG } from '../src/telemetry/engineering-clue-analysis.js'
import type { CapabilityAssessment, PressSemanticSignalEvidence, TelemetryChange, TelemetrySample, TelemetrySemanticSelector } from '../src/telemetry/telemetry-contracts.js'
import type { TelemetryFoundationService } from '../src/telemetry/telemetry-foundation-service.js'
import { CURRENT_ROLL_LENGTH_CANONICAL_ID, normalizeHistorianNumber, numericSummary, observedRadiusEntrySegments, RawRadiusExplorerService, RAW_EXPLORER_LENGTH_CATALOG, RAW_EXPLORER_MAX_WINDOW_MINUTES, samplesWithSeed, stateSummary, type RawExplorerOccurrence } from '../src/raw-radius-explorer/raw-radius-explorer-service.js'
import { InMemoryRawTelemetryReviewRepository, RawTelemetryReviewService } from '../src/raw-radius-explorer/raw-telemetry-review-service.js'
import { ClassifiedRadiusService } from '../src/classification/classified-radius-service.js'
import type { ClassificationService } from '../src/classification/classification-service.js'

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

  it('does not count the first Radius state after OFFLINE as a new observed code entry', async () => {
    const before = radiusSegment('2026-08-13T12:00:00.000Z', '2026-08-13T12:05:00.000Z')
    const offline: RadiusStatusSegment = { kind: 'offline', machineId: 3, pressKey: 'press3', displayName: 'Press 3', startUtc: '2026-08-13T12:05:00.000Z', endUtc: '2026-08-13T12:08:00.000Z', durationSeconds: 180, isOpen: false, sourceGeneration: 'offline_inference', eventType: null, statusCode: null, statusDescription: null, isProduction: false }
    const resumed = radiusSegment('2026-08-13T12:08:00.000Z', '2026-08-13T12:12:00.000Z')
    const observedAgain = radiusSegment('2026-08-13T12:15:00.000Z', '2026-08-13T12:20:00.000Z')
    const segments = [before, offline, resumed, observedAgain]
    assert.deepEqual(observedRadiusEntrySegments(segments).map(({ startUtc }) => startUtc), [before.startUtc, observedAgain.startUtc])
    const source = radiusService()
    source.getAnalysisOverview = async () => ({ presses: [{ pressKey: 'press3', displayName: 'Press 3', timelineSegments: segments }] }) as never
    const telemetry = { capabilities: { get: async () => ({ capabilities: [] }) } } as unknown as TelemetryFoundationService
    const explorer = new RawRadiusExplorerService(source, telemetry)
    assert.equal((await explorer.identities(before.startUtc, observedAgain.endUtc)).find(({ statusCode }) => statusCode === '400')?.eventCount, 2)
    const result = await explorer.explore({ fromUtc: before.startUtc, toUtc: observedAgain.endUtc, identity: { eventType: 'B', statusCode: '400', statusDescription: 'Recorded B state' }, changeLookbackMinutes: 15, chartContextMinutes: 30 })
    assert.deepEqual(result.occurrences.map(({ startUtc }) => startUtc), [before.startUtc, observedAgain.startUtc])
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

  it('loads one held current-roll track and exposes only changed optional machine length evidence', async () => {
    const capabilities: CapabilityAssessment[] = RAW_EXPLORER_LENGTH_CATALOG.map(({ canonicalId }) => ({ canonicalId, state: 'SUPPORTED', deckNumbers: [], historyQueryable: true, evidenceKind: 'semantic_history' }))
    const calls: Array<{ fromUtc: string; toUtc: string; includeSeed: boolean; signals: TelemetrySemanticSelector[] }> = []
    const telemetry = {
      capabilities: { get: async () => ({ capabilities }) },
      semanticHistory: async (_pressKey: string, query: { fromUtc: string; toUtc: string; includeSeed: boolean; signals: TelemetrySemanticSelector[] }) => {
        calls.push(query)
        return { signals: query.signals.map((selector) => {
          if (selector.canonicalId === 'machine.speed.actual') return evidence(selector)
          if (selector.canonicalId === CURRENT_ROLL_LENGTH_CANONICAL_ID && query.fromUtc === occurrence.chartFromUtc) return evidence(selector, sample('2026-08-13T11:29:00.000Z', 14_900), [change('2026-08-13T12:05:00.000Z', 14_920, 100)])
          if (selector.canonicalId === CURRENT_ROLL_LENGTH_CANONICAL_ID) return evidence(selector, sample('2026-08-13T11:44:00.000Z', 14_800), [change('2026-08-13T11:55:00.000Z', 14_800, 14_900)])
          if (selector.canonicalId === 'production.order.length.actual') return evidence(selector, sample('2026-08-13T11:44:00.000Z', 20_000), [], [sample('2026-08-13T11:58:00.000Z', 20_100)])
          return evidence(selector, sample('2026-08-13T11:44:00.000Z', 30_000))
        }) }
      },
    } as unknown as TelemetryFoundationService
    const explorer = new RawRadiusExplorerService(radiusService(), telemetry)
    const detail = await explorer.detail({ occurrence, changeLookbackMinutes: 15 })
    assert.equal(detail.currentRollLength?.canonicalId, CURRENT_ROLL_LENGTH_CANONICAL_ID)
    assert.equal(detail.currentRollLength?.representation, 'changes')
    assert.equal(detail.currentRollLength?.seed?.value, 14_900)
    assert.deepEqual(detail.currentRollLength?.changes.map(({ value }) => value), [100])
    assert.ok(calls.some((call) => call.fromUtc === occurrence.chartFromUtc && call.toUtc === occurrence.chartToUtc && call.signals.length === 1 && call.signals[0]?.canonicalId === CURRENT_ROLL_LENGTH_CANONICAL_ID && call.signals[0]?.representation === 'changes'))
    assert.deepEqual(detail.changedSignals.filter(({ canonicalId }) => canonicalId.startsWith('production.')).map(({ canonicalId, friendlyName, scope, deckNumber }) => ({ canonicalId, friendlyName, scope, deckNumber })), [
      { canonicalId: CURRENT_ROLL_LENGTH_CANONICAL_ID, friendlyName: 'Current Roll Length', scope: 'machine', deckNumber: null },
      { canonicalId: 'production.order.length.actual', friendlyName: 'Order Length', scope: 'machine', deckNumber: null },
    ])
    assert.equal(detail.changedSignals.some(({ canonicalId }) => canonicalId === 'production.roll.length.target'), false)
    const plotted = await explorer.plot({ occurrence, signal: { canonicalId: 'production.order.length.actual', deckNumber: null, friendlyName: 'Order Length', signalType: 'step_reference', category: 'repeat_other', scope: 'machine' } })
    assert.equal(plotted.signal.canonicalId, 'production.order.length.actual')
    assert.equal(plotted.signal.representation, 'samples')
    await assert.rejects(() => explorer.plot({ occurrence, signal: { canonicalId: CURRENT_ROLL_LENGTH_CANONICAL_ID, deckNumber: null, friendlyName: 'Current Roll Length', signalType: 'step_reference', category: 'repeat_other', scope: 'machine' } }))
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

  it('excludes unavailable-quality values and reconnect transitions from changed-signal summaries', () => {
    const numericSelector = { canonicalId: 'dryer.tunnel.temperature.actual', representation: 'samples' as const }
    const bad = { ...sample('2026-08-13T11:55:00.000Z', 900), qualityState: 'BAD' }
    assert.equal(numericSummary(evidence(numericSelector, null, [], [sample('2026-08-13T11:50:00.000Z', 10), bad, sample('2026-08-13T11:56:00.000Z', 20)]), Date.parse('2026-08-13T11:45:00.000Z'), Date.parse(startUtc)), null)
    const stateSelector = { canonicalId: 'ink.pump.status', deckNumber: 4, representation: 'changes' as const }
    const badQualityChange = { ...change('2026-08-13T11:55:00.000Z', 0, 1), previousQualityState: 'BAD' }
    const reconnectChange = { ...change('2026-08-13T11:58:00.000Z', 1, 2), previousObservedAtUtc: '2026-08-13T11:40:00.000Z' }
    assert.equal(stateSummary(evidence(stateSelector, null, [badQualityChange, reconnectChange]), Date.parse('2026-08-13T11:45:00.000Z'), Date.parse(startUtc)), null)
  })

  it('keeps raw discovery separate, uses the exact half-open lookback, plots one exact identity, and persists reviews per press', async () => {
    const rawCalls: Array<{ pressKey: string; fromUtc: string; toUtc: string }> = []
    const historyCalls: Array<{ pressKey: string; rawIdentity: string; fromUtc: string; toUtc: string }> = []
    const telemetry = {
      capabilities: { get: async () => ({ capabilities: [] }) },
      semanticHistory: async (_pressKey: string, query: { signals: TelemetrySemanticSelector[] }) => ({ signals: query.signals.map((selector) => evidence(selector)) }),
      rawChanges: async (pressKey: string, fromUtc: string, toUtc: string) => {
        rawCalls.push({ pressKey, fromUtc, toUtc })
        return { press: pressKey, displayName: 'Press 3', fromUtc, toUtc, rawCatalogIdentityCount: 3, canonicallyRepresentedIdentityCount: 1, unmappedIdentityCount: 2, usableIdentityCount: 2, changedIdentityCount: 2, framesRead: 10, historianReadCount: 1, signals: [
          { rawIdentity: 'Press3.unique.numeric', displayName: 'unique numeric', dataType: 'numeric', dataKind: 'numeric', sourceUnit: null, discoveryCategory: 'Other', plottable: true, usableObservationCount: 2, unavailableObservationCount: 0, firstValue: 14.8, lastValue: 24, minimum: 14.1, maximum: 24.6, changeCount: 1, largestAbsoluteStep: 9.2, positiveMovementPresent: true, negativeMovementPresent: false, transitionSequence: [], transitionSequenceTruncated: false, knownShape: null, alternateRepresentationCount: 0, alternateRawIdentities: [] },
          { rawIdentity: 'Press3.unique.container', displayName: 'deck.print_on', dataType: 'container', dataKind: 'container', sourceUnit: null, discoveryCategory: 'Containers / Arrays', plottable: false, usableObservationCount: 2, unavailableObservationCount: 0, firstValue: [0], lastValue: [1], minimum: null, maximum: null, changeCount: 1, largestAbsoluteStep: null, positiveMovementPresent: false, negativeMovementPresent: false, transitionSequence: [], transitionSequenceTruncated: false, knownShape: 'array[13]', alternateRepresentationCount: 0, alternateRawIdentities: [] },
          { rawIdentity: 'Press3.outage.artifact', displayName: 'outage artifact', dataType: 'numeric', dataKind: 'numeric', sourceUnit: null, discoveryCategory: 'Other', plottable: true, usableObservationCount: 2, unavailableObservationCount: 1, firstValue: 1, lastValue: 2, minimum: 1, maximum: 2, changeCount: 1, largestAbsoluteStep: 1, positiveMovementPresent: true, negativeMovementPresent: false, transitionSequence: [], transitionSequenceTruncated: false, knownShape: null, alternateRepresentationCount: 0, alternateRawIdentities: [] },
        ] }
      },
      rawHistory: async (pressKey: string, rawIdentity: string, fromUtc: string, toUtc: string) => {
        historyCalls.push({ pressKey, rawIdentity, fromUtc, toUtc })
        return { press: pressKey, displayName: 'Press 3', rawIdentity, signalDisplayName: 'unique numeric', dataType: 'numeric', dataKind: 'numeric', sourceUnit: null, plottable: true, fromUtc, toUtc, historianReadCount: 1, alternateRepresentationCount: 0, alternateRawIdentities: [], observations: [{ timestampUtc: fromUtc, receivedAtUtc: fromUtc, sourceTimestampUtc: fromUtc, qualityState: 'GOOD', dataType: 'numeric', rawValue: 14.8 }] }
      },
    } as unknown as TelemetryFoundationService
    const reviews = new RawTelemetryReviewService(new InMemoryRawTelemetryReviewRepository())
    await reviews.initialize()
    const explorer = new RawRadiusExplorerService(radiusService(), telemetry, reviews)
    const detail = await explorer.detail({ occurrence, changeLookbackMinutes: 15 })
    assert.deepEqual(rawCalls, [{ pressKey: 'press3', fromUtc: '2026-08-13T11:45:00.000Z', toUtc: startUtc }])
    assert.equal(detail.rawTelemetry.status, 'available')
    const validationDetail = await explorer.detail({ occurrence, changeLookbackMinutes: 15 }, 'validation-request', undefined, { includeRawTelemetryDiscovery: false })
    assert.equal(rawCalls.length, 1)
    assert.equal(validationDetail.rawTelemetry.status, 'unavailable')
    assert.deepEqual(detail.rawTelemetry.signals.map(({ rawIdentity, dataKind, reviewStatus }) => ({ rawIdentity, dataKind, reviewStatus })), [
      { rawIdentity: 'Press3.unique.numeric', dataKind: 'numeric', reviewStatus: 'UNREVIEWED' },
      { rawIdentity: 'Press3.unique.container', dataKind: 'container', reviewStatus: 'UNREVIEWED' },
    ])
    await explorer.review('press3', 'Press3.unique.numeric', 'USEFUL')
    assert.equal((await explorer.detail({ occurrence, changeLookbackMinutes: 15 })).rawTelemetry.signals[0]?.reviewStatus, 'USEFUL')
    await explorer.review('press3', 'Press3.unique.numeric', 'NEEDS_MAPPING')
    assert.equal((await explorer.detail({ occurrence, changeLookbackMinutes: 15 })).rawTelemetry.signals[0]?.reviewStatus, 'NEEDS_MAPPING')
    await explorer.review('press3', 'Press3.unique.numeric', 'IGNORE')
    assert.equal((await explorer.detail({ occurrence, changeLookbackMinutes: 15 })).rawTelemetry.signals[0]?.reviewStatus, 'IGNORE')
    assert.equal((await reviews.list('press5', ['Press3.unique.numeric'])).length, 0)
    const plotted = await explorer.rawPlot({ occurrence, rawIdentity: 'Press3.unique.numeric' })
    assert.equal(plotted.signal.rawIdentity, 'Press3.unique.numeric')
    assert.deepEqual(historyCalls.at(-1), { pressKey: 'press3', rawIdentity: 'Press3.unique.numeric', fromUtc: occurrence.chartFromUtc, toUtc: occurrence.chartToUtc })
  })

  it('treats raw discovery failure as supplemental and preserves canonical evidence', async () => {
    const telemetry = {
      capabilities: { get: async () => ({ capabilities: [] }) },
      semanticHistory: async (_pressKey: string, query: { signals: TelemetrySemanticSelector[] }) => ({ signals: query.signals.map((selector) => evidence(selector)) }),
      rawChanges: async () => { throw new Error('supplemental unavailable') },
    } as unknown as TelemetryFoundationService
    const detail = await new RawRadiusExplorerService(radiusService(), telemetry).detail({ occurrence, changeLookbackMinutes: 15 })
    assert.equal(detail.rawTelemetry.status, 'unavailable')
    assert.ok(Array.isArray(detail.radiusSegments))
    assert.ok(Array.isArray(detail.speed.samples))
    assert.ok(Array.isArray(detail.changedSignals))
  })

  it('bounds lazy same-code history and preserves exact statusCode identity', async () => {
    const source = radiusService(); let historyInput: Parameters<NonNullable<RadiusService['getExactIdentityHistory']>>[0] | undefined
    source.getAnalysisOverview = async () => { throw new Error('full overview must not be used by lazy history') }
    const identity = { eventType: 'B', statusCode: '400', statusDescription: 'Recorded B state' }
    const neighbor = (eventType: string, statusCode: string, statusDescription: string) => ({ eventType, statusCode, statusDescription })
    source.getExactIdentityHistory = async (input) => {
      historyInput = input
      return {
        queryCount: 3, sliceCount: 1, rowsConsidered: 18, matchingOccurrencesAvailable: 4,
        examinedFromUtc: '2026-08-01T00:00:00.000Z', examinedToUtc: startUtc,
        historyComplete: true, historyPartialReason: null,
        occurrences: [
          { ...identity, startUtc: '2026-08-01T12:00:00.000Z', endUtc: '2026-08-01T12:01:00.000Z', durationSeconds: 60, previousIdentity: neighbor('G', '1', 'Run'), nextIdentity: neighbor('B', '401', 'Recorded B state') },
          { ...identity, startUtc: '2026-08-02T12:00:00.000Z', endUtc: '2026-08-02T12:02:00.000Z', durationSeconds: 120, previousIdentity: neighbor('B', '401', 'Recorded B state'), nextIdentity: neighbor('M', '16', 'Make Ready') },
          { ...identity, startUtc: '2026-08-03T12:00:00.000Z', endUtc: '2026-08-03T12:03:00.000Z', durationSeconds: 180, previousIdentity: neighbor('G', '1', 'Run'), nextIdentity: neighbor('G', '1', 'Run') },
          { ...identity, startUtc: '2026-08-04T12:00:00.000Z', endUtc: '2026-08-04T12:04:00.000Z', durationSeconds: 240, previousIdentity: neighbor('M', '16', 'Make Ready'), nextIdentity: neighbor('G', '1', 'Run') },
        ],
      }
    }
    const telemetry = new Proxy({}, { get: () => { throw new Error('lazy Radius history must not access telemetry') } }) as TelemetryFoundationService
    const classified = new ClassifiedRadiusService(source, {} as ClassificationService)
    const summary = await new RawRadiusExplorerService(classified, telemetry).historicalSummary({ occurrence, lookbackDays: 31, maximumOccurrences: 100 })
    assert.deepEqual(historyInput, { pressKey: 'press3', fromUtc: '2026-07-13T12:00:00.000Z', toUtc: startUtc, identity, maximumOccurrences: 100 })
    assert.equal(summary.supportCount, 4); assert.equal(summary.scope.includes('exact Radius identity'), true)
    assert.equal(summary.metrics.medianDurationMinutes, 2.5); assert.equal(summary.metrics.durationLowerQuartileMinutes, 1); assert.equal(summary.metrics.durationUpperQuartileMinutes, 3)
    assert.match(String(summary.metrics.commonPreviousIdentities), /B \/ 401 \/ Recorded B state \(1\)/); assert.match(String(summary.metrics.commonNextIdentities), /G \/ 1 \/ Run \(2\)/)
    assert.deepEqual(summary.timeSpan, { startUtc: '2026-08-01T12:00:00.000Z', endUtc: '2026-08-04T12:04:00.000Z' })
    assert.deepEqual({ ...summary.performance, totalMs: 0 }, { radiusQueryCount: 3, historySliceCount: 1, rowsConsidered: 18, matchingOccurrences: 4, matchingOccurrencesAvailable: 4, historyExaminedFromUtc: '2026-08-01T00:00:00.000Z', historyExaminedToUtc: startUtc, historyComplete: true, historyPartialReason: null, totalMs: 0, payloadBytes: summary.performance!.payloadBytes })
    assert.equal(summary.metrics.historyComplete, true); assert.equal(summary.metrics.historyExaminedFromUtc, '2026-08-01T00:00:00.000Z')
    assert.ok(summary.performance!.totalMs >= 0); assert.ok(summary.performance!.payloadBytes > 0); assert.match(summary.limitations.join(' '), /not a correctness standard/)
  })

  it('builds a same-exact-identity report with bounded canonical telemetry and no raw scan', async () => {
    const source = radiusService(); let exactHistoryCalls = 0; let rawScans = 0; const telemetryCalls: Array<{ fromUtc: string; toUtc: string; signals: TelemetrySemanticSelector[] }> = []
    source.getExactIdentityHistory = async () => { exactHistoryCalls += 1; return { queryCount: 3, sliceCount: 1, rowsConsidered: 5, matchingOccurrencesAvailable: 1, examinedFromUtc: '2026-08-12T12:00:00.000Z', examinedToUtc: startUtc, historyComplete: true, historyPartialReason: null, occurrences: [{ eventType: 'B', statusCode: '400', statusDescription: 'Recorded B state', startUtc: '2026-08-13T11:00:00.000Z', endUtc: '2026-08-13T11:05:00.000Z', durationSeconds: 300, previousIdentity: null, nextIdentity: null }] } }
    const speedSamples = ['2026-08-13T10:50:00.000Z', '2026-08-13T10:55:00.000Z', '2026-08-13T11:01:00.000Z', '2026-08-13T11:04:00.000Z', '2026-08-13T11:50:00.000Z', '2026-08-13T11:55:00.000Z', '2026-08-13T12:01:00.000Z', '2026-08-13T12:04:00.000Z'].map((value, index) => sample(value, index % 4 < 2 ? 100 : 60))
    const telemetry = { capabilities: { get: async () => ({ capabilities: [] }) }, semanticHistory: async (_pressKey: string, query: { fromUtc: string; toUtc: string; signals: TelemetrySemanticSelector[] }) => { telemetryCalls.push(query); return { signals: query.signals.map((selector) => evidence(selector, null, [], speedSamples.filter((item) => Date.parse(item.observedAtUtc) >= Date.parse(query.fromUtc) && Date.parse(item.observedAtUtc) <= Date.parse(query.toUtc)))) } }, rawChanges: async () => { rawScans += 1; throw new Error('must not run') } } as unknown as TelemetryFoundationService
    const report = await new RawRadiusExplorerService(source, telemetry).eventLearningReport({ occurrence })
    assert.equal(report.reportKind, 'raw_radius'); assert.equal(exactHistoryCalls, 1); assert.equal(rawScans, 0); assert.equal(report.coverage.automaticRawSignalScans, 0)
    assert.ok(report.performance.cohortOccurrences <= 30); assert.ok(report.coverage.candidateSignals <= 12); assert.ok(report.performance.payloadBytes > 0)
    assert.ok(telemetryCalls.every((call) => Date.parse(call.toUtc) - Date.parse(call.fromUtc) <= 2 * 60 * 60_000 && call.signals.length <= 50))
    assert.deepEqual(report.target, { eventType: 'B', statusCode: '400', statusDescription: 'Recorded B state', press: 'Press 3', durationSeconds: 600 })
  })
})
