import { RADIUS_PRESS_KEYS, type RadiusPressKey } from '../radius/models.js'
import { RadiusUnavailableError, type RadiusService } from '../radius/radius-service.js'
import { RAW_EXPLORER_DISCOVERY_CATALOG, RAW_EXPLORER_MAX_WINDOW_MINUTES, RawRadiusExplorerService, type RawExplorerOccurrence, type RawExplorerSignalIdentity } from '../raw-radius-explorer/raw-radius-explorer-service.js'
import type { EngineeringClueCatalogItem } from '../telemetry/engineering-clue-analysis.js'
import type { CapabilityAssessment, PressSemanticSignalEvidence, TelemetrySample, TelemetrySemanticSelector } from '../telemetry/telemetry-contracts.js'
import { TelemetryFoundationService, type PressSemanticSignalWithIdentity } from '../telemetry/telemetry-foundation-service.js'
import { detectDeltaEvents, detectThresholdEvents, type DeltaDirection, type DeltaRule, type NumericEventObservation, type ThresholdOperator, type ThresholdRule } from './telemetry-event-engine.js'

const TWO_HOURS_MS = 2 * 60 * 60_000
const REQUEST_CONCURRENCY = 3
const SELECTOR_BATCH_SIZE = 50
export const TELEMETRY_EVENT_MAX_RANGE_MS = 31 * 24 * 60 * 60_000
export const TELEMETRY_EVENT_MAX_CONTEXT_MINUTES = 1_440

export type TelemetryEventSource =
  | { kind: 'canonical'; canonicalId: string }
  | { kind: 'raw'; pressKey: RadiusPressKey; rawIdentity: string; displayName: string }

export type TelemetryEventRule =
  | { kind: 'threshold'; operator: ThresholdOperator; threshold: number }
  | { kind: 'delta'; direction: DeltaDirection; amount: number; windowMinutes: number }

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

function definition(canonicalId: string): EngineeringClueCatalogItem | undefined {
  return RAW_EXPLORER_DISCOVERY_CATALOG.find((item) => item.canonicalId === canonicalId)
}

function compatibleSelectors(item: EngineeringClueCatalogItem, capabilities: CapabilityAssessment[], deckNumber: TelemetryEventSearchInput['deckNumber']): TelemetrySemanticSelector[] {
  const capability = capabilities.find((candidate) => candidate.canonicalId === item.canonicalId)
  if (capability?.state !== 'SUPPORTED' || !capability.historyQueryable || capability.evidenceKind !== 'semantic_history') return []
  if (item.scope === 'machine') return deckNumber === null || deckNumber === 'any' ? [{ canonicalId: item.canonicalId, representation: 'samples' }] : []
  const decks = capability.deckNumbers.filter((deck) => deck >= 1 && deck <= 10 && (deckNumber === 'any' || deck === deckNumber))
  return decks.map((deck) => ({ canonicalId: item.canonicalId, deckNumber: deck, representation: 'samples' }))
}

function numericObservations(signal: PressSemanticSignalEvidence): NumericEventObservation[] {
  return signal.samples.flatMap((sample) => typeof sample.value === 'number' && Number.isFinite(sample.value) ? [{ atUtc: sample.observedAtUtc, value: sample.value, qualityState: sample.qualityState }] : [])
}

function seedObservation(signal: PressSemanticSignalEvidence): NumericEventObservation | null {
  return signal.seed && typeof signal.seed.value === 'number' && Number.isFinite(signal.seed.value) ? { atUtc: signal.seed.observedAtUtc, value: signal.seed.value, qualityState: signal.seed.qualityState } : null
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
  constructor(private readonly telemetry: TelemetryFoundationService, private readonly radius: RadiusService, private readonly rawExplorer: RawRadiusExplorerService, private readonly now = () => Date.now()) {}

  private async capabilities(requestId?: string, signal?: AbortSignal) {
    return mapWithConcurrency([...RADIUS_PRESS_KEYS], REQUEST_CONCURRENCY, async (pressKey) => {
      try { return await this.telemetry.capabilities.get(pressKey, requestId, signal) } catch { return undefined }
    })
  }

  async catalog(rawPressKey?: RadiusPressKey, fromUtc?: string, toUtc?: string, requestId?: string, signal?: AbortSignal) {
    const sets = await this.capabilities(requestId, signal)
    const variables = RAW_EXPLORER_DISCOVERY_CATALOG.filter((item) => item.canonicalId !== 'physical.motion_state' && item.signalType !== 'state_event').flatMap((item) => {
      const compatiblePresses = sets.flatMap((set) => {
        if (!set) return []
        const capability = set.capabilities.find(({ canonicalId }) => canonicalId === item.canonicalId)
        if (capability?.state !== 'SUPPORTED' || !capability.historyQueryable || capability.evidenceKind !== 'semantic_history') return []
        return [{ pressKey: set.pressKey, displayName: set.displayName, deckNumbers: item.scope === 'deck' ? capability.deckNumbers.filter((deck) => deck >= 1 && deck <= 10) : [] }]
      }).filter((source) => item.scope !== 'deck' || source.deckNumbers.length > 0)
      return compatiblePresses.length ? [{ kind: 'canonical' as const, canonicalId: item.canonicalId, displayName: item.friendlyName, scope: item.scope, signalType: item.signalType, category: item.category, compatiblePresses }] : []
    })
    let rawVariables: Array<{ kind: 'raw'; pressKey: RadiusPressKey; rawIdentity: string; displayName: string; discoveryCategory: string; sourceUnit: string | null }> = []
    if (rawPressKey && fromUtc && toUtc) {
      const raw = await this.telemetry.rawChanges(rawPressKey, fromUtc, toUtc, requestId, signal).catch(() => undefined)
      rawVariables = raw?.signals.filter((item) => item.plottable && item.dataKind === 'numeric' && typeof item.firstValue === 'number' && typeof item.lastValue === 'number').map((item) => ({ kind: 'raw', pressKey: rawPressKey, rawIdentity: item.rawIdentity, displayName: item.displayName, discoveryCategory: item.discoveryCategory, sourceUnit: item.sourceUnit })) ?? []
    }
    return { canonicalVariables: variables, rawVariables }
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

  async search(input: TelemetryEventSearchInput, requestId?: string, abortSignal?: AbortSignal) {
    const started = this.now()
    const resolved: Array<{ identity: EventIdentity; observations: NumericEventObservation[]; seed: NumericEventObservation | null }> = []
    let requestCount = 0
    if (input.source.kind === 'raw') {
      const history = await this.telemetry.rawHistory(input.source.pressKey, input.source.rawIdentity, input.fromUtc, input.toUtc, requestId, abortSignal)
      if (!history.plottable || history.dataKind !== 'numeric') throw new RadiusUnavailableError()
      resolved.push({ identity: { sourceKind: 'raw', pressKey: input.source.pressKey, displayName: history.displayName, deckNumber: null, canonicalId: null, rawIdentity: history.rawIdentity, signalDisplayName: history.signalDisplayName, sourceUnit: history.sourceUnit, canonicalUnitStatus: null }, observations: history.observations.flatMap((item) => typeof item.rawValue === 'number' && Number.isFinite(item.rawValue) ? [{ atUtc: item.timestampUtc, value: item.rawValue, qualityState: item.qualityState }] : []), seed: null })
      requestCount = 1
    } else {
      const item = definition(input.source.canonicalId)
      if (!item || item.signalType === 'state_event') throw new RadiusUnavailableError()
      const presses: RadiusPressKey[] = input.pressKey === 'all' ? [...RADIUS_PRESS_KEYS] : [input.pressKey]
      const jobs = (await mapWithConcurrency(presses, REQUEST_CONCURRENCY, async (pressKey) => {
        try {
          const capabilities = await this.telemetry.capabilities.get(pressKey, requestId, abortSignal)
          const selectors = compatibleSelectors(item, capabilities.capabilities, input.deckNumber)
          if (!selectors.length) return undefined
          const loaded = await this.history(pressKey, input.fromUtc, input.toUtc, selectors, requestId, abortSignal)
          return { capabilities, loaded }
        } catch { return undefined }
      })).filter((value): value is NonNullable<typeof value> => Boolean(value))
      for (const job of jobs) {
        requestCount += job.loaded.requestCount
        for (const history of job.loaded.signals) {
          const observations = numericObservations(history)
          if (!observations.length && !seedObservation(history)) continue
          resolved.push({ identity: { sourceKind: 'canonical', pressKey: job.capabilities.pressKey, displayName: job.capabilities.displayName, deckNumber: history.deckNumber, canonicalId: history.canonicalId, rawIdentity: history.rawSignalId ?? history.sourceSelector ?? history.canonicalId, signalDisplayName: item.friendlyName, sourceUnit: history.sourceUnit, canonicalUnitStatus: history.canonicalUnitStatus }, observations, seed: seedObservation(history) })
        }
      }
    }

    const contextMs = input.chartContextMinutes * 60_000
    const occurrences: TelemetryEventOccurrence[] = resolved.flatMap(({ identity, observations, seed }) => {
      const detections = input.rule.kind === 'threshold'
        ? detectThresholdEvents({ observations, seed, fromUtc: input.fromUtc, toUtc: input.toUtc, rule: input.rule as ThresholdRule })
        : detectDeltaEvents({ observations, seed, fromUtc: input.fromUtc, toUtc: input.toUtc, rule: input.rule as DeltaRule })
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

  async detail(occurrence: TelemetryEventOccurrence, requestId?: string, signal?: AbortSignal) {
    const contextMinutes = Math.min(RAW_EXPLORER_MAX_WINDOW_MINUTES, Math.max(1, Math.ceil((Date.parse(occurrence.startUtc) - Date.parse(occurrence.chartFromUtc)) / 60_000)))
    const context = await this.rawExplorer.detail({ occurrence: rawOccurrence(occurrence), changeLookbackMinutes: contextMinutes }, requestId, signal)
    const primary = occurrence.sourceKind === 'raw'
      ? { kind: 'raw' as const, signal: (await this.telemetry.rawHistory(occurrence.pressKey, occurrence.rawIdentity, occurrence.chartFromUtc, occurrence.chartToUtc, requestId, signal)) }
      : { kind: 'canonical' as const, signal: (await this.history(occurrence.pressKey, occurrence.chartFromUtc, occurrence.chartToUtc, [{ canonicalId: occurrence.canonicalId!, ...(occurrence.deckNumber === null ? {} : { deckNumber: occurrence.deckNumber }), representation: 'samples' }], requestId, signal)).signals[0] }
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
