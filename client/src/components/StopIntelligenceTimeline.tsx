import { useMemo } from 'react'
import type { TimedNumericSample } from '../types/evidence'
import type { ChangeoverAction, ChangeoverActionEvidence, StopIdentityEvidence, StopIntelligenceDetail } from '../types/stop-intelligence'
import { SynchronizedTimeline, type TimelineEventTrack, type TimelineIntervalItem, type TimelineIntervalTrack, type TimelineNumericTrack } from './SynchronizedTimeline'

const usefulnessOrder: StopIdentityEvidence['usefulness'][] = ['STRONG', 'MEDIUM', 'WEAK', 'UNUSABLE', 'UNAVAILABLE']

const words = (value: string) => value.replaceAll('_', ' ').toLowerCase().replace(/^./, (character) => character.toUpperCase())
const formatUtc = (value: string) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(value)) + ' UTC'
const scalar = (value: string | number | boolean | null) => value === null ? '—' : String(value)
const duration = (seconds: number) => seconds >= 60 ? `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s` : `${Math.round(seconds)}s`
const inside = (at: number, start: string, end: string) => Date.parse(start) <= at && Date.parse(end) > at
const clampUtc = (value: string, from: number, to: number) => new Date(Math.min(to, Math.max(from, Date.parse(value)))).toISOString()

export function stopActionKey(action: ChangeoverAction, index: number) {
  return `action:${action.actionCode}:${action.startAt ?? 'unknown'}:${index}`
}

function primaryIdentity(detail: StopIntelligenceDetail) {
  return [...detail.stop.identities]
    .filter((identity) => identity.available)
    .sort((left, right) => Number(!left.changed) - Number(!right.changed) || usefulnessOrder.indexOf(left.usefulness) - usefulnessOrder.indexOf(right.usefulness))[0]
}

function partitionIntervals(detail: StopIntelligenceDetail): TimelineIntervalItem[] {
  const { physicalSegment: segment } = detail.stop
  const from = Date.parse(detail.speedContext.fromUtc)
  const to = Date.parse(detail.speedContext.toUtc)
  const stopStart = Date.parse(segment.startAt)
  const stopEnd = Date.parse(segment.endAt ?? detail.speedContext.toUtc)
  const boundaries = new Set<number>([from, to, stopStart, stopEnd])
  for (const attempt of segment.movementAttempts) boundaries.add(Date.parse(attempt.startAt)).add(Date.parse(attempt.endAt))
  for (const streak of segment.failedRecoveryStreaks) boundaries.add(Date.parse(streak.startAt)).add(Date.parse(streak.endAt))
  const ordered = [...boundaries].filter((value) => Number.isFinite(value) && value >= from && value <= to).sort((left, right) => left - right)
  return ordered.slice(0, -1).flatMap((start, index) => {
    const end = ordered[index + 1]!
    if (end <= start) return []
    const midpoint = start + (end - start) / 2
    const failed = segment.failedRecoveryStreaks.find((streak) => inside(midpoint, streak.startAt, streak.endAt))
    const attempt = segment.movementAttempts.find((candidate) => inside(midpoint, candidate.startAt, candidate.endAt))
    const isStopped = midpoint >= stopStart && midpoint < stopEnd
    const label = failed ? 'Failed recovery' : attempt ? `Restart #${attempt.sequenceNumber}` : isStopped ? 'Stopped' : midpoint < stopStart ? 'Running before stop' : 'Physical recovery'
    const className = failed ? 'si-physical-failed' : attempt?.reachedRecoveryThreshold ? 'si-physical-recovery' : attempt ? 'si-physical-attempt' : isStopped ? 'si-physical-stopped' : 'si-physical-running'
    const attemptDetails = attempt ? `\nAttempt #${attempt.sequenceNumber} · ${duration(attempt.durationSeconds)}\nAverage ${attempt.averageSpeed === null ? 'Unknown' : `${Math.round(attempt.averageSpeed)} ft/min`} · Peak ${attempt.peakSpeed === null ? 'Unknown' : `${Math.round(attempt.peakSpeed)} ft/min`}\n${attempt.reachedRecoveryThreshold ? 'Reached 595 ft/min' : 'Did not reach 595 ft/min'} · ${attempt.failedRecoveryCount} failed recovery streaks` : ''
    return [{ id: `physical:${start}:${end}`, startUtc: new Date(start).toISOString(), endUtc: new Date(end).toISOString(), label, className, details: `${label}\n${formatUtc(new Date(start).toISOString())} → ${formatUtc(new Date(end).toISOString())}${attemptDetails}` }]
  })
}

function identityIntervals(detail: StopIntelligenceDetail): TimelineIntervalItem[] {
  const identity = primaryIdentity(detail)
  if (!identity) return []
  const from = Date.parse(detail.speedContext.fromUtc)
  const to = Date.parse(detail.speedContext.toUtc)
  const change = identity.changed && identity.firstChangeAtUtc ? Date.parse(identity.firstChangeAtUtc) : undefined
  const label = words(identity.field)
  if (change && change > from && change < to) return [
    { id: 'identity:before', startUtc: detail.speedContext.fromUtc, endUtc: new Date(change).toISOString(), label: `${label}: ${identity.beforeValue ?? 'Unknown'}`, className: 'si-identity-before', details: `${label} before\n${identity.beforeValue ?? 'Unknown'}\n${identity.canonicalId ?? 'No mapped canonical signal'}` },
    { id: 'identity:after', startUtc: new Date(change).toISOString(), endUtc: detail.speedContext.toUtc, label: `${label}: ${identity.afterValue ?? 'Unknown'}`, className: 'si-identity-after', details: `${label} after\n${identity.afterValue ?? 'Unknown'}\n${identity.settled ? 'Settled' : 'Not settled'}\n${identity.canonicalId ?? 'No mapped canonical signal'}` },
  ]
  return [{ id: 'identity:steady', startUtc: detail.speedContext.fromUtc, endUtc: detail.speedContext.toUtc, label: `${label}: ${identity.afterValue ?? identity.beforeValue ?? 'Unknown'}`, className: identity.changed ? 'si-identity-after' : 'si-identity-steady', details: identity.reason }]
}

function availabilityIntervals(detail: StopIntelligenceDetail): TimelineIntervalItem[] {
  const from = Date.parse(detail.speedContext.fromUtc)
  const to = Date.parse(detail.speedContext.toUtc)
  const boundaries = new Set<number>([from, to])
  for (const interval of detail.speedContext.unknownIntervals) boundaries.add(Date.parse(interval.fromUtc)).add(Date.parse(interval.toUtc))
  const ordered = [...boundaries].filter((value) => Number.isFinite(value) && value >= from && value <= to).sort((left, right) => left - right)
  return ordered.slice(0, -1).map((start, index) => {
    const end = ordered[index + 1]!
    const midpoint = start + (end - start) / 2
    const unknown = detail.speedContext.unknownIntervals.find((interval) => inside(midpoint, interval.fromUtc, interval.toUtc))
    return { id: `availability:${start}:${end}`, startUtc: new Date(start).toISOString(), endUtc: new Date(end).toISOString(), label: unknown ? words(unknown.state) : 'Available', className: unknown ? 'si-availability-unknown' : 'si-availability-good', unavailable: Boolean(unknown), details: unknown ? `${words(unknown.state)}\nUNKNOWN is not treated as zero speed.` : 'Canonical speed evidence available' }
  })
}

function speedSamples(detail: StopIntelligenceDetail): TimedNumericSample[] {
  return detail.speedContext.observations.flatMap((observation) => typeof observation.speed !== 'number' || !Number.isFinite(observation.speed) || !['good', 'true'].includes(observation.qualityState.trim().toLowerCase()) ? [] : [{ observedAtUtc: observation.atUtc, receivedAtUtc: observation.atUtc, sourceTimestampUtc: observation.atUtc, qualityState: observation.qualityState, valueKind: 'numeric' as const, value: observation.speed }])
}

function numericValue(value: ChangeoverActionEvidence['newValue']): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value)
  return undefined
}

function evidenceLabel(evidence: ChangeoverActionEvidence) {
  return evidence.canonicalId ?? evidence.rawIdentity ?? `Signal ${evidence.signalId ?? 'unknown'}`
}

export function buildSelectedSignalTracks(action?: ChangeoverAction): { numeric: TimelineNumericTrack[]; events: TimelineEventTrack[] } {
  if (!action) return { numeric: [], events: [] }
  const groups = new Map<string, ChangeoverActionEvidence[]>()
  for (const evidence of action.evidence) {
    const key = evidenceLabel(evidence)
    groups.set(key, [...(groups.get(key) ?? []), evidence])
  }
  const selectedGroups = [...groups.entries()].sort((left, right) => right[1].length - left[1].length || left[0].localeCompare(right[0])).slice(0, 6)
  const numeric: TimelineNumericTrack[] = []
  const textEvents: TimelineEventTrack['events'] = []
  for (const [label, evidenceRows] of selectedGroups) {
    const samples: TimedNumericSample[] = []
    evidenceRows.forEach((evidence, index) => {
      const before = numericValue(evidence.oldValue)
      const after = numericValue(evidence.newValue)
      if (before === undefined || after === undefined) {
        textEvents.push({ id: `signal-event:${label}:${evidence.atUtc}:${index}`, atUtc: evidence.atUtc, label: `${label}: ${scalar(evidence.oldValue)} → ${scalar(evidence.newValue)}`, category: 'context', detail: evidence.explanation })
        return
      }
      const common = { receivedAtUtc: evidence.atUtc, sourceTimestampUtc: evidence.atUtc, qualityState: evidence.normalizedQuality, valueKind: 'numeric' as const }
      samples.push({ ...common, observedAtUtc: new Date(Date.parse(evidence.atUtc) - 1).toISOString(), value: before }, { ...common, observedAtUtc: evidence.atUtc, value: after })
    })
    if (samples.length) numeric.push({ id: `signal:${label}`, label, samples, interpolation: 'step', holdLastObservation: true, connectObservedGaps: true })
  }
  return { numeric, events: textEvents.length ? [{ id: 'selected-signal-events', label: 'Selected telemetry', events: textEvents, unavailableLabel: 'No text/state transitions for this action' }] : [] }
}

export interface StopTimelineModel {
  intervalTracks: TimelineIntervalTrack[]
  numericTracks: TimelineNumericTrack[]
  eventTracks: TimelineEventTrack[]
  trackOrder: string[]
}

export function buildStopTimelineModel(detail: StopIntelligenceDetail, selectedAction?: ChangeoverAction, showSignals = false): StopTimelineModel {
  const from = Date.parse(detail.speedContext.fromUtc)
  const to = Date.parse(detail.speedContext.toUtc)
  const span = Math.max(1, to - from)
  const actionIntervals = detail.changeoverActions.eligible ? detail.changeoverActions.actions.flatMap((action, index) => {
    if (!action.startAt) return []
    const start = Date.parse(clampUtc(action.startAt, from, to))
    const suppliedEnd = Date.parse(action.endAt ?? action.startAt)
    const end = Math.min(to, Math.max(start + Math.max(1_000, span * .006), suppliedEnd))
    return [{ id: stopActionKey(action, index), startUtc: new Date(start).toISOString(), endUtc: new Date(end).toISOString(), label: action.displayName, className: `si-action-band si-action-band--${action.confidence.toLowerCase()}`, details: `${action.displayName}\n${action.confidence}\n${action.explanation}` }]
  }).sort((left, right) => Date.parse(left.startUtc) - Date.parse(right.startUtc) || Date.parse(left.endUtc) - Date.parse(right.endUtc)) : []
  const actionLanes: TimelineIntervalItem[][] = []
  for (const interval of actionIntervals) {
    const lane = actionLanes.find((items) => Date.parse(items.at(-1)!.endUtc) <= Date.parse(interval.startUtc))
    if (lane) lane.push(interval)
    else actionLanes.push([interval])
  }
  const actionTracks: TimelineIntervalTrack[] = actionLanes.length ? actionLanes.map((intervals, index) => ({ id: index ? `actions-${index + 1}` : 'actions', label: index ? `Actions · overlap ${index + 1}` : 'Actions', intervals })) : [{ id: 'actions', label: 'Actions', intervals: [], unavailableLabel: detail.changeoverActions.eligible ? 'No action established' : detail.changeoverActions.reason }]
  const intervalTracks: TimelineIntervalTrack[] = [
    { id: 'physical', label: 'Physical behavior', intervals: partitionIntervals(detail) },
    { id: 'radius', label: 'Radius', intervals: detail.stop.radius.states.map((state, index) => ({ id: `radius:${index}`, startUtc: clampUtc(state.startUtc, from, to), endUtc: clampUtc(state.endUtc, from, to), label: state.kind === 'offline' ? 'Offline' : state.statusDescription ?? state.eventType ?? 'Radius state', className: state.kind === 'offline' ? 'si-radius-offline' : state.isProduction ? detail.stop.radiusAlignment === 'CONTRADICTORY' ? 'si-radius-production si-radius-conflict' : 'si-radius-production' : 'si-radius-nonproduction', unavailable: state.kind === 'offline', details: `${state.eventType ?? 'OFFLINE'} / ${state.statusCode ?? '—'}\n${state.statusDescription ?? 'Radius unavailable'}` })), unavailableLabel: 'Radius evidence unavailable' },
    { id: 'identity', label: 'Job / identity', intervals: identityIntervals(detail), unavailableLabel: 'No usable press identity in this range' },
    ...actionTracks,
    { id: 'availability', label: 'Availability', intervals: availabilityIntervals(detail) },
  ]
  const numericTracks: TimelineNumericTrack[] = [{ id: 'actual-speed', label: 'Actual speed', unit: detail.speedContext.unit, samples: speedSamples(detail), unavailableLabel: 'No good numeric speed samples', breakIntervals: detail.speedContext.unknownIntervals, referenceLines: [{ value: detail.speedContext.stopThreshold, label: `Stop < ${detail.speedContext.stopThreshold}` }, { value: detail.speedContext.recoveryThreshold, label: `Recovery ≥ ${detail.speedContext.recoveryThreshold}` }], markers: [{ atUtc: detail.stop.physicalSegment.startAt, label: 'Physical stop', kind: 'start' }, ...(detail.stop.physicalSegment.endAt ? [{ atUtc: detail.stop.physicalSegment.endAt, label: 'Physical recovery', kind: 'end' as const }] : [])] }]
  const signalTracks = showSignals ? buildSelectedSignalTracks(selectedAction) : { numeric: [], events: [] }
  numericTracks.push(...signalTracks.numeric)
  return {
    intervalTracks,
    numericTracks,
    eventTracks: signalTracks.events,
    trackOrder: ['numeric:actual-speed', 'interval:physical', 'interval:radius', 'interval:identity', ...actionTracks.map((track) => `interval:${track.id}`), 'interval:availability', ...signalTracks.numeric.map((track) => `numeric:${track.id}`), ...signalTracks.events.map((track) => `event:${track.id}`)],
  }
}

export function stopInspectionSnapshot(detail: StopIntelligenceDetail, atUtc: string) {
  const at = Date.parse(atUtc)
  const nearestSpeed = detail.speedContext.observations
    .filter((observation) => typeof observation.speed === 'number')
    .sort((left, right) => Math.abs(Date.parse(left.atUtc) - at) - Math.abs(Date.parse(right.atUtc) - at))[0]
  const segment = detail.stop.physicalSegment
  const attempt = segment.movementAttempts.find((item) => inside(at, item.startAt, item.endAt))
  const failed = segment.failedRecoveryStreaks.find((item) => inside(at, item.startAt, item.endAt))
  const physical = failed ? 'Failed recovery' : attempt ? `Restart #${attempt.sequenceNumber}` : at >= Date.parse(segment.startAt) && at < Date.parse(segment.endAt ?? detail.speedContext.toUtc) ? 'Stopped' : at < Date.parse(segment.startAt) ? 'Running before stop' : 'Recovered'
  const radius = detail.stop.radius.states.find((state) => inside(at, state.startUtc, state.endUtc))
  const identity = primaryIdentity(detail)
  const identityValue = identity ? identity.changed && identity.firstChangeAtUtc && at >= Date.parse(identity.firstChangeAtUtc) ? identity.afterValue : identity.beforeValue ?? identity.afterValue : null
  const actions = detail.changeoverActions.actions.filter((action) => action.startAt && at >= Date.parse(action.startAt) && at <= Date.parse(action.endAt ?? action.startAt) + 1_000)
  const unavailable = detail.speedContext.unknownIntervals.find((interval) => inside(at, interval.fromUtc, interval.toUtc))
  return { nearestSpeed, physical, attempt, radius, identity, identityValue, actions, availability: unavailable?.state ?? 'AVAILABLE' }
}

function InspectionTooltip({ detail, atUtc }: { detail: StopIntelligenceDetail; atUtc: string }) {
  const snapshot = stopInspectionSnapshot(detail, atUtc)
  return <div className="si-inspection-tooltip"><header><strong>{formatUtc(atUtc)}</strong><span>Shared inspection time</span></header><dl>
    <div><dt>Actual speed</dt><dd>{snapshot.nearestSpeed?.speed ?? 'Unknown'} {snapshot.nearestSpeed?.speed === null || snapshot.nearestSpeed?.speed === undefined ? '' : detail.speedContext.unit}</dd></div>
    <div><dt>Physical</dt><dd>{snapshot.physical}{snapshot.attempt ? ` · ${duration(snapshot.attempt.durationSeconds)} · avg ${snapshot.attempt.averageSpeed === null ? 'Unknown' : Math.round(snapshot.attempt.averageSpeed)} · peak ${snapshot.attempt.peakSpeed === null ? 'Unknown' : Math.round(snapshot.attempt.peakSpeed)} ft/min · ${snapshot.attempt.reachedRecoveryThreshold ? 'reached 595' : 'below 595'} · ${snapshot.attempt.failedRecoveryCount} failed` : ''}</dd></div>
    <div><dt>Radius</dt><dd>{snapshot.radius?.kind === 'offline' ? 'Offline' : snapshot.radius?.statusDescription ?? 'Unavailable'}</dd></div>
    <div><dt>Job / identity</dt><dd>{snapshot.identity ? `${words(snapshot.identity.field)} · ${snapshot.identityValue ?? 'Unknown'}` : 'Unavailable'}</dd></div>
    <div><dt>Actions</dt><dd>{snapshot.actions.length ? snapshot.actions.map((action) => action.displayName).join(', ') : 'None at this time'}</dd></div>
    <div><dt>Availability</dt><dd>{words(snapshot.availability)}</dd></div>
  </dl></div>
}

export function StopSynchronizedTimeline({ detail, selectedAction, selectedActionKey, showSignals, onSelectAction }: { detail: StopIntelligenceDetail; selectedAction?: ChangeoverAction; selectedActionKey?: string; showSignals: boolean; onSelectAction(key: string): void }) {
  const model = useMemo(() => buildStopTimelineModel(detail, selectedAction, showSignals), [detail, selectedAction, showSignals])
  return <div className="si-investigation-timeline">
    <SynchronizedTimeline fromUtc={detail.speedContext.fromUtc} toUtc={detail.speedContext.toUtc} intervalTracks={model.intervalTracks} numericTracks={model.numericTracks} eventTracks={model.eventTracks} trackOrder={model.trackOrder} selectedId={selectedActionKey} onSelect={(item, track) => { if (track.id.startsWith('actions')) onSelectAction(item.id) }} highlightedRange={{ fromUtc: detail.stop.physicalSegment.startAt, toUtc: detail.stop.physicalSegment.endAt ?? detail.speedContext.toUtc, label: 'Measured physical stop' }} renderInspectionTooltip={(atUtc) => <InspectionTooltip detail={detail} atUtc={atUtc}/>} minimumCanvasWidth={900} ariaLabel={`${detail.displayName} synchronized stop investigation timeline`} />
  </div>
}
