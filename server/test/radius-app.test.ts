import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import type { Express } from 'express'
import { createApp } from '../src/app.js'
import type { RadiusOverview } from '../src/radius/models.js'
import type { RadiusService } from '../src/radius/radius-service.js'
import { UnavailableRadiusService } from '../src/radius/radius-service.js'
import type { TelemetryClient } from '../src/telemetry/telemetry-api-client.js'

const telemetryClient: TelemetryClient = {
  getHealth: async () => ({ service: 'TelemetryQueryApi', status: 'healthy' }),
  getDatabaseHealth: async () => ({ service: 'TelemetryQueryApi', database: 'pressstop', status: 'healthy' }),
  getSources: async () => [],
  getPhysicalState: async () => {
    throw new Error('not used')
  },
}

async function request(app: Express, path: string, init?: RequestInit) {
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address() as AddressInfo
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, init)
    return { status: response.status, body: await response.text() }
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
}

test('Radius health is safely unavailable when no dedicated configuration exists', async () => {
  const app = createApp({ telemetryClient, logger: false })
  const response = await request(app, '/api/radius/health')
  assert.equal(response.status, 503)
  assert.deepEqual(JSON.parse(response.body), {
    status: 'unavailable',
    configured: false,
    reason: 'not_configured',
  })
  assert.doesNotMatch(response.body, /password|user|connection/i)
})

test('Radius overview remains safely unavailable without affecting the API process', async () => {
  const app = createApp({ telemetryClient, logger: false })
  const response = await request(
    app,
    '/api/radius/overview?fromUtc=2026-08-10T00%3A00%3A00.000Z&toUtc=2026-08-11T00%3A00%3A00.000Z',
  )
  assert.equal(response.status, 503)
  assert.deepEqual(JSON.parse(response.body), {
    status: 'unavailable',
    service: 'Radius',
  })
})

test('Radius range rejects more than 31 days before calling the service', async () => {
  let calls = 0
  const radiusService: RadiusService = {
    getHealth: async () => ({
      status: 'unavailable',
      configured: false,
      reason: 'not_configured',
    }),
    getOverview: async () => {
      calls += 1
      throw new Error('must not be called')
    },
    getPressEpisodes: async () => {
      throw new Error('must not be called')
    },
    getEpisode: async () => {
      throw new Error('must not be called')
    },
  }
  const app = createApp({ telemetryClient, radiusService, logger: false })
  const response = await request(
    app,
    '/api/radius/overview?fromUtc=2026-01-01T00%3A00%3A00.000Z&toUtc=2026-02-02T00%3A00%3A00.000Z',
  )
  assert.equal(response.status, 400)
  assert.deepEqual(JSON.parse(response.body), { error: 'time_range_too_large' })
  assert.equal(calls, 0)
})

test('valid Radius overview range is forwarded and returned', async () => {
  const overview: RadiusOverview = {
    fromUtc: '2026-08-10T00:00:00.000Z',
    toUtc: '2026-08-11T00:00:00.000Z',
    plantTimeZone: 'America/Chicago',
    productionStatusDescription: 'Run Production',
    stateBreakdownRunConfirmationSeconds: 120,
    rangeEndIsLive: false,
    feedStatus: 'OFFLINE',
    lastObservationUtc: null,
    offlinePressCount: 0,
    onlinePressCount: 0,
    summary: {
      pressesMonitored: 0,
      currentlyRunProduction: 0,
      currentlyNonProduction: 0,
      openEpisodes: 0,
      totalNonProductionSeconds: 0,
    },
    unmappedPressKeys: ['press3'],
    presses: [],
    episodeAnalysis: { sequenceFamilies: [] },
    operationalAnalytics: {
      fromUtc: '2026-08-10T00:00:00.000Z', toUtc: '2026-08-11T00:00:00.000Z',
      scopePressKeys: [], scopePressCount: 0, annotationDisclaimer: '',
      coverage: { possibleSeconds: 0, observedSeconds: 0, unknownSeconds: 0, coveragePercentage: 0 },
      categories: [], statusDrivers: [],
      productionStops: { anchorCount: 0, resolvedCount: 0, censoredCount: 0, outcomes: [], paths: [] },
      beforeSuccessfulProduction: { anchorCount: 0, resolvedCount: 0, censoredCount: 0, outcomes: [], paths: [] },
      afterMakeReady: { anchorCount: 0, resolvedCount: 0, censoredCount: 0, outcomes: [], paths: [], confirmedProductionCount: 0, returnedToMakeReadyCount: 0, enteredBadCount: 0, enteredSafetyCount: 0, failedToReachConfirmedProductionCount: 0, unresolvedCount: 0, medianSecondsToConfirmedProduction: null, p90SecondsToConfirmedProduction: null },
      relationshipGroups: [], anomalies: [],
    },
  }
  const radiusService: RadiusService = {
    getHealth: async () => ({ status: 'healthy', configured: true }),
    getOverview: async () => overview,
    getPressEpisodes: async () => {
      throw new Error('not used')
    },
    getEpisode: async () => {
      throw new Error('not used')
    },
  }
  const app = createApp({ telemetryClient, radiusService, logger: false })
  const response = await request(
    app,
    '/api/radius/overview?fromUtc=2026-08-10T00%3A00%3A00.000Z&toUtc=2026-08-11T00%3A00%3A00.000Z',
  )
  assert.equal(response.status, 200)
  assert.deepEqual(JSON.parse(response.body), overview)
  const decisionResponse = await request(
    app,
    '/api/radius/overview?fromUtc=2026-08-10T00%3A00%3A00.000Z&toUtc=2026-08-11T00%3A00%3A00.000Z&view=decision',
  )
  const decisionBody = JSON.parse(decisionResponse.body) as Record<string, unknown>
  assert.equal(decisionResponse.status, 200)
  assert.equal('episodeAnalysis' in decisionBody, false)
  assert.equal('operationalAnalytics' in decisionBody, false)
  assert.deepEqual(decisionBody.presses, overview.presses)
})

test('unknown press keys are rejected before repository access', async () => {
  const app = createApp({ telemetryClient, logger: false })
  const response = await request(
    app,
    '/api/radius/presses/press1/episodes?fromUtc=2026-08-10T00%3A00%3A00.000Z&toUtc=2026-08-11T00%3A00%3A00.000Z',
  )
  assert.equal(response.status, 400)
  assert.deepEqual(JSON.parse(response.body), { error: 'invalid_press_key' })
})

test('unexpected failures are logged with sanitized diagnostics and remain generic to clients', async () => {
  const messages: string[] = []
  const radiusService: RadiusService = {
    getHealth: async () => ({ status: 'healthy', configured: true }),
    getOverview: async () => {
      const error = new Error(
        'query failed password=super-secret postgres://reader:hidden@example/db',
      )
      error.name = 'DatabaseError'
      throw error
    },
    getPressEpisodes: async () => {
      throw new Error('not used')
    },
    getEpisode: async () => {
      throw new Error('not used')
    },
  }
  const app = createApp({
    telemetryClient,
    radiusService,
    logger: { info: () => undefined, error: (message) => messages.push(message) },
  })
  const response = await request(
    app,
    '/api/radius/overview?fromUtc=2026-08-10T00%3A00%3A00.000Z&toUtc=2026-08-11T00%3A00%3A00.000Z',
    { headers: { 'X-Request-Id': 'radius-regression-request' } },
  )
  assert.equal(response.status, 500)
  assert.deepEqual(JSON.parse(response.body), { error: 'internal_error' })
  assert.equal(messages.length, 1)
  const logged = JSON.parse(messages[0]) as {
    requestId: string
    route: string
    error: { type: string; message: string; stack: string }
  }
  assert.equal(logged.requestId, 'radius-regression-request')
  assert.equal(logged.route, '/api/radius/overview')
  assert.equal(logged.error.type, 'DatabaseError')
  assert.match(logged.error.message, /password=\[REDACTED\]/)
  assert.match(logged.error.stack, /DatabaseError/)
  assert.doesNotMatch(messages[0], /super-secret|reader:hidden/)
})
