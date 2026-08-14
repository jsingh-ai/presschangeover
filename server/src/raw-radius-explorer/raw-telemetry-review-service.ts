import pg from 'pg'
import type { AppDatabaseConfig } from '../config.js'
import type { RadiusPressKey } from '../radius/models.js'

const { Pool } = pg
const DOCUMENT_TABLE = 'public.classification_documents'
const DOCUMENT_TYPE = 'raw_telemetry_reviews'

export const RAW_TELEMETRY_REVIEW_STATUSES = ['UNREVIEWED', 'USEFUL', 'NEEDS_MAPPING', 'IGNORE'] as const
export type RawTelemetryReviewStatus = typeof RAW_TELEMETRY_REVIEW_STATUSES[number]

export interface RawTelemetryReview {
  press: RadiusPressKey
  rawIdentity: string
  reviewStatus: RawTelemetryReviewStatus
  createdAt: string
  updatedAt: string
}

interface StoredReview {
  press: RadiusPressKey
  raw_identity: string
  review_status: RawTelemetryReviewStatus
  created_at: string
  updated_at: string
}

interface ReviewDocument { version: 1; records: StoredReview[] }

export interface RawTelemetryReviewRepository {
  readonly persistence: 'postgresql' | 'memory'
  initialize(): Promise<void>
  list(press: RadiusPressKey, rawIdentities: string[]): Promise<RawTelemetryReview[]>
  set(press: RadiusPressKey, rawIdentity: string, reviewStatus: RawTelemetryReviewStatus): Promise<RawTelemetryReview>
}

function publicReview(review: StoredReview): RawTelemetryReview {
  return { press: review.press, rawIdentity: review.raw_identity, reviewStatus: review.review_status, createdAt: review.created_at, updatedAt: review.updated_at }
}

function validDocument(value: unknown): ReviewDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_raw_telemetry_review_document')
  const document = value as Record<string, unknown>
  if (document.version !== 1 || !Array.isArray(document.records)) throw new Error('invalid_raw_telemetry_review_document')
  const records = document.records as StoredReview[]
  if (records.some((item) => !item || typeof item.press !== 'string' || typeof item.raw_identity !== 'string' || !RAW_TELEMETRY_REVIEW_STATUSES.includes(item.review_status) || typeof item.created_at !== 'string' || typeof item.updated_at !== 'string')) throw new Error('invalid_raw_telemetry_review_document')
  return { version: 1, records }
}

export class InMemoryRawTelemetryReviewRepository implements RawTelemetryReviewRepository {
  readonly persistence = 'memory' as const
  private document: ReviewDocument = { version: 1, records: [] }
  async initialize() {}
  async list(press: RadiusPressKey, rawIdentities: string[]) {
    const identities = new Set(rawIdentities)
    return this.document.records.filter((item) => item.press === press && identities.has(item.raw_identity)).map(publicReview)
  }
  async set(press: RadiusPressKey, rawIdentity: string, reviewStatus: RawTelemetryReviewStatus) {
    const now = new Date().toISOString()
    const current = this.document.records.find((item) => item.press === press && item.raw_identity === rawIdentity)
    if (current) { current.review_status = reviewStatus; current.updated_at = now; return publicReview(current) }
    const created = { press, raw_identity: rawIdentity, review_status: reviewStatus, created_at: now, updated_at: now }
    this.document.records.push(created)
    return publicReview(created)
  }
}

export class PostgresRawTelemetryReviewRepository implements RawTelemetryReviewRepository {
  readonly persistence = 'postgresql' as const
  constructor(private readonly pool: pg.Pool) {}

  async initialize() {
    const now = new Date().toISOString()
    const document: ReviewDocument = { version: 1, records: [] }
    await this.pool.query(
      `INSERT INTO ${DOCUMENT_TABLE} (document_type, version, revision, status, document, changed_by, published_at)
       VALUES ($1, 1, 1, 'published', $2::jsonb, 'system-seed', $3)
       ON CONFLICT (document_type, version) DO NOTHING`,
      [DOCUMENT_TYPE, JSON.stringify(document), now],
    )
  }

  async list(press: RadiusPressKey, rawIdentities: string[]) {
    if (!rawIdentities.length) return []
    const result = await this.pool.query(`SELECT document FROM ${DOCUMENT_TABLE} WHERE document_type = $1 AND version = 1`, [DOCUMENT_TYPE])
    if (!result.rows.length) return []
    const identities = new Set(rawIdentities)
    return validDocument(result.rows[0].document).records.filter((item) => item.press === press && identities.has(item.raw_identity)).map(publicReview)
  }

  async set(press: RadiusPressKey, rawIdentity: string, reviewStatus: RawTelemetryReviewStatus) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await client.query(`SELECT id, revision, document FROM ${DOCUMENT_TABLE} WHERE document_type = $1 AND version = 1 FOR UPDATE`, [DOCUMENT_TYPE])
      if (!result.rows.length) throw new Error('raw_telemetry_review_document_missing')
      const document = validDocument(result.rows[0].document)
      const now = new Date().toISOString()
      let stored = document.records.find((item) => item.press === press && item.raw_identity === rawIdentity)
      if (stored) { stored.review_status = reviewStatus; stored.updated_at = now }
      else { stored = { press, raw_identity: rawIdentity, review_status: reviewStatus, created_at: now, updated_at: now }; document.records.push(stored) }
      const updated = await client.query(`UPDATE ${DOCUMENT_TABLE} SET revision = revision + 1, document = $2::jsonb, changed_by = 'application-user' WHERE id = $1 AND revision = $3`, [result.rows[0].id, JSON.stringify(document), result.rows[0].revision])
      if (updated.rowCount !== 1) throw new Error('raw_telemetry_review_conflict')
      await client.query('COMMIT')
      return publicReview(stored)
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally { client.release() }
  }
}

export class RawTelemetryReviewService {
  readonly persistence: RawTelemetryReviewRepository['persistence']
  constructor(private readonly repository: RawTelemetryReviewRepository) { this.persistence = repository.persistence }
  initialize() { return this.repository.initialize() }
  list(press: RadiusPressKey, rawIdentities: string[]) { return this.repository.list(press, rawIdentities) }
  set(press: RadiusPressKey, rawIdentity: string, reviewStatus: RawTelemetryReviewStatus) { return this.repository.set(press, rawIdentity, reviewStatus) }
}

export function createRawTelemetryReviewService(config: AppDatabaseConfig) {
  if (!config.enabled) return new RawTelemetryReviewService(new InMemoryRawTelemetryReviewRepository())
  const pool = new Pool({
    host: config.host, port: config.port, database: config.database, user: config.user, password: config.password,
    max: 2, connectionTimeoutMillis: 2_000, idleTimeoutMillis: 10_000, query_timeout: 6_000,
    statement_timeout: 5_000, application_name: 'ProcessIntelligenceRawTelemetryReview', allowExitOnIdle: true,
  })
  return new RawTelemetryReviewService(new PostgresRawTelemetryReviewRepository(pool))
}
