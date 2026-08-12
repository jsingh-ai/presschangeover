import { useEffect, useMemo, useState } from 'react'
import { getRadiusPressEpisodes } from '../api/process-intelligence-api'
import { formatDuration } from '../episode-presentation'
import { formatPlantDateTime } from '../time-ranges'
import type { OperationalRun, OperationalRunSegment, RadiusPressEpisodes, RunPatternEvidence } from '../types/api'
import { EvidenceDrawerShell } from './EvidenceDrawerShell'
import { PhysicalEvidencePanel } from './PhysicalEvidencePanel'
import { SynchronizedTimeline, type TimelineIntervalItem, type TimelineIntervalTrack } from './SynchronizedTimeline'
import { usePressTelemetryEvidence } from './TelemetryEvidenceTimeline'
import { UnifiedProcessTimeline } from './UnifiedProcessTimeline'

type RunLayer = 'radius' | 'group' | 'family'

function layerIdentity(segment: OperationalRunSegment, layer: RunLayer) {
  if (segment.isUnavailable) return { key: 'unavailable', label: 'Data unavailable' }
  if (layer === 'radius') return { key: segment.exactIdentity ?? `${segment.eventType}:${segment.statusCode}:${segment.statusDescription}`, label: `${segment.eventType ?? '—'} / ${segment.statusCode ?? '—'} / ${segment.statusDescription ?? 'Unknown'}` }
  if (layer === 'group') return { key: segment.operationalGroupKey ?? 'needs-classification', label: segment.operationalGroupName ?? 'Needs Classification' }
  return { key: segment.processFamilyKey ?? 'needs-classification', label: segment.processFamilyName ?? 'Needs Classification' }
}

export function runLayerIntervals(run: OperationalRun, layer: RunLayer, clip?: { fromUtc: string; toUtc: string }): TimelineIntervalItem[] {
  const from = Date.parse(clip?.fromUtc ?? run.startUtc)
  const to = Date.parse(clip?.toUtc ?? run.endUtc)
  const items: TimelineIntervalItem[] = []
  for (const segment of run.segments) {
    const start = Math.max(from, Date.parse(segment.startUtc))
    const end = Math.min(to, Date.parse(segment.endUtc))
    if (end <= start) continue
    const identity = layerIdentity(segment, layer)
    const previous = items.at(-1)
    if (layer !== 'radius' && previous?.endUtc === new Date(start).toISOString() && previous.id.startsWith(`${layer}:${identity.key}:`) && previous.unavailable === segment.isUnavailable) {
      previous.endUtc = new Date(end).toISOString()
      previous.details = `${identity.label}\n${formatPlantDateTime(previous.startUtc)} – ${formatPlantDateTime(previous.endUtc)} CT`
      continue
    }
    items.push({
      id: `${layer}:${identity.key}:${segment.segmentId}`,
      startUtc: new Date(start).toISOString(), endUtc: new Date(end).toISOString(), label: identity.label,
      unavailable: segment.isUnavailable,
      className: `run-relative-segment run-relative-segment--${segment.isUnavailable ? 'offline' : layer === 'family' ? 'family' : segment.eventType === 'G' ? 'good' : segment.eventType === 'M' ? 'make-ready' : segment.eventType === 'B' ? 'bad' : 'other'}`,
      details: `${identity.label}\n${formatPlantDateTime(new Date(start).toISOString())} – ${formatPlantDateTime(new Date(end).toISOString())} CT\n${formatDuration((end - start) / 1_000)}${segment.isShortRunAttempt ? '\nShort Run Production attempt under 120 seconds' : ''}`,
    })
  }
  return items
}

function runTracks(run: OperationalRun, clip?: { fromUtc: string; toUtc: string }): { radius: TimelineIntervalTrack; group: TimelineIntervalTrack; family: TimelineIntervalTrack } {
  return {
    radius: { id: 'radius', label: 'Radius recorded', intervals: runLayerIntervals(run, 'radius', clip) },
    group: { id: 'operational-group', label: 'Operational Group', intervals: runLayerIntervals(run, 'group', clip) },
    family: { id: 'process-family', label: 'Process Family', intervals: runLayerIntervals(run, 'family', clip) },
  }
}

export function RunEvidenceDrawer({ run, rangeFromUtc, rangeToUtc, onClose }: { run: RunPatternEvidence; rangeFromUtc: string; rangeToUtc: string; onClose(): void }) {
  const [detail, setDetail] = useState<RadiusPressEpisodes>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const telemetry = usePressTelemetryEvidence(run.pressKey, run.startUtc, run.endUtc, { padShortRange: false })
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError(false)
    void getRadiusPressEpisodes(run.pressKey, rangeFromUtc, rangeToUtc, controller.signal).then((value) => { if (!controller.signal.aborted) setDetail(value) }).catch(() => { if (!controller.signal.aborted) setError(true) }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [run.pressKey, run.runId, rangeFromUtc, rangeToUtc])
  const fullRun = useMemo(() => detail?.runComparison.runs.find(({ runId }) => runId === run.runId), [detail, run.runId])
  const longRun = telemetry.range.focused
  const fullTracks = fullRun ? runTracks(fullRun) : undefined
  const focusedTracks = fullRun ? runTracks(fullRun, telemetry.range) : undefined

  return <EvidenceDrawerShell eyebrow="Evidence · canonical Run" title={`${run.displayName} Run`} context="Elapsed semantic sequence with independent physical evidence" onClose={onClose}>
    <div className="drawer-content">
      <section className="drawer-section"><h3>Run interval</h3><dl className="drawer-interval-grid"><div><dt>Start</dt><dd>{formatPlantDateTime(run.startUtc)} CT</dd></div><div><dt>End</dt><dd>{formatPlantDateTime(run.endUtc)} CT</dd></div><div><dt>Duration</dt><dd>{formatDuration(run.totalDurationSeconds)}</dd></div></dl><p>{run.dataInterrupted ? 'Radius evidence was interrupted; this Run is excluded from eligible prevalence.' : run.isPartial ? 'This is a partial/open Run and is excluded from eligible prevalence.' : 'Completed canonical Run evidence.'}</p></section>
      <section className="drawer-section"><h3>ProcessIntelligence pattern</h3><p className="drawer-sequence">{run.groupSequence.join(' → ') || 'No classified group sequence'}</p><dl className="compact-facts"><div><dt>Time to sustained production</dt><dd>{run.timeToProductionSeconds === null ? 'Not reached' : formatDuration(run.timeToProductionSeconds)}</dd></div><div><dt>Full production interval</dt><dd>{formatDuration(run.productionDurationSeconds)}</dd></div><div><dt>Short return attempts</dt><dd>{run.shortRunAttemptCount}</dd></div><div><dt>Transitions</dt><dd>{run.transitionCount}</dd></div></dl></section>
      {loading && <div className="drawer-loading" role="status">Loading selected Run detail…</div>}
      {fullRun && fullTracks && <>
        {!longRun ? <section className="drawer-section"><h3>Unified synchronized Run evidence</h3><p className="quiet-copy">Context, Radius, Operational Group, Process Family, Physical Motion, Actual Speed, and observed event changes share one elapsed-Run axis.</p><UnifiedProcessTimeline fromUtc={fullRun.startUtc} toUtc={fullRun.endUtc} coordinateMode="elapsed" ariaLabel={`${run.displayName} unified elapsed Run evidence`} radiusTrack={fullTracks.radius} groupTrack={fullTracks.group} familyTrack={fullTracks.family} telemetry={telemetry} /></section> : <>
          <section className="drawer-section"><h3>Complete Run chronology</h3><p className="telemetry-range-note">This Run exceeds two hours. Complete Radius and semantic chronology remains below; telemetry is not silently chunked or truncated.</p><SynchronizedTimeline fromUtc={fullRun.startUtc} toUtc={fullRun.endUtc} coordinateMode="elapsed" ariaLabel={`${run.displayName} complete elapsed Run chronology`} intervalTracks={[fullTracks.radius, fullTracks.group, fullTracks.family]} /></section>
          {focusedTracks && <section className="drawer-section"><h3>Focused two-hour telemetry window</h3><p className="quiet-copy">{formatPlantDateTime(telemetry.range.fromUtc)} – {formatPlantDateTime(telemetry.range.toUtc)} CT · midpoint-focused physical detail</p><UnifiedProcessTimeline fromUtc={telemetry.range.fromUtc} toUtc={telemetry.range.toUtc} coordinateMode="elapsed" elapsedOriginUtc={fullRun.startUtc} ariaLabel={`${run.displayName} focused elapsed telemetry evidence`} radiusTrack={focusedTracks.radius} groupTrack={focusedTracks.group} familyTrack={focusedTracks.family} telemetry={telemetry} /></section>}
        </>}
        <section className="drawer-section"><h3>Same-press benchmark</h3><dl className="compact-facts"><div><dt>Comparable Runs</dt><dd>{fullRun.timeToProductionBenchmark.samePress.sampleRuns}</dd></div><div><dt>Same-press median to production</dt><dd>{fullRun.timeToProductionBenchmark.samePress.median === null ? 'Low support' : formatDuration(fullRun.timeToProductionBenchmark.samePress.median)}</dd></div><div><dt>Difference</dt><dd>{fullRun.timeToProductionBenchmark.samePress.delta === null ? 'Low support' : formatDuration(Math.abs(fullRun.timeToProductionBenchmark.samePress.delta)) + (fullRun.timeToProductionBenchmark.samePress.delta >= 0 ? ' longer' : ' shorter')}</dd></div><div><dt>Fleet benchmark</dt><dd>{fullRun.timeToProductionBenchmark.fleet.sufficientSupport && fullRun.timeToProductionBenchmark.fleet.median !== null ? `${formatDuration(fullRun.timeToProductionBenchmark.fleet.median)} · ${fullRun.timeToProductionBenchmark.fleet.samplePresses} presses` : 'Secondary benchmark has low support'}</dd></div></dl></section>
        <section className="drawer-section"><h3>Exact Radius sequence</h3><ol className="run-evidence-sequence">{fullRun.segments.map((segment) => <li key={segment.segmentId}><strong>{segment.statusDescription ?? 'Data unavailable'}</strong><span>{segment.eventType ?? '—'} / {segment.statusCode ?? '—'}</span><time>{formatPlantDateTime(segment.startUtc)} – {formatPlantDateTime(segment.endUtc)} CT</time><small>{formatDuration(segment.durationSeconds)}{segment.isShortRunAttempt ? ' · Short attempt' : ''}</small></li>)}</ol></section>
      </>}
      {error && <p className="message message--warning">Detailed Radius comparison could not be loaded. The matched Run evidence above remains available.</p>}
      <PhysicalEvidencePanel pressKey={run.pressKey} fromUtc={run.startUtc} toUtc={run.endUtc} evidence={telemetry} showTimeline={false} />
      <section className="drawer-section"><h3>Evidence quality</h3><dl className="compact-facts"><div><dt>Radius evidence</dt><dd>{run.dataInterrupted ? 'Interrupted by an explicit unavailable gap' : 'Available for the original Run interval'}</dd></div><div><dt>Run eligibility</dt><dd>{run.eligible ? 'Eligible' : 'Excluded from pattern denominator'}</dd></div><div><dt>Telemetry evidence</dt><dd>Independent, capability-gated, and bounded to at most two hours</dd></div></dl></section>
    </div>
  </EvidenceDrawerShell>
}
