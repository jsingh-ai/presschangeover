import type { RadiusPressKey } from '../radius/models.js'
import type { TelemetryClient } from './telemetry-api-client.js'
import { TelemetryCapabilityRegistry } from './telemetry-capability-registry.js'
import {
  PRODUCTION_CONTEXT_CANONICAL_IDS,
  PRODUCTION_CONTEXT_FIELDS,
  type CapabilityAssessment,
  type BoundedTelemetryReadDiagnostics,
  type CuratedPhysicalEvidence,
  type CuratedPhysicalEvidenceRequest,
  type EvidenceObservationState,
  type PressMotionEvidence,
  type PressSemanticHistoryEvidence,
  type PressSemanticSignalEvidence,
  type PressSpeedEvidence,
  type PressSpeedSignalEvidence,
  type ProductionContextEvidence,
  type ProductionContextField,
  type ProductionContextFieldEvidence,
  type RawTelemetryChangesResponse,
  type RawTelemetryHistoryResponse,
  type TelemetrySemanticHistoryQuery,
  type TelemetrySemanticSelector,
  type TelemetrySample,
  type TelemetrySourceSignal,
  type TelemetrySemanticSignalHistory,
  type TelemetryValueKind,
} from './telemetry-contracts.js'
import { TelemetryApiError } from './telemetry-error.js'
import { TelemetrySourceRegistry } from './telemetry-source-registry.js'

const MAX_SEMANTIC_SELECTORS_PER_REQUEST = 50
export const MAX_TELEMETRY_HISTORY_CHUNK_MS = 2 * 60 * 60_000
const BOUNDED_READ_CONCURRENCY = 3
const MAX_ANALYSIS_CACHE_ENTRIES = 128

function observationState(signal: TelemetrySemanticSignalHistory): EvidenceObservationState {
  if (!signal.supported) return 'UNSUPPORTED'
  if (signal.samples.length || signal.changes.length) return 'SUPPORTED_WITH_OBSERVATIONS'
  if (signal.seedSample) return 'SUPPORTED_WITH_SEED_ONLY'
  return 'SUPPORTED_WITH_NO_SAMPLES_IN_RANGE'
}

function signalEvidence(signal: TelemetrySemanticSignalHistory, capability?: CapabilityAssessment): PressSemanticSignalEvidence {
  return {
    canonicalId: signal.canonicalId,
    deckNumber: signal.deckNumber,
    capabilityState: capability?.state ?? (signal.supported ? 'SUPPORTED' : 'UNSUPPORTED'),
    observationState: observationState(signal),
    mappingStatus: signal.mappingStatus,
    sourceUnit: signal.sourceUnit,
    canonicalUnitStatus: signal.canonicalUnitStatus,
    representation: signal.representation,
    seed: signal.seedSample,
    samples: signal.samples,
    changes: signal.changes,
  }
}

export interface PressSemanticSignalWithIdentity extends PressSemanticSignalEvidence {
  valueKind?: TelemetryValueKind | null
  historianSignalId: number | null
  rawSignalId: string | null
  sourceSelector: string | null
  selectedVariant: string | null
}

type PressSemanticHistoryWithIdentity = Omit<PressSemanticHistoryEvidence, 'signals'> & { signals: PressSemanticSignalWithIdentity[] }

interface BoundedReadCacheEntry {
  requestId: string
  pressKey: RadiusPressKey
  fromMs: number
  toMs: number
  includeSeed: boolean
  selectorKeys: Set<string>
  operation: Promise<PressSemanticHistoryWithIdentity>
}

function signalKey(signal: { canonicalId: string; deckNumber?: number | null }) { return `${signal.canonicalId}\u0000${signal.deckNumber ?? ''}` }
function selectorKey(signal: TelemetrySemanticSelector) { return `${signal.canonicalId}\u0000${signal.deckNumber ?? ''}\u0000${signal.representation}` }
function pointTime(value: { observedAtUtc: string }) { return Date.parse(value.observedAtUtc) }
function median(values: number[]) { const ordered = [...values].sort((a, b) => a - b); const middle = Math.floor(ordered.length / 2); return ordered.length % 2 ? ordered[middle]! : (ordered[middle - 1]! + ordered[middle]!) / 2 }

function deduplicateBoundaryPoints<T extends { observedAtUtc: string }>(values: T[]): { values: T[]; removed: number } {
  const ordered = [...values].sort((left, right) => pointTime(left) - pointTime(right))
  const retained = new Map<string, T>()
  for (const value of ordered) if (!retained.has(value.observedAtUtc)) retained.set(value.observedAtUtc, value)
  return { values: [...retained.values()], removed: ordered.length - retained.size }
}

function evidenceGaps(signals: PressSemanticSignalWithIdentity[], range: { start: string; end: string }) {
  return signals.flatMap((signal) => {
    const points = [...signal.samples, ...signal.changes].sort((left, right) => pointTime(left) - pointTime(right))
    const cadences = points.slice(1).map((point, index) => pointTime(point) - pointTime(points[index]!)).filter((value) => value > 0)
    if (cadences.length < 2) return []
    const threshold = Math.max(5 * 60_000, median(cadences) * 3)
    return points.slice(1).flatMap((point, index) => {
      const prior = points[index]!; const durationMs = pointTime(point) - pointTime(prior)
      return durationMs > threshold && pointTime(prior) >= Date.parse(range.start) && pointTime(point) <= Date.parse(range.end) ? [{ canonicalId: signal.canonicalId, deckNumber: signal.deckNumber, startUtc: prior.observedAtUtc, endUtc: point.observedAtUtc, durationMs }] : []
    })
  })
}

function asSeed(point: TelemetrySample): TelemetrySample {
  return { observedAtUtc: point.observedAtUtc, receivedAtUtc: point.receivedAtUtc, sourceTimestampUtc: point.sourceTimestampUtc, qualityState: point.qualityState, valueKind: point.valueKind, value: point.value }
}

function sliceCachedSignal(signal: PressSemanticSignalWithIdentity, query: TelemetrySemanticHistoryQuery): PressSemanticSignalWithIdentity {
  const fromMs = Date.parse(query.fromUtc); const toMs = Date.parse(query.toUtc)
  const samples = signal.samples.filter((point) => pointTime(point) >= fromMs && pointTime(point) <= toMs)
  const changes = signal.changes.filter((point) => pointTime(point) >= fromMs && pointTime(point) <= toMs)
  const seedCandidates = [signal.seed, ...signal.samples, ...signal.changes].filter((point): point is TelemetrySample => Boolean(point) && pointTime(point!) < fromMs).sort((left, right) => pointTime(left) - pointTime(right))
  const seed = query.includeSeed && seedCandidates.length ? asSeed(seedCandidates.at(-1)!) : query.includeSeed && signal.seed && pointTime(signal.seed) <= fromMs ? signal.seed : null
  const observationState = samples.length || changes.length ? 'SUPPORTED_WITH_OBSERVATIONS' as const : seed ? 'SUPPORTED_WITH_SEED_ONLY' as const : signal.capabilityState === 'SUPPORTED' ? 'SUPPORTED_WITH_NO_SAMPLES_IN_RANGE' as const : 'UNSUPPORTED' as const
  return { ...signal, seed, samples, changes, observationState }
}

function cacheHitType(entry: BoundedReadCacheEntry, query: TelemetrySemanticHistoryQuery) {
  const queryKeys = new Set(query.signals.map(selectorKey)); const sameSelectors = queryKeys.size === entry.selectorKeys.size && [...queryKeys].every((key) => entry.selectorKeys.has(key))
  const sameRange = Date.parse(query.fromUtc) === entry.fromMs && Date.parse(query.toUtc) === entry.toMs
  return sameRange ? sameSelectors ? 'EXACT' as const : 'SELECTOR_SUBSET' as const : sameSelectors ? 'CONTAINED_RANGE' as const : 'CONTAINED_RANGE_SELECTOR_SUBSET' as const
}

export class TelemetryFoundationService {
  readonly sources: TelemetrySourceRegistry
  readonly capabilities: TelemetryCapabilityRegistry
  private readonly boundedReadCache = new Map<string, BoundedReadCacheEntry>()

  constructor(private readonly client: TelemetryClient, options: { metadataTtlMs?: number; now?: () => number } = {}) {
    this.sources = new TelemetrySourceRegistry(client, options.metadataTtlMs, options.now)
    this.capabilities = new TelemetryCapabilityRegistry(client, this.sources, options.metadataTtlMs, options.now)
  }

  private async readBoundedSemanticHistory(pressKey: RadiusPressKey, query: TelemetrySemanticHistoryQuery, requestId?: string, signal?: AbortSignal): Promise<PressSemanticHistoryWithIdentity> {
    if (!this.client.querySemanticHistory) throw new TelemetryApiError('unavailable')
    const rangeMs = Date.parse(query.toUtc) - Date.parse(query.fromUtc)
    if (!Number.isFinite(rangeMs) || rangeMs <= 0 || !query.signals.length) throw new TelemetryApiError('request_invalid', 400)
    const requestedSelectorKeys = new Set(query.signals.map(selectorKey)); const fromMs = Date.parse(query.fromUtc); const toMs = Date.parse(query.toUtc)
    const cached = requestId ? [...this.boundedReadCache.values()].filter((entry) => entry.requestId === requestId && entry.pressKey === pressKey && entry.fromMs <= fromMs && entry.toMs >= toMs && (entry.includeSeed || !query.includeSeed) && [...requestedSelectorKeys].every((key) => entry.selectorKeys.has(key))).sort((left, right) => (left.toMs - left.fromMs) - (right.toMs - right.fromMs) || left.selectorKeys.size - right.selectorKeys.size)[0] : undefined
    if (cached) {
      const source = await cached.operation; const type = cacheHitType(cached, query)
      const signals = query.signals.flatMap((selector) => { const signal = source.signals.find((item) => selectorKey({ canonicalId: item.canonicalId, ...(item.deckNumber === null ? {} : { deckNumber: item.deckNumber }), representation: item.representation }) === selectorKey(selector)); return signal ? [sliceCachedSignal(signal, query)] : [] })
      const pointsRetained = signals.reduce((sum, item) => sum + item.samples.length + item.changes.length, 0)
      const readDiagnostics: BoundedTelemetryReadDiagnostics = {
        requestedRange: { start: query.fromUtc, end: query.toUtc }, chunkCount: 0, telemetryRequests: 0, cacheHits: 1,
        exactCacheHits: type === 'EXACT' ? 1 : 0, selectorSubsetCacheHits: type === 'SELECTOR_SUBSET' ? 1 : 0,
        containedRangeCacheHits: type === 'CONTAINED_RANGE' ? 1 : 0, containedRangeSelectorSubsetCacheHits: type === 'CONTAINED_RANGE_SELECTOR_SUBSET' ? 1 : 0,
        cacheHitType: type, cacheSourceRange: { start: new Date(cached.fromMs).toISOString(), end: new Date(cached.toMs).toISOString() },
        pointsReturned: 0, pointsRetained, boundaryDuplicatesRemoved: 0, gaps: evidenceGaps(signals, { start: query.fromUtc, end: query.toUtc }), requests: [],
      }
      return { ...source, fromUtc: query.fromUtc, toUtc: query.toUtc, includeSeed: query.includeSeed, signals, readDiagnostics }
    }
    const cacheKey = requestId ? JSON.stringify([requestId, pressKey, query.fromUtc, query.toUtc, query.includeSeed, [...requestedSelectorKeys].sort()]) : null
    const operation = (async () => {
      const resolved = await this.sources.resolve(pressKey, requestId, signal)
      const capabilitySet = await this.capabilities.get(pressKey, requestId, signal).catch(() => undefined)
      const chunks: Array<{ fromUtc: string; toUtc: string }> = []
      for (let cursor = Date.parse(query.fromUtc); cursor < Date.parse(query.toUtc); cursor += MAX_TELEMETRY_HISTORY_CHUNK_MS) chunks.push({ fromUtc: new Date(cursor).toISOString(), toUtc: new Date(Math.min(Date.parse(query.toUtc), cursor + MAX_TELEMETRY_HISTORY_CHUNK_MS)).toISOString() })
      const selectorBatches = Array.from({ length: Math.ceil(query.signals.length / MAX_SEMANTIC_SELECTORS_PER_REQUEST) }, (_item, index) => query.signals.slice(index * MAX_SEMANTIC_SELECTORS_PER_REQUEST, (index + 1) * MAX_SEMANTIC_SELECTORS_PER_REQUEST))
      const requests = chunks.flatMap((chunk) => selectorBatches.map((signals) => ({ ...chunk, signals })))
      const responseEntries: Array<{ response: Awaited<ReturnType<NonNullable<TelemetryClient['querySemanticHistory']>>>; diagnostic: NonNullable<BoundedTelemetryReadDiagnostics['requests']>[number] }> = []
      for (let offset = 0; offset < requests.length; offset += BOUNDED_READ_CONCURRENCY) {
        responseEntries.push(...await Promise.all(requests.slice(offset, offset + BOUNDED_READ_CONCURRENCY).map(async (item, localIndex) => {
          const began = Date.now(); const response = await this.client.querySemanticHistory!(resolved.source.id, { fromUtc: item.fromUtc, toUtc: item.toUtc, includeSeed: query.includeSeed, signals: item.signals }, requestId, signal)
          return { response, diagnostic: { pressKey, selectorCount: item.signals.length, selectors: item.signals.map(selectorKey), range: { start: item.fromUtc, end: item.toUtc }, chunkIndex: Math.floor((offset + localIndex) / selectorBatches.length), durationMs: Date.now() - began, pointsReturned: response.signals.reduce((sum, candidate) => sum + candidate.samples.length + candidate.changes.length, 0) } }
        })))
      }
      const responses = responseEntries.map(({ response }) => response)
      if (!responses.length || responses.some((item) => item.sourceId !== resolved.source.id || item.sourceKey.toLowerCase() !== pressKey)) throw new TelemetryApiError('invalid_response')
      const merged = new Map<string, PressSemanticSignalWithIdentity>()
      let pointsReturned = 0; let duplicates = 0
      for (const response of responses) {
        for (const raw of response.signals) {
          const capability = capabilitySet?.capabilities.find(({ canonicalId }) => canonicalId === raw.canonicalId)
          const projected = { ...signalEvidence(raw, capability), valueKind: raw.valueKind, historianSignalId: raw.historianSignalId, rawSignalId: raw.rawSignalId, sourceSelector: raw.sourceSelector, selectedVariant: raw.selectedVariant }
          const key = signalKey(projected); const existing = merged.get(key)
          pointsReturned += raw.samples.length + raw.changes.length
          if (!existing) merged.set(key, projected)
          else {
            const samples = deduplicateBoundaryPoints([...existing.samples, ...projected.samples]); const changes = deduplicateBoundaryPoints([...existing.changes, ...projected.changes])
            duplicates += samples.removed + changes.removed
            merged.set(key, { ...existing, seed: existing.seed ?? projected.seed, samples: samples.values, changes: changes.values, observationState: samples.values.length || changes.values.length ? 'SUPPORTED_WITH_OBSERVATIONS' : existing.seed ?? projected.seed ? 'SUPPORTED_WITH_SEED_ONLY' : existing.observationState })
          }
        }
      }
      const signals = query.signals.flatMap((selector) => {
        const value = merged.get(signalKey(selector)); return value ? [value] : []
      })
      const gaps = evidenceGaps(signals, { start: query.fromUtc, end: query.toUtc })
      const readDiagnostics: BoundedTelemetryReadDiagnostics = { requestedRange: { start: query.fromUtc, end: query.toUtc }, chunkCount: chunks.length, telemetryRequests: requests.length, cacheHits: 0, exactCacheHits: 0, selectorSubsetCacheHits: 0, containedRangeCacheHits: 0, containedRangeSelectorSubsetCacheHits: 0, cacheHitType: null, cacheSourceRange: null, pointsReturned, pointsRetained: signals.reduce((sum, item) => sum + item.samples.length + item.changes.length, 0), boundaryDuplicatesRemoved: duplicates, gaps, requests: responseEntries.map(({ diagnostic }) => diagnostic) }
      const first = responses[0]!
      return { pressKey, sourceKey: first.sourceKey, displayName: first.displayName, fromUtc: query.fromUtc, toUtc: query.toUtc, includeSeed: query.includeSeed, signals, readDiagnostics }
    })()
    if (cacheKey) {
      this.boundedReadCache.set(cacheKey, { requestId: requestId!, pressKey, fromMs, toMs, includeSeed: query.includeSeed, selectorKeys: requestedSelectorKeys, operation })
      if (this.boundedReadCache.size > MAX_ANALYSIS_CACHE_ENTRIES) this.boundedReadCache.delete(this.boundedReadCache.keys().next().value!)
      operation.catch(() => this.boundedReadCache.delete(cacheKey))
    }
    return operation
  }

  async semanticHistory(pressKey: RadiusPressKey, query: TelemetrySemanticHistoryQuery, requestId?: string, signal?: AbortSignal): Promise<PressSemanticHistoryEvidence> {
    const history = await this.readBoundedSemanticHistory(pressKey, query, requestId, signal)
    return { ...history, signals: history.signals.map(({ historianSignalId: _historianSignalId, rawSignalId: _rawSignalId, sourceSelector: _sourceSelector, selectedVariant: _selectedVariant, valueKind: _valueKind, ...item }) => item) }
  }

  /** Internal-only event-search path that retains exact upstream identity. Browser-facing semantic routes keep omitting it. */
  async semanticHistoryWithIdentity(pressKey: RadiusPressKey, query: TelemetrySemanticHistoryQuery, requestId?: string, signal?: AbortSignal): Promise<Omit<PressSemanticHistoryEvidence, 'signals'> & { signals: PressSemanticSignalWithIdentity[] }> {
    return this.readBoundedSemanticHistory(pressKey, query, requestId, signal)
  }

  async rawChanges(pressKey: RadiusPressKey, fromUtc: string, toUtc: string, requestId?: string, signal?: AbortSignal): Promise<RawTelemetryChangesResponse> {
    if (!this.client.getRawTelemetryChanges) throw new TelemetryApiError('unavailable')
    const response = await this.client.getRawTelemetryChanges({ press: pressKey, fromUtc, toUtc }, requestId, signal)
    if (response.press.toLowerCase() !== pressKey) throw new TelemetryApiError('invalid_response')
    return response
  }

  async rawCatalog(pressKey: RadiusPressKey, requestId?: string, signal?: AbortSignal): Promise<TelemetrySourceSignal[]> {
    if (!this.client.getSignals) throw new TelemetryApiError('unavailable')
    const resolved = await this.sources.resolve(pressKey, requestId, signal)
    const values = await this.client.getSignals(resolved.source.id, requestId, signal)
    if (values.some(({ sourceId }) => sourceId !== resolved.source.id)) throw new TelemetryApiError('invalid_response')
    return values.filter(({ enabled }) => enabled)
  }

  async rawHistory(pressKey: RadiusPressKey, rawIdentity: string, fromUtc: string, toUtc: string, requestId?: string, signal?: AbortSignal): Promise<RawTelemetryHistoryResponse> {
    if (!this.client.getRawTelemetryHistory) throw new TelemetryApiError('unavailable')
    const response = await this.client.getRawTelemetryHistory({ press: pressKey, rawIdentity, fromUtc, toUtc }, requestId, signal)
    if (response.press.toLowerCase() !== pressKey || response.rawIdentity !== rawIdentity) throw new TelemetryApiError('invalid_response')
    return response
  }

  async context(pressKey: RadiusPressKey, fromUtc: string, toUtc: string, requestId?: string, signal?: AbortSignal): Promise<ProductionContextEvidence> {
    const history = await this.semanticHistory(pressKey, {
      fromUtc,
      toUtc,
      includeSeed: true,
      signals: PRODUCTION_CONTEXT_FIELDS.map((field) => ({ canonicalId: PRODUCTION_CONTEXT_CANONICAL_IDS[field], representation: 'changes' })),
    }, requestId, signal)
    const entries = PRODUCTION_CONTEXT_FIELDS.map((field): [ProductionContextField, ProductionContextFieldEvidence] => {
      const canonicalId = PRODUCTION_CONTEXT_CANONICAL_IDS[field]
      const item = history.signals.find((candidate) => candidate.canonicalId === canonicalId)
      if (!item) throw new TelemetryApiError('invalid_response')
      return [field, { field, canonicalId, capabilityState: item.capabilityState, observationState: item.observationState, seed: item.seed, changes: item.changes }]
    })
    const fields = Object.fromEntries(entries) as Record<ProductionContextField, ProductionContextFieldEvidence>
    const changes = entries.flatMap(([field, evidence]) => evidence.changes.map((change) => ({
      atUtc: change.observedAtUtc,
      field,
      canonicalId: evidence.canonicalId,
      previousValueKind: change.previousValueKind,
      previousValue: change.previousValue,
      valueKind: change.valueKind,
      value: change.value,
      qualityState: change.qualityState,
    }))).sort((a, b) => Date.parse(a.atUtc) - Date.parse(b.atUtc) || a.field.localeCompare(b.field))
    return { pressKey, sourceKey: history.sourceKey, displayName: history.displayName, fromUtc: history.fromUtc, toUtc: history.toUtc, fields, changes }
  }

  async speed(pressKey: RadiusPressKey, fromUtc: string, toUtc: string, requestId?: string, signal?: AbortSignal): Promise<PressSpeedEvidence> {
    if (!this.client.getMachineSpeedHistory) throw new TelemetryApiError('unavailable')
    const resolved = await this.sources.resolve(pressKey, requestId, signal)
    const upstream = await this.client.getMachineSpeedHistory(resolved.source.id, fromUtc, toUtc, requestId, signal)
    if (upstream.sourceId !== resolved.source.id || upstream.sourceKey.toLowerCase() !== pressKey) throw new TelemetryApiError('invalid_response')
    const project = (item: typeof upstream.actual): PressSpeedSignalEvidence => ({ canonicalId: item.canonicalId, observationState: item.samples.length ? 'SUPPORTED_WITH_OBSERVATIONS' : 'SUPPORTED_WITH_NO_SAMPLES_IN_RANGE', sourceUnit: item.sourceUnit, canonicalUnitStatus: item.canonicalUnitStatus, samples: item.samples })
    return { pressKey, sourceKey: upstream.sourceKey, displayName: upstream.displayName, fromUtc: upstream.fromUtc, toUtc: upstream.toUtc, actual: project(upstream.actual), setpoint: upstream.setpoint ? project(upstream.setpoint) : null }
  }

  /** Internal-only investigator path retaining exact mapped historian identity. */
  async speedWithIdentity(pressKey: RadiusPressKey, fromUtc: string, toUtc: string, requestId?: string, signal?: AbortSignal) {
    if (!this.client.getMachineSpeedHistory) throw new TelemetryApiError('unavailable')
    const resolved = await this.sources.resolve(pressKey, requestId, signal); const upstream = await this.client.getMachineSpeedHistory(resolved.source.id, fromUtc, toUtc, requestId, signal)
    if (upstream.sourceId !== resolved.source.id || upstream.sourceKey.toLowerCase() !== pressKey) throw new TelemetryApiError('invalid_response')
    const project = (item: typeof upstream.actual) => ({ canonicalId: item.canonicalId, rawSignalId: item.rawSignalId, observationState: item.samples.length ? 'SUPPORTED_WITH_OBSERVATIONS' as const : 'SUPPORTED_WITH_NO_SAMPLES_IN_RANGE' as const, sourceUnit: item.sourceUnit, canonicalUnitStatus: item.canonicalUnitStatus, samples: item.samples })
    return { pressKey, sourceKey: upstream.sourceKey, displayName: upstream.displayName, fromUtc: upstream.fromUtc, toUtc: upstream.toUtc, actual: project(upstream.actual), setpoint: upstream.setpoint ? project(upstream.setpoint) : null }
  }

  async motion(pressKey: RadiusPressKey, fromUtc: string, toUtc: string, requestId?: string, signal?: AbortSignal): Promise<PressMotionEvidence> {
    const resolved = await this.sources.resolve(pressKey, requestId, signal)
    const upstream = await this.client.getPhysicalState(resolved.source.id, fromUtc, toUtc, requestId, signal)
    if (upstream.sourceId !== resolved.source.id || upstream.sourceKey.toLowerCase() !== pressKey) throw new TelemetryApiError('invalid_response')
    const { sourceId: _sourceId, ...evidence } = upstream
    return { pressKey, ...evidence }
  }

  async evidence(pressKey: RadiusPressKey, request: CuratedPhysicalEvidenceRequest, requestId?: string, signal?: AbortSignal): Promise<CuratedPhysicalEvidence> {
    const capabilitySet = await this.capabilities.get(pressKey, requestId, signal)
    const ids = new Set<string>()
    for (const category of request.categories) {
      if (category === 'context') PRODUCTION_CONTEXT_FIELDS.forEach((field) => ids.add(PRODUCTION_CONTEXT_CANONICAL_IDS[field]))
      if (category === 'deck_states') ['deck.active', 'deck.print_on', 'deck.print_off'].forEach((id) => ids.add(id))
      if (category === 'register') capabilitySet.capabilities.filter(({ canonicalId }) => canonicalId.startsWith('register.')).forEach(({ canonicalId }) => ids.add(canonicalId))
      if (category === 'impression') capabilitySet.capabilities.filter(({ canonicalId }) => canonicalId.startsWith('impression.')).forEach(({ canonicalId }) => ids.add(canonicalId))
      if (category === 'wash') ids.add('ink.washup.state')
      if (category === 'pump') ids.add('ink.pump.status')
      if (category === 'viscosity') ids.add('ink.viscosity.actual')
      if (category === 'ink_temperature') ids.add('ink.temperature.actual')
    }
    const selectors = [...ids].flatMap((canonicalId) => {
      const capability = capabilitySet.capabilities.find((item) => item.canonicalId === canonicalId)
      const deckScoped = (capability?.deckNumbers.length ?? 0) > 0 || canonicalId.startsWith('deck.') || canonicalId.startsWith('register.') || canonicalId.startsWith('impression.') || canonicalId.startsWith('ink.')
      const decks = request.deckNumbers?.length ? request.deckNumbers : capability?.deckNumbers ?? []
      return deckScoped ? decks.map((deckNumber) => ({ canonicalId, deckNumber, representation: request.representation })) : [{ canonicalId, representation: request.representation }]
    })
    if (!selectors.length) throw new TelemetryApiError('request_invalid', 400)
    const batches = Array.from({ length: Math.ceil(selectors.length / MAX_SEMANTIC_SELECTORS_PER_REQUEST) }, (_, index) => selectors.slice(index * MAX_SEMANTIC_SELECTORS_PER_REQUEST, (index + 1) * MAX_SEMANTIC_SELECTORS_PER_REQUEST))
    const histories = await Promise.all(batches.map((signals) => this.semanticHistory(pressKey, { fromUtc: request.fromUtc, toUtc: request.toUtc, includeSeed: request.includeSeed, signals }, requestId, signal)))
    const history = histories[0]!
    return { pressKey, sourceKey: history.sourceKey, displayName: history.displayName, fromUtc: history.fromUtc, toUtc: history.toUtc, requestedCategories: request.categories, capabilities: capabilitySet.capabilities.filter(({ canonicalId }) => ids.has(canonicalId)), signals: histories.flatMap(({ signals }) => signals) }
  }
}
