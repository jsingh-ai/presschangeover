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
  eventType: string | null; radiusStateLabel: string; operationalGroupKey: string | null; operationalGroupLabel: string
  operationalGroupLightColor: string | null; operationalGroupDarkColor: string | null
  processFamilyKey: string | null; processFamilyLabel: string | null; classificationStatus: OverviewTimelineClassificationStatus
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
export interface ActivitySelection { level: ActivityLevel; key: string; label: string }
export interface ActivityCatalogItem extends ActivitySelection { description: string | null; eventType: string | null; statusCode: string | null; statusDescription: string | null; operationalGroupKey: string | null; operationalGroupName: string | null; processFamilyKey: string | null; processFamilyName: string | null; needsClassification: boolean }
export interface ActivityOccurrence { occurrenceId: string; pressKey: RadiusPressKey; displayName: string; startUtc: string; endUtc: string; durationSeconds: number; eventType: string; radiusStateLabel: string; operationalGroupKey: string; operationalGroupName: string; processFamilyKey: string; processFamilyName: string; exactIdentities: Array<{ identity: string; eventType: string; statusCode: string | null; statusDescription: string; durationSeconds: number; needsClassification: boolean }> }
export interface ActivityAnalysis {
  fromUtc: string; toUtc: string; classificationVersion: number; selection: ActivityCatalogItem; catalog: ActivityCatalogItem[]
  summary: { totalDurationSeconds: number; occurrenceCount: number; medianOccurrenceSeconds: number | null; p95OccurrenceSeconds: number | null; longestOccurrenceSeconds: number; pressesObserved: number; scopePresses: number; shareOfObservedPercent: number; sourceCoveragePercent: number; classificationCoveragePercent: number }
  pressBreakdown: Array<{ pressKey: RadiusPressKey; displayName: string; durationSeconds: number; occurrenceCount: number; medianOccurrenceSeconds: number | null; shareOfObservedPercent: number; coveragePercent: number }>
  radiusStateComposition: Array<{ eventType: string; label: string; durationSeconds: number; percentage: number }>
  semanticBreakdown: Array<{ key: string; label: string; level: 'operational_group' | 'process_family' | 'exact_status'; durationSeconds: number; percentage: number }>
  trend: Array<{ bucketStartUtc: string; durationSeconds: number; occurrenceCount: number }>; trendBucket: 'hour' | 'day'
  durationDistribution: Array<{ key: string; label: string; occurrenceCount: number }>; occurrences: ActivityOccurrence[]; totalOccurrenceCount: number; evidenceLimit: number
}
export type PatternMatchMode = 'contains_all' | 'in_order'
export interface RunPatternEvidence { runId: string; pressKey: RadiusPressKey; displayName: string; startUtc: string; endUtc: string; totalDurationSeconds: number; timeToProductionSeconds: number | null; productionDurationSeconds: number; shortRunAttemptCount: number; transitionCount: number; isPartial: boolean; dataInterrupted: boolean; eligible: boolean; groupSequence: string[]; familySequence: string[]; selectedActivitySeconds: number; conditionDurations: Array<{ conditionKey: string; durationSeconds: number }> }
export interface PatternSummary { patternKey: string; classificationVersion: number; orderedGroupKeys: string[]; orderedGroupLabels: string[]; runCount: number; runSharePercent: number; pressesObserved: number; medianTimeToProductionSeconds: number | null; medianPreProductionSeconds: number | null; medianProductionSeconds: number | null; shortAttemptRunCount: number; matchedRunIds: string[]; containsReentry: boolean; pressStats: Array<{ pressKey: RadiusPressKey; displayName: string; matchedRuns: number; eligibleRuns: number; matchRatePercent: number; medianTimeToProductionSeconds: number | null }>; familyVariations: Array<{ orderedFamilyKeys: string[]; orderedFamilyLabels: string[]; runCount: number; runShareWithinPatternPercent: number }> }
export interface PatternAnalysis {
  fromUtc: string; toUtc: string; classificationVersion: number; catalog: ActivityCatalogItem[]; totalRuns: number; eligibleRuns: number; excludedPartialRuns: number; excludedInterruptedRuns: number; excludedOpenRuns: number; uniquePatternCount: number; shortAttemptRuns: number; patterns: PatternSummary[]; selectedPattern: PatternSummary | null; matchedRuns: RunPatternEvidence[]; evidenceLimit: number
  builder: null | { conditions: ActivityCatalogItem[]; matchMode: PatternMatchMode; redundantConditionMessage: string | null; matchedRuns: number; matchSharePercent: number; pressesObserved: number; medianTimeToProductionSeconds: number | null; medianSelectedActivitySeconds: number | null; totalSelectedActivitySeconds: number; pressStats: Array<{ pressKey: RadiusPressKey; displayName: string; matchedRuns: number; eligibleRuns: number; matchRatePercent: number; selectedActivitySeconds: number; medianTimeToProductionSeconds: number | null }>; topPatterns: Array<{ patternKey: string; labels: string[]; runCount: number; percentageOfMatches: number }> }
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
