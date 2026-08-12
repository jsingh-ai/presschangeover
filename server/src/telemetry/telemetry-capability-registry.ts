import type { RadiusPressKey } from '../radius/models.js'
import type { TelemetryClient } from './telemetry-api-client.js'
import type { CapabilityAssessment, PressEvidenceCapabilities } from './telemetry-contracts.js'
import { DEFAULT_TELEMETRY_METADATA_TTL_MS, TelemetrySourceRegistry } from './telemetry-source-registry.js'
import { TelemetryApiError } from './telemetry-error.js'

interface CachedCapabilities { value: PressEvidenceCapabilities; loadedAt: number }

export const CORE_TELEMETRY_CAPABILITY_IDS = [
  'machine.speed.actual', 'machine.speed.setpoint', 'physical.motion_state',
  'production.job', 'production.order', 'production.recipe', 'production.customer', 'production.material', 'production.roll',
  'deck.active', 'deck.print_on', 'deck.print_off',
  'ink.washup.state', 'ink.pump.status', 'ink.viscosity.actual', 'ink.temperature.actual',
] as const

export class TelemetryCapabilityRegistry {
  private readonly cache = new Map<RadiusPressKey, CachedCapabilities>()
  private readonly inFlight = new Map<RadiusPressKey, Promise<PressEvidenceCapabilities>>()

  constructor(private readonly client: TelemetryClient, private readonly sources: TelemetrySourceRegistry, private readonly ttlMs = DEFAULT_TELEMETRY_METADATA_TTL_MS, private readonly now = () => Date.now()) {}

  async get(pressKey: RadiusPressKey, requestId?: string, signal?: AbortSignal): Promise<PressEvidenceCapabilities> {
    const cached = this.cache.get(pressKey)
    if (cached && this.now() - cached.loadedAt <= this.ttlMs) return { ...cached.value, metadataStatus: 'CACHED' }
    try {
      let pending = this.inFlight.get(pressKey)
      if (!pending) {
        pending = this.load(pressKey, requestId, signal).finally(() => this.inFlight.delete(pressKey))
        this.inFlight.set(pressKey, pending)
      }
      const value = await pending
      if (value.metadataStatus === 'STALE' && cached) return { ...cached.value, metadataStatus: 'STALE', capabilities: cached.value.capabilities.map((item) => ({ ...item, state: 'TEMPORARILY_UNAVAILABLE', lastKnownState: item.state === 'TEMPORARILY_UNAVAILABLE' ? item.lastKnownState : item.state })) }
      if (value.metadataStatus !== 'STALE') this.cache.set(pressKey, { value, loadedAt: this.now() })
      return value
    } catch (error) {
      if (error instanceof TelemetryApiError && error.kind === 'cancelled') throw error
      if (!cached) throw error
      return { ...cached.value, metadataStatus: 'STALE', capabilities: cached.value.capabilities.map((item) => ({ ...item, state: 'TEMPORARILY_UNAVAILABLE', lastKnownState: item.state === 'TEMPORARILY_UNAVAILABLE' ? item.lastKnownState : item.state })) }
    }
  }

  private async load(pressKey: RadiusPressKey, requestId?: string, signal?: AbortSignal): Promise<PressEvidenceCapabilities> {
    if (!this.client.getCapabilities) throw new TelemetryApiError('unavailable')
    const resolved = await this.sources.resolve(pressKey, requestId, signal)
    let upstream
    try { upstream = await this.client.getCapabilities(resolved.source.id, requestId, signal) }
    catch (error) {
      if (error instanceof TelemetryApiError && error.kind === 'cancelled') throw error
      return { pressKey, sourceId: resolved.source.id, sourceKey: resolved.source.sourceKey, displayName: resolved.source.displayName, metadataStatus: 'STALE', capabilities: CORE_TELEMETRY_CAPABILITY_IDS.map((canonicalId) => ({ canonicalId, state: 'TEMPORARILY_UNAVAILABLE', deckNumbers: [], historyQueryable: false, evidenceKind: null })) }
    }
    if (upstream.sourceId !== resolved.source.id || upstream.sourceKey.toLowerCase() !== pressKey) throw new TelemetryApiError('invalid_response')
    const capabilities: CapabilityAssessment[] = upstream.capabilities.map((item) => ({ canonicalId: item.canonicalId, state: item.supported ? 'SUPPORTED' : 'UNSUPPORTED', deckNumbers: item.deckNumbers, historyQueryable: item.historyQueryable, evidenceKind: item.evidenceKind }))
    for (const canonicalId of CORE_TELEMETRY_CAPABILITY_IDS) if (!capabilities.some((item) => item.canonicalId === canonicalId)) capabilities.push({ canonicalId, state: 'UNKNOWN', deckNumbers: [], historyQueryable: false, evidenceKind: null })
    return { pressKey, sourceId: upstream.sourceId, sourceKey: upstream.sourceKey, displayName: upstream.displayName, metadataStatus: 'FRESH', capabilities }
  }
}
