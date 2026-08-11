import type pg from 'pg'
import type {
  ClassificationAuditChange,
  ClassificationAuditEntry,
  ClassificationDraft,
  ClassificationSnapshot,
  ClassificationVersionSummary,
} from './models.js'
import { SEEDED_CLASSIFICATIONS, SEEDED_OPERATIONAL_GROUPS, SEEDED_PROCESS_FAMILIES, seededSnapshot } from './seeds.js'

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
    this.published = { version, publishedAtUtc, publishedBy: actor, groups: structuredClone(this.draft.groups), families: structuredClone(this.published.families), classifications: structuredClone(this.draft.classifications) }
    const changes = this.draft.changes.length
    this.versions.unshift({ version, publishedAtUtc, publishedBy: actor, changeCount: changes })
    this.audit.unshift({ id: `audit-${this.audit.length + 1}`, version, action: 'PUBLISHED', target: `version:${version}`, summary: `Published ${changes} draft change${changes === 1 ? '' : 's'}.`, atUtc: publishedAtUtc, actor })
    this.draft = null
    return structuredClone(this.published)
  }

  async listVersions() { return structuredClone(this.versions) }
  async listAudit() { return structuredClone(this.audit) }
}

function quoteIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error('invalid_application_schema')
  return `"${value}"`
}

function asSnapshot(value: unknown): ClassificationSnapshot {
  if (!value || typeof value !== 'object') throw new Error('invalid_classification_snapshot')
  return value as ClassificationSnapshot
}

function asDraft(value: unknown): ClassificationDraft {
  if (!value || typeof value !== 'object') throw new Error('invalid_classification_draft')
  return value as ClassificationDraft
}

export class PostgresClassificationRepository implements ClassificationRepository {
  readonly persistence = 'postgresql' as const
  private readonly schema: string
  constructor(private readonly pool: pg.Pool, schema: string) { this.schema = quoteIdentifier(schema) }

  async initialize() {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      for (const group of SEEDED_OPERATIONAL_GROUPS) {
        await client.query(`INSERT INTO ${this.schema}.operational_groups (id, stable_key, display_name, description, light_color, dark_color, icon_key, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (stable_key) DO NOTHING`, [group.id, group.key, group.displayName, group.description, group.lightColor, group.darkColor, group.icon, group.sortOrder])
      }
      for (const family of SEEDED_PROCESS_FAMILIES) {
        await client.query(`INSERT INTO ${this.schema}.process_families (id, stable_key, display_name, description, sort_order) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (stable_key) DO NOTHING`, [family.id, family.key, family.displayName, family.description, family.sortOrder])
      }
      for (const item of SEEDED_CLASSIFICATIONS) {
        await client.query(`INSERT INTO ${this.schema}.radius_state_classifications (identity_key, event_type, status_code, status_description, operational_group_id, process_family_id, display_label, explanation, confidence, needs_review, default_timeline_visibility, obsolete) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (identity_key) DO NOTHING`, [item.identity, item.eventType, item.statusCode, item.statusDescription, item.operationalGroupId, item.processFamilyId, item.displayLabel, item.explanation, item.confidence, item.needsReview, item.defaultTimelineVisibility, item.obsolete])
      }
      const count = await client.query(`SELECT count(*)::integer AS count FROM ${this.schema}.classification_versions`)
      if (Number(count.rows[0]?.count ?? 0) === 0) {
        const snapshot = seededSnapshot()
        await client.query(`INSERT INTO ${this.schema}.classification_versions (version, published_at, published_by, change_count, snapshot) VALUES (1, now(), 'system-seed', $1, $2::jsonb)`, [snapshot.classifications.length, JSON.stringify({ ...snapshot, publishedAtUtc: new Date().toISOString(), publishedBy: 'system-seed' })])
      }
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally { client.release() }
  }

  async getPublished() {
    const result = await this.pool.query(`SELECT snapshot FROM ${this.schema}.classification_versions ORDER BY version DESC LIMIT 1`)
    return result.rows.length ? asSnapshot(result.rows[0].snapshot) : seededSnapshot()
  }

  async getDraft() {
    const result = await this.pool.query(`SELECT snapshot FROM ${this.schema}.classification_drafts WHERE singleton_id = true`)
    return result.rows.length ? asDraft(result.rows[0].snapshot) : null
  }

  async saveDraft(draft: ClassificationDraft, expectedRevision: number | null, audit: ClassificationAuditChange) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const current = await client.query(`SELECT revision FROM ${this.schema}.classification_drafts WHERE singleton_id = true FOR UPDATE`)
      const revision = current.rows.length ? Number(current.rows[0].revision) : null
      if (revision !== expectedRevision) throw new ClassificationConflictError()
      await client.query(`INSERT INTO ${this.schema}.classification_drafts (singleton_id, base_version, revision, updated_at, updated_by, snapshot) VALUES (true,$1,$2,$3,$4,$5::jsonb) ON CONFLICT (singleton_id) DO UPDATE SET base_version=excluded.base_version, revision=excluded.revision, updated_at=excluded.updated_at, updated_by=excluded.updated_by, snapshot=excluded.snapshot`, [draft.baseVersion, draft.revision, draft.updatedAtUtc, draft.updatedBy, JSON.stringify(draft)])
      await client.query(`INSERT INTO ${this.schema}.classification_audit (version, action, target, summary, actor, created_at) VALUES (null,$1,$2,$3,$4,$5)`, [audit.action, audit.target, audit.summary, audit.actor, audit.atUtc])
      await client.query('COMMIT')
      return structuredClone(draft)
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }

  async discardDraft(expectedRevision: number, audit: ClassificationAuditChange) {
    const result = await this.pool.query(`DELETE FROM ${this.schema}.classification_drafts WHERE singleton_id = true AND revision = $1`, [expectedRevision])
    if (result.rowCount !== 1) throw new ClassificationConflictError()
    await this.pool.query(`INSERT INTO ${this.schema}.classification_audit (version, action, target, summary, actor, created_at) VALUES (null,$1,$2,$3,$4,$5)`, [audit.action, audit.target, audit.summary, audit.actor, audit.atUtc])
  }

  async publishDraft(expectedRevision: number, actor: string) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const currentVersionResult = await client.query(`SELECT version FROM ${this.schema}.classification_versions ORDER BY version DESC LIMIT 1 FOR UPDATE`)
      const currentVersion = Number(currentVersionResult.rows[0]?.version ?? 0)
      const draftResult = await client.query(`SELECT snapshot FROM ${this.schema}.classification_drafts WHERE singleton_id = true AND revision = $1 FOR UPDATE`, [expectedRevision])
      if (!draftResult.rows.length) throw new ClassificationConflictError()
      const draft = asDraft(draftResult.rows[0].snapshot)
      if (draft.baseVersion !== currentVersion) throw new ClassificationConflictError()
      const version = currentVersion + 1
      const publishedAtUtc = new Date().toISOString()
      const previous = await this.getPublished()
      const snapshot: ClassificationSnapshot = { version, publishedAtUtc, publishedBy: actor, groups: draft.groups, families: previous.families, classifications: draft.classifications }
      for (const group of snapshot.groups) {
        await client.query(`UPDATE ${this.schema}.operational_groups SET display_name=$2, description=$3, light_color=$4, dark_color=$5, icon_key=$6, sort_order=$7, updated_at=now() WHERE stable_key=$1`, [group.key, group.displayName, group.description, group.lightColor, group.darkColor, group.icon, group.sortOrder])
      }
      for (const item of snapshot.classifications) {
        await client.query(`INSERT INTO ${this.schema}.radius_state_classifications (identity_key,event_type,status_code,status_description,operational_group_id,process_family_id,display_label,explanation,confidence,needs_review,default_timeline_visibility,obsolete,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now()) ON CONFLICT (identity_key) DO UPDATE SET operational_group_id=excluded.operational_group_id, process_family_id=excluded.process_family_id, display_label=excluded.display_label, explanation=excluded.explanation, confidence=excluded.confidence, needs_review=excluded.needs_review, default_timeline_visibility=excluded.default_timeline_visibility, obsolete=excluded.obsolete, updated_at=now()`, [item.identity,item.eventType,item.statusCode,item.statusDescription,item.operationalGroupId,item.processFamilyId,item.displayLabel,item.explanation,item.confidence,item.needsReview,item.defaultTimelineVisibility,item.obsolete])
      }
      await client.query(`INSERT INTO ${this.schema}.classification_versions (version,published_at,published_by,change_count,snapshot) VALUES ($1,$2,$3,$4,$5::jsonb)`, [version,publishedAtUtc,actor,draft.changes.length,JSON.stringify(snapshot)])
      for (const change of draft.changes) await client.query(`INSERT INTO ${this.schema}.classification_audit (version,action,target,summary,actor,created_at) VALUES ($1,$2,$3,$4,$5,$6)`, [version,change.action,change.target,change.summary,change.actor,change.atUtc])
      await client.query(`INSERT INTO ${this.schema}.classification_audit (version,action,target,summary,actor,created_at) VALUES ($1,'PUBLISHED',$2,$3,$4,$5)`, [version,`version:${version}`,`Published ${draft.changes.length} draft changes.`,actor,publishedAtUtc])
      await client.query(`DELETE FROM ${this.schema}.classification_drafts WHERE singleton_id = true`)
      await client.query('COMMIT')
      return snapshot
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }

  async listVersions() {
    const result = await this.pool.query(`SELECT version, published_at AS "publishedAtUtc", published_by AS "publishedBy", change_count AS "changeCount" FROM ${this.schema}.classification_versions ORDER BY version DESC LIMIT 25`)
    return result.rows.map((row) => ({ version: Number(row.version), publishedAtUtc: new Date(row.publishedAtUtc).toISOString(), publishedBy: String(row.publishedBy), changeCount: Number(row.changeCount) }))
  }

  async listAudit() {
    const result = await this.pool.query(`SELECT id::text, version, action, target, summary, actor, created_at AS "atUtc" FROM ${this.schema}.classification_audit ORDER BY created_at DESC LIMIT 100`)
    return result.rows.map((row) => ({ id: String(row.id), version: row.version === null ? null : Number(row.version), action: row.action, target: String(row.target), summary: String(row.summary), actor: String(row.actor), atUtc: new Date(row.atUtc).toISOString() })) as ClassificationAuditEntry[]
  }
}
