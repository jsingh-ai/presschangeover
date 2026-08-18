import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { describeIndustrialNumeric, IndustrialAnalyticsService, INDUSTRIAL_ANALYTICS_RULES } from '../src/industrial-analytics/industrial-analytics-service.js'
import { largestWindowDelta } from '../src/ai-investigator/read-only-tools.js'

const analytics = new IndustrialAnalyticsService()
const at = (minute: number) => new Date(Date.parse('2026-08-17T00:00:00.000Z') + minute * 60_000).toISOString()
const numeric = (values: number[], offset = 0) => values.map((value, index) => ({ atUtc: at(index + offset), value }))

describe('V1 Industrial Analytics deterministic mathematics', () => {
  it('calculates robust descriptive statistics and a known step change', () => {
    const stats = describeIndustrialNumeric(numeric([1, 1, 1, 10, 10, 10]))!
    assert.deepEqual({ count: stats.count, minimum: stats.minimum, maximum: stats.maximum, median: stats.median, mean: stats.mean, range: stats.range, startEndDelta: stats.startEndDelta, largestDelta: stats.largestDelta }, { count: 6, minimum: 1, maximum: 10, median: 5.5, mean: 5.5, range: 9, startEndDelta: 9, largestDelta: 9 })
    assert.equal(stats.standardDeviation, 4.5); assert.equal(stats.slopePerMinute, 2.314)
  })

  it('finds perfect Pearson and high Spearman relationships', () => {
    const positive = analytics.numericRelationship({ pressKey: 'press14', leftVariableId: 'a', rightVariableId: 'b', range: { start: at(0), end: at(4) }, left: numeric([1, 2, 3, 4, 5]), right: numeric([2, 4, 6, 8, 10]), minimumPairs: 5, alignmentToleranceMs: 1_000, maximumLagMinutes: 0 })!
    assert.equal(positive.pearson, 1); assert.equal(positive.spearman, 1)
    const monotonic = analytics.numericRelationship({ pressKey: 'press14', leftVariableId: 'a', rightVariableId: 'b', range: { start: at(0), end: at(4) }, left: numeric([1, 2, 3, 4, 5]), right: numeric([1, 4, 9, 16, 25]), minimumPairs: 5, alignmentToleranceMs: 1_000, maximumLagMinutes: 0 })!
    assert.equal(monotonic.spearman, 1); assert.ok(monotonic.pearson > .97)
  })

  it('detects a known bounded lag and reports direction as left leading right', () => {
    const values = [0, 1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6]
    const result = analytics.numericRelationship({ pressKey: 'press14', leftVariableId: 'speed', rightVariableId: 'temperature', range: { start: at(0), end: at(13) }, left: numeric(values), right: numeric(values, 2), minimumPairs: 8, maximumLagMinutes: 3, lagStepMinutes: 1, alignmentToleranceMs: 1_000 })!
    assert.equal(result.bestLagMinutes, 2); assert.equal(result.bestLagCorrelation, 1)
  })

  it('keeps dense bounded relationship alignment subquadratic', () => {
    const origin = Date.parse('2026-08-17T00:00:00.000Z')
    const dense = Array.from({ length: 5_000 }, (_item, index) => ({ atUtc: new Date(origin + index * 1_000).toISOString(), value: Math.sin(index / 17) + index % 11 }))
    const began = Date.now()
    const result = analytics.numericRelationship({ pressKey: 'press14', leftVariableId: 'a', rightVariableId: 'b', range: { start: dense[0]!.atUtc, end: dense.at(-1)!.atUtc }, left: dense, right: dense.map((item) => ({ ...item, value: item.value * 2 })), maximumLagMinutes: 10, lagStepMinutes: 1, alignmentToleranceMs: 45_000 })!
    assert.equal(result.bestLagMinutes, 0); assert.equal(result.bestLagCorrelation, 1)
    assert.ok(Date.now() - began < 2_000)
  })

  it('calculates the exact strongest bounded window delta with a linear scan', () => {
    const samples = numeric([1, 3, 8, 2, 20, 4])
    assert.equal(largestWindowDelta(samples, { start: at(0), end: at(5) }, 2), 12)
  })

  it('rejects constant signals instead of emitting misleading correlation', () => {
    assert.equal(analytics.numericRelationship({ pressKey: 'press14', leftVariableId: 'a', rightVariableId: 'constant', range: { start: at(0), end: at(9) }, left: numeric([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), right: numeric(Array(10).fill(4)) }), null)
  })

  it('keeps very-low-coverage relationships in diagnostics but not model-visible evidence', () => {
    const left = numeric(Array.from({ length: 100 }, (_item, index) => index % 7))
    const right = numeric(Array.from({ length: 10 }, (_item, index) => (index % 7) * 2))
    const result = analytics.numericRelationship({ pressKey: 'press10', leftVariableId: 'speed', rightVariableId: 'tension', range: { start: at(0), end: at(99) }, left, right, minimumPairs: 8, maximumLagMinutes: 0, alignmentToleranceMs: 1_000 })!
    assert.equal(result.qualified, false); assert.equal(result.qualification, 'LOW_PAIR_COVERAGE'); assert.equal(result.coveragePercent, 10)
    const observation = analytics.relationshipObservation({ pressKey: 'press10', leftVariableId: 'speed', rightVariableId: 'tension', range: { start: at(0), end: at(99) }, left, right, minimumPairs: 8, maximumLagMinutes: 0, alignmentToleranceMs: 1_000 })!
    assert.equal(observation.support.adequate, false); assert.equal(observation.material, false); assert.equal(observation.metrics.qualification, 'LOW_PAIR_COVERAGE')
  })

  it('retains strong relationships only when pair and temporal coverage are meaningful', () => {
    const left = numeric(Array.from({ length: 40 }, (_item, index) => index % 7)); const right = numeric(Array.from({ length: 40 }, (_item, index) => (index % 7) * 3))
    const result = analytics.numericRelationship({ pressKey: 'press14', leftVariableId: 'speed', rightVariableId: 'tension', range: { start: at(0), end: at(39) }, left, right, minimumPairs: 8, maximumLagMinutes: 0, alignmentToleranceMs: 1_000 })!
    assert.equal(result.qualified, true); assert.equal(result.qualification, 'QUALIFIED'); assert.equal(result.temporalCoveragePercent, 100)
    assert.equal(analytics.relationshipObservation({ pressKey: 'press14', leftVariableId: 'speed', rightVariableId: 'tension', range: { start: at(0), end: at(39) }, left, right, minimumPairs: 8, maximumLagMinutes: 0, alignmentToleranceMs: 1_000 })!.material, true)
  })

  it('calculates before/event/after medians for a known event step', () => {
    const observation = analytics.eventAlignedNumeric({ pressKey: 'press14', variableId: 'machine.speed.actual', range: { start: at(0), end: at(8) }, event: { id: 'event-1', start: at(3), end: at(6) }, contextMinutes: 3, samples: numeric([1, 1, 1, 5, 5, 5, 2, 2, 2]) })!
    assert.equal(observation.metrics.beforeMedian, 1); assert.equal(observation.metrics.eventMedian, 5); assert.equal(observation.metrics.afterMedian, 2); assert.equal(observation.metrics.beforeToEventDelta, 4); assert.equal(observation.support.adequate, true)
  })

  it('reuses exact value-change logic for categorical and boolean transitions', () => {
    const states = analytics.valueTransitions({ pressKey: 'press14', variableId: 'production.recipe', range: { start: at(0), end: at(5) }, samples: ['A', 'A', 'A', 'B', 'B', 'C'].map((value, index) => ({ atUtc: at(index), value })) })
    assert.equal(states.metrics.transitionCount, 2)
    const booleans = analytics.valueTransitions({ pressKey: 'press14', variableId: 'deck.active', range: { start: at(0), end: at(4) }, samples: [false, false, true, true, false].map((value, index) => ({ atUtc: at(index), value })) })
    assert.equal(booleans.metrics.transitionCount, 2)
  })

  it('reuses threshold episodes for context-derived envelopes and groups persistence', () => {
    const samples = numeric([10, 10, 10, 10, 10, 10, 20, 20, 20, 20, 10])
    const event = { id: 'event-envelope', start: at(5), end: at(7) }; const range = { start: at(0), end: at(10) }
    const departure = analytics.normalEnvelopeDeparture({ pressKey: 'press14', variableId: 'temperature', range, event, samples })!
    const persistence = analytics.deviationPersistence({ pressKey: 'press14', variableId: 'temperature', range, event, samples })!
    assert.equal(departure.metrics.evidenceType, 'context_derived_normal_envelope'); assert.equal(departure.metrics.firstDepartureAtUtc, at(6)); assert.equal(departure.material, true)
    assert.equal(persistence.metrics.classification, 'sustained'); assert.equal(persistence.metrics.recurrenceCount, 1); assert.ok(Number(persistence.metrics.totalDurationMinutes) >= 4)
  })

  it('requires N>=3 for contextual telemetry feature baselines and retains provenance', () => {
    const input = { pressKey: 'press14' as const, eventId: 'event-context', variableId: 'temperature', feature: 'largest10mDelta', unit: 'F', range: { start: at(0), end: at(10) }, currentValue: 12, currentSampleCount: 20, currentCoveragePercent: 100, baselineType: 'context' as const, matchingDimensions: ['recipe', 'customer'], fallbackLevel: 1 }
    const insufficient = analytics.contextualTelemetryBaseline({ ...input, historical: [4, 5].map((value, index) => ({ value, coveragePercent: 100, range: { start: at(index), end: at(index + 1) } })) })
    assert.equal(insufficient.support.adequate, false); assert.equal(insufficient.material, false); assert.equal(insufficient.metrics.sampleCount, 2)
    const supported = analytics.contextualTelemetryBaseline({ ...input, historical: [4, 5, 6, 5].map((value, index) => ({ value, coveragePercent: 100, range: { start: at(index), end: at(index + 1) } })) })
    assert.equal(supported.support.adequate, true); assert.equal(supported.metrics.baselineType, 'context'); assert.equal(supported.metrics.matchingDimensions, 'recipe + customer'); assert.equal(supported.metrics.fallbackLevel, 1); assert.equal(supported.material, true)
  })

  it('orders first divergence and derives Radius/telemetry timing without causal language', () => {
    const range = { start: at(0), end: at(10) }; const event = { id: 'event-ordering', start: at(5), end: at(7) }
    const transition = analytics.valueTransitions({ pressKey: 'press14', variableId: 'production.recipe', range, event, samples: [{ atUtc: at(0), value: 'A' }, { atUtc: at(4), value: 'B' }] })
    const departure = analytics.normalEnvelopeDeparture({ pressKey: 'press14', variableId: 'temperature', range, event, samples: numeric([10, 10, 10, 10, 10, 10, 20, 20, 20, 20, 10]) })!
    const first = analytics.firstDivergence({ pressKey: 'press14', event, observations: [departure, transition] })!
    assert.equal(first.metrics.firstObservedAtUtc, at(4)); assert.equal(first.metrics.sourceFamily, 'value_state_transition'); assert.match(String(first.limitations[0]), /not a root-cause/)
    const alignment = analytics.radiusTelemetryAlignment({ pressKey: 'press14', event, observations: [departure] })!
    assert.equal(alignment.metrics.relation, 'RADIUS_PRECEDED_TELEMETRY'); assert.equal(alignment.metrics.lagMinutes, 1); assert.match(String(alignment.metrics.statement), /preceded/); assert.doesNotMatch(String(alignment.metrics.statement), /cause/i)
  })

  it('describes repeated and extra Radius sequence steps with adequate support', () => {
    const episode = (id: string, states: string[]) => ({ episodeId: id, startUtc: at(0), endUtc: at(5), orderedStates: states.map((state) => ({ state, identity: { eventType: 'M', statusCode: '1', statusDescription: state }, durationSeconds: 60 })), returnAttempts: 1 })
    const observation = analytics.sequenceDeviation({ pressKey: 'press14', range: { start: at(0), end: at(10) }, occurrence: episode('test', ['A', 'B', 'B', 'D', 'C']), comparable: [episode('one', ['A', 'B', 'C']), episode('two', ['A', 'B', 'C']), episode('three', ['A', 'B', 'C'])] })
    assert.equal(observation.support.minimumRequired, INDUSTRIAL_ANALYTICS_RULES.minimumComparableSequences); assert.equal(observation.support.adequate, true); assert.equal(observation.metrics.repeatedStates, 'M / 1 / B'); assert.equal(observation.metrics.extraStates, 'M / 1 / B, M / 1 / D'); assert.equal(observation.material, true)
  })

  it('keeps equal Radius descriptions distinct when status codes differ', () => {
    const state = (statusCode: string) => ({ state: 'Make Ready', identity: { eventType: 'M', statusCode, statusDescription: 'Make Ready' }, durationSeconds: 60 })
    const episode = (id: string, statusCode: string) => ({ episodeId: id, startUtc: at(0), endUtc: at(5), orderedStates: [state(statusCode)], returnAttempts: 0 })
    const observation = analytics.sequenceDeviation({ pressKey: 'press14', range: { start: at(0), end: at(10) }, occurrence: episode('selected', '20'), comparable: [episode('one', '10'), episode('two', '10'), episode('three', '10')] })
    assert.equal(observation.metrics.expectedStateAtDivergence, 'M / 10 / Make Ready')
    assert.equal(observation.metrics.observedStateAtDivergence, 'M / 20 / Make Ready')
    assert.equal(observation.material, true)
  })

  it('keeps equivalent canonical concepts isolated by press in cross-press comparison', () => {
    const observations = analytics.crossPressComparison({ canonicalId: 'machine.speed.actual', range: { start: at(0), end: at(5) }, series: [{ pressKey: 'press10', samples: numeric([10, 10, 11, 10, 10, 11]) }, { pressKey: 'press14', samples: numeric([100, 101, 100, 101, 100, 101]) }] })
    assert.deepEqual(observations.map(({ pressKey }) => pressKey), ['press10', 'press14']); assert.notEqual(observations[0]!.metrics.pressMedian, observations[1]!.metrics.pressMedian); assert.ok(observations.every(({ variableIds }) => variableIds[0] === 'machine.speed.actual'))
  })

  it('downgrades inadequate coverage, sparse windows, and stable numeric noise', () => {
    const baseline = analytics.baselineDeviation({ pressKey: 'press14', range: { start: at(5), end: at(10) }, comparisonRange: { start: at(0), end: at(5) }, currentCoveragePercent: 79.9, comparisonCoveragePercent: 100, metrics: [{ metricId: 'radius.interruptions', label: 'Interruptions', unit: 'count', current: 20, baseline: 1, materialDelta: 3, currentFactId: 'current', baselineFactId: 'baseline', deltaFactId: 'delta' }] })[0]!
    assert.equal(baseline.support.adequate, false); assert.equal(baseline.material, false)
    const sparse = analytics.eventAlignedNumeric({ pressKey: 'press14', variableId: 'machine.speed.actual', range: { start: at(0), end: at(5) }, event: { id: 'event', start: at(2), end: at(3) }, contextMinutes: 2, samples: numeric([1, 1, 9, 9, 1, 1]) })!
    assert.equal(sparse.support.adequate, false); assert.equal(sparse.material, false)
    const stable = analytics.robustNumericChange({ pressKey: 'press14', variableId: 'machine.speed.actual', range: { start: at(0), end: at(5) }, samples: numeric([50, 50, 50, 50, 50, 50]) })!
    assert.equal(stable.support.adequate, true); assert.equal(stable.material, false)
  })
})
