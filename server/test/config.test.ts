import assert from 'node:assert/strict'
import test from 'node:test'
import { loadServerConfig } from '../src/config.js'

test('configuration normalizes the telemetry base URL and defaults timeout', () => {
  const config = loadServerConfig({
    TELEMETRY_API_BASE_URL: 'http://telemetry.internal:5080/',
  })

  assert.equal(config.telemetryApi.baseUrl, 'http://telemetry.internal:5080')
  assert.equal(config.telemetryApi.timeoutMs, 5_000)
  assert.equal(config.host, 'localhost')
  assert.equal(config.plantTimeZone, 'America/Chicago')
  assert.deepEqual(config.radius, { enabled: false, staleSeconds: 180 })
})

test('configuration validates explicit plant timezone and complete Radius settings', () => {
  const config = loadServerConfig({
    TELEMETRY_API_BASE_URL: 'http://telemetry.internal',
    PLANT_TIME_ZONE: 'America/Chicago',
    RADIUS_DB_HOST: '127.0.0.1',
    RADIUS_DB_PORT: '5432',
    RADIUS_DB_NAME: 'press_radius_db',
    RADIUS_DB_USER: 'processintelligence_readonly',
    RADIUS_DB_PASSWORD: 'test-only-password',
    RADIUS_DB_SCHEMA: 'public',
    RADIUS_DB_TABLE: 'machine_status_history',
    RADIUS_DB_TIMESTAMP_MODE: 'timestamptz',
    RADIUS_RUN_PRODUCTION_STATUS: 'Run Production',
    RADIUS_PRESS_MAPPINGS: 'press15:215,press3:203,press5:205,press6:206,press7:207,press8:208,press9:209,press10:210,press11:211,press12:212,press13:213,press14:214',
  })

  assert.equal(config.radius.enabled, true)
  if (!config.radius.enabled) return
  assert.equal(config.radius.staleSeconds, 180)
  assert.deepEqual(
    config.radius.mappings.map(({ pressKey, machineId }) => ({ pressKey, machineId })),
    [
      { pressKey: 'press3', machineId: 203 },
      { pressKey: 'press5', machineId: 205 },
      { pressKey: 'press6', machineId: 206 },
      { pressKey: 'press7', machineId: 207 },
      { pressKey: 'press8', machineId: 208 },
      { pressKey: 'press9', machineId: 209 },
      { pressKey: 'press10', machineId: 210 },
      { pressKey: 'press11', machineId: 211 },
      { pressKey: 'press12', machineId: 212 },
      { pressKey: 'press13', machineId: 213 },
      { pressKey: 'press14', machineId: 214 },
      { pressKey: 'press15', machineId: 215 },
    ],
  )
})

test('Radius stale threshold accepts a positive reasonable integer and rejects invalid values', () => {
  const config = loadServerConfig({
    TELEMETRY_API_BASE_URL: 'http://telemetry.internal',
    RADIUS_STALE_SECONDS: '240',
  })
  assert.equal(config.radius.staleSeconds, 240)
  for (const value of ['0', '-1', '1.5', '86401', 'nope']) {
    assert.throws(
      () => loadServerConfig({
        TELEMETRY_API_BASE_URL: 'http://telemetry.internal',
        RADIUS_STALE_SECONDS: value,
      }),
      /RADIUS_STALE_SECONDS must be an integer/,
    )
  }
})

test('partial Radius configuration is rejected rather than silently using defaults', () => {
  assert.throws(
    () =>
      loadServerConfig({
        TELEMETRY_API_BASE_URL: 'http://telemetry.internal',
        RADIUS_DB_HOST: '127.0.0.1',
      }),
    /complete or entirely absent/,
  )
})

test('invalid fixed-offset or unknown plant timezone is rejected', () => {
  assert.throws(
    () =>
      loadServerConfig({
        TELEMETRY_API_BASE_URL: 'http://telemetry.internal',
        PLANT_TIME_ZONE: 'Central Standard Time',
      }),
    /valid IANA timezone/,
  )
})

test('configuration rejects unsafe or invalid telemetry settings', () => {
  assert.throws(
    () =>
      loadServerConfig({
        TELEMETRY_API_BASE_URL: 'postgresql://telemetry.internal:5432/database',
      }),
    /http or https/,
  )
  assert.throws(
    () =>
      loadServerConfig({
        TELEMETRY_API_BASE_URL: 'http://telemetry.internal',
        TELEMETRY_API_TIMEOUT_MS: '0',
      }),
    /between 100 and 60000/,
  )
})

test('configuration accepts an explicit localhost-only production binding', () => {
  const config = loadServerConfig({
    TELEMETRY_API_BASE_URL: 'http://telemetry.internal',
    HOST: '127.0.0.1',
    PORT: '3100',
  })

  assert.equal(config.host, '127.0.0.1')
  assert.equal(config.port, 3100)
})

test('configuration rejects malformed host values', () => {
  assert.throws(
    () =>
      loadServerConfig({
        TELEMETRY_API_BASE_URL: 'http://telemetry.internal',
        HOST: 'http://127.0.0.1',
      }),
    /valid hostname or IP address/,
  )
})

test('configuration requires an explicit telemetry URL outside the dev command', () => {
  assert.throws(
    () => loadServerConfig({}),
    /TELEMETRY_API_BASE_URL is required/,
  )
})

test('application writes require the separate processintelligence_db boundary and restricted runtime role', () => {
  const config = loadServerConfig({
    TELEMETRY_API_BASE_URL: 'http://telemetry.internal',
    APP_DB_HOST: '127.0.0.1', APP_DB_PORT: '5432', APP_DB_NAME: 'processintelligence_db',
    APP_DB_USER: 'processintelligence_app', APP_DB_PASSWORD: 'test-only-app-password', APP_DB_SCHEMA: 'process_intelligence',
  })
  assert.equal(config.classificationDatabase.enabled, true)
  assert.throws(() => loadServerConfig({
    TELEMETRY_API_BASE_URL: 'http://telemetry.internal',
    APP_DB_HOST: '127.0.0.1', APP_DB_PORT: '5432', APP_DB_NAME: 'press_radius_db',
    APP_DB_USER: 'processintelligence_readonly', APP_DB_PASSWORD: 'wrong-boundary', APP_DB_SCHEMA: 'public',
  }), /APP_DB_NAME must be processintelligence_db/)
  assert.throws(() => loadServerConfig({ TELEMETRY_API_BASE_URL: 'http://telemetry.internal', APP_DB_HOST: '127.0.0.1' }), /APP_DB_\* configuration must be complete/)
})
