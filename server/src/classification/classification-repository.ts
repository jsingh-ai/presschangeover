import type pg from 'pg'
import type {
  ClassificationAuditChange,
  ClassificationAuditEntry,
  ClassificationDraft,
  ClassificationSnapshot,
  ClassificationVersionSummary,
} from './models.js'
import { seededSnapshot } from './seeds.js'

const DOCUMENT_TABLE = 'public.classification_documents'
export const CLASSIFICATION_DOCUMENT_TYPE = 'radius_semantic_classification'

type PublishedDocument = ClassificationSnapshot & { changes?: ClassificationAuditChange[] }

export class ClassificationConflictError extends Error {
  constructor() { super('classification_draft_conflict'); this.name = 'ClassificationConflictError' }
}

export interface ClassificationRepository {
  readonly persistence: 'postgresql' | 'memory'
  initialize(): Promise<void>
  getPublished(): Promise<ClassificationSnapshot>
  getDraft(): Promise<ClassificationDraft | null>
  saveDraft(draft: ClassificationDraft, expectedRevision: number | null, audit: ClassificationAuditChange): Promise<ClassificationDraft>
  discardDraft(expectedRevision: number, audit: ClassificationAuditChange): Promise<void>
  publishDraft(expectedRevision: number, actor: string): Promise<ClassificationSnapshot>
  listVersions(): Promise<ClassificationVersionSummary[]>
  listAudit(): Promise<ClassificationAuditEntry[]>
}

export class InMemoryClassificationRepository implements ClassificationRepository {
  readonly persistence = 'memory' as const
  private published = seededSnapshot()
  private draft: ClassificationDraft | null = null
  private versions: ClassificationVersionSummary[] = []
  private audit: ClassificationAuditEntry[] = []

  async initialize() {}
  async getPublished() { return structuredClone(this.published) }
  async getDraft() { return this.draft ? structuredClone(this.draft) : null }

  async saveDraft(draft: ClassificationDraft, expectedRevision: number | null, audit: ClassificationAuditChange) {
    if ((this.draft?.revision ?? null) !== expectedRevision) throw new ClassificationConflictError()
    this.draft = structuredClone(draft)
    this.audit.unshift({ ...audit, id: `audit-${this.audit.length + 1}`, version: null })
    return structuredClone(this.draft)
  }

  async discardDraft(expectedRevision: number, audit: ClassificationAuditChange) {
    if (!this.draft || this.draft.revision !== expectedRevision) throw new ClassificationConflictError()
    this.draft = null
    this.audit.unshift({ ...audit, id: `audit-${this.audit.length + 1}`, version: null })
  }

  async publishDraft(expectedRevision: number, actor: string) {
    if (!this.draft || this.draft.revision !== expectedRevision || this.draft.baseVersion !== this.published.version) throw new ClassificationConflictError()
    const publishedAtUtc = new Date().toISOString()
    const version = this.published.version + 1
    this.published = { version, publishedAtUtc, publishedBy: actor, groups: structuredClone(this.draft.groups), families: structuredClone(this.draft.families), classifications: structuredClone(this.draft.classifications) }
    const changes = this.draft.changes.length
    this.versions.unshift({ version, publishedAtUtc, publishedBy: actor, changeCount: changes })
    this.audit.unshift({ id: `audit-${this.audit.length + 1}`, version, action: 'PUBLISHED', target: `version:${version}`, summary: `Published ${changes} draft change${changes === 1 ? '' : 's'}.`, atUtc: publishedAtUtc, actor })
    this.draft = null
    return structuredClone(this.published)
  }

  async listVersions() { return structuredClone(this.versions) }
  async listAudit() { return structuredClone(this.audit) }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasDocumentArrays(value: Record<string, unknown>): boolean {
  return Array.isArray(value.groups) && Array.isArray(value.families) && Array.isArray(value.classifications)
}

function asSnapshot(value: unknown): ClassificationSnapshot {
  if (!isRecord(value) || !Number.isInteger(value.version) || !hasDocumentArrays(value)) throw new Error('invalid_classification_snapshot')
  if (value.publishedAtUtc !== null && typeof value.publishedAtUtc !== 'string') throw new Error('invalid_classification_snapshot')
  if (value.publishedBy !== null && typeof value.publishedBy !== 'string') throw new Error('invalid_classification_snapshot')
  const snapshot = value as unknown as ClassificationSnapshot
  return {
    version: snapshot.version,
    publishedAtUtc: snapshot.publishedAtUtc,
    publishedBy: snapshot.publishedBy,
    groups: snapshot.groups,
    families: snapshot.families,
    classifications: snapshot.classifications,
  }
}

function asDraft(value: unknown): ClassificationDraft {
  if (!isRecord(value) || !Number.isInteger(value.baseVersion) || !Number.isInteger(value.revision) || !hasDocumentArrays(value) || !Array.isArray(value.changes)) throw new Error('invalid_classification_draft')
  if (typeof value.updatedAtUtc !== 'string' || typeof value.updatedBy !== 'string') throw new Error('invalid_classification_draft')
  return value as unknown as ClassificationDraft
}

function changesFromPublished(value: unknown): ClassificationAuditChange[] {
  if (!isRecord(value) || !Array.isArray(value.changes)) return []
  return value.changes.filter((change): change is ClassificationAuditChange => isRecord(change) && typeof change.action === 'string' && typeof change.target === 'string' && typeof change.summary === 'string' && typeof change.atUtc === 'string' && typeof change.actor === 'string')
}

function isUniqueViolation(error: unknown): boolean {
  return isRecord(error) && error.code === '23505'
}

export class PostgresClassificationRepository implements ClassificationRepository {
  readonly persistence = 'postgresql' as const

  constructor(private readonly pool: pg.Pool) {}

  async initialize() {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const publishedAtUtc = new Date().toISOString()
      const snapshot: PublishedDocument = { ...seededSnapshot(), publishedAtUtc, publishedBy: 'system-seed', changes: [] }
      await client.query(
        `INSERT INTO ${DOCUMENT_TABLE} (document_type, version, revision, status, document, changed_by, published_at)
         VALUES ($1, 1, 1, 'published', $2::jsonb, 'system-seed', $3)
         ON CONFLICT (document_type, version) DO NOTHING`,
        [CLASSIFICATION_DOCUMENT_TYPE, JSON.stringify(snapshot), publishedAtUtc],
      )
      const current = await client.query(
        `SELECT id FROM ${DOCUMENT_TABLE} WHERE document_type = $1 AND status = 'published' ORDER BY version DESC LIMIT 1`,
        [CLASSIFICATION_DOCUMENT_TYPE],
      )
      if (!current.rows.length) throw new Error('classification_published_document_missing')
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally { client.release() }
  }

  async getPublished() {
    const result = await this.pool.query(
      `SELECT document FROM ${DOCUMENT_TABLE} WHERE document_type = $1 AND status = 'published' ORDER BY version DESC LIMIT 1`,
      [CLASSIFICATION_DOCUMENT_TYPE],
    )
    return result.rows.length ? asSnapshot(result.rows[0].document) : seededSnapshot()
  }

  async getDraft() {
    const result = await this.pool.query(
      `SELECT document FROM ${DOCUMENT_TABLE} WHERE document_type = $1 AND status = 'draft' LIMIT 1`,
      [CLASSIFICATION_DOCUMENT_TYPE],
    )
    return result.rows.length ? asDraft(result.rows[0].document) : null
  }

  async saveDraft(draft: ClassificationDraft, expectedRevision: number | null, _audit: ClassificationAuditChange) {
    asDraft(draft)
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const current = await client.query(
        `SELECT id, version, revision FROM ${DOCUMENT_TABLE} WHERE document_type = $1 AND status = 'draft' LIMIT 1 FOR UPDATE`,
        [CLASSIFICATION_DOCUMENT_TYPE],
      )
      const revision = current.rows.length ? Number(current.rows[0].revision) : null
      if (revision !== expectedRevision) throw new ClassificationConflictError()

      if (current.rows.length) {
        if (Number(current.rows[0].version) !== draft.baseVersion + 1) throw new ClassificationConflictError()
        const updated = await client.query(
          `UPDATE ${DOCUMENT_TABLE}
           SET revision = $2, document = $3::jsonb, changed_by = $4
           WHERE id = $1 AND status = 'draft' AND revision = $5`,
          [current.rows[0].id, draft.revision, JSON.stringify(draft), draft.updatedBy, expectedRevision],
        )
        if (updated.rowCount !== 1) throw new ClassificationConflictError()
      } else {
        const published = await client.query(
          `SELECT id, version FROM ${DOCUMENT_TABLE} WHERE document_type = $1 AND status = 'published' ORDER BY version DESC LIMIT 1 FOR UPDATE`,
          [CLASSIFICATION_DOCUMENT_TYPE],
        )
        if (!published.rows.length || Number(published.rows[0].version) !== draft.baseVersion) throw new ClassificationConflictError()
        await client.query(
          `INSERT INTO ${DOCUMENT_TABLE} (document_type, version, revision, status, document, changed_by, supersedes_id)
           VALUES ($1, $2, $3, 'draft', $4::jsonb, $5, $6)`,
          [CLASSIFICATION_DOCUMENT_TYPE, draft.baseVersion + 1, draft.revision, JSON.stringify(draft), draft.updatedBy, published.rows[0].id],
        )
      }
      await client.query('COMMIT')
      return structuredClone(draft)
    } catch (error) {
      await client.query('ROLLBACK')
      if (isUniqueViolation(error)) throw new ClassificationConflictError()
      throw error
    } finally { client.release() }
  }

  async discardDraft(expectedRevision: number, _audit: ClassificationAuditChange) {
    const result = await this.pool.query(
      `DELETE FROM ${DOCUMENT_TABLE} WHERE document_type = $1 AND status = 'draft' AND revision = $2`,
      [CLASSIFICATION_DOCUMENT_TYPE, expectedRevision],
    )
    if (result.rowCount !== 1) throw new ClassificationConflictError()
  }

  async publishDraft(expectedRevision: number, actor: string) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const publishedResult = await client.query(
        `SELECT id, version, document FROM ${DOCUMENT_TABLE} WHERE document_type = $1 AND status = 'published' ORDER BY version DESC LIMIT 1 FOR UPDATE`,
        [CLASSIFICATION_DOCUMENT_TYPE],
      )
      const draftResult = await client.query(
        `SELECT id, version, revision, document FROM ${DOCUMENT_TABLE} WHERE document_type = $1 AND status = 'draft' LIMIT 1 FOR UPDATE`,
        [CLASSIFICATION_DOCUMENT_TYPE],
      )
      if (!publishedResult.rows.length || !draftResult.rows.length || Number(draftResult.rows[0].revision) !== expectedRevision) throw new ClassificationConflictError()
      const previous = asSnapshot(publishedResult.rows[0].document)
      const draft = asDraft(draftResult.rows[0].document)
      const currentVersion = Number(publishedResult.rows[0].version)
      const version = Number(draftResult.rows[0].version)
      if (draft.baseVersion !== currentVersion || version !== currentVersion + 1) throw new ClassificationConflictError()

      const publishedAtUtc = new Date().toISOString()
      const snapshot: ClassificationSnapshot = {
        version,
        publishedAtUtc,
        publishedBy: actor,
        groups: draft.groups,
        families: draft.families ?? previous.families,
        classifications: draft.classifications,
      }
      const document: PublishedDocument = { ...snapshot, changes: draft.changes }
      const updated = await client.query(
        `UPDATE ${DOCUMENT_TABLE}
         SET revision = $2, status = 'published', document = $3::jsonb, changed_by = $4, published_at = $5
         WHERE id = $1 AND status = 'draft' AND revision = $6`,
        [draftResult.rows[0].id, expectedRevision + 1, JSON.stringify(document), actor, publishedAtUtc, expectedRevision],
      )
      if (updated.rowCount !== 1) throw new ClassificationConflictError()
      await client.query('COMMIT')
      return snapshot
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally { client.release() }
  }

  async listVersions() {
    const result = await this.pool.query(
      `SELECT version, document, changed_by AS "changedBy", published_at AS "publishedAtUtc"
       FROM ${DOCUMENT_TABLE}
       WHERE document_type = $1 AND status = 'published'
       ORDER BY version DESC LIMIT 25`,
      [CLASSIFICATION_DOCUMENT_TYPE],
    )
    return result.rows.map((row) => ({
      version: Number(row.version),
      publishedAtUtc: new Date(row.publishedAtUtc).toISOString(),
      publishedBy: String(row.changedBy ?? 'system-seed'),
      changeCount: changesFromPublished(row.document).length,
    }))
  }

  async listAudit() {
    const result = await this.pool.query(
      `SELECT id::text, version, status, document, changed_by AS "changedBy", created_at AS "createdAtUtc", published_at AS "publishedAtUtc"
       FROM ${DOCUMENT_TABLE}
       WHERE document_type = $1
       ORDER BY version DESC LIMIT 25`,
      [CLASSIFICATION_DOCUMENT_TYPE],
    )
    const entries: ClassificationAuditEntry[] = []
    for (const row of result.rows) {
      const changes = row.status === 'draft' ? asDraft(row.document).changes : changesFromPublished(row.document)
      changes.forEach((change, index) => entries.push({ ...change, id: `${row.id}:change:${index}`, version: row.status === 'published' ? Number(row.version) : null }))
      if (row.status === 'published') {
        const atUtc = new Date(row.publishedAtUtc).toISOString()
        entries.push({
          id: `${row.id}:published`, version: Number(row.version), action: 'PUBLISHED', target: `version:${row.version}`,
          summary: `Published ${changes.length} draft change${changes.length === 1 ? '' : 's'}.`, atUtc, actor: String(row.changedBy ?? 'system-seed'),
        })
      }
    }
    return entries.sort((left, right) => Date.parse(right.atUtc) - Date.parse(left.atUtc)).slice(0, 100)
  }
}
