import type { ReactNode } from 'react'
import { categoryClass, statusLabel } from '../analytics-presentation'
import { formatDuration } from '../episode-presentation'
import type { AnalyticsArea, OperationalSection } from '../navigation'
import type { OperationalAnalytics, RadiusOverview as RadiusOverviewModel, RadiusPressKey, RadiusStatusSegment } from '../types/api'
import { DeviationsSection, RelationshipExplorer, StateBreakdownSection, StatusDriversSection, StopsRecoverySection } from './OperationalAnalyticsOverview'
import { RadiusOverview } from './RadiusOverview'
import { RunComparison } from './RunComparison'

interface SharedProps {
  analytics: OperationalAnalytics
  scopeLabel: string
}

function PageIntroduction({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return <header className="page-introduction"><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{description}</p></header>
}

export function OverviewPage({ analytics, scopeLabel, overview, selectedPress, focusedPress, focusWorkspace, onSelectPress, onClearFocus, onNavigate, onInvestigateStatus, onInvestigateAnomaly }: SharedProps & {
  overview: RadiusOverviewModel
  selectedPress?: RadiusPressKey
  focusedPress?: RadiusPressKey
  focusWorkspace?: ReactNode
  onSelectPress(pressKey: RadiusPressKey): void
  onClearFocus?(): void
  onNavigate(area: AnalyticsArea, section?: OperationalSection): void
  onInvestigateStatus(identity: string): void
  onInvestigateAnomaly(anomalyId: string): void
}) {
  const category = (eventType: string) => analytics.categories.find((item) => item.eventType === eventType)
  const productionSeconds = category('G')?.productionSeconds ?? 0
  const productionPercentage = analytics.coverage.observedSeconds === 0 ? 0 : productionSeconds / analytics.coverage.observedSeconds * 100
  const topBadDriver = analytics.statusDrivers.find(({ eventType }) => eventType === 'B')
  const topDriver = analytics.statusDrivers[0]
  const primaryAnomaly = analytics.anomalies[0]
  const signals = [
    { label: 'Production', value: `${productionPercentage.toFixed(1)}%`, detail: formatDuration(productionSeconds), tone: 'good' },
    { label: 'Make Ready', value: `${(category('M')?.percentageOfObserved ?? 0).toFixed(1)}%`, detail: formatDuration(category('M')?.durationSeconds ?? 0), tone: 'make-ready' },
    { label: 'Bad', value: `${(category('B')?.percentageOfObserved ?? 0).toFixed(1)}%`, detail: formatDuration(category('B')?.durationSeconds ?? 0), tone: 'bad' },
    { label: 'Unknown', value: `${(100 - analytics.coverage.coveragePercentage).toFixed(1)}%`, detail: formatDuration(analytics.coverage.unknownSeconds), tone: 'unknown' },
  ]

  return <div className="page-stack overview-page">
    <PageIntroduction eyebrow="Signal and prioritization" title="Overview" description="See where attention is needed, then move directly into the operational driver or supporting behavior." />
    <section className="signal-strip" aria-label={`${scopeLabel} state summary`}>{signals.map((signal) => <div key={signal.label} className={`signal-metric signal-metric--${signal.tone}`}><span>{signal.label}</span><strong>{signal.value}</strong><small>{signal.detail}</small></div>)}</section>
    <div className="overview-decision-grid">
      <StateBreakdownSection analytics={analytics} scopeLabel={scopeLabel} compact />
      <section className="panel attention-summary" aria-labelledby="attention-summary-title">
        <div className="section-heading"><div><p className="eyebrow">Decision summary</p><h2 id="attention-summary-title">What needs attention?</h2><p className="section-description">Prioritized from existing deterministic Radius results for this scope.</p></div></div>
        <div className="priority-list">
          {analytics.coverage.coveragePercentage < 95 && <article className="priority-item priority-item--data"><span className="priority-marker" aria-hidden="true">!</span><div><strong>Incomplete Radius coverage</strong><p>{(100 - analytics.coverage.coveragePercentage).toFixed(1)}% of possible time is unknown and excluded from observed-state percentages.</p><button type="button" onClick={() => onNavigate('operational-analysis', 'state')}>Review state coverage</button></div></article>}
          {topBadDriver && <article className="priority-item priority-item--bad"><span className="priority-marker" aria-hidden="true">B</span><div><strong>{statusLabel(topBadDriver)} is the leading Bad driver</strong><p>{formatDuration(topBadDriver.durationSeconds)} across {topBadDriver.occurrenceCount} occurrences · {topBadDriver.pressCount}/{topBadDriver.scopePressCount} presses.</p><div className="inline-actions"><button type="button" onClick={() => onNavigate('operational-analysis', 'drivers')}>View operational analysis</button><button type="button" onClick={() => onInvestigateStatus(topBadDriver.identity)}>View evidence</button></div></div></article>}
          {primaryAnomaly && <article className="priority-item priority-item--deviation"><span className="priority-marker" aria-hidden="true">↗</span><div><strong>Observed path differs from common behavior</strong><p>{primaryAnomaly.displayName}: {primaryAnomaly.actualSequence.map(({ statusDescription }) => statusDescription).join(' → ')}</p><div className="inline-actions"><button type="button" onClick={() => onNavigate('patterns-episodes')}>Explore this pattern</button><button type="button" onClick={() => onInvestigateAnomaly(primaryAnomaly.anomalyId)}>View evidence</button></div></div></article>}
          {!topBadDriver && !primaryAnomaly && analytics.coverage.coveragePercentage >= 95 && <article className="priority-item priority-item--normal"><span className="priority-marker" aria-hidden="true">✓</span><div><strong>No supported exception requires immediate attention</strong><p>Use Operational Analysis to review time distribution and leading status drivers.</p><button type="button" onClick={() => onNavigate('operational-analysis')}>View operational analysis</button></div></article>}
        </div>
        {topDriver && <p className="attention-footnote"><span className={`category-dot category-dot--${categoryClass(topDriver.eventType)}`} /> Dominant time driver: <strong>{statusLabel(topDriver)}</strong> · {topDriver.percentageOfObserved.toFixed(1)}% of observed time.</p>}
      </section>
    </div>
    <RadiusOverview overview={overview} selectedPress={selectedPress} focusedPress={focusedPress} focusWorkspace={focusWorkspace} onSelectPress={onSelectPress} onClearFocus={onClearFocus} showSummary={false} />
  </div>
}

export function OperationalAnalysisPage({ analytics, scopeLabel, overview, selectedPress, runComparison, section, onSelectSection, onSelectPress, onInspectSegment, onInvestigateStatus }: SharedProps & {
  overview: RadiusOverviewModel
  selectedPress?: RadiusPressKey
  runComparison?: import('../types/api').OperationalRunComparison
  section: OperationalSection
  onSelectSection(section: OperationalSection): void
  onSelectPress?(pressKey: RadiusPressKey | undefined): void
  onInspectSegment(pressKey: RadiusPressKey, segment: RadiusStatusSegment): void
  onInvestigateStatus(identity: string): void
}) {
  const stateActive = section === 'state'
  return <div className="page-stack operational-analysis-page">
    <PageIntroduction eyebrow="Magnitude, drivers, and recovery" title="Operational Analysis" description="Review state distribution, the exact Radius statuses driving it, and production recovery together for the selected scope." />
    <div className="analysis-tabs" role="tablist" aria-label="Operational Analysis views">
      <button type="button" role="tab" aria-selected={stateActive} aria-controls="operational-state-panel" className={stateActive ? 'active' : ''} onClick={() => onSelectSection('state')}>State breakdown</button>
      <button type="button" role="tab" aria-selected={!stateActive} aria-controls="operational-drivers-panel" className={!stateActive ? 'active' : ''} onClick={() => onSelectSection('drivers')}>Drivers &amp; recovery</button>
    </div>
    {stateActive
      ? <div className="operational-analysis-sections" id="operational-state-panel" role="tabpanel">
        <StateBreakdownSection analytics={analytics} scopeLabel={scopeLabel} />
        <RunComparison selectedPress={selectedPress} comparison={runComparison} overview={overview} onSelectPress={onSelectPress} onInspectOverviewSegment={onInspectSegment} showIndividualRuns={false} onInspectSegment={(segment) => {
          const source = overview.presses.find(({ pressKey }) => pressKey === selectedPress)?.timelineSegments.find(({ startUtc, endUtc }) => startUtc === segment.startUtc && endUtc === segment.endUtc)
          if (source && selectedPress) onInspectSegment(selectedPress, source)
        }} />
      </div>
      : <div className="operational-analysis-sections" id="operational-drivers-panel" role="tabpanel">
        <StatusDriversSection analytics={analytics} onInvestigateStatus={onInvestigateStatus} />
        <StopsRecoverySection analytics={analytics} />
      </div>}
  </div>
}

export function PatternsEpisodesPage({ analytics, scopeLabel, onInvestigateAnomaly, episodeWorkspace }: SharedProps & { onInvestigateAnomaly(anomalyId: string): void; episodeWorkspace?: ReactNode }) {
  return <div className="page-stack patterns-episodes-page">
    <PageIntroduction eyebrow="Behavior and supporting evidence" title="Patterns & Episodes" description="Compare recurring state sequences, understand known variation, and inspect episodes that differ from common behavior." />
    <div className="scope-caption"><strong>{scopeLabel}</strong><span>Every relationship percentage includes exact support. Radius annotations do not establish physical cause.</span></div>
    <RelationshipExplorer analytics={analytics} />
    <DeviationsSection analytics={analytics} onInvestigateAnomaly={onInvestigateAnomaly} />
    {episodeWorkspace ?? <section className="panel episode-empty-state"><div className="empty-state-icon" aria-hidden="true">≋</div><h2>Select a press to inspect episodes</h2><p>Press-specific Episode Comparison, recurring sequences, Needs Attention findings, and evidence remain available here after a press is selected from Overview or the shared press scope control.</p></section>}
  </div>
}
