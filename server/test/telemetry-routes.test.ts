import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import type { Express } from 'express'
import { createApp } from '../src/app.js'
import type { TelemetryClient } from '../src/telemetry/telemetry-api-client.js'
import { mixedHistoryFixture, motionFixture, press14SpeedFixture, press5CapabilitiesFixture, sourcesFixture } from './fixtures/telemetry-fixtures.js'

function client(): TelemetryClient {
  return {
    getHealth: async () => ({ service: 'TelemetryQueryApi', status: 'healthy' }),
    getDatabaseHealth: async () => ({ service: 'TelemetryQueryApi', database: 'historian', status: 'healthy' }),
    getSources: async () => sourcesFixture,
    getCapabilities: async () => press5CapabilitiesFixture,
    getMachineSpeedHistory: async () => ({ ...press14SpeedFixture, sourceId: 41, sourceKey: 'press5', displayName: 'Press 5', actual: { ...press14SpeedFixture.actual, sourceUnit: null }, setpoint: press14SpeedFixture.setpoint ? { ...press14SpeedFixture.setpoint, sourceUnit: null } : null }),
    querySemanticHistory: async () => mixedHistoryFixture,
    getPhysicalState: async () => motionFixture,
  }
}

async function request(app: Express, path: string, init?: RequestInit) {
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address() as AddressInfo
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, init)
    return { status: response.status, body: await response.text() }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}

test('ProcessIntelligence press registry route keeps raw source IDs off the contract', async () => {
  const response = await request(createApp({ telemetryClient: client(), logger: false }), '/api/telemetry/presses')
  assert.equal(response.status, 200)
  const body = JSON.parse(response.body)
  assert.equal(body.find((item: { pressKey: string }) => item.pressKey === 'press5').availability, 'AVAILABLE')
  assert.doesNotMatch(response.body, /"id"\s*:|sourceId|historianSignalId/)
})

test('ProcessIntelligence capabilities route uses press identity and omits raw source ID', async () => {
  const response = await request(createApp({ telemetryClient: client(), logger: false }), '/api/telemetry/presses/press5/capabilities')
  assert.equal(response.status, 200)
  assert.match(response.body, /deck\.active/)
  assert.doesNotMatch(response.body, /sourceId|historianSignalId/)
})

test('ProcessIntelligence speed and motion routes expose clean evidence contracts', async () => {
  const app = createApp({ telemetryClient: client(), logger: false })
  const query = '?fromUtc=2026-08-12T03%3A30%3A00.000Z&toUtc=2026-08-12T03%3A35%3A00.000Z'
  const speed = await request(app, `/api/telemetry/presses/press5/speed${query}`)
  assert.equal(speed.status, 200)
  assert.match(speed.body, /machine\.speed\.actual/)
  assert.doesNotMatch(speed.body, /sourceId|historianSignalId|rawSignalId/)
  const motion = await request(app, `/api/telemetry/presses/press5/motion${query}`)
  assert.equal(motion.status, 200)
  assert.match(motion.body, /RUNNING/)
  assert.doesNotMatch(motion.body, /sourceId|production state/i)
})

test('ProcessIntelligence semantic route validates bounded explicit representations', async () => {
  const app = createApp({ telemetryClient: client(), logger: false })
  const valid = await request(app, '/api/telemetry/presses/press5/semantic-history', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fromUtc: mixedHistoryFixture.fromUtc, toUtc: mixedHistoryFixture.toUtc, includeSeed: true, signals: [{ canonicalId: 'production.order', representation: 'changes' }, { canonicalId: 'ink.temperature.actual', deckNumber: 3, representation: 'samples' }] }) })
  assert.equal(valid.status, 200)
  assert.match(valid.body, /SUPPORTED_WITH_SEED_ONLY|SUPPORTED_WITH_OBSERVATIONS/)
  assert.doesNotMatch(valid.body, /historianSignalId|rawSignalId|sourceId/)
  const invalid = await request(app, '/api/telemetry/presses/press5/semantic-history', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fromUtc: mixedHistoryFixture.fromUtc, toUtc: mixedHistoryFixture.toUtc, includeSeed: true, signals: [{ canonicalId: 'production.order' }] }) })
  assert.equal(invalid.status, 400)
  assert.deepEqual(JSON.parse(invalid.body), { error: 'invalid_telemetry_representation' })
})

test('unknown press fails before any hard-coded source lookup', async () => {
  let sourceCalls = 0
  const fake = client()
  fake.getSources = async () => { sourceCalls += 1; return sourcesFixture }
  const response = await request(createApp({ telemetryClient: fake, logger: false }), '/api/telemetry/presses/press4/capabilities')
  assert.equal(response.status, 400)
  assert.equal(sourceCalls, 0)
})
