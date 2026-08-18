import type { RadiusPressKey } from '../radius/models.js'
import type { IndustrialAnalyticalObservation, IndustrialMetricValue, IndustrialNumericSample } from './contracts.js'
import { boundedDeltaPoints, scanBoundedDeltas } from './bounded-delta.js'

export interface EvidenceQuality {
  supportCount: number
  comparisonCount: number | null
  coverage: number | null
  comparisonCoverage: number | null
  historicalSpan: EvidenceTimeRange | null
  contextMatchLevel: number | null
  contextMatchDimensions: string[]
  medianCadence: number | null
  maximumGap: number | null
  timingResolution: { minimumSeconds: number; maximumSeconds: number } | null
  qualification: 'SUPPORTED' | 'LIMITED' | 'INSUFFICIENT'
  excludedReason: string | null
}

export interface EvidenceTimeRange { startUtc: string; endUtc: string }
export interface EvidenceLagRange { minimumSeconds: number; maximumSeconds: number }

export type RadiusPhysicalAgreementClass =
  | 'PHYSICAL_PRECEDES_RECORDED'
  | 'RECORDED_PRECEDES_PHYSICAL'
  | 'ALIGNED_WITHIN_CADENCE'
  | 'INDETERMINATE_WITHIN_CADENCE'
  | 'NO_SUPPORTED_PHYSICAL_EVIDENCE'

export interface RadiusPhysicalAlignment {
  pressKey: RadiusPressKey
  occurrenceId: string
  recordedRadius: { eventType: string; statusCode: string | null; statusDescription: string }
  recordedStartUtc: string
  recordedEndUtc: string
  inferredPhysicalOnsetRange: EvidenceTimeRange | null
  inferredPhysicalExitRange: EvidenceTimeRange | null
  entryLagRange: EvidenceLagRange | null
  exitLagRange: EvidenceLagRange | null
  speedEvidence: Array<{ canonicalId: 'machine.speed.actual'; observedAtUtc: string; referenceAtUtc: string; delta: number; sourceUnit: string | null }>
  otherTelemetryEvidence: Array<{ canonicalId: string; deckNumber: number | null; observedAtUtc: string; reason: string }>
  contextEvidence: Array<{ field: string; value: string | number | boolean }>
  radiusSequenceEvidence: Array<{ eventType: string; statusCode: string | null; statusDescription: string; relationship: 'PREVIOUS' | 'CURRENT' | 'NEXT' }>
  agreementClass: RadiusPhysicalAgreementClass
  evidenceQuality: EvidenceQuality
}

export type EvidencePhase = 'BACKGROUND' | 'PRECURSOR' | 'TARGET' | 'RESPONSE' | 'RECOVERY'
export interface EvidencePhaseItem { phase: EvidencePhase; atUtc: string | null; label: string; detail: string | null; source: 'radius' | 'telemetry' | 'production_context'; canonicalId: string | null; deckNumber: number | null }
export interface EvidencePhaseSummary { eventStartUtc: string; eventEndUtc: string; items: EvidencePhaseItem[]; limitations: string[] }

export type RelatedSignalReasonCode = 'DELTA_NEAR_EVENT' | 'FIRST_DIVERGENCE' | 'PERSISTENT_DEPARTURE' | 'VALUE_TRANSITION' | 'QUALIFIED_RELATIONSHIP' | 'SAME_DECK' | 'ACTUAL_SPEED_CONTEXT' | 'CONTEXTUAL_DEVIATION'
export interface RelatedSignalSuggestion {
  canonicalId: string
  deckNumber: number | null
  friendlyName: string
  signalType: string
  category: string
  scope: 'machine' | 'deck'
  reasonCodes: RelatedSignalReasonCode[]
  reason: string
  timingDetail: string | null
}

export interface BasicHistoricalSummary {
  scope: string
  supportCount: number
  timeSpan: EvidenceTimeRange | null
  metrics: Record<string, IndustrialMetricValue>
  evidenceQuality: EvidenceQuality
  limitations: string[]
  performance?: { radiusQueryCount: number; historySliceCount?: number; rowsConsidered: number; matchingOccurrences: number; matchingOccurrencesAvailable: number; historyExaminedFromUtc?: string; historyExaminedToUtc?: string; historyComplete?: boolean; historyPartialReason?: 'QUERY_TIMEOUT' | null; totalMs: number; payloadBytes: number }
}

export function evidenceQuality(input: { timestamps: string[]; range: EvidenceTimeRange; comparisonCount?: number | null; comparisonCoverage?: number | null; historicalSpan?: EvidenceTimeRange | null; contextMatchLevel?: number | null; contextMatchDimensions?: string[]; minimumSupport?: number; excludedReason?: string | null }): EvidenceQuality {
  const times = [...new Set(input.timestamps.map(Date.parse).filter(Number.isFinite))].sort((a, b) => a - b)
  const gaps = times.slice(1).map((value, index) => (value - times[index]!) / 1_000).filter((value) => value > 0).sort((a, b) => a - b)
  const medianCadence = gaps.length ? gaps.length % 2 ? gaps[Math.floor(gaps.length / 2)]! : (gaps[gaps.length / 2 - 1]! + gaps[gaps.length / 2]!) / 2 : null
  const duration = Date.parse(input.range.endUtc) - Date.parse(input.range.startUtc)
  const coverage = times.length > 1 && duration > 0 ? Math.min(100, Math.max(0, (times.at(-1)! - times[0]!) / duration * 100)) : times.length ? 0 : null
  const minimum = input.minimumSupport ?? 3
  const qualification = input.excludedReason || times.length < minimum ? 'INSUFFICIENT' : coverage !== null && coverage < 50 ? 'LIMITED' : 'SUPPORTED'
  return { supportCount: times.length, comparisonCount: input.comparisonCount ?? null, coverage: coverage === null ? null : Math.round(coverage * 10) / 10, comparisonCoverage: input.comparisonCoverage ?? null, historicalSpan: input.historicalSpan ?? null, contextMatchLevel: input.contextMatchLevel ?? null, contextMatchDimensions: input.contextMatchDimensions ?? [], medianCadence, maximumGap: gaps.length ? gaps.at(-1)! : null, timingResolution: medianCadence === null ? null : { minimumSeconds: 0, maximumSeconds: medianCadence }, qualification, excludedReason: input.excludedReason ?? (times.length < minimum ? `At least ${minimum} usable observations are required.` : null) }
}

const median = (values: number[]) => { const ordered = [...values].sort((a, b) => a - b); const middle = Math.floor(ordered.length / 2); return ordered.length % 2 ? ordered[middle]! : (ordered[middle - 1]! + ordered[middle]!) / 2 }

export function buildRadiusPhysicalAlignment(input: { pressKey: RadiusPressKey; occurrenceId: string; recordedRadius: RadiusPhysicalAlignment['recordedRadius']; recordedStartUtc: string; recordedEndUtc: string; speedSamples: IndustrialNumericSample[]; sourceUnit: string | null; otherTelemetryEvidence?: RadiusPhysicalAlignment['otherTelemetryEvidence']; contextEvidence?: RadiusPhysicalAlignment['contextEvidence']; radiusSequenceEvidence?: RadiusPhysicalAlignment['radiusSequenceEvidence'] }): RadiusPhysicalAlignment {
  const samples = boundedDeltaPoints(input.speedSamples)
  const range = { startUtc: samples[0]?.atUtc ?? input.recordedStartUtc, endUtc: samples.at(-1)?.atUtc ?? input.recordedEndUtc }
  const quality = evidenceQuality({ timestamps: samples.map((item) => item.atUtc), range, minimumSupport: 5 })
  const before = samples.filter((item) => Date.parse(item.atUtc) < Date.parse(input.recordedStartUtc))
  if (before.length < 5 || quality.qualification === 'INSUFFICIENT') return { ...input, inferredPhysicalOnsetRange: null, inferredPhysicalExitRange: null, entryLagRange: null, exitLagRange: null, speedEvidence: [], otherTelemetryEvidence: input.otherTelemetryEvidence ?? [], contextEvidence: input.contextEvidence ?? [], radiusSequenceEvidence: input.radiusSequenceEvidence ?? [], agreementClass: 'NO_SUPPORTED_PHYSICAL_EVIDENCE', evidenceQuality: { ...quality, excludedReason: 'Actual Speed did not provide enough usable pre-event support for a conservative physical-change window.' } }
  const center = median(before.map((item) => item.value)); const deviations = before.map((item) => Math.abs(item.value - center)); const mad = median(deviations)
  const scale = Math.max(mad * 1.4826, (Math.max(...before.map((item) => item.value)) - Math.min(...before.map((item) => item.value))) * .1, Math.abs(center) * .02, 1e-9)
  const scan = scanBoundedDeltas({ points: samples, windowMinutes: 10, direction: 'either', minimumAmount: scale * 2, referenceMode: 'ROLLING_EXTREME', gapLimitMs: quality.maximumGap && quality.medianCadence ? Math.max(330, quality.medianCadence * 5) * 1_000 : undefined })
  const searchFrom = Date.parse(input.recordedStartUtc) - 20 * 60_000; const searchTo = Date.parse(input.recordedEndUtc)
  const supported = scan.find((step) => step.candidate && Date.parse(step.trigger.atUtc) >= searchFrom && Date.parse(step.trigger.atUtc) <= searchTo)?.candidate
  if (!supported) return { ...input, inferredPhysicalOnsetRange: null, inferredPhysicalExitRange: null, entryLagRange: null, exitLagRange: null, speedEvidence: [], otherTelemetryEvidence: input.otherTelemetryEvidence ?? [], contextEvidence: input.contextEvidence ?? [], radiusSequenceEvidence: input.radiusSequenceEvidence ?? [], agreementClass: 'NO_SUPPORTED_PHYSICAL_EVIDENCE', evidenceQuality: { ...quality, excludedReason: 'No material speed departure was supported relative to local pre-event behavior.' } }
  const triggerIndex = samples.findIndex((item) => item.atUtc === supported.trigger.atUtc)
  const onset = { startUtc: triggerIndex > 0 ? samples[triggerIndex - 1]!.atUtc : supported.reference.atUtc, endUtc: supported.trigger.atUtc }
  const recordedMs = Date.parse(input.recordedStartUtc); const onsetStart = Date.parse(onset.startUtc); const onsetEnd = Date.parse(onset.endUtc)
  const agreementClass: RadiusPhysicalAgreementClass = onsetEnd < recordedMs ? 'PHYSICAL_PRECEDES_RECORDED' : onsetStart > recordedMs ? 'RECORDED_PRECEDES_PHYSICAL' : onsetEnd === recordedMs ? 'ALIGNED_WITHIN_CADENCE' : 'INDETERMINATE_WITHIN_CADENCE'
  const lagValues = [(recordedMs - onsetEnd) / 1_000, (recordedMs - onsetStart) / 1_000].sort((a, b) => a - b)
  return { ...input, inferredPhysicalOnsetRange: onset, inferredPhysicalExitRange: null, entryLagRange: { minimumSeconds: lagValues[0]!, maximumSeconds: lagValues[1]! }, exitLagRange: null, speedEvidence: [{ canonicalId: 'machine.speed.actual', observedAtUtc: supported.trigger.atUtc, referenceAtUtc: supported.reference.atUtc, delta: supported.delta, sourceUnit: input.sourceUnit }], otherTelemetryEvidence: input.otherTelemetryEvidence ?? [], contextEvidence: input.contextEvidence ?? [], radiusSequenceEvidence: input.radiusSequenceEvidence ?? [], agreementClass, evidenceQuality: quality }
}

const reasonLabel: Record<RelatedSignalReasonCode, string> = { DELTA_NEAR_EVENT: 'Strong nearby Delta', FIRST_DIVERGENCE: 'Material change near the target event', PERSISTENT_DEPARTURE: 'Persistent contextual departure', VALUE_TRANSITION: 'Value changed near the event', QUALIFIED_RELATIONSHIP: 'Qualified relationship evidence', SAME_DECK: 'Same deck', ACTUAL_SPEED_CONTEXT: 'Press-wide Actual Speed context', CONTEXTUAL_DEVIATION: 'Contextual-envelope departure' }
const reasonPriority: Record<RelatedSignalReasonCode, number> = { ACTUAL_SPEED_CONTEXT: 80, FIRST_DIVERGENCE: 70, DELTA_NEAR_EVENT: 60, PERSISTENT_DEPARTURE: 50, VALUE_TRANSITION: 45, CONTEXTUAL_DEVIATION: 40, QUALIFIED_RELATIONSHIP: 30, SAME_DECK: 10 }

export function rankRelatedSignals(input: Array<Omit<RelatedSignalSuggestion, 'reason' | 'reasonCodes'> & { reasonCodes: RelatedSignalReasonCode[]; observations?: IndustrialAnalyticalObservation[] }>, targetDeck: number | null, maximum = 5): RelatedSignalSuggestion[] {
  const ranked = input.map((item) => {
    const reasonCodes = [...new Set([...item.reasonCodes, ...(targetDeck !== null && item.deckNumber === targetDeck ? ['SAME_DECK' as const] : []), ...(item.canonicalId === 'machine.speed.actual' ? ['ACTUAL_SPEED_CONTEXT' as const] : [])])]
    const material = item.observations?.filter((value) => value.support.adequate && value.material) ?? []
    const score = Math.max(0, ...reasonCodes.map((reason) => reasonPriority[reason])) + material.length * 5
    return { item, reasonCodes, score }
  }).sort((left, right) => right.score - left.score || left.item.canonicalId.localeCompare(right.item.canonicalId) || (left.item.deckNumber ?? 0) - (right.item.deckNumber ?? 0))
  const selected: typeof ranked = []
  for (const candidate of ranked) if (selected.length < maximum && (!selected.some((item) => item.item.category === candidate.item.category) || candidate.item.canonicalId === 'machine.speed.actual' && !selected.some((item) => item.item.canonicalId === candidate.item.canonicalId))) selected.push(candidate)
  for (const candidate of ranked) if (selected.length < maximum && !selected.includes(candidate)) selected.push(candidate)
  return selected.slice(0, maximum).map(({ item, reasonCodes }) => { const { observations: _observations, ...signal } = item; return { ...signal, reasonCodes, reason: reasonCodes.map((reason) => reasonLabel[reason]).join(' • ') } })
}
