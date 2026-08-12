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
}

export interface TimelineNumericTrack {
  id: string
  label: string
  samples: TimedNumericSample[]
  unit?: string | null
  unavailableLabel?: string
}

interface SynchronizedTimelineProps {
  fromUtc: string
  toUtc: string
  coordinateMode?: TimelineCoordinateMode
  intervalTracks: TimelineIntervalTrack[]
  numericTracks?: TimelineNumericTrack[]
  selectedId?: string
  onSelect?(item: TimelineIntervalItem, track: TimelineIntervalTrack): void
  ariaLabel: string
  minimumCanvasWidth?: number
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

export function SynchronizedTimeline({ fromUtc, toUtc, coordinateMode = 'absolute', intervalTracks, numericTracks = [], selectedId, onSelect, ariaLabel, minimumCanvasWidth = 760 }: SynchronizedTimelineProps) {
  const from = Date.parse(fromUtc)
  const to = Date.parse(toUtc)
  const span = Math.max(1, to - from)
  const [hovered, setHovered] = useState<TimelineIntervalItem>()
  const [crosshair, setCrosshair] = useState<number>()
  const canvasStyle = { '--timeline-min-width': `${minimumCanvasWidth}px` } as CSSProperties
  const numericGeometry = useMemo(() => numericTracks.map((track) => ({ track, geometry: numericPaths(track.samples, from, span, 1000, 88) })), [numericTracks, from, span])

  function moveCrosshair(event: PointerEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect()
    setCrosshair(Math.min(100, Math.max(0, (event.clientX - bounds.left) / Math.max(1, bounds.width) * 100)))
  }

  return <div className="synchronized-timeline" aria-label={ariaLabel}>
    <div className="synchronized-timeline__scroll" tabIndex={0} aria-label={`Scrollable ${coordinateMode === 'absolute' ? 'wall-clock' : 'elapsed-time'} timeline`}>
      <div className="synchronized-timeline__canvas" style={canvasStyle} onPointerMove={moveCrosshair} onPointerLeave={() => { setCrosshair(undefined); setHovered(undefined) }}>
        <div className="synchronized-timeline__axis"><time>{timeLabel(fromUtc, from, coordinateMode)}</time><span>{coordinateMode === 'absolute' ? 'Wall clock' : 'Elapsed Run time'}</span><time>{timeLabel(toUtc, from, coordinateMode)}</time></div>
        {intervalTracks.map((track) => <div className="synchronized-timeline__row" key={track.id}>
          <strong>{track.label}</strong>
          <div className="synchronized-timeline__track" role="group" aria-label={`${track.label} intervals`}>
            {track.intervals.map((item) => {
              const left = Math.max(0, (Date.parse(item.startUtc) - from) / span * 100)
              const width = Math.max(.12, Math.min(100 - left, (Date.parse(item.endUtc) - Date.parse(item.startUtc)) / span * 100))
              const linked = hovered ? overlap(item, hovered) : false
              return <button type="button" key={item.id} className={`synchronized-timeline__interval ${item.className ?? ''} ${item.unavailable ? 'is-unavailable' : ''} ${linked ? 'is-linked' : ''} ${selectedId === item.id ? 'is-selected' : ''}`.trim()} style={{ left: `${left}%`, width: `${width}%`, ...item.style }} title={item.details} aria-label={item.details?.replaceAll('\n', '. ') ?? `${item.label}, ${timeLabel(item.startUtc, from, coordinateMode)} to ${timeLabel(item.endUtc, from, coordinateMode)}`} onMouseEnter={() => setHovered(item)} onFocus={() => setHovered(item)} onMouseLeave={() => setHovered(undefined)} onBlur={() => setHovered(undefined)} onClick={() => onSelect?.(item, track)}>{width >= 4 && <span>{item.label}</span>}</button>
            })}
          </div>
        </div>)}
        {numericGeometry.map(({ track, geometry }) => <div className="synchronized-timeline__row synchronized-timeline__row--numeric" key={track.id}>
          <strong>{track.label}{track.unit ? <small>{track.unit}</small> : null}</strong>
          <div className="synchronized-timeline__numeric" role="img" aria-label={`${track.label}. ${track.samples.length ? `${track.samples.length} observed samples from ${geometry.minimum} to ${geometry.maximum}${track.unit ? ` ${track.unit}` : ''}` : track.unavailableLabel ?? 'No samples in this range'}`}>
            {track.samples.length ? <svg viewBox="0 0 1000 88" preserveAspectRatio="none" aria-hidden="true">{geometry.paths.map((path, index) => <path key={index} d={path} />)}</svg> : <span>{track.unavailableLabel ?? 'No samples in this range'}</span>}
          </div>
        </div>)}
        {crosshair !== undefined && <div className="synchronized-timeline__crosshair" style={{ left: `${crosshair}%` }} aria-hidden="true" />}
      </div>
    </div>
  </div>
}
