import type { PressSemanticSignalWithIdentity } from '../telemetry/telemetry-foundation-service.js'
import type { TelemetrySample, TelemetryScalarValue } from '../telemetry/telemetry-contracts.js'
import {
  STOP_INTELLIGENCE_ACTION_VERSION,
  type ChangeoverAction,
  type ChangeoverActionAnalysis,
  type ChangeoverActionCode,
  type ChangeoverActionComparison,
  type ChangeoverActionEvidence,
  type ClassifiedStop,
  type StopSetupFamily,
} from './contracts.js'
import { normalizeSpeedQuality } from './physical-stop-engine.js'

const ACTION_CONTEXT_MS = 15 * 60_000
const BURST_GAP_MS = 2 * 60_000
const MAX_EVIDENCE_PER_ACTION = 80

interface ActionPoint { at: number; evidence: ChangeoverActionEvidence }
interface ActionDefinition { actionCode: ChangeoverActionCode; displayName: string; operatorConcept: string | null; explanation: string; family: StopSetupFamily | null }

const ACTION_DEFINITIONS: Record<'deck' | 'wash' | 'pump' | 'impression' | 'registration' | 'anilox', ActionDefinition> = {
  deck: { actionCode: 'DECK_MOVEMENT', displayName: 'Deck Movement', operatorConcept: 'Likely Deck Out / Deck In; direction is not established', explanation: 'Coordinated deck telemetry changed. Numeric direction/state semantics remain unvalidated.', family: 'DECK' },
  wash: { actionCode: 'WASH_ACTIVITY', displayName: 'Wash Activity', operatorConcept: 'Possible Washing of Ink / Plate Wash stage', explanation: 'The configured wash-state telemetry changed; it does not prove the narrower Plate Wash name.', family: 'WASH_PUMP_INK' },
  pump: { actionCode: 'INK_PUMP_ACTIVITY', displayName: 'Pump / Ink Activity', operatorConcept: 'Likely Ink Up / Supply activity', explanation: 'The configured pump-state telemetry changed; exact inking direction is not established.', family: 'WASH_PUMP_INK' },
  impression: { actionCode: 'IMPRESSION_ADJUSTMENT', displayName: 'Impression Adjustment', operatorConcept: null, explanation: 'Configured Impression telemetry changed.', family: 'IMPRESSION' },
  registration: { actionCode: 'REGISTRATION_ADJUSTMENT', displayName: 'Registration Adjustment', operatorConcept: null, explanation: 'Configured Register telemetry changed. Changes are grouped into bounded bursts.', family: 'REGISTRATION' },
  anilox: { actionCode: 'ANILOX_ACTIVITY', displayName: 'Anilox Activity', operatorConcept: null, explanation: 'Configured Anilox-family telemetry changed.', family: 'ANILOX' },
}

const validTime = (value: string) => Number.isFinite(Date.parse(value))
const scalarKey = (value: TelemetryScalarValue | null) => value === null ? 'null' : `${typeof value}:${String(value)}`
const component = (signal: PressSemanticSignalWithIdentity) => signal.deckNumber === null ? signal.sourceSelector : `Deck ${signal.deckNumber}`

function signalEvidence(signal: PressSemanticSignalWithIdentity, point: TelemetrySample, previousValue: TelemetryScalarValue | null, explanation: string): ChangeoverActionEvidence {
  return { signalId: signal.historianSignalId, canonicalId: signal.canonicalId, rawIdentity: signal.rawSignalId, component: component(signal), deckNumber: signal.deckNumber, atUtc: point.observedAtUtc, oldValue: previousValue, newValue: point.value, originalQuality: point.qualityState, normalizedQuality: normalizeSpeedQuality(point.qualityState), explanation }
}

function signalPoints(signal: PressSemanticSignalWithIdentity, from: number, to: number, explanation: string): ActionPoint[] {
  const changes = signal.changes.filter((point) => validTime(point.observedAtUtc) && Date.parse(point.observedAtUtc) >= from && Date.parse(point.observedAtUtc) <= to && normalizeSpeedQuality(point.qualityState) === 'GOOD' && scalarKey(point.value) !== scalarKey(point.previousValue))
  if (changes.length) return changes.map((point) => ({ at: Date.parse(point.observedAtUtc), evidence: signalEvidence(signal, point, point.previousValue, explanation) }))
  const samples = signal.samples.filter((point) => validTime(point.observedAtUtc) && Date.parse(point.observedAtUtc) >= from && Date.parse(point.observedAtUtc) <= to && normalizeSpeedQuality(point.qualityState) === 'GOOD').sort((left, right) => Date.parse(left.observedAtUtc) - Date.parse(right.observedAtUtc))
  return samples.flatMap((point, index) => {
    const previous = samples[index - 1]
    return previous && scalarKey(previous.value) !== scalarKey(point.value) ? [{ at: Date.parse(point.observedAtUtc), evidence: signalEvidence(signal, point, previous.value, explanation) }] : []
  })
}

function deduplicate(points: ActionPoint[]): ActionPoint[] {
  const unique = new Map<string, ActionPoint>()
  for (const point of points.sort((left, right) => left.at - right.at)) {
    const evidence = point.evidence
    const signalKey = evidence.signalId ?? `${evidence.canonicalId}:${evidence.deckNumber ?? ''}`
    const key = `${signalKey}:${evidence.atUtc}:${scalarKey(evidence.oldValue)}:${scalarKey(evidence.newValue)}`
    if (!unique.has(key)) unique.set(key, point)
  }
  return [...unique.values()]
}

function comparisonFor(family: StopSetupFamily | null, allStops: ClassifiedStop[]): ChangeoverActionComparison | null {
  if (!family) return null
  const eligible = allStops.filter((stop) => stop.classification === 'CHANGEOVER' || stop.classification === 'DOWNTIME')
  const changeovers = eligible.filter((stop) => stop.classification === 'CHANGEOVER'); const downtime = eligible.filter((stop) => stop.classification === 'DOWNTIME')
  const observed = (stop: ClassifiedStop) => stop.families.some((item) => item.family === family && item.observed)
  const changeoverStopsObserved = changeovers.filter(observed).length; const downtimeStopsObserved = downtime.filter(observed).length
  const interpretation = !changeovers.length && !downtime.length ? 'No comparable classified stops exist in this bounded range.' : `Observed in ${changeoverStopsObserved}/${changeovers.length} changeovers and ${downtimeStopsObserved}/${downtime.length} downtime stops in this range; descriptive only.`
  return { changeoverStopsObserved, changeoverStopsTotal: changeovers.length, downtimeStopsObserved, downtimeStopsTotal: downtime.length, interpretation }
}

function action(definition: ActionDefinition, confidence: ChangeoverAction['confidence'], points: ActionPoint[], allStops: ClassifiedStop[], explanation = definition.explanation): ChangeoverAction {
  const evidence = deduplicate(points); const retained = evidence.slice(0, MAX_EVIDENCE_PER_ACTION)
  return { actionCode: definition.actionCode, displayName: definition.displayName, operatorConcept: definition.operatorConcept, confidence, startAt: evidence[0]?.evidence.atUtc ?? null, endAt: evidence.at(-1)?.evidence.atUtc ?? null, explanation, evidence: retained.map((item) => item.evidence), evidenceCount: evidence.length, evidenceLimited: evidence.length > retained.length, comparison: comparisonFor(definition.family, allStops), detectorVersion: STOP_INTELLIGENCE_ACTION_VERSION }
}

function burstActions(definition: ActionDefinition, points: ActionPoint[], allStops: ClassifiedStop[]): ChangeoverAction[] {
  const bursts: ActionPoint[][] = []
  for (const point of deduplicate(points)) {
    const burst = bursts.at(-1)
    if (!burst || point.at - burst.at(-1)!.at > BURST_GAP_MS) bursts.push([point]); else burst.push(point)
  }
  return bursts.flatMap((burst) => {
    const independentSignals = new Set(burst.map(({ evidence }) => evidence.signalId ?? `${evidence.canonicalId}:${evidence.deckNumber ?? ''}`)).size
    if (definition.actionCode === 'DECK_MOVEMENT' && independentSignals < 2) return []
    return [action(definition, 'DETECTED', burst, allStops)]
  })
}

function physicalEvidence(stop: ClassifiedStop, speed: PressSemanticSignalWithIdentity | undefined, atUtc: string, oldValue: TelemetryScalarValue | null, newValue: TelemetryScalarValue | null, explanation: string): ActionPoint {
  const at = Date.parse(atUtc)
  return { at, evidence: { signalId: stop.physicalSegment.speedSignalId, canonicalId: 'machine.speed.actual', rawIdentity: speed?.rawSignalId ?? null, component: 'Press', deckNumber: null, atUtc, oldValue, newValue, originalQuality: 'DERIVED_FROM_GOOD_SPEED', normalizedQuality: 'GOOD', explanation } }
}

function identityAction(stop: ClassifiedStop, signals: PressSemanticSignalWithIdentity[], allStops: ClassifiedStop[]): ChangeoverAction | null {
  const priority = ['STRONG', 'MEDIUM', 'WEAK', 'UNUSABLE', 'UNAVAILABLE']
  const identity = stop.identities.filter((item) => item.changed && item.firstChangeAtUtc).sort((left, right) => priority.indexOf(left.usefulness) - priority.indexOf(right.usefulness))[0]
  if (!identity?.firstChangeAtUtc) return null
  const signal = signals.find((item) => item.canonicalId === identity.canonicalId && item.deckNumber === null)
  const transition = signal?.changes.find((item) => item.observedAtUtc === identity.firstChangeAtUtc)
  const evidence = transition && signal ? signalEvidence(signal, transition, transition.previousValue, `${identity.field} identity changed from ${identity.beforeValue ?? 'unknown'} to ${identity.afterValue ?? 'unknown'}.`) : { signalId: signal?.historianSignalId ?? null, canonicalId: identity.canonicalId, rawIdentity: signal?.rawSignalId ?? null, component: 'Press', deckNumber: null, atUtc: identity.firstChangeAtUtc, oldValue: identity.beforeValue, newValue: identity.afterValue, originalQuality: transition?.qualityState ?? 'GOOD_IDENTITY_ASSOCIATION', normalizedQuality: 'GOOD' as const, explanation: `${identity.field} identity changed from ${identity.beforeValue ?? 'unknown'} to ${identity.afterValue ?? 'unknown'}.` }
  return action({ actionCode: 'JOB_IDENTITY_TRANSITION', displayName: 'Job / Identity Change', operatorConcept: 'Likely Job Out', explanation: identity.reason, family: null }, 'DETECTED', [{ at: Date.parse(identity.firstChangeAtUtc), evidence }], allStops)
}

function unknown(actionCode: ChangeoverActionCode, displayName: string, explanation: string, operatorConcept: string | null = null): ChangeoverAction {
  return { actionCode, displayName, operatorConcept, confidence: 'UNKNOWN', startAt: null, endAt: null, explanation, evidence: [], evidenceCount: 0, evidenceLimited: false, comparison: null, detectorVersion: STOP_INTELLIGENCE_ACTION_VERSION }
}

function familySignals(signals: PressSemanticSignalWithIdentity[], key: keyof typeof ACTION_DEFINITIONS): PressSemanticSignalWithIdentity[] {
  if (key === 'deck') return signals.filter((signal) => signal.canonicalId.startsWith('deck.'))
  if (key === 'wash') return signals.filter((signal) => signal.canonicalId === 'ink.washup.state')
  if (key === 'pump') return signals.filter((signal) => signal.canonicalId === 'ink.pump.status' || signal.canonicalId === 'ink.pump.sequence')
  if (key === 'impression') return signals.filter((signal) => signal.canonicalId.startsWith('impression.'))
  if (key === 'registration') return signals.filter((signal) => signal.canonicalId.startsWith('register.'))
  return signals.filter((signal) => signal.canonicalId.startsWith('anilox.'))
}

function radiusColorAction(stop: ClassifiedStop, allStops: ClassifiedStop[]): ChangeoverAction | null {
  const states = stop.radius.states.filter((state) => state.kind === 'radius' && /color/i.test(`${state.eventType ?? ''} ${state.statusCode ?? ''} ${state.statusDescription ?? ''}`))
  if (!states.length) return null
  const points = states.map((state) => ({ at: Date.parse(state.startUtc), evidence: { signalId: null, canonicalId: null, rawIdentity: `${state.eventType ?? ''}/${state.statusCode ?? ''}/${state.statusDescription ?? ''}`, component: 'Radius', deckNumber: null, atUtc: state.startUtc, oldValue: null, newValue: state.statusDescription, originalQuality: 'RADIUS_ANNOTATION', normalizedQuality: 'GOOD' as const, explanation: 'Radius recorded a color-related status; Radius alone supports inference, not direct telemetry detection.' } }))
  return action({ actionCode: 'COLOR_RELATED_ACTIVITY', displayName: 'Color-related Activity', operatorConcept: 'Possible Color Check', explanation: 'Radius-only color evidence is inferential.', family: null }, 'INFERRED', points, allStops)
}

/** Derived, read-only action discovery. Physical/classification boundaries remain upstream authority. */
export function buildChangeoverActions(input: { stop: ClassifiedStop; allStops: ClassifiedStop[]; signals: PressSemanticSignalWithIdentity[]; speedSignal?: PressSemanticSignalWithIdentity; rangeEndUtc: string; evidenceCutoffUtc: string }): ChangeoverActionAnalysis {
  const segment = input.stop.physicalSegment; const endAt = segment.endAt ?? input.rangeEndUtc
  const windowFrom = Date.parse(segment.startAt) - ACTION_CONTEXT_MS; const windowTo = Math.max(windowFrom, Math.min(Date.parse(endAt) + ACTION_CONTEXT_MS, Date.parse(input.evidenceCutoffUtc)))
  const base = { eligible: false, reason: 'Full action discovery runs only for CHANGEOVER stops with HIGH or MEDIUM confidence.', windowFromUtc: new Date(windowFrom).toISOString(), windowToUtc: new Date(windowTo).toISOString(), actions: [], notDirectlyConfirmed: [], detectorVersion: STOP_INTELLIGENCE_ACTION_VERSION } satisfies ChangeoverActionAnalysis
  if (input.stop.classification !== 'CHANGEOVER' || !['HIGH', 'MEDIUM'].includes(input.stop.confidence)) return base

  const actions: ChangeoverAction[] = []; const unconfirmed: ChangeoverAction[] = []
  const identity = identityAction(input.stop, input.signals, input.allStops)
  const identityBefore = input.stop.identities.find((item) => item.changed && item.beforeValue)
  if (identityBefore) actions.push(action({ actionCode: 'PREVIOUS_JOB_FINISHED', displayName: 'Previous Job Finished', operatorConcept: null, explanation: 'Stable previous identity plus the physical stop supports this operator concept; no dedicated PLC action is mapped.', family: null }, 'INFERRED', [physicalEvidence(input.stop, input.speedSignal, segment.startAt, null, 0, `Physical stop began with previous ${identityBefore.field} ${identityBefore.beforeValue}.`)], input.allStops))
  else unconfirmed.push(unknown('PREVIOUS_JOB_FINISHED', 'Previous Job Finished', 'No stable previous identity was available to support this inference.'))
  if (identity) actions.push(identity); else unconfirmed.push(unknown('JOB_IDENTITY_TRANSITION', 'Job / Identity Change', 'No usable identity transition was associated with this changeover stop.', 'Possible Job Out'))

  for (const key of Object.keys(ACTION_DEFINITIONS) as Array<keyof typeof ACTION_DEFINITIONS>) {
    const definition = ACTION_DEFINITIONS[key]
    const points = familySignals(input.signals, key).flatMap((signal) => signalPoints(signal, windowFrom, windowTo, definition.explanation))
    actions.push(...burstActions(definition, points, input.allStops))
  }
  for (const definition of Object.values(ACTION_DEFINITIONS)) if (!actions.some((item) => item.actionCode === definition.actionCode)) unconfirmed.push(unknown(definition.actionCode, definition.displayName, definition.actionCode === 'DECK_MOVEMENT' ? 'No coordinated multi-signal deck movement burst was directly confirmed; Deck Out/In direction is not mapped.' : `No changing ${definition.displayName.toLowerCase()} telemetry was observed in the bounded action window.`, definition.operatorConcept))

  for (const attempt of segment.movementAttempts) {
    if (attempt.peakSpeed !== null && attempt.peakSpeed >= 1 && attempt.peakSpeed < 595) actions.push(action({ actionCode: 'SLOW_SETUP_RUN', displayName: 'Slow Setup Run', operatorConcept: 'Start press / slow setup movement', explanation: 'Actual Speed moved above stopped speed but stayed below the physical recovery threshold.', family: null }, 'DETECTED', [physicalEvidence(input.stop, input.speedSignal, attempt.startAt, 0, attempt.peakSpeed, `Movement attempt ${attempt.sequenceNumber} peaked at ${attempt.peakSpeed} ft/min.`), physicalEvidence(input.stop, input.speedSignal, attempt.endAt, attempt.peakSpeed, 0, `Movement attempt ${attempt.sequenceNumber} ended.`)], input.allStops))
    if (attempt.reachedRecoveryThreshold && attempt.failedRecoveryCount > 0) actions.push(action({ actionCode: 'TRIAL_RUN', displayName: 'Trial Run', operatorConcept: 'Setup run that did not sustain physical recovery', explanation: 'Actual Speed reached the recovery threshold but did not sustain it for five minutes.', family: null }, 'DETECTED', [physicalEvidence(input.stop, input.speedSignal, attempt.startAt, 0, attempt.peakSpeed, `Attempt ${attempt.sequenceNumber} reached ${attempt.peakSpeed ?? 'unknown'} ft/min.`), physicalEvidence(input.stop, input.speedSignal, attempt.endAt, attempt.peakSpeed, 0, `Attempt ${attempt.sequenceNumber} returned below recovery.`)], input.allStops))
  }
  for (const streak of segment.failedRecoveryStreaks) actions.push(action({ actionCode: 'FAILED_RECOVERY', displayName: 'Failed Recovery', operatorConcept: null, explanation: 'A recovery candidate ended before five continuous minutes.', family: null }, 'DETECTED', [physicalEvidence(input.stop, input.speedSignal, streak.startAt, null, 595, `Recovery candidate began; ${streak.reason}.`), physicalEvidence(input.stop, input.speedSignal, streak.endAt, 595, null, 'Recovery confirmation failed.')], input.allStops))
  if (!actions.some((item) => item.actionCode === 'SLOW_SETUP_RUN')) unconfirmed.push(unknown('SLOW_SETUP_RUN', 'Slow Setup Run', 'No movement attempt between 1 and 595 ft/min was observed in this physical stop.'))
  if (!actions.some((item) => item.actionCode === 'TRIAL_RUN')) unconfirmed.push(unknown('TRIAL_RUN', 'Trial Run', 'No above-recovery attempt that later failed confirmation was observed.'))
  if (!actions.some((item) => item.actionCode === 'FAILED_RECOVERY')) unconfirmed.push(unknown('FAILED_RECOVERY', 'Failed Recovery', 'No failed recovery streak was observed.'))
  if (segment.endAt) actions.push(action({ actionCode: 'PHYSICAL_RECOVERY', displayName: 'Physical Recovery', operatorConcept: 'Good production threshold reached', explanation: 'Actual Speed reached at least 595 ft/min and remained there for the accepted confirmation interval.', family: null }, 'DETECTED', [physicalEvidence(input.stop, input.speedSignal, segment.endAt, null, 595, 'Successful sustained physical recovery began.')], input.allStops))
  else unconfirmed.push(unknown('PHYSICAL_RECOVERY', 'Physical Recovery', 'The stop is right-censored or recovery has not yet been confirmed.'))

  const color = radiusColorAction(input.stop, input.allStops); if (color) actions.push(color); else unconfirmed.push(unknown('COLOR_RELATED_ACTIVITY', 'Color Check', 'No direct mapped color telemetry or Radius color-related annotation supports this stage.'))
  unconfirmed.push(
    unknown('VISTAPORT_ACTIVITY', 'VISTAPORT', 'No direct canonical VISTAPORT mapping exists in the bounded capability catalog.'),
    unknown('CHOPOVER', 'Chopover', 'No direct canonical Chopover mapping exists. Registration activity before/after cannot prove Chopover.'),
    unknown('KNIFE_CUTTING_ACTIVITY', 'Knife / Cutting / Slitting', 'No defensible mapped knife, cutter, slitter, cutting, or blade action signal was found. Doctor-blade process telemetry is not a cutting-stage signal.'),
    unknown('MASTER_IMAGE_RUN', 'Master Image / Speed Set', 'No direct canonical Master Image mapping exists, and speed alone cannot establish this operator stage.'),
  )
  actions.sort((left, right) => Date.parse(left.startAt ?? '9999-12-31') - Date.parse(right.startAt ?? '9999-12-31') || left.actionCode.localeCompare(right.actionCode))
  return { ...base, eligible: true, reason: 'Derived action discovery is enabled for this medium/high-confidence changeover.', actions, notDirectlyConfirmed: unconfirmed }
}
