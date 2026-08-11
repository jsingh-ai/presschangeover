import { createPortal } from 'react-dom'
import { useState } from 'react'
import type {
  RadiusAvailability,
  RadiusPressKey,
  RadiusStatusSegment,
} from '../types/api'
import { formatPlantDateTime } from '../time-ranges'
import { segmentDisplayLabel, semanticStyle, type RadiusTimelineView } from '../classification-presentation'

interface OperationalTimelineProps {
  press: {
    pressKey: RadiusPressKey
    displayName: string
    availability: RadiusAvailability
    currentStatusDescription: string | null
    timelineSegments: RadiusStatusSegment[]
    nonProductionSeconds: number
    dataCoveragePercent: number
  }
  fromUtc: string
  toUtc: string
  selected?: boolean
  onSelectPress?(): void
  onSelectSegment?(segment: RadiusStatusSegment): void
  segmentTooltip?(segment: RadiusStatusSegment): TimelineSegmentTooltip
  viewMode?: RadiusTimelineView
}

export interface TimelineSegmentTooltip {
  pressAverageSeconds: number | null
  pressCount: number
  fleetAverageSeconds: number | null
  fleetCount: number
}

interface TooltipPosition {
  key: string
  left: number
  top: number
  placement: 'above' | 'below'
}

function stateClass(segment: RadiusStatusSegment): string {
  if (segment.kind === 'offline') return 'offline'
  if (segment.isProduction) return 'production'
  if (segment.eventType === 'M') return 'make-ready'
  if (segment.eventType === 'B') return 'bad'
  if (segment.eventType === 'S') return 'safety'
  if (segment.eventType === 'G') return 'good-other'
  return 'other'
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`
  const hours = Math.floor(seconds / 3_600)
  const minutes = Math.round((seconds % 3_600) / 60)
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`
}

function segmentTitle(segment: RadiusStatusSegment): string {
  const end = segment.isOpen
    ? 'current'
    : formatPlantDateTime(segment.endUtc)
  if (segment.kind === 'offline') {
    return `Offline / No Radius Data · ${formatPlantDateTime(segment.startUtc)} to ${end} · ${formatDuration(segment.durationSeconds)}`
  }
  return `${segment.statusDescription} (${segment.eventType} / ${segment.statusCode ?? '—'}) · ${formatPlantDateTime(segment.startUtc)} to ${end} · ${formatDuration(segment.durationSeconds)}`
}

export function OperationalTimeline({
  press,
  fromUtc,
  toUtc,
  selected = false,
  onSelectPress,
  segmentTooltip,
  onSelectSegment,
  viewMode = 'operations',
}: OperationalTimelineProps) {
  const [hoveredSegment, setHoveredSegment] = useState<TooltipPosition>()
  const fromMs = Date.parse(fromUtc)
  const rangeMs = Math.max(1, Date.parse(toUtc) - fromMs)
  const selectionHint = `Select ${press.displayName} to focus the workspace.`

  function showTooltip(key: string, target: HTMLElement) {
    const rect = target.getBoundingClientRect()
    const edgeGap = 12
    const tooltipHalfWidth = Math.min(160, Math.max(0, (window.innerWidth - (edgeGap * 2)) / 2))
    const left = Math.min(
      window.innerWidth - edgeGap - tooltipHalfWidth,
      Math.max(edgeGap + tooltipHalfWidth, rect.left + (rect.width / 2)),
    )
    const estimatedTooltipHeight = 160
    const fitsAbove = rect.top - edgeGap >= estimatedTooltipHeight
    const fitsBelow = window.innerHeight - rect.bottom - edgeGap >= estimatedTooltipHeight
    const placement = fitsAbove || !fitsBelow ? 'above' : 'below'
    const top = placement === 'above'
      ? Math.max(edgeGap + estimatedTooltipHeight, rect.top - edgeGap)
      : Math.min(window.innerHeight - edgeGap - estimatedTooltipHeight, rect.bottom + edgeGap)

    setHoveredSegment({ key, left, top, placement })
  }

  function hideTooltip(key: string) {
    setHoveredSegment((current) => current?.key === key ? undefined : current)
  }

  return (
    <div className={`timeline-row ${selected ? 'timeline-row--selected' : ''} ${onSelectPress ? 'timeline-row--interactive' : ''}`} title={selectionHint} onClick={onSelectPress}>
      <button
        className="timeline-label timeline-label-button"
        type="button"
        onClick={(event) => { event.stopPropagation(); onSelectPress?.() }}
        disabled={!onSelectPress}
        title={`Focus analytics on ${press.displayName}`}
      >
        <strong>{press.displayName}</strong>
        <small>
          {press.availability === 'offline'
            ? 'Offline / No Radius Data'
            : press.currentStatusDescription ?? 'No current Radius status'}
        </small>
      </button>
      <span className="timeline-track" aria-label={`${press.displayName} operational timeline`}>
        {press.timelineSegments.map((segment, index) => {
          const left = ((Date.parse(segment.startUtc) - fromMs) / rangeMs) * 100
          const width = Math.max(
            0.15,
            ((Date.parse(segment.endUtc) - Date.parse(segment.startUtc)) /
              rangeMs) *
              100,
          )
          const title = segmentTitle(segment)
          const segmentKey = `${segment.startUtc}-${index}`
          const insight = segmentTooltip?.(segment)
          return (
            <button
              type="button"
              className={`timeline-segment timeline-segment--${stateClass(segment)}`}
              key={segmentKey}
              style={{ left: `${left}%`, width: `${width}%`, ...(viewMode === 'operations' ? semanticStyle(segment) : {}) }}
              data-view={viewMode}
              aria-label={viewMode === 'operations' && segment.kind === 'radius' ? `${segmentDisplayLabel(segment, viewMode)}; raw Radius identity ${segment.eventType} / ${segment.statusCode ?? 'no code'} / ${segment.statusDescription}; ${title}` : title}
              onMouseEnter={(event) => showTooltip(segmentKey, event.currentTarget)}
              onMouseLeave={() => hideTooltip(segmentKey)}
              onFocus={(event) => showTooltip(segmentKey, event.currentTarget)}
              onBlur={() => hideTooltip(segmentKey)}
              onClick={(event) => { event.stopPropagation(); onSelectSegment?.(segment) }}
            >
              {hoveredSegment?.key === segmentKey && insight && createPortal(
                <span
                  className={`timeline-hover-tooltip timeline-hover-tooltip--${hoveredSegment.placement} timeline-hover-tooltip--${stateClass(segment)}`}
                  role="tooltip"
                  style={{ left: `${hoveredSegment.left}px`, top: `${hoveredSegment.top}px` }}
                >
                <strong>{segmentDisplayLabel(segment, viewMode)}</strong>
                {viewMode === 'operations' && segment.kind === 'radius' && <span>Raw Radius · {segment.eventType} / {segment.statusCode ?? '—'} / {segment.statusDescription}</span>}
                <span>{formatPlantDateTime(segment.startUtc)} → {segment.isOpen ? 'Current' : formatPlantDateTime(segment.endUtc)}</span>
                <span>Duration <b>{formatDuration(segment.durationSeconds)}</b></span>
                <span>Press average <b>{insight.pressAverageSeconds === null ? '—' : formatDuration(insight.pressAverageSeconds)}</b> · {insight.pressCount} instance{insight.pressCount === 1 ? '' : 's'}</span>
                <span>Fleet average <b>{insight.fleetAverageSeconds === null ? '—' : formatDuration(insight.fleetAverageSeconds)}</b> · {insight.fleetCount} instance{insight.fleetCount === 1 ? '' : 's'}</span>
                </span>,
                document.body,
              )}
            </button>
          )
        })}
      </span>
      <span className="timeline-metric">
        <strong>{formatDuration(press.nonProductionSeconds)}</strong>
        <small>{press.dataCoveragePercent.toFixed(1)}% coverage</small>
      </span>
    </div>
  )
}
