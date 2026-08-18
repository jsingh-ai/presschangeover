import type { RadiusPressKey } from '../radius/models.js'
import type { PhysicalStateResponse, TelemetrySource } from './models.js'

export const TELEMETRY_REPRESENTATIONS = ['samples', 'changes'] as const
export type TelemetryRepresentation = (typeof TELEMETRY_REPRESENTATIONS)[number]

export const TELEMETRY_VALUE_KINDS = ['numeric', 'integer', 'boolean', 'string', 'text'] as const
export type TelemetryValueKind = (typeof TELEMETRY_VALUE_KINDS)[number]
export type TelemetryScalarValue = number | boolean | string
export type RawTelemetryValue = TelemetryScalarValue | null | RawTelemetryValue[] | { [key: string]: RawTelemetryValue }

export interface TelemetrySourceSignal {
  id: number
  sourceId: number
  signalId: string
  displayName: string
  sourceUnit: string | null
  valueKind: string
  enabled: boolean
}

export interface RawTelemetryChangesQuery {
  press: RadiusPressKey
  fromUtc: string
  toUtc: string
}

export interface RawTelemetryChangedSignal {
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
}

export interface RawTelemetryChangesResponse {
  press: RadiusPressKey
  displayName: string
  fromUtc: string
  toUtc: string
  rawCatalogIdentityCount: number
  canonicallyRepresentedIdentityCount: number
  unmappedIdentityCount: number
  usableIdentityCount: number
  changedIdentityCount: number
  framesRead: number
  historianReadCount: number
  signals: RawTelemetryChangedSignal[]
}

export interface RawTelemetryHistoryQuery {
  press: RadiusPressKey
  rawIdentity: string
  fromUtc: string
  toUtc: string
}

export interface RawTelemetryObservation {
  timestampUtc: string
  receivedAtUtc: string
  sourceTimestampUtc: string
  qualityState: string
  dataType: string
  rawValue: RawTelemetryValue
}

export interface RawTelemetryHistoryResponse {
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
  observations: RawTelemetryObservation[]
}

export interface TelemetrySample {
  observedAtUtc: string
  receivedAtUtc: string
  sourceTimestampUtc: string
  qualityState: string
  valueKind: TelemetryValueKind
  value: TelemetryScalarValue
}

export interface TelemetryChange extends TelemetrySample {
  previousObservedAtUtc: string
  previousReceivedAtUtc: string
  previousSourceTimestampUtc: string
  previousQualityState: string
  previousValueKind: TelemetryValueKind
  previousValue: TelemetryScalarValue
}

export interface TelemetryCapability {
  canonicalId: string
  supported: boolean
  deckNumbers: number[]
  historyQueryable: boolean
  evidenceKind: 'semantic_history' | 'derived'
}

export interface TelemetryCapabilitiesResponse {
  sourceId: number
  sourceKey: string
  displayName: string
  capabilities: TelemetryCapability[]
}

export interface TelemetrySemanticSelector {
  canonicalId: string
  deckNumber?: number
  representation: TelemetryRepresentation
}

export interface TelemetrySemanticHistoryQuery {
  fromUtc: string
  toUtc: string
  includeSeed: boolean
  signals: TelemetrySemanticSelector[]
}

export interface TelemetrySemanticSignalHistory {
  canonicalId: string
  deckNumber: number | null
  supported: boolean
  mappingStatus: 'MAPPED' | 'UNAVAILABLE' | 'UNMAPPED' | 'AMBIGUOUS'
  historianSignalId: number | null
  rawSignalId: string | null
  sourceUnit: string | null
  canonicalUnitStatus: string | null
  valueKind: TelemetryValueKind | null
  sourceSelector: string | null
  selectedVariant: string | null
  representation: TelemetryRepresentation
  seedSample: TelemetrySample | null
  samples: TelemetrySample[]
  changes: TelemetryChange[]
}

export interface TelemetrySemanticHistoryResponse {
  sourceId: number
  sourceKey: string
  displayName: string
  fromUtc: string
  toUtc: string
  includeSeed: boolean
  signals: TelemetrySemanticSignalHistory[]
}

export interface TelemetrySpeedSignal {
  canonicalId: 'machine.speed.actual' | 'machine.speed.setpoint'
  historianSignalId: number
  rawSignalId: string
  sourceUnit: string | null
  canonicalUnitStatus: string
  samples: TelemetrySample[]
}

export interface TelemetryMachineSpeedHistory {
  sourceId: number
  sourceKey: string
  displayName: string
  fromUtc: string
  toUtc: string
  actual: TelemetrySpeedSignal
  setpoint: TelemetrySpeedSignal | null
}

export type TelemetryMetadataStatus = 'FRESH' | 'CACHED' | 'STALE'
export type PressSourceAvailability = 'AVAILABLE' | 'DISABLED' | 'NO_SOURCE' | 'TEMPORARILY_UNAVAILABLE'

export interface TelemetryPressSourceStatus {
  pressKey: RadiusPressKey
  sourceKey: string | null
  displayName: string
  enabled: boolean | null
  availability: PressSourceAvailability
  metadataStatus: TelemetryMetadataStatus
}

export interface ResolvedTelemetrySource {
  pressKey: RadiusPressKey
  source: TelemetrySource
  metadataStatus: TelemetryMetadataStatus
}

export type CapabilityState = 'SUPPORTED' | 'UNSUPPORTED' | 'UNKNOWN' | 'TEMPORARILY_UNAVAILABLE'

export interface CapabilityAssessment {
  canonicalId: string
  state: CapabilityState
  lastKnownState?: Exclude<CapabilityState, 'TEMPORARILY_UNAVAILABLE'>
  deckNumbers: number[]
  historyQueryable: boolean
  evidenceKind: 'semantic_history' | 'derived' | null
}

export interface PressEvidenceCapabilities {
  pressKey: RadiusPressKey
  sourceId: number
  sourceKey: string
  displayName: string
  metadataStatus: TelemetryMetadataStatus
  capabilities: CapabilityAssessment[]
}

export type EvidenceObservationState =
  | 'UNSUPPORTED'
  | 'SUPPORTED_WITH_NO_SAMPLES_IN_RANGE'
  | 'SUPPORTED_WITH_SEED_ONLY'
  | 'SUPPORTED_WITH_OBSERVATIONS'

export interface PressSemanticSignalEvidence {
  canonicalId: string
  deckNumber: number | null
  capabilityState: CapabilityState
  observationState: EvidenceObservationState
  mappingStatus: TelemetrySemanticSignalHistory['mappingStatus']
  sourceUnit: string | null
  canonicalUnitStatus: string | null
  representation: TelemetryRepresentation
  seed: TelemetrySample | null
  samples: TelemetrySample[]
  changes: TelemetryChange[]
}

export interface PressSemanticHistoryEvidence {
  pressKey: RadiusPressKey
  sourceKey: string
  displayName: string
  fromUtc: string
  toUtc: string
  includeSeed: boolean
  signals: PressSemanticSignalEvidence[]
  readDiagnostics?: BoundedTelemetryReadDiagnostics
}

export interface TelemetryEvidenceGap {
  canonicalId: string
  deckNumber: number | null
  startUtc: string
  endUtc: string
  durationMs: number
}

export interface BoundedTelemetryReadDiagnostics {
  requestedRange: { start: string; end: string }
  chunkCount: number
  telemetryRequests: number
  cacheHits: number
  exactCacheHits?: number
  selectorSubsetCacheHits?: number
  containedRangeCacheHits?: number
  containedRangeSelectorSubsetCacheHits?: number
  cacheHitType?: 'EXACT' | 'SELECTOR_SUBSET' | 'CONTAINED_RANGE' | 'CONTAINED_RANGE_SELECTOR_SUBSET' | null
  cacheSourceRange?: { start: string; end: string } | null
  pointsReturned: number
  pointsRetained: number
  boundaryDuplicatesRemoved: number
  gaps: TelemetryEvidenceGap[]
  requests?: Array<{
    pressKey: string
    selectorCount: number
    selectors: string[]
    range: { start: string; end: string }
    chunkIndex: number
    durationMs: number
    pointsReturned: number
  }>
}

export const PRODUCTION_CONTEXT_FIELDS = ['job', 'order', 'recipe', 'customer', 'material', 'roll'] as const
export type ProductionContextField = (typeof PRODUCTION_CONTEXT_FIELDS)[number]

export const PRODUCTION_CONTEXT_CANONICAL_IDS: Record<ProductionContextField, string> = {
  job: 'production.job',
  order: 'production.order',
  recipe: 'production.recipe',
  customer: 'production.customer',
  material: 'production.material',
  roll: 'production.roll',
}

export interface ProductionContextFieldEvidence {
  field: ProductionContextField
  canonicalId: string
  capabilityState: CapabilityState
  observationState: EvidenceObservationState
  seed: TelemetrySample | null
  changes: TelemetryChange[]
}

export interface ProductionContextChange {
  atUtc: string
  field: ProductionContextField
  canonicalId: string
  previousValueKind: TelemetryValueKind
  previousValue: TelemetryScalarValue
  valueKind: TelemetryValueKind
  value: TelemetryScalarValue
  qualityState: string
}

export interface ProductionContextEvidence {
  pressKey: RadiusPressKey
  sourceKey: string
  displayName: string
  fromUtc: string
  toUtc: string
  fields: Record<ProductionContextField, ProductionContextFieldEvidence>
  changes: ProductionContextChange[]
}

export interface PressSpeedSignalEvidence {
  canonicalId: TelemetrySpeedSignal['canonicalId']
  observationState: 'SUPPORTED_WITH_NO_SAMPLES_IN_RANGE' | 'SUPPORTED_WITH_OBSERVATIONS'
  sourceUnit: string | null
  canonicalUnitStatus: string
  samples: TelemetrySample[]
}

export interface PressSpeedEvidence {
  pressKey: RadiusPressKey
  sourceKey: string
  displayName: string
  fromUtc: string
  toUtc: string
  actual: PressSpeedSignalEvidence
  setpoint: PressSpeedSignalEvidence | null
}

export interface PressMotionEvidence extends Omit<PhysicalStateResponse, 'sourceId'> {
  pressKey: RadiusPressKey
}

export const PHYSICAL_EVIDENCE_CATEGORIES = ['context', 'deck_states', 'register', 'impression', 'wash', 'pump', 'viscosity', 'ink_temperature'] as const
export type PhysicalEvidenceCategory = (typeof PHYSICAL_EVIDENCE_CATEGORIES)[number]

export interface CuratedPhysicalEvidenceRequest {
  fromUtc: string
  toUtc: string
  includeSeed: boolean
  categories: PhysicalEvidenceCategory[]
  deckNumbers?: number[]
  representation: TelemetryRepresentation
}

export interface CuratedPhysicalEvidence {
  pressKey: RadiusPressKey
  sourceKey: string
  displayName: string
  fromUtc: string
  toUtc: string
  requestedCategories: PhysicalEvidenceCategory[]
  capabilities: CapabilityAssessment[]
  signals: PressSemanticSignalEvidence[]
}
