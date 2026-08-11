import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import type pg from 'pg'
import {
  CLASSIFICATION_DOCUMENT_TYPE,
  ClassificationConflictError,
  PostgresClassificationRepository,
} from '../src/classification/classification-repository.js'
import type { ClassificationAuditChange, ClassificationDraft } from '../src/classification/models.js'
import { seededSnapshot } from '../src/classification/seeds.js'

interface Step {
  match: RegExp
  rows?: Record<string, unknown>[]
  rowCount?: number
}

class ScriptedPool {
  readonly statements: string[] = []
  readonly client = {
    query: async (text: string, values?: unknown[]) => this.run(text, values),
    release: () => {},
  }

  constructor(private readonly steps: Step[]) {}

  async connect() { return this.client }
  async query(text: string, values?: unknown[]) { return this.run(text, values) }

  private async run(text: string, _values?: unknown[]) {
    const normalized = text.replace(/\s+/g, ' ').trim()
    this.statements.push(normalized)
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(normalized)) return { rows: [], rowCount: null }
    const step = this.steps.shift()
    assert.ok(step, `Unexpected SQL: ${normalized}`)
    assert.match(normalized, step.match)
    return { rows: step.rows ?? [], rowCount: step.rowCount ?? (step.rows?.length ?? 0) }
  }

  assertComplete() { assert.equal(this.steps.length, 0, 'Not every expected SQL statement was executed') }
}

const change: ClassificationAuditChange = {
  action: 'DRAFT_CREATED', target: 'version:1', summary: 'Created a classification draft.',
  atUtc: '2026-08-11T18:00:00.000Z', actor: 'classification.admin',
}

function draft(revision = 1): ClassificationDraft {
  const seed = seededSnapshot()
  return {
    baseVersion: 1, revision, updatedAtUtc: change.atUtc, updatedBy: change.actor,
    groups: seed.groups, families: seed.families, classifications: seed.classifications, changes: [change],
  }
}

describe('single-document classification persistence', () => {
  it('defines exactly one application table with the required database and privilege guards', async () => {
    const migration = await readFile(new URL('../migrations/001_radius_semantic_classification.sql', import.meta.url), 'utf8')
    assert.equal(migration.match(/CREATE TABLE/gi)?.length, 1)
    assert.match(migration, /current_database\(\) <> 'processintelligence_db'/)
    assert.match(migration, /rolname = 'processintelligence_app'/)
    assert.match(migration, /CREATE TABLE public\.classification_documents/)
    assert.match(migration, /status IN \('draft', 'published'\)/)
    assert.match(migration, /UNIQUE \(document_type, version\)/)
    assert.match(migration, /WHERE status = 'draft'/)
    assert.match(migration, /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public\.classification_documents TO processintelligence_app/)
    assert.doesNotMatch(migration, /CREATE (DATABASE|SCHEMA|ROLE)|ALTER ROLE/i)
    assert.doesNotMatch(migration, /press_radius_db|telemetry|operational_groups|classification_versions|classification_drafts|classification_audit/i)
  })

  it('creates a draft document and atomically promotes that row while retaining published history', async () => {
    const seed = { ...seededSnapshot(), publishedAtUtc: '2026-08-11T17:00:00.000Z', publishedBy: 'system-seed' }
    const candidate = draft()
    const pool = new ScriptedPool([
      { match: /SELECT id, version, revision .* status = 'draft'/ },
      { match: /SELECT id, version .* status = 'published'/, rows: [{ id: 10, version: 1 }] },
      { match: /INSERT INTO public\.classification_documents/, rowCount: 1 },
      { match: /SELECT id, version, document .* status = 'published'/, rows: [{ id: 10, version: 1, document: seed }] },
      { match: /SELECT id, version, revision, document .* status = 'draft'/, rows: [{ id: 11, version: 2, revision: 1, document: candidate }] },
      { match: /UPDATE public\.classification_documents SET revision = .* status = 'published'/, rowCount: 1 },
      { match: /SELECT version, document, changed_by/, rows: [
        { version: 2, document: { ...seed, version: 2, changes: [change] }, changedBy: change.actor, publishedAtUtc: '2026-08-11T18:01:00.000Z' },
        { version: 1, document: { ...seed, changes: [] }, changedBy: 'system-seed', publishedAtUtc: seed.publishedAtUtc },
      ] },
    ])
    const repository = new PostgresClassificationRepository(pool as unknown as pg.Pool)
    await repository.saveDraft(candidate, null, change)
    const published = await repository.publishDraft(1, change.actor)
    assert.equal(published.version, 2)
    assert.equal(published.families.length, seed.families.length)
    const versions = await repository.listVersions()
    assert.deepEqual(versions.map(({ version }) => version), [2, 1])
    assert.equal(versions[0].changeCount, 1)
    assert.equal(pool.statements.filter((sql) => /public\.[a-z_]+/.test(sql) && !sql.includes('public.classification_documents')).length, 0)
    pool.assertComplete()
  })

  it('rejects a stale draft revision before issuing an update', async () => {
    const pool = new ScriptedPool([
      { match: /SELECT id, version, revision .* status = 'draft'/, rows: [{ id: 11, version: 2, revision: 2 }] },
    ])
    const repository = new PostgresClassificationRepository(pool as unknown as pg.Pool)
    await assert.rejects(() => repository.saveDraft(draft(2), 1, change), ClassificationConflictError)
    assert.equal(pool.statements.some((sql) => sql.startsWith('UPDATE public.classification_documents')), false)
    pool.assertComplete()
  })

  it('uses one stable document type and never stores an observed catalog row by itself', () => {
    assert.equal(CLASSIFICATION_DOCUMENT_TYPE, 'radius_semantic_classification')
  })
})
