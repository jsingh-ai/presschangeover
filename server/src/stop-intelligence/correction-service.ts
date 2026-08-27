import { randomUUID } from 'node:crypto'
import pg from 'pg'
import type { AppDatabaseConfig } from '../config.js'
import { RADIUS_PRESS_KEYS, type RadiusPressKey } from '../radius/models.js'

const { Pool } = pg
const DOCUMENT_TABLE = 'public.classification_documents'
const DOCUMENT_TYPE = 'stop_intelligence_operator_corrections'
const MAX_CORRECTION_RECORDS = 10_000

export const STOP_PREDICTED_STATES = ['CHANGEOVER', 'DOWNTIME', 'UNCERTAIN', 'IGNORE_BAD_DATA', 'OBSERVABLE_NON_STOP', 'UNKNOWN'] as const
export type StopPredictedState = typeof STOP_PREDICTED_STATES[number]
export const STOP_OPERATOR_STATES = ['CHANGEOVER', 'DOWNTIME', 'UNCERTAIN', 'ROUTINE', 'GOOD_PRODUCTION'] as const
export type StopOperatorState = typeof STOP_OPERATOR_STATES[number]
export const STOP_OPERATOR_DECISION_STATES = ['CHANGEOVER', 'DOWNTIME', 'ROUTINE', 'GOOD_PRODUCTION'] as const
export type StopOperatorDecisionState = typeof STOP_OPERATOR_DECISION_STATES[number]

export interface StopIntelligenceCorrection {
  correctionId: string
  pressKey: RadiusPressKey
  segmentKey: string
  fromUtc: string
  toUtc: string
  predictedState: StopPredictedState
  correctedState: StopOperatorState
  comment: string | null
  createdAtUtc: string
}

export interface StopIntelligenceCorrectionInput {
  pressKey: RadiusPressKey
  segmentKey: string
  fromUtc: string
  toUtc: string
  predictedState: StopPredictedState
  correctedState: StopOperatorDecisionState
  comment?: string | null
}

interface StoredCorrection {
  correction_id: string
  press_key: RadiusPressKey
  segment_key: string
  from_utc: string
  to_utc: string
  predicted_state: StopPredictedState
  corrected_state: StopOperatorState
  comment?: string | null
  created_at_utc: string
}

interface CorrectionDocument { version: 1; records: StoredCorrection[] }

export interface StopIntelligenceCorrectionRepository {
  readonly persistence: 'postgresql' | 'memory'
  initialize(): Promise<void>
  list(pressKey: RadiusPressKey, fromUtc: string, toUtc: string): Promise<StopIntelligenceCorrection[]>
  append(input: StopIntelligenceCorrectionInput): Promise<StopIntelligenceCorrection>
}

function publicCorrection(value: StoredCorrection): StopIntelligenceCorrection {
  return { correctionId: value.correction_id, pressKey: value.press_key, segmentKey: value.segment_key, fromUtc: value.from_utc, toUtc: value.to_utc, predictedState: value.predicted_state, correctedState: value.corrected_state, comment: value.comment ?? null, createdAtUtc: value.created_at_utc }
}

function validDocument(value: unknown): CorrectionDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_stop_intelligence_correction_document')
  const document = value as Record<string, unknown>
  if (document.version !== 1 || !Array.isArray(document.records)) throw new Error('invalid_stop_intelligence_correction_document')
  const records = document.records as StoredCorrection[]
  if (records.length > MAX_CORRECTION_RECORDS || records.some((item) => !item
    || typeof item.correction_id !== 'string'
    || !RADIUS_PRESS_KEYS.includes(item.press_key)
    || typeof item.segment_key !== 'string'
    || typeof item.from_utc !== 'string'
    || typeof item.to_utc !== 'string'
    || !STOP_PREDICTED_STATES.includes(item.predicted_state)
    || !STOP_OPERATOR_STATES.includes(item.corrected_state)
    || item.comment !== undefined && item.comment !== null && (typeof item.comment !== 'string' || item.comment.length > 1_000)
    || typeof item.created_at_utc !== 'string')) throw new Error('invalid_stop_intelligence_correction_document')
  return { version: 1, records }
}

function overlaps(value: StoredCorrection, fromUtc: string, toUtc: string) {
  return Date.parse(value.from_utc) < Date.parse(toUtc) && Date.parse(value.to_utc) > Date.parse(fromUtc)
}

function storedCorrection(input: StopIntelligenceCorrectionInput): StoredCorrection {
  return { correction_id: randomUUID(), press_key: input.pressKey, segment_key: input.segmentKey, from_utc: input.fromUtc, to_utc: input.toUtc, predicted_state: input.predictedState, corrected_state: input.correctedState, comment: input.comment?.trim() || null, created_at_utc: new Date().toISOString() }
}

export class InMemoryStopIntelligenceCorrectionRepository implements StopIntelligenceCorrectionRepository {
  readonly persistence = 'memory' as const
  private document: CorrectionDocument = { version: 1, records: [] }
  async initialize() {}
  async list(pressKey: RadiusPressKey, fromUtc: string, toUtc: string) {
    return this.document.records.filter((item) => item.press_key === pressKey && overlaps(item, fromUtc, toUtc)).map(publicCorrection)
  }
  async append(input: StopIntelligenceCorrectionInput) {
    if (this.document.records.length >= MAX_CORRECTION_RECORDS) throw new Error('stop_intelligence_correction_limit_reached')
    const stored = storedCorrection(input)
    this.document.records.push(stored)
    return publicCorrection(stored)
  }
}

export class PostgresStopIntelligenceCorrectionRepository implements StopIntelligenceCorrectionRepository {
  readonly persistence = 'postgresql' as const
  constructor(private readonly pool: pg.Pool) {}

  async initialize() {
    const now = new Date().toISOString()
    const document: CorrectionDocument = { version: 1, records: [] }
    await this.pool.query(
      `INSERT INTO ${DOCUMENT_TABLE} (document_type, version, revision, status, document, changed_by, published_at)
       VALUES ($1, 1, 1, 'published', $2::jsonb, 'system-seed', $3)
       ON CONFLICT (document_type, version) DO NOTHING`,
      [DOCUMENT_TYPE, JSON.stringify(document), now],
    )
  }

  async list(pressKey: RadiusPressKey, fromUtc: string, toUtc: string) {
    const result = await this.pool.query(`SELECT document FROM ${DOCUMENT_TABLE} WHERE document_type = $1 AND version = 1`, [DOCUMENT_TYPE])
    if (!result.rows.length) return []
    return validDocument(result.rows[0].document).records.filter((item) => item.press_key === pressKey && overlaps(item, fromUtc, toUtc)).map(publicCorrection)
  }

  async append(input: StopIntelligenceCorrectionInput) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await client.query(`SELECT id, revision, document FROM ${DOCUMENT_TABLE} WHERE document_type = $1 AND version = 1 FOR UPDATE`, [DOCUMENT_TYPE])
      if (!result.rows.length) throw new Error('stop_intelligence_correction_document_missing')
      const document = validDocument(result.rows[0].document)
      if (document.records.length >= MAX_CORRECTION_RECORDS) throw new Error('stop_intelligence_correction_limit_reached')
      const stored = storedCorrection(input)
      document.records.push(stored)
      const updated = await client.query(`UPDATE ${DOCUMENT_TABLE} SET revision = revision + 1, document = $2::jsonb, changed_by = 'application-user' WHERE id = $1 AND revision = $3`, [result.rows[0].id, JSON.stringify(document), result.rows[0].revision])
      if (updated.rowCount !== 1) throw new Error('stop_intelligence_correction_conflict')
      await client.query('COMMIT')
      return publicCorrection(stored)
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally { client.release() }
  }
}

export class StopIntelligenceCorrectionService {
  readonly persistence: StopIntelligenceCorrectionRepository['persistence']
  constructor(private readonly repository: StopIntelligenceCorrectionRepository) { this.persistence = repository.persistence }
  initialize() { return this.repository.initialize() }
  list(pressKey: RadiusPressKey, fromUtc: string, toUtc: string) { return this.repository.list(pressKey, fromUtc, toUtc) }
  append(input: StopIntelligenceCorrectionInput) { return this.repository.append(input) }
}

export function createStopIntelligenceCorrectionService(config: AppDatabaseConfig) {
  if (!config.enabled) return new StopIntelligenceCorrectionService(new InMemoryStopIntelligenceCorrectionRepository())
  const pool = new Pool({
    host: config.host, port: config.port, database: config.database, user: config.user, password: config.password,
    max: 2, connectionTimeoutMillis: 2_000, idleTimeoutMillis: 10_000, query_timeout: 6_000,
    statement_timeout: 5_000, application_name: 'ProcessIntelligenceStopCorrections', allowExitOnIdle: true,
  })
  return new StopIntelligenceCorrectionService(new PostgresStopIntelligenceCorrectionRepository(pool))
}
