import { isGoodTelemetryQuality } from '../telemetry/historical-telemetry-policy.js'

export type ThresholdOperator = '>' | '>=' | '<' | '<='
export type DeltaDirection = 'increase' | 'decrease' | 'either'
export type EventScalarValue = number | boolean | string

export interface NumericEventObservation {
  atUtc: string
  value: number
  qualityState?: string
}

export interface ThresholdRule {
  operator: ThresholdOperator
  threshold: number
}

export interface DeltaRule {
  direction: DeltaDirection
  amount: number
  windowMinutes: number
}

export interface ValueChangeRule {
  match: 'any' | 'becomes' | 'from_to'
  becomesValue?: EventScalarValue
  fromValue?: EventScalarValue
  toValue?: EventScalarValue
}

export interface ValueEventObservation {
  atUtc: string
  value: EventScalarValue
  qualityState?: string
}

export interface ValueChangeDetection {
  startUtc: string
  endUtc: string
  durationSeconds: 0
  transitionAtUtc: string
  previousAtUtc: string | null
  previousValue: EventScalarValue
  newValue: EventScalarValue
  clippedStart: boolean
  clippedEnd: false
  dataGap: boolean
}

export interface ThresholdDetection {
  startUtc: string
  endUtc: string
  durationSeconds: number
  entryValue: number
  returnValue: number | null
  extremeValue: number
  extremeAtUtc: string
  clippedStart: boolean
  clippedEnd: boolean
  dataGap: boolean
}

export interface DeltaDetection {
  startUtc: string
  endUtc: string
  durationSeconds: number
  baselineAtUtc: string
  baselineValue: number
  triggerAtUtc: string
  triggerValue: number
  direction: Exclude<DeltaDirection, 'either'>
  actualDelta: number
  elapsedSeconds: number
  maximumExcursion: number
  maximumExcursionAtUtc: string
  clippedEnd: boolean
  dataGap: boolean
}

// TelemetryQueryApi can emit five-minute held observations with a few seconds of
// scheduling jitter. Match the application's established 330-second freshness
// boundary so those observations remain continuous without bridging real gaps.
const MINIMUM_SIGNIFICANT_GAP_MS = 330_000

function usable(observation: NumericEventObservation): boolean {
  if (!Number.isFinite(Date.parse(observation.atUtc)) || !Number.isFinite(observation.value)) return false
  return observation.qualityState === undefined || isGoodTelemetryQuality(observation.qualityState)
}

function observations(values: NumericEventObservation[]): NumericEventObservation[] {
  const ordered = values.filter(usable).map((value) => ({ ...value, atUtc: new Date(Date.parse(value.atUtc)).toISOString() })).sort((left, right) => Date.parse(left.atUtc) - Date.parse(right.atUtc))
  const deduplicated = new Map<number, NumericEventObservation>()
  for (const value of ordered) deduplicated.set(Date.parse(value.atUtc), value)
  return [...deduplicated.values()]
}

export function significantGapMs(values: NumericEventObservation[]): number {
  const ordered = observations(values)
  const gaps = ordered.slice(1).map((value, index) => Date.parse(value.atUtc) - Date.parse(ordered[index]!.atUtc)).filter((gap) => gap > 0).sort((a, b) => a - b)
  // Use the lower median so a single long outage cannot redefine normal cadence.
  // One interval cannot establish a slower normal cadence, so keep the known
  // freshness boundary until at least two intervals are available.
  const median = gaps.length > 1 ? gaps[Math.floor((gaps.length - 1) / 2)]! : 0
  return Math.max(MINIMUM_SIGNIFICANT_GAP_MS, median * 5)
}

export function thresholdMatches(value: number, rule: ThresholdRule): boolean {
  if (rule.operator === '>') return value > rule.threshold
  if (rule.operator === '>=') return value >= rule.threshold
  if (rule.operator === '<') return value < rule.threshold
  return value <= rule.threshold
}

export function detectThresholdEvents(input: {
  observations: NumericEventObservation[]
  fromUtc: string
  toUtc: string
  rule: ThresholdRule
  seed?: NumericEventObservation | null
}): ThresholdDetection[] {
  const fromMs = Date.parse(input.fromUtc); const toMs = Date.parse(input.toUtc)
  const inRange = observations(input.observations).filter((item) => Date.parse(item.atUtc) >= fromMs && Date.parse(item.atUtc) <= toMs)
  const seed = input.seed && usable(input.seed) && Date.parse(input.seed.atUtc) < fromMs ? { ...input.seed, atUtc: new Date(Date.parse(input.seed.atUtc)).toISOString() } : undefined
  const gapLimit = significantGapMs([...(seed ? [seed] : []), ...inRange])
  const result: ThresholdDetection[] = []
  let active: { startUtc: string; entryValue: number; extremeValue: number; extremeAtUtc: string; clippedStart: boolean; dataGap: boolean } | undefined
  let previous = seed
  let suppressMatchingReconnect = false

  const finish = (endUtc: string, returnValue: number | null, clippedEnd: boolean, dataGap: boolean) => {
    if (!active) return
    result.push({ ...active, endUtc, durationSeconds: Math.max(0, (Date.parse(endUtc) - Date.parse(active.startUtc)) / 1_000), returnValue, clippedEnd, dataGap: active.dataGap || dataGap })
    active = undefined
  }

  if (seed && thresholdMatches(seed.value, input.rule)) active = { startUtc: input.fromUtc, entryValue: seed.value, extremeValue: seed.value, extremeAtUtc: input.fromUtc, clippedStart: true, dataGap: false }
  for (const current of inRange) {
    const observedGap = previous ? Date.parse(current.atUtc) - Date.parse(previous.atUtc) : 0
    const hasGap = Boolean(previous && (observedGap > gapLimit || previous === seed && observedGap > MINIMUM_SIGNIFICANT_GAP_MS))
    if (hasGap && active && previous) {
      if (previous === seed && active.clippedStart && active.startUtc === input.fromUtc) active = undefined
      else finish(new Date(Math.max(Date.parse(previous.atUtc), Date.parse(active.startUtc))).toISOString(), null, true, true)
    }
    const matches = thresholdMatches(current.value, input.rule)
    if (hasGap) suppressMatchingReconnect = matches
    if (matches && !active && !suppressMatchingReconnect) active = { startUtc: current.atUtc, entryValue: current.value, extremeValue: current.value, extremeAtUtc: current.atUtc, clippedStart: !previous, dataGap: false }
    else if (matches && active) {
      const moreExtreme = input.rule.operator === '>' || input.rule.operator === '>=' ? current.value > active.extremeValue : current.value < active.extremeValue
      if (moreExtreme) { active.extremeValue = current.value; active.extremeAtUtc = current.atUtc }
    } else if (!matches) {
      suppressMatchingReconnect = false
      if (active) finish(current.atUtc, current.value, false, false)
    }
    previous = current
  }
  if (active) finish(input.toUtc, null, true, false)
  return result
}

export function detectDeltaEvents(input: {
  observations: NumericEventObservation[]
  fromUtc: string
  toUtc: string
  rule: DeltaRule
  seed?: NumericEventObservation | null
}): DeltaDetection[] {
  const fromMs = Date.parse(input.fromUtc); const toMs = Date.parse(input.toUtc)
  const values = observations([...(input.seed ? [input.seed] : []), ...input.observations]).filter((item) => Date.parse(item.atUtc) <= toMs)
  const gapLimit = significantGapMs(values)
  const steps = scanBoundedDeltas({ points: values, windowMinutes: input.rule.windowMinutes, direction: input.rule.direction, minimumAmount: input.rule.amount, referenceMode: 'ROLLING_EXTREME', gapLimitMs: gapLimit })
  const result: DeltaDetection[] = []
  let active: DeltaDetection | undefined
  let previous: NumericEventObservation | undefined

  const finish = (endUtc: string, clippedEnd: boolean, dataGap: boolean) => {
    if (!active) return
    active.endUtc = endUtc; active.durationSeconds = Math.max(0, (Date.parse(endUtc) - Date.parse(active.startUtc)) / 1_000); active.clippedEnd = clippedEnd; active.dataGap ||= dataGap
    result.push(active); active = undefined
  }

  for (const step of steps) {
    const current = step.trigger
    const currentMs = Date.parse(current.atUtc)
    const hasGap = step.gapBefore
    if (hasGap && active && previous) finish(previous.atUtc, true, true)
    const candidate = currentMs >= fromMs ? step.candidate : null
    if (!candidate) {
      if (active && currentMs >= fromMs) finish(current.atUtc, false, false)
    } else if (!active || active.direction !== candidate.direction) {
      if (active) finish(current.atUtc, false, false)
      active = {
        startUtc: candidate.reference.atUtc, endUtc: current.atUtc, durationSeconds: candidate.elapsedSeconds,
        baselineAtUtc: candidate.reference.atUtc, baselineValue: candidate.reference.value,
        triggerAtUtc: current.atUtc, triggerValue: current.value, direction: candidate.direction,
        actualDelta: candidate.delta, elapsedSeconds: candidate.elapsedSeconds,
        maximumExcursion: candidate.delta, maximumExcursionAtUtc: current.atUtc,
        clippedEnd: false, dataGap: hasGap,
      }
    } else if (Math.abs(candidate.delta) > Math.abs(active.maximumExcursion)) {
      active.maximumExcursion = candidate.delta; active.maximumExcursionAtUtc = current.atUtc
    }
    previous = current
  }
  if (active) finish(input.toUtc, true, false)
  return result
}

function usableScalar(observation: ValueEventObservation): boolean {
  if (!Number.isFinite(Date.parse(observation.atUtc)) || !['number', 'boolean', 'string'].includes(typeof observation.value) || typeof observation.value === 'number' && !Number.isFinite(observation.value)) return false
  return observation.qualityState === undefined || isGoodTelemetryQuality(observation.qualityState)
}

function scalarObservations(values: ValueEventObservation[]): ValueEventObservation[] {
  const byTimestamp = new Map<number, ValueEventObservation>()
  for (const item of values.filter(usableScalar).map((value) => ({ ...value, atUtc: new Date(Date.parse(value.atUtc)).toISOString() })).sort((a, b) => Date.parse(a.atUtc) - Date.parse(b.atUtc))) byTimestamp.set(Date.parse(item.atUtc), item)
  return [...byTimestamp.values()]
}

function sameScalar(left: EventScalarValue, right: EventScalarValue) {
  return typeof left === typeof right && Object.is(left, right)
}

function matchesValueChange(previousValue: EventScalarValue, newValue: EventScalarValue, rule: ValueChangeRule) {
  if (rule.match === 'any') return true
  if (rule.match === 'becomes') return rule.becomesValue !== undefined && sameScalar(newValue, rule.becomesValue)
  return rule.fromValue !== undefined && rule.toValue !== undefined && sameScalar(previousValue, rule.fromValue) && sameScalar(newValue, rule.toValue)
}

export function detectValueChangeEvents(input: {
  observations: ValueEventObservation[]
  fromUtc: string
  toUtc: string
  rule: ValueChangeRule
  seed?: ValueEventObservation | null
}): ValueChangeDetection[] {
  const fromMs = Date.parse(input.fromUtc); const toMs = Date.parse(input.toUtc)
  const seed = input.seed && usableScalar(input.seed) && Date.parse(input.seed.atUtc) < fromMs ? { ...input.seed, atUtc: new Date(Date.parse(input.seed.atUtc)).toISOString() } : undefined
  const inRange = scalarObservations(input.observations).filter(({ atUtc }) => Date.parse(atUtc) >= fromMs && Date.parse(atUtc) <= toMs)
  const cadenceValues = [...(seed ? [seed] : []), ...inRange].map(({ atUtc }) => ({ atUtc, value: 0 }))
  const gapLimit = significantGapMs(cadenceValues)
  const result: ValueChangeDetection[] = []
  let previous = seed
  for (const current of inRange) {
    if (!previous) { previous = current; continue }
    if (sameScalar(previous.value, current.value)) { previous = current; continue }
    const dataGap = Date.parse(current.atUtc) - Date.parse(previous.atUtc) > gapLimit
    if (dataGap) { previous = current; continue }
    if (matchesValueChange(previous.value, current.value, input.rule)) result.push({
      startUtc: current.atUtc, endUtc: current.atUtc, durationSeconds: 0,
      transitionAtUtc: current.atUtc, previousAtUtc: previous.atUtc,
      previousValue: previous.value, newValue: current.value,
      clippedStart: Date.parse(previous.atUtc) < fromMs, clippedEnd: false, dataGap: false,
    })
    previous = current
  }
  return result
}
import { scanBoundedDeltas } from '../industrial-analytics/bounded-delta.js'
