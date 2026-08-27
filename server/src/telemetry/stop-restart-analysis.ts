import type { TelemetrySample } from './telemetry-contracts.js'
import { isGoodTelemetryQuality } from './historical-telemetry-policy.js'

export const PHYSICAL_SPEED_POLICY = {
  stoppedBelow: 1,
  runningAt: 600,
  highSpeedAbove: 1000,
  stopSearchBeforeMs: 30 * 60_000,
  stopSearchAfterMs: 10 * 60_000,
  detailedWindowBeforeMs: 30 * 60_000,
  detailedWindowAfterMs: 90 * 60_000,
  sustainedRunningConfirmationMs: 120_000,
  speedContinuityMaximumGapMs: 330_000,
  speedAlignmentMaximumAgeMs: 180_000,
  stableRunningMinimumObservations: 3,
  stableRunningMinimumDurationMs: 120_000,
} as const

export const PRE_STOP_REFERENCE_POLICY = {
  referenceHours: 24,
  chunkHours: 2,
  maximumAutomaticCandidates: 12,
  maximumFlags: 5,
  minimumCurrentObservations: 3,
  minimumReferenceObservations: 20,
  lowerPercentile: 0.05,
  upperPercentile: 0.95,
  minimumRobustDeviation: 3,
  minimumRelativeShift: 0.1,
} as const

export const RESTART_EXCURSION_POLICY = {
  briefLowSpeedMaximumExclusive: 10,
  briefLowSpeedMaximumDurationMs: 30_000,
} as const

export type PhysicalSpeedBucket = 'STOPPED' | 'LOW_TRANSITION' | 'RUNNING' | 'HIGH_SPEED_RUNNING'
export type StopMatchStatus = 'MATCHED' | 'AMBIGUOUS' | 'NO_PHYSICAL_STOP_FOUND' | 'INSUFFICIENT_SPEED_EVIDENCE'

export interface NumericObservation { atUtc: string; value: number }
export interface DescriptiveStats { count: number; mean: number; median: number; p05: number; p25: number; p75: number; p95: number; iqr: number; minimum: number; maximum: number }
export interface PhysicalStopCandidate { atUtc: string; observedSpeed: number; previousObservedSpeed: number; radiusOffsetSeconds: number }
export interface PhysicalStopMatch { status: StopMatchStatus; selected: PhysicalStopCandidate | null; candidates: PhysicalStopCandidate[]; speedObservationCount: number }
export type RunningWindowSupportReason = 'SUPPORTED' | 'NO_RUNNING_SAMPLE' | 'INSUFFICIENT_OBSERVATIONS' | 'DURATION_BELOW_MINIMUM' | 'HISTORIAN_GAP_EXCEEDED'
export interface RunningWindow { supported: boolean; fromUtc: string | null; toUtc: string | null; durationSeconds: number | null; bucket: PhysicalSpeedBucket | null; stats: DescriptiveStats | null; changing: boolean | null; timeSincePreviousStoppedSeconds: number | null; observationCount: number; maximumGapSeconds: number | null; boundaryGapSeconds: number | null; supportReason: RunningWindowSupportReason }
export type RestartExcursionClassification = 'BRIEF_LOW_SPEED_EXCURSION' | 'RESTART_EXCURSION' | 'FAILED_RUNNING_ATTEMPT' | 'SUSTAINED_PHYSICAL_RUNNING_RESUMED'
export interface RestartAttempt { attempt: number; startUtc: string; endUtc: string | null; durationSeconds: number | null; maximumObservedSpeed: number; highestBucket: PhysicalSpeedBucket; speedObservationCount: number; reachedRunningAtOrAbove600: boolean; motionSupportsMovement: boolean | null; returnedToStopped: boolean; failedRunningAttempt: boolean; sustainedRunning: boolean; classification: RestartExcursionClassification; sustainedConfirmedAtUtc: string | null }
export interface StopPhases { stableRunningBefore: RunningWindow; lastRunningSampleBeforeStopUtc: string | null; deceleration: { fromUtc: string | null; toUtc: string | null }; stopped: { fromUtc: string; toUtc: string | null; durationSeconds: number | null }; restartAttempts: RestartAttempt[]; sustainedRunningAgain: RunningWindow; sustainedRunningReachedAtUtc: string | null; sustainedRunningConfirmedAtUtc: string | null }
export interface SpeedBucketReference { bucket: PhysicalSpeedBucket; stats: DescriptiveStats | null; observationCount: number; observedDurationSeconds: number; sharePercent: number; sustainedSpanCount: number }
export interface AlignedBucketValues { values: Record<PhysicalSpeedBucket, number[]>; excludedWithoutFreshSpeed: number }
export interface RadiusTimingObservation { occurrenceId: string; pressKey: string; displayName: string; matchStatus: StopMatchStatus; offsetSeconds: number | null }
export interface RadiusTimingSummary {
  occurrenceCount: number
  matchedCount: number
  beforeCount: number
  nearCount: number
  afterCount: number
  medianOffsetSeconds: number | null
  iqrSeconds: number | null
  minimumOffsetSeconds: number | null
  maximumOffsetSeconds: number | null
  byPress: Array<{ pressKey: string; displayName: string; occurrenceCount: number; matchedCount: number; medianOffsetSeconds: number | null; medianSupport: 'SUPPORTED' | 'INSUFFICIENT' }>
}

const BUCKET_ORDER: PhysicalSpeedBucket[] = ['STOPPED', 'LOW_TRANSITION', 'RUNNING', 'HIGH_SPEED_RUNNING']

export function physicalSpeedBucket(speed: number): PhysicalSpeedBucket {
  const absolute = Math.abs(speed)
  if (absolute < PHYSICAL_SPEED_POLICY.stoppedBelow) return 'STOPPED'
  if (absolute < PHYSICAL_SPEED_POLICY.runningAt) return 'LOW_TRANSITION'
  if (absolute <= PHYSICAL_SPEED_POLICY.highSpeedAbove) return 'RUNNING'
  return 'HIGH_SPEED_RUNNING'
}

export function numericObservations(samples: TelemetrySample[] | NumericObservation[]): NumericObservation[] {
  return samples.flatMap((sample) => {
    const value = 'value' in sample ? sample.value : undefined
    const atUtc = 'observedAtUtc' in sample ? sample.observedAtUtc : sample.atUtc
    const qualityUsable = !('qualityState' in sample) || isGoodTelemetryQuality(sample.qualityState)
    return qualityUsable && typeof value === 'number' && Number.isFinite(value) && Number.isFinite(Date.parse(atUtc)) ? [{ atUtc, value }] : []
  }).sort((left, right) => Date.parse(left.atUtc) - Date.parse(right.atUtc))
}

function percentile(sorted: number[], fraction: number): number {
  if (!sorted.length) return Number.NaN
  const position = (sorted.length - 1) * fraction
  const lower = Math.floor(position); const upper = Math.ceil(position)
  return lower === upper ? sorted[lower]! : sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower)
}

export function descriptiveStats(values: number[]): DescriptiveStats | null {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!sorted.length) return null
  const p25 = percentile(sorted, .25); const p75 = percentile(sorted, .75)
  return { count: sorted.length, mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length, median: percentile(sorted, .5), p05: percentile(sorted, .05), p25, p75, p95: percentile(sorted, .95), iqr: p75 - p25, minimum: sorted[0]!, maximum: sorted.at(-1)! }
}

function candidateScore(candidate: PhysicalStopCandidate): number {
  return Math.abs(candidate.radiusOffsetSeconds) + (candidate.radiusOffsetSeconds > 0 ? 180 : 0)
}

export function matchPhysicalStop(input: NumericObservation[], radiusStartUtc: string): PhysicalStopMatch {
  const samples = numericObservations(input)
  const radiusAt = Date.parse(radiusStartUtc)
  const from = radiusAt - PHYSICAL_SPEED_POLICY.stopSearchBeforeMs
  const to = radiusAt + PHYSICAL_SPEED_POLICY.stopSearchAfterMs
  const bounded = samples.filter(({ atUtc }) => Date.parse(atUtc) >= from && Date.parse(atUtc) <= to)
  if (bounded.length < 3 || !bounded.some(({ atUtc }) => Date.parse(atUtc) < radiusAt) || !bounded.some(({ atUtc }) => Date.parse(atUtc) >= radiusAt)) return { status: 'INSUFFICIENT_SPEED_EVIDENCE', selected: null, candidates: [], speedObservationCount: bounded.length }
  const candidates: PhysicalStopCandidate[] = []
  let runningSinceCandidate = true
  for (let index = 1; index < bounded.length; index += 1) {
    const previous = bounded[index - 1]!; const current = bounded[index]!
    if (physicalSpeedBucket(current.value) === 'RUNNING' || physicalSpeedBucket(current.value) === 'HIGH_SPEED_RUNNING') runningSinceCandidate = true
    if (physicalSpeedBucket(previous.value) !== 'STOPPED' && physicalSpeedBucket(current.value) === 'STOPPED' && (runningSinceCandidate || candidates.length === 0)) {
      candidates.push({ atUtc: current.atUtc, observedSpeed: current.value, previousObservedSpeed: previous.value, radiusOffsetSeconds: (Date.parse(current.atUtc) - radiusAt) / 1000 })
      runningSinceCandidate = false
    }
  }
  if (!candidates.length) return { status: 'NO_PHYSICAL_STOP_FOUND', selected: null, candidates, speedObservationCount: bounded.length }
  const ranked = [...candidates].sort((left, right) => candidateScore(left) - candidateScore(right) || Date.parse(right.atUtc) - Date.parse(left.atUtc))
  if (ranked.length > 1 && candidateScore(ranked[1]!) - candidateScore(ranked[0]!) <= 90) return { status: 'AMBIGUOUS', selected: null, candidates, speedObservationCount: bounded.length }
  return { status: 'MATCHED', selected: ranked[0]!, candidates, speedObservationCount: bounded.length }
}

function highestBucket(values: NumericObservation[]): PhysicalSpeedBucket {
  return values.reduce((best, item) => BUCKET_ORDER.indexOf(physicalSpeedBucket(item.value)) > BUCKET_ORDER.indexOf(best) ? physicalSpeedBucket(item.value) : best, 'STOPPED' as PhysicalSpeedBucket)
}

function runningWindow(samples: NumericObservation[], startIndex: number, direction: 1 | -1): RunningWindow {
  const empty = (): RunningWindow => ({ supported: false, fromUtc: null, toUtc: null, durationSeconds: null, bucket: null, stats: null, changing: null, timeSincePreviousStoppedSeconds: null, observationCount: 0, maximumGapSeconds: null, boundaryGapSeconds: null, supportReason: 'NO_RUNNING_SAMPLE' })
  if (startIndex < 0 || startIndex >= samples.length) return empty()
  const runningBucket = (value: number) => ['RUNNING', 'HIGH_SPEED_RUNNING'].includes(physicalSpeedBucket(value))
  if (!runningBucket(samples[startIndex]!.value)) return empty()
  let low = startIndex; let high = startIndex
  while (low > 0 && runningBucket(samples[low - 1]!.value) && Date.parse(samples[low]!.atUtc) - Date.parse(samples[low - 1]!.atUtc) <= PHYSICAL_SPEED_POLICY.speedContinuityMaximumGapMs) low -= 1
  while (high < samples.length - 1 && runningBucket(samples[high + 1]!.value) && Date.parse(samples[high + 1]!.atUtc) - Date.parse(samples[high]!.atUtc) <= PHYSICAL_SPEED_POLICY.speedContinuityMaximumGapMs) high += 1
  if (direction < 0) high = startIndex
  else low = startIndex
  const values = samples.slice(low, high + 1)
  const bucketCounts = values.reduce((counts, { value }) => { const bucket = physicalSpeedBucket(value) as 'RUNNING' | 'HIGH_SPEED_RUNNING'; counts[bucket] += 1; return counts }, { RUNNING: 0, HIGH_SPEED_RUNNING: 0 })
  const bucket: PhysicalSpeedBucket = bucketCounts.HIGH_SPEED_RUNNING > bucketCounts.RUNNING ? 'HIGH_SPEED_RUNNING' : 'RUNNING'
  const durationSeconds = Math.max(0, (Date.parse(values.at(-1)!.atUtc) - Date.parse(values[0]!.atUtc)) / 1000)
  const stats = descriptiveStats(values.map(({ value }) => value))
  const priorStopped = samples.slice(0, low).reverse().find(({ value }) => physicalSpeedBucket(value) === 'STOPPED')
  const gaps = values.slice(1).map((item, index) => (Date.parse(item.atUtc) - Date.parse(values[index]!.atUtc)) / 1000)
  const boundary = direction < 0 ? samples[low - 1] : samples[high + 1]
  const boundaryNeighbor = direction < 0 ? values[0] : values.at(-1)!
  const boundaryGapSeconds = boundary && runningBucket(boundary.value) ? Math.abs(Date.parse(boundaryNeighbor.atUtc) - Date.parse(boundary.atUtc)) / 1000 : null
  const supported = values.length >= PHYSICAL_SPEED_POLICY.stableRunningMinimumObservations && durationSeconds * 1000 >= PHYSICAL_SPEED_POLICY.stableRunningMinimumDurationMs
  const supportReason: RunningWindowSupportReason = supported ? 'SUPPORTED' : boundaryGapSeconds !== null && boundaryGapSeconds * 1000 > PHYSICAL_SPEED_POLICY.speedContinuityMaximumGapMs ? 'HISTORIAN_GAP_EXCEEDED' : values.length < PHYSICAL_SPEED_POLICY.stableRunningMinimumObservations ? 'INSUFFICIENT_OBSERVATIONS' : 'DURATION_BELOW_MINIMUM'
  return { supported, fromUtc: values[0]!.atUtc, toUtc: values.at(-1)!.atUtc, durationSeconds, bucket, stats, changing: stats ? stats.iqr > Math.max(5, Math.abs(stats.median) * .08) : null, timeSincePreviousStoppedSeconds: priorStopped ? (Date.parse(values[0]!.atUtc) - Date.parse(priorStopped.atUtc)) / 1000 : null, observationCount: values.length, maximumGapSeconds: gaps.length ? Math.max(...gaps) : null, boundaryGapSeconds, supportReason }
}

export function buildStopPhases(input: NumericObservation[], stop: PhysicalStopCandidate): StopPhases {
  const samples = numericObservations(input)
  const stopIndex = samples.findIndex(({ atUtc }) => atUtc === stop.atUtc)
  let lastRunning = stopIndex - 1
  while (lastRunning >= 0 && !['RUNNING', 'HIGH_SPEED_RUNNING'].includes(physicalSpeedBucket(samples[lastRunning]!.value))) lastRunning -= 1
  const stableRunningBefore = runningWindow(samples, lastRunning, -1)
  const decelerationStart = lastRunning >= 0 && lastRunning + 1 <= stopIndex ? samples[lastRunning + 1]!.atUtc : null
  const attempts: RestartAttempt[] = []
  let sustainedReachedAt: string | null = null; let sustainedConfirmedAt: string | null = null
  let cursor = stopIndex + 1
  while (cursor < samples.length) {
    while (cursor < samples.length && physicalSpeedBucket(samples[cursor]!.value) === 'STOPPED') cursor += 1
    if (cursor >= samples.length) break
    const start = cursor
    let end = cursor
    let confirmation: NumericObservation | undefined
    while (end < samples.length && physicalSpeedBucket(samples[end]!.value) !== 'STOPPED') {
      const current = samples[end]!
      if (physicalSpeedBucket(current.value) === 'RUNNING' || physicalSpeedBucket(current.value) === 'HIGH_SPEED_RUNNING') {
        const confirmed = samples.slice(end).find((candidate) => Date.parse(candidate.atUtc) - Date.parse(current.atUtc) >= PHYSICAL_SPEED_POLICY.sustainedRunningConfirmationMs && Date.parse(candidate.atUtc) - Date.parse(current.atUtc) <= PHYSICAL_SPEED_POLICY.sustainedRunningConfirmationMs + PHYSICAL_SPEED_POLICY.speedContinuityMaximumGapMs && samples.slice(end, samples.indexOf(candidate) + 1).every(({ value }) => ['RUNNING', 'HIGH_SPEED_RUNNING'].includes(physicalSpeedBucket(value))))
        if (confirmed) { confirmation = confirmed; sustainedReachedAt = current.atUtc; sustainedConfirmedAt = confirmed.atUtc; break }
      }
      end += 1
    }
    const values = samples.slice(start, confirmation ? samples.indexOf(confirmation) + 1 : Math.min(end + 1, samples.length))
    const returned = !confirmation && end < samples.length && physicalSpeedBucket(samples[end]!.value) === 'STOPPED'
    const endUtc = confirmation?.atUtc ?? (returned ? samples[end]!.atUtc : values.at(-1)?.atUtc ?? null)
    const durationSeconds = (Date.parse(endUtc ?? samples[start]!.atUtc) - Date.parse(samples[start]!.atUtc)) / 1000
    const maximumObservedSpeed = Math.max(...values.map(({ value }) => Math.abs(value)) )
    const reachedRunningAtOrAbove600 = values.some(({ value }) => Math.abs(value) >= PHYSICAL_SPEED_POLICY.runningAt)
    const failedRunningAttempt = returned && reachedRunningAtOrAbove600
    const classification: RestartExcursionClassification = confirmation ? 'SUSTAINED_PHYSICAL_RUNNING_RESUMED' : failedRunningAttempt ? 'FAILED_RUNNING_ATTEMPT' : returned && maximumObservedSpeed < RESTART_EXCURSION_POLICY.briefLowSpeedMaximumExclusive && durationSeconds * 1000 <= RESTART_EXCURSION_POLICY.briefLowSpeedMaximumDurationMs ? 'BRIEF_LOW_SPEED_EXCURSION' : 'RESTART_EXCURSION'
    attempts.push({ attempt: attempts.length + 1, startUtc: samples[start]!.atUtc, endUtc, durationSeconds, maximumObservedSpeed, highestBucket: highestBucket(values), speedObservationCount: values.length, reachedRunningAtOrAbove600, motionSupportsMovement: null, returnedToStopped: returned, failedRunningAttempt, sustainedRunning: Boolean(confirmation), classification, sustainedConfirmedAtUtc: confirmation?.atUtc ?? null })
    if (confirmation) break
    cursor = Math.max(end + 1, cursor + 1)
  }
  const sustainedIndex = sustainedReachedAt ? samples.findIndex(({ atUtc }) => atUtc === sustainedReachedAt) : -1
  const sustainedRunningAgain = runningWindow(samples, sustainedIndex, 1)
  const stoppedEnd = attempts[0]?.startUtc ?? null
  return { stableRunningBefore, lastRunningSampleBeforeStopUtc: lastRunning >= 0 ? samples[lastRunning]!.atUtc : null, deceleration: { fromUtc: decelerationStart, toUtc: stop.atUtc }, stopped: { fromUtc: stop.atUtc, toUtc: stoppedEnd, durationSeconds: stoppedEnd ? (Date.parse(stoppedEnd) - Date.parse(stop.atUtc)) / 1000 : null }, restartAttempts: attempts, sustainedRunningAgain, sustainedRunningReachedAtUtc: sustainedReachedAt, sustainedRunningConfirmedAtUtc: sustainedConfirmedAt }
}

export function alignSignalToSpeed(signal: NumericObservation[], speed: NumericObservation[]): AlignedBucketValues {
  const sortedSpeed = numericObservations(speed)
  const values: Record<PhysicalSpeedBucket, number[]> = { STOPPED: [], LOW_TRANSITION: [], RUNNING: [], HIGH_SPEED_RUNNING: [] }
  let excludedWithoutFreshSpeed = 0; let cursor = -1
  for (const sample of numericObservations(signal)) {
    const at = Date.parse(sample.atUtc)
    while (cursor + 1 < sortedSpeed.length && Date.parse(sortedSpeed[cursor + 1]!.atUtc) <= at) cursor += 1
    const observedSpeed = sortedSpeed[cursor]
    if (!observedSpeed || at - Date.parse(observedSpeed.atUtc) > PHYSICAL_SPEED_POLICY.speedAlignmentMaximumAgeMs) { excludedWithoutFreshSpeed += 1; continue }
    values[physicalSpeedBucket(observedSpeed.value)].push(sample.value)
  }
  return { values, excludedWithoutFreshSpeed }
}

export function speedBucketReferences(speed: NumericObservation[], fromUtc: string, toUtc: string): SpeedBucketReference[] {
  const samples = numericObservations(speed); const rangeMs = Math.max(1, Date.parse(toUtc) - Date.parse(fromUtc))
  return BUCKET_ORDER.map((bucket) => {
    const matching = samples.filter(({ value }) => physicalSpeedBucket(value) === bucket)
    let durationMs = 0; let spans = 0; let active = false
    for (let index = 0; index < samples.length - 1; index += 1) {
      const same = physicalSpeedBucket(samples[index]!.value) === bucket
      if (same && !active) { spans += 1; active = true } else if (!same) active = false
      if (same) durationMs += Math.min(PHYSICAL_SPEED_POLICY.speedContinuityMaximumGapMs, Math.max(0, Date.parse(samples[index + 1]!.atUtc) - Date.parse(samples[index]!.atUtc)))
    }
    return { bucket, stats: descriptiveStats(matching.map(({ value }) => value)), observationCount: matching.length, observedDurationSeconds: durationMs / 1000, sharePercent: durationMs / rangeMs * 100, sustainedSpanCount: spans }
  })
}

export function referenceDeviation(current: DescriptiveStats, reference: DescriptiveStats): { qualifies: boolean; direction: 'ABOVE' | 'BELOW' | null; robustDeviation: number; referencePercentile: number } {
  const direction = current.median > reference.p95 ? 'ABOVE' : current.median < reference.p05 ? 'BELOW' : null
  const scale = Math.max(reference.iqr, Math.abs(reference.median) * .05, 1e-9)
  const robustDeviation = Math.abs(current.median - reference.median) / scale
  const relativeShift = Math.abs(current.median - reference.median) / Math.max(Math.abs(reference.median), 1)
  const referencePercentile = current.median <= reference.p05 ? 5 : current.median >= reference.p95 ? 95 : 50
  return { qualifies: Boolean(direction) && robustDeviation >= PRE_STOP_REFERENCE_POLICY.minimumRobustDeviation && relativeShift >= PRE_STOP_REFERENCE_POLICY.minimumRelativeShift, direction, robustDeviation, referencePercentile }
}

export function summarizeRadiusTiming(observations: RadiusTimingObservation[]): RadiusTimingSummary {
  const offsets = observations.flatMap(({ matchStatus, offsetSeconds }) => matchStatus === 'MATCHED' && offsetSeconds !== null ? [offsetSeconds] : [])
  const stats = descriptiveStats(offsets)
  const presses = [...new Map(observations.map(({ pressKey, displayName }) => [pressKey, displayName])).entries()].map(([pressKey, displayName]) => {
    const values = observations.filter((item) => item.pressKey === pressKey)
    const matched = values.flatMap(({ matchStatus, offsetSeconds }) => matchStatus === 'MATCHED' && offsetSeconds !== null ? [offsetSeconds] : [])
    return { pressKey, displayName, occurrenceCount: values.length, matchedCount: matched.length, medianOffsetSeconds: matched.length >= 3 ? descriptiveStats(matched)!.median : null, medianSupport: matched.length >= 3 ? 'SUPPORTED' as const : 'INSUFFICIENT' as const }
  }).sort((left, right) => left.displayName.localeCompare(right.displayName, undefined, { numeric: true }))
  return {
    occurrenceCount: observations.length,
    matchedCount: offsets.length,
    beforeCount: offsets.filter((value) => value < -30).length,
    nearCount: offsets.filter((value) => Math.abs(value) <= 30).length,
    afterCount: offsets.filter((value) => value > 30).length,
    medianOffsetSeconds: stats?.median ?? null,
    iqrSeconds: stats?.iqr ?? null,
    minimumOffsetSeconds: stats?.minimum ?? null,
    maximumOffsetSeconds: stats?.maximum ?? null,
    byPress: presses,
  }
}
