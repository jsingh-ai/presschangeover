export interface RadiusAcquisitionGuardDiagnostics {
  cap: number
  active: number
  queued: number
  lifetimePeak: number
}

interface Waiter {
  resolve: (release: () => void) => void
  reject: (error: Error) => void
  signal?: AbortSignal
  onAbort?: () => void
}

function abortError(): Error {
  const error = new Error('Radius acquisition was cancelled')
  error.name = 'AbortError'
  return error
}

export class ChangeoverRadiusAcquisitionGuard {
  private active = 0
  private lifetimePeak = 0
  private readonly queue: Waiter[] = []

  constructor(readonly cap = 1) {
    if (!Number.isSafeInteger(cap) || cap < 1) throw new Error('invalid_radius_acquisition_cap')
  }

  diagnostics(): RadiusAcquisitionGuardDiagnostics {
    return { cap: this.cap, active: this.active, queued: this.queue.length, lifetimePeak: this.lifetimePeak }
  }

  async run<T>(operation: () => Promise<T>, options: { signal?: AbortSignal } = {}): Promise<T> {
    const release = await this.acquire(options.signal)
    try {
      if (options.signal?.aborted) throw abortError()
      return await operation()
    } finally {
      release()
    }
  }

  private acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(abortError())
    if (this.active < this.cap) {
      this.active += 1
      this.lifetimePeak = Math.max(this.lifetimePeak, this.active)
      return Promise.resolve(this.releaseOnce())
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, ...(signal ? { signal } : {}) }
      if (signal) {
        waiter.onAbort = () => {
          const index = this.queue.indexOf(waiter)
          if (index >= 0) this.queue.splice(index, 1)
          reject(abortError())
        }
        signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
      this.queue.push(waiter)
    })
  }

  private releaseOnce(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      this.active -= 1
      this.drain()
    }
  }

  private drain(): void {
    while (this.active < this.cap && this.queue.length) {
      const waiter = this.queue.shift()!
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort)
      if (waiter.signal?.aborted) { waiter.reject(abortError()); continue }
      this.active += 1
      this.lifetimePeak = Math.max(this.lifetimePeak, this.active)
      waiter.resolve(this.releaseOnce())
    }
  }
}

export const changeoverRadiusAcquisitionGuard = new ChangeoverRadiusAcquisitionGuard(1)
