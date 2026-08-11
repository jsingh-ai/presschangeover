import pg from 'pg'
import type { RadiusConfig } from '../config.js'
import type { RadiusService } from './radius-service.js'
import {
  DatabaseRadiusService,
  UnavailableRadiusService,
} from './radius-service.js'
import { RadiusRepository } from './radius-repository.js'

const { Pool } = pg

export function createRadiusService(
  config: RadiusConfig,
  plantTimeZone: string,
): RadiusService {
  if (!config.enabled) return new UnavailableRadiusService()

  const pool = new Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    max: 5,
    connectionTimeoutMillis: 2_000,
    idleTimeoutMillis: 10_000,
    query_timeout: 6_000,
    statement_timeout: 5_000,
    application_name: 'ProcessIntelligence',
    allowExitOnIdle: true,
  })
  const executor = {
    query: async (text: string, values?: unknown[]) => {
      const result = await pool.query(text, values)
      return { rows: result.rows as Array<Record<string, unknown>> }
    },
  }
  return new DatabaseRadiusService(
    new RadiusRepository(executor, config, plantTimeZone),
    config,
    plantTimeZone,
  )
}
