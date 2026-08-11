import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import type { Express } from 'express'
import { createApp } from '../src/app.js'
import type {
  PhysicalStateResponse,
  TelemetrySource,
} from '../src/telemetry/models.js'
import {
  TelemetryApiClient,
  type TelemetryClient,
} from '../src/telemetry/telemetry-api-client.js'

const samplePhysicalState: PhysicalStateResponse = {
  sourceId: 3,
  sourceKey: 'press3',
  displayName: 'Press 3',
  fromUtc: '2026-08-10T12:00:00.000Z',
  toUtc: '2026-08-10T12:30:00.000Z',
  policy: { version: 'v1' },
  summary: {
    durationsMs: {
      RUNNING: 1_800_000,
      STOPPED: 0,
      TRANSITION: 0,
      UNKNOWN: 0,
    },
    segmentCount: 1,
  },
  segments: [
    {
      state: 'RUNNING',
      fromUtc: '2026-08-10T12:00:00.000Z',
      toUtc: '2026-08-10T12:30:00.000Z',
      durationMs: 1_800_000,
    },
  ],
}

function createFakeClient(
  overrides: Partial<TelemetryClient> = {},
): TelemetryClient {
  const sources: TelemetrySource[] = [
    {
      id: 3,
      sourceKey: 'press3',
      displayName: 'Press 3',
      enabled: true,
    },
  ]

  return {
    getHealth: async () => ({
      service: 'TelemetryQueryApi',
      status: 'healthy',
    }),
    getDatabaseHealth: async () => ({
      service: 'TelemetryQueryApi',
      database: 'pressstop',
      user: 'telemetry_database_user',
      status: 'healthy',
    }),
    getSources: async () => sources,
    getPhysicalState: async () => samplePhysicalState,
    ...overrides,
  }
}

async function request(
  app: Express,
  path: string,
  headers?: Record<string, string>,
): Promise<{ status: number; body: string; requestId: string | null }> {
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address() as AddressInfo

  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}${path}`,
      { headers },
    )
    return {
      status: response.status,
      body: await response.text(),
      requestId: response.headers.get('X-Request-Id'),
    }
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
}

test('invalid sourceId returns 400 without calling upstream', async () => {
  let upstreamCalls = 0
  const app = createApp({
    telemetryClient: createFakeClient({
      getPhysicalState: async () => {
        upstreamCalls += 1
        return samplePhysicalState
      },
    }),
    logger: false,
  })

  const response = await request(
    app,
    '/api/telemetry/sources/not-a-number/physical-state?fromUtc=2026-08-10T12%3A00%3A00.000Z&toUtc=2026-08-10T12%3A30%3A00.000Z',
  )

  assert.equal(response.status, 400)
  assert.deepEqual(JSON.parse(response.body), { error: 'invalid_source_id' })
  assert.equal(upstreamCalls, 0)
})

test('invalid time ordering returns 400', async () => {
  const app = createApp({
    telemetryClient: createFakeClient(),
    logger: false,
  })

  const response = await request(
    app,
    '/api/telemetry/sources/3/physical-state?fromUtc=2026-08-10T12%3A30%3A00.000Z&toUtc=2026-08-10T12%3A00%3A00.000Z',
  )

  assert.equal(response.status, 400)
  assert.deepEqual(JSON.parse(response.body), { error: 'invalid_time_range' })
})

test('a range longer than two hours returns 400', async () => {
  const app = createApp({
    telemetryClient: createFakeClient(),
    logger: false,
  })

  const response = await request(
    app,
    '/api/telemetry/sources/3/physical-state?fromUtc=2026-08-10T12%3A00%3A00.000Z&toUtc=2026-08-10T14%3A00%3A00.001Z',
  )

  assert.equal(response.status, 400)
  assert.deepEqual(JSON.parse(response.body), {
    error: 'time_range_too_large',
  })
})

test('valid physical-state request is forwarded with correlation ID', async () => {
  let forwarded:
    | {
        sourceId: number
        fromUtc: string
        toUtc: string
        requestId?: string
      }
    | undefined
  const app = createApp({
    telemetryClient: createFakeClient({
      getPhysicalState: async (sourceId, fromUtc, toUtc, requestId) => {
        forwarded = { sourceId, fromUtc, toUtc, requestId }
        return samplePhysicalState
      },
    }),
    logger: false,
  })

  const response = await request(
    app,
    '/api/telemetry/sources/3/physical-state?fromUtc=2026-08-10T12%3A00%3A00.000Z&toUtc=2026-08-10T12%3A30%3A00.000Z',
    { 'X-Request-Id': 'integration-test-request' },
  )

  assert.equal(response.status, 200)
  assert.equal(response.requestId, 'integration-test-request')
  assert.deepEqual(forwarded, {
    sourceId: 3,
    fromUtc: '2026-08-10T12:00:00.000Z',
    toUtc: '2026-08-10T12:30:00.000Z',
    requestId: 'integration-test-request',
  })
})

test('browser-facing telemetry health omits upstream database username', async () => {
  const app = createApp({
    telemetryClient: createFakeClient(),
    logger: false,
  })

  const response = await request(app, '/api/telemetry/health')

  assert.equal(response.status, 200)
  assert.deepEqual(JSON.parse(response.body), {
    status: 'healthy',
    telemetryApi: { status: 'healthy' },
    historian: { status: 'healthy', database: 'pressstop' },
  })
  assert.doesNotMatch(response.body, /telemetry_database_user/)
})

test('upstream HTTP 500 becomes a safe 503 without raw internals', async () => {
  const client = new TelemetryApiClient(
    { baseUrl: 'http://telemetry.internal', timeoutMs: 500 },
    async () =>
      new Response('database password and internal stack', { status: 500 }),
  )
  const app = createApp({ telemetryClient: client, logger: false })

  const response = await request(app, '/api/telemetry/sources')

  assert.equal(response.status, 503)
  assert.deepEqual(JSON.parse(response.body), {
    status: 'unavailable',
    service: 'TelemetryQueryApi',
  })
  assert.doesNotMatch(response.body, /password|stack|telemetry\.internal/i)
})

test('malformed upstream JSON is handled safely without process failure', async () => {
  const client = new TelemetryApiClient(
    { baseUrl: 'http://telemetry.internal', timeoutMs: 500 },
    async () =>
      new Response('{ malformed', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  )
  const app = createApp({ telemetryClient: client, logger: false })

  const response = await request(app, '/api/telemetry/sources')

  assert.equal(response.status, 503)
  assert.deepEqual(JSON.parse(response.body), {
    status: 'unavailable',
    service: 'TelemetryQueryApi',
  })
})
