import type { RadiusPressKey } from '../radius/models.js'
import type { CapabilityAssessment, PressSemanticSignalEvidence, TelemetryChange, TelemetrySample, TelemetrySemanticSelector } from './telemetry-contracts.js'
import { TelemetryFoundationService } from './telemetry-foundation-service.js'
import { isGoodTelemetryQuality } from './historical-telemetry-policy.js'

const MINUTE_MS = 60_000
export const CLUE_MAX_WINDOW_MS = 2 * 60 * MINUTE_MS
export const CLUE_SELECTOR_BATCH_SIZE = 50
export const CLUE_BATCH_CONCURRENCY = 3

export type EngineeringSignalType = 'continuous' | 'step_reference' | 'state_event'
export type EngineeringObservationConfidence = 'OBSERVED' | 'LIMITED_OBSERVATION' | 'NO_USABLE_OBSERVATION' | 'TEMPORARILY_UNAVAILABLE' | 'UNSUPPORTED'
export type EngineeringCategory = 'speed' | 'web_tension' | 'dryer' | 'ink' | 'viscosity' | 'temperature' | 'pump' | 'wash' | 'register' | 'impression' | 'torque' | 'drive_temperature' | 'doctor_blade' | 'repeat_other' | 'motion'

export interface EngineeringClueCatalogItem {
  canonicalId: string
  friendlyName: string
  signalType: EngineeringSignalType
  category: EngineeringCategory
  scope: 'machine' | 'deck'
}

const machine = (canonicalId: string, friendlyName: string, signalType: EngineeringSignalType, category: EngineeringCategory): EngineeringClueCatalogItem => ({ canonicalId, friendlyName, signalType, category, scope: 'machine' })
const deck = (canonicalId: string, friendlyName: string, signalType: EngineeringSignalType, category: EngineeringCategory): EngineeringClueCatalogItem => ({ canonicalId, friendlyName, signalType, category, scope: 'deck' })

export const ENGINEERING_CLUE_CATALOG: readonly EngineeringClueCatalogItem[] = [
  machine('machine.speed.actual', 'Actual Speed', 'continuous', 'speed'),
  machine('machine.speed.setpoint', 'Speed Setpoint', 'step_reference', 'speed'),
  machine('web_tension.chill_draw.actual', 'Chill Draw Tension', 'continuous', 'web_tension'),
  machine('web_tension.chill_draw.setpoint', 'Chill Draw Tension Setpoint', 'step_reference', 'web_tension'),
  machine('unwind.tension.actual', 'Unwind Tension', 'continuous', 'web_tension'),
  machine('rewind.tension.actual', 'Rewind Tension', 'continuous', 'web_tension'),
  machine('dryer.tunnel.temperature.actual', 'Dryer Tunnel Temperature', 'continuous', 'dryer'),
  machine('dryer.tunnel.temperature.setpoint', 'Dryer Tunnel Temperature Setpoint', 'step_reference', 'dryer'),
  machine('production.order.length.actual', 'Order Length', 'continuous', 'repeat_other'),
  deck('ink.viscosity.actual', 'Viscosity Actual', 'continuous', 'viscosity'),
  deck('ink.viscosity.setpoint', 'Viscosity Setpoint', 'step_reference', 'viscosity'),
  deck('ink.temperature.actual', 'Ink Temperature Actual', 'continuous', 'temperature'),
  deck('ink.temperature.setpoint', 'Ink Temperature Setpoint', 'step_reference', 'temperature'),
  deck('ink.pump.frequency.supply', 'Ink Pump Supply Frequency', 'continuous', 'pump'),
  deck('ink.pump.frequency.return', 'Ink Pump Return Frequency', 'continuous', 'pump'),
  deck('register.long.actual_or_correction', 'Long Register Actual or Correction', 'step_reference', 'register'),
  deck('register.long.preset', 'Long Register Preset', 'step_reference', 'register'),
  deck('register.long.rated_or_setpoint', 'Long Register Rated or Setpoint', 'step_reference', 'register'),
  deck('register.side.actual_or_correction', 'Side Register Actual or Correction', 'step_reference', 'register'),
  deck('register.side.preset', 'Side Register Preset', 'step_reference', 'register'),
  deck('register.side.rated_or_setpoint', 'Side Register Rated or Setpoint', 'step_reference', 'register'),
  deck('impression.anilox.drive_side', 'Anilox Impression Drive Side', 'step_reference', 'impression'),
  deck('impression.anilox.operator_side', 'Anilox Impression Operator Side', 'step_reference', 'impression'),
  deck('impression.plate_cylinder.drive_side', 'Plate Impression Drive Side', 'step_reference', 'impression'),
  deck('impression.plate_cylinder.operator_side', 'Plate Impression Operator Side', 'step_reference', 'impression'),
  deck('anilox.drive.torque.actual', 'Anilox Drive Torque', 'continuous', 'torque'),
  deck('anilox.drive.temperature.actual', 'Anilox Drive Temperature', 'continuous', 'drive_temperature'),
  deck('plate_cylinder.drive.torque.actual', 'Plate Cylinder Drive Torque', 'continuous', 'torque'),
  deck('plate_cylinder.drive.temperature.actual', 'Plate Cylinder Drive Temperature', 'continuous', 'drive_temperature'),
  deck('doctor_blade.pressure', 'Doctor Blade Pressure', 'continuous', 'doctor_blade'),
  deck('repeat_length.correction', 'Repeat Length Correction', 'step_reference', 'repeat_other'),
  machine('physical.motion_state', 'Physical Motion', 'state_event', 'motion'),
  deck('deck.active', 'Deck Active Signal', 'state_event', 'ink'),
  deck('deck.print_on', 'Print-on Signal', 'state_event', 'ink'),
  deck('deck.print_off', 'Print-off Signal', 'state_event', 'ink'),
  deck('ink.pump.status', 'Pump-state Code', 'state_event', 'pump'),
  deck('ink.pump.sequence', 'Pump-sequence Code', 'state_event', 'pump'),
  deck('ink.washup.state', 'Wash-state Code', 'state_event', 'wash'),
  deck('ink.viscosity.mode', 'Viscosity-mode Code', 'state_event', 'viscosity'),
  deck('ink.viscosity.status', 'Viscosity-status Code', 'state_event', 'viscosity'),
] as const

export interface ClueOccurrenceInput {
  occurrenceId: string
  pressKey: RadiusPressKey
  displayName: string
  startUtc: string
  endUtc: string
  durationSeconds: number
  exactIdentities: Array<{ eventType: string; statusCode: string | null; statusDescription: string }>
}

export interface NumericWindowSummary { count: number; median: number | null; minimum: number | null; maximum: number | null; iqr: number | null }
export interface EngineeringSignalClue {
  canonicalId: string
  deckNumber: number | null
  friendlyName: string
  signalType: EngineeringSignalType
  category: EngineeringCategory
  capabilityState: CapabilityAssessment['state']
  observationState: PressSemanticSignalEvidence['observationState']
  mappingStatus: PressSemanticSignalEvidence['mappingStatus']
  sourceUnit: string | null
  unitLabel: string
  canonicalUnitStatus: string | null
  observationConfidence: EngineeringObservationConfidence
  before: NumericWindowSummary | null
  during: NumericWindowSummary | null
  after: NumericWindowSummary | null
  enteringValue: string | number | boolean | null
  transitionCount: number
  largestRawStep: number | null
  description: string
  isClue: boolean
  clueQuality: number
  firstRelevantAtUtc: string | null
  firstRelevantOffsetMs: number | null
  firstRelevantPreviousValue: string | number | boolean | null
  firstRelevantValue: string | number | boolean | null
}

export interface EngineeringCategoryCell {
  scopeKey: string
  scopeLabel: string
  category: EngineeringCategory
  supportedSignals: number
  observedSignals: number
  clueSignals: number
  status: 'multiple_clues' | 'one_clue' | 'observed_no_shift' | 'insufficient' | 'temporarily_unavailable' | 'unknown' | 'unsupported'
  details: string[]
}

export interface EngineeringClueResponse {
  occurrence: ClueOccurrenceInput
  evidenceWindow: { fromUtc: string; toUtc: string; beforeEndUtc: string; duringStartUtc: string; duringEndUtc: string; afterStartUtc: string; boundedAroundStart: boolean; message: string | null }
  coverage: { supportedSelectors: number; observedSelectors: number; limitedObservationSelectors: number; noObservationSelectors: number; unavailableSelectors: number }
  whereToLook: Array<{ scopeKey: string; scopeLabel: string; category: EngineeringCategory; supportedSignals: number; clueSignals: number; clueShare: number; strongestClueQuality: number; averageClueQuality: number; qualityScore: number; summary: string }>
  categoryColumns: EngineeringCategory[]
  categoryCells: EngineeringCategoryCell[]
  firstChanges: Array<Pick<EngineeringSignalClue, 'canonicalId' | 'deckNumber' | 'friendlyName' | 'signalType' | 'category' | 'firstRelevantAtUtc' | 'firstRelevantOffsetMs' | 'firstRelevantPreviousValue' | 'firstRelevantValue'>>
  signalClues: EngineeringSignalClue[]
  performance: { upstreamCalls: number; semanticCalls: number; totalSelectors: number; upstreamMs: number; calculationMs: number; totalMs: number; responsePayloadBytes: number }
}

export const ENGINEERING_CLUE_HEURISTICS = {
  // Three observations are the minimum for a descriptive median/IQR comparison.
  // This is evidence support, not a historian cadence or missing-data SLA.
  minimumNumericObservationsPerComparedWindow: 3,
  levelShiftRobustScore: 2,
  variabilityRatio: 2.5,
  nearEntryMs: 30_000,
} as const

function quantile(values: number[], q: number): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const index = (sorted.length - 1) * q
  const lower = Math.floor(index)
  const upper = Math.ceil(index)
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (index - lower)
}

export function numericSummary(samples: TelemetrySample[], from: number, to: number): NumericWindowSummary {
  const values = samples.filter((sample) => {
    const at = Date.parse(sample.observedAtUtc)
    return at >= from && at < to && typeof sample.value === 'number' && Number.isFinite(sample.value) && isGoodTelemetryQuality(sample.qualityState)
  }).map(({ value }) => value as number)
  const q1 = quantile(values, .25)
  const q3 = quantile(values, .75)
  return { count: values.length, median: quantile(values, .5), minimum: values.length ? Math.min(...values) : null, maximum: values.length ? Math.max(...values) : null, iqr: q1 === null || q3 === null ? null : q3 - q1 }
}

export function clueEvidenceWindow(startUtc: string, endUtc: string) {
  const start = Date.parse(startUtc)
  const end = Date.parse(endUtc)
  const desiredFrom = start - 15 * MINUTE_MS
  const desiredTo = end + 15 * MINUTE_MS
  const boundedAroundStart = desiredTo - desiredFrom > CLUE_MAX_WINDOW_MS
  const from = desiredFrom
  const to = boundedAroundStart ? start + 105 * MINUTE_MS : desiredTo
  return {
    fromUtc: new Date(from).toISOString(), toUtc: new Date(to).toISOString(),
    beforeEndUtc: startUtc, duringStartUtc: startUtc, duringEndUtc: endUtc, afterStartUtc: endUtc,
    boundedAroundStart,
    message: boundedAroundStart ? 'Telemetry clues use a bounded window around occurrence start.' : null,
  }
}

function safeUnit(sourceUnit: string | null, canonicalUnitStatus: string | null): { sourceUnit: string | null; label: string } {
  const artifact = sourceUnit !== null && /^\d+$/.test(sourceUnit.trim())
  return { sourceUnit: artifact ? null : sourceUnit, label: sourceUnit && !artifact ? `${sourceUnit} · unit unverified` : 'Unit unverified' }
}

function firstByTime<T extends { observedAtUtc: string }>(items: T[]): T | undefined {
  return [...items].sort((a, b) => Date.parse(a.observedAtUtc) - Date.parse(b.observedAtUtc))[0]
}

function phaseLabel(at: number, occurrenceStart: number, occurrenceEnd: number): string {
  if (at < occurrenceStart) return 'before Radius entry'
  if (at < occurrenceEnd) return 'during the occurrence'
  return 'after the occurrence'
}

export function analyzeSemanticSignal(item: EngineeringClueCatalogItem, signal: PressSemanticSignalEvidence, occurrence: ClueOccurrenceInput, window: ReturnType<typeof clueEvidenceWindow>): EngineeringSignalClue {
  const start = Date.parse(occurrence.startUtc)
  const end = Date.parse(occurrence.endUtc)
  const from = Date.parse(window.fromUtc)
  const to = Date.parse(window.toUtc)
  const unit = safeUnit(signal.sourceUnit, signal.canonicalUnitStatus)
  const base = {
    canonicalId: item.canonicalId, deckNumber: signal.deckNumber, friendlyName: item.friendlyName, signalType: item.signalType,
    category: item.category, capabilityState: signal.capabilityState, observationState: signal.observationState,
    mappingStatus: signal.mappingStatus, sourceUnit: unit.sourceUnit, unitLabel: unit.label, canonicalUnitStatus: signal.canonicalUnitStatus,
  }
  if (item.signalType === 'continuous') {
    const before = numericSummary(signal.samples, from, start)
    const during = numericSummary(signal.samples, start, Math.min(end, to))
    const after = numericSummary(signal.samples, end, to)
    const enough = before.count >= ENGINEERING_CLUE_HEURISTICS.minimumNumericObservationsPerComparedWindow && during.count >= ENGINEERING_CLUE_HEURISTICS.minimumNumericObservationsPerComparedWindow
    const combined = [...signal.samples].filter(({ value }) => typeof value === 'number').map(({ value }) => value as number)
    const combinedRange = combined.length ? Math.max(...combined) - Math.min(...combined) : 0
    const baselineScale = Math.max(before.iqr ?? 0, combinedRange * .1, Math.abs(before.median ?? 0) * .02, 1e-9)
    const levelScore = enough ? Math.abs((during.median ?? 0) - (before.median ?? 0)) / baselineScale : 0
    const variabilityBase = Math.max(before.iqr ?? 0, combinedRange * .02, 1e-9)
    const variabilityRatio = enough ? (during.iqr ?? 0) / variabilityBase : 0
    const levelClue = levelScore >= ENGINEERING_CLUE_HEURISTICS.levelShiftRobustScore
    const variabilityClue = variabilityRatio >= ENGINEERING_CLUE_HEURISTICS.variabilityRatio
    const direction = (during.median ?? 0) > (before.median ?? 0) ? 'upward' : 'downward'
    const parts: string[] = []
    if (levelClue) parts.push(`observed ${direction} level shift during the occurrence relative to the preceding period`)
    if (variabilityClue) parts.push('more variable during the occurrence relative to the preceding period')
    if (!enough) parts.push('limited observation; insufficient temporal evidence for a before/during comparison')
    else if (!parts.length) parts.push('observed; no supported shift detected relative to the preceding period')
    if (after.count >= ENGINEERING_CLUE_HEURISTICS.minimumNumericObservationsPerComparedWindow && before.median !== null && during.median !== null && after.median !== null && Math.abs(after.median - before.median) < Math.abs(during.median - before.median)) parts.push('after-period median moved toward the preceding median')
    const duringSamples = signal.samples.filter(({ observedAtUtc, value }) => { const at = Date.parse(observedAtUtc); return at >= start && at < Math.min(end, to) && typeof value === 'number' })
    const qualifying = levelClue ? duringSamples.filter(({ value }) => Math.abs((value as number) - (before.median ?? 0)) >= baselineScale * ENGINEERING_CLUE_HEURISTICS.levelShiftRobustScore) : variabilityClue ? duringSamples : []
    const first = firstByTime(qualifying) ?? ((levelClue || variabilityClue) ? firstByTime(duringSamples) : undefined)
    const usableCount = before.count + during.count + after.count
    const observationConfidence: EngineeringObservationConfidence = enough ? 'OBSERVED' : usableCount || signal.seed ? 'LIMITED_OBSERVATION' : 'NO_USABLE_OBSERVATION'
    return { ...base, observationConfidence, before, during, after, enteringValue: signal.seed?.value ?? null, transitionCount: 0, largestRawStep: null, description: parts.join('; '), isClue: levelClue || variabilityClue, clueQuality: (levelClue ? Math.min(4, levelScore) : 0) + (variabilityClue ? 1 : 0), firstRelevantAtUtc: first?.observedAtUtc ?? null, firstRelevantOffsetMs: first ? Date.parse(first.observedAtUtc) - start : null, firstRelevantPreviousValue: null, firstRelevantValue: first?.value ?? null }
  }

  const changes = [...signal.changes].sort((a, b) => Date.parse(a.observedAtUtc) - Date.parse(b.observedAtUtc))
  const first = firstByTime(changes)
  const numericSteps = changes.filter((change) => typeof change.value === 'number' && typeof change.previousValue === 'number').map((change) => Math.abs((change.value as number) - (change.previousValue as number)))
  const largestRawStep = numericSteps.length ? Math.max(...numericSteps) : null
  const transition = first ? `raw ${item.signalType === 'state_event' ? 'state-code ' : ''}transition ${String(first.previousValue)} → ${String(first.value)} observed ${phaseLabel(Date.parse(first.observedAtUtc), start, end)}` : signal.seed ? 'limited observation; entering raw value observed, but no raw transition was observed in the evidence window' : 'no usable observation or raw transition was observed in the evidence window'
  const observationConfidence: EngineeringObservationConfidence = changes.length ? 'OBSERVED' : signal.seed ? 'LIMITED_OBSERVATION' : 'NO_USABLE_OBSERVATION'
  const transitionQuality = item.signalType === 'state_event' ? 3 : 2.5
  return { ...base, observationConfidence, before: null, during: null, after: null, enteringValue: signal.seed?.value ?? first?.previousValue ?? null, transitionCount: changes.length, largestRawStep, description: transition, isClue: changes.length > 0, clueQuality: changes.length ? transitionQuality : 0, firstRelevantAtUtc: first?.observedAtUtc ?? null, firstRelevantOffsetMs: first ? Date.parse(first.observedAtUtc) - start : null, firstRelevantPreviousValue: first?.previousValue ?? null, firstRelevantValue: first?.value ?? null }
}

function catalogSelectors(capabilities: CapabilityAssessment[]) {
  const byId = new Map(capabilities.map((capability) => [capability.canonicalId, capability]))
  const selectors: Array<{ item: EngineeringClueCatalogItem; selector: TelemetrySemanticSelector }> = []
  for (const item of ENGINEERING_CLUE_CATALOG) {
    const capability = byId.get(item.canonicalId)
    if (!capability || capability.state !== 'SUPPORTED' || !capability.historyQueryable || capability.evidenceKind !== 'semantic_history' || item.canonicalId === 'physical.motion_state') continue
    const representation = item.signalType === 'continuous' ? 'samples' : 'changes'
    if (item.scope === 'deck') for (const deckNumber of capability.deckNumbers) selectors.push({ item, selector: { canonicalId: item.canonicalId, deckNumber, representation } })
    else selectors.push({ item, selector: { canonicalId: item.canonicalId, representation } })
  }
  return { byId, selectors }
}

function matrix(capabilities: Map<string, CapabilityAssessment>, clues: EngineeringSignalClue[]) {
  const relevantColumns = [...new Set(ENGINEERING_CLUE_CATALOG.filter((item) => {
    const capability = capabilities.get(item.canonicalId)
    return capability && capability.state !== 'UNSUPPORTED'
  }).map(({ category }) => category))]
  const cells: EngineeringCategoryCell[] = []
  const scopes = [{ key: 'machine', label: 'Machine', deckNumber: null }, ...Array.from({ length: 10 }, (_, index) => ({ key: `deck-${index + 1}`, label: `Deck ${index + 1}`, deckNumber: index + 1 }))]
  for (const scope of scopes) for (const category of relevantColumns) {
    const candidates = ENGINEERING_CLUE_CATALOG.filter((item) => item.category === category && (scope.deckNumber === null ? item.scope === 'machine' : item.scope === 'deck'))
    if (!candidates.length) continue
    const applicable = candidates.filter((item) => {
      const capability = capabilities.get(item.canonicalId)
      return capability && (scope.deckNumber === null || capability.deckNumbers.includes(scope.deckNumber))
    })
    const supported = applicable.filter((item) => capabilities.get(item.canonicalId)?.state === 'SUPPORTED')
    const temporarilyUnavailable = applicable.filter((item) => capabilities.get(item.canonicalId)?.state === 'TEMPORARILY_UNAVAILABLE')
    const unknown = applicable.filter((item) => capabilities.get(item.canonicalId)?.state === 'UNKNOWN')
    const values = clues.filter((clue) => clue.category === category && clue.deckNumber === scope.deckNumber)
    const observed = values.filter(({ observationConfidence }) => observationConfidence === 'OBSERVED')
    const clueValues = values.filter(({ isClue }) => isClue)
    const status = clueValues.length > 1 ? 'multiple_clues' : clueValues.length === 1 ? 'one_clue' : observed.length ? 'observed_no_shift' : temporarilyUnavailable.length ? 'temporarily_unavailable' : unknown.length ? 'unknown' : supported.length ? 'insufficient' : 'unsupported'
    const details = values.map(({ friendlyName, description }) => `${friendlyName}: ${description}`)
    if (temporarilyUnavailable.length) details.push(`${temporarilyUnavailable.length} capability ${temporarilyUnavailable.length === 1 ? 'is' : 'are'} temporarily unavailable; this is not interpreted as zero or unchanged.`)
    if (unknown.length) details.push(`${unknown.length} capability ${unknown.length === 1 ? 'state is' : 'states are'} unknown; this is not interpreted as unsupported.`)
    cells.push({ scopeKey: scope.key, scopeLabel: scope.label, category, supportedSignals: supported.length, observedSignals: observed.length, clueSignals: clueValues.length, status, details })
  }
  return { categoryColumns: relevantColumns, categoryCells: cells }
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await task(items[index]!)
    }
  }))
  return results
}

export function rankWhereToLook(clues: EngineeringSignalClue[], categoryCells: EngineeringCategoryCell[]): EngineeringClueResponse['whereToLook'] {
  const grouped = new Map<string, { scopeKey: string; scopeLabel: string; category: EngineeringCategory; signals: Map<string, number> }>()
  for (const clue of clues.filter(({ isClue }) => isClue)) {
    const scopeKey = clue.deckNumber === null ? 'machine' : `deck-${clue.deckNumber}`
    const scopeLabel = clue.deckNumber === null ? 'Machine' : `Deck ${clue.deckNumber}`
    const key = `${scopeKey}:${clue.category}`
    const current = grouped.get(key) ?? { scopeKey, scopeLabel, category: clue.category, signals: new Map<string, number>() }
    const signalKey = `${clue.canonicalId}:${clue.deckNumber ?? ''}`
    current.signals.set(signalKey, Math.max(current.signals.get(signalKey) ?? 0, clue.clueQuality))
    grouped.set(key, current)
  }
  return [...grouped.values()].map((item) => {
    const qualities = [...item.signals.values()]
    const clueSignals = qualities.length
    const supportedSignals = categoryCells.find(({ scopeKey, category }) => scopeKey === item.scopeKey && category === item.category)?.supportedSignals ?? clueSignals
    const clueShare = supportedSignals ? clueSignals / supportedSignals : 0
    const strongestClueQuality = Math.max(0, ...qualities)
    const averageClueQuality = qualities.reduce((sum, value) => sum + value, 0) / Math.max(1, clueSignals)
    // Strength leads; capability-normalized coverage and a capped corroboration bonus follow.
    // Raw rows, raw transition counts, and the number of mapped opportunities are never scored.
    const qualityScore = strongestClueQuality + averageClueQuality * .5 + clueShare * .5 + Math.min(2, clueSignals) * .25
    const { signals: _signals, ...identity } = item
    return { ...identity, supportedSignals, clueSignals, clueShare, strongestClueQuality, averageClueQuality, qualityScore, summary: `${clueSignals} ${clueSignals === 1 ? 'signal showed' : 'signals showed'} changed behavior worth inspecting` }
  }).sort((a, b) => b.qualityScore - a.qualityScore || b.strongestClueQuality - a.strongestClueQuality || b.clueShare - a.clueShare || a.scopeLabel.localeCompare(b.scopeLabel, undefined, { numeric: true })).slice(0, 6)
}

export class EngineeringClueAnalysisService {
  constructor(private readonly telemetry: TelemetryFoundationService, private readonly now = () => Date.now()) {}

  async analyze(occurrence: ClueOccurrenceInput, requestId?: string, signal?: AbortSignal): Promise<EngineeringClueResponse> {
    const requestStarted = this.now()
    const window = clueEvidenceWindow(occurrence.startUtc, occurrence.endUtc)
    const capabilitySet = await this.telemetry.capabilities.get(occurrence.pressKey, requestId, signal)
    const { byId, selectors } = catalogSelectors(capabilitySet.capabilities)
    const batches = Array.from({ length: Math.ceil(selectors.length / CLUE_SELECTOR_BATCH_SIZE) }, (_, index) => selectors.slice(index * CLUE_SELECTOR_BATCH_SIZE, (index + 1) * CLUE_SELECTOR_BATCH_SIZE))
    const motionCapability = byId.get('physical.motion_state')
    const motionRequested = motionCapability?.state === 'SUPPORTED'
    const [histories, motion] = await Promise.all([
      mapWithConcurrency(batches, CLUE_BATCH_CONCURRENCY, (batch) => this.telemetry.semanticHistory(occurrence.pressKey, { fromUtc: window.fromUtc, toUtc: window.toUtc, includeSeed: true, signals: batch.map(({ selector }) => selector) }, requestId, signal)),
      motionRequested ? this.telemetry.motion(occurrence.pressKey, window.fromUtc, window.toUtc, requestId, signal).catch(() => undefined) : Promise.resolve(undefined),
    ])
    const calculationStarted = this.now()
    const signals = histories.flatMap(({ signals }) => signals)
    const itemBySelector = new Map(selectors.map(({ item, selector }) => [`${selector.canonicalId}:${selector.deckNumber ?? ''}`, item]))
    const clues = signals.map((history) => analyzeSemanticSignal(itemBySelector.get(`${history.canonicalId}:${history.deckNumber ?? ''}`)!, history, occurrence, window))
    if (motion) {
      const motionItem = ENGINEERING_CLUE_CATALOG.find(({ canonicalId }) => canonicalId === 'physical.motion_state')!
      const changes: TelemetryChange[] = motion.segments.slice(1).map((segment, index) => ({ observedAtUtc: segment.fromUtc, receivedAtUtc: segment.fromUtc, sourceTimestampUtc: segment.fromUtc, qualityState: 'DERIVED', valueKind: 'string', value: segment.state, previousObservedAtUtc: motion.segments[index]!.fromUtc, previousReceivedAtUtc: motion.segments[index]!.fromUtc, previousSourceTimestampUtc: motion.segments[index]!.fromUtc, previousQualityState: 'DERIVED', previousValueKind: 'string', previousValue: motion.segments[index]!.state }))
      clues.push(analyzeSemanticSignal(motionItem, { canonicalId: 'physical.motion_state', deckNumber: null, capabilityState: 'SUPPORTED', observationState: motion.segments.length ? 'SUPPORTED_WITH_OBSERVATIONS' : 'SUPPORTED_WITH_NO_SAMPLES_IN_RANGE', mappingStatus: 'MAPPED', sourceUnit: null, canonicalUnitStatus: null, representation: 'changes', seed: motion.segments[0] ? { observedAtUtc: motion.segments[0].fromUtc, receivedAtUtc: motion.segments[0].fromUtc, sourceTimestampUtc: motion.segments[0].fromUtc, qualityState: 'DERIVED', valueKind: 'string', value: motion.segments[0].state } : null, samples: [], changes }, occurrence, window))
    }
    const { categoryColumns, categoryCells } = matrix(byId, clues)
    const whereToLook = rankWhereToLook(clues, categoryCells)
    const signalClues = [...clues].sort((a, b) => Number(b.isClue) - Number(a.isClue) || b.clueQuality - a.clueQuality || a.friendlyName.localeCompare(b.friendlyName)).slice(0, 40)
    const firstChanges = clues.filter(({ isClue, firstRelevantAtUtc }) => isClue && firstRelevantAtUtc).sort((a, b) => (a.firstRelevantOffsetMs ?? 0) - (b.firstRelevantOffsetMs ?? 0)).map(({ canonicalId, deckNumber, friendlyName, signalType, category, firstRelevantAtUtc, firstRelevantOffsetMs, firstRelevantPreviousValue, firstRelevantValue }) => ({ canonicalId, deckNumber, friendlyName, signalType, category, firstRelevantAtUtc, firstRelevantOffsetMs, firstRelevantPreviousValue, firstRelevantValue }))
    const unavailableSelectors = ENGINEERING_CLUE_CATALOG.reduce((total, item) => {
      const capability = byId.get(item.canonicalId)
      if (capability?.state !== 'TEMPORARILY_UNAVAILABLE' && capability?.state !== 'UNKNOWN') return total
      return total + (item.scope === 'deck' ? capability.deckNumbers.length : 1)
    }, 0)
    const coverage = { supportedSelectors: selectors.length + Number(motionRequested), observedSelectors: clues.filter(({ observationConfidence }) => observationConfidence === 'OBSERVED').length, limitedObservationSelectors: clues.filter(({ observationConfidence }) => observationConfidence === 'LIMITED_OBSERVATION').length, noObservationSelectors: clues.filter(({ observationConfidence }) => observationConfidence === 'NO_USABLE_OBSERVATION').length, unavailableSelectors }
    const completed = this.now()
    const result: EngineeringClueResponse = { occurrence, evidenceWindow: window, coverage, whereToLook, categoryColumns, categoryCells, firstChanges, signalClues, performance: { upstreamCalls: 1 + batches.length + Number(motionRequested), semanticCalls: batches.length, totalSelectors: selectors.length + Number(motionRequested), upstreamMs: calculationStarted - requestStarted, calculationMs: completed - calculationStarted, totalMs: completed - requestStarted, responsePayloadBytes: 0 } }
    // Recalculate after inserting the first estimate so the metric includes its own digit width.
    result.performance.responsePayloadBytes = Buffer.byteLength(JSON.stringify(result), 'utf8')
    result.performance.responsePayloadBytes = Buffer.byteLength(JSON.stringify(result), 'utf8')
    return result
  }
}
