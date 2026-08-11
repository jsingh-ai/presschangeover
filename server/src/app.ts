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
import { ClassificationForbiddenError, ClassificationService, ClassificationValidationError } from './classification/classification-service.js'
import { OPERATIONAL_GROUP_KEYS, PROCESS_FAMILY_KEYS, type MappingConfidence, type OperationalGroupKey, type ProcessFamilyKey, type RadiusIdentity } from './classification/models.js'
import { exactRadiusIdentity } from './radius/radius-identity.js'

const MAX_PHYSICAL_STATE_RANGE_MS = 2 * 60 * 60 * 1_000
const MAX_RADIUS_RANGE_MS = 31 * 24 * 60 * 60 * 1_000
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
      response.status(200).json(await radiusService.getOverview(fromUtc, toUtc))
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

  const classificationWorkspace = async (request: Request) => {
    if (!classificationService) throw new RadiusUnavailableError()
    const observed = await (radiusService.getObservedIdentities?.() ?? Promise.resolve([]))
    return classificationService.getWorkspace(observed, classificationAuthorizer(request))
  }
  const classificationObserved = () => radiusService.getObservedIdentities?.() ?? Promise.resolve([])
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

  app.get('/api/classification/workspace', asyncRoute(async (request, response) => { response.status(200).json(await classificationWorkspace(request)) }))
  app.get('/api/classification/groups', asyncRoute(async (request, response) => { response.status(200).json((await classificationWorkspace(request)).effectiveGroups) }))
  app.get('/api/classification/process-families', asyncRoute(async (request, response) => { response.status(200).json((await classificationWorkspace(request)).families) }))
  app.get('/api/classification/identities', asyncRoute(async (request, response) => { response.status(200).json((await classificationWorkspace(request)).observedIdentities) }))
  app.get('/api/classification/classifications', asyncRoute(async (request, response) => { response.status(200).json((await classificationWorkspace(request)).effectiveClassifications) }))
  app.get('/api/classification/review-required', asyncRoute(async (request, response) => { response.status(200).json((await classificationWorkspace(request)).effectiveClassifications.filter(({ needsReview, isFallback }) => needsReview || isFallback)) }))
  app.get('/api/classification/draft', asyncRoute(async (request, response) => { response.status(200).json((await classificationWorkspace(request)).draft) }))
  app.get('/api/classification/versions', asyncRoute(async (request, response) => { response.status(200).json((await classificationWorkspace(request)).versions) }))
  app.get('/api/classification/audit', asyncRoute(async (request, response) => { response.status(200).json((await classificationWorkspace(request)).audit) }))

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
        const status = error.kind === 'not_found' ? 404 : 503
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
