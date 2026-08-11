import type {
  RadiusPressKey,
  RadiusStatusSegment,
} from './types/api'

export interface RadiusSegmentSelection {
  pressKey: RadiusPressKey
  startUtc: string
  endUtc: string
}

export function selectRadiusSegment(
  segment: RadiusStatusSegment,
): RadiusSegmentSelection {
  return {
    pressKey: segment.pressKey,
    startUtc: segment.startUtc,
    endUtc: segment.endUtc,
  }
}

export function findRadiusSegment(
  segments: RadiusStatusSegment[],
  selection: RadiusSegmentSelection | undefined,
): RadiusStatusSegment | undefined {
  if (!selection) return undefined
  return segments.find(
    (segment) =>
      segment.pressKey === selection.pressKey &&
      segment.startUtc === selection.startUtc &&
      segment.endUtc === selection.endUtc,
  )
}
