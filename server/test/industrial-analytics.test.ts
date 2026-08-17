import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { describeIndustrialNumeric, IndustrialAnalyticsService, INDUSTRIAL_ANALYTICS_RULES } from '../src/industrial-analytics/industrial-analytics-service.js'

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

  it('rejects constant signals instead of emitting misleading correlation', () => {
    assert.equal(analytics.numericRelationship({ pressKey: 'press14', leftVariableId: 'a', rightVariableId: 'constant', range: { start: at(0), end: at(9) }, left: numeric([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), right: numeric(Array(10).fill(4)) }), null)
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

  it('describes repeated and extra Radius sequence steps with adequate support', () => {
    const episode = (id: string, states: string[]) => ({ episodeId: id, startUtc: at(0), endUtc: at(5), orderedStates: states.map((state) => ({ state, durationSeconds: 60 })), returnAttempts: 1 })
    const observation = analytics.sequenceDeviation({ pressKey: 'press14', range: { start: at(0), end: at(10) }, occurrence: episode('test', ['A', 'B', 'B', 'D', 'C']), comparable: [episode('one', ['A', 'B', 'C']), episode('two', ['A', 'B', 'C']), episode('three', ['A', 'B', 'C'])] })
    assert.equal(observation.support.minimumRequired, INDUSTRIAL_ANALYTICS_RULES.minimumComparableSequences); assert.equal(observation.support.adequate, true); assert.equal(observation.metrics.repeatedStates, 'B'); assert.equal(observation.metrics.extraStates, 'B, D'); assert.equal(observation.material, true)
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
