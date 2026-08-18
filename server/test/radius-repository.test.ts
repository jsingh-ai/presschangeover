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
  assert.match(calls[1].sql, /"heartbeatRank" = 1/)
  assert.match(calls[1].sql, /"previousIdentityKey" IS DISTINCT FROM "identityKey"/)
  assert.equal(calls[1].values?.[4], 90)
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

test('fleet Overview loads hybrid observations in four set-based read-only queries without N+1 access', async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = []
  const executor: RadiusQueryExecutor = {
    query: async (sql, values) => {
      assertPostgresParameterContract(sql, values)
      calls.push({ sql, values })
      if (sql.includes('machine_status_events') && sql.includes('AS seed')) return { rows: [{ machineId: '203', eventType: 'G', statusCode: '150', statusDescription: 'Run Production', fetchedAtUtc: new Date('2026-08-10T14:30:00.000Z') }] }
      if (sql.includes('machine_status_history') && sql.includes('AS seed')) return { rows: [
        { machineId: '203', eventType: 'M', statusCode: '16', statusDescription: 'Make Ready', fetchedAtUtc: new Date('2026-08-10T14:28:00.000Z') },
        { machineId: '205', eventType: 'B', statusCode: '99', statusDescription: 'Plates: Wash', fetchedAtUtc: new Date('2026-08-10T14:28:00.000Z') },
      ] }
      return { rows: [] }
    },
  }
  const result = await new RadiusRepository(executor, config, 'America/Chicago').getObservationsForMachines(
    [203, 205],
    '2026-08-10T15:00:00.000Z',
    '2026-08-10T16:00:00.000Z',
  )
  assert.equal(calls.length, 4)
  assert.equal(calls.every(({ values }) => Array.isArray(values?.[0]) && (values?.[0] as string[]).join(',') === '203,205'), true)
  assert.equal(result.get(203)?.length, 1)
  assert.equal(result.get(203)?.[0].sourceGeneration, 'compact')
  assert.equal(result.get(205)?.[0].sourceGeneration, 'legacy')
  assert.match(calls[1].sql, /machine_id = ANY\(\$1::text\[\]\)/)
  assert.match(calls[1].sql, /"heartbeatRank" = 1/)
  assert.match(calls[1].sql, /"previousIdentityKey" IS DISTINCT FROM "identityKey"/)
  assert.equal(calls[1].values?.[4], 90)
  for (const { sql } of calls) {
    assert.doesNotMatch(sql, /^\s*(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|CREATE|DROP)\b/i)
  }
  for (const index of [0, 2, 3]) {
    assert.match(calls[index].sql, /unnest\(\$1::text\[\]\)/)
    assert.match(calls[index].sql, /CROSS JOIN LATERAL/)
  }
})

test('fleet Overview isolates malformed operational rows and retains a valid legacy seed', async () => {
  const executor: RadiusQueryExecutor = {
    query: async (sql) => {
      if (sql.includes('machine_status_events') && sql.includes('AS seed')) return { rows: [{
        machineId: '203', eventType: null, statusCode: null,
        statusDescription: null, fetchedAtUtc: new Date('2026-08-10T14:30:00.000Z'),
      }] }
      if (sql.includes('machine_status_history') && sql.includes('AS seed')) return { rows: [{
        machineId: '203', eventType: 'M', statusCode: '16',
        statusDescription: 'Make Ready', fetchedAtUtc: new Date('2026-08-10T14:28:00.000Z'),
      }] }
      if (sql.includes('machine_status_history')) return { rows: [{
        machineId: '205', eventType: null, statusCode: null,
        statusDescription: null, fetchedAtUtc: new Date('2026-08-10T14:29:00.000Z'),
      }] }
      return { rows: [] }
    },
  }

  const result = await new RadiusRepository(executor, config, 'America/Chicago').getObservationsForMachines(
    [203, 205],
    '2026-08-10T15:00:00.000Z',
    '2026-08-10T16:00:00.000Z',
  )

  assert.equal(result.get(203)?.length, 1)
  assert.equal(result.get(203)?.[0].sourceGeneration, 'legacy')
  assert.equal(result.get(203)?.[0].statusDescription, 'Make Ready')
  assert.deepEqual(result.get(205), [])
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
      if (sql.includes('machine_status_history') && sql.includes('DESC LIMIT 1')) {
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

const historyIdentity = { eventType: 'B', statusCode: '400', statusDescription: 'Recorded B state' }
const historyState = (atUtc: string, identity = historyIdentity) => ({ ...identity, atUtc })
const historyInput = (overrides: Partial<Parameters<RadiusRepository['getExactIdentityHistory']>[0]> = {}) => ({
  machineId: 203,
  fromUtc: '2026-07-18T12:00:00.000Z',
  toUtc: '2026-08-18T12:00:00.000Z',
  identity: historyIdentity,
  maximumOccurrences: 100,
  ...overrides,
})

test('exact identity history searches newest-first, stops at 100, isolates status code, and avoids legacy when compact evidence is sufficient', async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = []
  const states = Array.from({ length: 200 }, (_value, index) => historyState(
    new Date(Date.parse('2026-08-16T12:00:00.000Z') + index * 10 * 60_000).toISOString(),
    index % 2 ? { eventType: 'B', statusCode: '401', statusDescription: 'Recorded B state' } : historyIdentity,
  ))
  const executor: RadiusQueryExecutor = { query: async (sql, values) => {
    assertPostgresParameterContract(sql, values); calls.push({ sql, values })
    return { rows: [{ rowsConsidered: states.length, states }] }
  } }
  const result = await new RadiusRepository(executor, config, 'America/Chicago').getExactIdentityHistory(historyInput())
  assert.equal(calls.length, 1); assert.equal(result.queryCount, 1); assert.equal(result.sliceCount, 1)
  assert.equal(result.occurrences.length, 100); assert.ok(result.occurrences.every(({ statusCode }) => statusCode === '400'))
  assert.equal(result.examinedFromUtc, '2026-08-16T12:00:00.000Z'); assert.equal(result.historyComplete, true)
  assert.deepEqual(calls[0].values, ['203', '2026-08-16T12:00:00.000Z', '2026-08-18T12:00:00.000Z', config.effectiveCutoverUtc, 'B', '400', 'Recorded B state'])
  assert.match(calls[0].sql, /machine_status_events/); assert.doesNotMatch(calls[0].sql, /machine_status_history/)
  assert.match(calls[0].sql, /machine_id = \$1/); assert.match(calls[0].sql, /started_at >= \$2::timestamptz/); assert.match(calls[0].sql, /started_at < \$3::timestamptz/)
  assert.match(calls[0].sql, /IS NOT DISTINCT FROM ROW\(\$5::text, \$6::text, \$7::text\)/)
  assert.doesNotMatch(calls[0].sql, /machine_status_poll_runs|machine_status_current|raw_payload|telemetry/i)
  assert.doesNotMatch(calls[0].sql, /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|CREATE|ALTER|DROP|GRANT|REVOKE)\b/i)
})

test('exact identity history stops before 31 days once the requested match limit is reached', async () => {
  let calls = 0
  const executor: RadiusQueryExecutor = { query: async () => {
    calls += 1
    return { rows: [{ rowsConsidered: 5, states: [
      historyState('2026-08-16T13:00:00.000Z'),
      historyState('2026-08-16T13:01:00.000Z', { eventType: 'G', statusCode: '1', statusDescription: 'Run' }),
      historyState('2026-08-17T13:00:00.000Z'),
    ] }] }
  } }
  const result = await new RadiusRepository(executor, config, 'America/Chicago').getExactIdentityHistory(historyInput({ maximumOccurrences: 2 }))
  assert.equal(calls, 1); assert.equal(result.occurrences.length, 2); assert.equal(result.examinedFromUtc, '2026-08-16T12:00:00.000Z')
})

test('exact identity history clamps exhaustive searching to a maximum of 31 days', async () => {
  const calls: Array<{ values?: unknown[] }> = []
  const executor: RadiusQueryExecutor = { query: async (_sql, values) => { calls.push({ values }); return { rows: [{ rowsConsidered: 0, states: [] }] } } }
  const result = await new RadiusRepository(executor, config, 'America/Chicago').getExactIdentityHistory(historyInput({ fromUtc: '2026-06-01T12:00:00.000Z' }))
  assert.equal(result.examinedFromUtc, '2026-07-18T12:00:00.000Z'); assert.equal(result.examinedToUtc, '2026-08-18T12:00:00.000Z')
  assert.equal(result.historyComplete, true); assert.ok(calls.length > 1); assert.ok(calls.length <= 17)
  assert.ok(calls.every(({ values }) => Date.parse(String(values?.[2])) - Date.parse(String(values?.[1])) <= 2 * 24 * 60 * 60_000))
})

test('exact identity history splits cleanly at cutover and uses compact then legacy slices', async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = []
  const executor: RadiusQueryExecutor = { query: async (sql, values) => { calls.push({ sql, values }); return { rows: [{ rowsConsidered: 0, states: [] }] } } }
  await new RadiusRepository(executor, config, 'America/Chicago').getExactIdentityHistory(historyInput({ fromUtc: '2026-08-08T12:00:00.000Z', toUtc: '2026-08-12T12:00:00.000Z' }))
  assert.match(calls[0]!.sql, /machine_status_events/); assert.ok(calls.slice(1).every(({ sql }) => /machine_status_history/.test(sql)))
  assert.equal(calls[0]!.values?.[1], config.effectiveCutoverUtc); assert.equal(calls[1]!.values?.[2], config.effectiveCutoverUtc)
  assert.ok(calls.every(({ sql }) => !(/machine_status_events/.test(sql) && /machine_status_history/.test(sql))))
})

test('exact identity history deduplicates slice boundaries and preserves previous and next identities', async () => {
  let calls = 0
  const otherBefore = { eventType: 'M', statusCode: '16', statusDescription: 'Make Ready' }
  const otherAfter = { eventType: 'G', statusCode: '1', statusDescription: 'Run' }
  const executor: RadiusQueryExecutor = { query: async () => {
    calls += 1
    return { rows: [{ rowsConsidered: 3, states: calls === 1
      ? [historyState('2026-08-15T23:00:00.000Z'), historyState('2026-08-17T00:00:00.000Z', otherAfter)]
      : [historyState('2026-08-14T00:00:00.000Z', otherBefore), historyState('2026-08-15T23:00:00.000Z')]
    }] }
  } }
  const result = await new RadiusRepository(executor, config, 'America/Chicago').getExactIdentityHistory(historyInput({ fromUtc: '2026-08-14T12:00:00.000Z', maximumOccurrences: 1 }))
  assert.equal(calls, 2); assert.equal(result.occurrences.length, 1)
  assert.equal(result.occurrences[0]?.durationSeconds, 25 * 60 * 60)
  assert.equal(result.occurrences[0]?.previousIdentity?.statusCode, '16'); assert.equal(result.occurrences[0]?.nextIdentity?.statusCode, '1')
})

test('exact identity history returns newer evidence as partial when an older slice times out', async () => {
  let calls = 0
  const executor: RadiusQueryExecutor = { query: async () => {
    calls += 1
    if (calls === 2) throw new Error('canceling statement due to statement timeout')
    return { rows: [{ rowsConsidered: 2, states: [historyState('2026-08-17T00:00:00.000Z')] }] }
  } }
  const result = await new RadiusRepository(executor, config, 'America/Chicago').getExactIdentityHistory(historyInput())
  assert.equal(result.queryCount, 2); assert.equal(result.sliceCount, 2); assert.equal(result.occurrences.length, 1)
  assert.equal(result.historyComplete, false); assert.equal(result.historyPartialReason, 'QUERY_TIMEOUT'); assert.equal(result.examinedFromUtc, '2026-08-16T12:00:00.000Z')
})

test('exact identity history fails explicitly when the newest slice times out', async () => {
  const executor: RadiusQueryExecutor = { query: async () => { throw new Error('canceling statement due to statement timeout') } }
  await assert.rejects(
    new RadiusRepository(executor, config, 'America/Chicago').getExactIdentityHistory(historyInput()),
    /statement timeout/,
  )
})
