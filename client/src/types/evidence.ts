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
