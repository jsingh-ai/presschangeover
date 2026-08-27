import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { RadiusPressKey } from '../src/radius/models.js'
import { analyzeSemanticSignal, clueEvidenceWindow, CLUE_MAX_WINDOW_MS, CLUE_SELECTOR_BATCH_SIZE, ENGINEERING_CLUE_CATALOG, ENGINEERING_CLUE_HEURISTICS, EngineeringClueAnalysisService, numericSummary, rankWhereToLook, type ClueOccurrenceInput, type EngineeringCategoryCell, type EngineeringSignalClue } from '../src/telemetry/engineering-clue-analysis.js'
import type { CapabilityAssessment, PressSemanticSignalEvidence, TelemetrySample } from '../src/telemetry/telemetry-contracts.js'
import type { TelemetryFoundationService } from '../src/telemetry/telemetry-foundation-service.js'

const occurrence: ClueOccurrenceInput = { occurrenceId: 'occurrence-1', pressKey: 'press5', displayName: 'Press 5', startUtc: '2026-08-13T12:15:00.000Z', endUtc: '2026-08-13T12:30:00.000Z', durationSeconds: 900, exactIdentities: [{ eventType: 'B', statusCode: '1', statusDescription: 'Raw state' }] }
const window = clueEvidenceWindow(occurrence.startUtc, occurrence.endUtc)
const sample = (observedAtUtc: string, value: number | string): TelemetrySample => ({ observedAtUtc, receivedAtUtc: observedAtUtc, sourceTimestampUtc: observedAtUtc, qualityState: 'GOOD', valueKind: typeof value === 'number' ? 'numeric' : 'string', value })
const numericSignal = (samples: TelemetrySample[], sourceUnit: string | null = null): PressSemanticSignalEvidence => ({ canonicalId: 'machine.speed.actual', deckNumber: null, capabilityState: 'SUPPORTED', observationState: samples.length ? 'SUPPORTED_WITH_OBSERVATIONS' : 'SUPPORTED_WITH_NO_SAMPLES_IN_RANGE', mappingStatus: 'MAPPED', sourceUnit, canonicalUnitStatus: 'UNVERIFIED', representation: 'samples', seed: sample(window.fromUtc, 20), samples, changes: [] })
const speedItem = ENGINEERING_CLUE_CATALOG.find(({ canonicalId }) => canonicalId === 'machine.speed.actual')!

describe('engineering telemetry clue analysis', () => {
  it('uses exact before/during/after boundaries and explicitly bounds long occurrences around entry', () => {
    assert.deepEqual(window, { fromUtc: '2026-08-13T12:00:00.000Z', toUtc: '2026-08-13T12:45:00.000Z', beforeEndUtc: occurrence.startUtc, duringStartUtc: occurrence.startUtc, duringEndUtc: occurrence.endUtc, afterStartUtc: occurrence.endUtc, boundedAroundStart: false, message: null })
    const long = clueEvidenceWindow(occurrence.startUtc, '2026-08-13T15:30:00.000Z')
    assert.equal(Date.parse(long.toUtc) - Date.parse(long.fromUtc), CLUE_MAX_WINDOW_MS)
    assert.equal(long.boundedAroundStart, true)
    assert.equal(long.message, 'Telemetry clues use a bounded window around occurrence start.')
  })

  it('does not make a stable non-zero signal interesting and does not score raw sample count', () => {
    const samples = Array.from({ length: 700 }, (_, index) => sample(new Date(Date.parse(window.fromUtc) + index * 3_000).toISOString(), 22))
    const clue = analyzeSemanticSignal(speedItem, numericSignal(samples), occurrence, window)
    assert.equal(clue.isClue, false)
    assert.equal(clue.clueQuality, 0)
    assert.match(clue.description, /observed; no supported shift detected/)
    assert.equal(clue.observationConfidence, 'OBSERVED')
  })

  it('requires three observations in both comparison windows without treating sparse history as missing data', () => {
    assert.equal(ENGINEERING_CLUE_HEURISTICS.minimumNumericObservationsPerComparedWindow, 3)
    const sparse = [sample('2026-08-13T12:01:00.000Z', 20), sample('2026-08-13T12:02:00.000Z', 20), sample('2026-08-13T12:16:00.000Z', 80), sample('2026-08-13T12:17:00.000Z', 80)]
    const clue = analyzeSemanticSignal(speedItem, numericSignal(sparse), occurrence, window)
    assert.equal(clue.isClue, false)
    assert.equal(clue.observationConfidence, 'LIMITED_OBSERVATION')
    assert.match(clue.description, /limited observation; insufficient temporal evidence/)
    assert.doesNotMatch(clue.description, /stable|missing data/i)
  })

  it('finds numeric level and variability shifts using within-signal distributions', () => {
    const before = [20, 21, 20, 21].map((value, index) => sample(`2026-08-13T12:0${index + 1}:00.000Z`, value))
    const during = [35, 50, 38, 55].map((value, index) => sample(`2026-08-13T12:${16 + index}:00.000Z`, value))
    const clue = analyzeSemanticSignal(speedItem, numericSignal([...before, ...during]), occurrence, window)
    assert.equal(clue.isClue, true)
    assert.match(clue.description, /level shift/)
    assert.match(clue.description, /more variable/)
    assert.equal(clue.before?.count, 4)
    assert.equal(clue.during?.count, 4)
  })

  it('anchors a variability-only clue to its first contributing during observation', () => {
    const before = [0, 10, 0, 10].map((value, index) => sample(`2026-08-13T12:0${index + 1}:00.000Z`, value))
    const during = [-20, 30, -20, 30].map((value, index) => sample(`2026-08-13T12:${16 + index}:00.000Z`, value))
    const clue = analyzeSemanticSignal(speedItem, numericSignal([...before, ...during]), occurrence, window)
    assert.equal(clue.isClue, true)
    assert.doesNotMatch(clue.description, /level shift/)
    assert.match(clue.description, /more variable/)
    assert.equal(clue.firstRelevantAtUtc, '2026-08-13T12:16:00.000Z')
    assert.equal(clue.firstRelevantOffsetMs, 60_000)
  })

  it('keeps unavailable and no observations distinct from stable', () => {
    const noObservations = analyzeSemanticSignal(speedItem, numericSignal([]), occurrence, window)
    assert.equal(noObservations.observationState, 'SUPPORTED_WITH_NO_SAMPLES_IN_RANGE')
    assert.match(noObservations.description, /insufficient temporal evidence/)
    assert.doesNotMatch(noObservations.description, /stable relative/)
  })

  it('keeps temporarily unavailable, unknown, unsupported, and zero distinct in the category map', async () => {
    const capability = (canonicalId: string, state: CapabilityAssessment['state']): CapabilityAssessment => ({ canonicalId, state, deckNumbers: [], historyQueryable: state === 'SUPPORTED', evidenceKind: state === 'SUPPORTED' ? 'semantic_history' : null })
    const capabilities = [
      capability('machine.speed.actual', 'TEMPORARILY_UNAVAILABLE'),
      capability('dryer.tunnel.temperature.actual', 'UNKNOWN'),
      capability('production.order.length.actual', 'UNSUPPORTED'),
    ]
    const fake = {
      capabilities: { get: async () => ({ pressKey: 'press5', sourceId: 5, sourceKey: 'press5', displayName: 'Press 5', metadataStatus: 'STALE', capabilities }) },
      semanticHistory: async () => { throw new Error('no supported semantic selector should be requested') },
      motion: async () => { throw new Error('motion should not be requested') },
    } as unknown as TelemetryFoundationService
    const response = await new EngineeringClueAnalysisService(fake).analyze(occurrence)
    assert.equal(response.categoryCells.find(({ scopeKey, category }) => scopeKey === 'machine' && category === 'speed')?.status, 'temporarily_unavailable')
    assert.equal(response.categoryCells.find(({ scopeKey, category }) => scopeKey === 'machine' && category === 'dryer')?.status, 'unknown')
    assert.equal(response.categoryColumns.includes('repeat_other'), false)
    assert.equal(response.coverage.unavailableSelectors, 2)
  })

  it('keeps raw state codes and calculates signed lead/lag without decoding them', () => {
    const item = ENGINEERING_CLUE_CATALOG.find(({ canonicalId }) => canonicalId === 'ink.pump.status')!
    const at = '2026-08-13T12:14:18.000Z'
    const signal: PressSemanticSignalEvidence = { canonicalId: item.canonicalId, deckNumber: 4, capabilityState: 'SUPPORTED', observationState: 'SUPPORTED_WITH_OBSERVATIONS', mappingStatus: 'MAPPED', sourceUnit: null, canonicalUnitStatus: 'UNVERIFIED', representation: 'changes', seed: sample(window.fromUtc, 1), samples: [], changes: [{ ...sample(at, 11), previousObservedAtUtc: window.fromUtc, previousReceivedAtUtc: window.fromUtc, previousSourceTimestampUtc: window.fromUtc, previousQualityState: 'GOOD', previousValueKind: 'integer', previousValue: 1 }] }
    const clue = analyzeSemanticSignal(item, signal, occurrence, window)
    assert.equal(clue.firstRelevantOffsetMs, -42_000)
    assert.equal(clue.firstRelevantPreviousValue, 1)
    assert.equal(clue.firstRelevantValue, 11)
    assert.match(clue.description, /raw state-code transition 1 → 11 observed before Radius entry/)
    assert.doesNotMatch(clue.description, /started|failed|root cause/i)
  })

  it('hides B&R array-index unit artifacts', () => {
    const clue = analyzeSemanticSignal(speedItem, numericSignal([sample('2026-08-13T12:01:00.000Z', 20)], '3'), occurrence, window)
    assert.equal(clue.sourceUnit, null)
    assert.equal(clue.unitLabel, 'Unit unverified')
  })

  it('uses exact half-open summary windows', () => {
    const values = [sample('2026-08-13T12:00:00.000Z', 1), sample('2026-08-13T12:15:00.000Z', 2)]
    assert.equal(numericSummary(values, Date.parse(window.fromUtc), Date.parse(occurrence.startUtc)).count, 1)
    assert.equal(numericSummary(values, Date.parse(occurrence.startUtc), Date.parse(occurrence.endUtc)).count, 1)
  })

  it('preserves row-distribution median and IQR while excluding BAD historian quality', () => {
    const values = [sample('2026-08-13T12:01:00.000Z', 0), sample('2026-08-13T12:09:00.000Z', 10), sample('2026-08-13T12:10:00.000Z', 10), { ...sample('2026-08-13T12:11:00.000Z', 100), qualityState: 'false' }]
    assert.deepEqual(numericSummary(values, Date.parse(window.fromUtc), Date.parse(occurrence.startUtc)), { count: 3, median: 10, minimum: 0, maximum: 10, iqr: 5 })
  })

  it('preserves exact boundaries for very short and one-minute occurrences', () => {
    for (const durationMs of [20_000, 60_000]) {
      const shortOccurrence = { ...occurrence, endUtc: new Date(Date.parse(occurrence.startUtc) + durationMs).toISOString(), durationSeconds: durationMs / 1_000 }
      const shortWindow = clueEvidenceWindow(shortOccurrence.startUtc, shortOccurrence.endUtc)
      assert.equal(shortWindow.duringStartUtc, shortOccurrence.startUtc)
      assert.equal(shortWindow.duringEndUtc, shortOccurrence.endUtc)
      assert.equal(Date.parse(shortWindow.fromUtc), Date.parse(shortOccurrence.startUtc) - 15 * 60_000)
      assert.equal(Date.parse(shortWindow.toUtc), Date.parse(shortOccurrence.endUtc) + 15 * 60_000)
    }
  })

  it('does not compare when observations exist only before, during, after, or across a during-period gap', () => {
    const cases = [
      ['before', ['2026-08-13T12:01:00.000Z', '2026-08-13T12:02:00.000Z', '2026-08-13T12:03:00.000Z']],
      ['during', ['2026-08-13T12:16:00.000Z', '2026-08-13T12:17:00.000Z', '2026-08-13T12:18:00.000Z']],
      ['after', ['2026-08-13T12:31:00.000Z', '2026-08-13T12:32:00.000Z', '2026-08-13T12:33:00.000Z']],
      ['gap', ['2026-08-13T12:01:00.000Z', '2026-08-13T12:02:00.000Z', '2026-08-13T12:03:00.000Z', '2026-08-13T12:31:00.000Z', '2026-08-13T12:32:00.000Z', '2026-08-13T12:33:00.000Z']],
    ] as const
    for (const [name, timestamps] of cases) {
      const clue = analyzeSemanticSignal(speedItem, numericSignal(timestamps.map((at, index) => sample(at, index < 3 ? 10 : 90))), occurrence, window)
      assert.equal(clue.isClue, false, name)
      assert.equal(clue.observationConfidence, 'LIMITED_OBSERVATION', name)
      assert.match(clue.description, /insufficient temporal evidence/, name)
    }
  })

  it('treats a raw step at occurrence start as during and one at occurrence end as after', () => {
    const item = ENGINEERING_CLUE_CATALOG.find(({ canonicalId }) => canonicalId === 'machine.speed.setpoint')!
    const signalAt = (at: string): PressSemanticSignalEvidence => ({ canonicalId: item.canonicalId, deckNumber: null, capabilityState: 'SUPPORTED', observationState: 'SUPPORTED_WITH_OBSERVATIONS', mappingStatus: 'MAPPED', sourceUnit: null, canonicalUnitStatus: 'UNVERIFIED', representation: 'changes', seed: sample(window.fromUtc, 10), samples: [], changes: [{ ...sample(at, 20), previousObservedAtUtc: window.fromUtc, previousReceivedAtUtc: window.fromUtc, previousSourceTimestampUtc: window.fromUtc, previousQualityState: 'GOOD', previousValueKind: 'numeric', previousValue: 10 }] })
    const atStart = analyzeSemanticSignal(item, signalAt(occurrence.startUtc), occurrence, window)
    const atEnd = analyzeSemanticSignal(item, signalAt(occurrence.endUtc), occurrence, window)
    assert.match(atStart.description, /during the occurrence/)
    assert.equal(atStart.firstRelevantOffsetMs, 0)
    assert.match(atEnd.description, /after the occurrence/)
    assert.equal(atEnd.firstRelevantOffsetMs, Date.parse(occurrence.endUtc) - Date.parse(occurrence.startUtc))
  })

  it('assigns each canonical signal one primary category', () => {
    const categoryBySignal = new Map<string, string>()
    for (const item of ENGINEERING_CLUE_CATALOG) {
      assert.equal(categoryBySignal.has(item.canonicalId), false, `${item.canonicalId} was duplicated`)
      categoryBySignal.set(item.canonicalId, item.category)
    }
    assert.equal(categoryBySignal.size, ENGINEERING_CLUE_CATALOG.length)
  })

  it('normalizes Where to Look by supported opportunities and deduplicates a canonical signal', () => {
    const makeClue = (canonicalId: string, deckNumber: number, category: EngineeringSignalClue['category'], clueQuality: number): EngineeringSignalClue => ({ canonicalId, deckNumber, friendlyName: canonicalId, signalType: 'continuous', category, capabilityState: 'SUPPORTED', observationState: 'SUPPORTED_WITH_OBSERVATIONS', observationConfidence: 'OBSERVED', mappingStatus: 'MAPPED', sourceUnit: null, unitLabel: 'Unit unverified', canonicalUnitStatus: null, before: { count: 3, median: 1, minimum: 1, maximum: 1, iqr: 0 }, during: { count: 3, median: 2, minimum: 2, maximum: 2, iqr: 0 }, after: { count: 0, median: null, minimum: null, maximum: null, iqr: null }, enteringValue: null, transitionCount: 0, largestRawStep: null, description: 'observed shift', isClue: true, clueQuality, firstRelevantAtUtc: occurrence.startUtc, firstRelevantOffsetMs: 0, firstRelevantPreviousValue: null, firstRelevantValue: 2 })
    const cells: EngineeringCategoryCell[] = [
      { scopeKey: 'deck-1', scopeLabel: 'Deck 1', category: 'ink', supportedSignals: 10, observedSignals: 10, clueSignals: 4, status: 'multiple_clues', details: [] },
      { scopeKey: 'deck-2', scopeLabel: 'Deck 2', category: 'viscosity', supportedSignals: 2, observedSignals: 2, clueSignals: 1, status: 'one_clue', details: [] },
    ]
    const clues = [
      ...Array.from({ length: 4 }, (_, index) => makeClue(`weak-${index}`, 1, 'ink', 1)),
      makeClue('strong', 2, 'viscosity', 4),
      makeClue('strong', 2, 'viscosity', 3),
    ]
    const ranking = rankWhereToLook(clues, cells)
    assert.equal(ranking[0]?.scopeKey, 'deck-2')
    assert.equal(ranking[0]?.clueSignals, 1)
    assert.equal(ranking[0]?.clueShare, .5)
    assert.equal(ranking.find(({ scopeKey }) => scopeKey === 'deck-1')?.supportedSignals, 10)
  })

  it('filters capabilities before history, batches at 50, preserves P12/P13 deck scalars, and omits unsupported P15 Deck 10 drive selectors', async () => {
    const capability = (canonicalId: string, deckNumbers: number[] = [], state: CapabilityAssessment['state'] = 'SUPPORTED'): CapabilityAssessment => ({ canonicalId, state, deckNumbers, historyQueryable: true, evidenceKind: 'semantic_history' })
    const capabilities = ENGINEERING_CLUE_CATALOG.filter(({ canonicalId }) => canonicalId !== 'physical.motion_state').map(({ canonicalId, scope }) => capability(canonicalId, scope === 'deck' ? [1, 2, 3, 4, 5, 6, 7, 8, 9] : []))
    capabilities.push(capability('physical.motion_state', [], 'UNSUPPORTED'))
    const batches: Array<Array<{ canonicalId: string; deckNumber?: number }>> = []
    const fake = {
      capabilities: { get: async (_pressKey: RadiusPressKey) => ({ pressKey: 'press15', sourceId: 15, sourceKey: 'press15', displayName: 'Press 15', metadataStatus: 'FRESH', capabilities }) },
      semanticHistory: async (_pressKey: RadiusPressKey, query: { signals: Array<{ canonicalId: string; deckNumber?: number }> }) => {
        batches.push(query.signals)
        return { pressKey: 'press15', sourceKey: 'press15', displayName: 'Press 15', fromUtc: window.fromUtc, toUtc: window.toUtc, includeSeed: true, signals: query.signals.map(({ canonicalId, deckNumber }) => ({ canonicalId, deckNumber: deckNumber ?? null, capabilityState: 'SUPPORTED', observationState: 'SUPPORTED_WITH_NO_SAMPLES_IN_RANGE', mappingStatus: 'MAPPED', sourceUnit: null, canonicalUnitStatus: 'UNVERIFIED', representation: 'samples', seed: null, samples: [], changes: [] })) }
      },
      motion: async () => { throw new Error('unsupported motion must not be requested') },
    } as unknown as TelemetryFoundationService
    const response = await new EngineeringClueAnalysisService(fake).analyze({ ...occurrence, pressKey: 'press15' })
    assert.ok(batches.length > 1)
    assert.ok(batches.every((batch) => batch.length <= CLUE_SELECTOR_BATCH_SIZE))
    assert.ok(batches.flat().some(({ canonicalId, deckNumber }) => canonicalId === 'ink.viscosity.actual' && deckNumber === 4))
    assert.ok(!batches.flat().some(({ canonicalId, deckNumber }) => canonicalId === 'anilox.drive.torque.actual' && deckNumber === 10))
    assert.equal(response.performance.totalSelectors, batches.flat().length)
    assert.equal(response.performance.upstreamCalls, response.performance.semanticCalls + 1)
    assert.equal(response.performance.totalMs, response.performance.upstreamMs + response.performance.calculationMs)
    assert.equal(response.performance.responsePayloadBytes, Buffer.byteLength(JSON.stringify(response), 'utf8'))

    for (const pressKey of ['press12', 'press13'] as const) {
      batches.length = 0
      const scalarResponse = await new EngineeringClueAnalysisService(fake).analyze({ ...occurrence, pressKey })
      assert.ok(batches.flat().some(({ canonicalId, deckNumber }) => canonicalId === 'ink.viscosity.actual' && deckNumber === 4))
      assert.equal(scalarResponse.categoryCells.find(({ scopeKey, category }) => scopeKey === 'deck-4' && category === 'viscosity')?.supportedSignals, 4)
    }
  })
})
