import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { JobIntelligenceRadiusAcquisitionLimiter } from '../src/job-intelligence/radius-acquisition-limiter.js'

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))

describe('Job Intelligence process-wide Radius acquisition limiter', () => {
  it('eventually runs all 12 acquisitions while never exceeding the configured cap', async () => {
    const limiter = new JobIntelligenceRadiusAcquisitionLimiter()
    let active = 0; let observedPeak = 0; let completed = 0
    await Promise.all(Array.from({ length: 12 }, (_value, index) => limiter.run(async () => {
      active += 1; observedPeak = Math.max(observedPeak, active)
      await delay(4 + index % 3)
      active -= 1; completed += 1
    })))
    assert.equal(completed, 12); assert.equal(observedPeak, 1)
    assert.deepEqual(limiter.diagnostics(), { concurrencyCap: 1, active: 0, queued: 0, peakQueued: 11, peakActive: 1, totalAcquisitions: 12, completed: 12, failed: 0, cancelledWhileQueued: 0 })
  })

  it('removes queued cancellations without consuming or leaking a permit', async () => {
    const limiter = new JobIntelligenceRadiusAcquisitionLimiter(1)
    let releaseFirst!: () => void
    const first = limiter.run(() => new Promise<void>((resolve) => { releaseFirst = resolve }))
    await delay(0)
    const controller = new AbortController()
    const cancelled = limiter.run(async () => undefined, { signal: controller.signal }).then(() => null, (error: Error) => error)
    const follower = limiter.run(async () => 'follower-completed')
    controller.abort(); releaseFirst()
    const [error, followerResult] = await Promise.all([cancelled, follower, first.then(() => undefined)])
    assert.equal(error?.name, 'AbortError'); assert.equal(followerResult, 'follower-completed')
    const diagnostics = limiter.diagnostics(); assert.equal(diagnostics.active, 0); assert.equal(diagnostics.queued, 0); assert.equal(diagnostics.totalAcquisitions, 2); assert.equal(diagnostics.cancelledWhileQueued, 1)
  })

  it('releases an active permit when cancellation rejects the active acquisition', async () => {
    const limiter = new JobIntelligenceRadiusAcquisitionLimiter(1); const controller = new AbortController()
    const active = limiter.run(() => new Promise<void>((_resolve, reject) => controller.signal.addEventListener('abort', () => reject(new Error('cancelled-active')), { once: true })), { signal: controller.signal }).catch((error: Error) => error.message)
    await delay(0)
    const follower = limiter.run(async () => 'follower-completed')
    controller.abort()
    assert.deepEqual(await Promise.all([active, follower]), ['cancelled-active', 'follower-completed'])
    assert.equal(limiter.diagnostics().active, 0); assert.equal(limiter.diagnostics().failed, 1); assert.equal(limiter.diagnostics().completed, 2)
  })

  it('releases permits after failures and drains queued work without starvation or deadlock', async () => {
    const limiter = new JobIntelligenceRadiusAcquisitionLimiter(1); const executionOrder: number[] = []
    const results = await Promise.allSettled(Array.from({ length: 6 }, (_value, index) => limiter.run(async () => {
      executionOrder.push(index); await delay(1)
      if (index === 1 || index === 4) throw new Error(`failure-${index}`)
      return index
    })))
    assert.deepEqual(executionOrder, [0, 1, 2, 3, 4, 5]); assert.deepEqual(results.map((result) => result.status), ['fulfilled', 'rejected', 'fulfilled', 'fulfilled', 'rejected', 'fulfilled'])
    assert.deepEqual(limiter.diagnostics(), { concurrencyCap: 1, active: 0, queued: 0, peakQueued: 5, peakActive: 1, totalAcquisitions: 6, completed: 6, failed: 2, cancelledWhileQueued: 0 })
  })
})
