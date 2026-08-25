import pg from 'pg'
import type { AppDatabaseConfig } from '../config.js'
import { PostgresJobHistoryRepository } from './history-repository.js'

const { Pool } = pg
export const JOB_VALIDATION_DATABASE_MARKER = 'ProcessIntelligence disposable Job validation database'

export interface DisposableJobValidationDatabaseConfig {
  host: '127.0.0.1' | 'localhost'
  port: number
  database: 'processintelligence_db'
  user: 'processintelligence_app'
  password: string
}

export function loadDisposableJobValidationDatabaseConfig(environment: NodeJS.ProcessEnv, production: AppDatabaseConfig): DisposableJobValidationDatabaseConfig {
  if (environment.JOB_VALIDATION_DB_DISPOSABLE !== 'YES') throw new Error('job_validation_database_requires_explicit_disposable_marker')
  const host = environment.JOB_VALIDATION_DB_HOST?.trim(); const port = Number(environment.JOB_VALIDATION_DB_PORT); const database = environment.JOB_VALIDATION_DB_NAME?.trim(); const user = environment.JOB_VALIDATION_DB_USER?.trim(); const password = environment.JOB_VALIDATION_DB_PASSWORD?.trim()
  if (host !== '127.0.0.1' && host !== 'localhost') throw new Error('job_validation_database_must_be_local')
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('invalid_job_validation_database_port')
  if (database !== 'processintelligence_db' || user !== 'processintelligence_app' || !password) throw new Error('invalid_job_validation_database_identity')
  // Both accepted host spellings resolve to the same local machine, so a shared
  // port would be the production application database regardless of spelling.
  if (production.enabled && production.port === port) throw new Error('job_validation_database_matches_production_endpoint')
  return { host, port, database, user, password }
}

export async function createDisposableJobValidationRepository(config: DisposableJobValidationDatabaseConfig) {
  const pool = new Pool({ ...config, max: 1, connectionTimeoutMillis: 2_000, idleTimeoutMillis: 5_000, query_timeout: 15_000, statement_timeout: 15_000, application_name: 'ProcessIntelligenceDisposableJobValidation', allowExitOnIdle: true })
  try {
    const marker = await pool.query("SELECT current_database() AS database,current_user AS \"user\",obj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=current_database()")
    const row = marker.rows[0]
    if (row?.database !== config.database || row?.user !== config.user || row?.marker !== JOB_VALIDATION_DATABASE_MARKER) throw new Error('job_validation_database_marker_mismatch')
    return new PostgresJobHistoryRepository(pool)
  } catch (error) {
    await pool.end()
    throw error
  }
}
