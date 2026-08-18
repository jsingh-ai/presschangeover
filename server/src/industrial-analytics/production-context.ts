import { createHash } from 'node:crypto'
import type { OperationalEpisode, RadiusPressKey, RadiusStatusSegment } from '../radius/models.js'
import { PRODUCTION_CONTEXT_CANONICAL_IDS, type CapabilityState, type TelemetryScalarValue, type TelemetryValueKind } from '../telemetry/telemetry-contracts.js'

interface ContextCapabilitySignal {
  canonicalId: string
  capabilityState: CapabilityState
  rawSignalId: string | null
  sourceSelector: string | null
  valueKind?: TelemetryValueKind | null
  seed: { observedAtUtc: string; value: TelemetryScalarValue; valueKind: TelemetryValueKind; qualityState: string } | null
  changes: Array<{ observedAtUtc: string; value: TelemetryScalarValue; qualityState: string }>
  samples: Array<{ observedAtUtc: string; value: TelemetryScalarValue; qualityState: string }>
}

export const PRODUCTION_CONTEXT_IDENTITY_FIELDS = ['job', 'order', 'recipe', 'material', 'customer'] as const
export type ProductionContextIdentityField = (typeof PRODUCTION_CONTEXT_IDENTITY_FIELDS)[number]
export type ProductionContextValue = string | number | boolean

export interface ProductionContextCapability {
  field: ProductionContextIdentityField
  canonicalId: string
  rawIdentity: string | null
  dataType: TelemetryValueKind | null
  capabilityState: CapabilityState
  availability: 'available' | 'unavailable' | 'temporarily_unavailable'
  capabilityAvailability: 'CAPABILITY_AVAILABLE' | 'CAPABILITY_UNAVAILABLE'
  valueAvailability: 'VALUE_USABLE' | 'VALUE_UNAVAILABLE'
  recentCoveragePercent: number
  usable: boolean
  sentinelBehavior: string | null
}

export interface ProductionContextIdentity {
  pressKey: RadiusPressKey
  contextKey: string
  dimensions: Partial<Record<ProductionContextIdentityField, ProductionContextValue>>
  dimensionNames: ProductionContextIdentityField[]
  summary: string
}

export interface ProductionContextEpisodeMetrics {
  productionSeconds: number
  makeReadySeconds: number
  badSeconds: number
  safetySeconds: number
  otherRadiusSeconds: number
  unavailableSeconds: number
  productionInterruptions: number
  returnsToProduction: number
  longestInterruptionSeconds: number
  totalInterruptionSeconds: number
  returnAttempts: number
  failedReturnAttempts: number
  radiusDrivers: Array<{ eventType: string; statusCode: string | null; statusDescription: string; durationSeconds: number; occurrences: number }>
  repeatedRadiusStates: string[]
  loopCount: number
}

export interface ProductionContextEpisode {
  episodeId: string
  pressKey: RadiusPressKey
  identity: ProductionContextIdentity
  startUtc: string
  endUtc: string
  durationSeconds: number
  coveragePercent: number
  startedBy: string | null
  endedBy: string | null
  startedAfterDataGap: boolean
  contextChangeCount: number
  metrics: ProductionContextEpisodeMetrics
}

export interface ContextTimelineObservation {
  atUtc: string
  field: ProductionContextIdentityField
  value: unknown
  previousValue?: unknown
}

export interface ContextualBaseline {
  baselineType: 'context' | 'press'
  fallbackLevel: 1 | 2 | 3 | 4
  matchingDimensions: ProductionContextIdentityField[]
  sampleCount: number
  historicalRange: { start: string; end: string }
  coveragePercent: number
  label: string
  medians: Pick<ProductionContextEpisodeMetrics, 'productionInterruptions' | 'longestInterruptionSeconds' | 'totalInterruptionSeconds' | 'returnAttempts'> & { episodeDurationSeconds: number }
}

export interface ContextualBaselineAttempt {
  fallbackLevel: 1 | 2 | 3 | 4
  matchingDimensions: ProductionContextIdentityField[]
  candidatesFound: number
  candidatesRejected: number
}

export interface ContextualBaselineAssessment {
  status: 'SUFFICIENT' | 'INSUFFICIENT_CONTEXTUAL_HISTORY'
  minimumRequired: number
  actualSupport: number
  baseline: ContextualBaseline | null
  attempts: ContextualBaselineAttempt[]
}

const SENTINEL = /^(?:null|undefined|n\/a|na|none|unknown|unavailable|not available|not set|unset|-+)$/i
const badQuality = (qualityState?: string) => qualityState ? /BAD|INVALID|UNAVAILABLE|NO_DATA|NODATA/i.test(qualityState) : false

export function usableProductionContextValue(value: unknown, qualityState?: string): ProductionContextValue | null {
  if (badQuality(qualityState) || value === null || value === undefined) return null
  if (Array.isArray(value)) {
    const normalized = value.map((item) => usableProductionContextValue(item)).filter((item): item is ProductionContextValue => item !== null)
    return normalized.length ? JSON.stringify(normalized) : null
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed || SENTINEL.test(trimmed)) return null
    if (/^[+-]?0+(?:\.0+)?$/.test(trimmed)) return null
    if ((trimmed.startsWith('[') && trimmed.endsWith(']')) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
      try {
        const parsed = JSON.parse(trimmed) as unknown
        if (!Object.is(parsed, trimmed)) return usableProductionContextValue(parsed)
      } catch { /* preserve a legitimate non-JSON identity */ }
    }
    return trimmed.slice(0, 240)
  }
  if (typeof value === 'number') return Number.isFinite(value) && value !== 0 ? value : null
  return typeof value === 'boolean' ? value : null
}

function round(value: number, digits = 1): number { const factor = 10 ** digits; return Math.round(value * factor) / factor }
function median(values: number[]): number { const ordered = [...values].sort((left, right) => left - right); const middle = Math.floor(ordered.length / 2); return ordered.length % 2 ? ordered[middle]! : (ordered[middle - 1]! + ordered[middle]!) / 2 }
function identityKey(dimensions: Partial<Record<ProductionContextIdentityField, ProductionContextValue>>): string {
  return PRODUCTION_CONTEXT_IDENTITY_FIELDS.flatMap((field) => dimensions[field] === undefined ? [] : [`${field}=${String(dimensions[field])}`]).join('\u0000')
}

export function buildProductionContextIdentity(pressKey: RadiusPressKey, values: Partial<Record<ProductionContextIdentityField, unknown>>): ProductionContextIdentity | null {
  const dimensions: Partial<Record<ProductionContextIdentityField, ProductionContextValue>> = {}
  for (const field of PRODUCTION_CONTEXT_IDENTITY_FIELDS) {
    const value = usableProductionContextValue(values[field])
    if (value !== null) dimensions[field] = value
  }
  const dimensionNames = PRODUCTION_CONTEXT_IDENTITY_FIELDS.filter((field) => dimensions[field] !== undefined)
  if (!dimensionNames.length) return null
  const readable = dimensionNames.map((field) => `${field[0]!.toUpperCase()}${field.slice(1)} ${String(dimensions[field])}`).join(' · ')
  return { pressKey, contextKey: createHash('sha256').update(`${pressKey}\u0000${identityKey(dimensions)}`).digest('hex').slice(0, 16), dimensions, dimensionNames, summary: readable }
}

export function resolveProductionContextCapabilities(input: { range: { start: string; end: string }; signals: ContextCapabilitySignal[] }): ProductionContextCapability[] {
  const duration = Math.max(1, Date.parse(input.range.end) - Date.parse(input.range.start))
  return PRODUCTION_CONTEXT_IDENTITY_FIELDS.map((field) => {
    const canonicalId = PRODUCTION_CONTEXT_CANONICAL_IDS[field]
    const signal = input.signals.find((item) => item.canonicalId === canonicalId)
    const observations = signal ? [signal.seed, ...signal.changes, ...signal.samples].filter(Boolean) as Array<{ observedAtUtc: string; value: TelemetryScalarValue; qualityState: string }> : []
    const usable = observations.filter((item) => usableProductionContextValue(item.value, item.qualityState) !== null)
    const first = usable[0]?.observedAtUtc
    const coverage = signal?.seed && usableProductionContextValue(signal.seed.value, signal.seed.qualityState) !== null ? 100 : first ? Math.max(0, Math.min(100, (Date.parse(input.range.end) - Date.parse(first)) / duration * 100)) : 0
    const sentinel = observations.find((item) => usableProductionContextValue(item.value, item.qualityState) === null)?.value
    const capabilityState = signal?.capabilityState ?? 'UNKNOWN'
    const capabilityAvailable = capabilityState === 'SUPPORTED'
    const valueUsable = capabilityAvailable && usable.length > 0
    return {
      field, canonicalId, rawIdentity: signal?.rawSignalId ?? signal?.sourceSelector ?? null, dataType: signal?.valueKind ?? signal?.seed?.valueKind ?? null, capabilityState,
      availability: capabilityState === 'SUPPORTED' ? 'available' : capabilityState === 'TEMPORARILY_UNAVAILABLE' ? 'temporarily_unavailable' : 'unavailable',
      capabilityAvailability: capabilityAvailable ? 'CAPABILITY_AVAILABLE' : 'CAPABILITY_UNAVAILABLE',
      valueAvailability: valueUsable ? 'VALUE_USABLE' : 'VALUE_UNAVAILABLE',
      recentCoveragePercent: round(coverage), usable: valueUsable,
      sentinelBehavior: sentinel === undefined ? null : `Observed unusable sentinel ${JSON.stringify(sentinel)}`,
    }
  })
}

function overlapSeconds(left: { startUtc: string; endUtc: string }, right: { startUtc: string; endUtc: string }): number {
  return Math.max(0, Math.min(Date.parse(left.endUtc), Date.parse(right.endUtc)) - Math.max(Date.parse(left.startUtc), Date.parse(right.startUtc))) / 1_000
}

function operationalMetrics(range: { startUtc: string; endUtc: string }, segments: RadiusStatusSegment[], episodes: OperationalEpisode[]): ProductionContextEpisodeMetrics {
  const clipped = segments.filter((segment) => overlapSeconds(range, segment) > 0)
  const totals = { G: 0, M: 0, B: 0, S: 0, other: 0, offline: 0 }
  const drivers = new Map<string, { eventType: string; statusCode: string | null; statusDescription: string; durationSeconds: number; occurrences: number }>()
  const stateLabels = new Map<string, string>()
  let interruptions = 0; let returns = 0; let interruptionSeconds = 0; let longest = 0; let activeInterruption = 0; let priorProduction: boolean | null = null
  const states: string[] = []
  for (const segment of clipped) {
    const seconds = overlapSeconds(range, segment)
    if (segment.kind === 'offline') { totals.offline += seconds; activeInterruption = 0; priorProduction = null; continue }
    if (segment.eventType === 'G') totals.G += seconds
    else if (segment.eventType === 'M') totals.M += seconds
    else if (segment.eventType === 'B') totals.B += seconds
    else if (segment.eventType === 'S') totals.S += seconds
    else totals.other += seconds
    const key = `${segment.eventType}\u0000${segment.statusCode ?? ''}\u0000${segment.statusDescription}`; const driver = drivers.get(key) ?? { eventType: segment.eventType, statusCode: segment.statusCode, statusDescription: segment.statusDescription, durationSeconds: 0, occurrences: 0 }; driver.durationSeconds += seconds; driver.occurrences += 1; drivers.set(key, driver)
    states.push(key); stateLabels.set(key, segment.statusDescription)
    if (segment.isProduction) {
      if (priorProduction === false) returns += 1
      longest = Math.max(longest, activeInterruption); activeInterruption = 0; priorProduction = true
    } else {
      if (priorProduction !== false) interruptions += 1
      interruptionSeconds += seconds; activeInterruption += seconds; priorProduction = false
    }
  }
  longest = Math.max(longest, activeInterruption)
  const relevantEpisodes = episodes.filter((episode) => overlapSeconds(range, { startUtc: episode.startUtc, endUtc: episode.endUtc ?? range.endUtc }) > 0)
  const counts = new Map<string, number>(); states.forEach((state) => counts.set(state, (counts.get(state) ?? 0) + 1))
  const loops = states.filter((state, index) => index > 1 && states.slice(0, index - 1).includes(state)).length
  return { productionSeconds: round(totals.G), makeReadySeconds: round(totals.M), badSeconds: round(totals.B), safetySeconds: round(totals.S), otherRadiusSeconds: round(totals.other), unavailableSeconds: round(totals.offline), productionInterruptions: interruptions, returnsToProduction: returns, longestInterruptionSeconds: round(longest), totalInterruptionSeconds: round(interruptionSeconds), returnAttempts: relevantEpisodes.reduce((sum, item) => sum + item.returnToProductionAttemptCount, 0), failedReturnAttempts: relevantEpisodes.reduce((sum, item) => sum + item.failedReturnToProductionAttempts, 0), radiusDrivers: [...drivers.values()].sort((left, right) => right.durationSeconds - left.durationSeconds || left.statusDescription.localeCompare(right.statusDescription)).slice(0, 8).map((item) => ({ ...item, durationSeconds: round(item.durationSeconds) })), repeatedRadiusStates: [...counts].filter(([, count]) => count > 1).map(([state]) => stateLabels.get(state) ?? state), loopCount: loops }
}

export function segmentProductionContextEpisodes(input: { pressKey: RadiusPressKey; range: { start: string; end: string }; initialValues: Partial<Record<ProductionContextIdentityField, unknown>>; observations: ContextTimelineObservation[]; gaps?: Array<{ start: string; end: string }>; radiusSegments?: RadiusStatusSegment[]; operationalEpisodes?: OperationalEpisode[] }): ProductionContextEpisode[] {
  const values = { ...input.initialValues }; const boundaries = new Map<string, { atUtc: string; observations: ContextTimelineObservation[]; gap?: 'start' | 'end' }>()
  for (const observation of input.observations) {
    if (!PRODUCTION_CONTEXT_IDENTITY_FIELDS.includes(observation.field) || Date.parse(observation.atUtc) < Date.parse(input.range.start) || Date.parse(observation.atUtc) > Date.parse(input.range.end)) continue
    const item = boundaries.get(observation.atUtc) ?? { atUtc: observation.atUtc, observations: [] }; item.observations.push(observation); boundaries.set(observation.atUtc, item)
  }
  for (const gap of input.gaps ?? []) {
    boundaries.set(gap.start, { atUtc: gap.start, observations: [], gap: 'start' })
    boundaries.set(gap.end, { atUtc: gap.end, observations: [], gap: 'end' })
  }
  const ordered = [...boundaries.values()].sort((left, right) => Date.parse(left.atUtc) - Date.parse(right.atUtc) || (left.gap === 'start' ? -1 : 1))
  const result: ProductionContextEpisode[] = []; let start = input.range.start; let identity = buildProductionContextIdentity(input.pressKey, values); let startedBy: string | null = 'range_start'; let startedAfterDataGap = false; let changeCount = 0; let inGap = false
  const close = (endUtc: string, endedBy: string | null) => {
    if (!identity || Date.parse(endUtc) <= Date.parse(start)) return
    const range = { startUtc: start, endUtc }; const durationSeconds = (Date.parse(endUtc) - Date.parse(start)) / 1_000; const metrics = operationalMetrics(range, input.radiusSegments ?? [], input.operationalEpisodes ?? [])
    const observedSeconds = Math.max(0, durationSeconds - metrics.unavailableSeconds)
    result.push({ episodeId: `${input.pressKey}.context.${identity.contextKey}.${start}`, pressKey: input.pressKey, identity, startUtc: start, endUtc, durationSeconds: round(durationSeconds), coveragePercent: durationSeconds > 0 ? round(observedSeconds / durationSeconds * 100) : 0, startedBy, endedBy, startedAfterDataGap, contextChangeCount: changeCount, metrics })
  }
  for (const boundary of ordered) {
    if (boundary.gap === 'start') { if (!inGap) close(boundary.atUtc, 'data_gap'); inGap = true; identity = null; continue }
    if (boundary.gap === 'end') { inGap = false; start = boundary.atUtc; identity = buildProductionContextIdentity(input.pressKey, values); startedBy = 'data_gap_end'; startedAfterDataGap = true; changeCount = 0; continue }
    const before = identity; const changedFields: string[] = []
    for (const observation of boundary.observations) { values[observation.field] = observation.value; changedFields.push(observation.field) }
    const after = inGap ? null : buildProductionContextIdentity(input.pressKey, values)
    if ((before?.contextKey ?? null) !== (after?.contextKey ?? null)) {
      close(boundary.atUtc, changedFields.join('+')); start = boundary.atUtc; identity = after; startedBy = changedFields.join('+'); startedAfterDataGap = false; changeCount = changedFields.length
    } else changeCount += changedFields.length
  }
  close(input.range.end, 'range_end')
  return result
}

function dimensionsMatch(current: ProductionContextIdentity, candidate: ProductionContextIdentity, fields: ProductionContextIdentityField[]): boolean {
  return fields.length > 0 && fields.every((field) => current.dimensions[field] !== undefined && current.dimensions[field] === candidate.dimensions[field])
}

function dimensionSubsets(fields: ProductionContextIdentityField[]): ProductionContextIdentityField[][] {
  const values: ProductionContextIdentityField[][] = []
  for (let mask = 1; mask < 2 ** fields.length - 1; mask += 1) values.push(fields.filter((_field, index) => Boolean(mask & 2 ** index)))
  return values.sort((left, right) => right.length - left.length || identityKey(Object.fromEntries(left.map((field) => [field, field]))).localeCompare(identityKey(Object.fromEntries(right.map((field) => [field, field])))))
}

export function assessContextualBaseline(current: ProductionContextEpisode, prior: ProductionContextEpisode[], minimumSupport = 3): ContextualBaselineAssessment {
  const valid = prior.filter((item) => Date.parse(item.endUtc) <= Date.parse(current.startUtc) && item.coveragePercent >= 80 && item.durationSeconds > 0)
  const exactDimensions = current.identity.dimensionNames
  const attempts: ContextualBaselineAttempt[] = []
  const recordAttempt = (fallbackLevel: 1 | 2 | 3 | 4, matchingDimensions: ProductionContextIdentityField[], candidatesFound: number) => attempts.push({ fallbackLevel, matchingDimensions, candidatesFound, candidatesRejected: prior.length - candidatesFound })
  const exact = valid.filter((item) => dimensionsMatch(current.identity, item.identity, exactDimensions))
  recordAttempt(1, exactDimensions, exact.length)
  let cohort = exact; let level: 1 | 2 | 3 | 4 = 1; let matching = exactDimensions
  if (cohort.length < minimumSupport) {
    const subsets = dimensionSubsets(exactDimensions)
    const subsetsWithItems = subsets.map((fields) => ({ fields, items: valid.filter((item) => dimensionsMatch(current.identity, item.identity, fields)) }))
    subsetsWithItems.forEach(({ fields, items }) => recordAttempt(2, fields, items.length))
    const found = subsetsWithItems.find(({ items }) => items.length >= minimumSupport)
    if (found) { cohort = found.items; matching = found.fields; level = 2 }
    else {
      const sequence = current.metrics.radiusDrivers.slice(0, 3).map((item) => `${item.eventType}\u0000${item.statusCode ?? ''}\u0000${item.statusDescription}`).join('>')
      const family = valid.filter((item) => item.metrics.radiusDrivers.slice(0, 3).map((entry) => `${entry.eventType}\u0000${entry.statusCode ?? ''}\u0000${entry.statusDescription}`).join('>') === sequence)
      recordAttempt(3, [], family.length)
      if (sequence && family.length >= minimumSupport) { cohort = family; matching = []; level = 3 }
      else { cohort = valid; matching = []; level = 4; recordAttempt(4, [], valid.length) }
    }
  }
  if (cohort.length < minimumSupport) return { status: 'INSUFFICIENT_CONTEXTUAL_HISTORY', minimumRequired: minimumSupport, actualSupport: Math.max(0, ...attempts.map((item) => item.candidatesFound)), baseline: null, attempts }
  const historicalRange = { start: cohort.reduce((value, item) => Date.parse(item.startUtc) < Date.parse(value) ? item.startUtc : value, cohort[0]!.startUtc), end: cohort.reduce((value, item) => Date.parse(item.endUtc) > Date.parse(value) ? item.endUtc : value, cohort[0]!.endUtc) }
  const names = matching.map((field) => `${field[0]!.toUpperCase()}${field.slice(1)}`)
  const label = level <= 2 ? `Median of ${cohort.length} previous ${current.pressKey.replace('press', 'Press ')} episodes with the same ${names.join(' + ')}` : level === 3 ? `Median of ${cohort.length} previous comparable ${current.pressKey.replace('press', 'Press ')} Radius-sequence episodes` : `Median of ${cohort.length} recent comparable ${current.pressKey.replace('press', 'Press ')} episodes`
  const baseline = { baselineType: level < 4 ? 'context' as const : 'press' as const, fallbackLevel: level, matchingDimensions: matching, sampleCount: cohort.length, historicalRange, coveragePercent: round(median(cohort.map((item) => item.coveragePercent))), label, medians: { productionInterruptions: round(median(cohort.map((item) => item.metrics.productionInterruptions))), longestInterruptionSeconds: round(median(cohort.map((item) => item.metrics.longestInterruptionSeconds))), totalInterruptionSeconds: round(median(cohort.map((item) => item.metrics.totalInterruptionSeconds))), returnAttempts: round(median(cohort.map((item) => item.metrics.returnAttempts))), episodeDurationSeconds: round(median(cohort.map((item) => item.durationSeconds))) } }
  return { status: 'SUFFICIENT', minimumRequired: minimumSupport, actualSupport: cohort.length, baseline, attempts }
}

export function contextualBaseline(current: ProductionContextEpisode, prior: ProductionContextEpisode[], minimumSupport = 3): ContextualBaseline | null {
  return assessContextualBaseline(current, prior, minimumSupport).baseline
}
