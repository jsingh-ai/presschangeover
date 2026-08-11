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
): RadiusObservation {
  const machineId = positiveInteger(row.machineId, 'machine_id')
  if (machineId <= 0) throw new Error('Radius returned an invalid machine_id')
  if (
    typeof row.eventType !== 'string' ||
    typeof row.statusDescription !== 'string'
  ) {
    throw new Error('Radius returned an invalid operational status')
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
        `SELECT ${legacyColumns} FROM ${this.legacyTable}
         WHERE machine_id = $1
           AND fetched_at >= $2::timestamptz
           AND fetched_at < $3::timestamptz
           AND fetched_at < $4::timestamptz
         ORDER BY fetched_at ASC, id ASC`,
        windowValues,
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
    const seedRows = eventSeed.rows.length > 0
      ? eventSeed.rows.map((row) => mapObservation(row, 'compact'))
      : legacySeed.rows.map((row) => mapObservation(row, 'legacy'))
    return [
      ...seedRows,
      ...legacyWindow.rows.map((row) => mapObservation(row, 'legacy')),
      ...eventWindow.rows.map((row) => mapObservation(row, 'compact')),
    ]
      .sort(
        (left, right) =>
          Date.parse(left.fetchedAtUtc) - Date.parse(right.fetchedAtUtc),
      )
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
    return result.rows.map((row) => ({
      ...mapObservation(row, 'current'),
      isPresent: row.isPresent === true,
    }))
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
