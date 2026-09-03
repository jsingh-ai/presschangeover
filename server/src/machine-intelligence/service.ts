import type { RadiusPressKey } from '../radius/models.js'
import type { StopIntelligenceService } from '../stop-intelligence/service.js'
import type { MachineIntelligencePressReport } from './contracts.js'
import { buildMachineIntelligenceReport } from './engine.js'

export class MachineIntelligenceService {
  constructor(private readonly stopIntelligence: StopIntelligenceService, private readonly now = () => Date.now()) {}

  async press(input: { pressKey: RadiusPressKey; fromUtc: string; toUtc: string }, requestId?: string, signal?: AbortSignal): Promise<MachineIntelligencePressReport> {
    const report = await this.stopIntelligence.fleet(input, requestId, signal)
    return buildMachineIntelligenceReport(report, new Date(this.now()).toISOString())
  }
}
