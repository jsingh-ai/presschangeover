import { Buffer } from 'node:buffer'
import type {
  OperationalEpisode,
  RadiusObservation,
  RadiusOfflineSegment,
  RadiusPressMapping,
  RadiusStateSegment,
  RadiusStatusSegment,
} from '../radius/models.js'

export const PRODUCTION_CONFIRMATION_MS = 5 * 60 * 1_000

function secondsBetween(fromUtc: string, toUtc: string): number {
  return Math.max(0, (Date.parse(toUtc) - Date.parse(fromUtc)) / 1_000)
}

function sameState(left: RadiusObservation, right: RadiusObservation): boolean {
  return (
    left.eventType === right.eventType &&
    left.statusCode === right.statusCode &&
    left.statusDescription === right.statusDescription
  )
}

export function compressRadiusObservations(
  observations: RadiusObservation[],
  mapping: RadiusPressMapping,
  productionStatusDescription: string,
  productionEventType = 'G',
): RadiusStatusSegment[] {
  const ordered = [...observations].sort(
    (left, right) =>
      Date.parse(left.fetchedAtUtc) - Date.parse(right.fetchedAtUtc),
  )
  const segments: RadiusStatusSegment[] = []
  let currentObservation: RadiusObservation | undefined
  let currentSegment: RadiusStatusSegment | undefined

  for (const observation of ordered) {
    if (observation.machineId !== mapping.machineId) continue

    if (
      currentObservation &&
      currentSegment &&
      sameState(currentObservation, observation)
    ) {
      currentSegment.endUtc = observation.fetchedAtUtc
      currentSegment.durationSeconds = secondsBetween(
        currentSegment.startUtc,
        currentSegment.endUtc,
      )
      currentObservation = observation
      continue
    }

    if (currentSegment) {
      currentSegment.endUtc = observation.fetchedAtUtc
      currentSegment.durationSeconds = secondsBetween(
        currentSegment.startUtc,
        currentSegment.endUtc,
      )
    }

    currentObservation = observation
    currentSegment = {
      kind: 'radius',
      machineId: mapping.machineId,
      pressKey: mapping.pressKey,
      displayName: mapping.displayName,
      eventType: observation.eventType,
      statusCode: observation.statusCode,
      statusDescription: observation.statusDescription,
      startUtc: observation.fetchedAtUtc,
      endUtc: observation.fetchedAtUtc,
      durationSeconds: 0,
      isOpen: false,
      isProduction:
        observation.eventType === productionEventType &&
        observation.statusDescription === productionStatusDescription,
      sourceGeneration:
        observation.sourceGeneration === 'current'
          ? 'compact'
          : observation.sourceGeneration,
    }
    segments.push(currentSegment)
  }

  return segments
}

export function createEpisodeId(pressKey: string, startUtc: string): string {
  return Buffer.from(`${pressKey}|${startUtc}`, 'utf8').toString('base64url')
}

export function decodeEpisodeId(
  episodeId: string,
): { pressKey: string; startUtc: string } | undefined {
  try {
    const decoded = Buffer.from(episodeId, 'base64url').toString('utf8')
    const separator = decoded.indexOf('|')
    if (separator <= 0) return undefined
    const pressKey = decoded.slice(0, separator)
    const startUtc = decoded.slice(separator + 1)
    if (!Number.isFinite(Date.parse(startUtc))) return undefined
    return { pressKey, startUtc }
  } catch {
    return undefined
  }
}

function addDuration(target: Record<string, number>, key: string, value: number) {
  target[key] = (target[key] ?? 0) + value
}

interface ActiveEpisode {
  startUtc: string
  startStatus: string
  segments: RadiusStateSegment[]
  attempts: number
  failedAttempts: number
  lastObservedUtc: string
  startedAfterDataGap: boolean
}

function finalizeEpisode(
  active: ActiveEpisode,
  mapping: RadiusPressMapping,
  visibleFromUtc: string,
  visibleToUtc: string,
  endUtc: string | null,
  confirmedProductionStartUtc: string | null,
  confirmationSatisfiedUtc: string | null,
  completionStatus: OperationalEpisode['completionStatus'],
  interruption?: RadiusOfflineSegment,
): OperationalEpisode {
  const effectiveEndUtc = endUtc ?? active.lastObservedUtc
  const timeByEventType: Record<string, number> = {}
  const timeByStatusDescription: Record<string, number> = {}
  const nonProductionTimeByStatus: Record<string, number> = {}

  for (const segment of active.segments) {
    const segmentEndMs = Math.min(
      Date.parse(segment.endUtc),
      Date.parse(effectiveEndUtc),
    )
    const durationSeconds = Math.max(
      0,
      (segmentEndMs - Date.parse(segment.startUtc)) / 1_000,
    )
    addDuration(timeByEventType, segment.eventType, durationSeconds)
    addDuration(
      timeByStatusDescription,
      segment.statusDescription,
      durationSeconds,
    )
    if (!segment.isProduction) {
      addDuration(
        nonProductionTimeByStatus,
        segment.statusDescription,
        durationSeconds,
      )
    }
  }

  const primaryStatusDescription = Object.entries(nonProductionTimeByStatus).sort(
    (left, right) => right[1] - left[1],
  )[0]?.[0] ?? active.startStatus
  const unavailableEndMs = interruption
    ? Math.min(Date.parse(interruption.endUtc), Date.parse(visibleToUtc))
    : 0
  const displayUnavailable = interruption && unavailableEndMs > Date.parse(interruption.startUtc)
    ? {
        ...interruption,
        endUtc: new Date(unavailableEndMs).toISOString(),
        durationSeconds: secondsBetween(interruption.startUtc, new Date(unavailableEndMs).toISOString()),
      }
    : undefined
  const displayEndUtc = displayUnavailable?.endUtc ?? endUtc
  const observedDurationSeconds = secondsBetween(active.startUtc, effectiveEndUtc)

  return {
    episodeId: createEpisodeId(mapping.pressKey, active.startUtc),
    pressKey: mapping.pressKey,
    displayName: mapping.displayName,
    radiusMachineId: mapping.machineId,
    startUtc: active.startUtc,
    endUtc,
    durationSeconds: observedDurationSeconds,
    isOpen: completionStatus === 'OPEN',
    completionStatus,
    dataInterrupted: completionStatus === 'DATA_INTERRUPTED',
    startedAfterDataGap: active.startedAfterDataGap,
    startedBeforeRange: Date.parse(active.startUtc) < Date.parse(visibleFromUtc),
    startStatus: active.startStatus,
    statusSegments: active.segments,
    displaySegments: [...active.segments, ...(displayUnavailable ? [displayUnavailable] : [])],
    displayEndUtc,
    wallClockDurationSeconds: secondsBetween(active.startUtc, displayEndUtc ?? effectiveEndUtc),
    observedDurationSeconds,
    unavailableDurationSeconds: displayUnavailable?.durationSeconds ?? 0,
    returnToProductionAttemptCount: active.attempts,
    failedReturnToProductionAttempts: active.failedAttempts,
    confirmedProductionStartUtc,
    confirmationSatisfiedUtc,
    confirmationDurationSeconds:
      confirmedProductionStartUtc && confirmationSatisfiedUtc
        ? secondsBetween(confirmedProductionStartUtc, confirmationSatisfiedUtc)
        : 0,
    timeByEventType,
    timeByStatusDescription,
    primaryStatusDescription,
  }
}

export function deriveOperationalEpisodes(
  segments: RadiusStatusSegment[],
  mapping: RadiusPressMapping,
  visibleFromUtc: string,
  visibleToUtc: string,
): OperationalEpisode[] {
  const ordered = [...segments].sort(
    (left, right) => Date.parse(left.startUtc) - Date.parse(right.startUtc),
  )
  const episodes: OperationalEpisode[] = []
  let active: ActiveEpisode | undefined
  let nextObservationFollowsGap = false

  for (const segment of ordered) {
    if (segment.kind === 'offline') {
      if (active) {
        active.lastObservedUtc = segment.startUtc
        const episode = finalizeEpisode(
          active,
          mapping,
          visibleFromUtc,
          visibleToUtc,
          segment.startUtc,
          null,
          null,
          'DATA_INTERRUPTED',
          segment,
        )
        if (
          Date.parse(episode.startUtc) < Date.parse(visibleToUtc) &&
          Date.parse(episode.endUtc ?? visibleToUtc) >= Date.parse(visibleFromUtc)
        ) {
          episodes.push(episode)
        }
        active = undefined
      }
      nextObservationFollowsGap = true
      continue
    }

    if (!active) {
      if (segment.isProduction) {
        nextObservationFollowsGap = false
        continue
      }
      active = {
        startUtc: segment.startUtc,
        startStatus: segment.statusDescription,
        segments: [{ ...segment }],
        attempts: 0,
        failedAttempts: 0,
        lastObservedUtc: segment.endUtc,
        startedAfterDataGap: nextObservationFollowsGap,
      }
      nextObservationFollowsGap = false
      continue
    }

    active.lastObservedUtc = segment.endUtc

    if (!segment.isProduction) {
      const previous = active.segments.at(-1)
      if (previous?.isProduction && previous.returnToProduction === 'pending') {
        previous.returnToProduction = 'failed'
        active.failedAttempts += 1
      }
      active.segments.push({ ...segment })
      continue
    }

    active.attempts += 1
    const productionDurationMs =
      Date.parse(segment.endUtc) - Date.parse(segment.startUtc)

    if (productionDurationMs >= PRODUCTION_CONFIRMATION_MS) {
      const confirmationSatisfiedUtc = new Date(
        Date.parse(segment.startUtc) + PRODUCTION_CONFIRMATION_MS,
      ).toISOString()
      active.segments.push({
        ...segment,
        endUtc: confirmationSatisfiedUtc,
        durationSeconds: PRODUCTION_CONFIRMATION_MS / 1_000,
        returnToProduction: 'confirmed',
      })
      const episode = finalizeEpisode(
        active,
        mapping,
        visibleFromUtc,
        visibleToUtc,
        segment.startUtc,
        segment.startUtc,
        confirmationSatisfiedUtc,
        'CONFIRMED_PRODUCTION',
      )
      if (
        Date.parse(episode.startUtc) < Date.parse(visibleToUtc) &&
        Date.parse(episode.endUtc ?? visibleToUtc) >= Date.parse(visibleFromUtc)
      ) {
        episodes.push(episode)
      }
      active = undefined
      continue
    }

    active.segments.push({ ...segment, returnToProduction: 'pending' })
  }

  if (active) {
    const episode = finalizeEpisode(
      active,
      mapping,
      visibleFromUtc,
      visibleToUtc,
      null,
      null,
      null,
      'OPEN',
    )
    if (Date.parse(episode.startUtc) < Date.parse(visibleToUtc)) {
      episodes.push(episode)
    }
  }

  return episodes
}

export function clipSegmentsToRange(
  segments: RadiusStatusSegment[],
  fromUtc: string,
  toUtc: string,
): RadiusStatusSegment[] {
  const fromMs = Date.parse(fromUtc)
  const toMs = Date.parse(toUtc)

  return segments.flatMap((segment) => {
    const startMs = Math.max(fromMs, Date.parse(segment.startUtc))
    const endMs = Math.min(toMs, Date.parse(segment.endUtc))
    if (endMs <= startMs) return []
    return [
      {
        ...segment,
        startUtc: new Date(startMs).toISOString(),
        endUtc: new Date(endMs).toISOString(),
        durationSeconds: (endMs - startMs) / 1_000,
      },
    ]
  })
}
