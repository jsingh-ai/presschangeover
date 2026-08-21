import pg from 'pg'
import { JOB_INTELLIGENCE_MATERIALIZER_RADIUS_ROLE, type RadiusConfig } from '../config.js'
import { createManagedRadiusService, type RadiusPoolFactory, type RadiusPoolLike } from '../radius/create-radius-service.js'

const { Pool } = pg
export const JOB_INTELLIGENCE_MATERIALIZATION_RADIUS_CONNECTION_CAP = 1

export interface MaterializationSourcePrivilege {
  tableName: string
  select: boolean
  insert: boolean
  update: boolean
  delete: boolean
  truncate: boolean
}

export interface MaterializationSourceSafety {
  role: string
  defaultTransactionReadOnly: 'on'
  privileges: MaterializationSourcePrivilege[]
}

const REQUIRED_RADIUS_TABLES = ['machine_status_history', 'machine_status_events', 'machine_status_poll_runs', 'machine_status_current'] as const
function boolean(value: unknown): boolean { return value === true || value === 't' || value === 'true' }

export async function createMaterializationRadiusService(config: RadiusConfig, plantTimeZone: string, options: { poolFactory?: RadiusPoolFactory } = {}) {
  if (!config.enabled || config.user !== JOB_INTELLIGENCE_MATERIALIZER_RADIUS_ROLE) throw new Error('existing_production_readonly_radius_role_required')
  let pool: RadiusPoolLike | undefined
  const owner = createManagedRadiusService(config, plantTimeZone, {
    maximumConnections: JOB_INTELLIGENCE_MATERIALIZATION_RADIUS_CONNECTION_CAP,
    applicationName: 'ProcessIntelligenceJobMaterializer',
    startupOptions: '-c default_transaction_read_only=on',
    poolFactory: (poolConfig) => {
      pool = options.poolFactory ? options.poolFactory(poolConfig) : new Pool(poolConfig) as unknown as RadiusPoolLike
      return pool
    },
  })
  try {
    const readOnly = await pool!.query('SHOW default_transaction_read_only')
    const readOnlyValue = String(readOnly.rows[0]?.default_transaction_read_only ?? '').toLocaleLowerCase()
    if (readOnlyValue !== 'on') throw new Error('materializer_radius_session_not_read_only')
    const privilegeResult = await pool!.query(
      `SELECT current_user AS role, table_name AS "tableName",
              has_table_privilege(current_user, format('public.%I', table_name), 'SELECT') AS "select",
              has_table_privilege(current_user, format('public.%I', table_name), 'INSERT') AS "insert",
              has_table_privilege(current_user, format('public.%I', table_name), 'UPDATE') AS "update",
              has_table_privilege(current_user, format('public.%I', table_name), 'DELETE') AS "delete",
              has_table_privilege(current_user, format('public.%I', table_name), 'TRUNCATE') AS "truncate"
         FROM unnest($1::text[]) AS source_table(table_name) ORDER BY table_name`,
      [[...REQUIRED_RADIUS_TABLES]],
    )
    const privileges = privilegeResult.rows.map((row) => ({ tableName: String(row.tableName), select: boolean(row.select), insert: boolean(row.insert), update: boolean(row.update), delete: boolean(row.delete), truncate: boolean(row.truncate) }))
    if (String(privilegeResult.rows[0]?.role ?? '') !== JOB_INTELLIGENCE_MATERIALIZER_RADIUS_ROLE) throw new Error('materializer_connected_with_unexpected_radius_role')
    if (privileges.length !== REQUIRED_RADIUS_TABLES.length || privileges.some((item) => !item.select || item.insert || item.update || item.delete || item.truncate)) throw new Error('materializer_radius_source_privilege_violation')
    const sourceSafety: MaterializationSourceSafety = { role: JOB_INTELLIGENCE_MATERIALIZER_RADIUS_ROLE, defaultTransactionReadOnly: 'on', privileges }
    return { ...owner, sourceSafety }
  } catch (error) {
    await owner.close()
    throw error
  }
}
