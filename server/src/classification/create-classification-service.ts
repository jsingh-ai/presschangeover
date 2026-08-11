import pg from 'pg'
import type { AppDatabaseConfig, ClassificationAuthorizationConfig } from '../config.js'
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

export function createClassificationAuthorizer(config: ClassificationAuthorizationConfig, writableStoreConfigured: boolean): ClassificationAuthorizer {
  return (request) => {
    if (!writableStoreConfigured || !config.trustedProxy) return { id: 'anonymous', canEdit: false }
    const supplied = request.header('X-ProcessIntelligence-Authenticated-User')?.trim().toLowerCase()
    if (!supplied || !/^[a-z0-9._\\@-]{1,128}$/.test(supplied)) return { id: 'anonymous', canEdit: false }
    return { id: supplied, canEdit: config.adminActors.includes(supplied) }
  }
}
