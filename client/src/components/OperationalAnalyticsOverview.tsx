import { useMemo, useState } from 'react'
import { categoryClass, relationshipStrength, statusLabel, supportText } from '../analytics-presentation'
import { formatDuration } from '../episode-presentation'
import { formatPlantDateTime } from '../time-ranges'
import type {
  AnalyticsEvidenceInterval,
  MakeReadyPatternSummary,
  OperationalAnalytics,
  OperationalPatternSummary,
  OperationalRelationshipOutcome,
  OperationalStatusDriver,
} from '../types/api'

interface Props {
  analytics: OperationalAnalytics
  scopeLabel: string
  onInvestigateStatus(identity: string): void
  onInvestigateAnomaly(anomalyId: string): void
}

type DriverSort = 'duration' | 'occurrences' | 'median'

function compactDuration(seconds: number): string {
  return formatDuration(Math.round(seconds))
}

function EvidenceList({ items, empty }: { items: AnalyticsEvidenceInterval[]; empty: string }) {
  if (items.length === 0) return <p className="quiet-copy">{empty}</p>
  return <ul className="analytics-evidence-list">
    {items.map((item) => <li key={`${item.pressKey}-${item.startUtc}`}>
      <strong>{item.displayName}</strong>
      <span>{formatPlantDateTime(item.startUtc)} CT · {compactDuration(item.durationSeconds)}</span>
      <small>{item.previousStatus?.statusDescription ?? 'Range or data boundary'} → interval → {item.nextStatus?.statusDescription ?? 'Range or data boundary'}{item.leftCensored || item.rightCensored ? ' · range clipped' : ''}</small>
    </li>)}
  </ul>
}

function OutcomeRows({ outcomes, scopePressCount, limit = 4 }: { outcomes: OperationalRelationshipOutcome[]; scopePressCount: number; limit?: number }) {
  if (outcomes.length === 0) return <p className="quiet-copy">No resolved transitions are available in this range.</p>
  return <div className="pattern-outcomes">
    {outcomes.slice(0, limit).map((outcome) => <div key={outcome.target.identity}>
      <span className={`category-dot category-dot--${categoryClass(outcome.target.eventType)}`} aria-hidden="true" />
      <span><strong>{statusLabel(outcome.target)}</strong><small>{relationshipStrength(outcome)} · {outcome.pressCount}/{scopePressCount} presses</small></span>
      <b tabIndex={0} data-tooltip="Matching occurrences divided by resolved anchors">{supportText(outcome.numerator, outcome.denominator)}</b>
    </div>)}
  </div>
}

function PatternCard({ title, subtitle, pattern, scopePressCount }: { title: string; subtitle: string; pattern: OperationalPatternSummary; scopePressCount: number }) {
  return <article className="operational-pattern-card">
    <header><div><h3>{title}</h3><p>{subtitle}</p></div><strong title="Resolved anchors divided by all anchors">{pattern.resolvedCount}/{pattern.anchorCount}</strong></header>
    <OutcomeRows outcomes={pattern.outcomes} scopePressCount={scopePressCount} />
    <details>
      <summary>View common paths and denominator details</summary>
      <p className="denominator-note">Resolved: {pattern.resolvedCount}/{pattern.anchorCount}. Censored or unresolved at a range/data boundary: {pattern.censoredCount}.</p>
      {pattern.paths.length === 0 ? <p className="quiet-copy">No complete multi-step path was available.</p> : <ol className="path-list">
        {pattern.paths.slice(0, 6).map((path) => <li key={path.states.map(({ identity }) => identity).join('>')}>
          <span>{path.states.map(({ statusDescription }) => statusDescription).join(' → ')}</span>
          <strong>{supportText(path.count, path.denominator)}</strong>
          <small>{path.pressCount}/{scopePressCount} presses · median {compactDuration(path.medianElapsedSeconds)}{path.p90ElapsedSeconds === null ? '' : ` · P90 ${compactDuration(path.p90ElapsedSeconds)}`}{path.lowSupport ? ' · low support' : ''}</small>
        </li>)}
      </ol>}
    </details>
  </article>
}

function MakeReadyCard({ pattern, scopePressCount }: { pattern: MakeReadyPatternSummary; scopePressCount: number }) {
  return <article className="operational-pattern-card operational-pattern-card--make-ready">
    <header><div><h3>After Make Ready</h3><p>What followed each exact Radius Make Ready interval.</p></div><strong title="Resolved anchors divided by all anchors">{pattern.resolvedCount}/{pattern.anchorCount}</strong></header>
    <OutcomeRows outcomes={pattern.outcomes} scopePressCount={scopePressCount} />
    <details>
      <summary>View production-return and exception outcomes</summary>
      <dl className="analytics-facts">
        <div><dt>Reached confirmed production</dt><dd>{supportText(pattern.confirmedProductionCount, pattern.anchorCount)}</dd></div>
        <div><dt>Returned to Make Ready</dt><dd>{supportText(pattern.returnedToMakeReadyCount, pattern.anchorCount)}</dd></div>
        <div><dt>Entered Bad</dt><dd>{supportText(pattern.enteredBadCount, pattern.anchorCount)}</dd></div>
        <div><dt>Entered Radius S state</dt><dd>{supportText(pattern.enteredSafetyCount, pattern.anchorCount)}</dd></div>
        <div><dt>No confirmed production in bounded path</dt><dd>{supportText(pattern.failedToReachConfirmedProductionCount, pattern.anchorCount)}</dd></div>
        <div><dt>Unresolved at range/data boundary</dt><dd>{pattern.unresolvedCount}/{pattern.anchorCount}</dd></div>
        <div><dt>Time to confirmed production</dt><dd>{pattern.medianSecondsToConfirmedProduction === null ? 'No supported sample' : `Median ${compactDuration(pattern.medianSecondsToConfirmedProduction)}${pattern.p90SecondsToConfirmedProduction === null ? '' : ` · P90 ${compactDuration(pattern.p90SecondsToConfirmedProduction)}`}`}</dd></div>
      </dl>
      {pattern.paths.length > 0 && <ol className="path-list">{pattern.paths.slice(0, 5).map((path) => <li key={path.states.map(({ identity }) => identity).join('>')}><span>{path.states.map(({ statusDescription }) => statusDescription).join(' → ') || 'No later known state'}</span><strong>{supportText(path.count, path.denominator)}</strong></li>)}</ol>}
    </details>
  </article>
}

export function StateBreakdownSection({ analytics, scopeLabel, compact = false }: { analytics: OperationalAnalytics; scopeLabel: string; compact?: boolean }) {
  return <section className={compact ? 'panel state-breakdown state-breakdown--compact' : 'panel state-breakdown'} aria-labelledby="state-breakdown-title">
    <div className="section-heading"><div><p className="eyebrow">{scopeLabel} · selected range</p><h2 id="state-breakdown-title">State breakdown</h2><p className="section-description">Shows how observed Radius time was distributed across operational states during the selected period.</p></div><div className="coverage-callout" tabIndex={0} data-tooltip="Observed Radius time divided by all possible press-time in this scope."><strong>{analytics.coverage.coveragePercentage.toFixed(1)}%</strong><span>observed coverage · {compactDuration(analytics.coverage.observedSeconds)}</span></div></div>
    <div className="state-stack" role="img" aria-label={`Observed coverage ${analytics.coverage.coveragePercentage.toFixed(1)} percent. Unknown time is excluded from observed-state percentages.`}>
      {analytics.categories.map((category) => <span key={category.eventType} className={`state-stack__${categoryClass(category.eventType)}`} style={{ width: `${category.percentageOfPossible}%` }} title={`${category.category}: ${category.percentageOfObserved.toFixed(1)}% of observed time`} />)}
      {analytics.coverage.unknownSeconds > 0 && <span className="state-stack__unknown" style={{ width: `${100 - analytics.coverage.coveragePercentage}%` }} title="Unknown / unobserved time" />}
    </div>
    <div className="state-summary-grid">
      {analytics.categories.map((category) => <article key={category.eventType}>
        <span className={`category-dot category-dot--${categoryClass(category.eventType)}`} aria-hidden="true" /><div><strong>{category.category}</strong><small>{category.occurrenceCount} occurrences</small></div><b>{compactDuration(category.durationSeconds)}</b><em>{category.percentageOfObserved.toFixed(1)}% observed</em>
        {category.eventType === 'G' && category.productionSeconds > 0 && <small className="production-subset">Run Production: {compactDuration(category.productionSeconds)}</small>}
      </article>)}
      <article className="state-summary-unknown"><span className="category-dot category-dot--unknown" aria-hidden="true" /><div><strong>Unknown / unobserved</strong><small>Excluded from observed-state percentages</small></div><b>{compactDuration(analytics.coverage.unknownSeconds)}</b><em>{(100 - analytics.coverage.coveragePercentage).toFixed(1)}% possible</em></article>
    </div>
    {!compact && <p className="annotation-disclaimer">{analytics.annotationDisclaimer}</p>}
  </section>
}

function driverValue(driver: OperationalStatusDriver, sort: DriverSort) {
  if (sort === 'occurrences') return driver.occurrenceCount
  if (sort === 'median') return driver.medianOccurrenceSeconds
  return driver.durationSeconds
}

export function StatusDriversSection({ analytics, onInvestigateStatus }: { analytics: OperationalAnalytics; onInvestigateStatus(identity: string): void }) {
  const [driverSort, setDriverSort] = useState<DriverSort>('duration')
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set())
  const categoryGroups = analytics.categories.map((category) => ({ category, drivers: analytics.statusDrivers.filter(({ eventType }) => eventType === category.eventType).sort((left, right) => driverValue(right, driverSort) - driverValue(left, driverSort)) }))
  const toggleCategory = (eventType: string) => setExpandedCategories((current) => {
    const next = new Set(current)
    if (next.has(eventType)) next.delete(eventType); else next.add(eventType)
    return next
  })

  return <section className="panel status-drivers" aria-labelledby="driver-title">
    <div className="section-heading"><div><p className="eyebrow">Exact Radius identities</p><h2 id="driver-title">Status drivers</h2><p className="section-description">Identifies the exact Radius statuses contributing the most observed time within each state.</p></div><label className="compact-select">Sort within category<select value={driverSort} onChange={(event) => setDriverSort(event.target.value as DriverSort)}><option value="duration">Total duration</option><option value="occurrences">Occurrence count</option><option value="median">Median dwell</option></select></label></div>
    <div className="driver-groups">{categoryGroups.map(({ category, drivers }) => {
      const expanded = expandedCategories.has(category.eventType)
      return <article key={category.eventType} className={`driver-group driver-group--${categoryClass(category.eventType)}`}>
        <header><h3>{category.category}</h3><span>{compactDuration(category.durationSeconds)} · {category.occurrenceCount} occurrences</span></header>
        <div className="driver-list">{drivers.slice(0, expanded ? undefined : 3).map((driver) => <button key={driver.identity} type="button" onClick={() => onInvestigateStatus(driver.identity)} title={`Investigate ${statusLabel(driver)}`}>
          <span><strong>{statusLabel(driver)}</strong><small>{driver.occurrenceCount} occurrences · median {compactDuration(driver.medianOccurrenceSeconds)}{driver.p90OccurrenceSeconds === null ? ' · P90 requires at least 5' : ` · P90 ${compactDuration(driver.p90OccurrenceSeconds)}`}</small></span>
          <span><b>{compactDuration(driver.durationSeconds)}</b><small>{driver.percentageOfObserved.toFixed(1)}% observed · {driver.percentageWithinCategory.toFixed(1)}% of {category.category}</small></span>
          <span><b>{driver.pressCount}/{driver.scopePressCount}</b><small>press coverage{driver.clippedOccurrenceCount ? ` · ${driver.clippedOccurrenceCount} clipped` : ''}</small></span>
        </button>)}</div>
        {drivers.length > 3 && <button type="button" className="expand-action" onClick={() => toggleCategory(category.eventType)} aria-expanded={expanded}>{expanded ? 'Show leading 3' : `Show all ${drivers.length}`}</button>}
      </article>
    })}</div>
  </section>
}

export function StopsRecoverySection({ analytics }: { analytics: OperationalAnalytics }) {
  return <section className="panel patterns-panel" aria-labelledby="patterns-title">
    <div className="section-heading"><div><p className="eyebrow">Production interruption behavior</p><h2 id="patterns-title">Stops & recovery</h2><p className="section-description">Shows how production interruptions progressed and how frequently the press returned successfully to production.</p></div><p className="section-note">Every percentage includes its numerator and denominator. Boundary-censored anchors are reported separately.</p></div>
    <div className="operational-pattern-grid">
      <PatternCard title="After production stops" subtitle="First known non-production state after verified G / Run Production." pattern={analytics.productionStops} scopePressCount={analytics.scopePressCount} />
      <PatternCard title="Before successful production" subtitle="Last known state before a return satisfying the existing five-minute confirmation rule." pattern={analytics.beforeSuccessfulProduction} scopePressCount={analytics.scopePressCount} />
      <MakeReadyCard pattern={analytics.afterMakeReady} scopePressCount={analytics.scopePressCount} />
    </div>
  </section>
}

export function RelationshipExplorer({ analytics }: { analytics: OperationalAnalytics }) {
  const anchors = useMemo(() => {
    const unique = new Map(analytics.relationshipGroups.map(({ anchor }) => [anchor.identity, anchor]))
    return [...unique.values()].sort((left, right) => statusLabel(left).localeCompare(statusLabel(right)))
  }, [analytics])
  const [anchorIdentity, setAnchorIdentity] = useState(anchors[0]?.identity ?? '')
  const [direction, setDirection] = useState<'after' | 'before'>('after')
  const [distance, setDistance] = useState<1 | 2 | 3>(1)
  const group = analytics.relationshipGroups.find((candidate) => candidate.anchor.identity === anchorIdentity && candidate.direction === direction && candidate.maxTransitions === distance)
  const [requestedTarget, setRequestedTarget] = useState('')
  const selectedOutcome = group?.outcomes.find(({ target }) => target.identity === requestedTarget) ?? group?.outcomes[0]
  const exceptions = group?.outcomes.filter(({ target }) => target.identity !== selectedOutcome?.target.identity).flatMap(({ evidence }) => evidence).slice(0, 8) ?? []

  return <section className="panel relationship-panel" aria-labelledby="relationship-title">
    <div className="section-heading"><div><p className="eyebrow">Common behavior and known variation</p><h2 id="relationship-title">State relationship explorer</h2><p className="section-description">Tests what normally occurred before or after an exact Radius status and shows both matching and non-matching evidence.</p></div><p className="section-note">Known states only. Data gaps, offline boundaries, and range-edge censoring never become transitions.</p></div>
    {anchors.length === 0 ? <p className="empty-state">No complete state relationships can be calculated for this range. Try a longer period or a press with more observed transitions.</p> : <>
      <div className="relationship-controls">
        <label>Anchor status<select value={anchorIdentity} onChange={(event) => { setAnchorIdentity(event.target.value); setRequestedTarget('') }}>{anchors.map((anchor) => <option key={anchor.identity} value={anchor.identity}>{anchor.category} · {statusLabel(anchor)}</option>)}</select></label>
        <label>Direction<select value={direction} onChange={(event) => { setDirection(event.target.value as 'after' | 'before'); setRequestedTarget('') }}><option value="after">After anchor</option><option value="before">Before anchor</option></select></label>
        <label>Transition window<select value={distance} onChange={(event) => { setDistance(Number(event.target.value) as 1 | 2 | 3); setRequestedTarget('') }}><option value={1}>Immediate next</option><option value={2}>Within next 2</option><option value={3}>Within next 3</option></select></label>
        <label>Target status<select value={selectedOutcome?.target.identity ?? ''} onChange={(event) => setRequestedTarget(event.target.value)}>{group?.outcomes.map((outcome) => <option key={outcome.target.identity} value={outcome.target.identity}>{outcome.target.category} · {statusLabel(outcome.target)}</option>)}</select></label>
      </div>
      {!group || !selectedOutcome ? <p className="empty-state">No known target state is available for this relationship.</p> : <>
        <div className="relationship-result">
          <div><span>{relationshipStrength(selectedOutcome)}</span><strong tabIndex={0} data-tooltip="Matching occurrences divided by anchors with a known adjacent state">{supportText(selectedOutcome.numerator, selectedOutcome.denominator)}</strong><small>{selectedOutcome.lowSupport ? 'Low support · interpret cautiously' : 'Supported sample'} · {selectedOutcome.pressCount}/{analytics.scopePressCount} presses</small></div>
          <dl className="analytics-facts"><div><dt>Median transition lag</dt><dd>{compactDuration(selectedOutcome.medianLagSeconds)}</dd></div><div><dt>P90 lag</dt><dd>{selectedOutcome.p90LagSeconds === null ? 'Requires at least 5 matches' : compactDuration(selectedOutcome.p90LagSeconds)}</dd></div><div><dt>Excluded / censored anchors</dt><dd>{group.censoredCount}</dd></div><div><dt>Denominator</dt><dd>{group.denominator} anchors with a known {direction === 'after' ? 'next' : 'previous'} state</dd></div></dl>
        </div>
        <div className="relationship-evidence-grid">
          <details><summary>Matching evidence ({selectedOutcome.evidence.length} shown)</summary><EvidenceList items={selectedOutcome.evidence} empty="No matching evidence was retained." /></details>
          <details><summary>Variation / non-matching evidence ({exceptions.length} shown)</summary><EvidenceList items={exceptions} empty="No variation was observed among resolved anchors." /></details>
        </div>
      </>}
    </>}
  </section>
}

export function DeviationsSection({ analytics, onInvestigateAnomaly }: { analytics: OperationalAnalytics; onInvestigateAnomaly(anomalyId: string): void }) {
  return <section className="panel anomaly-panel" aria-labelledby="anomaly-title">
    <div className="section-heading"><div><p className="eyebrow">Expected behavior compared with variation</p><h2 id="anomaly-title">Pattern deviations</h2><p className="section-description">Highlights observed transitions that differ from a sufficiently supported common path.</p></div><span className="anomaly-count" aria-label={`${analytics.anomalies.length} deviations`}>{analytics.anomalies.length}</span></div>
    {analytics.anomalies.length === 0 ? <p className="empty-state">No deviations met the deterministic support threshold in this range. This does not imply every transition was physically normal.</p> : <div className="anomaly-list">{analytics.anomalies.slice(0, 12).map((anomaly) => <button type="button" key={anomaly.anomalyId} onClick={() => onInvestigateAnomaly(anomaly.anomalyId)}>
      <span><strong>{anomaly.displayName} · {formatPlantDateTime(anomaly.observedAtUtc)} CT</strong><small>{anomaly.reason}</small></span>
      <span><b>{anomaly.actualSequence.map(({ statusDescription }) => statusDescription).join(' → ')}</b><small>Common path: {anomaly.expectedSequence.map(({ statusDescription }) => statusDescription).join(' → ')} · support {anomaly.normalNumerator}/{anomaly.normalDenominator}{anomaly.lowSupport ? ' · low support' : ''}</small></span>
    </button>)}</div>}
  </section>
}

export function OperationalAnalyticsOverview({ analytics, scopeLabel, onInvestigateStatus, onInvestigateAnomaly }: Props) {
  return <section className="analytics-overview" aria-label={`${scopeLabel} operational analytics`}>
    <StateBreakdownSection analytics={analytics} scopeLabel={scopeLabel} />
    <StatusDriversSection analytics={analytics} onInvestigateStatus={onInvestigateStatus} />
    <StopsRecoverySection analytics={analytics} />
    <RelationshipExplorer analytics={analytics} />
    <DeviationsSection analytics={analytics} onInvestigateAnomaly={onInvestigateAnomaly} />
  </section>
}
