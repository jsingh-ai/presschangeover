import type { PressSemanticSignalWithIdentity } from '../telemetry/telemetry-foundation-service.js'
import type {
  CanonicalSpeedObservation,
  ChangeoverAction,
  ClassifiedStop,
  ChangeoverActivityWindow,
  ChangeoverActivityWindowKind,
  ChangeoverActivityWindowSource,
  StopDeckStatusContext,
} from './contracts.js'
import { normalizeSpeedQuality } from './physical-stop-engine.js'

interface StageCandidate {
  kind: ChangeoverActivityWindowKind
  label: string
  at: number
  source: ChangeoverActivityWindowSource
  explanation: string
  evidenceDetails: string[]
}

const GOOD_RUN_CONFIRMATION_MS = 7 * 60_000
const DECK_NUMBERS = Array.from({ length: 10 }, (_, index) => index + 1)
const validTime = (value: string | null | undefined): value is string => Boolean(value && Number.isFinite(Date.parse(value)))

function actionEvidenceTimes(actions: ChangeoverAction[], actionCode: ChangeoverAction['actionCode'], after: number, before: number) {
  return actions.filter((action) => action.actionCode === actionCode && action.confidence !== 'UNKNOWN').flatMap((action) => {
    const evidence = action.evidence.flatMap((item) => {
      const at = Date.parse(item.atUtc)
      return Number.isFinite(at) && at >= after && at < before ? [{ at, action, identity: item.canonicalId ?? item.rawIdentity ?? action.displayName }] : []
    })
    if (evidence.length || !validTime(action.startAt)) return evidence
    const at = Date.parse(action.startAt)
    return at >= after && at < before ? [{ at, action, identity: action.displayName }] : []
  }).sort((left, right) => left.at - right.at)
}

function firstDeckOut(deckStatus: StopDeckStatusContext, after: number, before: number): StageCandidate | null {
  const transitions = deckStatus.decks.flatMap((deck) => deck.intervals.flatMap((interval, index) => {
    const at = Date.parse(interval.startUtc); const previous = deck.intervals[index - 1]
    return previous && interval.state === 'OUT' && previous.state !== 'OUT' && at >= after && at < before ? [{ at, deckNumber: deck.deckNumber }] : []
  })).sort((left, right) => left.at - right.at || left.deckNumber - right.deckNumber)
  const first = transitions[0]
  if (!first) return null
  const decks = transitions.filter((item) => Math.abs(item.at - first.at) <= 5_000).map((item) => item.deckNumber)
  return { kind: 'deck-out', label: 'Deck Out', at: first.at, source: 'TELEMETRY', explanation: 'Deck Out begins at the first normalized transition into the Deck Out state.', evidenceDetails: [`Deck${decks.length === 1 ? '' : 's'} ${decks.join(', ')} changed to Deck Out.`] }
}

function washZero(value: unknown): boolean {
  if (value === false || value === 0) return true
  if (typeof value !== 'string') return false
  return ['0', 'false', 'off', 'inactive', 'idle'].includes(value.trim().toLowerCase())
}

function signalPoints(signal: PressSemanticSignalWithIdentity) {
  const unique = new Map<string, { at: number; value: unknown }>()
  for (const point of [signal.seed, ...signal.samples, ...signal.changes]) {
    if (!point || !validTime(point.observedAtUtc) || normalizeSpeedQuality(point.qualityState) !== 'GOOD') continue
    unique.set(point.observedAtUtc, { at: Date.parse(point.observedAtUtc), value: point.value })
  }
  return [...unique.values()].sort((left, right) => left.at - right.at)
}

function allWashDecksZero(signals: PressSemanticSignalWithIdentity[], after: number, before: number): StageCandidate | null {
  const byDeck = new Map<number, Array<{ at: number; value: unknown }>>()
  for (const deckNumber of DECK_NUMBERS) {
    const points = signals.filter((signal) => signal.canonicalId === 'ink.washup.state' && signal.deckNumber === deckNumber).flatMap(signalPoints).sort((left, right) => left.at - right.at)
    if (!points.length) return null
    byDeck.set(deckNumber, points)
  }
  const boundaries = [...new Set([...byDeck.values()].flatMap((points) => points.map((point) => point.at)).filter((at) => at > after && at < before))].sort((left, right) => left - right)
  const completeAt = boundaries.find((at) => DECK_NUMBERS.every((deckNumber) => {
    const observed = byDeck.get(deckNumber)!.filter((point) => point.at <= at).at(-1)
    return observed ? washZero(observed.value) : false
  }))
  return completeAt === undefined ? null : { kind: 'ink-up', label: 'Ink Up', at: completeAt, source: 'TELEMETRY', explanation: 'Washing ends only when wash-state telemetry simultaneously establishes zero for every deck.', evidenceDetails: ['ink.washup.state = 0 for Decks 1-10.'] }
}

function allDecksReadyOrInactive(deckStatus: StopDeckStatusContext, after: number, before: number): StageCandidate | null {
  const boundaries = [...new Set([after, ...deckStatus.decks.flatMap((deck) => deck.intervals.map((interval) => Date.parse(interval.startUtc))).filter((at) => at >= after && at < before)])].sort((left, right) => left - right)
  const completeAt = boundaries.find((at) => DECK_NUMBERS.every((deckNumber) => {
    const deck = deckStatus.decks.find((item) => item.deckNumber === deckNumber)
    const interval = deck?.intervals.find((item) => Date.parse(item.startUtc) <= at && at < Date.parse(item.endUtc))
    return interval?.state === 'READY' || interval?.state === 'INACTIVE'
  }))
  return completeAt === undefined ? null : { kind: 'deck-in', label: 'Deck In', at: completeAt, source: 'TELEMETRY', explanation: 'Deck In begins only after no deck remains Out and every deck is normalized as Active / ready or Inactive.', evidenceDetails: ['Decks 1-10 were all Active / ready or Inactive; none remained Deck Out or Printing.'] }
}

function speedPoints(observations: CanonicalSpeedObservation[], after: number, before: number) {
  return observations.flatMap((observation) => validTime(observation.atUtc) && typeof observation.speed === 'number' && Number.isFinite(observation.speed) && normalizeSpeedQuality(observation.qualityState) === 'GOOD'
    ? [{ at: Date.parse(observation.atUtc), speed: observation.speed }]
    : []).filter((item) => item.at >= after && item.at < before).sort((left, right) => left.at - right.at)
}

function actionActivityWindow(actions: ChangeoverAction[], actionCode: ChangeoverAction['actionCode'], after: number, before: number) {
  const matching = actions.filter((action) => action.actionCode === actionCode && action.confidence !== 'UNKNOWN')
  const observations = actionEvidenceTimes(matching, actionCode, after, before)
  const times = matching.flatMap((action) => [action.startAt, action.endAt].flatMap((value) => {
    if (!validTime(value)) return []
    const at = Date.parse(value)
    return at >= after && at <= before ? [at] : []
  }))
  const allTimes = [...observations.map(({ at }) => at), ...times].sort((left, right) => left - right)
  if (!allTimes.length) return null
  const identities = [...new Set(observations.map(({ identity }) => identity))]
  return { start: allTimes[0]!, end: allTimes.at(-1)!, count: observations.length, identities }
}

function colorCheckWindows(observations: CanonicalSpeedObservation[], registrationStart: number, stopEnd: number) {
  const speed = speedPoints(observations, registrationStart, stopEnd)
  const windows: Array<{ start: number; end: number }> = []
  let registrationRunObserved = false
  let colorCheckStart: number | null = null

  for (const point of speed) {
    if (point.speed >= 1) {
      registrationRunObserved = true
      if (colorCheckStart !== null) {
        windows.push({ start: colorCheckStart, end: point.at })
        colorCheckStart = null
      }
      continue
    }
    if (registrationRunObserved && colorCheckStart === null) colorCheckStart = point.at
  }

  if (colorCheckStart !== null && colorCheckStart < stopEnd) windows.push({ start: colorCheckStart, end: stopEnd })
  return windows
}

function stage(input: { segment: ClassifiedStop['physicalSegment']; stopStart: number; kind: ChangeoverActivityWindowKind; label: string; start: number; end: number; source?: ChangeoverActivityWindowSource; explanation: string; evidenceDetails: string[] }): ChangeoverActivityWindow | null {
  if (!Number.isFinite(input.start) || !Number.isFinite(input.end) || input.end < input.start) return null
  return { id: `${input.segment.pressKey}-${input.stopStart}-activity-${input.kind}`, kind: input.kind, label: input.label, startAt: new Date(input.start).toISOString(), endAt: new Date(input.end).toISOString(), source: input.source ?? 'TELEMETRY', explanation: input.explanation, evidenceDetails: input.evidenceDetails }
}

/** Derives independent activity windows. These rows may overlap and are not a predicted sequence. */
export function buildChangeoverActivityWindows(input: { stop: ClassifiedStop; actions: ChangeoverAction[]; signals: PressSemanticSignalWithIdentity[]; speedObservations: CanonicalSpeedObservation[]; deckStatus: StopDeckStatusContext; rangeEndUtc: string }): ChangeoverActivityWindow[] {
  const physicalEndAt = input.stop.physicalSegment.endAt
  if (input.stop.classification !== 'CHANGEOVER' || !physicalEndAt) return []
  const segment = input.stop.physicalSegment; const stopStart = Date.parse(segment.startAt); const stopEnd = Date.parse(physicalEndAt)
  const deckOut = firstDeckOut(input.deckStatus, stopStart, stopEnd)
  const wash = actionActivityWindow(input.actions, 'WASH_ACTIVITY', stopStart, stopEnd)
  const ink = actionActivityWindow(input.actions, 'INK_PUMP_ACTIVITY', stopStart, stopEnd)
  const registration = actionActivityWindow(input.actions, 'REGISTRATION_ADJUSTMENT', stopStart, stopEnd)
  const impression = actionActivityWindow(input.actions, 'IMPRESSION_ADJUSTMENT', stopStart, stopEnd)
  const washComplete = wash ? allWashDecksZero(input.signals, wash.start, stopEnd) : null
  const deckIn = washComplete ? allDecksReadyOrInactive(input.deckStatus, washComplete.at, stopEnd) : null
  const firstSetupRun = deckIn ? speedPoints(input.speedObservations, deckIn.at, stopEnd).find(({ speed }) => speed > 1)?.at : undefined
  const colorChecks = registration ? colorCheckWindows(input.speedObservations, registration.start, stopEnd) : []
  const windows: Array<ChangeoverActivityWindow | null> = [
    stage({ segment, stopStart, kind: 'job-out', label: 'Job Out', start: stopStart, end: deckOut?.at ?? stopEnd, source: 'TELEMETRY_INFERRED', explanation: 'Job Out begins at the canonical actual-speed physical stop boundary.', evidenceDetails: ['Actual speed entered the physical stop.'] }),
    deckOut ? stage({ segment, stopStart, kind: 'deck-out', label: 'Deck Out', start: deckOut.at, end: wash && wash.start >= deckOut.at ? wash.start : stopEnd, explanation: deckOut.explanation, evidenceDetails: deckOut.evidenceDetails }) : null,
    wash ? stage({ segment, stopStart, kind: 'wash', label: 'Washing of Ink', start: wash.start, end: wash.end, explanation: 'Wash time spans the first through last mapped wash activity observed in the physical stop.', evidenceDetails: [`${wash.count} wash observation${wash.count === 1 ? '' : 's'} across ${wash.identities.length || 1} signal${wash.identities.length === 1 ? '' : 's'}.`] }) : null,
    ink ? stage({ segment, stopStart, kind: 'ink-up', label: 'Ink Up', start: ink.start, end: ink.end, explanation: 'Ink-up time spans the first through last mapped pump or ink activity observed in the physical stop.', evidenceDetails: [`${ink.count} pump / ink observation${ink.count === 1 ? '' : 's'} across ${ink.identities.length || 1} signal${ink.identities.length === 1 ? '' : 's'}.`] }) : null,
    deckIn ? stage({ segment, stopStart, kind: 'deck-in', label: 'Deck In', start: deckIn.at, end: firstSetupRun ?? stopEnd, explanation: deckIn.explanation, evidenceDetails: deckIn.evidenceDetails }) : null,
    registration ? stage({ segment, stopStart, kind: 'register', label: 'Registration Setup', start: registration.start, end: registration.end, explanation: 'Registration setup spans the first through last mapped registration adjustment observed in the physical stop.', evidenceDetails: [`${registration.count} registration observation${registration.count === 1 ? '' : 's'} across ${registration.identities.length || 1} signal${registration.identities.length === 1 ? '' : 's'}.`] }) : null,
    impression ? stage({ segment, stopStart, kind: 'impression', label: 'Impression Setup', start: impression.start, end: impression.end, explanation: 'Impression setup spans the first through last mapped impression adjustment observed in the physical stop.', evidenceDetails: [`${impression.count} impression observation${impression.count === 1 ? '' : 's'} across ${impression.identities.length || 1} signal${impression.identities.length === 1 ? '' : 's'}.`] }) : null,
    ...colorChecks.map(({ start, end }, index) => stage({ segment, stopStart, kind: 'color-check', label: 'Color Check', start, end, explanation: 'Color Check spans each speed-below-1 interval after Registration Setup has begun and the press has run at or above 1.', evidenceDetails: [`Color Check ${index + 1}: registration/test movement stopped; another run closes this interval and the next return below 1 starts a new one.`] })),
  ]
  const stages = windows.filter((item): item is ChangeoverActivityWindow => item !== null)
  const goodEnd = Math.min(Date.parse(input.rangeEndUtc), stopEnd + GOOD_RUN_CONFIRMATION_MS)
  if (goodEnd > stopEnd) stages.push({ id: `${segment.pressKey}-${stopStart}-stage-good-run`, kind: 'good-run', label: 'Good Run', startAt: physicalEndAt, endAt: new Date(goodEnd).toISOString(), source: 'TELEMETRY', explanation: 'Observed recovery confirmed by the seven-minute sustained Good Run rule.', evidenceDetails: ['Actual speed sustained the configured recovery threshold for seven minutes.'] })
  return stages
}
