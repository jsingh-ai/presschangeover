import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { formatPlantDateTime } from '../time-ranges'
import type { TimedNumericSample } from '../types/evidence'

export type TimelineCoordinateMode = 'absolute' | 'elapsed'

export interface TimelineIntervalItem {
  id: string
  startUtc: string
  endUtc: string
  label: string
  details?: string
  className?: string
  style?: CSSProperties
  unavailable?: boolean
}

export interface TimelineIntervalTrack {
  id: string
  label: string
  intervals: TimelineIntervalItem[]
  unavailableLabel?: string
}

export interface TimelineNumericTrack {
  id: string
  label: string
  samples: TimedNumericSample[]
  unit?: string | null
  unavailableLabel?: string
  connectObservedGaps?: boolean
  interpolation?: 'linear' | 'step'
  holdLastObservation?: boolean
  referenceLines?: Array<{ value: number; label: string }>
  markers?: Array<{ atUtc: string; label: string; kind?: 'start' | 'trigger' | 'extreme' | 'end' | 'baseline' }>
  breakIntervals?: Array<{ fromUtc: string; toUtc: string }>
}

export interface TimelineEvent {
  id: string
  atUtc: string
  label: string
  category: string
  groupKey?: string
  groupLabel?: string
  detail?: string
  deckNumber?: number | null
}

export interface TimelineEventTrack {
  id: string
  label: string
  events: TimelineEvent[]
  unavailableLabel?: string
}

export interface TimelineEventCluster {
  id: string
  positionPercent: number
  events: TimelineEvent[]
}

export interface TimelineEventGroup {
  key: string
  label: string
  events: TimelineEvent[]
}

function defaultEventGroupLabel(category: string): string {
  const words = category.replace(/^context-/, '').replaceAll(/[-_]+/g, ' ')
  return `${words.charAt(0).toUpperCase()}${words.slice(1)} changes`
}

export function groupTimelineEvents(events: TimelineEvent[]): TimelineEventGroup[] {
  const groups = new Map<string, TimelineEventGroup>()
  for (const event of events) {
    const key = event.groupKey ?? event.category
    const group = groups.get(key) ?? { key, label: event.groupLabel ?? defaultEventGroupLabel(event.category), events: [] }
    group.events.push(event)
    groups.set(key, group)
  }
  return [...groups.values()].sort((left, right) => right.events.length - left.events.length || left.label.localeCompare(right.label))
}

export interface SynchronizedTimelineProps {
  fromUtc: string
  toUtc: string
  coordinateMode?: TimelineCoordinateMode
  elapsedOriginUtc?: string
  intervalTracks: TimelineIntervalTrack[]
  numericTracks?: TimelineNumericTrack[]
  eventTracks?: TimelineEventTrack[]
  trackOrder?: string[]
  selectedId?: string
  onSelect?(item: TimelineIntervalItem, track: TimelineIntervalTrack): void
  ariaLabel: string
  minimumCanvasWidth?: number
  highlightedRange?: { fromUtc: string; toUtc: string; label: string }
  onInspectionTimeChange?(atUtc: string): void
  renderInspectionTooltip?(atUtc: string): ReactNode
}

const INSPECTION_TOOLTIP_GAP = 24
const INSPECTION_TOOLTIP_EDGE_MARGIN = 12

export function positionInspectionTooltip(anchor: { x: number; y: number }, tooltip: { width: number; height: number }, viewport: { width: number; height: number }) {
  const right = anchor.x + INSPECTION_TOOLTIP_GAP
  const left = right + tooltip.width <= viewport.width - INSPECTION_TOOLTIP_EDGE_MARGIN ? right : anchor.x - INSPECTION_TOOLTIP_GAP - tooltip.width
  const above = anchor.y - INSPECTION_TOOLTIP_GAP - tooltip.height
  const top = above >= INSPECTION_TOOLTIP_EDGE_MARGIN ? above : anchor.y + INSPECTION_TOOLTIP_GAP
  return {
    left: Math.min(Math.max(INSPECTION_TOOLTIP_EDGE_MARGIN, left), Math.max(INSPECTION_TOOLTIP_EDGE_MARGIN, viewport.width - tooltip.width - INSPECTION_TOOLTIP_EDGE_MARGIN)),
    top: Math.min(Math.max(INSPECTION_TOOLTIP_EDGE_MARGIN, top), Math.max(INSPECTION_TOOLTIP_EDGE_MARGIN, viewport.height - tooltip.height - INSPECTION_TOOLTIP_EDGE_MARGIN)),
  }
}

function ViewportInspectionTooltip({ anchor, children }: { anchor: { x: number; y: number }; children: ReactNode }) {
  const tooltipRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: anchor.x + INSPECTION_TOOLTIP_GAP, top: anchor.y + INSPECTION_TOOLTIP_GAP, ready: false })

  useLayoutEffect(() => {
    const tooltip = tooltipRef.current
    if (!tooltip) return
    const place = () => {
      const bounds = tooltip.getBoundingClientRect()
      const next = positionInspectionTooltip(anchor, bounds, { width: window.innerWidth, height: window.innerHeight })
      setPosition((current) => current.left === next.left && current.top === next.top && current.ready ? current : { ...next, ready: true })
    }
    place()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(place)
    observer?.observe(tooltip)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [anchor])

  return createPortal(<div ref={tooltipRef} className="synchronized-timeline__inspection-tooltip" style={{ left: position.left, top: position.top, visibility: position.ready ? 'visible' : 'hidden' }} role="status" aria-live="polite">{children}</div>, document.body)
}

export function clusterTimelineEvents(events: TimelineEvent[], fromUtc: string, toUtc: string, thresholdPercent = .8): TimelineEventCluster[] {
  const from = Date.parse(fromUtc)
  const span = Math.max(1, Date.parse(toUtc) - from)
  const positioned = events
    .map((event) => ({ event, positionPercent: (Date.parse(event.atUtc) - from) / span * 100 }))
    .filter(({ positionPercent }) => Number.isFinite(positionPercent) && positionPercent >= 0 && positionPercent <= 100)
    .sort((left, right) => left.positionPercent - right.positionPercent || left.event.id.localeCompare(right.event.id))
  const clusters: TimelineEventCluster[] = []
  for (const item of positioned) {
    const previous = clusters.at(-1)
    const previousPosition = previous?.events.at(-1) ? (Date.parse(previous.events.at(-1)!.atUtc) - from) / span * 100 : -Infinity
    if (previous && item.positionPercent - previousPosition <= thresholdPercent) {
      previous.events.push(item.event)
      continue
    }
    clusters.push({ id: `event-cluster:${item.event.id}`, positionPercent: item.positionPercent, events: [item.event] })
  }
  return clusters
}

function overlap(left: TimelineIntervalItem, right: TimelineIntervalItem): boolean {
  return Date.parse(left.startUtc) < Date.parse(right.endUtc) && Date.parse(left.endUtc) > Date.parse(right.startUtc)
}

function timeLabel(value: string, from: number, coordinateMode: TimelineCoordinateMode): string {
  if (coordinateMode === 'absolute') return formatPlantDateTime(value)
  const seconds = Math.max(0, Math.round((Date.parse(value) - from) / 1_000))
  const hours = Math.floor(seconds / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  const remainder = seconds % 60
  return `${hours ? `${hours}h ` : ''}${minutes ? `${minutes}m ` : ''}${remainder}s`
}

export function numericPaths(samples: TimedNumericSample[], from: number, span: number, width: number, height: number, connectObservedGaps = false, interpolation: 'linear' | 'step' = 'linear', holdLastObservation = false, referenceValues: number[] = [], breakIntervals: Array<{ fromUtc: string; toUtc: string }> = []): { paths: string[]; minimum: number; maximum: number } {
  const to = from + span
  const observed = samples.filter(({ observedAtUtc, value }) => Number.isFinite(Date.parse(observedAtUtc)) && Number.isFinite(value) && Date.parse(observedAtUtc) <= to).sort((left, right) => Date.parse(left.observedAtUtc) - Date.parse(right.observedAtUtc))
  const seed = observed.filter(({ observedAtUtc }) => Date.parse(observedAtUtc) <= from).at(-1)
  const visible = [...(seed ? [seed] : []), ...observed.filter(({ observedAtUtc }) => Date.parse(observedAtUtc) > from)]
  const domainValues = [...visible.map(({ value }) => value), ...referenceValues.filter(Number.isFinite)]
  const minimum = domainValues.length ? Math.min(...domainValues) : 0
  const maximum = domainValues.length ? Math.max(...domainValues) : 0
  const valueSpan = Math.max(1, maximum - minimum)
  const medianGap = visible.length > 2 ? [...visible.slice(1).map((item, index) => Date.parse(item.observedAtUtc) - Date.parse(visible[index]!.observedAtUtc))].sort((a, b) => a - b)[Math.floor((visible.length - 1) / 2)] ?? span : span
  const maximumConnectedGap = Math.max(1_000, medianGap * 4)
  const paths: string[] = []
  let current: string[] = []
  visible.forEach((sample, index) => {
    const timestamp = Date.parse(sample.observedAtUtc)
    const previous = visible[index - 1]
    const crossesExplicitBreak = previous && breakIntervals.some((interval) => Date.parse(interval.fromUtc) < timestamp && Date.parse(interval.toUtc) > Date.parse(previous.observedAtUtc))
    if (previous && (crossesExplicitBreak || !connectObservedGaps && timestamp - Date.parse(previous.observedAtUtc) > maximumConnectedGap)) {
      if (current.length) paths.push(current.join(' '))
      current = []
    }
    const x = Math.max(0, (timestamp - from) / span * width)
    const y = height - 6 - (sample.value - minimum) / valueSpan * (height - 12)
    if (current.length && interpolation === 'step' && previous) {
      const previousY = height - 6 - (previous.value - minimum) / valueSpan * (height - 12)
      current.push(`L ${x.toFixed(2)} ${previousY.toFixed(2)}`)
    }
    current.push(`${current.length ? 'L' : 'M'} ${x.toFixed(2)} ${y.toFixed(2)}`)
  })
  if (holdLastObservation && current.length && visible.length) {
    const final = visible.at(-1)!
    const finalY = height - 6 - (final.value - minimum) / valueSpan * (height - 12)
    current.push(`L ${width.toFixed(2)} ${finalY.toFixed(2)}`)
  }
  if (current.length) paths.push(current.join(' '))
  return { paths, minimum, maximum }
}

export function SynchronizedTimeline({ fromUtc, toUtc, coordinateMode = 'absolute', elapsedOriginUtc, intervalTracks, numericTracks = [], eventTracks = [], trackOrder, selectedId, onSelect, ariaLabel, minimumCanvasWidth = 760, highlightedRange, onInspectionTimeChange, renderInspectionTooltip }: SynchronizedTimelineProps) {
  const from = Date.parse(fromUtc)
  const to = Date.parse(toUtc)
  const span = Math.max(1, to - from)
  const labelOrigin = coordinateMode === 'elapsed' && elapsedOriginUtc ? Date.parse(elapsedOriginUtc) : from
  const [hovered, setHovered] = useState<TimelineIntervalItem>()
  const [hoveredEventUtc, setHoveredEventUtc] = useState<string>()
  const [crosshair, setCrosshair] = useState<number>()
  const [tooltipAnchor, setTooltipAnchor] = useState<{ x: number; y: number }>()
  const [selectedEventCluster, setSelectedEventCluster] = useState<string>()
  const [expandedEventGroups, setExpandedEventGroups] = useState<Set<string>>(() => new Set())
  const canvasRef = useRef<HTMLDivElement>(null)
  const canvasStyle = { '--timeline-min-width': `${minimumCanvasWidth}px` } as CSSProperties
  const numericGeometry = useMemo(() => numericTracks.map((track) => ({ track, geometry: numericPaths(track.samples, from, span, 1000, 88, track.connectObservedGaps, track.interpolation, track.holdLastObservation, track.referenceLines?.map(({ value }) => value), track.breakIntervals) })), [numericTracks, from, span])
  const eventGeometry = useMemo(() => eventTracks.map((track) => ({ track, clusters: clusterTimelineEvents(track.events, fromUtc, toUtc) })), [eventTracks, fromUtc, toUtc])
  const highlightedGeometry = highlightedRange ? {
    start: Math.min(1, Math.max(0, (Date.parse(highlightedRange.fromUtc) - from) / span)),
    width: Math.min(1 - Math.min(1, Math.max(0, (Date.parse(highlightedRange.fromUtc) - from) / span)), Math.max(0, (Math.min(to, Date.parse(highlightedRange.toUtc)) - Math.max(from, Date.parse(highlightedRange.fromUtc))) / span)),
  } : undefined
  const inspectionUtc = crosshair === undefined ? undefined : new Date(from + span * crosshair / 100).toISOString()
  const inspectionContent = inspectionUtc && renderInspectionTooltip ? renderInspectionTooltip(inspectionUtc) : null

  const eventDescription = (event: TimelineEvent) => `${event.label}. ${formatPlantDateTime(event.atUtc)} CT${coordinateMode === 'elapsed' ? `, ${timeLabel(event.atUtc, labelOrigin, coordinateMode)} elapsed` : ''}${event.detail ? `. ${event.detail}` : ''}`
  const focusInterval = (item: TimelineIntervalItem) => {
    setHovered(item)
    const midpoint = (Date.parse(item.startUtc) + Date.parse(item.endUtc)) / 2
    updateCrosshair(Math.min(100, Math.max(0, (midpoint - from) / span * 100)))
  }
  const rowOrder = (kind: 'interval' | 'numeric' | 'event', id: string): CSSProperties | undefined => {
    if (!trackOrder) return undefined
    const index = trackOrder.indexOf(`${kind}:${id}`)
    return { order: index < 0 ? trackOrder.length : index }
  }

  function selectEventCluster(id: string) {
    setSelectedEventCluster((current) => current === id ? undefined : id)
    setExpandedEventGroups(new Set())
  }

  function toggleEventGroup(id: string) {
    setExpandedEventGroups((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function moveCrosshair(event: PointerEvent<HTMLDivElement>) {
    const plot = event.currentTarget.querySelector<HTMLElement>('.synchronized-timeline__track, .synchronized-timeline__numeric, .synchronized-timeline__events')
    const bounds = plot?.getBoundingClientRect() ?? event.currentTarget.getBoundingClientRect()
    updateCrosshair(Math.min(100, Math.max(0, (event.clientX - bounds.left) / Math.max(1, bounds.width) * 100)), { x: event.clientX, y: event.clientY })
  }

  function updateCrosshair(percent: number, anchor?: { x: number; y: number }) {
    const resolved = Math.min(100, Math.max(0, percent))
    setCrosshair(resolved)
    if (anchor) setTooltipAnchor(anchor)
    else {
      const bounds = canvasRef.current?.getBoundingClientRect()
      if (bounds) setTooltipAnchor({ x: bounds.left + bounds.width * resolved / 100, y: bounds.top + Math.min(bounds.height / 2, 160) })
    }
    onInspectionTimeChange?.(new Date(from + span * resolved / 100).toISOString())
  }

  function moveCrosshairWithKeyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    if (event.key === 'Home') updateCrosshair(0)
    else if (event.key === 'End') updateCrosshair(100)
    else updateCrosshair((crosshair ?? 50) + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 5 : 1))
  }

  return <div className="synchronized-timeline" aria-label={ariaLabel}>
    <div className="synchronized-timeline__scroll" tabIndex={0} aria-label={`Scrollable ${coordinateMode === 'absolute' ? 'wall-clock' : 'elapsed-time'} timeline. Use Left and Right Arrow keys to move the inspection time; Shift moves farther.`} onKeyDown={moveCrosshairWithKeyboard}>
      <div ref={canvasRef} className="synchronized-timeline__canvas" style={canvasStyle} onPointerMove={moveCrosshair} onPointerLeave={() => { setCrosshair(undefined); setTooltipAnchor(undefined); setHovered(undefined); setHoveredEventUtc(undefined) }}>
        <div className="synchronized-timeline__axis"><time>{timeLabel(fromUtc, labelOrigin, coordinateMode)}</time><span>{coordinateMode === 'absolute' ? 'Wall clock' : 'Elapsed Run time'}</span><time>{timeLabel(toUtc, labelOrigin, coordinateMode)}</time></div>
        {highlightedGeometry && <div className="synchronized-timeline__highlight" style={{ '--timeline-highlight-start': highlightedGeometry.start, '--timeline-highlight-width': highlightedGeometry.width } as CSSProperties} title={highlightedRange?.label} aria-hidden="true" />}
        {intervalTracks.map((track) => <div className="synchronized-timeline__row" key={track.id} style={rowOrder('interval', track.id)}>
          <strong>{track.label}</strong>
          <div className="synchronized-timeline__track" role="group" aria-label={`${track.label} intervals`}>
            {track.intervals.length ? track.intervals.map((item) => {
              const left = Math.max(0, (Date.parse(item.startUtc) - from) / span * 100)
              const width = Math.max(.12, Math.min(100 - left, (Date.parse(item.endUtc) - Date.parse(item.startUtc)) / span * 100))
              const linked = hovered ? overlap(item, hovered) : hoveredEventUtc ? Date.parse(item.startUtc) <= Date.parse(hoveredEventUtc) && Date.parse(item.endUtc) > Date.parse(hoveredEventUtc) : false
              return <button type="button" key={item.id} className={`synchronized-timeline__interval ${item.className ?? ''} ${item.unavailable ? 'is-unavailable' : ''} ${linked ? 'is-linked' : ''} ${selectedId === item.id ? 'is-selected' : ''}`.trim()} style={{ left: `${left}%`, width: `${width}%`, ...item.style }} title={item.details} aria-label={item.details?.replaceAll('\n', '. ') ?? `${item.label}, ${timeLabel(item.startUtc, labelOrigin, coordinateMode)} to ${timeLabel(item.endUtc, labelOrigin, coordinateMode)}`} onMouseEnter={() => focusInterval(item)} onFocus={() => focusInterval(item)} onMouseLeave={() => { setHovered(undefined); setCrosshair(undefined) }} onBlur={() => { setHovered(undefined); setCrosshair(undefined) }} onClick={() => onSelect?.(item, track)}>{width >= 4 && <span>{item.label}</span>}</button>
            }) : <span className="synchronized-timeline__empty">{track.unavailableLabel ?? 'No observed state in this range'}</span>}
          </div>
        </div>)}
        {numericGeometry.map(({ track, geometry }) => <div className="synchronized-timeline__row synchronized-timeline__row--numeric" key={track.id} style={rowOrder('numeric', track.id)}>
          <strong>{track.label}{track.unit ? <small>{track.unit}</small> : null}</strong>
          <div className="synchronized-timeline__numeric" role="img" aria-label={`${track.label}. ${track.samples.length ? `${track.samples.length} observed samples from ${geometry.minimum} to ${geometry.maximum}${track.unit ? ` ${track.unit}` : ''}` : track.unavailableLabel ?? 'No samples in this range'}`}>
            {track.samples.length ? <svg viewBox="0 0 1000 88" preserveAspectRatio="none" aria-hidden="true">{geometry.paths.map((path, index) => <path key={index} d={path} />)}</svg> : <span>{track.unavailableLabel ?? 'No samples in this range'}</span>}
            {track.referenceLines?.map((line) => { const valueSpan = Math.max(1, geometry.maximum - geometry.minimum); const top = (6 + (geometry.maximum - line.value) / valueSpan * 76) / 88 * 100; return <i key={`${line.label}:${line.value}`} className="synchronized-timeline__reference-line" style={{ top: `${top}%` }} title={line.label}><b>{line.label}</b></i> })}
            {track.markers?.filter(({ atUtc }) => Date.parse(atUtc) >= from && Date.parse(atUtc) <= to).map((marker) => <i key={`${marker.kind}:${marker.atUtc}:${marker.label}`} className={`synchronized-timeline__numeric-marker synchronized-timeline__numeric-marker--${marker.kind ?? 'event'}`} style={{ left: `${(Date.parse(marker.atUtc) - from) / span * 100}%` }} title={`${marker.label} · ${timeLabel(marker.atUtc, labelOrigin, coordinateMode)}`}><b>{marker.label}</b></i>)}
          </div>
        </div>)}
        {eventGeometry.map(({ track, clusters }) => <div className="synchronized-timeline__row synchronized-timeline__row--events" key={track.id} style={rowOrder('event', track.id)}>
          <strong>{track.label}</strong>
          <div className="synchronized-timeline__event-column">
            <div className="synchronized-timeline__events" role="group" aria-label={`${track.label} event markers`}>
              {clusters.length ? clusters.map((cluster) => {
                const description = cluster.events.map(eventDescription).join(' ')
                const category = cluster.events.length === 1 ? cluster.events[0]!.category.replace(/[^a-z0-9_-]/gi, '-').toLowerCase() : 'cluster'
                return <button type="button" key={cluster.id} className={`synchronized-timeline__event synchronized-timeline__event--${category} ${selectedEventCluster === cluster.id ? 'is-selected' : ''}`} style={{ left: `${cluster.positionPercent}%` }} title={description} aria-label={description} onMouseEnter={() => { updateCrosshair(cluster.positionPercent); setHoveredEventUtc(cluster.events[0]?.atUtc) }} onFocus={() => { updateCrosshair(cluster.positionPercent); setHoveredEventUtc(cluster.events[0]?.atUtc) }} onMouseLeave={() => { setCrosshair(undefined); setTooltipAnchor(undefined); setHoveredEventUtc(undefined) }} onBlur={() => { setCrosshair(undefined); setTooltipAnchor(undefined); setHoveredEventUtc(undefined) }} onClick={() => selectEventCluster(cluster.id)}><i aria-hidden="true" />{cluster.events.length > 1 && <b>{cluster.events.length}</b>}</button>
              }) : <span>{track.unavailableLabel ?? 'No observed changes in this range'}</span>}
            </div>
            {clusters.map((cluster) => selectedEventCluster === cluster.id && <div className="synchronized-timeline__event-detail" role="region" aria-label="Selected event details" key={`detail:${cluster.id}`}><header><strong>{cluster.events.length === 1 ? 'Observed event' : `${cluster.events.length} events`}</strong><span>{groupTimelineEvents(cluster.events).length} {groupTimelineEvents(cluster.events).length === 1 ? 'change group' : 'change groups'}</span></header><div className="synchronized-timeline__event-groups">{groupTimelineEvents(cluster.events).map((group) => { const groupId = `${cluster.id}:${group.key}`; const expanded = expandedEventGroups.has(groupId); const visible = expanded ? group.events : group.events.slice(0, 6); return <section key={group.key} className="synchronized-timeline__event-group"><div><strong>{group.label}</strong><b>{group.events.length}</b></div><ol>{visible.map((event) => <li key={event.id}><time>{formatPlantDateTime(event.atUtc)} CT</time><span>{event.label}</span></li>)}</ol>{group.events.length > 6 && <button type="button" className="secondary-action" onClick={() => toggleEventGroup(groupId)}>{expanded ? 'Show first 6' : `Show all ${group.events.length}`}</button>}</section> })}</div></div>)}
          </div>
        </div>)}
        {crosshair !== undefined && <div className="synchronized-timeline__crosshair" style={{ '--timeline-position': crosshair / 100 } as CSSProperties} aria-hidden="true" />}
      </div>
    </div>
    {crosshair !== undefined && tooltipAnchor && inspectionContent && typeof document !== 'undefined' && <ViewportInspectionTooltip anchor={tooltipAnchor}>{inspectionContent}</ViewportInspectionTooltip>}
  </div>
}
