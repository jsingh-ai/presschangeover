export type ServiceStatus = 'loading' | 'healthy' | 'unavailable'

export interface ProcessIntelligenceHealth {
  service: 'ProcessIntelligence'
  status: string
}

export interface TelemetryHealth {
  status: string
  telemetryApi: {
    status: string
  }
  historian: {
    status: string
    database: string
  }
}

export interface TelemetrySource {
  id: number
  sourceKey: string
  displayName: string
  enabled: boolean
}

export type PhysicalState =
  | 'RUNNING'
  | 'STOPPED'
  | 'TRANSITION'
  | 'UNKNOWN'

export interface PhysicalStateSummary {
  durationsMs: Record<PhysicalState, number>
  segmentCount: number
}

export interface PhysicalStateResponse {
  sourceId: number
  sourceKey: string
  displayName: string
  fromUtc: string
  toUtc: string
  summary: PhysicalStateSummary
  segments: Array<{
    state: PhysicalState
    fromUtc: string
    toUtc: string
    durationMs: number
  }>
}

export type RadiusPressKey =
  | 'press3'
  | 'press5'
  | 'press6'
  | 'press7'
  | 'press8'
  | 'press9'
  | 'press10'
  | 'press11'
  | 'press12'
  | 'press13'
  | 'press14'
  | 'press15'

export interface RadiusHealth {
  status: 'healthy' | 'unavailable'
  configured: boolean
  database?: string
  schema?: string
  table?: string
  tables?: string[]
  reason?: string
}

export type ReturnToProductionState = 'failed' | 'pending' | 'confirmed'

export type OperationalGroupKey = 'PRODUCTION' | 'CHANGEOVER_SETUP' | 'ROUTINE_PROCESS' | 'ADJUSTMENT_QUALITY' | 'WAITING_IDLE_HOLD' | 'FAULT_RECOVERY' | 'MAINTENANCE_INTERVENTION' | 'ADMIN_UNKNOWN'
export type ProcessFamilyKey = 'PRODUCTION' | 'MAKE_READY' | 'CLEANING_WASH' | 'ROLL_MATERIAL' | 'SLEEVES_PLATES' | 'ANILOX' | 'DOCTOR_BLADE_CHAMBER' | 'INK_COLOR' | 'IMPRESSION_REGISTER_PRINT_QUALITY' | 'SUBSTRATE' | 'WEB_HANDLING_WEB_BREAK' | 'QUALITY_APPROVAL' | 'MECHANICAL_ELECTRICAL' | 'MAINTENANCE' | 'TRIAL_ADMINISTRATIVE' | 'UNKNOWN'
export type MappingConfidence = 'HIGH' | 'MEDIUM' | 'LOW'
export interface OperationalGroup { id: string; key: OperationalGroupKey; displayName: string; description: string; lightColor: string; darkColor: string; icon: string; sortOrder: number }
export interface ProcessFamily { id: string; key: ProcessFamilyKey; displayName: string; description: string; sortOrder: number }
export interface ResolvedRadiusClassification {
  identity: string; eventType: string; statusCode: string | null; statusDescription: string
  operationalGroupId: string; operationalGroupKey: OperationalGroupKey; operationalGroupName: string; operationalGroupDescription: string; operationalGroupLightColor: string; operationalGroupDarkColor: string; operationalGroupIcon: string
  processFamilyId: string; processFamilyKey: ProcessFamilyKey; processFamilyName: string
  displayLabel: string | null; explanation: string; confidence: MappingConfidence; needsReview: boolean; defaultTimelineVisibility: boolean; obsolete: boolean; mappingVersion: number; isFallback: boolean
}

export interface StateBreakdownRunQualification {
  state: 'short' | 'pending' | 'sustained'
  returnUtc: string | null
  confirmationSatisfiedUtc: string | null
}
export type RadiusSegmentSourceGeneration =
  | 'legacy'
  | 'compact'
  | 'hybrid'
  | 'offline_inference'

interface BaseRadiusStatusSegment {
  machineId: number
  pressKey: RadiusPressKey
  displayName: string
  startUtc: string
  endUtc: string
  durationSeconds: number
  isOpen: boolean
  sourceGeneration: RadiusSegmentSourceGeneration
}

export interface RadiusStateSegment extends BaseRadiusStatusSegment {
  kind: 'radius'
  eventType: string
  statusCode: string | null
  statusDescription: string
  isProduction: boolean
  returnToProduction?: ReturnToProductionState
  stateBreakdownRunQualification?: StateBreakdownRunQualification
  classification?: ResolvedRadiusClassification
}

export interface RadiusOfflineSegment extends BaseRadiusStatusSegment {
  kind: 'offline'
  eventType: null
  statusCode: null
  statusDescription: null
  isProduction: false
}

export type RadiusStatusSegment = RadiusStateSegment | RadiusOfflineSegment
export type RadiusAvailability = 'online' | 'offline'
export type RadiusFeedStatus = 'ONLINE' | 'DEGRADED' | 'OFFLINE'
export type EpisodeCompletionStatus = 'OPEN' | 'CONFIRMED_PRODUCTION' | 'DATA_INTERRUPTED'

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
  enteredSStateCount: number
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

export type OverviewRankingExclusionReason = 'coverage_below_80_percent' | 'observed_time_below_30_minutes'
export interface OverviewPressContribution {
  pressKey: RadiusPressKey; displayName: string; durationSeconds: number; shareOfCategoryPercent: number
}
export interface OverviewFamilyAllocation {
  key: string; name: string; durationSeconds: number; nonProductionSeconds: number
  shareOfGroupPercent: number; shareOfRadiusStatePercent: number; shareOfObservedPercent: number
  sourceIdentityCount: number; needsClassification: boolean; pressContributions: OverviewPressContribution[]
}
export interface OverviewGroupAllocation {
  key: string; name: string; description: string; lightColor: string; darkColor: string
  durationSeconds: number; shareOfRadiusStatePercent: number; shareOfObservedPercent: number; nonProductionSeconds: number
  families: OverviewFamilyAllocation[]; needsClassification: boolean; pressContributions: OverviewPressContribution[]
}
export interface OverviewRadiusStateAllocation {
  eventType: string; displayLabel: string; durationSeconds: number; shareOfObservedPercent: number
  canonicalProductionSeconds: number; nonProductionSeconds: number; nonProductionShareOfObservedPercent: number
  operationalGroups: OverviewGroupAllocation[]; largestNonProductionGroupKey: string | null; largestNonProductionFamilyKey: string | null
}
export type OverviewTimelineClassificationStatus = 'mapped' | 'needs_classification' | 'unavailable'
export interface OverviewTimelineInterval {
  intervalId: string; startUtc: string; endUtc: string; durationSeconds: number; isUnavailable: boolean
  eventType: string | null; statusCode: string | null; statusDescription: string | null; radiusStateLabel: string; operationalGroupKey: string | null; operationalGroupLabel: string
  operationalGroupLightColor: string | null; operationalGroupDarkColor: string | null
  processFamilyKey: string | null; processFamilyLabel: string | null; classificationNeedsReview: boolean; classificationStatus: OverviewTimelineClassificationStatus
}
export interface OverviewPressAllocation {
  pressKey: RadiusPressKey; displayName: string; wallClockSeconds: number; observedSeconds: number; unavailableSeconds: number
  coveragePercent: number; productionSeconds: number; productionSharePercent: number | null
  nonProductionSeconds: number; nonProductionSharePercent: number | null; fleetProductionRank: number | null
  productionDeltaVsFleetMedianPoints: number | null; rankingEligible: boolean; rankingExclusionReason: OverviewRankingExclusionReason | null
  classificationCoveragePercent: number; needsClassificationSeconds: number; largestNonProductionRadiusStateEventType: string | null
  radiusStateBreakdown: OverviewRadiusStateAllocation[]; timelineIntervals: OverviewTimelineInterval[]
}
export interface OverviewDecisionSupport {
  minimumCoveragePercent: 80; minimumObservedSeconds: 1800; classificationVersion: number
  fleetSummary: {
    wallClockSeconds: number; observedSeconds: number; unavailableSeconds: number; coveragePercent: number
    productionSeconds: number; productionSharePercent: number | null; nonProductionSeconds: number; nonProductionSharePercent: number | null
    rankablePressCount: number; pressCount: number; productionMedianPercent: number | null
    classificationCoveragePercent: number; needsClassificationSeconds: number; largestNonProductionRadiusStateEventType: string | null
  }
  pressAllocations: OverviewPressAllocation[]; rankingPressKeys: RadiusPressKey[]; topRunningPressKeys: RadiusPressKey[]
  needsAttentionPressKeys: RadiusPressKey[]; fleetRadiusStateBreakdown: OverviewRadiusStateAllocation[]
  focusItems: string[]; excludedPressKeys: RadiusPressKey[]
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
  episodeAnalysis?: FleetEpisodeAnalysis
  operationalAnalytics?: OperationalAnalytics
  classificationVersion?: number
  operationalGroups?: OperationalGroup[]
  decisionSupport?: OverviewDecisionSupport
}

export type RunComparisonDirection = 'faster' | 'slower' | 'typical' | 'longer' | 'shorter' | 'low_support'
export interface RunBenchmarkStats { sampleRuns: number; samplePresses: number; sufficientSupport: boolean; average: number | null; median: number | null; delta: number | null; percentDelta: number | null; percentile: number | null }
export interface OperationalRunSegment { segmentId: string; exactIdentity: string | null; eventType: string | null; statusCode: string | null; statusDescription: string | null; startUtc: string; endUtc: string; durationSeconds: number; phase: 'pre-production' | 'production'; isUnavailable: boolean; isShortRunAttempt: boolean; operationalGroupKey?: string | null; operationalGroupName?: string | null; processFamilyKey?: string | null; processFamilyName?: string | null; classificationStatus?: 'mapped' | 'needs_classification' | 'unavailable' }
export interface OperationalRunStatusSummary {
  exactIdentity: string; eventType: string; statusCode: string | null; statusDescription: string; totalDurationSeconds: number; preProductionDurationSeconds: number; occurrenceCount: number; preProductionContributionPercent: number | null
  samePress: RunBenchmarkStats & { eligibleRuns: number; containingRuns: number; occurrenceFrequencyPercent: number | null; typicalOccurrenceCount: number | null; occurrenceDelta: number | null; direction: 'longer' | 'shorter' | 'typical' | 'low_support' }
  fleet: RunBenchmarkStats
}
export interface OperationalRunContributor { exactIdentity: string; statusDescription: string; excessSeconds: number; segmentIds: string[] }
export interface OperationalRun {
  runId: string; sequenceNumber: number; pressKey: RadiusPressKey; displayName: string; startUtc: string; endUtc: string; productionStartUtc: string | null; timeToProductionSeconds: number | null; productionDurationSeconds: number; totalDurationSeconds: number; transitionCount: number; distinctStatusCount: number; shortRunAttemptCount: number; shortRunAttemptDurationSeconds: number; isPartial: boolean; dataInterrupted: boolean; eligibleForBenchmark: boolean; segments: OperationalRunSegment[]
  timeToProductionBenchmark: { direction: 'faster' | 'slower' | 'typical' | 'low_support'; samePress: RunBenchmarkStats; fleet: RunBenchmarkStats }
  productionDurationBenchmark: { direction: 'longer' | 'shorter' | 'typical' | 'low_support'; samePress: RunBenchmarkStats }
  transitionBenchmark: RunBenchmarkStats; shortAttemptCountBenchmark: RunBenchmarkStats; shortAttemptDurationBenchmark: RunBenchmarkStats
  statusSummaries: OperationalRunStatusSummary[]; contributors: OperationalRunContributor[]
  sequenceComparison: { commonSequence: string[]; runSequence: string[]; variation: boolean; sufficientSupport: boolean }
  flags: string[]; rank: { timeToProduction: number | null; productionDuration: number | null; comparableRuns: number }
}
export interface OperationalRunComparison { pressKey: RadiusPressKey; displayName: string; fromUtc: string; toUtc: string; confirmationSeconds: number; samePressMinimumRuns: number; fleetMinimumPresses: number; fleetMinimumRuns: number; similarRelativeTolerance: number; similarAbsoluteSeconds: number; runs: OperationalRun[] }

export type ActivityLevel = 'radius_state' | 'operational_group' | 'process_family' | 'exact_status'
export interface ActivitySelection { level: ActivityLevel; key: string; label: string; operationalGroupKey?: string | null }
export interface ActivityCatalogItem extends ActivitySelection { description: string | null; eventType: string | null; statusCode: string | null; statusDescription: string | null; operationalGroupKey: string | null; operationalGroupName: string | null; processFamilyKey: string | null; processFamilyName: string | null; needsClassification: boolean; durationSeconds?: number; percentageOfObservedTime?: number }
export interface ActivityOccurrenceSegment { segmentId: string; startUtc: string; endUtc: string; durationSeconds: number; eventType: string; statusCode: string | null; statusDescription: string; operationalGroupKey: string; operationalGroupName: string; processFamilyKey: string; processFamilyName: string; needsClassification: boolean }
export interface ActivityOccurrence { occurrenceId: string; pressKey: RadiusPressKey; displayName: string; startUtc: string; endUtc: string; durationSeconds: number; eventType: string; radiusStateLabel: string; operationalGroupKey: string; operationalGroupName: string; processFamilyKey: string; processFamilyName: string; segments: ActivityOccurrenceSegment[]; exactIdentities: Array<{ identity: string; eventType: string; statusCode: string | null; statusDescription: string; durationSeconds: number; needsClassification: boolean }> }
export interface ActivityAnalysis {
  fromUtc: string; toUtc: string; classificationVersion: number; selection: ActivityCatalogItem; catalog: ActivityCatalogItem[]
  summary: { totalDurationSeconds: number; occurrenceCount: number; medianOccurrenceSeconds: number | null; p95OccurrenceSeconds: number | null; longestOccurrenceSeconds: number; pressesObserved: number; scopePresses: number; shareOfObservedPercent: number; sourceCoveragePercent: number; classificationCoveragePercent: number }
  pressBreakdown: Array<{ pressKey: RadiusPressKey; displayName: string; durationSeconds: number; occurrenceCount: number; medianOccurrenceSeconds: number | null; shareOfObservedPercent: number; coveragePercent: number }>
  pressTimelines: Array<{ pressKey: RadiusPressKey; displayName: string; timelineIntervals: OverviewTimelineInterval[] }>
  radiusStateComposition: Array<{ eventType: string; label: string; durationSeconds: number; percentage: number }>
  semanticBreakdown: Array<{ key: string; label: string; level: 'operational_group' | 'process_family' | 'exact_status'; durationSeconds: number; percentage: number }>
  trend: Array<{ bucketStartUtc: string; durationSeconds: number; occurrenceCount: number }>; trendBucket: 'hour' | 'day'
  durationDistribution: Array<{ key: string; label: string; occurrenceCount: number }>; occurrences: ActivityOccurrence[]; totalOccurrenceCount: number; evidenceOffset: number; evidenceLimit: number
}
export type PatternMatchMode = 'contains_all' | 'in_order'
export interface RunPatternEvidence { runId: string; pressKey: RadiusPressKey; displayName: string; startUtc: string; endUtc: string; totalDurationSeconds: number; timeToProductionSeconds: number | null; productionDurationSeconds: number; shortRunAttemptCount: number; transitionCount: number; isPartial: boolean; dataInterrupted: boolean; eligible: boolean; groupSequence: string[]; familySequence: string[]; selectedActivitySeconds: number; conditionDurations: Array<{ conditionKey: string; durationSeconds: number }> }
export interface PatternSummary { patternKey: string; classificationVersion: number; orderedGroupKeys: string[]; orderedGroupLabels: string[]; runCount: number; runSharePercent: number; pressesObserved: number; medianTimeToProductionSeconds: number | null; medianPreProductionSeconds: number | null; medianProductionSeconds: number | null; shortAttemptRunCount: number; matchedRunIds: string[]; containsReentry: boolean; pressStats: Array<{ pressKey: RadiusPressKey; displayName: string; matchedRuns: number; eligibleRuns: number; matchRatePercent: number; medianTimeToProductionSeconds: number | null }>; familyVariations: Array<{ orderedFamilyKeys: string[]; orderedFamilyLabels: string[]; runCount: number; runShareWithinPatternPercent: number }> }
export interface PatternAnalysis {
  fromUtc: string; toUtc: string; classificationVersion: number; catalog: ActivityCatalogItem[]; totalRuns: number; eligibleRuns: number; excludedPartialRuns: number; excludedInterruptedRuns: number; excludedOpenRuns: number; patternCriteria: { minimumSteps: number; minimumRuns: number }; observedJourneyCount: number; patternedRuns: number; patternedRunSharePercent: number; simpleJourneyRuns: number; oneOffJourneyRuns: number; uniquePatternCount: number; shortAttemptRuns: number; patterns: PatternSummary[]; selectedPattern: PatternSummary | null; recentRuns: RunPatternEvidence[]; matchedRuns: RunPatternEvidence[]; evidenceLimit: number
  builder: null | { conditions: ActivityCatalogItem[]; matchMode: PatternMatchMode; ready: boolean; minimumConditions: number; redundantConditionMessage: string | null; matchedRuns: number; matchSharePercent: number; pressesObserved: number; medianTimeToProductionSeconds: number | null; medianSelectedActivitySeconds: number | null; totalSelectedActivitySeconds: number; pressStats: Array<{ pressKey: RadiusPressKey; displayName: string; matchedRuns: number; eligibleRuns: number; matchRatePercent: number; selectedActivitySeconds: number; medianTimeToProductionSeconds: number | null }>; topPatterns: Array<{ patternKey: string; labels: string[]; runCount: number; percentageOfMatches: number }> }
}

export interface RadiusPressEpisodes {
  fromUtc: string
  toUtc: string
  plantTimeZone: string
  stateBreakdownRunConfirmationSeconds: number
  rangeEndIsLive: boolean
  press: {
    pressKey: RadiusPressKey
    displayName: string
    machineId: number
  }
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
  operationalGroups?: OperationalGroup[]
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

export interface RadiusStateClassification {
  identity: string; eventType: string; statusCode: string | null; statusDescription: string
  operationalGroupId: string; operationalGroupKey: OperationalGroupKey; processFamilyId: string; processFamilyKey: ProcessFamilyKey
  displayLabel: string | null; explanation: string; confidence: MappingConfidence; needsReview: boolean; defaultTimelineVisibility: boolean; obsolete: boolean
}
export interface ClassificationDraft { baseVersion: number; revision: number; updatedAtUtc: string; updatedBy: string; groups: OperationalGroup[]; families: ProcessFamily[]; classifications: RadiusStateClassification[]; changes: Array<{ action: string; target: string; summary: string; atUtc: string; actor: string }> }
export interface ClassificationSnapshot { version: number; publishedAtUtc: string | null; publishedBy: string | null; groups: OperationalGroup[]; families: ProcessFamily[]; classifications: RadiusStateClassification[] }
export interface ClassificationWorkspace {
  published: ClassificationSnapshot; draft: ClassificationDraft | null; effectiveGroups: OperationalGroup[]
  effectiveClassifications: Array<RadiusStateClassification & { eventCount: number; lastSeenUtc: string | null; isFallback: boolean }>
  observedIdentities: Array<{ identity: string; eventType: string; statusCode: string | null; statusDescription: string; eventCount: number; lastSeenUtc: string | null }>
  families: ProcessFamily[]; versions: Array<{ version: number; publishedAtUtc: string; publishedBy: string; changeCount: number }>
  audit: Array<{ id: string; version: number | null; action: string; target: string; summary: string; actor: string; atUtc: string }>
  unmappedCount: number; reviewRequiredCount: number; canEdit: boolean; actor: string | null; persistence: 'postgresql' | 'memory'
  observedIdentityStatus: 'fresh' | 'cached' | 'unavailable'; observedIdentityAsOf: string | null
}

export interface ClassificationSearchResult {
  id: string; type: 'group' | 'family' | 'exact_status'; title: string; score: number; matchReason: string; description: string | null
  groups: Array<{ key: OperationalGroupKey; displayName: string }>
  family: { key: ProcessFamilyKey; displayName: string } | null
  eventType: string | null; statusCode: string | null; statusDescription: string | null
  needsClassification: boolean; publishedClassification: boolean
}

export interface ClassificationSearchResponse {
  query: string; publishedVersion: number
  observedIdentityStatus: 'fresh' | 'cached' | 'unavailable'; observedIdentityAsOf: string | null
  results: ClassificationSearchResult[]
}
export interface ClassificationValidation { valid: boolean; errors: string[]; warnings: string[]; mappedCount: number; fallbackCount: number; reviewRequiredCount: number }

export type RawRadiusPhase = 'G' | 'B' | 'M' | 'S'
export type RawExplorerSignalType = 'continuous' | 'step_reference' | 'state_event'
export type RawExplorerCategory = 'speed' | 'web_tension' | 'dryer' | 'ink' | 'viscosity' | 'temperature' | 'pump' | 'wash' | 'register' | 'impression' | 'torque' | 'drive_temperature' | 'doctor_blade' | 'repeat_other' | 'motion'
export type RawTelemetryScalar = string | number | boolean | null
export type RawTelemetryValue = RawTelemetryScalar | RawTelemetryValue[] | { [key: string]: RawTelemetryValue }
export type RawTelemetryReviewStatus = 'UNREVIEWED' | 'USEFUL' | 'NEEDS_MAPPING' | 'IGNORE'

export interface RawUnmappedChangedSignal {
  rawIdentity: string
  displayName: string
  dataType: string
  dataKind: string
  sourceUnit: string | null
  discoveryCategory: string
  plottable: boolean
  usableObservationCount: number
  unavailableObservationCount: number
  firstValue: RawTelemetryValue
  lastValue: RawTelemetryValue
  minimum: number | null
  maximum: number | null
  changeCount: number
  largestAbsoluteStep: number | null
  positiveMovementPresent: boolean
  negativeMovementPresent: boolean
  transitionSequence: RawTelemetryValue[]
  transitionSequenceTruncated: boolean
  knownShape: string | null
  alternateRepresentationCount: number
  alternateRawIdentities: string[]
  reviewStatus: RawTelemetryReviewStatus
}

export interface RawUnmappedObservation {
  timestampUtc: string
  receivedAtUtc: string
  sourceTimestampUtc: string
  qualityState: string
  dataType: string
  rawValue: RawTelemetryValue
}

export interface RawUnmappedHistory {
  press: RadiusPressKey
  displayName: string
  rawIdentity: string
  signalDisplayName: string
  dataType: string
  dataKind: string
  sourceUnit: string | null
  plottable: boolean
  fromUtc: string
  toUtc: string
  historianReadCount: number
  alternateRepresentationCount: number
  alternateRawIdentities: string[]
  observations: RawUnmappedObservation[]
  reviewStatus: RawTelemetryReviewStatus
}

export interface RawTelemetryReview {
  press: RadiusPressKey
  rawIdentity: string
  reviewStatus: RawTelemetryReviewStatus
  createdAt: string
  updatedAt: string
}

export interface RawExplorerIdentity {
  identity: string
  eventType: RawRadiusPhase
  statusCode: string
  statusDescription: string
  eventCount: number
  lastSeenUtc: string | null
}

export interface RawExplorerSetup {
  fromUtc: string
  toUtc: string
  identity: Pick<RawExplorerIdentity, 'eventType' | 'statusCode' | 'statusDescription'>
  changeLookbackMinutes: number
  chartContextMinutes: number
}

export interface RawExplorerOccurrence {
  occurrenceId: string
  pressKey: RadiusPressKey
  displayName: string
  pressOccurrenceIndex: number
  pressOccurrenceCount: number
  eventType: string
  statusCode: string
  statusDescription: string
  startUtc: string
  endUtc: string
  durationSeconds: number
  chartFromUtc: string
  chartToUtc: string
}

export interface RawExplorerResult {
  setup: RawExplorerSetup
  summary: {
    totalOccurrences: number
    pressesContainingCode: number
    totalObservedDurationSeconds: number
    pressCounts: Array<{ pressKey: RadiusPressKey; displayName: string; occurrenceCount: number }>
  }
  occurrences: RawExplorerOccurrence[]
  performance: { totalMs: number; payloadBytes: number }
}

export interface RawExplorerSignalIdentity {
  canonicalId: string
  deckNumber: number | null
  friendlyName: string
  signalType: RawExplorerSignalType
  category: RawExplorerCategory
  scope: 'machine' | 'deck'
}

export interface RawExplorerNumericSummary {
  kind: 'numeric'
  firstValue: number
  lastValue: number
  netDelta: number
  minimum: number
  maximum: number
  largestPositiveExcursion: number
  largestNegativeExcursion: number
  largestAbsoluteExcursion: number
  observationCount: number
}

export interface RawExplorerStateSummary {
  kind: 'state'
  firstValue: RawTelemetryScalar
  lastValue: RawTelemetryScalar
  transitions: Array<{ atUtc: string; previousValue: RawTelemetryScalar; value: RawTelemetryScalar }>
}

export interface RawExplorerChangedSignal extends RawExplorerSignalIdentity {
  summary: RawExplorerNumericSummary | RawExplorerStateSummary
  sourceUnit: string | null
  canonicalUnitStatus: string | null
}

export interface RawTelemetrySample {
  observedAtUtc: string
  receivedAtUtc: string
  sourceTimestampUtc: string
  qualityState: string
  valueKind: string
  value: RawTelemetryScalar
}

export interface RawTelemetryChange extends RawTelemetrySample {
  previousObservedAtUtc: string
  previousReceivedAtUtc: string
  previousSourceTimestampUtc: string
  previousQualityState: string
  previousValueKind: string
  previousValue: RawTelemetryScalar
}

export interface ExplorerEvidenceQuality { supportCount: number; comparisonCount: number | null; coverage: number | null; comparisonCoverage: number | null; historicalSpan: { startUtc: string; endUtc: string } | null; contextMatchLevel: number | null; contextMatchDimensions: string[]; medianCadence: number | null; maximumGap: number | null; timingResolution: { minimumSeconds: number; maximumSeconds: number } | null; qualification: 'SUPPORTED' | 'LIMITED' | 'INSUFFICIENT'; excludedReason: string | null }
export interface RelatedSignalSuggestion { canonicalId: string; deckNumber: number | null; friendlyName: string; signalType: RawExplorerSignalType | string; category: RawExplorerCategory | string; scope: 'machine' | 'deck'; reasonCodes: string[]; reason: string; timingDetail: string | null }
export interface EvidencePhaseSummary { eventStartUtc: string; eventEndUtc: string; items: Array<{ phase: 'BACKGROUND' | 'PRECURSOR' | 'TARGET' | 'RESPONSE' | 'RECOVERY'; atUtc: string | null; label: string; detail: string | null; source: 'radius' | 'telemetry' | 'production_context'; canonicalId: string | null; deckNumber: number | null }>; limitations: string[] }
export interface BasicHistoricalSummary { scope: string; supportCount: number; timeSpan: { startUtc: string; endUtc: string } | null; metrics: Record<string, string | number | boolean | null>; evidenceQuality: ExplorerEvidenceQuality; limitations: string[]; performance?: { radiusQueryCount: number; historySliceCount?: number; rowsConsidered: number; matchingOccurrences: number; matchingOccurrencesAvailable: number; historyExaminedFromUtc?: string; historyExaminedToUtc?: string; historyComplete?: boolean; historyPartialReason?: 'QUERY_TIMEOUT' | null; totalMs: number; payloadBytes: number } }
export interface ExplorerAnalyticalObservation { family: string; metrics: Record<string, string | number | boolean | null>; support: { sampleCount: number; comparisonSampleCount: number | null; coveragePercent: number | null; comparisonCoveragePercent: number | null; adequate: boolean; minimumRequired: number; reason: string | null }; material: boolean; limitations: string[] }

export interface RadiusPhysicalAlignment {
  pressKey: RadiusPressKey; occurrenceId: string; recordedRadius: { eventType: string; statusCode: string | null; statusDescription: string }; recordedStartUtc: string; recordedEndUtc: string
  inferredPhysicalOnsetRange: { startUtc: string; endUtc: string } | null; inferredPhysicalExitRange: { startUtc: string; endUtc: string } | null; entryLagRange: { minimumSeconds: number; maximumSeconds: number } | null; exitLagRange: { minimumSeconds: number; maximumSeconds: number } | null
  speedEvidence: Array<{ canonicalId: 'machine.speed.actual'; observedAtUtc: string; referenceAtUtc: string; delta: number; sourceUnit: string | null }>; otherTelemetryEvidence: Array<{ canonicalId: string; deckNumber: number | null; observedAtUtc: string; reason: string }>; contextEvidence: Array<{ field: string; value: string | number | boolean }>; radiusSequenceEvidence: Array<{ eventType: string; statusCode: string | null; statusDescription: string; relationship: 'PREVIOUS' | 'CURRENT' | 'NEXT' }>; agreementClass: 'PHYSICAL_PRECEDES_RECORDED' | 'RECORDED_PRECEDES_PHYSICAL' | 'ALIGNED_WITHIN_CADENCE' | 'INDETERMINATE_WITHIN_CADENCE' | 'NO_SUPPORTED_PHYSICAL_EVIDENCE'; evidenceQuality: ExplorerEvidenceQuality
}

export interface RawExplorerDetail {
  occurrence: RawExplorerOccurrence
  lookback: { fromUtc: string; toUtc: string; halfOpen: true }
  radiusSegments: RadiusStatusSegment[]
  currentRollLength: RawExplorerSignalHistory | null
  speed: { sourceUnit: string | null; canonicalUnitStatus: string | null; samples: RawTelemetrySample[] }
  changedSignals: RawExplorerChangedSignal[]
  rawTelemetry: {
    status: 'available' | 'unavailable'
    signals: RawUnmappedChangedSignal[]
    counts: null | { rawCatalogIdentityCount: number; canonicallyRepresentedIdentityCount: number; unmappedIdentityCount: number; usableIdentityCount: number; changedIdentityCount: number }
    historianReadCount: number
  }
  evidence: {
    physicalAlignment: RadiusPhysicalAlignment
    productionContext: Array<{ field: string; value: string | number | boolean }>
    phaseSummary: EvidencePhaseSummary
    behavior: { signal: string; unit: string | null; before: Record<string, number> | null; during: Record<string, number> | null; after: Record<string, number> | null }
    radiusSequence: RadiusPhysicalAlignment['radiusSequenceEvidence']
    suggestedSignals: RelatedSignalSuggestion[]
  }
  performance: { totalMs: number; selectorCount: number; semanticHistoryRequests: number; speedHistoryMs: number; payloadBytes: number }
}

export interface RawExplorerSignalHistory extends RawExplorerSignalIdentity {
  representation: 'samples' | 'changes'
  sourceUnit: string | null
  canonicalUnitStatus: string | null
  seed: RawTelemetrySample | null
  samples: RawTelemetrySample[]
  changes: RawTelemetryChange[]
}

export interface RawExplorerPlotResult {
  signal: RawExplorerSignalHistory
  performance: { totalMs: number; semanticHistoryRequests: number; payloadBytes: number }
}

export interface RawUnmappedPlotResult {
  signal: RawUnmappedHistory
  performance: { totalMs: number; historianReadCount: number; payloadBytes: number }
}

export type TelemetryEventScalar = number | boolean | string
export type TelemetryEventSource = { kind: 'canonical'; canonicalId: string } | { kind: 'raw'; pressKey: RadiusPressKey; rawIdentity: string; displayName: string; dataType?: string; dataKind?: string }
export type TelemetryEventRule = { kind: 'threshold'; operator: '>' | '>=' | '<' | '<='; threshold: number } | { kind: 'delta'; direction: 'increase' | 'decrease' | 'either'; amount: number; windowMinutes: number } | { kind: 'value_change'; match: 'any' | 'becomes' | 'from_to'; becomesValue?: TelemetryEventScalar; fromValue?: TelemetryEventScalar; toValue?: TelemetryEventScalar }

export interface TelemetryEventCatalog {
  canonicalVariables: Array<{ kind: 'canonical'; canonicalId: string; displayName: string; scope: 'machine' | 'deck'; signalType: RawExplorerSignalType; dataKind: 'numeric' | 'string' | 'boolean' | 'categorical'; category: RawExplorerCategory; compatiblePresses: Array<{ pressKey: RadiusPressKey; displayName: string; deckNumbers: number[] }> }>
}

export interface TelemetryEventRawCatalogItem { kind: 'raw'; pressKey: RadiusPressKey; rawIdentity: string; displayName: string; dataType: string; dataKind: 'numeric' | 'string' | 'boolean' | 'categorical'; discoveryCategory: string; sourceUnit: string | null; plottable: boolean }
export interface TelemetryEventRawCatalogResult { pressKey: RadiusPressKey; query: string; offset: number; limit: number; total: number; catalogTotal: number; items: TelemetryEventRawCatalogItem[] }
export interface TelemetryEventPreview { sourceKind: 'canonical' | 'raw'; pressKey: RadiusPressKey; displayName: string; deckNumber: number | null; canonicalId: string | null; rawIdentity: string; signalDisplayName: string; dataType: string; dataKind: 'numeric' | 'string' | 'boolean' | 'categorical'; sourceUnit: string | null; canonicalUnitStatus: string | null; fromUtc: string; toUtc: string; plottable: boolean; observations: Array<{ atUtc: string; value: TelemetryEventScalar; qualityState?: string }> }

export interface TelemetryEventSearchInput {
  fromUtc: string
  toUtc: string
  source: TelemetryEventSource
  pressKey: 'all' | RadiusPressKey
  deckNumber: 'any' | number | null
  rule: TelemetryEventRule
  chartContextMinutes: number
}

export interface TelemetryEventOccurrence {
  occurrenceId: string
  sourceKind: 'canonical' | 'raw'
  pressKey: RadiusPressKey
  displayName: string
  deckNumber: number | null
  canonicalId: string | null
  rawIdentity: string
  signalDisplayName: string
  sourceUnit: string | null
  canonicalUnitStatus: string | null
  valueKind: string
  dataKind: 'numeric' | 'string' | 'boolean' | 'categorical'
  pressOccurrenceIndex: number
  pressOccurrenceCount: number
  startUtc: string
  endUtc: string
  durationSeconds: number
  chartFromUtc: string
  chartToUtc: string
  eventType: 'threshold' | 'delta' | 'value_change'
  clippedStart?: boolean
  clippedEnd: boolean
  dataGap: boolean
  entryValue?: number
  returnValue?: number | null
  extremeValue?: number
  extremeAtUtc?: string
  baselineAtUtc?: string
  baselineValue?: number
  triggerAtUtc?: string
  triggerValue?: number
  direction?: 'increase' | 'decrease'
  actualDelta?: number
  elapsedSeconds?: number
  maximumExcursion?: number
  maximumExcursionAtUtc?: string
  transitionAtUtc?: string
  previousAtUtc?: string | null
  previousValue?: TelemetryEventScalar
  newValue?: TelemetryEventScalar
}

export interface TelemetryEventSearchResult {
  setup: TelemetryEventSearchInput
  summary: { totalOccurrences: number; resolvedSeries: number; compatiblePressesSearched: RadiusPressKey[]; compatibleDecksSearched: number[]; pressCounts: Array<{ pressKey: RadiusPressKey; displayName: string; occurrenceCount: number }> }
  occurrences: TelemetryEventOccurrence[]
  performance: { semanticHistoryRequests: number; totalMs: number; payloadBytes: number }
}

export interface TelemetryEventCanonicalHistory {
  canonicalId: string
  deckNumber: number | null
  mappingStatus: string
  sourceUnit: string | null
  canonicalUnitStatus: string | null
  representation: 'samples' | 'changes'
  valueKind?: string | null
  seed: RawTelemetrySample | null
  samples: RawTelemetrySample[]
  changes: RawTelemetryChange[]
}

export interface TelemetryEventDetail {
  occurrence: TelemetryEventOccurrence
  primary: { kind: 'canonical'; signal: TelemetryEventCanonicalHistory } | { kind: 'raw'; signal: Omit<RawUnmappedHistory, 'reviewStatus'> }
  context: RawExplorerDetail
  evidence: { productionContext: Array<{ field: string; value: string | number | boolean }>; radiusAtEvent: { eventType: string; statusCode: string | null; statusDescription: string } | null; phaseSummary: EvidencePhaseSummary; behavior: ExplorerAnalyticalObservation | null; persistence: ExplorerAnalyticalObservation | null; contextualEnvelope: ExplorerAnalyticalObservation | null; firstDivergence: ExplorerAnalyticalObservation | null; suggestedSignals: RelatedSignalSuggestion[]; observationCount: number }
}

export interface EventSignalPattern {
  canonicalId: string; deckNumber: number | null; friendlyName: string; category: string; sourceUnit: string | null
  kind: 'numeric' | 'state'; provenance: 'AUTHORITATIVE' | 'INFERRED_LOW_CARDINALITY' | 'NUMERIC'; description: string; direction: 'increase' | 'decrease' | 'transition'
  magnitude: number | null; oldValue: TelemetryEventScalar | null; newValue: TelemetryEventScalar | null; atUtc: string; relativeMinutes: number; persistenceMinutes: number | null; reason: string; coverageObservations: number
  phase: { before: string; event: string; recovery: string }
}

export interface EventFingerprintFinding extends EventSignalPattern {
  validOccurrenceCount: number; observedOccurrenceCount: number; occurrenceRate: number; medianRelativeMinutes: number; relativeMinutesIqr: { lower: number; upper: number } | null; medianMagnitude: number | null; occurrenceIds: string[]
}

export interface EventLearningReport {
  version: 1; reportKind: 'raw_radius' | 'telemetry_event'; title: string
  status?: 'SUCCESS' | 'PARTIAL' | 'INSUFFICIENT_EVIDENCE'
  relationshipAnalysis?: { status: 'AVAILABLE' | 'UNAVAILABLE'; reason: 'RELATIONSHIP_ANALYSIS_FAILED' | null }
  target: Record<string, string | number | boolean | null>
  selectedOccurrence: { occurrenceId: string; startUtc: string; endUtc: string; label: string }
  recordedTime: { startUtc: string; endUtc: string }; physicalTiming: object
  productionContext: Array<{ field: string; value: string | number | boolean }>
  radiusContext: Array<{ relationship: string; eventType: string; statusCode: string | null; statusDescription: string }>
  selectedFindings: EventSignalPattern[]
  phaseComparison: Array<{ canonicalId: string; deckNumber: number | null; friendlyName: string; before: string; event: string; recovery: string }>
  historicalFingerprint: { requestedOccurrences: number; qualifiedOccurrences: number; excludedOccurrences: number; radiusCoverage: { startUtc: string; endUtc: string } | null; telemetryCoverage: { startUtc: string; endUtc: string } | null; findings: EventFingerprintFinding[] }
  typicalSequence: Array<{ label: string; canonicalId: string; deckNumber: number | null; supportCount: number; validOccurrenceCount: number; medianRelativeMinutes: number; relativeMinutesIqr: { lower: number; upper: number } | null }>
  relationships: Array<{ signal: string; mode: 'LEVELS' | 'DIFFERENCES' | 'TRANSITION_COOCCURRENCE'; interpretation: string; metrics: Record<string, string | number | boolean | null> }>
  occurrenceComparison: { common: string[]; exceptions: string[] }
  controls: { status: 'AVAILABLE' | 'UNAVAILABLE'; reason: string; comparisons: Array<{ label: string; targetRate: number; controlRate: number }> }
  occurrenceMatrix: Array<{ occurrenceId: string; startUtc: string; patterns: string[] }>
  coverage: { candidateSignals: number; automaticRawSignalScans: 0; limitations: string[] }
  performance: { semanticHistoryRequests: number; cohortOccurrences: number; totalMs: number; payloadBytes: number }
}
