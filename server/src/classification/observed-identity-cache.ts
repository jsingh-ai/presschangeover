import type { ObservedRadiusIdentity } from './models.js'

export type ObservedIdentityStatus = 'fresh' | 'cached' | 'unavailable'

export interface ObservedIdentitySnapshot {
  identities: ObservedRadiusIdentity[]
  status: ObservedIdentityStatus
  asOfUtc: string | null
}

export const OBSERVED_IDENTITY_CACHE_TTL_MS = 60_000
const OBSERVED_IDENTITY_RETRY_MS = 15_000
const MAX_OBSERVED_IDENTITIES = 2_000

interface CacheOptions {
  ttlMs?: number
  retryMs?: number
  maxIdentities?: number
  now?: () => number
  onRefreshError?: () => void
}

function normalizedIdentities(
  identities: ObservedRadiusIdentity[],
  maximum: number,
): ObservedRadiusIdentity[] {
  const distinct = new Map<string, ObservedRadiusIdentity>()
  for (const item of identities) {
    if (!item.identity || distinct.has(item.identity)) continue
    distinct.set(item.identity, {
      ...item,
      eventCount: Math.max(0, Number(item.eventCount) || 0),
      lastSeenUtc: item.lastSeenUtc ?? null,
    })
    if (distinct.size >= maximum) break
  }
  return [...distinct.values()].sort((left, right) =>
    left.identity.localeCompare(right.identity),
  )
}

export class ObservedIdentityCache {
  private lastGood: { identities: ObservedRadiusIdentity[]; atMs: number } | null = null
  private refreshPromise: Promise<ObservedIdentitySnapshot> | null = null
  private nextRefreshAtMs = 0
  private readonly ttlMs: number
  private readonly retryMs: number
  private readonly maxIdentities: number
  private readonly now: () => number
  private readonly onRefreshError?: () => void

  constructor(
    private readonly loader: () => Promise<ObservedRadiusIdentity[]>,
    options: CacheOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? OBSERVED_IDENTITY_CACHE_TTL_MS
    this.retryMs = options.retryMs ?? OBSERVED_IDENTITY_RETRY_MS
    this.maxIdentities = options.maxIdentities ?? MAX_OBSERVED_IDENTITIES
    this.now = options.now ?? Date.now
    this.onRefreshError = options.onRefreshError
  }

  private cachedSnapshot(): ObservedIdentitySnapshot {
    if (!this.lastGood) {
      return { identities: [], status: 'unavailable', asOfUtc: null }
    }
    return {
      identities: this.lastGood.identities,
      status: 'cached',
      asOfUtc: new Date(this.lastGood.atMs).toISOString(),
    }
  }

  private refresh(): Promise<ObservedIdentitySnapshot> {
    if (this.refreshPromise) return this.refreshPromise
    const startedAt = this.now()
    this.refreshPromise = this.loader()
      .then((items) => {
        const atMs = this.now()
        const identities = normalizedIdentities(items, this.maxIdentities)
        this.lastGood = { identities, atMs }
        this.nextRefreshAtMs = atMs + this.ttlMs
        return {
          identities,
          status: 'fresh' as const,
          asOfUtc: new Date(atMs).toISOString(),
        }
      })
      .catch(() => {
        this.nextRefreshAtMs = Math.max(this.now(), startedAt) + this.retryMs
        this.onRefreshError?.()
        return this.cachedSnapshot()
      })
      .finally(() => { this.refreshPromise = null })
    return this.refreshPromise
  }

  async get(): Promise<ObservedIdentitySnapshot> {
    const now = this.now()
    if (this.lastGood && now < this.lastGood.atMs + this.ttlMs) {
      return this.cachedSnapshot()
    }
    if (now < this.nextRefreshAtMs) return this.cachedSnapshot()
    return this.refresh()
  }

  peekAndRefresh(): ObservedIdentitySnapshot {
    const snapshot = this.cachedSnapshot()
    const now = this.now()
    if ((!this.lastGood || now >= this.lastGood.atMs + this.ttlMs) && now >= this.nextRefreshAtMs) {
      void this.refresh()
    }
    return snapshot
  }
}
