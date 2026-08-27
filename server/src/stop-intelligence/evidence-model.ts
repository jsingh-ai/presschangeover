import { JOB_CONTEXT_SETTLING_MS, usableJobIdentity } from '../job-intelligence/engine.js'
import type { RadiusPressKey } from '../radius/models.js'
import type { PressSemanticSignalWithIdentity } from '../telemetry/telemetry-foundation-service.js'
import type { TelemetryChange, TelemetrySample } from '../telemetry/telemetry-contracts.js'
import type { PhysicalStopSegment, StopFamilyEvidence, StopIdentityAssociationConfiguration, StopIdentityEvidence, StopIdentityField, StopIdentityUsefulness, StopSetupFamily } from './contracts.js'

export const STOP_FAMILY_EVIDENCE_WINDOW_MS = JOB_CONTEXT_SETTLING_MS

interface IdentityDefinition { field: StopIdentityField; canonicalId: string | null; usefulness: StopIdentityUsefulness; reason: string }
interface IdentityCluster { changes: TelemetryChange[]; firstAt: number; lastAt: number; settledAt: number; settled: boolean; before: string | null; after: string | null }

const IDENTITY_DEFINITIONS: Record<'press14' | 'press15', IdentityDefinition[]> = {
  press14: [
    { field: 'recipe', canonicalId: 'production.recipe', usefulness: 'STRONG', reason: 'Press 14 Recipe is the validated primary product identity.' },
    { field: 'previous_order', canonicalId: 'production.previous_order', usefulness: 'MEDIUM', reason: 'Press 14 Previous Order is secondary transition evidence when mapped.' },
    { field: 'customer', canonicalId: 'production.customer', usefulness: 'WEAK', reason: 'Press 14 Customer is supporting context only.' },
    { field: 'order', canonicalId: 'production.order', usefulness: 'UNUSABLE', reason: 'Press 14 primary Order is validated as unusable for changeover identity.' },
    { field: 'material', canonicalId: 'production.material', usefulness: 'UNAVAILABLE', reason: 'Press 14 Material identity is unavailable.' },
  ],
  press15: [
    { field: 'order', canonicalId: 'production.order', usefulness: 'STRONG', reason: 'Press 15 Order is the validated primary product identity.' },
    { field: 'previous_order', canonicalId: 'production.previous_order', usefulness: 'MEDIUM', reason: 'Press 15 Previous Order is secondary transition evidence when mapped.' },
    { field: 'recipe', canonicalId: 'production.recipe', usefulness: 'WEAK', reason: 'Press 15 Recipe is normally constant and is supporting context only.' },
    { field: 'customer', canonicalId: 'production.customer', usefulness: 'WEAK', reason: 'Press 15 Customer is normally constant and is supporting context only.' },
    { field: 'material', canonicalId: 'production.material', usefulness: 'UNAVAILABLE', reason: 'Press 15 Material identity is unavailable.' },
  ],
}

export function stopIdentityDefinitions(pressKey: RadiusPressKey): IdentityDefinition[] {
  return pressKey === 'press14' || pressKey === 'press15' ? IDENTITY_DEFINITIONS[pressKey] : []
}

export const STOP_FAMILY_CANONICAL_PATTERNS: Array<{ family: StopSetupFamily; matches: (canonicalId: string) => boolean }> = [
  { family: 'DECK', matches: (value) => value.startsWith('deck.') },
  { family: 'ANILOX', matches: (value) => value.startsWith('anilox.drive.') },
  { family: 'WASH_PUMP_INK', matches: (value) => value === 'ink.washup.state' || value === 'ink.pump.status' || value.startsWith('ink.viscosity.') || value.startsWith('ink.temperature.') },
  { family: 'IMPRESSION', matches: (value) => value.startsWith('impression.') },
  { family: 'REGISTRATION', matches: (value) => value.startsWith('register.') },
  { family: 'WINDER_CORE_WIDTH', matches: (value) => /(?:winder|core.*width|width.*core)/i.test(value) },
  { family: 'WEB_TENSION_SETPOINT', matches: (value) => /(?:tension|web_tension)/i.test(value) && /(?:setpoint|rated|command)/i.test(value) },
]

const validTime = (value: string) => Number.isFinite(Date.parse(value))
const goodQuality = (value: string) => !/bad|false|invalid|unavailable|no_data|nodata/i.test(value)
const scalarKey = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? String(value) : typeof value === 'string' || typeof value === 'boolean' ? String(value).trim() : ''
const segmentEnd = (segment: PhysicalStopSegment, rangeEndUtc: string) => Date.parse(segment.endAt ?? rangeEndUtc)

function identityClusters(signal: PressSemanticSignalWithIdentity, evidenceCutoffUtc: string): IdentityCluster[] {
  const cutoff = Date.parse(evidenceCutoffUtc)
  const changes = signal.changes.filter((value) => validTime(value.observedAtUtc) && Date.parse(value.observedAtUtc) <= cutoff && goodQuality(value.qualityState)).sort((left, right) => Date.parse(left.observedAtUtc) - Date.parse(right.observedAtUtc))
  const grouped: TelemetryChange[][] = []
  for (const change of changes) {
    const cluster = grouped.at(-1)
    if (!cluster || Date.parse(change.observedAtUtc) - Date.parse(cluster.at(-1)!.observedAtUtc) > JOB_CONTEXT_SETTLING_MS) grouped.push([change])
    else cluster.push(change)
  }
  let resolved = usableJobIdentity(signal.seed?.value, signal.seed?.qualityState)
  return grouped.flatMap((cluster) => {
    const first = cluster[0]!; const last = cluster.at(-1)!
    const before = resolved ?? usableJobIdentity(first.previousValue, first.previousQualityState)
    const after = usableJobIdentity(last.value, last.qualityState)
    const settledAt = Date.parse(last.observedAtUtc) + JOB_CONTEXT_SETTLING_MS
    const settled = settledAt <= cutoff
    if (settled && after) resolved = after
    return before && after && before !== after ? [{ changes: cluster, firstAt: Date.parse(first.observedAtUtc), lastAt: Date.parse(last.observedAtUtc), settledAt, settled, before, after }] : []
  })
}

function associationStopIndex(cluster: IdentityCluster, segments: PhysicalStopSegment[], rangeEndUtc: string, configuration: StopIdentityAssociationConfiguration): number | null {
  const beforeMs = configuration.identityContextBeforeSeconds * 1_000; const afterMs = configuration.identityContextAfterSeconds * 1_000
  const candidates = segments.flatMap((segment, index) => {
    const start = Date.parse(segment.startAt); const end = segmentEnd(segment, rangeEndUtc)
    if (cluster.firstAt < start - beforeMs || cluster.firstAt > end + afterMs) return []
    const distance = cluster.firstAt < start ? start - cluster.firstAt : cluster.firstAt > end ? cluster.firstAt - end : 0
    return [{ index, distance, start }]
  }).sort((left, right) => left.distance - right.distance || left.start - right.start)
  return candidates[0]?.index ?? null
}

function identityAt(signal: PressSemanticSignalWithIdentity, clusters: IdentityCluster[], at: number): string | null {
  let value = usableJobIdentity(signal.seed?.value, signal.seed?.qualityState)
  for (const cluster of clusters) if (cluster.settled && cluster.settledAt <= at && cluster.after) value = cluster.after
  return value
}

function associationOffsetSeconds(cluster: IdentityCluster, segment: PhysicalStopSegment, rangeEndUtc: string): number {
  const start = Date.parse(segment.startAt); const end = segmentEnd(segment, rangeEndUtc)
  return cluster.firstAt < start ? (cluster.firstAt - start) / 1_000 : cluster.firstAt > end ? (cluster.firstAt - end) / 1_000 : 0
}

function identityEvidence(definition: IdentityDefinition, signal: PressSemanticSignalWithIdentity | undefined, segment: PhysicalStopSegment, segmentIndex: number, allSegments: PhysicalStopSegment[], rangeEndUtc: string, evidenceCutoffUtc: string, configuration: StopIdentityAssociationConfiguration): StopIdentityEvidence {
  const unavailable = { field: definition.field, usefulness: definition.usefulness, available: false, canonicalId: definition.canonicalId, beforeValue: null, afterValue: null, changed: false, settled: false, firstChangeAtUtc: null, lastChangeAtUtc: null, settledAtUtc: null, associationOffsetSeconds: null, intermediateValues: [], reason: `${definition.reason} No supported observations were available.` } satisfies StopIdentityEvidence
  if (!signal || definition.usefulness === 'UNAVAILABLE') return unavailable
  const clusters = identityClusters(signal, evidenceCutoffUtc)
  const associated = clusters.filter((cluster) => associationStopIndex(cluster, allSegments, rangeEndUtc, configuration) === segmentIndex)
  if (!associated.length) {
    const value = identityAt(signal, clusters, Date.parse(segment.startAt))
    return { ...unavailable, available: Boolean(value || signal.seed || signal.changes.length), beforeValue: value, afterValue: value, reason: `${definition.reason} No transition was uniquely associated with this physical stop.` }
  }
  const first = associated[0]!; const last = associated.at(-1)!; const changed = definition.usefulness !== 'UNUSABLE' && Boolean(first.before && last.after && first.before !== last.after)
  const settled = changed && associated.length === 1 && first.settled
  const offset = associationOffsetSeconds(first, segment, rangeEndUtc)
  return { field: definition.field, usefulness: definition.usefulness, available: true, canonicalId: definition.canonicalId, beforeValue: first.before, afterValue: last.after, changed, settled, firstChangeAtUtc: new Date(first.firstAt).toISOString(), lastChangeAtUtc: new Date(last.lastAt).toISOString(), settledAtUtc: settled ? new Date(first.settledAt).toISOString() : null, associationOffsetSeconds: offset, intermediateValues: [...new Set(associated.flatMap((cluster) => cluster.changes.flatMap((value) => usableJobIdentity(value.value, value.qualityState) ?? [])))], reason: definition.usefulness === 'UNUSABLE' ? definition.reason : associated.length > 1 ? `${definition.reason} Multiple separated identity transitions were closest to this stop, so the association remains conflicting.` : `${definition.reason} One transition was uniquely associated ${offset < 0 ? `${Math.abs(offset)} seconds before the stop` : offset > 0 ? `${offset} seconds after recovery` : 'inside the physical stop'}${settled ? ' and settled for five minutes' : ' but had not settled at the evidence cutoff'}.` }
}

function activityPoints(signal: PressSemanticSignalWithIdentity, fromMs: number, toMs: number): TelemetrySample[] {
  const changes = signal.changes.filter((value) => { const at = Date.parse(value.observedAtUtc); return at >= fromMs && at <= toMs && goodQuality(value.qualityState) && scalarKey(value.value) !== scalarKey(value.previousValue) })
  if (changes.length) return changes
  const samples = signal.samples.filter((value) => { const at = Date.parse(value.observedAtUtc); return at >= fromMs && at <= toMs && goodQuality(value.qualityState) })
  return new Set(samples.map((value) => scalarKey(value.value))).size > 1 ? samples : []
}

function familyEvidence(family: StopSetupFamily, signals: PressSemanticSignalWithIdentity[], segment: PhysicalStopSegment, rangeEndUtc: string, evidenceCutoffUtc: string, available: boolean): StopFamilyEvidence {
  const definition = STOP_FAMILY_CANONICAL_PATTERNS.find((value) => value.family === family)!
  const candidates = signals.filter((value) => definition.matches(value.canonicalId))
  const fromMs = Date.parse(segment.startAt) - STOP_FAMILY_EVIDENCE_WINDOW_MS; const toMs = Math.min(segmentEnd(segment, rangeEndUtc) + STOP_FAMILY_EVIDENCE_WINDOW_MS, Date.parse(evidenceCutoffUtc))
  const observed = candidates.flatMap((signal) => activityPoints(signal, fromMs, toMs).map((point) => ({ signal, point }))).sort((left, right) => Date.parse(left.point.observedAtUtc) - Date.parse(right.point.observedAtUtc))
  const identities = new Set(observed.map(({ signal }) => `${signal.canonicalId}:${signal.deckNumber ?? ''}`))
  const deckNumbers = [...new Set(observed.flatMap(({ signal }) => signal.deckNumber === null ? [] : [signal.deckNumber]))].sort((left, right) => left - right)
  return { family, available, observed: observed.length > 0, coordinated: identities.size >= 2 || deckNumbers.length >= 2, changeCount: observed.length, deckNumbers, canonicalIds: [...new Set(observed.map(({ signal }) => signal.canonicalId))], firstObservedAtUtc: observed[0]?.point.observedAtUtc ?? null, lastObservedAtUtc: observed.at(-1)?.point.observedAtUtc ?? null, reason: observed.length ? `${family} activity changed on ${identities.size} independent signal${identities.size === 1 ? '' : 's'} around the physical stop.` : `No changing ${family} evidence was observed around the physical stop.` }
}

export function buildStopEvidence(input: { pressKey: RadiusPressKey; segment: PhysicalStopSegment; allSegments: PhysicalStopSegment[]; signals: PressSemanticSignalWithIdentity[]; physicalRangeEndUtc: string; identityEvidenceCutoffUtc: string; identityAssociationConfiguration: StopIdentityAssociationConfiguration; supportedFamilies: StopSetupFamily[] }) {
  const segmentIndex = input.allSegments.indexOf(input.segment)
  const identities = stopIdentityDefinitions(input.pressKey).map((definition) => identityEvidence(definition, input.signals.find((value) => value.canonicalId === definition.canonicalId && value.deckNumber === null), input.segment, segmentIndex, input.allSegments, input.physicalRangeEndUtc, input.identityEvidenceCutoffUtc, input.identityAssociationConfiguration))
  const families = STOP_FAMILY_CANONICAL_PATTERNS.map(({ family }) => familyEvidence(family, input.signals, input.segment, input.physicalRangeEndUtc, input.identityEvidenceCutoffUtc, input.supportedFamilies.includes(family)))
  const identityCoverageAdequate = identities.some((value) => value.usefulness === 'STRONG' && Boolean(value.beforeValue || value.afterValue))
  const familyCoverageAdequate = new Set(input.supportedFamilies).size >= 3
  return { identities, families, identityCoverageAdequate, familyCoverageAdequate }
}
