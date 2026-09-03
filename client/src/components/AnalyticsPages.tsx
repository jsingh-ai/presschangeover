import type { RadiusOverview as RadiusOverviewModel, RadiusPressKey } from '../types/api'
import { RadiusOverview } from './RadiusOverview'

export function OverviewPage({ overview, selectedPress }: { overview: RadiusOverviewModel; selectedPress?: RadiusPressKey }) {
  return <div className="page-stack overview-page">
    <header className="page-introduction"><p className="eyebrow">Fleet orientation and decision support</p><h1>Overview</h1><p>See which presses spent the most observed time running, where non-production time went, and whether data coverage supports a fair comparison.</p></header>
    <RadiusOverview overview={overview} selectedPress={selectedPress} />
  </div>
}
