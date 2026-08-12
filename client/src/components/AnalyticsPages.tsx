import { useState } from 'react'
import type { OperationalAnalytics, RadiusOverview as RadiusOverviewModel, RadiusPressKey } from '../types/api'
import { RadiusOverview } from './RadiusOverview'
import { OperationalActivityExplorer } from './OperationalActivityExplorer'
import { PatternExplorer } from './PatternExplorer'
import { RunComparison } from './RunComparison'

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
    <PageIntroduction eyebrow="One activity · magnitude, frequency, where, and when" title="Operational Analysis" description="Select one Radius state, operational group, process family, or exact status to quantify its duration, frequency, press distribution, timing, semantic meaning, and exact supporting evidence." />
    <div className="scope-caption"><strong>{scopeLabel}</strong><span>One activity at a time. Combinations and ordered behavior belong in Patterns &amp; Episodes.</span></div>
    <OperationalActivityExplorer fromUtc={overview.fromUtc} toUtc={overview.toUtc} pressKey={selectedPress} analytics={analytics} />
  </div>
}

export function PatternsEpisodesPage({ scopeLabel, overview, selectedPress, runComparison, onSelectPress, onInspectSegment }: SharedProps & { overview: RadiusOverviewModel; selectedPress?: RadiusPressKey; runComparison?: import('../types/api').OperationalRunComparison; onSelectPress?(pressKey: RadiusPressKey | undefined): void; onInspectSegment?(segment: import('../types/api').OperationalRunSegment): void }) {
  const [matchedRunId, setMatchedRunId] = useState<string>()
  return <div className="page-stack patterns-episodes-page">
    <PageIntroduction eyebrow="Combinations, order, and canonical Run evidence" title="Patterns & Episodes" description="Discover recurring operational-group sequences and build deterministic questions about which activities occurred together or in order inside the same canonical Run." />
    <div className="scope-caption"><strong>{scopeLabel}</strong><span>Patterns are descriptive evidence, not efficiency, root-cause, or job-adjusted conclusions.</span></div>
    <PatternExplorer fromUtc={overview.fromUtc} toUtc={overview.toUtc} pressKey={selectedPress} onSelectRun={(run) => { setMatchedRunId(run.runId); onSelectPress?.(run.pressKey); setTimeout(() => document.getElementById('pattern-run-detail')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100) }} />
    {selectedPress && runComparison && <div id="pattern-run-detail"><RunComparison selectedPress={selectedPress} comparison={runComparison} initialRunId={matchedRunId} onInspectSegment={(segment) => onInspectSegment?.(segment)} /></div>}
  </div>
}
