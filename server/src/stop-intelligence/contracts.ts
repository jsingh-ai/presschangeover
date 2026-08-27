import type { RadiusPressKey } from '../radius/models.js'

export const STOP_INTELLIGENCE_ALGORITHM_VERSION = 'stop-intelligence-physical-v1.0.0'
export const STOP_INTELLIGENCE_CONFIG_VERSION = 'stop-intelligence-config-v1.0.0'
export const STOP_INTELLIGENCE_CLASSIFICATION_VERSION = 'stop-intelligence-classification-v2.0.0'
export const STOP_INTELLIGENCE_ACTION_VERSION = 'stop-intelligence-actions-v1.0.0'
export const STOP_SPEED_THRESHOLD_DEFAULT = 1
export const STOP_RECOVERY_THRESHOLD_DEFAULT = 595
export const STOP_RECOVERY_CONFIRMATION_SECONDS_DEFAULT = 300
export const STOP_IDENTITY_CONTEXT_BEFORE_SECONDS_DEFAULT = 3_600
export const STOP_IDENTITY_CONTEXT_AFTER_SECONDS_DEFAULT = 3_600
export const STOP_IDENTITY_SETTLING_SECONDS = 300

export type TelemetryEvidenceState = 'AVAILABLE' | 'UNKNOWN_COLLECTION' | 'UNKNOWN_SPEED_QUALITY'
export type NormalizedSpeedQuality = 'GOOD' | 'BAD'
export type StopCensorReason = 'RANGE_START' | 'RANGE_END' | 'UNKNOWN_COLLECTION' | 'UNKNOWN_SPEED_QUALITY'
export type StopClassification = 'CHANGEOVER' | 'DOWNTIME' | 'UNCERTAIN' | 'IGNORE_BAD_DATA'
export type StopClassificationConfidence = 'HIGH' | 'MEDIUM' | 'LOW'
export type StopEvidenceStrength = 'STRONG' | 'MEDIUM' | 'WEAK' | 'SUPPORTING'
export type StopIdentityField = 'order' | 'recipe' | 'customer' | 'material' | 'previous_order'
export type StopIdentityUsefulness = 'STRONG' | 'MEDIUM' | 'WEAK' | 'UNUSABLE' | 'UNAVAILABLE'
export type StopSetupFamily = 'DECK' | 'ANILOX' | 'WASH_PUMP_INK' | 'IMPRESSION' | 'REGISTRATION' | 'WINDER_CORE_WIDTH' | 'WEB_TENSION_SETPOINT'
export type RadiusAlignment = 'AGREES' | 'PARTIAL' | 'RADIUS_LATE' | 'RADIUS_EARLY' | 'RADIUS_UNAVAILABLE' | 'CONTRADICTORY'
export type ChangeoverActionConfidence = 'DETECTED' | 'INFERRED' | 'UNKNOWN'
export type ChangeoverActionCode = 'PREVIOUS_JOB_FINISHED' | 'JOB_IDENTITY_TRANSITION' | 'DECK_MOVEMENT' | 'WASH_ACTIVITY' | 'INK_PUMP_ACTIVITY' | 'SLOW_SETUP_RUN' | 'IMPRESSION_ADJUSTMENT' | 'REGISTRATION_ADJUSTMENT' | 'ANILOX_ACTIVITY' | 'COLOR_RELATED_ACTIVITY' | 'TRIAL_RUN' | 'FAILED_RECOVERY' | 'PHYSICAL_RECOVERY' | 'VISTAPORT_ACTIVITY' | 'CHOPOVER' | 'KNIFE_CUTTING_ACTIVITY' | 'MASTER_IMAGE_RUN'

export interface CanonicalSpeedConfiguration {
  pressKey: RadiusPressKey
  sourceId: number
  canonicalSpeedSignalId: number
  canonicalId: 'machine.speed.actual'
  stopThreshold: number
  recoveryThreshold: number
  recoveryConfirmationSeconds: number
}

export interface StopIdentityAssociationConfiguration {
  pressKey: RadiusPressKey
  identityContextBeforeSeconds: number
  identityContextAfterSeconds: number
  identitySettlingSeconds: number
}

export interface CanonicalSpeedObservation {
  atUtc: string
  speed: number | null
  qualityState: string
}

export interface TelemetryAvailabilityInterval {
  fromUtc: string
  toUtc: string
  state: Exclude<TelemetryEvidenceState, 'AVAILABLE'>
}

export interface MovementAttempt {
  startAt: string
  endAt: string
  durationSeconds: number
  averageSpeed: number | null
  peakSpeed: number | null
  reachedRecoveryThreshold: boolean
  failedRecoveryCount: number
  sequenceNumber: number
}

export interface FailedRecoveryStreak {
  startAt: string
  endAt: string
  durationSeconds: number
  reason: 'DROPPED_BELOW_RECOVERY' | 'TELEMETRY_UNAVAILABLE'
  movementAttemptSequenceNumber: number | null
}

export interface PhysicalStopSegment {
  pressKey: RadiusPressKey
  sourceId: number
  speedSignalId: number
  startAt: string
  endAt: string | null
  leftCensored: boolean
  rightCensored: boolean
  leftCensorReason: StopCensorReason | null
  rightCensorReason: StopCensorReason | null
  physicalDurationSeconds: number
  zeroSpeedSeconds: number
  lowMovementSeconds: number
  movementAttempts: MovementAttempt[]
  failedRecoveryCount: number
  failedRecoveryStreaks: FailedRecoveryStreak[]
  algorithmVersion: string
  configVersion: string
}

export interface PhysicalStopAnalysisInput {
  configuration: CanonicalSpeedConfiguration
  fromUtc: string
  toUtc: string
  observations: CanonicalSpeedObservation[]
  availabilityIntervals?: TelemetryAvailabilityInterval[]
}

export interface PhysicalStopAnalysis {
  configuration: CanonicalSpeedConfiguration
  fromUtc: string
  toUtc: string
  segments: PhysicalStopSegment[]
}

export interface StopIdentityEvidence {
  field: StopIdentityField
  usefulness: StopIdentityUsefulness
  available: boolean
  canonicalId: string | null
  beforeValue: string | null
  afterValue: string | null
  changed: boolean
  settled: boolean
  firstChangeAtUtc: string | null
  lastChangeAtUtc: string | null
  settledAtUtc: string | null
  associationOffsetSeconds: number | null
  intermediateValues: string[]
  reason: string
}

export interface StopFamilyEvidence {
  family: StopSetupFamily
  available: boolean
  observed: boolean
  coordinated: boolean
  changeCount: number
  deckNumbers: number[]
  canonicalIds: string[]
  firstObservedAtUtc: string | null
  lastObservedAtUtc: string | null
  reason: string
}

export interface StopEvidenceItem {
  code: string
  category: 'IDENTITY' | 'SETUP_FAMILY' | 'PHYSICAL' | 'AVAILABILITY' | 'RADIUS'
  strength: StopEvidenceStrength
  explanation: string
  canonicalIds: string[]
  fromUtc: string | null
  toUtc: string | null
}

export interface StopClassificationEvidence {
  supporting: StopEvidenceItem[]
  conflicting: StopEvidenceItem[]
  missing: string[]
}

export interface StopRadiusOverlay {
  alignment: RadiusAlignment
  firstNonProductionAtUtc: string | null
  firstProductionReturnAtUtc: string | null
  physicalStartOffsetSeconds: number | null
  physicalEndOffsetSeconds: number | null
  coveredSeconds: number
  physicalSeconds: number
  coveragePercent: number
  states: Array<{
    kind: 'radius' | 'offline'
    startUtc: string
    endUtc: string
    eventType: string | null
    statusCode: string | null
    statusDescription: string | null
    isProduction: boolean
  }>
  reason: string
}

export interface ClassifiedStop {
  physicalSegment: PhysicalStopSegment
  classification: StopClassification
  confidence: StopClassificationConfidence
  classificationVersion: typeof STOP_INTELLIGENCE_CLASSIFICATION_VERSION
  identities: StopIdentityEvidence[]
  identityBefore: Partial<Record<StopIdentityField, string | null>>
  identityAfter: Partial<Record<StopIdentityField, string | null>>
  families: StopFamilyEvidence[]
  supportingEvidence: StopEvidenceItem[]
  conflictingEvidence: StopEvidenceItem[]
  missingEvidence: string[]
  radiusAlignment: RadiusAlignment
  radius: StopRadiusOverlay
}

export interface StopIntelligenceRequest {
  pressKey: RadiusPressKey
  fromUtc: string
  toUtc: string
}

export interface StopIntelligenceReport extends PhysicalStopAnalysis {
  displayName: string
  telemetryEvidenceState: TelemetryEvidenceState
  identityAssociationConfiguration: StopIdentityAssociationConfiguration
  classifiedStops: ClassifiedStop[]
}

export interface StopFleetEpisode {
  stopId: string
  pressKey: RadiusPressKey
  startAt: string
  endAt: string | null
  physicalDurationSeconds: number
  classification: StopClassification
  confidence: StopClassificationConfidence
  movementAttemptCount: number
  failedRecoveryCount: number
  radiusAlignment: RadiusAlignment
  radiusStatusDescription: string | null
  primaryReasonCodes: string[]
  leftCensored: boolean
  rightCensored: boolean
  affectedByCollectionGap: boolean
  affectedBySpeedQuality: boolean
}

export interface StopFleetPressSummary {
  pressKey: RadiusPressKey
  displayName: string
  telemetryEvidenceState: TelemetryEvidenceState
  stopCount: number
  totalPhysicalStopSeconds: number
  changeoverCount: number
  downtimeCount: number
  uncertainCount: number
  badDataCount: number
  changeoverPhysicalStopSeconds: number
  longestPhysicalStopSeconds: number
  dataAvailabilityWarning: boolean
  warningReason: string | null
  episodes: StopFleetEpisode[]
  speedContext: StopSpeedContext
}

export interface StopIntelligenceFleetReport {
  fromUtc: string
  toUtc: string
  algorithmVersion: string
  classificationVersion: typeof STOP_INTELLIGENCE_CLASSIFICATION_VERSION
  presses: StopFleetPressSummary[]
}

export interface StopSpeedContext {
  fromUtc: string
  toUtc: string
  unit: 'ft/min'
  stopThreshold: number
  recoveryThreshold: number
  observations: CanonicalSpeedObservation[]
  unknownIntervals: TelemetryAvailabilityInterval[]
}

export interface ChangeoverActionEvidence {
  signalId: number | null
  canonicalId: string | null
  rawIdentity: string | null
  component: string | null
  deckNumber: number | null
  atUtc: string
  oldValue: string | number | boolean | null
  newValue: string | number | boolean | null
  originalQuality: string
  normalizedQuality: NormalizedSpeedQuality
  explanation: string
}

export interface ChangeoverActionComparison {
  changeoverStopsObserved: number
  changeoverStopsTotal: number
  downtimeStopsObserved: number
  downtimeStopsTotal: number
  interpretation: string
}

export interface ChangeoverAction {
  actionCode: ChangeoverActionCode
  displayName: string
  operatorConcept: string | null
  confidence: ChangeoverActionConfidence
  startAt: string | null
  endAt: string | null
  explanation: string
  evidence: ChangeoverActionEvidence[]
  evidenceCount: number
  evidenceLimited: boolean
  comparison: ChangeoverActionComparison | null
  detectorVersion: typeof STOP_INTELLIGENCE_ACTION_VERSION
}

export interface ChangeoverActionAnalysis {
  eligible: boolean
  reason: string
  windowFromUtc: string
  windowToUtc: string
  actions: ChangeoverAction[]
  notDirectlyConfirmed: ChangeoverAction[]
  detectorVersion: typeof STOP_INTELLIGENCE_ACTION_VERSION
}

export interface StopIntelligenceDetail {
  stopId: string
  displayName: string
  rangeFromUtc: string
  rangeToUtc: string
  telemetryEvidenceState: TelemetryEvidenceState
  identityAssociationConfiguration: StopIdentityAssociationConfiguration
  stop: ClassifiedStop
  speedContext: StopSpeedContext
  changeoverActions: ChangeoverActionAnalysis
}
