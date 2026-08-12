import { TelemetryApiError } from './telemetry-error.js'
import {
  TELEMETRY_REPRESENTATIONS,
  TELEMETRY_VALUE_KINDS,
  type TelemetryCapabilitiesResponse,
  type TelemetryCapability,
  type TelemetryChange,
  type TelemetryMachineSpeedHistory,
  type TelemetryRepresentation,
  type TelemetrySample,
  type TelemetryScalarValue,
  type TelemetrySemanticHistoryResponse,
  type TelemetrySemanticSignalHistory,
  type TelemetrySpeedSignal,
  type TelemetryValueKind,
} from './telemetry-contracts.js'

type JsonRecord = Record<string, unknown>

function invalid(): never { throw new TelemetryApiError('invalid_response') }
export function isRecord(value: unknown): value is JsonRecord { return typeof value === 'object' && value !== null && !Array.isArray(value) }
export function requireRecord(value: unknown): JsonRecord { return isRecord(value) ? value : invalid() }
export function requireString(record: JsonRecord, key: string): string { const value = record[key]; return typeof value === 'string' && value.length > 0 ? value : invalid() }
export function requireBoolean(record: JsonRecord, key: string): boolean { const value = record[key]; return typeof value === 'boolean' ? value : invalid() }
export function requireNumber(record: JsonRecord, key: string): number { const value = record[key]; return typeof value === 'number' && Number.isFinite(value) ? value : invalid() }
export function requireInteger(record: JsonRecord, key: string): number { const value = requireNumber(record, key); return Number.isSafeInteger(value) ? value : invalid() }
export function requireTimestamp(record: JsonRecord, key: string): string { const value = requireString(record, key); return Number.isFinite(Date.parse(value)) ? value : invalid() }

function nullableString(record: JsonRecord, key: string): string | null {
  const value = record[key]
  return value === null ? null : typeof value === 'string' ? value : invalid()
}

function nullableInteger(record: JsonRecord, key: string): number | null {
  const value = record[key]
  return value === null ? null : typeof value === 'number' && Number.isSafeInteger(value) ? value : invalid()
}

function valueKind(value: unknown): TelemetryValueKind {
  return typeof value === 'string' && TELEMETRY_VALUE_KINDS.includes(value as TelemetryValueKind) ? value as TelemetryValueKind : invalid()
}

function scalar(kind: TelemetryValueKind, value: unknown): TelemetryScalarValue {
  if (kind === 'numeric' && typeof value === 'number' && Number.isFinite(value)) return value
  if (kind === 'integer' && typeof value === 'number' && Number.isSafeInteger(value)) return value
  if (kind === 'boolean' && typeof value === 'boolean') return value
  if ((kind === 'string' || kind === 'text') && typeof value === 'string') return value
  return invalid()
}

export function parseTelemetrySample(value: unknown): TelemetrySample {
  const record = requireRecord(value)
  const kind = valueKind(record.valueKind)
  return {
    observedAtUtc: requireTimestamp(record, 'observedAtUtc'),
    receivedAtUtc: requireTimestamp(record, 'receivedAtUtc'),
    sourceTimestampUtc: requireTimestamp(record, 'sourceTimestampUtc'),
    qualityState: requireString(record, 'qualityState'),
    valueKind: kind,
    value: scalar(kind, record.value),
  }
}

export function parseTelemetryChange(value: unknown): TelemetryChange {
  const record = requireRecord(value)
  const current = parseTelemetrySample(record)
  const previousKind = valueKind(record.previousValueKind)
  return {
    ...current,
    previousObservedAtUtc: requireTimestamp(record, 'previousObservedAtUtc'),
    previousReceivedAtUtc: requireTimestamp(record, 'previousReceivedAtUtc'),
    previousSourceTimestampUtc: requireTimestamp(record, 'previousSourceTimestampUtc'),
    previousQualityState: requireString(record, 'previousQualityState'),
    previousValueKind: previousKind,
    previousValue: scalar(previousKind, record.previousValue),
  }
}

function representation(value: unknown): TelemetryRepresentation {
  return typeof value === 'string' && TELEMETRY_REPRESENTATIONS.includes(value as TelemetryRepresentation) ? value as TelemetryRepresentation : invalid()
}

function capability(value: unknown): TelemetryCapability {
  const record = requireRecord(value)
  const decks = record.deckNumbers
  const evidenceKind = record.evidenceKind
  if (!Array.isArray(decks) || !decks.every((deck) => Number.isSafeInteger(deck) && Number(deck) > 0)) invalid()
  if (evidenceKind !== 'semantic_history' && evidenceKind !== 'derived') invalid()
  return {
    canonicalId: requireString(record, 'canonicalId'),
    supported: requireBoolean(record, 'supported'),
    deckNumbers: decks as number[],
    historyQueryable: requireBoolean(record, 'historyQueryable'),
    evidenceKind,
  }
}

export function parseCapabilitiesResponse(value: unknown): TelemetryCapabilitiesResponse {
  const record = requireRecord(value)
  if (!Array.isArray(record.capabilities)) invalid()
  const capabilities = record.capabilities.map(capability)
  if (new Set(capabilities.map(({ canonicalId }) => canonicalId)).size !== capabilities.length) invalid()
  return {
    sourceId: requireInteger(record, 'sourceId'),
    sourceKey: requireString(record, 'sourceKey'),
    displayName: requireString(record, 'displayName'),
    capabilities,
  }
}

function semanticSignal(value: unknown): TelemetrySemanticSignalHistory {
  const record = requireRecord(value)
  const rawMapping = record.mappingStatus
  const mappingStatuses = ['MAPPED', 'UNAVAILABLE', 'UNMAPPED', 'AMBIGUOUS'] as const
  if (typeof rawMapping !== 'string' || !mappingStatuses.includes(rawMapping as typeof mappingStatuses[number])) invalid()
  if (!Array.isArray(record.samples) || !Array.isArray(record.changes)) invalid()
  const rawDeck = record.deckNumber
  if (rawDeck !== null && (!Number.isSafeInteger(rawDeck) || Number(rawDeck) <= 0)) invalid()
  const rawKind = record.valueKind
  return {
    canonicalId: requireString(record, 'canonicalId'),
    deckNumber: rawDeck as number | null,
    supported: requireBoolean(record, 'supported'),
    mappingStatus: rawMapping as TelemetrySemanticSignalHistory['mappingStatus'],
    historianSignalId: nullableInteger(record, 'historianSignalId'),
    rawSignalId: nullableString(record, 'rawSignalId'),
    sourceUnit: nullableString(record, 'sourceUnit'),
    canonicalUnitStatus: nullableString(record, 'canonicalUnitStatus'),
    valueKind: rawKind === null ? null : valueKind(rawKind),
    sourceSelector: nullableString(record, 'sourceSelector'),
    selectedVariant: nullableString(record, 'selectedVariant'),
    representation: representation(record.representation),
    seedSample: record.seedSample === null ? null : parseTelemetrySample(record.seedSample),
    samples: record.samples.map(parseTelemetrySample),
    changes: record.changes.map(parseTelemetryChange),
  }
}

export function parseSemanticHistoryResponse(value: unknown): TelemetrySemanticHistoryResponse {
  const record = requireRecord(value)
  if (!Array.isArray(record.signals)) invalid()
  return {
    sourceId: requireInteger(record, 'sourceId'),
    sourceKey: requireString(record, 'sourceKey'),
    displayName: requireString(record, 'displayName'),
    fromUtc: requireTimestamp(record, 'fromUtc'),
    toUtc: requireTimestamp(record, 'toUtc'),
    includeSeed: requireBoolean(record, 'includeSeed'),
    signals: record.signals.map(semanticSignal),
  }
}

function speedSignal(value: unknown, expectedId: TelemetrySpeedSignal['canonicalId']): TelemetrySpeedSignal {
  const record = requireRecord(value)
  if (record.canonicalId !== expectedId || !Array.isArray(record.samples)) invalid()
  return {
    canonicalId: expectedId,
    historianSignalId: requireInteger(record, 'historianSignalId'),
    rawSignalId: requireString(record, 'rawSignalId'),
    sourceUnit: nullableString(record, 'sourceUnit'),
    canonicalUnitStatus: requireString(record, 'canonicalUnitStatus'),
    samples: record.samples.map(parseTelemetrySample),
  }
}

export function parseMachineSpeedHistory(value: unknown): TelemetryMachineSpeedHistory {
  const record = requireRecord(value)
  return {
    sourceId: requireInteger(record, 'sourceId'),
    sourceKey: requireString(record, 'sourceKey'),
    displayName: requireString(record, 'displayName'),
    fromUtc: requireTimestamp(record, 'fromUtc'),
    toUtc: requireTimestamp(record, 'toUtc'),
    actual: speedSignal(record.actual, 'machine.speed.actual'),
    setpoint: record.setpoint === null || record.setpoint === undefined ? null : speedSignal(record.setpoint, 'machine.speed.setpoint'),
  }
}
