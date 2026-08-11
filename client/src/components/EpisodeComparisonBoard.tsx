import { DateTime } from 'luxon'
import { useState, type CSSProperties } from 'react'
import { formatDuration, phaseClass, signedDurationDifference } from '../episode-presentation'
import { PLANT_TIME_ZONE, formatPlantDateTime } from '../time-ranges'
import type { OperationalEpisode, RadiusPressEpisodes, RadiusStateSegment, RadiusStatusSegment } from '../types/api'
import { groupedPhaseSequence, segmentDisplayLabel, semanticStyle, type RadiusTimelineView } from '../classification-presentation'

interface EpisodeComparisonBoardProps {
  result: RadiusPressEpisodes
  onSelectEpisode(episode: OperationalEpisode): void
  onSelectSegment(segment: RadiusStatusSegment): void
}

function localDateTime(value: string) {
  return DateTime.fromISO(value, { zone: 'utc' }).setZone(PLANT_TIME_ZONE)
}

function exactPlantDateTime(value: string): string {
  return localDateTime(value).toFormat('MMM d, yyyy h:mm:ss a')
}

function plantTime(value: string): string {
  return localDateTime(value).toFormat('h:mm a')
}

function matchingOfflineSegment(episode: OperationalEpisode, result: RadiusPressEpisodes) {
  if (!episode.dataInterrupted || !episode.endUtc) return undefined
  const observedEndMs = Date.parse(episode.endUtc)
  return result.timelineSegments.find((segment) => segment.kind === 'offline' && Date.parse(segment.startUtc) <= observedEndMs && Date.parse(segment.endUtc) > observedEndMs)
}

export function episodeDisplaySegments(episode: OperationalEpisode, result: RadiusPressEpisodes): RadiusStatusSegment[] {
  const contracted = episode.displaySegments?.length ? episode.displaySegments : episode.statusSegments
  const hasOffline = contracted.some(({ kind }) => kind === 'offline')
  const sourceSegments: RadiusStatusSegment[] = hasOffline ? contracted : [...contracted, ...(matchingOfflineSegment(episode, result) ? [matchingOfflineSegment(episode, result)!] : [])]
  return sourceSegments.map((segment) => {
    if (segment.kind === 'offline' || segment.returnToProduction !== 'confirmed') return segment
    const productionStartMs = Date.parse(episode.confirmedProductionStartUtc ?? segment.startUtc)
    const fullProduction = result.timelineSegments.find((candidate): candidate is RadiusStateSegment =>
      candidate.kind === 'radius' && candidate.isProduction &&
      Date.parse(candidate.startUtc) <= productionStartMs && Date.parse(candidate.endUtc) > productionStartMs,
    )
    return fullProduction ? { ...fullProduction, returnToProduction: 'confirmed' } : segment
  })
}

export function episodeSequenceLabels(segments: RadiusStatusSegment[]): string[] {
  return segments.map((segment) => {
    if (segment.kind === 'offline') return 'Data unavailable'
    const shortReturn = segment.returnToProduction === 'failed' || segment.stateBreakdownRunQualification?.state === 'short'
    return shortReturn && segment.isProduction ? `${segment.statusDescription} (short)` : segment.statusDescription
  })
}

function episodeTiming(episode: OperationalEpisode, segments: RadiusStatusSegment[]) {
  const unavailableSeconds = episode.unavailableDurationSeconds ?? segments.filter(({ kind }) => kind === 'offline').reduce((sum, segment) => sum + segment.durationSeconds, 0)
  const displayEndUtc = episode.displayEndUtc ?? segments.filter(({ kind }) => kind === 'offline').at(-1)?.endUtc ?? episode.endUtc
  const observedSeconds = episode.observedDurationSeconds ?? episode.durationSeconds
  const wallSeconds = episode.wallClockDurationSeconds ?? (displayEndUtc ? Math.max(0, (Date.parse(displayEndUtc) - Date.parse(episode.startUtc)) / 1_000) : observedSeconds)
  return { displayEndUtc, observedSeconds, unavailableSeconds, wallSeconds }
}

function episodeTimeLabels(episode: OperationalEpisode, displayEndUtc: string | null) {
  const start = localDateTime(episode.startUtc)
  if (!displayEndUtc) return { start: start.toFormat('h:mm a'), end: 'Ongoing', crossDate: false }
  const end = localDateTime(displayEndUtc)
  const crossDate = start.toISODate() !== end.toISODate()
  return {
    start: start.toFormat(crossDate ? 'MMM d, h:mm a' : 'h:mm a'),
    end: end.toFormat(crossDate ? 'MMM d, h:mm a' : 'h:mm a'),
    crossDate,
  }
}

function episodeStatus(episode: OperationalEpisode): string {
  if (episode.dataInterrupted) return 'Interrupted'
  if (episode.isOpen) return 'Open'
  return 'Production confirmed'
}

export function episodeHover(episode: OperationalEpisode, segments: RadiusStatusSegment[]): string {
  const timing = episodeTiming(episode, segments)
  const lines = [
    'EPISODE',
    `Start: ${exactPlantDateTime(episode.startUtc)} CT`,
    `${episode.dataInterrupted ? 'End of visible episode' : 'End'}: ${timing.displayEndUtc ? `${exactPlantDateTime(timing.displayEndUtc)} CT` : 'Ongoing'}`,
  ]
  if (episode.dataInterrupted) {
    lines.push(`Wall-clock duration: ${formatDuration(timing.wallSeconds)}`)
    lines.push(`Observed Radius time: ${formatDuration(timing.observedSeconds)}`)
    lines.push(`Data unavailable: ${formatDuration(timing.unavailableSeconds)}`)
  } else {
    lines.push(`${episode.isOpen ? 'Observed duration' : 'Duration'}: ${formatDuration(timing.observedSeconds)}`)
  }
  lines.push(`Status: ${episode.dataInterrupted ? 'Interrupted by data gap' : episodeStatus(episode)}`)
  lines.push(`Production return attempts: ${episode.returnToProductionAttemptCount}`)
  lines.push(`Failed short returns: ${episode.failedReturnToProductionAttempts}`)
  return lines.join('\n')
}

function rangeSegmentHover(segment: RadiusStatusSegment): string {
  const formatTimestamp = segment.kind === 'offline' ? exactPlantDateTime : formatPlantDateTime
  return [
    segment.kind === 'offline' ? 'Offline / No Radius Data' : segment.statusDescription,
    ...(segment.kind === 'radius' ? [`Event type: ${segment.eventType}`, `Status code: ${segment.statusCode ?? '—'}`, segment.isProduction ? 'Run Production' : 'Non-production'] : ['Radius data unavailable', 'Machine state is unknown.']),
    `Start: ${formatTimestamp(segment.startUtc)} CT`,
    `End: ${formatTimestamp(segment.endUtc)} CT`,
    `Duration: ${formatDuration(segment.durationSeconds)}`,
  ].join('\n')
}

function phaseHover(episode: OperationalEpisode, segment: RadiusStatusSegment, next: RadiusStatusSegment | undefined, result: RadiusPressEpisodes): string {
  if (segment.kind === 'offline') {
    return [
      'DATA UNAVAILABLE',
      `Start: ${exactPlantDateTime(segment.startUtc)} CT`,
      `End: ${exactPlantDateTime(segment.endUtc)} CT`,
      `Duration: ${formatDuration(segment.durationSeconds)}`,
      'No Radius observations were available during this interval.',
      'Machine state is unknown.',
    ].join('\n')
  }
  if (segment.returnToProduction === 'confirmed') {
    return [
      'Confirmed Run Production',
      `Event type: ${segment.eventType}`,
      `Status code: ${segment.statusCode ?? '—'}`,
      `Start: ${formatPlantDateTime(segment.startUtc)} CT`,
      `End: ${formatPlantDateTime(segment.endUtc)} CT`,
      `Full observed production duration: ${formatDuration(segment.durationSeconds)}`,
      `5-minute confirmation satisfied: ${formatPlantDateTime(episode.confirmationSatisfiedUtc ?? segment.startUtc)} CT`,
      `Operational episode ended: ${formatPlantDateTime(episode.endUtc ?? segment.startUtc)} CT`,
    ].join('\n')
  }
  const benchmark = result.analysis.phaseBenchmarks.find((candidate) => candidate.eventType === segment.eventType && candidate.statusDescription === segment.statusDescription)
  const percentage = episode.durationSeconds === 0 ? 0 : (segment.durationSeconds / episode.durationSeconds) * 100
  const lines = [
    segment.returnToProduction === 'failed' ? 'Failed Run Production attempt' : segment.statusDescription,
    `Event type: ${segment.eventType}`,
    `Status code: ${segment.statusCode ?? '—'}`,
    `Start: ${formatPlantDateTime(segment.startUtc)} CT`,
    `End: ${formatPlantDateTime(segment.endUtc)} CT`,
    `Duration: ${formatDuration(segment.durationSeconds)} (${percentage.toFixed(1)}% of observed episode time)`,
  ]
  if (segment.returnToProduction === 'failed') lines.push(`Followed by: ${next?.kind === 'radius' ? next.statusDescription : next?.kind === 'offline' ? 'Data unavailable' : 'unknown'}`)
  if (benchmark && benchmark.sampleCount >= 3) {
    const difference = segment.durationSeconds - benchmark.medianDurationSeconds
    lines.push(`Comparable ${result.press.displayName} phases: median ${formatDuration(benchmark.medianDurationSeconds)}`)
    lines.push(`Difference: ${signedDurationDifference(difference)}`)
    if (benchmark.p90DurationSeconds !== null && segment.durationSeconds > benchmark.p90DurationSeconds) lines.push('Unusually long: above comparable P90')
  }
  return lines.join('\n')
}

function rowDurationSeconds(startUtc: string, segments: RadiusStatusSegment[], fallbackSeconds: number): number {
  const startMs = Date.parse(startUtc)
  return Math.max(fallbackSeconds, ...segments.map(({ endUtc }) => Math.max(0, (Date.parse(endUtc) - startMs) / 1_000)))
}

function phaseGeometry(episode: OperationalEpisode, segment: RadiusStatusSegment, sharedScaleSeconds: number) {
  const safeScale = Math.max(1, sharedScaleSeconds)
  return {
    left: ((Date.parse(segment.startUtc) - Date.parse(episode.startUtc)) / 1_000 / safeScale) * 100,
    width: (segment.durationSeconds / safeScale) * 100,
  }
}

function rangeGeometry(result: RadiusPressEpisodes, segment: RadiusStatusSegment) {
  const fromMs = Date.parse(result.fromUtc)
  const rangeMs = Math.max(1, Date.parse(result.toUtc) - fromMs)
  return {
    left: Math.max(0, ((Date.parse(segment.startUtc) - fromMs) / rangeMs) * 100),
    width: Math.max(0.1, ((Date.parse(segment.endUtc) - Date.parse(segment.startUtc)) / rangeMs) * 100),
  }
}

function segmentTone(segment: RadiusStatusSegment): string {
  return segment.kind === 'offline' ? 'offline' : phaseClass(segment)
}

export function EpisodeComparisonBoard({ result, onSelectEpisode, onSelectSegment }: EpisodeComparisonBoardProps) {
  const [timelineView, setTimelineView] = useState<RadiusTimelineView>('operations')
  const median = result.analysis.medianDurationSeconds
  const displaySegments = new Map(result.episodes.map((episode) => [episode.episodeId, episodeDisplaySegments(episode, result)]))
  const maxDuration = Math.max(60, ...result.episodes.map((episode) => rowDurationSeconds(episode.startUtc, displaySegments.get(episode.episodeId) ?? episode.statusSegments, episode.durationSeconds)))
  const tickCount = 4

  return <section className="panel comparison-panel" aria-labelledby="comparison-title">
    <div className="section-heading">
      <div><p className="eyebrow">See and compare</p><h2 id="comparison-title">Episode comparison</h2></div>
      <div className="timeline-view-toggle" role="group" aria-label="Episode timeline presentation"><button type="button" className={timelineView === 'operations' ? 'active' : ''} aria-pressed={timelineView === 'operations'} onClick={() => setTimelineView('operations')}>Operations</button><button type="button" className={timelineView === 'raw' ? 'active' : ''} aria-pressed={timelineView === 'raw'} onClick={() => setTimelineView('raw')}>Raw Radius</button></div>
      <p className="section-note">Complete activity uses the selected range. Episode rows retain one shared elapsed-time scale; unavailable time is shown but excluded from operational calculations.</p>
    </div>
    <div className="focused-range-gantt" aria-label={`${result.press.displayName} complete activity for selected range`}>
      <div className="focused-range-gantt-heading"><div><strong>Complete press activity</strong><span>Production, stops, and offline periods remain in chronological order.</span></div><span>{result.timelineSegments.length} observed state{result.timelineSegments.length === 1 ? '' : 's'}</span></div>
      <div className="focused-range-axis" aria-hidden="true"><time>{formatPlantDateTime(result.fromUtc)} CT</time><span>Selected time range</span><time>{formatPlantDateTime(result.toUtc)} CT</time></div>
      <div className="focused-range-track">
        {result.timelineSegments.map((segment, index) => {
          const { left, width } = rangeGeometry(result, segment)
          const hover = rangeSegmentHover(segment)
          return <button key={`${segment.startUtc}-${index}`} type="button" data-view={timelineView} className={`focused-range-segment focused-range-segment--${segmentTone(segment)}`} style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%`, ...(timelineView === 'operations' ? semanticStyle(segment) : {}) }} title={timelineView === 'operations' && segment.kind === 'radius' ? `${segmentDisplayLabel(segment, timelineView)}\nRaw Radius: ${segment.eventType} / ${segment.statusCode ?? '—'} / ${segment.statusDescription}\n${hover}` : hover} aria-label={timelineView === 'operations' && segment.kind === 'radius' ? `${segmentDisplayLabel(segment, timelineView)}; exact Radius identity ${segment.eventType} / ${segment.statusCode ?? 'no code'} / ${segment.statusDescription}` : hover} onClick={() => onSelectSegment(segment)} />
        })}
      </div>
    </div>
    {result.episodes.length === 0 ? <p className="empty-state">No observed non-production episodes occurred in this range. Complete press activity still shows the available Radius history.</p> : <div className="comparison-scroll">
      <div className="comparison-board" style={{ '--board-max-seconds': maxDuration } as CSSProperties}>
        <div className="comparison-axis-label">Episode</div>
        <div className="comparison-axis" aria-hidden="true">{Array.from({ length: tickCount + 1 }, (_, index) => <span key={index} style={{ left: `${(index / tickCount) * 100}%` }}>T+{formatDuration((maxDuration * index) / tickCount)}</span>)}</div>
        {result.episodes.map((episode) => {
          const segments = displaySegments.get(episode.episodeId) ?? episode.statusSegments
          const timing = episodeTiming(episode, segments)
          const labels = episodeTimeLabels(episode, timing.displayEndUtc)
          const sequence = timelineView === 'operations' ? groupedPhaseSequence(segments).map(({ label, durationSeconds }) => `${label} · ${formatDuration(durationSeconds)}`) : episodeSequenceLabels(segments)
          const hover = episodeHover(episode, segments)
          const difference = median === null ? null : episode.durationSeconds - median
          return <div className="comparison-row" key={episode.episodeId}>
            <button className="comparison-row-label" type="button" title={hover} aria-label={hover} onClick={() => onSelectEpisode(episode)}>
              <span className={`episode-time-range${labels.crossDate ? ' episode-time-range--cross-date' : ''}`}><strong>{labels.start}</strong><i aria-hidden="true">→</i><strong>{labels.end}</strong></span>
              <small className="episode-duration">{episode.dataInterrupted ? `${formatDuration(timing.wallSeconds)} wall time` : episode.isOpen ? `${formatDuration(timing.observedSeconds)} observed` : formatDuration(episode.durationSeconds)}</small>
              <span className={`state-pill ${episode.completionStatus.toLowerCase()}`}>{episodeStatus(episode)}</span>
              {!episode.dataInterrupted && difference !== null && result.episodes.length >= 3 && <em className="episode-comparison-note">{signedDurationDifference(difference)} vs typical</em>}
              {episode.dataInterrupted && <em className="episode-comparison-note">Comparison unavailable — incomplete Radius coverage</em>}
            </button>
            <div className="comparison-track" aria-label={`Sequence: ${sequence.join(', then ')}${sequence.includes('Data unavailable') ? '. Data unavailable, machine state unknown.' : '.'}`}>
              {segments.map((segment, index) => {
                const { left, width } = phaseGeometry(episode, segment, maxDuration)
                const segmentHover = phaseHover(episode, segment, segments[index + 1], result)
                const exactContext = segment.kind === 'radius' ? `\nOperational group: ${segment.classification?.operationalGroupName ?? 'Administrative & Unknown'}\nProcess family: ${segment.classification?.processFamilyName ?? 'Unknown'}\nExact Radius: ${segment.eventType} / ${segment.statusCode ?? '—'} / ${segment.statusDescription}` : ''
                return <button type="button" key={`${segment.startUtc}-${index}`} data-view={timelineView} className={`comparison-phase comparison-phase--${segmentTone(segment)} ${segment.kind === 'radius' && segment.returnToProduction ? `comparison-phase--return-${segment.returnToProduction}` : ''}`} style={{ left: `${left}%`, width: `${width}%`, ...(timelineView === 'operations' ? semanticStyle(segment) : {}) }} title={`${segmentHover}${exactContext}`} aria-label={`${segmentDisplayLabel(segment, timelineView)}. ${segmentHover}${exactContext}`} onClick={() => onSelectSegment(segment)}>{width > 10 && <span>{segmentDisplayLabel(segment, timelineView)}</span>}</button>
              })}
              <p className="comparison-phase-sequence">{sequence.map((label, index) => <span key={`${label}-${index}`}>{index > 0 && <i aria-hidden="true">→</i>}{label}</span>)}</p>
            </div>
          </div>
        })}
      </div>
    </div>}
    <div className="comparison-key"><span className="failed-key">Failed &lt;5m production return</span><span className="confirmed-key">Confirmed production (full observed duration)</span><span className="offline-key">Offline / No Radius Data</span></div>
  </section>
}
