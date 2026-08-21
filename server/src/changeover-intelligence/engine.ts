import { createHash } from 'node:crypto'
import { DateTime } from 'luxon'
import type { RadiusPressKey, RadiusStatusSegment } from '../radius/models.js'
import type { ProductionContextEvidence, TelemetrySample } from '../telemetry/telemetry-contracts.js'
import { significantGapMs } from '../telemetry-event-explorer/telemetry-event-engine.js'
import { usableJobIdentity } from '../job-intelligence/engine.js'
import {
  CHANGEOVER_ALGORITHM_VERSION,
  type AdjustedRadiusContribution,
  type ChangeoverClassification,
  type ChangeoverDefinition,
  type ChangeoverPhase,
  type ConfirmedChangeover,
  type DailyChangeoverSummary,
  type DistributionSummary,
  type EvidenceSupport,
  type ExactReasonSummary,
  type OrderIdentityTransition,
  type PhaseSummary,
  type PhysicalStop,
  type PressChangeoverSummary,
  type RadiusExactIdentity,
  type RadiusReconciliation,
  type RecoveryCohortSummary,
  type RawRadiusInterval,
  type SequenceSummary,
  type TransitionPairSummary,
} from './contracts.js'

export const ORDER_SETTLING_MS = 5 * 60_000
const iso = (value: number) => new Date(value).toISOString()
const seconds = (value: number) => Math.round(value / 100) / 10
const validTime = (value: string) => Number.isFinite(Date.parse(value))
const badQuality = (value: string) => /bad|invalid|unavailable|no_data|nodata/i.test(value)

function numericSamples(samples: TelemetrySample[]): Array<{ at: number; value: number; sample: TelemetrySample }> {
  return samples.flatMap((sample) => typeof sample.value === 'number' && Number.isFinite(sample.value) && validTime(sample.observedAtUtc) && !badQuality(sample.qualityState) ? [{ at: Date.parse(sample.observedAtUtc), value: sample.value, sample }] : []).sort((left, right) => left.at - right.at)
}
/** Detects the physical envelope. Radius and metadata are intentionally absent. */
export function detectPhysicalStops(samples: TelemetrySample[], definition: ChangeoverDefinition): PhysicalStop[] {
  const points = numericSamples(samples)
  if (points.length < 2) return []
  const gapLimit = significantGapMs(points.map(({ at, value }) => ({ atUtc: iso(at), value })))
  const result: PhysicalStop[] = []
  let stopCandidate: { start: number; last: number; count: number } | undefined
  let stop: { start: number; confirmed: number; last: number; recovery?: number; failed: PhysicalStop['failedRecoveryAttempts'] } | undefined

  const interrupt = (gapStart: number, gapEnd: number) => {
    if (stop) {
      if (stop.recovery !== undefined) stop.failed.push({ candidateStartUtc: iso(stop.recovery), endedAtUtc: iso(gapStart), durationSeconds: seconds(gapStart - stop.recovery), outcome: 'FAILED', failureReason: 'telemetry_gap' })
      result.push({ physicalStartUtc: iso(stop.start), stopConfirmedAtUtc: iso(stop.confirmed), physicalRecoveryUtc: null, recoveryConfirmedAtUtc: null, durationSeconds: null, failedRecoveryAttempts: stop.failed, evidenceState: 'INTERRUPTED', telemetryGap: { startUtc: iso(gapStart), endUtc: iso(gapEnd), durationSeconds: seconds(gapEnd - gapStart) } })
    }
    stop = undefined; stopCandidate = undefined
  }

  for (let index = 0; index < points.length; index += 1) {
    const point = points[index]!
    const prior = points[index - 1]
    if (prior && point.at - prior.at > gapLimit) interrupt(prior.at, point.at)

    if (!stop) {
      if (point.value < definition.stopSpeed) {
        if (!stopCandidate || point.at - stopCandidate.last > gapLimit) stopCandidate = { start: point.at, last: point.at, count: 1 }
        else { stopCandidate.last = point.at; stopCandidate.count += 1 }
        if (stopCandidate.count >= 2) stop = { start: stopCandidate.start, confirmed: point.at, last: point.at, failed: [] }
      } else stopCandidate = undefined
      continue
    }

    stop.last = point.at
    if (point.value > definition.recoverySpeed) {
      stop.recovery ??= point.at
      if (point.at - stop.recovery >= definition.recoveryConfirmationSeconds * 1_000) {
        result.push({ physicalStartUtc: iso(stop.start), stopConfirmedAtUtc: iso(stop.confirmed), physicalRecoveryUtc: iso(stop.recovery), recoveryConfirmedAtUtc: iso(point.at), durationSeconds: seconds(stop.recovery - stop.start), failedRecoveryAttempts: stop.failed, evidenceState: 'CONFIRMED', telemetryGap: null })
        stop = undefined; stopCandidate = undefined
      }
    } else if (stop.recovery !== undefined) {
      stop.failed.push({ candidateStartUtc: iso(stop.recovery), endedAtUtc: iso(point.at), durationSeconds: seconds(point.at - stop.recovery), outcome: 'FAILED', failureReason: 'speed_at_or_below_threshold' })
      stop.recovery = undefined
    }
  }
  if (stop) result.push({ physicalStartUtc: iso(stop.start), stopConfirmedAtUtc: iso(stop.confirmed), physicalRecoveryUtc: null, recoveryConfirmedAtUtc: null, durationSeconds: null, failedRecoveryAttempts: stop.failed, evidenceState: 'OPEN', telemetryGap: null })
  return result
}

export function resolveOrderTransitions(context: ProductionContextEvidence): OrderIdentityTransition[] {
  const seed = context.fields.order.seed
  let resolved = usableJobIdentity(seed?.value, seed?.qualityState) ?? null
  const changes = context.changes
    .filter((item) => item.field === 'order')
    .flatMap((item) => {
      const value = usableJobIdentity(item.value, item.qualityState)
      return value && validTime(item.atUtc) ? [{ at: Date.parse(item.atUtc), atUtc: item.atUtc, value }] : []
    })
    .sort((a, b) => a.at - b.at)
  const clusters: Array<typeof changes> = []
  for (const change of changes) {
    const cluster = clusters.at(-1)
    if (!cluster || change.at - cluster.at(-1)!.at > ORDER_SETTLING_MS) clusters.push([change])
    else cluster.push(change)
  }
  const result: OrderIdentityTransition[] = []
  for (const cluster of clusters) {
    const final = cluster.at(-1)!.value
    if (final === resolved) continue
    const settledAt = cluster.at(-1)!.at + ORDER_SETTLING_MS
    const settled = settledAt <= Date.parse(context.toUtc)
    result.push({
      previousResolvedOrder: resolved,
      finalResolvedOrder: final,
      identityChangeFirstSeenAtUtc: cluster[0]!.atUtc,
      identityLastChangeAtUtc: cluster.at(-1)!.atUtc,
      identitySettledAtUtc: settled ? iso(settledAt) : null,
      settleState: settled ? 'CONFIRMED' : 'PENDING_RANGE_END',
      inferredBoundary: true,
      intermediateValues: [...new Set(cluster.map(({ value }) => value))],
    })
    if (settled) resolved = final
  }
  return result
}

function orderAt(context: ProductionContextEvidence, transitions: OrderIdentityTransition[], at: number): string | null {
  const seed = context.fields.order.seed
  let value = usableJobIdentity(seed?.value, seed?.qualityState) ?? null
  for (const transition of transitions) if (transition.identitySettledAtUtc && Date.parse(transition.identitySettledAtUtc) <= at) value = transition.finalResolvedOrder
  return value
}

function rawRadius(segment: RadiusStatusSegment): RawRadiusInterval {
  return {
    kind: segment.kind,
    originalStartUtc: segment.startUtc,
    originalEndUtc: segment.endUtc,
    originalDurationSeconds: segment.durationSeconds,
    identity: segment.kind === 'radius' ? { eventType: segment.eventType, statusCode: segment.statusCode, statusDescription: segment.statusDescription } : { eventType: null, statusCode: null, statusDescription: null },
    operationalGroupKey: segment.kind === 'radius' ? segment.classification?.operationalGroupKey ?? null : null,
    operationalGroupName: segment.kind === 'radius' ? segment.classification?.operationalGroupName ?? null : null,
    processFamilyKey: segment.kind === 'radius' ? segment.classification?.processFamilyKey ?? null : null,
    processFamilyName: segment.kind === 'radius' ? segment.classification?.processFamilyName ?? null : null,
    isProduction: segment.kind === 'radius' && segment.isProduction,
  }
}

function radiusPhase(interval: RawRadiusInterval): ChangeoverPhase {
  if (interval.kind === 'offline') return 'RADIUS_DATA_GAP'
  if (interval.isProduction) return 'RADIUS_PRODUCTION_MISMATCH'
  const family = interval.processFamilyKey
  if (family === 'CLEANING_WASH') return 'CLEANING_WASH'
  if (family === 'SLEEVES_PLATES' || family === 'ANILOX' || family === 'DOCTOR_BLADE_CHAMBER') return 'PLATES_SLEEVES_ANILOX'
  if (family === 'IMPRESSION_REGISTER_PRINT_QUALITY' || family === 'QUALITY_APPROVAL') return 'REGISTRATION_QUALITY'
  if (family === 'ROLL_MATERIAL' || family === 'SUBSTRATE' || family === 'WEB_HANDLING_WEB_BREAK') return 'MATERIAL_WEB'
  if (family === 'INK_COLOR') return 'INK_COLOR_RADIUS'
  if (family === 'MAINTENANCE' || family === 'MECHANICAL_ELECTRICAL') return 'MAINTENANCE'
  if (family === 'MAKE_READY') return 'MAKE_READY'
  const label = `${interval.operationalGroupKey ?? ''} ${interval.operationalGroupName ?? ''} ${interval.processFamilyName ?? ''}`.toLowerCase()
  if (label.includes('make') && label.includes('ready')) return 'MAKE_READY'
  if (label.includes('break') || interval.identity.eventType === 'B') return 'BREAKDOWN'
  if (label.includes('delay') || label.includes('process') || interval.identity.eventType === 'S') return 'PROCESS_DELAY'
  if (interval.identity.eventType === 'M') return 'MAKE_READY'
  return interval.operationalGroupKey || interval.identity.eventType ? 'OTHER_RADIUS' : 'UNKNOWN_UNCLASSIFIED'
}

export function reconcileRadius(physical: PhysicalStop, segments: RadiusStatusSegment[]): RadiusReconciliation | null {
  if (!physical.physicalRecoveryUtc || physical.durationSeconds === null) return null
  const start = Date.parse(physical.physicalStartUtc); const end = Date.parse(physical.physicalRecoveryUtc)
  const ordered = segments.map(rawRadius).sort((a, b) => Date.parse(a.originalStartUtc) - Date.parse(b.originalStartUtc))
  const overlapping = ordered.filter((item) => Date.parse(item.originalEndUtc) > start && Date.parse(item.originalStartUtc) < end)
  const before = ordered.filter((item) => Date.parse(item.originalEndUtc) <= start).at(-1)
  const after = ordered.find((item) => Date.parse(item.originalStartUtc) >= end)
  const rawIntervals = [before, ...overlapping, after].filter((item, index, all): item is RawRadiusInterval => Boolean(item) && all.indexOf(item) === index)
  const adjustedContributions: AdjustedRadiusContribution[] = []
  let cursor = start
  for (let index = 0; index < rawIntervals.length && cursor < end; index += 1) {
    const interval = rawIntervals[index]!
    const intervalStart = Math.max(start, Date.parse(interval.originalStartUtc)); const intervalEnd = Math.min(end, Date.parse(interval.originalEndUtc))
    if (intervalEnd <= cursor) continue
    if (intervalStart > cursor) adjustedContributions.push({ phase: 'UNKNOWN_UNCLASSIFIED', adjustedStartUtc: iso(cursor), adjustedEndUtc: iso(intervalStart), durationSeconds: seconds(intervalStart - cursor), rawIntervalIndex: null, identity: { eventType: null, statusCode: null, statusDescription: null }, reason: 'No Radius interval covered this part of the physical window.' })
    const clippedStart = Math.max(cursor, intervalStart)
    if (intervalEnd > clippedStart) {
      const phase = radiusPhase(interval)
      adjustedContributions.push({ phase, adjustedStartUtc: iso(clippedStart), adjustedEndUtc: iso(intervalEnd), durationSeconds: seconds(intervalEnd - clippedStart), rawIntervalIndex: index, identity: interval.identity, reason: phase === 'RADIUS_PRODUCTION_MISMATCH' ? 'Radius still recorded production during the telemetry-derived physical stop.' : phase === 'RADIUS_DATA_GAP' ? 'Radius evidence was unavailable.' : interval.operationalGroupName ?? 'Exact Radius state retained without a stronger semantic mapping.' })
      cursor = intervalEnd
    }
  }
  if (cursor < end) adjustedContributions.push({ phase: 'UNKNOWN_UNCLASSIFIED', adjustedStartUtc: iso(cursor), adjustedEndUtc: iso(end), durationSeconds: seconds(end - cursor), rawIntervalIndex: null, identity: { eventType: null, statusCode: null, statusDescription: null }, reason: 'No Radius interval covered this part of the physical window.' })
  const adjustedMs = adjustedContributions.reduce((sum, item) => sum + (Date.parse(item.adjustedEndUtc) - Date.parse(item.adjustedStartUtc)), 0)
  const physicalSeconds = seconds(end - start); const roundedContributionTotal = adjustedContributions.reduce((sum, item) => sum + item.durationSeconds, 0); const correction = Math.round((physicalSeconds - roundedContributionTotal) * 10) / 10
  if (adjustedContributions.length && correction) adjustedContributions.at(-1)!.durationSeconds = Math.round((adjustedContributions.at(-1)!.durationSeconds + correction) * 10) / 10
  const firstNonProduction = rawIntervals.find((item) => !item.isProduction && item.kind === 'radius' && Date.parse(item.originalEndUtc) > start)
  const firstReturn = firstNonProduction ? rawIntervals.find((item) => item.isProduction && Date.parse(item.originalStartUtc) >= Date.parse(firstNonProduction.originalStartUtc)) : undefined
  return {
    physicalDurationSeconds: physicalSeconds,
    adjustedDurationSeconds: physicalSeconds,
    differenceSeconds: 0,
    annotationStartLagSeconds: firstNonProduction ? seconds(Date.parse(firstNonProduction.originalStartUtc) - start) : null,
    annotationEndLagSeconds: firstReturn ? seconds(Date.parse(firstReturn.originalStartUtc) - end) : null,
    rawIntervals,
    adjustedContributions,
  }
}

function exactSequence(radius: RadiusReconciliation | null): RadiusExactIdentity[] {
  const values = (radius?.adjustedContributions ?? []).filter((item) => item.rawIntervalIndex !== null).map((item) => item.identity)
  return values.filter((item, index) => index === 0 || JSON.stringify(item) !== JSON.stringify(values[index - 1]))
}

function phaseSequence(radius: RadiusReconciliation | null): ChangeoverPhase[] {
  const values = (radius?.adjustedContributions ?? []).map((item) => item.phase)
  return values.filter((item, index) => index === 0 || item !== values[index - 1])
}

export function assembleChangeovers(input: { pressKey: RadiusPressKey; displayName: string; context: ProductionContextEvidence; stops: PhysicalStop[]; radiusSegments?: RadiusStatusSegment[]; definition?: ChangeoverDefinition }): { events: ConfirmedChangeover[]; metadataOnlyTransitions: OrderIdentityTransition[] } {
  const transitions = resolveOrderTransitions(input.context)
  const used = new Set<number>()
  const events = input.stops.map((physical): ConfirmedChangeover => {
    const start = Date.parse(physical.physicalStartUtc); const recovery = physical.physicalRecoveryUtc ? Date.parse(physical.physicalRecoveryUtc) : start
    const candidates = transitions.map((transition, index) => ({ transition, index })).filter(({ transition }) => {
      const first = Date.parse(transition.identityChangeFirstSeenAtUtc ?? '')
      return Number.isFinite(first) && first >= start - ORDER_SETTLING_MS && first <= recovery + ORDER_SETTLING_MS
    })
    let transition: OrderIdentityTransition
    let classification: ChangeoverClassification
    if (candidates.length === 1) {
      const selected = candidates[0]!; used.add(selected.index); transition = selected.transition
      classification = transition.settleState === 'CONFIRMED' && transition.previousResolvedOrder !== null && transition.finalResolvedOrder !== null && transition.previousResolvedOrder !== transition.finalResolvedOrder ? 'CONFIRMED_CHANGEOVER' : 'AMBIGUOUS_STOP'
    } else if (candidates.length > 1) {
      candidates.forEach(({ index }) => used.add(index))
      const first = candidates[0]!.transition; const last = candidates.at(-1)!.transition
      transition = { previousResolvedOrder: first.previousResolvedOrder, finalResolvedOrder: last.finalResolvedOrder, identityChangeFirstSeenAtUtc: first.identityChangeFirstSeenAtUtc, identityLastChangeAtUtc: last.identityLastChangeAtUtc, identitySettledAtUtc: last.identitySettledAtUtc, settleState: 'CONFLICTING', inferredBoundary: true, intermediateValues: candidates.flatMap(({ transition: item }) => item.intermediateValues) }
      classification = 'AMBIGUOUS_STOP'
    } else {
      const before = orderAt(input.context, transitions, start); const after = orderAt(input.context, transitions, recovery + ORDER_SETTLING_MS)
      transition = { previousResolvedOrder: before, finalResolvedOrder: after, identityChangeFirstSeenAtUtc: null, identityLastChangeAtUtc: null, identitySettledAtUtc: null, settleState: before && after ? 'RANGE_START' : 'MISSING', inferredBoundary: false, intermediateValues: [] }
      classification = before && after && before === after ? 'OTHER_STOP' : 'AMBIGUOUS_STOP'
    }
    const radius = input.radiusSegments ? reconcileRadius(physical, input.radiusSegments) : null
    const evidenceNotes = [
      'Physical bounds come from canonical actual-speed telemetry.',
      transition.inferredBoundary ? 'Order timing is an inferred asynchronous metadata transition; first-seen is not treated as physical ground truth.' : 'No settled Order transition was associated with this stop.',
      radius ? 'Radius intervals explain time only after clipping to the physical window.' : 'Radius enrichment was unavailable; the physical and Order result remains intact.',
    ]
    const definitionIdentity = input.definition ? `${input.definition.stopSpeed}\u0000${input.definition.recoverySpeed}\u0000${input.definition.recoveryConfirmationSeconds}` : '1\u0000500\u0000300'
    const changeoverId = `${input.pressKey}.co.${createHash('sha256').update(`${input.pressKey}\u0000${physical.physicalStartUtc}\u0000${physical.physicalRecoveryUtc ?? 'open'}\u0000${CHANGEOVER_ALGORITHM_VERSION}\u0000${definitionIdentity}`).digest('hex').slice(0, 18)}`
    const limitedRadius = radius?.adjustedContributions.some((item) => item.phase === 'RADIUS_DATA_GAP' || item.phase === 'UNKNOWN_UNCLASSIFIED') ?? false
    const evidenceState = physical.evidenceState !== 'CONFIRMED' || classification === 'AMBIGUOUS_STOP' || limitedRadius ? 'INSUFFICIENT_EVIDENCE' : radius ? 'COMPLETE' : 'PARTIAL'
    return { changeoverId, algorithmVersion: CHANGEOVER_ALGORITHM_VERSION, pressKey: input.pressKey, displayName: input.displayName, classification, evidenceState, physical, orderTransition: transition, radius, exactRadiusSequence: exactSequence(radius), phaseSequence: phaseSequence(radius), evidenceNotes }
  })
  return { events, metadataOnlyTransitions: transitions.filter((_item, index) => !used.has(index)) }
}

export function distribution(values: number[]): DistributionSummary {
  const ordered = values.filter(Number.isFinite).sort((a, b) => a - b)
  const at = (fraction: number) => { if (!ordered.length) return null; const position = (ordered.length - 1) * fraction; const low = Math.floor(position); const high = Math.ceil(position); return Math.round((ordered[low]! + (ordered[high]! - ordered[low]!) * (position - low)) * 10) / 10 }
  const p25 = at(.25); const p75 = at(.75)
  return { median: at(.5), p25, p75, p90: at(.9), iqr: p25 === null || p75 === null ? null : Math.round((p75 - p25) * 10) / 10, count: ordered.length }
}

export function support(count: number): EvidenceSupport {
  const level = count >= 20 ? 'strong' : count >= 8 ? 'moderate' : count >= 3 ? 'limited' : 'insufficient'
  return { level, count, description: count < 3 ? `N=${count}; no comparative or best-performance claim is made.` : `N=${count}; ${level} empirical support.` }
}

export function summarizePresses(events: ConfirmedChangeover[], focusPressKey: RadiusPressKey | null, pressStates: Map<RadiusPressKey, { displayName: string; evidenceState: ConfirmedChangeover['evidenceState']; metadataOnly: number }>): PressChangeoverSummary[] {
  return [...pressStates].map(([pressKey, state]) => {
    const pressEvents = events.filter((item) => item.pressKey === pressKey); const changes = pressEvents.filter((item) => item.classification === 'CONFIRMED_CHANGEOVER')
    const durations = changes.flatMap((item) => item.physical.durationSeconds === null ? [] : [item.physical.durationSeconds]); const totalChangeoverSeconds = durations.reduce((sum, value) => sum + value, 0); const failedRecoveryAttemptCount = changes.reduce((sum, item) => sum + item.physical.failedRecoveryAttempts.length, 0); const withFailure = changes.filter((item) => item.physical.failedRecoveryAttempts.length > 0).length
    const startLags = changes.flatMap((item) => item.radius?.annotationStartLagSeconds === null || item.radius?.annotationStartLagSeconds === undefined ? [] : [item.radius.annotationStartLagSeconds]); const endLags = changes.flatMap((item) => item.radius?.annotationEndLagSeconds === null || item.radius?.annotationEndLagSeconds === undefined ? [] : [item.radius.annotationEndLagSeconds]); const physical = changes.reduce((sum, item) => sum + (item.physical.durationSeconds ?? 0), 0); const radiusObserved = changes.reduce((sum, item) => sum + (item.radius?.adjustedContributions.filter((value) => value.rawIntervalIndex !== null && value.phase !== 'RADIUS_DATA_GAP').reduce((subtotal, value) => subtotal + value.durationSeconds, 0) ?? 0), 0)
    const phaseTotals = new Map<ChangeoverPhase, number>(); for (const change of changes) for (const item of change.radius?.adjustedContributions ?? []) phaseTotals.set(item.phase, (phaseTotals.get(item.phase) ?? 0) + item.durationSeconds)
    return { pressKey, displayName: state.displayName, evidenceState: state.evidenceState, changeoverCount: changes.length, otherStopCount: pressEvents.filter((item) => item.classification === 'OTHER_STOP').length, ambiguousStopCount: pressEvents.filter((item) => item.classification === 'AMBIGUOUS_STOP').length, metadataOnlyTransitionCount: state.metadataOnly, duration: distribution(durations), totalChangeoverSeconds: Math.round(totalChangeoverSeconds * 10) / 10, failedRecoveryAttemptCount, failedRecoveriesPerChangeover: changes.length ? Math.round(failedRecoveryAttemptCount / changes.length * 100) / 100 : null, percentWithFailedRecovery: changes.length ? Math.round(withFailure / changes.length * 1_000) / 10 : null, annotationStartLag: distribution(startLags), annotationEndLag: distribution(endLags), radiusCoveragePercent: physical ? Math.round(radiusObserved / physical * 1_000) / 10 : null, phaseMinutesPerChangeover: [...phaseTotals].map(([phase, value]) => ({ phase, minutes: changes.length ? Math.round(value / 60 / changes.length * 10) / 10 : 0 })).sort((a, b) => b.minutes - a.minutes), support: support(changes.length), focused: pressKey === focusPressKey }
  }).sort((a, b) => Number(b.focused) - Number(a.focused) || (a.duration.median ?? Infinity) - (b.duration.median ?? Infinity) || a.pressKey.localeCompare(b.pressKey))
}

export function summarizeRecoveryCohorts(events: ConfirmedChangeover[]): RecoveryCohortSummary[] {
  const bands: RecoveryCohortSummary['attemptBand'][] = ['0', '1', 'multiple']
  return bands.map((attemptBand) => { const items = events.filter((item) => { const count = item.physical.failedRecoveryAttempts.length; return attemptBand === '0' ? count === 0 : attemptBand === '1' ? count === 1 : count > 1 }); const values = items.flatMap((item) => item.physical.durationSeconds === null ? [] : [item.physical.durationSeconds]); return { attemptBand, changeoverCount: items.length, percentOfChangeovers: events.length ? Math.round(items.length / events.length * 1_000) / 10 : 0, duration: distribution(values), support: support(items.length) } })
}

export function summarizePhases(events: ConfirmedChangeover[]): PhaseSummary[] {
  const total = events.reduce((sum, item) => sum + (item.physical.durationSeconds ?? 0), 0); const map = new Map<ChangeoverPhase, { seconds: number; count: number }>()
  for (const event of events) for (const item of event.radius?.adjustedContributions ?? []) { const prior = map.get(item.phase) ?? { seconds: 0, count: 0 }; prior.seconds += item.durationSeconds; prior.count += 1; map.set(item.phase, prior) }
  return [...map].map(([phase, value]) => ({ phase, durationSeconds: Math.round(value.seconds * 10) / 10, percentOfPhysicalChangeover: total ? Math.round(value.seconds / total * 1_000) / 10 : 0, occurrenceCount: value.count })).sort((a, b) => b.durationSeconds - a.durationSeconds)
}

export function summarizeExactReasons(events: ConfirmedChangeover[]): ExactReasonSummary[] {
  const map = new Map<string, { identity: RadiusExactIdentity; phase: ChangeoverPhase; seconds: number; occurrences: number; durations: number[]; events: Set<string> }>()
  for (const event of events) for (const item of event.radius?.adjustedContributions ?? []) {
    if (item.rawIntervalIndex === null) continue
    const key = JSON.stringify([item.phase, item.identity]); const prior = map.get(key) ?? { identity: item.identity, phase: item.phase, seconds: 0, occurrences: 0, durations: [], events: new Set<string>() }
    prior.seconds += item.durationSeconds; prior.occurrences += 1; prior.durations.push(item.durationSeconds); prior.events.add(event.changeoverId); map.set(key, prior)
  }
  return [...map.values()].map((item) => ({ identity: item.identity, phase: item.phase, durationSeconds: Math.round(item.seconds * 10) / 10, minutesPerChangeover: item.events.size ? Math.round(item.seconds / 60 / item.events.size * 10) / 10 : 0, occurrenceCount: item.occurrences, changeoverCount: item.events.size, medianOccurrenceSeconds: distribution(item.durations).median, support: support(item.events.size) })).sort((a, b) => b.durationSeconds - a.durationSeconds)
}

export function summarizeSequences(events: ConfirmedChangeover[]): SequenceSummary[] {
  const map = new Map<string, ConfirmedChangeover[]>()
  for (const event of events) { const sequence = event.phaseSequence.length ? event.phaseSequence : ['UNKNOWN_UNCLASSIFIED']; const key = sequence.join(' → '); map.set(key, [...(map.get(key) ?? []), event]) }
  return [...map].map(([key, items]) => { const sequence = key.split(' → '); return { sequence, count: items.length, duration: distribution(items.flatMap((item) => item.physical.durationSeconds === null ? [] : [item.physical.durationSeconds])), failedRecoveryAttemptCount: items.reduce((sum, item) => sum + item.physical.failedRecoveryAttempts.length, 0), loopCount: sequence.length - new Set(sequence).size, support: support(items.length) } }).sort((a, b) => b.count - a.count || (b.duration.median ?? 0) - (a.duration.median ?? 0))
}

export function summarizeTransitionPairs(events: ConfirmedChangeover[]): TransitionPairSummary[] {
  const map = new Map<string, ConfirmedChangeover[]>()
  for (const event of events) { const previous = event.orderTransition.previousResolvedOrder; const current = event.orderTransition.finalResolvedOrder; if (!previous || !current || previous === current) continue; const key = `${previous}\u0000${current}`; map.set(key, [...(map.get(key) ?? []), event]) }
  return [...map].map(([key, items]) => {
    const [previousOrder, currentOrder] = key.split('\u0000') as [string, string]; const phaseTotals = new Map<ChangeoverPhase, number>(); const sequenceCounts = new Map<string, number>()
    for (const item of items) { for (const phase of item.radius?.adjustedContributions ?? []) phaseTotals.set(phase.phase, (phaseTotals.get(phase.phase) ?? 0) + phase.durationSeconds); const sequence = item.phaseSequence.join('\u0000'); sequenceCounts.set(sequence, (sequenceCounts.get(sequence) ?? 0) + 1) }
    const dominant = [...sequenceCounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0]
    return { previousOrder, currentOrder, count: items.length, duration: distribution(items.flatMap((item) => item.physical.durationSeconds === null ? [] : [item.physical.durationSeconds])), phaseMinutesPerChangeover: [...phaseTotals].map(([phase, value]) => ({ phase, minutes: Math.round(value / 60 / items.length * 10) / 10 })).sort((a, b) => b.minutes - a.minutes), dominantSequence: dominant ? dominant.split('\u0000') as ChangeoverPhase[] : [], failedRecoveryPercent: Math.round(items.filter((item) => item.physical.failedRecoveryAttempts.length).length / items.length * 1_000) / 10, presses: [...new Set(items.map((item) => item.pressKey))].sort(), support: support(items.length) }
  }).sort((a, b) => b.count - a.count || (b.duration.median ?? 0) - (a.duration.median ?? 0))
}

export function summarizeDaily(events: ConfirmedChangeover[], fromUtc: string, toUtc: string, timeZone = 'America/Chicago'): DailyChangeoverSummary[] {
  let day = DateTime.fromISO(fromUtc, { zone: 'utc' }).setZone(timeZone).startOf('day'); const final = DateTime.fromISO(toUtc, { zone: 'utc' }).setZone(timeZone).startOf('day'); const result: DailyChangeoverSummary[] = []
  while (day <= final) {
    const date = day.toISODate()!; const items = events.filter((item) => DateTime.fromISO(item.physical.physicalStartUtc, { zone: 'utc' }).setZone(timeZone).toISODate() === date); const values = items.flatMap((item) => item.physical.durationSeconds === null ? [] : [item.physical.durationSeconds])
    result.push({ date, count: items.length, durationSeconds: Math.round(values.reduce((sum, value) => sum + value, 0) * 10) / 10, medianDurationSeconds: distribution(values).median, failedRecoveryAttemptCount: items.reduce((sum, item) => sum + item.physical.failedRecoveryAttempts.length, 0) }); day = day.plus({ days: 1 })
  }
  return result
}
