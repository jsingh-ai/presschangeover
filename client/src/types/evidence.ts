import type { PhysicalState, RadiusPressKey, ResolvedRadiusClassification } from './api'

export interface PressRef {
  pressKey: RadiusPressKey
  displayName: string
}

export interface TimeRange {
  fromUtc: string
  toUtc: string
}

export interface RadiusIdentity {
  eventType: string
  statusCode: string | null
  statusDescription: string
}

export interface RadiusEvidence extends RadiusIdentity, TimeRange {
  durationSeconds: number
}

export interface SemanticClassificationRef {
  operationalGroupKey: string | null
  operationalGroupName: string | null
  processFamilyKey: string | null
  processFamilyName: string | null
  status: ClassificationStatus
  version: number | null
}

export type ClassificationStatus = 'mapped' | 'needs_classification' | 'unavailable'
export type CapabilityState = 'SUPPORTED' | 'UNSUPPORTED' | 'UNKNOWN' | 'TEMPORARILY_UNAVAILABLE'
export type SourceAvailability = 'AVAILABLE' | 'DISABLED' | 'NO_SOURCE' | 'TEMPORARILY_UNAVAILABLE'
export type EvidenceObservationState = 'UNSUPPORTED' | 'SUPPORTED_WITH_NO_SAMPLES_IN_RANGE' | 'SUPPORTED_WITH_SEED_ONLY' | 'SUPPORTED_WITH_OBSERVATIONS'
export type TelemetryValueKind = 'numeric' | 'integer' | 'boolean' | 'string' | 'text'
export type TelemetryScalarValue = number | boolean | string
export type TelemetryRepresentation = 'samples' | 'changes'
export type ProductionContextField = 'job' | 'order' | 'recipe' | 'customer' | 'material' | 'roll'
export type PhysicalEvidenceCategory = 'context' | 'deck_states' | 'register' | 'impression' | 'wash' | 'pump' | 'viscosity' | 'ink_temperature'

export interface SignalCapability {
  canonicalId: string
  state: CapabilityState
  lastKnownState?: Exclude<CapabilityState, 'TEMPORARILY_UNAVAILABLE'>
  deckNumbers: number[]
  historyQueryable: boolean
  evidenceKind: 'semantic_history' | 'derived' | null
}

export interface PressTelemetrySource extends PressRef {
  sourceKey: string | null
  enabled: boolean | null
  availability: SourceAvailability
  metadataStatus: 'FRESH' | 'CACHED' | 'STALE'
}

export interface PressTelemetryCapabilities extends PressRef {
  sourceKey: string
  metadataStatus: 'FRESH' | 'CACHED' | 'STALE'
  capabilities: SignalCapability[]
}

export interface TimedTelemetryValue {
  observedAtUtc: string
  receivedAtUtc: string
  sourceTimestampUtc: string
  qualityState: string
  valueKind: TelemetryValueKind
  value: TelemetryScalarValue
}

export interface TimedNumericSample extends TimedTelemetryValue {
  valueKind: 'numeric' | 'integer'
  value: number
}

export interface TelemetryChange extends TimedTelemetryValue {
  previousObservedAtUtc: string
  previousReceivedAtUtc: string
  previousSourceTimestampUtc: string
  previousQualityState: string
  previousValueKind: TelemetryValueKind
  previousValue: TelemetryScalarValue
}

export interface TimedStateInterval {
  state: PhysicalState
  fromUtc: string
  toUtc: string
  durationMs: number
  durationSeconds?: number
  actualSpeedAtStart?: number | null
  targetSpeedAtStart?: number | null
  targetCommanded?: boolean | null
  reason?: string
}

export interface SemanticSignalEvidence {
  canonicalId: string
  deckNumber: number | null
  capabilityState: CapabilityState
  observationState: EvidenceObservationState
  mappingStatus: 'MAPPED' | 'UNAVAILABLE' | 'UNMAPPED' | 'AMBIGUOUS'
  sourceUnit: string | null
  canonicalUnitStatus: string | null
  representation: TelemetryRepresentation
  seed: TimedTelemetryValue | null
  samples: TimedTelemetryValue[]
  changes: TelemetryChange[]
}

export interface ContextValue {
  field: ProductionContextField
  canonicalId: string
  capabilityState: CapabilityState
  observationState: EvidenceObservationState
  seed: TimedTelemetryValue | null
  changes: TelemetryChange[]
}

export interface ContextChange {
  atUtc: string
  field: ProductionContextField
  canonicalId: string
  previousValueKind: TelemetryValueKind
  previousValue: TelemetryScalarValue
  valueKind: TelemetryValueKind
  value: TelemetryScalarValue
  qualityState: string
}

export interface ProductionContextEvidence extends PressRef, TimeRange {
  sourceKey: string
  fields: Record<ProductionContextField, ContextValue>
  changes: ContextChange[]
}

export interface SpeedSignalEvidence {
  canonicalId: 'machine.speed.actual' | 'machine.speed.setpoint'
  observationState: 'SUPPORTED_WITH_NO_SAMPLES_IN_RANGE' | 'SUPPORTED_WITH_OBSERVATIONS'
  sourceUnit: string | null
  canonicalUnitStatus: string
  samples: TimedNumericSample[]
}

export interface PressSpeedEvidence extends PressRef, TimeRange {
  sourceKey: string
  actual: SpeedSignalEvidence
  setpoint: SpeedSignalEvidence | null
}

export interface PressMotionEvidence extends PressRef, TimeRange {
  sourceKey: string
  policy: Record<string, unknown>
  summary: { durationsMs: Record<PhysicalState, number>; durationsSeconds?: Record<PhysicalState, number>; segmentCount: number }
  segments: TimedStateInterval[]
}

export interface CuratedPhysicalEvidence extends PressRef, TimeRange {
  sourceKey: string
  requestedCategories: PhysicalEvidenceCategory[]
  capabilities: SignalCapability[]
  signals: SemanticSignalEvidence[]
}

export type EngineeringSignalType = 'continuous' | 'step_reference' | 'state_event'
export type EngineeringObservationConfidence = 'OBSERVED' | 'LIMITED_OBSERVATION' | 'NO_USABLE_OBSERVATION' | 'TEMPORARILY_UNAVAILABLE' | 'UNSUPPORTED'
export type EngineeringCategory = 'speed' | 'web_tension' | 'dryer' | 'ink' | 'viscosity' | 'temperature' | 'pump' | 'wash' | 'register' | 'impression' | 'torque' | 'drive_temperature' | 'doctor_blade' | 'repeat_other' | 'motion'

export interface PressSemanticHistoryEvidence extends PressRef, TimeRange {
  sourceKey: string
  includeSeed: boolean
  signals: SemanticSignalEvidence[]
}

export interface NumericWindowSummary { count: number; median: number | null; minimum: number | null; maximum: number | null; iqr: number | null }

export interface EngineeringSignalClue {
  canonicalId: string
  deckNumber: number | null
  friendlyName: string
  signalType: EngineeringSignalType
  category: EngineeringCategory
  capabilityState: CapabilityState
  observationState: EvidenceObservationState
  observationConfidence: EngineeringObservationConfidence
  mappingStatus: SemanticSignalEvidence['mappingStatus']
  sourceUnit: string | null
  unitLabel: string
  canonicalUnitStatus: string | null
  before: NumericWindowSummary | null
  during: NumericWindowSummary | null
  after: NumericWindowSummary | null
  enteringValue: TelemetryScalarValue | null
  transitionCount: number
  largestRawStep: number | null
  description: string
  isClue: boolean
  clueQuality: number
  firstRelevantAtUtc: string | null
  firstRelevantOffsetMs: number | null
  firstRelevantPreviousValue: TelemetryScalarValue | null
  firstRelevantValue: TelemetryScalarValue | null
}

export interface EngineeringClueResponse {
  occurrence: { occurrenceId: string; pressKey: RadiusPressKey; displayName: string; startUtc: string; endUtc: string; durationSeconds: number; exactIdentities: Array<{ eventType: string; statusCode: string | null; statusDescription: string }> }
  evidenceWindow: { fromUtc: string; toUtc: string; beforeEndUtc: string; duringStartUtc: string; duringEndUtc: string; afterStartUtc: string; boundedAroundStart: boolean; message: string | null }
  coverage: { supportedSelectors: number; observedSelectors: number; limitedObservationSelectors: number; noObservationSelectors: number; unavailableSelectors: number }
  whereToLook: Array<{ scopeKey: string; scopeLabel: string; category: EngineeringCategory; supportedSignals: number; clueSignals: number; clueShare: number; strongestClueQuality: number; averageClueQuality: number; qualityScore: number; summary: string }>
  categoryColumns: EngineeringCategory[]
  categoryCells: Array<{ scopeKey: string; scopeLabel: string; category: EngineeringCategory; supportedSignals: number; observedSignals: number; clueSignals: number; status: 'multiple_clues' | 'one_clue' | 'observed_no_shift' | 'insufficient' | 'temporarily_unavailable' | 'unknown' | 'unsupported'; details: string[] }>
  firstChanges: Array<Pick<EngineeringSignalClue, 'canonicalId' | 'deckNumber' | 'friendlyName' | 'signalType' | 'category' | 'firstRelevantAtUtc' | 'firstRelevantOffsetMs' | 'firstRelevantPreviousValue' | 'firstRelevantValue'>>
  signalClues: EngineeringSignalClue[]
  performance: { upstreamCalls: number; semanticCalls: number; totalSelectors: number; upstreamMs: number; calculationMs: number; totalMs: number; responsePayloadBytes: number }
}

export type PhysicalSpeedBucket = 'STOPPED' | 'LOW_TRANSITION' | 'RUNNING' | 'HIGH_SPEED_RUNNING'
export type StopMatchStatus = 'MATCHED' | 'AMBIGUOUS' | 'NO_PHYSICAL_STOP_FOUND' | 'INSUFFICIENT_SPEED_EVIDENCE'
export interface StopRestartStats { count: number; mean: number; median: number; p05: number; p25: number; p75: number; p95: number; iqr: number; minimum: number; maximum: number }
export interface StopRestartRunningWindow { supported: boolean; fromUtc: string | null; toUtc: string | null; durationSeconds: number | null; bucket: PhysicalSpeedBucket | null; stats: StopRestartStats | null; changing: boolean | null; timeSincePreviousStoppedSeconds: number | null }
export interface StopRestartResponse {
  occurrence: { occurrenceId: string; pressKey: RadiusPressKey; displayName: string; startUtc: string; endUtc: string; operationalGroupKey: string; operationalGroupName: string; processFamilyKey: string; processFamilyName: string; exactIdentities: Array<{ eventType: string; statusCode: string | null; statusDescription: string }> }
  analysisWindow: { fromUtc: string; toUtc: string }
  physicalStopMatch: { status: StopMatchStatus; selected: null | { atUtc: string; observedSpeed: number; previousObservedSpeed: number; radiusOffsetSeconds: number }; candidates: Array<{ atUtc: string; observedSpeed: number; previousObservedSpeed: number; radiusOffsetSeconds: number }>; speedObservationCount: number }
  phases: null | { stableRunningBefore: StopRestartRunningWindow; deceleration: { fromUtc: string | null; toUtc: string | null }; stopped: { fromUtc: string; toUtc: string | null; durationSeconds: number | null }; restartAttempts: Array<{ attempt: number; startUtc: string; endUtc: string | null; durationSeconds: number | null; maximumObservedSpeed: number; highestBucket: PhysicalSpeedBucket; returnedToStopped: boolean; sustainedRunning: boolean; sustainedConfirmedAtUtc: string | null }>; sustainedRunningAgain: StopRestartRunningWindow; sustainedRunningReachedAtUtc: string | null; sustainedRunningConfirmedAtUtc: string | null }
  radiusTiming: { offsetSeconds: number | null; wording: string }
  speedContext: { preStopBucket: PhysicalSpeedBucket | null; currentPercentile: number | null; referencePeriod: { fromUtc: string; toUtc: string; hours: number }; samePressBuckets: Array<{ bucket: PhysicalSpeedBucket; stats: StopRestartStats | null; observationCount: number; observedDurationSeconds: number; sharePercent: number; sustainedSpanCount: number }> }
  preStopFlags: Array<{ canonicalId: string; deckNumber: number | null; friendlyName: string; signalType: EngineeringSignalType; category: EngineeringCategory; direction: 'ABOVE' | 'BELOW'; current: StopRestartStats; reference: StopRestartStats; afterRestart: StopRestartStats | null; speedBucket: PhysicalSpeedBucket; referencePercentile: number; robustDeviation: number; excludedReferenceObservationsWithoutFreshSpeed: number; recovery: 'RETURNED_TOWARD_REFERENCE' | 'REMAINED_SHIFTED' | 'AFTER_RESTART_SPEED_NOT_COMPARABLE' | 'INSUFFICIENT_AFTER_RESTART_EVIDENCE'; wording: string }>
  noFlagMessage: string | null
  stopRestartContext: Array<{ atUtc: string; kind: 'SPEED' | 'RADIUS' | 'MOTION' | 'RAW_STATE'; label: string; canonicalId?: string; deckNumber?: number | null }>
  referenceMetadata: { status: 'AVAILABLE' | 'NOT_APPLICABLE' | 'INSUFFICIENT' | 'TEMPORARILY_UNAVAILABLE'; chunkHours: number; requestCount: number; candidateCount: number; excludedObservationsWithoutFreshSpeed: number; automaticCandidateLimit: number; flagLimit: number; cache: 'hit' | 'miss'; message: string }
  performance: { upstreamCalls: number; currentSelectors: number; referenceSelectors: number; totalMs: number; responsePayloadBytes: number }
}
export interface RadiusTimingAnalysisResponse {
  exactIdentity: { eventType: string; statusCode: string | null; statusDescription: string }
  occurrenceCount: number
  matchedCount: number
  beforeCount: number
  nearCount: number
  afterCount: number
  medianOffsetSeconds: number | null
  iqrSeconds: number | null
  minimumOffsetSeconds: number | null
  maximumOffsetSeconds: number | null
  byPress: Array<{ pressKey: RadiusPressKey; displayName: string; occurrenceCount: number; matchedCount: number; medianOffsetSeconds: number | null; medianSupport: 'SUPPORTED' | 'INSUFFICIENT' }>
  support: { analyzedOccurrenceCount: number; maximumOccurrences: number; pressMedianMinimumMatched: number; nearThresholdSeconds: number }
  performance: { upstreamCalls: number; cacheHits: number; totalMs: number }
}
export interface FleetSpeedContextResponse {
  referencePeriod: { fromUtc: string; toUtc: string; hours: number }
  presses: Array<{ pressKey: RadiusPressKey; status: 'AVAILABLE' | 'TEMPORARILY_UNAVAILABLE'; buckets: StopRestartResponse['speedContext']['samePressBuckets']; cache: 'hit' | 'miss' }>
  rawEngineeringComparison: { status: 'DEFERRED'; message: string }
  performance: { upstreamCalls: number; totalMs: number }
}

export interface EvidenceQuality {
  radius: 'available' | 'unavailable'
  classification: ClassificationStatus
  telemetry: 'available' | 'no_samples' | 'unavailable' | 'not_requested'
  context: 'available' | 'partial' | 'unavailable' | 'not_requested'
}

export interface EvidenceSubject extends PressRef, TimeRange {
  kind: 'radius_interval' | 'activity_occurrence' | 'operational_run'
  title: string
  durationSeconds: number
  radius?: RadiusEvidence[]
  classification?: SemanticClassificationRef
}

export interface CoverageMeasure {
  numerator: number
  denominator: number
  percentage: number | null
}

export interface CanonicalRunRef extends PressRef, TimeRange {
  runId: string
}

export function classificationRef(classification?: ResolvedRadiusClassification): SemanticClassificationRef {
  return classification ? {
    operationalGroupKey: classification.operationalGroupKey,
    operationalGroupName: classification.operationalGroupName,
    processFamilyKey: classification.processFamilyKey,
    processFamilyName: classification.processFamilyName,
    status: classification.isFallback ? 'needs_classification' : 'mapped',
    version: classification.mappingVersion,
  } : {
    operationalGroupKey: null,
    operationalGroupName: null,
    processFamilyKey: null,
    processFamilyName: null,
    status: 'unavailable',
    version: null,
  }
}
