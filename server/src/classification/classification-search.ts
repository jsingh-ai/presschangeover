import type {
  ClassificationSearchResponse,
  ClassificationSearchResult,
  ClassificationSnapshot,
  ObservedRadiusIdentity,
} from './models.js'
import type { ObservedIdentitySnapshot } from './observed-identity-cache.js'

interface SearchField {
  value: string
  weight: number
  reason: string
}

interface SearchRecord {
  result: Omit<ClassificationSearchResult, 'score' | 'matchReason'>
  fields: SearchField[]
}

interface FieldMatch {
  score: number
  reason: string
}

const TYPE_ORDER: Record<ClassificationSearchResult['type'], number> = {
  exact_status: 0,
  family: 1,
  group: 2,
}

export function normalizeSearchText(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

function queryTokens(query: string): string[] {
  return [...new Set(query.split(' ').filter(Boolean))]
}

function fieldMatch(
  field: SearchField,
  query: string,
  tokens: string[],
): FieldMatch | null {
  const normalized = normalizeSearchText(field.value)
  if (!normalized) return null
  if (normalized === query) return { score: 1_000 + field.weight, reason: field.reason }
  if (normalized.startsWith(query)) return { score: 800 + field.weight, reason: field.reason }
  const fieldTokens = normalized.split(' ')
  if (tokens.every((token) => fieldTokens.includes(token))) {
    return { score: 600 + field.weight + tokens.length, reason: field.reason }
  }
  if (normalized.includes(query)) return { score: 500 + field.weight, reason: field.reason }
  const matchingTokens = tokens.filter((token) =>
    fieldTokens.some((candidate) => candidate.startsWith(token) || candidate.includes(token)),
  ).length
  if (matchingTokens === 0) return null
  return {
    score: 300 + field.weight + matchingTokens * 10,
    reason: field.reason,
  }
}

function bestMatch(record: SearchRecord, query: string): FieldMatch | null {
  const tokens = queryTokens(query)
  let best: FieldMatch | null = null
  for (const field of record.fields) {
    const candidate = fieldMatch(field, query, tokens)
    if (candidate && (!best || candidate.score > best.score)) best = candidate
  }
  return best
}

function buildPublishedRecords(snapshot: ClassificationSnapshot): SearchRecord[] {
  const groupsById = new Map(snapshot.groups.map((group) => [group.id, group]))
  const groupsByKey = new Map(snapshot.groups.map((group) => [group.key, group]))
  const familiesById = new Map(snapshot.families.map((family) => [family.id, family]))
  const familiesByKey = new Map(snapshot.families.map((family) => [family.key, family]))
  const familyGroups = new Map<string, Set<string>>()
  for (const mapping of snapshot.classifications) {
    const keys = familyGroups.get(mapping.processFamilyId) ?? new Set<string>()
    keys.add(mapping.operationalGroupId)
    familyGroups.set(mapping.processFamilyId, keys)
  }

  const groupRecords: SearchRecord[] = snapshot.groups.map((group) => ({
    result: {
      id: `group:${group.key}`,
      type: 'group',
      title: group.displayName,
      description: group.description,
      groups: [{ key: group.key, displayName: group.displayName }],
      family: null,
      eventType: null,
      statusCode: null,
      statusDescription: null,
      needsClassification: false,
      publishedClassification: true,
    },
    fields: [
      { value: group.displayName, weight: 80, reason: 'Group name match' },
      { value: group.key, weight: 60, reason: 'Group key match' },
      { value: group.description, weight: 20, reason: 'Description match' },
    ],
  }))

  const familyRecords: SearchRecord[] = snapshot.families.map((family) => {
    const groups = [...(familyGroups.get(family.id) ?? [])]
      .map((id) => groupsById.get(id))
      .filter((group): group is NonNullable<typeof group> => Boolean(group))
      .sort((left, right) => left.sortOrder - right.sortOrder)
      .map((group) => ({ key: group.key, displayName: group.displayName }))
    return {
      result: {
        id: `family:${family.key}`,
        type: 'family',
        title: family.displayName,
        description: family.description,
        groups,
        family: { key: family.key, displayName: family.displayName },
        eventType: null,
        statusCode: null,
        statusDescription: null,
        needsClassification: false,
        publishedClassification: true,
      },
      fields: [
        { value: family.displayName, weight: 80, reason: 'Family name match' },
        { value: family.key, weight: 60, reason: 'Family key match' },
        { value: family.description, weight: 20, reason: 'Description match' },
      ],
    }
  })

  const statusRecords: SearchRecord[] = snapshot.classifications.map((mapping) => {
    const group = groupsById.get(mapping.operationalGroupId) ?? groupsByKey.get(mapping.operationalGroupKey)
    const family = familiesById.get(mapping.processFamilyId) ?? familiesByKey.get(mapping.processFamilyKey)
    return {
      result: {
        id: `exact:${mapping.identity}`,
        type: 'exact_status',
        title: mapping.displayLabel?.trim() || mapping.statusDescription || '(blank Radius status)',
        description: mapping.explanation || null,
        groups: group ? [{ key: group.key, displayName: group.displayName }] : [],
        family: family ? { key: family.key, displayName: family.displayName } : null,
        eventType: mapping.eventType,
        statusCode: mapping.statusCode,
        statusDescription: mapping.statusDescription,
        needsClassification: false,
        publishedClassification: true,
      },
      fields: [
        { value: mapping.statusDescription, weight: 100, reason: 'Exact status match' },
        { value: mapping.displayLabel ?? '', weight: 90, reason: 'Status label match' },
        { value: mapping.statusCode ?? '', weight: 70, reason: 'Status code match' },
        { value: mapping.eventType, weight: 50, reason: 'Event type match' },
        { value: family?.displayName ?? '', weight: 35, reason: 'Family context match' },
        { value: group?.displayName ?? '', weight: 30, reason: 'Group context match' },
        { value: mapping.explanation, weight: 10, reason: 'Description match' },
      ],
    }
  })

  return [...statusRecords, ...familyRecords, ...groupRecords]
}

function unknownRecords(
  snapshot: ClassificationSnapshot,
  identities: ObservedRadiusIdentity[],
): SearchRecord[] {
  const published = new Set(snapshot.classifications.map(({ identity }) => identity))
  return identities
    .filter(({ identity }) => !published.has(identity))
    .map((identity) => ({
      result: {
        id: `observed:${identity.identity}`,
        type: 'exact_status' as const,
        title: identity.statusDescription || '(blank Radius status)',
        description: null,
        groups: [],
        family: null,
        eventType: identity.eventType,
        statusCode: identity.statusCode,
        statusDescription: identity.statusDescription,
        needsClassification: true,
        publishedClassification: false,
      },
      fields: [
        { value: identity.statusDescription, weight: 100, reason: 'Observed status match' },
        { value: identity.statusCode ?? '', weight: 70, reason: 'Status code match' },
        { value: identity.eventType, weight: 50, reason: 'Event type match' },
      ],
    }))
}

export class ClassificationSearchIndex {
  private publishedVersion: number | null = null
  private publishedRecords: SearchRecord[] = []

  search(
    snapshot: ClassificationSnapshot,
    query: string,
    limit: number,
    observed: ObservedIdentitySnapshot,
  ): ClassificationSearchResponse {
    if (this.publishedVersion !== snapshot.version) {
      this.publishedRecords = buildPublishedRecords(snapshot)
      this.publishedVersion = snapshot.version
    }
    const normalizedQuery = normalizeSearchText(query)
    const records = [
      ...this.publishedRecords,
      ...unknownRecords(snapshot, observed.identities),
    ]
    const results = records
      .map((record) => ({ record, match: bestMatch(record, normalizedQuery) }))
      .filter((candidate): candidate is { record: SearchRecord; match: FieldMatch } => Boolean(candidate.match))
      .map(({ record, match }) => ({
        ...record.result,
        score: match.score,
        matchReason: match.reason,
      }))
      .sort((left, right) =>
        right.score - left.score
        || TYPE_ORDER[left.type] - TYPE_ORDER[right.type]
        || left.title.localeCompare(right.title)
        || left.id.localeCompare(right.id),
      )
      .slice(0, limit)
    return {
      query: query.trim().replace(/\s+/g, ' '),
      publishedVersion: snapshot.version,
      observedIdentityStatus: observed.status,
      observedIdentityAsOf: observed.asOfUtc,
      results,
    }
  }
}
