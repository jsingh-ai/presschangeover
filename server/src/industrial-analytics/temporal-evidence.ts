import { createHash } from 'node:crypto'
import type { RadiusPressKey } from '../radius/models.js'
import type { TelemetryEvidenceGap } from '../telemetry/telemetry-contracts.js'
import { isGoodTelemetryQuality } from '../telemetry/historical-telemetry-policy.js'
import type { IndustrialAnalyticalObservation, IndustrialNumericSample, IndustrialStateSample } from './contracts.js'
import { strongestBoundedDelta } from './bounded-delta.js'

export const TEMPORAL_PROGRAM_NUMERIC_LANDMARK_LIMIT = 12
export const TEMPORAL_PROGRAM_SEGMENT_LIMIT = 6
export const TEMPORAL_PROGRAM_MODEL_SIGNAL_LIMIT = 6

export type TemporalTrend = 'STABLE' | 'RISING' | 'FALLING' | 'OSCILLATING'
export type TemporalLandmarkKind = 'WINDOW_START' | 'EVENT_START' | 'EVENT_END' | 'WINDOW_END' | 'MINIMUM' | 'MAXIMUM' | 'DELTA_BASELINE' | 'DELTA_TRIGGER' | 'DELTA_EXTREME' | 'ENVELOPE_CROSSING' | 'RETURN_INSIDE_ENVELOPE' | 'RADIUS_ADJACENT' | 'DIRECTION_CHANGE' | 'SHAPE'

export interface TemporalEvidenceCommon {
  traceId: string
  candidateId: string
  pressKey: RadiusPressKey
  eventId: string
  canonicalId: string
  datatype: 'numeric' | 'categorical' | 'radius' | 'production_context'
  unit: string | null
  range: { start: string; end: string }
  event: { start: string; end: string }
  coveragePercent: number
  gapState: 'COMPLETE' | 'GAPS_PRESENT' | 'INSUFFICIENT'
  gaps: TelemetryEvidenceGap[]
  usable: boolean
  selectedBecause: string[]
  explorer: { href: string; label: string }
}

export interface NumericTemporalLandmark { atUtc: string; relativeMinutes: number; value: number; kinds: TemporalLandmarkKind[] }
export interface NumericTrendSegment { startUtc: string; endUtc: string; startRelativeMinutes: number; endRelativeMinutes: number; trend: TemporalTrend; startValue: number; endValue: number; minimum: number; maximum: number; sampleCount: number }
export interface NumericTemporalEvidenceProgram extends TemporalEvidenceCommon {
  datatype: 'numeric'
  summary: {
    beforeMedian: number | null; eventMedian: number | null; afterMedian: number | null; minimum: number; maximum: number
    startValue: number; endValue: number; overallDelta: number
    strongestDelta: { windowMinutes: number; delta: number; baselineAtUtc: string; triggerAtUtc: string } | null
    envelopeState: string | null; persistence: string | null; recurrenceCount: number | null
    relationships: Array<{ basis: string; scope: string; qualification: string; coefficient: number | null; lagMinutes: number | null }>
  }
  segments: NumericTrendSegment[]
  landmarks: NumericTemporalLandmark[]
}

export interface CategoricalTemporalEvidenceProgram extends TemporalEvidenceCommon {
  datatype: 'categorical' | 'radius' | 'production_context'
  enteringState: string | number | boolean
  leavingState: string | number | boolean
  intervals: Array<{ startUtc: string; endUtc: string; startRelativeMinutes: number; endRelativeMinutes: number; value: string | number | boolean }>
  transitions: Array<{ atUtc: string; relativeMinutes: number; from: string | number | boolean; to: string | number | boolean }>
  transitionCount: number
  repeatedToggleCount: number
  longestPersistenceMinutes: number
}

export type TemporalEvidenceProgram = NumericTemporalEvidenceProgram | CategoricalTemporalEvidenceProgram

const badQuality = (quality?: string) => quality !== undefined && !isGoodTelemetryQuality(quality)
const round = (value: number, digits = 2) => { const factor = 10 ** digits; return Math.round(value * factor) / factor }
const median = (values: number[]) => { const ordered = [...values].sort((a, b) => a - b); const middle = Math.floor(ordered.length / 2); return ordered.length % 2 ? ordered[middle]! : (ordered[middle - 1]! + ordered[middle]!) / 2 }
const relative = (atUtc: string, eventStart: string) => round((Date.parse(atUtc) - Date.parse(eventStart)) / 60_000)
const traceIdentity = (input: { candidateId: string; pressKey: RadiusPressKey; eventId: string; canonicalId: string }) => `${input.pressKey}.trace.${createHash('sha256').update(`${input.candidateId}\u0000${input.eventId}\u0000${input.canonicalId}`).digest('hex').slice(0, 16)}`

function nearest(samples: IndustrialNumericSample[], atUtc: string) { return samples.reduce((best, sample) => Math.abs(Date.parse(sample.atUtc) - Date.parse(atUtc)) < Math.abs(Date.parse(best.atUtc) - Date.parse(atUtc)) ? sample : best, samples[0]!) }

function strongestDelta(samples: IndustrialNumericSample[]) {
  let strongest: { windowMinutes: number; delta: number; baseline: IndustrialNumericSample; trigger: IndustrialNumericSample } | null = null
  for (const windowMinutes of [2, 5, 10, 20]) {
    const candidate = strongestBoundedDelta({ points: samples, windowMinutes, referenceMode: 'LATEST_AT_OR_BEFORE_WINDOW' })
    if (candidate && (!strongest || Math.abs(candidate.delta) > Math.abs(strongest.delta) || Math.abs(candidate.delta) === Math.abs(strongest.delta) && windowMinutes < strongest.windowMinutes)) strongest = { windowMinutes, delta: candidate.delta, baseline: candidate.reference, trigger: candidate.trigger }
  }
  return strongest
}

function trendSegments(samples: IndustrialNumericSample[], eventStart: string): NumericTrendSegment[] {
  if (samples.length < 2) return []
  const range = Math.max(...samples.map(({ value }) => value)) - Math.min(...samples.map(({ value }) => value))
  const threshold = Math.max(range * .04, 1e-9)
  const edgeTrend = (left: IndustrialNumericSample, right: IndustrialNumericSample): TemporalTrend => right.value - left.value > threshold ? 'RISING' : left.value - right.value > threshold ? 'FALLING' : 'STABLE'
  const groups: Array<{ trend: TemporalTrend; values: IndustrialNumericSample[] }> = []
  for (let index = 1; index < samples.length; index += 1) {
    const trend = edgeTrend(samples[index - 1]!, samples[index]!)
    const latest = groups.at(-1)
    if (latest?.trend === trend) latest.values.push(samples[index]!)
    else groups.push({ trend, values: [samples[index - 1]!, samples[index]!] })
  }
  let bounded = groups
  if (groups.length > TEMPORAL_PROGRAM_SEGMENT_LIMIT) {
    const size = Math.ceil(groups.length / TEMPORAL_PROGRAM_SEGMENT_LIMIT)
    bounded = Array.from({ length: Math.ceil(groups.length / size) }, (_item, index) => {
      const chunk = groups.slice(index * size, (index + 1) * size); const values = chunk.flatMap((item, itemIndex) => itemIndex ? item.values.slice(1) : item.values)
      const directions = new Set(chunk.map((item) => item.trend).filter((item) => item !== 'STABLE'))
      return { trend: directions.size > 1 ? 'OSCILLATING' as const : directions.values().next().value ?? 'STABLE', values }
    })
  }
  return bounded.slice(0, TEMPORAL_PROGRAM_SEGMENT_LIMIT).map(({ trend, values }) => ({ startUtc: values[0]!.atUtc, endUtc: values.at(-1)!.atUtc, startRelativeMinutes: relative(values[0]!.atUtc, eventStart), endRelativeMinutes: relative(values.at(-1)!.atUtc, eventStart), trend, startValue: round(values[0]!.value), endValue: round(values.at(-1)!.value), minimum: round(Math.min(...values.map(({ value }) => value))), maximum: round(Math.max(...values.map(({ value }) => value))), sampleCount: values.length }))
}

function landmarks(samples: IndustrialNumericSample[], event: { start: string; end: string }, delta: ReturnType<typeof strongestDelta>, observations: IndustrialAnalyticalObservation[], segments: NumericTrendSegment[]): NumericTemporalLandmark[] {
  const values = new Map<string, { sample: IndustrialNumericSample; kinds: Set<TemporalLandmarkKind> }>()
  const add = (sample: IndustrialNumericSample, kind: TemporalLandmarkKind) => { const existing = values.get(sample.atUtc) ?? { sample, kinds: new Set<TemporalLandmarkKind>() }; existing.kinds.add(kind); values.set(sample.atUtc, existing) }
  add(samples[0]!, 'WINDOW_START'); add(nearest(samples, event.start), 'EVENT_START'); add(nearest(samples, event.end), 'EVENT_END'); add(samples.at(-1)!, 'WINDOW_END')
  add(samples.reduce((best, item) => item.value < best.value ? item : best, samples[0]!), 'MINIMUM')
  add(samples.reduce((best, item) => item.value > best.value ? item : best, samples[0]!), 'MAXIMUM')
  if (delta) { add(delta.baseline, 'DELTA_BASELINE'); add(delta.trigger, 'DELTA_TRIGGER'); add(delta.trigger, 'DELTA_EXTREME') }
  const envelope = observations.find((item) => item.family === 'normal_envelope_departure')
  if (typeof envelope?.metrics.firstDepartureAtUtc === 'string') add(nearest(samples, envelope.metrics.firstDepartureAtUtc), 'ENVELOPE_CROSSING')
  add(nearest(samples, event.start), 'RADIUS_ADJACENT')
  for (const segment of segments.slice(1)) add(nearest(samples, segment.startUtc), 'DIRECTION_CHANGE')
  const mandatory = [...values.values()]
  if (mandatory.length < TEMPORAL_PROGRAM_NUMERIC_LANDMARK_LIMIT) {
    const chosen = new Set(values.keys())
    const remaining = samples.filter((item) => !chosen.has(item.atUtc)).map((item, index, all) => {
      const prior = all[Math.max(0, index - 1)] ?? item; const next = all[Math.min(all.length - 1, index + 1)] ?? item
      return { item, shape: Math.abs((item.value - prior.value) * (Date.parse(next.atUtc) - Date.parse(prior.atUtc)) - (next.value - prior.value) * (Date.parse(item.atUtc) - Date.parse(prior.atUtc))) }
    }).sort((left, right) => right.shape - left.shape || Date.parse(left.item.atUtc) - Date.parse(right.item.atUtc))
    for (const { item } of remaining.slice(0, TEMPORAL_PROGRAM_NUMERIC_LANDMARK_LIMIT - mandatory.length)) add(item, 'SHAPE')
  }
  return [...values.values()].sort((left, right) => Date.parse(left.sample.atUtc) - Date.parse(right.sample.atUtc)).slice(0, TEMPORAL_PROGRAM_NUMERIC_LANDMARK_LIMIT).map(({ sample, kinds }) => ({ atUtc: sample.atUtc, relativeMinutes: relative(sample.atUtc, event.start), value: round(sample.value), kinds: [...kinds] }))
}

export function buildNumericTemporalEvidenceProgram(input: { candidateId: string; pressKey: RadiusPressKey; eventId: string; canonicalId: string; unit: string | null; range: { start: string; end: string }; event: { start: string; end: string }; samples: IndustrialNumericSample[]; observations?: IndustrialAnalyticalObservation[]; gaps?: TelemetryEvidenceGap[]; selectedBecause?: string[] }): NumericTemporalEvidenceProgram | null {
  const samples = input.samples.filter((item) => Number.isFinite(item.value) && !badQuality(item.qualityState) && Date.parse(item.atUtc) >= Date.parse(input.range.start) && Date.parse(item.atUtc) <= Date.parse(input.range.end)).sort((a, b) => Date.parse(a.atUtc) - Date.parse(b.atUtc))
  if (samples.length < 2) return null
  const before = samples.filter((item) => Date.parse(item.atUtc) < Date.parse(input.event.start)); const during = samples.filter((item) => Date.parse(item.atUtc) >= Date.parse(input.event.start) && Date.parse(item.atUtc) <= Date.parse(input.event.end)); const after = samples.filter((item) => Date.parse(item.atUtc) > Date.parse(input.event.end))
  const duration = Date.parse(input.range.end) - Date.parse(input.range.start); const coveragePercent = round(Math.min(100, Math.max(0, (Date.parse(samples.at(-1)!.atUtc) - Date.parse(samples[0]!.atUtc)) / duration * 100)), 1)
  const delta = strongestDelta(samples); const observations = input.observations ?? []; const segments = trendSegments(samples, input.event.start)
  const envelope = observations.find((item) => item.family === 'normal_envelope_departure'); const persistence = observations.find((item) => item.family === 'deviation_persistence')
  const relationships = observations.filter((item) => item.family === 'numeric_relationship').slice(0, 3).map((item) => ({ basis: String(item.metrics.basis ?? 'LEVELS'), scope: String(item.metrics.scope ?? 'EVENT_WINDOW'), qualification: String(item.metrics.qualification ?? 'UNKNOWN'), coefficient: typeof item.metrics.bestLagCorrelation === 'number' ? item.metrics.bestLagCorrelation : null, lagMinutes: typeof item.metrics.bestLagMinutes === 'number' ? item.metrics.bestLagMinutes : null }))
  const gaps = (input.gaps ?? []).filter((gap) => gap.canonicalId === input.canonicalId)
  const usable = samples.length >= 5 && coveragePercent >= 30
  return {
    traceId: traceIdentity(input), candidateId: input.candidateId, pressKey: input.pressKey, eventId: input.eventId, canonicalId: input.canonicalId, datatype: 'numeric', unit: input.unit,
    range: input.range, event: input.event, coveragePercent, gapState: !usable ? 'INSUFFICIENT' : gaps.length ? 'GAPS_PRESENT' : 'COMPLETE', gaps, usable,
    selectedBecause: input.selectedBecause ?? [], explorer: { href: `/telemetry-event-explorer?press=${input.pressKey}`, label: 'Open telemetry evidence' },
    summary: { beforeMedian: before.length ? round(median(before.map(({ value }) => value))) : null, eventMedian: during.length ? round(median(during.map(({ value }) => value))) : null, afterMedian: after.length ? round(median(after.map(({ value }) => value))) : null, minimum: round(Math.min(...samples.map(({ value }) => value))), maximum: round(Math.max(...samples.map(({ value }) => value))), startValue: round(samples[0]!.value), endValue: round(samples.at(-1)!.value), overallDelta: round(samples.at(-1)!.value - samples[0]!.value), strongestDelta: delta ? { windowMinutes: delta.windowMinutes, delta: round(delta.delta), baselineAtUtc: delta.baseline.atUtc, triggerAtUtc: delta.trigger.atUtc } : null, envelopeState: envelope ? String(envelope.metrics.evidenceType ?? 'departure') : null, persistence: persistence ? String(persistence.metrics.classification ?? 'detected') : null, recurrenceCount: typeof persistence?.metrics.recurrenceCount === 'number' ? persistence.metrics.recurrenceCount : null, relationships },
    segments, landmarks: landmarks(samples, input.event, delta, observations, segments),
  }
}

export function buildCategoricalTemporalEvidenceProgram(input: { candidateId: string; pressKey: RadiusPressKey; eventId: string; canonicalId: string; datatype?: 'categorical' | 'radius' | 'production_context'; range: { start: string; end: string }; event: { start: string; end: string }; samples: IndustrialStateSample[]; coveragePercent?: number; gaps?: TelemetryEvidenceGap[]; selectedBecause?: string[] }): CategoricalTemporalEvidenceProgram | null {
  const ordered = input.samples.filter((item) => !badQuality(item.qualityState) && Date.parse(item.atUtc) >= Date.parse(input.range.start) && Date.parse(item.atUtc) <= Date.parse(input.range.end)).sort((a, b) => Date.parse(a.atUtc) - Date.parse(b.atUtc))
  const states = ordered.filter((item, index) => index === 0 || item.value !== ordered[index - 1]!.value)
  if (!states.length) return null
  const intervals = states.map((item, index) => { const endUtc = states[index + 1]?.atUtc ?? input.range.end; return { startUtc: item.atUtc, endUtc, startRelativeMinutes: relative(item.atUtc, input.event.start), endRelativeMinutes: relative(endUtc, input.event.start), value: item.value } })
  const transitions = states.slice(1).map((item, index) => ({ atUtc: item.atUtc, relativeMinutes: relative(item.atUtc, input.event.start), from: states[index]!.value, to: item.value })).slice(0, 12)
  const repeatedToggleCount = transitions.filter((item, index) => index > 0 && item.to === transitions[index - 1]!.from).length
  const coveragePercent = input.coveragePercent ?? 100; const gaps = (input.gaps ?? []).filter((gap) => gap.canonicalId === input.canonicalId); const usable = coveragePercent >= 30
  return { traceId: traceIdentity(input), candidateId: input.candidateId, pressKey: input.pressKey, eventId: input.eventId, canonicalId: input.canonicalId, datatype: input.datatype ?? 'categorical', unit: null, range: input.range, event: input.event, coveragePercent, gapState: !usable ? 'INSUFFICIENT' : gaps.length ? 'GAPS_PRESENT' : 'COMPLETE', gaps, usable, selectedBecause: input.selectedBecause ?? [], explorer: { href: input.datatype === 'radius' ? `/raw-radius-explorer?press=${input.pressKey}` : `/telemetry-event-explorer?press=${input.pressKey}`, label: input.datatype === 'radius' ? 'Open Radius evidence' : 'Open state evidence' }, enteringState: states[0]!.value, leavingState: states.at(-1)!.value, intervals, transitions, transitionCount: states.length - 1, repeatedToggleCount, longestPersistenceMinutes: round(Math.max(...intervals.map((item) => (Date.parse(item.endUtc) - Date.parse(item.startUtc)) / 60_000))) }
}

export interface IndustrialCandidateGenerator<Input = unknown> {
  readonly family: string
  generate(input: Input): IndustrialAnalyticalObservation[]
}
