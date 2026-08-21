export const JOB_INTELLIGENCE_RADIUS_CONCURRENCY_CAP = 1

export interface JobIntelligenceRadiusAcquisitionDiagnostics {
  concurrencyCap: number
  active: number
  queued: number
  peakQueued: number
  peakActive: number
  totalAcquisitions: number
  completed: number
  failed: number
  cancelledWhileQueued: number
}

export class JobIntelligenceRadiusAcquisitionScope {
  private state: JobIntelligenceRadiusAcquisitionDiagnostics

  constructor(concurrencyCap: number) {
    this.state = { concurrencyCap, active: 0, queued: 0, peakQueued: 0, peakActive: 0, totalAcquisitions: 0, completed: 0, failed: 0, cancelledWhileQueued: 0 }
  }

  diagnostics(): JobIntelligenceRadiusAcquisitionDiagnostics { return { ...this.state } }
  queued(delta: number) { this.state.queued += delta; this.state.peakQueued = Math.max(this.state.peakQueued, this.state.queued) }
  started() { this.state.active += 1; this.state.totalAcquisitions += 1; this.state.peakActive = Math.max(this.state.peakActive, this.state.active) }
  finished(failed: boolean) { this.state.active -= 1; this.state.completed += 1; if (failed) this.state.failed += 1 }
  cancelled() { this.state.cancelledWhileQueued += 1 }
}

interface Waiter {
  resolve(release: () => void): void
  reject(error: Error): void
  signal?: AbortSignal
  abort?: () => void
  scope?: JobIntelligenceRadiusAcquisitionScope
}

function cancellationError(): Error {
  const error = new Error('Job Intelligence Radius acquisition cancelled while queued')
  error.name = 'AbortError'
  return error
}

export class JobIntelligenceRadiusAcquisitionLimiter {
  private active = 0
  private peakActive = 0
  private peakQueued = 0
  private totalAcquisitions = 0
  private completed = 0
  private failed = 0
  private cancelledWhileQueued = 0
  private readonly queue: Waiter[] = []

  constructor(readonly concurrencyCap = JOB_INTELLIGENCE_RADIUS_CONCURRENCY_CAP) {
    if (!Number.isSafeInteger(concurrencyCap) || concurrencyCap < 1) throw new Error('invalid_job_intelligence_radius_concurrency_cap')
  }

  createScope(): JobIntelligenceRadiusAcquisitionScope { return new JobIntelligenceRadiusAcquisitionScope(this.concurrencyCap) }

  diagnostics(): JobIntelligenceRadiusAcquisitionDiagnostics {
    return { concurrencyCap: this.concurrencyCap, active: this.active, queued: this.queue.length, peakQueued: this.peakQueued, peakActive: this.peakActive, totalAcquisitions: this.totalAcquisitions, completed: this.completed, failed: this.failed, cancelledWhileQueued: this.cancelledWhileQueued }
  }

  private grant(waiter: Waiter) {
    if (waiter.abort && waiter.signal) waiter.signal.removeEventListener('abort', waiter.abort)
    waiter.scope?.queued(-1)
    this.active += 1; this.totalAcquisitions += 1; this.peakActive = Math.max(this.peakActive, this.active); waiter.scope?.started()
    let released = false
    waiter.resolve(() => {
      if (released) return
      released = true; this.active -= 1; this.completed += 1; this.drain()
    })
  }

  private drain() {
    while (this.active < this.concurrencyCap && this.queue.length) {
      const waiter = this.queue.shift()!
      if (waiter.signal?.aborted) { waiter.scope?.queued(-1); waiter.scope?.cancelled(); this.cancelledWhileQueued += 1; waiter.reject(cancellationError()); continue }
      this.grant(waiter)
    }
  }

  private acquire(signal?: AbortSignal, scope?: JobIntelligenceRadiusAcquisitionScope): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(cancellationError())
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, ...(signal ? { signal } : {}), ...(scope ? { scope } : {}) }
      if (this.active < this.concurrencyCap && this.queue.length === 0) { scope?.queued(1); this.grant(waiter); return }
      scope?.queued(1)
      if (signal) {
        waiter.abort = () => {
          const index = this.queue.indexOf(waiter)
          if (index < 0) return
          this.queue.splice(index, 1); scope?.queued(-1); scope?.cancelled(); this.cancelledWhileQueued += 1; reject(cancellationError()); this.drain()
        }
        signal.addEventListener('abort', waiter.abort, { once: true })
      }
      this.queue.push(waiter)
      this.peakQueued = Math.max(this.peakQueued, this.queue.length)
    })
  }

  async run<T>(work: () => Promise<T>, options: { signal?: AbortSignal; scope?: JobIntelligenceRadiusAcquisitionScope } = {}): Promise<T> {
    const release = await this.acquire(options.signal, options.scope)
    let didFail = false
    try { return await work() }
    catch (error) { didFail = true; this.failed += 1; throw error }
    finally { options.scope?.finished(didFail); release() }
  }
}

// Module ownership makes this semaphore process-wide across HTTP requests,
// service instances, legacy report support, and backfill code.
export const jobIntelligenceRadiusAcquisitionLimiter = new JobIntelligenceRadiusAcquisitionLimiter()
