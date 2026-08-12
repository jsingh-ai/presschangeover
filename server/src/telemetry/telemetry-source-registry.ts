import { RADIUS_PRESS_KEYS, type RadiusPressKey } from '../radius/models.js'
import type { TelemetryClient } from './telemetry-api-client.js'
import type { ResolvedTelemetrySource, TelemetryMetadataStatus, TelemetryPressSourceStatus } from './telemetry-contracts.js'
import { TelemetryApiError } from './telemetry-error.js'
import type { TelemetrySource } from './models.js'

export const DEFAULT_TELEMETRY_METADATA_TTL_MS = 5 * 60 * 1_000

export class TelemetrySourceRegistry {
  private sources: TelemetrySource[] | undefined
  private loadedAt = 0
  private inFlight: Promise<TelemetrySource[]> | undefined

  constructor(private readonly client: TelemetryClient, private readonly ttlMs = DEFAULT_TELEMETRY_METADATA_TTL_MS, private readonly now = () => Date.now()) {}

  private async refresh(requestId?: string, signal?: AbortSignal): Promise<TelemetrySource[]> {
    if (!this.inFlight) this.inFlight = this.client.getSources(requestId, signal).then((sources) => {
      if (new Set(sources.map(({ sourceKey }) => sourceKey)).size !== sources.length) throw new TelemetryApiError('invalid_response')
      this.sources = sources
      this.loadedAt = this.now()
      return sources
    }).finally(() => { this.inFlight = undefined })
    if (signal?.aborted) throw new TelemetryApiError('cancelled')
    return this.inFlight
  }

  async list(requestId?: string, signal?: AbortSignal): Promise<{ sources: TelemetrySource[]; metadataStatus: TelemetryMetadataStatus }> {
    if (this.sources && this.now() - this.loadedAt <= this.ttlMs) return { sources: this.sources, metadataStatus: 'CACHED' }
    try { return { sources: await this.refresh(requestId, signal), metadataStatus: 'FRESH' } }
    catch (error) {
      if (error instanceof TelemetryApiError && error.kind === 'cancelled') throw error
      if (this.sources) return { sources: this.sources, metadataStatus: 'STALE' }
      throw error
    }
  }

  async presses(requestId?: string, signal?: AbortSignal): Promise<TelemetryPressSourceStatus[]> {
    try {
      const { sources, metadataStatus } = await this.list(requestId, signal)
      return RADIUS_PRESS_KEYS.map((pressKey) => {
        const source = sources.find(({ sourceKey }) => sourceKey.toLowerCase() === pressKey)
        return source ? { pressKey, sourceKey: source.sourceKey, displayName: source.displayName, enabled: source.enabled, availability: source.enabled ? 'AVAILABLE' : 'DISABLED', metadataStatus } : { pressKey, sourceKey: null, displayName: pressKey.replace('press', 'Press '), enabled: null, availability: 'NO_SOURCE', metadataStatus }
      })
    } catch {
      return RADIUS_PRESS_KEYS.map((pressKey) => ({ pressKey, sourceKey: null, displayName: pressKey.replace('press', 'Press '), enabled: null, availability: 'TEMPORARILY_UNAVAILABLE', metadataStatus: 'STALE' }))
    }
  }

  async resolve(pressKey: RadiusPressKey, requestId?: string, signal?: AbortSignal): Promise<ResolvedTelemetrySource> {
    const { sources, metadataStatus } = await this.list(requestId, signal)
    const source = sources.find(({ sourceKey }) => sourceKey.toLowerCase() === pressKey)
    if (!source || !source.enabled) throw new TelemetryApiError('unsupported_source', 404)
    return { pressKey, source, metadataStatus }
  }
}
