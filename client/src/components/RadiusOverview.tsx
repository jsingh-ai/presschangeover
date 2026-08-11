import { useState, type ReactNode } from 'react'
import type { RadiusOverview as RadiusOverviewModel, RadiusPressKey, RadiusStatusSegment } from '../types/api'
import { OperationalTimeline, type TimelineSegmentTooltip } from './OperationalTimeline'
import { formatPlantDateTime } from '../time-ranges'
import { visibleFleetPresses } from '../workspace-state'
import type { RadiusTimelineView } from '../classification-presentation'

interface RadiusOverviewProps {
  overview: RadiusOverviewModel
  selectedPress?: RadiusPressKey
  focusedPress?: RadiusPressKey
  focusWorkspace?: ReactNode
  onSelectPress(pressKey: RadiusPressKey): void
  onClearFocus?(): void
  showSummary?: boolean
}

function duration(seconds: number): string {
  const hours = Math.floor(seconds / 3_600)
  const minutes = Math.round((seconds % 3_600) / 60)
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`
}

function sameSegmentState(left: RadiusStatusSegment, right: RadiusStatusSegment): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === 'offline' || right.kind === 'offline') return true
  return left.eventType === right.eventType && left.statusDescription === right.statusDescription
}

function averageDuration(segments: RadiusStatusSegment[]): number | null {
  if (segments.length === 0) return null
  return segments.reduce((total, segment) => total + segment.durationSeconds, 0) / segments.length
}

function segmentTooltip(overview: RadiusOverviewModel, press: RadiusOverviewModel['presses'][number], segment: RadiusStatusSegment): TimelineSegmentTooltip {
  const pressMatches = press.timelineSegments.filter((candidate) => sameSegmentState(candidate, segment))
  const fleetMatches = overview.presses.flatMap((candidate) => candidate.timelineSegments.filter((item) => sameSegmentState(item, segment)))
  return {
    pressAverageSeconds: averageDuration(pressMatches),
    pressCount: pressMatches.length,
    fleetAverageSeconds: averageDuration(fleetMatches),
    fleetCount: fleetMatches.length,
  }
}

const zoomLevels = [1, 1.5, 2, 3, 4] as const

export function RadiusOverview({ overview, selectedPress, focusedPress, focusWorkspace, onSelectPress, onClearFocus, showSummary = true }: RadiusOverviewProps) {
  const expectedPresses = overview.onlinePressCount + overview.offlinePressCount
  const displayedPresses = visibleFleetPresses(overview.presses, focusedPress ?? selectedPress)
  const focusedDisplayName = focusedPress ? overview.presses.find(({ pressKey }) => pressKey === focusedPress)?.displayName ?? focusedPress.replace('press', 'Press ') : undefined
  const [zoomIndex, setZoomIndex] = useState(0)
  const [timelineView, setTimelineView] = useState<RadiusTimelineView>('operations')
  const zoom = zoomLevels[zoomIndex]
  return (
    <>
      {overview.feedStatus === 'OFFLINE' && (
        <section className="feed-banner feed-banner--offline" role="status">
          <strong>{overview.rangeEndIsLive ? 'Radius data feed offline' : 'Radius feed was offline at range end'}</strong>
          <span>
            Last observation: {overview.lastObservationUtc ? formatPlantDateTime(overview.lastObservationUtc) : 'none in the bounded data window'}. Historical information before that time remains available.
          </span>
        </section>
      )}
      {overview.feedStatus === 'DEGRADED' && (
        <section className="feed-banner feed-banner--degraded" role="status">
          <strong>{overview.rangeEndIsLive ? 'Radius data feed degraded' : 'Radius feed was degraded at range end'} — {overview.onlinePressCount} of {expectedPresses} presses reporting</strong>
        </section>
      )}
      {showSummary && <section className="metric-grid" aria-label="Fleet summary">
        <div><span>Presses monitored</span><strong>{overview.summary.pressesMonitored}</strong></div>
        <div><span>{overview.rangeEndIsLive ? 'Run Production now' : 'Run Production at range end'}</span><strong>{overview.summary.currentlyRunProduction}</strong></div>
        <div><span>{overview.rangeEndIsLive ? 'Non-production now' : 'Non-production at range end'}</span><strong>{overview.summary.currentlyNonProduction}</strong></div>
        <div><span>{overview.rangeEndIsLive ? 'Open episodes' : 'Open episodes at range end'}</span><strong>{overview.summary.openEpisodes}</strong></div>
        <div><span>Non-production in range</span><strong>{duration(overview.summary.totalNonProductionSeconds)}</strong></div>
        <div><span>{overview.rangeEndIsLive ? 'Radius feed' : 'Radius feed at range end'}</span><strong>{overview.feedStatus}</strong></div>
      </section>}

      {overview.unmappedPressKeys.length > 0 && (
        <p className="message message--warning">
          Radius mapping is not yet verified for: {overview.unmappedPressKeys.join(', ')}.
        </p>
      )}

      <section className="panel operational-panel" aria-labelledby="timeline-title">
        <div className="press-activity-focus-control" aria-live="polite">
          <span>Activity focus</span>
          {focusedPress ? (
            <button type="button" className="selected-press-chip" onClick={onClearFocus} aria-label={`Clear ${focusedDisplayName} activity focus`}>
              {focusedDisplayName}<span aria-hidden="true">×</span>
            </button>
          ) : <small>Select a press row to isolate its activity and open the investigation below.</small>}
        </div>
        <div className="section-heading">
          <div>
            <p className="eyebrow">Current scope and supporting timeline</p>
            <h2 id="timeline-title">Press activity</h2>
            <p className="section-description">Select a press to keep its context across the workspace. Zoom to inspect shorter intervals, then scroll horizontally; hover a press or segment for details before opening it.</p>
          </div>
          <div className="timeline-header-tools">
            <div className="timeline-view-toggle" role="group" aria-label="Radius timeline presentation"><button type="button" className={timelineView === 'operations' ? 'active' : ''} aria-pressed={timelineView === 'operations'} onClick={() => setTimelineView('operations')}>Operations</button><button type="button" className={timelineView === 'raw' ? 'active' : ''} aria-pressed={timelineView === 'raw'} onClick={() => setTimelineView('raw')}>Raw Radius</button></div>
            <div className="timeline-zoom-controls" role="group" aria-label="Timeline zoom controls">
              <button type="button" aria-label="Zoom out timeline" title="Zoom out timeline" disabled={zoomIndex === 0} onClick={() => setZoomIndex((index) => Math.max(0, index - 1))}>−</button>
              <output aria-live="polite" aria-label="Timeline zoom level">{Math.round(zoom * 100)}%</output>
              <button type="button" aria-label="Zoom in timeline" title="Zoom in timeline" disabled={zoomIndex === zoomLevels.length - 1} onClick={() => setZoomIndex((index) => Math.min(zoomLevels.length - 1, index + 1))}>+</button>
              <button type="button" className="timeline-reset" disabled={zoomIndex === 0} onClick={() => setZoomIndex(0)}>Reset</button>
            </div>
            {timelineView === 'raw' ? <div className="timeline-legend" aria-label="Raw Radius timeline legend">
            <span className="legend-production">Run Production</span>
            <span className="legend-make-ready">Make Ready</span>
            <span className="legend-bad">Bad</span>
            <span className="legend-safety">Safety</span>
            <span className="legend-other">Other</span>
            <span className="legend-offline">Offline / No Radius Data</span>
            </div> : <div className="timeline-legend semantic-legend" aria-label="Operational group legend">{overview.operationalGroups?.map((group) => <span key={group.key} style={{ '--semantic-light': group.lightColor, '--semantic-dark': group.darkColor } as React.CSSProperties}>{group.displayName}</span>)}<span className="legend-offline">Data unavailable</span></div>}
          </div>
        </div>
        {displayedPresses.length === 0 ? (
          <p className="empty-state">No mapped Radius press data exists for this range.</p>
        ) : (
          <div className="timeline-scroll" tabIndex={0} aria-label={`Scrollable press timeline at ${Math.round(zoom * 100)} percent zoom`}>
            <div className="timeline-zoom-canvas" data-zoom={zoom} style={{ width: `${zoom * 100}%` }}>
              <div className="timeline-axis" aria-hidden="true">
                <span>Selected period</span>
                <div><time>{formatPlantDateTime(overview.fromUtc)}</time><time>{formatPlantDateTime(overview.toUtc)}</time></div>
                <span>{zoom.toFixed(1)}×</span>
              </div>
              <div className="timeline-list">
                {displayedPresses.map((press) => (
                  <OperationalTimeline
                    key={press.pressKey}
                    press={press}
                    fromUtc={overview.fromUtc}
                    toUtc={overview.toUtc}
                    selected={selectedPress === press.pressKey || focusedPress === press.pressKey}
                    onSelectPress={() => onSelectPress(press.pressKey)}
                    segmentTooltip={(segment) => segmentTooltip(overview, press, segment)}
                    viewMode={timelineView}
                  />
                ))}
              </div>
            </div>
          </div>
        )}
      </section>
      {focusWorkspace ?? (
        <section className="panel focused-investigation-empty" aria-labelledby="focused-investigation-empty-title">
          <p className="eyebrow">Focused press investigation</p>
          <h2 id="focused-investigation-empty-title">Pick a press to get more details</h2>
          <p>Select a press in Press activity to isolate its Gantt and review its complete production, offline, and recovery history.</p>
        </section>
      )}
    </>
  )
}
