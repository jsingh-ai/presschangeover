import assert from 'node:assert/strict'
import test from 'node:test'
import {
  TelemetryApiClient,
  TelemetryApiError,
} from '../src/telemetry/telemetry-api-client.js'
import { mixedHistoryFixture, motionFixture, press14SpeedFixture, press5CapabilitiesFixture } from './fixtures/telemetry-fixtures.js'

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

test('builds the correct physical-state URL and propagates request ID', async () => {
  let requestedUrl = ''
  let requestId = ''
  const fetchMock: typeof fetch = async (input, init) => {
    requestedUrl = input.toString()
    requestId = new Headers(init?.headers).get('X-Request-Id') ?? ''
    return jsonResponse({
      sourceId: 3,
      sourceKey: 'press3',
      displayName: 'Press 3',
      fromUtc: '2026-08-10T12:00:00.000Z',
      toUtc: '2026-08-10T12:30:00.000Z',
      policy: { version: 'v1' },
      summary: { runningDurationMs: 1_800_000, segmentCount: 1 },
      segments: [
        {
          state: 'RUNNING',
          startUtc: '2026-08-10T12:00:00.000Z',
          endUtc: '2026-08-10T12:30:00.000Z',
          durationMs: 1_800_000,
        },
      ],
    })
  }
  const client = new TelemetryApiClient(
    { baseUrl: 'http://telemetry.internal:5080', timeoutMs: 500 },
    fetchMock,
  )

  const result = await client.getPhysicalState(
    3,
    '2026-08-10T12:00:00.000Z',
    '2026-08-10T12:30:00.000Z',
    'test-request',
  )

  const url = new URL(requestedUrl)
  assert.equal(
    `${url.origin}${url.pathname}`,
    'http://telemetry.internal:5080/api/telemetry/sources/3/physical-state',
  )
  assert.equal(url.searchParams.get('fromUtc'), '2026-08-10T12:00:00.000Z')
  assert.equal(url.searchParams.get('toUtc'), '2026-08-10T12:30:00.000Z')
  assert.equal(requestId, 'test-request')
  assert.equal(result.summary.durationsMs.RUNNING, 1_800_000)
})

test('trailing slash does not produce a malformed upstream URL', async () => {
  let requestedUrl = ''
  const fetchMock: typeof fetch = async (input) => {
    requestedUrl = input.toString()
    return jsonResponse({ service: 'TelemetryQueryApi', status: 'healthy' })
  }
  const client = new TelemetryApiClient(
    { baseUrl: 'http://telemetry.internal:5080/', timeoutMs: 500 },
    fetchMock,
  )

  await client.getHealth()

  assert.equal(requestedUrl, 'http://telemetry.internal:5080/health')
})

test('successful health response parses into the typed contract', async () => {
  const client = new TelemetryApiClient(
    { baseUrl: 'http://telemetry.internal', timeoutMs: 500 },
    async () =>
      jsonResponse({ service: 'TelemetryQueryApi', status: 'healthy' }),
  )

  assert.deepEqual(await client.getHealth(), {
    service: 'TelemetryQueryApi',
    status: 'healthy',
  })
})

test('successful source response is projected to known fields', async () => {
  const client = new TelemetryApiClient(
    { baseUrl: 'http://telemetry.internal', timeoutMs: 500 },
    async () =>
      jsonResponse({
        sources: [
          {
            id: 3,
            sourceKey: 'press3',
            displayName: 'Press 3',
            enabled: true,
            unexpected: 'not forwarded',
          },
        ],
      }),
  )

  assert.deepEqual(await client.getSources(), [
    {
      id: 3,
      sourceKey: 'press3',
      displayName: 'Press 3',
      enabled: true,
    },
  ])
})

test('timeout is translated to a safe telemetry error', async () => {
  const fetchMock: typeof fetch = async (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () =>
        reject(new Error('socket detail must remain internal')),
      )
    })
  const client = new TelemetryApiClient(
    { baseUrl: 'http://telemetry.internal', timeoutMs: 10 },
    fetchMock,
  )

  await assert.rejects(
    client.getHealth(),
    (error: unknown) =>
      error instanceof TelemetryApiError && error.kind === 'timeout',
  )
})

test('malformed upstream JSON becomes an invalid-response error', async () => {
  const client = new TelemetryApiClient(
    { baseUrl: 'http://telemetry.internal', timeoutMs: 500 },
    async () =>
      new Response('<html>internal failure</html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      }),
  )

  await assert.rejects(
    client.getSources(),
    (error: unknown) =>
      error instanceof TelemetryApiError && error.kind === 'invalid_response',
  )
})

test('strictly parses capabilities and preserves supported and unsupported entries', async () => {
  const client = new TelemetryApiClient({ baseUrl: 'http://telemetry.internal', timeoutMs: 500 }, async () => jsonResponse(press5CapabilitiesFixture))
  const result = await client.getCapabilities(41)
  assert.equal(result.capabilities.find(({ canonicalId }) => canonicalId === 'deck.active')?.supported, true)
  assert.equal(result.capabilities.find(({ canonicalId }) => canonicalId === 'deck.active')?.deckNumbers[0], 1)
})

test('semantic history POST sends explicit mixed representations and preserves typed evidence', async () => {
  let method = ''
  let body: Record<string, unknown> = {}
  const client = new TelemetryApiClient({ baseUrl: 'http://telemetry.internal', timeoutMs: 500 }, async (_input, init) => {
    method = init?.method ?? ''
    body = JSON.parse(String(init?.body))
    return jsonResponse(mixedHistoryFixture)
  })
  const result = await client.querySemanticHistory(41, {
    fromUtc: mixedHistoryFixture.fromUtc, toUtc: mixedHistoryFixture.toUtc, includeSeed: true,
    signals: [{ canonicalId: 'production.order', representation: 'changes' }, { canonicalId: 'ink.temperature.actual', deckNumber: 3, representation: 'samples' }],
  })
  assert.equal(method, 'POST')
  assert.deepEqual((body.signals as Array<{ representation: string }>).map(({ representation }) => representation), ['changes', 'samples'])
  assert.equal(result.signals[0]?.seedSample?.observedAtUtc, '2026-08-12T03:29:25.000Z')
  assert.equal(result.signals[0]?.changes[0]?.previousValueKind, 'string')
  assert.equal(result.signals[1]?.seedSample?.value, 0)
  assert.equal(result.signals[2]?.samples[0]?.valueKind, 'numeric')
  assert.equal(result.signals[3]?.seedSample?.value, false)
})

test('machine speed preserves actual/setpoint values and source unit without conversion', async () => {
  const client = new TelemetryApiClient({ baseUrl: 'http://telemetry.internal', timeoutMs: 500 }, async () => jsonResponse(press14SpeedFixture))
  const result = await client.getMachineSpeedHistory(43, press14SpeedFixture.fromUtc, press14SpeedFixture.toUtc)
  assert.equal(result.actual.sourceUnit, 'ft/min')
  assert.equal(result.actual.canonicalUnitStatus, 'unverified')
  assert.deepEqual(result.actual.samples.map(({ value }) => value), [0, 25.5])
  assert.equal(result.setpoint?.samples[0]?.value, 100)
})

test('physical motion parser preserves policy, states, speed, target, and durations', async () => {
  const productionShape = {
    ...motionFixture,
    summary: { runningSeconds: 120, stoppedSeconds: 120, transitionSeconds: 30, unknownSeconds: 30 },
    segments: motionFixture.segments.map(({ fromUtc, toUtc, durationMs, ...segment }) => ({ ...segment, startUtc: fromUtc, endUtc: toUtc, durationSeconds: durationMs / 1000 })),
  }
  const client = new TelemetryApiClient({ baseUrl: 'http://telemetry.internal', timeoutMs: 500 }, async () => jsonResponse(productionShape))
  const result = await client.getPhysicalState(41, motionFixture.fromUtc, motionFixture.toUtc)
  assert.deepEqual(result.segments.map(({ state }) => state), ['RUNNING', 'STOPPED', 'TRANSITION', 'UNKNOWN'])
  assert.equal(result.segments[0]?.actualSpeedAtStart, 30)
  assert.equal(result.segments[0]?.targetCommanded, true)
  assert.equal(result.summary.durationsSeconds?.RUNNING, 120)
})

test('malformed semantic values fail closed rather than becoming zero', async () => {
  const malformed = structuredClone(mixedHistoryFixture) as unknown as { signals: Array<{ seedSample: { valueKind: string; value: unknown } | null }> }
  malformed.signals[0]!.seedSample = { ...malformed.signals[0]!.seedSample!, valueKind: 'integer', value: 'not-a-number' }
  const client = new TelemetryApiClient({ baseUrl: 'http://telemetry.internal', timeoutMs: 500 }, async () => jsonResponse(malformed))
  await assert.rejects(client.querySemanticHistory(41, { fromUtc: mixedHistoryFixture.fromUtc, toUtc: mixedHistoryFixture.toUtc, includeSeed: true, signals: [{ canonicalId: 'production.order', representation: 'changes' }] }), (error: unknown) => error instanceof TelemetryApiError && error.kind === 'invalid_response')
})

for (const [status, kind] of [[400, 'request_invalid'], [413, 'payload_too_large'], [503, 'unavailable']] as const) {
  test(`semantic upstream ${status} maps to ${kind}`, async () => {
    const client = new TelemetryApiClient({ baseUrl: 'http://telemetry.internal', timeoutMs: 500 }, async () => new Response('sanitized failure', { status }))
    await assert.rejects(client.querySemanticHistory(41, { fromUtc: mixedHistoryFixture.fromUtc, toUtc: mixedHistoryFixture.toUtc, includeSeed: true, signals: [{ canonicalId: 'production.order', representation: 'changes' }] }), (error: unknown) => error instanceof TelemetryApiError && error.kind === kind && error.upstreamStatus === status)
  })
}

test('external AbortSignal cancellation is distinct from timeout', async () => {
  const client = new TelemetryApiClient({ baseUrl: 'http://telemetry.internal', timeoutMs: 5_000 }, async (_input, init) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('cancelled internal request')))))
  const controller = new AbortController()
  const pending = client.getCapabilities(41, undefined, controller.signal)
  controller.abort()
  await assert.rejects(pending, (error: unknown) => error instanceof TelemetryApiError && error.kind === 'cancelled')
})

test('raw telemetry changes uses the deployed press contract and preserves unique scalar and container evidence', async () => {
  let requestedUrl = ''; let body: Record<string, unknown> = {}
  const client = new TelemetryApiClient({ baseUrl: 'http://telemetry.internal:5080', timeoutMs: 500 }, async (input, init) => {
    requestedUrl = input.toString(); body = JSON.parse(String(init?.body))
    return jsonResponse({ press: 'press12', displayName: 'Press 12', fromUtc: '2026-08-14T15:00:00.000Z', toUtc: '2026-08-14T16:59:00.000Z', rawCatalogIdentityCount: 601, canonicallyRepresentedIdentityCount: 85, unmappedIdentityCount: 516, usableIdentityCount: 516, changedIdentityCount: 2, framesRead: 1428, historianReadCount: 1, signals: [
      { rawIdentity: 'Press12.unique.analog_in3', displayName: 'analog_in3', dataType: 'numeric', dataKind: 'numeric', sourceUnit: null, discoveryCategory: 'Other', plottable: true, usableObservationCount: 10, unavailableObservationCount: 0, firstValue: 14.8, lastValue: 24, minimum: 14.1, maximum: 24.6, changeCount: 3, largestAbsoluteStep: 3.7, positiveMovementPresent: true, negativeMovementPresent: false, transitionSequence: [], transitionSequenceTruncated: false, knownShape: null, alternateRepresentationCount: 0, alternateRawIdentities: [] },
      { rawIdentity: 'Press12.unique.deck.print_on', displayName: 'deck.print_on', dataType: 'container', dataKind: 'container', sourceUnit: null, discoveryCategory: 'Containers / Arrays', plottable: false, usableObservationCount: 4, unavailableObservationCount: 0, firstValue: [0, 0], lastValue: [0, 1], minimum: null, maximum: null, changeCount: 1, largestAbsoluteStep: null, positiveMovementPresent: false, negativeMovementPresent: false, transitionSequence: [], transitionSequenceTruncated: false, knownShape: 'array[13]', alternateRepresentationCount: 0, alternateRawIdentities: [] },
    ] })
  })
  const result = await client.getRawTelemetryChanges({ press: 'press12', fromUtc: '2026-08-14T15:00:00.000Z', toUtc: '2026-08-14T16:59:00.000Z' })
  assert.equal(requestedUrl, 'http://telemetry.internal:5080/api/raw-telemetry/changes')
  assert.deepEqual(body, { press: 'press12', fromUtc: '2026-08-14T15:00:00.000Z', toUtc: '2026-08-14T16:59:00.000Z' })
  assert.equal(result.signals[0]?.rawIdentity, 'Press12.unique.analog_in3')
  assert.equal(result.signals[1]?.knownShape, 'array[13]')
  assert.equal(result.signals[1]?.plottable, false)
})

test('raw telemetry history requests one exact raw identity and preserves supporting timestamps and raw state values', async () => {
  let body: Record<string, unknown> = {}
  const client = new TelemetryApiClient({ baseUrl: 'http://telemetry.internal:5080', timeoutMs: 500 }, async (_input, init) => {
    body = JSON.parse(String(init?.body))
    return jsonResponse({ press: 'press12', displayName: 'Press 12', rawIdentity: 'Press12.unique.state', signalDisplayName: 'state', dataType: 'integer', dataKind: 'state', sourceUnit: null, plottable: true, fromUtc: '2026-08-14T16:45:00.000Z', toUtc: '2026-08-14T16:55:00.000Z', historianReadCount: 1, alternateRepresentationCount: 0, alternateRawIdentities: [], observations: [{ timestampUtc: '2026-08-14T16:46:00.000Z', receivedAtUtc: '2026-08-14T16:46:01.000Z', sourceTimestampUtc: null, qualityState: 'GOOD', dataType: 'integer', rawValue: 10 }] })
  })
  const result = await client.getRawTelemetryHistory({ press: 'press12', rawIdentity: 'Press12.unique.state', fromUtc: '2026-08-14T16:45:00.000Z', toUtc: '2026-08-14T16:55:00.000Z' })
  assert.deepEqual(body, { press: 'press12', rawIdentity: 'Press12.unique.state', fromUtc: '2026-08-14T16:45:00.000Z', toUtc: '2026-08-14T16:55:00.000Z' })
  assert.equal(result.observations[0]?.timestampUtc, '2026-08-14T16:46:00.000Z')
  assert.equal(result.observations[0]?.sourceTimestampUtc, null)
  assert.equal(result.observations[0]?.rawValue, 10)
})

test('source signal catalog preserves numeric, string, and boolean scalar metadata', async () => {
  let requestedUrl = ''
  const client = new TelemetryApiClient({ baseUrl: 'http://telemetry.internal:5080', timeoutMs: 500 }, async (input) => {
    requestedUrl = String(input)
    return jsonResponse([
      { id: 1, sourceId: 14, signalId: 'Press14.Temp', displayName: 'Temperature', sourceUnit: 'degF', valueKind: 'numeric', enabled: true },
      { id: 2, sourceId: 14, signalId: 'Press14.Job', displayName: 'Job', sourceUnit: null, valueKind: 'string', enabled: true },
      { id: 3, sourceId: 14, signalId: 'Press14.Nip', displayName: 'Nip', sourceUnit: null, valueKind: 'boolean', enabled: true },
    ])
  })
  const result = await client.getSignals(14)
  assert.equal(requestedUrl, 'http://telemetry.internal:5080/api/telemetry/sources/14/signals')
  assert.deepEqual(result.map(({ signalId, valueKind }) => ({ signalId, valueKind })), [{ signalId: 'Press14.Temp', valueKind: 'numeric' }, { signalId: 'Press14.Job', valueKind: 'string' }, { signalId: 'Press14.Nip', valueKind: 'boolean' }])
})
