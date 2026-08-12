import { useMemo } from 'react'
import { statusLabel, supportText } from '../analytics-presentation'
import { formatDuration } from '../episode-presentation'
import { formatPlantDateTime } from '../time-ranges'
import type { OperationalAnalytics } from '../types/api'
import type { InvestigationRoute } from '../workspace-state'
import { EvidenceDrawerShell } from './EvidenceDrawerShell'

interface Props {
  route: Extract<InvestigationRoute, { mode: 'status' } | { mode: 'anomaly' }>
  analytics: OperationalAnalytics
  scopeLabel: string
  onClose(): void
}

export function AnalyticsEvidenceDrawer({ route, analytics, scopeLabel, onClose }: Props) {
  const driver = route.mode === 'status' ? analytics.statusDrivers.find(({ identity }) => identity === route.statusIdentity) : undefined
  const anomaly = route.mode === 'anomaly' ? analytics.anomalies.find(({ anomalyId }) => anomalyId === route.anomalyId) : undefined
  const anomalyRelationship = useMemo(() => anomaly && analytics.relationshipGroups.find((group) =>
    group.direction === 'after' && group.maxTransitions === 1 && group.anchor.identity === anomaly.actualSequence[0]?.identity,
  ), [analytics, anomaly])
  const driverRelationships = useMemo(() => driver ? analytics.relationshipGroups
    .filter((group) => group.anchor.identity === driver.identity && group.maxTransitions === 1 && group.outcomes.length > 0)
    .map((group) => ({ group, outcome: group.outcomes[0] })) : [], [analytics, driver])

  return <EvidenceDrawerShell eyebrow={`Evidence · ${route.mode}`} title={scopeLabel} context="Radius and ProcessIntelligence evidence" onClose={onClose}>
      {driver && <div className="drawer-content">
        <div className="drawer-focus-title"><span>{driver.category} · exact Radius identity</span><strong>{statusLabel(driver)}</strong></div>
        <dl className="drawer-summary compact-facts">
          <div><dt>Total duration</dt><dd>{formatDuration(driver.durationSeconds)}</dd></div>
          <div><dt>Observed-time share</dt><dd>{driver.percentageOfObserved.toFixed(1)}%</dd></div>
          <div><dt>Category share</dt><dd>{driver.percentageWithinCategory.toFixed(1)}%</dd></div>
          <div><dt>Occurrences</dt><dd>{driver.occurrenceCount}</dd></div>
          <div><dt>Median / P90 dwell</dt><dd>{formatDuration(driver.medianOccurrenceSeconds)} / {driver.p90OccurrenceSeconds === null ? 'requires ≥5' : formatDuration(driver.p90OccurrenceSeconds)}</dd></div>
          <div><dt>Press coverage</dt><dd>{driver.pressCount}/{driver.scopePressCount}</dd></div>
          <div><dt>Range-clipped occurrences</dt><dd>{driver.clippedOccurrenceCount}</dd></div>
        </dl>
        <section className="drawer-analysis"><h3>Contributing intervals</h3><p className="quiet-copy">Evidence is bounded to the selected range. Adjacent states are shown only when continuously known.</p>
          <ul className="drawer-evidence-list">{driver.evidence.map((item) => <li key={`${item.pressKey}-${item.startUtc}`}><strong>{item.displayName}</strong><span>{formatPlantDateTime(item.startUtc)}–{formatPlantDateTime(item.endUtc)} CT</span><span>{formatDuration(item.durationSeconds)}</span><small>{item.previousStatus?.statusDescription ?? 'Boundary / no known previous state'} → selected interval → {item.nextStatus?.statusDescription ?? 'Boundary / no known next state'}{item.leftCensored || item.rightCensored ? ' · clipped by range/open state' : ''}</small></li>)}</ul>
        </section>
        {driverRelationships.length > 0 && <section className="drawer-analysis"><h3>Typical before / after context</h3><p className="quiet-copy">Immediate, continuously known Radius relationships for this exact status identity.</p><div className="drawer-cohort-grid">{driverRelationships.map(({ group, outcome }) => <div key={group.direction}><strong>{group.direction === 'after' ? 'Usually followed by' : 'Usually preceded by'} {statusLabel(outcome.target)}</strong><span>{supportText(outcome.numerator, outcome.denominator)} · {outcome.pressCount}/{analytics.scopePressCount} presses</span></div>)}</div></section>}
        <p className="annotation-disclaimer">{analytics.annotationDisclaimer}</p>
      </div>}
      {anomaly && <div className="drawer-content">
        <div className="drawer-focus-title"><span>Deterministic pattern deviation</span><strong>{anomaly.displayName} · {formatPlantDateTime(anomaly.observedAtUtc)} CT</strong></div>
        <section className="drawer-analysis">
          <h3>Why it was flagged</h3><p>{anomaly.reason}</p>
          <dl className="compact-facts">
            <div><dt>Actual sequence</dt><dd>{anomaly.actualSequence.map(statusLabel).join(' → ')}</dd></div>
            <div><dt>Expected/common sequence</dt><dd>{anomaly.expectedSequence.map(statusLabel).join(' → ')}</dd></div>
            <div><dt>Normal support</dt><dd>{supportText(anomaly.normalNumerator, anomaly.normalDenominator)}</dd></div>
            <div><dt>Observed exception count</dt><dd>{anomaly.observedCount}</dd></div>
            <div><dt>Support qualification</dt><dd>{anomaly.lowSupport ? 'Low support' : 'Minimum support met'}</dd></div>
          </dl>
        </section>
        {anomalyRelationship && <section className="drawer-analysis"><h3>Matching and exception cohort</h3><div className="drawer-cohort-grid">{anomalyRelationship.outcomes.map((outcome) => <div key={outcome.target.identity}><strong>{statusLabel(outcome.target)}</strong><span>{supportText(outcome.numerator, outcome.denominator)} · {outcome.pressCount}/{analytics.scopePressCount} presses</span></div>)}</div></section>}
        <p className="annotation-disclaimer">{analytics.annotationDisclaimer}</p>
      </div>}
      {!driver && !anomaly && <p className="drawer-missing">This analytics evidence is not present in the selected range and filter.</p>}
  </EvidenceDrawerShell>
}
