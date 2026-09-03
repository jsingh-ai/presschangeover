import { randomUUID } from 'node:crypto'
import express, {
  type NextFunction,
  type Request,
  type Response,
} from 'express'
import {
  TelemetryApiError,
  type TelemetryClient,
} from './telemetry/telemetry-api-client.js'
import { RADIUS_PRESS_KEYS, type RadiusPressKey } from './radius/models.js'
import {
  RadiusNotFoundError,
  type RadiusService,
  RadiusUnavailableError,
  UnavailableRadiusService,
} from './radius/radius-service.js'
import type { ClassificationAuthorizer } from './classification/create-classification-service.js'
import { ClassificationConflictError } from './classification/classification-repository.js'
import { assertClassificationEditor, ClassificationForbiddenError, ClassificationService, ClassificationValidationError } from './classification/classification-service.js'
import { OPERATIONAL_GROUP_KEYS, PROCESS_FAMILY_KEYS, type MappingConfidence, type OperationalGroupKey, type ProcessFamilyKey, type RadiusIdentity } from './classification/models.js'
import { ObservedIdentityCache, type ObservedIdentitySnapshot } from './classification/observed-identity-cache.js'
import { exactRadiusIdentity } from './radius/radius-identity.js'
import { TelemetryFoundationService } from './telemetry/telemetry-foundation-service.js'
import { PHYSICAL_EVIDENCE_CATEGORIES, TELEMETRY_REPRESENTATIONS, type CuratedPhysicalEvidenceRequest, type TelemetryRepresentation, type TelemetrySemanticHistoryQuery } from './telemetry/telemetry-contracts.js'
import { RAW_EXPLORER_MAX_WINDOW_MINUTES, RawRadiusExplorerService, type RawExplorerOccurrence, type RawExplorerSetup, type RawExplorerSignalIdentity } from './raw-radius-explorer/raw-radius-explorer-service.js'
import { RAW_TELEMETRY_REVIEW_STATUSES, type RawTelemetryReviewService, type RawTelemetryReviewStatus } from './raw-radius-explorer/raw-telemetry-review-service.js'
import { TELEMETRY_EVENT_MAX_CONTEXT_MINUTES, TELEMETRY_EVENT_MAX_RANGE_MS, TelemetryEventExplorerService, type TelemetryEventOccurrence, type TelemetryEventSearchInput } from './telemetry-event-explorer/telemetry-event-explorer-service.js'
import { EXPLORER_HTTP_VALIDATION_CAPABILITIES } from './explorer-validation-capabilities.js'
import { JOB_ANALYSIS_DIMENSIONS, JOB_GROUP_OPERATORS, type JobGroupDefinition } from './job-intelligence/contracts.js'
import { JOB_INTELLIGENCE_MAX_RANGE_MS, JobIntelligenceService } from './job-intelligence/service.js'
import { CHANGEOVER_CONFIRMATION_SECONDS_DEFAULT, CHANGEOVER_RECOVERY_SPEED_DEFAULT, CHANGEOVER_STOP_SPEED_DEFAULT, type ChangeoverMode } from './changeover-intelligence/contracts.js'
import { ChangeoverIntelligenceService } from './changeover-intelligence/service.js'
import { hasStopIntelligenceCanonicalPolicy } from './stop-intelligence/configuration.js'
import { StopIntelligenceConfigurationError, StopIntelligenceService } from './stop-intelligence/service.js'
import { InMemoryStopIntelligenceCorrectionRepository, STOP_OPERATOR_DECISION_STATES, STOP_PREDICTED_STATES, StopIntelligenceCorrectionService, type StopIntelligenceCorrectionInput, type StopOperatorDecisionState, type StopPredictedState } from './stop-intelligence/correction-service.js'
import { MachineIntelligenceService } from './machine-intelligence/service.js'

const MAX_PHYSICAL_STATE_RANGE_MS = 2 * 60 * 60 * 1_000
const MAX_RADIUS_RANGE_MS = 31 * 24 * 60 * 60 * 1_000
const MAX_STOP_INTELLIGENCE_RANGE_MS = 72 * 60 * 60 * 1_000
const SAFE_REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/
const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/

interface Logger {
  info(message: string): void
  error(message: string): void
}

function sanitizeErrorText(value: string): string {
  return value
    .replace(
      /([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi,
      '$1[REDACTED]@',
    )
    .replace(
      /((?:password|passwd|pwd|secret|token|authorization|api[_-]?key)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1[REDACTED]',
    )
}

function unexpectedErrorLog(
  error: unknown,
  request: Request,
  requestId: string,
): string {
  const type = error instanceof Error ? error.name : typeof error
  const message = error instanceof Error ? error.message : String(error)
  const stack = error instanceof Error ? error.stack ?? '' : ''
  return JSON.stringify({
    requestId,
    method: request.method,
    route: request.path,
    status: 500,
    event: 'unexpected_error',
    error: {
      type: sanitizeErrorText(type),
      message: sanitizeErrorText(message),
      stack: sanitizeErrorText(stack),
    },
  })
}

export interface CreateAppOptions {
  telemetryClient: TelemetryClient
  now?: () => number
  radiusService?: RadiusService
  logger?: Logger | false
  classificationService?: ClassificationService
  classificationAuthorizer?: ClassificationAuthorizer
  rawTelemetryReviewService?: RawTelemetryReviewService
  stopIntelligenceCorrectionService?: StopIntelligenceCorrectionService
}

class RequestValidationError extends Error {
  constructor(public readonly code: string) {
    super(code)
    this.name = 'RequestValidationError'
  }
}

function isJsonBodyParseError(error: unknown): boolean {
  if (!(error instanceof SyntaxError) || typeof error !== 'object' || error === null) return false
  const parseError = error as { status?: unknown; type?: unknown }
  return parseError.status === 400 && parseError.type === 'entity.parse.failed'
}

function isPayloadTooLargeError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const payloadError = error as { status?: unknown; type?: unknown }
  return payloadError.status === 413 && payloadError.type === 'entity.too.large'
}

function requestIdFrom(request: Request): string {
  const supplied = request.header('X-Request-Id')
  return supplied && SAFE_REQUEST_ID_PATTERN.test(supplied)
    ? supplied
    : randomUUID()
}

function parseSourceId(value: string | string[]): number {
  if (Array.isArray(value) || !/^\d+$/.test(value)) {
    throw new RequestValidationError('invalid_source_id')
  }
  const sourceId = Number(value)
  if (!Number.isSafeInteger(sourceId) || sourceId <= 0) {
    throw new RequestValidationError('invalid_source_id')
  }
  return sourceId
}

function parseUtcTimestamp(value: unknown, errorCode: string): string {
  if (
    typeof value !== 'string' ||
    !UTC_TIMESTAMP_PATTERN.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new RequestValidationError(errorCode)
  }
  return value
}

function validateRange(query: Request['query']): {
  fromUtc: string
  toUtc: string
} {
  const fromUtc = parseUtcTimestamp(query.fromUtc, 'invalid_from_utc')
  const toUtc = parseUtcTimestamp(query.toUtc, 'invalid_to_utc')
  const rangeMs = Date.parse(toUtc) - Date.parse(fromUtc)

  if (rangeMs <= 0) {
    throw new RequestValidationError('invalid_time_range')
  }
  if (rangeMs > MAX_PHYSICAL_STATE_RANGE_MS) {
    throw new RequestValidationError('time_range_too_large')
  }

  return { fromUtc, toUtc }
}

function validateBodyRange(body: Record<string, unknown>): { fromUtc: string; toUtc: string } {
  const fromUtc = parseUtcTimestamp(body.fromUtc, 'invalid_from_utc')
  const toUtc = parseUtcTimestamp(body.toUtc, 'invalid_to_utc')
  const rangeMs = Date.parse(toUtc) - Date.parse(fromUtc)
  if (rangeMs <= 0) throw new RequestValidationError('invalid_time_range')
  if (rangeMs > MAX_PHYSICAL_STATE_RANGE_MS) throw new RequestValidationError('time_range_too_large')
  return { fromUtc, toUtc }
}

function validateTelemetryEventRange(body: Record<string, unknown>): { fromUtc: string; toUtc: string } {
  const fromUtc = parseUtcTimestamp(body.fromUtc, 'invalid_from_utc')
  const toUtc = parseUtcTimestamp(body.toUtc, 'invalid_to_utc')
  const rangeMs = Date.parse(toUtc) - Date.parse(fromUtc)
  if (rangeMs <= 0 || rangeMs > TELEMETRY_EVENT_MAX_RANGE_MS) throw new RequestValidationError('invalid_time_range')
  return { fromUtc, toUtc }
}

function parseRepresentation(value: unknown): TelemetryRepresentation {
  if (typeof value !== 'string' || !TELEMETRY_REPRESENTATIONS.includes(value as TelemetryRepresentation)) throw new RequestValidationError('invalid_telemetry_representation')
  return value as TelemetryRepresentation
}

function parseSemanticQuery(body: unknown): TelemetrySemanticHistoryQuery {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestValidationError('invalid_telemetry_query')
  const raw = body as Record<string, unknown>
  const { fromUtc, toUtc } = validateBodyRange(raw)
  if (typeof raw.includeSeed !== 'boolean' || !Array.isArray(raw.signals) || raw.signals.length < 1 || raw.signals.length > 50) throw new RequestValidationError('invalid_telemetry_query')
  const signals = raw.signals.map((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new RequestValidationError('invalid_telemetry_selector')
    const item = candidate as Record<string, unknown>
    if (typeof item.canonicalId !== 'string' || !/^[a-z0-9_.]{1,200}$/.test(item.canonicalId)) throw new RequestValidationError('invalid_telemetry_selector')
    if (item.deckNumber !== undefined && (!Number.isSafeInteger(item.deckNumber) || Number(item.deckNumber) < 1 || Number(item.deckNumber) > 100)) throw new RequestValidationError('invalid_telemetry_selector')
    return { canonicalId: item.canonicalId, ...(item.deckNumber === undefined ? {} : { deckNumber: Number(item.deckNumber) }), representation: parseRepresentation(item.representation) }
  })
  return { fromUtc, toUtc, includeSeed: raw.includeSeed, signals }
}

function parseEvidenceRequest(body: unknown): CuratedPhysicalEvidenceRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestValidationError('invalid_evidence_request')
  const raw = body as Record<string, unknown>
  const { fromUtc, toUtc } = validateBodyRange(raw)
  if (typeof raw.includeSeed !== 'boolean' || !Array.isArray(raw.categories) || raw.categories.length < 1 || !raw.categories.every((item) => typeof item === 'string' && PHYSICAL_EVIDENCE_CATEGORIES.includes(item as typeof PHYSICAL_EVIDENCE_CATEGORIES[number]))) throw new RequestValidationError('invalid_evidence_request')
  if (raw.deckNumbers !== undefined && (!Array.isArray(raw.deckNumbers) || raw.deckNumbers.length > 10 || !raw.deckNumbers.every((deck) => Number.isSafeInteger(deck) && Number(deck) >= 1 && Number(deck) <= 100))) throw new RequestValidationError('invalid_evidence_request')
  return { fromUtc, toUtc, includeSeed: raw.includeSeed, categories: [...new Set(raw.categories)] as CuratedPhysicalEvidenceRequest['categories'], ...(raw.deckNumbers === undefined ? {} : { deckNumbers: [...new Set(raw.deckNumbers as number[])] }), representation: parseRepresentation(raw.representation) }
}

function rawExplorerIdentity(value: unknown): RawExplorerSetup['identity'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RequestValidationError('invalid_raw_radius_identity')
  const raw = value as Record<string, unknown>
  if (raw.eventType !== 'G' && raw.eventType !== 'B' && raw.eventType !== 'M' && raw.eventType !== 'S') throw new RequestValidationError('invalid_raw_radius_identity')
  if (typeof raw.statusCode !== 'string' || !raw.statusCode.trim() || raw.statusCode.length > 128 || typeof raw.statusDescription !== 'string' || !raw.statusDescription.trim() || raw.statusDescription.length > 512) throw new RequestValidationError('invalid_raw_radius_identity')
  return { eventType: raw.eventType, statusCode: raw.statusCode, statusDescription: raw.statusDescription }
}

function rawExplorerMinutes(value: unknown, allowZero: boolean, code: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value > RAW_EXPLORER_MAX_WINDOW_MINUTES || (allowZero ? value < 0 : value <= 0)) throw new RequestValidationError(code)
  return value
}

function parseRawExplorerSetup(body: unknown): RawExplorerSetup {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestValidationError('invalid_raw_explorer_request')
  const raw = body as Record<string, unknown>
  const fromUtc = parseUtcTimestamp(raw.fromUtc, 'invalid_from_utc'); const toUtc = parseUtcTimestamp(raw.toUtc, 'invalid_to_utc')
  const rangeMs = Date.parse(toUtc) - Date.parse(fromUtc)
  if (rangeMs <= 0 || rangeMs > MAX_RADIUS_RANGE_MS) throw new RequestValidationError('invalid_time_range')
  return { fromUtc, toUtc, identity: rawExplorerIdentity(raw.identity), changeLookbackMinutes: rawExplorerMinutes(raw.changeLookbackMinutes, false, 'invalid_change_lookback'), chartContextMinutes: rawExplorerMinutes(raw.chartContextMinutes, true, 'invalid_chart_context') }
}

function parseRawExplorerOccurrence(value: unknown): RawExplorerOccurrence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RequestValidationError('invalid_raw_explorer_occurrence')
  const raw = value as Record<string, unknown>
  const pressKey = parsePressKey(String(raw.pressKey ?? ''))
  const startUtc = parseUtcTimestamp(raw.startUtc, 'invalid_raw_explorer_occurrence'); const endUtc = parseUtcTimestamp(raw.endUtc, 'invalid_raw_explorer_occurrence')
  const chartFromUtc = parseUtcTimestamp(raw.chartFromUtc, 'invalid_raw_explorer_occurrence'); const chartToUtc = parseUtcTimestamp(raw.chartToUtc, 'invalid_raw_explorer_occurrence')
  const maximumChartRangeMs = MAX_RADIUS_RANGE_MS + 2 * RAW_EXPLORER_MAX_WINDOW_MINUTES * 60_000
  if (Date.parse(endUtc) <= Date.parse(startUtc) || Date.parse(chartFromUtc) > Date.parse(startUtc) || Date.parse(chartToUtc) < Date.parse(endUtc) || Date.parse(chartToUtc) - Date.parse(chartFromUtc) > maximumChartRangeMs) throw new RequestValidationError('invalid_raw_explorer_occurrence')
  const identity = rawExplorerIdentity(raw)
  if (typeof raw.occurrenceId !== 'string' || !/^[A-Za-z0-9:._-]{1,300}$/.test(raw.occurrenceId) || typeof raw.displayName !== 'string' || !raw.displayName || raw.displayName.length > 100 || !Number.isSafeInteger(raw.pressOccurrenceIndex) || Number(raw.pressOccurrenceIndex) < 1 || !Number.isSafeInteger(raw.pressOccurrenceCount) || Number(raw.pressOccurrenceCount) < Number(raw.pressOccurrenceIndex)) throw new RequestValidationError('invalid_raw_explorer_occurrence')
  return { occurrenceId: raw.occurrenceId, pressKey, displayName: raw.displayName, pressOccurrenceIndex: Number(raw.pressOccurrenceIndex), pressOccurrenceCount: Number(raw.pressOccurrenceCount), ...identity, startUtc, endUtc, durationSeconds: (Date.parse(endUtc) - Date.parse(startUtc)) / 1_000, chartFromUtc, chartToUtc }
}

function parseRawExplorerSignal(value: unknown): RawExplorerSignalIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RequestValidationError('invalid_raw_explorer_signal')
  const raw = value as Record<string, unknown>
  const signalTypes = ['continuous', 'step_reference', 'state_event']; const categories = ['speed', 'web_tension', 'dryer', 'ink', 'viscosity', 'temperature', 'pump', 'wash', 'register', 'impression', 'torque', 'drive_temperature', 'doctor_blade', 'repeat_other', 'motion']
  if (typeof raw.canonicalId !== 'string' || !/^[a-z0-9_.]{1,200}$/.test(raw.canonicalId) || raw.deckNumber !== null && (!Number.isSafeInteger(raw.deckNumber) || Number(raw.deckNumber) < 1 || Number(raw.deckNumber) > 10) || typeof raw.friendlyName !== 'string' || !raw.friendlyName || !signalTypes.includes(String(raw.signalType)) || !categories.includes(String(raw.category)) || raw.scope !== 'machine' && raw.scope !== 'deck') throw new RequestValidationError('invalid_raw_explorer_signal')
  return { canonicalId: raw.canonicalId, deckNumber: raw.deckNumber === null ? null : Number(raw.deckNumber), friendlyName: raw.friendlyName, signalType: raw.signalType as RawExplorerSignalIdentity['signalType'], category: raw.category as RawExplorerSignalIdentity['category'], scope: raw.scope }
}

function parseRawIdentity(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2_000) throw new RequestValidationError('invalid_raw_telemetry_identity')
  return value
}

function parseRawReviewStatus(value: unknown): RawTelemetryReviewStatus {
  if (typeof value !== 'string' || !RAW_TELEMETRY_REVIEW_STATUSES.includes(value as RawTelemetryReviewStatus)) throw new RequestValidationError('invalid_raw_telemetry_review_status')
  return value as RawTelemetryReviewStatus
}

function parseTelemetryEventSource(value: unknown): TelemetryEventSearchInput['source'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RequestValidationError('invalid_telemetry_event_source')
  const raw = value as Record<string, unknown>
  if (raw.kind === 'canonical') {
    if (typeof raw.canonicalId !== 'string' || !/^[a-z0-9_.]{1,200}$/.test(raw.canonicalId)) throw new RequestValidationError('invalid_telemetry_event_source')
    return { kind: 'canonical', canonicalId: raw.canonicalId }
  }
  if (raw.kind === 'raw') {
    const rawIdentity = parseRawIdentity(raw.rawIdentity)
    if (typeof raw.displayName !== 'string' || !raw.displayName.trim() || raw.displayName.length > 300) throw new RequestValidationError('invalid_telemetry_event_source')
    return { kind: 'raw', pressKey: parsePressKey(String(raw.pressKey ?? '')), rawIdentity, displayName: raw.displayName, ...(typeof raw.dataType === 'string' ? { dataType: raw.dataType } : {}), ...(typeof raw.dataKind === 'string' ? { dataKind: raw.dataKind } : {}) }
  }
  throw new RequestValidationError('invalid_telemetry_event_source')
}

function parseTelemetryEventScalar(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean' || typeof value === 'string' && value.length <= 1_000) return value
  throw new RequestValidationError('invalid_telemetry_event_rule')
}

function parseTelemetryEventSearch(body: unknown): TelemetryEventSearchInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestValidationError('invalid_telemetry_event_search')
  const raw = body as Record<string, unknown>
  const fromUtc = parseUtcTimestamp(raw.fromUtc, 'invalid_from_utc'); const toUtc = parseUtcTimestamp(raw.toUtc, 'invalid_to_utc')
  const rangeMs = Date.parse(toUtc) - Date.parse(fromUtc)
  if (rangeMs <= 0 || rangeMs > TELEMETRY_EVENT_MAX_RANGE_MS) throw new RequestValidationError('invalid_time_range')
  const source = parseTelemetryEventSource(raw.source)
  const pressKey = raw.pressKey === 'all' ? 'all' : parsePressKey(String(raw.pressKey ?? ''))
  const deckNumber = raw.deckNumber === 'any' ? 'any' : raw.deckNumber === null ? null : Number(raw.deckNumber)
  if (deckNumber !== 'any' && deckNumber !== null && (!Number.isSafeInteger(deckNumber) || deckNumber < 1 || deckNumber > 10)) throw new RequestValidationError('invalid_telemetry_event_deck')
  if (!raw.rule || typeof raw.rule !== 'object' || Array.isArray(raw.rule)) throw new RequestValidationError('invalid_telemetry_event_rule')
  const ruleRaw = raw.rule as Record<string, unknown>
  let rule: TelemetryEventSearchInput['rule']
  if (ruleRaw.kind === 'threshold') {
    if (!['>', '>=', '<', '<='].includes(String(ruleRaw.operator)) || typeof ruleRaw.threshold !== 'number' || !Number.isFinite(ruleRaw.threshold)) throw new RequestValidationError('invalid_telemetry_event_rule')
    rule = { kind: 'threshold', operator: ruleRaw.operator as '>' | '>=' | '<' | '<=', threshold: ruleRaw.threshold }
  } else if (ruleRaw.kind === 'delta') {
    if (!['increase', 'decrease', 'either'].includes(String(ruleRaw.direction)) || typeof ruleRaw.amount !== 'number' || !Number.isFinite(ruleRaw.amount) || ruleRaw.amount <= 0 || !Number.isSafeInteger(ruleRaw.windowMinutes) || Number(ruleRaw.windowMinutes) < 1 || Number(ruleRaw.windowMinutes) > 1_440) throw new RequestValidationError('invalid_telemetry_event_rule')
    rule = { kind: 'delta', direction: ruleRaw.direction as 'increase' | 'decrease' | 'either', amount: ruleRaw.amount, windowMinutes: Number(ruleRaw.windowMinutes) }
  } else if (ruleRaw.kind === 'value_change') {
    if (!['any', 'becomes', 'from_to'].includes(String(ruleRaw.match))) throw new RequestValidationError('invalid_telemetry_event_rule')
    const match = ruleRaw.match as 'any' | 'becomes' | 'from_to'
    rule = match === 'any' ? { kind: 'value_change', match } : match === 'becomes' ? { kind: 'value_change', match, becomesValue: parseTelemetryEventScalar(ruleRaw.becomesValue) } : { kind: 'value_change', match, fromValue: parseTelemetryEventScalar(ruleRaw.fromValue), toValue: parseTelemetryEventScalar(ruleRaw.toValue) }
  } else throw new RequestValidationError('invalid_telemetry_event_rule')
  if (!Number.isSafeInteger(raw.chartContextMinutes) || Number(raw.chartContextMinutes) < 0 || Number(raw.chartContextMinutes) > TELEMETRY_EVENT_MAX_CONTEXT_MINUTES) throw new RequestValidationError('invalid_telemetry_event_context')
  if (source.kind === 'raw' && (pressKey === 'all' || pressKey !== source.pressKey || deckNumber !== null)) throw new RequestValidationError('invalid_telemetry_event_source_scope')
  return { fromUtc, toUtc, source, pressKey, deckNumber, rule, chartContextMinutes: Number(raw.chartContextMinutes) }
}

function parseTelemetryEventOccurrence(value: unknown): TelemetryEventOccurrence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RequestValidationError('invalid_telemetry_event_occurrence')
  const raw = value as Record<string, unknown>
  const occurrenceId = typeof raw.occurrenceId === 'string' && raw.occurrenceId.length <= 2_000 ? raw.occurrenceId : undefined
  const sourceKind = raw.sourceKind === 'canonical' || raw.sourceKind === 'raw' ? raw.sourceKind : undefined
  const eventType = raw.eventType === 'threshold' || raw.eventType === 'delta' || raw.eventType === 'value_change' ? raw.eventType : undefined
  const startUtc = parseUtcTimestamp(raw.startUtc, 'invalid_telemetry_event_occurrence'); const endUtc = parseUtcTimestamp(raw.endUtc, 'invalid_telemetry_event_occurrence')
  const chartFromUtc = parseUtcTimestamp(raw.chartFromUtc, 'invalid_telemetry_event_occurrence'); const chartToUtc = parseUtcTimestamp(raw.chartToUtc, 'invalid_telemetry_event_occurrence')
  if (!occurrenceId || !sourceKind || !eventType || Date.parse(endUtc) < Date.parse(startUtc) || Date.parse(chartFromUtc) > Date.parse(startUtc) || Date.parse(chartToUtc) < Date.parse(endUtc) || Date.parse(chartToUtc) - Date.parse(chartFromUtc) > (TELEMETRY_EVENT_MAX_CONTEXT_MINUTES * 2 * 60_000 + TELEMETRY_EVENT_MAX_RANGE_MS)) throw new RequestValidationError('invalid_telemetry_event_occurrence')
  if (typeof raw.displayName !== 'string' || typeof raw.rawIdentity !== 'string' || !raw.rawIdentity || raw.rawIdentity.length > 2_000 || typeof raw.signalDisplayName !== 'string' || !raw.signalDisplayName || raw.signalDisplayName.length > 300) throw new RequestValidationError('invalid_telemetry_event_occurrence')
  if (raw.canonicalId !== null && (typeof raw.canonicalId !== 'string' || !/^[a-z0-9_.]{1,200}$/.test(raw.canonicalId))) throw new RequestValidationError('invalid_telemetry_event_occurrence')
  if (raw.deckNumber !== null && (!Number.isSafeInteger(raw.deckNumber) || Number(raw.deckNumber) < 1 || Number(raw.deckNumber) > 10)) throw new RequestValidationError('invalid_telemetry_event_occurrence')
  const numeric = (name: string, required = false) => { const candidate = raw[name]; if (candidate === undefined && !required) return undefined; if (typeof candidate !== 'number' || !Number.isFinite(candidate)) throw new RequestValidationError('invalid_telemetry_event_occurrence'); return candidate }
  for (const name of ['extremeAtUtc', 'baselineAtUtc', 'triggerAtUtc', 'maximumExcursionAtUtc'] as const) if (raw[name] !== undefined) parseUtcTimestamp(raw[name], 'invalid_telemetry_event_occurrence')
  if (eventType === 'value_change') {
    parseUtcTimestamp(raw.transitionAtUtc, 'invalid_telemetry_event_occurrence')
    if (raw.previousAtUtc !== null) parseUtcTimestamp(raw.previousAtUtc, 'invalid_telemetry_event_occurrence')
    parseTelemetryEventScalar(raw.previousValue); parseTelemetryEventScalar(raw.newValue)
  }
  return { ...(raw as unknown as TelemetryEventOccurrence), occurrenceId, sourceKind, eventType, pressKey: parsePressKey(String(raw.pressKey ?? '')), displayName: raw.displayName, deckNumber: raw.deckNumber === null ? null : Number(raw.deckNumber), canonicalId: raw.canonicalId as string | null, rawIdentity: raw.rawIdentity, signalDisplayName: raw.signalDisplayName, startUtc, endUtc, chartFromUtc, chartToUtc, durationSeconds: numeric('durationSeconds', true)!, pressOccurrenceIndex: numeric('pressOccurrenceIndex', true)!, pressOccurrenceCount: numeric('pressOccurrenceCount', true)!, clippedEnd: Boolean(raw.clippedEnd), dataGap: Boolean(raw.dataGap) }
}

function cancellationSignal(request: Request, response: Response): AbortSignal {
  const controller = new AbortController()
  request.once('aborted', () => controller.abort())
  response.once('close', () => { if (!response.writableEnded) controller.abort() })
  return controller.signal
}

function validateRadiusRange(query: Request['query']): {
  fromUtc: string
  toUtc: string
} {
  const fromUtc = parseUtcTimestamp(query.fromUtc, 'invalid_from_utc')
  const toUtc = parseUtcTimestamp(query.toUtc, 'invalid_to_utc')
  const rangeMs = Date.parse(toUtc) - Date.parse(fromUtc)
  if (rangeMs <= 0) throw new RequestValidationError('invalid_time_range')
  if (rangeMs > MAX_RADIUS_RANGE_MS) {
    throw new RequestValidationError('time_range_too_large')
  }
  return { fromUtc, toUtc }
}

function parseChangeoverNumber(value: unknown, fallback: number, minimum: number, maximum: number, code: string): number {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || !value.trim()) throw new RequestValidationError(code)
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) throw new RequestValidationError(code)
  return parsed
}

function parseChangeoverQuery(query: Request['query']) {
  const { fromUtc, toUtc } = validateRadiusRange(query)
  const mode: ChangeoverMode = query.mode === undefined ? 'CHANGEOVERS' : query.mode === 'CHANGEOVERS' || query.mode === 'ALL_STOPS' ? query.mode : (() => { throw new RequestValidationError('invalid_changeover_mode') })()
  const stopSpeed = parseChangeoverNumber(query.stopSpeed, CHANGEOVER_STOP_SPEED_DEFAULT, 0, 100, 'invalid_changeover_stop_speed')
  const recoverySpeed = parseChangeoverNumber(query.recoverySpeed, CHANGEOVER_RECOVERY_SPEED_DEFAULT, 1, 10_000, 'invalid_changeover_recovery_speed')
  const recoveryConfirmationSeconds = parseChangeoverNumber(query.recoveryConfirmationSeconds, CHANGEOVER_CONFIRMATION_SECONDS_DEFAULT, 30, 1_800, 'invalid_changeover_confirmation')
  if (recoverySpeed <= stopSpeed) throw new RequestValidationError('invalid_changeover_thresholds')
  const focusPressKey = query.focusPressKey === undefined ? null : parsePressKey(String(query.focusPressKey))
  return { fromUtc, toUtc, mode, stopSpeed, recoverySpeed, recoveryConfirmationSeconds, focusPressKey }
}

function parseStopIntelligenceQuery(query: Request['query']) {
  const { fromUtc, toUtc } = validateRadiusRange(query)
  const pressKey = parsePressKey(String(query.pressKey ?? ''))
  if (!hasStopIntelligenceCanonicalPolicy(pressKey)) throw new RequestValidationError('stop_intelligence_press_not_configured')
  if (Date.parse(toUtc) - Date.parse(fromUtc) > MAX_STOP_INTELLIGENCE_RANGE_MS) throw new RequestValidationError('stop_intelligence_range_too_large')
  return { pressKey, fromUtc, toUtc }
}

function parseStopIntelligenceCorrection(value: unknown): StopIntelligenceCorrectionInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RequestValidationError('invalid_stop_intelligence_correction')
  const raw = value as Record<string, unknown>
  const pressKey = parsePressKey(String(raw.pressKey ?? ''))
  if (!hasStopIntelligenceCanonicalPolicy(pressKey)) throw new RequestValidationError('stop_intelligence_press_not_configured')
  const segmentKey = typeof raw.segmentKey === 'string' ? raw.segmentKey.trim() : ''
  if (!/^[A-Za-z0-9:._-]{1,200}$/.test(segmentKey)) throw new RequestValidationError('invalid_stop_intelligence_segment_key')
  const fromUtc = parseUtcTimestamp(raw.fromUtc, 'invalid_stop_intelligence_correction_from')
  const toUtc = parseUtcTimestamp(raw.toUtc, 'invalid_stop_intelligence_correction_to')
  const durationMs = Date.parse(toUtc) - Date.parse(fromUtc)
  if (durationMs <= 0 || durationMs > MAX_STOP_INTELLIGENCE_RANGE_MS) throw new RequestValidationError('invalid_stop_intelligence_correction_range')
  const predictedState = String(raw.predictedState ?? '') as StopPredictedState
  const correctedState = String(raw.correctedState ?? '') as StopOperatorDecisionState
  if (!STOP_PREDICTED_STATES.includes(predictedState)) throw new RequestValidationError('invalid_stop_intelligence_predicted_state')
  if (!STOP_OPERATOR_DECISION_STATES.includes(correctedState)) throw new RequestValidationError('invalid_stop_intelligence_corrected_state')
  if (raw.comment !== undefined && raw.comment !== null && typeof raw.comment !== 'string') throw new RequestValidationError('invalid_stop_intelligence_correction_comment')
  const comment = typeof raw.comment === 'string' ? raw.comment.trim() : ''
  if (comment.length > 1_000) throw new RequestValidationError('invalid_stop_intelligence_correction_comment')
  return { pressKey, segmentKey, fromUtc, toUtc, predictedState, correctedState, comment: comment || null }
}

function parsePressKey(value: string | string[]): RadiusPressKey {
  if (
    Array.isArray(value) ||
    !RADIUS_PRESS_KEYS.includes(value as RadiusPressKey)
  ) {
    throw new RequestValidationError('invalid_press_key')
  }
  return value as RadiusPressKey
}

function asyncRoute(
  handler: (request: Request, response: Response) => Promise<void>,
) {
  return (request: Request, response: Response, next: NextFunction): void => {
    handler(request, response).catch(next)
  }
}

export function createApp({
  telemetryClient,
  now = () => Date.now(),
  radiusService = new UnavailableRadiusService(),
  logger = console,
  classificationService,
  classificationAuthorizer = () => ({ id: 'anonymous', canEdit: false }),
  rawTelemetryReviewService,
  stopIntelligenceCorrectionService = new StopIntelligenceCorrectionService(new InMemoryStopIntelligenceCorrectionRepository()),
}: CreateAppOptions) {
  const app = express()
  const telemetry = new TelemetryFoundationService(telemetryClient, {
    now,
    onSemanticHistoryDiagnostic: (diagnostic) => {
      if (logger) logger.info(JSON.stringify({ event: 'semantic_history_read', ...diagnostic }))
    },
  })
  const rawRadiusExplorer = new RawRadiusExplorerService(radiusService, telemetry, rawTelemetryReviewService)
  const telemetryEventExplorer = new TelemetryEventExplorerService(telemetry, radiusService, rawRadiusExplorer)
  const jobIntelligence = new JobIntelligenceService(radiusService, telemetry)
  const changeoverIntelligence = new ChangeoverIntelligenceService(radiusService, telemetry)
  const stopIntelligence = new StopIntelligenceService(telemetry, radiusService, now, stopIntelligenceCorrectionService)
  const machineIntelligence = new MachineIntelligenceService(stopIntelligence, now)
  const observedIdentityCache = new ObservedIdentityCache(
    () => radiusService.getObservedIdentities?.() ?? Promise.resolve([]),
    { onRefreshError: () => { if (logger) logger.error('classification_observed_identity_refresh_unavailable') } },
  )

  app.use((request, response, next) => {
    const requestId = requestIdFrom(request)
    response.locals.requestId = requestId
    response.setHeader('X-Request-Id', requestId)

    if (logger) {
      response.on('finish', () => {
        logger.info(
          `[${requestId}] ${request.method} ${request.path} ${response.statusCode}`,
        )
      })
    }
    next()
  })
  app.use(express.json({ limit: '256kb' }))

  app.get('/api/health', (_request, response) => {
    response.status(200).json({
      service: 'ProcessIntelligence',
      status: 'healthy',
      explorerHttpValidation: EXPLORER_HTTP_VALIDATION_CAPABILITIES,
    })
  })

  app.get(
    '/api/telemetry/health',
    asyncRoute(async (_request, response) => {
      const requestId = String(response.locals.requestId)
      const [telemetryApi, historian] = await Promise.all([
        telemetryClient.getHealth(requestId),
        telemetryClient.getDatabaseHealth(requestId),
      ])
      const healthy =
        telemetryApi.status === 'healthy' && historian.status === 'healthy'

      response.status(healthy ? 200 : 503).json({
        status: healthy ? 'healthy' : 'unavailable',
        telemetryApi: { status: telemetryApi.status },
        historian: {
          status: historian.status,
          database: historian.database,
        },
      })
    }),
  )

  app.get('/api/telemetry/presses', asyncRoute(async (request, response) => {
    response.status(200).json(await telemetry.sources.presses(String(response.locals.requestId), cancellationSignal(request, response)))
  }))

  app.get('/api/telemetry/presses/:pressKey/capabilities', asyncRoute(async (request, response) => {
    const result = await telemetry.capabilities.get(parsePressKey(request.params.pressKey), String(response.locals.requestId), cancellationSignal(request, response))
    const { sourceId: _sourceId, ...publicResult } = result
    response.status(200).json(publicResult)
  }))

  app.get('/api/telemetry/presses/:pressKey/speed', asyncRoute(async (request, response) => {
    const { fromUtc, toUtc } = validateRange(request.query)
    response.status(200).json(await telemetry.speed(parsePressKey(request.params.pressKey), fromUtc, toUtc, String(response.locals.requestId), cancellationSignal(request, response)))
  }))

  app.get('/api/telemetry/presses/:pressKey/motion', asyncRoute(async (request, response) => {
    const { fromUtc, toUtc } = validateRange(request.query)
    response.status(200).json(await telemetry.motion(parsePressKey(request.params.pressKey), fromUtc, toUtc, String(response.locals.requestId), cancellationSignal(request, response)))
  }))

  app.post('/api/telemetry/presses/:pressKey/semantic-history', asyncRoute(async (request, response) => {
    response.status(200).json(await telemetry.semanticHistory(parsePressKey(request.params.pressKey), parseSemanticQuery(request.body), String(response.locals.requestId), cancellationSignal(request, response)))
  }))

  app.post('/api/telemetry/presses/:pressKey/context', asyncRoute(async (request, response) => {
    if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) throw new RequestValidationError('invalid_context_request')
    const { fromUtc, toUtc } = validateBodyRange(request.body as Record<string, unknown>)
    response.status(200).json(await telemetry.context(parsePressKey(request.params.pressKey), fromUtc, toUtc, String(response.locals.requestId), cancellationSignal(request, response)))
  }))

  app.post('/api/telemetry/presses/:pressKey/evidence', asyncRoute(async (request, response) => {
    response.status(200).json(await telemetry.evidence(parsePressKey(request.params.pressKey), parseEvidenceRequest(request.body), String(response.locals.requestId), cancellationSignal(request, response)))
  }))

  app.get(
    '/api/telemetry/sources',
    asyncRoute(async (_request, response) => {
      const sources = await telemetryClient.getSources(
        String(response.locals.requestId),
      )
      response.status(200).json(
        sources.map(({ id, sourceKey, displayName, enabled }) => ({
          id,
          sourceKey,
          displayName,
          enabled,
        })),
      )
    }),
  )

  app.get(
    '/api/telemetry/sources/:sourceId/physical-state',
    asyncRoute(async (request, response) => {
      const sourceId = parseSourceId(request.params.sourceId)
      const { fromUtc, toUtc } = validateRange(request.query)
      const physicalState = await telemetryClient.getPhysicalState(
        sourceId,
        fromUtc,
        toUtc,
        String(response.locals.requestId),
      )
      response.status(200).json(physicalState)
    }),
  )

  app.get(
    '/api/radius/health',
    asyncRoute(async (_request, response) => {
      const health = await radiusService.getHealth()
      response.status(health.status === 'healthy' ? 200 : 503).json(health)
    }),
  )

  app.get('/api/job-intelligence/report', asyncRoute(async (request, response) => {
    const { fromUtc, toUtc } = validateRadiusRange(request.query)
    if (Date.parse(toUtc) - Date.parse(fromUtc) > JOB_INTELLIGENCE_MAX_RANGE_MS) throw new RequestValidationError('job_intelligence_range_too_large')
    const pressKey = parsePressKey(String(request.query.pressKey ?? ''))
    const analyzeBy = String(request.query.analyzeBy ?? '')
    if (!JOB_ANALYSIS_DIMENSIONS.includes(analyzeBy as (typeof JOB_ANALYSIS_DIMENSIONS)[number])) throw new RequestValidationError('invalid_job_analysis_dimension')
    const operator = request.query.operator === undefined ? undefined : String(request.query.operator)
    const query = request.query.query === undefined ? undefined : String(request.query.query).trim()
    let group: JobGroupDefinition | undefined
    if (operator !== undefined || query !== undefined) {
      if (!operator || !JOB_GROUP_OPERATORS.includes(operator as (typeof JOB_GROUP_OPERATORS)[number]) || !query || query.length > 240) throw new RequestValidationError('invalid_job_group')
      const optionalInteger = (value: unknown, maximum: number) => { if (value === undefined) return undefined; const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) throw new RequestValidationError('invalid_job_group'); return parsed }
      const delimiter = request.query.delimiter === undefined ? undefined : String(request.query.delimiter)
      if (delimiter !== undefined && (!delimiter.length || delimiter.length > 3)) throw new RequestValidationError('invalid_job_group')
      group = { operator: operator as JobGroupDefinition['operator'], query, positionStart: optionalInteger(request.query.positionStart, 240), positionEnd: optionalInteger(request.query.positionEnd, 240), segmentIndex: optionalInteger(request.query.segmentIndex, 20), delimiter }
      if (group.operator === 'position_range' && (group.positionStart === undefined || group.positionEnd === undefined || group.positionEnd < group.positionStart) || group.operator === 'segment_equals' && group.segmentIndex === undefined) throw new RequestValidationError('invalid_job_group')
    }
    response.status(200).json(await jobIntelligence.report({ pressKey, fromUtc, toUtc, analyzeBy: analyzeBy as (typeof JOB_ANALYSIS_DIMENSIONS)[number], group }, String(response.locals.requestId), cancellationSignal(request, response)))
  }))

  app.get('/api/changeover-intelligence/report', asyncRoute(async (request, response) => {
    response.status(200).json(await changeoverIntelligence.report(parseChangeoverQuery(request.query), String(response.locals.requestId), cancellationSignal(request, response)))
  }))

  app.get('/api/stop-intelligence/presses/:pressKey', asyncRoute(async (request, response) => {
    const query = parseStopIntelligenceQuery({ ...request.query, pressKey: request.params.pressKey })
    response.status(200).json(await stopIntelligence.analyze(query, String(response.locals.requestId), cancellationSignal(request, response)))
  }))

  app.get('/api/stop-intelligence/fleet', asyncRoute(async (request, response) => {
    response.status(200).json(await stopIntelligence.fleet(parseStopIntelligenceQuery(request.query), String(response.locals.requestId), cancellationSignal(request, response)))
  }))

  app.get('/api/stop-intelligence/presses/:pressKey/production-attributes', asyncRoute(async (request, response) => {
    const query = parseStopIntelligenceQuery({ ...request.query, pressKey: request.params.pressKey })
    response.status(200).json(await stopIntelligence.productionAttributes(query, String(response.locals.requestId), cancellationSignal(request, response)))
  }))

  app.get('/api/machine-intelligence/presses/:pressKey', asyncRoute(async (request, response) => {
    const query = parseStopIntelligenceQuery({ ...request.query, pressKey: request.params.pressKey })
    response.status(200).json(await machineIntelligence.press(query, String(response.locals.requestId), cancellationSignal(request, response)))
  }))

  app.get('/api/stop-intelligence/presses/:pressKey/stops/:stopId', asyncRoute(async (request, response) => {
    const query = parseStopIntelligenceQuery({ ...request.query, pressKey: request.params.pressKey })
    const stopId = request.params.stopId
    if (Array.isArray(stopId) || !/^press(?:3|5|6|7|8|9|10|11|12|13|14|15)-\d{1,16}$/.test(stopId)) throw new RequestValidationError('invalid_stop_intelligence_stop_id')
    const includeRawValue = request.query.includeRaw
    if (Array.isArray(includeRawValue) || includeRawValue !== undefined && includeRawValue !== 'true' && includeRawValue !== 'false') throw new RequestValidationError('invalid_include_raw')
    const detail = await stopIntelligence.detail({ ...query, stopId, includeRaw: includeRawValue === 'true' }, String(response.locals.requestId), cancellationSignal(request, response))
    if (!detail) { response.status(404).json({ error: 'stop_intelligence_stop_not_found' }); return }
    response.status(200).json(detail)
  }))

  app.post('/api/stop-intelligence/corrections', asyncRoute(async (request, response) => {
    assertClassificationEditor(classificationAuthorizer(request))
    response.status(201).json(await stopIntelligenceCorrectionService.append(parseStopIntelligenceCorrection(request.body)))
  }))

  app.get('/api/changeover-intelligence/changeovers/:changeoverId', asyncRoute(async (request, response) => {
    const changeoverId = request.params.changeoverId
    if (Array.isArray(changeoverId) || !/^[A-Za-z0-9._-]{1,160}$/.test(changeoverId)) throw new RequestValidationError('invalid_changeover_id')
    const query = parseChangeoverQuery(request.query)
    const pressKey = parsePressKey(String(request.query.pressKey ?? ''))
    const physicalStartUtc = parseUtcTimestamp(request.query.physicalStartUtc, 'invalid_physical_start_utc')
    const physicalRecoveryUtc = parseUtcTimestamp(request.query.physicalRecoveryUtc, 'invalid_physical_recovery_utc')
    if (Date.parse(physicalRecoveryUtc) <= Date.parse(physicalStartUtc)) throw new RequestValidationError('invalid_physical_changeover_range')
    const result = await changeoverIntelligence.inspect({ ...query, changeoverId, pressKey, physicalStartUtc, physicalRecoveryUtc }, String(response.locals.requestId), cancellationSignal(request, response))
    if (!result) { response.status(404).json({ error: 'changeover_not_found' }); return }
    response.status(200).json(result)
  }))

  app.get(
    '/api/radius/overview',
    asyncRoute(async (request, response) => {
      const { fromUtc, toUtc } = validateRadiusRange(request.query)
      const overview = await radiusService.getOverview(fromUtc, toUtc)
      if (request.query.view === 'decision') {
        response.status(200).json({
          ...overview,
          presses: overview.presses.map((press) => ({ ...press, timelineSegments: [] })),
        })
        return
      }
      response.status(200).json(overview)
    }),
  )

  app.get('/api/radius/raw-explorer/identities', asyncRoute(async (request, response) => {
    const { fromUtc, toUtc } = validateRadiusRange(request.query)
    response.status(200).json(await rawRadiusExplorer.identities(fromUtc, toUtc))
  }))

  app.post('/api/radius/raw-explorer/explore', asyncRoute(async (request, response) => {
    response.status(200).json(await rawRadiusExplorer.explore(parseRawExplorerSetup(request.body)))
  }))

  app.post('/api/radius/raw-explorer/detail', asyncRoute(async (request, response) => {
    if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) throw new RequestValidationError('invalid_raw_explorer_request')
    const raw = request.body as Record<string, unknown>
    response.status(200).json(await rawRadiusExplorer.detail({ occurrence: parseRawExplorerOccurrence(raw.occurrence), changeLookbackMinutes: rawExplorerMinutes(raw.changeLookbackMinutes, false, 'invalid_change_lookback') }, String(response.locals.requestId), cancellationSignal(request, response), raw.includeRawTelemetryDiscovery === false ? { includeRawTelemetryDiscovery: false } : undefined))
  }))

  app.post('/api/radius/raw-explorer/history', asyncRoute(async (request, response) => {
    if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) throw new RequestValidationError('invalid_raw_explorer_history_request')
    const raw = request.body as Record<string, unknown>; const lookbackDays = raw.lookbackDays === undefined ? undefined : Number(raw.lookbackDays); const maximumOccurrences = raw.maximumOccurrences === undefined ? undefined : Number(raw.maximumOccurrences)
    if (lookbackDays !== undefined && (!Number.isSafeInteger(lookbackDays) || lookbackDays < 1 || lookbackDays > 31) || maximumOccurrences !== undefined && (!Number.isSafeInteger(maximumOccurrences) || maximumOccurrences < 1 || maximumOccurrences > 100)) throw new RequestValidationError('invalid_raw_explorer_history_bounds')
    response.status(200).json(await rawRadiusExplorer.historicalSummary({ occurrence: parseRawExplorerOccurrence(raw.occurrence), lookbackDays, maximumOccurrences }))
  }))

  app.post('/api/radius/raw-explorer/report', asyncRoute(async (request, response) => {
    response.status(200).json(await rawRadiusExplorer.eventLearningReport({ occurrence: parseRawExplorerOccurrence(request.body?.occurrence) }, String(response.locals.requestId), cancellationSignal(request, response)))
  }))

  app.post('/api/radius/raw-explorer/plot', asyncRoute(async (request, response) => {
    if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) throw new RequestValidationError('invalid_raw_explorer_request')
    const raw = request.body as Record<string, unknown>
    response.status(200).json(await rawRadiusExplorer.plot({ occurrence: parseRawExplorerOccurrence(raw.occurrence), signal: parseRawExplorerSignal(raw.signal) }, String(response.locals.requestId), cancellationSignal(request, response)))
  }))

  app.post('/api/radius/raw-explorer/raw-plot', asyncRoute(async (request, response) => {
    if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) throw new RequestValidationError('invalid_raw_explorer_request')
    const raw = request.body as Record<string, unknown>
    response.status(200).json(await rawRadiusExplorer.rawPlot({ occurrence: parseRawExplorerOccurrence(raw.occurrence), rawIdentity: parseRawIdentity(raw.rawIdentity) }, String(response.locals.requestId), cancellationSignal(request, response)))
  }))

  app.patch('/api/radius/raw-explorer/raw-review', asyncRoute(async (request, response) => {
    if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) throw new RequestValidationError('invalid_raw_explorer_request')
    const raw = request.body as Record<string, unknown>
    response.status(200).json(await rawRadiusExplorer.review(parsePressKey(String(raw.pressKey ?? '')), parseRawIdentity(raw.rawIdentity), parseRawReviewStatus(raw.reviewStatus)))
  }))

  app.get('/api/telemetry/event-explorer/catalog', asyncRoute(async (request, response) => {
    const rawPressKey = request.query.rawPressKey === undefined ? undefined : parsePressKey(String(request.query.rawPressKey))
    const range = rawPressKey ? validateRadiusRange(request.query) : undefined
    response.status(200).json(await telemetryEventExplorer.catalog(rawPressKey, range?.fromUtc, range?.toUtc, String(response.locals.requestId), cancellationSignal(request, response)))
  }))

  app.get('/api/telemetry/event-explorer/raw-catalog', asyncRoute(async (request, response) => {
    const pressKey = parsePressKey(String(request.query.pressKey ?? ''))
    const query = typeof request.query.q === 'string' ? request.query.q : ''
    const offset = request.query.offset === undefined ? 0 : Number(request.query.offset)
    const limit = request.query.limit === undefined ? 50 : Number(request.query.limit)
    if (query.length > 300 || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RequestValidationError('invalid_raw_catalog_query')
    response.status(200).json(await telemetryEventExplorer.rawCatalog(pressKey, query, offset, limit, String(response.locals.requestId), cancellationSignal(request, response)))
  }))

  app.post('/api/telemetry/event-explorer/preview', asyncRoute(async (request, response) => {
    if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) throw new RequestValidationError('invalid_telemetry_event_preview')
    const raw = request.body as Record<string, unknown>; const range = validateTelemetryEventRange(raw)
    const source = parseTelemetryEventSource(raw.source); const pressKey = parsePressKey(String(raw.pressKey ?? ''))
    const deckNumber = raw.deckNumber === null ? null : Number(raw.deckNumber)
    if (deckNumber !== null && (!Number.isSafeInteger(deckNumber) || deckNumber < 1 || deckNumber > 10) || source.kind === 'raw' && (source.pressKey !== pressKey || deckNumber !== null)) throw new RequestValidationError('invalid_telemetry_event_preview')
    response.status(200).json(await telemetryEventExplorer.preview({ source, pressKey, deckNumber, ...range }, String(response.locals.requestId), cancellationSignal(request, response)))
  }))

  app.post('/api/telemetry/event-explorer/search', asyncRoute(async (request, response) => {
    response.status(200).json(await telemetryEventExplorer.search(parseTelemetryEventSearch(request.body), String(response.locals.requestId), cancellationSignal(request, response)))
  }))

  app.post('/api/telemetry/event-explorer/detail', asyncRoute(async (request, response) => {
    response.status(200).json(await telemetryEventExplorer.detail(parseTelemetryEventOccurrence(request.body?.occurrence), String(response.locals.requestId), cancellationSignal(request, response), request.body?.includeRawTelemetryDiscovery === false ? { includeRawTelemetryDiscovery: false } : undefined))
  }))

  app.post('/api/telemetry/event-explorer/history', asyncRoute(async (request, response) => {
    if (!Array.isArray(request.body?.occurrences) || request.body.occurrences.length > 500) throw new RequestValidationError('invalid_telemetry_event_history_bounds')
    response.status(200).json(telemetryEventExplorer.historicalSummary({ occurrence: parseTelemetryEventOccurrence(request.body?.occurrence), occurrences: request.body.occurrences.map(parseTelemetryEventOccurrence) }))
  }))

  app.post('/api/telemetry/event-explorer/report', asyncRoute(async (request, response) => {
    if (!Array.isArray(request.body?.occurrences) || request.body.occurrences.length > 500) throw new RequestValidationError('invalid_telemetry_event_report_bounds')
    response.status(200).json(await telemetryEventExplorer.eventLearningReport({ occurrence: parseTelemetryEventOccurrence(request.body?.occurrence), occurrences: request.body.occurrences.map(parseTelemetryEventOccurrence) }, String(response.locals.requestId), cancellationSignal(request, response)))
  }))

  app.post('/api/telemetry/event-explorer/plot', asyncRoute(async (request, response) => {
    response.status(200).json(await telemetryEventExplorer.plot(parseTelemetryEventOccurrence(request.body?.occurrence), parseRawExplorerSignal(request.body?.signal), String(response.locals.requestId), cancellationSignal(request, response)))
  }))

  app.post('/api/telemetry/event-explorer/raw-plot', asyncRoute(async (request, response) => {
    response.status(200).json(await telemetryEventExplorer.rawPlot(parseTelemetryEventOccurrence(request.body?.occurrence), parseRawIdentity(request.body?.rawIdentity), String(response.locals.requestId), cancellationSignal(request, response)))
  }))

  const requireClassificationService = () => {
    if (!classificationService) throw new RadiusUnavailableError()
    return classificationService
  }
  const exposeObservedStatus = (response: Response, observed: ObservedIdentitySnapshot) => {
    response.setHeader('X-Observed-Identity-Status', observed.status)
    if (observed.asOfUtc) response.setHeader('X-Observed-Identity-As-Of', observed.asOfUtc)
  }
  const classificationWorkspace = async (request: Request, response?: Response) => {
    const observed = await observedIdentityCache.get()
    if (response) exposeObservedStatus(response, observed)
    return requireClassificationService().getWorkspace(
      observed.identities,
      classificationAuthorizer(request),
      observed.status,
      observed.asOfUtc,
    )
  }
  const classificationObserved = async () => {
    const observed = await observedIdentityCache.get()
    if (observed.status === 'unavailable') throw new RadiusUnavailableError()
    return observed.identities
  }
  const expectedRevision = (value: unknown, nullable = false): number | null => {
    if (nullable && value === null) return null
    if (!Number.isInteger(value) || Number(value) < 1) throw new RequestValidationError('invalid_draft_revision')
    return Number(value)
  }
  const radiusIdentities = (value: unknown): RadiusIdentity[] => {
    if (!Array.isArray(value) || value.length < 1 || value.length > 250) throw new RequestValidationError('invalid_radius_identities')
    return value.map((candidate) => {
      if (!candidate || typeof candidate !== 'object') throw new RequestValidationError('invalid_radius_identity')
      const raw = candidate as Record<string, unknown>
      if (typeof raw.eventType !== 'string' || raw.eventType.length > 64 || (raw.statusCode !== null && typeof raw.statusCode !== 'string') || (typeof raw.statusCode === 'string' && raw.statusCode.length > 128) || typeof raw.statusDescription !== 'string' || raw.statusDescription.length > 512) throw new RequestValidationError('invalid_radius_identity')
      const identity = { eventType: raw.eventType, statusCode: raw.statusCode as string | null, statusDescription: raw.statusDescription }
      return { ...identity, identity: exactRadiusIdentity(identity) }
    })
  }

  app.get('/api/classification/workspace', asyncRoute(async (request, response) => { response.status(200).json(await classificationWorkspace(request, response)) }))
  app.get('/api/classification/groups', asyncRoute(async (_request, response) => { response.status(200).json(await requireClassificationService().getPublishedGroups()) }))
  app.get('/api/classification/process-families', asyncRoute(async (_request, response) => { response.status(200).json(await requireClassificationService().getPublishedFamilies()) }))
  app.get('/api/classification/identities', asyncRoute(async (_request, response) => {
    const observed = await observedIdentityCache.get()
    exposeObservedStatus(response, observed)
    response.status(200).json(observed.identities)
  }))
  app.get('/api/classification/classifications', asyncRoute(async (_request, response) => { response.status(200).json(await requireClassificationService().getPublishedClassifications()) }))
  app.get('/api/classification/review-required', asyncRoute(async (request, response) => { response.status(200).json((await classificationWorkspace(request, response)).effectiveClassifications.filter(({ needsReview, isFallback }) => needsReview || isFallback)) }))
  app.get('/api/classification/draft', asyncRoute(async (_request, response) => { response.status(200).json(await requireClassificationService().getDraft()) }))
  app.get('/api/classification/versions', asyncRoute(async (_request, response) => { response.status(200).json(await requireClassificationService().listVersions()) }))
  app.get('/api/classification/audit', asyncRoute(async (_request, response) => { response.status(200).json(await requireClassificationService().listAudit()) }))
  app.post('/api/classification/draft', asyncRoute(async (request, response) => {
    if (!classificationService) throw new RadiusUnavailableError()
    response.status(201).json(await classificationService.createDraft(classificationAuthorizer(request), request.body?.expectedVersion === undefined ? undefined : Number(request.body.expectedVersion)))
  }))
  app.patch('/api/classification/draft/groups/:groupKey', asyncRoute(async (request, response) => {
    if (!classificationService) throw new RadiusUnavailableError()
    const groupKey = String(request.params.groupKey) as OperationalGroupKey
    if (!OPERATIONAL_GROUP_KEYS.includes(groupKey)) throw new RequestValidationError('invalid_operational_group')
    const body = request.body as Record<string, unknown>
    const input: Record<string, unknown> = {}
    for (const key of ['displayName', 'description', 'lightColor', 'darkColor', 'icon'] as const) if (body[key] !== undefined) {
      if (typeof body[key] !== 'string' || String(body[key]).length > 512) throw new RequestValidationError('invalid_group_presentation')
      input[key] = body[key]
    }
    if (body.sortOrder !== undefined) {
      if (!Number.isInteger(body.sortOrder)) throw new RequestValidationError('invalid_group_order')
      input.sortOrder = Number(body.sortOrder)
    }
    response.status(200).json(await classificationService.editGroup(classificationAuthorizer(request), groupKey, input, expectedRevision(body.expectedRevision, true), body.restoreDefault === true))
  }))
  app.patch('/api/classification/draft/classifications', asyncRoute(async (request, response) => {
    if (!classificationService) throw new RadiusUnavailableError()
    const body = request.body as Record<string, unknown>
    const operationalGroupKey = body.operationalGroupKey === undefined ? undefined : String(body.operationalGroupKey) as OperationalGroupKey
    const processFamilyKey = body.processFamilyKey === undefined ? undefined : String(body.processFamilyKey) as ProcessFamilyKey
    if (operationalGroupKey && !OPERATIONAL_GROUP_KEYS.includes(operationalGroupKey)) throw new RequestValidationError('invalid_operational_group')
    if (processFamilyKey && !PROCESS_FAMILY_KEYS.includes(processFamilyKey)) throw new RequestValidationError('invalid_process_family')
    const confidence = body.confidence === undefined ? undefined : String(body.confidence) as MappingConfidence
    if (confidence && !['HIGH', 'MEDIUM', 'LOW'].includes(confidence)) throw new RequestValidationError('invalid_mapping_confidence')
    response.status(200).json(await classificationService.editMappings(classificationAuthorizer(request), radiusIdentities(body.identities), {
      operationalGroupKey, processFamilyKey, confidence,
      displayLabel: body.displayLabel === undefined ? undefined : body.displayLabel === null ? null : String(body.displayLabel),
      explanation: body.explanation === undefined ? undefined : String(body.explanation),
      needsReview: body.needsReview === undefined ? undefined : Boolean(body.needsReview),
      defaultTimelineVisibility: body.defaultTimelineVisibility === undefined ? undefined : Boolean(body.defaultTimelineVisibility),
      obsolete: body.obsolete === undefined ? undefined : Boolean(body.obsolete),
    }, expectedRevision(body.expectedRevision, true)))
  }))
  app.post('/api/classification/draft/validate', asyncRoute(async (_request, response) => {
    if (!classificationService) throw new RadiusUnavailableError()
    response.status(200).json(await classificationService.validateCurrentDraft(await classificationObserved()))
  }))
  app.post('/api/classification/draft/publish', asyncRoute(async (request, response) => {
    if (!classificationService) throw new RadiusUnavailableError()
    response.status(200).json(await classificationService.publish(classificationAuthorizer(request), expectedRevision(request.body?.expectedRevision)!, await classificationObserved()))
  }))
  app.delete('/api/classification/draft', asyncRoute(async (request, response) => {
    if (!classificationService) throw new RadiusUnavailableError()
    await classificationService.discard(classificationAuthorizer(request), expectedRevision(request.body?.expectedRevision)!)
    response.status(204).end()
  }))

  app.use(
    (
      error: unknown,
      request: Request,
      response: Response,
      _next: NextFunction,
    ) => {
      const requestId = String(response.locals.requestId)

      if (isPayloadTooLargeError(error)) {
        if (logger) logger.error(`[${requestId}] ${request.method} ${request.path} 413 request_payload_too_large`)
        response.status(413).json({ error: 'request_payload_too_large' })
        return
      }

      if (isJsonBodyParseError(error)) {
        if (logger) logger.error(`[${requestId}] ${request.method} ${request.path} 400 invalid_request_body`)
        response.status(400).json({ error: 'invalid_request_body' })
        return
      }

      if (error instanceof RequestValidationError) {
        response.status(400).json({ error: error.code })
        return
      }

      if (error instanceof ClassificationForbiddenError) { response.status(403).json({ error: 'classification_forbidden' }); return }
      if (error instanceof ClassificationConflictError) { response.status(409).json({ error: 'classification_draft_conflict' }); return }
      if (error instanceof ClassificationValidationError) { response.status(422).json({ error: 'classification_validation_failed', details: error.errors }); return }

      if (error instanceof StopIntelligenceConfigurationError) {
        if (logger) logger.error(`[${requestId}] ${request.method} ${request.path} 503 stop_intelligence_mapping_unavailable`)
        response.status(503).json({ status: 'unavailable', service: 'StopIntelligence' })
        return
      }

      if (error instanceof TelemetryApiError) {
        const status = error.kind === 'not_found' || error.kind === 'unsupported_source' ? 404 : error.kind === 'request_invalid' ? 400 : error.kind === 'payload_too_large' ? 413 : 503
        if (logger) {
          logger.error(
            `[${requestId}] ${request.method} ${request.path} ${status} telemetry_${error.kind}`,
          )
        }
        response.status(status).json({
          status: status === 404 ? 'not_found' : 'unavailable',
          service: 'TelemetryQueryApi',
        })
        return
      }

      if (error instanceof RadiusUnavailableError) {
        if (logger) {
          logger.error(
            `[${requestId}] ${request.method} ${request.path} 503 radius_unavailable`,
          )
        }
        response.status(503).json({
          status: 'unavailable',
          service: 'Radius',
        })
        return
      }

      if (error instanceof RadiusNotFoundError) {
        response.status(404).json({ status: 'not_found', service: 'Radius' })
        return
      }

      if (logger) {
        logger.error(unexpectedErrorLog(error, request, requestId))
      }
      response.status(500).json({ error: 'internal_error' })
    },
  )

  return app
}
