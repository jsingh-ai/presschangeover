import type { RadiusPressKey } from '../radius/models.js'
import type { StopIntelligenceService } from '../stop-intelligence/service.js'
import type { PressDowntimePressReport } from './contracts.js'
import { buildPressDowntimeReport } from './engine.js'

export class PressDowntimeService {
  constructor(private readonly stopIntelligence: StopIntelligenceService, private readonly now = () => Date.now()) {}

  async press(input: { pressKey: RadiusPressKey; fromUtc: string; toUtc: string }, requestId?: string, signal?: AbortSignal): Promise<PressDowntimePressReport> {
    const report = await this.stopIntelligence.fleet(input, requestId, signal)
    return buildPressDowntimeReport(report, new Date(this.now()).toISOString())
  }
}
