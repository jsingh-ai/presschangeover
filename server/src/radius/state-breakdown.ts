import type {
  RadiusStateSegment,
  RadiusStatusSegment,
  StateBreakdownRunQualification,
} from './models.js'

export const STATE_BREAKDOWN_RUN_CONFIRMATION_SECONDS = 120

function runQualification(
  segment: RadiusStateSegment,
  next: RadiusStatusSegment | undefined,
): StateBreakdownRunQualification {
  if (segment.durationSeconds >= STATE_BREAKDOWN_RUN_CONFIRMATION_SECONDS) {
    return {
      state: 'sustained',
      returnUtc: segment.startUtc,
      confirmationSatisfiedUtc: new Date(
        Date.parse(segment.startUtc) + STATE_BREAKDOWN_RUN_CONFIRMATION_SECONDS * 1_000,
      ).toISOString(),
    }
  }

  if (next?.kind === 'radius' && !next.isProduction) {
    return {
      state: 'short',
      returnUtc: null,
      confirmationSatisfiedUtc: null,
    }
  }

  return {
    state: 'pending',
    returnUtc: null,
    confirmationSatisfiedUtc: null,
  }
}

/**
 * Qualifies Run Production returns for the chronological State Breakdown view.
 * This deliberately remains separate from the five-minute episode confirmation rule.
 * The original segment timestamps and duration are never changed.
 */
export function qualifyStateBreakdownRuns(
  segments: RadiusStatusSegment[],
): RadiusStatusSegment[] {
  const ordered = [...segments].sort(
    (left, right) => Date.parse(left.startUtc) - Date.parse(right.startUtc),
  )

  return ordered.map((segment, index) => {
    if (segment.kind !== 'radius' || !segment.isProduction) return { ...segment }

    const previous = ordered[index - 1]
    if (previous?.kind !== 'radius' || previous.isProduction) return { ...segment }

    return {
      ...segment,
      stateBreakdownRunQualification: runQualification(segment, ordered[index + 1]),
    }
  })
}
