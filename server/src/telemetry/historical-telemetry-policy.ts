import type { PhysicalState, PhysicalStateResponse, PhysicalStateSegment } from './models.js'
import type {
  HistoricalTelemetryAvailability,
  HistoricalTelemetryAvailabilityInterval,
  PressSemanticSignalEvidence,
  RawHistoryAvailability,
  TelemetrySample,
  TelemetrySourceEvidenceGap,
} from './telemetry-contracts.js'

export type NormalizedTelemetryQuality = 'GOOD' | 'BAD'

export function normalizeTelemetryQuality(value: string | null | undefined): NormalizedTelemetryQuality {
  const normalized = value?.trim().toLowerCase()
  return normalized === 'true' || normalized === 'good' ? 'GOOD' : 'BAD'
}

export function isGoodTelemetryQuality(value: string | null | undefined): boolean {
  return normalizeTelemetryQuality(value) === 'GOOD'
}

function pointTime(value: { observedAtUtc: string }) { return Date.parse(value.observedAtUtc) }
function lowerMedian(values: number[]) { const ordered = [...values].sort((a, b) => a - b); return ordered[Math.floor((ordered.length - 1) / 2)]! }

const HISTORIAN_HEARTBEAT_JITTER_MS = 30_000
const HISTORIAN_MINIMUM_SILENCE_MS = 330_000

/**
 * Finds a source-specific silence only when at least two independently
 * recorded sample histories corroborate the same missing-heartbeat interval.
 * Transition/change rows are intentionally excluded because a quiet signal is
 * valid transition-first history. No 30-second staleness rule is applied.
 */
export function sourceTelemetryUnavailableGaps(signals: Array<Pick<PressSemanticSignalEvidence, 'samples'>>, range: { start: string; end: string }): TelemetrySourceEvidenceGap[] {
  const rangeStart = Date.parse(range.start); const rangeEnd = Date.parse(range.end)
  const witnesses = signals.flatMap((signal) => {
    const points = [...signal.samples].filter((point) => Number.isFinite(pointTime(point))).sort((left, right) => pointTime(left) - pointTime(right))
    const cadences = points.slice(1).map((point, index) => pointTime(point) - pointTime(points[index]!)).filter((value) => value > 0)
    if (cadences.length < 3) return []
    // One missed expected five-minute heartbeat plus the application's
    // established 30-second scheduling allowance is enough to stop holding
    // the prior physical value. The lower median prevents one or more real
    // outages from redefining the normal source cadence.
    const threshold = Math.max(HISTORIAN_MINIMUM_SILENCE_MS, lowerMedian(cadences) + HISTORIAN_HEARTBEAT_JITTER_MS)
    const gaps = points.slice(1).flatMap((point, index) => {
      const prior = points[index]!; const start = pointTime(prior); const end = pointTime(point)
      return end - start > threshold && start >= rangeStart && end <= rangeEnd ? [{ start, end }] : []
    })
    const last = points.at(-1)
    if (last && rangeEnd - pointTime(last) > threshold) gaps.push({ start: pointTime(last), end: rangeEnd })
    return [{ gaps }]
  })
  if (witnesses.length < 2) return []
  let intersections = witnesses[0]!.gaps
  for (const witness of witnesses.slice(1)) {
    intersections = intersections.flatMap((left) => witness.gaps.flatMap((right) => {
      const start = Math.max(left.start, right.start); const end = Math.min(left.end, right.end)
      return end > start ? [{ start, end }] : []
    }))
  }
  const ordered = intersections.sort((left, right) => left.start - right.start)
  const merged: Array<{ start: number; end: number }> = []
  for (const gap of ordered) {
    const prior = merged.at(-1)
    if (prior && gap.start <= prior.end) prior.end = Math.max(prior.end, gap.end)
    else merged.push({ ...gap })
  }
  return merged.map(({ start, end }) => ({ startUtc: new Date(start).toISOString(), endUtc: new Date(end).toISOString(), durationMs: end - start, witnessCount: witnesses.length }))
}

export function assessDetailedHistory(signals: Array<Pick<PressSemanticSignalEvidence, 'capabilityState' | 'observationState' | 'seed' | 'samples' | 'changes'>>, sourceGaps: TelemetrySourceEvidenceGap[] = []): HistoricalTelemetryAvailability {
  const supported = signals.filter((signal) => signal.capabilityState === 'SUPPORTED')
  if (!supported.length) return { state: 'UNKNOWN', detailedTelemetryAvailable: false, intervals: [], reason: 'No supported detailed-history signal was available to assess this range.' }
  const hasDetailedEvidence = supported.some((signal) => signal.seed || signal.samples.length || signal.changes.length)
  if (!hasDetailedEvidence) return { state: 'INSUFFICIENT_DETAILED_TELEMETRY', detailedTelemetryAvailable: false, intervals: [], reason: 'Supported signals exist, but detailed historian observations are unavailable for this period.' }
  const intervals: HistoricalTelemetryAvailabilityInterval[] = sourceGaps.map((gap) => ({ fromUtc: gap.startUtc, toUtc: gap.endUtc, state: 'SOURCE_TELEMETRY_UNAVAILABLE', witnessCount: gap.witnessCount }))
  if (intervals.length) return { state: 'SOURCE_TELEMETRY_UNAVAILABLE', detailedTelemetryAvailable: true, intervals, reason: 'Detailed history is available outside intervals where this machine/source stopped providing corroborated telemetry.' }
  return { state: 'DETAILED_AVAILABLE', detailedTelemetryAvailable: true, intervals: [], reason: 'Detailed transition-first historian evidence is available for this range.' }
}

export function assessRawHistory(counts: { framesRead?: number; historianReadCount: number; observations?: unknown[] }): RawHistoryAvailability {
  const available = counts.framesRead !== undefined
    ? counts.framesRead > 0
    : counts.observations !== undefined
      ? counts.observations.length > 0
      : counts.historianReadCount > 0
  return available
    ? { state: 'RAW_AVAILABLE', detailedTelemetryMayRemainAvailable: true, reason: 'Raw snapshot history is available for this period.' }
    : { state: 'RAW_HISTORY_EXPIRED', detailedTelemetryMayRemainAvailable: true, reason: 'Raw snapshot history is unavailable for this period; mapped detailed telemetry may still be available.' }
}

/** Cross-source corroboration is deliberately separate from source silence. */
export function corroborateSharedCollectionOutages(sources: Array<{ pressKey: string; intervals: HistoricalTelemetryAvailabilityInterval[] }>, minimumIndependentSources = 2): HistoricalTelemetryAvailabilityInterval[] {
  const sourceIntervals = sources.map((source) => ({ ...source, intervals: source.intervals.filter((interval) => interval.state === 'SOURCE_TELEMETRY_UNAVAILABLE') })).filter((source) => source.intervals.length)
  if (sourceIntervals.length < minimumIndependentSources) return []
  const boundaries = [...new Set(sourceIntervals.flatMap(({ intervals }) => intervals.flatMap(({ fromUtc, toUtc }) => [Date.parse(fromUtc), Date.parse(toUtc)])))].filter(Number.isFinite).sort((left, right) => left - right)
  const slices = boundaries.slice(0, -1).flatMap((start, index) => {
    const end = boundaries[index + 1]!; const midpoint = start + (end - start) / 2
    const witnesses = sourceIntervals.filter(({ intervals }) => intervals.some((interval) => Date.parse(interval.fromUtc) <= midpoint && Date.parse(interval.toUtc) > midpoint)).length
    return end > start && witnesses >= minimumIndependentSources ? [{ fromUtc: new Date(start).toISOString(), toUtc: new Date(end).toISOString(), state: 'SHARED_COLLECTION_OUTAGE' as const, witnessCount: witnesses }] : []
  })
  const merged: HistoricalTelemetryAvailabilityInterval[] = []
  for (const slice of slices) {
    const prior = merged.at(-1)
    if (prior && prior.toUtc === slice.fromUtc && prior.witnessCount === slice.witnessCount) prior.toUtc = slice.toUtc
    else merged.push(slice)
  }
  return merged
}

export interface PiecewiseTelemetryInterval<T> {
  fromUtc: string
  toUtc: string
  durationMs: number
  value: T
  quality: NormalizedTelemetryQuality
  originalQuality: string
  observedAtUtc: string
}

/** Reconstructs elapsed time by holding each recorded state until the next observation. */
export function reconstructPiecewiseConstant<T extends string | number | boolean>(points: Array<Pick<TelemetrySample, 'observedAtUtc' | 'qualityState'> & { value: T }>, fromUtc: string, toUtc: string): PiecewiseTelemetryInterval<T>[] {
  const from = Date.parse(fromUtc); const to = Date.parse(toUtc)
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return []
  const ordered = [...points].filter((point) => Number.isFinite(pointTime(point)) && pointTime(point) <= to).sort((left, right) => pointTime(left) - pointTime(right))
  const deduplicated = [...new Map(ordered.map((point) => [point.observedAtUtc, point])).values()]
  const seed = deduplicated.filter((point) => pointTime(point) <= from).at(-1)
  const visible = [...(seed ? [seed] : []), ...deduplicated.filter((point) => pointTime(point) > from)]
  return visible.flatMap((point, index) => {
    const start = Math.max(from, pointTime(point)); const end = Math.min(to, pointTime(visible[index + 1] ?? { observedAtUtc: toUtc }))
    return end > start ? [{ fromUtc: new Date(start).toISOString(), toUtc: new Date(end).toISOString(), durationMs: end - start, value: point.value, quality: normalizeTelemetryQuality(point.qualityState), originalQuality: point.qualityState, observedAtUtc: point.observedAtUtc }] : []
  })
}

function physicalState(speed: number): PhysicalState { const absolute = Math.abs(speed); return absolute < 1 ? 'STOPPED' : absolute < 600 ? 'TRANSITION' : 'RUNNING' }

export function reconstructHistoricalPhysicalState(input: { sourceId: number; sourceKey: string; displayName: string; fromUtc: string; toUtc: string; samples: TelemetrySample[]; unavailable: HistoricalTelemetryAvailabilityInterval[] }): PhysicalStateResponse {
  const numeric = input.samples.flatMap((sample) => typeof sample.value === 'number' && Number.isFinite(sample.value) ? [{ ...sample, value: sample.value }] : [])
  const base = reconstructPiecewiseConstant(numeric, input.fromUtc, input.toUtc).map((interval): PhysicalStateSegment => ({ state: interval.quality === 'GOOD' ? physicalState(interval.value) : 'UNKNOWN', fromUtc: interval.fromUtc, toUtc: interval.toUtc, durationMs: interval.durationMs, durationSeconds: interval.durationMs / 1_000, actualSpeedAtStart: interval.quality === 'GOOD' ? interval.value : null, reason: interval.quality === 'GOOD' ? 'Piecewise-constant detailed Actual Speed history.' : `Actual Speed quality ${interval.originalQuality} is not physical evidence.` }))
  const boundaries = [...new Set([Date.parse(input.fromUtc), Date.parse(input.toUtc), ...base.flatMap((item) => [Date.parse(item.fromUtc), Date.parse(item.toUtc)]), ...input.unavailable.flatMap((item) => [Date.parse(item.fromUtc), Date.parse(item.toUtc)])])].filter(Number.isFinite).sort((left, right) => left - right)
  const slices = boundaries.slice(0, -1).flatMap((start, index): PhysicalStateSegment[] => {
    const end = boundaries[index + 1]!; if (end <= start) return []
    const midpoint = start + (end - start) / 2; const unavailable = input.unavailable.find((item) => Date.parse(item.fromUtc) <= midpoint && Date.parse(item.toUtc) > midpoint); const observed = base.find((item) => Date.parse(item.fromUtc) <= midpoint && Date.parse(item.toUtc) > midpoint)
    const state = unavailable || !observed ? 'UNKNOWN' : observed.state
    return [{ state, fromUtc: new Date(start).toISOString(), toUtc: new Date(end).toISOString(), durationMs: end - start, durationSeconds: (end - start) / 1_000, actualSpeedAtStart: state === 'UNKNOWN' ? null : observed?.actualSpeedAtStart ?? null, reason: unavailable ? unavailable.state === 'SHARED_COLLECTION_OUTAGE' ? 'Shared telemetry collection outage corroborated across independent press sources.' : 'The selected machine/source telemetry is unavailable.' : observed?.reason ?? 'Detailed speed history is unavailable.' }]
  })
  const segments: PhysicalStateSegment[] = []
  for (const slice of slices) { const prior = segments.at(-1); if (prior && prior.state === slice.state && prior.reason === slice.reason && prior.toUtc === slice.fromUtc) { prior.toUtc = slice.toUtc; prior.durationMs += slice.durationMs; prior.durationSeconds = prior.durationMs / 1_000 } else segments.push({ ...slice }) }
  const durationsMs = { RUNNING: 0, STOPPED: 0, TRANSITION: 0, UNKNOWN: 0 }
  for (const segment of segments) durationsMs[segment.state] += segment.durationMs
  return { sourceId: input.sourceId, sourceKey: input.sourceKey, displayName: input.displayName, fromUtc: input.fromUtc, toUtc: input.toUtc, policy: { evidenceSource: 'signal_samples', reconstruction: 'piecewise_constant_elapsed_time', stopSpeedExclusive: 1, runningSpeedInclusive: 600, shortStalenessApplied: false }, summary: { durationsMs, durationsSeconds: { RUNNING: durationsMs.RUNNING / 1_000, STOPPED: durationsMs.STOPPED / 1_000, TRANSITION: durationsMs.TRANSITION / 1_000, UNKNOWN: durationsMs.UNKNOWN / 1_000 }, segmentCount: segments.length }, segments }
}
