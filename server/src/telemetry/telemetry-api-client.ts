import type { TelemetryApiConfig } from '../config.js'
import {
  PHYSICAL_STATES,
  type JsonValue,
  type PhysicalState,
  type PhysicalStateResponse,
  type PhysicalStateSegment,
  type TelemetryDatabaseHealth,
  type TelemetryHealth,
  type TelemetrySource,
} from './models.js'
import type {
  TelemetryCapabilitiesResponse,
  TelemetryMachineSpeedHistory,
  RawTelemetryChangesQuery,
  RawTelemetryChangesResponse,
  RawTelemetryHistoryQuery,
  RawTelemetryHistoryResponse,
  TelemetrySourceSignal,
  TelemetrySemanticHistoryQuery,
  TelemetrySemanticHistoryResponse,
} from './telemetry-contracts.js'
import { TelemetryApiError } from './telemetry-error.js'
import { parseCapabilitiesResponse, parseMachineSpeedHistory, parseSemanticHistoryResponse } from './telemetry-response-parsers.js'

export { TelemetryApiError } from './telemetry-error.js'
export type { TelemetryApiErrorKind } from './telemetry-error.js'

export interface TelemetryClient {
  getHealth(requestId?: string): Promise<TelemetryHealth>
  getDatabaseHealth(requestId?: string): Promise<TelemetryDatabaseHealth>
  getSources(requestId?: string, signal?: AbortSignal): Promise<TelemetrySource[]>
  getSignals?(sourceId: number, requestId?: string, signal?: AbortSignal): Promise<TelemetrySourceSignal[]>
  getCapabilities?(sourceId: number, requestId?: string, signal?: AbortSignal): Promise<TelemetryCapabilitiesResponse>
  getMachineSpeedHistory?(sourceId: number, fromUtc: string, toUtc: string, requestId?: string, signal?: AbortSignal): Promise<TelemetryMachineSpeedHistory>
  querySemanticHistory?(sourceId: number, query: TelemetrySemanticHistoryQuery, requestId?: string, signal?: AbortSignal): Promise<TelemetrySemanticHistoryResponse>
  getRawTelemetryChanges?(query: RawTelemetryChangesQuery, requestId?: string, signal?: AbortSignal): Promise<RawTelemetryChangesResponse>
  getRawTelemetryHistory?(query: RawTelemetryHistoryQuery, requestId?: string, signal?: AbortSignal): Promise<RawTelemetryHistoryResponse>
  getPhysicalState(
    sourceId: number,
    fromUtc: string,
    toUtc: string,
    requestId?: string,
    signal?: AbortSignal,
  ): Promise<PhysicalStateResponse>
}

type FetchImplementation = typeof fetch
type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireRecord(value: unknown): JsonRecord {
  if (!isRecord(value)) {
    throw new TelemetryApiError('invalid_response')
  }
  return value
}

function requireString(record: JsonRecord, key: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new TelemetryApiError('invalid_response')
  }
  return value
}

function requireNumber(record: JsonRecord, key: string): number {
  const value = record[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TelemetryApiError('invalid_response')
  }
  return value
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return true
  }
  if (typeof value === 'number') {
    return Number.isFinite(value)
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue)
  }
  if (isRecord(value)) {
    return Object.values(value).every(isJsonValue)
  }
  return false
}

function parseHealth(value: unknown): TelemetryHealth {
  const record = requireRecord(value)
  return {
    service: requireString(record, 'service'),
    status: requireString(record, 'status'),
  }
}

function parseDatabaseHealth(value: unknown): TelemetryDatabaseHealth {
  const record = requireRecord(value)
  const user = record.user
  if (user !== undefined && typeof user !== 'string') {
    throw new TelemetryApiError('invalid_response')
  }

  return {
    service: requireString(record, 'service'),
    database: requireString(record, 'database'),
    status: requireString(record, 'status'),
    ...(user === undefined ? {} : { user }),
  }
}

function parseSource(value: unknown): TelemetrySource {
  const record = requireRecord(value)
  if (typeof record.enabled !== 'boolean') {
    throw new TelemetryApiError('invalid_response')
  }

  return {
    id: requireNumber(record, 'id'),
    sourceKey: requireString(record, 'sourceKey'),
    displayName: requireString(record, 'displayName'),
    enabled: record.enabled,
  }
}

function parseSources(value: unknown): TelemetrySource[] {
  const candidate = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.sources)
      ? value.sources
      : undefined

  if (!candidate) {
    throw new TelemetryApiError('invalid_response')
  }

  return candidate.map(parseSource)
}

function requireBoolean(record: JsonRecord, key: string): boolean {
  if (typeof record[key] !== 'boolean') throw new TelemetryApiError('invalid_response')
  return record[key] as boolean
}

function nullableString(record: JsonRecord, key: string): string | null {
  const value = record[key]
  if (value !== null && typeof value !== 'string') throw new TelemetryApiError('invalid_response')
  return value as string | null
}

function nullableNumber(record: JsonRecord, key: string): number | null {
  const value = record[key]
  if (value !== null && (typeof value !== 'number' || !Number.isFinite(value))) throw new TelemetryApiError('invalid_response')
  return value as number | null
}

function requireJson(record: JsonRecord, key: string) {
  const value = record[key]
  if (!isJsonValue(value)) throw new TelemetryApiError('invalid_response')
  return value
}

function requireStrings(record: JsonRecord, key: string): string[] {
  const value = record[key]
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) throw new TelemetryApiError('invalid_response')
  return value
}

function parseRawChangedSignal(value: unknown): RawTelemetryChangesResponse['signals'][number] {
  const record = requireRecord(value)
  const transitions = record.transitionSequence
  if (!Array.isArray(transitions) || !transitions.every(isJsonValue)) throw new TelemetryApiError('invalid_response')
  return {
    rawIdentity: requireString(record, 'rawIdentity'), displayName: requireString(record, 'displayName'),
    dataType: requireString(record, 'dataType'), dataKind: requireString(record, 'dataKind'), sourceUnit: nullableString(record, 'sourceUnit'),
    discoveryCategory: requireString(record, 'discoveryCategory'), plottable: requireBoolean(record, 'plottable'),
    usableObservationCount: requireNumber(record, 'usableObservationCount'), unavailableObservationCount: requireNumber(record, 'unavailableObservationCount'),
    firstValue: requireJson(record, 'firstValue'), lastValue: requireJson(record, 'lastValue'), minimum: nullableNumber(record, 'minimum'), maximum: nullableNumber(record, 'maximum'),
    changeCount: requireNumber(record, 'changeCount'), largestAbsoluteStep: nullableNumber(record, 'largestAbsoluteStep'),
    positiveMovementPresent: requireBoolean(record, 'positiveMovementPresent'), negativeMovementPresent: requireBoolean(record, 'negativeMovementPresent'),
    transitionSequence: transitions, transitionSequenceTruncated: requireBoolean(record, 'transitionSequenceTruncated'), knownShape: nullableString(record, 'knownShape'),
    alternateRepresentationCount: requireNumber(record, 'alternateRepresentationCount'), alternateRawIdentities: requireStrings(record, 'alternateRawIdentities'),
  }
}

function parseRawChanges(value: unknown): RawTelemetryChangesResponse {
  const record = requireRecord(value)
  if (!Array.isArray(record.signals)) throw new TelemetryApiError('invalid_response')
  return {
    press: requireString(record, 'press') as RawTelemetryChangesResponse['press'], displayName: requireString(record, 'displayName'),
    fromUtc: requireString(record, 'fromUtc'), toUtc: requireString(record, 'toUtc'),
    rawCatalogIdentityCount: requireNumber(record, 'rawCatalogIdentityCount'), canonicallyRepresentedIdentityCount: requireNumber(record, 'canonicallyRepresentedIdentityCount'),
    unmappedIdentityCount: requireNumber(record, 'unmappedIdentityCount'), usableIdentityCount: requireNumber(record, 'usableIdentityCount'), changedIdentityCount: requireNumber(record, 'changedIdentityCount'),
    framesRead: requireNumber(record, 'framesRead'), historianReadCount: requireNumber(record, 'historianReadCount'), signals: record.signals.map(parseRawChangedSignal),
  }
}

function parseRawHistory(value: unknown): RawTelemetryHistoryResponse {
  const record = requireRecord(value)
  if (!Array.isArray(record.observations)) throw new TelemetryApiError('invalid_response')
  return {
    press: requireString(record, 'press') as RawTelemetryHistoryResponse['press'], displayName: requireString(record, 'displayName'),
    rawIdentity: requireString(record, 'rawIdentity'), signalDisplayName: requireString(record, 'signalDisplayName'), dataType: requireString(record, 'dataType'), dataKind: requireString(record, 'dataKind'),
    sourceUnit: nullableString(record, 'sourceUnit'), plottable: requireBoolean(record, 'plottable'), fromUtc: requireString(record, 'fromUtc'), toUtc: requireString(record, 'toUtc'),
    historianReadCount: requireNumber(record, 'historianReadCount'), alternateRepresentationCount: requireNumber(record, 'alternateRepresentationCount'), alternateRawIdentities: requireStrings(record, 'alternateRawIdentities'),
    observations: record.observations.map((item) => { const observation = requireRecord(item); return { timestampUtc: requireString(observation, 'timestampUtc'), receivedAtUtc: requireString(observation, 'receivedAtUtc'), sourceTimestampUtc: nullableString(observation, 'sourceTimestampUtc'), qualityState: requireString(observation, 'qualityState'), dataType: requireString(observation, 'dataType'), rawValue: requireJson(observation, 'rawValue') } }),
  }
}

function parseSourceSignals(value: unknown): TelemetrySourceSignal[] {
  if (!Array.isArray(value)) throw new TelemetryApiError('invalid_response')
  return value.map((item) => {
    const record = requireRecord(item)
    return {
      id: requireNumber(record, 'id'), sourceId: requireNumber(record, 'sourceId'),
      signalId: requireString(record, 'signalId'), displayName: requireString(record, 'displayName'),
      sourceUnit: nullableString(record, 'sourceUnit'), valueKind: requireString(record, 'valueKind'),
      enabled: requireBoolean(record, 'enabled'),
    }
  })
}

function parseState(value: unknown): PhysicalState {
  if (
    typeof value !== 'string' ||
    !PHYSICAL_STATES.includes(value as PhysicalState)
  ) {
    throw new TelemetryApiError('invalid_response')
  }
  return value as PhysicalState
}

function firstString(record: JsonRecord, keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof record[key] === 'string') {
      return record[key]
    }
  }
  return undefined
}

function parseSegment(value: unknown): PhysicalStateSegment {
  const record = requireRecord(value)
  const fromUtc = firstString(record, ['fromUtc', 'startUtc', 'start'])
  const toUtc = firstString(record, ['toUtc', 'endUtc', 'end'])
  if (
    !fromUtc ||
    !toUtc ||
    !Number.isFinite(Date.parse(fromUtc)) ||
    !Number.isFinite(Date.parse(toUtc))
  ) {
    throw new TelemetryApiError('invalid_response')
  }

  const suppliedDuration = record.durationMs
  const suppliedSeconds = record.durationSeconds
  const calculatedDuration = Date.parse(toUtc) - Date.parse(fromUtc)
  const durationMs =
    typeof suppliedDuration === 'number' && Number.isFinite(suppliedDuration)
      ? suppliedDuration
      : typeof suppliedSeconds === 'number' && Number.isFinite(suppliedSeconds)
        ? suppliedSeconds * 1_000
      : calculatedDuration

  if (durationMs < 0) {
    throw new TelemetryApiError('invalid_response')
  }

  const optionalNumber = (key: string): number | null | undefined => record[key] === undefined ? undefined : record[key] === null ? null : typeof record[key] === 'number' && Number.isFinite(record[key]) ? record[key] as number : (() => { throw new TelemetryApiError('invalid_response') })()
  const optionalBoolean = (key: string): boolean | null | undefined => record[key] === undefined ? undefined : record[key] === null ? null : typeof record[key] === 'boolean' ? record[key] as boolean : (() => { throw new TelemetryApiError('invalid_response') })()
  if (record.reason !== undefined && typeof record.reason !== 'string') throw new TelemetryApiError('invalid_response')
  return {
    state: parseState(record.state),
    fromUtc,
    toUtc,
    durationMs,
    durationSeconds: durationMs / 1_000,
    actualSpeedAtStart: optionalNumber('actualSpeedAtStart'),
    targetSpeedAtStart: optionalNumber('targetSpeedAtStart'),
    targetCommanded: optionalBoolean('targetCommanded'),
    ...(typeof record.reason === 'string' ? { reason: record.reason } : {}),
  }
}

function summaryDuration(
  summary: JsonRecord,
  state: PhysicalState,
): number | undefined {
  const stateName = state.toLowerCase()
  const directKeys = [
    `${stateName}DurationMs`,
    `${stateName}Ms`,
    state,
  ]
  for (const key of directKeys) {
    const value = summary[key]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      return value
    }
  }

  for (const key of ['durationsMs', 'durationMsByState', 'byState']) {
    const container = summary[key]
    if (isRecord(container)) {
      const value = container[state]
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        return value
      }
      if (isRecord(value)) {
        const duration = value.durationMs
        if (
          typeof duration === 'number' &&
          Number.isFinite(duration) &&
          duration >= 0
        ) {
          return duration
        }
      }
    }
    if (Array.isArray(container)) {
      const match = container.find(
        (item) => isRecord(item) && item.state === state,
      )
      if (isRecord(match)) {
        const duration = match.durationMs
        if (
          typeof duration === 'number' &&
          Number.isFinite(duration) &&
          duration >= 0
        ) {
          return duration
        }
      }
    }
  }

  return undefined
}

function parsePhysicalState(value: unknown): PhysicalStateResponse {
  const record = requireRecord(value)
  const rawSegments = record.segments
  const rawSummary = record.summary
  if (!Array.isArray(rawSegments) || !isRecord(rawSummary)) {
    throw new TelemetryApiError('invalid_response')
  }

  const segments = rawSegments.map(parseSegment)
  const durationsMs = Object.fromEntries(
    PHYSICAL_STATES.map((state) => [
      state,
      summaryDuration(rawSummary, state) ??
        segments
          .filter((segment) => segment.state === state)
          .reduce((total, segment) => total + segment.durationMs, 0),
    ]),
  ) as Record<PhysicalState, number>
  const durationSecondsKey: Record<PhysicalState, string> = { RUNNING: 'runningSeconds', STOPPED: 'stoppedSeconds', TRANSITION: 'transitionSeconds', UNKNOWN: 'unknownSeconds' }
  const durationsSeconds = Object.fromEntries(PHYSICAL_STATES.map((state) => {
    const supplied = rawSummary[durationSecondsKey[state]]
    return [state, typeof supplied === 'number' && Number.isFinite(supplied) && supplied >= 0 ? supplied : durationsMs[state] / 1_000]
  })) as Record<PhysicalState, number>

  const rawPolicy = record.policy
  const policy = isRecord(rawPolicy) && isJsonValue(rawPolicy) ? rawPolicy : {}

  return {
    sourceId: requireNumber(record, 'sourceId'),
    sourceKey: requireString(record, 'sourceKey'),
    displayName: requireString(record, 'displayName'),
    fromUtc: requireString(record, 'fromUtc'),
    toUtc: requireString(record, 'toUtc'),
    policy,
    summary: {
      durationsMs,
      durationsSeconds,
      segmentCount:
        typeof rawSummary.segmentCount === 'number' &&
        Number.isInteger(rawSummary.segmentCount) &&
        rawSummary.segmentCount >= 0
          ? rawSummary.segmentCount
          : segments.length,
    },
    segments,
  }
}

export class TelemetryApiClient implements TelemetryClient {
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly fetchImplementation: FetchImplementation

  constructor(
    config: TelemetryApiConfig,
    fetchImplementation: FetchImplementation = fetch,
  ) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '')
    this.timeoutMs = config.timeoutMs
    this.fetchImplementation = fetchImplementation
  }

  async getHealth(requestId?: string): Promise<TelemetryHealth> {
    return parseHealth(await this.request('/health', undefined, requestId))
  }

  async getDatabaseHealth(requestId?: string): Promise<TelemetryDatabaseHealth> {
    return parseDatabaseHealth(
      await this.request('/health/database', undefined, requestId),
    )
  }

  async getSources(requestId?: string, signal?: AbortSignal): Promise<TelemetrySource[]> {
    return parseSources(
      await this.request('/api/telemetry/sources', undefined, requestId, 'GET', undefined, signal),
    )
  }

  async getCapabilities(sourceId: number, requestId?: string, signal?: AbortSignal): Promise<TelemetryCapabilitiesResponse> {
    return parseCapabilitiesResponse(await this.request(`/api/telemetry/sources/${sourceId}/capabilities`, undefined, requestId, 'GET', undefined, signal))
  }

  async getSignals(sourceId: number, requestId?: string, signal?: AbortSignal): Promise<TelemetrySourceSignal[]> {
    return parseSourceSignals(await this.request(`/api/telemetry/sources/${sourceId}/signals`, undefined, requestId, 'GET', undefined, signal))
  }

  async getMachineSpeedHistory(sourceId: number, fromUtc: string, toUtc: string, requestId?: string, signal?: AbortSignal): Promise<TelemetryMachineSpeedHistory> {
    return parseMachineSpeedHistory(await this.request(`/api/telemetry/sources/${sourceId}/machine-speed-history`, { fromUtc, toUtc }, requestId, 'GET', undefined, signal))
  }

  async querySemanticHistory(sourceId: number, query: TelemetrySemanticHistoryQuery, requestId?: string, signal?: AbortSignal): Promise<TelemetrySemanticHistoryResponse> {
    const rangeMs = Date.parse(query.toUtc) - Date.parse(query.fromUtc)
    if (!Number.isFinite(rangeMs) || rangeMs <= 0 || rangeMs > 2 * 60 * 60 * 1_000 || query.signals.length < 1 || query.signals.length > 50 || query.signals.some(({ canonicalId, deckNumber, representation }) => !canonicalId || canonicalId.length > 200 || (deckNumber !== undefined && (!Number.isSafeInteger(deckNumber) || deckNumber < 1)) || (representation !== 'samples' && representation !== 'changes'))) throw new TelemetryApiError('request_invalid', 400)
    return parseSemanticHistoryResponse(await this.request(`/api/telemetry/sources/${sourceId}/semantic-history/query`, undefined, requestId, 'POST', query, signal))
  }

  async getRawTelemetryChanges(query: RawTelemetryChangesQuery, requestId?: string, signal?: AbortSignal): Promise<RawTelemetryChangesResponse> {
    return parseRawChanges(await this.request('/api/raw-telemetry/changes', undefined, requestId, 'POST', query, signal))
  }

  async getRawTelemetryHistory(query: RawTelemetryHistoryQuery, requestId?: string, signal?: AbortSignal): Promise<RawTelemetryHistoryResponse> {
    return parseRawHistory(await this.request('/api/raw-telemetry/history', undefined, requestId, 'POST', query, signal))
  }

  async getPhysicalState(
    sourceId: number,
    fromUtc: string,
    toUtc: string,
    requestId?: string,
    signal?: AbortSignal,
  ): Promise<PhysicalStateResponse> {
    return parsePhysicalState(
      await this.request(
        `/api/telemetry/sources/${sourceId}/physical-state`,
        { fromUtc, toUtc },
        requestId,
        'GET',
        undefined,
        signal,
      ),
    )
  }

  private async request(
    path: string,
    query: Record<string, string> | undefined,
    requestId: string | undefined,
    method: 'GET' | 'POST' = 'GET',
    body?: unknown,
    externalSignal?: AbortSignal,
  ): Promise<unknown> {
    const url = new URL(path.replace(/^\//, ''), `${this.baseUrl}/`)
    for (const [key, value] of Object.entries(query ?? {})) {
      url.searchParams.set(key, value)
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    const cancel = () => controller.abort()
    externalSignal?.addEventListener('abort', cancel, { once: true })

    try {
      const response = await this.fetchImplementation(url, {
        method,
        headers: {
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(requestId ? { 'X-Request-Id': requestId } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      })

      if (!response.ok) {
        const kind = response.status === 404 ? 'not_found' : response.status === 400 ? 'request_invalid' : response.status === 413 ? 'payload_too_large' : response.status >= 500 ? 'unavailable' : 'upstream_http'
        throw new TelemetryApiError(kind, response.status)
      }

      try {
        return await response.json()
      } catch {
        throw new TelemetryApiError('invalid_response')
      }
    } catch (error) {
      if (error instanceof TelemetryApiError) {
        throw error
      }
      if (controller.signal.aborted) {
        throw new TelemetryApiError(externalSignal?.aborted ? 'cancelled' : 'timeout')
      }
      throw new TelemetryApiError('unavailable')
    } finally {
      clearTimeout(timeout)
      externalSignal?.removeEventListener('abort', cancel)
    }
  }
}
