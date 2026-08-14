import type { CapabilityAssessment, PressSemanticSignalEvidence, TelemetrySemanticSelector } from './telemetry-contracts.js'
import { ENGINEERING_CLUE_CATALOG, type EngineeringCategory, type EngineeringSignalType } from './engineering-clue-analysis.js'
import { descriptiveStats, numericObservations, type RunningWindow } from './stop-restart-analysis.js'

export type CandidateSource = 'clue' | 'pin' | 'priority' | 'activity' | 'reserved' | 'condition'
export interface CandidateIdentity { canonicalId: string; deckNumber?: number; friendlyName?: string; signalType?: EngineeringSignalType; category?: EngineeringCategory; source: CandidateSource }
export interface CandidateSelectionResult {
  selected: CandidateIdentity[]
  counts: Record<CandidateSource, number>
  activityPriorityCategories: EngineeringCategory[]
  screenedIdentityCount: number
  observedScreenedIdentityCount: number
}

export const PRE_STOP_CANDIDATE_POLICY = {
  maximumCurrentScreenSelectors: 96,
  maximumCurrentScreenBatchSize: 50,
  maximumHistoricalCandidates: 12,
  maximumPins: 3,
  maximumLocalClues: 3,
  reservedActivitySlots: 2,
  reservedGenericCoverageSlots: 2,
} as const

const GENERIC_CATEGORY_ORDER: EngineeringCategory[] = ['torque', 'web_tension', 'drive_temperature', 'viscosity', 'temperature', 'pump', 'doctor_blade', 'dryer', 'repeat_other', 'register', 'impression']
const ACTIVITY_CATEGORY_HINTS: Array<{ pattern: RegExp; categories: EngineeringCategory[] }> = [
  { pattern: /mechanical|electrical/i, categories: ['torque', 'drive_temperature', 'web_tension', 'register', 'impression'] },
  { pattern: /clean|wash/i, categories: ['pump', 'viscosity', 'temperature'] },
  { pattern: /impression|register|print quality/i, categories: ['register', 'impression', 'torque', 'repeat_other'] },
  { pattern: /roll|material|web|substrate/i, categories: ['web_tension', 'repeat_other'] },
  { pattern: /ink|color/i, categories: ['viscosity', 'temperature', 'pump', 'doctor_blade'] },
  { pattern: /doctor blade|chamber/i, categories: ['doctor_blade', 'pump', 'torque'] },
]

const signalKey = ({ canonicalId, deckNumber }: { canonicalId: string; deckNumber?: number | null }) => `${canonicalId}:${deckNumber ?? ''}`
const definition = (canonicalId: string) => ENGINEERING_CLUE_CATALOG.find((item) => item.canonicalId === canonicalId)
const unique = <T extends { canonicalId: string; deckNumber?: number | null }>(items: T[]) => items.filter((item, index, all) => all.findIndex((candidate) => signalKey(candidate) === signalKey(item)) === index)

function supportedContinuousIdentities(capabilities: CapabilityAssessment[]): CandidateIdentity[] {
  const byId = new Map(capabilities.map((item) => [item.canonicalId, item]))
  return ENGINEERING_CLUE_CATALOG.flatMap((item): CandidateIdentity[] => {
    const capability = byId.get(item.canonicalId)
    if (item.signalType !== 'continuous' || item.canonicalId === 'machine.speed.actual' || capability?.state !== 'SUPPORTED' || !capability.historyQueryable || capability.evidenceKind !== 'semantic_history') return []
    if (item.scope === 'machine') return [{ canonicalId: item.canonicalId, friendlyName: item.friendlyName, signalType: item.signalType, category: item.category, source: 'condition' }]
    return capability.deckNumbers.map((deckNumber) => ({ canonicalId: item.canonicalId, deckNumber, friendlyName: item.friendlyName, signalType: item.signalType, category: item.category, source: 'condition' }))
  })
}

/**
 * Builds a bounded, category-balanced current-window screen. Round-robin category
 * selection prevents a ten-deck family from crowding every other family out.
 */
export function currentScreenCandidates(capabilities: CapabilityAssessment[]): CandidateIdentity[] {
  const supported = supportedContinuousIdentities(capabilities)
  const categories = GENERIC_CATEGORY_ORDER.filter((category) => supported.some((item) => item.category === category))
  const queues = new Map(categories.map((category) => [category, supported.filter((item) => item.category === category).sort((left, right) => (left.deckNumber ?? 0) - (right.deckNumber ?? 0) || left.canonicalId.localeCompare(right.canonicalId))]))
  const result: CandidateIdentity[] = []
  while (result.length < PRE_STOP_CANDIDATE_POLICY.maximumCurrentScreenSelectors && [...queues.values()].some((items) => items.length)) {
    for (const category of categories) {
      const next = queues.get(category)?.shift()
      if (next) result.push(next)
      if (result.length === PRE_STOP_CANDIDATE_POLICY.maximumCurrentScreenSelectors) break
    }
  }
  return result
}

export function activityPriorityCategories(operationalGroupName: string, processFamilyName: string): EngineeringCategory[] {
  const text = `${operationalGroupName} ${processFamilyName}`
  return unique(ACTIVITY_CATEGORY_HINTS.filter(({ pattern }) => pattern.test(text)).flatMap(({ categories }) => categories).map((category) => ({ canonicalId: category, category }))).map(({ category }) => category)
}

function conditionScore(signal: PressSemanticSignalEvidence | undefined, window: RunningWindow | null): { observed: boolean; score: number; median: number | null } {
  if (!signal || !window?.fromUtc || !window.toUtc) return { observed: false, score: -1, median: null }
  const points = numericObservations(signal.samples).filter(({ atUtc }) => Date.parse(atUtc) >= Date.parse(window.fromUtc!) && Date.parse(atUtc) <= Date.parse(window.toUtc!))
  if (!points.length) return { observed: false, score: -1, median: null }
  if (points.length < 3) return { observed: true, score: 0, median: descriptiveStats(points.map(({ value }) => value))!.median }
  const midpoint = Math.ceil(points.length / 2)
  const all = descriptiveStats(points.map(({ value }) => value))!
  const first = descriptiveStats(points.slice(0, midpoint).map(({ value }) => value))!
  const last = descriptiveStats(points.slice(midpoint).map(({ value }) => value)) ?? first
  const scale = Math.max(all.iqr, Math.abs(all.median) * .02, (all.maximum - all.minimum) * .1, 1e-9)
  return { observed: true, score: Math.abs(last.median - first.median) / scale + (all.maximum - all.minimum) / scale * .05, median: all.median }
}

function enriched(identity: CandidateIdentity, source: CandidateSource): CandidateIdentity {
  const item = definition(identity.canonicalId)
  return { ...identity, friendlyName: identity.friendlyName ?? item?.friendlyName, signalType: identity.signalType ?? item?.signalType, category: identity.category ?? item?.category, source }
}

/**
 * Historical slots are deterministic and bounded: pins (up to 3), local clues
 * (up to 3), activity-prioritized coverage (2), and generic cross-family
 * coverage (2). Unused or duplicate quota is filled by like-for-like current
 * condition evidence, so persistently offset decks retain meaningful capacity.
 * Duplicates free slots for a final balanced condition-score fill. Activity is
 * only a search-order hint and never excludes unrelated generic coverage.
 */
export function selectHistoricalCandidates(args: {
  requested: CandidateIdentity[]
  screen: CandidateIdentity[]
  currentSignals: PressSemanticSignalEvidence[]
  stableRunningBefore: RunningWindow | null
  operationalGroupName: string
  processFamilyName: string
}): CandidateSelectionResult {
  const byKey = new Map(args.currentSignals.map((item) => [signalKey(item), item]))
  const baseScores = args.screen.map((item) => ({ item, ...conditionScore(byKey.get(signalKey(item)), args.stableRunningBefore) }))
  const scored = baseScores.map((candidate) => {
    const peers = baseScores.filter(({ item, observed, median }) => observed && median !== null && item.canonicalId === candidate.item.canonicalId && signalKey(item) !== signalKey(candidate.item)).map(({ median }) => median!)
    const peerStats = peers.length >= 3 ? descriptiveStats(peers) : null
    const peerScale = peerStats ? Math.max(peerStats.iqr, Math.abs(peerStats.median) * .05, 1e-9) : null
    const crossDeckScore = candidate.median !== null && peerStats && peerScale ? Math.abs(candidate.median - peerStats.median) / peerScale : 0
    return { ...candidate, crossDeckScore, score: candidate.score + crossDeckScore }
  }).sort((left, right) => Number(right.observed) - Number(left.observed) || right.score - left.score || GENERIC_CATEGORY_ORDER.indexOf(left.item.category!) - GENERIC_CATEGORY_ORDER.indexOf(right.item.category!) || (left.item.deckNumber ?? 0) - (right.item.deckNumber ?? 0) || left.item.canonicalId.localeCompare(right.item.canonicalId))
  const priorities = activityPriorityCategories(args.operationalGroupName, args.processFamilyName)
  const selected: CandidateIdentity[] = []
  const counts: Record<CandidateSource, number> = { clue: 0, pin: 0, priority: 0, activity: 0, reserved: 0, condition: 0 }
  const add = (item: CandidateIdentity | undefined, source: CandidateSource) => {
    if (!item || selected.length >= PRE_STOP_CANDIDATE_POLICY.maximumHistoricalCandidates || selected.some((candidate) => signalKey(candidate) === signalKey(item))) return false
    selected.push(enriched(item, source)); counts[source] += 1; return true
  }
  args.requested.filter(({ source }) => source === 'pin').slice(0, PRE_STOP_CANDIDATE_POLICY.maximumPins).forEach((item) => add(item, 'pin'))
  args.requested.filter(({ source }) => source === 'clue').slice(0, PRE_STOP_CANDIDATE_POLICY.maximumLocalClues).forEach((item) => add(item, 'clue'))
  for (const category of priorities) {
    if (counts.activity >= PRE_STOP_CANDIDATE_POLICY.reservedActivitySlots) break
    add(scored.find(({ item, observed }) => observed && item.category === category)?.item, 'activity')
  }
  for (const category of GENERIC_CATEGORY_ORDER.filter((category) => !priorities.includes(category))) {
    if (counts.reserved >= PRE_STOP_CANDIDATE_POLICY.reservedGenericCoverageSlots) break
    add(scored.find(({ item, observed }) => observed && item.category === category)?.item, 'reserved')
  }
  for (const item of scored) add(item.item, 'condition')
  for (const item of args.requested.filter(({ source }) => source === 'priority')) add(item, 'priority')
  return { selected, counts, activityPriorityCategories: priorities, screenedIdentityCount: args.screen.length, observedScreenedIdentityCount: scored.filter(({ observed }) => observed).length }
}

export function candidateSelectors(items: CandidateIdentity[]): TelemetrySemanticSelector[] {
  return unique(items).map(({ canonicalId, deckNumber }) => ({ canonicalId, ...(deckNumber === undefined ? {} : { deckNumber }), representation: 'samples' as const }))
}
