import type { EnabledRadiusConfig } from '../config.js'
import type {
  RadiusCurrentState,
  RadiusObservation,
  RadiusPollRun,
} from './models.js'
import type { ObservedRadiusIdentity } from '../classification/models.js'
import { exactRadiusIdentity } from './radius-identity.js'

export interface RadiusQueryExecutor {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>> }>
}

export interface RadiusAccessAssessment {
  databaseMatches: boolean
  schemaMatches: boolean
  canConnect: boolean
  canUseSchema: boolean
  canSelect: boolean
  hasWritePrivilege: boolean
  hasCreatePrivilege: boolean
  elevatedRole: boolean
}

export interface RadiusExactIdentity {
  eventType: string
  statusCode: string | null
  statusDescription: string
}

export interface RadiusIdentityHistoryOccurrence extends RadiusExactIdentity {
  startUtc: string
  endUtc: string
  durationSeconds: number
  previousIdentity: RadiusExactIdentity | null
  nextIdentity: RadiusExactIdentity | null
}

export interface RadiusIdentityHistoryResult {
  occurrences: RadiusIdentityHistoryOccurrence[]
  rowsConsidered: number
  matchingOccurrencesAvailable: number
  queryCount: number
  sliceCount: number
  examinedFromUtc: string
  examinedToUtc: string
  historyComplete: boolean
  historyPartialReason: 'QUERY_TIMEOUT' | null
}

interface RadiusIdentityHistoryState extends RadiusExactIdentity {
  atUtc: string
}

const HISTORY_SLICE_MS = 2 * 24 * 60 * 60_000
const HISTORY_MAXIMUM_LOOKBACK_MS = 31 * 24 * 60 * 60_000

const EXPECTED_COLUMNS: Record<string, Record<string, string>> = {
  machine_status_history: {
    machine_id: 'text',
    event_type: 'text',
    status_code: 'text',
    fetched_at: 'timestamp with time zone',
    status_description: 'text',
  },
  machine_status_events: {
    machine_id: 'text',
    event_type: 'text',
    status_code: 'text',
    started_at: 'timestamp with time zone',
    status_description: 'text',
  },
  machine_status_poll_runs: {
    fetched_at: 'timestamp with time zone',
    machine_count: 'integer',
    changed_machine_count: 'integer',
    stale_machine_count: 'integer',
  },
  machine_status_current: {
    machine_id: 'text',
    event_type: 'text',
    status_code: 'text',
    status_description: 'text',
    last_fetched_at: 'timestamp with time zone',
    is_present: 'boolean',
  },
}

function quoteIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error('Unsafe PostgreSQL identifier')
  }
  return `"${value}"`
}

function toUtc(value: unknown, field: string): string {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString()
  }
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) {
    return new Date(value).toISOString()
  }
  throw new Error(`Radius returned an invalid ${field} value`)
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Radius returned an invalid ${field} value`)
  }
  return parsed
}

function nullableText(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value
  throw new Error(`Radius returned an invalid ${field} value`)
}

function mapObservation(
  row: Record<string, unknown>,
  sourceGeneration: RadiusObservation['sourceGeneration'],
): RadiusObservation | null {
  const machineId = positiveInteger(row.machineId, 'machine_id')
  if (machineId <= 0) throw new Error('Radius returned an invalid machine_id')
  if (
    typeof row.eventType !== 'string' ||
    typeof row.statusDescription !== 'string'
  ) {
    return null
  }
  return {
    machineId,
    eventType: row.eventType,
    fetchedAtUtc: toUtc(row.fetchedAtUtc, 'state timestamp'),
    statusCode: nullableText(row.statusCode, 'status_code'),
    statusDescription: row.statusDescription,
    sourceGeneration,
  }
}

function mapObservations(
  rows: Record<string, unknown>[],
  sourceGeneration: RadiusObservation['sourceGeneration'],
): RadiusObservation[] {
  return rows
    .map((row) => mapObservation(row, sourceGeneration))
    .filter((observation): observation is RadiusObservation => observation !== null)
}

function mapPollRun(row: Record<string, unknown>): RadiusPollRun {
  return {
    fetchedAtUtc: toUtc(row.fetchedAtUtc, 'poll fetched_at'),
    machineCount: positiveInteger(row.machineCount, 'machine_count'),
    changedMachineCount: positiveInteger(
      row.changedMachineCount,
      'changed_machine_count',
    ),
    staleMachineCount: positiveInteger(
      row.staleMachineCount,
      'stale_machine_count',
    ),
  }
}

function exactIdentityFromJson(value: unknown): RadiusExactIdentity | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  if (typeof row.eventType !== 'string' || typeof row.statusDescription !== 'string') return null
  return {
    eventType: row.eventType,
    statusCode: nullableText(row.statusCode, 'status_code'),
    statusDescription: row.statusDescription,
  }
}

export class RadiusRepository {
  private readonly legacyTable: string
  private readonly eventsTable: string
  private readonly pollRunsTable: string
  private readonly currentTable: string
  private readonly tablePrivilegeNames: string[]

  constructor(
    private readonly executor: RadiusQueryExecutor,
    private readonly config: EnabledRadiusConfig,
    _plantTimeZone: string,
  ) {
    const schema = quoteIdentifier(config.schema)
    this.legacyTable = `${schema}.${quoteIdentifier(config.table)}`
    this.eventsTable = `${schema}.${quoteIdentifier(config.eventsTable)}`
    this.pollRunsTable = `${schema}.${quoteIdentifier(config.pollRunsTable)}`
    this.currentTable = `${schema}.${quoteIdentifier(config.currentTable)}`
    this.tablePrivilegeNames = [
      config.table,
      config.eventsTable,
      config.pollRunsTable,
      config.currentTable,
    ].map((table) => `${config.schema}.${table}`)
  }

  async assessAccess(): Promise<RadiusAccessAssessment> {
    const expectedColumnNames = Object.values(EXPECTED_COLUMNS).flatMap(
      (columns) => Object.keys(columns),
    )
    const [privilegeResult, columnResult] = await Promise.all([
      this.executor.query(
        `SELECT
           current_database() = $1 AS "databaseMatches",
           has_database_privilege(current_user, $1, 'CONNECT') AS "canConnect",
           has_schema_privilege(current_user, $2, 'USAGE') AS "canUseSchema",
           (SELECT bool_and(has_table_privilege(current_user, table_name, 'SELECT'))
              FROM unnest($3::text[]) AS table_name) AS "canSelect",
           (SELECT bool_or(
                has_table_privilege(current_user, table_name, 'INSERT')
                OR has_table_privilege(current_user, table_name, 'UPDATE')
                OR has_table_privilege(current_user, table_name, 'DELETE')
                OR has_table_privilege(current_user, table_name, 'TRUNCATE')
              ) FROM unnest($3::text[]) AS table_name) AS "hasWritePrivilege",
           EXISTS (
             SELECT 1 FROM pg_catalog.pg_namespace AS namespace
             WHERE namespace.nspname NOT LIKE 'pg_temp_%'
               AND has_schema_privilege(current_user, namespace.oid, 'CREATE')
           ) AS "hasCreatePrivilege",
           role.rolsuper OR role.rolcreatedb OR role.rolcreaterole
             OR role.rolreplication OR role.rolbypassrls
             OR EXISTS (
               SELECT 1 FROM pg_catalog.pg_auth_members AS membership
               WHERE membership.member = role.oid
             ) AS "elevatedRole"
         FROM pg_catalog.pg_roles AS role
         WHERE role.rolname = current_user`,
        [this.config.database, this.config.schema, this.tablePrivilegeNames],
      ),
      this.executor.query(
        `SELECT table_name AS "tableName", column_name AS "columnName",
                data_type AS "dataType"
         FROM information_schema.columns
         WHERE table_schema = $1
           AND table_name = ANY($2::text[])
           AND column_name = ANY($3::text[])
         ORDER BY table_name, ordinal_position`,
        [
          this.config.schema,
          Object.keys(EXPECTED_COLUMNS),
          [...new Set(expectedColumnNames)],
        ],
      ),
    ])

    const privilege = privilegeResult.rows[0] ?? {}
    const columns = new Map(
      columnResult.rows.map((row) => [
        `${String(row.tableName)}.${String(row.columnName)}`,
        String(row.dataType),
      ]),
    )
    const schemaMatches = Object.entries(EXPECTED_COLUMNS).every(
      ([table, expected]) =>
        Object.entries(expected).every(
          ([column, type]) => columns.get(`${table}.${column}`) === type,
        ),
    )

    return {
      databaseMatches: privilege.databaseMatches === true,
      schemaMatches,
      canConnect: privilege.canConnect === true,
      canUseSchema: privilege.canUseSchema === true,
      canSelect: privilege.canSelect === true,
      hasWritePrivilege: privilege.hasWritePrivilege === true,
      hasCreatePrivilege: privilege.hasCreatePrivilege === true,
      elevatedRole: privilege.elevatedRole === true,
    }
  }

  async getObservations(
    machineId: number,
    fromUtc: string,
    toUtc: string,
    _seedLookbackFromUtc: string,
  ): Promise<RadiusObservation[]> {
    const windowValues = [
      String(machineId),
      fromUtc,
      toUtc,
      this.config.effectiveCutoverUtc,
    ]
    const legacyWindowValues = [
      ...windowValues,
      Math.max(1, Math.floor(this.config.staleSeconds / 2)),
    ]
    const legacyColumns = `machine_id AS "machineId", event_type AS "eventType",
      status_code AS "statusCode", fetched_at AS "fetchedAtUtc",
      status_description AS "statusDescription"`
    const eventColumns = `machine_id AS "machineId", event_type AS "eventType",
      status_code AS "statusCode", started_at AS "fetchedAtUtc",
      status_description AS "statusDescription"`
    const [legacySeed, legacyWindow, eventSeed, eventWindow] = await Promise.all([
      this.executor.query(
        `SELECT ${legacyColumns} FROM ${this.legacyTable}
         WHERE machine_id = $1
           AND fetched_at < LEAST($2::timestamptz, $3::timestamptz)
         ORDER BY fetched_at DESC, id DESC LIMIT 1`,
        [String(machineId), fromUtc, this.config.effectiveCutoverUtc],
      ),
      this.executor.query(
        `WITH legacy_observed AS (
           SELECT ${legacyColumns},
                  concat_ws(E'\\x1f', coalesce(event_type, ''), coalesce(status_code, ''), coalesce(status_description, '')) AS "identityKey",
                  lag(concat_ws(E'\\x1f', coalesce(event_type, ''), coalesce(status_code, ''), coalesce(status_description, '')))
                    OVER (PARTITION BY machine_id ORDER BY fetched_at, id) AS "previousIdentityKey",
                  row_number() OVER (
                    PARTITION BY machine_id, floor(extract(epoch FROM fetched_at) / $5::double precision)
                    ORDER BY fetched_at DESC, id DESC
                  ) AS "heartbeatRank"
           FROM ${this.legacyTable}
           WHERE machine_id = $1
             AND fetched_at >= $2::timestamptz
             AND fetched_at < $3::timestamptz
             AND fetched_at < $4::timestamptz
         )
         SELECT "machineId", "eventType", "statusCode", "fetchedAtUtc", "statusDescription"
         FROM legacy_observed
         WHERE "heartbeatRank" = 1 OR "previousIdentityKey" IS DISTINCT FROM "identityKey"
         ORDER BY "fetchedAtUtc" ASC`,
        legacyWindowValues,
      ),
      this.executor.query(
        `SELECT ${eventColumns} FROM ${this.eventsTable}
         WHERE machine_id = $1
           AND started_at >= $3::timestamptz
           AND started_at < $2::timestamptz
         ORDER BY started_at DESC, id DESC LIMIT 1`,
        [String(machineId), fromUtc, this.config.effectiveCutoverUtc],
      ),
      this.executor.query(
        `SELECT ${eventColumns} FROM ${this.eventsTable}
         WHERE machine_id = $1
           AND started_at >= GREATEST($2::timestamptz, $4::timestamptz)
           AND started_at < $3::timestamptz
         ORDER BY started_at ASC, id ASC`,
        windowValues,
      ),
    ])
    const compactSeedRows = mapObservations(eventSeed.rows, 'compact')
    const seedRows = compactSeedRows.length > 0
      ? compactSeedRows
      : mapObservations(legacySeed.rows, 'legacy')
    return [
      ...seedRows,
      ...mapObservations(legacyWindow.rows, 'legacy'),
      ...mapObservations(eventWindow.rows, 'compact'),
    ]
      .sort(
        (left, right) =>
          Date.parse(left.fetchedAtUtc) - Date.parse(right.fetchedAtUtc),
      )
  }

  async getObservationsForMachines(
    machineIds: number[],
    fromUtc: string,
    toUtc: string,
  ): Promise<Map<number, RadiusObservation[]>> {
    const result = new Map(machineIds.map((machineId) => [machineId, [] as RadiusObservation[]]))
    if (machineIds.length === 0) return result
    const machineIdValues = machineIds.map(String)
    const values = [
      machineIdValues,
      fromUtc,
      toUtc,
      this.config.effectiveCutoverUtc,
    ]
    const legacyWindowValues = [
      ...values,
      Math.max(1, Math.floor(this.config.staleSeconds / 2)),
    ]
    const seedValues = [machineIdValues, fromUtc, this.config.effectiveCutoverUtc]
    const legacyColumns = `source.machine_id AS "machineId", source.event_type AS "eventType",
      source.status_code AS "statusCode", source.fetched_at AS "fetchedAtUtc",
      source.status_description AS "statusDescription"`
    const eventColumns = `source.machine_id AS "machineId", source.event_type AS "eventType",
      source.status_code AS "statusCode", source.started_at AS "fetchedAtUtc",
      source.status_description AS "statusDescription"`
    const [legacySeeds, legacyWindow, eventSeeds, eventWindow] = await Promise.all([
      this.executor.query(
        `SELECT seed.*
         FROM unnest($1::text[]) AS requested(machine_id)
         CROSS JOIN LATERAL (
           SELECT ${legacyColumns} FROM ${this.legacyTable} AS source
           WHERE source.machine_id = requested.machine_id
             AND source.fetched_at < LEAST($2::timestamptz, $3::timestamptz)
           ORDER BY source.fetched_at DESC, source.id DESC LIMIT 1
         ) AS seed
         ORDER BY seed."machineId"`,
        seedValues,
      ),
      this.executor.query(
        `WITH legacy_observed AS (
           SELECT source.machine_id AS "machineId", source.event_type AS "eventType",
                  source.status_code AS "statusCode", source.fetched_at AS "fetchedAtUtc",
                  source.status_description AS "statusDescription",
                  concat_ws(E'\\x1f', coalesce(source.event_type, ''), coalesce(source.status_code, ''), coalesce(source.status_description, '')) AS "identityKey",
                  lag(concat_ws(E'\\x1f', coalesce(source.event_type, ''), coalesce(source.status_code, ''), coalesce(source.status_description, '')))
                    OVER (PARTITION BY source.machine_id ORDER BY source.fetched_at, source.id) AS "previousIdentityKey",
                  row_number() OVER (
                    PARTITION BY source.machine_id, floor(extract(epoch FROM source.fetched_at) / $5::double precision)
                    ORDER BY source.fetched_at DESC, source.id DESC
                  ) AS "heartbeatRank"
           FROM ${this.legacyTable} AS source
           WHERE source.machine_id = ANY($1::text[])
             AND source.fetched_at >= $2::timestamptz
             AND source.fetched_at < $3::timestamptz
             AND source.fetched_at < $4::timestamptz
         )
         SELECT "machineId", "eventType", "statusCode", "fetchedAtUtc", "statusDescription"
         FROM legacy_observed
         WHERE "heartbeatRank" = 1 OR "previousIdentityKey" IS DISTINCT FROM "identityKey"
         ORDER BY "machineId", "fetchedAtUtc"`,
        legacyWindowValues,
      ),
      this.executor.query(
        `SELECT seed.*
         FROM unnest($1::text[]) AS requested(machine_id)
         CROSS JOIN LATERAL (
           SELECT ${eventColumns} FROM ${this.eventsTable} AS source
           WHERE source.machine_id = requested.machine_id
             AND source.started_at >= $3::timestamptz
             AND source.started_at < $2::timestamptz
           ORDER BY source.started_at DESC, source.id DESC LIMIT 1
         ) AS seed
         ORDER BY seed."machineId"`,
        seedValues,
      ),
      this.executor.query(
        `SELECT observed.*
         FROM unnest($1::text[]) AS requested(machine_id)
         CROSS JOIN LATERAL (
           SELECT ${eventColumns} FROM ${this.eventsTable} AS source
           WHERE source.machine_id = requested.machine_id
             AND source.started_at >= GREATEST($2::timestamptz, $4::timestamptz)
             AND source.started_at < $3::timestamptz
           ORDER BY source.started_at ASC, source.id ASC
         ) AS observed
         ORDER BY observed."machineId", observed."fetchedAtUtc"`,
        values,
      ),
    ])
    const compactSeeds = mapObservations(eventSeeds.rows, 'compact')
    const eventSeedMachines = new Set(compactSeeds.map(({ machineId }) => machineId))
    const rows = [
      ...mapObservations(legacySeeds.rows, 'legacy').filter(({ machineId }) => !eventSeedMachines.has(machineId)),
      ...compactSeeds,
      ...mapObservations(legacyWindow.rows, 'legacy'),
      ...mapObservations(eventWindow.rows, 'compact'),
    ]
    for (const observation of rows) result.get(observation.machineId)?.push(observation)
    for (const observations of result.values()) observations.sort((left, right) => Date.parse(left.fetchedAtUtc) - Date.parse(right.fetchedAtUtc))
    return result
  }

  async getExactIdentityHistory(input: {
    machineId: number
    fromUtc: string
    toUtc: string
    identity: RadiusExactIdentity
    maximumOccurrences: number
  }): Promise<RadiusIdentityHistoryResult> {
    const maximumOccurrences = Math.min(100, Math.max(1, Math.floor(input.maximumOccurrences)))
    const requestedToMs = Date.parse(input.toUtc)
    const requestedFromMs = Math.max(Date.parse(input.fromUtc), requestedToMs - HISTORY_MAXIMUM_LOOKBACK_MS)
    const cutoverMs = Date.parse(this.config.effectiveCutoverUtc)
    if (!Number.isFinite(requestedFromMs) || !Number.isFinite(requestedToMs) || requestedFromMs >= requestedToMs) throw new Error('Invalid Radius identity history range')

    const states: RadiusIdentityHistoryState[] = []
    let rowsConsidered = 0
    let queryCount = 0
    let cursorMs = requestedToMs
    let examinedFromMs = requestedToMs
    let historyPartialReason: RadiusIdentityHistoryResult['historyPartialReason'] = null

    const sameIdentity = (left: RadiusExactIdentity, right: RadiusExactIdentity) => left.eventType === right.eventType && left.statusCode === right.statusCode && left.statusDescription === right.statusDescription
    const collapsedStates = () => {
      const ordered = [...states].sort((left, right) => Date.parse(left.atUtc) - Date.parse(right.atUtc))
      const collapsed: RadiusIdentityHistoryState[] = []
      for (const state of ordered) {
        const previous = collapsed.at(-1)
        if (previous && sameIdentity(previous, state)) continue
        collapsed.push(state)
      }
      return collapsed
    }
    const matchingCount = () => collapsedStates().filter((state) => {
      const atMs = Date.parse(state.atUtc)
      return atMs >= examinedFromMs && atMs < requestedToMs && sameIdentity(state, input.identity)
    }).length

    while (cursorMs > requestedFromMs && matchingCount() < maximumOccurrences) {
      const compact = cursorMs > cutoverMs
      const sourceBoundaryMs = compact ? cutoverMs : requestedFromMs
      const sliceFromMs = Math.max(requestedFromMs, sourceBoundaryMs, cursorMs - HISTORY_SLICE_MS)
      const sliceFromUtc = new Date(sliceFromMs).toISOString()
      const sliceToUtc = new Date(cursorMs).toISOString()
      const sourceTable = compact ? this.eventsTable : this.legacyTable
      const timestampColumn = compact ? 'started_at' : 'fetched_at'
      const sourceFloor = compact ? `AND ${timestampColumn} >= $4::timestamptz` : `AND ${timestampColumn} < $4::timestamptz`
      const collapseSql = compact
        ? 'SELECT * FROM source_rows'
        : `SELECT * FROM source_ordered
           WHERE "atUtc" < $2::timestamptz
              OR ROW("eventType", "statusCode", "statusDescription")
                 IS DISTINCT FROM ROW("collapsePreviousEventType", "collapsePreviousStatusCode", "collapsePreviousStatusDescription")`
      try {
        queryCount += 1
        const result = await this.executor.query(
          `WITH seed AS (
             SELECT id AS "sourceId", event_type AS "eventType", status_code AS "statusCode",
                    status_description AS "statusDescription", ${timestampColumn} AS "atUtc"
             FROM ${sourceTable}
             WHERE machine_id = $1 AND ${timestampColumn} < $2::timestamptz ${sourceFloor}
             ORDER BY ${timestampColumn} DESC, id DESC LIMIT 1
           ), window_rows AS (
             SELECT id AS "sourceId", event_type AS "eventType", status_code AS "statusCode",
                    status_description AS "statusDescription", ${timestampColumn} AS "atUtc"
             FROM ${sourceTable}
             WHERE machine_id = $1 AND ${timestampColumn} >= $2::timestamptz
               AND ${timestampColumn} < $3::timestamptz ${sourceFloor}
           ), source_rows AS (
             SELECT * FROM seed UNION ALL SELECT * FROM window_rows
           ), source_ordered AS (
             SELECT source_rows.*,
                    lag("eventType") OVER (ORDER BY "atUtc", "sourceId") AS "collapsePreviousEventType",
                    lag("statusCode") OVER (ORDER BY "atUtc", "sourceId") AS "collapsePreviousStatusCode",
                    lag("statusDescription") OVER (ORDER BY "atUtc", "sourceId") AS "collapsePreviousStatusDescription"
             FROM source_rows
           ), slice_states AS (${collapseSql}), annotated_states AS (
             SELECT "sourceId", "eventType", "statusCode", "statusDescription", "atUtc",
                    row_number() OVER (ORDER BY "atUtc", "sourceId") AS "stateOrder",
                    lag("eventType") OVER (ORDER BY "atUtc", "sourceId") AS "previousEventType",
                    lag("statusCode") OVER (ORDER BY "atUtc", "sourceId") AS "previousStatusCode",
                    lag("statusDescription") OVER (ORDER BY "atUtc", "sourceId") AS "previousStatusDescription",
                    lead("eventType") OVER (ORDER BY "atUtc", "sourceId") AS "nextEventType",
                    lead("statusCode") OVER (ORDER BY "atUtc", "sourceId") AS "nextStatusCode",
                    lead("statusDescription") OVER (ORDER BY "atUtc", "sourceId") AS "nextStatusDescription"
             FROM slice_states
           ), relevant_states AS (
             SELECT "sourceId", "eventType", "statusCode", "statusDescription", "atUtc"
             FROM annotated_states
             WHERE "stateOrder" = 1
                OR ROW("eventType", "statusCode", "statusDescription") IS NOT DISTINCT FROM ROW($5::text, $6::text, $7::text)
                OR ROW("previousEventType", "previousStatusCode", "previousStatusDescription") IS NOT DISTINCT FROM ROW($5::text, $6::text, $7::text)
                OR ROW("nextEventType", "nextStatusCode", "nextStatusDescription") IS NOT DISTINCT FROM ROW($5::text, $6::text, $7::text)
           )
           SELECT (SELECT count(*)::integer FROM window_rows) AS "rowsConsidered",
                  coalesce((SELECT jsonb_agg(jsonb_build_object(
                    'eventType', "eventType", 'statusCode', "statusCode",
                    'statusDescription', "statusDescription", 'atUtc', "atUtc"
                  ) ORDER BY "atUtc", "sourceId") FROM relevant_states), '[]'::jsonb) AS "states"`,
          [String(input.machineId), sliceFromUtc, sliceToUtc, this.config.effectiveCutoverUtc, input.identity.eventType, input.identity.statusCode, input.identity.statusDescription],
        )
        const row = result.rows[0] ?? {}
        rowsConsidered += positiveInteger(row.rowsConsidered ?? 0, 'history rows considered')
        const rawStates = Array.isArray(row.states) ? row.states : typeof row.states === 'string' ? JSON.parse(row.states) as unknown[] : []
        for (const value of rawStates) {
          const identity = exactIdentityFromJson(value)
          if (!identity || !value || typeof value !== 'object' || Array.isArray(value)) continue
          states.push({ ...identity, atUtc: toUtc((value as Record<string, unknown>).atUtc, 'history state timestamp') })
        }
        examinedFromMs = sliceFromMs
        cursorMs = sliceFromMs
      } catch (error) {
        if (examinedFromMs === requestedToMs || !/statement timeout|canceling statement due to statement timeout/i.test(error instanceof Error ? error.message : String(error))) throw error
        historyPartialReason = 'QUERY_TIMEOUT'
        break
      }
    }

    const orderedStates = collapsedStates()
    const matchingIndexes = orderedStates.flatMap((state, index) => {
      const atMs = Date.parse(state.atUtc)
      return atMs >= examinedFromMs && atMs < requestedToMs && sameIdentity(state, input.identity) ? [index] : []
    })
    const selectedIndexes = matchingIndexes.slice(-maximumOccurrences)
    const occurrences = selectedIndexes.map((index): RadiusIdentityHistoryOccurrence => {
      const state = orderedStates[index]!
      const previous = orderedStates[index - 1] ?? null
      const next = orderedStates[index + 1] ?? null
      const endUtc = next && Date.parse(next.atUtc) < requestedToMs ? next.atUtc : new Date(requestedToMs).toISOString()
      return {
        eventType: state.eventType,
        statusCode: state.statusCode,
        statusDescription: state.statusDescription,
        startUtc: state.atUtc,
        endUtc,
        durationSeconds: Math.max(0, (Date.parse(endUtc) - Date.parse(state.atUtc)) / 1_000),
        previousIdentity: previous ? { eventType: previous.eventType, statusCode: previous.statusCode, statusDescription: previous.statusDescription } : null,
        nextIdentity: next ? { eventType: next.eventType, statusCode: next.statusCode, statusDescription: next.statusDescription } : null,
      }
    })
    return {
      occurrences,
      rowsConsidered,
      matchingOccurrencesAvailable: matchingIndexes.length,
      queryCount,
      sliceCount: queryCount,
      examinedFromUtc: new Date(examinedFromMs).toISOString(),
      examinedToUtc: new Date(requestedToMs).toISOString(),
      historyComplete: historyPartialReason === null,
      historyPartialReason,
    }
  }

  async getPollRuns(fromUtc: string, toUtc: string): Promise<RadiusPollRun[]> {
    const windowValues = [fromUtc, toUtc, this.config.effectiveCutoverUtc]
    const columns = `fetched_at AS "fetchedAtUtc",
      machine_count AS "machineCount",
      changed_machine_count AS "changedMachineCount",
      stale_machine_count AS "staleMachineCount"`
    const [seed, window] = await Promise.all([
      this.executor.query(
        `SELECT ${columns} FROM ${this.pollRunsTable}
         WHERE fetched_at >= $2::timestamptz
           AND fetched_at < $1::timestamptz
         ORDER BY fetched_at DESC, id DESC LIMIT 1`,
        [fromUtc, this.config.effectiveCutoverUtc],
      ),
      this.executor.query(
        `SELECT ${columns} FROM ${this.pollRunsTable}
         WHERE fetched_at >= GREATEST($1::timestamptz, $3::timestamptz)
           AND fetched_at < $2::timestamptz
         ORDER BY fetched_at ASC, id ASC`,
        windowValues,
      ),
    ])
    return [...seed.rows, ...window.rows].map(mapPollRun)
  }

  async getCurrentStates(machineIds: number[]): Promise<RadiusCurrentState[]> {
    if (machineIds.length === 0) return []
    const result = await this.executor.query(
      `SELECT machine_id AS "machineId", event_type AS "eventType",
              status_code AS "statusCode", status_description AS "statusDescription",
              last_fetched_at AS "fetchedAtUtc", is_present AS "isPresent"
       FROM ${this.currentTable}
       WHERE machine_id = ANY($1::text[])
       ORDER BY machine_id ASC`,
      [machineIds.map(String)],
    )
    return result.rows.flatMap((row) => {
      const observation = mapObservation(row, 'current')
      return observation ? [{ ...observation, isPresent: row.isPresent === true }] : []
    })
  }

  async getObservedIdentities(): Promise<ObservedRadiusIdentity[]> {
    const result = await this.executor.query(
      `WITH legacy_ordered AS (
         SELECT coalesce(event_type, '') AS event_type, nullif(status_code, '') AS status_code, coalesce(status_description, '') AS status_description,
                fetched_at, concat_ws(E'\\x1f', coalesce(event_type, ''), coalesce(status_code, ''), coalesce(status_description, '')) AS identity_key,
                lag(concat_ws(E'\\x1f', coalesce(event_type, ''), coalesce(status_code, ''), coalesce(status_description, ''))) OVER (PARTITION BY machine_id ORDER BY fetched_at, id) AS previous_identity_key
         FROM ${this.legacyTable}
       )
       SELECT event_type AS "eventType", status_code AS "statusCode", status_description AS "statusDescription",
              sum("eventCount")::integer AS "eventCount", max("lastSeenUtc") AS "lastSeenUtc"
       FROM (
         SELECT event_type, status_code, status_description,
                count(*) FILTER (WHERE previous_identity_key IS DISTINCT FROM identity_key)::integer AS "eventCount", max(fetched_at) AS "lastSeenUtc"
         FROM legacy_ordered
         GROUP BY event_type, status_code, status_description
         UNION ALL
         SELECT coalesce(event_type, '') AS event_type, nullif(status_code, '') AS status_code, coalesce(status_description, '') AS status_description,
                count(*)::integer AS "eventCount", max(coalesce(ended_at, last_observed_at, started_at)) AS "lastSeenUtc"
         FROM ${this.eventsTable}
         GROUP BY coalesce(event_type, ''), nullif(status_code, ''), coalesce(status_description, '')
       ) observed
       GROUP BY event_type, status_code, status_description
       ORDER BY event_type, status_code NULLS FIRST, status_description`,
    )
    return result.rows.map((row) => {
      const identity = { eventType: String(row.eventType ?? ''), statusCode: row.statusCode === null || row.statusCode === undefined ? null : String(row.statusCode), statusDescription: String(row.statusDescription ?? '') }
      return { ...identity, identity: exactRadiusIdentity(identity), eventCount: Number(row.eventCount ?? 0), lastSeenUtc: row.lastSeenUtc ? new Date(String(row.lastSeenUtc)).toISOString() : null }
    })
  }
}
