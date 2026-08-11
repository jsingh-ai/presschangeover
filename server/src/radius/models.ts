export const RADIUS_PRESS_KEYS = [
  'press3',
  'press5',
  'press6',
  'press7',
  'press8',
  'press9',
  'press10',
  'press11',
  'press12',
  'press13',
  'press14',
  'press15',
] as const

export type RadiusPressKey = (typeof RADIUS_PRESS_KEYS)[number]

export interface RadiusPressMapping {
  pressKey: RadiusPressKey
  displayName: string
  machineId: number
}

export type RadiusObservationSourceGeneration = 'legacy' | 'compact' | 'current'
export type RadiusSegmentSourceGeneration =
  | 'legacy'
  | 'compact'
  | 'hybrid'
  | 'offline_inference'

export interface RadiusObservation {
  machineId: number
  eventType: string
  fetchedAtUtc: string
  statusCode: string | null
  statusDescription: string
  sourceGeneration: RadiusObservationSourceGeneration
}

export interface RadiusPollRun {
  fetchedAtUtc: string
  machineCount: number
  changedMachineCount: number
  staleMachineCount: number
}

export interface RadiusCurrentState extends RadiusObservation {
  isPresent: boolean
}

export type ReturnToProductionState = 'failed' | 'pending' | 'confirmed'

export interface StateBreakdownRunQualification {
  state: 'short' | 'pending' | 'sustained'
  returnUtc: string | null
  confirmationSatisfiedUtc: string | null
}

interface BaseRadiusTimelineSegment {
  machineId: number
  pressKey: RadiusPressKey
  displayName: string
  startUtc: string
  endUtc: string
  durationSeconds: number
  isOpen: boolean
  sourceGeneration: RadiusSegmentSourceGeneration
}

export interface RadiusStateSegment extends BaseRadiusTimelineSegment {
  kind: 'radius'
  eventType: string
  statusCode: string | null
  statusDescription: string
  isProduction: boolean
  returnToProduction?: ReturnToProductionState
  stateBreakdownRunQualification?: StateBreakdownRunQualification
  classification?: ResolvedRadiusClassification
}

export interface RadiusOfflineSegment extends BaseRadiusTimelineSegment {
  kind: 'offline'
  eventType: null
  statusCode: null
  statusDescription: null
  isProduction: false
}

export type RadiusStatusSegment = RadiusStateSegment | RadiusOfflineSegment

export type RadiusAvailability = 'online' | 'offline'
export type RadiusFeedStatus = 'ONLINE' | 'DEGRADED' | 'OFFLINE'
export type EpisodeCompletionStatus =
  | 'OPEN'
  | 'CONFIRMED_PRODUCTION'
  | 'DATA_INTERRUPTED'

export interface LastRadiusStatus {
  eventType: string
  statusCode: string | null
  statusDescription: string
  observedAtUtc: string
}

export interface OperationalEpisode {
  episodeId: string
  pressKey: RadiusPressKey
  displayName: string
  radiusMachineId: number
  startUtc: string
  endUtc: string | null
  durationSeconds: number
  isOpen: boolean
  completionStatus: EpisodeCompletionStatus
  dataInterrupted: boolean
  startedAfterDataGap: boolean
  startedBeforeRange: boolean
  startStatus: string
  statusSegments: RadiusStateSegment[]
  displaySegments: RadiusStatusSegment[]
  displayEndUtc: string | null
  wallClockDurationSeconds: number
  observedDurationSeconds: number
  unavailableDurationSeconds: number
  returnToProductionAttemptCount: number
  failedReturnToProductionAttempts: number
  confirmedProductionStartUtc: string | null
  confirmationSatisfiedUtc: string | null
  confirmationDurationSeconds: number
  timeByEventType: Record<string, number>
  timeByStatusDescription: Record<string, number>
  primaryStatusDescription: string
}

export interface EpisodeStateSummary {
  eventType: string
  statusDescription: string
  count: number
  percentage: number
  medianDwellSeconds: number
}

export interface EpisodeSequenceFamily {
  sequenceKey: string
  states: string[]
  count: number
  percentage: number
  medianDurationSeconds: number
}

export interface EpisodeTransitionSummary {
  fromStatusDescription: string
  outcomes: EpisodeStateSummary[]
}

export interface EpisodePhaseBenchmark {
  eventType: string
  statusDescription: string
  sampleCount: number
  medianDurationSeconds: number
  p90DurationSeconds: number | null
}

export interface EpisodeAttentionItem {
  episodeId: string
  pressKey: RadiusPressKey
  startUtc: string
  descriptor: string
  reasons: string[]
}

export interface PressEpisodeAnalysis {
  episodeCount: number
  episodeProfiles: Array<{
    episodeId: string
    descriptor: string
    sequenceKey: string
    sequenceStates: string[]
  }>
  medianDurationSeconds: number | null
  p75DurationSeconds: number | null
  p90DurationSeconds: number | null
  firstStates: EpisodeStateSummary[]
  finalStatesBeforeSuccess: EpisodeStateSummary[]
  sequenceFamilies: EpisodeSequenceFamily[]
  transitionSummaries: EpisodeTransitionSummary[]
  phaseBenchmarks: EpisodePhaseBenchmark[]
  mostTimeConsumingPhase: EpisodeStateSummary | null
  failedReturns: {
    completedEpisodeCount: number
    successfulFirstReturnCount: number
    oneFailedReturnCount: number
    multipleFailedReturnCount: number
    firstReturnSuccessRate: number | null
  }
  attentionItems: EpisodeAttentionItem[]
}

export interface CrossPressSequenceFamily {
  sequenceKey: string
  states: string[]
  totalCount: number
  comparable: boolean
  insufficientSampleReason: string | null
  presses: Array<{
    pressKey: RadiusPressKey
    displayName: string
    episodeCount: number
    medianDurationSeconds: number
    medianPhaseDurationSeconds: number
    failedReturnRate: number
  }>
}

export interface FleetEpisodeAnalysis {
  sequenceFamilies: CrossPressSequenceFamily[]
}

export interface AnalyticsStatusRef {
  identity: string
  eventType: string
  category: string
  statusCode: string | null
  statusDescription: string
}

export interface AnalyticsEvidenceInterval {
  pressKey: RadiusPressKey
  displayName: string
  startUtc: string
  endUtc: string
  durationSeconds: number
  leftCensored: boolean
  rightCensored: boolean
  previousStatus: AnalyticsStatusRef | null
  nextStatus: AnalyticsStatusRef | null
}

export interface OperationalCategorySummary {
  eventType: string
  category: string
  durationSeconds: number
  percentageOfObserved: number
  percentageOfPossible: number
  occurrenceCount: number
  productionSeconds: number
}

export interface OperationalStatusDriver extends AnalyticsStatusRef {
  durationSeconds: number
  percentageOfObserved: number
  percentageWithinCategory: number
  occurrenceCount: number
  medianOccurrenceSeconds: number
  p90OccurrenceSeconds: number | null
  pressCount: number
  scopePressCount: number
  clippedOccurrenceCount: number
  evidence: AnalyticsEvidenceInterval[]
}

export interface OperationalRelationshipOutcome {
  target: AnalyticsStatusRef
  numerator: number
  denominator: number
  percentage: number
  pressCount: number
  medianLagSeconds: number
  p90LagSeconds: number | null
  lowSupport: boolean
  evidence: AnalyticsEvidenceInterval[]
}

export interface OperationalRelationshipGroup {
  anchor: AnalyticsStatusRef
  direction: 'after' | 'before'
  maxTransitions: 1 | 2 | 3
  denominator: number
  censoredCount: number
  outcomes: OperationalRelationshipOutcome[]
}

export interface OperationalPathSummary {
  states: AnalyticsStatusRef[]
  count: number
  denominator: number
  percentage: number
  pressCount: number
  medianElapsedSeconds: number
  p90ElapsedSeconds: number | null
  lowSupport: boolean
}

export interface OperationalPatternSummary {
  anchorCount: number
  resolvedCount: number
  censoredCount: number
  outcomes: OperationalRelationshipOutcome[]
  paths: OperationalPathSummary[]
}

export interface MakeReadyPatternSummary extends OperationalPatternSummary {
  confirmedProductionCount: number
  returnedToMakeReadyCount: number
  enteredBadCount: number
  enteredSafetyCount: number
  failedToReachConfirmedProductionCount: number
  unresolvedCount: number
  medianSecondsToConfirmedProduction: number | null
  p90SecondsToConfirmedProduction: number | null
}

export interface OperationalPatternAnomaly {
  anomalyId: string
  pressKey: RadiusPressKey
  displayName: string
  observedAtUtc: string
  actualSequence: AnalyticsStatusRef[]
  expectedSequence: AnalyticsStatusRef[]
  normalNumerator: number
  normalDenominator: number
  observedCount: number
  durationDifferenceSeconds: number | null
  reason: string
  lowSupport: boolean
}

export interface OperationalAnalytics {
  fromUtc: string
  toUtc: string
  scopePressKeys: RadiusPressKey[]
  scopePressCount: number
  annotationDisclaimer: string
  coverage: {
    possibleSeconds: number
    observedSeconds: number
    unknownSeconds: number
    coveragePercentage: number
  }
  categories: OperationalCategorySummary[]
  statusDrivers: OperationalStatusDriver[]
  productionStops: OperationalPatternSummary
  beforeSuccessfulProduction: OperationalPatternSummary
  afterMakeReady: MakeReadyPatternSummary
  relationshipGroups: OperationalRelationshipGroup[]
  anomalies: OperationalPatternAnomaly[]
}

export interface RadiusPressOverview {
  pressKey: RadiusPressKey
  displayName: string
  radiusMachineId: number
  availability: RadiusAvailability
  lastRadiusStatus: LastRadiusStatus | null
  lastObservationUtc: string | null
  offlineSinceUtc: string | null
  currentStatusDescription: string | null
  currentEventType: string | null
  currentStatusAtUtc: string | null
  isCurrentlyProduction: boolean | null
  runProductionSeconds: number
  nonProductionSeconds: number
  offlineSeconds: number
  observedSeconds: number
  rangeSeconds: number
  dataCoveragePercent: number
  episodeCount: number
  openEpisodeCount: number
  longestEpisodeSeconds: number
  timelineSegments: RadiusStatusSegment[]
}

export interface RadiusOverview {
  fromUtc: string
  toUtc: string
  plantTimeZone: string
  productionStatusDescription: string
  stateBreakdownRunConfirmationSeconds: number
  rangeEndIsLive: boolean
  feedStatus: RadiusFeedStatus
  lastObservationUtc: string | null
  offlinePressCount: number
  onlinePressCount: number
  summary: {
    pressesMonitored: number
    currentlyRunProduction: number
    currentlyNonProduction: number
    openEpisodes: number
    totalNonProductionSeconds: number
  }
  unmappedPressKeys: RadiusPressKey[]
  presses: RadiusPressOverview[]
  episodeAnalysis: FleetEpisodeAnalysis
  operationalAnalytics: OperationalAnalytics
  classificationVersion?: number
  operationalGroups?: import('../classification/models.js').OperationalGroup[]
}

export type RunComparisonDirection = 'faster' | 'slower' | 'typical' | 'longer' | 'shorter' | 'low_support'

export interface RunBenchmarkStats {
  sampleRuns: number
  samplePresses: number
  sufficientSupport: boolean
  average: number | null
  median: number | null
  delta: number | null
  percentDelta: number | null
  percentile: number | null
}

export interface OperationalRunSegment {
  segmentId: string
  exactIdentity: string | null
  eventType: string | null
  statusCode: string | null
  statusDescription: string | null
  startUtc: string
  endUtc: string
  durationSeconds: number
  phase: 'pre-production' | 'production'
  isUnavailable: boolean
  isShortRunAttempt: boolean
}

export interface OperationalRunStatusSummary {
  exactIdentity: string
  eventType: string
  statusCode: string | null
  statusDescription: string
  totalDurationSeconds: number
  preProductionDurationSeconds: number
  occurrenceCount: number
  preProductionContributionPercent: number | null
  samePress: RunBenchmarkStats & {
    eligibleRuns: number
    containingRuns: number
    occurrenceFrequencyPercent: number | null
    typicalOccurrenceCount: number | null
    occurrenceDelta: number | null
    direction: 'longer' | 'shorter' | 'typical' | 'low_support'
  }
  fleet: RunBenchmarkStats
}

export interface OperationalRunContributor {
  exactIdentity: string
  statusDescription: string
  excessSeconds: number
  segmentIds: string[]
}

export interface OperationalRun {
  runId: string
  sequenceNumber: number
  pressKey: RadiusPressKey
  displayName: string
  startUtc: string
  endUtc: string
  productionStartUtc: string | null
  timeToProductionSeconds: number | null
  productionDurationSeconds: number
  totalDurationSeconds: number
  transitionCount: number
  distinctStatusCount: number
  shortRunAttemptCount: number
  shortRunAttemptDurationSeconds: number
  isPartial: boolean
  dataInterrupted: boolean
  eligibleForBenchmark: boolean
  segments: OperationalRunSegment[]
  timeToProductionBenchmark: {
    direction: 'faster' | 'slower' | 'typical' | 'low_support'
    samePress: RunBenchmarkStats
    fleet: RunBenchmarkStats
  }
  productionDurationBenchmark: {
    direction: 'longer' | 'shorter' | 'typical' | 'low_support'
    samePress: RunBenchmarkStats
  }
  transitionBenchmark: RunBenchmarkStats
  shortAttemptCountBenchmark: RunBenchmarkStats
  shortAttemptDurationBenchmark: RunBenchmarkStats
  statusSummaries: OperationalRunStatusSummary[]
  contributors: OperationalRunContributor[]
  sequenceComparison: {
    commonSequence: string[]
    runSequence: string[]
    variation: boolean
    sufficientSupport: boolean
  }
  flags: string[]
  rank: {
    timeToProduction: number | null
    productionDuration: number | null
    comparableRuns: number
  }
}

export interface OperationalRunComparison {
  pressKey: RadiusPressKey
  displayName: string
  fromUtc: string
  toUtc: string
  confirmationSeconds: number
  samePressMinimumRuns: number
  fleetMinimumPresses: number
  fleetMinimumRuns: number
  similarRelativeTolerance: number
  similarAbsoluteSeconds: number
  runs: OperationalRun[]
}

export interface RadiusPressEpisodes {
  fromUtc: string
  toUtc: string
  plantTimeZone: string
  stateBreakdownRunConfirmationSeconds: number
  rangeEndIsLive: boolean
  press: RadiusPressMapping
  availability: RadiusAvailability
  lastRadiusStatus: LastRadiusStatus | null
  lastObservationUtc: string | null
  offlineSinceUtc: string | null
  currentStatusDescription: string | null
  currentEventType: string | null
  currentStatusAtUtc: string | null
  isCurrentlyProduction: boolean | null
  timelineSegments: RadiusStatusSegment[]
  episodes: OperationalEpisode[]
  analysis: PressEpisodeAnalysis
  operationalAnalytics: OperationalAnalytics
  runComparison: OperationalRunComparison
  classificationVersion?: number
  operationalGroups?: import('../classification/models.js').OperationalGroup[]
  summary: {
    episodeCount: number
    openEpisodeCount: number
    totalNonProductionSeconds: number
    runProductionSeconds: number
    offlineSeconds: number
    observedSeconds: number
    rangeSeconds: number
    dataCoveragePercent: number
    averageEpisodeSeconds: number
    longestEpisodeSeconds: number
  }
}

export interface RadiusHealth {
  status: 'healthy' | 'unavailable'
  configured: boolean
  database?: string
  schema?: string
  table?: string
  tables?: string[]
  reason?: 'not_configured' | 'connection_failed' | 'unsafe_privileges' | 'schema_mismatch'
}
import type { ResolvedRadiusClassification } from '../classification/models.js'
