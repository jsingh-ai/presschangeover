import type {
  RadiusAvailability,
  RadiusFeedStatus,
  LastRadiusStatus,
  RadiusObservation,
  RadiusPollRun,
  RadiusPressMapping,
  RadiusStateSegment,
  RadiusStatusSegment,
} from './models.js'

export const VERIFIED_PRODUCTION_STATUS_CODE = '150'

function secondsBetween(fromMs: number, toMs: number): number {
  return Math.max(0, (toMs - fromMs) / 1_000)
}

function offlineSegment(
  mapping: RadiusPressMapping,
  startMs: number,
  endMs: number,
  isOpen: boolean,
): RadiusStatusSegment {
  return {
    kind: 'offline',
    machineId: mapping.machineId,
    pressKey: mapping.pressKey,
    displayName: mapping.displayName,
    eventType: null,
    statusCode: null,
    statusDescription: null,
    startUtc: new Date(startMs).toISOString(),
    endUtc: new Date(endMs).toISOString(),
    durationSeconds: secondsBetween(startMs, endMs),
    isProduction: false,
    isOpen,
    sourceGeneration: 'offline_inference',
  }
}

function radiusSegment(
  mapping: RadiusPressMapping,
  observation: RadiusObservation,
  startMs: number,
  endMs: number,
  productionStatusDescription: string,
  productionEventType: string,
  productionStatusCode: string,
  isOpen: boolean,
): RadiusStateSegment {
  return {
    kind: 'radius',
    machineId: mapping.machineId,
    pressKey: mapping.pressKey,
    displayName: mapping.displayName,
    eventType: observation.eventType,
    statusCode: observation.statusCode,
    statusDescription: observation.statusDescription,
    startUtc: new Date(startMs).toISOString(),
    endUtc: new Date(endMs).toISOString(),
    durationSeconds: secondsBetween(startMs, endMs),
    isProduction:
      observation.eventType === productionEventType &&
      observation.statusCode === productionStatusCode &&
      observation.statusDescription === productionStatusDescription,
    isOpen,
    sourceGeneration:
      observation.sourceGeneration === 'current'
        ? 'compact'
        : observation.sourceGeneration,
  }
}

function appendSegment(
  segments: RadiusStatusSegment[],
  segment: RadiusStatusSegment,
): void {
  if (segment.durationSeconds <= 0) return
  const previous = segments.at(-1)
  const sameRadiusState =
    previous?.kind === 'radius' &&
    segment.kind === 'radius' &&
    previous.eventType === segment.eventType &&
    previous.statusCode === segment.statusCode &&
    previous.statusDescription === segment.statusDescription
  if (
    previous &&
    previous.kind === segment.kind &&
    (previous.kind === 'offline' || sameRadiusState) &&
    previous.endUtc === segment.startUtc
  ) {
    if (
      previous.kind === 'radius' &&
      segment.kind === 'radius' &&
      previous.sourceGeneration !== segment.sourceGeneration
    ) {
      previous.sourceGeneration = 'hybrid'
      if (previous.statusCode !== segment.statusCode) previous.statusCode = null
    }
    previous.endUtc = segment.endUtc
    previous.durationSeconds += segment.durationSeconds
    previous.isOpen = segment.isOpen
    return
  }
  segments.push(segment)
}

/**
 * Operational observations are sparse state transitions in the compact era.
 * Collector heartbeats, not transition frequency, determine data availability.
 * When heartbeats are omitted, observation timestamps retain the legacy behavior.
 */
export function buildRadiusAvailabilityTimeline(
  observations: RadiusObservation[],
  mapping: RadiusPressMapping,
  productionStatusDescription: string,
  timelineStartUtc: string,
  timelineEndUtc: string,
  staleSeconds: number,
  heartbeats?: Array<{ fetchedAtUtc: string }>,
  terminalIsOpen = true,
  productionEventType = 'G',
  productionStatusCode = VERIFIED_PRODUCTION_STATUS_CODE,
): RadiusStatusSegment[] {
  const startMs = Date.parse(timelineStartUtc)
  const endMs = Date.parse(timelineEndUtc)
  const staleMs = staleSeconds * 1_000
  const ordered = observations
    .filter(({ machineId }) => machineId === mapping.machineId)
    .filter(({ fetchedAtUtc }) => {
      const value = Date.parse(fetchedAtUtc)
      return Number.isFinite(value) && value < endMs
    })
    .sort(
      (left, right) =>
        Date.parse(left.fetchedAtUtc) - Date.parse(right.fetchedAtUtc),
    )

  if (endMs <= startMs) return []

  const heartbeatTimes = [
    ...new Set(
      (heartbeats ?? ordered)
        .map(({ fetchedAtUtc }) => Date.parse(fetchedAtUtc))
        .filter((value) => Number.isFinite(value) && value < endMs),
    ),
  ].sort((left, right) => left - right)
  const onlineWindows: Array<{ startMs: number; endMs: number }> = []
  for (let index = 0; index < heartbeatTimes.length; index += 1) {
    const heartbeatMs = heartbeatTimes[index]
    const nextMs = heartbeatTimes[index + 1] ?? endMs
    if (nextMs <= heartbeatMs) continue
    const trustedEndMs =
      nextMs - heartbeatMs > staleMs ? heartbeatMs + staleMs : nextMs
    const clippedStartMs = Math.max(startMs, heartbeatMs)
    const clippedEndMs = Math.min(endMs, trustedEndMs)
    if (clippedEndMs <= clippedStartMs) continue
    const previous = onlineWindows.at(-1)
    if (previous && previous.endMs === clippedStartMs) {
      previous.endMs = clippedEndMs
    } else {
      onlineWindows.push({ startMs: clippedStartMs, endMs: clippedEndMs })
    }
  }

  const breakpoints = new Set<number>([startMs, endMs])
  for (const observation of ordered) {
    const value = Date.parse(observation.fetchedAtUtc)
    if (value > startMs && value < endMs) breakpoints.add(value)
  }
  for (const window of onlineWindows) {
    breakpoints.add(window.startMs)
    breakpoints.add(window.endMs)
  }
  const boundaries = [...breakpoints].sort((left, right) => left - right)
  const segments: RadiusStatusSegment[] = []
  let observationIndex = -1
  let onlineIndex = 0

  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const intervalStartMs = boundaries[index]
    const intervalEndMs = boundaries[index + 1]
    while (
      observationIndex + 1 < ordered.length &&
      Date.parse(ordered[observationIndex + 1].fetchedAtUtc) <= intervalStartMs
    ) {
      observationIndex += 1
    }
    while (
      onlineIndex < onlineWindows.length &&
      onlineWindows[onlineIndex].endMs <= intervalStartMs
    ) {
      onlineIndex += 1
    }
    const isOnline =
      onlineIndex < onlineWindows.length &&
      onlineWindows[onlineIndex].startMs <= intervalStartMs &&
      onlineWindows[onlineIndex].endMs >= intervalEndMs
    const state = observationIndex >= 0 ? ordered[observationIndex] : undefined
    const isTerminal = intervalEndMs === endMs && terminalIsOpen
    appendSegment(
      segments,
      isOnline && state
        ? radiusSegment(
            mapping,
            state,
            intervalStartMs,
            intervalEndMs,
            productionStatusDescription,
            productionEventType,
            productionStatusCode,
            isTerminal,
          )
        : offlineSegment(
            mapping,
            intervalStartMs,
            intervalEndMs,
            isTerminal,
          ),
    )
  }
  return segments
}

export interface CurrentRadiusAvailability {
  availability: RadiusAvailability
  lastRadiusStatus: LastRadiusStatus | null
  lastObservationUtc: string | null
  offlineSinceUtc: string | null
  currentStatusDescription: string | null
  currentEventType: string | null
  currentStatusAtUtc: string | null
  isCurrentlyProduction: boolean | null
}

export function deriveCurrentRadiusAvailability(
  observations: RadiusObservation[],
  evaluationUtc: string,
  fallbackOfflineStartUtc: string,
  staleSeconds: number,
  productionStatusDescription: string,
  heartbeatUtc?: string | null,
  currentState?: RadiusObservation | null,
  isPresent = true,
  productionEventType = 'G',
  productionStatusCode = VERIFIED_PRODUCTION_STATUS_CODE,
): CurrentRadiusAvailability {
  const evaluationMs = Date.parse(evaluationUtc)
  const currentObservation = [...observations]
    .filter((observation) => Date.parse(observation.fetchedAtUtc) <= evaluationMs)
    .sort(
      (left, right) =>
        Date.parse(right.fetchedAtUtc) - Date.parse(left.fetchedAtUtc),
    )[0]
  const stateObservation = currentState ?? currentObservation
  const freshnessTimestamp = heartbeatUtc ?? currentObservation?.fetchedAtUtc
  const isFresh =
    isPresent &&
    stateObservation !== undefined &&
    freshnessTimestamp !== undefined &&
    freshnessTimestamp !== null &&
    evaluationMs - Date.parse(freshnessTimestamp) <=
      staleSeconds * 1_000
  const availability: RadiusAvailability = isFresh ? 'online' : 'offline'
  return {
    availability,
    lastRadiusStatus: stateObservation
        ? {
          eventType: stateObservation.eventType,
          statusCode: stateObservation.statusCode,
          statusDescription: stateObservation.statusDescription,
          observedAtUtc: stateObservation.fetchedAtUtc,
        }
      : null,
    lastObservationUtc: freshnessTimestamp ?? null,
    offlineSinceUtc:
      availability === 'offline'
        ? freshnessTimestamp
          ? isPresent
            ? new Date(
                Date.parse(freshnessTimestamp) + staleSeconds * 1_000,
              ).toISOString()
            : new Date(Date.parse(freshnessTimestamp)).toISOString()
          : fallbackOfflineStartUtc
        : null,
    currentStatusDescription: isFresh
      ? stateObservation.statusDescription
      : null,
    currentEventType: isFresh ? stateObservation.eventType : null,
    currentStatusAtUtc: isFresh ? stateObservation.fetchedAtUtc : null,
    isCurrentlyProduction: isFresh
      ? stateObservation.eventType === productionEventType &&
        stateObservation.statusCode === productionStatusCode &&
        stateObservation.statusDescription === productionStatusDescription
      : null,
  }
}

export interface AvailabilityMetrics {
  runProductionSeconds: number
  nonProductionSeconds: number
  offlineSeconds: number
  observedSeconds: number
  rangeSeconds: number
  dataCoveragePercent: number
}

export function summarizeAvailabilityMetrics(
  segments: RadiusStatusSegment[],
  rangeSeconds: number,
): AvailabilityMetrics {
  const runProductionSeconds = segments
    .filter(
      (segment): segment is RadiusStateSegment =>
        segment.kind === 'radius' && segment.isProduction,
    )
    .reduce((total, segment) => total + segment.durationSeconds, 0)
  const nonProductionSeconds = segments
    .filter(
      (segment): segment is RadiusStateSegment =>
        segment.kind === 'radius' && !segment.isProduction,
    )
    .reduce((total, segment) => total + segment.durationSeconds, 0)
  const observedSeconds = Math.min(
    Math.max(0, rangeSeconds),
    runProductionSeconds + nonProductionSeconds,
  )
  const offlineSeconds = Math.max(0, rangeSeconds - observedSeconds)
  return {
    runProductionSeconds,
    nonProductionSeconds,
    offlineSeconds,
    observedSeconds,
    rangeSeconds,
    dataCoveragePercent:
      rangeSeconds <= 0 ? 0 : (observedSeconds / rangeSeconds) * 100,
  }
}

export function deriveRadiusFeedStatus(
  availabilities: RadiusAvailability[],
): RadiusFeedStatus {
  const online = availabilities.filter((value) => value === 'online').length
  if (online === availabilities.length && online > 0) return 'ONLINE'
  if (online === 0) return 'OFFLINE'
  return 'DEGRADED'
}

export function deriveRadiusFeedStatusFromPoll(
  pollRun: RadiusPollRun | undefined,
  evaluationUtc: string,
  staleSeconds: number,
  expectedMachineCount: number,
): RadiusFeedStatus {
  if (
    !pollRun ||
    Date.parse(evaluationUtc) - Date.parse(pollRun.fetchedAtUtc) >
      staleSeconds * 1_000
  ) {
    return 'OFFLINE'
  }
  if (
    pollRun.machineCount < expectedMachineCount ||
    pollRun.staleMachineCount > 0
  ) {
    return 'DEGRADED'
  }
  return 'ONLINE'
}
