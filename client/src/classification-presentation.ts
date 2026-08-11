import type { RadiusStatusSegment } from './types/api'

export type RadiusTimelineView = 'operations' | 'raw'

export function semanticLabel(segment: RadiusStatusSegment): string {
  if (segment.kind === 'offline') return 'Data unavailable'
  return segment.classification?.operationalGroupName ?? 'Administrative & Unknown'
}

export function semanticStyle(segment: RadiusStatusSegment): React.CSSProperties | undefined {
  if (segment.kind === 'offline') return undefined
  const classification = segment.classification
  const ink = (color: string) => {
    const values = [1, 3, 5].map((index) => Number.parseInt(color.slice(index, index + 2), 16) / 255).map((value) => value <= .03928 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
    return (.2126 * values[0] + .7152 * values[1] + .0722 * values[2]) > .42 ? '#101820' : '#ffffff'
  }
  const light = classification?.operationalGroupLightColor ?? '#68727d'
  const dark = classification?.operationalGroupDarkColor ?? '#9ca8b5'
  return { '--semantic-light': light, '--semantic-dark': dark, '--semantic-light-ink': ink(light), '--semantic-dark-ink': ink(dark) } as React.CSSProperties
}

export function rawLabel(segment: RadiusStatusSegment): string {
  return segment.kind === 'offline' ? 'Data unavailable' : segment.statusDescription || '(empty Radius description)'
}

export function segmentDisplayLabel(segment: RadiusStatusSegment, view: RadiusTimelineView): string {
  return view === 'operations' ? semanticLabel(segment) : rawLabel(segment)
}

export function groupedPhaseSequence(segments: RadiusStatusSegment[]): Array<{ label: string; durationSeconds: number; offline: boolean }> {
  const result: Array<{ label: string; durationSeconds: number; offline: boolean }> = []
  for (const segment of segments) {
    const short = segment.kind === 'radius' && segment.isProduction && (segment.returnToProduction === 'failed' || segment.stateBreakdownRunQualification?.state === 'short')
    const label = `${semanticLabel(segment)}${short ? ' (short)' : ''}`
    const previous = result.at(-1)
    if (previous && previous.label === label && previous.offline === (segment.kind === 'offline')) previous.durationSeconds += segment.durationSeconds
    else result.push({ label, durationSeconds: segment.durationSeconds, offline: segment.kind === 'offline' })
  }
  return result
}
