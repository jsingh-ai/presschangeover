import type { PressSemanticSignalWithIdentity } from '../telemetry/telemetry-foundation-service.js'
import type { RawTelemetryHistoryResponse, TelemetrySample, TelemetryScalarValue } from '../telemetry/telemetry-contracts.js'
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
import { contextualPumpFrequencyActivity, isDirectAniloxActivitySignal } from './evidence-model.js'

const ACTION_CONTEXT_MS = 15 * 60_000
const BURST_GAP_MS = 2 * 60_000
const MAX_EVIDENCE_PER_ACTION = 80
const COMPLEMENTARY_TRANSITION_TOLERANCE_MS = 2_000

interface ActionPoint { at: number; evidence: ChangeoverActionEvidence }
interface ActionDefinition { actionCode: ChangeoverActionCode; displayName: string; operatorConcept: string | null; explanation: string; family: StopSetupFamily | null }

const ACTION_DEFINITIONS: Record<'deck' | 'wash' | 'pump' | 'impression' | 'registration' | 'anilox', ActionDefinition> = {
  deck: { actionCode: 'DECK_MOVEMENT', displayName: 'Deck Movement', operatorConcept: 'Likely Deck Out / Deck In; direction is not established', explanation: 'Coordinated deck telemetry changed. Numeric direction/state semantics remain unvalidated.', family: 'DECK' },
  wash: { actionCode: 'WASH_ACTIVITY', displayName: 'Wash Activity', operatorConcept: 'Possible Washing of Ink / Plate Wash stage', explanation: 'The configured wash-state telemetry changed; it does not prove the narrower Plate Wash name.', family: 'WASH_PUMP_INK' },
  pump: { actionCode: 'INK_PUMP_ACTIVITY', displayName: 'Pump / Ink Activity', operatorConcept: 'Likely Ink Up / Supply activity', explanation: 'A direct pump status/sequence, pump-frequency on/off boundary, or ink-system mode/status changed; exact inking direction is not established.', family: 'WASH_PUMP_INK' },
  impression: { actionCode: 'IMPRESSION_ADJUSTMENT', displayName: 'Impression Adjustment', operatorConcept: null, explanation: 'Configured Impression telemetry changed.', family: 'IMPRESSION' },
  registration: { actionCode: 'REGISTRATION_ADJUSTMENT', displayName: 'Registration Adjustment', operatorConcept: null, explanation: 'Configured Register telemetry changed. Changes are grouped into bounded bursts.', family: 'REGISTRATION' },
  anilox: { actionCode: 'ANILOX_ACTIVITY', displayName: 'Anilox Activity', operatorConcept: null, explanation: 'Configured Anilox-family telemetry changed.', family: 'ANILOX' },
}
const ROLL_DEFINITION: ActionDefinition = { actionCode: 'ROLL_TRANSITION', displayName: 'Roll Change', operatorConcept: 'Roll identity transition', explanation: 'The canonical Roll identity changed in the bounded stop context. Roll supports investigation but does not move the physical stop boundary.', family: null }
const RAW_DEFINITION: ActionDefinition = { actionCode: 'UNCANONICALIZED_RAW_ACTIVITY', displayName: 'Raw / Unmapped Changes', operatorConcept: null, explanation: 'Direct transitions were observed in raw telemetry that is not represented by a canonical action category. The operational meaning is intentionally left unclassified.', family: null }

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

type BehaviorPhase = 'BEFORE' | 'DURING' | 'AFTER'
const behaviorPhase = (at: number, stopStart: number, stopEnd: number): BehaviorPhase => at < stopStart ? 'BEFORE' : at < stopEnd ? 'DURING' : 'AFTER'
function behaviorFingerprint(point: ActionPoint): string {
  const { oldValue, newValue } = point.evidence
  if (typeof oldValue === 'number' && typeof newValue === 'number') return `numeric:${newValue > oldValue ? 'UP' : newValue < oldValue ? 'DOWN' : 'SAME'}`
  if (typeof oldValue === 'boolean' && typeof newValue === 'boolean') return `boolean:${oldValue ? 'ON' : 'OFF'}>${newValue ? 'ON' : 'OFF'}`
  return `state:${scalarKey(oldValue)}>${scalarKey(newValue)}`
}

/**
 * A transition is action evidence only when its behavior is not repeated in
 * all three stop phases. This removes ordinary cycling/drift that looks the
 * same before, during, and after while retaining phase-specific setup work.
 */
function contextualBehaviorPoints(points: ActionPoint[], stopStart: number, stopEnd: number): ActionPoint[] {
  const fingerprints: Record<BehaviorPhase, Set<string>> = { BEFORE: new Set(), DURING: new Set(), AFTER: new Set() }
  for (const point of points) fingerprints[behaviorPhase(point.at, stopStart, stopEnd)].add(behaviorFingerprint(point))
  const numericValues: Record<BehaviorPhase, number[]> = { BEFORE: [], DURING: [], AFTER: [] }
  for (const point of points) if (typeof point.evidence.newValue === 'number') numericValues[behaviorPhase(point.at, stopStart, stopEnd)].push(point.evidence.newValue)
  const median = (values: number[]) => { const ordered = [...values].sort((left, right) => left - right); const middle = Math.floor(ordered.length / 2); return ordered.length % 2 ? ordered[middle]! : (ordered[middle - 1]! + ordered[middle]!) / 2 }
  const phases: BehaviorPhase[] = ['BEFORE', 'DURING', 'AFTER']
  const allNumeric = phases.flatMap((phase) => numericValues[phase])
  const numericSpan = allNumeric.length ? Math.max(...allNumeric) - Math.min(...allNumeric) : 0
  const levelTolerance = Math.max(1e-6, numericSpan * .15)
  const levelDistinct = new Set<BehaviorPhase>()
  for (const phase of phases) {
    const others = phases.filter((candidate) => candidate !== phase)
    if (numericValues[phase].length < 3 || numericValues[others[0]!].length < 3 || numericValues[others[1]!].length < 3) continue
    const targetMedian = median(numericValues[phase]); const firstMedian = median(numericValues[others[0]!]); const secondMedian = median(numericValues[others[1]!])
    if (Math.abs(firstMedian - secondMedian) <= levelTolerance && Math.abs(targetMedian - (firstMedian + secondMedian) / 2) > levelTolerance * 2) levelDistinct.add(phase)
  }
  return points.flatMap((point) => {
    const fingerprint = behaviorFingerprint(point)
    const repeatedEverywhere = fingerprints.BEFORE.has(fingerprint) && fingerprints.DURING.has(fingerprint) && fingerprints.AFTER.has(fingerprint)
    const phase = behaviorPhase(point.at, stopStart, stopEnd)
    if (repeatedEverywhere && !levelDistinct.has(phase)) return []
    const contextReason = levelDistinct.has(phase) ? 'Its numeric level was materially different while the other two phase medians were similar.' : 'The same transition behavior was not repeated across before-stop, during-stop, and after-stop context.'
    return [{ ...point, evidence: { ...point.evidence, explanation: `${point.evidence.explanation} ${contextReason}` } }]
  })
}

function pumpSignalPoints(signal: PressSemanticSignalWithIdentity, from: number, to: number, stopStart: number, stopEnd: number, explanation: string): ActionPoint[] {
  if (!signal.canonicalId.startsWith('ink.pump.frequency.')) return signalPoints(signal, from, to, explanation)
  return contextualPumpFrequencyActivity(signal, from, to, stopStart, stopEnd).map(({ point, previousValue }) => ({ at: Date.parse(point.observedAtUtc), evidence: signalEvidence(signal, point, previousValue, `${explanation} Pump frequency crossed the 1-unit active boundary in a pattern not repeated both before and after the physical stop.`) }))
}

function deduplicate(points: ActionPoint[]): ActionPoint[] {
  const unique = new Map<string, ActionPoint>()
  for (const point of points.sort((left, right) => left.at - right.at)) {
    const evidence = point.evidence
    const signalKey = evidence.signalId ?? evidence.rawIdentity ?? `${evidence.canonicalId}:${evidence.deckNumber ?? ''}`
    const key = `${signalKey}:${evidence.atUtc}:${scalarKey(evidence.oldValue)}:${scalarKey(evidence.newValue)}`
    if (!unique.has(key)) unique.set(key, point)
  }
  return [...unique.values()]
}

function complementaryCoordinate(point: ActionPoint): { base: string; state: 'on' | 'off' } | null {
  const identity = point.evidence.canonicalId ?? point.evidence.rawIdentity
  if (!identity) return null
  const match = /^(.*?)(?:[._](on|off))$/i.exec(identity)
  if (!match?.[1] || !match[2]) return null
  return { base: `${match[1].toLowerCase()}:${point.evidence.deckNumber ?? ''}`, state: match[2].toLowerCase() as 'on' | 'off' }
}

/** A paired x_on/x_off PLC transition is one logical state change, not two actions. */
export function collapseComplementaryStatePoints(points: ActionPoint[]): ActionPoint[] {
  const ordered = deduplicate(points)
  const consumed = new Set<number>()
  const retained: ActionPoint[] = []
  ordered.forEach((point, index) => {
    if (consumed.has(index)) return
    const coordinate = complementaryCoordinate(point)
    if (!coordinate) { retained.push(point); return }
    const partnerIndex = ordered.findIndex((candidate, candidateIndex) => {
      if (candidateIndex === index || consumed.has(candidateIndex)) return false
      const candidateCoordinate = complementaryCoordinate(candidate)
      return candidateCoordinate?.base === coordinate.base && candidateCoordinate.state !== coordinate.state && Math.abs(candidate.at - point.at) <= COMPLEMENTARY_TRANSITION_TOLERANCE_MS
    })
    if (partnerIndex < 0) { retained.push(point); return }
    consumed.add(partnerIndex)
    const partner = ordered[partnerIndex]!
    const primary = coordinate.state === 'on' ? point : partner
    retained.push({ ...primary, evidence: { ...primary.evidence, explanation: `${primary.evidence.explanation} Complementary ON/OFF telemetry changed together and is represented once.` } })
  })
  return retained.sort((left, right) => left.at - right.at)
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

const rawScalar = (value: unknown): value is TelemetryScalarValue => typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)

function rawHistoryPoints(histories: RawTelemetryHistoryResponse[]): ActionPoint[] {
  const points = histories.flatMap((history) => {
    const observations = history.observations
      .filter((item) => validTime(item.timestampUtc) && normalizeSpeedQuality(item.qualityState) === 'GOOD' && rawScalar(item.rawValue))
      .sort((left, right) => Date.parse(left.timestampUtc) - Date.parse(right.timestampUtc))
    return observations.flatMap((observation, index): ActionPoint[] => {
      const previous = observations[index - 1]
      if (!previous || !rawScalar(previous.rawValue) || scalarKey(previous.rawValue) === scalarKey(observation.rawValue as TelemetryScalarValue)) return []
      return [{ at: Date.parse(observation.timestampUtc), evidence: { signalId: null, canonicalId: null, rawIdentity: history.rawIdentity, component: history.signalDisplayName, deckNumber: null, atUtc: observation.timestampUtc, oldValue: previous.rawValue, newValue: observation.rawValue as TelemetryScalarValue, originalQuality: observation.qualityState, normalizedQuality: 'GOOD', explanation: `Observed raw transition in ${history.signalDisplayName}; this identity has not been canonicalized.` } }]
    })
  })
  return collapseComplementaryStatePoints(points)
}

/** Adds observed, explicitly uncanonicalized evidence without changing the physical stop or its classification. */
export function buildUncanonicalizedRawActions(input: { stop: ClassifiedStop; allStops: ClassifiedStop[]; histories: RawTelemetryHistoryResponse[] }): ChangeoverAction[] {
  const points = rawHistoryPoints(input.histories)
  const stopStart = Date.parse(input.stop.physicalSegment.startAt)
  const stopEnd = Date.parse(input.stop.physicalSegment.endAt ?? '9999-12-31T23:59:59.999Z')
  const byRawIdentity = new Map<string, ActionPoint[]>()
  for (const point of points) {
    const rawIdentity = point.evidence.rawIdentity
    if (!rawIdentity) continue
    byRawIdentity.set(rawIdentity, [...(byRawIdentity.get(rawIdentity) ?? []), point])
  }
  return [...byRawIdentity.entries()].flatMap(([rawIdentity, signalPoints]) => {
    const phases = [
      signalPoints.filter((point) => point.at < stopStart),
      signalPoints.filter((point) => point.at >= stopStart && point.at < stopEnd),
      signalPoints.filter((point) => point.at >= stopEnd),
    ]
    const tagName = signalPoints[0]?.evidence.component ?? rawIdentity
    const definition = { ...RAW_DEFINITION, displayName: tagName, explanation: `${RAW_DEFINITION.explanation} The displayed name is the observed raw telemetry tag.` }
    return phases.flatMap((phase) => phase.length ? [action(definition, 'DETECTED', phase, input.allStops)] : [])
  }).sort((left, right) => Date.parse(left.startAt ?? '9999-12-31') - Date.parse(right.startAt ?? '9999-12-31') || (left.evidence[0]?.rawIdentity ?? '').localeCompare(right.evidence[0]?.rawIdentity ?? ''))
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
  if (key === 'pump') return signals.filter((signal) => signal.canonicalId === 'ink.pump.status' || signal.canonicalId === 'ink.pump.sequence' || signal.canonicalId === 'ink.pump.frequency.supply' || signal.canonicalId === 'ink.pump.frequency.return' || signal.canonicalId === 'ink.viscosity.mode' || signal.canonicalId === 'ink.viscosity.status')
  if (key === 'impression') return signals.filter((signal) => signal.canonicalId.startsWith('impression.'))
  if (key === 'registration') return signals.filter((signal) => signal.canonicalId.startsWith('register.'))
  return signals.filter((signal) => isDirectAniloxActivitySignal(signal.canonicalId))
}

export interface RequiredChangeoverActivity {
  washActivity: boolean
  pumpInkActivity: boolean
  impressionAdjustment: boolean
}

/**
 * Uses the same contextual action detectors as the investigation, but counts
 * only evidence whose timestamp falls inside the physical stop.
 */
export function detectRequiredChangeoverActivity(input: { segment: ClassifiedStop['physicalSegment']; signals: PressSemanticSignalWithIdentity[]; rangeEndUtc: string; evidenceCutoffUtc: string }): RequiredChangeoverActivity {
  const stopStart = Date.parse(input.segment.startAt)
  const stopEnd = Date.parse(input.segment.endAt ?? input.rangeEndUtc)
  const windowFrom = stopStart - ACTION_CONTEXT_MS
  const windowTo = Math.min(stopEnd + ACTION_CONTEXT_MS, Date.parse(input.evidenceCutoffUtc))
  const observedDuringStop = (key: 'wash' | 'pump' | 'impression') => familySignals(input.signals, key).some((signal) => {
    const definition = ACTION_DEFINITIONS[key]
    const discovered = key === 'pump'
      ? pumpSignalPoints(signal, windowFrom, windowTo, stopStart, stopEnd, definition.explanation)
      : signalPoints(signal, windowFrom, windowTo, definition.explanation)
    return contextualBehaviorPoints(discovered, stopStart, stopEnd).some((point) => point.at >= stopStart && point.at < stopEnd)
  })
  return {
    washActivity: observedDuringStop('wash'),
    pumpInkActivity: observedDuringStop('pump'),
    impressionAdjustment: observedDuringStop('impression'),
  }
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
  const base = { eligible: true, reason: 'Derived action discovery runs for every selected physical stop, independently of its predicted classification or confidence.', windowFromUtc: new Date(windowFrom).toISOString(), windowToUtc: new Date(windowTo).toISOString(), actions: [], notDirectlyConfirmed: [], detectorVersion: STOP_INTELLIGENCE_ACTION_VERSION } satisfies ChangeoverActionAnalysis

  const actions: ChangeoverAction[] = []; const unconfirmed: ChangeoverAction[] = []
  const identity = identityAction(input.stop, input.signals, input.allStops)
  const identityBefore = input.stop.identities.find((item) => item.changed && item.beforeValue)
  if (identityBefore) actions.push(action({ actionCode: 'PREVIOUS_JOB_FINISHED', displayName: 'Previous Job Finished', operatorConcept: null, explanation: 'Stable previous identity plus the physical stop supports this operator concept; no dedicated PLC action is mapped.', family: null }, 'INFERRED', [physicalEvidence(input.stop, input.speedSignal, segment.startAt, null, 0, `Physical stop began with previous ${identityBefore.field} ${identityBefore.beforeValue}.`)], input.allStops))
  else unconfirmed.push(unknown('PREVIOUS_JOB_FINISHED', 'Previous Job Finished', 'No stable previous identity was available to support this inference.'))
  if (identity) actions.push(identity); else unconfirmed.push(unknown('JOB_IDENTITY_TRANSITION', 'Job / Identity Change', 'No usable identity transition was associated with this physical stop.', 'Possible Job Out'))
  const rollPoints = input.signals.filter((signal) => signal.canonicalId === 'production.roll' && signal.deckNumber === null).flatMap((signal) => contextualBehaviorPoints(signalPoints(signal, windowFrom, windowTo, ROLL_DEFINITION.explanation), Date.parse(segment.startAt), Date.parse(endAt)))
  actions.push(...burstActions(ROLL_DEFINITION, rollPoints, input.allStops))
  if (!actions.some((item) => item.actionCode === 'ROLL_TRANSITION')) unconfirmed.push(unknown('ROLL_TRANSITION', 'Roll Change', 'No canonical Roll identity transition was observed in the bounded action window.', 'Roll identity transition'))

  for (const key of Object.keys(ACTION_DEFINITIONS) as Array<keyof typeof ACTION_DEFINITIONS>) {
    const definition = ACTION_DEFINITIONS[key]
    const discovered = familySignals(input.signals, key).flatMap((signal) => contextualBehaviorPoints(key === 'pump' ? pumpSignalPoints(signal, windowFrom, windowTo, Date.parse(segment.startAt), Date.parse(endAt), definition.explanation) : signalPoints(signal, windowFrom, windowTo, definition.explanation), Date.parse(segment.startAt), Date.parse(endAt)))
    const points = key === 'deck' ? collapseComplementaryStatePoints(discovered) : discovered
    actions.push(...burstActions(definition, points, input.allStops))
  }
  for (const definition of Object.values(ACTION_DEFINITIONS)) if (!actions.some((item) => item.actionCode === definition.actionCode)) unconfirmed.push(unknown(definition.actionCode, definition.displayName, definition.actionCode === 'DECK_MOVEMENT' ? 'No coordinated multi-signal deck movement burst was directly confirmed; Deck Out/In direction is not mapped.' : `No changing ${definition.displayName.toLowerCase()} telemetry was observed in the bounded action window.`, definition.operatorConcept))

  const color = radiusColorAction(input.stop, input.allStops); if (color) actions.push(color); else unconfirmed.push(unknown('COLOR_RELATED_ACTIVITY', 'Color Check', 'No direct mapped color telemetry or Radius color-related annotation supports this stage.'))
  unconfirmed.push(
    unknown('VISTAPORT_ACTIVITY', 'VISTAPORT', 'No direct canonical VISTAPORT mapping exists in the bounded capability catalog.'),
    unknown('CHOPOVER', 'Chopover', 'No direct canonical Chopover mapping exists. Registration activity before/after cannot prove Chopover.'),
    unknown('KNIFE_CUTTING_ACTIVITY', 'Knife / Cutting / Slitting', 'No defensible mapped knife, cutter, slitter, cutting, or blade action signal was found. Doctor-blade process telemetry is not a cutting-stage signal.'),
    unknown('MASTER_IMAGE_RUN', 'Master Image / Speed Set', 'No direct canonical Master Image mapping exists, and speed alone cannot establish this operator stage.'),
  )
  actions.sort((left, right) => Date.parse(left.startAt ?? '9999-12-31') - Date.parse(right.startAt ?? '9999-12-31') || left.actionCode.localeCompare(right.actionCode))
  return { ...base, actions, notDirectlyConfirmed: unconfirmed }
}
