import type { OperationalEpisode, RadiusStateSegment } from './types/api'

export function formatDuration(seconds: number): string {
  const rounded = Math.max(0, Math.round(seconds))
  const hours = Math.floor(rounded / 3_600)
  const minutes = Math.floor((rounded % 3_600) / 60)
  const remaining = rounded % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return remaining > 0 ? `${minutes}m ${remaining}s` : `${minutes}m`
  return `${remaining}s`
}

export function phaseClass(segment: RadiusStateSegment): string {
  if (segment.isProduction) return 'production'
  if (segment.eventType === 'M') return 'make-ready'
  if (segment.eventType === 'B') return 'bad'
  if (segment.eventType === 'S') return 'safety'
  if (segment.eventType === 'G') return 'good-other'
  return 'other'
}

export function completionLabel(episode: OperationalEpisode): string {
  if (episode.completionStatus === 'DATA_INTERRUPTED') return 'Data interrupted'
  if (episode.completionStatus === 'OPEN') return 'Open'
  return 'Production confirmed'
}

export function signedDurationDifference(seconds: number): string {
  const prefix = seconds >= 0 ? '+' : '−'
  return `${prefix}${formatDuration(Math.abs(seconds))}`
}

export function episodeVisualizationDurationSeconds(episode: OperationalEpisode): number {
  const startMs = Date.parse(episode.startUtc)
  return Math.max(
    episode.durationSeconds,
    ...episode.statusSegments.map(({ endUtc }) => Math.max(0, (Date.parse(endUtc) - startMs) / 1_000)),
  )
}

export function phaseGeometry(
  episode: OperationalEpisode,
  segment: RadiusStateSegment,
  sharedScaleSeconds: number,
): { leftPercent: number; widthPercent: number } {
  const safeScale = Math.max(1, sharedScaleSeconds)
  return {
    leftPercent: ((Date.parse(segment.startUtc) - Date.parse(episode.startUtc)) / 1_000 / safeScale) * 100,
    widthPercent: (segment.durationSeconds / safeScale) * 100,
  }
}
