import { exactRadiusIdentity } from '../radius/radius-identity.js'
import { RADIUS_PRESS_KEYS, type RadiusPressKey, type RadiusStatusSegment } from '../radius/models.js'
import { RadiusUnavailableError, type RadiusService } from '../radius/radius-service.js'
import { ENGINEERING_CLUE_CATALOG, type EngineeringCategory, type EngineeringSignalType } from '../telemetry/engineering-clue-analysis.js'
import type { PressSemanticSignalEvidence, TelemetryChange, TelemetrySample, TelemetryScalarValue, TelemetrySemanticSelector } from '../telemetry/telemetry-contracts.js'
import { TelemetryFoundationService } from '../telemetry/telemetry-foundation-service.js'

const TWO_HOURS_MS = 2 * 60 * 60_000
const SELECTOR_BATCH_SIZE = 50
const REQUEST_CONCURRENCY = 3
export const RAW_EXPLORER_MAX_WINDOW_MINUTES = 24 * 60

export interface RawExplorerIdentity {
  identity: string
  eventType: 'G' | 'B' | 'M' | 'S'
  statusCode: string
  statusDescription: string
  eventCount: number
  lastSeenUtc: string | null
}

export interface RawExplorerOccurrence {
  occurrenceId: string
  pressKey: RadiusPressKey
  displayName: string
  pressOccurrenceIndex: number
  pressOccurrenceCount: number
  eventType: string
  statusCode: string
  statusDescription: string
  startUtc: string
  endUtc: string
  durationSeconds: number
  chartFromUtc: string
  chartToUtc: string
}

export interface RawExplorerSetup {
  fromUtc: string
  toUtc: string
  identity: { eventType: 'G' | 'B' | 'M' | 'S'; statusCode: string; statusDescription: string }
  changeLookbackMinutes: number
  chartContextMinutes: number
}

export interface RawExplorerSignalIdentity {
  canonicalId: string
  deckNumber: number | null
  friendlyName: string
  signalType: EngineeringSignalType
  category: EngineeringCategory
  scope: 'machine' | 'deck'
}

export interface RawExplorerNumericSummary {
  kind: 'numeric'
  firstValue: number
  lastValue: number
  netDelta: number
  minimum: number
  maximum: number
  largestPositiveExcursion: number
  largestNegativeExcursion: number
  largestAbsoluteExcursion: number
  observationCount: number
}

export interface RawExplorerStateSummary {
  kind: 'state'
  firstValue: TelemetryScalarValue
  lastValue: TelemetryScalarValue
  transitions: Array<{ atUtc: string; previousValue: TelemetryScalarValue; value: TelemetryScalarValue }>
}

export interface RawExplorerChangedSignal extends RawExplorerSignalIdentity {
  summary: RawExplorerNumericSummary | RawExplorerStateSummary
  sourceUnit: string | null
  canonicalUnitStatus: string | null
}

export interface RawExplorerSignalHistory extends RawExplorerSignalIdentity {
  representation: 'samples' | 'changes'
  sourceUnit: string | null
  canonicalUnitStatus: string | null
  seed: TelemetrySample | null
  samples: TelemetrySample[]
  changes: TelemetryChange[]
}

interface HistoryLoad {
  signals: PressSemanticSignalEvidence[]
  requestCount: number
  selectorCount: number
  totalMs: number
}

function signalKey(signal: { canonicalId: string; deckNumber?: number | null }) {
  return `${signal.canonicalId}:${signal.deckNumber ?? ''}`
}

function sameIdentity(segment: RadiusStatusSegment, identity: RawExplorerSetup['identity']) {
  return segment.kind === 'radius' && segment.eventType === identity.eventType && segment.statusCode === identity.statusCode && segment.statusDescription === identity.statusDescription
}

function mapWithConcurrency<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await work(items[index]!)
    }
  }
  return Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker)).then(() => results)
}

// Historian values are rounded to 12 significant digits only to remove binary
// serialization tails. This is not a process threshold: every remaining exact
// stored-value change is retained as descriptive evidence.
export function normalizeHistorianNumber(value: number): number {
  return Number(value.toPrecision(12))
}

function scalarEqual(left: TelemetryScalarValue, right: TelemetryScalarValue) {
  return typeof left === 'number' && typeof right === 'number'
    ? normalizeHistorianNumber(left) === normalizeHistorianNumber(right)
    : left === right
}

function uniqueBy<T>(values: T[], key: (value: T) => string): T[] {
  const seen = new Set<string>()
  return values.filter((value) => { const id = key(value); if (seen.has(id)) return false; seen.add(id); return true })
}

export function samplesWithSeed(signal: Pick<PressSemanticSignalEvidence, 'seed' | 'samples'>): TelemetrySample[] {
  return uniqueBy([...(signal.seed ? [signal.seed] : []), ...signal.samples], ({ observedAtUtc }) => observedAtUtc)
    .sort((left, right) => Date.parse(left.observedAtUtc) - Date.parse(right.observedAtUtc))
}

function mergeSignals(histories: PressSemanticSignalEvidence[][]): PressSemanticSignalEvidence[] {
  const merged = new Map<string, PressSemanticSignalEvidence>()
  for (const history of histories.flat()) {
    const key = signalKey(history)
    const current = merged.get(key)
    if (!current) { merged.set(key, { ...history, samples: [...history.samples], changes: [...history.changes] }); continue }
    current.seed ??= history.seed
    current.samples.push(...history.samples)
    current.changes.push(...history.changes)
  }
  for (const value of merged.values()) {
    value.samples = uniqueBy(value.samples, (item) => `${item.observedAtUtc}|${item.valueKind}|${String(item.value)}`).sort((a, b) => Date.parse(a.observedAtUtc) - Date.parse(b.observedAtUtc))
    value.changes = uniqueBy(value.changes, (item) => `${item.observedAtUtc}|${String(item.previousValue)}|${String(item.value)}`).sort((a, b) => Date.parse(a.observedAtUtc) - Date.parse(b.observedAtUtc))
  }
  return [...merged.values()]
}

export function numericSummary(signal: PressSemanticSignalEvidence, fromMs: number, toMs: number): RawExplorerNumericSummary | null {
  const values = signal.representation === 'samples'
    ? [
        ...(signal.seed && Date.parse(signal.seed.observedAtUtc) <= fromMs && typeof signal.seed.value === 'number' && Number.isFinite(signal.seed.value) ? [normalizeHistorianNumber(signal.seed.value)] : []),
        ...signal.samples.filter((item) => Date.parse(item.observedAtUtc) >= fromMs && Date.parse(item.observedAtUtc) < toMs && typeof item.value === 'number' && Number.isFinite(item.value)).map((item) => normalizeHistorianNumber(item.value as number)),
      ]
    : [
        ...(signal.seed && Date.parse(signal.seed.observedAtUtc) <= fromMs && typeof signal.seed.value === 'number' ? [normalizeHistorianNumber(signal.seed.value)] : []),
        ...signal.changes.filter((item) => Date.parse(item.observedAtUtc) >= fromMs && Date.parse(item.observedAtUtc) < toMs && typeof item.value === 'number' && Number.isFinite(item.value)).map((item) => normalizeHistorianNumber(item.value as number)),
      ]
  if (values.length < 2) return null
  const firstValue = values[0]!
  if (values.every((value) => value === firstValue)) return null
  const lastValue = values.at(-1)!
  const excursions = values.map((value) => value - firstValue)
  const largestPositiveExcursion = Math.max(0, ...excursions)
  const largestNegativeExcursion = Math.min(0, ...excursions)
  return {
    kind: 'numeric', firstValue, lastValue, netDelta: lastValue - firstValue,
    minimum: Math.min(...values), maximum: Math.max(...values),
    largestPositiveExcursion, largestNegativeExcursion,
    largestAbsoluteExcursion: Math.max(Math.abs(largestPositiveExcursion), Math.abs(largestNegativeExcursion)),
    observationCount: values.length,
  }
}

export function stateSummary(signal: PressSemanticSignalEvidence, fromMs: number, toMs: number): RawExplorerStateSummary | null {
  const transitions = signal.changes
    .filter((item) => Date.parse(item.observedAtUtc) >= fromMs && Date.parse(item.observedAtUtc) < toMs && !scalarEqual(item.previousValue, item.value))
    .map(({ observedAtUtc, previousValue, value }) => ({ atUtc: observedAtUtc, previousValue, value }))
  if (!transitions.length) return null
  return { kind: 'state', firstValue: transitions[0]!.previousValue, lastValue: transitions.at(-1)!.value, transitions }
}

export class RawRadiusExplorerService {
  constructor(private readonly radius: RadiusService, private readonly telemetry: TelemetryFoundationService, private readonly now: () => number = () => Date.now()) {}

  async identities(fromUtc: string, toUtc: string): Promise<RawExplorerIdentity[]> {
    const overview = await (this.radius.getAnalysisOverview?.(fromUtc, toUtc) ?? this.radius.getOverview(fromUtc, toUtc))
    const observed = new Map<string, RawExplorerIdentity>()
    for (const press of overview.presses) for (const segment of press.timelineSegments) {
      if (segment.kind !== 'radius' || !['G', 'B', 'M', 'S'].includes(segment.eventType) || typeof segment.statusCode !== 'string' || !segment.statusCode.trim() || !segment.statusDescription.trim()) continue
      const identity = exactRadiusIdentity(segment)
      const current = observed.get(identity)
      if (current) { current.eventCount += 1; if (!current.lastSeenUtc || Date.parse(segment.startUtc) > Date.parse(current.lastSeenUtc)) current.lastSeenUtc = segment.startUtc }
      else observed.set(identity, { identity, eventType: segment.eventType as RawExplorerIdentity['eventType'], statusCode: segment.statusCode, statusDescription: segment.statusDescription, eventCount: 1, lastSeenUtc: segment.startUtc })
    }
    return [...observed.values()]
      .sort((a, b) => a.eventType.localeCompare(b.eventType) || a.statusCode.localeCompare(b.statusCode, undefined, { numeric: true }) || a.statusDescription.localeCompare(b.statusDescription))
  }

  async explore(input: RawExplorerSetup) {
    const started = this.now()
    const overview = await (this.radius.getAnalysisOverview?.(input.fromUtc, input.toUtc) ?? this.radius.getOverview(input.fromUtc, input.toUtc))
    const occurrences: RawExplorerOccurrence[] = []
    for (const pressKey of RADIUS_PRESS_KEYS) {
      const press = overview.presses.find((item) => item.pressKey === pressKey)
      if (!press) continue
      const matching = press.timelineSegments.filter((segment) => sameIdentity(segment, input.identity))
      matching.forEach((segment, index) => {
        const contextMs = input.chartContextMinutes * 60_000
        occurrences.push({
          occurrenceId: `${pressKey}:${segment.startUtc}:${index}`,
          pressKey, displayName: press.displayName,
          pressOccurrenceIndex: index + 1, pressOccurrenceCount: matching.length,
          ...input.identity,
          startUtc: segment.startUtc, endUtc: segment.endUtc, durationSeconds: segment.durationSeconds,
          chartFromUtc: new Date(Date.parse(segment.startUtc) - contextMs).toISOString(),
          chartToUtc: new Date(Date.parse(segment.endUtc) + contextMs).toISOString(),
        })
      })
    }
    const pressCounts = RADIUS_PRESS_KEYS.flatMap((pressKey) => {
      const values = occurrences.filter((item) => item.pressKey === pressKey)
      return values.length ? [{ pressKey, displayName: values[0]!.displayName, occurrenceCount: values.length }] : []
    })
    const response = {
      setup: input,
      summary: {
        totalOccurrences: occurrences.length,
        pressesContainingCode: pressCounts.length,
        totalObservedDurationSeconds: occurrences.reduce((sum, item) => sum + item.durationSeconds, 0),
        pressCounts,
      },
      occurrences,
      performance: { totalMs: this.now() - started, payloadBytes: 0 },
    }
    response.performance.payloadBytes = Buffer.byteLength(JSON.stringify(response))
    return response
  }

  private selectors(capabilities: Awaited<ReturnType<TelemetryFoundationService['capabilities']['get']>>['capabilities']) {
    return ENGINEERING_CLUE_CATALOG.flatMap((item) => {
      if (item.canonicalId === 'physical.motion_state' || item.canonicalId === 'machine.speed.actual') return []
      const capability = capabilities.find((candidate) => candidate.canonicalId === item.canonicalId)
      if (capability?.state !== 'SUPPORTED' || !capability.historyQueryable || capability.evidenceKind !== 'semantic_history') return []
      const representation = item.signalType === 'continuous' ? 'samples' as const : 'changes' as const
      return item.scope === 'deck'
        ? capability.deckNumbers.filter((deck) => deck >= 1 && deck <= 10).map((deckNumber) => ({ item, selector: { canonicalId: item.canonicalId, deckNumber, representation } }))
        : [{ item, selector: { canonicalId: item.canonicalId, representation } }]
    })
  }

  private async history(pressKey: RadiusPressKey, fromUtc: string, toUtc: string, selectors: TelemetrySemanticSelector[], includeSeed: boolean, requestId?: string, signal?: AbortSignal): Promise<HistoryLoad> {
    const started = this.now()
    const chunks: Array<{ fromUtc: string; toUtc: string; chunkIndex: number }> = []
    const fromMs = Date.parse(fromUtc); const toMs = Date.parse(toUtc)
    for (let cursor = fromMs, index = 0; cursor < toMs; cursor += TWO_HOURS_MS, index += 1) chunks.push({ fromUtc: new Date(cursor).toISOString(), toUtc: new Date(Math.min(toMs, cursor + TWO_HOURS_MS)).toISOString(), chunkIndex: index })
    const batches = Array.from({ length: Math.ceil(selectors.length / SELECTOR_BATCH_SIZE) }, (_, index) => selectors.slice(index * SELECTOR_BATCH_SIZE, (index + 1) * SELECTOR_BATCH_SIZE))
    const jobs = chunks.flatMap((chunk) => batches.map((signals) => ({ ...chunk, signals })))
    const histories = await mapWithConcurrency(jobs, REQUEST_CONCURRENCY, (job) => this.telemetry.semanticHistory(pressKey, { fromUtc: job.fromUtc, toUtc: job.toUtc, includeSeed: includeSeed && job.chunkIndex === 0, signals: job.signals }, requestId, signal))
    return { signals: mergeSignals(histories.map((item) => item.signals)), requestCount: jobs.length, selectorCount: selectors.length, totalMs: this.now() - started }
  }

  async detail(input: { occurrence: RawExplorerOccurrence; changeLookbackMinutes: number }, requestId?: string, signal?: AbortSignal) {
    if (!this.radius.getRawTimeline) throw new RadiusUnavailableError()
    const started = this.now()
    const { occurrence } = input
    const capabilities = await this.telemetry.capabilities.get(occurrence.pressKey, requestId, signal)
    const catalog = this.selectors(capabilities.capabilities)
    const lookbackFromUtc = new Date(Date.parse(occurrence.startUtc) - input.changeLookbackMinutes * 60_000).toISOString()
    const speedSelector: TelemetrySemanticSelector = { canonicalId: 'machine.speed.actual', representation: 'samples' }
    const [radius, speed, discovery] = await Promise.all([
      this.radius.getRawTimeline(occurrence.pressKey, occurrence.chartFromUtc, occurrence.chartToUtc),
      this.history(occurrence.pressKey, occurrence.chartFromUtc, occurrence.chartToUtc, [speedSelector], true, requestId, signal),
      this.history(occurrence.pressKey, lookbackFromUtc, occurrence.startUtc, catalog.map(({ selector }) => selector), true, requestId, signal),
    ])
    const byKey = new Map(catalog.map(({ item, selector }) => [signalKey(selector), item]))
    const changedSignals = discovery.signals.flatMap((item): RawExplorerChangedSignal[] => {
      const definition = byKey.get(signalKey(item))
      if (!definition) return []
      const summary = definition.signalType === 'state_event'
        ? stateSummary(item, Date.parse(lookbackFromUtc), Date.parse(occurrence.startUtc))
        : numericSummary(item, Date.parse(lookbackFromUtc), Date.parse(occurrence.startUtc))
      if (!summary) return []
      return [{ canonicalId: item.canonicalId, deckNumber: item.deckNumber, friendlyName: definition.friendlyName, signalType: definition.signalType, category: definition.category, scope: definition.scope, summary, sourceUnit: item.sourceUnit, canonicalUnitStatus: item.canonicalUnitStatus }]
    }).sort((a, b) => (a.deckNumber ?? 0) - (b.deckNumber ?? 0) || a.category.localeCompare(b.category) || a.friendlyName.localeCompare(b.friendlyName))
    const speedSignal = speed.signals.find((item) => item.canonicalId === 'machine.speed.actual')
    const response = {
      occurrence, lookback: { fromUtc: lookbackFromUtc, toUtc: occurrence.startUtc, halfOpen: true },
      radiusSegments: radius.segments,
      speed: speedSignal ? { sourceUnit: speedSignal.sourceUnit, canonicalUnitStatus: speedSignal.canonicalUnitStatus, samples: samplesWithSeed(speedSignal) } : { sourceUnit: null, canonicalUnitStatus: null, samples: [] },
      changedSignals,
      performance: { totalMs: this.now() - started, selectorCount: discovery.selectorCount, semanticHistoryRequests: discovery.requestCount + speed.requestCount, speedHistoryMs: speed.totalMs, payloadBytes: 0 },
    }
    response.performance.payloadBytes = Buffer.byteLength(JSON.stringify(response))
    return response
  }

  async plot(input: { occurrence: RawExplorerOccurrence; signal: RawExplorerSignalIdentity }, requestId?: string, abortSignal?: AbortSignal) {
    const capabilities = await this.telemetry.capabilities.get(input.occurrence.pressKey, requestId, abortSignal)
    const requestedSignalKey = signalKey(input.signal)
    const available = this.selectors(capabilities.capabilities).find(({ selector }) => signalKey(selector) === requestedSignalKey)
    if (!available) throw new RadiusUnavailableError()
    const loaded = await this.history(input.occurrence.pressKey, input.occurrence.chartFromUtc, input.occurrence.chartToUtc, [available.selector], true, requestId, abortSignal)
    const history = loaded.signals[0]
    if (!history) throw new RadiusUnavailableError()
    const response: { signal: RawExplorerSignalHistory; performance: { totalMs: number; semanticHistoryRequests: number; payloadBytes: number } } = {
      signal: { canonicalId: available.item.canonicalId, deckNumber: available.item.scope === 'deck' ? input.signal.deckNumber : null, friendlyName: available.item.friendlyName, signalType: available.item.signalType, category: available.item.category, scope: available.item.scope, representation: history.representation, sourceUnit: history.sourceUnit, canonicalUnitStatus: history.canonicalUnitStatus, seed: history.seed, samples: history.samples, changes: history.changes },
      performance: { totalMs: loaded.totalMs, semanticHistoryRequests: loaded.requestCount, payloadBytes: 0 },
    }
    response.performance.payloadBytes = Buffer.byteLength(JSON.stringify(response))
    return response
  }
}
