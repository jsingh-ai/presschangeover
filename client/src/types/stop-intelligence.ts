import type { RadiusPressKey } from './api'

export type StopClassification = 'CHANGEOVER' | 'DOWNTIME' | 'UNCERTAIN' | 'IGNORE_BAD_DATA'
export type StopConfidence = 'HIGH' | 'MEDIUM' | 'LOW'
export type RadiusAlignment = 'AGREES' | 'PARTIAL' | 'RADIUS_LATE' | 'RADIUS_EARLY' | 'RADIUS_UNAVAILABLE' | 'CONTRADICTORY'
export type StopEvidenceState = 'AVAILABLE' | 'SOURCE_TELEMETRY_UNAVAILABLE' | 'SHARED_COLLECTION_OUTAGE' | 'INSUFFICIENT_DETAILED_TELEMETRY' | 'UNKNOWN_SPEED_QUALITY'
export type ChangeoverActionConfidence = 'DETECTED' | 'INFERRED' | 'UNKNOWN'
export type ChangeoverActionCode = 'PREVIOUS_JOB_FINISHED' | 'JOB_IDENTITY_TRANSITION' | 'ROLL_TRANSITION' | 'DECK_MOVEMENT' | 'WASH_ACTIVITY' | 'INK_PUMP_ACTIVITY' | 'IMPRESSION_ADJUSTMENT' | 'REGISTRATION_ADJUSTMENT' | 'ANILOX_ACTIVITY' | 'COLOR_RELATED_ACTIVITY' | 'UNCANONICALIZED_RAW_ACTIVITY' | 'TRIAL_RUN' | 'FAILED_RECOVERY' | 'PHYSICAL_RECOVERY' | 'VISTAPORT_ACTIVITY' | 'CHOPOVER' | 'KNIFE_CUTTING_ACTIVITY' | 'MASTER_IMAGE_RUN'

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

export type ChangeoverActivityWindowKind = 'previous-job' | 'job-out' | 'deck-out' | 'wash' | 'ink-up' | 'deck-in' | 'register' | 'impression' | 'color-check' | 'good-run' | 'mixed'
export interface ChangeoverActivityWindow {
  id: string
  kind: ChangeoverActivityWindowKind
  label: string
  startAt: string
  endAt: string
  source: 'TELEMETRY' | 'TELEMETRY_INFERRED' | 'RADIUS_FALLBACK'
  explanation: string
  evidenceDetails: string[]
}

export interface StopFleetEpisode {
  stopId: string
  pressKey: RadiusPressKey
  startAt: string
  endAt: string | null
  physicalDurationSeconds: number
  eventDurationSeconds?: number
  trialRunSeconds?: number
  mergedChangeover?: boolean
  constituentStopIds?: string[]
  classification: StopClassification
  operationalClassification?: StopClassification
  changeoverStabilizationId?: string | null
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
  changeoverActivityWindows: ChangeoverActivityWindow[]
}

export interface ChangeoverStabilizationRoll {
  rollId: string
  startAt: string
  productionStartAt: string
  completedAt: string
  completedLength: number
  unit: string | null
}

export interface ChangeoverStabilizationPhase {
  stabilizationId: string
  triggerStopId: string
  startAt: string
  endAt: string
  status: 'STABILIZING' | 'STABILIZED'
  stabilizedAt: string | null
  goodProductionStartAt: string | null
  minimumRollLength: number
  requiredConsecutiveRolls: number
  completionWindowSeconds: number
  qualifyingRolls: ChangeoverStabilizationRoll[]
  continuationStopIds: string[]
  reason: string
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
    unit: string | null
    stopThreshold: number
    recoveryThreshold: number
    observations: Array<{ atUtc: string; speed: number | null; qualityState: string }>
    unknownIntervals: Array<{ fromUtc: string; toUtc: string; state: Exclude<StopEvidenceState, 'AVAILABLE'> }>
  }
  radiusContext: {
    states: Array<{ kind: 'radius' | 'offline'; startUtc: string; endUtc: string; eventType: string | null; statusCode: string | null; statusDescription: string | null; isProduction: boolean }>
    reason: string
  }
  identityContext: Array<{
    signalId: number | null
    canonicalId: 'production.order' | 'production.recipe' | 'production.material'
    rawIdentity: string | null
    observations: Array<{ atUtc: string; value: string | number | boolean; qualityState: string }>
  }>
  rollLengthContext: {
    signalId: number | null
    canonicalId: 'production.roll.length.actual'
    rawIdentity: string | null
    unit: string | null
    observations: Array<{ atUtc: string; value: number; qualityState: string }>
  } | null
  productionAttributeContext?: Array<{
    attribute: 'WEB_WIDTH' | 'FILM_THICKNESS' | 'FILM_DENSITY' | 'PLATE_REPEAT'
    label: string
    rawIdentity: string
    unit: string | null
    observations: Array<{ atUtc: string; value: number; qualityState: string }>
  }>
  changeoverStabilizationPhases?: ChangeoverStabilizationPhase[]
}

export interface StopIntelligenceFleetReport {
  fromUtc: string
  toUtc: string
  algorithmVersion: string
  classificationVersion: string
  presses: StopFleetPressSummary[]
  operatorCorrections: StopIntelligenceCorrection[]
  correctionPersistence: 'postgresql' | 'memory'
}

export type StopPredictedState = StopClassification | 'OBSERVABLE_NON_STOP' | 'UNKNOWN'
export type StopOperatorState = 'CHANGEOVER' | 'DOWNTIME' | 'UNCERTAIN' | 'ROUTINE' | 'GOOD_PRODUCTION'
export interface StopIntelligenceCorrection {
  correctionId: string
  pressKey: RadiusPressKey
  segmentKey: string
  fromUtc: string
  toUtc: string
  predictedState: StopPredictedState
  correctedState: StopOperatorState
  comment: string | null
  createdAtUtc: string
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
  changeoverStabilizationPhase?: ChangeoverStabilizationPhase
  mergedChangeoverEvent?: StopFleetEpisode
  speedContext: {
    fromUtc: string
    toUtc: string
    unit: string | null
    stopThreshold: number
    recoveryThreshold: number
    observations: Array<{ atUtc: string; speed: number | null; qualityState: string }>
    unknownIntervals: Array<{ fromUtc: string; toUtc: string; state: Exclude<StopEvidenceState, 'AVAILABLE'> }>
  }
  radiusContext: {
    fromUtc: string
    toUtc: string
    states: Array<{ kind: 'radius' | 'offline'; startUtc: string; endUtc: string; eventType: string | null; statusCode: string | null; statusDescription: string | null; isProduction: boolean }>
    reason: string
  }
  actionSignalContext: Array<{
    signalId: number | null
    canonicalId: string
    rawIdentity: string | null
    component: string | null
    deckNumber: number | null
    unit: string | null
    representation: 'samples' | 'changes'
    observations: Array<{ atUtc: string; value: string | number | boolean; qualityState: string }>
  }>
  deckStatusContext: {
    fromUtc: string
    toUtc: string
    availability: 'AVAILABLE' | 'PARTIAL' | 'UNAVAILABLE'
    reason: string
    sourceIdentities: Array<{ role: 'active' | 'deck_out' | 'print_on' | 'print_off' | 'status' | 'position'; rawIdentity: string }>
    decks: Array<{
      deckNumber: number
      intervals: Array<{ startUtc: string; endUtc: string; state: 'PRINTING' | 'OUT' | 'READY' | 'INACTIVE' | 'UNKNOWN'; active: boolean | null; printing: boolean | null; out: boolean | null }>
      events: Array<{ atUtc: string; kind: 'PRINT_OFF_COMMAND'; label: string }>
    }>
  }
  changeoverActivityWindows: ChangeoverActivityWindow[]
  rawUnmappedContext: {
    availability: 'NOT_LOADED' | 'AVAILABLE' | 'PARTIAL' | 'NO_CHANGES' | 'RAW_HISTORY_EXPIRED' | 'UNAVAILABLE'
    discoveredSignalCount: number
    loadedSignalCount: number
    plottedSignalCount: number
    reason: string
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
