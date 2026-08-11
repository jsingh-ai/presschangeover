import type { OperationalEpisode, RadiusHealth, RadiusOverview, RadiusPressEpisodes, RadiusPressKey } from '../radius/models.js'
import type { RadiusService } from '../radius/radius-service.js'
import type { ObservedRadiusIdentity } from './models.js'
import type { ClassificationService } from './classification-service.js'

export class ClassifiedRadiusService implements RadiusService {
  constructor(private readonly source: RadiusService, private readonly classifications: ClassificationService) {}
  getHealth(): Promise<RadiusHealth> { return this.source.getHealth() }
  async getOverview(fromUtc: string, toUtc: string): Promise<RadiusOverview> { return this.classifications.classifyOverview(await this.source.getOverview(fromUtc, toUtc)) }
  async getPressEpisodes(pressKey: RadiusPressKey, fromUtc: string, toUtc: string): Promise<RadiusPressEpisodes> { return this.classifications.classifyPressEpisodes(await this.source.getPressEpisodes(pressKey, fromUtc, toUtc)) }
  async getEpisode(pressKey: RadiusPressKey, episodeId: string): Promise<OperationalEpisode> { return this.classifications.classifyEpisode(await this.source.getEpisode(pressKey, episodeId)) }
  getObservedIdentities(): Promise<ObservedRadiusIdentity[]> { return this.source.getObservedIdentities?.() ?? Promise.resolve([]) }
}
