import { useMemo, useState, type CSSProperties, type PointerEvent } from 'react'
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
}

export interface TimelineEvent {
  id: string
  atUtc: string
  label: string
  category: string
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

function numericPaths(samples: TimedNumericSample[], from: number, span: number, width: number, height: number): { paths: string[]; minimum: number; maximum: number } {
  const visible = samples.filter(({ observedAtUtc, value }) => Number.isFinite(Date.parse(observedAtUtc)) && Number.isFinite(value) && Date.parse(observedAtUtc) >= from && Date.parse(observedAtUtc) <= from + span)
  const minimum = visible.length ? Math.min(...visible.map(({ value }) => value)) : 0
  const maximum = visible.length ? Math.max(...visible.map(({ value }) => value)) : 0
  const valueSpan = Math.max(1, maximum - minimum)
  const medianGap = visible.length > 2 ? [...visible.slice(1).map((item, index) => Date.parse(item.observedAtUtc) - Date.parse(visible[index]!.observedAtUtc))].sort((a, b) => a - b)[Math.floor((visible.length - 1) / 2)] ?? span : span
  const maximumConnectedGap = Math.max(1_000, medianGap * 4)
  const paths: string[] = []
  let current: string[] = []
  visible.forEach((sample, index) => {
    const timestamp = Date.parse(sample.observedAtUtc)
    const previous = visible[index - 1]
    if (previous && timestamp - Date.parse(previous.observedAtUtc) > maximumConnectedGap) {
      if (current.length) paths.push(current.join(' '))
      current = []
    }
    const x = (timestamp - from) / span * width
    const y = height - 6 - (sample.value - minimum) / valueSpan * (height - 12)
    current.push(`${current.length ? 'L' : 'M'} ${x.toFixed(2)} ${y.toFixed(2)}`)
  })
  if (current.length) paths.push(current.join(' '))
  return { paths, minimum, maximum }
}

export function SynchronizedTimeline({ fromUtc, toUtc, coordinateMode = 'absolute', elapsedOriginUtc, intervalTracks, numericTracks = [], eventTracks = [], trackOrder, selectedId, onSelect, ariaLabel, minimumCanvasWidth = 760 }: SynchronizedTimelineProps) {
  const from = Date.parse(fromUtc)
  const to = Date.parse(toUtc)
  const span = Math.max(1, to - from)
  const labelOrigin = coordinateMode === 'elapsed' && elapsedOriginUtc ? Date.parse(elapsedOriginUtc) : from
  const [hovered, setHovered] = useState<TimelineIntervalItem>()
  const [hoveredEventUtc, setHoveredEventUtc] = useState<string>()
  const [crosshair, setCrosshair] = useState<number>()
  const [selectedEventCluster, setSelectedEventCluster] = useState<string>()
  const canvasStyle = { '--timeline-min-width': `${minimumCanvasWidth}px` } as CSSProperties
  const numericGeometry = useMemo(() => numericTracks.map((track) => ({ track, geometry: numericPaths(track.samples, from, span, 1000, 88) })), [numericTracks, from, span])
  const eventGeometry = useMemo(() => eventTracks.map((track) => ({ track, clusters: clusterTimelineEvents(track.events, fromUtc, toUtc) })), [eventTracks, fromUtc, toUtc])

  const eventDescription = (event: TimelineEvent) => `${event.label}. ${formatPlantDateTime(event.atUtc)} CT${coordinateMode === 'elapsed' ? `, ${timeLabel(event.atUtc, labelOrigin, coordinateMode)} elapsed` : ''}${event.detail ? `. ${event.detail}` : ''}`
  const focusInterval = (item: TimelineIntervalItem) => {
    setHovered(item)
    const midpoint = (Date.parse(item.startUtc) + Date.parse(item.endUtc)) / 2
    setCrosshair(Math.min(100, Math.max(0, (midpoint - from) / span * 100)))
  }
  const rowOrder = (kind: 'interval' | 'numeric' | 'event', id: string): CSSProperties | undefined => {
    if (!trackOrder) return undefined
    const index = trackOrder.indexOf(`${kind}:${id}`)
    return { order: index < 0 ? trackOrder.length : index }
  }

  function moveCrosshair(event: PointerEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect()
    setCrosshair(Math.min(100, Math.max(0, (event.clientX - bounds.left) / Math.max(1, bounds.width) * 100)))
  }

  return <div className="synchronized-timeline" aria-label={ariaLabel}>
    <div className="synchronized-timeline__scroll" tabIndex={0} aria-label={`Scrollable ${coordinateMode === 'absolute' ? 'wall-clock' : 'elapsed-time'} timeline`}>
      <div className="synchronized-timeline__canvas" style={canvasStyle} onPointerMove={moveCrosshair} onPointerLeave={() => { setCrosshair(undefined); setHovered(undefined); setHoveredEventUtc(undefined) }}>
        <div className="synchronized-timeline__axis"><time>{timeLabel(fromUtc, labelOrigin, coordinateMode)}</time><span>{coordinateMode === 'absolute' ? 'Wall clock' : 'Elapsed Run time'}</span><time>{timeLabel(toUtc, labelOrigin, coordinateMode)}</time></div>
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
          </div>
        </div>)}
        {eventGeometry.map(({ track, clusters }) => <div className="synchronized-timeline__row synchronized-timeline__row--events" key={track.id} style={rowOrder('event', track.id)}>
          <strong>{track.label}</strong>
          <div className="synchronized-timeline__event-column">
            <div className="synchronized-timeline__events" role="group" aria-label={`${track.label} event markers`}>
              {clusters.length ? clusters.map((cluster) => {
                const description = cluster.events.map(eventDescription).join(' ')
                const category = cluster.events.length === 1 ? cluster.events[0]!.category.replace(/[^a-z0-9_-]/gi, '-').toLowerCase() : 'cluster'
                return <button type="button" key={cluster.id} className={`synchronized-timeline__event synchronized-timeline__event--${category} ${selectedEventCluster === cluster.id ? 'is-selected' : ''}`} style={{ left: `${cluster.positionPercent}%` }} title={description} aria-label={description} onMouseEnter={() => { setCrosshair(cluster.positionPercent); setHoveredEventUtc(cluster.events[0]?.atUtc) }} onFocus={() => { setCrosshair(cluster.positionPercent); setHoveredEventUtc(cluster.events[0]?.atUtc) }} onMouseLeave={() => { setCrosshair(undefined); setHoveredEventUtc(undefined) }} onBlur={() => { setCrosshair(undefined); setHoveredEventUtc(undefined) }} onClick={() => setSelectedEventCluster((current) => current === cluster.id ? undefined : cluster.id)}><i aria-hidden="true" />{cluster.events.length > 1 && <b>{cluster.events.length}</b>}</button>
              }) : <span>{track.unavailableLabel ?? 'No observed changes in this range'}</span>}
            </div>
            {clusters.map((cluster) => selectedEventCluster === cluster.id && <div className="synchronized-timeline__event-detail" role="status" key={`detail:${cluster.id}`}><strong>{cluster.events.length === 1 ? 'Observed event' : `${cluster.events.length} grouped events`}</strong><ul>{cluster.events.map((event) => <li key={event.id}><time>{formatPlantDateTime(event.atUtc)} CT</time><span>{event.label}</span></li>)}</ul></div>)}
          </div>
        </div>)}
        {crosshair !== undefined && <div className="synchronized-timeline__crosshair" style={{ left: `${crosshair}%` }} aria-hidden="true" />}
      </div>
    </div>
  </div>
}
