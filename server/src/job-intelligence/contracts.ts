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

export interface JobRunLossAggregate {
  eventType: string
  statusCode: string | null
  statusDescription: string
  category: 'make_ready' | 'bad' | 'other'
  totalSeconds: number
  occurrenceCount: number
  medianEpisodeSeconds: number
}

export interface ProductionRun {
  runId: string
  previousRunId?: string | null
  nextRunId?: string | null
  pressKey: RadiusPressKey
  startUtc: string
  endUtc: string
  durationSeconds: number
  boundaryCompleteness: 'natural' | 'left_fragment' | 'right_fragment' | 'isolated_fragment' | 'gap_fragment'
  persistenceEligible: boolean
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
  identityAvailability?: Partial<Record<JobAnalysisDimension, 'available' | 'unavailable' | 'temporarily_unavailable'>>
  coveragePercent: number
  identityConfidence: 'high' | 'moderate' | 'limited'
  goodSeconds: number
  makeReadySeconds: number
  badSeconds: number
  otherRadiusSeconds: number
  unavailableSeconds?: number
  productionStateEfficiency?: number | null
  productionInterruptionCount: number
  interruptionsPerProductionHour?: number | null
  transitionToStableProductionSeconds: number | null
  transitionMakeReadySeconds?: number | null
  transitionBadSeconds?: number | null
  transitionValid?: boolean
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
  radiusLossAggregates?: JobRunLossAggregate[]
  deckConfiguration: {
    activeDecks: number[]
    reusedDecks: number[]
    addedDecks: number[]
    removedDecks: number[]
    changedDeckCount: number
    evidenceCanonicalId: 'deck.active'
  } | null
  runningPerformance?: {
    stableProductionStartUtc: string | null
    observedSeconds: number
    goodSeconds: number
    badSeconds: number
    interruptions: number
    interruptionsPerProductionHour: number | null
    medianUninterruptedGoodSeconds: number | null
    restartCount: number
    speed: null | {
      canonicalId: 'machine.speed.actual'
      sourceUnit: string | null
      canonicalUnitStatus: string | null
      sampleCount: number
      median: number
      p25: number
      p75: number
      p90: number
      timeWeightedMean: number | null
    }
  }
}

export interface JobMetricDistribution { n: number; median: number | null; p25: number | null; p75: number | null; p90: number | null }

export interface JobRefinement { dimension: JobAnalysisDimension; group: JobGroupDefinition; previousIdentity?: boolean }

export interface FleetPressResult extends PressAffinity {
  unavailablePercent: number
  changeover: { transitionCount: number; durationSeconds: JobMetricDistribution; makeReadySecondsPerTransition: number | null; badSecondsPerTransition: number | null; changedDecks: JobMetricDistribution | null }
  running: { runCount: number; goodPercent: number; badPercent: number; interruptionCount: number; interruptionsPerProductionHour: number | null; uninterruptedGoodSeconds: JobMetricDistribution; restartCount: number; speed: null | { sourceUnit: string | null; canonicalUnitStatus: string | null; distribution: JobMetricDistribution; timeWeightedMean: number | null } }
  radiusLosses: RadiusLossSummary[]
  transitions: TransitionSummary[]
  deckEvidence: 'available' | 'unavailable'
}

export interface FleetRadiusLossComparison {
  eventType: string; statusCode: string | null; statusDescription: string
  presses: Array<{ pressKey: RadiusPressKey; totalSeconds: number; secondsPerRun: number; occurrenceCount: number; occurrencesPerRun: number; medianEpisodeSeconds: number; evidenceRuns: Array<{ runId: string; startUtc: string; totalSeconds: number; occurrenceCount: number }> }>
}

export interface FleetTransitionMatrixCell { previousValue: string; currentValue: string; transitionCount: number; durationSeconds: JobMetricDistribution; makeReadySeconds: JobMetricDistribution; badSeconds: JobMetricDistribution; support: EvidenceSupport; pressKeys: RadiusPressKey[] }

export const HISTORICAL_RUN_SORTS = ['newest', 'worst_good', 'longest_make_ready', 'most_bad', 'longest_transition', 'most_interruptions', 'highest_speed', 'lowest_speed'] as const
export type HistoricalRunSort = (typeof HISTORICAL_RUN_SORTS)[number]

export interface HistoricalRunSummary {
  runId: string; pressKey: RadiusPressKey; startUtc: string; endUtc: string; identities: ProductionRun['identities']; previousIdentities: ProductionRun['previousIdentities']; transitionSeconds: number | null
  goodPercent: number; makeReadyPercent: number; badPercent: number; unavailablePercent: number; interruptions: number; medianSpeed: number | null; changedDeckCount: number | null; confidence: ProductionRun['identityConfidence']; dataInterrupted: boolean
}

export interface FleetJobIntelligenceReport {
  version: 'job-intelligence-fleet-v2'; generatedAtUtc: string; algorithmVersion: string; fromUtc: string; toUtc: string; analyzeBy: JobAnalysisDimension; group: JobGroupDefinition; refinements: JobRefinement[]; focusPressKey: RadiusPressKey | null
  selection: { includedValues: string[]; matchingPresses: RadiusPressKey[]; runCount: number; observedHours: number; historyFromUtc: string | null; historyToUtc: string | null; historicalRunCount: number; liveTailRunCount: number }
  fleetSummary: { matchingPressCount: number; runCount: number; observedSeconds: number; goodPercent: number; makeReadyPercent: number; badPercent: number; unavailablePercent: number; support: EvidenceSupport }
  decisions: JobDecisionCard[]; presses: FleetPressResult[]; radiusLossComparison: FleetRadiusLossComparison[]; predecessorRanking: TransitionSummary[]; transitionMatrix: FleetTransitionMatrixCell[]
  historicalRuns: { items: HistoricalRunSummary[]; total: number; offset: number; limit: number; hasMore: boolean; sort: HistoricalRunSort }
  coverage: Array<{ pressKey: RadiusPressKey; fields: JobIdentityCoverage[]; limitation: string | null }>; limitations: string[]
}

export interface JobRunInspector {
  version: 'job-intelligence-run-v3'; algorithmVersion: string; support: EvidenceSupport
  run: {
    runId: string; pressKey: RadiusPressKey; startUtc: string; endUtc: string; durationSeconds: number
    identities: ProductionRun['identities']; previousIdentities: ProductionRun['previousIdentities']
    goodPercent: number; makeReadyPercent: number; badPercent: number; unavailablePercent: number
    transitionSeconds: number | null; interruptions: number; medianRunningSpeed: number | null; runningSpeedUnit: string | null
    identityConfidence: ProductionRun['identityConfidence']; dataInterrupted: boolean
    identityTransition: ProductionRun['identityTransition']; transitionTiming: ProductionRun['transitionTiming']; deckConfiguration: ProductionRun['deckConfiguration']
    mainRadiusLosses: JobRunLossAggregate[]
  }
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
