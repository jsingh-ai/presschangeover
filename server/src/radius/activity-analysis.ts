import { DateTime } from 'luxon'
import type { ClassificationSnapshot } from '../classification/models.js'
import type {
  ActivityAnalysis,
  ActivityCatalogItem,
  ActivityOccurrence,
  ActivitySelection,
  RadiusOverview,
  RadiusStateSegment,
} from './models.js'
import { exactRadiusIdentity } from './radius-identity.js'

export const ACTIVITY_EVIDENCE_LIMIT = 100

const stateLabels: Record<string, string> = { G: 'Good', M: 'Make Ready', B: 'Bad', S: 'Radius S state' }

function median(values: number[]): number | null {
  if (!values.length) return null
  const ordered = [...values].sort((a, b) => a - b)
  const middle = Math.floor(ordered.length / 2)
  return ordered.length % 2 ? ordered[middle]! : (ordered[middle - 1]! + ordered[middle]!) / 2
}

function percentile(values: number[], percentileValue: number): number | null {
  if (!values.length) return null
  const ordered = [...values].sort((a, b) => a - b)
  return ordered[Math.ceil(percentileValue * ordered.length) - 1] ?? null
}

function percentage(value: number, denominator: number): number {
  return denominator > 0 ? value / denominator * 100 : 0
}

function classified(segment: RadiusStateSegment) {
  const value = segment.classification
  return {
    groupKey: !value || value.isFallback ? 'NEEDS_CLASSIFICATION' : value.operationalGroupKey,
    groupName: !value || value.isFallback ? 'Needs Classification' : value.operationalGroupName,
    familyKey: !value || value.isFallback ? 'NEEDS_CLASSIFICATION' : value.processFamilyKey,
    familyName: !value || value.isFallback ? 'Needs Classification' : value.processFamilyName,
    needsClassification: !value || value.isFallback,
  }
}

export function buildActivityCatalog(overview: RadiusOverview, snapshot: ClassificationSnapshot): ActivityCatalogItem[] {
  const items = new Map<string, ActivityCatalogItem>()
  for (const [eventType, label] of Object.entries(stateLabels)) items.set(`radius_state:${eventType}`, {
    level: 'radius_state', key: eventType, label, description: `Radius ${label} state`, eventType,
    statusCode: null, statusDescription: null, operationalGroupKey: null, operationalGroupName: null,
    processFamilyKey: null, processFamilyName: null, needsClassification: false,
  })
  for (const group of snapshot.groups) items.set(`operational_group:${group.key}`, {
    level: 'operational_group', key: group.key, label: group.displayName, description: group.description,
    eventType: null, statusCode: null, statusDescription: null, operationalGroupKey: group.key,
    operationalGroupName: group.displayName, processFamilyKey: null, processFamilyName: null, needsClassification: false,
  })
  const groupById = new Map(snapshot.groups.map((group) => [group.id, group]))
  const familyById = new Map(snapshot.families.map((family) => [family.id, family]))
  for (const family of snapshot.families) {
    const mapping = snapshot.classifications.find(({ processFamilyId }) => processFamilyId === family.id)
    const group = mapping ? groupById.get(mapping.operationalGroupId) : undefined
    items.set(`process_family:${family.key}`, {
      level: 'process_family', key: family.key, label: family.displayName, description: family.description,
      eventType: null, statusCode: null, statusDescription: null, operationalGroupKey: group?.key ?? null,
      operationalGroupName: group?.displayName ?? null, processFamilyKey: family.key, processFamilyName: family.displayName,
      needsClassification: false,
    })
  }
  for (const press of overview.presses) for (const segment of press.timelineSegments) {
    if (segment.kind !== 'radius') continue
    const identity = exactRadiusIdentity(segment)
    const semantic = classified(segment)
    items.set(`exact_status:${identity}`, {
      level: 'exact_status', key: identity, label: `${segment.eventType} / ${segment.statusCode ?? '—'} / ${segment.statusDescription}`,
      description: segment.classification?.explanation || null, eventType: segment.eventType, statusCode: segment.statusCode,
      statusDescription: segment.statusDescription, operationalGroupKey: semantic.groupKey,
      operationalGroupName: semantic.groupName, processFamilyKey: semantic.familyKey,
      processFamilyName: semantic.familyName, needsClassification: semantic.needsClassification,
    })
  }
  for (const mapping of snapshot.classifications) {
    const group = groupById.get(mapping.operationalGroupId)
    const family = familyById.get(mapping.processFamilyId)
    const catalogKey = `exact_status:${mapping.identity}`
    if (!items.has(catalogKey)) items.set(catalogKey, {
      level: 'exact_status', key: mapping.identity,
      label: `${mapping.eventType} / ${mapping.statusCode ?? '—'} / ${mapping.statusDescription}`,
      description: mapping.explanation || null, eventType: mapping.eventType, statusCode: mapping.statusCode,
      statusDescription: mapping.statusDescription, operationalGroupKey: group?.key ?? null,
      operationalGroupName: group?.displayName ?? null, processFamilyKey: family?.key ?? null,
      processFamilyName: family?.displayName ?? null, needsClassification: false,
    })
  }
  return [...items.values()].sort((a, b) => a.level.localeCompare(b.level) || a.label.localeCompare(b.label, undefined, { numeric: true }))
}

function matches(segment: RadiusStateSegment, selection: ActivitySelection): boolean {
  const semantic = classified(segment)
  if (selection.level === 'radius_state') return segment.eventType === selection.key
  if (selection.level === 'operational_group') return semantic.groupKey === selection.key
  if (selection.level === 'process_family') return semantic.familyKey === selection.key
  return exactRadiusIdentity(segment) === selection.key
}

function buildOccurrence(segments: RadiusStateSegment[], index: number): ActivityOccurrence {
  const durationSeconds = segments.reduce((sum, segment) => sum + segment.durationSeconds, 0)
  const identities = new Map<string, ActivityOccurrence['exactIdentities'][number]>()
  const states = new Set<string>()
  for (const segment of segments) {
    states.add(stateLabels[segment.eventType] ?? segment.eventType)
    const identity = exactRadiusIdentity(segment)
    const current = identities.get(identity)
    if (current) current.durationSeconds += segment.durationSeconds
    else identities.set(identity, { identity, eventType: segment.eventType, statusCode: segment.statusCode, statusDescription: segment.statusDescription, durationSeconds: segment.durationSeconds, needsClassification: classified(segment).needsClassification })
  }
  const primary = [...segments].sort((a, b) => b.durationSeconds - a.durationSeconds)[0]!
  const semantic = classified(primary)
  return {
    occurrenceId: `${primary.pressKey}:${segments[0]!.startUtc}:${index}`,
    pressKey: primary.pressKey, displayName: primary.displayName, startUtc: segments[0]!.startUtc,
    endUtc: segments.at(-1)!.endUtc, durationSeconds, eventType: states.size === 1 ? primary.eventType : 'MULTIPLE',
    radiusStateLabel: [...states].join(', '), operationalGroupKey: semantic.groupKey,
    operationalGroupName: semantic.groupName, processFamilyKey: semantic.familyKey,
    processFamilyName: semantic.familyName,
    segments: segments.map((segment, segmentIndex) => {
      const resolved = classified(segment)
      return {
        segmentId: `${primary.pressKey}:${segment.startUtc}:${segmentIndex}`,
        startUtc: segment.startUtc, endUtc: segment.endUtc, durationSeconds: segment.durationSeconds,
        eventType: segment.eventType, statusCode: segment.statusCode, statusDescription: segment.statusDescription,
        operationalGroupKey: resolved.groupKey, operationalGroupName: resolved.groupName,
        processFamilyKey: resolved.familyKey, processFamilyName: resolved.familyName,
        needsClassification: resolved.needsClassification,
      }
    }),
    exactIdentities: [...identities.values()].sort((a, b) => b.durationSeconds - a.durationSeconds || a.statusDescription.localeCompare(b.statusDescription)),
  }
}

function occurrencesFor(overview: RadiusOverview, selection: ActivitySelection): ActivityOccurrence[] {
  const result: ActivityOccurrence[] = []
  for (const press of overview.presses) {
    let current: RadiusStateSegment[] = []
    const finish = () => { if (current.length) result.push(buildOccurrence(current, result.length)); current = [] }
    for (const segment of press.timelineSegments) {
      if (segment.kind !== 'radius' || !matches(segment, selection)) { finish(); continue }
      const adjacent = current.length === 0 || current.at(-1)!.endUtc === segment.startUtc
      if (!adjacent) finish()
      current.push(segment)
    }
    finish()
  }
  return result.sort((a, b) => Date.parse(b.startUtc) - Date.parse(a.startUtc))
}

function trend(occurrences: ActivityOccurrence[], fromUtc: string, toUtc: string, zone: string) {
  const bucket: ActivityAnalysis['trendBucket'] = Date.parse(toUtc) - Date.parse(fromUtc) > 48 * 3_600_000 ? 'day' : 'hour'
  const values = new Map<string, { bucketStartUtc: string; durationSeconds: number; occurrenceCount: number }>()
  for (const occurrence of occurrences) {
    let cursor = DateTime.fromISO(occurrence.startUtc, { zone: 'utc' })
    const end = DateTime.fromISO(occurrence.endUtc, { zone: 'utc' })
    let first = true
    while (cursor < end) {
      const local = cursor.setZone(zone)
      const localStart = bucket === 'day' ? local.startOf('day') : local.startOf('hour')
      const next = bucket === 'day' ? localStart.plus({ days: 1 }) : localStart.plus({ hours: 1 })
      const partEnd = end < next.toUTC() ? end : next.toUTC()
      const key = localStart.toUTC().toISO()!
      const value = values.get(key) ?? { bucketStartUtc: key, durationSeconds: 0, occurrenceCount: 0 }
      value.durationSeconds += Math.max(0, partEnd.diff(cursor, 'seconds').seconds)
      if (first) value.occurrenceCount += 1
      values.set(key, value)
      cursor = partEnd
      first = false
    }
  }
  return { bucket, values: [...values.values()].sort((a, b) => a.bucketStartUtc.localeCompare(b.bucketStartUtc)) }
}

export function analyzeOperationalActivity(overview: RadiusOverview, snapshot: ClassificationSnapshot, requested?: ActivitySelection, evidencePage: { offset?: number; limit?: number } = {}): ActivityAnalysis {
  const catalog = buildActivityCatalog(overview, snapshot)
  const selection = catalog.find((item) => item.level === requested?.level && item.key === requested.key)
    ?? catalog.find((item) => item.level === 'operational_group' && item.key === 'MAINTENANCE_INTERVENTION')
    ?? catalog.find((item) => item.level === 'radius_state' && item.key === 'B')!
  const occurrences = occurrencesFor(overview, selection)
  const durations = occurrences.map(({ durationSeconds }) => durationSeconds)
  const totalDurationSeconds = durations.reduce((sum, value) => sum + value, 0)
  const observedSeconds = overview.presses.reduce((sum, press) => sum + press.observedSeconds, 0)
  const possibleSeconds = overview.presses.reduce((sum, press) => sum + press.rangeSeconds, 0)
  const mappedSeconds = overview.presses.flatMap(({ timelineSegments }) => timelineSegments).reduce((sum, segment) => sum + (segment.kind === 'radius' && segment.classification && !segment.classification.isFallback ? segment.durationSeconds : 0), 0)
  const perPress = new Map(overview.presses.map((press) => [press.pressKey, { pressKey: press.pressKey, displayName: press.displayName, observedSeconds: press.observedSeconds, rangeSeconds: press.rangeSeconds, occurrences: [] as ActivityOccurrence[] }]))
  for (const occurrence of occurrences) perPress.get(occurrence.pressKey)?.occurrences.push(occurrence)
  const pressBreakdown = [...perPress.values()].map((press) => {
    const pressDurations = press.occurrences.map(({ durationSeconds }) => durationSeconds)
    const durationSeconds = pressDurations.reduce((sum, value) => sum + value, 0)
    return { pressKey: press.pressKey, displayName: press.displayName, durationSeconds, occurrenceCount: press.occurrences.length, medianOccurrenceSeconds: median(pressDurations), shareOfObservedPercent: percentage(durationSeconds, press.observedSeconds), coveragePercent: percentage(press.observedSeconds, press.rangeSeconds) }
  }).sort((a, b) => b.durationSeconds - a.durationSeconds || a.displayName.localeCompare(b.displayName, undefined, { numeric: true }))
  const segmentMatches = overview.presses.flatMap(({ timelineSegments }) => timelineSegments.filter((segment): segment is RadiusStateSegment => segment.kind === 'radius' && matches(segment, selection)))
  const aggregate = <T extends string>(key: (segment: RadiusStateSegment) => T, label: (segment: RadiusStateSegment) => string) => {
    const map = new Map<T, { key: T; label: string; durationSeconds: number }>()
    for (const segment of segmentMatches) { const itemKey = key(segment); const item = map.get(itemKey) ?? { key: itemKey, label: label(segment), durationSeconds: 0 }; item.durationSeconds += segment.durationSeconds; map.set(itemKey, item) }
    return [...map.values()].map((item) => ({ ...item, percentage: percentage(item.durationSeconds, totalDurationSeconds) })).sort((a, b) => b.durationSeconds - a.durationSeconds || a.label.localeCompare(b.label))
  }
  const radiusStateComposition = aggregate((segment) => segment.eventType, (segment) => stateLabels[segment.eventType] ?? segment.eventType).map(({ key: eventType, ...item }) => ({ eventType, ...item }))
  const semanticBreakdown: ActivityAnalysis['semanticBreakdown'] = selection.level === 'radius_state'
    ? aggregate((segment) => classified(segment).groupKey, (segment) => classified(segment).groupName).map((item) => ({ ...item, level: 'operational_group' as const }))
    : selection.level === 'operational_group'
      ? aggregate((segment) => classified(segment).familyKey, (segment) => classified(segment).familyName).map((item) => ({ ...item, level: 'process_family' as const }))
      : aggregate((segment) => exactRadiusIdentity(segment), (segment) => `${segment.eventType} / ${segment.statusCode ?? '—'} / ${segment.statusDescription}`).map((item) => ({ ...item, level: 'exact_status' as const }))
  const bucketed = trend(occurrences, overview.fromUtc, overview.toUtc, overview.plantTimeZone)
  const distribution = [
    { key: 'under_5m', label: '< 5m', min: 0, max: 300 }, { key: '5_15m', label: '5–15m', min: 300, max: 900 },
    { key: '15_30m', label: '15–30m', min: 900, max: 1_800 }, { key: '30_60m', label: '30–60m', min: 1_800, max: 3_600 },
    { key: 'over_60m', label: '> 60m', min: 3_600, max: Number.POSITIVE_INFINITY },
  ].map(({ key, label, min, max }) => ({ key, label, occurrenceCount: durations.filter((value) => value >= min && value < max).length }))
  return {
    fromUtc: overview.fromUtc, toUtc: overview.toUtc, classificationVersion: snapshot.version, selection, catalog,
    summary: { totalDurationSeconds, occurrenceCount: occurrences.length, medianOccurrenceSeconds: median(durations), p95OccurrenceSeconds: durations.length >= 20 ? percentile(durations, .95) : null, longestOccurrenceSeconds: Math.max(0, ...durations), pressesObserved: pressBreakdown.filter(({ occurrenceCount }) => occurrenceCount > 0).length, scopePresses: overview.presses.length, shareOfObservedPercent: percentage(totalDurationSeconds, observedSeconds), sourceCoveragePercent: percentage(observedSeconds, possibleSeconds), classificationCoveragePercent: percentage(mappedSeconds, observedSeconds) },
    pressBreakdown, radiusStateComposition, semanticBreakdown, trend: bucketed.values, trendBucket: bucketed.bucket,
    durationDistribution: distribution,
    occurrences: occurrences.slice(evidencePage.offset ?? 0, (evidencePage.offset ?? 0) + Math.min(ACTIVITY_EVIDENCE_LIMIT, evidencePage.limit ?? ACTIVITY_EVIDENCE_LIMIT)),
    totalOccurrenceCount: occurrences.length,
    evidenceOffset: evidencePage.offset ?? 0,
    evidenceLimit: Math.min(ACTIVITY_EVIDENCE_LIMIT, evidencePage.limit ?? ACTIVITY_EVIDENCE_LIMIT),
  }
}
