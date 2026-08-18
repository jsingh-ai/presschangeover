import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { EXPLORER_HTTP_VALIDATION_CAPABILITIES } from '../src/explorer-validation-capabilities.js'
import { localProcessIntelligenceBaseUrl, ProcessIntelligenceExplorerHttpClient } from '../scripts/explorer-http-validation.js'

test('live explorer validation has no direct Radius database construction path', async () => {
  const liveHarness = await readFile(new URL('../scripts/validate-explorers-live.ts', import.meta.url), 'utf8')
  const httpTransport = await readFile(new URL('../scripts/explorer-http-validation.ts', import.meta.url), 'utf8')
  const appSource = await readFile(new URL('../src/app.ts', import.meta.url), 'utf8')
  for (const source of [liveHarness, httpTransport]) {
    assert.doesNotMatch(source, /createRadiusService|RadiusRepository|from ['"]pg['"]|new Pool\s*\(/)
  }
  assert.match(liveHarness, /ProcessIntelligenceExplorerHttpClient/)
  assert.match(liveHarness, /maximumDatabaseConnections:\s*0/)
  assert.match(liveHarness, /directRadiusDatabaseConnections:\s*0/)
  assert.match(appSource, /explorerHttpValidation:\s*EXPLORER_HTTP_VALIDATION_CAPABILITIES/)
  assert.equal((appSource.match(/includeRawTelemetryDiscovery:\s*false/g) ?? []).length >= 2, true)
})

test('HTTP validation requires the safe deployed route contract and loopback URL', async () => {
  assert.deepEqual(EXPLORER_HTTP_VALIDATION_CAPABILITIES, {
    version: 1,
    transport: 'processintelligence_http',
    directPostgresValidationConnections: 0,
    radiusAccess: 'read_only',
    boundedExplorerRoutes: true,
    rawDetailSuppressesRawDiscovery: true,
    telemetryDetailSuppressesRawDiscovery: true,
    rawHistoryRoute: true,
    telemetryHistoryRoute: true,
  })
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init })
    return new Response(JSON.stringify({ service: 'ProcessIntelligence', status: 'healthy', explorerHttpValidation: EXPLORER_HTTP_VALIDATION_CAPABILITIES }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  const api = new ProcessIntelligenceExplorerHttpClient(localProcessIntelligenceBaseUrl('127.0.0.1', 3100), fakeFetch)

  await api.assertCompatibleServer()
  assert.equal(requests.length, 1)
  assert.equal(requests[0]!.url, 'http://127.0.0.1:3100/api/health')
  assert.equal(requests[0]!.init?.method, 'GET')
  assert.throws(() => localProcessIntelligenceBaseUrl('10.8.10.97', 3100), /loopback/)
})

test('validation detail calls explicitly suppress raw discovery', async () => {
  const bodies: unknown[] = []
  const fakeFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)))
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  const api = new ProcessIntelligenceExplorerHttpClient(localProcessIntelligenceBaseUrl('localhost', 3100), fakeFetch)
  await api.rawDetail({} as never, 30)
  await api.telemetryDetail({} as never)
  assert.deepEqual(bodies, [
    { occurrence: {}, changeLookbackMinutes: 30, includeRawTelemetryDiscovery: false },
    { occurrence: {}, includeRawTelemetryDiscovery: false },
  ])
})
