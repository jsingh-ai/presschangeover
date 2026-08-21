import type { RadiusPressKey } from '../radius/models.js'
import type { TelemetrySample } from '../telemetry/telemetry-contracts.js'

export const CHANGEOVER_ALGORITHM_VERSION = 'changeover-v1.0.0'
export const CHANGEOVER_STOP_SPEED_DEFAULT = 1
export const CHANGEOVER_RECOVERY_SPEED_DEFAULT = 500
export const CHANGEOVER_CONFIRMATION_SECONDS_DEFAULT = 300

export type ChangeoverMode = 'CHANGEOVERS' | 'ALL_STOPS'
export type EvidenceState = 'COMPLETE' | 'PARTIAL' | 'INSUFFICIENT_EVIDENCE' | 'FAILED'
export type SupportLevel = 'strong' | 'moderate' | 'limited' | 'insufficient'
export type ChangeoverClassification = 'CONFIRMED_CHANGEOVER' | 'OTHER_STOP' | 'AMBIGUOUS_STOP'

export interface ChangeoverDefinition {
  stopSpeed: number
  recoverySpeed: number
  recoveryConfirmationSeconds: number
  source: 'DEFAULT' | 'CUSTOM'
  stopRule: 'speed_below_threshold_debounced'
  recoveryRule: 'first_speed_above_threshold_sustained'
  identityRule: 'resolved_order_changed'
}

export interface RecoveryAttempt {
  candidateStartUtc: string
  endedAtUtc: string
  durationSeconds: number
  outcome: 'FAILED' | 'CONFIRMED'
  failureReason: 'speed_at_or_below_threshold' | 'telemetry_gap' | null
}

export interface PhysicalStop {
  physicalStartUtc: string
  stopConfirmedAtUtc: string
  physicalRecoveryUtc: string | null
  recoveryConfirmedAtUtc: string | null
  durationSeconds: number | null
  failedRecoveryAttempts: RecoveryAttempt[]
  evidenceState: 'CONFIRMED' | 'OPEN' | 'INTERRUPTED'
  telemetryGap: { startUtc: string; endUtc: string; durationSeconds: number } | null
}

export interface OrderIdentityTransition {
  previousResolvedOrder: string | null
  finalResolvedOrder: string | null
  identityChangeFirstSeenAtUtc: string | null
  identityLastChangeAtUtc: string | null
  identitySettledAtUtc: string | null
  settleState: 'CONFIRMED' | 'PENDING_RANGE_END' | 'RANGE_START' | 'MISSING' | 'CONFLICTING'
  inferredBoundary: boolean
  intermediateValues: string[]
}

export interface RadiusExactIdentity {
  eventType: string | null
  statusCode: string | null
  statusDescription: string | null
}

export type ChangeoverPhase =
  | 'MAKE_READY'
  | 'CLEANING_WASH'
  | 'PLATES_SLEEVES_ANILOX'
  | 'REGISTRATION_QUALITY'
  | 'MATERIAL_WEB'
  | 'INK_COLOR_RADIUS'
  | 'MAINTENANCE'
  | 'PROCESS_DELAY'
  | 'BREAKDOWN'
  | 'OTHER_RADIUS'
  | 'RADIUS_PRODUCTION_MISMATCH'
  | 'RADIUS_DATA_GAP'
  | 'UNKNOWN_UNCLASSIFIED'

export interface RawRadiusInterval {
  kind: 'radius' | 'offline'
  originalStartUtc: string
  originalEndUtc: string
  originalDurationSeconds: number
  identity: RadiusExactIdentity
  operationalGroupKey: string | null
  operationalGroupName: string | null
  processFamilyKey: string | null
  processFamilyName: string | null
  isProduction: boolean
}

export interface AdjustedRadiusContribution {
  phase: ChangeoverPhase
  adjustedStartUtc: string
  adjustedEndUtc: string
  durationSeconds: number
  rawIntervalIndex: number | null
  identity: RadiusExactIdentity
  reason: string
}

export interface RadiusReconciliation {
  physicalDurationSeconds: number
  adjustedDurationSeconds: number
  differenceSeconds: number
  annotationStartLagSeconds: number | null
  annotationEndLagSeconds: number | null
  rawIntervals: RawRadiusInterval[]
  adjustedContributions: AdjustedRadiusContribution[]
}

export interface ConfirmedChangeover {
  changeoverId: string
  algorithmVersion: string
  pressKey: RadiusPressKey
  displayName: string
  classification: ChangeoverClassification
  evidenceState: EvidenceState
  physical: PhysicalStop
  orderTransition: OrderIdentityTransition
  radius: RadiusReconciliation | null
  exactRadiusSequence: RadiusExactIdentity[]
  phaseSequence: ChangeoverPhase[]
  evidenceNotes: string[]
}

export interface DistributionSummary {
  median: number | null
  p25: number | null
  p75: number | null
  p90: number | null
  iqr: number | null
  count: number
}

export interface EvidenceSupport {
  level: SupportLevel
  count: number
  description: string
}

export interface PressChangeoverSummary {
  pressKey: RadiusPressKey
  displayName: string
  evidenceState: EvidenceState
  changeoverCount: number
  otherStopCount: number
  ambiguousStopCount: number
  metadataOnlyTransitionCount: number
  duration: DistributionSummary
  totalChangeoverSeconds: number
  failedRecoveryAttemptCount: number
  failedRecoveriesPerChangeover: number | null
  percentWithFailedRecovery: number | null
  annotationStartLag: DistributionSummary
  annotationEndLag: DistributionSummary
  radiusCoveragePercent: number | null
  phaseMinutesPerChangeover: Array<{ phase: ChangeoverPhase; minutes: number }>
  support: EvidenceSupport
  focused: boolean
}

export interface RecoveryCohortSummary {
  attemptBand: '0' | '1' | 'multiple'
  changeoverCount: number
  percentOfChangeovers: number
  duration: DistributionSummary
  support: EvidenceSupport
}

export interface PhaseSummary {
  phase: ChangeoverPhase
  durationSeconds: number
  percentOfPhysicalChangeover: number
  occurrenceCount: number
}

export interface ExactReasonSummary {
  identity: RadiusExactIdentity
  phase: ChangeoverPhase
  durationSeconds: number
  minutesPerChangeover: number
  occurrenceCount: number
  changeoverCount: number
  medianOccurrenceSeconds: number | null
  support: EvidenceSupport
}

export interface SequenceSummary {
  sequence: string[]
  count: number
  duration: DistributionSummary
  failedRecoveryAttemptCount: number
  loopCount: number
  support: EvidenceSupport
}

export interface TransitionPairSummary {
  previousOrder: string
  currentOrder: string
  count: number
  duration: DistributionSummary
  phaseMinutesPerChangeover: Array<{ phase: ChangeoverPhase; minutes: number }>
  dominantSequence: ChangeoverPhase[]
  failedRecoveryPercent: number
  presses: RadiusPressKey[]
  support: EvidenceSupport
}

export interface DailyChangeoverSummary {
  date: string
  count: number
  durationSeconds: number
  medianDurationSeconds: number | null
  failedRecoveryAttemptCount: number
}

export interface ChangeoverTrendPoint {
  periodStartUtc: string
  count: number
  medianDurationSeconds: number | null
  p90DurationSeconds: number | null
}

export interface ChangeoverReport {
  version: 'changeover-intelligence-report-v1'
  algorithmVersion: string
  generatedAtUtc: string
  requestedFromUtc: string
  requestedToUtc: string
  analyzedFromUtc: string
  analyzedToUtc: string
  historyState: 'AVAILABLE' | 'LIMITED_HISTORY'
  historyMessage: string | null
  mode: ChangeoverMode
  definition: ChangeoverDefinition
  focusPressKey: RadiusPressKey | null
  evidenceState: EvidenceState
  support: EvidenceSupport
  fleet: PressChangeoverSummary[]
  changeovers: ConfirmedChangeover[]
  allStops: ConfirmedChangeover[]
  metadataOnlyTransitions: Array<{ pressKey: RadiusPressKey; displayName: string; transition: OrderIdentityTransition }>
  duration: DistributionSummary
  phases: PhaseSummary[]
  exactReasons: ExactReasonSummary[]
  sequences: SequenceSummary[]
  recoveryCohorts: RecoveryCohortSummary[]
  transitionPairs: TransitionPairSummary[]
  daily: DailyChangeoverSummary[]
  trends: ChangeoverTrendPoint[]
  diagnostics: { pressCount: number; successfulPressCount: number; radiusUnavailablePressCount: number; telemetryUnavailablePressCount: number; sequentialRadiusAcquisitions: number; radiusConcurrencyCap: number; peakConcurrentRadiusAcquisitions: number; radiusQueuedAtCompletion: number; telemetryChunkCount: number; telemetryRequestCount: number; cache: 'MISS' | 'HIT' | 'SHARED' }
}

export interface ChangeoverInspector {
  version: 'changeover-intelligence-inspector-v1'
  algorithmVersion: string
  generatedAtUtc: string
  definition: ChangeoverDefinition
  event: ConfirmedChangeover
  speed: { canonicalId: 'machine.speed.actual'; sourceUnit: string | null; samples: TelemetrySample[] }
  orderTrack: Array<{ atUtc: string; value: string | null; kind: 'SEED' | 'CHANGE' | 'SETTLED' }>
}

export interface ChangeoverReportInput {
  fromUtc: string
  toUtc: string
  mode: ChangeoverMode
  focusPressKey: RadiusPressKey | null
  stopSpeed: number
  recoverySpeed: number
  recoveryConfirmationSeconds: number
}

export interface ChangeoverInspectorInput extends ChangeoverReportInput {
  changeoverId: string
  pressKey: RadiusPressKey
  physicalStartUtc: string
  physicalRecoveryUtc: string
}
