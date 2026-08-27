import { createHash } from 'node:crypto'
import type { ProductionContextEvidence, TelemetryScalarValue } from '../telemetry/telemetry-contracts.js'
import type { RadiusPressKey, RadiusStatusSegment } from '../radius/models.js'
import { isGoodTelemetryQuality } from '../telemetry/historical-telemetry-policy.js'
import { JOB_ANALYSIS_DIMENSIONS, type EvidenceSupport, type JobAnalysisDimension, type JobGroupDefinition, type JobIdentityCoverage, type JobIdentitySummary, type JobRadiusEpisode, type PressAffinity, type ProductionRun, type RadiusLossSummary, type TransitionSummary } from './contracts.js'

export const JOB_CONTEXT_SETTLING_MS = 5 * 60_000
export const JOB_STABLE_PRODUCTION_MS = 5 * 60_000

export interface DeckActiveEvidence {
  deckNumber: number
  seed: { observedAtUtc: string; value: TelemetryScalarValue; qualityState: string } | null
  changes: Array<{ observedAtUtc: string; value: TelemetryScalarValue; qualityState: string }>
}

interface ContextChange { atUtc: string; field: JobAnalysisDimension; value: string | null }
interface ContextCluster { startUtc: string; endUtc: string; changes: ContextChange[] }
type Identities = Partial<Record<JobAnalysisDimension, string>>

const badQuality = (value?: string) => value !== undefined && !isGoodTelemetryQuality(value)
const round = (value: number, digits = 1) => { const factor = 10 ** digits; return Math.round(value * factor) / factor }
const median = (values: number[]): number | null => { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2 }
const percentile = (values: number[], fraction: number): number | null => { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b); const position = (sorted.length - 1) * fraction; const low = Math.floor(position); const high = Math.ceil(position); return low === high ? sorted[low]! : sorted[low]! + (sorted[high]! - sorted[low]!) * (position - low) }

export function usableJobIdentity(value: unknown, qualityState?: string): string | null {
  if (badQuality(qualityState) || value === null || value === undefined) return null
  const normalized = typeof value === 'string' ? value.trim() : typeof value === 'number' || typeof value === 'boolean' ? String(value) : ''
  if (!normalized || /^(?:null|undefined|n\/a|na|none|unknown|unavailable|not set|unset|-+)$/i.test(normalized) || /^[+-]?0+(?:\.0+)?$/.test(normalized)) return null
  return normalized.slice(0, 240)
}

function identityKey(values: Identities): string {
  return JOB_ANALYSIS_DIMENSIONS.map((field) => `${field}=${values[field] ?? ''}`).join('\u0000')
}

function clusters(changes: ContextChange[]): ContextCluster[] {
  const result: ContextCluster[] = []
  for (const change of [...changes].sort((a, b) => Date.parse(a.atUtc) - Date.parse(b.atUtc) || a.field.localeCompare(b.field))) {
    const prior = result.at(-1)
    if (!prior || Date.parse(change.atUtc) - Date.parse(prior.endUtc) > JOB_CONTEXT_SETTLING_MS) result.push({ startUtc: change.atUtc, endUtc: change.atUtc, changes: [change] })
    else { prior.endUtc = change.atUtc; prior.changes.push(change) }
  }
  return result
}

function overlapSeconds(startUtc: string, endUtc: string, segment: { startUtc: string; endUtc: string }): number {
  return Math.max(0, Math.min(Date.parse(endUtc), Date.parse(segment.endUtc)) - Math.max(Date.parse(startUtc), Date.parse(segment.startUtc))) / 1_000
}

function clippedEpisodes(startUtc: string, endUtc: string, segments: RadiusStatusSegment[]): JobRadiusEpisode[] {
  return segments.flatMap((segment) => {
    if (segment.kind !== 'radius') return []
    const start = Math.max(Date.parse(startUtc), Date.parse(segment.startUtc)); const end = Math.min(Date.parse(endUtc), Date.parse(segment.endUtc))
    return end > start ? [{ eventType: segment.eventType, statusCode: segment.statusCode, statusDescription: segment.statusDescription, startUtc: new Date(start).toISOString(), endUtc: new Date(end).toISOString(), durationSeconds: round((end - start) / 1_000) }] : []
  })
}

function activeDecksAt(atUtc: string, evidence: DeckActiveEvidence[]): number[] | null {
  if (!evidence.length) return null
  const at = Date.parse(atUtc); const decks: number[] = []; let usable = 0
  for (const signal of evidence) {
    const values = [signal.seed, ...signal.changes].filter((item): item is NonNullable<typeof item> => Boolean(item) && Date.parse(item!.observedAtUtc) <= at && !badQuality(item!.qualityState)).sort((a, b) => Date.parse(a.observedAtUtc) - Date.parse(b.observedAtUtc))
    const value = values.at(-1)?.value
    if (value === 0 || value === 1 || value === false || value === true) { usable += 1; if (value === 1 || value === true) decks.push(signal.deckNumber) }
  }
  return usable === evidence.length ? decks : null
}

function baseRuns(input: { pressKey: RadiusPressKey; fromUtc: string; toUtc: string; context: ProductionContextEvidence; radiusSegments: RadiusStatusSegment[]; deckActive?: DeckActiveEvidence[] }): Array<Omit<ProductionRun, 'previousIdentities' | 'nextIdentities' | 'deckConfiguration'>> {
  const values: Identities = {}
  for (const field of JOB_ANALYSIS_DIMENSIONS) {
    const seed = input.context.fields[field].seed
    const value = usableJobIdentity(seed?.value, seed?.qualityState)
    if (value !== null) values[field] = value
  }
  const changes: ContextChange[] = input.context.changes.flatMap((item) => {
    if (!JOB_ANALYSIS_DIMENSIONS.includes(item.field as JobAnalysisDimension)) return []
    if (badQuality(item.qualityState)) return []
    const value = usableJobIdentity(item.value, item.qualityState)
    return [{ atUtc: item.atUtc, field: item.field as JobAnalysisDimension, value }]
  })
  const boundaries: Array<{ atUtc: string; lastChangeUtc: string | null; settledUtc: string | null; identities: Identities; previous: Identities | null; fields: JobAnalysisDimension[]; settlingSeconds: number }> = [{ atUtc: input.fromUtc, lastChangeUtc: null, settledUtc: null, identities: { ...values }, previous: null, fields: [], settlingSeconds: 0 }]
  for (const cluster of clusters(changes)) {
    const previous = { ...values }; const before = identityKey(values); const fields = new Set<JobAnalysisDimension>()
    for (const change of cluster.changes) { if (change.value === null) delete values[change.field]; else values[change.field] = change.value; fields.add(change.field) }
    if (identityKey(values) !== before) {
      const settledAt = Date.parse(cluster.endUtc) + JOB_CONTEXT_SETTLING_MS
      boundaries.push({ atUtc: cluster.startUtc, lastChangeUtc: cluster.endUtc, settledUtc: settledAt <= Date.parse(input.toUtc) ? new Date(settledAt).toISOString() : null, identities: { ...values }, previous, fields: [...fields], settlingSeconds: round((Date.parse(cluster.endUtc) - Date.parse(cluster.startUtc)) / 1_000) })
    }
  }
  const gaps = input.radiusSegments.filter((segment) => segment.kind === 'offline').map((segment) => ({ startUtc: segment.startUtc, endUtc: segment.endUtc }))
  const result: Array<Omit<ProductionRun, 'previousIdentities' | 'nextIdentities' | 'deckConfiguration'>> = []
  for (let index = 0; index < boundaries.length; index += 1) {
    const boundary = boundaries[index]!; const naturalEnd = boundaries[index + 1]?.atUtc ?? input.toUtc
    const cuts = [boundary.atUtc, naturalEnd, ...gaps.flatMap((gap) => Date.parse(gap.endUtc) > Date.parse(boundary.atUtc) && Date.parse(gap.startUtc) < Date.parse(naturalEnd) ? [gap.startUtc, gap.endUtc] : [])].filter((value, item, all) => Number.isFinite(Date.parse(value)) && Date.parse(value) >= Date.parse(boundary.atUtc) && Date.parse(value) <= Date.parse(naturalEnd) && all.indexOf(value) === item).sort((a, b) => Date.parse(a) - Date.parse(b))
    for (let part = 0; part < cuts.length - 1; part += 1) {
      const startUtc = cuts[part]!; const endUtc = cuts[part + 1]!
      const insideGap = gaps.some((gap) => Date.parse(startUtc) >= Date.parse(gap.startUtc) && Date.parse(endUtc) <= Date.parse(gap.endUtc))
      if (insideGap || Date.parse(endUtc) <= Date.parse(startUtc) || !Object.keys(boundary.identities).length) continue
      const episodes = clippedEpisodes(startUtc, endUtc, input.radiusSegments)
      const totals = episodes.reduce((sum, episode) => { if (episode.eventType === 'G') sum.good += episode.durationSeconds; else if (episode.eventType === 'M') sum.makeReady += episode.durationSeconds; else if (episode.eventType === 'B') sum.bad += episode.durationSeconds; else sum.other += episode.durationSeconds; return sum }, { good: 0, makeReady: 0, bad: 0, other: 0 })
      let priorProduction = false; let interruptions = 0
      for (const episode of episodes) { const production = episode.eventType === 'G' && episode.statusDescription === 'Run Production'; if (priorProduction && !production) interruptions += 1; priorProduction = production }
      const afterGap = part > 0 || gaps.some((gap) => gap.endUtc === startUtc)
      const identityTransitionBoundary = part === 0 && boundary.fields.length > 0
      const stable = episodes.find((episode) => episode.eventType === 'G' && episode.statusDescription === 'Run Production' && episode.durationSeconds * 1_000 >= JOB_STABLE_PRODUCTION_MS)
      const priorStable = input.radiusSegments.filter((segment) => segment.kind === 'radius' && segment.eventType === 'G' && segment.statusDescription === 'Run Production' && segment.durationSeconds * 1_000 >= JOB_STABLE_PRODUCTION_MS && Date.parse(segment.endUtc) <= Date.parse(startUtc)).sort((a, b) => Date.parse(a.endUtc) - Date.parse(b.endUtc)).at(-1)
      const stableStart = stable?.startUtc ?? null; const outgoingEnd = priorStable?.endUtc ?? null
      const radiusProxy = identityTransitionBoundary && stableStart && outgoingEnd && Date.parse(stableStart) >= Date.parse(outgoingEnd) ? round((Date.parse(stableStart) - Date.parse(outgoingEnd)) / 1_000) : null
      const firstToStable = identityTransitionBoundary && stableStart && Date.parse(stableStart) >= Date.parse(boundary.atUtc) ? round((Date.parse(stableStart) - Date.parse(boundary.atUtc)) / 1_000) : null
      const settledToStable = identityTransitionBoundary && stableStart && boundary.settledUtc && Date.parse(stableStart) >= Date.parse(boundary.settledUtc) ? round((Date.parse(stableStart) - Date.parse(boundary.settledUtc)) / 1_000) : null
      const durationSeconds = (Date.parse(endUtc) - Date.parse(startUtc)) / 1_000; const observed = totals.good + totals.makeReady + totals.bad + totals.other
      result.push({ runId: `${input.pressKey}.job.${createHash('sha256').update(`${startUtc}\u0000${identityKey(boundary.identities)}`).digest('hex').slice(0, 16)}`, pressKey: input.pressKey, startUtc, endUtc, durationSeconds: round(durationSeconds), identities: { ...boundary.identities }, boundaryFields: part === 0 ? boundary.fields : [], contextSettlingSeconds: part === 0 ? boundary.settlingSeconds : 0, identityTransition: { identityChangeFirstSeenAtUtc: part === 0 && boundary.fields.length ? boundary.atUtc : null, identityLastChangeAtUtc: part === 0 ? boundary.lastChangeUtc : null, identitySettledAtUtc: part === 0 ? boundary.settledUtc : null, settleState: afterGap ? 'after_data_gap' : !boundary.fields.length ? 'range_start' : boundary.settledUtc ? 'confirmed' : 'pending_range_end', previousResolvedIdentity: part === 0 ? boundary.previous : null, finalResolvedIdentity: { ...boundary.identities }, inferredBoundary: Boolean(boundary.fields.length) }, dataInterrupted: afterGap || gaps.some((gap) => gap.startUtc === endUtc), coveragePercent: durationSeconds ? round(observed / durationSeconds * 100) : 0, identityConfidence: boundary.fields.length > 2 && boundary.settlingSeconds <= 300 && boundary.settledUtc ? 'high' : boundary.fields.length || index === 0 ? 'moderate' : 'limited', goodSeconds: round(totals.good), makeReadySeconds: round(totals.makeReady), badSeconds: round(totals.bad), otherRadiusSeconds: round(totals.other), productionInterruptionCount: interruptions, transitionToStableProductionSeconds: radiusProxy, transitionMetric: radiusProxy === null ? 'unavailable' : 'radius_stable_production_proxy', transitionTiming: { outgoingStableRadiusProductionEndUtc: outgoingEnd, incomingStableRadiusProductionStartUtc: stableStart, radiusStableProductionProxySeconds: radiusProxy, metadataFirstSeenToStableSeconds: firstToStable, metadataSettledToStableSeconds: settledToStable, telemetryPhysicalProductionAtUtc: null, timingUncertaintySeconds: identityTransitionBoundary && boundary.lastChangeUtc ? round((Date.parse(boundary.lastChangeUtc) + JOB_CONTEXT_SETTLING_MS - Date.parse(boundary.atUtc)) / 1_000) : null }, radiusEpisodes: episodes })
    }
  }
  return result
}

export function deriveProductionRuns(input: { pressKey: RadiusPressKey; fromUtc: string; toUtc: string; context: ProductionContextEvidence; radiusSegments: RadiusStatusSegment[]; deckActive?: DeckActiveEvidence[] }): ProductionRun[] {
  const raw = baseRuns(input)
  return raw.map((run, index) => {
    const previous = raw[index - 1]; const next = raw[index + 1]
    const currentDecks = activeDecksAt(run.startUtc, input.deckActive ?? []); const previousDecks = previous ? activeDecksAt(previous.startUtc, input.deckActive ?? []) : null
    const deckConfiguration = currentDecks === null || previousDecks === null ? null : { activeDecks: currentDecks, reusedDecks: currentDecks.filter((deck) => previousDecks.includes(deck)), addedDecks: currentDecks.filter((deck) => !previousDecks.includes(deck)), removedDecks: previousDecks.filter((deck) => !currentDecks.includes(deck)), changedDeckCount: currentDecks.filter((deck) => !previousDecks.includes(deck)).length + previousDecks.filter((deck) => !currentDecks.includes(deck)).length, evidenceCanonicalId: 'deck.active' as const }
    return { ...run, previousIdentities: previous && !run.dataInterrupted ? previous.identities : null, nextIdentities: next && !next.dataInterrupted ? next.identities : null, deckConfiguration }
  })
}

export function splitIdentitySegments(value: string, delimiter = '-'): string[] {
  return delimiter && value.includes(delimiter) ? value.split(delimiter).map((item) => item.trim()).filter(Boolean) : [value]
}

export function matchesJobGroup(value: string, group: JobGroupDefinition): boolean {
  const query = group.query.trim().toLocaleLowerCase(); const candidate = value.toLocaleLowerCase()
  if (!query) return false
  if (group.operator === 'exact') return candidate === query
  if (group.operator === 'contains') return candidate.includes(query)
  if (group.operator === 'starts_with') return candidate.startsWith(query)
  if (group.operator === 'ends_with') return candidate.endsWith(query)
  if (group.operator === 'position_range') { const start = Math.max(1, group.positionStart ?? 1); const end = Math.max(start, group.positionEnd ?? start); return candidate.slice(start - 1, end) === query }
  const delimiter = group.delimiter && group.delimiter.length <= 3 ? group.delimiter : '-'; const index = Math.max(1, group.segmentIndex ?? 1)
  return splitIdentitySegments(value, delimiter)[index - 1]?.toLocaleLowerCase() === query
}

export function evidenceSupport(runs: ProductionRun[], comparableCount = 0): EvidenceSupport {
  const observed = runs.reduce((sum, run) => sum + run.goodSeconds + run.makeReadySeconds + run.badSeconds + run.otherRadiusSeconds, 0); const possible = runs.reduce((sum, run) => sum + run.durationSeconds, 0); const coverage = possible ? observed / possible * 100 : 0
  const percentages = runs.flatMap((run) => { const total = run.goodSeconds + run.makeReadySeconds + run.badSeconds; return total ? [run.goodSeconds / total * 100] : [] }); const p25 = percentile(percentages, .25); const p75 = percentile(percentages, .75); const variability = p25 === null || p75 === null ? null : round(p75 - p25)
  const hours = observed / 3600; let level: EvidenceSupport['level']; let reason: string
  if (runs.length >= 10 && hours >= 8 && coverage >= 90 && (comparableCount === 0 || comparableCount >= 10)) { level = 'strong'; reason = 'At least 10 runs, 8 observed hours, 90% coverage, and adequate comparable support.' }
  else if (runs.length >= 5 && hours >= 3 && coverage >= 80 && (comparableCount === 0 || comparableCount >= 5)) { level = 'moderate'; reason = 'At least 5 runs, 3 observed hours, and 80% coverage.' }
  else if (runs.length >= 3 && hours >= 1) { level = 'limited'; reason = 'Some repeat evidence exists, but support or coverage is below recommendation thresholds.' }
  else { level = 'insufficient'; reason = 'Fewer than 3 runs or 1 observed hour; no recommendation is produced.' }
  return { level, runCount: runs.length, observedHours: round(hours), coveragePercent: round(coverage), variabilityPoints: variability, comparableCount, reason }
}

export function summarizeIdentities(runs: ProductionRun[], dimension: JobAnalysisDimension): JobIdentitySummary[] {
  const grouped = new Map<string, ProductionRun[]>(); for (const run of runs) { const value = run.identities[dimension]; if (value) grouped.set(value, [...(grouped.get(value) ?? []), run]) }
  return [...grouped].map(([value, items]): JobIdentitySummary => {
    const good = items.reduce((sum, run) => sum + run.goodSeconds, 0); const makeReady = items.reduce((sum, run) => sum + run.makeReadySeconds, 0); const bad = items.reduce((sum, run) => sum + run.badSeconds, 0); const stateObserved = good + makeReady + bad; const observed = stateObserved + items.reduce((sum, run) => sum + run.otherRadiusSeconds, 0)
    const runGood = items.flatMap((run) => { const total = run.goodSeconds + run.makeReadySeconds + run.badSeconds; return total ? [run.goodSeconds / total * 100] : [] }); const p25 = percentile(runGood, .25); const p75 = percentile(runGood, .75); const variability = p25 === null || p75 === null ? null : round(p75 - p25)
    const support = evidenceSupport(items); const interruptions = items.reduce((sum, run) => sum + run.productionInterruptionCount, 0)
    return { value, segments: splitIdentitySegments(value), runCount: items.length, observedSeconds: round(observed), goodPercent: stateObserved ? round(good / stateObserved * 100) : 0, makeReadyPercent: stateObserved ? round(makeReady / stateObserved * 100) : 0, badPercent: stateObserved ? round(bad / stateObserved * 100) : 0, medianRunSeconds: round(median(items.map((run) => run.durationSeconds)) ?? 0), medianTransitionSeconds: median(items.flatMap((run) => run.transitionToStableProductionSeconds === null ? [] : [run.transitionToStableProductionSeconds])), interruptions, interruptionsPerProductionHour: good > 0 ? round(interruptions / (good / 3600), 2) : null, variabilityPoints: variability, consistency: variability === null || items.length < 3 ? 'insufficient' : variability <= 10 ? 'consistent' : variability <= 25 ? 'variable' : 'highly_variable', support }
  }).sort((a, b) => b.goodPercent - a.goodPercent || b.observedSeconds - a.observedSeconds || a.value.localeCompare(b.value))
}

function explorerUrl(path: string, pressKey: RadiusPressKey, fromUtc: string, toUtc: string): string { const query = new URLSearchParams({ press: pressKey, fromUtc, toUtc, preset: 'custom' }); return `${path}?${query}` }

export function summarizeRadiusLosses(runs: ProductionRun[], pressKey: RadiusPressKey, fromUtc: string, toUtc: string): RadiusLossSummary[] {
  const grouped = new Map<string, JobRadiusEpisode[]>()
  for (const episode of runs.flatMap((run) => run.radiusEpisodes).filter((episode) => episode.eventType === 'M' || episode.eventType === 'B')) { const key = `${episode.eventType}\u0000${episode.statusCode ?? ''}\u0000${episode.statusDescription}`; grouped.set(key, [...(grouped.get(key) ?? []), episode]) }
  return [...grouped.values()].map((episodes) => { const first = episodes[0]!; const total = episodes.reduce((sum, episode) => sum + episode.durationSeconds, 0); return { eventType: first.eventType, statusCode: first.statusCode, statusDescription: first.statusDescription, totalSeconds: round(total), secondsPerRun: runs.length ? round(total / runs.length) : 0, occurrenceCount: episodes.length, occurrencesPerRun: runs.length ? round(episodes.length / runs.length, 2) : 0, medianEpisodeSeconds: round(median(episodes.map((episode) => episode.durationSeconds)) ?? 0), evidenceUrl: explorerUrl('/raw-radius-explorer', pressKey, fromUtc, toUtc) } }).sort((a, b) => b.totalSeconds - a.totalSeconds || a.statusDescription.localeCompare(b.statusDescription))
}

export function summarizeTransitions(runs: ProductionRun[], dimension: JobAnalysisDimension, selected?: JobGroupDefinition): TransitionSummary[] {
  const grouped = new Map<string, ProductionRun[]>()
  for (const run of runs) { const current = run.identities[dimension]; const previous = run.previousIdentities?.[dimension]; if (!current || !previous || current === previous || selected && !matchesJobGroup(current, selected)) continue; const key = `${previous}\u0000${current}`; grouped.set(key, [...(grouped.get(key) ?? []), run]) }
  return [...grouped].map<TransitionSummary>(([key, items]) => {
    const [previousValue, currentValue] = key.split('\u0000') as [string, string]; const good = items.reduce((sum, run) => sum + run.goodSeconds, 0); const makeReady = items.reduce((sum, run) => sum + run.makeReadySeconds, 0); const bad = items.reduce((sum, run) => sum + run.badSeconds, 0); const observed = good + makeReady + bad; const fromUtc = items[0]!.startUtc; const toUtc = items.at(-1)!.endUtc
    const sequences = new Map<string, { count: number; sequence: TransitionSummary['fingerprint']['exactRadiusSequence'] }>()
    for (const run of items) { const sequence = run.radiusEpisodes.map(({ eventType, statusCode, statusDescription }) => ({ eventType, statusCode, statusDescription })); const sequenceKey = sequence.map((entry) => `${entry.eventType}\u0000${entry.statusCode ?? ''}\u0000${entry.statusDescription}`).join('\u0001'); const prior = sequences.get(sequenceKey); sequences.set(sequenceKey, { count: (prior?.count ?? 0) + 1, sequence }) }
    const recurring = [...sequences.values()].sort((a, b) => b.count - a.count || JSON.stringify(a.sequence).localeCompare(JSON.stringify(b.sequence)))[0] ?? { count: 0, sequence: [] }
    const deckRuns = items.filter((run) => run.deckConfiguration !== null); const commonDecks = (field: 'reusedDecks' | 'addedDecks' | 'removedDecks') => [...new Set(deckRuns.flatMap((run) => run.deckConfiguration![field]))].filter((deck) => deckRuns.filter((run) => run.deckConfiguration![field].includes(deck)).length >= Math.ceil(deckRuns.length / 2)).sort((a, b) => a - b)
    const deckChangeEvidence = deckRuns.length ? { supportedRunCount: deckRuns.length, medianChangedDecks: round(median(deckRuns.map((run) => run.deckConfiguration!.changedDeckCount)) ?? 0), commonlyReusedDecks: commonDecks('reusedDecks'), commonlyAddedDecks: commonDecks('addedDecks'), commonlyRemovedDecks: commonDecks('removedDecks') } : null
    return { transitionKey: createHash('sha256').update(`${items[0]!.pressKey}\u0000${key}`).digest('hex').slice(0, 16), pressKey: items[0]!.pressKey, previousValue, currentValue, transitionCount: items.length, medianTransitionSeconds: median(items.flatMap((run) => run.transitionToStableProductionSeconds === null ? [] : [run.transitionToStableProductionSeconds])), goodPercent: observed ? round(good / observed * 100) : 0, makeReadyPercent: observed ? round(makeReady / observed * 100) : 0, badPercent: observed ? round(bad / observed * 100) : 0, interruptionRatePerTransition: round(items.reduce((sum, run) => sum + run.productionInterruptionCount, 0) / items.length, 2), support: evidenceSupport(items), radiusCauses: summarizeRadiusLosses(items, items[0]!.pressKey, fromUtc, toUtc).slice(0, 3), fingerprint: { exactRadiusSequence: recurring.sequence, recurringSequenceCount: recurring.count, medianIdentitySettlingSeconds: round(median(items.map((run) => run.contextSettlingSeconds)) ?? 0), medianTimingUncertaintySeconds: median(items.flatMap((run) => run.transitionTiming.timingUncertaintySeconds === null ? [] : [run.transitionTiming.timingUncertaintySeconds])), deckChangeEvidence, telemetryPhysicalTiming: 'not_loaded_in_summary', telemetryEvidenceUrl: explorerUrl('/telemetry-event-explorer', items[0]!.pressKey, fromUtc, toUtc) }, evidenceUrl: explorerUrl('/raw-radius-explorer', items[0]!.pressKey, fromUtc, toUtc) }
  }).sort((a, b) => (b.medianTransitionSeconds ?? -1) - (a.medianTransitionSeconds ?? -1) || b.transitionCount - a.transitionCount)
}

function comparableRuns(target: ProductionRun, fleet: ProductionRun[], dimension: JobAnalysisDimension): ProductionRun[] {
  const identity = target.identities[dimension]
  const candidates = fleet.filter((run) => run.pressKey !== target.pressKey && run.identities[dimension] === identity && run.coveragePercent >= 80 && run.durationSeconds >= target.durationSeconds * .5 && run.durationSeconds <= target.durationSeconds * 2)
  const contextual = candidates.filter((run) => ['recipe', 'material'].filter((field) => field !== dimension && target.identities[field as JobAnalysisDimension]).every((field) => run.identities[field as JobAnalysisDimension] === target.identities[field as JobAnalysisDimension]) && (!target.previousIdentities?.[dimension] || run.previousIdentities?.[dimension] === target.previousIdentities?.[dimension]))
  return contextual.length >= 3 ? contextual : candidates
}

export function buildPressAffinity(fleetRuns: ProductionRun[], dimension: JobAnalysisDimension, group: JobGroupDefinition): PressAffinity[] {
  const included = fleetRuns.filter((run) => { const value = run.identities[dimension]; return value ? matchesJobGroup(value, group) : false })
  const byPress = new Map<RadiusPressKey, ProductionRun[]>(); for (const run of included) byPress.set(run.pressKey, [...(byPress.get(run.pressKey) ?? []), run])
  const rows = [...byPress].map(([pressKey, runs]) => {
    const matched = runs.flatMap((run) => comparableRuns(run, fleetRuns, dimension).map((candidate) => ({ run, candidate })))
    const expected = median(matched.flatMap(({ candidate }) => { const total = candidate.goodSeconds + candidate.makeReadySeconds + candidate.badSeconds; return total ? [candidate.goodSeconds / total * 100] : [] })); const good = runs.reduce((sum, run) => sum + run.goodSeconds, 0); const makeReady = runs.reduce((sum, run) => sum + run.makeReadySeconds, 0); const bad = runs.reduce((sum, run) => sum + run.badSeconds, 0); const stateObserved = good + makeReady + bad; const observed = stateObserved + runs.reduce((sum, run) => sum + run.otherRadiusSeconds, 0); const actual = stateObserved ? good / stateObserved * 100 : 0; const support = evidenceSupport(runs, matched.length)
    return { pressKey, displayName: pressKey.replace('press', 'Press '), runCount: runs.length, observedSeconds: round(observed), goodPercent: round(actual), makeReadyPercent: stateObserved ? round(makeReady / stateObserved * 100) : 0, badPercent: stateObserved ? round(bad / stateObserved * 100) : 0, medianTransitionSeconds: median(runs.flatMap((run) => run.transitionToStableProductionSeconds === null ? [] : [run.transitionToStableProductionSeconds])), variabilityPoints: support.variabilityPoints, actualVersusComparableGoodPoints: expected === null || matched.length < 3 ? null : round(actual - expected), comparableRunCount: matched.length, comparisonDescription: expected === null || matched.length < 3 ? 'No sufficiently similar cross-press cohort.' : 'Median expected Good-time from the same identity, similar-duration runs, using Recipe/Material and predecessor when support permits.', recoverableOpportunitySeconds: null, recoverableBaseline: null, support }
  })
  const supported = rows.filter((row) => row.support.level === 'strong' || row.support.level === 'moderate'); const baselineMakeReady = median(supported.map((row) => row.makeReadyPercent + row.badPercent))
  return rows.map((row) => baselineMakeReady === null || row.support.level === 'insufficient' ? row : { ...row, recoverableOpportunitySeconds: round(Math.max(0, (row.makeReadyPercent + row.badPercent - baselineMakeReady) / 100 * row.observedSeconds)), recoverableBaseline: `Supported cross-press median Make Ready + Bad share (${round(baselineMakeReady)}%).` }).sort((a, b) => (b.actualVersusComparableGoodPoints ?? -Infinity) - (a.actualVersusComparableGoodPoints ?? -Infinity) || b.goodPercent - a.goodPercent)
}

export function productionContextCoverage(context: ProductionContextEvidence, runs: ProductionRun[]): JobIdentityCoverage[] {
  const total = runs.reduce((sum, run) => sum + run.durationSeconds, 0)
  return JOB_ANALYSIS_DIMENSIONS.map((field) => { const evidence = context.fields[field]; const covered = runs.filter((run) => run.identities[field]).reduce((sum, run) => sum + run.durationSeconds, 0); const coverage = total ? round(covered / total * 100) : 0; const capability = evidence.capabilityState === 'SUPPORTED' ? 'available' : evidence.capabilityState === 'TEMPORARILY_UNAVAILABLE' ? 'temporarily_unavailable' : 'unavailable'; const confidence = capability !== 'available' ? 'unavailable' : coverage >= 95 ? 'high' : coverage >= 75 ? 'moderate' : 'limited'; return { field, capability, valueCoveragePercent: coverage, confidence, limitation: capability !== 'available' ? 'No mapped telemetry capability on this press.' : coverage < 95 ? 'Usable values do not cover the complete selected period.' : null } })
}
