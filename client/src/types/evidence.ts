import type { PhysicalState, RadiusPressKey } from './api'

export interface PressRef {
  pressKey: RadiusPressKey
  displayName: string
}

export interface TimeRange {
  fromUtc: string
  toUtc: string
}

export type CapabilityState = 'SUPPORTED' | 'UNSUPPORTED' | 'UNKNOWN' | 'TEMPORARILY_UNAVAILABLE'
export type SourceAvailability = 'AVAILABLE' | 'DISABLED' | 'NO_SOURCE' | 'TEMPORARILY_UNAVAILABLE'
export type EvidenceObservationState = 'UNSUPPORTED' | 'SUPPORTED_WITH_NO_SAMPLES_IN_RANGE' | 'SUPPORTED_WITH_SEED_ONLY' | 'SUPPORTED_WITH_OBSERVATIONS'
export type TelemetryValueKind = 'numeric' | 'integer' | 'boolean' | 'string' | 'text'
export type TelemetryScalarValue = number | boolean | string
export type TelemetryRepresentation = 'samples' | 'changes'
export type ProductionContextField = 'job' | 'order' | 'recipe' | 'customer' | 'material' | 'roll'
export type PhysicalEvidenceCategory = 'context' | 'deck_states' | 'register' | 'impression' | 'wash' | 'pump' | 'viscosity' | 'ink_temperature'
export type DetailedHistoryState = 'DETAILED_AVAILABLE' | 'SOURCE_TELEMETRY_UNAVAILABLE' | 'SHARED_COLLECTION_OUTAGE' | 'INSUFFICIENT_DETAILED_TELEMETRY' | 'UNKNOWN'

export interface HistoricalTelemetryAvailabilityInterval {
  fromUtc: string
  toUtc: string
  state: 'SOURCE_TELEMETRY_UNAVAILABLE' | 'SHARED_COLLECTION_OUTAGE'
  witnessCount: number
}

export interface HistoricalTelemetryAvailability {
  state: DetailedHistoryState
  detailedTelemetryAvailable: boolean
  intervals: HistoricalTelemetryAvailabilityInterval[]
  reason: string
}

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
  sourceTimestampUtc: string | null
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
  previousSourceTimestampUtc: string | null
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
  historicalAvailability?: HistoricalTelemetryAvailability
}

export interface CuratedPhysicalEvidence extends PressRef, TimeRange {
  sourceKey: string
  requestedCategories: PhysicalEvidenceCategory[]
  capabilities: SignalCapability[]
  signals: SemanticSignalEvidence[]
}

export type EngineeringSignalType = 'continuous' | 'step_reference' | 'state_event'
export type EngineeringCategory = 'speed' | 'web_tension' | 'dryer' | 'ink' | 'viscosity' | 'temperature' | 'pump' | 'wash' | 'register' | 'impression' | 'torque' | 'drive_temperature' | 'doctor_blade' | 'repeat_other' | 'motion'
