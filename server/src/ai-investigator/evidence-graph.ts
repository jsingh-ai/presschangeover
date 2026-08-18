import { createHash } from 'node:crypto'
import type { IndustrialAnalyticalObservation } from '../industrial-analytics/contracts.js'
import type { TemporalEvidenceProgram } from '../industrial-analytics/temporal-evidence.js'
import type { RadiusPressKey } from '../radius/models.js'
import type { AiGroundingFact } from './contracts.js'

const VALID_FACT_SOURCES = new Set<AiGroundingFact['source']>(['radius', 'telemetry', 'production_context', 'comparison', 'coverage'])

export interface DiscoveryEvidenceCandidate {
  pressKey: RadiusPressKey
  observations: IndustrialAnalyticalObservation[]
  facts: AiGroundingFact[]
  traces?: TemporalEvidenceProgram[]
}

export type DiscoveryEvidenceIssueCode =
  | 'conflicting_fact_registration'
  | 'duplicate_observation_id'
  | 'unknown_observation_id'
  | 'unknown_fact_id'
  | 'candidate_missing_observation_fact'
  | 'cross_press_observation'
  | 'cross_press_fact'
  | 'unusable_fact'
  | 'invalid_fact_source'
  | 'unknown_model_candidate'
  | 'unknown_model_observation_id'
  | 'unknown_model_fact_id'
  | 'duplicate_trace_id'
  | 'unknown_trace_id'
  | 'unknown_model_trace_id'
  | 'cross_press_trace'
  | 'unusable_trace'

export interface DiscoveryEvidenceIssue {
  validationStage: 'evidence_graph'
  generationStage: 'fact_registration' | 'observation_registry' | 'candidate_package' | 'model_serialization'
  code: DiscoveryEvidenceIssueCode
  path: string
  candidateId?: string
  observationId?: string
  factId?: string
  traceId?: string
  press?: RadiusPressKey
}

export interface DiscoveryEvidenceGraphResult {
  valid: boolean
  issues: DiscoveryEvidenceIssue[]
  registeredFacts: number
  observations: number
  candidates: number
  advertisedFactReferences: number
  modelVisibleFactIds: number
  unresolvedReferences: number
  crossPressViolations: number
  unusableAdvertisedFacts: number
  traces: number
  modelVisibleTraceIds: number
  unresolvedTraceReferences: number
  unusableAdvertisedTraces: number
}

export class DiscoveryEvidenceValidationError extends Error {
  constructor(public readonly diagnostic: DiscoveryEvidenceIssue) {
    super('invalid_discovery_evidence')
    this.name = 'DiscoveryEvidenceValidationError'
  }
}

function comparableFact(fact: AiGroundingFact): string {
  return JSON.stringify({ pressKey: fact.pressKey, press: fact.press, source: fact.source, metric: fact.metric, value: fact.value, unit: fact.unit, role: fact.role, usable: fact.usable, label: fact.label, timestamp: fact.timestamp ?? null, range: fact.range ?? null })
}

export class DiscoveryFactRegistry {
  private readonly entries = new Map<string, AiGroundingFact>()

  register(fact: AiGroundingFact): AiGroundingFact {
    const existing = this.entries.get(fact.factId)
    if (existing && comparableFact(existing) !== comparableFact(fact)) throw new DiscoveryEvidenceValidationError({ validationStage: 'evidence_graph', generationStage: 'fact_registration', code: 'conflicting_fact_registration', path: 'facts', candidateId: fact.pressKey, factId: fact.factId, press: fact.pressKey })
    if (!existing) this.entries.set(fact.factId, fact)
    return existing ?? fact
  }

  registerAll(facts: AiGroundingFact[]): AiGroundingFact[] { return facts.map((fact) => this.register(fact)) }
  get(factId: string): AiGroundingFact | undefined { return this.entries.get(factId) }
  values(): AiGroundingFact[] { return [...this.entries.values()] }
}

export interface RadiusDriverIdentityInput { eventType: string; statusCode: string | null; statusDescription: string }

export function radiusDriverIdentity(driver: RadiusDriverIdentityInput): string {
  return createHash('sha256').update(`${driver.eventType}\u0000${driver.statusCode ?? ''}\u0000${driver.statusDescription}`).digest('hex').slice(0, 10)
}

export function createRadiusDriverDurationFact(input: { pressKey: RadiusPressKey; press: string; driver: RadiusDriverIdentityInput & { durationMinutes: number | null }; role: 'current' | 'baseline' | 'event'; range: { start: string; end: string } }): AiGroundingFact {
  const id = radiusDriverIdentity(input.driver)
  return { factId: `${input.pressKey}.radius_driver.${id}.duration_minutes.${input.role}`, pressKey: input.pressKey, press: input.press, source: 'radius', metric: 'radiusDriverDurationMinutes', value: input.driver.durationMinutes, unit: 'minutes', role: input.role, usable: input.driver.durationMinutes !== null, label: `${input.driver.eventType} / ${input.driver.statusCode ?? '—'} / ${input.driver.statusDescription}`, range: input.range }
}

export function registerRadiusDriverDurationComparison(registry: DiscoveryFactRegistry, input: { pressKey: RadiusPressKey; press: string; current: RadiusDriverIdentityInput & { durationMinutes: number }; baseline: RadiusDriverIdentityInput & { durationMinutes: number }; currentRange: { start: string; end: string }; baselineRange: { start: string; end: string } }): { facts: [AiGroundingFact, AiGroundingFact, AiGroundingFact]; factIds: { current: string; baseline: string; delta: string } } {
  const current = registry.register(createRadiusDriverDurationFact({ pressKey: input.pressKey, press: input.press, driver: input.current, role: 'current', range: input.currentRange }))
  const baseline = registry.register(createRadiusDriverDurationFact({ pressKey: input.pressKey, press: input.press, driver: input.baseline, role: 'baseline', range: input.baselineRange }))
  const delta = registry.register({ factId: `${input.pressKey}.radius_driver.${radiusDriverIdentity(input.current)}.duration_minutes.delta`, pressKey: input.pressKey, press: input.press, source: 'comparison', metric: 'radiusDriverDurationDeltaMinutes', value: Math.round((input.current.durationMinutes - input.baseline.durationMinutes) * 10) / 10, unit: 'minutes', role: 'delta', usable: true, label: `${input.current.eventType} / ${input.current.statusCode ?? '—'} / ${input.current.statusDescription} duration change`, range: input.currentRange })
  return { facts: [current, baseline, delta], factIds: { current: current.factId, baseline: baseline.factId, delta: delta.factId } }
}

const INDUSTRIAL_METRIC_LABELS: Record<string, string> = {
  current: 'Current', baseline: 'Baseline', delta: 'Change', median: 'Median', startEndDelta: 'Start-to-end change', largestDelta: 'Largest adjacent change', standardDeviation: 'Standard deviation', deltaEventCount: 'Bounded delta events', largestEventExplorerDelta: 'Largest bounded delta',
  beforeMedian: 'Before-event median', eventMedian: 'Event median', afterMedian: 'After-event median', beforeToEventDelta: 'Before-to-event change', eventMinimum: 'Event minimum', eventMaximum: 'Event maximum', eventSlopePerMinute: 'Event slope per minute', eventVolatility: 'Event volatility',
  transitionCount: 'State transitions', transitionsNearEvent: 'Transitions near event', stateBefore: 'State before', stateAfter: 'State after',
  commonSequenceCount: 'Common Radius sequence support', commonSequenceSharePercent: 'Common Radius sequence share', extraStepCount: 'Extra Radius steps', missingStepCount: 'Missing Radius steps', repeatedStepCount: 'Repeated Radius steps', loopCount: 'Looped Radius steps', longestDwellMinutes: 'Longest Radius dwell', biggestDwellDeviationMinutes: 'Largest Radius dwell deviation', returnAttempts: 'Return attempts', productionRestored: 'Production restored',
  speedBefore: 'Speed before event', minimumSpeed: 'Minimum speed', speedAtReturn: 'Speed at return', timeToRestartMinutes: 'Time to restart', accelerationAttempts: 'Acceleration attempts', failedAccelerations: 'Failed accelerations', maximumRecoveredSpeed: 'Maximum recovered speed', timeToSustainedSpeedMinutes: 'Time to sustained speed', recoverySlopePerMinute: 'Recovery slope per minute', recoveryVariability: 'Recovery variability',
  expectedMedian: 'Expected median', envelopeLower: 'Normal envelope lower bound', envelopeUpper: 'Normal envelope upper bound', firstDepartureAtUtc: 'First envelope departure', recurrenceCount: 'Deviation recurrences', longestDurationMinutes: 'Longest deviation duration', maximumDepartureMagnitude: 'Maximum envelope departure',
  classification: 'Persistence pattern', startAtUtc: 'Persistence start', endAtUtc: 'Persistence end', totalDurationMinutes: 'Total deviation duration', maximumMagnitude: 'Maximum deviation magnitude',
  firstObservedAtUtc: 'First observed divergence', relativeToEpisodeMinutes: 'Minutes relative to episode', sourceFamily: 'Divergence evidence type', signal: 'Divergence signal', observedBehavior: 'Observed behavior', expectedBehavior: 'Expected behavior',
  relation: 'Radius/telemetry ordering', lagMinutes: 'Radius/telemetry lag', radiusTransitionAtUtc: 'Radius transition time', telemetryBehaviorAtUtc: 'Telemetry behavior time', statement: 'Radius/telemetry timing fact',
  pearson: 'Pearson correlation', spearman: 'Spearman correlation', bestLagMinutes: 'Strongest lag', bestLagCorrelation: 'Lagged correlation', alignedPairCount: 'Aligned pairs', pairCoveragePercent: 'Aligned pair coverage', temporalCoveragePercent: 'Temporal coverage', qualification: 'Relationship qualification', pressMedian: 'Press median', compatiblePressMedian: 'Compatible-press median',
}

const INDUSTRIAL_FACT_METRICS: Record<IndustrialAnalyticalObservation['family'], string[]> = {
  baseline_deviation: ['current', 'baseline', 'delta'],
  robust_numeric_change: ['median', 'largestEventExplorerDelta', 'deltaEventCount'],
  event_aligned_change: ['beforeMedian', 'eventMedian', 'afterMedian', 'beforeToEventDelta', 'eventSlopePerMinute'],
  contextual_baseline: ['current', 'baselineMedian', 'delta', 'sampleCount'],
  contextual_telemetry_baseline: ['current', 'historicalMedian', 'historicalMad', 'delta', 'standardizedDelta', 'sampleCount'],
  speed_recovery: ['speedBefore', 'minimumSpeed', 'accelerationAttempts', 'failedAccelerations', 'maximumRecoveredSpeed', 'timeToSustainedSpeedMinutes'],
  normal_envelope_departure: ['expectedMedian', 'envelopeLower', 'envelopeUpper', 'firstDepartureAtUtc', 'recurrenceCount', 'longestDurationMinutes', 'maximumDepartureMagnitude'],
  deviation_persistence: ['classification', 'startAtUtc', 'endAtUtc', 'totalDurationMinutes', 'longestDurationMinutes', 'recurrenceCount', 'maximumMagnitude'],
  first_divergence: ['firstObservedAtUtc', 'signal', 'observedBehavior', 'expectedBehavior'],
  radius_telemetry_alignment: ['relation', 'lagMinutes', 'radiusTransitionAtUtc', 'telemetryBehaviorAtUtc', 'statement'],
  value_state_transition: ['transitionCount', 'transitionsNearEvent', 'stateBefore', 'stateAfter'],
  radius_sequence_deviation: ['commonSequenceCount', 'extraStepCount', 'missingStepCount', 'repeatedStepCount', 'loopCount', 'biggestDwellDeviationMinutes', 'returnAttempts', 'productionRestored'],
  numeric_relationship: ['pearson', 'spearman', 'bestLagMinutes', 'bestLagCorrelation', 'alignedPairCount', 'pairCoveragePercent', 'temporalCoveragePercent', 'qualification'],
  cross_press_comparison: ['pressMedian', 'compatiblePressMedian', 'delta'],
}

export function createIndustrialObservationFacts(observation: IndustrialAnalyticalObservation, pressName: string): AiGroundingFact[] {
  const defaultUnit = typeof observation.metrics.unit === 'string' ? observation.metrics.unit : null
  const units: Record<string, string | null> = { transitionCount: 'count', transitionsNearEvent: 'count', deltaEventCount: 'count', commonSequenceCount: 'episodes', commonSequenceSharePercent: 'percent', extraStepCount: 'count', missingStepCount: 'count', repeatedStepCount: 'count', loopCount: 'count', returnAttempts: 'count', longestDwellMinutes: 'minutes', biggestDwellDeviationMinutes: 'minutes', timeToRestartMinutes: 'minutes', timeToSustainedSpeedMinutes: 'minutes', accelerationAttempts: 'count', failedAccelerations: 'count', recoverySlopePerMinute: 'speed_per_minute', recoveryVariability: defaultUnit, productionRestored: null, expectedMedian: defaultUnit, envelopeLower: defaultUnit, envelopeUpper: defaultUnit, maximumDepartureMagnitude: defaultUnit, maximumMagnitude: defaultUnit, recurrenceCount: 'count', longestDurationMinutes: 'minutes', totalDurationMinutes: 'minutes', relativeToEpisodeMinutes: 'minutes', lagMinutes: 'minutes', alignedPairCount: 'count', pairCoveragePercent: 'percent', temporalCoveragePercent: 'percent', bestLagMinutes: 'minutes', pearson: 'coefficient', spearman: 'coefficient', bestLagCorrelation: 'coefficient' }
  const facts = INDUSTRIAL_FACT_METRICS[observation.family].flatMap((metric): AiGroundingFact[] => {
    const value = observation.metrics[metric]
    if (value === null || value === undefined || value === '') return []
    const timestamp = metric.endsWith('AtUtc') && typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : undefined
    return [{ factId: `${observation.pressKey}.${observation.observationId}.${metric}.event`, pressKey: observation.pressKey, press: pressName, source: observation.evidenceSource, metric: `industrial.${observation.family}.${metric}`, value, unit: units[metric] ?? defaultUnit, role: 'event', usable: true, label: INDUSTRIAL_METRIC_LABELS[metric] ?? metric, ...(timestamp ? { timestamp } : {}), range: observation.range }]
  })
  observation.factIds = facts.map((fact) => fact.factId)
  return facts
}

function record(value: unknown): Record<string, unknown> | null { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null }

export function validateDiscoveryEvidenceGraph(input: { facts: AiGroundingFact[]; observations: IndustrialAnalyticalObservation[]; candidates: DiscoveryEvidenceCandidate[]; modelInput?: Record<string, unknown> }): DiscoveryEvidenceGraphResult {
  const issues: DiscoveryEvidenceIssue[] = []
  const factMap = new Map(input.facts.map((fact) => [fact.factId, fact]))
  const observationMap = new Map<string, IndustrialAnalyticalObservation>()
  const traceMap = new Map<string, TemporalEvidenceProgram>()
  const candidateMap = new Map(input.candidates.map((candidate) => [candidate.pressKey, candidate]))
  const observationOwners = new Map(input.candidates.flatMap((candidate) => candidate.observations.map((observation) => [observation.observationId, candidate.pressKey] as const)))
  let advertisedFactReferences = 0
  const modelVisible = new Set<string>()
  const modelVisibleTraces = new Set<string>()
  const issue = (value: DiscoveryEvidenceIssue) => issues.push(value)
  const checkFact = (factId: string, stage: DiscoveryEvidenceIssue['generationStage'], path: string, context: { candidateId?: string; observationId?: string; press?: RadiusPressKey }, modelVisibleReference = false) => {
    advertisedFactReferences += 1
    if (modelVisibleReference) modelVisible.add(factId)
    const fact = factMap.get(factId)
    if (!fact) { issue({ validationStage: 'evidence_graph', generationStage: stage, code: stage === 'model_serialization' ? 'unknown_model_fact_id' : 'unknown_fact_id', path, ...context, factId }); return }
    if (context.press && fact.pressKey !== context.press) issue({ validationStage: 'evidence_graph', generationStage: stage, code: 'cross_press_fact', path, ...context, factId })
    if (!fact.usable) issue({ validationStage: 'evidence_graph', generationStage: stage, code: 'unusable_fact', path, ...context, factId })
    if (!VALID_FACT_SOURCES.has(fact.source)) issue({ validationStage: 'evidence_graph', generationStage: stage, code: 'invalid_fact_source', path, ...context, factId })
  }
  input.observations.forEach((observation, observationIndex) => {
    if (observationMap.has(observation.observationId)) issue({ validationStage: 'evidence_graph', generationStage: 'observation_registry', code: 'duplicate_observation_id', path: `observations[${observationIndex}].observationId`, observationId: observation.observationId, press: observation.pressKey })
    else observationMap.set(observation.observationId, observation)
    observation.factIds.forEach((factId, factIndex) => checkFact(factId, 'observation_registry', `observations[${observationIndex}].factIds[${factIndex}]`, { candidateId: observationOwners.get(observation.observationId), observationId: observation.observationId, press: observation.pressKey }))
  })
  input.candidates.flatMap((candidate) => candidate.traces ?? []).forEach((trace, traceIndex) => {
    if (traceMap.has(trace.traceId)) issue({ validationStage: 'evidence_graph', generationStage: 'observation_registry', code: 'duplicate_trace_id', path: `traces[${traceIndex}].traceId`, traceId: trace.traceId, press: trace.pressKey })
    else traceMap.set(trace.traceId, trace)
  })
  input.candidates.forEach((candidate, candidateIndex) => {
    const candidateFacts = new Set(candidate.facts.map((fact) => fact.factId))
    candidate.facts.forEach((fact, factIndex) => checkFact(fact.factId, 'candidate_package', `candidates[${candidateIndex}].facts[${factIndex}]`, { candidateId: candidate.pressKey, press: candidate.pressKey }))
    candidate.observations.forEach((observation, observationIndex) => {
      const registered = observationMap.get(observation.observationId)
      if (!registered) issue({ validationStage: 'evidence_graph', generationStage: 'candidate_package', code: 'unknown_observation_id', path: `candidates[${candidateIndex}].observations[${observationIndex}]`, candidateId: candidate.pressKey, observationId: observation.observationId, press: candidate.pressKey })
      else if (registered.pressKey !== candidate.pressKey) issue({ validationStage: 'evidence_graph', generationStage: 'candidate_package', code: 'cross_press_observation', path: `candidates[${candidateIndex}].observations[${observationIndex}]`, candidateId: candidate.pressKey, observationId: observation.observationId, press: candidate.pressKey })
      observation.factIds.forEach((factId, factIndex) => {
        if (!candidateFacts.has(factId)) issue({ validationStage: 'evidence_graph', generationStage: 'candidate_package', code: 'candidate_missing_observation_fact', path: `candidates[${candidateIndex}].observations[${observationIndex}].factIds[${factIndex}]`, candidateId: candidate.pressKey, observationId: observation.observationId, factId, press: candidate.pressKey })
      })
    })
    ;(candidate.traces ?? []).forEach((trace, traceIndex) => {
      if (!traceMap.has(trace.traceId)) issue({ validationStage: 'evidence_graph', generationStage: 'candidate_package', code: 'unknown_trace_id', path: `candidates[${candidateIndex}].traces[${traceIndex}]`, candidateId: candidate.pressKey, traceId: trace.traceId, press: candidate.pressKey })
      if (trace.pressKey !== candidate.pressKey || trace.candidateId !== candidate.pressKey) issue({ validationStage: 'evidence_graph', generationStage: 'candidate_package', code: 'cross_press_trace', path: `candidates[${candidateIndex}].traces[${traceIndex}]`, candidateId: candidate.pressKey, traceId: trace.traceId, press: candidate.pressKey })
      if (!trace.usable || trace.coveragePercent < 30) issue({ validationStage: 'evidence_graph', generationStage: 'candidate_package', code: 'unusable_trace', path: `candidates[${candidateIndex}].traces[${traceIndex}]`, candidateId: candidate.pressKey, traceId: trace.traceId, press: candidate.pressKey })
    })
  })
  const modelCandidates = Array.isArray(input.modelInput?.candidates) ? input.modelInput.candidates : []
  modelCandidates.forEach((rawCandidate, candidateIndex) => {
    const candidate = record(rawCandidate); const candidateId = typeof candidate?.id === 'string' ? candidate.id : undefined
    const sourceCandidate = candidateId ? candidateMap.get(candidateId as RadiusPressKey) : undefined
    if (!sourceCandidate) issue({ validationStage: 'evidence_graph', generationStage: 'model_serialization', code: 'unknown_model_candidate', path: `model.candidates[${candidateIndex}].id`, candidateId })
    const press = sourceCandidate?.pressKey
    const sourceFactIds = new Set(sourceCandidate?.facts.map((fact) => fact.factId) ?? [])
    const sourceObservationIds = new Set(sourceCandidate?.observations.map((observation) => observation.observationId) ?? [])
    const sourceTraceIds = new Set(sourceCandidate?.traces?.map((trace) => trace.traceId) ?? [])
    const modelFacts = Array.isArray(candidate?.facts) ? candidate.facts : []
    modelFacts.forEach((rawFact, factIndex) => {
      const factId = Array.isArray(rawFact) && typeof rawFact[0] === 'string' ? rawFact[0] : undefined
      if (factId) {
        checkFact(factId, 'model_serialization', `model.candidates[${candidateIndex}].facts[${factIndex}][0]`, { candidateId, press }, true)
        if (sourceCandidate && !sourceFactIds.has(factId)) issue({ validationStage: 'evidence_graph', generationStage: 'model_serialization', code: 'unknown_model_fact_id', path: `model.candidates[${candidateIndex}].facts[${factIndex}][0]`, candidateId, factId, press })
      }
    })
    const modelObservations = Array.isArray(candidate?.observations) ? candidate.observations : []
    modelObservations.forEach((rawObservation, observationIndex) => {
      const observationId = Array.isArray(rawObservation) && typeof rawObservation[0] === 'string' ? rawObservation[0] : undefined
      const registered = observationId ? observationMap.get(observationId) : undefined
      if (!registered || sourceCandidate && observationId && !sourceObservationIds.has(observationId)) issue({ validationStage: 'evidence_graph', generationStage: 'model_serialization', code: 'unknown_model_observation_id', path: `model.candidates[${candidateIndex}].observations[${observationIndex}][0]`, candidateId, observationId, press })
      else if (press && registered.pressKey !== press) issue({ validationStage: 'evidence_graph', generationStage: 'model_serialization', code: 'cross_press_observation', path: `model.candidates[${candidateIndex}].observations[${observationIndex}][0]`, candidateId, observationId, press })
      const factIds = Array.isArray(rawObservation) && Array.isArray(rawObservation[4]) ? rawObservation[4] : []
      factIds.forEach((factId, factIndex) => { if (typeof factId === 'string') {
        checkFact(factId, 'model_serialization', `model.candidates[${candidateIndex}].observations[${observationIndex}][4][${factIndex}]`, { candidateId, observationId, press }, true)
        if (sourceCandidate && !sourceFactIds.has(factId)) issue({ validationStage: 'evidence_graph', generationStage: 'model_serialization', code: 'unknown_model_fact_id', path: `model.candidates[${candidateIndex}].observations[${observationIndex}][4][${factIndex}]`, candidateId, observationId, factId, press })
      } })
    })
    const modelTraces = Array.isArray(candidate?.traces) ? candidate.traces : []
    modelTraces.forEach((rawTrace, traceIndex) => {
      const traceId = Array.isArray(rawTrace) && typeof rawTrace[0] === 'string' ? rawTrace[0] : undefined; const trace = traceId ? traceMap.get(traceId) : undefined
      if (traceId) modelVisibleTraces.add(traceId)
      if (!trace || sourceCandidate && traceId && !sourceTraceIds.has(traceId)) issue({ validationStage: 'evidence_graph', generationStage: 'model_serialization', code: 'unknown_model_trace_id', path: `model.candidates[${candidateIndex}].traces[${traceIndex}][0]`, candidateId, traceId, press })
      else if (press && trace.pressKey !== press) issue({ validationStage: 'evidence_graph', generationStage: 'model_serialization', code: 'cross_press_trace', path: `model.candidates[${candidateIndex}].traces[${traceIndex}][0]`, candidateId, traceId, press })
      else if (!trace.usable || trace.coveragePercent < 30) issue({ validationStage: 'evidence_graph', generationStage: 'model_serialization', code: 'unusable_trace', path: `model.candidates[${candidateIndex}].traces[${traceIndex}][0]`, candidateId, traceId, press })
    })
  })
  return {
    valid: issues.length === 0,
    issues,
    registeredFacts: input.facts.length,
    observations: input.observations.length,
    candidates: input.candidates.length,
    advertisedFactReferences,
    modelVisibleFactIds: modelVisible.size,
    unresolvedReferences: issues.filter((item) => ['unknown_fact_id', 'candidate_missing_observation_fact', 'unknown_model_fact_id'].includes(item.code)).length,
    crossPressViolations: issues.filter((item) => ['cross_press_fact', 'cross_press_observation'].includes(item.code)).length,
    unusableAdvertisedFacts: issues.filter((item) => item.code === 'unusable_fact').length,
    traces: traceMap.size,
    modelVisibleTraceIds: modelVisibleTraces.size,
    unresolvedTraceReferences: issues.filter((item) => ['unknown_trace_id', 'unknown_model_trace_id'].includes(item.code)).length,
    unusableAdvertisedTraces: issues.filter((item) => item.code === 'unusable_trace').length,
  }
}

export function requireValidDiscoveryEvidenceGraph(input: Parameters<typeof validateDiscoveryEvidenceGraph>[0]): DiscoveryEvidenceGraphResult {
  const result = validateDiscoveryEvidenceGraph(input)
  if (!result.valid) throw new DiscoveryEvidenceValidationError(result.issues[0]!)
  return result
}
