import { RADIUS_PRESS_KEYS, type RadiusPressKey } from '../radius/models.js'
import { RadiusUnavailableError, type RadiusService } from '../radius/radius-service.js'
import { RAW_EXPLORER_DISCOVERY_CATALOG, RAW_EXPLORER_MAX_WINDOW_MINUTES, RawRadiusExplorerService, type RawExplorerOccurrence, type RawExplorerSignalIdentity } from '../raw-radius-explorer/raw-radius-explorer-service.js'
import type { EngineeringClueCatalogItem } from '../telemetry/engineering-clue-analysis.js'
import { PRODUCTION_CONTEXT_CANONICAL_IDS, type CapabilityAssessment, type PressSemanticSignalEvidence, type RawTelemetryHistoryResponse, type TelemetrySample, type TelemetryScalarValue, type TelemetrySemanticSelector, type TelemetrySourceSignal } from '../telemetry/telemetry-contracts.js'
import { TelemetryFoundationService, type PressSemanticSignalWithIdentity } from '../telemetry/telemetry-foundation-service.js'
import { detectDeltaEvents, detectThresholdEvents, detectValueChangeEvents, type DeltaDirection, type DeltaRule, type EventScalarValue, type NumericEventObservation, type ThresholdOperator, type ThresholdRule, type ValueChangeRule, type ValueEventObservation } from './telemetry-event-engine.js'

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

  async detail(occurrence: TelemetryEventOccurrence, requestId?: string, signal?: AbortSignal) {
    const contextMinutes = Math.min(RAW_EXPLORER_MAX_WINDOW_MINUTES, Math.max(1, Math.ceil((Date.parse(occurrence.startUtc) - Date.parse(occurrence.chartFromUtc)) / 60_000)))
    const context = await this.rawExplorer.detail({ occurrence: rawOccurrence(occurrence), changeLookbackMinutes: contextMinutes }, requestId, signal)
    let primary: { kind: 'raw'; signal: RawTelemetryHistoryResponse } | { kind: 'canonical'; signal: PressSemanticSignalWithIdentity | undefined }
    if (occurrence.sourceKind === 'raw') {
      const history = (await this.rawHistory(occurrence.pressKey, occurrence.rawIdentity, occurrence.chartFromUtc, occurrence.chartToUtc, requestId, signal)).history
      primary = { kind: 'raw', signal: { ...history, dataType: occurrence.valueKind, dataKind: occurrence.dataKind, plottable: true, observations: history.observations.filter((item) => scalarForKind(item.rawValue, occurrence.dataKind)) } }
    } else primary = { kind: 'canonical', signal: (await this.history(occurrence.pressKey, occurrence.chartFromUtc, occurrence.chartToUtc, [{ canonicalId: occurrence.canonicalId!, ...(occurrence.deckNumber === null ? {} : { deckNumber: occurrence.deckNumber }), representation: occurrence.eventType === 'value_change' ? 'changes' : 'samples' }], requestId, signal)).signals[0] }
    if (!primary.signal) throw new RadiusUnavailableError()
    return { occurrence, primary, context }
  }

  plot(occurrence: TelemetryEventOccurrence, signalIdentity: RawExplorerSignalIdentity, requestId?: string, signal?: AbortSignal) {
    return this.rawExplorer.plot({ occurrence: rawOccurrence(occurrence), signal: signalIdentity }, requestId, signal)
  }

  rawPlot(occurrence: TelemetryEventOccurrence, rawIdentity: string, requestId?: string, signal?: AbortSignal) {
    return this.rawExplorer.rawPlot({ occurrence: rawOccurrence(occurrence), rawIdentity }, requestId, signal)
  }
}
