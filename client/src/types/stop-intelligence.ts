import type { RadiusPressKey } from './api'

export type StopClassification = 'CHANGEOVER' | 'DOWNTIME' | 'UNCERTAIN' | 'IGNORE_BAD_DATA'
export type StopConfidence = 'HIGH' | 'MEDIUM' | 'LOW'
export type RadiusAlignment = 'AGREES' | 'PARTIAL' | 'RADIUS_LATE' | 'RADIUS_EARLY' | 'RADIUS_UNAVAILABLE' | 'CONTRADICTORY'
export type StopEvidenceState = 'AVAILABLE' | 'UNKNOWN_COLLECTION' | 'UNKNOWN_SPEED_QUALITY'
export type ChangeoverActionConfidence = 'DETECTED' | 'INFERRED' | 'UNKNOWN'
export type ChangeoverActionCode = 'PREVIOUS_JOB_FINISHED' | 'JOB_IDENTITY_TRANSITION' | 'DECK_MOVEMENT' | 'WASH_ACTIVITY' | 'INK_PUMP_ACTIVITY' | 'SLOW_SETUP_RUN' | 'IMPRESSION_ADJUSTMENT' | 'REGISTRATION_ADJUSTMENT' | 'ANILOX_ACTIVITY' | 'COLOR_RELATED_ACTIVITY' | 'TRIAL_RUN' | 'FAILED_RECOVERY' | 'PHYSICAL_RECOVERY' | 'VISTAPORT_ACTIVITY' | 'CHOPOVER' | 'KNIFE_CUTTING_ACTIVITY' | 'MASTER_IMAGE_RUN'

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
  normalizedQuality: 'GOOD' | 'BAD'
  explanation: string
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
  comparison: null | { changeoverStopsObserved: number; changeoverStopsTotal: number; downtimeStopsObserved: number; downtimeStopsTotal: number; interpretation: string }
  detectorVersion: string
}

export interface StopFleetEpisode {
  stopId: string
  pressKey: RadiusPressKey
  startAt: string
  endAt: string | null
  physicalDurationSeconds: number
  classification: StopClassification
  confidence: StopConfidence
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
  telemetryEvidenceState: StopEvidenceState
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
  speedContext: {
    fromUtc: string
    toUtc: string
    unit: 'ft/min'
    stopThreshold: number
    recoveryThreshold: number
    observations: Array<{ atUtc: string; speed: number | null; qualityState: string }>
    unknownIntervals: Array<{ fromUtc: string; toUtc: string; state: 'UNKNOWN_COLLECTION' | 'UNKNOWN_SPEED_QUALITY' }>
  }
}

export interface StopIntelligenceFleetReport {
  fromUtc: string
  toUtc: string
  algorithmVersion: string
  classificationVersion: string
  presses: StopFleetPressSummary[]
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

export interface StopEvidenceItem {
  code: string
  category: 'IDENTITY' | 'SETUP_FAMILY' | 'PHYSICAL' | 'AVAILABILITY' | 'RADIUS'
  strength: 'STRONG' | 'MEDIUM' | 'WEAK' | 'SUPPORTING'
  explanation: string
  canonicalIds: string[]
  fromUtc: string | null
  toUtc: string | null
}

export interface StopIdentityEvidence {
  field: 'order' | 'recipe' | 'customer' | 'material' | 'previous_order'
  usefulness: 'STRONG' | 'MEDIUM' | 'WEAK' | 'UNUSABLE' | 'UNAVAILABLE'
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
  family: 'DECK' | 'ANILOX' | 'WASH_PUMP_INK' | 'IMPRESSION' | 'REGISTRATION' | 'WINDER_CORE_WIDTH' | 'WEB_TENSION_SETPOINT'
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

export interface ClassifiedStopDetail {
  physicalSegment: {
    pressKey: RadiusPressKey
    sourceId: number
    speedSignalId: number
    startAt: string
    endAt: string | null
    leftCensored: boolean
    rightCensored: boolean
    leftCensorReason: string | null
    rightCensorReason: string | null
    physicalDurationSeconds: number
    zeroSpeedSeconds: number
    lowMovementSeconds: number
    movementAttempts: MovementAttempt[]
    failedRecoveryCount: number
    failedRecoveryStreaks: FailedRecoveryStreak[]
    algorithmVersion: string
    configVersion: string
  }
  classification: StopClassification
  confidence: StopConfidence
  classificationVersion: string
  identities: StopIdentityEvidence[]
  identityBefore: Partial<Record<StopIdentityEvidence['field'], string | null>>
  identityAfter: Partial<Record<StopIdentityEvidence['field'], string | null>>
  families: StopFamilyEvidence[]
  supportingEvidence: StopEvidenceItem[]
  conflictingEvidence: StopEvidenceItem[]
  missingEvidence: string[]
  radiusAlignment: RadiusAlignment
  radius: {
    alignment: RadiusAlignment
    firstNonProductionAtUtc: string | null
    firstProductionReturnAtUtc: string | null
    physicalStartOffsetSeconds: number | null
    physicalEndOffsetSeconds: number | null
    coveredSeconds: number
    physicalSeconds: number
    coveragePercent: number
    states: Array<{ kind: 'radius' | 'offline'; startUtc: string; endUtc: string; eventType: string | null; statusCode: string | null; statusDescription: string | null; isProduction: boolean }>
    reason: string
  }
}

export interface StopIntelligenceDetail {
  stopId: string
  displayName: string
  rangeFromUtc: string
  rangeToUtc: string
  telemetryEvidenceState: StopEvidenceState
  identityAssociationConfiguration: { pressKey: RadiusPressKey; identityContextBeforeSeconds: number; identityContextAfterSeconds: number; identitySettlingSeconds: number }
  stop: ClassifiedStopDetail
  speedContext: {
    fromUtc: string
    toUtc: string
    unit: 'ft/min'
    stopThreshold: number
    recoveryThreshold: number
    observations: Array<{ atUtc: string; speed: number | null; qualityState: string }>
    unknownIntervals: Array<{ fromUtc: string; toUtc: string; state: 'UNKNOWN_COLLECTION' | 'UNKNOWN_SPEED_QUALITY' }>
  }
  changeoverActions: {
    eligible: boolean
    reason: string
    windowFromUtc: string
    windowToUtc: string
    actions: ChangeoverAction[]
    notDirectlyConfirmed: ChangeoverAction[]
    detectorVersion: string
  }
}
