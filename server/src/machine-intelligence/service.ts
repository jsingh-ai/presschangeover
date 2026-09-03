import { RADIUS_PRESS_KEYS, type RadiusPressKey } from '../radius/models.js'
import type { StopIntelligenceService } from '../stop-intelligence/service.js'
import { MACHINE_INTELLIGENCE_VERSION, type MachineIntelligenceFleetOverview, type MachineIntelligencePressOverview } from './contracts.js'
import { buildMachineIntelligenceOverview } from './engine.js'

const PRESS_CONCURRENCY = 3

async function mapPresses<T>(values: readonly RadiusPressKey[], operation: (pressKey: RadiusPressKey) => Promise<T>): Promise<T[]> {
  const results: T[] = new Array(values.length); let cursor = 0
  const worker = async () => {
    while (cursor < values.length) {
      const index = cursor++
      results[index] = await operation(values[index]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(PRESS_CONCURRENCY, values.length) }, worker))
  return results
}

export class MachineIntelligenceService {
  constructor(private readonly stopIntelligence: StopIntelligenceService, private readonly now = () => Date.now()) {}

  async overview(input: { fromUtc: string; toUtc: string }, requestId?: string, signal?: AbortSignal): Promise<MachineIntelligenceFleetOverview> {
    const results = await mapPresses(RADIUS_PRESS_KEYS, async (pressKey) => {
      try {
        // One logical read per press lets the telemetry layer batch the full range.
        // It also avoids building or retaining the removed drill-down report.
        const report = await this.stopIntelligence.fleet({ ...input, pressKey }, requestId, signal, { cache: 'bypass' })
        return { overview: buildMachineIntelligenceOverview(report), failure: null }
      } catch (error) {
        if (signal?.aborted) throw error
        return { overview: null, failure: { pressKey, displayName: pressKey.replace('press', 'Press '), reason: 'Overview evidence could not be loaded.' } }
      }
    })
    return {
      version: MACHINE_INTELLIGENCE_VERSION,
      generatedAtUtc: new Date(this.now()).toISOString(),
      fromUtc: input.fromUtc,
      toUtc: input.toUtc,
      presses: results.flatMap(({ overview }) => overview ? [overview] : []) as MachineIntelligencePressOverview[],
      unavailablePresses: results.flatMap(({ failure }) => failure ? [failure] : []),
    }
  }
}
