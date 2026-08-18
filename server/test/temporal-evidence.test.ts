import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { IndustrialAnalyticsService } from '../src/industrial-analytics/industrial-analytics-service.js'
import { buildCategoricalTemporalEvidenceProgram, buildNumericTemporalEvidenceProgram, TEMPORAL_PROGRAM_NUMERIC_LANDMARK_LIMIT, TEMPORAL_PROGRAM_SEGMENT_LIMIT } from '../src/industrial-analytics/temporal-evidence.js'
import { validateDiscoveryReferences, type DiscoveryCandidate } from '../src/ai-investigator/discovery.js'
import type { AiGroundingFact, AiInvestigatorDiscoveryDraftContent } from '../src/ai-investigator/contracts.js'

const origin = Date.parse('2026-08-17T00:00:00.000Z')
const at = (minute: number) => new Date(origin + minute * 60_000).toISOString()

describe('Temporal Evidence Programs', () => {
  it('preserves event boundaries, extrema, strongest Delta landmarks, and bounded trend shape', () => {
    const values = [10, 10, 10, 11, 12, 30, 28, 25, 5, 8, 12, 18, 16, 14, 22, 24, 20, 18, 17, 16, 15]
    const program = buildNumericTemporalEvidenceProgram({ candidateId: 'press14', pressKey: 'press14', eventId: 'episode-1', canonicalId: 'ink.temperature.actual', unit: 'F', range: { start: at(0), end: at(20) }, event: { start: at(5), end: at(10) }, samples: values.map((value, index) => ({ atUtc: at(index), value })), selectedBecause: ['strongest bounded Delta change'] })!
    assert.equal(program.datatype, 'numeric'); assert.ok(program.landmarks.length <= TEMPORAL_PROGRAM_NUMERIC_LANDMARK_LIMIT); assert.ok(program.segments.length <= TEMPORAL_PROGRAM_SEGMENT_LIMIT)
    assert.ok(program.landmarks.some((item) => item.kinds.includes('EVENT_START'))); assert.ok(program.landmarks.some((item) => item.kinds.includes('EVENT_END')))
    assert.ok(program.landmarks.some((item) => item.kinds.includes('MINIMUM') && item.value === 5)); assert.ok(program.landmarks.some((item) => item.kinds.includes('MAXIMUM') && item.value === 30))
    assert.ok(program.landmarks.some((item) => item.kinds.includes('DELTA_BASELINE'))); assert.ok(program.landmarks.some((item) => item.kinds.includes('DELTA_TRIGGER')))
    assert.ok(program.segments.some((item) => item.trend === 'RISING' || item.trend === 'FALLING' || item.trend === 'OSCILLATING'))
    assert.equal('samples' in program, false)
  })

  it('represents categorical values as intervals and removes repeated identical samples', () => {
    const program = buildCategoricalTemporalEvidenceProgram({ candidateId: 'press14', pressKey: 'press14', eventId: 'episode-2', canonicalId: 'ink.washup.state', range: { start: at(0), end: at(10) }, event: { start: at(4), end: at(7) }, samples: [[0, false], [1, false], [3, true], [4, true], [7, false], [9, false]].map(([minute, value]) => ({ atUtc: at(Number(minute)), value: Boolean(value) })) })!
    assert.equal(program.transitionCount, 2); assert.deepEqual(program.transitions.map(({ from, to }) => [from, to]), [[false, true], [true, false]]); assert.equal(program.intervals.length, 3); assert.equal(program.repeatedToggleCount, 1)
  })

  it('marks traces unusable below coverage support and preserves gap state without interpolation', () => {
    const program = buildNumericTemporalEvidenceProgram({ candidateId: 'press10', pressKey: 'press10', eventId: 'episode-gap', canonicalId: 'machine.speed.actual', unit: null, range: { start: at(0), end: at(100) }, event: { start: at(5), end: at(10) }, samples: [0, 1, 2, 3, 4].map((value) => ({ atUtc: at(value), value })), gaps: [{ canonicalId: 'machine.speed.actual', deckNumber: null, startUtc: at(4), endUtc: at(90), durationMs: 86 * 60_000 }] })!
    assert.equal(program.usable, false); assert.equal(program.gapState, 'INSUFFICIENT'); assert.equal(program.gaps.length, 1)
  })
})

describe('relationship and ordering hardening', () => {
  const analytics = new IndustrialAnalyticsService()
  it('reports LEVELS and DIFFERENCES as separate relationship bases and scopes', () => {
    const left = Array.from({ length: 30 }, (_item, index) => ({ atUtc: at(index), value: index + index % 3 }))
    const right = left.map((item) => ({ atUtc: item.atUtc, value: item.value * 2 }))
    const levels = analytics.numericRelationship({ pressKey: 'press14', leftVariableId: 'a', rightVariableId: 'b', range: { start: at(0), end: at(29) }, left, right, basis: 'LEVELS', scope: 'EVENT_WINDOW', maximumLagMinutes: 0 })!
    const differences = analytics.numericRelationship({ pressKey: 'press14', leftVariableId: 'a', rightVariableId: 'b', range: { start: at(0), end: at(29) }, left, right, basis: 'DIFFERENCES', scope: 'EVENT_WINDOW', maximumLagMinutes: 0 })!
    assert.equal(levels.basis, 'LEVELS'); assert.equal(differences.basis, 'DIFFERENCES'); assert.equal(levels.scope, 'EVENT_WINDOW'); assert.equal(differences.bestLagCorrelation, 1)
  })

  it('classifies tied and cadence-ambiguous first divergence explicitly', () => {
    const transition = analytics.valueTransitions({ pressKey: 'press14', variableId: 'mode', range: { start: at(0), end: at(10) }, event: { id: 'event', start: at(5), end: at(7) }, samples: [{ atUtc: at(0), value: 'A' }, { atUtc: at(5.2), value: 'B' }] })
    const ambiguous = analytics.firstDivergence({ pressKey: 'press14', event: { id: 'event', start: at(5), end: at(7) }, observations: [transition], cadenceMinutes: 1 })!
    assert.equal(ambiguous.metrics.ordering, 'INDETERMINATE_WITHIN_CADENCE')
    const tied = analytics.firstDivergence({ pressKey: 'press14', event: { id: 'event', start: at(5.2), end: at(7) }, observations: [transition], cadenceMinutes: 1 })!
    assert.equal(tied.metrics.ordering, 'SAME_RECORDED_TIME')
  })
})

describe('temporal trace grounding', () => {
  const fact: AiGroundingFact = { factId: 'press14.test.metric.current', pressKey: 'press14', press: 'Press 14', source: 'telemetry', metric: 'test', value: 1, unit: null, role: 'current', usable: true, label: 'Test' }
  const trace = buildCategoricalTemporalEvidenceProgram({ candidateId: 'press14', pressKey: 'press14', eventId: 'episode', canonicalId: 'mode', range: { start: at(0), end: at(10) }, event: { start: at(4), end: at(6) }, samples: [{ atUtc: at(0), value: 'A' }, { atUtc: at(5), value: 'B' }] })!
  const candidate: DiscoveryCandidate = { pressKey: 'press14', press: 'Press 14', signalCount: 1, productionDelta: null, interruptionDelta: 0, longestDelta: null, observations: [], facts: [fact], traces: [trace] }
  const draft = (traceIds: string[]): AiInvestigatorDiscoveryDraftContent => ({ summary: 'Review.', findings: [{ candidateId: 'press14', title: 'Trace review', importance: 'medium', confidence: 'medium', factIds: [fact.factId], traceIds, interpretation: 'The supplied trace has a reviewable pattern.', whyWorthInvestigating: 'The trace is grounded.', recommendedInvestigation: 'Inspect the trace.' }], limitations: [] })

  it('accepts an owned usable trace and rejects invented, cross-press, and unusable trace references', () => {
    assert.equal(validateDiscoveryReferences(draft([trace.traceId]), [candidate], [fact]).issues.length, 0)
    assert.equal(validateDiscoveryReferences(draft(['press14.trace.0000000000000000']), [candidate], [fact]).issues[0]?.code, 'unknown_trace_id')
    const crossPress = { ...trace, pressKey: 'press10' as const }; assert.equal(validateDiscoveryReferences(draft([trace.traceId]), [{ ...candidate, traces: [crossPress] }], [fact]).issues[0]?.code, 'cross_press_trace')
    const unusable = { ...trace, usable: false }; assert.equal(validateDiscoveryReferences(draft([trace.traceId]), [{ ...candidate, traces: [unusable] }], [fact]).issues[0]?.code, 'unusable_trace')
  })
})
