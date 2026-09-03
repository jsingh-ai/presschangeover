import type { RadiusHealth, RadiusOverview, RadiusPressKey } from '../radius/models.js'
import type { RadiusService } from '../radius/radius-service.js'
import type { ObservedRadiusIdentity } from './models.js'
import type { ClassificationService } from './classification-service.js'

export class ClassifiedRadiusService implements RadiusService {
  constructor(private readonly source: RadiusService, private readonly classifications: ClassificationService) {}
  getHealth(): Promise<RadiusHealth> { return this.source.getHealth() }
  async getOverview(fromUtc: string, toUtc: string): Promise<RadiusOverview> { return this.classifications.classifyOverview(await this.source.getOverview(fromUtc, toUtc)) }
  getObservedIdentities(): Promise<ObservedRadiusIdentity[]> { return this.source.getObservedIdentities?.() ?? Promise.resolve([]) }
  getRawTimeline(pressKey: RadiusPressKey, fromUtc: string, toUtc: string) { if (!this.source.getRawTimeline) throw new Error('Raw Radius timeline is unavailable'); return this.source.getRawTimeline(pressKey, fromUtc, toUtc) }
  getExactIdentityHistory(input: Parameters<NonNullable<RadiusService['getExactIdentityHistory']>>[0]) { if (!this.source.getExactIdentityHistory) throw new Error('Raw Radius identity history is unavailable'); return this.source.getExactIdentityHistory(input) }
}
