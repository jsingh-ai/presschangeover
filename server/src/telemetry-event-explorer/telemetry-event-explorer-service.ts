import { RADIUS_PRESS_KEYS, type RadiusPressKey } from '../radius/models.js'
import { RadiusUnavailableError, type RadiusService } from '../radius/radius-service.js'
import { RAW_EXPLORER_DISCOVERY_CATALOG, RAW_EXPLORER_MAX_WINDOW_MINUTES, RawRadiusExplorerService, type RawExplorerOccurrence, type RawExplorerSignalIdentity } from '../raw-radius-explorer/raw-radius-explorer-service.js'
import type { EngineeringClueCatalogItem } from '../telemetry/engineering-clue-analysis.js'
import { PRODUCTION_CONTEXT_CANONICAL_IDS, type CapabilityAssessment, type PressSemanticSignalEvidence, type RawTelemetryHistoryResponse, type TelemetrySample, type TelemetryScalarValue, type TelemetrySemanticSelector, type TelemetrySourceSignal } from '../telemetry/telemetry-contracts.js'
import { TelemetryFoundationService, type PressSemanticSignalWithIdentity } from '../telemetry/telemetry-foundation-service.js'
import { detectDeltaEvents, detectThresholdEvents, detectValueChangeEvents, type DeltaDirection, type DeltaRule, type EventScalarValue, type NumericEventObservation, type ThresholdOperator, type ThresholdRule, type ValueChangeRule, type ValueEventObservation } from './telemetry-event-engine.js'
import { IndustrialAnalyticsService } from '../industrial-analytics/industrial-analytics-service.js'
import { rankRelatedSignals, type BasicHistoricalSummary, type EvidencePhaseSummary } from '../industrial-analytics/explorer-evidence.js'
import type { IndustrialAnalyticalObservation, IndustrialNumericSample, IndustrialStateSample } from '../industrial-analytics/contracts.js'
import { aggregateEventFingerprints, buildOccurrenceFingerprint, compareSelectedToTypical, EVENT_LEARNING_LIMITS, telemetryCoverage, type EventLearningOccurrence, type EventLearningReport, type EventLearningSignal } from '../industrial-analytics/event-learning.js'

const TWO_HOURS_MS = 2 * 60 * 60_000
const REQUEST_CONCURRENCY = 3
const SELECTOR_BATCH_SIZE = 50
export const TELEMETRY_EVENT_MAX_RANGE_MS = 31 * 24 * 60 * 60_000
export const TELEMETRY_EVENT_MAX_CONTEXT_MINUTES = 1_440

export type TelemetryEventSource =
  | { kind: 'canonical'; canonicalId: string }
  | { kind: 'raw'; pressKey: RadiusPressKey; rawIdentity: string; displayName: string; dataType?: string; dataKind?: string }

export type TelemetryEventRule =
  | { kind: 'threshold'; operator: ThresholdOperator; threshold: number }
  | { kind: 'delta'; direction: DeltaDirection; amount: number; windowMinutes: number }
  | ({ kind: 'value_change' } & ValueChangeRule)

export interface TelemetryEventSearchInput {
  fromUtc: string
  toUtc: string
  source: TelemetryEventSource
  pressKey: 'all' | RadiusPressKey
  deckNumber: 'any' | number | null
  rule: TelemetryEventRule
  chartContextMinutes: number
}

interface EventIdentity {
  sourceKind: 'canonical' | 'raw'
  pressKey: RadiusPressKey
  displayName: string
  deckNumber: number | null
  canonicalId: string | null
  rawIdentity: string
  signalDisplayName: string
  sourceUnit: string | null
  canonicalUnitStatus: string | null
  valueKind: string
  dataKind: 'numeric' | 'string' | 'boolean' | 'categorical'
}

export type TelemetryEventOccurrence = EventIdentity & {
  occurrenceId: string
  pressOccurrenceIndex: number
  pressOccurrenceCount: number
  startUtc: string
  endUtc: string
  durationSeconds: number
  chartFromUtc: string
  chartToUtc: string
  eventType: TelemetryEventRule['kind']
  clippedStart?: boolean
  clippedEnd: boolean
  dataGap: boolean
  entryValue?: number
  returnValue?: number | null
  extremeValue?: number
  extremeAtUtc?: string
  baselineAtUtc?: string
  baselineValue?: number
  triggerAtUtc?: string
  triggerValue?: number
  direction?: 'increase' | 'decrease'
  actualDelta?: number
  elapsedSeconds?: number
  maximumExcursion?: number
  maximumExcursionAtUtc?: string
  transitionAtUtc?: string
  previousAtUtc?: string | null
  previousValue?: EventScalarValue
  newValue?: EventScalarValue
}

interface LoadedHistory {
  signals: PressSemanticSignalWithIdentity[]
  requestCount: number
}

function key(value: { canonicalId: string; deckNumber?: number | null }) { return `${value.canonicalId}:${value.deckNumber ?? ''}` }

async function mapWithConcurrency<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length); let cursor = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (cursor < items.length) { const index = cursor++; results[index] = await task(items[index]!) } }))
  return results
}

function uniqueSamples(values: TelemetrySample[]): TelemetrySample[] {
  const byTimestamp = new Map<number, TelemetrySample>()
  for (const value of values.sort((a, b) => Date.parse(a.observedAtUtc) - Date.parse(b.observedAtUtc))) byTimestamp.set(Date.parse(value.observedAtUtc), value)
  return [...byTimestamp.values()]
}

function mergeHistories(values: PressSemanticSignalWithIdentity[][]): PressSemanticSignalWithIdentity[] {
  const merged = new Map<string, PressSemanticSignalWithIdentity>()
  for (const value of values.flat()) {
    const id = key(value); const current = merged.get(id)
    if (!current) { merged.set(id, { ...value, samples: [...value.samples], changes: [...value.changes] }); continue }
    current.seed ??= value.seed; current.rawSignalId ??= value.rawSignalId; current.historianSignalId ??= value.historianSignalId
    current.samples.push(...value.samples); current.changes.push(...value.changes)
  }
  for (const value of merged.values()) value.samples = uniqueSamples(value.samples)
  return [...merged.values()]
}

const CONTEXT_CATALOG: EngineeringClueCatalogItem[] = [
  ['job', 'Job'], ['order', 'Order'], ['recipe', 'Recipe'], ['customer', 'Customer'], ['material', 'Material'], ['roll', 'Roll'],
].map(([field, friendlyName]) => ({ canonicalId: PRODUCTION_CONTEXT_CANONICAL_IDS[field as keyof typeof PRODUCTION_CONTEXT_CANONICAL_IDS], friendlyName, signalType: 'state_event', category: 'repeat_other', scope: 'machine' }))
const EVENT_CATALOG = [...new Map([...CONTEXT_CATALOG, ...RAW_EXPLORER_DISCOVERY_CATALOG].map((item) => [item.canonicalId, item])).values()]

function definition(canonicalId: string): EngineeringClueCatalogItem | undefined { return EVENT_CATALOG.find((item) => item.canonicalId === canonicalId) }

function compatibleSelectors(item: EngineeringClueCatalogItem, capabilities: CapabilityAssessment[], deckNumber: TelemetryEventSearchInput['deckNumber'], representation: 'samples' | 'changes' = 'samples'): TelemetrySemanticSelector[] {
  const capability = capabilities.find((candidate) => candidate.canonicalId === item.canonicalId)
  if (capability?.state !== 'SUPPORTED' || !capability.historyQueryable || capability.evidenceKind !== 'semantic_history') return []
  if (item.scope === 'machine') return deckNumber === null || deckNumber === 'any' ? [{ canonicalId: item.canonicalId, representation }] : []
  const decks = capability.deckNumbers.filter((deck) => deck >= 1 && deck <= 10 && (deckNumber === 'any' || deck === deckNumber))
  return decks.map((deck) => ({ canonicalId: item.canonicalId, deckNumber: deck, representation }))
}

function scalarObservations(signal: PressSemanticSignalEvidence): ValueEventObservation[] {
  return signal.samples.flatMap((sample) => ['number', 'boolean', 'string'].includes(typeof sample.value) ? [{ atUtc: sample.observedAtUtc, value: sample.value as EventScalarValue, qualityState: sample.qualityState }] : [])
}

function scalarSeed(signal: PressSemanticSignalEvidence): ValueEventObservation | null {
  return signal.seed && ['number', 'boolean', 'string'].includes(typeof signal.seed.value) ? { atUtc: signal.seed.observedAtUtc, value: signal.seed.value as EventScalarValue, qualityState: signal.seed.qualityState } : null
}

function dataKind(valueKind: string | null | undefined): EventIdentity['dataKind'] {
  const normalized = valueKind?.toLowerCase() ?? ''
  if (normalized === 'numeric' || normalized === 'integer' || normalized === 'number') return 'numeric'
  if (normalized === 'boolean' || normalized === 'bool') return 'boolean'
  if (normalized === 'string' || normalized === 'text') return 'string'
  return 'categorical'
}

function rawCatalogItem(item: TelemetrySourceSignal, pressKey: RadiusPressKey) {
  const kind = dataKind(item.valueKind)
  return { kind: 'raw' as const, pressKey, rawIdentity: item.signalId, displayName: item.displayName, dataType: item.valueKind, dataKind: kind, discoveryCategory: 'Raw telemetry', sourceUnit: item.sourceUnit, plottable: kind !== 'categorical' }
}

function scalarForKind(value: unknown, kind: EventIdentity['dataKind']): value is EventScalarValue {
  if (kind === 'numeric') return typeof value === 'number' && Number.isFinite(value)
  if (kind === 'boolean') return typeof value === 'boolean'
  if (kind === 'string') return typeof value === 'string'
  return typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean' || typeof value === 'string'
}

function rawOccurrence(occurrence: TelemetryEventOccurrence): RawExplorerOccurrence {
  return {
    occurrenceId: occurrence.occurrenceId, pressKey: occurrence.pressKey, displayName: occurrence.displayName,
    pressOccurrenceIndex: occurrence.pressOccurrenceIndex, pressOccurrenceCount: occurrence.pressOccurrenceCount,
    eventType: 'TELEMETRY', statusCode: occurrence.eventType.toUpperCase(), statusDescription: occurrence.signalDisplayName,
    startUtc: occurrence.startUtc, endUtc: occurrence.endUtc, durationSeconds: occurrence.durationSeconds,
    chartFromUtc: occurrence.chartFromUtc, chartToUtc: occurrence.chartToUtc,
  }
}

export class TelemetryEventExplorerService {
  private readonly rawCatalogCache = new Map<RadiusPressKey, { expiresAt: number; values: TelemetrySourceSignal[] }>()
  private readonly analytics = new IndustrialAnalyticsService()
  constructor(private readonly telemetry: TelemetryFoundationService, private readonly radius: RadiusService, private readonly rawExplorer: RawRadiusExplorerService, private readonly now = () => Date.now()) {}

  private async capabilities(requestId?: string, signal?: AbortSignal) {
    return mapWithConcurrency([...RADIUS_PRESS_KEYS], REQUEST_CONCURRENCY, async (pressKey) => {
      try { return await this.telemetry.capabilities.get(pressKey, requestId, signal) } catch { return undefined }
    })
  }

  async catalog(_rawPressKey?: RadiusPressKey, _fromUtc?: string, _toUtc?: string, requestId?: string, signal?: AbortSignal) {
    const sets = await this.capabilities(requestId, signal)
    const variables = EVENT_CATALOG.filter((item) => item.canonicalId !== 'physical.motion_state').flatMap((item) => {
      const compatiblePresses = sets.flatMap((set) => {
        if (!set) return []
        const capability = set.capabilities.find(({ canonicalId }) => canonicalId === item.canonicalId)
        if (capability?.state !== 'SUPPORTED' || !capability.historyQueryable || capability.evidenceKind !== 'semantic_history') return []
        return [{ pressKey: set.pressKey, displayName: set.displayName, deckNumbers: item.scope === 'deck' ? capability.deckNumbers.filter((deck) => deck >= 1 && deck <= 10) : [] }]
      }).filter((source) => item.scope !== 'deck' || source.deckNumbers.length > 0)
      const expectedDataKind = item.signalType === 'state_event' ? (item.canonicalId.startsWith('production.') ? 'string' : 'categorical') : 'numeric'
      return compatiblePresses.length ? [{ kind: 'canonical' as const, canonicalId: item.canonicalId, displayName: item.friendlyName, scope: item.scope, signalType: item.signalType, dataKind: expectedDataKind, category: item.category, compatiblePresses }] : []
    })
    return { canonicalVariables: variables }
  }

  private async completeRawCatalog(pressKey: RadiusPressKey, requestId?: string, signal?: AbortSignal) {
    const cached = this.rawCatalogCache.get(pressKey)
    if (cached && cached.expiresAt > this.now()) return cached.values
    const values = await this.telemetry.rawCatalog(pressKey, requestId, signal)
    this.rawCatalogCache.set(pressKey, { expiresAt: this.now() + 5 * 60_000, values })
    return values
  }

  async rawCatalog(pressKey: RadiusPressKey, query: string, offset: number, limit: number, requestId?: string, signal?: AbortSignal) {
    const complete = (await this.completeRawCatalog(pressKey, requestId, signal)).map((item) => rawCatalogItem(item, pressKey))
    const normalized = query.trim().toLowerCase()
    const matching = normalized ? complete.filter((item) => `${item.displayName} ${item.rawIdentity} ${item.sourceUnit ?? ''} ${item.dataType}`.toLowerCase().includes(normalized)) : complete
    return { pressKey, query, offset, limit, total: matching.length, catalogTotal: complete.length, items: matching.slice(offset, offset + limit) }
  }

  private async history(pressKey: RadiusPressKey, fromUtc: string, toUtc: string, selectors: TelemetrySemanticSelector[], requestId?: string, signal?: AbortSignal): Promise<LoadedHistory> {
    const chunks: Array<{ fromUtc: string; toUtc: string; first: boolean }> = []
    const fromMs = Date.parse(fromUtc); const toMs = Date.parse(toUtc)
    for (let cursor = fromMs, index = 0; cursor < toMs; cursor += TWO_HOURS_MS, index += 1) chunks.push({ fromUtc: new Date(cursor).toISOString(), toUtc: new Date(Math.min(toMs, cursor + TWO_HOURS_MS)).toISOString(), first: index === 0 })
    const batches = Array.from({ length: Math.ceil(selectors.length / SELECTOR_BATCH_SIZE) }, (_, index) => selectors.slice(index * SELECTOR_BATCH_SIZE, (index + 1) * SELECTOR_BATCH_SIZE))
    const jobs = chunks.flatMap((chunk) => batches.map((signals) => ({ ...chunk, signals })))
    const responses = await mapWithConcurrency(jobs, REQUEST_CONCURRENCY, (job) => this.telemetry.semanticHistoryWithIdentity(pressKey, { fromUtc: job.fromUtc, toUtc: job.toUtc, includeSeed: job.first, signals: job.signals }, requestId, signal))
    return { signals: mergeHistories(responses.map(({ signals }) => signals)), requestCount: jobs.length }
  }

  private async rawHistory(pressKey: RadiusPressKey, rawIdentity: string, fromUtc: string, toUtc: string, requestId?: string, signal?: AbortSignal): Promise<{ history: RawTelemetryHistoryResponse; requestCount: number }> {
    const chunks: Array<{ fromUtc: string; toUtc: string }> = []
    const fromMs = Date.parse(fromUtc); const toMs = Date.parse(toUtc)
    for (let cursor = fromMs; cursor < toMs; cursor += TWO_HOURS_MS) chunks.push({ fromUtc: new Date(cursor).toISOString(), toUtc: new Date(Math.min(toMs, cursor + TWO_HOURS_MS)).toISOString() })
    const responses = await mapWithConcurrency(chunks, REQUEST_CONCURRENCY, (chunk) => this.telemetry.rawHistory(pressKey, rawIdentity, chunk.fromUtc, chunk.toUtc, requestId, signal))
    const first = responses[0]
    if (!first) throw new RadiusUnavailableError()
    const byTimestamp = new Map<number, RawTelemetryHistoryResponse['observations'][number]>()
    for (const item of responses.flatMap(({ observations }) => observations).sort((a, b) => Date.parse(a.timestampUtc) - Date.parse(b.timestampUtc))) byTimestamp.set(Date.parse(item.timestampUtc), item)
    return { history: { ...first, fromUtc, toUtc, historianReadCount: responses.reduce((sum, item) => sum + item.historianReadCount, 0), observations: [...byTimestamp.values()] }, requestCount: chunks.length }
  }

  async search(input: TelemetryEventSearchInput, requestId?: string, abortSignal?: AbortSignal) {
    const started = this.now()
    const resolved: Array<{ identity: EventIdentity; observations: ValueEventObservation[]; seed: ValueEventObservation | null }> = []
    let requestCount = 0
    if (input.source.kind === 'raw') {
      const rawSource = input.source
      const catalogSignal = (await this.completeRawCatalog(rawSource.pressKey, requestId, abortSignal)).find(({ signalId }) => signalId === rawSource.rawIdentity)
      if (!catalogSignal) throw new RadiusUnavailableError()
      const loaded = await this.rawHistory(rawSource.pressKey, rawSource.rawIdentity, input.fromUtc, input.toUtc, requestId, abortSignal)
      const history = loaded.history; const kind = dataKind(catalogSignal.valueKind)
      if (history.dataKind === 'container' || input.rule.kind !== 'value_change' && kind !== 'numeric') throw new RadiusUnavailableError()
      const observations = history.observations.flatMap((item): ValueEventObservation[] => scalarForKind(item.rawValue, kind) ? [{ atUtc: item.timestampUtc, value: item.rawValue, qualityState: item.qualityState }] : [])
      resolved.push({ identity: { sourceKind: 'raw', pressKey: rawSource.pressKey, displayName: history.displayName, deckNumber: null, canonicalId: null, rawIdentity: history.rawIdentity, signalDisplayName: catalogSignal.displayName, sourceUnit: catalogSignal.sourceUnit, canonicalUnitStatus: null, valueKind: catalogSignal.valueKind, dataKind: kind }, observations, seed: null })
      requestCount = loaded.requestCount
    } else {
      const item = definition(input.source.canonicalId)
      if (!item || input.rule.kind !== 'value_change' && item.signalType === 'state_event') throw new RadiusUnavailableError()
      const presses: RadiusPressKey[] = input.pressKey === 'all' ? [...RADIUS_PRESS_KEYS] : [input.pressKey]
      const jobs = (await mapWithConcurrency(presses, REQUEST_CONCURRENCY, async (pressKey) => {
        try {
          const capabilities = await this.telemetry.capabilities.get(pressKey, requestId, abortSignal)
          const selectors = compatibleSelectors(item, capabilities.capabilities, input.deckNumber, 'samples')
          if (!selectors.length) return undefined
          const loaded = await this.history(pressKey, input.fromUtc, input.toUtc, selectors, requestId, abortSignal)
          return { capabilities, loaded }
        } catch { return undefined }
      })).filter((value): value is NonNullable<typeof value> => Boolean(value))
      for (const job of jobs) {
        requestCount += job.loaded.requestCount
        for (const history of job.loaded.signals) {
          const observations = scalarObservations(history); const seed = scalarSeed(history)
          if (!observations.length && !seed) continue
          const kind = dataKind(history.valueKind ?? (item.signalType === 'state_event' ? 'categorical' : 'numeric'))
          if (input.rule.kind !== 'value_change' && kind !== 'numeric') continue
          resolved.push({ identity: { sourceKind: 'canonical', pressKey: job.capabilities.pressKey, displayName: job.capabilities.displayName, deckNumber: history.deckNumber, canonicalId: history.canonicalId, rawIdentity: history.rawSignalId ?? history.sourceSelector ?? history.canonicalId, signalDisplayName: item.friendlyName, sourceUnit: history.sourceUnit, canonicalUnitStatus: history.canonicalUnitStatus, valueKind: history.valueKind ?? kind, dataKind: kind }, observations, seed })
        }
      }
    }

    const contextMs = input.chartContextMinutes * 60_000
    const occurrences: TelemetryEventOccurrence[] = resolved.flatMap(({ identity, observations, seed }) => {
      const numericSeed: NumericEventObservation | null = seed && typeof seed.value === 'number' ? { ...seed, value: seed.value } : null
      const detections = input.rule.kind === 'threshold'
        ? detectThresholdEvents({ observations: observations.filter((item): item is NumericEventObservation => typeof item.value === 'number'), seed: numericSeed, fromUtc: input.fromUtc, toUtc: input.toUtc, rule: input.rule as ThresholdRule })
        : input.rule.kind === 'delta'
          ? detectDeltaEvents({ observations: observations.filter((item): item is NumericEventObservation => typeof item.value === 'number'), seed: numericSeed, fromUtc: input.fromUtc, toUtc: input.toUtc, rule: input.rule as DeltaRule })
          : detectValueChangeEvents({ observations, seed, fromUtc: input.fromUtc, toUtc: input.toUtc, rule: input.rule })
      return detections.map((event, index): TelemetryEventOccurrence => ({
        ...identity, ...event, eventType: input.rule.kind,
        occurrenceId: `${identity.pressKey}:${identity.deckNumber ?? 'machine'}:${encodeURIComponent(identity.rawIdentity)}:${event.startUtc}:${index}`,
        pressOccurrenceIndex: 0, pressOccurrenceCount: 0,
        chartFromUtc: new Date(Date.parse(event.startUtc) - contextMs).toISOString(),
        chartToUtc: new Date(Date.parse(event.endUtc) + contextMs).toISOString(),
      }))
    }).sort((a, b) => Date.parse(a.startUtc) - Date.parse(b.startUtc) || a.pressKey.localeCompare(b.pressKey) || (a.deckNumber ?? 0) - (b.deckNumber ?? 0))
    for (const occurrence of occurrences) {
      const samePress = occurrences.filter(({ pressKey }) => pressKey === occurrence.pressKey)
      occurrence.pressOccurrenceCount = samePress.length; occurrence.pressOccurrenceIndex = samePress.indexOf(occurrence) + 1
    }
    const pressCounts = RADIUS_PRESS_KEYS.flatMap((pressKey) => { const values = occurrences.filter((item) => item.pressKey === pressKey); return values.length ? [{ pressKey, displayName: values[0]!.displayName, occurrenceCount: values.length }] : [] })
    const response = { setup: input, summary: { totalOccurrences: occurrences.length, resolvedSeries: resolved.length, compatiblePressesSearched: [...new Set(resolved.map(({ identity }) => identity.pressKey))], compatibleDecksSearched: [...new Set(resolved.flatMap(({ identity }) => identity.deckNumber ?? []))].sort((a, b) => a - b), pressCounts }, occurrences, performance: { semanticHistoryRequests: requestCount, totalMs: this.now() - started, payloadBytes: 0 } }
    response.performance.payloadBytes = Buffer.byteLength(JSON.stringify(response))
    return response
  }

  async preview(input: { source: TelemetryEventSource; pressKey: RadiusPressKey; deckNumber: number | null; fromUtc: string; toUtc: string }, requestId?: string, signal?: AbortSignal) {
    if (input.source.kind === 'raw') {
      const rawSource = input.source
      if (rawSource.pressKey !== input.pressKey || input.deckNumber !== null) throw new RadiusUnavailableError()
      const catalogSignal = (await this.completeRawCatalog(input.pressKey, requestId, signal)).find(({ signalId }) => signalId === rawSource.rawIdentity)
      if (!catalogSignal) throw new RadiusUnavailableError()
      const loaded = await this.rawHistory(input.pressKey, rawSource.rawIdentity, input.fromUtc, input.toUtc, requestId, signal)
      const history = loaded.history; const kind = dataKind(catalogSignal.valueKind)
      const observations = history.observations.flatMap((item) => scalarForKind(item.rawValue, kind) ? [{ atUtc: new Date(Date.parse(item.timestampUtc)).toISOString(), value: item.rawValue, qualityState: item.qualityState }] : [])
      return { sourceKind: 'raw' as const, pressKey: input.pressKey, displayName: history.displayName, deckNumber: null, canonicalId: null, rawIdentity: history.rawIdentity, signalDisplayName: catalogSignal.displayName, dataType: catalogSignal.valueKind, dataKind: kind, sourceUnit: catalogSignal.sourceUnit, canonicalUnitStatus: null, fromUtc: input.fromUtc, toUtc: input.toUtc, plottable: history.dataKind !== 'container', observations }
    }
    const item = definition(input.source.canonicalId)
    if (!item) throw new RadiusUnavailableError()
    const capabilities = await this.telemetry.capabilities.get(input.pressKey, requestId, signal)
    const selectors = compatibleSelectors(item, capabilities.capabilities, input.deckNumber, 'samples')
    if (selectors.length !== 1) throw new RadiusUnavailableError()
    const history = (await this.history(input.pressKey, input.fromUtc, input.toUtc, selectors, requestId, signal)).signals[0]
    if (!history) throw new RadiusUnavailableError()
    const kind = dataKind(history.valueKind ?? (item.signalType === 'state_event' ? 'categorical' : 'numeric'))
    const observations = [...(history.seed ? [{ atUtc: history.seed.observedAtUtc, value: history.seed.value, qualityState: history.seed.qualityState }] : []), ...history.samples.map((sample) => ({ atUtc: sample.observedAtUtc, value: sample.value, qualityState: sample.qualityState }))]
    return { sourceKind: 'canonical' as const, pressKey: input.pressKey, displayName: capabilities.displayName, deckNumber: history.deckNumber, canonicalId: history.canonicalId, rawIdentity: history.rawSignalId ?? history.sourceSelector ?? history.canonicalId, signalDisplayName: item.friendlyName, dataType: history.valueKind ?? kind, dataKind: kind, sourceUnit: history.sourceUnit, canonicalUnitStatus: history.canonicalUnitStatus, fromUtc: input.fromUtc, toUtc: input.toUtc, plottable: true, observations }
  }

  async detail(occurrence: TelemetryEventOccurrence, requestId?: string, signal?: AbortSignal, options: { includeRawTelemetryDiscovery?: boolean } = {}) {
    const contextMinutes = Math.min(RAW_EXPLORER_MAX_WINDOW_MINUTES, Math.max(1, Math.ceil((Date.parse(occurrence.startUtc) - Date.parse(occurrence.chartFromUtc)) / 60_000)))
    const context = await this.rawExplorer.detail({ occurrence: rawOccurrence(occurrence), changeLookbackMinutes: contextMinutes }, requestId, signal, options)
    let primary: { kind: 'raw'; signal: RawTelemetryHistoryResponse } | { kind: 'canonical'; signal: PressSemanticSignalWithIdentity | undefined }
    if (occurrence.sourceKind === 'raw') {
      const history = (await this.rawHistory(occurrence.pressKey, occurrence.rawIdentity, occurrence.chartFromUtc, occurrence.chartToUtc, requestId, signal)).history
      primary = { kind: 'raw', signal: { ...history, dataType: occurrence.valueKind, dataKind: occurrence.dataKind, plottable: true, observations: history.observations.filter((item) => scalarForKind(item.rawValue, occurrence.dataKind)) } }
    } else if (occurrence.canonicalId === 'machine.speed.actual' && occurrence.deckNumber === null) primary = { kind: 'canonical', signal: { canonicalId: occurrence.canonicalId, deckNumber: null, capabilityState: 'SUPPORTED', observationState: context.speed.samples.length ? 'SUPPORTED_WITH_OBSERVATIONS' : 'SUPPORTED_WITH_NO_SAMPLES_IN_RANGE', mappingStatus: 'MAPPED', sourceUnit: context.speed.sourceUnit, canonicalUnitStatus: context.speed.canonicalUnitStatus, representation: 'samples', seed: null, samples: context.speed.samples, changes: [], valueKind: 'numeric', historianSignalId: null, rawSignalId: occurrence.rawIdentity, sourceSelector: occurrence.rawIdentity, selectedVariant: null } }
    else primary = { kind: 'canonical', signal: (await this.history(occurrence.pressKey, occurrence.chartFromUtc, occurrence.chartToUtc, [{ canonicalId: occurrence.canonicalId!, ...(occurrence.deckNumber === null ? {} : { deckNumber: occurrence.deckNumber }), representation: occurrence.eventType === 'value_change' ? 'changes' : 'samples' }], requestId, signal)).signals[0] }
    if (!primary.signal) throw new RadiusUnavailableError()
    const numeric: IndustrialNumericSample[] = primary.kind === 'canonical'
      ? [...(primary.signal.seed ? [primary.signal.seed] : []), ...primary.signal.samples].flatMap((item) => typeof item.value === 'number' ? [{ atUtc: item.observedAtUtc, value: item.value, qualityState: item.qualityState }] : [])
      : primary.signal.observations.flatMap((item) => typeof item.rawValue === 'number' ? [{ atUtc: item.timestampUtc, value: item.rawValue, qualityState: item.qualityState }] : [])
    const states: IndustrialStateSample[] = primary.kind === 'canonical'
      ? [...(primary.signal.seed ? [{ atUtc: primary.signal.seed.observedAtUtc, value: primary.signal.seed.value, qualityState: primary.signal.seed.qualityState }] : []), ...primary.signal.changes.map((item) => ({ atUtc: item.observedAtUtc, value: item.value, qualityState: item.qualityState }))].flatMap((item): IndustrialStateSample[] => ['string', 'number', 'boolean'].includes(typeof item.value) ? [{ atUtc: item.atUtc, value: item.value, qualityState: item.qualityState }] : [])
      : primary.signal.observations.flatMap((item) => ['string', 'number', 'boolean'].includes(typeof item.rawValue) ? [{ atUtc: item.timestampUtc, value: item.rawValue as string | number | boolean, qualityState: item.qualityState }] : [])
    const event = { id: occurrence.occurrenceId, start: occurrence.startUtc, end: occurrence.endUtc }; const range = { start: occurrence.chartFromUtc, end: occurrence.chartToUtc }
    const observations: IndustrialAnalyticalObservation[] = []
    if (numeric.length) {
      const aligned = this.analytics.eventAlignedNumeric({ pressKey: occurrence.pressKey, variableId: occurrence.canonicalId ?? occurrence.rawIdentity, deckNumber: occurrence.deckNumber, unit: occurrence.sourceUnit, range, samples: numeric, event }); if (aligned) observations.push(aligned)
      const envelope = this.analytics.normalEnvelopeDeparture({ pressKey: occurrence.pressKey, variableId: occurrence.canonicalId ?? occurrence.rawIdentity, deckNumber: occurrence.deckNumber, unit: occurrence.sourceUnit, range, samples: numeric, event }); if (envelope) observations.push(envelope)
      const persistence = this.analytics.deviationPersistence({ pressKey: occurrence.pressKey, variableId: occurrence.canonicalId ?? occurrence.rawIdentity, deckNumber: occurrence.deckNumber, unit: occurrence.sourceUnit, range, samples: numeric, event }); if (persistence) observations.push(persistence)
    } else if (states.length) observations.push(this.analytics.valueTransitions({ pressKey: occurrence.pressKey, variableId: occurrence.canonicalId ?? occurrence.rawIdentity, deckNumber: occurrence.deckNumber, range, samples: states, event }))
    const firstDivergence = this.analytics.firstDivergence({ pressKey: occurrence.pressKey, event, observations }); if (firstDivergence) observations.push(firstDivergence)
    const productionContext = context.evidence.productionContext
    const radiusAtEvent = context.radiusSegments.find((item) => item.kind === 'radius' && Date.parse(item.startUtc) <= Date.parse(occurrence.startUtc) && Date.parse(item.endUtc) > Date.parse(occurrence.startUtc))
    const phaseSummary: EvidencePhaseSummary = { eventStartUtc: occurrence.startUtc, eventEndUtc: occurrence.endUtc, items: [
      ...productionContext.map((item) => ({ phase: 'BACKGROUND' as const, atUtc: occurrence.startUtc, label: `${item.field[0]!.toUpperCase()}${item.field.slice(1)}`, detail: String(item.value), source: 'production_context' as const, canonicalId: `production.${item.field}`, deckNumber: null })),
      ...(radiusAtEvent?.kind === 'radius' ? [{ phase: 'BACKGROUND' as const, atUtc: occurrence.startUtc, label: 'Recorded Radius', detail: `${radiusAtEvent.eventType} / ${radiusAtEvent.statusCode ?? '—'} / ${radiusAtEvent.statusDescription}`, source: 'radius' as const, canonicalId: null, deckNumber: null }] : []),
      ...(context.evidence.physicalAlignment.inferredPhysicalOnsetRange ? [{ phase: 'PRECURSOR' as const, atUtc: context.evidence.physicalAlignment.inferredPhysicalOnsetRange.endUtc, label: 'Actual Speed materially changed', detail: 'Possible physical transition; activity remains unknown.', source: 'telemetry' as const, canonicalId: 'machine.speed.actual', deckNumber: null }] : []),
      ...context.changedSignals.flatMap((item) => item.summary.kind === 'state' ? item.summary.transitions.slice(-1).map((transition) => ({ phase: 'PRECURSOR' as const, atUtc: transition.atUtc, label: `${item.friendlyName} changed`, detail: `${String(transition.previousValue)} → ${String(transition.value)}`, source: 'telemetry' as const, canonicalId: item.canonicalId, deckNumber: item.deckNumber })) : []).sort((left, right) => Date.parse(left.atUtc!) - Date.parse(right.atUtc!)).slice(-3),
      { phase: 'TARGET' as const, atUtc: occurrence.startUtc, label: `${occurrence.signalDisplayName} ${occurrence.eventType.replace('_', ' ')}`, detail: null, source: 'telemetry' as const, canonicalId: occurrence.canonicalId, deckNumber: occurrence.deckNumber },
    ], limitations: ['Phase labels organize observed timing and do not establish causation.', 'Recorded Radius is operator-entered context, not physical ground truth.'] }
    const suggestedSignals = rankRelatedSignals([
      { canonicalId: 'machine.speed.actual', deckNumber: null, friendlyName: 'Actual Speed', signalType: 'continuous', category: 'speed', scope: 'machine', reasonCodes: ['ACTUAL_SPEED_CONTEXT'], timingDetail: context.evidence.physicalAlignment.inferredPhysicalOnsetRange ? `Changed near ${context.evidence.physicalAlignment.inferredPhysicalOnsetRange.endUtc}` : null },
      ...context.changedSignals.filter((item) => item.canonicalId !== occurrence.canonicalId || item.deckNumber !== occurrence.deckNumber).map((item) => ({ canonicalId: item.canonicalId, deckNumber: item.deckNumber, friendlyName: item.friendlyName, signalType: item.signalType, category: item.category, scope: item.scope, reasonCodes: [item.summary.kind === 'numeric' ? 'DELTA_NEAR_EVENT' as const : 'VALUE_TRANSITION' as const], timingDetail: item.summary.kind === 'numeric' ? `${item.summary.netDelta >= 0 ? '+' : ''}${item.summary.netDelta.toPrecision(3)} before target` : `${item.summary.transitions.length} nearby transition${item.summary.transitions.length === 1 ? '' : 's'}` })),
    ], occurrence.deckNumber, 5)
    return { occurrence, primary, context, evidence: { productionContext, radiusAtEvent: radiusAtEvent?.kind === 'radius' ? { eventType: radiusAtEvent.eventType, statusCode: radiusAtEvent.statusCode, statusDescription: radiusAtEvent.statusDescription } : null, phaseSummary, behavior: observations.find((item) => item.family === 'event_aligned_change' || item.family === 'value_state_transition') ?? null, persistence: observations.find((item) => item.family === 'deviation_persistence') ?? null, contextualEnvelope: observations.find((item) => item.family === 'normal_envelope_departure') ?? null, firstDivergence, suggestedSignals, observationCount: observations.length } }
  }

  async eventLearningReport(input: { occurrence: TelemetryEventOccurrence; occurrences: TelemetryEventOccurrence[] }, requestId?: string, signal?: AbortSignal): Promise<EventLearningReport> {
    const started = this.now(); const selected = input.occurrence
    const detail = await this.detail(selected, requestId, signal, { includeRawTelemetryDiscovery: false })
    const sameDefinition = (item: TelemetryEventOccurrence) => item.pressKey === selected.pressKey && item.sourceKind === selected.sourceKind && item.rawIdentity === selected.rawIdentity && item.deckNumber === selected.deckNumber && item.eventType === selected.eventType && (selected.eventType !== 'value_change' || item.previousValue === selected.previousValue && item.newValue === selected.newValue)
    const telemetryFloor = Date.parse(selected.startUtc) - EVENT_LEARNING_LIMITS.telemetryLookbackHours * 60 * 60_000
    const comparable = input.occurrences.filter(sameDefinition).filter((item) => Date.parse(item.startUtc) >= telemetryFloor && item.occurrenceId !== selected.occurrenceId).sort((a, b) => Date.parse(a.startUtc) - Date.parse(b.startUtc)).slice(-(EVENT_LEARNING_LIMITS.maximumCohortOccurrences - 1))
    const cohortSource = [...comparable, selected]
    const occurrences: EventLearningOccurrence[] = cohortSource.map((item) => ({ occurrenceId: item.occurrenceId, startUtc: item.startUtc, endUtc: item.endUtc, label: `${item.signalDisplayName} ${item.eventType.replace('_', ' ')}` }))
    const candidateIdentities = [
      ...(selected.sourceKind === 'canonical' && selected.canonicalId ? [{ canonicalId: selected.canonicalId, deckNumber: selected.deckNumber, friendlyName: selected.signalDisplayName, signalType: selected.dataKind === 'numeric' ? 'continuous' as const : 'state_event' as const, category: 'target' }] : []),
      { canonicalId: 'machine.speed.actual', deckNumber: null, friendlyName: 'Actual Speed', signalType: 'continuous' as const, category: 'speed' },
      ...detail.context.changedSignals.map((item) => ({ canonicalId: item.canonicalId, deckNumber: item.deckNumber, friendlyName: item.friendlyName, signalType: item.signalType, category: item.category })),
    ]
    const uniqueCandidates = [...new Map(candidateIdentities.map((item) => [`${item.canonicalId}:${item.deckNumber ?? ''}`, item])).values()].slice(0, EVENT_LEARNING_LIMITS.maximumCandidateSignals)
    const selectors: TelemetrySemanticSelector[] = uniqueCandidates.map((item) => ({ canonicalId: item.canonicalId, ...(item.deckNumber === null ? {} : { deckNumber: item.deckNumber }), representation: item.signalType === 'state_event' ? 'changes' : 'samples' }))
    const contextMs = EVENT_LEARNING_LIMITS.contextMinutes * 60_000
    const analysisOccurrences = occurrences.map((item) => ({ ...item, endUtc: new Date(Math.min(Date.parse(item.endUtc), Date.parse(item.startUtc) + contextMs)).toISOString() }))
    const cohortFromUtc = new Date(Math.min(...analysisOccurrences.map((item) => Date.parse(item.startUtc))) - contextMs).toISOString(); const cohortToUtc = new Date(Math.max(...analysisOccurrences.map((item) => Date.parse(item.endUtc))) + contextMs).toISOString()
    const loaded = await this.history(selected.pressKey, cohortFromUtc, cohortToUtc, selectors, requestId, signal)
    const definitions = new Map(uniqueCandidates.map((item) => [`${item.canonicalId}:${item.deckNumber ?? ''}`, item]))
    const signals: EventLearningSignal[] = loaded.signals.flatMap((item) => {
      const definition = definitions.get(`${item.canonicalId}:${item.deckNumber ?? ''}`); if (!definition) return []
      return [{ canonicalId: item.canonicalId, deckNumber: item.deckNumber, friendlyName: definition.friendlyName, category: definition.category, signalType: definition.signalType, sourceUnit: item.sourceUnit, valueKind: item.valueKind ?? null, samples: [...(item.seed ? [item.seed] : []), ...item.samples], changes: item.changes }]
    })
    const fingerprints = analysisOccurrences.map((occurrence) => buildOccurrenceFingerprint(occurrence, signals)); const selectedFingerprint = fingerprints.find(({ occurrenceId }) => occurrenceId === selected.occurrenceId) ?? buildOccurrenceFingerprint(analysisOccurrences.at(-1)!, signals)
    const aggregated = aggregateEventFingerprints(fingerprints, signals); const comparison = compareSelectedToTypical(selectedFingerprint, aggregated.findings)
    const relationships: EventLearningReport['relationships'] = []
    const targetSignal = selected.canonicalId ? signals.find((item) => item.canonicalId === selected.canonicalId && item.deckNumber === selected.deckNumber) : undefined
    if (targetSignal) for (const candidate of signals.filter((item) => item !== targetSignal && item.samples.some(({ value }) => typeof value === 'number')).slice(0, 5)) {
      const left = targetSignal.samples.flatMap((item): IndustrialNumericSample[] => typeof item.value === 'number' ? [{ atUtc: item.observedAtUtc, value: item.value, qualityState: item.qualityState }] : []); const right = candidate.samples.flatMap((item): IndustrialNumericSample[] => typeof item.value === 'number' ? [{ atUtc: item.observedAtUtc, value: item.value, qualityState: item.qualityState }] : [])
      const levels = this.analytics.numericRelationship({ pressKey: selected.pressKey, leftVariableId: targetSignal.canonicalId, rightVariableId: candidate.canonicalId, range: { start: cohortFromUtc, end: cohortToUtc }, left, right, basis: 'LEVELS' }); const differences = this.analytics.numericRelationship({ pressKey: selected.pressKey, leftVariableId: targetSignal.canonicalId, rightVariableId: candidate.canonicalId, range: { start: cohortFromUtc, end: cohortToUtc }, left, right, basis: 'DIFFERENCES' })
      for (const result of [levels, differences]) if (result?.qualified) relationships.push({ signal: candidate.friendlyName, mode: result.basis, interpretation: `${result.basis === 'DIFFERENCES' ? 'Change-based' : 'Level-based'} association was observed with ${result.sampleCount} aligned pairs; this is a condition to investigate, not causal evidence.`, metrics: { pearson: result.pearson, spearman: result.spearman, bestLagMinutes: result.bestLagMinutes, bestLagCorrelation: result.bestLagCorrelation, alignedPairCount: result.sampleCount, pairCoveragePercent: result.coveragePercent, temporalCoveragePercent: result.temporalCoveragePercent } })
    }
    for (const finding of aggregated.findings.filter((item) => item.kind === 'state' && item.observedOccurrenceCount >= 2).slice(0, 3)) relationships.push({ signal: finding.friendlyName, mode: 'TRANSITION_COOCCURRENCE', interpretation: `${finding.description} was observed in ${finding.observedOccurrenceCount}/${finding.validOccurrenceCount} target events with valid coverage.`, metrics: { occurrenceRate: finding.occurrenceRate, medianRelativeMinutes: finding.medianRelativeMinutes, provenance: finding.provenance } })
    const target: EventLearningReport['target'] = { signal: selected.signalDisplayName, detector: selected.eventType, press: selected.displayName, deck: selected.deckNumber, durationSeconds: selected.durationSeconds, sourceUnit: selected.sourceUnit }
    if (selected.eventType === 'threshold') Object.assign(target, { entryValue: selected.entryValue ?? null, extremeValue: selected.extremeValue ?? null, returnValue: selected.returnValue ?? null })
    if (selected.eventType === 'delta') Object.assign(target, { startingValue: selected.baselineValue ?? null, endingValue: selected.triggerValue ?? null, delta: selected.actualDelta ?? null, direction: selected.direction ?? null, elapsedSeconds: selected.elapsedSeconds ?? null })
    if (selected.eventType === 'value_change') Object.assign(target, { oldValue: selected.previousValue ?? null, newValue: selected.newValue ?? null, transitionAtUtc: selected.transitionAtUtc ?? selected.startUtc })
    const selectedFindings = selectedFingerprint.patterns.slice(0, EVENT_LEARNING_LIMITS.maximumFindings)
    const response: EventLearningReport = {
      version: 1, reportKind: 'telemetry_event', title: 'Telemetry event learning report', target, selectedOccurrence: occurrences.at(-1)!, recordedTime: { startUtc: selected.startUtc, endUtc: selected.endUtc },
      physicalTiming: detail.context.evidence.physicalAlignment, productionContext: detail.evidence.productionContext,
      radiusContext: detail.evidence.radiusAtEvent ? [{ relationship: 'AT_EVENT', ...detail.evidence.radiusAtEvent }] : [],
      selectedFindings, phaseComparison: selectedFindings.slice(0, 6).map((item) => ({ canonicalId: item.canonicalId, deckNumber: item.deckNumber, friendlyName: item.friendlyName, before: item.phase.before, event: item.phase.event, recovery: item.phase.recovery })),
      historicalFingerprint: { requestedOccurrences: input.occurrences.filter(sameDefinition).length, qualifiedOccurrences: fingerprints.filter((item) => item.coveredSignalKeys.length > 0).length, excludedOccurrences: Math.max(0, input.occurrences.filter(sameDefinition).length - fingerprints.filter((item) => item.coveredSignalKeys.length > 0).length), radiusCoverage: null, telemetryCoverage: telemetryCoverage(signals), findings: aggregated.findings },
      typicalSequence: aggregated.typicalSequence, relationships: relationships.sort((a, b) => Number(b.metrics.alignedPairCount ?? b.metrics.occurrenceRate ?? 0) - Number(a.metrics.alignedPairCount ?? a.metrics.occurrenceRate ?? 0)).slice(0, 6), occurrenceComparison: comparison,
      controls: { status: 'UNAVAILABLE', reason: 'A safe same-context non-target cohort was not available from the bounded explorer result.', comparisons: [] },
      occurrenceMatrix: fingerprints.map((item) => ({ occurrenceId: item.occurrenceId, startUtc: item.startUtc, patterns: item.patterns.map((pattern) => `${pattern.canonicalId}:${pattern.deckNumber ?? ''}`) })),
      coverage: { candidateSignals: signals.length, automaticRawSignalScans: 0, limitations: ['Automatic related-signal analysis is canonical-only.', `The cohort is limited to ${EVENT_LEARNING_LIMITS.maximumCohortOccurrences} recent occurrences within ${EVENT_LEARNING_LIMITS.telemetryLookbackHours} hours.`, `Each occurrence analysis window is capped at ${EVENT_LEARNING_LIMITS.contextMinutes} minutes before, during, and after the target.`, 'Associations, ordering, and correlations do not establish causation.', ...(aggregated.typicalSequence.length ? [] : ['A typical sequence requires at least two occurrences and 50% valid-coverage support.'])] },
      performance: { semanticHistoryRequests: detail.context.performance.semanticHistoryRequests + loaded.requestCount, cohortOccurrences: occurrences.length, totalMs: this.now() - started, payloadBytes: 0 },
    }
    response.performance.payloadBytes = Buffer.byteLength(JSON.stringify(response)); return response
  }

  historicalSummary(input: { occurrence: TelemetryEventOccurrence; occurrences: TelemetryEventOccurrence[] }): BasicHistoricalSummary {
    const bounded = input.occurrences.slice(0, 500).filter((item) => item.pressKey === input.occurrence.pressKey && item.sourceKind === input.occurrence.sourceKind && item.rawIdentity === input.occurrence.rawIdentity && item.deckNumber === input.occurrence.deckNumber && item.eventType === input.occurrence.eventType)
    const magnitudes = bounded.flatMap((item) => typeof item.maximumExcursion === 'number' ? [Math.abs(item.maximumExcursion)] : typeof item.extremeValue === 'number' && typeof item.entryValue === 'number' ? [Math.abs(item.extremeValue - item.entryValue)] : [])
    const durations = bounded.map((item) => item.durationSeconds).filter(Number.isFinite).sort((a, b) => a - b); const median = (values: number[]) => values.length ? values.length % 2 ? values[Math.floor(values.length / 2)]! : (values[values.length / 2 - 1]! + values[values.length / 2]!) / 2 : null
    const timeSpan = bounded.length ? { startUtc: bounded.reduce((value, item) => Date.parse(item.startUtc) < Date.parse(value) ? item.startUtc : value, bounded[0]!.startUtc), endUtc: bounded.reduce((value, item) => Date.parse(item.endUtc) > Date.parse(value) ? item.endUtc : value, bounded[0]!.endUtc) } : null
    return { scope: 'Same press, exact source identity, deck, and detector family in the current bounded search result', supportCount: bounded.length, timeSpan, metrics: { medianMagnitude: median(magnitudes.sort((a, b) => a - b)), medianDurationSeconds: median(durations), detectorFamily: input.occurrence.eventType, truncatedAt: input.occurrences.length > 500 ? 500 : null }, evidenceQuality: { supportCount: bounded.length, comparisonCount: bounded.length, coverage: null, comparisonCoverage: null, historicalSpan: timeSpan, contextMatchLevel: null, contextMatchDimensions: [], medianCadence: null, maximumGap: null, timingResolution: null, qualification: bounded.length >= 3 ? 'SUPPORTED' : bounded.length ? 'LIMITED' : 'INSUFFICIENT', excludedReason: bounded.length ? null : 'No matching occurrences are present in the bounded search result.' }, limitations: ['This summarizes only the current fetched search result.', 'No target/control comparison or causal inference is performed.', 'At most 500 supplied occurrences are evaluated.'] }
  }

  plot(occurrence: TelemetryEventOccurrence, signalIdentity: RawExplorerSignalIdentity, requestId?: string, signal?: AbortSignal) {
    return this.rawExplorer.plot({ occurrence: rawOccurrence(occurrence), signal: signalIdentity }, requestId, signal)
  }

  rawPlot(occurrence: TelemetryEventOccurrence, rawIdentity: string, requestId?: string, signal?: AbortSignal) {
    return this.rawExplorer.rawPlot({ occurrence: rawOccurrence(occurrence), rawIdentity }, requestId, signal)
  }
}
