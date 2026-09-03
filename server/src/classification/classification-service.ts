import { exactRadiusIdentity } from '../radius/radius-identity.js'
import type { RadiusOverview, RadiusStatusSegment } from '../radius/models.js'
import { ClassificationConflictError, type ClassificationRepository } from './classification-repository.js'
import type {
  ClassificationActor,
  ClassificationAuditChange,
  ClassificationDraft,
  ClassificationSnapshot,
  ClassificationValidation,
  ClassificationWorkspace,
  MappingConfidence,
  ObservedRadiusIdentity,
  OperationalGroup,
  OperationalGroupKey,
  ProcessFamilyKey,
  RadiusIdentity,
  RadiusStateClassification,
  ResolvedRadiusClassification,
} from './models.js'
import { OPERATIONAL_GROUP_KEYS, PROCESS_FAMILY_KEYS } from './models.js'
import { SEEDED_OPERATIONAL_GROUPS } from './seeds.js'
import type { ObservedIdentityStatus } from './observed-identity-cache.js'
import { buildOverviewDecisionSupport } from '../radius/overview-analytics.js'

export class ClassificationValidationError extends Error {
  constructor(public readonly errors: string[]) { super('classification_validation_failed'); this.name = 'ClassificationValidationError' }
}

export class ClassificationForbiddenError extends Error {
  constructor() { super('classification_forbidden'); this.name = 'ClassificationForbiddenError' }
}

export function assertClassificationEditor(actor: ClassificationActor) {
  if (!actor.canEdit) throw new ClassificationForbiddenError()
}

function nowChange(actor: ClassificationActor, action: ClassificationAuditChange['action'], target: string, summary: string): ClassificationAuditChange {
  return { action, target, summary, atUtc: new Date().toISOString(), actor: actor.id }
}

function fallbackClassification(identity: RadiusIdentity, snapshot: ClassificationSnapshot): ResolvedRadiusClassification {
  const group = snapshot.groups.find(({ key }) => key === 'ADMIN_UNKNOWN')!
  const family = snapshot.families.find(({ key }) => key === 'UNKNOWN')!
  return {
    ...identity, operationalGroupId: group.id, operationalGroupKey: group.key,
    operationalGroupName: group.displayName, operationalGroupDescription: group.description,
    operationalGroupLightColor: group.lightColor, operationalGroupDarkColor: group.darkColor, operationalGroupIcon: group.icon,
    processFamilyId: family.id, processFamilyKey: family.key, processFamilyName: family.displayName,
    displayLabel: null, explanation: 'No published exact mapping exists. Review is required before assigning an operational meaning.',
    confidence: 'LOW', needsReview: true, defaultTimelineVisibility: true, obsolete: false,
    mappingVersion: snapshot.version, isFallback: true,
  }
}

function resolveFromSnapshot(identity: RadiusIdentity, snapshot: ClassificationSnapshot): ResolvedRadiusClassification {
  const mapping = snapshot.classifications.find((candidate) => candidate.identity === identity.identity)
  if (!mapping) return fallbackClassification(identity, snapshot)
  const group = snapshot.groups.find(({ id }) => id === mapping.operationalGroupId) ?? snapshot.groups.find(({ key }) => key === 'ADMIN_UNKNOWN')!
  const family = snapshot.families.find(({ id }) => id === mapping.processFamilyId) ?? snapshot.families.find(({ key }) => key === 'UNKNOWN')!
  return {
    ...mapping, operationalGroupId: group.id, operationalGroupKey: group.key,
    operationalGroupName: group.displayName, operationalGroupDescription: group.description,
    operationalGroupLightColor: group.lightColor, operationalGroupDarkColor: group.darkColor, operationalGroupIcon: group.icon,
    processFamilyId: family.id, processFamilyKey: family.key, processFamilyName: family.displayName,
    mappingVersion: snapshot.version, isFallback: false,
  }
}

function classifySegment(segment: RadiusStatusSegment, snapshot: ClassificationSnapshot): RadiusStatusSegment {
  if (segment.kind === 'offline') return segment
  const identity = { identity: exactRadiusIdentity(segment), eventType: segment.eventType, statusCode: segment.statusCode, statusDescription: segment.statusDescription }
  return { ...segment, classification: resolveFromSnapshot(identity, snapshot) }
}

function colorValid(value: string) { return /^#[0-9A-Fa-f]{6}$/.test(value) }

export class ClassificationService {
  constructor(private readonly repository: ClassificationRepository) {}
  get persistence() { return this.repository.persistence }
  async initialize() { await this.repository.initialize() }

  async getPublishedSnapshot() { return this.repository.getPublished() }
  async getPublishedGroups() {
    return [...(await this.repository.getPublished()).groups]
      .sort((left, right) => left.sortOrder - right.sortOrder)
  }
  async getPublishedFamilies() {
    return [...(await this.repository.getPublished()).families]
      .sort((left, right) => left.sortOrder - right.sortOrder)
  }
  async getPublishedClassifications() {
    return (await this.repository.getPublished()).classifications
  }
  async getDraft() { return this.repository.getDraft() }
  async listVersions() { return this.repository.listVersions() }
  async listAudit() { return this.repository.listAudit() }
  async resolve(identity: RadiusIdentity) { return resolveFromSnapshot(identity, await this.repository.getPublished()) }

  async classifyOverview(overview: RadiusOverview): Promise<RadiusOverview> {
    const snapshot = await this.repository.getPublished()
    const classified = { ...overview, classificationVersion: snapshot.version, operationalGroups: snapshot.groups, presses: overview.presses.map((press) => ({ ...press, timelineSegments: press.timelineSegments.map((segment) => classifySegment(segment, snapshot)) })) }
    return { ...classified, decisionSupport: buildOverviewDecisionSupport(classified) }
  }

  async getWorkspace(
    observedIdentities: ObservedRadiusIdentity[],
    actor: ClassificationActor,
    observedIdentityStatus: ObservedIdentityStatus = 'fresh',
    observedIdentityAsOf: string | null = null,
  ): Promise<ClassificationWorkspace> {
    const [published, draft, versions, audit] = await Promise.all([this.repository.getPublished(), this.repository.getDraft(), this.repository.listVersions(), this.repository.listAudit()])
    const effectiveGroups = draft?.groups ?? published.groups
    const effectiveMappings = draft?.classifications ?? published.classifications
    const observedByIdentity = new Map(observedIdentities.map((item) => [item.identity, item]))
    const mappedByIdentity = new Map(effectiveMappings.map((item) => [item.identity, item]))
    const effectiveClassifications = observedIdentities.map((observed) => {
      const mapping = mappedByIdentity.get(observed.identity)
      if (mapping) return { ...mapping, eventCount: observed.eventCount, lastSeenUtc: observed.lastSeenUtc, isFallback: false }
      const fallback = fallbackClassification(observed, { ...published, groups: effectiveGroups, classifications: effectiveMappings })
      return { ...fallback, eventCount: observed.eventCount, lastSeenUtc: observed.lastSeenUtc, isFallback: true }
    })
    for (const mapping of effectiveMappings) if (!observedByIdentity.has(mapping.identity)) effectiveClassifications.push({ ...mapping, eventCount: 0, lastSeenUtc: null, isFallback: false })
    return {
      published, draft, effectiveGroups: [...effectiveGroups].sort((a, b) => a.sortOrder - b.sortOrder), effectiveClassifications,
      observedIdentities, families: published.families, versions, audit,
      unmappedCount: effectiveClassifications.filter(({ isFallback }) => isFallback).length,
      reviewRequiredCount: effectiveClassifications.filter(({ needsReview }) => needsReview).length,
      canEdit: actor.canEdit, actor: actor.id || null, persistence: this.repository.persistence,
      observedIdentityStatus, observedIdentityAsOf,
    }
  }

  async createDraft(actor: ClassificationActor, expectedVersion?: number) {
    assertClassificationEditor(actor)
    const [published, current] = await Promise.all([this.repository.getPublished(), this.repository.getDraft()])
    if (current) return current
    if (expectedVersion !== undefined && expectedVersion !== published.version) throw new ClassificationConflictError()
    const atUtc = new Date().toISOString()
    const change = nowChange(actor, 'DRAFT_CREATED', `version:${published.version}`, 'Created a classification draft.')
    const draft: ClassificationDraft = { baseVersion: published.version, revision: 1, updatedAtUtc: atUtc, updatedBy: actor.id, groups: structuredClone(published.groups), families: structuredClone(published.families), classifications: structuredClone(published.classifications), changes: [change] }
    return this.repository.saveDraft(draft, null, change)
  }

  private async editableDraft(actor: ClassificationActor, expectedRevision: number | null) {
    assertClassificationEditor(actor)
    const current = await this.repository.getDraft()
    if (!current) {
      if (expectedRevision !== null) throw new ClassificationConflictError()
      return { draft: await this.createDraft(actor), repositoryRevision: 1 }
    }
    if (expectedRevision !== current.revision) throw new ClassificationConflictError()
    return { draft: current, repositoryRevision: current.revision }
  }

  async editGroup(actor: ClassificationActor, groupKey: OperationalGroupKey, input: Partial<Pick<OperationalGroup, 'displayName' | 'description' | 'lightColor' | 'darkColor' | 'icon' | 'sortOrder'>>, expectedRevision: number | null, restoreDefault = false) {
    if (!OPERATIONAL_GROUP_KEYS.includes(groupKey)) throw new ClassificationValidationError(['Unknown stable group key.'])
    const { draft, repositoryRevision } = await this.editableDraft(actor, expectedRevision)
    const index = draft.groups.findIndex(({ key }) => key === groupKey)
    if (index < 0) throw new ClassificationValidationError(['Operational group is missing from the draft.'])
    const seeded = SEEDED_OPERATIONAL_GROUPS.find(({ key }) => key === groupKey)!
    const current = draft.groups[index]
    const next = restoreDefault ? structuredClone(seeded) : { ...current, ...input, id: current.id, key: current.key }
    if (!next.displayName.trim() || !next.description.trim()) throw new ClassificationValidationError(['Display name and description are required.'])
    if (!colorValid(next.lightColor) || !colorValid(next.darkColor)) throw new ClassificationValidationError(['Colors must use six-digit hexadecimal values.'])
    const change = nowChange(actor, 'GROUP_PRESENTATION_EDITED', `group:${groupKey}`, `${restoreDefault ? 'Restored defaults for' : 'Edited'} ${current.displayName}.`)
    draft.groups[index] = next
    draft.revision = repositoryRevision + 1; draft.updatedAtUtc = change.atUtc; draft.updatedBy = actor.id; draft.changes.push(change)
    return this.repository.saveDraft(draft, repositoryRevision, change)
  }

  async editMappings(actor: ClassificationActor, identities: RadiusIdentity[], input: { operationalGroupKey?: OperationalGroupKey; processFamilyKey?: ProcessFamilyKey; displayLabel?: string | null; explanation?: string; confidence?: MappingConfidence; needsReview?: boolean; defaultTimelineVisibility?: boolean; obsolete?: boolean }, expectedRevision: number | null) {
    if (!identities.length) throw new ClassificationValidationError(['At least one exact Radius identity is required.'])
    if (input.operationalGroupKey && !OPERATIONAL_GROUP_KEYS.includes(input.operationalGroupKey)) throw new ClassificationValidationError(['Unknown operational group.'])
    if (input.processFamilyKey && !PROCESS_FAMILY_KEYS.includes(input.processFamilyKey)) throw new ClassificationValidationError(['Unknown process family.'])
    const { draft, repositoryRevision } = await this.editableDraft(actor, expectedRevision)
    const published = await this.repository.getPublished()
    const group = draft.groups.find(({ key }) => key === (input.operationalGroupKey ?? 'ADMIN_UNKNOWN'))!
    const family = published.families.find(({ key }) => key === (input.processFamilyKey ?? 'UNKNOWN'))!
    for (const identity of identities) {
      const index = draft.classifications.findIndex((item) => item.identity === identity.identity)
      const existing = index >= 0 ? draft.classifications[index] : undefined
      const item: RadiusStateClassification = {
        ...identity,
        operationalGroupId: input.operationalGroupKey ? group.id : existing?.operationalGroupId ?? group.id,
        operationalGroupKey: input.operationalGroupKey ?? existing?.operationalGroupKey ?? group.key,
        processFamilyId: input.processFamilyKey ? family.id : existing?.processFamilyId ?? family.id,
        processFamilyKey: input.processFamilyKey ?? existing?.processFamilyKey ?? family.key,
        displayLabel: input.displayLabel !== undefined ? input.displayLabel?.trim() || null : existing?.displayLabel ?? null,
        explanation: input.explanation !== undefined ? input.explanation.trim() : existing?.explanation ?? '',
        confidence: input.confidence ?? existing?.confidence ?? 'LOW', needsReview: input.needsReview ?? existing?.needsReview ?? true,
        defaultTimelineVisibility: input.defaultTimelineVisibility ?? existing?.defaultTimelineVisibility ?? true,
        obsolete: input.obsolete ?? existing?.obsolete ?? false,
      }
      if (index >= 0) draft.classifications[index] = item; else draft.classifications.push(item)
    }
    const moved = input.operationalGroupKey !== undefined
    const change = nowChange(actor, moved ? 'STATE_MOVED' : 'STATE_MAPPING_EDITED', identities.map(({ identity }) => identity).join(','), `${moved ? 'Moved' : 'Edited'} ${identities.length} exact Radius ${identities.length === 1 ? 'identity' : 'identities'}${moved ? ` to ${group.displayName}` : ''}.`)
    draft.revision = repositoryRevision + 1; draft.updatedAtUtc = change.atUtc; draft.updatedBy = actor.id; draft.changes.push(change)
    return this.repository.saveDraft(draft, repositoryRevision, change)
  }

  validateDraft(draft: ClassificationDraft | null, observed: ObservedRadiusIdentity[]): ClassificationValidation {
    if (!draft) return { valid: false, errors: ['No draft exists.'], warnings: [], mappedCount: 0, fallbackCount: observed.length, reviewRequiredCount: observed.length }
    const errors: string[] = []
    if (new Set(draft.groups.map(({ key }) => key)).size !== OPERATIONAL_GROUP_KEYS.length) errors.push('All stable operational groups must remain present.')
    if (draft.groups.some(({ lightColor, darkColor }) => !colorValid(lightColor) || !colorValid(darkColor))) errors.push('Every operational group must have valid light and dark colors.')
    const identities = new Set(draft.classifications.map(({ identity }) => identity))
    const fallbackCount = observed.filter(({ identity }) => !identities.has(identity)).length
    const reviewRequiredCount = draft.classifications.filter(({ needsReview }) => needsReview).length + fallbackCount
    return { valid: errors.length === 0, errors, warnings: fallbackCount ? [`${fallbackCount} observed ${fallbackCount === 1 ? 'identity uses' : 'identities use'} the visible Administrative & Unknown fallback.`] : [], mappedCount: observed.length - fallbackCount, fallbackCount, reviewRequiredCount }
  }

  async validateCurrentDraft(observed: ObservedRadiusIdentity[]) { return this.validateDraft(await this.repository.getDraft(), observed) }

  async publish(actor: ClassificationActor, expectedRevision: number, observed: ObservedRadiusIdentity[]) {
    assertClassificationEditor(actor)
    const draft = await this.repository.getDraft()
    if (!draft || draft.revision !== expectedRevision) throw new ClassificationConflictError()
    const validation = this.validateDraft(draft, observed)
    if (!validation.valid) throw new ClassificationValidationError(validation.errors)
    return this.repository.publishDraft(expectedRevision, actor.id)
  }

  async discard(actor: ClassificationActor, expectedRevision: number) {
    assertClassificationEditor(actor)
    const change = nowChange(actor, 'DRAFT_DISCARDED', 'draft', 'Discarded the current classification draft.')
    await this.repository.discardDraft(expectedRevision, change)
  }
}
