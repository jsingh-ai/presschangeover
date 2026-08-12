import { useCallback, useEffect, useState } from 'react'
import type { OperationalAnalytics, RadiusOverview as RadiusOverviewModel, RadiusPressKey, RunPatternEvidence } from '../types/api'
import { RadiusOverview } from './RadiusOverview'
import { OperationalActivityExplorer } from './OperationalActivityExplorer'
import { PatternExplorer } from './PatternExplorer'
import { RunEvidenceDrawer } from './RunEvidenceDrawer'

interface SharedProps {
  analytics: OperationalAnalytics
  scopeLabel: string
}

function PageIntroduction({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return <header className="page-introduction"><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{description}</p></header>
}

export function OverviewPage({ overview, selectedPress }: {
  overview: RadiusOverviewModel
  selectedPress?: RadiusPressKey
}) {
  return <div className="page-stack overview-page">
    <PageIntroduction eyebrow="Fleet orientation and decision support" title="Overview" description="See which presses spent the most observed time running, where non-production time went, and whether data coverage supports a fair comparison." />
    <RadiusOverview overview={overview} selectedPress={selectedPress} />
  </div>
}

export function OperationalAnalysisPage({ analytics, scopeLabel, overview, selectedPress }: SharedProps & {
  overview: RadiusOverviewModel
  selectedPress?: RadiusPressKey
}) {
  return <div className="page-stack operational-analysis-page">
    <PageIntroduction eyebrow="From Radius phase to operational explanation" title="Operational Analysis" description="Choose a broad Radius phase, narrow through ProcessIntelligence Operational Groups and Process Families, then inspect exact codes only when needed. The page quantifies one clearly identified activity across time and presses." />
    <div className="scope-caption"><strong>{scopeLabel}</strong><span>The guided path controls the activity analyzed below. Combinations and ordered behavior belong in Patterns &amp; Episodes.</span></div>
    <OperationalActivityExplorer fromUtc={overview.fromUtc} toUtc={overview.toUtc} pressKey={selectedPress} analytics={analytics} />
  </div>
}

export function PatternsEpisodesPage({ analytics, scopeLabel, overview, selectedPress }: SharedProps & { overview: RadiusOverviewModel; selectedPress?: RadiusPressKey; runComparison?: import('../types/api').OperationalRunComparison; onSelectPress?(pressKey: RadiusPressKey | undefined): void; onInspectSegment?(segment: import('../types/api').OperationalRunSegment): void }) {
  const [selectedRun, setSelectedRun] = useState<RunPatternEvidence>()
  const openRun = (run: RunPatternEvidence) => {
    const url = new URL(window.location.href)
    url.searchParams.set('evidence', 'run')
    url.searchParams.set('runId', run.runId)
    window.history.pushState({ processIntelligenceEvidenceDrawer: true }, '', `${url.pathname}?${url.searchParams}`)
    setSelectedRun(run)
  }
  const closeRun = useCallback(() => {
    setSelectedRun(undefined)
    if ((window.history.state as { processIntelligenceEvidenceDrawer?: boolean } | null)?.processIntelligenceEvidenceDrawer) { window.history.back(); return }
    const url = new URL(window.location.href)
    url.searchParams.delete('evidence')
    url.searchParams.delete('runId')
    window.history.replaceState({}, '', `${url.pathname}?${url.searchParams}`)
  }, [])
  useEffect(() => {
    const restore = () => { if (new URLSearchParams(window.location.search).get('evidence') !== 'run') setSelectedRun(undefined) }
    window.addEventListener('popstate', restore)
    return () => window.removeEventListener('popstate', restore)
  }, [])
  return <div className="page-stack patterns-episodes-page">
    <PageIntroduction eyebrow="Repeated journeys and exact Run evidence" title="Patterns & Episodes" description="Find meaningful journeys that happened more than once, build a simple step-by-step question, and open any matching Run to see exactly when it happened." />
    <div className="scope-caption"><strong>{scopeLabel}</strong><span>A pattern needs at least three steps and two completed Runs. It describes what repeated; it does not claim why it happened.</span></div>
    <PatternExplorer fromUtc={overview.fromUtc} toUtc={overview.toUtc} pressKey={selectedPress} onSelectRun={openRun} onRestoreRun={setSelectedRun} />
    <section className="panel pattern-recovery-views" aria-labelledby="pattern-recovery-title"><div className="section-heading"><div><p className="eyebrow">Built-in recovery journey</p><h2 id="pattern-recovery-title">What happened after production stopped?</h2><p>A return counts only after production remains stable for five minutes. Brief production attempts are kept visible instead of being mistaken for a completed recovery.</p></div></div><dl className="activity-metrics"><div><dt>Production stops</dt><dd>{analytics.productionStops.anchorCount}</dd></div><div><dt>Returned to stable production</dt><dd>{analytics.productionStops.resolvedCount} / {analytics.productionStops.anchorCount}</dd></div><div><dt>Stable return points</dt><dd>{analytics.beforeSuccessfulProduction.anchorCount}</dd></div><div><dt>Could not be followed to an outcome</dt><dd>{analytics.productionStops.censoredCount}</dd></div></dl></section>
    {selectedRun && <RunEvidenceDrawer run={selectedRun} rangeFromUtc={overview.fromUtc} rangeToUtc={overview.toUtc} onClose={closeRun} />}
  </div>
}
