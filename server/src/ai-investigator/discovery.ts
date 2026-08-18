import { createHash } from 'node:crypto'
import type { RadiusPressKey } from '../radius/models.js'
import { IndustrialAnalyticsService } from '../industrial-analytics/industrial-analytics-service.js'
import type { IndustrialAnalyticalObservation, IndustrialBaselineMetricInput } from '../industrial-analytics/contracts.js'
import type { AiGroundingFact, AiInvestigatorDiscoveryDraftContent, AiInvestigatorDraftContent, AiInvestigatorRequest } from './contracts.js'
import type { AiInvestigatorToolExecutor, AiToolResult } from './read-only-tools.js'

export const DISCOVERY_CANDIDATE_LIMIT = 5
export const DISCOVERY_EVENT_LIMIT = 3
export const DISCOVERY_OUTPUT_TOKENS = 1_400
export const DISCOVERY_SELECTED_PRESS_LIMIT = 3
export const DISCOVERY_OBSERVATION_LIMIT_PER_CANDIDATE = 3
export const DISCOVERY_PROMPT_CACHE_KEY = 'processintelligence-discovery-v1'
export const DISCOVERY_INSTRUCTIONS = `You are the advisory ProcessIntelligence AI Investigator. Rank only supplied deterministic candidate ids. Return only model judgment: candidateId, title, importance, confidence, supplied factIds, interpretation, whyWorthInvestigating, recommendedInvestigation, plus the overall summary and limitations. ProcessIntelligence reconstructs all values, units, timestamps, evidence classes, links, and tables. All supplied facts are authoritative; never reproduce, compute, invent, recalculate, or contradict their values. For material comparisons select the supplied current, baseline, and delta ids together. Treat low support or coverage as limitations. Radius states and associations are investigation leads, not proven causes. Return at most one finding per candidate and no more than five total. Do not claim control, database, historian, filesystem, network, configuration, acknowledgement, or root-cause access. No HTML.`

interface FleetRow {
  pressKey: RadiusPressKey
  press: string
  coveragePercent: number | null
  productionPercent: number | null
  productionInterruptions: number
  longestInterruptionMinutes: number | null
  leadingRadiusStates: FleetDriver[]
}

interface FleetDriver { eventType: string; statusCode: string | null; statusDescription: string; durationMinutes: number | null; occurrences: number }

export interface DiscoveryCandidate {
  pressKey: RadiusPressKey
  press: string
  signalCount: number
  productionDelta: number | null
  interruptionDelta: number
  longestDelta: number | null
  observations: IndustrialAnalyticalObservation[]
  facts: AiGroundingFact[]
}

export interface DiscoveryPreflight {
  evidence: Array<{ name: string; arguments: unknown; result: AiToolResult; durationMs: number }>
  facts: AiGroundingFact[]
  candidates: DiscoveryCandidate[]
  eligiblePresses: RadiusPressKey[]
  excludedPresses: RadiusPressKey[]
  limitations: string[]
  analytics: { calculated: number; retained: number; grouped: number; modelCandidates: number; calculationMs: number }
  performance: { dataServiceQueries: number; preflightMs: number }
  modelInput: Record<string, unknown>
}

function round(value: number): number { return Math.round(value * 10) / 10 }
function numberOrNull(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) ? value : null }
function rows(result: AiToolResult): FleetRow[] {
  if (!Array.isArray(result.presses)) return []
  return result.presses.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return []
    const row = raw as Record<string, unknown>
    if (typeof row.pressKey !== 'string' || typeof row.press !== 'string' || typeof row.productionInterruptions !== 'number') return []
    const leadingRadiusStates = Array.isArray(row.leadingRadiusStates) ? row.leadingRadiusStates.flatMap((value) => {
      if (!value || typeof value !== 'object') return []
      const driver = value as Record<string, unknown>
      if (typeof driver.eventType !== 'string' || typeof driver.statusDescription !== 'string' || typeof driver.occurrences !== 'number') return []
      return [{ eventType: driver.eventType, statusCode: typeof driver.statusCode === 'string' ? driver.statusCode : null, statusDescription: driver.statusDescription, durationMinutes: numberOrNull(driver.durationMinutes), occurrences: driver.occurrences }]
    }) : []
    return [{ pressKey: row.pressKey as RadiusPressKey, press: row.press, coveragePercent: numberOrNull(row.coveragePercent), productionPercent: numberOrNull(row.productionPercent), productionInterruptions: row.productionInterruptions, longestInterruptionMinutes: numberOrNull(row.longestInterruptionMinutes), leadingRadiusStates }]
  })
}

function facts(result: AiToolResult): AiGroundingFact[] {
  return Array.isArray(result.facts) ? result.facts.filter((item): item is AiGroundingFact => Boolean(item) && typeof item === 'object' && typeof (item as AiGroundingFact).factId === 'string') : []
}

function baselineFact(fact: AiGroundingFact, range: { start: string; end: string }): AiGroundingFact {
  return { ...fact, factId: fact.factId.replace(/\.current$/, '.baseline'), role: 'baseline', range }
}

function deltaFact(current: FleetRow, metric: 'production' | 'interruptions' | 'longest', value: number | null, range: { start: string; end: string }): AiGroundingFact {
  const attributes = metric === 'production'
    ? ['productionPercentagePointDelta', 'percentage_points', 'Production time change', 'production_percent.delta']
    : metric === 'interruptions'
      ? ['interruptionDelta', 'count', 'Interruption change', 'interruptions.delta']
      : ['longestInterruptionDeltaMinutes', 'minutes', 'Longest interruption change', 'longest_interruption_minutes.delta']
  return { factId: `${current.pressKey}.${attributes[3]}`, pressKey: current.pressKey, press: current.press, source: 'comparison', metric: attributes[0], value, unit: attributes[1], role: 'delta', usable: value !== null, label: attributes[2], range }
}

function driverIdentity(driver: FleetDriver): string { return createHash('sha256').update(`${driver.eventType}\u0000${driver.statusCode ?? ''}\u0000${driver.statusDescription}`).digest('hex').slice(0, 10) }

function driverComparisons(row: FleetRow, previous: FleetRow, currentRange: { start: string; end: string }, baselineRange: { start: string; end: string }): { facts: AiGroundingFact[]; metrics: IndustrialBaselineMetricInput[] } {
  const previousById = new Map(previous.leadingRadiusStates.map((driver) => [driverIdentity(driver), driver]))
  const resultFacts: AiGroundingFact[] = []
  const metrics: IndustrialBaselineMetricInput[] = []
  for (const driver of row.leadingRadiusStates.slice(0, 3)) {
    const id = driverIdentity(driver); const baseline = previousById.get(id); if (!baseline) continue
    const label = `${driver.eventType} / ${driver.statusCode ?? '—'} / ${driver.statusDescription}`
    const baseId = `${row.pressKey}.radius_driver.${id}`
    if (driver.durationMinutes !== null && baseline.durationMinutes !== null) {
      const delta = round(driver.durationMinutes - baseline.durationMinutes)
      const deltaId = `${baseId}.duration_minutes.delta`
      resultFacts.push({ factId: deltaId, pressKey: row.pressKey, press: row.press, source: 'comparison', metric: 'radiusDriverDurationDeltaMinutes', value: delta, unit: 'minutes', role: 'delta', usable: true, label: `${label} duration change`, range: currentRange })
      metrics.push({ metricId: `radius.driver.${id}.duration`, label: `${label} duration`, unit: 'minutes', current: driver.durationMinutes, baseline: baseline.durationMinutes, materialDelta: 30, currentFactId: `${baseId}.duration_minutes.current`, baselineFactId: `${baseId}.duration_minutes.baseline`, deltaFactId: deltaId })
    }
    const currentId = `${baseId}.occurrences.current`; const baselineId = `${baseId}.occurrences.baseline`; const deltaId = `${baseId}.occurrences.delta`; const delta = driver.occurrences - baseline.occurrences
    resultFacts.push(
      { factId: currentId, pressKey: row.pressKey, press: row.press, source: 'radius', metric: 'radiusDriverOccurrences', value: driver.occurrences, unit: 'count', role: 'current', usable: true, label: `${label} occurrences`, range: currentRange },
      { factId: baselineId, pressKey: row.pressKey, press: row.press, source: 'radius', metric: 'radiusDriverOccurrences', value: baseline.occurrences, unit: 'count', role: 'baseline', usable: true, label: `${label} occurrences`, range: baselineRange },
      { factId: deltaId, pressKey: row.pressKey, press: row.press, source: 'comparison', metric: 'radiusDriverOccurrenceDelta', value: delta, unit: 'count', role: 'delta', usable: true, label: `${label} occurrence change`, range: currentRange },
    )
    metrics.push({ metricId: `radius.driver.${id}.occurrences`, label: `${label} occurrences`, unit: 'count', current: driver.occurrences, baseline: baseline.occurrences, materialDelta: 2, currentFactId: currentId, baselineFactId: baselineId, deltaFactId: deltaId })
  }
  return { facts: resultFacts, metrics }
}

function eventObservations(result: AiToolResult): IndustrialAnalyticalObservation[] {
  if (!result.industrialAnalytics || typeof result.industrialAnalytics !== 'object') return []
  const analytics = result.industrialAnalytics as Record<string, unknown>
  return Array.isArray(analytics.observations) ? analytics.observations.filter((item): item is IndustrialAnalyticalObservation => Boolean(item) && typeof item === 'object' && typeof (item as IndustrialAnalyticalObservation).observationId === 'string') : []
}

function analyticsCount(result: AiToolResult, key: 'calculatedCount' | 'retainedCount'): number {
  if (!result.industrialAnalytics || typeof result.industrialAnalytics !== 'object') return 0
  const value = (result.industrialAnalytics as Record<string, unknown>)[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

const FAMILY_PRIORITY: Record<IndustrialAnalyticalObservation['family'], number> = { event_aligned_change: 7, radius_sequence_deviation: 6, baseline_deviation: 5, value_state_transition: 4, numeric_relationship: 3, robust_numeric_change: 2, cross_press_comparison: 1 }
function observationMagnitude(observation: IndustrialAnalyticalObservation): number { return Math.max(0, ...Object.values(observation.magnitudeInputs).filter((value): value is number => typeof value === 'number' && Number.isFinite(value)).map(Math.abs)) }
function rankObservations(observations: IndustrialAnalyticalObservation[]): IndustrialAnalyticalObservation[] {
  return [...new Map(observations.filter((item) => item.support.adequate && item.material && item.factIds.length > 0).map((item) => [item.observationId, item])).values()]
    .sort((left, right) => FAMILY_PRIORITY[right.family] - FAMILY_PRIORITY[left.family] || observationMagnitude(right) - observationMagnitude(left) || right.support.sampleCount - left.support.sampleCount || left.observationId.localeCompare(right.observationId))
}

const MODEL_METRICS: Record<IndustrialAnalyticalObservation['family'], string[]> = {
  baseline_deviation: ['label', 'unit', 'current', 'baseline', 'delta'],
  robust_numeric_change: ['unit', 'median', 'startEndDelta', 'largestDelta', 'standardDeviation'],
  event_aligned_change: ['unit', 'beforeMedian', 'eventMedian', 'afterMedian', 'beforeToEventDelta'],
  value_state_transition: ['transitionCount', 'transitionsNearEvent', 'medianMinutesBetweenTransitions'],
  radius_sequence_deviation: ['commonSequenceCount', 'commonSequenceSharePercent', 'extraStepCount', 'missingStepCount', 'loopCount', 'longestDwellMinutes', 'returnAttempts'],
  numeric_relationship: ['context', 'pearson', 'spearman', 'bestLagMinutes', 'bestLagCorrelation', 'direction'],
  cross_press_comparison: ['unit', 'pressValue', 'compatiblePressMedian', 'delta'],
}
function compactObservationMetrics(observation: IndustrialAnalyticalObservation) { return Object.fromEntries(MODEL_METRICS[observation.family].flatMap((key) => observation.metrics[key] === undefined ? [] : [[key, observation.metrics[key]]])) }

function uniqueFacts(input: AiGroundingFact[]): AiGroundingFact[] {
  const found = new Map<string, AiGroundingFact>()
  for (const fact of input) if (!found.has(fact.factId)) found.set(fact.factId, fact)
  return [...found.values()]
}

function selectFacts(pressKey: RadiusPressKey, all: AiGroundingFact[], observations: IndustrialAnalyticalObservation[]): AiGroundingFact[] {
  const matching = all.filter((fact) => fact.pressKey === pressKey && fact.usable)
  const core = matching.filter((fact) => ['coveragePercent', 'productionPercent', 'productionPercentagePointDelta', 'interruptions', 'interruptionDelta', 'longestInterruptionMinutes', 'longestInterruptionDeltaMinutes'].includes(fact.metric))
  const drivers = (role: AiGroundingFact['role']) => matching.filter((fact) => fact.metric === 'radiusDriverDurationMinutes' && fact.role === role).slice(0, 1)
  const eventPairs = matching.filter((fact) => ['eventTimestamp', 'eventDurationMinutes'].includes(fact.metric)).slice(0, 2)
  const context = ['job', 'order', 'recipe'].flatMap((metric) => matching.filter((fact) => fact.source === 'production_context' && fact.metric === metric).slice(0, 1))
  const observationIds = new Set(observations.flatMap(({ factIds }) => factIds).slice(0, 8))
  const observationFacts = matching.filter((fact) => observationIds.has(fact.factId))
  return uniqueFacts([...core, ...drivers('current'), ...drivers('baseline'), ...eventPairs, ...context, ...observationFacts])
}

function compactModelInput(request: AiInvestigatorRequest, current: { start: string; end: string }, baseline: { start: string; end: string }, candidates: DiscoveryCandidate[], eligible: RadiusPressKey[], excluded: RadiusPressKey[], limit: number, limitations: string[]) {
  const units: Array<string | null> = [null]; const roles: AiGroundingFact['role'][] = ['current', 'baseline', 'delta', 'event']; const sources = ['radius', 'telemetry', 'production_context', 'comparison', 'coverage']
  const unitIndex = (unit: string | null) => { const found = units.indexOf(unit); if (found >= 0) return found; units.push(unit); return units.length - 1 }
  return {
    version: 1,
    task: 'rank_supplied_candidates',
    scope: request.scope.pressKey ?? 'all',
    ranges: { current: [current.start, current.end], baseline: [baseline.start, baseline.end] },
    selection: { eligible, excluded, selected: candidates.map((candidate) => candidate.pressKey), limit, rule: 'coverage>=80 both periods; press rank by material baseline signal count then absolute deltas; observation rank by fixed family priority, deterministic magnitude, support, id' },
    factColumns: ['id', 'metric', 'value', 'unitIndex', 'roleIndex', 'sourceIndex', 'timestamp', 'label'],
    dictionary: { units, roles, sources },
    observationColumns: ['id', 'family', 'eventId', 'variables', 'factIds', 'metrics', 'sampleCount', 'coveragePercent'],
    candidates: candidates.map((candidate) => ({ id: candidate.pressKey, score: [candidate.signalCount, candidate.productionDelta, candidate.interruptionDelta, candidate.longestDelta], observations: candidate.observations.map((observation) => [observation.observationId, observation.family, observation.eventId, observation.variableIds, observation.factIds, compactObservationMetrics(observation), observation.support.sampleCount, observation.support.coveragePercent]), facts: candidate.facts.map((fact) => [fact.factId, fact.metric, fact.value, unitIndex(fact.unit), roles.indexOf(fact.role), sources.indexOf(fact.source), fact.timestamp ?? null, fact.label]) })),
    limitations,
  }
}

export async function buildDiscoveryPreflight(executor: AiInvestigatorToolExecutor, request: AiInvestigatorRequest, signal: AbortSignal, options: { candidateLimit?: number; requestId?: string; maxParallelTools?: number; toolTimeoutMs?: number } = {}): Promise<DiscoveryPreflight> {
  const preflightBegan = Date.now()
  const duration = Date.parse(request.range.endUtc) - Date.parse(request.range.startUtc)
  const current = { start: request.range.startUtc, end: request.range.endUtc }
  const baseline = { start: new Date(Date.parse(current.start) - duration).toISOString(), end: current.start }
  const scope = request.scope.pressKey
  const evidence: DiscoveryPreflight['evidence'] = []
  const execute = async (name: string, args: unknown) => {
    const began = Date.now(); const controller = new AbortController(); const toolSignal = AbortSignal.any([signal, controller.signal])
    const timer = options.toolTimeoutMs ? setTimeout(() => controller.abort(new Error('ai_tool_timeout')), options.toolTimeoutMs) : undefined
    try {
      const operation = executor.execute(name, args, { requestId: options.requestId ?? 'offline-discovery', signal: toolSignal })
      const result = await Promise.race([operation, new Promise<never>((_resolve, reject) => toolSignal.addEventListener('abort', () => reject(toolSignal.reason ?? new Error('ai_tool_timeout')), { once: true }))])
      return { name, arguments: args, result, durationMs: Date.now() - began }
    } finally { if (timer) clearTimeout(timer) }
  }
  const [currentEvidence, baselineEvidence] = await Promise.all([
    execute('get_fleet_operational_summary', { start: current.start, end: current.end, press: scope }),
    execute('get_fleet_operational_summary', { start: baseline.start, end: baseline.end, press: scope }),
  ])
  evidence.push(currentEvidence, baselineEvidence)
  const currentResult = currentEvidence.result; const baselineResult = baselineEvidence.result
  const currentRows = rows(currentResult); const baselineRows = new Map(rows(baselineResult).map((row) => [row.pressKey, row]))
  const candidateRows = currentRows.flatMap((row) => {
    const previous = baselineRows.get(row.pressKey); if (!previous) return []
    const productionDelta = row.productionPercent === null || previous.productionPercent === null ? null : round(row.productionPercent - previous.productionPercent)
    const interruptionDelta = row.productionInterruptions - previous.productionInterruptions
    const longestDelta = row.longestInterruptionMinutes === null || previous.longestInterruptionMinutes === null ? null : round(row.longestInterruptionMinutes - previous.longestInterruptionMinutes)
    const signalCount = Number(productionDelta !== null && Math.abs(productionDelta) >= 5) + Number(Math.abs(interruptionDelta) >= 3) + Number(longestDelta !== null && Math.abs(longestDelta) >= 60)
    return [{ row, previous, productionDelta, interruptionDelta, longestDelta, signalCount }]
  })
  const eligible = candidateRows.filter(({ row, previous }) => scope !== null || (row.coveragePercent ?? 0) >= 80 && (previous.coveragePercent ?? 0) >= 80)
  eligible.sort((left, right) => right.signalCount - left.signalCount || Math.abs(right.productionDelta ?? 0) - Math.abs(left.productionDelta ?? 0) || Math.abs(right.interruptionDelta) - Math.abs(left.interruptionDelta) || Math.abs(right.longestDelta ?? 0) - Math.abs(left.longestDelta ?? 0) || Number(left.row.pressKey.slice(5)) - Number(right.row.pressKey.slice(5)))
  const limit = Math.max(0, Math.min(DISCOVERY_CANDIDATE_LIMIT, options.candidateLimit ?? (scope ? DISCOVERY_SELECTED_PRESS_LIMIT : DISCOVERY_CANDIDATE_LIMIT)))
  const selected = eligible.slice(0, limit)
  const eventEvidence: DiscoveryPreflight['evidence'] = []; const parallel = Math.max(1, options.maxParallelTools ?? 3)
  for (let offset = 0; offset < selected.length; offset += parallel) eventEvidence.push(...await Promise.all(selected.slice(offset, offset + parallel).map(({ row }) => execute('get_press_event_summary', { press: row.pressKey, start: current.start, end: current.end, topN: DISCOVERY_EVENT_LIMIT }))))
  evidence.push(...eventEvidence)
  const eventResults = eventEvidence.map((item) => item.result)
  const analyticsBegan = Date.now()
  const industrialAnalytics = new IndustrialAnalyticsService()
  const industrialByPress = new Map<RadiusPressKey, IndustrialAnalyticalObservation[]>()
  const derivedFacts: AiGroundingFact[] = []
  for (const { row, previous, productionDelta, interruptionDelta, longestDelta } of selected) {
    const comparisons = driverComparisons(row, previous, current, baseline)
    derivedFacts.push(...comparisons.facts)
    const metrics: IndustrialBaselineMetricInput[] = [
      { metricId: 'radius.productionPercent', label: 'Production time', unit: 'percent', current: row.productionPercent, baseline: previous.productionPercent, materialDelta: 5, currentFactId: `${row.pressKey}.production_percent.current`, baselineFactId: `${row.pressKey}.production_percent.baseline`, deltaFactId: `${row.pressKey}.production_percent.delta` },
      { metricId: 'radius.interruptions', label: 'Production interruptions', unit: 'count', current: row.productionInterruptions, baseline: previous.productionInterruptions, materialDelta: 3, currentFactId: `${row.pressKey}.interruptions.current`, baselineFactId: `${row.pressKey}.interruptions.baseline`, deltaFactId: `${row.pressKey}.interruptions.delta` },
      { metricId: 'radius.longestInterruptionMinutes', label: 'Longest interruption', unit: 'minutes', current: row.longestInterruptionMinutes, baseline: previous.longestInterruptionMinutes, materialDelta: 60, currentFactId: `${row.pressKey}.longest_interruption_minutes.current`, baselineFactId: `${row.pressKey}.longest_interruption_minutes.baseline`, deltaFactId: `${row.pressKey}.longest_interruption_minutes.delta` },
      ...comparisons.metrics,
    ]
    industrialByPress.set(row.pressKey, industrialAnalytics.baselineDeviation({ pressKey: row.pressKey, range: current, comparisonRange: baseline, currentCoveragePercent: row.coveragePercent ?? 0, comparisonCoveragePercent: previous.coveragePercent ?? 0, metrics }))
  }
  const crossPress = industrialAnalytics.crossPressSummaryComparison({ canonicalId: 'radius.productionPercent', unit: 'percent', range: current, values: eligible.map(({ row }) => ({ pressKey: row.pressKey, value: row.productionPercent, supportCount: 1, coveragePercent: row.coveragePercent, factId: `${row.pressKey}.production_percent.current` })) })
  for (const observation of crossPress) {
    const medianId = `${observation.pressKey}.${observation.observationId}.compatible_median.current`; const deltaId = `${observation.pressKey}.${observation.observationId}.delta.current`
    derivedFacts.push(
      { factId: medianId, pressKey: observation.pressKey, press: selected.find(({ row }) => row.pressKey === observation.pressKey)?.row.press ?? observation.pressKey, source: 'comparison', metric: 'compatiblePressMedian', value: observation.metrics.compatiblePressMedian ?? null, unit: 'percent', role: 'current', usable: observation.metrics.compatiblePressMedian !== null, label: 'Compatible-press median production time', range: current },
      { factId: deltaId, pressKey: observation.pressKey, press: selected.find(({ row }) => row.pressKey === observation.pressKey)?.row.press ?? observation.pressKey, source: 'comparison', metric: 'crossPressDelta', value: observation.metrics.delta ?? null, unit: 'percentage_points', role: 'delta', usable: observation.metrics.delta !== null, label: 'Production time versus compatible-press median', range: current },
    )
    observation.factIds = [observation.factIds[0]!, medianId, deltaId]
    industrialByPress.set(observation.pressKey, [...(industrialByPress.get(observation.pressKey) ?? []), observation])
  }
  eventResults.forEach((result) => {
    const pressKey = typeof result.pressKey === 'string' ? result.pressKey as RadiusPressKey : null
    if (pressKey) industrialByPress.set(pressKey, [...(industrialByPress.get(pressKey) ?? []), ...eventObservations(result)])
  })
  const baseFacts = [
    ...facts(currentResult),
    ...facts(baselineResult).map((fact) => baselineFact(fact, baseline)),
    ...selected.flatMap(({ row, productionDelta, interruptionDelta, longestDelta }) => [deltaFact(row, 'production', productionDelta, current), deltaFact(row, 'interruptions', interruptionDelta, current), deltaFact(row, 'longest', longestDelta, current)]),
    ...derivedFacts,
    ...eventResults.flatMap(facts),
  ]
  const allFacts = uniqueFacts(baseFacts)
  const retainedByPress = new Map(selected.map(({ row }) => [row.pressKey, rankObservations(industrialByPress.get(row.pressKey) ?? [])]))
  const candidates: DiscoveryCandidate[] = selected.map(({ row, productionDelta, interruptionDelta, longestDelta, signalCount }) => {
    const retained = retainedByPress.get(row.pressKey) ?? []; const observations = retained.slice(0, DISCOVERY_OBSERVATION_LIMIT_PER_CANDIDATE)
    return { pressKey: row.pressKey, press: row.press, signalCount: signalCount + retained.length, productionDelta, interruptionDelta, longestDelta, observations, facts: selectFacts(row.pressKey, allFacts, observations) }
  })
  const eligiblePresses = eligible.map(({ row }) => row.pressKey); const excludedPresses = candidateRows.filter((item) => !eligible.includes(item)).map(({ row }) => row.pressKey)
  const limitations = uniqueStrings([
    ...extractLimitations(currentResult), ...extractLimitations(baselineResult), ...eventResults.flatMap(extractLimitations),
    ...(excludedPresses.length ? [`Excluded for less than 80% coverage in current or baseline: ${excludedPresses.join(', ')}.`] : []),
    ...(scope && eligible.some(({ row, previous }) => (row.coveragePercent ?? 0) < 80 || (previous.coveragePercent ?? 0) < 80) ? ['The selected press has less than 80% coverage in the current or baseline period.'] : []),
    ...(eligible.length > selected.length ? [`Detailed evidence was bounded to the top ${selected.length} of ${eligible.length} eligible presses.`] : []),
  ])
  const selectedFacts = uniqueFacts(candidates.flatMap((candidate) => candidate.facts))
  const baselineCalculated = selected.reduce((sum, { row }) => sum + (industrialByPress.get(row.pressKey)?.filter(({ family }) => family === 'baseline_deviation').length ?? 0), 0)
  const eventCalculated = eventResults.reduce((sum, result) => sum + analyticsCount(result, 'calculatedCount'), 0)
  const retained = [...retainedByPress.values()].reduce((sum, observations) => sum + observations.length, 0)
  const analytics = { calculated: baselineCalculated + eventCalculated + crossPress.filter((observation) => selected.some(({ row }) => row.pressKey === observation.pressKey)).length, retained, grouped: candidates.reduce((sum, candidate) => sum + candidate.observations.length, 0), modelCandidates: candidates.length, calculationMs: Date.now() - analyticsBegan }
  const dataServiceQueries = evidence.reduce((sum, item) => sum + (typeof item.result.queryCount === 'number' && Number.isFinite(item.result.queryCount) ? item.result.queryCount : 1), 0)
  return { evidence, facts: selectedFacts, candidates, eligiblePresses, excludedPresses, limitations, analytics, performance: { dataServiceQueries, preflightMs: Date.now() - preflightBegan }, modelInput: compactModelInput(request, current, baseline, candidates, eligiblePresses, excludedPresses, limit, limitations) }
}

function extractLimitations(result: AiToolResult): string[] { return Array.isArray(result.limitations) ? result.limitations.filter((item): item is string => typeof item === 'string') : [] }
function uniqueStrings(values: string[]): string[] { return [...new Set(values)] }

function groupKey(fact: AiGroundingFact): string {
  return fact.factId.replace(/\.(?:current|baseline|delta)$/, '').replace(/\.(?:timestamp|duration_minutes)$/, '')
}

export type DiscoveryReferenceIssueCode = 'unknown_candidate_id' | 'duplicate_candidate_id' | 'unknown_fact_id' | 'cross_press_fact' | 'unusable_fact' | 'invalid_fact_source'
export interface DiscoveryReferenceIssue {
  validationStage: 'grounding_reference'
  code: DiscoveryReferenceIssueCode
  path: string
  findingIndex: number
  candidateId: string
  factId?: string
}

export function validateDiscoveryReferences(draft: AiInvestigatorDiscoveryDraftContent, candidates: DiscoveryCandidate[], facts: AiGroundingFact[]): { accepted: AiInvestigatorDiscoveryDraftContent; issues: DiscoveryReferenceIssue[] } {
  const candidateMap = new Map(candidates.map((candidate) => [candidate.pressKey, candidate]))
  const factMap = new Map(facts.map((fact) => [fact.factId, fact]))
  const seenCandidates = new Set<string>(); const accepted: AiInvestigatorDiscoveryDraftContent['findings'] = []; const issues: DiscoveryReferenceIssue[] = []
  draft.findings.forEach((finding, findingIndex) => {
    const candidate = candidateMap.get(finding.candidateId as RadiusPressKey)
    const findingIssues: DiscoveryReferenceIssue[] = []
    if (!candidate) findingIssues.push({ validationStage: 'grounding_reference', code: 'unknown_candidate_id', path: `findings[${findingIndex}].candidateId`, findingIndex, candidateId: finding.candidateId })
    else if (seenCandidates.has(finding.candidateId)) findingIssues.push({ validationStage: 'grounding_reference', code: 'duplicate_candidate_id', path: `findings[${findingIndex}].candidateId`, findingIndex, candidateId: finding.candidateId })
    finding.factIds.forEach((factId, factIndex) => {
      const fact = factMap.get(factId); const path = `findings[${findingIndex}].factIds[${factIndex}]`
      if (!fact) findingIssues.push({ validationStage: 'grounding_reference', code: 'unknown_fact_id', path, findingIndex, candidateId: finding.candidateId, factId })
      else if (candidate && fact.pressKey !== candidate.pressKey) findingIssues.push({ validationStage: 'grounding_reference', code: 'cross_press_fact', path, findingIndex, candidateId: finding.candidateId, factId })
      else if (!fact.usable) findingIssues.push({ validationStage: 'grounding_reference', code: 'unusable_fact', path, findingIndex, candidateId: finding.candidateId, factId })
      else if (!['radius', 'telemetry', 'production_context', 'comparison', 'coverage'].includes(fact.source)) findingIssues.push({ validationStage: 'grounding_reference', code: 'invalid_fact_source', path, findingIndex, candidateId: finding.candidateId, factId })
    })
    issues.push(...findingIssues)
    if (!findingIssues.length) { accepted.push(finding); seenCandidates.add(finding.candidateId) }
  })
  return { accepted: { summary: draft.summary, findings: accepted, limitations: draft.limitations }, issues }
}

export function expandDiscoveryDraft(draft: AiInvestigatorDiscoveryDraftContent, availableFacts: AiGroundingFact[], availableObservations: IndustrialAnalyticalObservation[] = []): AiInvestigatorDraftContent {
  const factMap = new Map(availableFacts.map((fact) => [fact.factId, fact]))
  return {
    summary: draft.summary,
    findings: draft.findings.map((finding, findingIndex) => {
      const pressKey = finding.candidateId as RadiusPressKey
      const requested = uniqueStrings(finding.factIds).flatMap((id) => factMap.get(id) ? [factMap.get(id)!] : [])
      const unknownIds = uniqueStrings(finding.factIds).filter((id) => !factMap.has(id))
      const comparisonGroups = new Set(requested.filter((fact) => fact.role === 'delta').map(groupKey))
      const selected = uniqueFacts([...requested, ...availableFacts.filter((fact) => fact.pressKey === pressKey && comparisonGroups.has(groupKey(fact)) && ['current', 'baseline', 'delta'].includes(fact.role))])
      const grouped = new Map<string, AiGroundingFact[]>()
      for (const fact of selected) { const key = groupKey(fact); grouped.set(key, [...(grouped.get(key) ?? []), fact]) }
      const contextId = (metric: string) => selected.find((fact) => fact.source === 'production_context' && fact.metric === metric && fact.usable)?.factId ?? null
      const selectedIds = new Set(selected.map(({ factId }) => factId))
      const observationLinks = availableObservations.filter((observation) => observation.pressKey === pressKey && observation.factIds.some((id) => selectedIds.has(id)) && observation.explorer).map((observation) => observation.explorer!)
      const links = [...new Map([...observationLinks, { label: 'Inspect Radius evidence', href: `/raw-radius-explorer?press=${pressKey}` }, { label: 'Open press overview', href: `/overview?press=${pressKey}` }].map((link) => [link.href, link])).values()].slice(0, 4)
      return {
        rank: findingIndex + 1, pressKey, title: finding.title, importance: finding.importance, confidence: finding.confidence,
        whyItMatters: `${finding.interpretation} ${finding.whyWorthInvestigating}`.trim().slice(0, 700),
        facts: [...grouped.values()].slice(0, 8).map((group) => ({ label: group[0].label, factIds: group.map((fact) => fact.factId).slice(0, 4) })).concat(unknownIds.length ? [{ label: 'Selected evidence', factIds: unknownIds.slice(0, 4) }] : []).slice(0, 8),
        timestampFactIds: selected.filter((fact) => fact.timestamp).map((fact) => fact.factId).slice(0, 8),
        evidenceFactIds: selected.filter((fact) => ['radius', 'telemetry'].includes(fact.source) && fact.usable).map((fact) => fact.factId).slice(0, 12),
        productionContextFactIds: { job: contextId('job'), order: contextId('order'), recipe: contextId('recipe') },
        recommendedInvestigation: finding.recommendedInvestigation,
        links,
      }
    }),
    limitations: uniqueStrings(draft.limitations),
  }
}
