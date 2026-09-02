import {
  STOP_INTELLIGENCE_ALGORITHM_VERSION,
  STOP_INTELLIGENCE_CONFIG_VERSION,
  type CanonicalSpeedObservation,
  type FailedRecoveryStreak,
  type MovementAttempt,
  type NormalizedSpeedQuality,
  type PhysicalStopAnalysis,
  type PhysicalStopAnalysisInput,
  type PhysicalStopSegment,
  type StopCensorReason,
  type TelemetryAvailabilityInterval,
} from './contracts.js'
import { normalizeTelemetryQuality } from '../telemetry/historical-telemetry-policy.js'

const millisecondsPerSecond = 1_000

type UnavailableState = Exclude<StopCensorReason, 'RANGE_START' | 'RANGE_END'>
type KnownSpeed = { kind: 'known'; speed: number }
type UnknownSpeed = { kind: 'unknown'; reason: UnavailableState }
type SpeedState = KnownSpeed | UnknownSpeed | undefined

interface AttemptAccumulator {
  start: number
  startSpeed: number
  sequenceNumber: number
  weightedSpeed: number
  observedMilliseconds: number
  peakSpeed: number
  reachedRecoveryThreshold: boolean
  failedRecoveryCount: number
}

interface RecoveryCandidate {
  start: number
  attempt: AttemptAccumulator
  pending: Array<{ speed: number; milliseconds: number }>
}

interface SegmentAccumulator {
  start: number
  leftCensored: boolean
  leftCensorReason: StopCensorReason | null
  physicalMilliseconds: number
  zeroMilliseconds: number
  lowMovementMilliseconds: number
  attempt: AttemptAccumulator | undefined
  movementAttempts: MovementAttempt[]
  failedRecoveryStreaks: FailedRecoveryStreak[]
  recovery: RecoveryCandidate | undefined
}

type TimelineEvent =
  | { at: number; kind: 'unavailable-start'; reason: UnavailableState }
  | { at: number; kind: 'unavailable-end' }
  | { at: number; kind: 'observation'; observation: CanonicalSpeedObservation }

function iso(value: number) { return new Date(value).toISOString() }
function seconds(value: number) { return value / millisecondsPerSecond }
function parsedTime(value: string) { const result = Date.parse(value); return Number.isFinite(result) ? result : undefined }

export function normalizeSpeedQuality(value: string): NormalizedSpeedQuality {
  return normalizeTelemetryQuality(value)
}

function validObservation(observation: CanonicalSpeedObservation): observation is CanonicalSpeedObservation & { speed: number } {
  return typeof observation.speed === 'number' && Number.isFinite(observation.speed) && normalizeSpeedQuality(observation.qualityState) === 'GOOD'
}

function normalizeAvailability(intervals: TelemetryAvailabilityInterval[], from: number, to: number): TelemetryAvailabilityInterval[] {
  const ordered = intervals.flatMap((interval) => {
    const start = parsedTime(interval.fromUtc); const end = parsedTime(interval.toUtc)
    if (start === undefined || end === undefined || end <= start) return []
    const clippedStart = Math.max(from, start); const clippedEnd = Math.min(to, end)
    return clippedEnd > clippedStart ? [{ ...interval, fromUtc: iso(clippedStart), toUtc: iso(clippedEnd) }] : []
  }).sort((left, right) => Date.parse(left.fromUtc) - Date.parse(right.fromUtc))
  const result: TelemetryAvailabilityInterval[] = []
  for (const interval of ordered) {
    const prior = result.at(-1)
    if (prior && prior.state === interval.state && Date.parse(interval.fromUtc) <= Date.parse(prior.toUtc)) {
      prior.toUtc = iso(Math.max(Date.parse(prior.toUtc), Date.parse(interval.toUtc)))
    } else result.push({ ...interval })
  }
  return result
}

type BridgeableSpeedState = 'STOPPED' | 'RUNNING'

function bridgeableSpeedState(observation: CanonicalSpeedObservation, input: PhysicalStopAnalysisInput): BridgeableSpeedState | null {
  if (!validObservation(observation)) return null
  if (observation.speed < input.configuration.stopThreshold) return 'STOPPED'
  if (observation.speed >= input.configuration.recoveryThreshold) return 'RUNNING'
  return null
}

function speedQualityAvailability(observations: CanonicalSpeedObservation[], from: number, to: number): TelemetryAvailabilityInterval[] {
  const ordered = observations.filter((item) => parsedTime(item.atUtc) !== undefined).sort((left, right) => Date.parse(left.atUtc) - Date.parse(right.atUtc))
  const intervals: TelemetryAvailabilityInterval[] = []
  for (let index = 0; index < ordered.length; index += 1) {
    const observation = ordered[index]!
    if (validObservation(observation)) continue
    const nextGood = ordered.slice(index + 1).find(validObservation)
    const start = Math.max(from, Date.parse(observation.atUtc)); const end = Math.min(to, nextGood ? Date.parse(nextGood.atUtc) : to)
    if (end > start) intervals.push({ fromUtc: iso(start), toUtc: iso(end), state: 'UNKNOWN_SPEED_QUALITY' })
  }
  return intervals
}

export function bridgeMatchingSpeedStateEvidence(input: PhysicalStopAnalysisInput): { observations: CanonicalSpeedObservation[]; availabilityIntervals: TelemetryAvailabilityInterval[]; bridgedIntervals: TelemetryAvailabilityInterval[] } {
  const from = parsedTime(input.fromUtc); const to = parsedTime(input.toUtc)
  if (from === undefined || to === undefined || to <= from) throw new Error('invalid_stop_intelligence_range')
  const observations = input.observations.filter((item) => parsedTime(item.atUtc) !== undefined).sort((left, right) => Date.parse(left.atUtc) - Date.parse(right.atUtc))
  const good = observations.filter(validObservation)
  const unavailable = normalizeAvailability([...(input.availabilityIntervals ?? []), ...speedQualityAvailability(observations, from, to)], from, to)
  const maximumGapMs = input.configuration.matchingStateGapBridgeSeconds * millisecondsPerSecond
  const bridgedIntervals = unavailable.filter((interval) => {
    const start = Date.parse(interval.fromUtc); const end = Date.parse(interval.toUtc)
    if (end - start >= maximumGapMs) return false
    const before = good.filter((item) => Date.parse(item.atUtc) < start).at(-1)
    const after = good.find((item) => Date.parse(item.atUtc) >= end)
    if (!before || !after) return false
    const beforeState = bridgeableSpeedState(before, input)
    return beforeState !== null && beforeState === bridgeableSpeedState(after, input)
  })
  const retainedIntervals = unavailable.filter((interval) => !bridgedIntervals.includes(interval))
  const retainedObservations = observations.filter((observation) => validObservation(observation) || !bridgedIntervals.some((interval) => {
    const at = Date.parse(observation.atUtc)
    return at >= Date.parse(interval.fromUtc) && at < Date.parse(interval.toUtc)
  }))
  return { observations: retainedObservations, availabilityIntervals: retainedIntervals, bridgedIntervals }
}

function unavailableReason(state: TelemetryAvailabilityInterval['state']): UnavailableState {
  return state
}

function isInsideUnavailable(at: number, intervals: TelemetryAvailabilityInterval[]) {
  return intervals.some((interval) => at >= Date.parse(interval.fromUtc) && at < Date.parse(interval.toUtc))
}

function createEvents(input: PhysicalStopAnalysisInput, from: number, to: number): TimelineEvent[] {
  const intervals = normalizeAvailability(input.availabilityIntervals ?? [], from, to)
  const events: TimelineEvent[] = [
    ...intervals.flatMap((interval): TimelineEvent[] => [
      { at: Date.parse(interval.fromUtc), kind: 'unavailable-start', reason: unavailableReason(interval.state) },
      { at: Date.parse(interval.toUtc), kind: 'unavailable-end' },
    ]),
    ...input.observations.flatMap((observation): TimelineEvent[] => {
      const at = parsedTime(observation.atUtc)
      if (at === undefined || at < from || at > to || isInsideUnavailable(at, intervals)) return []
      return [{ at, kind: 'observation', observation }]
    }),
  ]
  const priority: Record<TimelineEvent['kind'], number> = { 'unavailable-start': 0, 'unavailable-end': 1, observation: 2 }
  return events.sort((left, right) => left.at - right.at || priority[left.kind] - priority[right.kind])
}

function addAttemptTime(attempt: AttemptAccumulator, speed: number, milliseconds: number) {
  if (milliseconds <= 0) return
  attempt.weightedSpeed += speed * milliseconds
  attempt.observedMilliseconds += milliseconds
  attempt.peakSpeed = Math.max(attempt.peakSpeed, speed)
}

function finishAttempt(segment: SegmentAccumulator, attempt: AttemptAccumulator, end: number): void {
  const durationMilliseconds = Math.max(0, end - attempt.start)
  segment.movementAttempts.push({
    startAt: iso(attempt.start),
    endAt: iso(end),
    durationSeconds: seconds(durationMilliseconds),
    averageSpeed: attempt.observedMilliseconds ? attempt.weightedSpeed / attempt.observedMilliseconds : attempt.startSpeed,
    peakSpeed: attempt.peakSpeed,
    reachedRecoveryThreshold: attempt.reachedRecoveryThreshold,
    failedRecoveryCount: attempt.failedRecoveryCount,
    sequenceNumber: attempt.sequenceNumber,
  })
}

function addSegmentTime(segment: SegmentAccumulator, speed: number, milliseconds: number, configuration: PhysicalStopAnalysisInput['configuration']) {
  if (milliseconds <= 0) return
  segment.physicalMilliseconds += milliseconds
  if (speed < configuration.stopThreshold) segment.zeroMilliseconds += milliseconds
  else if (speed < configuration.recoveryThreshold) segment.lowMovementMilliseconds += milliseconds
  if (segment.attempt) addAttemptTime(segment.attempt, speed, milliseconds)
}

function startAttempt(segment: SegmentAccumulator, at: number, speed: number): AttemptAccumulator {
  const attempt: AttemptAccumulator = {
    start: at,
    startSpeed: speed,
    sequenceNumber: segment.movementAttempts.length + 1,
    weightedSpeed: 0,
    observedMilliseconds: 0,
    peakSpeed: speed,
    reachedRecoveryThreshold: false,
    failedRecoveryCount: 0,
  }
  segment.attempt = attempt
  return attempt
}

function startSegment(at: number, leftCensored: boolean, leftCensorReason: StopCensorReason | null): SegmentAccumulator {
  return {
    start: at,
    leftCensored,
    leftCensorReason,
    physicalMilliseconds: 0,
    zeroMilliseconds: 0,
    lowMovementMilliseconds: 0,
    attempt: undefined,
    movementAttempts: [],
    failedRecoveryStreaks: [],
    recovery: undefined,
  }
}

function finalizeSegment(segment: SegmentAccumulator, end: number | null, rightCensorReason: StopCensorReason | null, input: PhysicalStopAnalysisInput): PhysicalStopSegment {
  if (segment.attempt) {
    finishAttempt(segment, segment.attempt, end === null ? Date.parse(input.toUtc) : end)
    segment.attempt = undefined
  }
  return {
    pressKey: input.configuration.pressKey,
    sourceId: input.configuration.sourceId,
    speedSignalId: input.configuration.canonicalSpeedSignalId,
    startAt: iso(segment.start),
    endAt: end === null ? null : iso(end),
    leftCensored: segment.leftCensored,
    rightCensored: rightCensorReason !== null,
    leftCensorReason: segment.leftCensorReason,
    rightCensorReason,
    physicalDurationSeconds: seconds(segment.physicalMilliseconds),
    zeroSpeedSeconds: seconds(segment.zeroMilliseconds),
    lowMovementSeconds: seconds(segment.lowMovementMilliseconds),
    movementAttempts: segment.movementAttempts,
    failedRecoveryCount: segment.failedRecoveryStreaks.length,
    failedRecoveryStreaks: segment.failedRecoveryStreaks,
    algorithmVersion: STOP_INTELLIGENCE_ALGORITHM_VERSION,
    configVersion: STOP_INTELLIGENCE_CONFIG_VERSION,
  }
}

function failRecovery(segment: SegmentAccumulator, at: number, reason: FailedRecoveryStreak['reason'], configuration: PhysicalStopAnalysisInput['configuration']) {
  const recovery = segment.recovery
  if (!recovery) return
  const duration = recovery.pending.reduce((sum, item) => sum + item.milliseconds, 0)
  for (const item of recovery.pending) addSegmentTime(segment, item.speed, item.milliseconds, configuration)
  recovery.attempt.reachedRecoveryThreshold = true
  recovery.attempt.failedRecoveryCount += 1
  segment.failedRecoveryStreaks.push({
    startAt: iso(recovery.start),
    endAt: iso(at),
    durationSeconds: seconds(duration),
    reason,
    movementAttemptSequenceNumber: recovery.attempt.sequenceNumber,
  })
  segment.recovery = undefined
}

function retainUnconfirmedRecoveryTime(segment: SegmentAccumulator, configuration: PhysicalStopAnalysisInput['configuration']) {
  const recovery = segment.recovery
  if (!recovery) return
  for (const item of recovery.pending) addSegmentTime(segment, item.speed, item.milliseconds, configuration)
  segment.recovery = undefined
}

/**
 * Reconstructs physical stops from ordered, transition-first canonical speed
 * observations. It never bridges an explicit unavailable interval.
 */
export function analyzePhysicalStops(input: PhysicalStopAnalysisInput): PhysicalStopAnalysis {
  const from = parsedTime(input.fromUtc); const to = parsedTime(input.toUtc)
  if (from === undefined || to === undefined || to <= from) throw new Error('invalid_stop_intelligence_range')
  const bridged = bridgeMatchingSpeedStateEvidence(input)
  const events = createEvents({ ...input, observations: bridged.observations, availabilityIntervals: bridged.availabilityIntervals }, from, to)
  const segments: PhysicalStopSegment[] = []
  let state: SpeedState
  let stateAt = from
  let active: SegmentAccumulator | undefined
  let observedBeforeStart = false

  const integrateUntil = (at: number) => {
    if (!active || !state || state.kind !== 'known' || at <= stateAt) return
    if (active.recovery) {
      active.recovery.pending.push({ speed: state.speed, milliseconds: at - stateAt })
      return
    }
    addSegmentTime(active, state.speed, at - stateAt, input.configuration)
  }

  const closeForUnavailable = (at: number, reason: UnavailableState) => {
    if (!active) return
    if (active.recovery) failRecovery(active, at, 'TELEMETRY_UNAVAILABLE', input.configuration)
    if (active.attempt) {
      finishAttempt(active, active.attempt, at)
      active.attempt = undefined
    }
    segments.push(finalizeSegment(active, at, reason, input))
    active = undefined
  }

  for (const event of events) {
    integrateUntil(event.at)
    if (event.kind === 'unavailable-start') {
      closeForUnavailable(event.at, event.reason)
      state = { kind: 'unknown', reason: event.reason }
      stateAt = event.at
      continue
    }
    if (event.kind === 'unavailable-end') {
      state = state?.kind === 'unknown' ? state : undefined
      stateAt = event.at
      continue
    }

    const observation = event.observation
    if (!validObservation(observation)) {
      closeForUnavailable(event.at, 'UNKNOWN_SPEED_QUALITY')
      state = { kind: 'unknown', reason: 'UNKNOWN_SPEED_QUALITY' }
      stateAt = event.at
      observedBeforeStart = true
      continue
    }

    const prior = state
    const priorWasStopped = prior?.kind === 'known' && prior.speed < input.configuration.stopThreshold
    if (active?.recovery && observation.speed < input.configuration.recoveryThreshold) failRecovery(active, event.at, 'DROPPED_BELOW_RECOVERY', input.configuration)

    if (!active && observation.speed < input.configuration.stopThreshold) {
      const wasUnknown = !prior || prior.kind === 'unknown'
      const leftCensorReason = wasUnknown ? (!observedBeforeStart ? 'RANGE_START' : prior?.kind === 'unknown' ? prior.reason : 'RANGE_START') : null
      active = startSegment(event.at, wasUnknown, leftCensorReason)
    }

    if (active) {
      if (!active.attempt && observation.speed >= input.configuration.stopThreshold && priorWasStopped) startAttempt(active, event.at, observation.speed)
      if (active.attempt && observation.speed >= input.configuration.recoveryThreshold && !active.recovery) {
        active.attempt.reachedRecoveryThreshold = true
        active.recovery = { start: event.at, attempt: active.attempt, pending: [] }
      }
      if (active.attempt && observation.speed < input.configuration.stopThreshold) {
        finishAttempt(active, active.attempt, event.at)
        active.attempt = undefined
      }
      if (active.recovery && event.at - active.recovery.start >= input.configuration.recoveryConfirmationSeconds * millisecondsPerSecond && observation.speed >= input.configuration.recoveryThreshold) {
        const recoveryStart = active.recovery.start
        const attempt = active.recovery.attempt
        finishAttempt(active, attempt, recoveryStart)
        active.attempt = undefined
        segments.push(finalizeSegment(active, recoveryStart, null, input))
        active = undefined
      }
    }

    state = { kind: 'known', speed: observation.speed }
    stateAt = event.at
    observedBeforeStart = true
  }

  if (active) {
    integrateUntil(to)
    if (active.recovery) {
      // The range ended before recovery was proven; preserve observed movement without calling it failed.
      retainUnconfirmedRecoveryTime(active, input.configuration)
    }
    segments.push(finalizeSegment(active, null, 'RANGE_END', input))
  }

  return { configuration: input.configuration, fromUtc: input.fromUtc, toUtc: input.toUtc, segments }
}
