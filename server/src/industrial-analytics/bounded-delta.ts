export interface BoundedDeltaPoint {
  atUtc: string
  value: number
  qualityState?: string
}

export type BoundedDeltaDirection = 'increase' | 'decrease' | 'either'
export type BoundedDeltaReferenceMode = 'ROLLING_EXTREME' | 'LATEST_AT_OR_BEFORE_WINDOW'

export interface BoundedDeltaCandidate<T extends BoundedDeltaPoint = BoundedDeltaPoint> {
  direction: 'increase' | 'decrease'
  reference: T
  trigger: T
  delta: number
  elapsedSeconds: number
  gapBefore: boolean
}

export interface BoundedDeltaStep<T extends BoundedDeltaPoint = BoundedDeltaPoint> {
  trigger: T
  candidate: BoundedDeltaCandidate<T> | null
  gapBefore: boolean
}

const unusable = (point: BoundedDeltaPoint) => {
  if (!Number.isFinite(Date.parse(point.atUtc)) || !Number.isFinite(point.value)) return true
  return /BAD|INVALID|UNAVAILABLE|NO_DATA|NODATA/i.test(point.qualityState ?? '')
}

export function boundedDeltaPoints<T extends BoundedDeltaPoint>(points: T[]): T[] {
  const byTimestamp = new Map<number, T>()
  for (const point of points.filter((item) => !unusable(item)).sort((left, right) => Date.parse(left.atUtc) - Date.parse(right.atUtc))) {
    byTimestamp.set(Date.parse(point.atUtc), point)
  }
  return [...byTimestamp.values()]
}

/**
 * Linear bounded Delta scan. ROLLING_EXTREME preserves Telemetry Event Explorer
 * semantics; LATEST_AT_OR_BEFORE_WINDOW preserves Temporal Evidence semantics.
 * References and triggers are always observed points—never interpolated.
 */
export function scanBoundedDeltas<T extends BoundedDeltaPoint>(input: {
  points: T[]
  windowMinutes: number
  direction?: BoundedDeltaDirection
  minimumAmount?: number
  referenceMode: BoundedDeltaReferenceMode
  gapLimitMs?: number
}): BoundedDeltaStep<T>[] {
  const points = boundedDeltaPoints(input.points)
  const windowMs = input.windowMinutes * 60_000
  const direction = input.direction ?? 'either'
  const amount = Math.max(0, input.minimumAmount ?? 0)
  const minimum: number[] = []
  const maximum: number[] = []
  let minHead = 0
  let maxHead = 0
  let latestReference = -1
  let segmentStart = 0
  const result: BoundedDeltaStep<T>[] = []

  for (let index = 0; index < points.length; index += 1) {
    const trigger = points[index]!
    const triggerMs = Date.parse(trigger.atUtc)
    const gapBefore = index > 0 && input.gapLimitMs !== undefined && triggerMs - Date.parse(points[index - 1]!.atUtc) > input.gapLimitMs
    if (gapBefore) {
      minimum.length = 0; maximum.length = 0; minHead = 0; maxHead = 0
      latestReference = index - 1
      segmentStart = index
    }

    let candidates: Array<BoundedDeltaCandidate<T>> = []
    if (input.referenceMode === 'LATEST_AT_OR_BEFORE_WINDOW') {
      const target = triggerMs - windowMs
      while (latestReference + 1 < index && Date.parse(points[latestReference + 1]!.atUtc) <= target) latestReference += 1
      if (latestReference >= segmentStart) {
        const reference = points[latestReference]!
        const delta = trigger.value - reference.value
        const candidateDirection = delta >= 0 ? 'increase' as const : 'decrease' as const
        if (Math.abs(delta) >= amount && (direction === 'either' || direction === candidateDirection)) candidates = [{ direction: candidateDirection, reference, trigger, delta, elapsedSeconds: (triggerMs - Date.parse(reference.atUtc)) / 1_000, gapBefore }]
      }
    } else {
      const floor = triggerMs - windowMs
      while (minHead < minimum.length && Date.parse(points[minimum[minHead]!]!.atUtc) < floor) minHead += 1
      while (maxHead < maximum.length && Date.parse(points[maximum[maxHead]!]!.atUtc) < floor) maxHead += 1
      const low = minHead < minimum.length ? points[minimum[minHead]!]! : undefined
      const high = maxHead < maximum.length ? points[maximum[maxHead]!]! : undefined
      if (low && (direction === 'increase' || direction === 'either')) {
        const delta = trigger.value - low.value
        if (delta >= amount) candidates.push({ direction: 'increase', reference: low, trigger, delta, elapsedSeconds: (triggerMs - Date.parse(low.atUtc)) / 1_000, gapBefore })
      }
      if (high && (direction === 'decrease' || direction === 'either')) {
        const magnitude = high.value - trigger.value
        if (magnitude >= amount) candidates.push({ direction: 'decrease', reference: high, trigger, delta: -magnitude, elapsedSeconds: (triggerMs - Date.parse(high.atUtc)) / 1_000, gapBefore })
      }
      candidates.sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta) || Date.parse(left.reference.atUtc) - Date.parse(right.reference.atUtc))
    }
    result.push({ trigger, candidate: candidates[0] ?? null, gapBefore })

    while (minimum.length > minHead && points[minimum.at(-1)!]!.value > trigger.value) minimum.pop()
    while (maximum.length > maxHead && points[maximum.at(-1)!]!.value < trigger.value) maximum.pop()
    minimum.push(index); maximum.push(index)
    if (minHead > 1_024) { minimum.splice(0, minHead); minHead = 0 }
    if (maxHead > 1_024) { maximum.splice(0, maxHead); maxHead = 0 }
  }
  return result
}

export function strongestBoundedDelta<T extends BoundedDeltaPoint>(input: {
  points: T[]
  windowMinutes: number
  referenceMode?: BoundedDeltaReferenceMode
  gapLimitMs?: number
}): BoundedDeltaCandidate<T> | null {
  return scanBoundedDeltas({ ...input, direction: 'either', minimumAmount: 0, referenceMode: input.referenceMode ?? 'LATEST_AT_OR_BEFORE_WINDOW' })
    .flatMap((step) => step.candidate ?? [])
    .reduce<BoundedDeltaCandidate<T> | null>((best, candidate) => !best || Math.abs(candidate.delta) > Math.abs(best.delta) ? candidate : best, null)
}
