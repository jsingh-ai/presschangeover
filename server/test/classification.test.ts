import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { InMemoryClassificationRepository } from '../src/classification/classification-repository.js'
import { ClassificationForbiddenError, ClassificationService } from '../src/classification/classification-service.js'
import { exactRadiusIdentity } from '../src/radius/radius-identity.js'
import type { RadiusIdentity } from '../src/classification/models.js'
import type { RadiusPressEpisodes, RadiusStateSegment, RadiusOfflineSegment } from '../src/radius/models.js'

const admin = { id: 'plant\\classification.admin', canEdit: true }
const viewer = { id: 'plant\\viewer', canEdit: false }

function identity(eventType: string, statusCode: string | null, statusDescription: string): RadiusIdentity {
  const raw = { eventType, statusCode, statusDescription }
  return { ...raw, identity: exactRadiusIdentity(raw) }
}

describe('Radius semantic classification', () => {
  it('resolves confirmed exact identities without collapsing distinct production states', async () => {
    const service = new ClassificationService(new InMemoryClassificationRepository())
    const run = await service.resolve(identity('G', '20', 'Run'))
    const verified = await service.resolve(identity('G', '150', 'Run Production'))
    assert.equal(run.operationalGroupKey, 'PRODUCTION')
    assert.equal(verified.operationalGroupKey, 'PRODUCTION')
    assert.notEqual(run.identity, verified.identity)
    assert.equal(run.statusDescription, 'Run')
    assert.equal(verified.statusDescription, 'Run Production')
  })

  it('uses conservative seeded meanings and visible fallback semantics', async () => {
    const service = new ClassificationService(new InMemoryClassificationRepository())
    for (const [raw, group] of [
      [identity('B', '64', 'Mechanical Problem'), 'MAINTENANCE_INTERVENTION'],
      [identity('B', '29', 'Electrical Problem'), 'MAINTENANCE_INTERVENTION'],
      [identity('B', '126', 'Web Break'), 'FAULT_RECOVERY'],
      [identity('B', '83', 'Drum Clean'), 'ROUTINE_PROCESS'],
      [identity('B', '450', 'Non Productive'), 'WAITING_IDLE_HOLD'],
    ] as const) assert.equal((await service.resolve(raw)).operationalGroupKey, group)
    const fallback = await service.resolve(identity('Z', null, 'Unreviewed operator entry'))
    assert.equal(fallback.operationalGroupKey, 'ADMIN_UNKNOWN')
    assert.equal(fallback.processFamilyKey, 'UNKNOWN')
    assert.equal(fallback.isFallback, true)
    assert.equal(fallback.needsReview, true)
  })

  it('merges a newly observed identity as Needs classification without persisting it', async () => {
    const repository = new InMemoryClassificationRepository()
    const service = new ClassificationService(repository)
    const unknown = identity('Z', null, 'New exact Radius value')
    const workspace = await service.getWorkspace([{ ...unknown, eventCount: 1, lastSeenUtc: '2026-08-11T18:00:00.000Z' }], viewer)
    const merged = workspace.effectiveClassifications.find(({ identity: key }) => key === unknown.identity)
    assert.equal(merged?.operationalGroupKey, 'ADMIN_UNKNOWN')
    assert.equal(merged?.confidence, 'LOW')
    assert.equal(merged?.needsReview, true)
    assert.equal(merged?.isFallback, true)
    assert.equal((await repository.getPublished()).classifications.some(({ identity: key }) => key === unknown.identity), false)
  })

  it('keeps group rename and state movement draft-only until atomic publication', async () => {
    const repository = new InMemoryClassificationRepository()
    const service = new ClassificationService(repository)
    const production = identity('G', '150', 'Run Production')
    const neutral = identity('B', '450', 'Non Productive')
    const draft = await service.createDraft(admin, 1)
    const renamed = await service.editGroup(admin, 'PRODUCTION', { displayName: 'Making Product' }, draft.revision)
    const moved = await service.editMappings(admin, [neutral], { operationalGroupKey: 'ADMIN_UNKNOWN', needsReview: true }, renamed.revision)
    assert.equal((await service.resolve(production)).operationalGroupName, 'Production')
    assert.equal((await service.resolve(neutral)).operationalGroupKey, 'WAITING_IDLE_HOLD')
    const workspace = await service.getWorkspace([], admin)
    assert.equal(workspace.effectiveGroups.find(({ key }) => key === 'PRODUCTION')?.displayName, 'Making Product')
    assert.equal(workspace.effectiveClassifications.find(({ identity: key }) => key === neutral.identity)?.operationalGroupKey, 'ADMIN_UNKNOWN')
    await service.publish(admin, moved.revision, [])
    assert.equal((await service.resolve(production)).operationalGroupName, 'Making Product')
    assert.equal((await service.resolve(production)).operationalGroupKey, 'PRODUCTION')
    assert.equal((await service.resolve(neutral)).operationalGroupKey, 'ADMIN_UNKNOWN')
    const after = await service.getWorkspace([], admin)
    assert.equal(after.published.version, 2)
    assert.equal(after.audit.some(({ action }) => action === 'GROUP_PRESENTATION_EDITED'), true)
    assert.equal(after.audit.some(({ action }) => action === 'STATE_MOVED'), true)
    assert.equal(after.audit.some(({ action }) => action === 'PUBLISHED'), true)
  })

  it('rejects unauthorized draft changes at the service boundary', async () => {
    const service = new ClassificationService(new InMemoryClassificationRepository())
    await assert.rejects(() => service.createDraft(viewer), ClassificationForbiddenError)
    await assert.rejects(() => service.editMappings(viewer, [identity('G', '20', 'Run')], { operationalGroupKey: 'ADMIN_UNKNOWN' }, null), ClassificationForbiddenError)
  })

  it('classifies raw segments while leaving offline outside every operational group', async () => {
    const service = new ClassificationService(new InMemoryClassificationRepository())
    const radius: RadiusStateSegment = { kind: 'radius', machineId: 203, pressKey: 'press3', displayName: 'Press 3', startUtc: '2026-08-10T10:00:00.000Z', endUtc: '2026-08-10T10:10:00.000Z', durationSeconds: 600, isOpen: false, sourceGeneration: 'compact', eventType: 'G', statusCode: '20', statusDescription: 'Run', isProduction: false }
    const offline: RadiusOfflineSegment = { kind: 'offline', machineId: 203, pressKey: 'press3', displayName: 'Press 3', startUtc: radius.endUtc, endUtc: '2026-08-10T10:20:00.000Z', durationSeconds: 600, isOpen: false, sourceGeneration: 'offline_inference', eventType: null, statusCode: null, statusDescription: null, isProduction: false }
    const result = await service.classifyPressEpisodes({ timelineSegments: [radius, offline], episodes: [], operationalGroups: [], analysis: {}, runComparison: {}, summary: {} } as unknown as RadiusPressEpisodes)
    assert.equal(result.timelineSegments[0].kind === 'radius' && result.timelineSegments[0].classification?.operationalGroupKey, 'PRODUCTION')
    assert.equal('classification' in result.timelineSegments[1], false)
    assert.equal(result.timelineSegments.filter(({ kind }) => kind === 'radius').reduce((sum, segment) => sum + segment.durationSeconds, 0), 600)
  })
})
