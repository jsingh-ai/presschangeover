import { createPortal } from 'react-dom'
import { useEffect, useMemo, useState } from 'react'
import { formatDuration } from '../episode-presentation'
import { formatPlantDateTime } from '../time-ranges'
import type { OperationalRun, OperationalRunComparison, OperationalRunSegment, OperationalRunStatusSummary, RadiusOverview, RadiusPressKey, RadiusStatusSegment } from '../types/api'
import { PressFilterBar } from './PressFilterBar'
import { PressStateTimeline } from './PressStateTimeline'

interface RunTooltipPosition {
  type: 'run' | 'segment'
  runId: string
  segmentId?: string
  left: number
  top: number
  placement: 'above' | 'below'
}

function signedDuration(seconds: number | null): string {
  if (seconds === null) return '—'
  return `${seconds > 0 ? '+' : seconds < 0 ? '−' : ''}${formatDuration(Math.abs(seconds))}`
}

function signedPercent(value: number | null): string {
  if (value === null) return '—'
  return `${value > 0 ? '+' : ''}${Math.round(value)}%`
}

function ordinal(value: number | null): string {
  if (value === null) return '—'
  const suffix = value % 100 >= 11 && value % 100 <= 13 ? 'th' : value % 10 === 1 ? 'st' : value % 10 === 2 ? 'nd' : value % 10 === 3 ? 'rd' : 'th'
  return `${value}${suffix}`
}

function sequenceLabel(identity: string): string {
  return identity.split('\u001f')[2] || 'Unclassified Radius state'
}

function segmentTone(eventType: string | null, unavailable: boolean): string {
  if (unavailable) return 'unavailable'
  if (eventType === 'G') return 'good'
  if (eventType === 'M') return 'make-ready'
  if (eventType === 'B') return 'bad'
  if (eventType === 'S') return 'safety'
  return 'other'
}

function comparisonCopy(run: OperationalRun): { symbol: string; label: string } {
  const direction = run.timeToProductionBenchmark.direction
  if (direction === 'slower') return { symbol: '↑', label: 'Slower to production' }
  if (direction === 'faster') return { symbol: '↓', label: 'Faster to production' }
  if (direction === 'typical') return { symbol: '≈', label: 'Typical' }
  return { symbol: '·', label: 'Low support' }
}

function runStartLabel(run: OperationalRun, comparison: OperationalRunComparison): string {
  if (run.isPartial && Date.parse(run.startUtc) <= Date.parse(comparison.fromUtc) + 1_000) return `Before selected period · visible from ${formatPlantDateTime(run.startUtc)} CT`
  return `${formatPlantDateTime(run.startUtc)} CT`
}

function runEndLabel(run: OperationalRun, comparison: OperationalRunComparison): string {
  if (run.isPartial && Date.parse(run.endUtc) >= Date.parse(comparison.toUtc) - 1_000) return `Ongoing / Partial · visible through ${formatPlantDateTime(run.endUtc)} CT`
  return `${formatPlantDateTime(run.endUtc)} CT`
}

function runTooltipLabel(run: OperationalRun, comparison: OperationalRunComparison): string {
  return `Run ${run.sequenceNumber}. Start ${runStartLabel(run, comparison)}. End ${runEndLabel(run, comparison)}. Total duration ${formatDuration(run.totalDurationSeconds)}. Time to sustained production ${run.timeToProductionSeconds === null ? 'Not reached' : formatDuration(run.timeToProductionSeconds)}. Sustained production duration ${formatDuration(run.productionDurationSeconds)}. Short Run attempts ${run.shortRunAttemptCount}. State transitions ${run.transitionCount}.`
}

function segmentInterpretation(segment: OperationalRunSegment, confirmationSeconds: number): string {
  if (segment.isUnavailable) return 'Radius observations unavailable; prior state not carried forward'
  if (segment.isShortRunAttempt) return `Short Run attempt · did not satisfy the ${formatDuration(confirmationSeconds)} sustained-production threshold`
  if (segment.phase === 'production') return 'Confirmed sustained production'
  return 'Pre-production state'
}

function segmentTooltipLabel(segment: OperationalRunSegment, run: OperationalRun, comparison: OperationalRunComparison): string {
  const benchmark = segment.exactIdentity ? run.statusSummaries.find(({ exactIdentity }) => exactIdentity === segment.exactIdentity)?.samePress : undefined
  const benchmarkCopy = benchmark?.sufficientSupport && benchmark.median !== null ? ` Press typical ${formatDuration(benchmark.median)}. ${signedDuration(segment.durationSeconds - benchmark.median)} ${segment.durationSeconds >= benchmark.median ? 'longer' : 'shorter'} than typical.` : ''
  return `${segment.statusDescription ?? 'Data unavailable'}. ${segment.eventType ?? 'Unavailable'} / ${segment.statusCode ?? '—'}. Start ${formatPlantDateTime(segment.startUtc)} CT. End ${formatPlantDateTime(segment.endUtc)} CT. Duration ${formatDuration(segment.durationSeconds)}. ${segmentInterpretation(segment, comparison.confirmationSeconds)}.${benchmarkCopy}`
}

function StatusBenchmark({ status, selectedSegment }: { status: OperationalRunStatusSummary; selectedSegment?: OperationalRunSegment }) {
  const same = status.samePress
  const fleet = status.fleet
  return <section className="run-status-benchmark" aria-labelledby="selected-run-status-title">
    <div className="run-detail-heading"><div><p className="eyebrow">Selected exact Radius status</p><h3 id="selected-run-status-title">{status.statusDescription}</h3><p>{status.eventType} / {status.statusCode ?? '—'}</p></div><span className={`run-comparison-chip run-comparison-chip--${same.direction}`}>{same.direction === 'low_support' ? 'Low support' : `${same.direction[0]!.toUpperCase()}${same.direction.slice(1)} than typical`}</span></div>
    {selectedSegment && <p className="run-selected-span">Selected span: <strong>{formatPlantDateTime(selectedSegment.startUtc)} – {formatPlantDateTime(selectedSegment.endUtc)} CT</strong> · {formatDuration(selectedSegment.durationSeconds)}{selectedSegment.isShortRunAttempt ? ' · Short Run attempt' : ''}</p>}
    <div className="run-benchmark-columns">
      <dl><h4>This Run</h4><div><dt>Total duration</dt><dd>{formatDuration(status.totalDurationSeconds)}</dd></div><div><dt>Occurrences</dt><dd>{status.occurrenceCount}</dd></div><div><dt>Pre-production share</dt><dd>{status.preProductionContributionPercent === null ? 'Not applicable' : `${status.preProductionContributionPercent.toFixed(1)}%`}</dd></div></dl>
      <dl><h4>Same press</h4><div><dt>Typical / median</dt><dd>{same.median === null ? '—' : formatDuration(same.median)}</dd></div><div><dt>Average</dt><dd>{same.average === null ? '—' : formatDuration(same.average)}</dd></div><div><dt>Difference</dt><dd>{signedDuration(same.delta)} · {signedPercent(same.percentDelta)}</dd></div><div><dt>Percentile</dt><dd>{same.sufficientSupport ? ordinal(same.percentile) : 'Low support'}</dd></div><div><dt>Appears in</dt><dd>{same.containingRuns}/{same.eligibleRuns} Runs{same.occurrenceFrequencyPercent === null ? '' : ` · ${same.occurrenceFrequencyPercent.toFixed(0)}%`}</dd></div><div><dt>Typical entries</dt><dd>{same.typicalOccurrenceCount?.toFixed(1) ?? '—'}</dd></div></dl>
      <dl><h4>Other presses</h4><div><dt>Typical / median</dt><dd>{fleet.median === null ? '—' : formatDuration(fleet.median)}</dd></div><div><dt>Average</dt><dd>{fleet.average === null ? '—' : formatDuration(fleet.average)}</dd></div><div><dt>Difference</dt><dd>{signedDuration(fleet.delta)} · {signedPercent(fleet.percentDelta)}</dd></div><div><dt>Support</dt><dd>{fleet.sufficientSupport ? `${fleet.sampleRuns} Runs · ${fleet.samplePresses} presses` : `Low support · ${fleet.sampleRuns} Runs / ${fleet.samplePresses} presses`}</dd></div></dl>
    </div>
    <p className="run-method-note">Compares this exact event type, status code, and description with the same identity in other eligible Runs.</p>
  </section>
}

export function RunComparison({ selectedPress, comparison, overview, onSelectPress, onInspectSegment, onInspectOverviewSegment, showIndividualRuns = true }: {
  selectedPress?: RadiusPressKey
  comparison?: OperationalRunComparison
  overview?: RadiusOverview
  onSelectPress?(pressKey: RadiusPressKey | undefined): void
  onInspectSegment(segment: OperationalRunSegment): void
  onInspectOverviewSegment?(pressKey: RadiusPressKey, segment: RadiusStatusSegment): void
  showIndividualRuns?: boolean
}) {
  const [selectedRunId, setSelectedRunId] = useState<string>()
  const [selectedStatusIdentity, setSelectedStatusIdentity] = useState<string>()
  const [selectedSegmentId, setSelectedSegmentId] = useState<string>()
  const [hoveredItem, setHoveredItem] = useState<RunTooltipPosition>()

  useEffect(() => {
    setSelectedRunId(comparison?.runs[0]?.runId)
    setSelectedStatusIdentity(undefined)
    setSelectedSegmentId(undefined)
  }, [comparison?.pressKey, comparison?.fromUtc, comparison?.toUtc])

  const selectedRun = comparison?.runs.find(({ runId }) => runId === selectedRunId) ?? comparison?.runs[0]
  const selectedStatus = selectedRun?.statusSummaries.find(({ exactIdentity }) => exactIdentity === selectedStatusIdentity)
  const selectedSegment = selectedRun?.segments.find(({ segmentId }) => segmentId === selectedSegmentId)
  const tooltipRun = comparison?.runs.find(({ runId }) => runId === hoveredItem?.runId)
  const tooltipSegment = tooltipRun?.segments.find(({ segmentId }) => segmentId === hoveredItem?.segmentId)
  const maxRunDuration = useMemo(() => Math.max(1, ...(comparison?.runs.map(({ totalDurationSeconds }) => totalDurationSeconds) ?? [1])), [comparison])

  function selectRun(run: OperationalRun) {
    setSelectedRunId(run.runId)
    setSelectedStatusIdentity(undefined)
    setSelectedSegmentId(undefined)
  }

  function selectStatus(identity: string, segmentIds: string[] = []) {
    setSelectedStatusIdentity(identity)
    setSelectedSegmentId(segmentIds[0])
  }

  function showTooltip(type: RunTooltipPosition['type'], runId: string, target: HTMLElement, segmentId?: string) {
    const rect = target.getBoundingClientRect()
    const edgeGap = 12
    const halfWidth = Math.min(180, Math.max(0, (window.innerWidth - edgeGap * 2) / 2))
    const left = Math.min(window.innerWidth - edgeGap - halfWidth, Math.max(edgeGap + halfWidth, rect.left + rect.width / 2))
    const placement = rect.top > 280 ? 'above' : 'below'
    setHoveredItem({ type, runId, segmentId, left, top: placement === 'above' ? rect.top - edgeGap : rect.bottom + edgeGap, placement })
  }

  function hideTooltip(type: RunTooltipPosition['type'], runId: string, segmentId?: string) {
    setHoveredItem((current) => current?.type === type && current.runId === runId && current.segmentId === segmentId ? undefined : current)
  }

  const pressSelector = overview && onSelectPress ? <div className="run-press-selector">
    <div><p className="eyebrow">Press selection</p><strong>{showIndividualRuns ? 'Choose a press for Run Comparison' : 'Choose a press for Press history'}</strong><small>Synced with the global Press Selection above.</small></div>
    <PressFilterBar presses={overview.presses} selectedPress={selectedPress} onSelect={onSelectPress} onClear={() => onSelectPress(undefined)} />
  </div> : null

  if (!selectedPress) return <section className="panel run-comparison run-comparison--empty" aria-labelledby="run-comparison-title">{pressSelector}<div className="section-heading"><div><p className="eyebrow">{showIndividualRuns ? 'Relative operating Runs' : 'Selected press chronology'}</p><h2 id="run-comparison-title">{showIndividualRuns ? 'Run comparison' : 'Press history'}</h2></div></div><div className="run-empty-state"><span aria-hidden="true">↔</span><h3>{showIndividualRuns ? 'Select a press to compare individual operating Runs' : 'Select a press to review its complete Radius history'}</h3><p>{showIndividualRuns ? 'Run segmentation is press-specific so setup, short production attempts, and sustained production can be compared consistently.' : 'The global and local Press Selection controls remain synchronized.'}</p></div></section>
  if (!comparison) return <section className="panel run-comparison" aria-labelledby="run-comparison-title">{pressSelector}<div className="section-heading"><div><p className="eyebrow">Selected press chronology</p><h2 id="run-comparison-title">Press history</h2></div></div>{overview && <PressStateTimeline overview={overview} selectedPress={selectedPress} onInspectSegment={onInspectOverviewSegment} embedded />}{showIndividualRuns && <p className="empty-state">Loading press-specific Run comparison…</p>}</section>

  return <section className="panel run-comparison" aria-labelledby="run-comparison-title">
    {pressSelector}
    <div className="section-heading"><div><p className="eyebrow">{showIndividualRuns ? `${comparison.displayName} · elapsed-time comparison` : `${comparison.displayName} · selected-period chronology`}</p><h2 id="run-comparison-title">{showIndividualRuns ? 'Run comparison' : 'Press history'}</h2><p className="section-description">{showIndividualRuns ? 'Compares press operating Runs from the start of a non-production sequence through sustained production. Runs are aligned by elapsed time so differences are easier to spot.' : 'Review the complete Radius state history for this press. The focused press investigation and compact Run context are available on Overview.'}</p></div>{showIndividualRuns && <p className="section-note">Typical = same-press median · selected Run excluded</p>}</div>
    {overview && <PressStateTimeline overview={overview} selectedPress={selectedPress} onInspectSegment={onInspectOverviewSegment} embedded />}
    {showIndividualRuns && (comparison.runs.length === 0 ? <div className="run-empty-state"><span aria-hidden="true">∅</span><h3>No comparable operating Runs in this period</h3><p>Try a wider selected period while keeping {comparison.displayName} selected.</p></div> : <>
      <div className="run-subsection-heading"><p className="eyebrow">Individual Runs</p><h2>Run breakdowns</h2><p>Breaks the same press history into complete operating Runs. Every bar uses the common elapsed-time scale below and includes the full sustained Good / Run Production period.</p><span>Longest visible Run = full scale · shorter Runs remain proportionally shorter</span></div>
      <div className="run-row-header" aria-hidden="true"><span>Run and timing</span><span>Full Run · common elapsed-time scale</span><span>Production duration</span></div>
      <div className="run-list">{comparison.runs.map((run) => {
        const copy = comparisonCopy(run)
        const delta = run.timeToProductionBenchmark.samePress.delta
        const productionBenchmark = run.productionDurationBenchmark.samePress
        return <article key={run.runId} className={`run-row${selectedRun?.runId === run.runId ? ' selected' : ''}`} onClick={() => selectRun(run)}>
          <button type="button" className="run-row-summary" onClick={() => selectRun(run)} aria-pressed={selectedRun?.runId === run.runId} aria-label={runTooltipLabel(run, comparison)} onMouseEnter={(event) => showTooltip('run', run.runId, event.currentTarget)} onMouseLeave={() => hideTooltip('run', run.runId)} onFocus={(event) => showTooltip('run', run.runId, event.currentTarget)} onBlur={() => hideTooltip('run', run.runId)}>
            <strong>Run {run.sequenceNumber}</strong><small>{runStartLabel(run, comparison)} → {runEndLabel(run, comparison)}</small><b>{formatDuration(run.totalDurationSeconds)} total</b><span className="run-time-to-production">{run.timeToProductionSeconds === null ? 'No sustained return' : `${formatDuration(run.timeToProductionSeconds)} to production`}</span><span className={`run-primary-indicator run-primary-indicator--${run.timeToProductionBenchmark.direction}`}>{copy.symbol} {copy.label}</span>{delta !== null && <em>{signedDuration(delta)} vs {comparison.displayName} typical</em>}
          </button>
          <div className="run-relative-track" role="group" aria-label={`Run ${run.sequenceNumber} complete chronological sequence`}>
            <div className="run-relative-scale" data-run-width-percent={(run.totalDurationSeconds / maxRunDuration * 100).toFixed(2)}>{run.segments.map((segment) => <button key={segment.segmentId} type="button" className={`run-relative-segment run-relative-segment--${segmentTone(segment.eventType, segment.isUnavailable)}${segment.phase === 'production' ? ' run-relative-segment--production' : ''}${segment.isShortRunAttempt ? ' run-relative-segment--short' : ''}${selectedSegmentId === segment.segmentId ? ' selected' : ''}`} style={{ width: `${segment.durationSeconds / maxRunDuration * 100}%` }} aria-label={segmentTooltipLabel(segment, run, comparison)} onClick={(event) => { event.stopPropagation(); selectRun(run); setSelectedSegmentId(segment.segmentId); if (segment.exactIdentity) setSelectedStatusIdentity(segment.exactIdentity) }} onMouseEnter={(event) => showTooltip('segment', run.runId, event.currentTarget, segment.segmentId)} onMouseLeave={() => hideTooltip('segment', run.runId, segment.segmentId)} onFocus={(event) => showTooltip('segment', run.runId, event.currentTarget, segment.segmentId)} onBlur={() => hideTooltip('segment', run.runId, segment.segmentId)}>{segment.durationSeconds / maxRunDuration > .12 ? segment.statusDescription : ''}</button>)}</div>
            <div className="run-flags">{run.flags.slice(0, 3).map((flag) => <span key={flag}>{flag}</span>)}</div>
          </div>
          <button type="button" className="run-production-summary" onClick={() => selectRun(run)}><span>Production duration</span><strong>{formatDuration(run.productionDurationSeconds)}</strong>{productionBenchmark.sufficientSupport && productionBenchmark.median !== null ? <small>{comparison.displayName} typical {formatDuration(productionBenchmark.median)} · {signedDuration(productionBenchmark.delta)} {run.productionDurationBenchmark.direction === 'longer' ? 'longer Good period' : run.productionDurationBenchmark.direction === 'shorter' ? 'shorter Good period' : 'typical Good period'}</small> : run.rank.productionDuration && <small>#{run.rank.productionDuration} longest of {run.rank.comparableRuns}</small>}</button>
        </article>
      })}</div>

      {selectedRun && <div className="selected-run-analysis" aria-live="polite">
        <div className="selected-run-heading"><div><p className="eyebrow">Selected Run</p><h3>Run {selectedRun.sequenceNumber}</h3><p>{formatPlantDateTime(selectedRun.startUtc)} → {formatPlantDateTime(selectedRun.endUtc)} CT</p></div><div className="selected-run-flags">{selectedRun.flags.slice(0, 5).map((flag) => <span key={flag}>{flag}</span>)}</div></div>
        <dl className="selected-run-metrics"><div><dt>Time to production</dt><dd>{selectedRun.timeToProductionSeconds === null ? 'Not reached' : formatDuration(selectedRun.timeToProductionSeconds)}</dd></div><div><dt>{comparison.displayName} typical</dt><dd>{selectedRun.timeToProductionBenchmark.samePress.median === null ? 'Not enough comparable Runs' : formatDuration(selectedRun.timeToProductionBenchmark.samePress.median)}</dd></div><div><dt>Difference</dt><dd>{signedDuration(selectedRun.timeToProductionBenchmark.samePress.delta)} · {signedPercent(selectedRun.timeToProductionBenchmark.samePress.percentDelta)}</dd></div><div><dt>Percentile</dt><dd>{selectedRun.timeToProductionBenchmark.samePress.sufficientSupport ? ordinal(selectedRun.timeToProductionBenchmark.samePress.percentile) : 'Low support'}</dd></div><div className="selected-production-metric"><dt>Production duration</dt><dd>{formatDuration(selectedRun.productionDurationSeconds)}{selectedRun.productionDurationBenchmark.samePress.sufficientSupport && selectedRun.productionDurationBenchmark.samePress.median !== null && <small>{comparison.displayName} typical {formatDuration(selectedRun.productionDurationBenchmark.samePress.median)} · {signedDuration(selectedRun.productionDurationBenchmark.samePress.delta)} {selectedRun.productionDurationBenchmark.direction === 'longer' ? 'longer production period' : selectedRun.productionDurationBenchmark.direction === 'shorter' ? 'shorter production period' : 'typical production period'}</small>}</dd></div><div><dt>Transitions</dt><dd>{selectedRun.transitionCount}</dd></div><div><dt>Short attempts</dt><dd>{selectedRun.shortRunAttemptCount} · {formatDuration(selectedRun.shortRunAttemptDurationSeconds)}</dd></div><div><dt>Period rank</dt><dd>{selectedRun.rank.timeToProduction ? `#${selectedRun.rank.timeToProduction} slowest of ${selectedRun.rank.comparableRuns}` : 'Not ranked'}</dd></div></dl>

        <div className="run-decision-grid">
          <section className="run-contributors"><div className="run-detail-heading"><div><p className="eyebrow">Duration contributors</p><h3>What made this Run different?</h3><p>Shows where this Run spent more or less pre-production time than comparable Runs on the same press.</p></div></div>{selectedRun.contributors.length ? <div>{selectedRun.contributors.slice(0, 8).map((contributor) => <button type="button" key={contributor.exactIdentity} onClick={() => selectStatus(contributor.exactIdentity, contributor.segmentIds)}><span>{contributor.statusDescription}</span><strong className={contributor.excessSeconds >= 0 ? 'positive' : 'negative'}>{signedDuration(contributor.excessSeconds)}</strong></button>)}</div> : <p className="empty-state">Not enough supported exact-status history to decompose this Run.</p>}<p className="run-method-note">Short Run attempts remain part of exact G / Run Production time and are not added twice.</p></section>
          <section className="run-sequence-comparison"><div className="run-detail-heading"><div><p className="eyebrow">Deterministic sequence</p><h3>{selectedRun.sequenceComparison.variation ? 'Sequence variation' : 'Sequence comparison'}</h3></div></div><div><span>Common {comparison.displayName} sequence</span><p>{selectedRun.sequenceComparison.sufficientSupport ? selectedRun.sequenceComparison.commonSequence.map(sequenceLabel).join(' → ') : 'Not enough comparable Runs'}</p></div><div><span>This Run</span><p>{selectedRun.sequenceComparison.runSequence.map(sequenceLabel).join(' → ') || 'No complete observed sequence'}</p></div></section>
        </div>

        <section className="run-status-list"><div className="run-detail-heading"><div><p className="eyebrow">Run-level totals</p><h3>Exact status breakdown</h3></div></div><div>{selectedRun.statusSummaries.map((status) => <button type="button" key={status.exactIdentity} className={selectedStatus?.exactIdentity === status.exactIdentity ? 'selected' : ''} onClick={() => selectStatus(status.exactIdentity, selectedRun.segments.filter(({ exactIdentity }) => exactIdentity === status.exactIdentity).map(({ segmentId }) => segmentId))}><span><strong>{status.statusDescription}</strong><small>{status.eventType} / {status.statusCode ?? '—'} · {status.occurrenceCount} occurrence{status.occurrenceCount === 1 ? '' : 's'}</small></span><b>{formatDuration(status.totalDurationSeconds)}</b><em>{status.samePress.direction === 'low_support' ? 'Low support' : `${status.samePress.direction} than typical`}</em></button>)}</div></section>

        {selectedStatus && <StatusBenchmark status={selectedStatus} selectedSegment={selectedSegment} />}

        <section className="run-detailed-sequence"><div className="run-detail-heading"><div><p className="eyebrow">Chronological evidence</p><h3>Detailed state sequence</h3></div></div><ol>{selectedRun.segments.map((segment) => <li key={segment.segmentId} className={selectedSegmentId === segment.segmentId ? 'selected' : ''}><button type="button" onClick={() => { setSelectedSegmentId(segment.segmentId); if (segment.exactIdentity) setSelectedStatusIdentity(segment.exactIdentity) }}><span className={`category-dot category-dot--${segmentTone(segment.eventType, segment.isUnavailable)}`} /><span><strong>{segment.statusDescription ?? 'Data unavailable'}</strong><small>{formatPlantDateTime(segment.startUtc)} → {formatPlantDateTime(segment.endUtc)} CT · {segment.eventType ?? '—'} / {segment.statusCode ?? '—'}</small></span><b>{formatDuration(segment.durationSeconds)}</b>{segment.isShortRunAttempt && <em>Short attempt</em>}</button><button type="button" className="run-evidence-action" onClick={() => onInspectSegment(segment)}>Evidence</button></li>)}</ol></section>
      </div>}
    </>)}
    {hoveredItem && tooltipRun && typeof document !== 'undefined' && createPortal(<div className={`run-hover-tooltip run-hover-tooltip--${hoveredItem.placement} run-hover-tooltip--${hoveredItem.type}`} role="tooltip" style={{ left: `${hoveredItem.left}px`, top: `${hoveredItem.top}px` }}>
      {hoveredItem.type === 'run' ? <><strong>Run {tooltipRun.sequenceNumber}</strong><dl><div><dt>Start</dt><dd>{runStartLabel(tooltipRun, comparison)}</dd></div><div><dt>End</dt><dd>{runEndLabel(tooltipRun, comparison)}</dd></div><div><dt>Total duration</dt><dd>{formatDuration(tooltipRun.totalDurationSeconds)}</dd></div><div><dt>Time to sustained production</dt><dd>{tooltipRun.timeToProductionSeconds === null ? 'Not reached' : formatDuration(tooltipRun.timeToProductionSeconds)}</dd></div><div><dt>Sustained production duration</dt><dd>{formatDuration(tooltipRun.productionDurationSeconds)}</dd></div><div><dt>Short Run attempts</dt><dd>{tooltipRun.shortRunAttemptCount}</dd></div><div><dt>State transitions</dt><dd>{tooltipRun.transitionCount}</dd></div></dl></> : tooltipSegment && <><strong>{tooltipSegment.statusDescription ?? 'Data unavailable'}</strong><span>{tooltipSegment.eventType ?? 'Unavailable'} / {tooltipSegment.statusCode ?? '—'}</span><dl><div><dt>Start</dt><dd>{formatPlantDateTime(tooltipSegment.startUtc)} CT</dd></div><div><dt>End</dt><dd>{formatPlantDateTime(tooltipSegment.endUtc)} CT</dd></div><div><dt>Duration</dt><dd>{formatDuration(tooltipSegment.durationSeconds)}</dd></div></dl><p>{segmentInterpretation(tooltipSegment, comparison.confirmationSeconds)}</p>{tooltipSegment.exactIdentity && (() => { const benchmark = tooltipRun.statusSummaries.find(({ exactIdentity }) => exactIdentity === tooltipSegment.exactIdentity)?.samePress; return benchmark?.sufficientSupport && benchmark.median !== null ? <p><span>{comparison.displayName} typical</span> <b>{formatDuration(benchmark.median)}</b><br />{signedDuration(tooltipSegment.durationSeconds - benchmark.median)} {tooltipSegment.durationSeconds >= benchmark.median ? 'longer' : 'shorter'} than typical</p> : null })()}</>}
    </div>, document.body)}
  </section>
}
