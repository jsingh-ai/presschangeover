import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ObservedIdentityCache } from '../src/classification/observed-identity-cache.js'
import { exactRadiusIdentity } from '../src/radius/radius-identity.js'

function observed(description = 'Make Ready') {
  const raw = { eventType: 'M', statusCode: '16', statusDescription: description }
  return { ...raw, identity: exactRadiusIdentity(raw), eventCount: 3, lastSeenUtc: '2026-08-11T12:00:00.000Z' }
}

describe('observed identity last-good cache', () => {
  it('returns a fresh load once and a bounded cached result within the TTL', async () => {
    let calls = 0
    const cache = new ObservedIdentityCache(async () => {
      calls += 1
      return [observed(), observed(), observed('Plates: Wash')]
    }, { now: () => 1_000, maxIdentities: 2 })
    const first = await cache.get()
    const second = await cache.get()
    assert.equal(first.status, 'fresh')
    assert.equal(first.identities.length, 2)
    assert.equal(second.status, 'cached')
    assert.equal(calls, 1)
  })

  it('returns unavailable without leaking a Radius timeout when no last-good value exists', async () => {
    let errors = 0
    const cache = new ObservedIdentityCache(async () => { throw new Error('canceling statement due to statement timeout') }, { onRefreshError: () => { errors += 1 } })
    const result = await cache.get()
    assert.deepEqual(result, { identities: [], status: 'unavailable', asOfUtc: null })
    assert.equal(errors, 1)
  })

  it('falls back to the last-good snapshot after a transient Radius failure', async () => {
    let now = 1_000
    let calls = 0
    const cache = new ObservedIdentityCache(async () => {
      calls += 1
      if (calls > 1) throw new Error('statement timeout')
      return [observed()]
    }, { ttlMs: 100, retryMs: 50, now: () => now })
    assert.equal((await cache.get()).status, 'fresh')
    now += 101
    const fallback = await cache.get()
    assert.equal(fallback.status, 'cached')
    assert.equal(fallback.identities[0].statusDescription, 'Make Ready')
    assert.equal(calls, 2)
  })

  it('shares one in-flight refresh across concurrent cold requests', async () => {
    let calls = 0
    let release!: (value: ReturnType<typeof observed>[]) => void
    const pending = new Promise<ReturnType<typeof observed>[]>((resolve) => { release = resolve })
    const cache = new ObservedIdentityCache(async () => { calls += 1; return pending })
    const first = cache.get()
    const second = cache.get()
    const third = cache.get()
    release([observed()])
    const results = await Promise.all([first, second, third])
    assert.equal(calls, 1)
    assert.equal(results.every(({ status }) => status === 'fresh'), true)
  })

  it('serves static callers immediately while one background refresh is in flight', async () => {
    let calls = 0
    let release!: (value: ReturnType<typeof observed>[]) => void
    const pending = new Promise<ReturnType<typeof observed>[]>((resolve) => { release = resolve })
    const cache = new ObservedIdentityCache(async () => { calls += 1; return pending })
    assert.equal(cache.peekAndRefresh().status, 'unavailable')
    assert.equal(cache.peekAndRefresh().status, 'unavailable')
    assert.equal(calls, 1)
    release([observed()])
    await pending
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(cache.peekAndRefresh().status, 'cached')
  })
})
