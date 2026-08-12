import { useCallback, useEffect, useState } from 'react'
import type { OperationalAnalytics, OverviewTimelineInterval, RadiusOverview as RadiusOverviewModel, RadiusPressKey, RunPatternEvidence } from '../types/api'
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

export function OverviewPage({ overview, selectedPress, onInspectInterval }: {
  overview: RadiusOverviewModel
  selectedPress?: RadiusPressKey
  onInspectInterval?(pressKey: RadiusPressKey, interval: OverviewTimelineInterval): void
}) {
  return <div className="page-stack overview-page">
    <PageIntroduction eyebrow="Fleet orientation and decision support" title="Overview" description="See which presses spent the most observed time running, where non-production time went, and whether data coverage supports a fair comparison." />
    <RadiusOverview overview={overview} selectedPress={selectedPress} onInspectInterval={onInspectInterval} />
  </div>
}

export function OperationalAnalysisPage({ analytics, scopeLabel, overview, selectedPress }: SharedProps & {
  overview: RadiusOverviewModel
  selectedPress?: RadiusPressKey
}) {
  return <div className="page-stack operational-analysis-page">
    <PageIntroduction eyebrow="One activity · magnitude, frequency, where, and when" title="Operational Analysis" description="Select one Radius state, operational group, process family, or exact status to quantify its duration, frequency, press distribution, timing, semantic meaning, and exact supporting evidence." />
    <div className="scope-caption"><strong>{scopeLabel}</strong><span>One activity at a time. Combinations and ordered behavior belong in Patterns &amp; Episodes.</span></div>
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
    <PageIntroduction eyebrow="Combinations, order, and canonical Run evidence" title="Patterns & Episodes" description="Discover recurring operational-group sequences and build deterministic questions about which activities occurred together or in order inside the same canonical Run." />
    <div className="scope-caption"><strong>{scopeLabel}</strong><span>Patterns are descriptive evidence, not efficiency, root-cause, or job-adjusted conclusions.</span></div>
    <PatternExplorer fromUtc={overview.fromUtc} toUtc={overview.toUtc} pressKey={selectedPress} onSelectRun={openRun} onRestoreRun={setSelectedRun} />
    <section className="panel pattern-recovery-views" aria-labelledby="pattern-recovery-title"><div className="section-heading"><div><p className="eyebrow">Built-in deterministic sequence · separate 300-second rule</p><h2 id="pattern-recovery-title">Stops &amp; Recovery patterns</h2><p>Stop and confirmed-return sequences live here because this page asks what occurred together and in what order. This 300-second confirmation remains separate from the 120-second canonical Run rule.</p></div></div><dl className="activity-metrics"><div><dt>Production stops</dt><dd>{analytics.productionStops.anchorCount}</dd></div><div><dt>Resolved outcomes</dt><dd>{analytics.productionStops.resolvedCount} / {analytics.productionStops.anchorCount}</dd></div><div><dt>Confirmed return anchors</dt><dd>{analytics.beforeSuccessfulProduction.anchorCount}</dd></div><div><dt>Boundary / unavailable</dt><dd>{analytics.productionStops.censoredCount}</dd></div></dl></section>
    {selectedRun && <RunEvidenceDrawer run={selectedRun} rangeFromUtc={overview.fromUtc} rangeToUtc={overview.toUtc} onClose={closeRun} />}
  </div>
}
