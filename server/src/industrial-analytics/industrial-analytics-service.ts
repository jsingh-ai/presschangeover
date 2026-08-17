import { createHash } from 'node:crypto'
import type { RadiusPressKey } from '../radius/models.js'
import { detectValueChangeEvents } from '../telemetry-event-explorer/telemetry-event-engine.js'
import type { IndustrialAnalyticalObservation, IndustrialBaselineMetricInput, IndustrialNumericSample, IndustrialNumericStats, IndustrialRelationshipResult, IndustrialSequenceEpisode, IndustrialStateSample } from './contracts.js'

export const INDUSTRIAL_ANALYTICS_RULES = {
  minimumBaselineCoveragePercent: 80,
  minimumNumericSamples: 5,
  minimumWindowSamples: 3,
  minimumRelationshipPairs: 8,
  minimumComparableSequences: 3,
  minimumCrossPressSeries: 2,
  minimumVariance: 1e-9,
  eventContextMinutes: 20,
  maximumLagMinutes: 10,
  lagStepMinutes: 1,
  alignmentToleranceMs: 45_000,
} as const

function round(value: number, digits = 3): number { const factor = 10 ** digits; return Math.round(value * factor) / factor }
function median(values: number[]): number { const sorted = [...values].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2 }
function mean(values: number[]): number { return values.reduce((sum, value) => sum + value, 0) / values.length }
function deviation(values: number[]): number { const average = mean(values); return Math.sqrt(mean(values.map((value) => (value - average) ** 2))) }
function usableQuality(qualityState?: string): boolean { return !/BAD|INVALID|UNAVAILABLE|NO_DATA|NODATA/i.test(qualityState ?? '') }
function observationId(parts: unknown[]): string { return `industrial.${createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 14)}` }
function validRange(range: { start: string; end: string }): boolean { return Number.isFinite(Date.parse(range.start)) && Number.isFinite(Date.parse(range.end)) && Date.parse(range.end) > Date.parse(range.start) }
function numericSamples(input: IndustrialNumericSample[], range?: { start: string; end: string }): IndustrialNumericSample[] {
  const from = range ? Date.parse(range.start) : -Infinity; const to = range ? Date.parse(range.end) : Infinity
  const values = input.filter((item) => Number.isFinite(Date.parse(item.atUtc)) && Number.isFinite(item.value) && usableQuality(item.qualityState) && Date.parse(item.atUtc) >= from && Date.parse(item.atUtc) <= to).sort((a, b) => Date.parse(a.atUtc) - Date.parse(b.atUtc))
  const unique = new Map<number, IndustrialNumericSample>(); for (const value of values) unique.set(Date.parse(value.atUtc), value)
  return [...unique.values()]
}
function spanCoverage(samples: IndustrialNumericSample[], range: { start: string; end: string }): number {
  if (samples.length < 2 || !validRange(range)) return 0
  return round(Math.min(100, Math.max(0, (Date.parse(samples.at(-1)!.atUtc) - Date.parse(samples[0]!.atUtc)) / (Date.parse(range.end) - Date.parse(range.start)) * 100)), 1)
}

export function describeIndustrialNumeric(input: IndustrialNumericSample[]): IndustrialNumericStats | null {
  const samples = numericSamples(input); if (!samples.length) return null
  const values = samples.map(({ value }) => value); const deltas = values.slice(1).map((value, index) => value - values[index]!)
  const x = samples.map(({ atUtc }) => (Date.parse(atUtc) - Date.parse(samples[0]!.atUtc)) / 60_000); const xMean = mean(x); const yMean = mean(values)
  const denominator = x.reduce((sum, value) => sum + (value - xMean) ** 2, 0); const slope = denominator > 0 ? x.reduce((sum, value, index) => sum + (value - xMean) * (values[index]! - yMean), 0) / denominator : 0
  const valueMedian = median(values); const mad = values.length >= INDUSTRIAL_ANALYTICS_RULES.minimumNumericSamples ? median(values.map((value) => Math.abs(value - valueMedian))) : null
  const largestDelta = deltas.length ? deltas.reduce((best, value) => Math.abs(value) > Math.abs(best) ? value : best, deltas[0]!) : 0
  return { count: values.length, minimum: round(Math.min(...values)), maximum: round(Math.max(...values)), median: round(valueMedian), mean: round(yMean), range: round(Math.max(...values) - Math.min(...values)), standardDeviation: round(deviation(values)), mad: mad === null ? null : round(mad), startEndDelta: round(values.at(-1)! - values[0]!), largestDelta: round(largestDelta), slopePerMinute: round(slope), volatility: round(deltas.length ? mean(deltas.map(Math.abs)) : 0) }
}

function ranks(values: number[]): number[] {
  const ordered = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value); const result = new Array<number>(values.length)
  for (let start = 0; start < ordered.length;) { let end = start + 1; while (end < ordered.length && ordered[end]!.value === ordered[start]!.value) end += 1; const rank = (start + end - 1) / 2 + 1; for (let index = start; index < end; index += 1) result[ordered[index]!.index] = rank; start = end }
  return result
}
function correlation(left: number[], right: number[]): number | null {
  if (left.length !== right.length || left.length < 2 || deviation(left) < INDUSTRIAL_ANALYTICS_RULES.minimumVariance || deviation(right) < INDUSTRIAL_ANALYTICS_RULES.minimumVariance) return null
  const leftMean = mean(left); const rightMean = mean(right); const numerator = left.reduce((sum, value, index) => sum + (value - leftMean) * (right[index]! - rightMean), 0)
  const denominator = Math.sqrt(left.reduce((sum, value) => sum + (value - leftMean) ** 2, 0) * right.reduce((sum, value) => sum + (value - rightMean) ** 2, 0))
  return denominator > 0 ? round(numerator / denominator) : null
}
function align(leftInput: IndustrialNumericSample[], rightInput: IndustrialNumericSample[], lagMs: number, toleranceMs: number) {
  const left = numericSamples(leftInput); const right = numericSamples(rightInput); const used = new Set<number>(); const pairs: Array<[number, number]> = []
  for (const item of left) {
    const target = Date.parse(item.atUtc) + lagMs; let bestIndex = -1; let bestDistance = Infinity
    right.forEach((candidate, index) => { const distance = Math.abs(Date.parse(candidate.atUtc) - target); if (!used.has(index) && distance <= toleranceMs && distance < bestDistance) { bestIndex = index; bestDistance = distance } })
    if (bestIndex >= 0) { used.add(bestIndex); pairs.push([item.value, right[bestIndex]!.value]) }
  }
  return pairs
}

export class IndustrialAnalyticsService {
  baselineDeviation(input: { pressKey: RadiusPressKey; range: { start: string; end: string }; comparisonRange: { start: string; end: string }; currentCoveragePercent: number; comparisonCoveragePercent: number; metrics: IndustrialBaselineMetricInput[] }): IndustrialAnalyticalObservation[] {
    const adequate = input.currentCoveragePercent >= INDUSTRIAL_ANALYTICS_RULES.minimumBaselineCoveragePercent && input.comparisonCoveragePercent >= INDUSTRIAL_ANALYTICS_RULES.minimumBaselineCoveragePercent
    return input.metrics.flatMap((metric) => {
      if (metric.current === null || metric.baseline === null) return []
      const delta = round(metric.current - metric.baseline); const magnitude = Math.abs(delta); const material = adequate && magnitude >= metric.materialDelta
      return [{ observationId: observationId(['baseline', input.pressKey, metric.metricId, input.range, input.comparisonRange]), family: 'baseline_deviation', pressKey: input.pressKey, deckNumber: null, range: input.range, comparisonRange: input.comparisonRange, eventId: null, variableIds: [metric.metricId], factIds: [metric.currentFactId, metric.baselineFactId, metric.deltaFactId], metrics: { label: metric.label, unit: metric.unit, current: round(metric.current), baseline: round(metric.baseline), delta, magnitude }, support: { sampleCount: metric.sampleCount ?? 1, comparisonSampleCount: metric.comparisonSampleCount ?? 1, coveragePercent: input.currentCoveragePercent, comparisonCoveragePercent: input.comparisonCoveragePercent, adequate, minimumRequired: INDUSTRIAL_ANALYTICS_RULES.minimumBaselineCoveragePercent, reason: adequate ? null : 'Current and comparison coverage must both be at least 80%.' }, evidenceSource: 'comparison', magnitudeInputs: { absoluteDelta: magnitude, materialThreshold: metric.materialDelta }, material, limitations: material ? [] : adequate ? ['Observed change is below the configured material-change threshold.'] : ['Insufficient current or comparison coverage.'], explorer: { href: `/overview?press=${input.pressKey}`, label: 'Open press overview' } } satisfies IndustrialAnalyticalObservation]
    })
  }

  robustNumericChange(input: { pressKey: RadiusPressKey; variableId: string; deckNumber?: number | null; unit?: string | null; range: { start: string; end: string }; samples: IndustrialNumericSample[]; eventId?: string | null }): IndustrialAnalyticalObservation | null {
    const samples = numericSamples(input.samples, input.range); const stats = describeIndustrialNumeric(samples); if (!stats) return null
    const adequate = stats.count >= INDUSTRIAL_ANALYTICS_RULES.minimumNumericSamples; const scale = Math.max(stats.mad ?? 0, stats.range * .1, Math.abs(stats.median) * .02, INDUSTRIAL_ANALYTICS_RULES.minimumVariance); const magnitude = Math.max(Math.abs(stats.startEndDelta), Math.abs(stats.largestDelta), stats.standardDeviation) / scale
    return { observationId: observationId(['numeric', input.pressKey, input.variableId, input.deckNumber ?? null, input.range, input.eventId ?? null]), family: 'robust_numeric_change', pressKey: input.pressKey, deckNumber: input.deckNumber ?? null, range: input.range, comparisonRange: null, eventId: input.eventId ?? null, variableIds: [input.variableId], factIds: [], metrics: { unit: input.unit ?? null, ...stats }, support: { sampleCount: stats.count, comparisonSampleCount: null, coveragePercent: spanCoverage(samples, input.range), comparisonCoveragePercent: null, adequate, minimumRequired: INDUSTRIAL_ANALYTICS_RULES.minimumNumericSamples, reason: adequate ? null : 'At least five usable numeric observations are required.' }, evidenceSource: 'telemetry', magnitudeInputs: { robustMagnitude: round(magnitude), scale: round(scale) }, material: adequate && magnitude >= 2, limitations: adequate ? [] : ['Insufficient numeric sample support.'], explorer: { href: `/telemetry-event-explorer?press=${input.pressKey}`, label: 'Open telemetry evidence' } }
  }

  eventAlignedNumeric(input: { pressKey: RadiusPressKey; variableId: string; deckNumber?: number | null; unit?: string | null; range: { start: string; end: string }; event: { id: string; start: string; end: string }; samples: IndustrialNumericSample[]; contextMinutes?: number }): IndustrialAnalyticalObservation | null {
    const contextMs = (input.contextMinutes ?? INDUSTRIAL_ANALYTICS_RULES.eventContextMinutes) * 60_000; const eventStart = Date.parse(input.event.start); const eventEnd = Date.parse(input.event.end); const range = { start: new Date(eventStart - contextMs).toISOString(), end: new Date(eventEnd + contextMs).toISOString() }
    const phase = (start: number, end: number, includeEnd = false) => describeIndustrialNumeric(numericSamples(input.samples, { start: new Date(start).toISOString(), end: new Date(end).toISOString() }).filter((sample) => includeEnd || Date.parse(sample.atUtc) < end))
    const before = phase(eventStart - contextMs, eventStart); const during = phase(eventStart, eventEnd); const after = phase(eventEnd, eventEnd + contextMs, true); if (!before && !during && !after) return null
    const adequate = Boolean(before && during && after && before.count >= INDUSTRIAL_ANALYTICS_RULES.minimumWindowSamples && during.count >= INDUSTRIAL_ANALYTICS_RULES.minimumWindowSamples && after.count >= INDUSTRIAL_ANALYTICS_RULES.minimumWindowSamples)
    const beforeToEvent = before && during ? round(during.median - before.median) : null; const eventToAfter = during && after ? round(after.median - during.median) : null; const scale = Math.max(before?.mad ?? 0, before?.range ?? 0, Math.abs(before?.median ?? 0) * .02, INDUSTRIAL_ANALYTICS_RULES.minimumVariance); const magnitude = beforeToEvent === null ? 0 : Math.abs(beforeToEvent) / scale
    return { observationId: observationId(['event', input.pressKey, input.variableId, input.deckNumber ?? null, input.event]), family: 'event_aligned_change', pressKey: input.pressKey, deckNumber: input.deckNumber ?? null, range, comparisonRange: null, eventId: input.event.id, variableIds: [input.variableId], factIds: [], metrics: { unit: input.unit ?? null, beforeMedian: before?.median ?? null, eventMedian: during?.median ?? null, afterMedian: after?.median ?? null, beforeToEventDelta: beforeToEvent, eventToAfterDelta: eventToAfter, eventMinimum: during?.minimum ?? null, eventMaximum: during?.maximum ?? null, eventSlopePerMinute: during?.slopePerMinute ?? null, eventVolatility: during?.volatility ?? null }, support: { sampleCount: (before?.count ?? 0) + (during?.count ?? 0) + (after?.count ?? 0), comparisonSampleCount: before?.count ?? 0, coveragePercent: spanCoverage(numericSamples(input.samples, range), range), comparisonCoveragePercent: null, adequate, minimumRequired: INDUSTRIAL_ANALYTICS_RULES.minimumWindowSamples, reason: adequate ? null : 'Before, event, and after windows each require at least three observations.' }, evidenceSource: 'telemetry', magnitudeInputs: { robustMagnitude: round(magnitude), baselineScale: round(scale) }, material: adequate && magnitude >= 2, limitations: adequate ? [] : ['Insufficient before/event/after support.'], explorer: { href: `/telemetry-event-explorer?press=${input.pressKey}`, label: 'Open event-aligned telemetry' } }
  }

  valueTransitions(input: { pressKey: RadiusPressKey; variableId: string; deckNumber?: number | null; range: { start: string; end: string }; samples: IndustrialStateSample[]; event?: { id: string; start: string; end: string } | null }): IndustrialAnalyticalObservation {
    const transitions = detectValueChangeEvents({ observations: input.samples, fromUtc: input.range.start, toUtc: input.range.end, rule: { match: 'any' } }); const intervals = transitions.slice(1).map((item, index) => (Date.parse(item.transitionAtUtc) - Date.parse(transitions[index]!.transitionAtUtc)) / 60_000); const nearEvent = input.event ? transitions.filter((item) => Date.parse(item.transitionAtUtc) >= Date.parse(input.event!.start) - 20 * 60_000 && Date.parse(item.transitionAtUtc) <= Date.parse(input.event!.end) + 20 * 60_000).length : 0
    const adequate = input.samples.length >= 2; return { observationId: observationId(['transition', input.pressKey, input.variableId, input.deckNumber ?? null, input.range, input.event?.id ?? null]), family: 'value_state_transition', pressKey: input.pressKey, deckNumber: input.deckNumber ?? null, range: input.range, comparisonRange: null, eventId: input.event?.id ?? null, variableIds: [input.variableId], factIds: [], metrics: { transitionCount: transitions.length, repeatedTransitionCount: Math.max(0, transitions.length - new Set(transitions.map((item) => `${String(item.previousValue)}>${String(item.newValue)}`)).size), medianMinutesBetweenTransitions: intervals.length ? round(median(intervals)) : null, transitionsNearEvent: nearEvent, stateBefore: transitions[0]?.previousValue ?? input.samples[0]?.value ?? null, stateAfter: transitions.at(-1)?.newValue ?? input.samples.at(-1)?.value ?? null }, support: { sampleCount: input.samples.length, comparisonSampleCount: null, coveragePercent: null, comparisonCoveragePercent: null, adequate, minimumRequired: 2, reason: adequate ? null : 'At least two state observations are required.' }, evidenceSource: input.variableId.startsWith('production.') ? 'production_context' : 'telemetry', magnitudeInputs: { transitionCount: transitions.length, transitionsNearEvent: nearEvent }, material: adequate && (nearEvent > 0 || transitions.length >= 2), limitations: adequate ? [] : ['Insufficient state observations.'], explorer: { href: `/telemetry-event-explorer?press=${input.pressKey}`, label: 'Open transition evidence' } }
  }

  sequenceDeviation(input: { pressKey: RadiusPressKey; range: { start: string; end: string }; occurrence: IndustrialSequenceEpisode; comparable: IndustrialSequenceEpisode[] }): IndustrialAnalyticalObservation {
    const cohort = input.comparable.filter(({ episodeId }) => episodeId !== input.occurrence.episodeId)
    const counts = new Map<string, { count: number; states: string[] }>(); for (const episode of cohort) { const states = episode.orderedStates.map(({ state }) => state); const key = states.join('>'); const prior = counts.get(key); counts.set(key, { count: (prior?.count ?? 0) + 1, states }) }
    const commonEntry = [...counts.entries()].sort(([leftKey, left], [rightKey, right]) => right.count - left.count || leftKey.localeCompare(rightKey))[0]?.[1]
    const common = commonEntry?.states ?? []; const commonCount = commonEntry?.count ?? 0; const actual = input.occurrence.orderedStates.map(({ state }) => state); const adequate = cohort.length >= INDUSTRIAL_ANALYTICS_RULES.minimumComparableSequences && commonCount >= 2
    const commonCounts = new Map<string, number>(); const actualCounts = new Map<string, number>(); common.forEach((state) => commonCounts.set(state, (commonCounts.get(state) ?? 0) + 1)); actual.forEach((state) => actualCounts.set(state, (actualCounts.get(state) ?? 0) + 1))
    const extra = [...actualCounts].flatMap(([state, count]) => Array.from({ length: Math.max(0, count - (commonCounts.get(state) ?? 0)) }, () => state)); const missing = [...commonCounts].flatMap(([state, count]) => Array.from({ length: Math.max(0, count - (actualCounts.get(state) ?? 0)) }, () => state)); const repeated = actual.filter((state, index) => index > 0 && state === actual[index - 1]); const loops = actual.filter((state, index) => index > 1 && actual.slice(0, index - 1).includes(state)); const longest = input.occurrence.orderedStates.reduce((best, item) => item.durationSeconds > best.durationSeconds ? item : best, input.occurrence.orderedStates[0] ?? { state: '', durationSeconds: 0 })
    const variation = common.join('>') !== actual.join('>'); return { observationId: observationId(['sequence', input.pressKey, input.occurrence.episodeId]), family: 'radius_sequence_deviation', pressKey: input.pressKey, deckNumber: null, range: { start: input.occurrence.startUtc, end: input.occurrence.endUtc }, comparisonRange: input.range, eventId: input.occurrence.episodeId, variableIds: ['radius.sequence'], factIds: [], metrics: { commonSequence: common.join(' → '), commonSequenceCount: commonCount, commonSequenceSharePercent: cohort.length ? round(commonCount / cohort.length * 100, 1) : 0, actualSequence: actual.join(' → '), repeatedStates: [...new Set(repeated)].join(', '), loopStates: [...new Set(loops)].join(', '), extraStates: extra.join(', '), missingStates: missing.join(', '), extraStepCount: extra.length, missingStepCount: missing.length, loopCount: loops.length, longestDwellState: longest.state || null, longestDwellMinutes: round(longest.durationSeconds / 60, 1), returnAttempts: input.occurrence.returnAttempts }, support: { sampleCount: actual.length, comparisonSampleCount: cohort.length, coveragePercent: null, comparisonCoveragePercent: null, adequate, minimumRequired: INDUSTRIAL_ANALYTICS_RULES.minimumComparableSequences, reason: adequate ? null : cohort.length < INDUSTRIAL_ANALYTICS_RULES.minimumComparableSequences ? 'At least three other comparable episodes are required.' : 'The modal comparison sequence requires at least two supporting episodes.' }, evidenceSource: 'radius', magnitudeInputs: { extraStepCount: extra.length, missingStepCount: missing.length, loopCount: loops.length, returnAttempts: input.occurrence.returnAttempts }, material: adequate && variation && (extra.length > 0 || missing.length > 0 || loops.length > 0 || input.occurrence.returnAttempts > 1), limitations: adequate ? [] : ['Insufficient comparable sequence support.'], explorer: { href: `/operational-analysis?press=${input.pressKey}`, label: 'Open Radius sequence evidence' } }
  }

  numericRelationship(input: { pressKey: RadiusPressKey; leftVariableId: string; rightVariableId: string; range: { start: string; end: string }; left: IndustrialNumericSample[]; right: IndustrialNumericSample[]; context?: string; minimumPairs?: number; maximumLagMinutes?: number; lagStepMinutes?: number; alignmentToleranceMs?: number }): IndustrialRelationshipResult | null {
    const minimum = input.minimumPairs ?? INDUSTRIAL_ANALYTICS_RULES.minimumRelationshipPairs; const tolerance = input.alignmentToleranceMs ?? INDUSTRIAL_ANALYTICS_RULES.alignmentToleranceMs; const base = align(input.left, input.right, 0, tolerance); if (base.length < minimum) return null
    const pearson = correlation(base.map(([left]) => left), base.map(([, right]) => right)); const spearman = correlation(ranks(base.map(([left]) => left)), ranks(base.map(([, right]) => right))); if (pearson === null || spearman === null) return null
    let best = { lag: 0, correlation: pearson, count: base.length }; const maximumLag = input.maximumLagMinutes ?? INDUSTRIAL_ANALYTICS_RULES.maximumLagMinutes; const lagStep = input.lagStepMinutes ?? INDUSTRIAL_ANALYTICS_RULES.lagStepMinutes
    for (let lag = -maximumLag; lag <= maximumLag; lag += lagStep) { const pairs = align(input.left, input.right, lag * 60_000, tolerance); if (pairs.length < minimum) continue; const value = correlation(pairs.map(([left]) => left), pairs.map(([, right]) => right)); if (value !== null && (Math.abs(value) > Math.abs(best.correlation) + 1e-9 || Math.abs(value) === Math.abs(best.correlation) && Math.abs(lag) < Math.abs(best.lag))) best = { lag, correlation: value, count: pairs.length } }
    return { pearson, spearman, bestLagMinutes: best.lag, bestLagCorrelation: best.correlation, sampleCount: best.count, coveragePercent: round(best.count / Math.max(input.left.length, input.right.length) * 100, 1) }
  }

  relationshipObservation(input: Parameters<IndustrialAnalyticsService['numericRelationship']>[0]): IndustrialAnalyticalObservation | null {
    const result = this.numericRelationship(input); if (!result) return null; const strong = Math.abs(result.bestLagCorrelation) >= .7
    return { observationId: observationId(['relationship', input.pressKey, input.leftVariableId, input.rightVariableId, input.range, input.context ?? 'overall']), family: 'numeric_relationship', pressKey: input.pressKey, deckNumber: null, range: input.range, comparisonRange: null, eventId: null, variableIds: [input.leftVariableId, input.rightVariableId], factIds: [], metrics: { context: input.context ?? 'overall', pearson: result.pearson, spearman: result.spearman, bestLagMinutes: result.bestLagMinutes, bestLagCorrelation: result.bestLagCorrelation, direction: result.bestLagMinutes > 0 ? `${input.leftVariableId} leads ${input.rightVariableId}` : result.bestLagMinutes < 0 ? `${input.rightVariableId} leads ${input.leftVariableId}` : 'no detected lead' }, support: { sampleCount: result.sampleCount, comparisonSampleCount: null, coveragePercent: result.coveragePercent, comparisonCoveragePercent: null, adequate: true, minimumRequired: input.minimumPairs ?? INDUSTRIAL_ANALYTICS_RULES.minimumRelationshipPairs, reason: null }, evidenceSource: 'telemetry', magnitudeInputs: { absoluteCorrelation: Math.abs(result.bestLagCorrelation), lagMinutes: result.bestLagMinutes }, material: strong, limitations: ['Correlation is association evidence and does not establish causation.'], explorer: { href: `/telemetry-event-explorer?press=${input.pressKey}`, label: 'Open relationship evidence' } }
  }

  crossPressComparison(input: { canonicalId: string; range: { start: string; end: string }; series: Array<{ pressKey: RadiusPressKey; samples: IndustrialNumericSample[] }> }): IndustrialAnalyticalObservation[] {
    const supported = input.series.flatMap((item) => { const stats = describeIndustrialNumeric(numericSamples(item.samples, input.range)); return stats && stats.count >= INDUSTRIAL_ANALYTICS_RULES.minimumNumericSamples ? [{ ...item, stats }] : [] })
    if (supported.length < INDUSTRIAL_ANALYTICS_RULES.minimumCrossPressSeries) return []
    const fleetMedian = median(supported.map(({ stats }) => stats.median))
    return supported.map(({ pressKey, stats, samples }) => {
      const delta = round(stats.median - fleetMedian)
      return {
        observationId: observationId(['cross-press', input.canonicalId, pressKey, input.range]),
        family: 'cross_press_comparison',
        pressKey,
        deckNumber: null,
        range: input.range,
        comparisonRange: input.range,
        eventId: null,
        variableIds: [input.canonicalId],
        factIds: [],
        metrics: { pressMedian: stats.median, compatiblePressMedian: round(fleetMedian), delta, slopePerMinute: stats.slopePerMinute, volatility: stats.volatility },
        support: { sampleCount: stats.count, comparisonSampleCount: supported.length - 1, coveragePercent: spanCoverage(samples, input.range), comparisonCoveragePercent: null, adequate: true, minimumRequired: INDUSTRIAL_ANALYTICS_RULES.minimumCrossPressSeries, reason: null },
        evidenceSource: 'comparison',
        magnitudeInputs: { absoluteMedianDelta: Math.abs(delta) },
        material: Math.abs(delta) >= Math.max(Math.abs(fleetMedian) * .2, stats.mad ?? 0, INDUSTRIAL_ANALYTICS_RULES.minimumVariance),
        limitations: ['Compared only through the same trusted canonical concept; press series remained independent.'],
        explorer: { href: `/overview?press=${pressKey}`, label: 'Open compatible-press evidence' },
      } satisfies IndustrialAnalyticalObservation
    })
  }

  crossPressSummaryComparison(input: { canonicalId: string; unit?: string | null; range: { start: string; end: string }; values: Array<{ pressKey: RadiusPressKey; value: number | null; supportCount: number; coveragePercent: number | null; factId: string }> }): IndustrialAnalyticalObservation[] {
    const supported = input.values.filter((item): item is typeof item & { value: number; coveragePercent: number } => item.value !== null && item.coveragePercent !== null && item.coveragePercent >= INDUSTRIAL_ANALYTICS_RULES.minimumBaselineCoveragePercent)
    if (supported.length < INDUSTRIAL_ANALYTICS_RULES.minimumCrossPressSeries) return []
    const compatibleMedian = median(supported.map(({ value }) => value))
    const deviations = supported.map(({ value }) => Math.abs(value - compatibleMedian))
    const materialThreshold = Math.max(median(deviations) * 2, Math.abs(compatibleMedian) * .2, INDUSTRIAL_ANALYTICS_RULES.minimumVariance)
    return supported.map((item) => {
      const delta = round(item.value - compatibleMedian)
      return {
        observationId: observationId(['cross-press-summary', input.canonicalId, item.pressKey, input.range]),
        family: 'cross_press_comparison',
        pressKey: item.pressKey,
        deckNumber: null,
        range: input.range,
        comparisonRange: input.range,
        eventId: null,
        variableIds: [input.canonicalId],
        factIds: [item.factId],
        metrics: { unit: input.unit ?? null, pressValue: round(item.value), compatiblePressMedian: round(compatibleMedian), delta },
        support: { sampleCount: item.supportCount, comparisonSampleCount: supported.length - 1, coveragePercent: item.coveragePercent, comparisonCoveragePercent: null, adequate: true, minimumRequired: INDUSTRIAL_ANALYTICS_RULES.minimumCrossPressSeries, reason: null },
        evidenceSource: 'comparison',
        magnitudeInputs: { absoluteDelta: Math.abs(delta), materialThreshold: round(materialThreshold) },
        material: Math.abs(delta) >= materialThreshold,
        limitations: ['Compared only through the same deterministic Radius metric and time range; press records remained independent.'],
        explorer: { href: `/overview?press=${item.pressKey}`, label: 'Open compatible-press evidence' },
      } satisfies IndustrialAnalyticalObservation
    })
  }
}
