import { createHash } from 'node:crypto'
import type { RadiusService } from '../radius/radius-service.js'
import { RADIUS_PRESS_KEYS, type OperationalEpisode, type RadiusPressKey, type RadiusStatusSegment } from '../radius/models.js'
import type { PressSemanticSignalWithIdentity, TelemetryFoundationService } from '../telemetry/telemetry-foundation-service.js'
import { PRODUCTION_CONTEXT_CANONICAL_IDS, type BoundedTelemetryReadDiagnostics, type CapabilityAssessment, type ProductionContextChange, type ProductionContextEvidence, type TelemetrySample, type TelemetryScalarValue } from '../telemetry/telemetry-contracts.js'
import { IndustrialAnalyticsService } from '../industrial-analytics/industrial-analytics-service.js'
import type { IndustrialAnalyticalObservation, IndustrialNumericSample, IndustrialStateSample } from '../industrial-analytics/contracts.js'
import { assessContextualBaseline, buildProductionContextIdentity, contextualBaseline, PRODUCTION_CONTEXT_IDENTITY_FIELDS, resolveProductionContextCapabilities, segmentProductionContextEpisodes, usableProductionContextValue, type ContextualBaselineAssessment, type ProductionContextEpisode, type ProductionContextIdentityField } from '../industrial-analytics/production-context.js'
import { eventTelemetrySelectors, selectBoundedEventTelemetry, speedRecoveryObservation, type SelectedEventTelemetrySeries } from '../industrial-analytics/event-telemetry.js'
import { buildCategoricalTemporalEvidenceProgram, buildNumericTemporalEvidenceProgram, TEMPORAL_PROGRAM_MODEL_SIGNAL_LIMIT, type TemporalEvidenceProgram } from '../industrial-analytics/temporal-evidence.js'
import { strongestBoundedDelta } from '../industrial-analytics/bounded-delta.js'
import { rankRelatedSignals, type RelatedSignalReasonCode } from '../industrial-analytics/explorer-evidence.js'
import { AI_INVESTIGATOR_MAX_RANGE_MS, type AiBaselineProvenance, type AiEvidenceSource, type AiGroundingFact } from './contracts.js'
import { createIndustrialObservationFacts, createRadiusDriverDurationFact } from './evidence-graph.js'

export const AI_INVESTIGATOR_TOOL_NAMES = [
  'get_fleet_operational_summary',
  'compare_press_period',
  'get_press_event_summary',
  'get_event_context',
] as const
export type AiInvestigatorToolName = (typeof AI_INVESTIGATOR_TOOL_NAMES)[number]

export interface AiInvestigatorToolDefinition {
  type: 'function'
  name: AiInvestigatorToolName
  description: string
  strict: true
  parameters: Record<string, unknown>
}

export interface AiToolExecutionContext {
  requestId: string
  signal: AbortSignal
  includeDiagnostics?: boolean
}

export type AiToolResult = Record<string, unknown>
export interface AiInvestigatorToolExecutor {
  readonly definitions: AiInvestigatorToolDefinition[]
  execute(name: string, rawArguments: unknown, context: AiToolExecutionContext): Promise<AiToolResult>
}
export const MAX_TOOL_PAYLOAD_BYTES = 64 * 1024
export const TOOL_PAYLOAD_ENGINEERING_TARGET_BYTES = 48 * 1024
const MAX_EVENT_CONTEXT_MINUTES = 60
const MAX_EVENT_SUMMARY_RANGE_MS = 24 * 60 * 60_000
const DETAILED_EVENT_LIMIT = 3
const CONTEXT_BASELINE_LOOKBACK_STEPS_MS = [24, 48].map((hours) => hours * 60 * 60_000)

const PRESS_SCHEMA = { type: ['string', 'null'], enum: [...RADIUS_PRESS_KEYS, null] }
const UTC_SCHEMA = { type: 'string', description: 'UTC ISO-8601 ending in Z.' }

export const AI_INVESTIGATOR_TOOL_DEFINITIONS: AiInvestigatorToolDefinition[] = [
  {
    type: 'function', name: 'get_fleet_operational_summary', strict: true,
    description: 'Deterministic Radius facts for the fleet or one press; use first.',
    parameters: { type: 'object', additionalProperties: false, required: ['start', 'end', 'press'], properties: { start: UTC_SCHEMA, end: UTC_SCHEMA, press: PRESS_SCHEMA } },
  },
  {
    type: 'function', name: 'compare_press_period', strict: true,
    description: 'Deterministic current-versus-baseline facts for one press.',
    parameters: { type: 'object', additionalProperties: false, required: ['press', 'currentStart', 'currentEnd', 'baselineStart', 'baselineEnd'], properties: { press: { type: 'string', enum: RADIUS_PRESS_KEYS }, currentStart: UTC_SCHEMA, currentEnd: UTC_SCHEMA, baselineStart: UTC_SCHEMA, baselineEnd: UTC_SCHEMA } },
  },
  {
    type: 'function', name: 'get_press_event_summary', strict: true,
    description: 'Bounded event, Radius-state, and Job/Order/Recipe facts for one press.',
    parameters: { type: 'object', additionalProperties: false, required: ['press', 'start', 'end', 'topN', 'detailLevel'], properties: { press: { type: 'string', enum: RADIUS_PRESS_KEYS }, start: UTC_SCHEMA, end: UTC_SCHEMA, topN: { type: 'integer', minimum: 1, maximum: 10 }, detailLevel: { type: 'string', enum: ['selected', 'fleet', 'fleet_summary'] } } },
  },
  {
    type: 'function', name: 'get_event_context', strict: true,
    description: 'Bounded Radius, actual-speed, and Job/Order/Recipe facts around a timestamp.',
    parameters: { type: 'object', additionalProperties: false, required: ['press', 'timestamp', 'beforeMinutes', 'afterMinutes'], properties: { press: { type: 'string', enum: RADIUS_PRESS_KEYS }, timestamp: UTC_SCHEMA, beforeMinutes: { type: 'integer', minimum: 1, maximum: MAX_EVENT_CONTEXT_MINUTES }, afterMinutes: { type: 'integer', minimum: 1, maximum: MAX_EVENT_CONTEXT_MINUTES } } },
  },
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort()
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index])
}

function press(value: unknown): RadiusPressKey {
  if (typeof value !== 'string' || !RADIUS_PRESS_KEYS.includes(value as RadiusPressKey)) throw new Error('invalid_ai_tool_press')
  return value as RadiusPressKey
}

function utc(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('invalid_ai_tool_timestamp')
  return value
}

function range(startValue: unknown, endValue: unknown): { start: string; end: string } {
  const start = utc(startValue); const end = utc(endValue)
  const duration = Date.parse(end) - Date.parse(start)
  if (duration <= 0 || duration > AI_INVESTIGATOR_MAX_RANGE_MS) throw new Error('invalid_ai_tool_range')
  return { start, end }
}

function integer(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new Error('invalid_ai_tool_limit')
  return Number(value)
}

function round(value: number | null, digits = 1): number | null {
  if (value === null || !Number.isFinite(value)) return null
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function percent(part: number, total: number): number | null {
  return total > 0 ? round(part / total * 100) : null
}

function displayValue(value: TelemetryScalarValue): string | number | boolean | null {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  return round(value, 2)
}

export function sanitizeProductionContextIdentity(value: unknown): { value: string | number | boolean | null; usable: boolean } {
  const normalized = usableProductionContextValue(value)
  return normalized === null ? { value: null, usable: false } : { value: normalized, usable: true }
}

function identity(value: string): string { return createHash('sha256').update(value).digest('hex').slice(0, 10) }
function fact(pressKey: RadiusPressKey, pressName: string, source: AiEvidenceSource, metric: string, value: AiGroundingFact['value'], unit: string | null, role: AiGroundingFact['role'], label: string, suffix: string, options: Pick<AiGroundingFact, 'timestamp' | 'range'> = {}): AiGroundingFact {
  return { factId: `${pressKey}.${suffix}`, pressKey, press: pressName, source, metric, value, unit, role, usable: value !== null, label, ...options }
}

function summaryFacts(pressKey: RadiusPressKey, pressName: string, summary: { coveragePercent: number | null; productionPercent: number | null; productionInterruptions: number; longestInterruptionMinutes: number | null }, role: 'current' | 'baseline', rangeValue: { start: string; end: string }): AiGroundingFact[] {
  return [
    fact(pressKey, pressName, 'coverage', 'coveragePercent', summary.coveragePercent, 'percent', role, 'Data coverage', `coverage_percent.${role}`, { range: rangeValue }),
    fact(pressKey, pressName, 'radius', 'productionPercent', summary.productionPercent, 'percent', role, 'Production time', `production_percent.${role}`, { range: rangeValue }),
    fact(pressKey, pressName, 'radius', 'interruptions', summary.productionInterruptions, 'count', role, 'Production interruptions', `interruptions.${role}`, { range: rangeValue }),
    fact(pressKey, pressName, 'radius', 'longestInterruptionMinutes', summary.longestInterruptionMinutes, 'minutes', role, 'Longest interruption', `longest_interruption_minutes.${role}`, { range: rangeValue }),
  ]
}

function driverFacts(pressKey: RadiusPressKey, pressName: string, drivers: Array<{ eventType: string; statusCode: string | null; statusDescription: string; durationMinutes: number | null; occurrences: number }>, role: 'current' | 'baseline' | 'event', rangeValue: { start: string; end: string }): AiGroundingFact[] {
  return drivers.map((driver) => createRadiusDriverDurationFact({ pressKey, press: pressName, driver, role, range: rangeValue }))
}

function compactRadiusStates(segments: RadiusStatusSegment[], maximum = 6) {
  const totals = new Map<string, { eventType: string; statusCode: string | null; statusDescription: string; durationSeconds: number; occurrences: number }>()
  for (const segment of segments) {
    if (segment.kind !== 'radius') continue
    const key = `${segment.eventType}\u0000${segment.statusCode ?? ''}\u0000${segment.statusDescription}`
    const current = totals.get(key) ?? { eventType: segment.eventType, statusCode: segment.statusCode, statusDescription: segment.statusDescription, durationSeconds: 0, occurrences: 0 }
    current.durationSeconds += segment.durationSeconds; current.occurrences += 1; totals.set(key, current)
  }
  return [...totals.values()].sort((left, right) => right.durationSeconds - left.durationSeconds).slice(0, maximum).map(({ durationSeconds, ...item }) => ({ ...item, durationMinutes: round(durationSeconds / 60) }))
}

function contextAt(evidence: ProductionContextEvidence, timestamp: string) {
  const timestampMs = Date.parse(timestamp)
  return Object.fromEntries(Object.entries(evidence.fields).map(([field, item]) => {
    const latest = item.changes.filter((change) => Date.parse(change.observedAtUtc) <= timestampMs).at(-1)
    const sample = latest ?? item.seed
    const sanitized = sanitizeProductionContextIdentity(sample ? displayValue(sample.value) : null)
    return [field, { ...sanitized, observedAtUtc: sample?.observedAtUtc ?? null, observationState: item.observationState }]
  }))
}

function usableNumber(sample: TelemetrySample): number | null {
  if (typeof sample.value !== 'number' || !Number.isFinite(sample.value) || /BAD|INVALID|UNAVAILABLE|NO_DATA|NODATA/i.test(sample.qualityState)) return null
  return sample.value
}

function speedSummary(samples: TelemetrySample[]) {
  const usable = samples.map((sample) => ({ sample, value: usableNumber(sample) })).filter((item): item is { sample: TelemetrySample; value: number } => item.value !== null)
  if (!usable.length) return { observationCount: 0, minimum: null, maximum: null, average: null, latest: null, latestAtUtc: null }
  const values = usable.map(({ value }) => value)
  const latest = usable.at(-1)!
  return { observationCount: usable.length, minimum: round(Math.min(...values), 2), maximum: round(Math.max(...values), 2), average: round(values.reduce((sum, value) => sum + value, 0) / values.length, 2), latest: round(latest.value, 2), latestAtUtc: latest.sample.observedAtUtc }
}

function industrialNumericSamples(samples: TelemetrySample[]): IndustrialNumericSample[] {
  return samples.flatMap((sample) => typeof sample.value === 'number' && Number.isFinite(sample.value)
    ? [{ atUtc: sample.observedAtUtc, value: sample.value, qualityState: sample.qualityState }]
    : [])
}

function telemetryPointCoverage(samples: Array<{ observedAtUtc?: string; atUtc?: string }>, rangeValue: { start: string; end: string }): number {
  if (samples.length < 2) return 0
  const ordered = samples.map((item) => Date.parse(item.observedAtUtc ?? item.atUtc ?? '')).filter(Number.isFinite).sort((left, right) => left - right)
  return Number(round(Math.min(100, Math.max(0, (ordered.at(-1)! - ordered[0]!) / (Date.parse(rangeValue.end) - Date.parse(rangeValue.start)) * 100))) ?? 0)
}

export function largestWindowDelta(samples: IndustrialNumericSample[], rangeValue: { start: string; end: string }, windowMinutes = 10): number | null {
  return strongestBoundedDelta({ points: samples.filter((item) => Date.parse(item.atUtc) >= Date.parse(rangeValue.start) && Date.parse(item.atUtc) <= Date.parse(rangeValue.end)), windowMinutes, referenceMode: 'LATEST_AT_OR_BEFORE_WINDOW' })?.delta ?? null
}

function observedCadenceMinutes(values: Array<{ atUtc: string }>): number | undefined {
  const ordered = values.map((item) => Date.parse(item.atUtc)).filter(Number.isFinite).sort((a, b) => a - b); const gaps = ordered.slice(1).map((value, index) => value - ordered[index]!).filter((value) => value > 0).sort((a, b) => a - b); if (!gaps.length) return undefined; const middle = Math.floor(gaps.length / 2); return (gaps.length % 2 ? gaps[middle]! : (gaps[middle - 1]! + gaps[middle]!) / 2) / 60_000
}

export interface AiToolPayloadProfile {
  serializedBytes: number
  limitBytes: number
  headroomBytes: number
  withinHardLimit: boolean
  withinEngineeringTarget: boolean
  diagnosticsExcludedAtBoundary: true
  topLevelSections: Array<{ section: string; serializedBytes: number }>
  observationCount: number
  factCount: number
  traceCount: number
  contextEpisodeCount: number
  largestTraceBytes: number
}

function arrayCount(value: unknown): number { return Array.isArray(value) ? value.length : 0 }

export function profileAiToolPayload(result: AiToolResult): AiToolPayloadProfile {
  const { validationDiagnostics: _validationDiagnostics, ...normal } = result
  const industrialAnalytics = isRecord(normal.industrialAnalytics) ? normal.industrialAnalytics : {}
  const productionContext = isRecord(normal.productionContext) ? normal.productionContext : {}
  const traces = Array.isArray(normal.temporalEvidencePrograms) ? normal.temporalEvidencePrograms : []
  const serializedBytes = Buffer.byteLength(JSON.stringify(normal), 'utf8')
  return {
    serializedBytes,
    limitBytes: MAX_TOOL_PAYLOAD_BYTES,
    headroomBytes: MAX_TOOL_PAYLOAD_BYTES - serializedBytes,
    withinHardLimit: serializedBytes < MAX_TOOL_PAYLOAD_BYTES,
    withinEngineeringTarget: serializedBytes <= TOOL_PAYLOAD_ENGINEERING_TARGET_BYTES,
    diagnosticsExcludedAtBoundary: true,
    topLevelSections: Object.entries(normal).map(([section, value]) => ({ section, serializedBytes: Buffer.byteLength(JSON.stringify({ [section]: value }), 'utf8') })).sort((left, right) => right.serializedBytes - left.serializedBytes),
    observationCount: arrayCount(industrialAnalytics.observations),
    factCount: arrayCount(normal.facts),
    traceCount: traces.length,
    contextEpisodeCount: arrayCount(productionContext.episodes),
    largestTraceBytes: Math.max(0, ...traces.map((trace) => Buffer.byteLength(JSON.stringify(trace), 'utf8'))),
  }
}

export class AiToolPayloadTooLargeError extends Error {
  readonly code = 'ai_tool_payload_too_large'
  context: { tool: string; pressKey: string | null; detailMode: string | null } | null = null
  constructor(readonly profile: AiToolPayloadProfile) { super('ai_tool_payload_too_large'); this.name = 'AiToolPayloadTooLargeError' }
}

function safePayload(result: AiToolResult, includeDiagnostics = false): AiToolResult {
  const { validationDiagnostics, ...normal } = result
  const profile = profileAiToolPayload(normal)
  if (!profile.withinHardLimit) throw new AiToolPayloadTooLargeError(profile)
  return includeDiagnostics && validationDiagnostics !== undefined ? { ...normal, validationDiagnostics } : normal
}

interface LoadedContextHistory {
  signals: PressSemanticSignalWithIdentity[]
  queryCount: number
  range: { start: string; end: string }
  readDiagnostics?: BoundedTelemetryReadDiagnostics
}

interface LoadedHistoricalContext {
  episodes: ProductionContextEpisode[]
  queryCount: number
  range: { start: string; end: string }
  readDiagnostics?: BoundedTelemetryReadDiagnostics
}

function contextInitialValues(history: LoadedContextHistory): Partial<Record<ProductionContextIdentityField, unknown>> {
  return Object.fromEntries(PRODUCTION_CONTEXT_IDENTITY_FIELDS.flatMap((field) => {
    const signal = history.signals.find((item) => item.canonicalId === PRODUCTION_CONTEXT_CANONICAL_IDS[field])
    const value = signal?.seed ? usableProductionContextValue(signal.seed.value, signal.seed.qualityState) : null
    return value === null ? [] : [[field, value]]
  }))
}

function contextTimelineObservations(history: LoadedContextHistory) {
  return PRODUCTION_CONTEXT_IDENTITY_FIELDS.flatMap((field) => {
    const signal = history.signals.find((item) => item.canonicalId === PRODUCTION_CONTEXT_CANONICAL_IDS[field])
    return signal?.changes.map((change) => ({ atUtc: change.observedAtUtc, field, value: usableProductionContextValue(change.value, change.qualityState), previousValue: usableProductionContextValue(change.previousValue, change.previousQualityState) })) ?? []
  }).sort((left, right) => Date.parse(left.atUtc) - Date.parse(right.atUtc) || left.field.localeCompare(right.field))
}

function identityFacts(pressKey: RadiusPressKey, pressName: string, episode: ProductionContextEpisode): AiGroundingFact[] {
  return episode.identity.dimensionNames.map((field) => fact(pressKey, pressName, 'production_context', field, episode.identity.dimensions[field]!, null, 'event', `${field[0]!.toUpperCase()}${field.slice(1)}`, `context.${episode.identity.contextKey}.${field}.event`, { range: { start: episode.startUtc, end: episode.endUtc } }))
}

function contextualObservation(episode: ProductionContextEpisode, prior: ProductionContextEpisode[]): { observation: IndustrialAnalyticalObservation; facts: AiGroundingFact[] } | null {
  const baseline = contextualBaseline(episode, prior)
  if (!baseline) return null
  const metrics = [
    { metric: 'contextEpisodeInterruptions', deltaMetric: 'contextEpisodeInterruptionDelta', label: 'Context-episode interruptions', unit: 'count', current: episode.metrics.productionInterruptions, reference: baseline.medians.productionInterruptions, material: 2 },
    { metric: 'contextEpisodeTotalInterruptionMinutes', deltaMetric: 'contextEpisodeTotalInterruptionDeltaMinutes', label: 'Context-episode interruption time', unit: 'minutes', current: round(episode.metrics.totalInterruptionSeconds / 60)!, reference: round(baseline.medians.totalInterruptionSeconds / 60)!, material: 15 },
    { metric: 'contextEpisodeReturnAttempts', deltaMetric: 'contextEpisodeReturnAttemptDelta', label: 'Context-episode return attempts', unit: 'count', current: episode.metrics.returnAttempts, reference: baseline.medians.returnAttempts, material: 2 },
    { metric: 'contextEpisodeDurationMinutes', deltaMetric: 'contextEpisodeDurationDeltaMinutes', label: 'Context-episode duration', unit: 'minutes', current: round(episode.durationSeconds / 60)!, reference: round(baseline.medians.episodeDurationSeconds / 60)!, material: 30 },
  ].map((item) => ({ ...item, delta: round(item.current - item.reference)! })).sort((left, right) => Math.abs(right.delta) / right.material - Math.abs(left.delta) / left.material || left.metric.localeCompare(right.metric))
  const selected = metrics[0]!
  const base = `${episode.pressKey}.context_baseline.${episode.identity.contextKey}.${selected.metric}`
  const provenance: AiBaselineProvenance = { baselineType: baseline.baselineType, label: `Context comparison: ${baseline.label}`, currentRange: { start: episode.startUtc, end: episode.endUtc }, baselineRange: baseline.historicalRange, supportCount: baseline.sampleCount, coveragePercent: baseline.coveragePercent, matchingDimensions: baseline.matchingDimensions, fallbackLevel: baseline.fallbackLevel }
  const values: AiGroundingFact[] = [
    { factId: `${base}.current`, pressKey: episode.pressKey, press: episode.pressKey.replace('press', 'Press '), source: 'radius', metric: selected.metric, value: selected.current, unit: selected.unit, role: 'current', usable: true, label: selected.label, range: { start: episode.startUtc, end: episode.endUtc }, baselineProvenance: provenance },
    { factId: `${base}.baseline`, pressKey: episode.pressKey, press: episode.pressKey.replace('press', 'Press '), source: 'comparison', metric: selected.metric, value: selected.reference, unit: selected.unit, role: 'baseline', usable: true, label: `${selected.label} contextual median`, range: baseline.historicalRange, baselineProvenance: provenance },
    { factId: `${base}.delta`, pressKey: episode.pressKey, press: episode.pressKey.replace('press', 'Press '), source: 'comparison', metric: selected.deltaMetric, value: selected.delta, unit: selected.unit, role: 'delta', usable: true, label: `${selected.label} change`, range: { start: episode.startUtc, end: episode.endUtc }, baselineProvenance: provenance },
  ]
  const observation: IndustrialAnalyticalObservation = { observationId: `contextual.${episode.identity.contextKey}.${selected.metric}`, family: 'contextual_baseline', pressKey: episode.pressKey, deckNumber: null, range: { start: episode.startUtc, end: episode.endUtc }, comparisonRange: baseline.historicalRange, eventId: episode.episodeId, variableIds: episode.identity.dimensionNames.map((field) => `production.${field}`), factIds: values.map((item) => item.factId), metrics: { metric: selected.label, unit: selected.unit, current: selected.current, baselineMedian: selected.reference, delta: selected.delta, baselineType: baseline.baselineType, matchingDimensions: baseline.matchingDimensions.join(' + '), sampleCount: baseline.sampleCount, fallbackLevel: baseline.fallbackLevel }, support: { sampleCount: 1, comparisonSampleCount: baseline.sampleCount, coveragePercent: episode.coveragePercent, comparisonCoveragePercent: baseline.coveragePercent, adequate: baseline.sampleCount >= 3 && episode.coveragePercent >= 80, minimumRequired: 3, reason: null }, evidenceSource: 'comparison', magnitudeInputs: { normalizedDelta: Math.abs(selected.delta) / selected.material, support: baseline.sampleCount }, material: Math.abs(selected.delta) >= selected.material, limitations: [], explorer: { href: `/operational-analysis?press=${episode.pressKey}`, label: 'Open contextual episode evidence' } }
  return { observation, facts: values }
}

function eventWindow(episode: OperationalEpisode, requestRange: { start: string; end: string }) {
  const eventEnd = Math.min(Date.parse(episode.endUtc ?? requestRange.end), Date.parse(episode.startUtc) + 20 * 60_000)
  const event = { id: episode.episodeId, start: episode.startUtc, end: new Date(eventEnd).toISOString() }
  return { event, range: { start: new Date(Math.max(Date.parse(requestRange.start), Date.parse(event.start) - 20 * 60_000)).toISOString(), end: new Date(Math.min(Date.parse(requestRange.end), eventEnd + 20 * 60_000)).toISOString() } }
}

export function eventOverlapsRequestedRange(episode: Pick<OperationalEpisode, 'startUtc' | 'endUtc'>, requestRange: { start: string; end: string }): boolean {
  return Date.parse(episode.startUtc) < Date.parse(requestRange.end) && Date.parse(episode.endUtc ?? requestRange.end) > Date.parse(requestRange.start)
}

export class AiInvestigatorReadOnlyToolRegistry implements AiInvestigatorToolExecutor {
  readonly definitions = AI_INVESTIGATOR_TOOL_DEFINITIONS
  private readonly industrialAnalytics = new IndustrialAnalyticsService()

  constructor(private readonly radius: RadiusService, private readonly telemetry: TelemetryFoundationService) {}

  private async productionContextHistory(pressKey: RadiusPressKey, start: string, end: string, context: AiToolExecutionContext): Promise<LoadedContextHistory> {
    const selectors = PRODUCTION_CONTEXT_IDENTITY_FIELDS.map((field) => ({ canonicalId: PRODUCTION_CONTEXT_CANONICAL_IDS[field], representation: 'changes' as const }))
    const response = await this.telemetry.semanticHistoryWithIdentity(pressKey, { fromUtc: start, toUtc: end, includeSeed: true, signals: selectors }, context.requestId, context.signal)
    const signals = PRODUCTION_CONTEXT_IDENTITY_FIELDS.flatMap((field): PressSemanticSignalWithIdentity[] => {
      const canonicalId = PRODUCTION_CONTEXT_CANONICAL_IDS[field]; const found = response.signals.find((item) => item.canonicalId === canonicalId)
      return found ? [{ ...found, samples: [] }] : []
    })
    return { signals, queryCount: response.readDiagnostics?.telemetryRequests ?? 1, range: { start, end }, readDiagnostics: response.readDiagnostics }
  }

  private async historicalContextEpisodes(pressKey: RadiusPressKey, start: string, end: string, context: AiToolExecutionContext): Promise<LoadedHistoricalContext> {
    const [history, radius] = await Promise.all([this.productionContextHistory(pressKey, start, end, context), this.radius.getPressEpisodes(pressKey, start, end)])
    const episodes = segmentProductionContextEpisodes({ pressKey, range: { start, end }, initialValues: contextInitialValues(history), observations: contextTimelineObservations(history), gaps: radius.timelineSegments.filter((segment) => segment.kind === 'offline').map((segment) => ({ start: segment.startUtc, end: segment.endUtc })), radiusSegments: radius.timelineSegments, operationalEpisodes: radius.episodes })
    return { episodes, queryCount: history.queryCount + 1, range: { start, end }, readDiagnostics: history.readDiagnostics }
  }

  async execute(name: string, rawArguments: unknown, context: AiToolExecutionContext): Promise<AiToolResult> {
    if (!AI_INVESTIGATOR_TOOL_NAMES.includes(name as AiInvestigatorToolName)) throw new Error('unknown_ai_investigator_tool')
    if (!isRecord(rawArguments)) throw new Error('invalid_ai_tool_arguments')
    let result: AiToolResult
    if (name === 'get_fleet_operational_summary') result = await this.fleetSummary(rawArguments)
    else if (name === 'compare_press_period') result = await this.comparePeriod(rawArguments)
    else if (name === 'get_press_event_summary') result = await this.pressEvents(rawArguments, context)
    else result = await this.eventContext(rawArguments, context)
    try { return safePayload(result, context.includeDiagnostics) }
    catch (error) {
      if (error instanceof AiToolPayloadTooLargeError) error.context = { tool: name, pressKey: typeof rawArguments.press === 'string' ? rawArguments.press : null, detailMode: typeof rawArguments.detailLevel === 'string' ? rawArguments.detailLevel : null }
      throw error
    }
  }

  private async fleetSummary(args: Record<string, unknown>): Promise<AiToolResult> {
    if (!exactKeys(args, ['start', 'end', 'press'])) throw new Error('invalid_ai_tool_arguments')
    const selectedPress = args.press === null ? null : press(args.press)
    const { start, end } = range(args.start, args.end)
    const overview = await (this.radius.getAnalysisOverview?.(start, end) ?? this.radius.getOverview(start, end))
    const presses = overview.presses.filter((item) => !selectedPress || item.pressKey === selectedPress)
    const mappedPresses = presses.map((item) => ({
      press: item.displayName, pressKey: item.pressKey, coveragePercent: round(item.dataCoveragePercent), productionPercent: percent(item.runProductionSeconds, item.observedSeconds), productionMinutes: round(item.runProductionSeconds / 60), nonProductionMinutes: round(item.nonProductionSeconds / 60), unavailableMinutes: round(item.offlineSeconds / 60), productionInterruptions: item.episodeCount, longestInterruptionMinutes: round(item.longestEpisodeSeconds / 60), currentRadiusState: item.currentStatusDescription,
      leadingRadiusStates: compactRadiusStates(item.timelineSegments),
    }))
    return {
      range: { start, end }, scope: selectedPress ?? 'all', feedStatus: overview.feedStatus, lastObservationUtc: overview.lastObservationUtc, queryCount: 1,
      presses: mappedPresses,
      facts: mappedPresses.flatMap((item) => [...summaryFacts(item.pressKey, item.press, item, 'current', { start, end }), ...driverFacts(item.pressKey, item.press, item.leadingRadiusStates, 'current', { start, end })]),
      limitations: ['Job, Order, and Recipe are not fleet-scanned in this phase; request press event context only for the strongest candidates.', 'Unavailable time is reported separately and is not classified as an operational state.'],
    }
  }

  private async comparePeriod(args: Record<string, unknown>): Promise<AiToolResult> {
    if (!exactKeys(args, ['press', 'currentStart', 'currentEnd', 'baselineStart', 'baselineEnd'])) throw new Error('invalid_ai_tool_arguments')
    const pressKey = press(args.press)
    const current = range(args.currentStart, args.currentEnd); const baseline = range(args.baselineStart, args.baselineEnd)
    const loadOverview = (fromUtc: string, toUtc: string) => this.radius.getAnalysisOverview?.(fromUtc, toUtc) ?? this.radius.getOverview(fromUtc, toUtc)
    const [currentOverview, baselineOverview] = await Promise.all([loadOverview(current.start, current.end), loadOverview(baseline.start, baseline.end)])
    const currentData = currentOverview.presses.find((item) => item.pressKey === pressKey); const baselineData = baselineOverview.presses.find((item) => item.pressKey === pressKey)
    if (!currentData || !baselineData) throw new Error('ai_tool_press_unavailable')
    const summarize = (data: typeof currentData) => ({ coveragePercent: round(data.dataCoveragePercent), productionPercent: percent(data.runProductionSeconds, data.observedSeconds), productionMinutes: round(data.runProductionSeconds / 60), nonProductionMinutes: round(data.nonProductionSeconds / 60), unavailableMinutes: round(data.offlineSeconds / 60), productionInterruptions: data.episodeCount, longestInterruptionMinutes: round(data.longestEpisodeSeconds / 60), leadingRadiusStates: compactRadiusStates(data.timelineSegments) })
    const currentSummary = summarize(currentData); const baselineSummary = summarize(baselineData)
    const differences = { productionPercentagePoints: currentSummary.productionPercent === null || baselineSummary.productionPercent === null ? null : round(currentSummary.productionPercent - baselineSummary.productionPercent), productionInterruptions: currentSummary.productionInterruptions - baselineSummary.productionInterruptions, longestInterruptionMinutes: currentSummary.longestInterruptionMinutes === null || baselineSummary.longestInterruptionMinutes === null ? null : round(currentSummary.longestInterruptionMinutes - baselineSummary.longestInterruptionMinutes) }
    const comparisonFacts: AiGroundingFact[] = [
      fact(pressKey, currentData.displayName, 'comparison', 'productionPercentagePointDelta', differences.productionPercentagePoints, 'percentage_points', 'delta', 'Production time change', 'production_percent.delta', { range: current }),
      fact(pressKey, currentData.displayName, 'comparison', 'interruptionDelta', differences.productionInterruptions, 'count', 'delta', 'Interruption change', 'interruptions.delta', { range: current }),
      fact(pressKey, currentData.displayName, 'comparison', 'longestInterruptionDeltaMinutes', differences.longestInterruptionMinutes, 'minutes', 'delta', 'Longest interruption change', 'longest_interruption_minutes.delta', { range: current }),
    ]
    return { press: currentData.displayName, pressKey, current: { range: current, ...currentSummary }, baseline: { range: baseline, ...baselineSummary }, differences, queryCount: 2, facts: [...summaryFacts(pressKey, currentData.displayName, currentSummary, 'current', current), ...summaryFacts(pressKey, currentData.displayName, baselineSummary, 'baseline', baseline), ...comparisonFacts, ...driverFacts(pressKey, currentData.displayName, currentSummary.leadingRadiusStates, 'current', current), ...driverFacts(pressKey, currentData.displayName, baselineSummary.leadingRadiusStates, 'baseline', baseline)], baselineSufficient: baselineData.dataCoveragePercent >= 80, limitations: ['Job counts are omitted because no compact aggregate is available without additional telemetry queries.'] }
  }

  private async pressEvents(args: Record<string, unknown>, context: AiToolExecutionContext): Promise<AiToolResult> {
    const pressEventsBegan = Date.now()
    const legacyArguments = exactKeys(args, ['press', 'start', 'end', 'topN'])
    if (!legacyArguments && !exactKeys(args, ['press', 'start', 'end', 'topN', 'detailLevel']) || !legacyArguments && !['selected', 'fleet', 'fleet_summary'].includes(String(args.detailLevel))) throw new Error('invalid_ai_tool_arguments')
    const pressKey = press(args.press); const { start, end } = range(args.start, args.end); const topN = integer(args.topN, 1, 10); const detailLevel = legacyArguments ? 'selected' : args.detailLevel as 'selected' | 'fleet' | 'fleet_summary'
    if (Date.parse(end) - Date.parse(start) > MAX_EVENT_SUMMARY_RANGE_MS) throw new Error('invalid_ai_tool_range')
    const radiusBegan = Date.now()
    const data = await this.radius.getPressEpisodes(pressKey, start, end)
    const radiusFetchMs = Date.now() - radiusBegan
    const orderedEpisodes = data.episodes.filter((episode) => eventOverlapsRequestedRange(episode, { start, end })).sort((left, right) => right.durationSeconds - left.durationSeconds)
    const detailedEpisodes = orderedEpisodes.slice(0, detailLevel === 'selected' ? Math.min(topN, DETAILED_EVENT_LIMIT) : Math.min(topN, 1))
    const focusWindow = detailedEpisodes[0] ? eventWindow(detailedEpisodes[0], { start, end }).range : { start, end }
    const contextRange = detailLevel === 'selected' ? { start, end } : focusWindow
    let capabilitiesFetchMs = 0; let currentContextFetchMs = 0
    const [capabilitiesResult, contextResult] = await Promise.allSettled([
      (async () => { const began = Date.now(); try { return await (this.telemetry.capabilities?.get ? this.telemetry.capabilities.get(pressKey, context.requestId, context.signal) : Promise.reject(new Error('telemetry_capabilities_unavailable'))) } finally { capabilitiesFetchMs = Date.now() - began } })(),
      (async () => { const began = Date.now(); try { return await (typeof this.telemetry.semanticHistoryWithIdentity === 'function' ? this.productionContextHistory(pressKey, contextRange.start, contextRange.end, context) : Promise.reject(new Error('production_context_history_unavailable'))) } finally { currentContextFetchMs = Date.now() - began } })(),
    ])
    const contextCapabilities = contextResult.status === 'fulfilled' ? resolveProductionContextCapabilities({ range: contextResult.value.range, signals: contextResult.value.signals }) : []
    const contextEpisodes = contextResult.status === 'fulfilled' ? segmentProductionContextEpisodes({
      pressKey, range: contextRange, initialValues: contextInitialValues(contextResult.value), observations: contextTimelineObservations(contextResult.value),
      gaps: data.timelineSegments.filter((segment) => segment.kind === 'offline').map((segment) => ({ start: segment.startUtc, end: segment.endUtc })), radiusSegments: data.timelineSegments, operationalEpisodes: data.episodes,
    }) : []
    const contextFor = (episode: OperationalEpisode) => contextEpisodes.find((candidate) => Date.parse(candidate.startUtc) <= Date.parse(episode.startUtc) && Date.parse(candidate.endUtc) >= Date.parse(episode.startUtc))
    let baselineEpisodes = [...contextEpisodes]; let baselineQueryCount = 0; let baselineRadiusQueries = 0; let baselineLookbackStart = contextRange.start; const baselineReadDiagnostics: BoundedTelemetryReadDiagnostics[] = []; const baselineSearchBegan = Date.now()
    const assessBaselines = () => detailedEpisodes.map((episode) => { const current = contextFor(episode); return { eventId: episode.episodeId, current, assessment: current ? assessContextualBaseline(current, baselineEpisodes) : null } })
    let baselineAssessments = assessBaselines()
    if (detailLevel === 'selected' && contextResult.status === 'fulfilled' && baselineAssessments.some((item) => item.assessment?.status !== 'SUFFICIENT')) {
      let priorOffset = 0
      for (const lookback of CONTEXT_BASELINE_LOOKBACK_STEPS_MS) {
        const historicalRange = { start: new Date(Date.parse(start) - lookback).toISOString(), end: new Date(Date.parse(start) - priorOffset).toISOString() }
        const loaded = await this.historicalContextEpisodes(pressKey, historicalRange.start, historicalRange.end, context); baselineEpisodes = [...loaded.episodes, ...baselineEpisodes]; baselineQueryCount += loaded.queryCount; baselineRadiusQueries += 1; if (loaded.readDiagnostics) baselineReadDiagnostics.push(loaded.readDiagnostics); baselineLookbackStart = historicalRange.start; baselineAssessments = assessBaselines(); priorOffset = lookback
        if (baselineAssessments.every((item) => !item.current || item.assessment?.status === 'SUFFICIENT')) break
      }
    }
    const baselineSearchMs = Date.now() - baselineSearchBegan
    const baselineDiagnostics = baselineAssessments.map(({ eventId, current, assessment }) => ({ eventId, matchingLevel: assessment?.baseline?.fallbackLevel ?? null, matchingDimensions: assessment?.baseline?.matchingDimensions ?? current?.identity.dimensionNames ?? [], searchRange: { start: baselineLookbackStart, end: contextRange.end }, candidatesFound: assessment?.attempts.map((item) => ({ level: item.fallbackLevel, dimensions: item.matchingDimensions, found: item.candidatesFound, rejected: item.candidatesRejected })) ?? [], finalN: assessment?.actualSupport ?? 0, minimumRequired: assessment?.minimumRequired ?? 3, result: assessment?.status ?? 'VALUE_UNAVAILABLE' }))
    const episodes = orderedEpisodes.slice(0, topN).map((episode) => {
      const primary = episode.statusSegments.find((segment) => segment.statusDescription === episode.primaryStatusDescription) ?? episode.statusSegments.find((segment) => !segment.isProduction)
      return { episodeId: episode.episodeId, startUtc: episode.startUtc, endUtc: episode.endUtc, durationMinutes: round(episode.durationSeconds / 60), completionStatus: episode.completionStatus, dataInterrupted: episode.dataInterrupted, primaryRadiusState: episode.primaryStatusDescription, primaryRadiusIdentity: primary ? { eventType: primary.eventType, statusCode: primary.statusCode, statusDescription: primary.statusDescription } : null, returnAttempts: episode.returnToProductionAttemptCount, failedReturnAttempts: episode.failedReturnToProductionAttempts }
    })
    const productionContextIdentities = [...new Map(detailedEpisodes.flatMap((episode) => { const match = contextFor(episode); return match ? [[match.identity.contextKey, { eventId: episode.episodeId, contextKey: match.identity.contextKey, dimensions: match.identity.dimensions, summary: match.identity.summary }] as const] : [] })).values()]
    const productionContext = contextResult.status === 'fulfilled' ? {
      available: true, capabilities: contextCapabilities, identities: productionContextIdentities,
      episodes: contextEpisodes.slice(0, 8).map((episode) => ({ contextKey: episode.identity.contextKey, dimensions: episode.identity.dimensions, summary: episode.identity.summary, startUtc: episode.startUtc, endUtc: episode.endUtc, durationMinutes: round(episode.durationSeconds / 60), coveragePercent: episode.coveragePercent, interruptions: episode.metrics.productionInterruptions, returnsToProduction: episode.metrics.returnsToProduction, returnAttempts: episode.metrics.returnAttempts, failedReturnAttempts: episode.metrics.failedReturnAttempts, longestInterruptionMinutes: round(episode.metrics.longestInterruptionSeconds / 60), totalInterruptionMinutes: round(episode.metrics.totalInterruptionSeconds / 60), repeatedRadiusStates: episode.metrics.repeatedRadiusStates, loopCount: episode.metrics.loopCount })),
    } : { available: false, capabilities: [], identities: [], episodes: [] }
    const topRadiusDrivers = data.operationalAnalytics.statusDrivers.slice().sort((left, right) => right.durationSeconds - left.durationSeconds).slice(0, topN).map((item) => ({ eventType: item.eventType, statusCode: item.statusCode, statusDescription: item.statusDescription, durationMinutes: round(item.durationSeconds / 60), occurrences: item.occurrenceCount }))
    const eventFacts = episodes.flatMap((episode, index) => {
      const eventEnd = episode.endUtc ?? end
      return [
        fact(pressKey, data.press.displayName, 'radius', 'eventTimestamp', episode.startUtc, 'iso8601', 'event', `Interruption ${index + 1}`, `event.${identity(`${episode.startUtc}\u0000${eventEnd}`)}.timestamp`, { timestamp: episode.startUtc, range: { start: episode.startUtc, end: eventEnd } }),
        fact(pressKey, data.press.displayName, 'radius', 'eventDurationMinutes', episode.durationMinutes, 'minutes', 'event', `Interruption ${index + 1} duration`, `event.${identity(`${episode.startUtc}\u0000${eventEnd}`)}.duration_minutes`, { range: { start: episode.startUtc, end: eventEnd } }),
      ]
    })
    const contextFacts = detailedEpisodes.flatMap((episode) => { const match = contextFor(episode); return match ? identityFacts(pressKey, data.press.displayName, match) : [] })
    const summary = { coveragePercent: round(data.summary.dataCoveragePercent), productionPercent: null, productionInterruptions: data.summary.episodeCount, longestInterruptionMinutes: round(data.summary.longestEpisodeSeconds / 60) }
    const observations: IndustrialAnalyticalObservation[] = []
    const contextualFacts: AiGroundingFact[] = []
    for (const focusEpisode of detailedEpisodes) {
      observations.push(this.industrialAnalytics.sequenceDeviation({
        pressKey,
        range: { start, end },
        occurrence: { episodeId: focusEpisode.episodeId, startUtc: focusEpisode.startUtc, endUtc: focusEpisode.endUtc ?? end, orderedStates: focusEpisode.statusSegments.map((segment) => ({ state: segment.statusDescription, identity: { eventType: segment.eventType, statusCode: segment.statusCode, statusDescription: segment.statusDescription }, durationSeconds: segment.durationSeconds })), returnAttempts: focusEpisode.returnToProductionAttemptCount, productionRestored: focusEpisode.completionStatus === 'CONFIRMED_PRODUCTION' },
        comparable: data.episodes.map((episode) => ({ episodeId: episode.episodeId, startUtc: episode.startUtc, endUtc: episode.endUtc ?? end, orderedStates: episode.statusSegments.map((segment) => ({ state: segment.statusDescription, identity: { eventType: segment.eventType, statusCode: segment.statusCode, statusDescription: segment.statusDescription }, durationSeconds: segment.durationSeconds })), returnAttempts: episode.returnToProductionAttemptCount })),
      }))
      const matchingContext = contextFor(focusEpisode); const contextual = matchingContext ? contextualObservation(matchingContext, baselineEpisodes) : null
      if (contextual) { observations.push(contextual.observation); contextualFacts.push(...contextual.facts) }
    }
    const actualSpeedSupported = capabilitiesResult.status === 'fulfilled' && capabilitiesResult.value.capabilities.some((item) => item.canonicalId === 'machine.speed.actual' && item.state === 'SUPPORTED' && item.historyQueryable)
    const selectedTelemetry = capabilitiesResult.status === 'fulfilled' ? selectBoundedEventTelemetry(capabilitiesResult.value.capabilities, actualSpeedSupported ? 11 : 12) : []
    const supportedContextBaseline = detailLevel === 'selected' ? baselineAssessments.find((item) => item.assessment?.baseline)?.assessment?.baseline ?? null : null
    const baselineSelectors = [...(actualSpeedSupported ? [{ canonicalId: 'machine.speed.actual', representation: 'samples' as const }] : []), ...eventTelemetrySelectors(selectedTelemetry)]
    const contextualFeatureBegan = Date.now()
    const contextualFeatureHistory = supportedContextBaseline && baselineSelectors.length ? await this.telemetry.semanticHistoryWithIdentity(pressKey, { fromUtc: supportedContextBaseline.historicalRange.start, toUtc: supportedContextBaseline.historicalRange.end, includeSeed: true, signals: baselineSelectors }, context.requestId, context.signal) : null
    const contextualFeatureFetchMs = Date.now() - contextualFeatureBegan
    const contextualFeatureCache = new Map<string, { value: number | null; coveragePercent: number; range: { start: string; end: string } }>()
    let speedUnavailableCount = 0; let telemetryUnavailableCount = 0
    const eventWindowsBegan = Date.now()
    const telemetryResults: Array<{ observations: IndustrialAnalyticalObservation[]; temporalPrograms: TemporalEvidenceProgram[]; diagnostic: Record<string, unknown> }> = []
    for (const [episodeIndex, focusEpisode] of detailedEpisodes.entries()) {
      const telemetryResult = await (async () => {
      const bounded = eventWindow(focusEpisode, { start, end }); const selectors = eventTelemetrySelectors(selectedTelemetry); const queryBegan = Date.now()
      let speedFetchMs = 0; let semanticFetchMs = 0
      const [speedResult, selectedResult] = await Promise.allSettled([
        (async () => { const began = Date.now(); try { return await this.telemetry.speedWithIdentity(pressKey, bounded.range.start, bounded.range.end, context.requestId, context.signal) } finally { speedFetchMs = Date.now() - began } })(),
        (async () => { const began = Date.now(); try { return await (selectors.length ? this.telemetry.semanticHistoryWithIdentity(pressKey, { fromUtc: bounded.range.start, toUtc: bounded.range.end, includeSeed: true, signals: selectors }, context.requestId, context.signal) : Promise.resolve(null)) } finally { semanticFetchMs = Date.now() - began } })(),
      ])
      const localAnalyticsBegan = Date.now()
      const local: IndustrialAnalyticalObservation[] = []
      const programInputs: Array<{ canonicalId: string; deckNumber: number | null; friendlyName: string; signalType: string; category: string; scope: 'machine' | 'deck'; unit: string | null; numeric?: IndustrialNumericSample[]; states?: IndustrialStateSample[]; gaps?: Array<{ canonicalId: string; deckNumber: number | null; startUtc: string; endUtc: string; durationMs: number }> }> = []
      let actual: IndustrialNumericSample[] = []
      if (speedResult.status === 'fulfilled') {
        const speed = speedResult.value; actual = industrialNumericSamples(speed.actual.samples)
        programInputs.push({ canonicalId: speed.actual.canonicalId, deckNumber: null, friendlyName: 'Actual Speed', signalType: 'continuous', category: 'speed', scope: 'machine', unit: speed.actual.sourceUnit, numeric: actual })
        if (speed.setpoint) programInputs.push({ canonicalId: speed.setpoint.canonicalId, deckNumber: null, friendlyName: 'Speed Setpoint', signalType: 'continuous', category: 'speed_setpoint', scope: 'machine', unit: speed.setpoint.sourceUnit, numeric: industrialNumericSamples(speed.setpoint.samples) })
        const robust = this.industrialAnalytics.robustNumericChange({ pressKey, variableId: speed.actual.canonicalId, unit: speed.actual.sourceUnit, range: bounded.range, samples: actual, eventId: focusEpisode.episodeId })
        const aligned = this.industrialAnalytics.eventAlignedNumeric({ pressKey, variableId: speed.actual.canonicalId, unit: speed.actual.sourceUnit, range: bounded.range, samples: actual, event: bounded.event })
        const recovery = speedRecoveryObservation({ pressKey, event: bounded.event, range: bounded.range, samples: speed.actual.samples, unit: speed.actual.sourceUnit })
        const envelope = this.industrialAnalytics.normalEnvelopeDeparture({ pressKey, variableId: speed.actual.canonicalId, unit: speed.actual.sourceUnit, range: bounded.range, samples: actual, event: bounded.event }); const persistence = this.industrialAnalytics.deviationPersistence({ pressKey, variableId: speed.actual.canonicalId, unit: speed.actual.sourceUnit, range: bounded.range, samples: actual, event: bounded.event })
        if (robust) local.push(robust); if (aligned) local.push(aligned); if (recovery) local.push(recovery); if (envelope) local.push(envelope); if (persistence) local.push(persistence)
        if (speed.setpoint) { for (const basis of ['LEVELS', 'DIFFERENCES'] as const) { const relationship = this.industrialAnalytics.relationshipObservation({ pressKey, leftVariableId: speed.setpoint.canonicalId, rightVariableId: speed.actual.canonicalId, range: bounded.range, left: industrialNumericSamples(speed.setpoint.samples), right: actual, context: `Radius episode ${focusEpisode.episodeId}`, basis, scope: 'EVENT_WINDOW' }); if (relationship) local.push(relationship) } }
      } else speedUnavailableCount += 1
      if (selectedResult.status === 'fulfilled' && selectedResult.value) {
        for (const selected of selectedTelemetry) {
          const signal = selectedResult.value.signals.find((item) => item.canonicalId === selected.canonicalId && item.deckNumber === (selected.deckNumber ?? null)); if (!signal) continue
          if (selected.signalType === 'continuous') {
            const samples = industrialNumericSamples(signal.samples); const robust = this.industrialAnalytics.robustNumericChange({ pressKey, variableId: selected.canonicalId, deckNumber: selected.deckNumber, unit: signal.sourceUnit, range: bounded.range, samples, eventId: focusEpisode.episodeId }); const aligned = this.industrialAnalytics.eventAlignedNumeric({ pressKey, variableId: selected.canonicalId, deckNumber: selected.deckNumber, unit: signal.sourceUnit, range: bounded.range, samples, event: bounded.event }); const envelope = this.industrialAnalytics.normalEnvelopeDeparture({ pressKey, variableId: selected.canonicalId, deckNumber: selected.deckNumber, unit: signal.sourceUnit, range: bounded.range, samples, event: bounded.event }); const persistence = this.industrialAnalytics.deviationPersistence({ pressKey, variableId: selected.canonicalId, deckNumber: selected.deckNumber, unit: signal.sourceUnit, range: bounded.range, samples, event: bounded.event }); if (robust) local.push(robust); if (aligned) local.push(aligned); if (envelope) local.push(envelope); if (persistence) local.push(persistence)
            programInputs.push({ canonicalId: selected.canonicalId, deckNumber: selected.deckNumber ?? null, friendlyName: selected.friendlyName, signalType: selected.signalType, category: selected.category, scope: selected.deckNumber === null ? 'machine' : 'deck', unit: signal.sourceUnit, numeric: samples, gaps: selectedResult.value.readDiagnostics?.gaps })
            if (actual.length) { for (const basis of ['LEVELS', 'DIFFERENCES'] as const) { const relationship = this.industrialAnalytics.relationshipObservation({ pressKey, leftVariableId: 'machine.speed.actual', rightVariableId: selected.canonicalId, range: bounded.range, left: actual, right: samples, context: `Radius episode ${focusEpisode.episodeId}`, basis, scope: 'EVENT_WINDOW' }); if (relationship) local.push(relationship) } }
          } else {
            const states: IndustrialStateSample[] = []; if (signal.seed) states.push({ atUtc: bounded.range.start, value: signal.seed.value, qualityState: signal.seed.qualityState }); states.push(...signal.changes.map((change) => ({ atUtc: change.observedAtUtc, value: change.value, qualityState: change.qualityState }))); if (states.length) local.push(this.industrialAnalytics.valueTransitions({ pressKey, variableId: selected.canonicalId, deckNumber: selected.deckNumber, range: bounded.range, samples: states, event: bounded.event }))
            programInputs.push({ canonicalId: selected.canonicalId, deckNumber: selected.deckNumber ?? null, friendlyName: selected.friendlyName, signalType: selected.signalType, category: selected.category, scope: selected.deckNumber === null ? 'machine' : 'deck', unit: null, states, gaps: selectedResult.value.readDiagnostics?.gaps })
          }
        }
      } else if (selectors.length) telemetryUnavailableCount += 1
      const baselineAssessment = baselineAssessments.find((item) => item.eventId === focusEpisode.episodeId)?.assessment
      const matchingContext = contextFor(focusEpisode)
      if (contextualFeatureHistory && baselineAssessment?.baseline && matchingContext) {
        const matchingDimensions = baselineAssessment.baseline.matchingDimensions
        const priorEpisodes = baselineEpisodes.filter((episode) => Date.parse(episode.endUtc) <= Date.parse(matchingContext.startUtc) && episode.coveragePercent >= 80 && (matchingDimensions.length === 0 || matchingDimensions.every((field) => episode.identity.dimensions[field] === matchingContext.identity.dimensions[field])))
        for (const item of programInputs.filter((candidate) => candidate.numeric)) {
          const currentValue = largestWindowDelta(item.numeric!, bounded.range); const historicalSignal = contextualFeatureHistory.signals.find((signalValue) => signalValue.canonicalId === item.canonicalId); if (currentValue === null || !historicalSignal) continue
          const historicalSamples = industrialNumericSamples(historicalSignal.samples)
          const historical = priorEpisodes.flatMap((episode) => { const rangeValue = { start: episode.startUtc, end: episode.endUtc }; const cacheKey = `${item.canonicalId}\u0000${rangeValue.start}\u0000${rangeValue.end}`; let feature = contextualFeatureCache.get(cacheKey); if (!feature) { const episodeSamples = historicalSamples.filter((sample) => Date.parse(sample.atUtc) >= Date.parse(rangeValue.start) && Date.parse(sample.atUtc) <= Date.parse(rangeValue.end)); feature = { value: largestWindowDelta(episodeSamples, rangeValue), coveragePercent: telemetryPointCoverage(episodeSamples, rangeValue), range: rangeValue }; contextualFeatureCache.set(cacheKey, feature) } return feature.value === null ? [] : [{ ...feature, value: feature.value }] })
          local.push(this.industrialAnalytics.contextualTelemetryBaseline({ pressKey, eventId: focusEpisode.episodeId, variableId: item.canonicalId, feature: 'largest10mDelta', unit: item.unit, range: bounded.range, currentValue, currentSampleCount: item.numeric!.length, currentCoveragePercent: telemetryPointCoverage(item.numeric!, bounded.range), historical, baselineType: baselineAssessment.baseline.fallbackLevel <= 2 ? 'context' : 'episode', matchingDimensions, fallbackLevel: baselineAssessment.baseline.fallbackLevel }))
        }
      }
      const cadenceMinutes = observedCadenceMinutes(programInputs.flatMap((item) => item.numeric ?? item.states ?? [])); const eventObservations = [...observations.filter((item) => item.eventId === focusEpisode.episodeId), ...local]; const first = this.industrialAnalytics.firstDivergence({ pressKey, event: bounded.event, observations: eventObservations, cadenceMinutes }); const alignment = this.industrialAnalytics.radiusTelemetryAlignment({ pressKey, event: bounded.event, observations: local, cadenceMinutes }); if (first) local.push(first); if (alignment) local.push(alignment)
      const temporalPrograms: TemporalEvidenceProgram[] = []; const temporalProgramBegan = Date.now()
      if (detailLevel !== 'fleet_summary' && (detailLevel === 'fleet' || episodeIndex < 2)) {
        const familyReason = (family: IndustrialAnalyticalObservation['family']): RelatedSignalReasonCode | null => family === 'robust_numeric_change' ? 'DELTA_NEAR_EVENT' : family === 'normal_envelope_departure' ? 'CONTEXTUAL_DEVIATION' : family === 'deviation_persistence' ? 'PERSISTENT_DEPARTURE' : family === 'value_state_transition' ? 'VALUE_TRANSITION' : family === 'first_divergence' ? 'FIRST_DIVERGENCE' : family === 'numeric_relationship' ? 'QUALIFIED_RELATIONSHIP' : null
        const suggestions = rankRelatedSignals(programInputs.map((item) => { const supported = local.filter((observation) => observation.variableIds.includes(item.canonicalId) && observation.support.adequate && observation.material); return { canonicalId: item.canonicalId, deckNumber: item.deckNumber, friendlyName: item.friendlyName, signalType: item.signalType, category: item.category, scope: item.scope, reasonCodes: supported.flatMap((observation) => familyReason(observation.family) ?? []), timingDetail: null, observations: supported } }), null, TEMPORAL_PROGRAM_MODEL_SIGNAL_LIMIT)
        for (const suggestion of suggestions) {
          const item = programInputs.find((candidate) => candidate.canonicalId === suggestion.canonicalId && candidate.deckNumber === suggestion.deckNumber)!; const supported = local.filter((observation) => observation.variableIds.includes(item.canonicalId) && observation.support.adequate && observation.material); const selectedBecause = suggestion.reasonCodes
          const program = item.numeric ? buildNumericTemporalEvidenceProgram({ candidateId: pressKey, pressKey, eventId: focusEpisode.episodeId, canonicalId: item.canonicalId, unit: item.unit, range: bounded.range, event: bounded.event, samples: item.numeric, observations: supported, gaps: item.gaps, selectedBecause }) : item.states ? buildCategoricalTemporalEvidenceProgram({ candidateId: pressKey, pressKey, eventId: focusEpisode.episodeId, canonicalId: item.canonicalId, range: bounded.range, event: bounded.event, samples: item.states, gaps: item.gaps, selectedBecause }) : null
          if (program?.usable) temporalPrograms.push(program)
        }
        const radiusStates = focusEpisode.statusSegments.map((segment) => ({ atUtc: segment.startUtc, value: segment.statusDescription }))
        const radiusProgram = buildCategoricalTemporalEvidenceProgram({ candidateId: pressKey, pressKey, eventId: focusEpisode.episodeId, canonicalId: 'radius.sequence', datatype: 'radius', range: bounded.range, event: bounded.event, samples: radiusStates, selectedBecause: ['candidate Radius sequence and recovery context'] })
        if (radiusProgram) temporalPrograms.unshift(radiusProgram)
        const contextStates = contextEpisodes.filter((episode) => Date.parse(episode.startUtc) < Date.parse(bounded.range.end) && Date.parse(episode.endUtc) > Date.parse(bounded.range.start)).map((episode) => ({ atUtc: new Date(Math.max(Date.parse(episode.startUtc), Date.parse(bounded.range.start))).toISOString(), value: episode.identity.summary }))
        const contextProgram = buildCategoricalTemporalEvidenceProgram({ candidateId: pressKey, pressKey, eventId: focusEpisode.episodeId, canonicalId: 'production.context.identity', datatype: 'production_context', range: bounded.range, event: bounded.event, samples: contextStates, selectedBecause: ['strongest usable per-press production context'] })
        if (contextProgram?.usable) temporalPrograms.splice(Math.min(1, temporalPrograms.length), 0, contextProgram)
      }
      const seriesDiagnostics = [
        ...(speedResult.status === 'fulfilled' ? [speedResult.value.actual, ...(speedResult.value.setpoint ? [speedResult.value.setpoint] : [])].map((signal) => ({ canonicalId: signal.canonicalId, deckNumber: null, friendlyName: signal.canonicalId, exactTrustedSourceIdentity: signal.rawSignalId, dataType: 'numeric', representation: 'samples', requestedPointCount: null, returnedPointCount: signal.samples.length, usablePointCount: industrialNumericSamples(signal.samples).length, coveragePercent: telemetryPointCoverage(signal.samples, bounded.range), detectorsApplied: ['numeric_delta', 'robust_change', 'event_alignment', 'context_derived_normal_envelope', 'persistence', ...(signal.canonicalId === 'machine.speed.actual' ? ['speed_recovery'] : [])] })) : []),
        ...(selectedResult.status === 'fulfilled' && selectedResult.value ? selectedTelemetry.flatMap((selected) => { const signal = selectedResult.value!.signals.find((item) => item.canonicalId === selected.canonicalId && item.deckNumber === (selected.deckNumber ?? null)); if (!signal) return []; const points = selected.signalType === 'continuous' ? signal.samples : [...(signal.seed ? [signal.seed] : []), ...signal.changes]; const usable = selected.signalType === 'continuous' ? industrialNumericSamples(signal.samples).length : points.filter((item) => !/BAD|INVALID|UNAVAILABLE|NO_DATA|NODATA/i.test(item.qualityState)).length; return [{ canonicalId: selected.canonicalId, deckNumber: selected.deckNumber ?? null, friendlyName: selected.friendlyName, exactTrustedSourceIdentity: signal.rawSignalId ?? signal.sourceSelector, dataType: signal.valueKind ?? selected.signalType, representation: selected.representation, requestedPointCount: null, returnedPointCount: points.length, usablePointCount: usable, coveragePercent: telemetryPointCoverage(points, bounded.range), detectorsApplied: selected.signalType === 'continuous' ? ['numeric_delta', 'robust_change', 'event_alignment', 'context_derived_normal_envelope', 'persistence', 'relationship'] : ['value_change'] }] }) : []),
      ]
      const readMetrics = selectedResult.status === 'fulfilled' && selectedResult.value ? selectedResult.value.readDiagnostics : undefined
      return { observations: local, temporalPrograms, diagnostic: { eventId: focusEpisode.episodeId, requestedRange: bounded.range, queryRuntimeMs: Date.now() - queryBegan, speedFetchMs, semanticFetchMs, localAnalyticsMs: Date.now() - localAnalyticsBegan, temporalProgramConstructionMs: Date.now() - temporalProgramBegan, telemetrySeries: seriesDiagnostics, detectorRawOccurrenceCount: local.reduce((sum, item) => sum + Number(item.metrics.deltaEventCount ?? item.metrics.transitionCount ?? item.metrics.recurrenceCount ?? 0), 0), detectorRetainedOccurrenceCount: local.filter((item) => item.support.adequate && item.material).length, boundedRead: readMetrics ?? null, temporalProgramsCreated: temporalPrograms.length } }
      })()
      telemetryResults.push(telemetryResult)
    }
    const eventWindowsMs = Date.now() - eventWindowsBegan
    observations.push(...telemetryResults.flatMap((item) => item.observations))
    const retentionPriority: Partial<Record<IndustrialAnalyticalObservation['family'], number>> = { first_divergence: 8, contextual_baseline: 7, deviation_persistence: 6, normal_envelope_departure: 5, radius_telemetry_alignment: 4, speed_recovery: 3, radius_sequence_deviation: 2 }
    const retainedObservations = observations.filter((observation) => observation.support.adequate && observation.material).sort((left, right) => (retentionPriority[right.family] ?? 1) - (retentionPriority[left.family] ?? 1) || Math.max(0, ...Object.values(right.magnitudeInputs).filter((item): item is number => typeof item === 'number').map(Math.abs)) - Math.max(0, ...Object.values(left.magnitudeInputs).filter((item): item is number => typeof item === 'number').map(Math.abs))).slice(0, 8)
    // Keep the rich calculation set internally, but return only the evidence cardinality the downstream fleet candidate contract can use.
    const returnedObservations = retainedObservations.slice(0, detailLevel === 'selected' ? 8 : detailLevel === 'fleet' ? 3 : 1)
    const contextualIds = new Set(contextualFacts.map((item) => item.factId)); const analyticsFacts = returnedObservations.flatMap((observation) => observation.family === 'contextual_baseline' ? contextualFacts.filter((item) => observation.factIds.includes(item.factId)) : createIndustrialObservationFacts(observation, data.press.displayName)).filter((item, index, all) => !contextualIds.has(item.factId) || all.findIndex((candidate) => candidate.factId === item.factId) === index)
    const usedDimensions = [...new Set(detailedEpisodes.flatMap((episode) => contextFor(episode)?.identity.dimensionNames ?? []))]; const unavailable = contextCapabilities.filter((item) => !item.usable).map((item) => `${item.field[0]!.toUpperCase()}${item.field.slice(1)}`)
    const contextLimitation = usedDimensions.length && unavailable.length ? `${data.press.displayName} did not expose usable trusted ${unavailable.join(', ')} context in this range; ${usedDimensions.map((field) => `${field[0]!.toUpperCase()}${field.slice(1)}`).join(' + ')} formed the production context.` : null
    const eventReadDiagnostics = telemetryResults.flatMap((item) => { const value = item.diagnostic.boundedRead; return value && typeof value === 'object' ? [value as BoundedTelemetryReadDiagnostics] : [] })
    const allReadDiagnostics = [...(contextResult.status === 'fulfilled' && contextResult.value.readDiagnostics ? [contextResult.value.readDiagnostics] : []), ...baselineReadDiagnostics, ...(contextualFeatureHistory?.readDiagnostics ? [contextualFeatureHistory.readDiagnostics] : []), ...eventReadDiagnostics]
    const semanticRequests = allReadDiagnostics.reduce((sum, item) => sum + item.telemetryRequests, 0)
    const queryCount = 2 + baselineRadiusQueries + detailedEpisodes.length + semanticRequests; const retainedIds = new Set(returnedObservations.map((item) => item.observationId)); const windowDiagnostics = telemetryResults.map(({ diagnostic, observations: local }) => { const visible = local.filter((item) => retainedIds.has(item.observationId)); const bytes = Buffer.byteLength(JSON.stringify(visible), 'utf8'); return { ...diagnostic, detectorRetainedOccurrenceCount: visible.length, modelVisiblePayloadBytes: bytes, approximateTokenContribution: Math.ceil(bytes / 4) } })
    const temporalProgramLimit = detailLevel === 'selected' ? 6 : detailLevel === 'fleet' ? 4 : 0
    const temporalEvidencePrograms: TemporalEvidenceProgram[] = []
    const maximumProgramsPerWindow = Math.max(0, ...telemetryResults.map((item) => item.temporalPrograms.length))
    for (let programIndex = 0; programIndex < maximumProgramsPerWindow && temporalEvidencePrograms.length < temporalProgramLimit; programIndex += 1) {
      for (const item of telemetryResults) {
        const program = item.temporalPrograms[programIndex]
        if (program) temporalEvidencePrograms.push(program)
        if (temporalEvidencePrograms.length >= temporalProgramLimit) break
      }
    }
    return { press: data.press.displayName, pressKey, range: { start, end }, coveragePercent: summary.coveragePercent, productionInterruptions: summary.productionInterruptions, longestInterruptionMinutes: summary.longestInterruptionMinutes, events: episodes, topRadiusDrivers, productionContext, temporalEvidencePrograms, eventAnalytics: { eventWindowsAnalyzed: detailedEpisodes.length, telemetrySeriesScanned: selectedTelemetry.length + Number(actualSpeedSupported), telemetrySeriesSelected: new Set(temporalEvidencePrograms.filter((item) => item.datatype === 'numeric' || item.datatype === 'categorical').map((item) => item.canonicalId)).size, telemetrySeriesQueried: (selectedTelemetry.length + Number(actualSpeedSupported)) * detailedEpisodes.length, tracesCreated: temporalEvidencePrograms.length }, industrialAnalytics: { calculatedCount: observations.length, internallyRetainedCount: retainedObservations.length, retainedCount: returnedObservations.length, excludedCount: observations.length - retainedObservations.length, observations: returnedObservations }, validationDiagnostics: { windows: windowDiagnostics, baselines: baselineDiagnostics, relationships: observations.filter((item) => item.family === 'numeric_relationship').map((item) => ({ variables: item.variableIds, basis: item.metrics.basis, scope: item.metrics.scope, alignedPairCount: item.metrics.alignedPairCount, pairCoveragePercent: item.metrics.pairCoveragePercent, temporalCoveragePercent: item.metrics.temporalCoveragePercent, pearson: item.metrics.pearson, spearman: item.metrics.spearman, lagMinutes: item.metrics.bestLagMinutes, qualification: item.metrics.qualification, modelVisible: retainedIds.has(item.observationId) })), boundedTelemetry: { telemetryRequests: semanticRequests, chunkCount: allReadDiagnostics.reduce((sum, item) => sum + item.chunkCount, 0), cacheHits: allReadDiagnostics.reduce((sum, item) => sum + item.cacheHits, 0), exactCacheHits: allReadDiagnostics.reduce((sum, item) => sum + (item.exactCacheHits ?? 0), 0), selectorSubsetCacheHits: allReadDiagnostics.reduce((sum, item) => sum + (item.selectorSubsetCacheHits ?? 0), 0), containedRangeCacheHits: allReadDiagnostics.reduce((sum, item) => sum + (item.containedRangeCacheHits ?? 0), 0), containedRangeSelectorSubsetCacheHits: allReadDiagnostics.reduce((sum, item) => sum + (item.containedRangeSelectorSubsetCacheHits ?? 0), 0), pointsReturned: allReadDiagnostics.reduce((sum, item) => sum + item.pointsReturned, 0), pointsRetained: allReadDiagnostics.reduce((sum, item) => sum + item.pointsRetained, 0), requests: allReadDiagnostics.flatMap((item) => item.requests ?? []) }, runtimeBreakdown: { radiusFetchMs, capabilitiesFetchMs, currentContextFetchMs, baselineSearchMs, contextualFeatureFetchMs, eventWindowsMs, eventWindowQueryMsSum: telemetryResults.reduce((sum, item) => sum + Number(item.diagnostic.queryRuntimeMs ?? 0), 0), totalToolMs: Date.now() - pressEventsBegan }, speedRecovery: { calculated: observations.filter((item) => item.family === 'speed_recovery').length, retained: returnedObservations.filter((item) => item.family === 'speed_recovery').length, unavailableWindows: speedUnavailableCount, explanation: observations.some((item) => item.family === 'speed_recovery') ? 'Speed recovery was calculated where before, during, and after samples were available; only material recoveries are retained.' : speedUnavailableCount ? 'Trusted Actual Speed was unavailable in one or more windows.' : 'No window had qualifying before, during, and after speed samples.' }, rawTelemetryScans: 0 }, queryCount, facts: [...summaryFacts(pressKey, data.press.displayName, summary, 'current', { start, end }).filter((item) => item.metric !== 'productionPercent'), ...driverFacts(pressKey, data.press.displayName, topRadiusDrivers, 'event', { start, end }), ...eventFacts, ...contextFacts, ...analyticsFacts], limitations: [...(contextLimitation ? [contextLimitation] : []), ...(contextResult.status === 'rejected' ? ['Trusted production context was temporarily unavailable; Radius evidence remains valid.'] : []), ...(baselineDiagnostics.some((item) => item.result === 'INSUFFICIENT_CONTEXTUAL_HISTORY') ? [`INSUFFICIENT_CONTEXTUAL_HISTORY: bounded same-press search found at most N=${Math.max(0, ...baselineDiagnostics.map((item) => item.finalN))}; N>=3 is required.`] : []), ...(speedUnavailableCount ? [`Trusted Actual Speed was unavailable for ${speedUnavailableCount} bounded event window${speedUnavailableCount === 1 ? '' : 's'}.`] : []), ...(telemetryUnavailableCount ? [`Selected trusted telemetry was unavailable for ${telemetryUnavailableCount} bounded event window${telemetryUnavailableCount === 1 ? '' : 's'}.`] : []), `Industrial analytics examined ${detailedEpisodes.length} bounded Radius event window${detailedEpisodes.length === 1 ? '' : 's'} and at most ${selectedTelemetry.length + Number(actualSpeedSupported)} trusted canonical telemetry series per window; no raw-tag scan was performed.`] }
  }

  private async eventContext(args: Record<string, unknown>, context: AiToolExecutionContext): Promise<AiToolResult> {
    if (!exactKeys(args, ['press', 'timestamp', 'beforeMinutes', 'afterMinutes'])) throw new Error('invalid_ai_tool_arguments')
    const pressKey = press(args.press); const timestamp = utc(args.timestamp); const beforeMinutes = integer(args.beforeMinutes, 1, MAX_EVENT_CONTEXT_MINUTES); const afterMinutes = integer(args.afterMinutes, 1, MAX_EVENT_CONTEXT_MINUTES)
    const fromUtc = new Date(Date.parse(timestamp) - beforeMinutes * 60_000).toISOString(); const toUtc = new Date(Date.parse(timestamp) + afterMinutes * 60_000).toISOString()
    if (!this.radius.getRawTimeline) throw new Error('radius_timeline_unavailable')
    const [radiusResult, productionResult, speedResult] = await Promise.allSettled([this.radius.getRawTimeline(pressKey, fromUtc, toUtc), this.telemetry.context(pressKey, fromUtc, toUtc, context.requestId, context.signal), this.telemetry.speed(pressKey, fromUtc, toUtc, context.requestId, context.signal)])
    if (radiusResult.status === 'rejected') throw radiusResult.reason
    const timeline = radiusResult.value; const offlineSeconds = timeline.segments.filter((segment) => segment.kind === 'offline').reduce((sum, segment) => sum + segment.durationSeconds, 0)
    const segments = timeline.segments.slice(0, 30).map((segment) => segment.kind === 'offline' ? { startUtc: segment.startUtc, endUtc: segment.endUtc, unavailable: true as const } : { startUtc: segment.startUtc, endUtc: segment.endUtc, unavailable: false as const, eventType: segment.eventType, statusCode: segment.statusCode, statusDescription: segment.statusDescription })
    const actualSpeed = speedResult.status === 'fulfilled' ? { available: true as const, unit: speedResult.value.actual.sourceUnit, ...speedSummary(speedResult.value.actual.samples) } : { available: false as const, observationCount: 0 }
    const atEvent = productionResult.status === 'fulfilled' ? contextAt(productionResult.value, timestamp) : {}
    const productionChanges = productionResult.status === 'fulfilled' ? productionResult.value.changes.filter((change) => PRODUCTION_CONTEXT_IDENTITY_FIELDS.includes(change.field as ProductionContextIdentityField)).slice(0, 20).map((change) => { const previous = sanitizeProductionContextIdentity(displayValue(change.previousValue)); const current = sanitizeProductionContextIdentity(displayValue(change.value)); return { atUtc: change.atUtc, field: change.field, previousValue: previous.value, value: current.value, usable: current.usable } }) : []
    const radiusFacts = segments.flatMap((segment, index) => segment.unavailable ? [] : [fact(pressKey, timeline.displayName, 'radius', 'radiusStateTimestamp', segment.startUtc, 'iso8601', 'event', `${segment.eventType} / ${segment.statusCode ?? '—'} / ${segment.statusDescription}`, `radius_segment.${identity(`${segment.startUtc}\u0000${segment.endUtc}`)}.timestamp`, { timestamp: segment.startUtc, range: { start: segment.startUtc, end: segment.endUtc } }), fact(pressKey, timeline.displayName, 'radius', 'radiusStateDurationMinutes', round((Date.parse(segment.endUtc) - Date.parse(segment.startUtc)) / 60_000), 'minutes', 'event', `${segment.statusDescription} duration`, `radius_segment.${identity(`${segment.startUtc}\u0000${segment.endUtc}`)}.duration_minutes`, { range: { start: segment.startUtc, end: segment.endUtc } })])
    const contextKey = identity(`${fromUtc}\u0000${toUtc}`)
    const speedFacts: AiGroundingFact[] = actualSpeed.available ? [
      fact(pressKey, timeline.displayName, 'telemetry', 'actualSpeedMinimum', actualSpeed.minimum, actualSpeed.unit, 'event', 'Actual Speed minimum', `telemetry.actual_speed.${contextKey}.minimum.event`, { range: { start: fromUtc, end: toUtc } }),
      fact(pressKey, timeline.displayName, 'telemetry', 'actualSpeedMaximum', actualSpeed.maximum, actualSpeed.unit, 'event', 'Actual Speed maximum', `telemetry.actual_speed.${contextKey}.maximum.event`, { range: { start: fromUtc, end: toUtc } }),
      fact(pressKey, timeline.displayName, 'telemetry', 'actualSpeedAverage', actualSpeed.average, actualSpeed.unit, 'event', 'Actual Speed average', `telemetry.actual_speed.${contextKey}.average.event`, { range: { start: fromUtc, end: toUtc } }),
      fact(pressKey, timeline.displayName, 'telemetry', 'actualSpeedLatest', actualSpeed.latest, actualSpeed.unit, 'event', 'Actual Speed latest', `telemetry.actual_speed.${contextKey}.latest.event`, { ...(actualSpeed.latestAtUtc ? { timestamp: actualSpeed.latestAtUtc } : {}), range: { start: fromUtc, end: toUtc } }),
    ] : []
    const contextFacts: AiGroundingFact[] = Object.entries(atEvent).filter(([field]) => PRODUCTION_CONTEXT_IDENTITY_FIELDS.includes(field as ProductionContextIdentityField)).map(([field, raw]) => {
      const item = raw as { value: string | number | boolean | null; usable: boolean; observedAtUtc: string | null }
      const result = fact(pressKey, timeline.displayName, 'production_context', field, item.value, null, 'event', `${field[0].toUpperCase()}${field.slice(1)}`, `context.${field}.${contextKey}.at_event`, { ...(item.observedAtUtc ? { timestamp: item.observedAtUtc } : {}), range: { start: fromUtc, end: toUtc } })
      return { ...result, usable: item.usable }
    })
    return {
      press: timeline.displayName, pressKey, timestamp, range: { start: fromUtc, end: toUtc }, queryCount: 3,
      radius: { coveragePercent: round(100 - offlineSeconds / ((Date.parse(toUtc) - Date.parse(fromUtc)) / 1_000) * 100), segments },
      actualSpeed,
      productionContext: productionResult.status === 'fulfilled' ? { available: true, atEvent, changes: productionChanges } : { available: false, atEvent: {}, changes: [] },
      facts: [...radiusFacts, ...speedFacts, ...contextFacts],
      limitations: [...(speedResult.status === 'rejected' ? ['Actual Speed was unavailable for this window.'] : []), ...(productionResult.status === 'rejected' ? ['Trusted production context was unavailable for this window.'] : []), ...(timeline.segments.length > 30 ? ['Radius segments were bounded to the first 30 records in the requested context window.'] : [])],
    }
  }
}
