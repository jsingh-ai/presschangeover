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

export type TelemetryApiErrorKind =
  | 'timeout'
  | 'unavailable'
  | 'not_found'
  | 'upstream_http'
  | 'invalid_response'

export class TelemetryApiError extends Error {
  constructor(
    public readonly kind: TelemetryApiErrorKind,
    public readonly upstreamStatus?: number,
  ) {
    super(`Telemetry dependency failure: ${kind}`)
    this.name = 'TelemetryApiError'
  }
}

export interface TelemetryClient {
  getHealth(requestId?: string): Promise<TelemetryHealth>
  getDatabaseHealth(requestId?: string): Promise<TelemetryDatabaseHealth>
  getSources(requestId?: string): Promise<TelemetrySource[]>
  getPhysicalState(
    sourceId: number,
    fromUtc: string,
    toUtc: string,
    requestId?: string,
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
  const calculatedDuration = Date.parse(toUtc) - Date.parse(fromUtc)
  const durationMs =
    typeof suppliedDuration === 'number' && Number.isFinite(suppliedDuration)
      ? suppliedDuration
      : calculatedDuration

  if (durationMs < 0) {
    throw new TelemetryApiError('invalid_response')
  }

  return {
    state: parseState(record.state),
    fromUtc,
    toUtc,
    durationMs,
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

  async getSources(requestId?: string): Promise<TelemetrySource[]> {
    return parseSources(
      await this.request('/api/telemetry/sources', undefined, requestId),
    )
  }

  async getPhysicalState(
    sourceId: number,
    fromUtc: string,
    toUtc: string,
    requestId?: string,
  ): Promise<PhysicalStateResponse> {
    return parsePhysicalState(
      await this.request(
        `/api/telemetry/sources/${sourceId}/physical-state`,
        { fromUtc, toUtc },
        requestId,
      ),
    )
  }

  private async request(
    path: string,
    query: Record<string, string> | undefined,
    requestId: string | undefined,
  ): Promise<unknown> {
    const url = new URL(path.replace(/^\//, ''), `${this.baseUrl}/`)
    for (const [key, value] of Object.entries(query ?? {})) {
      url.searchParams.set(key, value)
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)

    try {
      const response = await this.fetchImplementation(url, {
        headers: {
          Accept: 'application/json',
          ...(requestId ? { 'X-Request-Id': requestId } : {}),
        },
        signal: controller.signal,
      })

      if (!response.ok) {
        throw new TelemetryApiError(
          response.status === 404 ? 'not_found' : 'upstream_http',
          response.status,
        )
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
        throw new TelemetryApiError('timeout')
      }
      throw new TelemetryApiError('unavailable')
    } finally {
      clearTimeout(timeout)
    }
  }
}
