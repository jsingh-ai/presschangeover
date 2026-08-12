import { useEffect, useMemo, useState } from 'react'
import { getRadiusPressEpisodes } from '../api/process-intelligence-api'
import { formatDuration } from '../episode-presentation'
import { formatPlantDateTime } from '../time-ranges'
import type { OperationalRun, RadiusPressEpisodes, RunPatternEvidence } from '../types/api'
import { EvidenceDrawerShell } from './EvidenceDrawerShell'
import { PhysicalEvidencePanel } from './PhysicalEvidencePanel'
import { SynchronizedTimeline, type TimelineIntervalItem } from './SynchronizedTimeline'

function runSegmentItem(segment: OperationalRun['segments'][number], layer: 'radius' | 'semantic'): TimelineIntervalItem {
  const label = segment.isUnavailable ? 'Data unavailable' : layer === 'radius' ? `${segment.eventType ?? '—'} / ${segment.statusDescription ?? 'Unknown'}` : segment.operationalGroupName ?? 'Needs Classification'
  return {
    id: `${layer}:${segment.segmentId}`,
    startUtc: segment.startUtc,
    endUtc: segment.endUtc,
    label,
    unavailable: segment.isUnavailable,
    className: `run-relative-segment run-relative-segment--${segment.isUnavailable ? 'offline' : segment.eventType === 'G' ? 'good' : segment.eventType === 'M' ? 'make-ready' : segment.eventType === 'B' ? 'bad' : 'other'}`,
    details: `${label}\n${formatPlantDateTime(segment.startUtc)} – ${formatPlantDateTime(segment.endUtc)} CT\n${formatDuration(segment.durationSeconds)}${segment.isShortRunAttempt ? '\nShort Run Production attempt under 120 seconds' : ''}`,
  }
}

export function RunEvidenceDrawer({ run, rangeFromUtc, rangeToUtc, onClose }: { run: RunPatternEvidence; rangeFromUtc: string; rangeToUtc: string; onClose(): void }) {
  const [detail, setDetail] = useState<RadiusPressEpisodes>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError(false)
    void getRadiusPressEpisodes(run.pressKey, rangeFromUtc, rangeToUtc, controller.signal).then((value) => { if (!controller.signal.aborted) setDetail(value) }).catch(() => { if (!controller.signal.aborted) setError(true) }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [run.pressKey, run.runId, rangeFromUtc, rangeToUtc])
  const fullRun = useMemo(() => detail?.runComparison.runs.find(({ runId }) => runId === run.runId), [detail, run.runId])

  return <EvidenceDrawerShell eyebrow="Evidence · canonical Run" title={`${run.displayName} Run`} context="Elapsed semantic sequence with independent physical evidence" onClose={onClose}>
    <div className="drawer-content">
      <section className="drawer-section"><h3>Run interval</h3><dl className="drawer-interval-grid"><div><dt>Start</dt><dd>{formatPlantDateTime(run.startUtc)} CT</dd></div><div><dt>End</dt><dd>{formatPlantDateTime(run.endUtc)} CT</dd></div><div><dt>Duration</dt><dd>{formatDuration(run.totalDurationSeconds)}</dd></div></dl><p>{run.dataInterrupted ? 'Radius evidence was interrupted; this Run is excluded from eligible prevalence.' : run.isPartial ? 'This is a partial/open Run and is excluded from eligible prevalence.' : 'Completed canonical Run evidence.'}</p></section>
      <section className="drawer-section"><h3>ProcessIntelligence pattern</h3><p className="drawer-sequence">{run.groupSequence.join(' → ') || 'No classified group sequence'}</p><dl className="compact-facts"><div><dt>Time to sustained production</dt><dd>{run.timeToProductionSeconds === null ? 'Not reached' : formatDuration(run.timeToProductionSeconds)}</dd></div><div><dt>Full production interval</dt><dd>{formatDuration(run.productionDurationSeconds)}</dd></div><div><dt>Short return attempts</dt><dd>{run.shortRunAttemptCount}</dd></div><div><dt>Transitions</dt><dd>{run.transitionCount}</dd></div></dl></section>
      {loading && <div className="drawer-loading" role="status">Loading selected Run detail…</div>}
      {fullRun && <>
        <section className="drawer-section"><h3>Synchronized elapsed Run timeline</h3><SynchronizedTimeline fromUtc={fullRun.startUtc} toUtc={fullRun.endUtc} coordinateMode="elapsed" ariaLabel={`${run.displayName} elapsed Run evidence`} selectedId={undefined} intervalTracks={[{ id: 'radius', label: 'Radius recorded', intervals: fullRun.segments.map((segment) => runSegmentItem(segment, 'radius')) }, { id: 'semantic', label: 'ProcessIntelligence', intervals: fullRun.segments.map((segment) => runSegmentItem(segment, 'semantic')) }]} /></section>
        <section className="drawer-section"><h3>Same-press benchmark</h3><dl className="compact-facts"><div><dt>Comparable Runs</dt><dd>{fullRun.timeToProductionBenchmark.samePress.sampleRuns}</dd></div><div><dt>Same-press median to production</dt><dd>{fullRun.timeToProductionBenchmark.samePress.median === null ? 'Low support' : formatDuration(fullRun.timeToProductionBenchmark.samePress.median)}</dd></div><div><dt>Difference</dt><dd>{fullRun.timeToProductionBenchmark.samePress.delta === null ? 'Low support' : formatDuration(Math.abs(fullRun.timeToProductionBenchmark.samePress.delta)) + (fullRun.timeToProductionBenchmark.samePress.delta >= 0 ? ' longer' : ' shorter')}</dd></div><div><dt>Fleet benchmark</dt><dd>{fullRun.timeToProductionBenchmark.fleet.sufficientSupport && fullRun.timeToProductionBenchmark.fleet.median !== null ? `${formatDuration(fullRun.timeToProductionBenchmark.fleet.median)} · ${fullRun.timeToProductionBenchmark.fleet.samplePresses} presses` : 'Secondary benchmark has low support'}</dd></div></dl></section>
        <section className="drawer-section"><h3>Exact Radius sequence</h3><ol className="run-evidence-sequence">{fullRun.segments.map((segment) => <li key={segment.segmentId}><strong>{segment.statusDescription ?? 'Data unavailable'}</strong><span>{segment.eventType ?? '—'} / {segment.statusCode ?? '—'}</span><time>{formatPlantDateTime(segment.startUtc)} – {formatPlantDateTime(segment.endUtc)} CT</time><small>{formatDuration(segment.durationSeconds)}{segment.isShortRunAttempt ? ' · Short attempt' : ''}</small></li>)}</ol></section>
      </>}
      {error && <p className="message message--warning">Detailed Radius comparison could not be loaded. The matched Run evidence above remains available.</p>}
      <PhysicalEvidencePanel pressKey={run.pressKey} fromUtc={run.startUtc} toUtc={run.endUtc} />
      <section className="drawer-section"><h3>Evidence quality</h3><dl className="compact-facts"><div><dt>Radius evidence</dt><dd>{run.dataInterrupted ? 'Interrupted by an explicit unavailable gap' : 'Available for the original Run interval'}</dd></div><div><dt>Run eligibility</dt><dd>{run.eligible ? 'Eligible' : 'Excluded from pattern denominator'}</dd></div><div><dt>Telemetry evidence</dt><dd>Independent, capability-gated, and bounded to at most two hours</dd></div></dl></section>
    </div>
  </EvidenceDrawerShell>
}
