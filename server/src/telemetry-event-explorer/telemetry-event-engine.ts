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
  const quality = observation.qualityState?.toUpperCase() ?? ''
  return !['BAD', 'INVALID', 'UNAVAILABLE', 'NO_DATA', 'NODATA'].some((token) => quality.includes(token))
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
  const median = gaps.length ? gaps[Math.floor((gaps.length - 1) / 2)]! : 0
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
    if (matches && !active) active = { startUtc: current.atUtc, entryValue: current.value, extremeValue: current.value, extremeAtUtc: current.atUtc, clippedStart: hasGap || !previous, dataGap: hasGap }
    else if (matches && active) {
      const moreExtreme = input.rule.operator === '>' || input.rule.operator === '>=' ? current.value > active.extremeValue : current.value < active.extremeValue
      if (moreExtreme) { active.extremeValue = current.value; active.extremeAtUtc = current.atUtc }
    } else if (!matches && active) finish(current.atUtc, current.value, false, false)
    previous = current
  }
  if (active) finish(input.toUtc, null, true, false)
  return result
}

interface DeltaCandidate {
  direction: 'increase' | 'decrease'
  baseline: NumericEventObservation
  actualDelta: number
  elapsedSeconds: number
}

function deltaCandidate(history: NumericEventObservation[], current: NumericEventObservation, rule: DeltaRule): DeltaCandidate | undefined {
  const currentMs = Date.parse(current.atUtc)
  const floor = currentMs - rule.windowMinutes * 60_000
  const prior = history.filter((item) => Date.parse(item.atUtc) >= floor && Date.parse(item.atUtc) < currentMs)
  if (!prior.length) return undefined
  const minimum = prior.reduce((best, item) => item.value < best.value ? item : best)
  const maximum = prior.reduce((best, item) => item.value > best.value ? item : best)
  const increase = current.value - minimum.value
  const decrease = maximum.value - current.value
  const candidates: DeltaCandidate[] = []
  if ((rule.direction === 'increase' || rule.direction === 'either') && increase >= rule.amount) candidates.push({ direction: 'increase', baseline: minimum, actualDelta: increase, elapsedSeconds: (currentMs - Date.parse(minimum.atUtc)) / 1_000 })
  if ((rule.direction === 'decrease' || rule.direction === 'either') && decrease >= rule.amount) candidates.push({ direction: 'decrease', baseline: maximum, actualDelta: -decrease, elapsedSeconds: (currentMs - Date.parse(maximum.atUtc)) / 1_000 })
  return candidates.sort((left, right) => Math.abs(right.actualDelta) - Math.abs(left.actualDelta) || Date.parse(left.baseline.atUtc) - Date.parse(right.baseline.atUtc))[0]
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
  const result: DeltaDetection[] = []
  let active: DeltaDetection | undefined
  let history: NumericEventObservation[] = []
  let previous: NumericEventObservation | undefined

  const finish = (endUtc: string, clippedEnd: boolean, dataGap: boolean) => {
    if (!active) return
    active.endUtc = endUtc; active.durationSeconds = Math.max(0, (Date.parse(endUtc) - Date.parse(active.startUtc)) / 1_000); active.clippedEnd = clippedEnd; active.dataGap ||= dataGap
    result.push(active); active = undefined
  }

  for (const current of values) {
    const currentMs = Date.parse(current.atUtc)
    const hasGap = Boolean(previous && currentMs - Date.parse(previous.atUtc) > gapLimit)
    if (hasGap) { if (active && previous) finish(previous.atUtc, true, true); history = [] }
    history = history.filter((item) => currentMs - Date.parse(item.atUtc) <= input.rule.windowMinutes * 60_000)
    const candidate = currentMs >= fromMs ? deltaCandidate(history, current, input.rule) : undefined
    if (!candidate) {
      if (active && currentMs >= fromMs) finish(current.atUtc, false, false)
    } else if (!active || active.direction !== candidate.direction) {
      if (active) finish(current.atUtc, false, false)
      active = {
        startUtc: candidate.baseline.atUtc, endUtc: current.atUtc, durationSeconds: candidate.elapsedSeconds,
        baselineAtUtc: candidate.baseline.atUtc, baselineValue: candidate.baseline.value,
        triggerAtUtc: current.atUtc, triggerValue: current.value, direction: candidate.direction,
        actualDelta: candidate.actualDelta, elapsedSeconds: candidate.elapsedSeconds,
        maximumExcursion: candidate.actualDelta, maximumExcursionAtUtc: current.atUtc,
        clippedEnd: false, dataGap: hasGap,
      }
    } else if (Math.abs(candidate.actualDelta) > Math.abs(active.maximumExcursion)) {
      active.maximumExcursion = candidate.actualDelta; active.maximumExcursionAtUtc = current.atUtc
    }
    history.push(current); previous = current
  }
  if (active) finish(input.toUtc, true, false)
  return result
}

function usableScalar(observation: ValueEventObservation): boolean {
  if (!Number.isFinite(Date.parse(observation.atUtc)) || !['number', 'boolean', 'string'].includes(typeof observation.value) || typeof observation.value === 'number' && !Number.isFinite(observation.value)) return false
  const quality = observation.qualityState?.toUpperCase() ?? ''
  return !['BAD', 'INVALID', 'UNAVAILABLE', 'NO_DATA', 'NODATA'].some((token) => quality.includes(token))
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
    if (matchesValueChange(previous.value, current.value, input.rule)) result.push({
      startUtc: current.atUtc, endUtc: current.atUtc, durationSeconds: 0,
      transitionAtUtc: current.atUtc, previousAtUtc: previous.atUtc,
      previousValue: previous.value, newValue: current.value,
      clippedStart: Date.parse(previous.atUtc) < fromMs, clippedEnd: false, dataGap,
    })
    previous = current
  }
  return result
}
