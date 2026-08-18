import pg from 'pg'
import type { RadiusConfig } from '../config.js'
import type { RadiusService } from './radius-service.js'
import {
  DatabaseRadiusService,
  UnavailableRadiusService,
} from './radius-service.js'
import { RadiusRepository, type RadiusQueryExecutor } from './radius-repository.js'

const { Pool } = pg

export function createRadiusQueryExecutor(
  query: RadiusQueryExecutor['query'],
  serialize: boolean,
): RadiusQueryExecutor {
  let tail = Promise.resolve()
  return {
    query: (text, values) => {
      if (!serialize) return query(text, values)
      const operation = tail.then(() => query(text, values))
      tail = operation.then(() => undefined, () => undefined)
      return operation
    },
  }
}

export function createRadiusService(
  config: RadiusConfig,
  plantTimeZone: string,
  options: { maximumConnections?: number } = {},
): RadiusService {
  if (!config.enabled) return new UnavailableRadiusService()

  const maximumConnections = options.maximumConnections ?? 5
  const pool = new Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    max: maximumConnections,
    connectionTimeoutMillis: 2_000,
    idleTimeoutMillis: 10_000,
    query_timeout: 6_000,
    statement_timeout: 5_000,
    application_name: 'ProcessIntelligence',
    allowExitOnIdle: true,
  })
  const executor = createRadiusQueryExecutor(
    async (text: string, values?: unknown[]) => {
      const result = await pool.query(text, values)
      return { rows: result.rows as Array<Record<string, unknown>> }
    },
    maximumConnections === 1,
  )
  return new DatabaseRadiusService(
    new RadiusRepository(executor, config, plantTimeZone),
    config,
    plantTimeZone,
  )
}
