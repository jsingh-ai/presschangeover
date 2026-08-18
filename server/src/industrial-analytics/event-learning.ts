import type { TelemetryScalarValue, TelemetryValueKind } from '../telemetry/telemetry-contracts.js'

export const EVENT_LEARNING_LIMITS = {
  maximumCohortOccurrences: 30,
  maximumCandidateSignals: 12,
  telemetryLookbackHours: 24,
  contextMinutes: 20,
  maximumFindings: 12,
} as const

export interface EventLearningOccurrence {
  occurrenceId: string
  startUtc: string
  endUtc: string
  label: string
}

export interface EventLearningSignal {
  canonicalId: string
  deckNumber: number | null
  friendlyName: string
  category: string
  signalType: string
  sourceUnit: string | null
  valueKind: TelemetryValueKind | null
  samples: Array<{ observedAtUtc: string; value: TelemetryScalarValue; qualityState?: string }>
  changes: Array<{ observedAtUtc: string; previousValue: TelemetryScalarValue; value: TelemetryScalarValue; qualityState?: string; previousQualityState?: string }>
}

export interface EventSignalPattern {
  canonicalId: string
  deckNumber: number | null
  friendlyName: string
  category: string
  sourceUnit: string | null
  kind: 'numeric' | 'state'
  provenance: 'AUTHORITATIVE' | 'INFERRED_LOW_CARDINALITY' | 'NUMERIC'
  description: string
  direction: 'increase' | 'decrease' | 'transition'
  magnitude: number | null
  oldValue: TelemetryScalarValue | null
  newValue: TelemetryScalarValue | null
  atUtc: string
  relativeMinutes: number
  persistenceMinutes: number | null
  reason: string
  coverageObservations: number
  phase: {
    before: string
    event: string
    recovery: string
  }
}

export interface EventOccurrenceFingerprint {
  occurrenceId: string
  startUtc: string
  endUtc: string
  coveredSignalKeys: string[]
  patterns: EventSignalPattern[]
}

export interface EventFingerprintFinding extends EventSignalPattern {
  validOccurrenceCount: number
  observedOccurrenceCount: number
  occurrenceRate: number
  medianRelativeMinutes: number
  relativeMinutesIqr: { lower: number; upper: number } | null
  medianMagnitude: number | null
  occurrenceIds: string[]
}

export interface EventSequencePattern {
  label: string
  canonicalId: string
  deckNumber: number | null
  supportCount: number
  validOccurrenceCount: number
  medianRelativeMinutes: number
  relativeMinutesIqr: { lower: number; upper: number } | null
}

export interface EventLearningReport {
  version: 1
  reportKind: 'raw_radius' | 'telemetry_event'
  title: string
  target: Record<string, string | number | boolean | null>
  selectedOccurrence: EventLearningOccurrence
  recordedTime: { startUtc: string; endUtc: string }
  physicalTiming: object
  productionContext: Array<{ field: string; value: string | number | boolean }>
  radiusContext: Array<{ relationship: string; eventType: string; statusCode: string | null; statusDescription: string }>
  selectedFindings: EventSignalPattern[]
  phaseComparison: Array<{ canonicalId: string; deckNumber: number | null; friendlyName: string; before: string; event: string; recovery: string }>
  historicalFingerprint: {
    requestedOccurrences: number
    qualifiedOccurrences: number
    excludedOccurrences: number
    radiusCoverage: { startUtc: string; endUtc: string } | null
    telemetryCoverage: { startUtc: string; endUtc: string } | null
    findings: EventFingerprintFinding[]
  }
  typicalSequence: EventSequencePattern[]
  relationships: Array<{ signal: string; mode: 'LEVELS' | 'DIFFERENCES' | 'TRANSITION_COOCCURRENCE'; interpretation: string; metrics: Record<string, string | number | boolean | null> }>
  occurrenceComparison: { common: string[]; exceptions: string[] }
  controls: { status: 'AVAILABLE' | 'UNAVAILABLE'; reason: string; comparisons: Array<{ label: string; targetRate: number; controlRate: number }> }
  occurrenceMatrix: Array<{ occurrenceId: string; startUtc: string; patterns: string[] }>
  coverage: { candidateSignals: number; automaticRawSignalScans: 0; limitations: string[] }
  performance: { semanticHistoryRequests: number; cohortOccurrences: number; totalMs: number; payloadBytes: number }
}

function signalKey(signal: Pick<EventLearningSignal, 'canonicalId' | 'deckNumber'>) { return `${signal.canonicalId}:${signal.deckNumber ?? ''}` }
function usableQuality(value?: string) { return !value || !/(bad|invalid|unavailable|no.?data|not.?connected|error)/i.test(value) }
function round(value: number, digits = 2) { const scale = 10 ** digits; return Math.round(value * scale) / scale }
function median(values: number[]) { const sorted = [...values].sort((a, b) => a - b); if (!sorted.length) return null; const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2 }
function quantile(values: number[], percentile: number) { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.floor((sorted.length - 1) * percentile)]! : null }
function describeValue(value: TelemetryScalarValue) { return typeof value === 'boolean' ? (value ? 'TRUE' : 'FALSE') : String(value) }
function describeNumbers(values: number[]) { const middle = median(values); return values.length && middle !== null ? `median ${round(middle)}; range ${round(Math.min(...values))}–${round(Math.max(...values))}` : 'unavailable' }
function sameScalar(left: TelemetryScalarValue, right: TelemetryScalarValue) { return typeof left === 'number' && typeof right === 'number' ? Math.abs(left - right) <= Number.EPSILON : left === right }

function inferredDiscrete(signal: EventLearningSignal, usableSamples: EventLearningSignal['samples']) {
  if (signal.signalType === 'state_event' || signal.valueKind === 'boolean' || signal.valueKind === 'string' || signal.valueKind === 'text') return false
  if (signal.valueKind !== 'integer' || usableSamples.length < 3) return false
  const values = usableSamples.flatMap(({ value }) => typeof value === 'number' && Number.isInteger(value) ? [value] : [])
  return values.length === usableSamples.length && new Set(values).size >= 2 && new Set(values).size <= 6
}

function statePattern(signal: EventLearningSignal, occurrence: EventLearningOccurrence, fromMs: number, toMs: number, inferred: boolean): EventSignalPattern | null {
  const explicit = signal.changes.filter((item) => usableQuality(item.qualityState) && usableQuality(item.previousQualityState) && Date.parse(item.observedAtUtc) >= fromMs && Date.parse(item.observedAtUtc) <= toMs && !sameScalar(item.previousValue, item.value))
  let transition = explicit.sort((a, b) => Math.abs(Date.parse(a.observedAtUtc) - Date.parse(occurrence.startUtc)) - Math.abs(Date.parse(b.observedAtUtc) - Date.parse(occurrence.startUtc)))[0]
  if (!transition && inferred) {
    const ordered = signal.samples.filter((item) => usableQuality(item.qualityState) && Date.parse(item.observedAtUtc) >= fromMs && Date.parse(item.observedAtUtc) <= toMs).sort((a, b) => Date.parse(a.observedAtUtc) - Date.parse(b.observedAtUtc))
    const transitions = ordered.slice(1).flatMap((item, index) => sameScalar(ordered[index]!.value, item.value) ? [] : [{ observedAtUtc: item.observedAtUtc, previousValue: ordered[index]!.value, value: item.value, qualityState: item.qualityState }])
    transition = transitions.sort((a, b) => Math.abs(Date.parse(a.observedAtUtc) - Date.parse(occurrence.startUtc)) - Math.abs(Date.parse(b.observedAtUtc) - Date.parse(occurrence.startUtc)))[0]
  }
  if (!transition) return null
  const atMs = Date.parse(transition.observedAtUtc); const next = signal.changes.filter((item) => Date.parse(item.observedAtUtc) > atMs && !sameScalar(item.value, transition!.value)).sort((a, b) => Date.parse(a.observedAtUtc) - Date.parse(b.observedAtUtc))[0]
  const relativeMinutes = round((atMs - Date.parse(occurrence.startUtc)) / 60_000, 1)
  return {
    canonicalId: signal.canonicalId, deckNumber: signal.deckNumber, friendlyName: signal.friendlyName, category: signal.category, sourceUnit: signal.sourceUnit,
    kind: 'state', provenance: inferred ? 'INFERRED_LOW_CARDINALITY' : 'AUTHORITATIVE', description: `${describeValue(transition.previousValue)} → ${describeValue(transition.value)}`,
    direction: 'transition', magnitude: null, oldValue: transition.previousValue, newValue: transition.value, atUtc: transition.observedAtUtc, relativeMinutes,
    persistenceMinutes: next ? round((Date.parse(next.observedAtUtc) - atMs) / 60_000, 1) : null,
    reason: inferred ? 'Low-cardinality integer transition near the target (inferred discrete)' : 'Authoritative value/state transition near the target',
    coverageObservations: Math.max(explicit.length, signal.samples.filter((item) => Date.parse(item.observedAtUtc) >= fromMs && Date.parse(item.observedAtUtc) <= toMs && usableQuality(item.qualityState)).length),
    phase: { before: describeValue(transition.previousValue), event: `${describeValue(transition.previousValue)} → ${describeValue(transition.value)}`, recovery: next ? describeValue(next.value) : 'not observed in bounded window' },
  }
}

function numericPattern(signal: EventLearningSignal, occurrence: EventLearningOccurrence, fromMs: number, toMs: number): EventSignalPattern | null {
  const targetMs = Date.parse(occurrence.startUtc); const usable = signal.samples.filter((item): item is typeof item & { value: number } => typeof item.value === 'number' && Number.isFinite(item.value) && usableQuality(item.qualityState) && Date.parse(item.observedAtUtc) >= fromMs && Date.parse(item.observedAtUtc) <= toMs).sort((a, b) => Date.parse(a.observedAtUtc) - Date.parse(b.observedAtUtc))
  const before = usable.filter((item) => Date.parse(item.observedAtUtc) < targetMs); const event = usable.filter((item) => Date.parse(item.observedAtUtc) >= targetMs && Date.parse(item.observedAtUtc) <= Math.min(toMs, Date.parse(occurrence.endUtc))); const after = usable.filter((item) => Date.parse(item.observedAtUtc) > Date.parse(occurrence.endUtc))
  if (before.length < 2 || (event.length + after.length) < 2) return null
  const beforeMedian = median(before.map(({ value }) => value))!; const comparison = event.length >= 2 ? event : after; const comparisonMedian = median(comparison.map(({ value }) => value))!
  const magnitude = comparisonMedian - beforeMedian; const allValues = usable.map(({ value }) => value); const scale = Math.max((Math.max(...allValues) - Math.min(...allValues)) * .08, Math.abs(beforeMedian) * .01, 1e-9)
  if (Math.abs(magnitude) < scale) return null
  const strongest = usable.reduce((best, item) => Math.abs(item.value - beforeMedian) > Math.abs(best.value - beforeMedian) ? item : best, usable[0]!)
  const relativeMinutes = round((Date.parse(strongest.observedAtUtc) - targetMs) / 60_000, 1)
  return {
    canonicalId: signal.canonicalId, deckNumber: signal.deckNumber, friendlyName: signal.friendlyName, category: signal.category, sourceUnit: signal.sourceUnit,
    kind: 'numeric', provenance: 'NUMERIC', description: `${magnitude >= 0 ? 'increased' : 'decreased'} ${round(Math.abs(magnitude))}${signal.sourceUnit ? ` ${signal.sourceUnit}` : ''}`,
    direction: magnitude >= 0 ? 'increase' : 'decrease', magnitude: round(magnitude), oldValue: null, newValue: null, atUtc: strongest.observedAtUtc, relativeMinutes, persistenceMinutes: null,
    reason: 'Material event-aligned numeric change with usable before/event observations', coverageObservations: usable.length,
    phase: { before: describeNumbers(before.map(({ value }) => value)), event: describeNumbers(event.map(({ value }) => value)), recovery: describeNumbers(after.map(({ value }) => value)) },
  }
}

export function buildOccurrenceFingerprint(occurrence: EventLearningOccurrence, signals: EventLearningSignal[], contextMinutes = EVENT_LEARNING_LIMITS.contextMinutes): EventOccurrenceFingerprint {
  const contextMs = contextMinutes * 60_000; const fromMs = Date.parse(occurrence.startUtc) - contextMs; const toMs = Date.parse(occurrence.endUtc) + contextMs
  const patterns: EventSignalPattern[] = []; const coveredSignalKeys: string[] = []
  for (const signal of signals) {
    const usableSamples = signal.samples.filter((item) => usableQuality(item.qualityState) && Date.parse(item.observedAtUtc) >= fromMs && Date.parse(item.observedAtUtc) <= toMs)
    const usableChanges = signal.changes.filter((item) => usableQuality(item.qualityState) && Date.parse(item.observedAtUtc) >= fromMs && Date.parse(item.observedAtUtc) <= toMs)
    if (usableSamples.length >= 2 || usableChanges.length) coveredSignalKeys.push(signalKey(signal))
    const inferred = inferredDiscrete(signal, usableSamples)
    const pattern = signal.signalType === 'state_event' || ['boolean', 'string', 'text'].includes(signal.valueKind ?? '') || inferred ? statePattern(signal, occurrence, fromMs, toMs, inferred) : numericPattern(signal, occurrence, fromMs, toMs)
    if (pattern) patterns.push(pattern)
  }
  return { occurrenceId: occurrence.occurrenceId, startUtc: occurrence.startUtc, endUtc: occurrence.endUtc, coveredSignalKeys, patterns: patterns.sort((a, b) => Math.abs(a.relativeMinutes) - Math.abs(b.relativeMinutes)).slice(0, EVENT_LEARNING_LIMITS.maximumFindings) }
}

function patternSignature(pattern: EventSignalPattern) { return `${pattern.canonicalId}:${pattern.deckNumber ?? ''}:${pattern.kind}:${pattern.kind === 'state' ? `${String(pattern.oldValue)}>${String(pattern.newValue)}` : pattern.direction}` }

export function aggregateEventFingerprints(fingerprints: EventOccurrenceFingerprint[], signals: EventLearningSignal[]) {
  const signalByKey = new Map(signals.map((signal) => [signalKey(signal), signal])); const grouped = new Map<string, EventSignalPattern[]>()
  for (const fingerprint of fingerprints) for (const pattern of fingerprint.patterns) { const key = patternSignature(pattern); grouped.set(key, [...(grouped.get(key) ?? []), pattern]) }
  const findings: EventFingerprintFinding[] = [...grouped.values()].map((patterns) => {
    const first = patterns[0]!; const key = signalKey(first); const validOccurrenceCount = fingerprints.filter((item) => item.coveredSignalKeys.includes(key)).length; const relative = patterns.map(({ relativeMinutes }) => relativeMinutes); const magnitudes = patterns.flatMap(({ magnitude }) => magnitude === null ? [] : [magnitude]); const lower = quantile(relative, .25); const upper = quantile(relative, .75)
    return { ...first, validOccurrenceCount, observedOccurrenceCount: patterns.length, occurrenceRate: validOccurrenceCount ? round(patterns.length / validOccurrenceCount, 3) : 0, medianRelativeMinutes: round(median(relative) ?? 0, 1), relativeMinutesIqr: lower === null || upper === null ? null : { lower: round(lower, 1), upper: round(upper, 1) }, medianMagnitude: magnitudes.length ? round(median(magnitudes)!) : null, occurrenceIds: fingerprints.filter((item) => item.patterns.some((pattern) => patternSignature(pattern) === patternSignature(first))).map(({ occurrenceId }) => occurrenceId) }
  }).filter((item) => item.validOccurrenceCount > 0).sort((a, b) => b.occurrenceRate - a.occurrenceRate || b.observedOccurrenceCount - a.observedOccurrenceCount || a.friendlyName.localeCompare(b.friendlyName)).slice(0, EVENT_LEARNING_LIMITS.maximumFindings)
  const typicalSequence: EventSequencePattern[] = findings.filter((item) => item.observedOccurrenceCount >= 2 && item.occurrenceRate >= .5).map((item) => ({ label: `${item.friendlyName}: ${item.description}`, canonicalId: item.canonicalId, deckNumber: item.deckNumber, supportCount: item.observedOccurrenceCount, validOccurrenceCount: item.validOccurrenceCount, medianRelativeMinutes: item.medianRelativeMinutes, relativeMinutesIqr: item.relativeMinutesIqr })).sort((a, b) => a.medianRelativeMinutes - b.medianRelativeMinutes).slice(0, 6)
  return { findings, typicalSequence, signalByKey }
}

export function telemetryCoverage(signals: EventLearningSignal[]) {
  const timestamps = signals.flatMap((signal) => [...signal.samples.map(({ observedAtUtc }) => observedAtUtc), ...signal.changes.map(({ observedAtUtc }) => observedAtUtc)]).filter((value) => Number.isFinite(Date.parse(value))).sort((a, b) => Date.parse(a) - Date.parse(b))
  return timestamps.length ? { startUtc: timestamps[0]!, endUtc: timestamps.at(-1)! } : null
}

export function compareSelectedToTypical(selected: EventOccurrenceFingerprint, findings: EventFingerprintFinding[]) {
  const selectedSignatures = new Set(selected.patterns.map(patternSignature)); const common: string[] = []; const exceptions: string[] = []
  for (const finding of findings.filter((item) => item.observedOccurrenceCount >= 2 && item.occurrenceRate >= .5)) {
    if (selectedSignatures.has(patternSignature(finding))) common.push(`${finding.friendlyName} matches the recurring ${finding.description} pattern (${finding.observedOccurrenceCount}/${finding.validOccurrenceCount} valid occurrences).`)
    else if (selected.coveredSignalKeys.includes(signalKey(finding))) exceptions.push(`${finding.friendlyName} had valid coverage, but the recurring ${finding.description} pattern was not observed in this bounded window.`)
  }
  return { common: common.slice(0, 5), exceptions: exceptions.slice(0, 5) }
}
