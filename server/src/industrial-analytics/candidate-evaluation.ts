import type { IndustrialAnalyticalObservation } from './contracts.js'
import type { ProductionContextCapability } from './production-context.js'

export interface IndustrialCandidateEvaluationInput {
  pressCount: number
  rangeHours: number
  candidates: Array<{ candidateId: string; observations: IndustrialAnalyticalObservation[]; contextCapabilities?: ProductionContextCapability[] }>
}

export interface IndustrialCandidateEvaluation {
  candidatesPerDayPerPress: number
  duplicateCandidateRatePercent: number
  detectorFamilyContribution: Record<string, number>
  supportedObservationPercent: number
  candidateOverlapPercent: number
  contextAvailabilityPercent: number
  operatorVerifiableDeepLinkPercent: number
  labeledOutcomeMetrics: null
}

export function evaluateIndustrialCandidates(input: IndustrialCandidateEvaluationInput): IndustrialCandidateEvaluation {
  const denominator = Math.max(1, input.pressCount * Math.max(input.rangeHours / 24, 1 / 24))
  const observations = input.candidates.flatMap((candidate) => candidate.observations)
  const identities = observations.map((item) => `${item.pressKey}\u0000${item.family}\u0000${item.eventId ?? ''}\u0000${item.variableIds.join(',')}`)
  const duplicateCount = identities.length - new Set(identities).size
  const eventOwners = new Map<string, Set<string>>()
  for (const candidate of input.candidates) for (const observation of candidate.observations) if (observation.eventId) eventOwners.set(observation.eventId, new Set([...(eventOwners.get(observation.eventId) ?? []), candidate.candidateId]))
  const overlapping = [...eventOwners.values()].filter((owners) => owners.size > 1).length
  const capabilities = input.candidates.flatMap((candidate) => candidate.contextCapabilities ?? [])
  return {
    candidatesPerDayPerPress: Math.round(input.candidates.length / denominator * 100) / 100,
    duplicateCandidateRatePercent: observations.length ? Math.round(duplicateCount / observations.length * 10_000) / 100 : 0,
    detectorFamilyContribution: Object.fromEntries([...new Set(observations.map((item) => item.family))].sort().map((family) => [family, observations.filter((item) => item.family === family).length])),
    supportedObservationPercent: observations.length ? Math.round(observations.filter((item) => item.support.adequate).length / observations.length * 10_000) / 100 : 0,
    candidateOverlapPercent: eventOwners.size ? Math.round(overlapping / eventOwners.size * 10_000) / 100 : 0,
    contextAvailabilityPercent: capabilities.length ? Math.round(capabilities.filter((item) => item.usable).length / capabilities.length * 10_000) / 100 : 0,
    operatorVerifiableDeepLinkPercent: observations.length ? Math.round(observations.filter((item) => Boolean(item.explorer?.href)).length / observations.length * 10_000) / 100 : 0,
    labeledOutcomeMetrics: null,
  }
}
