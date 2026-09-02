import { useEffect, useMemo, useState } from 'react'
import { formatPlantDateTimeCt } from '../time-ranges'
import type { TimedNumericSample } from '../types/evidence'
import type { ChangeoverAction, ChangeoverActionCode, ChangeoverActionEvidence, StopIdentityEvidence, StopIntelligenceDetail } from '../types/stop-intelligence'
import { SynchronizedTimeline, type TimelineEventTrack, type TimelineIntervalItem, type TimelineIntervalTrack, type TimelineNumericTrack } from './SynchronizedTimeline'
import { buildDeckStatusTimelineTracks } from './StopDeckStatusGantt'

const usefulnessOrder: StopIdentityEvidence['usefulness'][] = ['STRONG', 'MEDIUM', 'WEAK', 'UNUSABLE', 'UNAVAILABLE']

const words = (value: string) => value.replaceAll('_', ' ').toLowerCase().replace(/^./, (character) => character.toUpperCase())
const formatUtc = (value: string) => formatPlantDateTimeCt(value)
const scalar = (value: string | number | boolean | null) => value === null ? '—' : String(value)
const duration = (seconds: number) => seconds >= 60 ? `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s` : `${Math.round(seconds)}s`
const inside = (at: number, start: string, end: string) => Date.parse(start) <= at && Date.parse(end) > at
const clampUtc = (value: string, from: number, to: number) => new Date(Math.min(to, Math.max(from, Date.parse(value)))).toISOString()
const stableColorHash = (value: string) => [...value].reduce((hash, character) => (hash * 31 + character.charCodeAt(0)) >>> 0, 2166136261)
const orderIdentityPalette = ['#5147a8', '#247686', '#9a572e', '#77477f', '#2d7059', '#87513f', '#3d638f', '#876b25']

export function investigationRadiusCodeStyle(eventType: string | null, statusCode: string | null): TimelineIntervalItem['style'] {
  const exactCode = `${eventType ?? 'UNKNOWN'}:${statusCode ?? 'UNKNOWN'}`.toUpperCase()
  const family = (eventType ?? '').trim().charAt(0).toUpperCase()
  const [baseHue, saturation] = family === 'G' ? [142, 58] : family === 'M' ? [212, 64] : family === 'B' ? [29, 72] : family === 'S' ? [278, 52] : [188, 42]
  const hash = stableColorHash(exactCode)
  return { background: `hsl(${baseHue + hash % 13 - 6} ${saturation}% ${33 + Math.floor(hash / 13) % 15}%)`, color: '#fff' }
}

export function stopActionKey(action: ChangeoverAction, index: number) {
  return `action:${action.actionCode}:${action.startAt ?? 'unknown'}:${index}`
}

const actionColors: Record<ChangeoverActionCode, string> = {
  PREVIOUS_JOB_FINISHED: '#4f6d7a',
  JOB_IDENTITY_TRANSITION: '#3d6fb4',
  ROLL_TRANSITION: '#b65387',
  DECK_MOVEMENT: '#7258b8',
  WASH_ACTIVITY: '#168c85',
  INK_PUMP_ACTIVITY: '#c17825',
  IMPRESSION_ADJUSTMENT: '#c0524f',
  REGISTRATION_ADJUSTMENT: '#328aa0',
  ANILOX_ACTIVITY: '#9a6a25',
  COLOR_RELATED_ACTIVITY: '#9a4f87',
  UNCANONICALIZED_RAW_ACTIVITY: '#657981',
  TRIAL_RUN: '#557f3d',
  FAILED_RECOVERY: '#a43f45',
  PHYSICAL_RECOVERY: '#2f8060',
  VISTAPORT_ACTIVITY: '#4d78a8',
  CHOPOVER: '#9a6243',
  KNIFE_CUTTING_ACTIVITY: '#8062a4',
  MASTER_IMAGE_RUN: '#447d73',
}

export function actionBandColor(actionCode: ChangeoverActionCode) {
  return actionColors[actionCode]
}

function primaryIdentity(detail: StopIntelligenceDetail) {
  return [...detail.stop.identities]
    .filter((identity) => identity.available)
    .sort((left, right) => Number(!left.changed) - Number(!right.changed) || usefulnessOrder.indexOf(left.usefulness) - usefulnessOrder.indexOf(right.usefulness))[0]
}

export function physicalBehaviorIntervals(detail: StopIntelligenceDetail): TimelineIntervalItem[] {
  const { physicalSegment: segment } = detail.stop
  const from = Date.parse(detail.speedContext.fromUtc)
  const to = Date.parse(detail.speedContext.toUtc)
  const stopStart = Date.parse(segment.startAt)
  const stopEnd = Date.parse(segment.endAt ?? detail.speedContext.toUtc)
  const boundaries = new Set<number>([from, to, stopStart, stopEnd])
  for (const attempt of segment.movementAttempts) boundaries.add(Date.parse(attempt.startAt)).add(Date.parse(attempt.endAt))
  const ordered = [...boundaries].filter((value) => Number.isFinite(value) && value >= from && value <= to).sort((left, right) => left - right)
  return ordered.slice(0, -1).flatMap((start, index) => {
    const end = ordered[index + 1]!
    if (end <= start) return []
    const midpoint = start + (end - start) / 2
    const attempt = segment.movementAttempts.find((candidate) => inside(midpoint, candidate.startAt, candidate.endAt))
    const isStopped = midpoint >= stopStart && midpoint < stopEnd
    const successfulRecovery = attempt?.reachedRecoveryThreshold && attempt.failedRecoveryCount === 0 && Math.abs(Date.parse(attempt.endAt) - stopEnd) <= 1_000
    const testing = Boolean(isStopped && attempt && !successfulRecovery)
    const label = testing ? `Testing #${attempt!.sequenceNumber}` : isStopped && !successfulRecovery ? 'Stopped' : 'Running'
    const className = testing ? 'si-physical-testing' : isStopped && !successfulRecovery ? 'si-physical-stopped' : 'si-physical-running'
    const attemptDetails = testing ? `\nSpeed-only test #${attempt!.sequenceNumber} · ${duration(attempt!.durationSeconds)}\nAverage ${attempt!.averageSpeed === null ? 'Unknown' : `${Math.round(attempt!.averageSpeed)} ft/min`} · Peak ${attempt!.peakSpeed === null ? 'Unknown' : `${Math.round(attempt!.peakSpeed)} ft/min`}\nMovement occurred during the physical stop and did not become sustained recovery.` : ''
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
  const colors = new Map<string, string>()
  for (const value of [identity.beforeValue, identity.afterValue]) if (value !== null && !colors.has(value)) colors.set(value, orderIdentityPalette[colors.size % orderIdentityPalette.length]!)
  const identityStyle = (value: string | null) => ({ background: value === null ? orderIdentityPalette[0] : colors.get(value) ?? orderIdentityPalette[0], color: '#fff' })
  if (change && change > from && change < to) return [
    { id: 'identity:before', startUtc: detail.speedContext.fromUtc, endUtc: new Date(change).toISOString(), label: `${label}: ${identity.beforeValue ?? 'Unknown'}`, className: 'si-identity-before', style: identityStyle(identity.beforeValue), details: `${label} before\n${identity.beforeValue ?? 'Unknown'}\n${identity.canonicalId ?? 'No mapped canonical signal'}` },
    { id: 'identity:after', startUtc: new Date(change).toISOString(), endUtc: detail.speedContext.toUtc, label: `${label}: ${identity.afterValue ?? 'Unknown'}`, className: 'si-identity-after', style: identityStyle(identity.afterValue), details: `${label} after\n${identity.afterValue ?? 'Unknown'}\n${identity.settled ? 'Settled' : 'Not settled'}\n${identity.canonicalId ?? 'No mapped canonical signal'}` },
  ]
  const value = identity.afterValue ?? identity.beforeValue
  return [{ id: 'identity:steady', startUtc: detail.speedContext.fromUtc, endUtc: detail.speedContext.toUtc, label: `${label}: ${value ?? 'Unknown'}`, className: identity.changed ? 'si-identity-after' : 'si-identity-steady', style: identityStyle(value), details: identity.reason }]
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

export type ActionSignalContext = StopIntelligenceDetail['actionSignalContext'][number]

export function actionSignalLabel(signal: ActionSignalContext) {
  if (signal.canonicalId === 'raw.uncanonicalized') return `RAW · ${signal.component ?? signal.rawIdentity ?? 'Uncanonicalized signal'}`
  const identity = signal.canonicalId || signal.rawIdentity || `Signal ${signal.signalId ?? 'unknown'}`
  return `${identity}${signal.deckNumber === null ? '' : ` · Deck ${signal.deckNumber}`}`
}

export const actionSignalTrackKey = (signal: ActionSignalContext) => [signal.signalId ?? 'no-id', signal.canonicalId, signal.deckNumber ?? 'press', signal.rawIdentity ?? 'no-raw'].join(':')

function actionSignalForTrack(trackId: string, contexts: ActionSignalContext[]) {
  return contexts.find((signal) => trackId === `signal:${actionSignalTrackKey(signal)}` || trackId === `selected-signal:${actionSignalTrackKey(signal)}`)
}

function evidenceMatchesSignal(evidence: ChangeoverActionEvidence, signal: ActionSignalContext): boolean {
  if (evidence.signalId !== null && signal.signalId !== null) return evidence.signalId === signal.signalId
    && (!evidence.canonicalId || evidence.canonicalId === signal.canonicalId)
    && (evidence.deckNumber === null || evidence.deckNumber === signal.deckNumber)
  if (evidence.rawIdentity && signal.rawIdentity) return evidence.rawIdentity === signal.rawIdentity
    && (!evidence.canonicalId || evidence.canonicalId === signal.canonicalId)
    && (evidence.deckNumber === null || evidence.deckNumber === signal.deckNumber)
  return evidence.signalId === null && evidence.canonicalId !== null && evidence.canonicalId === signal.canonicalId && evidence.deckNumber === signal.deckNumber
}

function actionContextCanonicalIds(action: ChangeoverAction): string[] {
  switch (action.actionCode) {
    case 'ROLL_TRANSITION': return ['production.roll', 'production.roll.length.actual']
    case 'INK_PUMP_ACTIVITY': return ['ink.pump.status', 'ink.pump.sequence', 'ink.pump.frequency.supply', 'ink.pump.frequency.return', 'ink.viscosity.mode', 'ink.viscosity.status']
    case 'WASH_ACTIVITY': return ['ink.washup.state']
    case 'PREVIOUS_JOB_FINISHED':
    case 'JOB_IDENTITY_TRANSITION': return ['production.order', 'production.previous_order', 'production.recipe', 'production.customer', 'production.material']
    default: return []
  }
}

function actionContextFamilyMatch(action: ChangeoverAction, canonicalId: string) {
  if (action.actionCode === 'DECK_MOVEMENT') return canonicalId.startsWith('deck.')
  if (action.actionCode === 'IMPRESSION_ADJUSTMENT') return canonicalId.startsWith('impression.')
  if (action.actionCode === 'REGISTRATION_ADJUSTMENT') return canonicalId.startsWith('register.')
  if (action.actionCode === 'ANILOX_ACTIVITY') return /^anilox\.(?:drive\.)?(?:active|engaged|position|selection|selected|change|command|mode)(?:\.|$)/i.test(canonicalId)
  return false
}

export function selectedActionSignalContext(contexts: ActionSignalContext[], selected?: ChangeoverAction | ChangeoverAction[]): ActionSignalContext[] {
  const actions = selected ? Array.isArray(selected) ? selected : [selected] : []
  if (!actions.length) return []
  const evidence = actions.flatMap((action) => action.evidence)
  const hasDirectEvidence = evidence.some((item) => item.signalId !== null || item.rawIdentity !== null || item.canonicalId !== null)
  const supplementalCanonicalIds = new Set(actions.flatMap((action) => action.actionCode === 'ROLL_TRANSITION' ? ['production.roll.length.actual'] : []))
  const fallbackCanonicalIds = new Set(actions.flatMap(actionContextCanonicalIds))
  const matching = contexts
    .filter((signal) => evidence.some((item) => evidenceMatchesSignal(item, signal))
      || supplementalCanonicalIds.has(signal.canonicalId)
      || !hasDirectEvidence && (fallbackCanonicalIds.has(signal.canonicalId) || actions.some((action) => actionContextFamilyMatch(action, signal.canonicalId))))
    .sort((left, right) => left.canonicalId.localeCompare(right.canonicalId) || (left.deckNumber ?? 0) - (right.deckNumber ?? 0))
  const byCanonical = new Map<string, ActionSignalContext[]>()
  for (const signal of matching) byCanonical.set(signal.canonicalId, [...(byCanonical.get(signal.canonicalId) ?? []), signal])
  const balanced: ActionSignalContext[] = []
  for (let deckIndex = 0; balanced.length < 12 && [...byCanonical.values()].some((signals) => deckIndex < signals.length); deckIndex += 1) {
    for (const signals of byCanonical.values()) {
      if (signals[deckIndex]) balanced.push(signals[deckIndex]!)
      if (balanced.length === 12) break
    }
  }
  return balanced
}

export function buildSelectedSignalTracks(selected?: ChangeoverAction | ChangeoverAction[], contexts: ActionSignalContext[] = [], fromUtc?: string, toUtc?: string, visibleSignalKeys?: string[]): { numeric: TimelineNumericTrack[]; intervals: TimelineIntervalTrack[]; events: TimelineEventTrack[] } {
  const actions = selected ? Array.isArray(selected) ? selected : [selected] : []
  if (!actions.length && visibleSignalKeys === undefined) return { numeric: [], intervals: [], events: [] }
  const visibleKeySet = visibleSignalKeys === undefined ? undefined : new Set(visibleSignalKeys)
  const selectedContexts = visibleKeySet ? contexts.filter((signal) => visibleKeySet.has(actionSignalTrackKey(signal))) : selectedActionSignalContext(contexts, actions)
  if (visibleKeySet && !selectedContexts.length) return { numeric: [], intervals: [], events: [] }
  if (selectedContexts.length && fromUtc && toUtc) {
    const numeric: TimelineNumericTrack[] = []
    const intervals: TimelineIntervalTrack[] = []
    for (const signal of selectedContexts) {
      const label = actionSignalLabel(signal)
      const parsed = signal.observations.map((observation) => ({ observation, value: numericValue(observation.value) }))
      const isNumeric = parsed.length > 0 && parsed.every(({ value }) => value !== undefined)
      const evidenceTimes = actions.flatMap((action) => action.evidence.filter((item) => evidenceMatchesSignal(item, signal)).map((item) => item.atUtc))
      const belongsToSelectedAction = selectedActionSignalContext(contexts, actions).some((item) => actionSignalTrackKey(item) === actionSignalTrackKey(signal))
      const markerTimes = [...new Set(evidenceTimes.length ? evidenceTimes : belongsToSelectedAction ? actions.flatMap((action) => action.startAt ? [action.startAt] : []) : [])]
      if (isNumeric) {
        numeric.push({
          id: `signal:${actionSignalTrackKey(signal)}`,
          label,
          unit: signal.unit,
          samples: parsed.map(({ observation, value }) => ({ observedAtUtc: observation.atUtc, receivedAtUtc: observation.atUtc, sourceTimestampUtc: observation.atUtc, qualityState: observation.qualityState, valueKind: 'numeric' as const, value: value! })),
          interpolation: signal.representation === 'changes' ? 'step' : 'linear',
          holdLastObservation: signal.representation === 'changes',
          connectObservedGaps: true,
          highlightedRanges: actions.flatMap((action) => action.startAt ? [{ fromUtc: action.startAt, toUtc: action.endAt && Date.parse(action.endAt) > Date.parse(action.startAt) ? action.endAt : new Date(Date.parse(action.startAt) + 1_000).toISOString(), label: `${action.displayName} observed change window` }] : []),
          markers: markerTimes.map((atUtc) => ({ atUtc, label: 'Observed action change', kind: 'trigger' as const })),
          unavailableLabel: `No good ${label} observations in the context window`,
        })
        continue
      }
      const observations = [...signal.observations].sort((left, right) => Date.parse(left.atUtc) - Date.parse(right.atUtc))
      intervals.push({
        id: `selected-signal:${actionSignalTrackKey(signal)}`,
        label,
        intervals: observations.flatMap((observation, index) => {
          const start = Math.max(Date.parse(fromUtc), Date.parse(observation.atUtc))
          const end = Math.min(Date.parse(toUtc), Date.parse(observations[index + 1]?.atUtc ?? toUtc))
          if (!Number.isFinite(start) || end <= start) return []
          const isChange = markerTimes.some((atUtc) => Math.abs(Date.parse(atUtc) - Date.parse(observation.atUtc)) < 1_000)
          return [{ id: `selected-signal:${actionSignalTrackKey(signal)}:${index}`, startUtc: new Date(start).toISOString(), endUtc: new Date(end).toISOString(), label: scalar(observation.value), className: `si-selected-signal-state ${isChange ? 'is-change' : ''}`.trim(), details: `${label}\nValue ${scalar(observation.value)}\n${formatUtc(new Date(start).toISOString())} → ${formatUtc(new Date(end).toISOString())}` }]
        }),
        unavailableLabel: `No good ${label} observations in the context window`,
      })
    }
    return { numeric, intervals, events: [] }
  }

  // Compatibility fallback for action evidence without full context history.
  const groups = new Map<string, ChangeoverActionEvidence[]>()
  for (const evidence of actions.flatMap((action) => action.evidence)) {
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
  return { numeric, intervals: [], events: textEvents.length ? [{ id: 'selected-signal-events', label: 'Selected telemetry', events: textEvents, unavailableLabel: 'No text/state transitions for this action' }] : [] }
}

export interface StopTimelineModel {
  intervalTracks: TimelineIntervalTrack[]
  numericTracks: TimelineNumericTrack[]
  eventTracks: TimelineEventTrack[]
  trackOrder: string[]
}

export function buildStopTimelineModel(detail: StopIntelligenceDetail, selectedActions: ChangeoverAction | ChangeoverAction[] = [], visibleSignalKeys?: string[], includeStageBreakdown = true): StopTimelineModel {
  const from = Date.parse(detail.speedContext.fromUtc)
  const to = Date.parse(detail.speedContext.toUtc)
  const span = Math.max(1, to - from)
  const actionIntervals = detail.changeoverActions.eligible ? detail.changeoverActions.actions.flatMap((action, index) => {
    if (!action.startAt || action.actionCode === 'UNCANONICALIZED_RAW_ACTIVITY') return []
    const start = Date.parse(clampUtc(action.startAt, from, to))
    const suppliedEnd = Date.parse(action.endAt ?? action.startAt)
    const end = Math.min(to, Math.max(start + Math.max(1_000, span * .006), suppliedEnd))
    return [{ id: stopActionKey(action, index), startUtc: new Date(start).toISOString(), endUtc: new Date(end).toISOString(), label: action.displayName, className: `si-action-band si-action-band--${action.confidence.toLowerCase()}`, style: { background: actionBandColor(action.actionCode) }, details: action.displayName }]
  }).sort((left, right) => Date.parse(left.startUtc) - Date.parse(right.startUtc) || Date.parse(left.endUtc) - Date.parse(right.endUtc)) : []
  const actionLanes: TimelineIntervalItem[][] = []
  for (const interval of actionIntervals) {
    const lane = actionLanes.find((items) => Date.parse(items.at(-1)!.endUtc) <= Date.parse(interval.startUtc))
    if (lane) lane.push(interval)
    else actionLanes.push([interval])
  }
  const actionTracks: TimelineIntervalTrack[] = actionLanes.length ? actionLanes.map((intervals, index) => ({ id: index ? `actions-${index + 1}` : 'actions', label: index ? `Actions · overlap ${index + 1}` : 'Actions', intervals })) : [{ id: 'actions', label: 'Actions', intervals: [], unavailableLabel: detail.changeoverActions.eligible ? 'No action established' : detail.changeoverActions.reason }]
  const deckStatusTracks = buildDeckStatusTimelineTracks(detail)
  const stageBreakdownTracks: TimelineIntervalTrack[] = includeStageBreakdown ? Array.from((detail.changeoverActivityWindows ?? []).reduce((tracks, stage, index) => {
    const existing = tracks.get(stage.kind)
    const interval = { id: `changeover-stage:${index}`, startUtc: stage.startAt, endUtc: stage.endAt, label: stage.label, compactLabel: stage.label.replace(/ (?:-|·) Radius fallback$/i, ''), className: `si-changeover-stage si-changeover-stage--${stage.kind} ${stage.source === 'RADIUS_FALLBACK' ? 'is-radius-fallback' : ''}`.trim(), details: `${stage.label}\n${formatUtc(stage.startAt)} → ${formatUtc(stage.endAt)}\n${stage.explanation}${stage.evidenceDetails?.length ? `\n${stage.evidenceDetails.join('\n')}` : ''}` }
    if (existing) existing.intervals.push(interval)
    else tracks.set(stage.kind, { id: `changeover-stage-${stage.kind}`, label: stage.label, className: 'si-changeover-stage-row', intervals: [interval] })
    return tracks
  }, new Map<string, TimelineIntervalTrack>()).values()) : []
  const intervalTracks: TimelineIntervalTrack[] = [
    ...deckStatusTracks,
    { id: 'physical', label: 'Physical behavior', intervals: physicalBehaviorIntervals(detail) },
    { id: 'radius', label: 'Radius', alwaysShowLabels: true, intervals: (detail.radiusContext?.states ?? detail.stop.radius.states).map((state, index) => { const code = state.kind === 'offline' ? 'OFFLINE' : `${state.eventType ?? '—'}${state.statusCode ?? '—'}`; return { id: `radius:${index}`, startUtc: clampUtc(state.startUtc, from, to), endUtc: clampUtc(state.endUtc, from, to), label: state.kind === 'offline' ? 'Offline' : state.statusDescription ?? code, compactLabel: code, className: state.kind === 'offline' ? 'si-radius-offline' : state.isProduction ? detail.stop.radiusAlignment === 'CONTRADICTORY' ? 'si-radius-production si-radius-conflict' : 'si-radius-production' : 'si-radius-nonproduction', style: state.kind === 'offline' || state.isProduction ? undefined : investigationRadiusCodeStyle(state.eventType, state.statusCode), unavailable: state.kind === 'offline', details: `Code ${code}\n${state.statusDescription ?? 'Radius unavailable'}\n${formatUtc(state.startUtc)} → ${formatUtc(state.endUtc)}` } }), unavailableLabel: detail.radiusContext?.reason ?? 'Radius evidence unavailable' },
    ...stageBreakdownTracks,
    { id: 'identity', label: 'Job / identity', intervals: identityIntervals(detail), unavailableLabel: 'No usable press identity in this range' },
    ...actionTracks,
  ]
  const numericTracks: TimelineNumericTrack[] = [{ id: 'actual-speed', label: 'Actual speed', unit: detail.speedContext.unit, samples: speedSamples(detail), interpolation: 'step', holdLastObservation: true, connectObservedGaps: true, unavailableLabel: 'No good numeric speed samples', breakIntervals: detail.speedContext.unknownIntervals, referenceLines: [{ value: detail.speedContext.stopThreshold, label: `Stop < ${detail.speedContext.stopThreshold}` }, { value: detail.speedContext.recoveryThreshold, label: `Recovery ≥ ${detail.speedContext.recoveryThreshold}` }], markers: [{ atUtc: detail.stop.physicalSegment.startAt, label: 'Physical stop', kind: 'start' }, ...(detail.stop.physicalSegment.endAt ? [{ atUtc: detail.stop.physicalSegment.endAt, label: 'Physical recovery', kind: 'end' as const }] : [])] }]
  const signalTracks = buildSelectedSignalTracks(selectedActions, detail.actionSignalContext, detail.speedContext.fromUtc, detail.speedContext.toUtc, visibleSignalKeys)
  intervalTracks.push(...signalTracks.intervals)
  numericTracks.push(...signalTracks.numeric)
  return {
    intervalTracks,
    numericTracks,
    eventTracks: signalTracks.events,
    trackOrder: [...deckStatusTracks.map((track) => `interval:${track.id}`), 'numeric:actual-speed', 'interval:physical', 'interval:radius', ...stageBreakdownTracks.map((track) => `interval:${track.id}`), 'interval:identity', ...actionTracks.map((track) => `interval:${track.id}`), ...signalTracks.intervals.map((track) => `interval:${track.id}`), ...signalTracks.numeric.map((track) => `numeric:${track.id}`), ...signalTracks.events.map((track) => `event:${track.id}`)],
  }
}

export function stopInspectionSnapshot(detail: StopIntelligenceDetail, atUtc: string) {
  const at = Date.parse(atUtc)
  const nearestSpeed = detail.speedContext.observations
    .filter((observation) => typeof observation.speed === 'number')
    .sort((left, right) => Math.abs(Date.parse(left.atUtc) - at) - Math.abs(Date.parse(right.atUtc) - at))[0]
  const segment = detail.stop.physicalSegment
  const attempt = segment.movementAttempts.find((item) => inside(at, item.startAt, item.endAt))
  const stopEnd = Date.parse(segment.endAt ?? detail.speedContext.toUtc)
  const successfulRecovery = attempt?.reachedRecoveryThreshold && attempt.failedRecoveryCount === 0 && Math.abs(Date.parse(attempt.endAt) - stopEnd) <= 1_000
  const testing = Boolean(attempt && !successfulRecovery && at >= Date.parse(segment.startAt) && at < stopEnd)
  const physical = testing ? `Testing #${attempt!.sequenceNumber}` : at >= Date.parse(segment.startAt) && at < stopEnd && !successfulRecovery ? 'Stopped' : 'Running'
  const radius = (detail.radiusContext?.states ?? detail.stop.radius.states).find((state) => inside(at, state.startUtc, state.endUtc))
  const identity = primaryIdentity(detail)
  const identityValue = identity ? identity.changed && identity.firstChangeAtUtc && at >= Date.parse(identity.firstChangeAtUtc) ? identity.afterValue : identity.beforeValue ?? identity.afterValue : null
  const actions = detail.changeoverActions.actions.filter((action) => action.startAt && at >= Date.parse(action.startAt) && at <= Date.parse(action.endAt ?? action.startAt) + 1_000)
  const unavailable = detail.speedContext.unknownIntervals.find((interval) => inside(at, interval.fromUtc, interval.toUtc))
  return { nearestSpeed, physical, attempt, radius, identity, identityValue, actions, availability: unavailable?.state ?? 'AVAILABLE' }
}

export function selectedSignalSnapshots(detail: StopIntelligenceDetail, selectedActions: ChangeoverAction[], atUtc: string, numericTrackId?: string, visibleSignalKeys?: string[]) {
  const at = Date.parse(atUtc)
  const visibleKeySet = visibleSignalKeys === undefined ? undefined : new Set(visibleSignalKeys)
  const contexts = visibleKeySet ? detail.actionSignalContext.filter((signal) => visibleKeySet.has(actionSignalTrackKey(signal))) : selectedActionSignalContext(detail.actionSignalContext, selectedActions)
  return contexts.filter((signal) => !numericTrackId || numericTrackId === `signal:${actionSignalTrackKey(signal)}`).map((signal) => {
    const ordered = [...signal.observations].sort((left, right) => Date.parse(left.atUtc) - Date.parse(right.atUtc))
    const observation = ordered.filter((item) => Date.parse(item.atUtc) <= at).at(-1) ?? ordered[0]
    const changes = selectedActions.flatMap((action) => action.evidence)
      .filter((item) => evidenceMatchesSignal(item, signal))
      .sort((left, right) => Date.parse(left.atUtc) - Date.parse(right.atUtc))
    return { label: actionSignalLabel(signal), unit: signal.unit, observation, changes }
  }).filter((item) => item.observation)
}

function ActionSignalTooltipRows({ signals }: { signals: ReturnType<typeof selectedSignalSnapshots> }) {
  if (!signals.length) return null
  return <section className="si-inspection-signals"><strong>Action signals</strong>{signals.map(({ label, unit, observation, changes }) => <div key={label}><span title={label}>{label}</span><b>At cursor · {scalar(observation!.value)}{unit ? ` ${unit}` : ''}</b>{changes.map((change, index) => <small key={`${change.atUtc}:${index}`}>{scalar(change.oldValue)} → {scalar(change.newValue)} · {formatUtc(change.atUtc)}</small>)}</div>)}</section>
}

function InspectionTooltip({ detail, selectedActions, atUtc, numericTrackId, numericTrackLabel, intervalItem, intervalTrackId, visibleSignalKeys }: { detail: StopIntelligenceDetail; selectedActions: ChangeoverAction[]; atUtc: string; numericTrackId?: string; numericTrackLabel?: string; intervalItem?: TimelineIntervalItem; intervalTrackId?: string; visibleSignalKeys?: string[] }) {
  const snapshot = stopInspectionSnapshot(detail, atUtc)
  if (intervalTrackId?.startsWith('deck-status-') && intervalItem) {
    const deckNumber = intervalTrackId.slice('deck-status-'.length)
    const isEvent = intervalItem.id.includes(':event:')
    return <div className="si-inspection-tooltip si-deck-inspection-tooltip"><header><div><b>Deck {deckNumber}</b><strong>{formatUtc(atUtc)}</strong></div><span>At inspection time</span></header><section className="si-deck-inspection-summary"><h3>{intervalItem.label}</h3><small>{isEvent ? formatUtc(atUtc) : `${formatUtc(intervalItem.startUtc)} → ${formatUtc(intervalItem.endUtc)} · ${duration((Date.parse(intervalItem.endUtc) - Date.parse(intervalItem.startUtc)) / 1_000)}`}</small></section></div>
  }
  const hoveredRadius = intervalTrackId === 'radius' && intervalItem ? (detail.radiusContext?.states ?? detail.stop.radius.states)[Number(intervalItem.id.split(':')[1])] : undefined
  if (hoveredRadius) {
    const code = hoveredRadius.kind === 'offline' ? 'OFFLINE' : `${hoveredRadius.eventType ?? '—'}${hoveredRadius.statusCode ?? '—'}`
    return <div className="si-inspection-tooltip si-radius-inspection-tooltip"><header><div><b>Radius</b><strong>{formatUtc(atUtc)}</strong></div><span>At inspection time</span></header><section className="si-radius-inspection-summary"><strong>{code}</strong><h3>{hoveredRadius.statusDescription ?? 'Radius unavailable'}</h3><small>{formatUtc(hoveredRadius.startUtc)} → {formatUtc(hoveredRadius.endUtc)}</small></section></div>
  }
  const hoveredStage = intervalTrackId?.startsWith('changeover-stage-') && intervalItem ? detail.changeoverActivityWindows?.[Number(intervalItem.id.split(':')[1])] : undefined
  if (hoveredStage) return <div className="si-inspection-tooltip si-stage-inspection-tooltip"><header><div><b>Changeover activity window</b><strong>{formatUtc(atUtc)}</strong></div><span>Observed breakdown · windows may overlap</span></header><section className="si-action-inspection-summary"><h3>{hoveredStage.label}</h3><small>{formatUtc(hoveredStage.startAt)} → {formatUtc(hoveredStage.endAt)} · {duration((Date.parse(hoveredStage.endAt) - Date.parse(hoveredStage.startAt)) / 1_000)}</small><p>{hoveredStage.explanation}</p>{hoveredStage.evidenceDetails.map((detailLine, index) => <small key={index}>{detailLine}</small>)}</section></div>
  const hoveredAction = intervalTrackId?.startsWith('actions') && intervalItem
    ? detail.changeoverActions.actions.find((action, index) => stopActionKey(action, index) === intervalItem.id)
    : undefined
  if (hoveredAction) {
    const actionSignals = selectedSignalSnapshots(detail, [hoveredAction], atUtc)
    return <div className="si-inspection-tooltip si-action-inspection-tooltip"><header><div><b>Action</b><strong>{formatUtc(atUtc)}</strong></div><span>At inspection time</span></header><section className="si-action-inspection-summary" style={{ borderLeftColor: actionBandColor(hoveredAction.actionCode) }}><h3>{hoveredAction.displayName}</h3><p>{hoveredAction.explanation}</p></section><ActionSignalTooltipRows signals={actionSignals}/></div>
  }
  const selectedSignals = numericTrackId?.startsWith('signal:') ? selectedSignalSnapshots(detail, selectedActions, atUtc, numericTrackId, visibleSignalKeys) : []
  return <div className="si-inspection-tooltip"><header><div><b>{numericTrackLabel ?? 'Timeline context'}</b><strong>{formatUtc(atUtc)}</strong></div><span>Shared inspection time</span></header><dl>
    <div><dt>Actual speed</dt><dd>{snapshot.nearestSpeed?.speed ?? 'Unknown'} {snapshot.nearestSpeed?.speed === null || snapshot.nearestSpeed?.speed === undefined ? '' : detail.speedContext.unit}</dd></div>
    <div><dt>Physical</dt><dd>{snapshot.physical}{snapshot.physical.startsWith('Testing') && snapshot.attempt ? ` · ${duration(snapshot.attempt.durationSeconds)} · avg ${snapshot.attempt.averageSpeed === null ? 'Unknown' : Math.round(snapshot.attempt.averageSpeed)} · peak ${snapshot.attempt.peakSpeed === null ? 'Unknown' : Math.round(snapshot.attempt.peakSpeed)} ft/min` : ''}</dd></div>
    <div><dt>Radius</dt><dd>{snapshot.radius?.kind === 'offline' ? 'Offline' : snapshot.radius?.statusDescription ?? 'Unavailable'}</dd></div>
    <div><dt>Job / identity</dt><dd>{snapshot.identity ? `${words(snapshot.identity.field)} · ${snapshot.identityValue ?? 'Unknown'}` : 'Unavailable'}</dd></div>
  </dl><ActionSignalTooltipRows signals={selectedSignals}/></div>
}

export function StopSynchronizedTimeline({ detail, selectedActions, selectedActionKey, visibleSignalKeys, hiddenSignalKeys = [], pinnedSignalKeys = [], onToggleHiddenSignal, onTogglePinnedSignal, onSelectAction }: { detail: StopIntelligenceDetail; selectedActions: ChangeoverAction[]; selectedActionKey?: string; visibleSignalKeys?: string[]; hiddenSignalKeys?: string[]; pinnedSignalKeys?: string[]; onToggleHiddenSignal?(key: string): void; onTogglePinnedSignal?(key: string): void; onSelectAction(key: string): void }) {
  const [showStageBreakdown, setShowStageBreakdown] = useState(false)
  useEffect(() => setShowStageBreakdown(false), [detail.stopId])
  const model = useMemo(() => buildStopTimelineModel(detail, selectedActions, visibleSignalKeys, showStageBreakdown), [detail, selectedActions, visibleSignalKeys, showStageBreakdown])
  const renderSignalControls = (track: TimelineIntervalTrack | TimelineNumericTrack | TimelineEventTrack) => {
    const signal = actionSignalForTrack(track.id, detail.actionSignalContext)
    if (!signal || !onToggleHiddenSignal || !onTogglePinnedSignal) return null
    const key = actionSignalTrackKey(signal); const label = actionSignalLabel(signal); const hidden = hiddenSignalKeys.includes(key); const pinned = pinnedSignalKeys.includes(key)
    return <span className="si-signal-row-controls"><button type="button" className="si-signal-visibility" aria-label={`${hidden ? 'Show' : 'Hide'} ${label} trend`} aria-pressed={!hidden} title={`${hidden ? 'Show' : 'Hide'} trend`} onClick={() => onToggleHiddenSignal(key)}><span aria-hidden="true">👁</span></button><button type="button" className="si-signal-pin" aria-label={`${pinned ? 'Unpin' : 'Pin'} ${label} trend`} aria-pressed={pinned} title={`${pinned ? 'Unpin' : 'Pin'} trend`} onClick={() => onTogglePinnedSignal(key)}><span aria-hidden="true">📌</span></button></span>
  }
  return <div className="si-investigation-timeline">
    {detail.deckStatusContext.availability !== 'UNAVAILABLE' && <div className="si-deck-timeline-legend" aria-label="Deck status colors"><strong>Deck status · Decks 1–10</strong><span className="printing">Printing</span><span className="out">Deck out</span><span className="ready">Active / ready</span><span className="inactive">Inactive</span><span className="command">Print-off command</span><span className="unknown">Unknown</span></div>}
    {detail.changeoverActivityWindows?.length ? <details className="si-stage-breakdown-toggle" open={showStageBreakdown} onToggle={(event) => setShowStageBreakdown(event.currentTarget.open)}><summary><span><strong>Stage breakdown</strong><small>Show overlapping changeover activity windows on the shared timeline</small></span><b>{detail.changeoverActivityWindows.length}</b></summary></details> : null}
    <SynchronizedTimeline fromUtc={detail.speedContext.fromUtc} toUtc={detail.speedContext.toUtc} intervalTracks={model.intervalTracks} numericTracks={model.numericTracks} eventTracks={model.eventTracks} trackOrder={model.trackOrder} selectedId={selectedActionKey} onSelect={(item, track) => { if (track.id.startsWith('actions')) onSelectAction(item.id) }} highlightedRange={{ fromUtc: detail.stop.physicalSegment.startAt, toUtc: detail.stop.physicalSegment.endAt ?? detail.speedContext.toUtc, label: 'Measured physical stop' }} renderTrackLabelControls={(track) => renderSignalControls(track)} renderInspectionTooltip={(atUtc, context) => <InspectionTooltip detail={detail} selectedActions={selectedActions} atUtc={atUtc} numericTrackId={context.numericTrackId} numericTrackLabel={context.numericTrackLabel} intervalItem={context.intervalItem} intervalTrackId={context.intervalTrackId} visibleSignalKeys={visibleSignalKeys}/>} minimumCanvasWidth={900} ariaLabel={`${detail.displayName} synchronized stop investigation timeline`} />
  </div>
}
