import pg from 'pg'
import type { AppDatabaseConfig } from '../config.js'
import type { Request } from 'express'
import { InMemoryClassificationRepository, PostgresClassificationRepository } from './classification-repository.js'
import { ClassificationService } from './classification-service.js'
import type { ClassificationActor } from './models.js'

const { Pool } = pg

export function createClassificationService(config: AppDatabaseConfig) {
  if (!config.enabled) return new ClassificationService(new InMemoryClassificationRepository())
  const pool = new Pool({
    host: config.host, port: config.port, database: config.database, user: config.user, password: config.password,
    max: 3, connectionTimeoutMillis: 2_000, idleTimeoutMillis: 10_000, query_timeout: 6_000,
    statement_timeout: 5_000, application_name: 'ProcessIntelligenceClassification', allowExitOnIdle: true,
  })
  return new ClassificationService(new PostgresClassificationRepository(pool))
}

export type ClassificationAuthorizer = (request: Request) => ClassificationActor

export function createClassificationAuthorizer(writableStoreConfigured: boolean): ClassificationAuthorizer {
  return () => ({
    id: writableStoreConfigured ? 'application-user' : 'read-only-memory',
    canEdit: writableStoreConfigured,
  })
}
