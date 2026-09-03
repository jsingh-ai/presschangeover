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

export interface RawRadiusTimeline {
  pressKey: RadiusPressKey
  displayName: string
  fromUtc: string
  toUtc: string
  segments: RadiusStatusSegment[]
}

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

export type OverviewRankingExclusionReason =
  | 'coverage_below_80_percent'
  | 'observed_time_below_30_minutes'

export interface OverviewPressContribution {
  pressKey: RadiusPressKey
  displayName: string
  durationSeconds: number
  shareOfCategoryPercent: number
}

export interface OverviewFamilyAllocation {
  key: string
  name: string
  durationSeconds: number
  nonProductionSeconds: number
  shareOfGroupPercent: number
  shareOfRadiusStatePercent: number
  shareOfObservedPercent: number
  sourceIdentityCount: number
  needsClassification: boolean
  pressContributions: OverviewPressContribution[]
}

export interface OverviewGroupAllocation {
  key: string
  name: string
  description: string
  lightColor: string
  darkColor: string
  durationSeconds: number
  shareOfRadiusStatePercent: number
  shareOfObservedPercent: number
  nonProductionSeconds: number
  families: OverviewFamilyAllocation[]
  needsClassification: boolean
  pressContributions: OverviewPressContribution[]
}

export interface OverviewRadiusStateAllocation {
  eventType: string
  displayLabel: string
  durationSeconds: number
  shareOfObservedPercent: number
  canonicalProductionSeconds: number
  nonProductionSeconds: number
  nonProductionShareOfObservedPercent: number
  operationalGroups: OverviewGroupAllocation[]
  largestNonProductionGroupKey: string | null
  largestNonProductionFamilyKey: string | null
}

export type OverviewTimelineClassificationStatus = 'mapped' | 'needs_classification' | 'unavailable'

export interface OverviewTimelineInterval {
  intervalId: string
  startUtc: string
  endUtc: string
  durationSeconds: number
  isUnavailable: boolean
  eventType: string | null
  statusCode: string | null
  statusDescription: string | null
  radiusStateLabel: string
  operationalGroupKey: string | null
  operationalGroupLabel: string
  operationalGroupLightColor: string | null
  operationalGroupDarkColor: string | null
  processFamilyKey: string | null
  processFamilyLabel: string | null
  classificationNeedsReview: boolean
  classificationStatus: OverviewTimelineClassificationStatus
}

export interface OverviewPressAllocation {
  pressKey: RadiusPressKey
  displayName: string
  wallClockSeconds: number
  observedSeconds: number
  unavailableSeconds: number
  coveragePercent: number
  productionSeconds: number
  productionSharePercent: number | null
  nonProductionSeconds: number
  nonProductionSharePercent: number | null
  fleetProductionRank: number | null
  productionDeltaVsFleetMedianPoints: number | null
  rankingEligible: boolean
  rankingExclusionReason: OverviewRankingExclusionReason | null
  classificationCoveragePercent: number
  needsClassificationSeconds: number
  largestNonProductionRadiusStateEventType: string | null
  radiusStateBreakdown: OverviewRadiusStateAllocation[]
  timelineIntervals: OverviewTimelineInterval[]
}

export interface OverviewDecisionSupport {
  minimumCoveragePercent: 80
  minimumObservedSeconds: 1800
  classificationVersion: number
  fleetSummary: {
    wallClockSeconds: number
    observedSeconds: number
    unavailableSeconds: number
    coveragePercent: number
    productionSeconds: number
    productionSharePercent: number | null
    nonProductionSeconds: number
    nonProductionSharePercent: number | null
    rankablePressCount: number
    pressCount: number
    productionMedianPercent: number | null
    classificationCoveragePercent: number
    needsClassificationSeconds: number
    largestNonProductionRadiusStateEventType: string | null
  }
  pressAllocations: OverviewPressAllocation[]
  rankingPressKeys: RadiusPressKey[]
  topRunningPressKeys: RadiusPressKey[]
  needsAttentionPressKeys: RadiusPressKey[]
  fleetRadiusStateBreakdown: OverviewRadiusStateAllocation[]
  focusItems: string[]
  excludedPressKeys: RadiusPressKey[]
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
  operationalGroups?: import('../classification/models.js').OperationalGroup[]
  decisionSupport?: OverviewDecisionSupport
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
