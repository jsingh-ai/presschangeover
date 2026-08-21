import type { RadiusPressKey } from '../radius/models.js'

export const JOB_ANALYSIS_DIMENSIONS = ['order', 'recipe', 'customer', 'material'] as const
export type JobAnalysisDimension = (typeof JOB_ANALYSIS_DIMENSIONS)[number]
export const JOB_GROUP_OPERATORS = ['exact', 'contains', 'starts_with', 'ends_with', 'position_range', 'segment_equals'] as const
export type JobGroupOperator = (typeof JOB_GROUP_OPERATORS)[number]
export type JobEvidenceLevel = 'strong' | 'moderate' | 'limited' | 'insufficient'

export interface JobGroupDefinition {
  operator: JobGroupOperator
  query: string
  positionStart?: number
  positionEnd?: number
  segmentIndex?: number
  delimiter?: string
}

export interface JobIdentityCoverage {
  field: JobAnalysisDimension
  capability: 'available' | 'unavailable' | 'temporarily_unavailable'
  valueCoveragePercent: number
  confidence: 'high' | 'moderate' | 'limited' | 'unavailable'
  limitation: string | null
}

export interface JobRadiusEpisode {
  eventType: string
  statusCode: string | null
  statusDescription: string
  startUtc: string
  endUtc: string
  durationSeconds: number
}

export interface ProductionRun {
  runId: string
  pressKey: RadiusPressKey
  startUtc: string
  endUtc: string
  durationSeconds: number
  identities: Partial<Record<JobAnalysisDimension, string>>
  previousIdentities: Partial<Record<JobAnalysisDimension, string>> | null
  nextIdentities: Partial<Record<JobAnalysisDimension, string>> | null
  boundaryFields: JobAnalysisDimension[]
  contextSettlingSeconds: number
  identityTransition: {
    identityChangeFirstSeenAtUtc: string | null
    identityLastChangeAtUtc: string | null
    identitySettledAtUtc: string | null
    settleState: 'confirmed' | 'pending_range_end' | 'range_start' | 'after_data_gap'
    previousResolvedIdentity: Partial<Record<JobAnalysisDimension, string>> | null
    finalResolvedIdentity: Partial<Record<JobAnalysisDimension, string>>
    inferredBoundary: boolean
  }
  dataInterrupted: boolean
  coveragePercent: number
  identityConfidence: 'high' | 'moderate' | 'limited'
  goodSeconds: number
  makeReadySeconds: number
  badSeconds: number
  otherRadiusSeconds: number
  productionInterruptionCount: number
  transitionToStableProductionSeconds: number | null
  transitionMetric: 'radius_stable_production_proxy' | 'unavailable'
  transitionTiming: {
    outgoingStableRadiusProductionEndUtc: string | null
    incomingStableRadiusProductionStartUtc: string | null
    radiusStableProductionProxySeconds: number | null
    metadataFirstSeenToStableSeconds: number | null
    metadataSettledToStableSeconds: number | null
    telemetryPhysicalProductionAtUtc: string | null
    timingUncertaintySeconds: number | null
  }
  radiusEpisodes: JobRadiusEpisode[]
  deckConfiguration: {
    activeDecks: number[]
    reusedDecks: number[]
    addedDecks: number[]
    removedDecks: number[]
    changedDeckCount: number
    evidenceCanonicalId: 'deck.active'
  } | null
}

export interface EvidenceSupport {
  level: JobEvidenceLevel
  runCount: number
  observedHours: number
  coveragePercent: number
  variabilityPoints: number | null
  comparableCount: number
  reason: string
}

export interface JobIdentitySummary {
  value: string
  segments: string[]
  runCount: number
  observedSeconds: number
  goodPercent: number
  makeReadyPercent: number
  badPercent: number
  medianRunSeconds: number
  medianTransitionSeconds: number | null
  interruptions: number
  interruptionsPerProductionHour: number | null
  variabilityPoints: number | null
  consistency: 'consistent' | 'variable' | 'highly_variable' | 'insufficient'
  support: EvidenceSupport
}

export interface RadiusLossSummary {
  eventType: string
  statusCode: string | null
  statusDescription: string
  totalSeconds: number
  secondsPerRun: number
  occurrenceCount: number
  occurrencesPerRun: number
  medianEpisodeSeconds: number
  evidenceUrl: string
}

export interface TransitionSummary {
  transitionKey: string
  pressKey: RadiusPressKey
  previousValue: string
  currentValue: string
  transitionCount: number
  medianTransitionSeconds: number | null
  goodPercent: number
  makeReadyPercent: number
  badPercent: number
  interruptionRatePerTransition: number
  support: EvidenceSupport
  radiusCauses: RadiusLossSummary[]
  fingerprint: {
    exactRadiusSequence: Array<{ eventType: string; statusCode: string | null; statusDescription: string }>
    recurringSequenceCount: number
    medianIdentitySettlingSeconds: number
    medianTimingUncertaintySeconds: number | null
    deckChangeEvidence: null | { supportedRunCount: number; medianChangedDecks: number; commonlyReusedDecks: number[]; commonlyAddedDecks: number[]; commonlyRemovedDecks: number[] }
    telemetryPhysicalTiming: 'not_loaded_in_summary'
    telemetryEvidenceUrl: string
  }
  evidenceUrl: string
}

export interface PressAffinity {
  pressKey: RadiusPressKey
  displayName: string
  runCount: number
  observedSeconds: number
  goodPercent: number
  makeReadyPercent: number
  badPercent: number
  medianTransitionSeconds: number | null
  variabilityPoints: number | null
  actualVersusComparableGoodPoints: number | null
  comparableRunCount: number
  comparisonDescription: string
  recoverableOpportunitySeconds: number | null
  recoverableBaseline: string | null
  support: EvidenceSupport
}

export interface JobDecisionCard {
  kind: 'preferred_press' | 'sequence_risk' | 'largest_loss' | 'stability' | 'insufficient_evidence'
  label: string
  headline: string
  value: string
  detail: string
  evidenceLevel: JobEvidenceLevel
  inspectUrl: string
}

export interface JobIntelligenceFinding {
  findingId: string
  category: 'job_performance_anomaly' | 'press_affinity_anomaly' | 'transition_anomaly' | 'repeat_interruption_anomaly' | 'radius_loss_anomaly' | 'deck_configuration_transition_anomaly'
  title: string
  evidenceLevel: JobEvidenceLevel
  evidenceUrl: string
  deterministicInputs: string[]
}

export interface JobIntelligenceReport {
  version: 'job-intelligence-v1'
  generatedAtUtc: string
  fromUtc: string
  toUtc: string
  pressKey: RadiusPressKey
  displayName: string
  analyzeBy: JobAnalysisDimension
  metricName: 'Production State Efficiency'
  boundaryPolicy: {
    settlingWindowSeconds: 300
    stableProductionConfirmationSeconds: 300
    description: string
  }
  coverage: JobIdentityCoverage[]
  ranking: JobIdentitySummary[]
  selectedGroup: null | {
    definition: JobGroupDefinition
    includedValues: string[]
    runCount: number
  }
  decisions: JobDecisionCard[]
  crossPress: PressAffinity[]
  transitions: TransitionSummary[]
  radiusLosses: RadiusLossSummary[]
  findings: JobIntelligenceFinding[]
  evidenceLinks: { rawRadius: string; telemetryEvents: string }
  limitations: string[]
}
