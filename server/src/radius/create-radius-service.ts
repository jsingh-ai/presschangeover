import pg from 'pg'
import type { RadiusConfig } from '../config.js'
import type { RadiusService } from './radius-service.js'
import {
  DatabaseRadiusService,
  UnavailableRadiusService,
} from './radius-service.js'
import { RadiusRepository, type RadiusQueryExecutor } from './radius-repository.js'

const { Pool } = pg
export const RADIUS_SERVICE_DEFAULT_MAX_CONNECTIONS = 5

export interface RadiusPoolLike {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>
  end(): Promise<void>
}

export type RadiusPoolFactory = (config: pg.PoolConfig) => RadiusPoolLike

export interface ManagedRadiusService {
  service: RadiusService
  maximumConnections: number
  close(): Promise<void>
}

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
  options: { maximumConnections?: number; applicationName?: string } = {},
): RadiusService {
  return createManagedRadiusService(config, plantTimeZone, options).service
}

export function createManagedRadiusService(
  config: RadiusConfig,
  plantTimeZone: string,
  options: { maximumConnections?: number; applicationName?: string; poolFactory?: RadiusPoolFactory; startupOptions?: string } = {},
): ManagedRadiusService {
  if (!config.enabled) return { service: new UnavailableRadiusService(), maximumConnections: 0, close: async () => undefined }

  const maximumConnections = options.maximumConnections ?? RADIUS_SERVICE_DEFAULT_MAX_CONNECTIONS
  if (!Number.isSafeInteger(maximumConnections) || maximumConnections < 1) throw new Error('invalid_radius_pool_maximum_connections')
  const poolConfig: pg.PoolConfig = {
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
    application_name: options.applicationName ?? 'ProcessIntelligence',
    allowExitOnIdle: true,
    ...(options.startupOptions ? { options: options.startupOptions } : {}),
  }
  const pool = options.poolFactory ? options.poolFactory(poolConfig) : new Pool(poolConfig) as unknown as RadiusPoolLike
  const executor = createRadiusQueryExecutor(
    async (text: string, values?: unknown[]) => {
      const result = await pool.query(text, values)
      return { rows: result.rows as Array<Record<string, unknown>> }
    },
    maximumConnections === 1,
  )
  const service = new DatabaseRadiusService(
    new RadiusRepository(executor, config, plantTimeZone),
    config,
    plantTimeZone,
  )
  let closed = false
  return { service, maximumConnections, close: async () => { if (closed) return; closed = true; await pool.end() } }
}
