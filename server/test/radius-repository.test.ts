import assert from 'node:assert/strict'
import test from 'node:test'
import type { EnabledRadiusConfig } from '../src/config.js'
import {
  RadiusRepository,
  type RadiusQueryExecutor,
} from '../src/radius/radius-repository.js'

const mappings: EnabledRadiusConfig['mappings'] = [
  [3, 203], [5, 205], [6, 206], [7, 207], [8, 208], [9, 209],
  [10, 210], [11, 211], [12, 212], [13, 213], [14, 214], [15, 215],
].map(([press, machineId]) => ({
  pressKey: `press${press}` as EnabledRadiusConfig['mappings'][number]['pressKey'],
  displayName: `Press ${press}`,
  machineId,
}))

const config: EnabledRadiusConfig = {
  enabled: true,
  host: '127.0.0.1',
  port: 5432,
  database: 'press_radius_db',
  user: 'processintelligence_readonly',
  password: 'test-only-password',
  schema: 'public',
  table: 'machine_status_history',
  currentTable: 'machine_status_current',
  eventsTable: 'machine_status_events',
  pollRunsTable: 'machine_status_poll_runs',
  timestampMode: 'timestamptz',
  effectiveCutoverUtc: '2026-08-10T14:29:00.415Z',
  expectedMachineCount: 12,
  productionEventType: 'G',
  productionStatusDescription: 'Run Production',
  staleSeconds: 180,
  mappings,
}

const expectedColumns = [
  ['machine_status_history', 'machine_id', 'text'],
  ['machine_status_history', 'event_type', 'text'],
  ['machine_status_history', 'status_code', 'text'],
  ['machine_status_history', 'fetched_at', 'timestamp with time zone'],
  ['machine_status_history', 'status_description', 'text'],
  ['machine_status_events', 'machine_id', 'text'],
  ['machine_status_events', 'event_type', 'text'],
  ['machine_status_events', 'status_code', 'text'],
  ['machine_status_events', 'started_at', 'timestamp with time zone'],
  ['machine_status_events', 'status_description', 'text'],
  ['machine_status_poll_runs', 'fetched_at', 'timestamp with time zone'],
  ['machine_status_poll_runs', 'machine_count', 'integer'],
  ['machine_status_poll_runs', 'changed_machine_count', 'integer'],
  ['machine_status_poll_runs', 'stale_machine_count', 'integer'],
  ['machine_status_current', 'machine_id', 'text'],
  ['machine_status_current', 'event_type', 'text'],
  ['machine_status_current', 'status_code', 'text'],
  ['machine_status_current', 'status_description', 'text'],
  ['machine_status_current', 'last_fetched_at', 'timestamp with time zone'],
  ['machine_status_current', 'is_present', 'boolean'],
].map(([tableName, columnName, dataType]) => ({ tableName, columnName, dataType }))

function assertPostgresParameterContract(sql: string, values?: unknown[]) {
  const indexes = [...sql.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]))
  const maximum = Math.max(0, ...indexes)
  assert.equal(values?.length ?? 0, maximum)
  assert.deepEqual(
    [...new Set(indexes)].sort((left, right) => left - right),
    Array.from({ length: maximum }, (_value, index) => index + 1),
  )
}

test('access assessment validates SELECT-only access and all four verified schemas', async () => {
  const executor: RadiusQueryExecutor = {
    query: async (sql) => sql.includes('pg_catalog.pg_roles')
      ? { rows: [{
          databaseMatches: true, canConnect: true, canUseSchema: true,
          canSelect: true, hasWritePrivilege: false,
          hasCreatePrivilege: false, elevatedRole: false,
        }] }
      : { rows: expectedColumns },
  }
  const assessment = await new RadiusRepository(executor, config, 'America/Chicago').assessAccess()
  assert.deepEqual(assessment, {
    databaseMatches: true,
    schemaMatches: true,
    canConnect: true,
    canUseSchema: true,
    canSelect: true,
    hasWritePrivilege: false,
    hasCreatePrivilege: false,
    elevatedRole: false,
  })
})

test('hybrid observation SQL is bounded, read-only, and uses text machine IDs', async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = []
  const executor: RadiusQueryExecutor = {
    query: async (sql, values) => {
      assertPostgresParameterContract(sql, values)
      calls.push({ sql, values })
      return { rows: [] }
    },
  }
  await new RadiusRepository(executor, config, 'America/Chicago').getObservations(
    203,
    '2026-08-10T14:00:00.000Z',
    '2026-08-10T15:00:00.000Z',
    '2026-08-03T14:00:00.000Z',
  )
  assert.equal(calls.length, 4)
  assert.equal(calls.every(({ values }) => values?.[0] === '203'), true)
  assert.match(calls[0].sql, /"public"\."machine_status_history"/)
  assert.match(calls[0].sql, /ORDER BY fetched_at DESC, id DESC LIMIT 1/)
  assert.deepEqual(calls[0].values, [
    '203',
    '2026-08-10T14:00:00.000Z',
    config.effectiveCutoverUtc,
  ])
  assert.match(calls[1].sql, /fetched_at < \$4::timestamptz/)
  assert.match(calls[2].sql, /"public"\."machine_status_events"/)
  assert.match(calls[2].sql, /ORDER BY started_at DESC, id DESC LIMIT 1/)
  assert.deepEqual(calls[2].values, [
    '203',
    '2026-08-10T14:00:00.000Z',
    config.effectiveCutoverUtc,
  ])
  assert.match(calls[3].sql, /started_at >= GREATEST/)
  for (const { sql } of calls) {
    assert.doesNotMatch(sql, /^\s*(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|CREATE|DROP)\b/i)
  }
})

test('a prior compact event supersedes the legacy fallback seed', async () => {
  const executor: RadiusQueryExecutor = {
    query: async (sql) => {
      if (sql.includes('machine_status_events') && sql.includes('DESC')) {
        return { rows: [{
          machineId: '203', eventType: 'G',
          statusDescription: 'Run Production',
          fetchedAtUtc: new Date('2026-08-10T15:00:00.000Z'),
        }] }
      }
      if (sql.includes('machine_status_history') && sql.includes('DESC')) {
        return { rows: [{
          machineId: '203', eventType: 'B', statusDescription: 'Non Productive',
          fetchedAtUtc: new Date('2026-08-10T14:27:52.383Z'),
        }] }
      }
      return { rows: [] }
    },
  }
  const rows = await new RadiusRepository(executor, config, 'America/Chicago').getObservations(
    203,
    '2026-08-10T16:00:00.000Z',
    '2026-08-10T17:00:00.000Z',
    '2026-08-03T16:00:00.000Z',
  )
  assert.equal(rows.length, 1)
  assert.equal(rows[0].statusDescription, 'Run Production')
  assert.equal(rows[0].sourceGeneration, 'compact')
})

test('poll-run queries include one bounded seed plus the requested compact window', async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = []
  const executor: RadiusQueryExecutor = {
    query: async (sql, values) => {
      assertPostgresParameterContract(sql, values)
      calls.push({ sql, values })
      return { rows: [] }
    },
  }
  await new RadiusRepository(executor, config, 'America/Chicago').getPollRuns(
    '2026-08-10T16:00:00.000Z',
    '2026-08-10T17:00:00.000Z',
  )
  assert.equal(calls.length, 2)
  assert.match(calls[0].sql, /ORDER BY fetched_at DESC, id DESC LIMIT 1/)
  assert.deepEqual(calls[0].values, [
    '2026-08-10T16:00:00.000Z',
    config.effectiveCutoverUtc,
  ])
  assert.match(calls[1].sql, /fetched_at >= GREATEST/)
  assert.equal(calls.every(({ sql }) => sql.includes('machine_status_poll_runs')), true)
})

test('current-state lookup omits raw payload and maps the verified text ID', async () => {
  const calls: string[] = []
  const executor: RadiusQueryExecutor = {
    query: async (sql) => {
      calls.push(sql)
      return { rows: [{
        machineId: '213', eventType: 'G', statusDescription: 'Run Production',
        fetchedAtUtc: new Date('2026-08-11T02:00:00.000Z'), isPresent: true,
      }] }
    },
  }
  const rows = await new RadiusRepository(executor, config, 'America/Chicago').getCurrentStates([213])
  assert.equal(rows[0].machineId, 213)
  assert.equal(rows[0].isPresent, true)
  assert.equal(rows[0].sourceGeneration, 'current')
  assert.doesNotMatch(calls[0], /raw_payload/i)
  assert.match(calls[0], /machine_id = ANY\(\$1::text\[\]\)/)
  assert.match(calls[0], /status_code AS "statusCode"/)
})

test('observed identity catalog is read-only and null-safe across legacy and compact Radius tables', async () => {
  let sql = ''
  const executor: RadiusQueryExecutor = { query: async (text) => {
    sql = text
    return { rows: [{ eventType: 'H', statusCode: null, statusDescription: '', eventCount: 4, lastSeenUtc: new Date('2026-08-10T14:27:52.383Z') }] }
  } }
  const rows = await new RadiusRepository(executor, config, 'America/Chicago').getObservedIdentities()
  assert.equal(rows[0].identity, `H\u001f\u001f`)
  assert.equal(rows[0].eventCount, 4)
  assert.match(sql, /machine_status_history/)
  assert.match(sql, /machine_status_events/)
  assert.match(sql, /coalesce\(event_type, ''\)/)
  assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)\b/i)
})
