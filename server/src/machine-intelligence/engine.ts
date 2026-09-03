import { usableJobIdentity } from '../job-intelligence/engine.js'
import type { StopIntelligenceCorrection, StopOperatorState } from '../stop-intelligence/correction-service.js'
import type { StopFleetPressSummary, StopIntelligenceFleetReport } from '../stop-intelligence/contracts.js'
import { isGoodTelemetryQuality } from '../telemetry/historical-telemetry-policy.js'
import type { MachineIntelligenceCategoryTotals, MachineIntelligencePressOverview, MachineIntelligenceRadiusCategory, MachineIntelligenceRollSummary } from './contracts.js'

type MachineIntelligenceCategory = keyof MachineIntelligenceCategoryTotals
type MachineIntelligenceSegmentSource = 'PREDICTION' | 'OPERATOR_REVIEW' | 'DATA_AVAILABILITY'
type JobField = 'order' | 'recipe'
interface IdentitySegment { startUtc: string; endUtc: string; order: string | null; recipe: string | null; missingFields: JobField[] }
interface StateSlice { startUtc: string; endUtc: string; category: MachineIntelligenceCategory; source: MachineIntelligenceSegmentSource; underlyingState: string; stopId: string | null }

const iso = (value: number) => new Date(value).toISOString()
const seconds = (from: number, to: number) => Math.round(to - from) / 1_000
const emptyTotals = (): MachineIntelligenceCategoryTotals => ({ CHANGEOVER: 0, GOOD_RUN: 0, DOWNTIME: 0, MISSING_DATA: 0 })
const emptyRollSummary = (): MachineIntelligenceRollSummary => ({ total: 0, good: 0, changeover: 0, goodLength: 0, changeoverLength: 0 })

function operatorCategory(state: StopOperatorState): MachineIntelligenceCategory {
  if (state === 'CHANGEOVER') return 'CHANGEOVER'
  if (state === 'GOOD_PRODUCTION') return 'GOOD_RUN'
  return 'DOWNTIME'
}

function latestCorrection(corrections: StopIntelligenceCorrection[], at: number): StopIntelligenceCorrection | undefined {
  return corrections
    .filter((item) => Date.parse(item.fromUtc) <= at && Date.parse(item.toUtc) > at)
    .sort((left, right) => Date.parse(right.createdAtUtc) - Date.parse(left.createdAtUtc))[0]
}

function predictedCategory(classification: StopFleetPressSummary['episodes'][number]['classification']): MachineIntelligenceCategory {
  if (classification === 'CHANGEOVER') return 'CHANGEOVER'
  if (classification === 'IGNORE_BAD_DATA') return 'MISSING_DATA'
  return 'DOWNTIME'
}

function identityTimeline(press: StopFleetPressSummary, fromUtc: string, toUtc: string): IdentitySegment[] {
  const from = Date.parse(fromUtc); const to = Date.parse(toUtc)
  const byTime = new Map<number, Array<{ field: JobField; value: string | null }>>()
  for (const series of press.identityContext) {
    if (series.canonicalId !== 'production.order' && series.canonicalId !== 'production.recipe') continue
    const field: JobField = series.canonicalId === 'production.order' ? 'order' : 'recipe'
    for (const observation of series.observations) {
      const at = Date.parse(observation.atUtc)
      if (!Number.isFinite(at) || at < from || at >= to || !isGoodTelemetryQuality(observation.qualityState)) continue
      byTime.set(at, [...(byTime.get(at) ?? []), { field, value: usableJobIdentity(observation.value, observation.qualityState) }])
    }
  }
  const orderedTimes = [...new Set([from, to, ...byTime.keys()])].sort((left, right) => left - right)
  const observed: Record<JobField, string | null> = { order: null, recipe: null }
  const timeline: IdentitySegment[] = []
  for (let index = 0; index < orderedTimes.length - 1; index += 1) {
    const start = orderedTimes[index]!; const end = orderedTimes[index + 1]!
    for (const change of byTime.get(start) ?? []) observed[change.field] = change.value
    const missingFields = (['order', 'recipe'] as JobField[]).filter((field) => observed[field] === null)
    const previous = timeline.at(-1)
    if (previous && previous.endUtc === iso(start) && previous.order === observed.order && previous.recipe === observed.recipe && previous.missingFields.join('|') === missingFields.join('|')) previous.endUtc = iso(end)
    else timeline.push({ startUtc: iso(start), endUtc: iso(end), order: observed.order, recipe: observed.recipe, missingFields })
  }
  return timeline
}

function stateSlices(report: StopIntelligenceFleetReport, press: StopFleetPressSummary, identities: IdentitySegment[]): StateSlice[] {
  const from = Date.parse(report.fromUtc); const to = Date.parse(report.toUtc)
  const boundaries = new Set<number>([from, to])
  for (const episode of press.episodes) { boundaries.add(Math.max(from, Date.parse(episode.startAt))); boundaries.add(Math.min(to, Date.parse(episode.endAt ?? report.toUtc))) }
  for (const interval of press.speedContext.unknownIntervals) { boundaries.add(Math.max(from, Date.parse(interval.fromUtc))); boundaries.add(Math.min(to, Date.parse(interval.toUtc))) }
  for (const interval of identities.filter((item) => item.missingFields.length)) { boundaries.add(Math.max(from, Date.parse(interval.startUtc))); boundaries.add(Math.min(to, Date.parse(interval.endUtc))) }
  for (const correction of report.operatorCorrections.filter((item) => item.pressKey === press.pressKey)) { boundaries.add(Math.max(from, Date.parse(correction.fromUtc))); boundaries.add(Math.min(to, Date.parse(correction.toUtc))) }
  const ordered = [...boundaries].filter((value) => Number.isFinite(value) && value >= from && value <= to).sort((left, right) => left - right)
  const slices: StateSlice[] = []
  const corrections = report.operatorCorrections.filter((item) => item.pressKey === press.pressKey)
  for (let index = 0; index < ordered.length - 1; index += 1) {
    const start = ordered[index]!; const end = ordered[index + 1]!; if (end <= start) continue
    const midpoint = start + (end - start) / 2
    const correction = latestCorrection(corrections, midpoint)
    const identityUnavailable = identities.some((item) => item.missingFields.length && Date.parse(item.startUtc) <= midpoint && Date.parse(item.endUtc) > midpoint)
    const unavailable = !press.speedContext.observations.length || identityUnavailable || press.speedContext.unknownIntervals.some((item) => Date.parse(item.fromUtc) <= midpoint && Date.parse(item.toUtc) > midpoint)
    const episode = press.episodes.find((item) => Date.parse(item.startAt) <= midpoint && Date.parse(item.endAt ?? report.toUtc) > midpoint)
    const value: Omit<StateSlice, 'startUtc' | 'endUtc'> = correction
      ? { category: operatorCategory(correction.correctedState), source: 'OPERATOR_REVIEW', underlyingState: correction.correctedState, stopId: episode?.stopId ?? null }
      : unavailable
        ? { category: 'MISSING_DATA', source: 'DATA_AVAILABILITY', underlyingState: identityUnavailable ? 'IDENTITY_UNAVAILABLE' : 'UNKNOWN', stopId: episode?.stopId ?? null }
        : episode
          ? { category: predictedCategory(episode.classification), source: episode.classification === 'IGNORE_BAD_DATA' ? 'DATA_AVAILABILITY' : 'PREDICTION', underlyingState: episode.classification, stopId: episode.stopId }
          : { category: 'GOOD_RUN', source: 'PREDICTION', underlyingState: 'OBSERVABLE_NON_STOP', stopId: null }
    const previous = slices.at(-1)
    if (previous && previous.endUtc === iso(start) && previous.category === value.category && previous.source === value.source && previous.underlyingState === value.underlyingState && previous.stopId === value.stopId) previous.endUtc = iso(end)
    else slices.push({ startUtc: iso(start), endUtc: iso(end), ...value })
  }
  return slices
}

function categoryTotals(slices: StateSlice[], fromUtc: string, toUtc: string): MachineIntelligenceCategoryTotals {
  const from = Date.parse(fromUtc); const to = Date.parse(toUtc); const totals = emptyTotals()
  for (const slice of slices) totals[slice.category] += Math.max(0, Math.min(to, Date.parse(slice.endUtc)) - Math.max(from, Date.parse(slice.startUtc))) / 1_000
  return totals
}

function radiusTotals(report: StopIntelligenceFleetReport, press: StopFleetPressSummary): Record<MachineIntelligenceRadiusCategory, number> {
  const from = Date.parse(report.fromUtc); const to = Date.parse(report.toUtc); const boundaries = new Set<number>([from, to])
  for (const state of press.radiusContext.states) { boundaries.add(Math.max(from, Date.parse(state.startUtc))); boundaries.add(Math.min(to, Date.parse(state.endUtc))) }
  const ordered = [...boundaries].filter((value) => Number.isFinite(value) && value >= from && value <= to).sort((left, right) => left - right)
  const totals: Record<MachineIntelligenceRadiusCategory, number> = { G: 0, B: 0, M: 0, MISSING_DATA: 0 }
  for (let index = 0; index < ordered.length - 1; index += 1) {
    const start = ordered[index]!; const end = ordered[index + 1]!; const midpoint = start + (end - start) / 2
    const state = press.radiusContext.states.find((item) => Date.parse(item.startUtc) <= midpoint && Date.parse(item.endUtc) > midpoint)
    const family = state?.eventType?.trim().charAt(0).toUpperCase()
    const category: MachineIntelligenceRadiusCategory = state?.kind === 'radius' && (family === 'G' || family === 'B' || family === 'M') ? family : 'MISSING_DATA'
    totals[category] += seconds(start, end)
  }
  return totals
}

function completedRollSummary(press: StopFleetPressSummary, slices: StateSlice[]): MachineIntelligenceRollSummary {
  const points = press.rollLengthContext?.observations.filter((point) => Number.isFinite(point.value) && point.value >= 0 && isGoodTelemetryQuality(point.qualityState) && Number.isFinite(Date.parse(point.atUtc))).sort((left, right) => Date.parse(left.atUtc) - Date.parse(right.atUtc)) ?? []
  const summary = emptyRollSummary(); if (points.length < 2) return summary
  let rollStart = Date.parse(points[0]!.atUtc); let peak = points[0]!.value; let changeoverBuildObserved = false
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]!; const point = points[index]!; peak = Math.max(peak, previous.value)
    const pointAt = Date.parse(point.atUtc)
    if (point.value > previous.value && slices.some((slice) => slice.category === 'CHANGEOVER' && Date.parse(slice.startUtc) <= pointAt && Date.parse(slice.endUtc) > pointAt)) changeoverBuildObserved = true
    if (!(previous.value > 0 && point.value <= previous.value * .5)) { peak = Math.max(peak, point.value); continue }
    if (pointAt > rollStart && peak > 0) {
      summary.total += 1
      if (changeoverBuildObserved) { summary.changeover += 1; summary.changeoverLength += peak }
      else { summary.good += 1; summary.goodLength += peak }
    }
    rollStart = pointAt; peak = point.value; changeoverBuildObserved = false
  }
  return summary
}

export function buildMachineIntelligenceOverview(report: StopIntelligenceFleetReport): MachineIntelligencePressOverview {
  const press = report.presses[0]
  if (!press) throw new Error('machine_intelligence_press_missing')
  const slices = stateSlices(report, press, identityTimeline(press, report.fromUtc, report.toUtc))
  const totals = categoryTotals(slices, report.fromUtc, report.toUtc)
  const rangeSeconds = seconds(Date.parse(report.fromUtc), Date.parse(report.toUtc))
  const availability = totals.MISSING_DATA >= rangeSeconds - .1 ? 'UNAVAILABLE' : totals.MISSING_DATA > 0 ? 'PARTIAL' : 'AVAILABLE'
  return {
    pressKey: press.pressKey,
    displayName: press.displayName,
    availability,
    reason: availability === 'UNAVAILABLE' ? 'No trustworthy Process Intelligence evidence was available in this range.' : availability === 'PARTIAL' ? 'Missing Data is excluded from production and loss comparisons.' : null,
    totals,
    radiusTotals: radiusTotals(report, press),
    rollSummary: completedRollSummary(press, slices),
  }
}
