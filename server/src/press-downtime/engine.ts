import { createHash } from 'node:crypto'
import { usableJobIdentity } from '../job-intelligence/engine.js'
import type { StopIntelligenceCorrection, StopOperatorState } from '../stop-intelligence/correction-service.js'
import type { StopFleetPressSummary, StopIntelligenceFleetReport } from '../stop-intelligence/contracts.js'
import { isGoodTelemetryQuality } from '../telemetry/historical-telemetry-policy.js'
import { PRESS_DOWNTIME_VERSION, type PressDowntimeCategory, type PressDowntimeCategoryTotals, type PressDowntimeIdentitySegment, type PressDowntimeJobGroup, type PressDowntimeJobOccurrence, type PressDowntimePressReport, type PressDowntimeRadiusCategory, type PressDowntimeRadiusSegment, type PressDowntimeRoll, type PressDowntimeRollSummary, type PressDowntimeSegment, type PressDowntimeSegmentSource } from './contracts.js'

type JobField = 'order' | 'recipe'
type JobIdentity = Record<JobField, string | null>
interface StateSlice { startUtc: string; endUtc: string; category: PressDowntimeCategory; source: PressDowntimeSegmentSource; underlyingState: string; stopId: string | null }

const iso = (value: number) => new Date(value).toISOString()
const seconds = (from: number, to: number) => Math.round(to - from) / 1_000
const emptyTotals = (): PressDowntimeCategoryTotals => ({ CHANGEOVER: 0, GOOD_RUN: 0, DOWNTIME: 0, MISSING_DATA: 0 })
const emptyRollSummary = (): PressDowntimeRollSummary => ({ total: 0, good: 0, changeover: 0, goodLength: 0, changeoverLength: 0 })
const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16)
const identityKey = (identity: JobIdentity) => `${identity.order ?? ''}\u0000${identity.recipe ?? ''}`

function totalsFor(segments: Array<Pick<PressDowntimeSegment, 'category' | 'durationSeconds'>>): PressDowntimeCategoryTotals {
  const totals = emptyTotals()
  for (const segment of segments) totals[segment.category] = Math.round((totals[segment.category] + segment.durationSeconds) * 1_000) / 1_000
  return totals
}

function operatorCategory(state: StopOperatorState): PressDowntimeCategory {
  if (state === 'CHANGEOVER') return 'CHANGEOVER'
  if (state === 'GOOD_PRODUCTION') return 'GOOD_RUN'
  return 'DOWNTIME'
}

function latestCorrection(corrections: StopIntelligenceCorrection[], at: number): StopIntelligenceCorrection | undefined {
  return corrections
    .filter((item) => Date.parse(item.fromUtc) <= at && Date.parse(item.toUtc) > at)
    .sort((left, right) => Date.parse(right.createdAtUtc) - Date.parse(left.createdAtUtc))[0]
}

function predictedCategory(classification: StopFleetPressSummary['episodes'][number]['classification']): PressDowntimeCategory {
  if (classification === 'CHANGEOVER') return 'CHANGEOVER'
  if (classification === 'IGNORE_BAD_DATA') return 'MISSING_DATA'
  return 'DOWNTIME'
}

function stateSlices(report: StopIntelligenceFleetReport, press: StopFleetPressSummary, identityTimeline: PressDowntimeIdentitySegment[]): StateSlice[] {
  const from = Date.parse(report.fromUtc); const to = Date.parse(report.toUtc)
  const unknown = press.speedContext.unknownIntervals
  const corrections = report.operatorCorrections.filter((item) => item.pressKey === press.pressKey)
  const noSpeedEvidence = press.speedContext.observations.length === 0
  const boundaries = new Set<number>([from, to])
  for (const episode of press.episodes) {
    boundaries.add(Math.max(from, Date.parse(episode.startAt)))
    boundaries.add(Math.min(to, Date.parse(episode.endAt ?? report.toUtc)))
  }
  for (const interval of unknown) {
    boundaries.add(Math.max(from, Date.parse(interval.fromUtc)))
    boundaries.add(Math.min(to, Date.parse(interval.toUtc)))
  }
  for (const interval of identityTimeline.filter((item) => item.missingFields.length > 0)) {
    boundaries.add(Math.max(from, Date.parse(interval.startUtc)))
    boundaries.add(Math.min(to, Date.parse(interval.endUtc)))
  }
  for (const correction of corrections) {
    boundaries.add(Math.max(from, Date.parse(correction.fromUtc)))
    boundaries.add(Math.min(to, Date.parse(correction.toUtc)))
  }
  const ordered = [...boundaries].filter((value) => Number.isFinite(value) && value >= from && value <= to).sort((left, right) => left - right)
  const slices: StateSlice[] = []
  for (let index = 0; index < ordered.length - 1; index += 1) {
    const start = ordered[index]!; const end = ordered[index + 1]!
    if (end <= start) continue
    const midpoint = start + (end - start) / 2
    const correction = latestCorrection(corrections, midpoint)
    const identityUnavailable = identityTimeline.some((item) => item.missingFields.length > 0 && Date.parse(item.startUtc) <= midpoint && Date.parse(item.endUtc) > midpoint)
    const unavailable = noSpeedEvidence || identityUnavailable || unknown.some((item) => Date.parse(item.fromUtc) <= midpoint && Date.parse(item.toUtc) > midpoint)
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

function identityEvidence(press: StopFleetPressSummary, fromUtc: string, toUtc: string): { occurrences: Array<{ startUtc: string; endUtc: string; identity: JobIdentity; boundaryFields: JobField[] }>; timeline: PressDowntimeIdentitySegment[] } {
  const from = Date.parse(fromUtc); const to = Date.parse(toUtc)
  const byTime = new Map<number, Array<{ field: JobField; value: string | null }>>()
  for (const series of press.identityContext) {
    const field: JobField = series.canonicalId === 'production.order' ? 'order' : 'recipe'
    for (const observation of series.observations) {
      const at = Date.parse(observation.atUtc)
      if (!Number.isFinite(at) || at < from || at >= to || !isGoodTelemetryQuality(observation.qualityState)) continue
      byTime.set(at, [...(byTime.get(at) ?? []), { field, value: usableJobIdentity(observation.value, observation.qualityState) }])
    }
  }
  const orderedTimes = [...new Set([from, to, ...byTime.keys()])].filter((value) => value >= from && value <= to).sort((left, right) => left - right)
  const observed: JobIdentity = { order: null, recipe: null }
  const timeline: PressDowntimeIdentitySegment[] = []
  for (let index = 0; index < orderedTimes.length - 1; index += 1) {
    const start = orderedTimes[index]!; const end = orderedTimes[index + 1]!; if (end <= start) continue
    for (const change of byTime.get(start) ?? []) observed[change.field] = change.value
    const missingFields = (['order', 'recipe'] as JobField[]).filter((field) => observed[field] === null)
    const value = { order: observed.order, recipe: observed.recipe, missingFields }
    const previous = timeline.at(-1)
    if (previous && previous.endUtc === iso(start) && previous.order === value.order && previous.recipe === value.recipe && previous.missingFields.join('|') === missingFields.join('|')) {
      previous.endUtc = iso(end); previous.durationSeconds = seconds(Date.parse(previous.startUtc), end)
    } else timeline.push({ segmentId: `press-downtime.identity.${hash(`${press.pressKey}\u0000${start}\u0000${end}\u0000${identityKey(value)}`)}`, startUtc: iso(start), endUtc: iso(end), durationSeconds: seconds(start, end), ...value })
  }
  const firstKnown = (field: JobField) => [...byTime].sort((left, right) => left[0] - right[0]).flatMap(([, changes]) => changes.filter((change) => change.field === field && change.value !== null).map((change) => change.value))[0] ?? null
  const running: JobIdentity = { order: firstKnown('order'), recipe: firstKnown('recipe') }
  const result: Array<{ startUtc: string; endUtc: string; identity: JobIdentity; boundaryFields: JobField[] }> = []
  let start = from; let fields: JobField[] = []
  for (const at of [...byTime.keys()].filter((value) => value > from).sort((left, right) => left - right)) {
    const heldIdentity = { ...running }; const before = identityKey(heldIdentity); const changed: JobField[] = []
    for (const change of byTime.get(at) ?? []) {
      if (change.value === null || running[change.field] === change.value) continue
      running[change.field] = change.value; changed.push(change.field)
    }
    if (identityKey(running) === before) continue
    result.push({ startUtc: iso(start), endUtc: iso(at), identity: heldIdentity, boundaryFields: fields })
    start = at; fields = [...new Set(changed)]
  }
  result.push({ startUtc: iso(start), endUtc: toUtc, identity: { ...running }, boundaryFields: fields })
  return { occurrences: result.filter((item) => Date.parse(item.endUtc) > Date.parse(item.startUtc)), timeline }
}

function clipSegments(slices: StateSlice[], occurrenceId: string, fromUtc: string, toUtc: string): PressDowntimeSegment[] {
  const from = Date.parse(fromUtc); const to = Date.parse(toUtc)
  return slices.flatMap((slice) => {
    const start = Math.max(from, Date.parse(slice.startUtc)); const end = Math.min(to, Date.parse(slice.endUtc))
    if (end <= start) return []
    return [{ segmentId: `press-downtime.segment.${hash(`${occurrenceId}\u0000${start}\u0000${end}\u0000${slice.category}\u0000${slice.source}`)}`, occurrenceId, category: slice.category, startUtc: iso(start), endUtc: iso(end), durationSeconds: seconds(start, end), source: slice.source, underlyingState: slice.underlyingState, stopId: slice.stopId }]
  })
}

function rollSummary(rolls: PressDowntimeRoll[]): PressDowntimeRollSummary {
  return rolls.reduce((summary, roll) => {
    summary.total += 1
    if (roll.category === 'CHANGEOVER') { summary.changeover += 1; summary.changeoverLength += roll.length }
    else { summary.good += 1; summary.goodLength += roll.length }
    return summary
  }, emptyRollSummary())
}

function radiusCategory(eventType: string | null, unavailable: boolean): PressDowntimeRadiusCategory {
  if (unavailable) return 'MISSING_DATA'
  const family = eventType?.trim().charAt(0).toUpperCase()
  return family === 'G' || family === 'B' || family === 'M' ? family : 'MISSING_DATA'
}

function radiusTimeline(report: StopIntelligenceFleetReport, press: StopFleetPressSummary): PressDowntimeRadiusSegment[] {
  const from = Date.parse(report.fromUtc); const to = Date.parse(report.toUtc)
  const boundaries = new Set<number>([from, to])
  for (const state of press.radiusContext.states) {
    boundaries.add(Math.max(from, Date.parse(state.startUtc)))
    boundaries.add(Math.min(to, Date.parse(state.endUtc)))
  }
  const ordered = [...boundaries].filter((value) => Number.isFinite(value) && value >= from && value <= to).sort((left, right) => left - right)
  const result: PressDowntimeRadiusSegment[] = []
  for (let index = 0; index < ordered.length - 1; index += 1) {
    const start = ordered[index]!; const end = ordered[index + 1]!; if (end <= start) continue
    const midpoint = start + (end - start) / 2
    const state = press.radiusContext.states.find((item) => Date.parse(item.startUtc) <= midpoint && Date.parse(item.endUtc) > midpoint)
    const category = radiusCategory(state?.eventType ?? null, !state || state.kind === 'offline')
    const value = { category, eventType: state?.eventType ?? null, statusCode: state?.statusCode ?? null, statusDescription: state?.statusDescription ?? null }
    const previous = result.at(-1)
    if (previous && previous.endUtc === iso(start) && previous.category === value.category && previous.eventType === value.eventType && previous.statusCode === value.statusCode && previous.statusDescription === value.statusDescription) {
      previous.endUtc = iso(end); previous.durationSeconds = seconds(Date.parse(previous.startUtc), end)
    } else result.push({ segmentId: `press-downtime.radius.${hash(`${press.pressKey}\u0000${start}\u0000${end}\u0000${category}`)}`, startUtc: iso(start), endUtc: iso(end), durationSeconds: seconds(start, end), ...value })
  }
  return result
}

function completedRolls(press: StopFleetPressSummary, slices: StateSlice[], occurrences: Array<Pick<PressDowntimeJobOccurrence, 'occurrenceId' | 'startUtc' | 'endUtc'>>): PressDowntimeRoll[] {
  const context = press.rollLengthContext
  if (!context) return []
  const points = context.observations.filter((point) => Number.isFinite(point.value) && point.value >= 0 && isGoodTelemetryQuality(point.qualityState) && Number.isFinite(Date.parse(point.atUtc))).sort((left, right) => Date.parse(left.atUtc) - Date.parse(right.atUtc))
  if (points.length < 2) return []
  const rolls: PressDowntimeRoll[] = []
  let rollStart = Date.parse(points[0]!.atUtc); let peak = points[0]!.value
  let changeoverBuildObserved = false
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]!; const point = points[index]!; peak = Math.max(peak, previous.value)
    const pointAt = Date.parse(point.atUtc)
    if (point.value > previous.value && slices.some((slice) => slice.category === 'CHANGEOVER' && Date.parse(slice.startUtc) <= pointAt && Date.parse(slice.endUtc) > pointAt)) changeoverBuildObserved = true
    const reset = previous.value > 0 && point.value <= previous.value * .5
    if (!reset) { peak = Math.max(peak, point.value); continue }
    const end = pointAt; const assignmentAt = Math.max(rollStart, end - 1)
    const occurrence = occurrences.find((item) => Date.parse(item.startUtc) <= assignmentAt && Date.parse(item.endUtc) > assignmentAt)
    if (occurrence && end > rollStart && peak > 0) {
      rolls.push({ rollId: `press-downtime.roll.${hash(`${press.pressKey}\u0000${rollStart}\u0000${end}\u0000${peak}`)}`, occurrenceId: occurrence.occurrenceId, category: changeoverBuildObserved ? 'CHANGEOVER' : 'GOOD', startUtc: iso(rollStart), endUtc: iso(end), length: peak, unit: context.unit })
    }
    rollStart = end; peak = point.value; changeoverBuildObserved = false
  }
  return rolls
}

export function buildPressDowntimeReport(report: StopIntelligenceFleetReport, generatedAtUtc = new Date().toISOString()): PressDowntimePressReport {
  const press = report.presses[0]
  if (!press) throw new Error('press_downtime_press_missing')
  const identities = identityEvidence(press, report.fromUtc, report.toUtc)
  const slices = stateSlices(report, press, identities.timeline)
  const baseOccurrences = identities.occurrences.map((item): Omit<PressDowntimeJobOccurrence, 'occurrenceNumber'> => {
    const occurrenceId = `press-downtime.occurrence.${hash(`${press.pressKey}\u0000${item.startUtc}\u0000${identityKey(item.identity)}`)}`
    const segments = clipSegments(slices, occurrenceId, item.startUtc, item.endUtc)
    return { occurrenceId, startUtc: item.startUtc, endUtc: item.endUtc, durationSeconds: seconds(Date.parse(item.startUtc), Date.parse(item.endUtc)), order: item.identity.order, recipe: item.identity.recipe, identityComplete: Boolean(item.identity.order && item.identity.recipe), boundaryFields: item.boundaryFields, totals: totalsFor(segments), segments, rollSummary: emptyRollSummary(), rolls: [] }
  })
  const allRolls = completedRolls(press, slices, baseOccurrences)
  const occurrences = baseOccurrences.map((occurrence) => { const rolls = allRolls.filter((roll) => roll.occurrenceId === occurrence.occurrenceId); return { ...occurrence, rolls, rollSummary: rollSummary(rolls) } })
  const grouped = new Map<string, Array<Omit<PressDowntimeJobOccurrence, 'occurrenceNumber'>>>()
  for (const occurrence of occurrences) {
    const key = identityKey({ order: occurrence.order, recipe: occurrence.recipe })
    grouped.set(key, [...(grouped.get(key) ?? []), occurrence])
  }
  const jobGroups: PressDowntimeJobGroup[] = [...grouped].map(([key, items]) => {
    const ordered = [...items].sort((left, right) => Date.parse(left.startUtc) - Date.parse(right.startUtc)).map((item, index) => ({ ...item, occurrenceNumber: index + 1 }))
    const allSegments = ordered.flatMap((item) => item.segments)
    const rolls = ordered.flatMap((item) => item.rolls)
    return { groupId: `press-downtime.group.${hash(`${press.pressKey}\u0000${key}`)}`, order: ordered[0]!.order, recipe: ordered[0]!.recipe, identityComplete: ordered[0]!.identityComplete, occurrenceCount: ordered.length, firstStartUtc: ordered[0]!.startUtc, lastEndUtc: ordered.at(-1)!.endUtc, totals: totalsFor(allSegments), rollSummary: rollSummary(rolls), rolls, occurrences: ordered }
  }).sort((left, right) => Date.parse(left.firstStartUtc) - Date.parse(right.firstStartUtc))
  const totals = totalsFor(jobGroups.flatMap((group) => group.occurrences.flatMap((occurrence) => occurrence.segments)))
  const classificationTimeline = clipSegments(slices, 'press-range', report.fromUtc, report.toUtc)
  const radiusSegments = radiusTimeline(report, press)
  const radiusTotals = radiusSegments.reduce<Record<PressDowntimeRadiusCategory, number>>((result, segment) => { result[segment.category] += segment.durationSeconds; return result }, { G: 0, B: 0, M: 0, MISSING_DATA: 0 })
  const rangeSeconds = seconds(Date.parse(report.fromUtc), Date.parse(report.toUtc)); const missing = totals.MISSING_DATA
  const availability = missing >= rangeSeconds - 0.1 ? 'UNAVAILABLE' : missing > 0 ? 'PARTIAL' : 'AVAILABLE'
  return {
    version: PRESS_DOWNTIME_VERSION, generatedAtUtc, fromUtc: report.fromUtc, toUtc: report.toUtc, pressKey: press.pressKey, displayName: press.displayName, availability,
    reason: availability === 'UNAVAILABLE' ? 'No trustworthy Stop Intelligence evidence was available in this range.' : availability === 'PARTIAL' ? 'Some time is separated as Missing Data and is not counted as production or downtime.' : null,
    totals,
    classificationTimeline,
    speedTrend: {
      unit: press.speedContext.unit,
      observations: press.speedContext.observations.flatMap((observation) => typeof observation.speed === 'number' && Number.isFinite(observation.speed) && isGoodTelemetryQuality(observation.qualityState) ? [{ atUtc: observation.atUtc, value: observation.speed, qualityState: observation.qualityState }] : []),
    },
    identityTimeline: identities.timeline,
    radiusTimeline: radiusSegments, radiusTotals, rollSummary: rollSummary(allRolls), jobGroups, correctionPersistence: report.correctionPersistence,
    policy: { identityBoundary: 'ANY_OBSERVED_ORDER_OR_RECIPE_CHANGE', temporaryIdentityGaps: 'MISSING_TIME_WITHOUT_NEW_OCCURRENCE', repeatedIdentity: 'GROUPED_OCCURRENCES', operatorReview: 'LATEST_REVIEW_OVERRIDES_PREDICTION', routineAndUncertain: 'DOWNTIME', badOrUnavailableEvidence: 'MISSING_DATA' },
  }
}
