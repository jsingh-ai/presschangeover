import type { RadiusPressKey } from '../radius/models.js'
import type { TelemetryClient } from './telemetry-api-client.js'
import { TelemetryCapabilityRegistry } from './telemetry-capability-registry.js'
import {
  PRODUCTION_CONTEXT_CANONICAL_IDS,
  PRODUCTION_CONTEXT_FIELDS,
  type CapabilityAssessment,
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
  type TelemetrySemanticSignalHistory,
} from './telemetry-contracts.js'
import { TelemetryApiError } from './telemetry-error.js'
import { TelemetrySourceRegistry } from './telemetry-source-registry.js'

const MAX_SEMANTIC_SELECTORS_PER_REQUEST = 50

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
  historianSignalId: number | null
  rawSignalId: string | null
  sourceSelector: string | null
  selectedVariant: string | null
}

export class TelemetryFoundationService {
  readonly sources: TelemetrySourceRegistry
  readonly capabilities: TelemetryCapabilityRegistry

  constructor(private readonly client: TelemetryClient, options: { metadataTtlMs?: number; now?: () => number } = {}) {
    this.sources = new TelemetrySourceRegistry(client, options.metadataTtlMs, options.now)
    this.capabilities = new TelemetryCapabilityRegistry(client, this.sources, options.metadataTtlMs, options.now)
  }

  async semanticHistory(pressKey: RadiusPressKey, query: TelemetrySemanticHistoryQuery, requestId?: string, signal?: AbortSignal): Promise<PressSemanticHistoryEvidence> {
    if (!this.client.querySemanticHistory) throw new TelemetryApiError('unavailable')
    const resolved = await this.sources.resolve(pressKey, requestId, signal)
    const [upstream, capabilitySet] = await Promise.all([
      this.client.querySemanticHistory(resolved.source.id, query, requestId, signal),
      this.capabilities.get(pressKey, requestId, signal).catch(() => undefined),
    ])
    if (upstream.sourceId !== resolved.source.id || upstream.sourceKey.toLowerCase() !== pressKey) throw new TelemetryApiError('invalid_response')
    return {
      pressKey,
      sourceKey: upstream.sourceKey,
      displayName: upstream.displayName,
      fromUtc: upstream.fromUtc,
      toUtc: upstream.toUtc,
      includeSeed: upstream.includeSeed,
      signals: upstream.signals.map((item) => signalEvidence(item, capabilitySet?.capabilities.find(({ canonicalId }) => canonicalId === item.canonicalId))),
    }
  }

  /** Internal-only event-search path that retains exact upstream identity. Browser-facing semantic routes keep omitting it. */
  async semanticHistoryWithIdentity(pressKey: RadiusPressKey, query: TelemetrySemanticHistoryQuery, requestId?: string, signal?: AbortSignal): Promise<Omit<PressSemanticHistoryEvidence, 'signals'> & { signals: PressSemanticSignalWithIdentity[] }> {
    if (!this.client.querySemanticHistory) throw new TelemetryApiError('unavailable')
    const resolved = await this.sources.resolve(pressKey, requestId, signal)
    const [upstream, capabilitySet] = await Promise.all([
      this.client.querySemanticHistory(resolved.source.id, query, requestId, signal),
      this.capabilities.get(pressKey, requestId, signal).catch(() => undefined),
    ])
    if (upstream.sourceId !== resolved.source.id || upstream.sourceKey.toLowerCase() !== pressKey) throw new TelemetryApiError('invalid_response')
    return {
      pressKey, sourceKey: upstream.sourceKey, displayName: upstream.displayName, fromUtc: upstream.fromUtc, toUtc: upstream.toUtc, includeSeed: upstream.includeSeed,
      signals: upstream.signals.map((item) => ({ ...signalEvidence(item, capabilitySet?.capabilities.find(({ canonicalId }) => canonicalId === item.canonicalId)), historianSignalId: item.historianSignalId, rawSignalId: item.rawSignalId, sourceSelector: item.sourceSelector, selectedVariant: item.selectedVariant })),
    }
  }

  async rawChanges(pressKey: RadiusPressKey, fromUtc: string, toUtc: string, requestId?: string, signal?: AbortSignal): Promise<RawTelemetryChangesResponse> {
    if (!this.client.getRawTelemetryChanges) throw new TelemetryApiError('unavailable')
    const response = await this.client.getRawTelemetryChanges({ press: pressKey, fromUtc, toUtc }, requestId, signal)
    if (response.press.toLowerCase() !== pressKey) throw new TelemetryApiError('invalid_response')
    return response
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
