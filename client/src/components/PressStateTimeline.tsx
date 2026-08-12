import { createPortal } from 'react-dom'
import { useEffect, useMemo, useState } from 'react'
import { formatDuration } from '../episode-presentation'
import { formatPlantDateTime } from '../time-ranges'
import type {
  RadiusOverview,
  RadiusPressKey,
  RadiusStatusSegment,
} from '../types/api'
import { segmentDisplayLabel, semanticStyle, type RadiusTimelineView } from '../classification-presentation'

interface Props {
  overview: RadiusOverview
  selectedPress?: RadiusPressKey
  onInspectSegment?(pressKey: RadiusPressKey, segment: RadiusStatusSegment): void
  embedded?: boolean
}

interface TooltipPosition {
  key: string
  left: number
  top: number
  placement: 'above' | 'below'
}

function segmentClass(segment: RadiusStatusSegment): string {
  if (segment.kind === 'offline') return 'offline'
  if (segment.isProduction) return 'production'
  if (segment.eventType === 'M') return 'make-ready'
  if (segment.eventType === 'B') return 'bad'
  if (segment.eventType === 'S') return 'safety'
  if (segment.eventType === 'G') return 'good-other'
  return 'other'
}

function categoryLabel(eventType: string | null): string {
  if (eventType === 'G') return 'Good'
  if (eventType === 'M') return 'Make Ready'
  if (eventType === 'B') return 'Bad'
  if (eventType === 'S') return 'Radius S state'
  return eventType || 'Unavailable'
}

function runNote(segment: RadiusStatusSegment, thresholdSeconds: number): string | undefined {
  if (segment.kind !== 'radius') return undefined
  const qualification = segment.stateBreakdownRunQualification
  if (qualification?.state === 'short') return 'Short return attempt'
  if (qualification?.state === 'pending') return 'Sustained-return confirmation unresolved'
  if (qualification?.state === 'sustained') return `Sustained return · ${formatDuration(thresholdSeconds)} threshold satisfied`
  return undefined
}

function segmentName(segment: RadiusStatusSegment): string {
  return segment.kind === 'offline' ? 'Data unavailable' : segment.statusDescription
}

function segmentKey(segment: RadiusStatusSegment, index: number): string {
  return `${segment.startUtc}-${segment.endUtc}-${index}`
}

export function PressStateTimeline({ overview, selectedPress, onInspectSegment, embedded = false }: Props) {
  const [localPress, setLocalPress] = useState<RadiusPressKey>(() => selectedPress ?? overview.presses[0]?.pressKey ?? 'press3')
  const [selectedSegmentKey, setSelectedSegmentKey] = useState<string>()
  const [hoveredSegment, setHoveredSegment] = useState<TooltipPosition>()
  const [timelineView, setTimelineView] = useState<RadiusTimelineView>('operations')
  const activePressKey = selectedPress ?? localPress
  const press = overview.presses.find(({ pressKey }) => pressKey === activePressKey) ?? overview.presses[0]
  const threshold = overview.stateBreakdownRunConfirmationSeconds
  const fromMs = Date.parse(overview.fromUtc)
  const rangeMs = Math.max(1, Date.parse(overview.toUtc) - fromMs)
  const ticks = useMemo(() => Array.from({ length: 5 }, (_, index) => new Date(fromMs + rangeMs * index / 4).toISOString()), [fromMs, rangeMs])
  const selectedSegment = press?.timelineSegments.find((segment, index) => segmentKey(segment, index) === selectedSegmentKey)

  useEffect(() => {
    setSelectedSegmentKey(undefined)
    setHoveredSegment(undefined)
  }, [activePressKey, overview.fromUtc, overview.toUtc])

  function showTooltip(key: string, target: HTMLElement) {
    const rect = target.getBoundingClientRect()
    const edgeGap = 12
    const halfWidth = Math.min(170, Math.max(0, (window.innerWidth - edgeGap * 2) / 2))
    const left = Math.min(window.innerWidth - edgeGap - halfWidth, Math.max(edgeGap + halfWidth, rect.left + rect.width / 2))
    const placement = rect.top > 190 ? 'above' : 'below'
    const top = placement === 'above' ? rect.top - edgeGap : rect.bottom + edgeGap
    setHoveredSegment({ key, left, top, placement })
  }

  function hideTooltip(key: string) {
    setHoveredSegment((current) => current?.key === key ? undefined : current)
  }

  if (!press) {
    return <section className={`${embedded ? 'run-comparison-overview ' : 'panel '}press-state-history`}><div className="section-heading"><div><p className="eyebrow">Press overview</p><h2>Press timeline</h2></div></div><p className="empty-state">No mapped Radius press data is available for this period.</p></section>
  }

  return <section className={`${embedded ? 'run-comparison-overview ' : 'panel '}press-state-history`} aria-labelledby="press-state-timeline-title">
    <div className="section-heading press-state-heading">
      <div>
        <p className="eyebrow">Press overview</p>
        <h2 id="press-state-timeline-title">Press timeline</h2>
        <p className="section-description">{embedded ? 'Shows the complete chronological Radius history for the selected press and period. Exact chronological state details are shown directly below.' : `Shows exact Radius states for one press. Short Run Production attempts remain visible; a sustained ${formatDuration(threshold)} Run confirms return at its original start time.`}</p>
      </div>
      {!selectedPress && <label className="compact-select">Selected press<select value={press.pressKey} onChange={(event) => setLocalPress(event.target.value as RadiusPressKey)}>{overview.presses.map((candidate) => <option key={candidate.pressKey} value={candidate.pressKey}>{candidate.displayName}</option>)}</select></label>}
      <div className="timeline-view-toggle" role="group" aria-label="Press timeline presentation"><button type="button" className={timelineView === 'operations' ? 'active' : ''} aria-pressed={timelineView === 'operations'} onClick={() => setTimelineView('operations')}>Operations</button><button type="button" className={timelineView === 'raw' ? 'active' : ''} aria-pressed={timelineView === 'raw'} onClick={() => setTimelineView('raw')}>Raw Radius</button></div>
    </div>

    <div className="press-state-context">
      <div><span>Press</span><strong>{press.displayName}</strong></div>
      <div><span>Selected period</span><strong>{formatPlantDateTime(overview.fromUtc)} – {formatPlantDateTime(overview.toUtc)} CT</strong></div>
      <div><span>Sustained Run rule</span><strong>At least {formatDuration(threshold)}</strong></div>
    </div>

    {timelineView === 'operations' ? <div className="press-state-legend semantic-legend" aria-label="Operational group legend">{overview.operationalGroups?.map((group) => <span key={group.key} style={{ '--semantic-light': group.lightColor, '--semantic-dark': group.darkColor } as React.CSSProperties}>{group.displayName}</span>)}<span className="legend-offline">Data unavailable</span></div> : <div className="press-state-legend" aria-label="Raw Radius state legend"><span className="legend-production">Run Production</span><span className="legend-make-ready">Make Ready</span><span className="legend-bad">Bad</span><span className="legend-safety">Radius S state</span><span className="legend-other">Other</span><span className="legend-offline">Data unavailable</span><span className="legend-short-run">Short Run attempt</span></div>}

    {press.timelineSegments.length === 0 ? <p className="empty-state">No observed Radius state spans are available for {press.displayName} in this period.</p> : <>
      <div className="press-state-timeline-scroll" tabIndex={0} aria-label={`Scrollable chronological Radius timeline for ${press.displayName}`}>
        <div className="press-state-timeline-canvas">
          <div className="press-state-axis" aria-hidden="true">{ticks.map((tick) => <time key={tick}>{formatPlantDateTime(tick)}</time>)}</div>
          <div className="press-state-track">
            {press.timelineSegments.map((segment, index) => {
              const key = segmentKey(segment, index)
              const left = Math.max(0, (Date.parse(segment.startUtc) - fromMs) / rangeMs * 100)
              const width = Math.max(0, (Date.parse(segment.endUtc) - Date.parse(segment.startUtc)) / rangeMs * 100)
              const note = runNote(segment, threshold)
              const state = segmentClass(segment)
              return <button
                key={key}
                type="button"
                className={`press-state-segment press-state-segment--${state} ${note ? `press-state-segment--run-${segment.kind === 'radius' ? segment.stateBreakdownRunQualification?.state : ''}` : ''} ${selectedSegmentKey === key ? 'selected' : ''}`}
                style={{ left: `${left}%`, width: `${width}%`, ...(timelineView === 'operations' ? semanticStyle(segment) : {}) }}
                data-view={timelineView}
                aria-label={`${segmentDisplayLabel(segment, timelineView)}${timelineView === 'operations' && segment.kind === 'radius' ? `, exact Radius state ${segment.eventType} / ${segment.statusCode ?? 'no code'} / ${segment.statusDescription}` : ''}, ${formatPlantDateTime(segment.startUtc)} to ${formatPlantDateTime(segment.endUtc)}, ${formatDuration(segment.durationSeconds)}${note ? `, ${note}` : ''}`}
                aria-pressed={selectedSegmentKey === key}
                onClick={() => setSelectedSegmentKey(key)}
                onMouseEnter={(event) => showTooltip(key, event.currentTarget)}
                onMouseLeave={() => hideTooltip(key)}
                onFocus={(event) => showTooltip(key, event.currentTarget)}
                onBlur={() => hideTooltip(key)}
              >{width >= 8 ? <span>{segmentDisplayLabel(segment, timelineView)}</span> : null}
                {hoveredSegment?.key === key && createPortal(<span className={`timeline-hover-tooltip timeline-hover-tooltip--${hoveredSegment.placement} timeline-hover-tooltip--${state}`} role="tooltip" style={{ left: `${hoveredSegment.left}px`, top: `${hoveredSegment.top}px` }}><strong>{segmentDisplayLabel(segment, timelineView)}</strong><span>{formatPlantDateTime(segment.startUtc)} → {formatPlantDateTime(segment.endUtc)} CT</span><span>Duration <b>{formatDuration(segment.durationSeconds)}</b></span><span>{segment.kind === 'offline' ? 'Radius observations were unavailable; the prior state was not carried through this interval.' : `Raw Radius · ${segment.eventType} / ${segment.statusCode ?? '—'} / ${segment.statusDescription}`}</span>{segment.kind === 'radius' && timelineView === 'operations' && <span>{segment.classification?.processFamilyName ?? 'Unknown process family'} · {segment.classification?.needsReview ? 'Mapping needs review' : `Published mapping v${segment.classification?.mappingVersion ?? '—'}`}</span>}{note && <span>{note}</span>}</span>, document.body)}
              </button>
            })}
          </div>
        </div>
      </div>

      {selectedSegment && <div className="press-state-selection" aria-live="polite"><div><span>Selected interval</span><strong>{segmentDisplayLabel(selectedSegment, timelineView)}</strong><small>{formatPlantDateTime(selectedSegment.startUtc)} → {formatPlantDateTime(selectedSegment.endUtc)} CT · {formatDuration(selectedSegment.durationSeconds)}</small></div><div><span>Exact Radius identity</span><strong>{selectedSegment.kind === 'offline' ? 'Unavailable' : `${selectedSegment.eventType} / ${selectedSegment.statusCode ?? '—'} / ${selectedSegment.statusDescription}`}</strong><small>{selectedSegment.kind === 'radius' ? selectedSegment.classification?.processFamilyName ?? 'Unknown process family' : 'Machine state unknown'}</small></div>{onInspectSegment && <button type="button" onClick={() => onInspectSegment(press.pressKey, selectedSegment)}>Inspect evidence</button>}</div>}

      <div className="table-wrap press-state-event-list" tabIndex={0} aria-label={`${press.displayName} chronological state detail`}>
        <table className="episode-table">
          <thead><tr><th>Start</th><th>End</th><th>Duration</th><th>Category</th><th>Exact Radius status</th><th>Run interpretation</th></tr></thead>
          <tbody>{press.timelineSegments.map((segment, index) => {
            const key = segmentKey(segment, index)
            const note = runNote(segment, threshold)
            return <tr key={key} className={selectedSegmentKey === key ? 'selected' : ''} onClick={() => setSelectedSegmentKey(key)}><td>{formatPlantDateTime(segment.startUtc)}</td><td>{formatPlantDateTime(segment.endUtc)}</td><td>{formatDuration(segment.durationSeconds)}</td><td>{timelineView === 'operations' ? segmentDisplayLabel(segment, timelineView) : categoryLabel(segment.eventType)}</td><td><button type="button" onClick={() => setSelectedSegmentKey(key)}>{segmentName(segment)}</button>{segment.kind === 'radius' && <small>{segment.eventType} / {segment.statusCode ?? '—'}</small>}</td><td>{note ?? '—'}</td></tr>
          })}</tbody>
        </table>
      </div>
    </>}
    <p className="annotation-disclaimer">Radius states are operator-entered operational evidence. Data-unavailable intervals are shown explicitly and are not forward-filled.</p>
  </section>
}
