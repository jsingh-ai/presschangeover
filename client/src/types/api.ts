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
  classificationVersion?: number
  operationalGroups?: OperationalGroup[]
  decisionSupport?: OverviewDecisionSupport
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
  sourceTimestampUtc: string | null
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
  rawHistoryAvailability?: {
    state: 'RAW_AVAILABLE' | 'RAW_HISTORY_EXPIRED' | 'UNKNOWN'
    detailedTelemetryMayRemainAvailable: boolean
    reason: string
  }
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
  sourceTimestampUtc: string | null
  qualityState: string
  valueKind: string
  value: RawTelemetryScalar
}

export interface RawTelemetryChange extends RawTelemetrySample {
  previousObservedAtUtc: string
  previousReceivedAtUtc: string
  previousSourceTimestampUtc: string | null
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
    availability?: RawUnmappedHistory['rawHistoryAvailability']
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
export type JobAnalysisDimension = 'order' | 'recipe' | 'customer' | 'material'
export type JobGroupOperator = 'exact' | 'contains' | 'starts_with' | 'ends_with' | 'position_range' | 'segment_equals'
export type JobEvidenceLevel = 'strong' | 'moderate' | 'limited' | 'insufficient'
export interface JobGroupDefinition { operator: JobGroupOperator; query: string; positionStart?: number; positionEnd?: number; segmentIndex?: number; delimiter?: string }
export interface JobEvidenceSupport { level: JobEvidenceLevel; runCount: number; observedHours: number; coveragePercent: number; variabilityPoints: number | null; comparableCount: number; reason: string }
export interface JobIdentitySummary { value: string; segments: string[]; runCount: number; observedSeconds: number; goodPercent: number; makeReadyPercent: number; badPercent: number; medianRunSeconds: number; medianTransitionSeconds: number | null; interruptions: number; interruptionsPerProductionHour: number | null; variabilityPoints: number | null; consistency: 'consistent' | 'variable' | 'highly_variable' | 'insufficient'; support: JobEvidenceSupport }
export interface JobRadiusLoss { eventType: string; statusCode: string | null; statusDescription: string; totalSeconds: number; secondsPerRun: number; occurrenceCount: number; occurrencesPerRun: number; medianEpisodeSeconds: number; evidenceUrl: string }
export interface JobTransitionSummary { transitionKey: string; pressKey: RadiusPressKey; previousValue: string; currentValue: string; transitionCount: number; medianTransitionSeconds: number | null; goodPercent: number; makeReadyPercent: number; badPercent: number; interruptionRatePerTransition: number; support: JobEvidenceSupport; radiusCauses: JobRadiusLoss[]; fingerprint: { exactRadiusSequence: Array<{ eventType: string; statusCode: string | null; statusDescription: string }>; recurringSequenceCount: number; medianIdentitySettlingSeconds: number; medianTimingUncertaintySeconds: number | null; deckChangeEvidence: null | { supportedRunCount: number; medianChangedDecks: number; commonlyReusedDecks: number[]; commonlyAddedDecks: number[]; commonlyRemovedDecks: number[] }; telemetryPhysicalTiming: 'not_loaded_in_summary'; telemetryEvidenceUrl: string }; evidenceUrl: string }
export interface JobPressAffinity { pressKey: RadiusPressKey; displayName: string; runCount: number; observedSeconds: number; goodPercent: number; makeReadyPercent: number; badPercent: number; medianTransitionSeconds: number | null; variabilityPoints: number | null; actualVersusComparableGoodPoints: number | null; comparableRunCount: number; comparisonDescription: string; recoverableOpportunitySeconds: number | null; recoverableBaseline: string | null; support: JobEvidenceSupport }
export interface JobDecisionCard { kind: 'preferred_press' | 'sequence_risk' | 'largest_loss' | 'stability' | 'insufficient_evidence'; label: string; headline: string; value: string; detail: string; evidenceLevel: JobEvidenceLevel; inspectUrl: string }
export interface JobIntelligenceReport {
  version: 'job-intelligence-v1'; generatedAtUtc: string; fromUtc: string; toUtc: string; pressKey: RadiusPressKey; displayName: string; analyzeBy: JobAnalysisDimension; metricName: 'Production State Efficiency'
  boundaryPolicy: { settlingWindowSeconds: 300; stableProductionConfirmationSeconds: 300; description: string }
  coverage: Array<{ field: JobAnalysisDimension; capability: 'available' | 'unavailable' | 'temporarily_unavailable'; valueCoveragePercent: number; confidence: 'high' | 'moderate' | 'limited' | 'unavailable'; limitation: string | null }>
  ranking: JobIdentitySummary[]
  selectedGroup: null | { definition: JobGroupDefinition; includedValues: string[]; runCount: number }
  decisions: JobDecisionCard[]; crossPress: JobPressAffinity[]; transitions: JobTransitionSummary[]; radiusLosses: JobRadiusLoss[]
  findings: Array<{ findingId: string; category: string; title: string; evidenceLevel: JobEvidenceLevel; evidenceUrl: string; deterministicInputs: string[] }>
  evidenceLinks: { rawRadius: string; telemetryEvents: string }; limitations: string[]
}
