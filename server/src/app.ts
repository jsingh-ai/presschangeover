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
}: CreateAppOptions) {
  const app = express()
  const telemetry = new TelemetryFoundationService(telemetryClient)
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
