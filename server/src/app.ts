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
import { RADIUS_PRESS_KEYS, type ActivityLevel, type ActivitySelection, type PatternMatchMode, type RadiusPressKey } from './radius/models.js'
import {
  RadiusNotFoundError,
  type RadiusService,
  RadiusUnavailableError,
  UnavailableRadiusService,
} from './radius/radius-service.js'
import type { ClassificationAuthorizer } from './classification/create-classification-service.js'
import { ClassificationConflictError } from './classification/classification-repository.js'
import { ClassificationForbiddenError, ClassificationService, ClassificationValidationError } from './classification/classification-service.js'
import { OPERATIONAL_GROUP_KEYS, PROCESS_FAMILY_KEYS, type MappingConfidence, type OperationalGroupKey, type ProcessFamilyKey, type RadiusIdentity } from './classification/models.js'
import { ObservedIdentityCache, type ObservedIdentitySnapshot } from './classification/observed-identity-cache.js'
import { exactRadiusIdentity } from './radius/radius-identity.js'
import { TelemetryFoundationService } from './telemetry/telemetry-foundation-service.js'
import { PHYSICAL_EVIDENCE_CATEGORIES, TELEMETRY_REPRESENTATIONS, type CuratedPhysicalEvidenceRequest, type TelemetryRepresentation, type TelemetrySemanticHistoryQuery } from './telemetry/telemetry-contracts.js'
import { EngineeringClueAnalysisService, type ClueOccurrenceInput } from './telemetry/engineering-clue-analysis.js'
import { StopRestartAnalysisService, type FleetSpeedContextInput, type RadiusTimingAnalysisInput, type StopRestartAnalysisInput } from './telemetry/stop-restart-analysis-service.js'
import { RAW_EXPLORER_MAX_WINDOW_MINUTES, RawRadiusExplorerService, type RawExplorerOccurrence, type RawExplorerSetup, type RawExplorerSignalIdentity } from './raw-radius-explorer/raw-radius-explorer-service.js'
import { RAW_TELEMETRY_REVIEW_STATUSES, type RawTelemetryReviewService, type RawTelemetryReviewStatus } from './raw-radius-explorer/raw-telemetry-review-service.js'
import { TELEMETRY_EVENT_MAX_CONTEXT_MINUTES, TELEMETRY_EVENT_MAX_RANGE_MS, TelemetryEventExplorerService, type TelemetryEventOccurrence, type TelemetryEventSearchInput } from './telemetry-event-explorer/telemetry-event-explorer-service.js'
import type { AiInvestigatorConfig } from './config.js'
import { parseAiInvestigatorRequest } from './ai-investigator/contracts.js'
import { AI_INVESTIGATOR_TOOL_NAMES, AiInvestigatorReadOnlyToolRegistry } from './ai-investigator/read-only-tools.js'
import { AiInvestigatorOrchestrator, createAiInvestigatorOrchestrator, investigatorDisplayName, type AiInvestigatorModelClient } from './ai-investigator/orchestrator.js'

const MAX_PHYSICAL_STATE_RANGE_MS = 2 * 60 * 60 * 1_000
const MAX_RADIUS_RANGE_MS = 31 * 24 * 60 * 60 * 1_000
const SAFE_REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/
const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/
const DEFAULT_CLASSIFICATION_SEARCH_LIMIT = 10
const MAX_CLASSIFICATION_SEARCH_LIMIT = 20
const ACTIVITY_LEVELS = new Set<ActivityLevel>(['radius_state', 'operational_group', 'process_family', 'exact_status'])

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
  radiusService?: RadiusService
  logger?: Logger | false
  classificationService?: ClassificationService
  classificationAuthorizer?: ClassificationAuthorizer
  rawTelemetryReviewService?: RawTelemetryReviewService
  aiInvestigatorConfig?: AiInvestigatorConfig
  aiInvestigatorModelClient?: AiInvestigatorModelClient
}

class RequestValidationError extends Error {
  constructor(public readonly code: string) {
    super(code)
    this.name = 'RequestValidationError'
  }
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

function parseActivitySelection(levelValue: unknown, keyValue: unknown, operationalGroupValue?: unknown): ActivitySelection | undefined {
  if (levelValue === undefined && keyValue === undefined) return undefined
  if (typeof levelValue !== 'string' || !ACTIVITY_LEVELS.has(levelValue as ActivityLevel) || typeof keyValue !== 'string' || !keyValue || keyValue.length > 300) throw new RequestValidationError('invalid_activity_selection')
  if (operationalGroupValue !== undefined && (typeof operationalGroupValue !== 'string' || !OPERATIONAL_GROUP_KEYS.includes(operationalGroupValue as OperationalGroupKey))) throw new RequestValidationError('invalid_activity_selection')
  return { level: levelValue as ActivityLevel, key: keyValue, label: keyValue, ...(operationalGroupValue === undefined ? {} : { operationalGroupKey: operationalGroupValue as OperationalGroupKey }) }
}

function parseOptionalPressKey(value: unknown): RadiusPressKey | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new RequestValidationError('invalid_press_key')
  return parsePressKey(value)
}

function parsePatternConditions(value: unknown): ActivitySelection[] {
  if (value === undefined) return []
  if (typeof value !== 'string' || value.length > 2_000) throw new RequestValidationError('invalid_pattern_conditions')
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { throw new RequestValidationError('invalid_pattern_conditions') }
  if (!Array.isArray(parsed) || parsed.length > 6) throw new RequestValidationError('invalid_pattern_conditions')
  return parsed.map((item) => {
    if (!item || typeof item !== 'object') throw new RequestValidationError('invalid_pattern_conditions')
    const candidate = item as Record<string, unknown>
    const selection = parseActivitySelection(candidate.level, candidate.key, candidate.operationalGroupKey)
    if (!selection) throw new RequestValidationError('invalid_pattern_conditions')
    return selection
  })
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

function parseClueOccurrence(body: unknown, pressKey: RadiusPressKey): ClueOccurrenceInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestValidationError('invalid_clue_occurrence')
  const raw = body as Record<string, unknown>
  const startUtc = parseUtcTimestamp(raw.startUtc, 'invalid_clue_occurrence')
  const endUtc = parseUtcTimestamp(raw.endUtc, 'invalid_clue_occurrence')
  if (Date.parse(endUtc) <= Date.parse(startUtc) || Date.parse(endUtc) - Date.parse(startUtc) > MAX_RADIUS_RANGE_MS) throw new RequestValidationError('invalid_clue_occurrence')
  if (typeof raw.occurrenceId !== 'string' || !/^[A-Za-z0-9:._-]{1,300}$/.test(raw.occurrenceId)) throw new RequestValidationError('invalid_clue_occurrence')
  if (typeof raw.displayName !== 'string' || !raw.displayName.trim() || raw.displayName.length > 100) throw new RequestValidationError('invalid_clue_occurrence')
  if (!Array.isArray(raw.exactIdentities) || raw.exactIdentities.length < 1 || raw.exactIdentities.length > 100) throw new RequestValidationError('invalid_clue_occurrence')
  const exactIdentities = raw.exactIdentities.map((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new RequestValidationError('invalid_clue_occurrence')
    const identity = candidate as Record<string, unknown>
    if (typeof identity.eventType !== 'string' || identity.eventType.length > 64 || (identity.statusCode !== null && typeof identity.statusCode !== 'string') || typeof identity.statusDescription !== 'string' || identity.statusDescription.length > 512) throw new RequestValidationError('invalid_clue_occurrence')
    return { eventType: identity.eventType, statusCode: identity.statusCode as string | null, statusDescription: identity.statusDescription }
  })
  return { occurrenceId: raw.occurrenceId, pressKey, displayName: raw.displayName, startUtc, endUtc, durationSeconds: (Date.parse(endUtc) - Date.parse(startUtc)) / 1_000, exactIdentities }
}

function parseStopRestartInput(body: unknown, pressKey: RadiusPressKey): StopRestartAnalysisInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestValidationError('invalid_stop_restart_request')
  const raw = body as Record<string, unknown>
  if (!raw.occurrence || typeof raw.occurrence !== 'object' || Array.isArray(raw.occurrence)) throw new RequestValidationError('invalid_stop_restart_request')
  const occurrenceRaw = raw.occurrence as Record<string, unknown>
  const clueOccurrence = parseClueOccurrence(occurrenceRaw, pressKey)
  const requiredText = (key: string) => {
    const value = occurrenceRaw[key]
    if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new RequestValidationError('invalid_stop_restart_request')
    return value
  }
  if (!Array.isArray(raw.candidates) || raw.candidates.length > 24) throw new RequestValidationError('invalid_stop_restart_request')
  const candidates = raw.candidates.map((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new RequestValidationError('invalid_stop_restart_request')
    const item = candidate as Record<string, unknown>
    if (typeof item.canonicalId !== 'string' || !/^[a-z0-9._]+$/.test(item.canonicalId) || item.canonicalId.length > 200) throw new RequestValidationError('invalid_stop_restart_request')
    if (item.deckNumber !== undefined && (!Number.isSafeInteger(item.deckNumber) || Number(item.deckNumber) < 1 || Number(item.deckNumber) > 10)) throw new RequestValidationError('invalid_stop_restart_request')
    if (item.source !== 'clue' && item.source !== 'pin' && item.source !== 'priority') throw new RequestValidationError('invalid_stop_restart_request')
    if (item.friendlyName !== undefined && (typeof item.friendlyName !== 'string' || item.friendlyName.length > 200)) throw new RequestValidationError('invalid_stop_restart_request')
    if (item.signalType !== undefined && item.signalType !== 'continuous' && item.signalType !== 'step_reference' && item.signalType !== 'state_event') throw new RequestValidationError('invalid_stop_restart_request')
    const categories = ['speed', 'web_tension', 'dryer', 'ink', 'viscosity', 'temperature', 'pump', 'wash', 'register', 'impression', 'torque', 'drive_temperature', 'doctor_blade', 'repeat_other', 'motion']
    if (item.category !== undefined && (typeof item.category !== 'string' || !categories.includes(item.category))) throw new RequestValidationError('invalid_stop_restart_request')
    return { canonicalId: item.canonicalId, ...(item.deckNumber === undefined ? {} : { deckNumber: Number(item.deckNumber) }), ...(item.friendlyName === undefined ? {} : { friendlyName: item.friendlyName }), ...(item.signalType === undefined ? {} : { signalType: item.signalType as 'continuous' | 'step_reference' | 'state_event' }), ...(item.category === undefined ? {} : { category: item.category as StopRestartAnalysisInput['candidates'][number]['category'] }), source: item.source as 'clue' | 'pin' | 'priority' }
  })
  return { occurrence: { ...clueOccurrence, operationalGroupKey: requiredText('operationalGroupKey'), operationalGroupName: requiredText('operationalGroupName'), processFamilyKey: requiredText('processFamilyKey'), processFamilyName: requiredText('processFamilyName') }, candidates }
}

function parseRadiusTimingInput(body: unknown): RadiusTimingAnalysisInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestValidationError('invalid_radius_timing_request')
  const raw = body as Record<string, unknown>
  if (!raw.exactIdentity || typeof raw.exactIdentity !== 'object' || Array.isArray(raw.exactIdentity) || !Array.isArray(raw.occurrences) || raw.occurrences.length < 1 || raw.occurrences.length > 30) throw new RequestValidationError('invalid_radius_timing_request')
  const identity = raw.exactIdentity as Record<string, unknown>
  if (typeof identity.eventType !== 'string' || !identity.eventType.trim() || identity.eventType.length > 50 || identity.statusCode !== null && typeof identity.statusCode !== 'string' || typeof identity.statusDescription !== 'string' || !identity.statusDescription.trim() || identity.statusDescription.length > 300) throw new RequestValidationError('invalid_radius_timing_request')
  const occurrences = raw.occurrences.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RequestValidationError('invalid_radius_timing_request')
    const item = value as Record<string, unknown>
    if (typeof item.occurrenceId !== 'string' || !item.occurrenceId || item.occurrenceId.length > 300 || typeof item.displayName !== 'string' || !item.displayName || item.displayName.length > 100) throw new RequestValidationError('invalid_radius_timing_request')
    return { occurrenceId: item.occurrenceId, pressKey: parsePressKey(String(item.pressKey ?? '')), displayName: item.displayName, startUtc: parseUtcTimestamp(item.startUtc, 'invalid_start_utc') }
  })
  return { exactIdentity: { eventType: identity.eventType, statusCode: identity.statusCode as string | null, statusDescription: identity.statusDescription }, occurrences }
}

function parseFleetSpeedContextInput(body: unknown): FleetSpeedContextInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestValidationError('invalid_fleet_speed_context_request')
  const raw = body as Record<string, unknown>
  const fromUtc = parseUtcTimestamp(raw.fromUtc, 'invalid_from_utc'); const toUtc = parseUtcTimestamp(raw.toUtc, 'invalid_to_utc')
  const rangeMs = Date.parse(toUtc) - Date.parse(fromUtc)
  if (rangeMs <= 0 || rangeMs > 24 * 60 * 60_000 || !Array.isArray(raw.pressKeys) || raw.pressKeys.length < 1 || raw.pressKeys.length > 6) throw new RequestValidationError('invalid_fleet_speed_context_request')
  return { fromUtc, toUtc, pressKeys: raw.pressKeys.map((value) => parsePressKey(String(value))) }
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

function parsePressKey(value: string | string[]): RadiusPressKey {
  if (
    Array.isArray(value) ||
    !RADIUS_PRESS_KEYS.includes(value as RadiusPressKey)
  ) {
    throw new RequestValidationError('invalid_press_key')
  }
  return value as RadiusPressKey
}

function parseEpisodeId(value: string | string[]): string {
  if (Array.isArray(value) || !/^[A-Za-z0-9_-]{1,256}$/.test(value)) {
    throw new RequestValidationError('invalid_episode_id')
  }
  return value
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
  radiusService = new UnavailableRadiusService(),
  logger = console,
  classificationService,
  classificationAuthorizer = () => ({ id: 'anonymous', canEdit: false }),
  rawTelemetryReviewService,
  aiInvestigatorConfig,
  aiInvestigatorModelClient,
}: CreateAppOptions) {
  const app = express()
  const telemetry = new TelemetryFoundationService(telemetryClient)
  const engineeringClues = new EngineeringClueAnalysisService(telemetry)
  const stopRestart = new StopRestartAnalysisService(telemetry)
  const rawRadiusExplorer = new RawRadiusExplorerService(radiusService, telemetry, rawTelemetryReviewService)
  const telemetryEventExplorer = new TelemetryEventExplorerService(telemetry, radiusService, rawRadiusExplorer)
  const aiToolRegistry = new AiInvestigatorReadOnlyToolRegistry(radiusService, telemetry)
  const aiInvestigator = aiInvestigatorConfig?.enabled && aiInvestigatorModelClient
    ? new AiInvestigatorOrchestrator(aiInvestigatorConfig, aiToolRegistry, aiInvestigatorModelClient, logger)
    : aiInvestigatorConfig ? createAiInvestigatorOrchestrator(aiInvestigatorConfig, aiToolRegistry, logger) : undefined
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
    })
  })

  app.get('/api/ai-investigator/status', (_request, response) => {
    const config = aiInvestigatorConfig
    response.status(200).json({
      configured: Boolean(aiInvestigator),
      enabled: config?.enabled ?? false,
      model: config?.model ?? 'not-configured',
      maximumAnalysisMs: config?.totalTimeoutMs ?? 45_000,
      maximumToolMs: config?.toolTimeoutMs ?? 8_000,
      maximumToolCalls: config?.maxToolCalls ?? 8,
      maximumToolRounds: config?.maxToolRounds ?? 4,
      maximumParallelTools: config?.maxParallelTools ?? 3,
      presses: RADIUS_PRESS_KEYS.map((pressKey) => ({ pressKey, displayName: investigatorDisplayName(pressKey) })),
      allowedTools: AI_INVESTIGATOR_TOOL_NAMES,
    })
  })

  app.post('/api/ai-investigator/analyze', asyncRoute(async (request, response) => {
    if (!aiInvestigator) {
      response.status(503).json({ status: 'not_configured', message: 'AI Investigator is not configured on this server.' })
      return
    }
    let input
    try { input = parseAiInvestigatorRequest(request.body) }
    catch (error) { throw new RequestValidationError(error instanceof Error ? error.message : 'invalid_ai_investigator_request') }
    response.status(200).json(await aiInvestigator.analyze(input, cancellationSignal(request, response)))
  }))

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

  app.post('/api/telemetry/presses/:pressKey/clues', asyncRoute(async (request, response) => {
    const pressKey = parsePressKey(request.params.pressKey)
    response.status(200).json(await engineeringClues.analyze(parseClueOccurrence(request.body, pressKey), String(response.locals.requestId), cancellationSignal(request, response)))
  }))

  app.post('/api/telemetry/presses/:pressKey/stop-restart-analysis', asyncRoute(async (request, response) => {
    const pressKey = parsePressKey(request.params.pressKey)
    response.status(200).json(await stopRestart.analyze(parseStopRestartInput(request.body, pressKey), String(response.locals.requestId), cancellationSignal(request, response)))
  }))

  app.post('/api/telemetry/radius-timing-analysis', asyncRoute(async (request, response) => {
    response.status(200).json(await stopRestart.analyzeRadiusTiming(parseRadiusTimingInput(request.body), String(response.locals.requestId), cancellationSignal(request, response)))
  }))

  app.post('/api/telemetry/fleet-speed-context', asyncRoute(async (request, response) => {
    response.status(200).json(await stopRestart.fleetSpeedContext(parseFleetSpeedContextInput(request.body), String(response.locals.requestId), cancellationSignal(request, response)))
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

  app.get(
    '/api/radius/overview',
    asyncRoute(async (request, response) => {
      const { fromUtc, toUtc } = validateRadiusRange(request.query)
      const overview = await radiusService.getOverview(fromUtc, toUtc)
      if (request.query.view === 'decision') {
        const { episodeAnalysis: _episodeAnalysis, operationalAnalytics: _operationalAnalytics, ...decisionOverview } = overview
        response.status(200).json({
          ...decisionOverview,
          presses: decisionOverview.presses.map((press) => ({ ...press, timelineSegments: [] })),
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
    response.status(200).json(await rawRadiusExplorer.detail({ occurrence: parseRawExplorerOccurrence(raw.occurrence), changeLookbackMinutes: rawExplorerMinutes(raw.changeLookbackMinutes, false, 'invalid_change_lookback') }, String(response.locals.requestId), cancellationSignal(request, response)))
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
    response.status(200).json(await telemetryEventExplorer.detail(parseTelemetryEventOccurrence(request.body?.occurrence), String(response.locals.requestId), cancellationSignal(request, response)))
  }))

  app.post('/api/telemetry/event-explorer/plot', asyncRoute(async (request, response) => {
    response.status(200).json(await telemetryEventExplorer.plot(parseTelemetryEventOccurrence(request.body?.occurrence), parseRawExplorerSignal(request.body?.signal), String(response.locals.requestId), cancellationSignal(request, response)))
  }))

  app.post('/api/telemetry/event-explorer/raw-plot', asyncRoute(async (request, response) => {
    response.status(200).json(await telemetryEventExplorer.rawPlot(parseTelemetryEventOccurrence(request.body?.occurrence), parseRawIdentity(request.body?.rawIdentity), String(response.locals.requestId), cancellationSignal(request, response)))
  }))

  app.get(
    '/api/radius/activity-analysis',
    asyncRoute(async (request, response) => {
      const { fromUtc, toUtc } = validateRadiusRange(request.query)
      if (!radiusService.getActivityAnalysis) throw new RadiusUnavailableError()
      const pressKey = parseOptionalPressKey(request.query.pressKey)
      const evidenceOffset = request.query.evidenceOffset === undefined ? 0 : Number(request.query.evidenceOffset)
      const evidenceLimit = request.query.evidenceLimit === undefined ? undefined : Number(request.query.evidenceLimit)
      if (!Number.isSafeInteger(evidenceOffset) || evidenceOffset < 0 || (evidenceLimit !== undefined && (!Number.isSafeInteger(evidenceLimit) || evidenceLimit < 1 || evidenceLimit > 100))) throw new RequestValidationError('invalid_activity_evidence_page')
      response.status(200).json(await radiusService.getActivityAnalysis(fromUtc, toUtc, parseActivitySelection(request.query.level, request.query.key, request.query.operationalGroupKey), pressKey, { offset: evidenceOffset, limit: evidenceLimit }))
    }),
  )

  app.get(
    '/api/radius/pattern-analysis',
    asyncRoute(async (request, response) => {
      const { fromUtc, toUtc } = validateRadiusRange(request.query)
      const mode = request.query.matchMode === undefined ? undefined : request.query.matchMode
      if (mode !== undefined && mode !== 'contains_all' && mode !== 'in_order') throw new RequestValidationError('invalid_pattern_match_mode')
      const selectedPatternKey = request.query.patternKey
      if (selectedPatternKey !== undefined && (typeof selectedPatternKey !== 'string' || selectedPatternKey.length > 100)) throw new RequestValidationError('invalid_pattern_key')
      if (!radiusService.getPatternAnalysis) throw new RadiusUnavailableError()
      const pressKey = parseOptionalPressKey(request.query.pressKey)
      response.status(200).json(await radiusService.getPatternAnalysis(fromUtc, toUtc, { selectedPatternKey, conditions: parsePatternConditions(request.query.conditions), matchMode: mode as PatternMatchMode | undefined, pressKey }))
    }),
  )

  app.get(
    '/api/radius/presses/:pressKey/episodes',
    asyncRoute(async (request, response) => {
      const pressKey = parsePressKey(request.params.pressKey)
      const { fromUtc, toUtc } = validateRadiusRange(request.query)
      response
        .status(200)
        .json(await radiusService.getPressEpisodes(pressKey, fromUtc, toUtc))
    }),
  )

  app.get(
    '/api/radius/presses/:pressKey/episodes/:episodeId',
    asyncRoute(async (request, response) => {
      const pressKey = parsePressKey(request.params.pressKey)
      response
        .status(200)
        .json(
          await radiusService.getEpisode(
            pressKey,
            parseEpisodeId(request.params.episodeId),
          ),
        )
    }),
  )

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
  app.get('/api/classification/search', asyncRoute(async (request, response) => {
    const query = typeof request.query.q === 'string' ? request.query.q : ''
    if (!query.trim() || query.length > 128 || !/[\p{L}\p{N}]/u.test(query)) throw new RequestValidationError('invalid_classification_search_query')
    const rawLimit = request.query.limit
    const limit = rawLimit === undefined ? DEFAULT_CLASSIFICATION_SEARCH_LIMIT : Number(rawLimit)
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CLASSIFICATION_SEARCH_LIMIT) throw new RequestValidationError('invalid_classification_search_limit')
    const observed = observedIdentityCache.peekAndRefresh()
    response.status(200).json(await requireClassificationService().search(query, limit, observed))
  }))

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

      if (error instanceof RequestValidationError) {
        response.status(400).json({ error: error.code })
        return
      }

      if (error instanceof ClassificationForbiddenError) { response.status(403).json({ error: 'classification_forbidden' }); return }
      if (error instanceof ClassificationConflictError) { response.status(409).json({ error: 'classification_draft_conflict' }); return }
      if (error instanceof ClassificationValidationError) { response.status(422).json({ error: 'classification_validation_failed', details: error.errors }); return }

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
