import { exactRadiusIdentity } from '../radius/radius-identity.js'
import { RADIUS_PRESS_KEYS, type RadiusPressKey, type RadiusStateSegment, type RadiusStatusSegment } from '../radius/models.js'
import { RadiusUnavailableError, type RadiusService } from '../radius/radius-service.js'
import { ENGINEERING_CLUE_CATALOG, type EngineeringCategory, type EngineeringClueCatalogItem, type EngineeringSignalType } from '../telemetry/engineering-clue-analysis.js'
import type { PressSemanticSignalEvidence, TelemetryChange, TelemetrySample, TelemetryScalarValue, TelemetrySemanticSelector } from '../telemetry/telemetry-contracts.js'
import { TelemetryFoundationService } from '../telemetry/telemetry-foundation-service.js'
import type { RawTelemetryChangedSignal, RawTelemetryHistoryResponse } from '../telemetry/telemetry-contracts.js'
import { InMemoryRawTelemetryReviewRepository, RawTelemetryReviewService, type RawTelemetryReviewStatus } from './raw-telemetry-review-service.js'
import { buildRadiusPhysicalAlignment, evidenceQuality, rankRelatedSignals, type BasicHistoricalSummary, type EvidencePhaseSummary } from '../industrial-analytics/explorer-evidence.js'
import { describeIndustrialNumeric } from '../industrial-analytics/industrial-analytics-service.js'
import { usableProductionContextValue } from '../industrial-analytics/production-context.js'

const TWO_HOURS_MS = 2 * 60 * 60_000
const SELECTOR_BATCH_SIZE = 50
const REQUEST_CONCURRENCY = 3
export const RAW_EXPLORER_MAX_WINDOW_MINUTES = 24 * 60
export const CURRENT_ROLL_LENGTH_CANONICAL_ID = 'production.roll.length.actual'

export const RAW_EXPLORER_LENGTH_CATALOG: readonly EngineeringClueCatalogItem[] = [
  { canonicalId: 'production.order.length.actual', friendlyName: 'Order Length', signalType: 'step_reference', category: 'repeat_other', scope: 'machine' },
  { canonicalId: 'production.order.length.target', friendlyName: 'Order Length Target', signalType: 'step_reference', category: 'repeat_other', scope: 'machine' },
  { canonicalId: CURRENT_ROLL_LENGTH_CANONICAL_ID, friendlyName: 'Current Roll Length', signalType: 'step_reference', category: 'repeat_other', scope: 'machine' },
  { canonicalId: 'production.roll.length.target', friendlyName: 'Roll Length Target', signalType: 'step_reference', category: 'repeat_other', scope: 'machine' },
  { canonicalId: 'production.previous_roll.length.actual', friendlyName: 'Previous Roll Length', signalType: 'step_reference', category: 'repeat_other', scope: 'machine' },
  { canonicalId: 'production.roll.remaining_length', friendlyName: 'Remaining Roll Length', signalType: 'step_reference', category: 'repeat_other', scope: 'machine' },
]

export const RAW_EXPLORER_DISCOVERY_CATALOG = [...new Map([...RAW_EXPLORER_LENGTH_CATALOG, ...ENGINEERING_CLUE_CATALOG].map((item) => [item.canonicalId, item])).values()]

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

export interface RawExplorerDetailOptions {
  /** Validation callers can disable the operator-triggered supplemental raw scan. */
  includeRawTelemetryDiscovery?: boolean
}

export interface RawExplorerRawChangedSignal extends RawTelemetryChangedSignal {
  reviewStatus: RawTelemetryReviewStatus
}

export interface RawExplorerRawHistory extends RawTelemetryHistoryResponse {
  reviewStatus: RawTelemetryReviewStatus
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

function quantile(values: number[], percentile: number) {
  const ordered = [...values].sort((a, b) => a - b); if (!ordered.length) return null
  return ordered[Math.min(ordered.length - 1, Math.max(0, Math.floor((ordered.length - 1) * percentile)))]!
}
function medianValue(values: number[]) { const ordered = [...values].sort((a, b) => a - b); const middle = Math.floor(ordered.length / 2); return ordered.length % 2 ? ordered[middle]! : (ordered[middle - 1]! + ordered[middle]!) / 2 }

function exactRadiusLabel(value: { eventType: string; statusCode: string | null; statusDescription: string }) { return `${value.eventType} / ${value.statusCode ?? '—'} / ${value.statusDescription}` }

export function observedRadiusEntrySegments(segments: RadiusStatusSegment[]) {
  return segments.filter((segment, index): segment is RadiusStateSegment => segment.kind === 'radius' && segments[index - 1]?.kind !== 'offline')
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

const MAX_CONTINUOUS_CHANGE_GAP_MS = 330_000
const MINIMUM_DISCOVERY_SAMPLE_GAP_MS = 900_000

function usableAnalysisQuality(qualityState: string | undefined) {
  const quality = qualityState?.toUpperCase() ?? ''
  return !['BAD', 'INVALID', 'UNAVAILABLE', 'NO_DATA', 'NODATA'].some((token) => quality.includes(token))
}

function latestContinuousNumericRun(values: Array<{ atUtc: string; value: number; usable: boolean }>) {
  const ordered = uniqueBy(values.filter(({ atUtc, value }) => Number.isFinite(Date.parse(atUtc)) && Number.isFinite(value)), ({ atUtc }) => atUtc)
    .sort((left, right) => Date.parse(left.atUtc) - Date.parse(right.atUtc))
  const gaps = ordered.slice(1).map((item, index) => Date.parse(item.atUtc) - Date.parse(ordered[index]!.atUtc)).filter((gap) => gap > 0).sort((left, right) => left - right)
  const median = gaps.length > 1 ? gaps[Math.floor((gaps.length - 1) / 2)]! : 0
  const gapLimit = Math.max(MINIMUM_DISCOVERY_SAMPLE_GAP_MS, median * 5)
  let runStart = 0
  ordered.forEach((item, index) => {
    if (!item.usable) runStart = index + 1
    else if (index > 0 && Date.parse(item.atUtc) - Date.parse(ordered[index - 1]!.atUtc) > gapLimit) runStart = index
  })
  return ordered.slice(runStart).filter(({ usable }) => usable)
}

function usableContinuousChange(change: TelemetryChange) {
  return usableAnalysisQuality(change.qualityState) && usableAnalysisQuality(change.previousQualityState)
    && Number.isFinite(Date.parse(change.observedAtUtc)) && Number.isFinite(Date.parse(change.previousObservedAtUtc))
    && Date.parse(change.observedAtUtc) - Date.parse(change.previousObservedAtUtc) <= MAX_CONTINUOUS_CHANGE_GAP_MS
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
    ? latestContinuousNumericRun([
        ...(signal.seed && Date.parse(signal.seed.observedAtUtc) <= fromMs && typeof signal.seed.value === 'number' && Number.isFinite(signal.seed.value) ? [{ atUtc: signal.seed.observedAtUtc, value: normalizeHistorianNumber(signal.seed.value), usable: usableAnalysisQuality(signal.seed.qualityState) }] : []),
        ...signal.samples.filter((item) => Date.parse(item.observedAtUtc) >= fromMs && Date.parse(item.observedAtUtc) < toMs && typeof item.value === 'number' && Number.isFinite(item.value)).map((item) => ({ atUtc: item.observedAtUtc, value: normalizeHistorianNumber(item.value as number), usable: usableAnalysisQuality(item.qualityState) })),
      ]).map(({ value }) => value)
    : signal.changes.filter((item) => Date.parse(item.observedAtUtc) >= fromMs && Date.parse(item.observedAtUtc) < toMs && usableContinuousChange(item) && typeof item.previousValue === 'number' && Number.isFinite(item.previousValue) && typeof item.value === 'number' && Number.isFinite(item.value)).flatMap((item, index) => [...(index === 0 ? [normalizeHistorianNumber(item.previousValue as number)] : []), normalizeHistorianNumber(item.value as number)])
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
    .filter((item) => Date.parse(item.observedAtUtc) >= fromMs && Date.parse(item.observedAtUtc) < toMs && usableContinuousChange(item) && !scalarEqual(item.previousValue, item.value))
    .map(({ observedAtUtc, previousValue, value }) => ({ atUtc: observedAtUtc, previousValue, value }))
  if (!transitions.length) return null
  return { kind: 'state', firstValue: transitions[0]!.previousValue, lastValue: transitions.at(-1)!.value, transitions }
}

export class RawRadiusExplorerService {
  constructor(
    private readonly radius: RadiusService,
    private readonly telemetry: TelemetryFoundationService,
    private readonly reviews = new RawTelemetryReviewService(new InMemoryRawTelemetryReviewRepository()),
    private readonly now: () => number = () => Date.now(),
  ) {}

  async identities(fromUtc: string, toUtc: string): Promise<RawExplorerIdentity[]> {
    const overview = await (this.radius.getAnalysisOverview?.(fromUtc, toUtc) ?? this.radius.getOverview(fromUtc, toUtc))
    const observed = new Map<string, RawExplorerIdentity>()
    for (const press of overview.presses) for (const segment of observedRadiusEntrySegments(press.timelineSegments)) {
      if (!['G', 'B', 'M', 'S'].includes(segment.eventType) || typeof segment.statusCode !== 'string' || !segment.statusCode.trim() || !segment.statusDescription.trim()) continue
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
      const matching = observedRadiusEntrySegments(press.timelineSegments).filter((segment) => sameIdentity(segment, input.identity))
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
    return RAW_EXPLORER_DISCOVERY_CATALOG.flatMap((item) => {
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

  async detail(input: { occurrence: RawExplorerOccurrence; changeLookbackMinutes: number }, requestId?: string, signal?: AbortSignal, options: RawExplorerDetailOptions = {}) {
    if (!this.radius.getRawTimeline) throw new RadiusUnavailableError()
    const started = this.now()
    const { occurrence } = input
    const capabilities = await this.telemetry.capabilities.get(occurrence.pressKey, requestId, signal)
    const catalog = this.selectors(capabilities.capabilities)
    const lookbackFromUtc = new Date(Date.parse(occurrence.startUtc) - input.changeLookbackMinutes * 60_000).toISOString()
    const speedSelector: TelemetrySemanticSelector = { canonicalId: 'machine.speed.actual', representation: 'samples' }
    const currentRollSelector = catalog.find(({ selector }) => selector.canonicalId === CURRENT_ROLL_LENGTH_CANONICAL_ID)?.selector
    const [radius, speed, discovery, currentRoll, rawDiscovery, productionContext] = await Promise.all([
      this.radius.getRawTimeline(occurrence.pressKey, occurrence.chartFromUtc, occurrence.chartToUtc),
      this.history(occurrence.pressKey, occurrence.chartFromUtc, occurrence.chartToUtc, [speedSelector], true, requestId, signal),
      this.history(occurrence.pressKey, lookbackFromUtc, occurrence.startUtc, catalog.map(({ selector }) => selector), true, requestId, signal),
      currentRollSelector
        ? this.history(occurrence.pressKey, occurrence.chartFromUtc, occurrence.chartToUtc, [currentRollSelector], true, requestId, signal).catch(() => undefined)
        : Promise.resolve(undefined),
      options.includeRawTelemetryDiscovery === false
        ? Promise.resolve(undefined)
        : Promise.resolve().then(() => this.telemetry.rawChanges(occurrence.pressKey, lookbackFromUtc, occurrence.startUtc, requestId, signal)).catch(() => undefined),
      Promise.resolve().then(() => this.telemetry.context(occurrence.pressKey, occurrence.chartFromUtc, occurrence.chartToUtc, requestId, signal)).catch(() => undefined),
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
    const currentRollSignal = currentRoll?.signals.find((item) => item.canonicalId === CURRENT_ROLL_LENGTH_CANONICAL_ID)
    const currentRollDefinition = RAW_EXPLORER_LENGTH_CATALOG.find((item) => item.canonicalId === CURRENT_ROLL_LENGTH_CANONICAL_ID)!
    const analysisSafeRawSignals = rawDiscovery?.signals.filter(({ unavailableObservationCount }) => unavailableObservationCount === 0) ?? []
    const rawReviews = rawDiscovery ? await this.reviews.list(occurrence.pressKey, analysisSafeRawSignals.map(({ rawIdentity }) => rawIdentity)).catch(() => []) : []
    const reviewByIdentity = new Map(rawReviews.map((item) => [item.rawIdentity, item.reviewStatus]))
    const contextEvidence = productionContext ? Object.values(productionContext.fields).flatMap((field) => {
      const changes = field.changes.filter((item) => Date.parse(item.observedAtUtc) <= Date.parse(occurrence.startUtc))
      const observed = changes.at(-1)?.value ?? field.seed?.value
      const value = usableProductionContextValue(observed)
      return value === null ? [] : [{ field: field.field, value }]
    }) : []
    const speedSamples = speedSignal ? samplesWithSeed(speedSignal).flatMap((item) => typeof item.value === 'number' ? [{ atUtc: item.observedAtUtc, value: item.value, qualityState: item.qualityState }] : []) : []
    const occurrenceSegmentIndex = radius.segments.findIndex((item) => item.kind === 'radius' && item.eventType === occurrence.eventType && item.statusCode === occurrence.statusCode && item.statusDescription === occurrence.statusDescription && item.startUtc === occurrence.startUtc)
    const sequenceEvidence = [
      ...(occurrenceSegmentIndex > 0 && radius.segments[occurrenceSegmentIndex - 1]?.kind === 'radius' ? [{ ...radius.segments[occurrenceSegmentIndex - 1], relationship: 'PREVIOUS' as const }] : []),
      { eventType: occurrence.eventType, statusCode: occurrence.statusCode, statusDescription: occurrence.statusDescription, relationship: 'CURRENT' as const },
      ...(occurrenceSegmentIndex >= 0 && radius.segments[occurrenceSegmentIndex + 1]?.kind === 'radius' ? [{ ...radius.segments[occurrenceSegmentIndex + 1], relationship: 'NEXT' as const }] : []),
    ].map(({ eventType, statusCode, statusDescription, relationship }) => ({ eventType: eventType!, statusCode, statusDescription: statusDescription!, relationship }))
    const physicalAlignment = buildRadiusPhysicalAlignment({ pressKey: occurrence.pressKey, occurrenceId: occurrence.occurrenceId, recordedRadius: { eventType: occurrence.eventType, statusCode: occurrence.statusCode, statusDescription: occurrence.statusDescription }, recordedStartUtc: occurrence.startUtc, recordedEndUtc: occurrence.endUtc, speedSamples, sourceUnit: speedSignal?.sourceUnit ?? null, contextEvidence, radiusSequenceEvidence: sequenceEvidence, otherTelemetryEvidence: changedSignals.flatMap((item) => item.summary.kind === 'state' && item.summary.transitions.length ? [{ canonicalId: item.canonicalId, deckNumber: item.deckNumber, observedAtUtc: item.summary.transitions.at(-1)!.atUtc, reason: 'Value transition before the recorded Radius entry' }] : []) })
    const speedPhase = (fromUtc: string, toUtc: string) => describeIndustrialNumeric(speedSamples.filter((item) => Date.parse(item.atUtc) >= Date.parse(fromUtc) && Date.parse(item.atUtc) <= Date.parse(toUtc)))
    const phaseSummary: EvidencePhaseSummary = { eventStartUtc: occurrence.startUtc, eventEndUtc: occurrence.endUtc, items: [
      ...contextEvidence.map((item) => ({ phase: 'BACKGROUND' as const, atUtc: occurrence.startUtc, label: `${item.field[0]!.toUpperCase()}${item.field.slice(1)}`, detail: String(item.value), source: 'production_context' as const, canonicalId: `production.${item.field}`, deckNumber: null })),
      ...(physicalAlignment.inferredPhysicalOnsetRange ? [{ phase: 'PRECURSOR' as const, atUtc: physicalAlignment.inferredPhysicalOnsetRange.endUtc, label: 'Actual Speed materially changed', detail: 'Possible physical transition; activity remains unknown.', source: 'telemetry' as const, canonicalId: 'machine.speed.actual', deckNumber: null }] : []),
      { phase: 'TARGET' as const, atUtc: occurrence.startUtc, label: `Recorded Radius: ${exactRadiusLabel({ eventType: occurrence.eventType, statusCode: occurrence.statusCode, statusDescription: occurrence.statusDescription })}`, detail: null, source: 'radius' as const, canonicalId: null, deckNumber: null },
    ], limitations: ['Phase labels organize observed timing and do not establish causation.', 'Actual Speed is physical-boundary evidence, not a physical-state classifier.'] }
    const suggestedSignals = rankRelatedSignals([
      ...(speedSamples.length ? [{ canonicalId: 'machine.speed.actual', deckNumber: null, friendlyName: 'Actual Speed', signalType: 'continuous', category: 'speed', scope: 'machine' as const, reasonCodes: ['ACTUAL_SPEED_CONTEXT' as const], timingDetail: physicalAlignment.inferredPhysicalOnsetRange ? `Changed near ${physicalAlignment.inferredPhysicalOnsetRange.endUtc}` : null }] : []),
      ...changedSignals.map((item) => ({ canonicalId: item.canonicalId, deckNumber: item.deckNumber, friendlyName: item.friendlyName, signalType: item.signalType, category: item.category, scope: item.scope, reasonCodes: [item.summary.kind === 'numeric' ? 'DELTA_NEAR_EVENT' as const : 'VALUE_TRANSITION' as const], timingDetail: item.summary.kind === 'numeric' ? `${item.summary.netDelta >= 0 ? '+' : ''}${item.summary.netDelta.toPrecision(3)} in the pre-entry window` : `${item.summary.transitions.length} transition${item.summary.transitions.length === 1 ? '' : 's'} before entry` })),
    ], null, 5)
    const response = {
      occurrence, lookback: { fromUtc: lookbackFromUtc, toUtc: occurrence.startUtc, halfOpen: true },
      radiusSegments: radius.segments,
      currentRollLength: currentRollSignal ? { canonicalId: CURRENT_ROLL_LENGTH_CANONICAL_ID, deckNumber: null, friendlyName: currentRollDefinition.friendlyName, signalType: currentRollDefinition.signalType, category: currentRollDefinition.category, scope: currentRollDefinition.scope, representation: currentRollSignal.representation, sourceUnit: currentRollSignal.sourceUnit, canonicalUnitStatus: currentRollSignal.canonicalUnitStatus, seed: currentRollSignal.seed, samples: currentRollSignal.samples, changes: currentRollSignal.changes } : null,
      speed: speedSignal ? { sourceUnit: speedSignal.sourceUnit, canonicalUnitStatus: speedSignal.canonicalUnitStatus, samples: samplesWithSeed(speedSignal) } : { sourceUnit: null, canonicalUnitStatus: null, samples: [] },
      changedSignals,
      rawTelemetry: rawDiscovery ? {
        status: 'available' as const,
        signals: analysisSafeRawSignals.map((item): RawExplorerRawChangedSignal => ({ ...item, reviewStatus: reviewByIdentity.get(item.rawIdentity) ?? 'UNREVIEWED' })),
        counts: { rawCatalogIdentityCount: rawDiscovery.rawCatalogIdentityCount, canonicallyRepresentedIdentityCount: rawDiscovery.canonicallyRepresentedIdentityCount, unmappedIdentityCount: rawDiscovery.unmappedIdentityCount, usableIdentityCount: rawDiscovery.usableIdentityCount, changedIdentityCount: analysisSafeRawSignals.length },
        historianReadCount: rawDiscovery.historianReadCount,
      } : { status: 'unavailable' as const, signals: [], counts: null, historianReadCount: 0 },
      evidence: {
        physicalAlignment,
        productionContext: contextEvidence,
        phaseSummary,
        behavior: { signal: 'machine.speed.actual', unit: speedSignal?.sourceUnit ?? null, before: speedPhase(occurrence.chartFromUtc, occurrence.startUtc), during: speedPhase(occurrence.startUtc, occurrence.endUtc), after: speedPhase(occurrence.endUtc, occurrence.chartToUtc) },
        radiusSequence: sequenceEvidence,
        suggestedSignals,
      },
      performance: { totalMs: this.now() - started, selectorCount: discovery.selectorCount, semanticHistoryRequests: discovery.requestCount + speed.requestCount + (currentRoll?.requestCount ?? 0), speedHistoryMs: speed.totalMs, payloadBytes: 0 },
    }
    response.performance.payloadBytes = Buffer.byteLength(JSON.stringify(response))
    return response
  }

  async historicalSummary(input: { occurrence: RawExplorerOccurrence; lookbackDays?: number; maximumOccurrences?: number }): Promise<BasicHistoricalSummary> {
    if (!this.radius.getExactIdentityHistory) throw new RadiusUnavailableError()
    const started = this.now()
    const lookbackDays = Math.min(31, Math.max(1, input.lookbackDays ?? 31)); const maximum = Math.min(100, Math.max(1, input.maximumOccurrences ?? 100))
    const fromUtc = new Date(Date.parse(input.occurrence.startUtc) - lookbackDays * 24 * 60 * 60_000).toISOString(); const toUtc = input.occurrence.startUtc
    const history = await this.radius.getExactIdentityHistory({ pressKey: input.occurrence.pressKey, fromUtc, toUtc, identity: { eventType: input.occurrence.eventType, statusCode: input.occurrence.statusCode, statusDescription: input.occurrence.statusDescription }, maximumOccurrences: maximum })
    const comparable = history.occurrences.filter((item) => item.eventType === input.occurrence.eventType && item.statusCode === input.occurrence.statusCode && item.statusDescription === input.occurrence.statusDescription && item.startUtc !== input.occurrence.startUtc).slice(-maximum)
    const durations = comparable.map((item) => item.durationSeconds); const neighborCounts = (relationship: 'previousIdentity' | 'nextIdentity') => {
      const counts = new Map<string, number>(); for (const item of comparable) { const neighbor = item[relationship]; if (!neighbor) continue; const label = exactRadiusLabel(neighbor); counts.set(label, (counts.get(label) ?? 0) + 1) }
      return [...counts].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).slice(0, 3).map(([identity, count]) => `${identity} (${count})`).join(', ')
    }
    const historicalSpan = comparable.length ? { startUtc: comparable[0]!.startUtc, endUtc: comparable.at(-1)!.endUtc } : null
    const response: BasicHistoricalSummary = { scope: `Same press and exact Radius identity over the previous ${lookbackDays} days`, supportCount: comparable.length, timeSpan: historicalSpan, metrics: { medianDurationMinutes: durations.length ? Math.round(medianValue(durations) / 6) / 10 : null, durationLowerQuartileMinutes: durations.length ? Math.round(quantile(durations, .25)! / 6) / 10 : null, durationUpperQuartileMinutes: durations.length ? Math.round(quantile(durations, .75)! / 6) / 10 : null, commonPreviousIdentities: neighborCounts('previousIdentity') || null, commonNextIdentities: neighborCounts('nextIdentity') || null }, evidenceQuality: evidenceQuality({ timestamps: comparable.map((item) => item.startUtc), range: historicalSpan ?? { startUtc: fromUtc, endUtc: toUtc }, comparisonCount: comparable.length, historicalSpan, minimumSupport: 3, excludedReason: comparable.length ? null : 'No previous comparable recorded occurrences were found in the bounded range.' }), limitations: ['Typical recorded history is descriptive; it is not a correctness standard.', `At most ${maximum} occurrences are summarized.`, 'Historical telemetry fingerprints and operator-accuracy scoring are not included.'], performance: { radiusQueryCount: history.queryCount, rowsConsidered: history.rowsConsidered, matchingOccurrences: comparable.length, matchingOccurrencesAvailable: history.matchingOccurrencesAvailable, totalMs: this.now() - started, payloadBytes: 0 } }
    response.performance!.payloadBytes = Buffer.byteLength(JSON.stringify(response))
    return response
  }

  async plot(input: { occurrence: RawExplorerOccurrence; signal: RawExplorerSignalIdentity }, requestId?: string, abortSignal?: AbortSignal) {
    if (input.signal.canonicalId === CURRENT_ROLL_LENGTH_CANONICAL_ID && input.signal.deckNumber === null) throw new RadiusUnavailableError()
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

  async rawPlot(input: { occurrence: RawExplorerOccurrence; rawIdentity: string }, requestId?: string, abortSignal?: AbortSignal) {
    const started = this.now()
    const history = await this.telemetry.rawHistory(input.occurrence.pressKey, input.rawIdentity, input.occurrence.chartFromUtc, input.occurrence.chartToUtc, requestId, abortSignal)
    if (!history.plottable || history.dataKind === 'container') throw new RadiusUnavailableError()
    const response: { signal: RawExplorerRawHistory; performance: { totalMs: number; historianReadCount: number; payloadBytes: number } } = {
      signal: { ...history, reviewStatus: (await this.reviews.list(input.occurrence.pressKey, [input.rawIdentity]).catch(() => [])).at(0)?.reviewStatus ?? 'UNREVIEWED' },
      performance: { totalMs: this.now() - started, historianReadCount: history.historianReadCount, payloadBytes: 0 },
    }
    response.performance.payloadBytes = Buffer.byteLength(JSON.stringify(response))
    return response
  }

  review(press: RadiusPressKey, rawIdentity: string, status: RawTelemetryReviewStatus) {
    return this.reviews.set(press, rawIdentity, status)
  }
}
