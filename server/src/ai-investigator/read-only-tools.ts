import { createHash } from 'node:crypto'
import type { RadiusService } from '../radius/radius-service.js'
import { RADIUS_PRESS_KEYS, type RadiusPressKey, type RadiusStatusSegment } from '../radius/models.js'
import type { TelemetryFoundationService } from '../telemetry/telemetry-foundation-service.js'
import type { ProductionContextChange, ProductionContextEvidence, TelemetrySample, TelemetryScalarValue } from '../telemetry/telemetry-contracts.js'
import { IndustrialAnalyticsService } from '../industrial-analytics/industrial-analytics-service.js'
import type { IndustrialAnalyticalObservation, IndustrialNumericSample, IndustrialStateSample } from '../industrial-analytics/contracts.js'
import { AI_INVESTIGATOR_MAX_RANGE_MS, type AiEvidenceSource, type AiGroundingFact } from './contracts.js'

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
}

export type AiToolResult = Record<string, unknown>
export interface AiInvestigatorToolExecutor {
  readonly definitions: AiInvestigatorToolDefinition[]
  execute(name: string, rawArguments: unknown, context: AiToolExecutionContext): Promise<AiToolResult>
}
const MAX_TOOL_PAYLOAD_BYTES = 64 * 1024
const MAX_EVENT_CONTEXT_MINUTES = 60
const MAX_EVENT_SUMMARY_RANGE_MS = 24 * 60 * 60_000
const TELEMETRY_SLICE_MS = 2 * 60 * 60_000

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
    parameters: { type: 'object', additionalProperties: false, required: ['press', 'start', 'end', 'topN'], properties: { press: { type: 'string', enum: RADIUS_PRESS_KEYS }, start: UTC_SCHEMA, end: UTC_SCHEMA, topN: { type: 'integer', minimum: 1, maximum: 10 } } },
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
  if (value === null || value === undefined) return { value: null, usable: false }
  if (Array.isArray(value)) {
    if (value.length === 0 || value.every((item) => item === 0 || item === '0' || item === null)) return { value: null, usable: false }
    return { value: JSON.stringify(value), usable: true }
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed || /^(?:null|undefined|n\/a|na|none|unknown|not set|unset)$/i.test(trimmed)) return { value: null, usable: false }
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        const parsed = JSON.parse(trimmed) as unknown
        if (Array.isArray(parsed) && (parsed.length === 0 || parsed.every((item) => item === 0 || item === '0' || item === null))) return { value: null, usable: false }
      } catch { /* retain non-JSON identity strings */ }
    }
    return { value: trimmed, usable: true }
  }
  if (typeof value === 'number') return { value: round(value, 2), usable: Number.isFinite(value) }
  if (typeof value === 'boolean') return { value, usable: true }
  return { value: null, usable: false }
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
  return drivers.map((driver) => {
    const key = identity(`${driver.eventType}\u0000${driver.statusCode ?? ''}\u0000${driver.statusDescription}`)
    return fact(pressKey, pressName, 'radius', 'radiusDriverDurationMinutes', driver.durationMinutes, 'minutes', role, `${driver.eventType} / ${driver.statusCode ?? '—'} / ${driver.statusDescription}`, `radius_driver.${key}.duration_minutes.${role}`, { range: rangeValue })
  })
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

const INDUSTRIAL_METRIC_LABELS: Record<string, string> = {
  median: 'Median', startEndDelta: 'Start-to-end change', largestDelta: 'Largest adjacent change', standardDeviation: 'Standard deviation',
  beforeMedian: 'Before-event median', eventMedian: 'Event median', afterMedian: 'After-event median', beforeToEventDelta: 'Before-to-event change',
  transitionCount: 'State transitions', transitionsNearEvent: 'Transitions near event', stateBefore: 'State before', stateAfter: 'State after',
  commonSequenceCount: 'Common Radius sequence support', commonSequenceSharePercent: 'Common Radius sequence share', extraStepCount: 'Extra Radius steps', loopCount: 'Looped Radius steps',
  pearson: 'Pearson correlation', spearman: 'Spearman correlation', bestLagMinutes: 'Strongest lag', bestLagCorrelation: 'Lagged correlation', direction: 'Lag direction',
}

const INDUSTRIAL_FACT_METRICS: Record<IndustrialAnalyticalObservation['family'], string[]> = {
  baseline_deviation: ['current', 'baseline', 'delta'],
  robust_numeric_change: ['median', 'startEndDelta', 'largestDelta', 'standardDeviation'],
  event_aligned_change: ['beforeMedian', 'eventMedian', 'afterMedian', 'beforeToEventDelta'],
  value_state_transition: ['transitionCount', 'transitionsNearEvent', 'stateBefore', 'stateAfter'],
  radius_sequence_deviation: ['commonSequenceCount', 'commonSequenceSharePercent', 'extraStepCount', 'loopCount'],
  numeric_relationship: ['pearson', 'spearman', 'bestLagMinutes', 'bestLagCorrelation'],
  cross_press_comparison: ['pressMedian', 'compatiblePressMedian', 'delta'],
}

function industrialFacts(observation: IndustrialAnalyticalObservation, pressName: string): AiGroundingFact[] {
  const unit = typeof observation.metrics.unit === 'string' ? observation.metrics.unit : null
  const units: Record<string, string | null> = { transitionCount: 'count', transitionsNearEvent: 'count', commonSequenceCount: 'episodes', commonSequenceSharePercent: 'percent', extraStepCount: 'count', loopCount: 'count', bestLagMinutes: 'minutes', pearson: 'coefficient', spearman: 'coefficient', bestLagCorrelation: 'coefficient' }
  const result = INDUSTRIAL_FACT_METRICS[observation.family].flatMap((metric) => {
    const value = observation.metrics[metric]
    if (value === null || value === undefined || value === '') return []
    return [fact(observation.pressKey, pressName, observation.evidenceSource, `industrial.${observation.family}.${metric}`, value, units[metric] ?? unit, 'event', INDUSTRIAL_METRIC_LABELS[metric] ?? metric, `${observation.observationId}.${metric}.event`, { range: observation.range })]
  })
  observation.factIds = result.map(({ factId }) => factId)
  return result
}

function safePayload(result: AiToolResult): AiToolResult {
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_TOOL_PAYLOAD_BYTES) throw new Error('ai_tool_payload_too_large')
  return result
}

export class AiInvestigatorReadOnlyToolRegistry implements AiInvestigatorToolExecutor {
  readonly definitions = AI_INVESTIGATOR_TOOL_DEFINITIONS
  private readonly industrialAnalytics = new IndustrialAnalyticsService()

  constructor(private readonly radius: RadiusService, private readonly telemetry: TelemetryFoundationService) {}

  private async productionContextChanges(pressKey: RadiusPressKey, start: string, end: string, context: AiToolExecutionContext): Promise<ProductionContextChange[]> {
    const slices: Array<{ fromUtc: string; toUtc: string }> = []
    for (let cursor = Date.parse(start); cursor < Date.parse(end); cursor += TELEMETRY_SLICE_MS) slices.push({ fromUtc: new Date(cursor).toISOString(), toUtc: new Date(Math.min(Date.parse(end), cursor + TELEMETRY_SLICE_MS)).toISOString() })
    const responses: ProductionContextEvidence[] = []
    for (let offset = 0; offset < slices.length; offset += 3) responses.push(...await Promise.all(slices.slice(offset, offset + 3).map((slice) => this.telemetry.context(pressKey, slice.fromUtc, slice.toUtc, context.requestId, context.signal))))
    const unique = new Map<string, ProductionContextChange>()
    for (const change of responses.flatMap((response) => response.changes)) unique.set(`${change.atUtc}\u0000${change.field}\u0000${String(change.value)}`, change)
    return [...unique.values()].sort((left, right) => Date.parse(left.atUtc) - Date.parse(right.atUtc) || left.field.localeCompare(right.field))
  }

  async execute(name: string, rawArguments: unknown, context: AiToolExecutionContext): Promise<AiToolResult> {
    if (!AI_INVESTIGATOR_TOOL_NAMES.includes(name as AiInvestigatorToolName)) throw new Error('unknown_ai_investigator_tool')
    if (!isRecord(rawArguments)) throw new Error('invalid_ai_tool_arguments')
    let result: AiToolResult
    if (name === 'get_fleet_operational_summary') result = await this.fleetSummary(rawArguments)
    else if (name === 'compare_press_period') result = await this.comparePeriod(rawArguments)
    else if (name === 'get_press_event_summary') result = await this.pressEvents(rawArguments, context)
    else result = await this.eventContext(rawArguments, context)
    return safePayload(result)
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
    if (!exactKeys(args, ['press', 'start', 'end', 'topN'])) throw new Error('invalid_ai_tool_arguments')
    const pressKey = press(args.press); const { start, end } = range(args.start, args.end); const topN = integer(args.topN, 1, 10)
    if (Date.parse(end) - Date.parse(start) > MAX_EVENT_SUMMARY_RANGE_MS) throw new Error('invalid_ai_tool_range')
    const [radiusResult] = await Promise.allSettled([this.radius.getPressEpisodes(pressKey, start, end)])
    if (radiusResult.status === 'rejected') throw radiusResult.reason
    const data = radiusResult.value
    const orderedEpisodes = data.episodes.slice().sort((left, right) => right.durationSeconds - left.durationSeconds)
    const focusEpisode = orderedEpisodes[0]
    const focusEndMs = focusEpisode ? Math.min(Date.parse(focusEpisode.endUtc ?? end), Date.parse(focusEpisode.startUtc) + 20 * 60_000) : null
    const focusEvent = focusEpisode && focusEndMs !== null ? { id: focusEpisode.episodeId, start: focusEpisode.startUtc, end: new Date(focusEndMs).toISOString() } : null
    const telemetryRange = focusEvent && focusEndMs !== null ? { start: new Date(Math.max(Date.parse(start), Date.parse(focusEvent.start) - 20 * 60_000)).toISOString(), end: new Date(Math.min(Date.parse(end), focusEndMs + 20 * 60_000)).toISOString() } : null
    const contextResult: PromiseSettledResult<ProductionContextChange[]> = telemetryRange
      ? (await Promise.allSettled([this.productionContextChanges(pressKey, telemetryRange.start, telemetryRange.end, context)]))[0]!
      : { status: 'fulfilled', value: [] }
    const episodes = orderedEpisodes.slice(0, topN).map((episode) => ({ episodeId: episode.episodeId, startUtc: episode.startUtc, endUtc: episode.endUtc, durationMinutes: round(episode.durationSeconds / 60), completionStatus: episode.completionStatus, dataInterrupted: episode.dataInterrupted, primaryRadiusState: episode.primaryStatusDescription, returnAttempts: episode.returnToProductionAttemptCount, failedReturnAttempts: episode.failedReturnToProductionAttempts }))
    const contextChanges = contextResult.status === 'fulfilled' ? contextResult.value.filter((change) => ['job', 'order', 'recipe'].includes(change.field)).slice(0, 30).map((change) => ({ atUtc: change.atUtc, field: change.field, previous: sanitizeProductionContextIdentity(displayValue(change.previousValue)), current: sanitizeProductionContextIdentity(displayValue(change.value)) })) : []
    const productionContext = contextResult.status === 'fulfilled' ? { available: true, changes: contextChanges.map((change) => ({ atUtc: change.atUtc, field: change.field, previousValue: change.previous.value, value: change.current.value, usable: change.current.usable })) } : { available: false, changes: [] }
    const topRadiusDrivers = data.operationalAnalytics.statusDrivers.slice().sort((left, right) => right.durationSeconds - left.durationSeconds).slice(0, topN).map((item) => ({ eventType: item.eventType, statusCode: item.statusCode, statusDescription: item.statusDescription, durationMinutes: round(item.durationSeconds / 60), occurrences: item.occurrenceCount }))
    const eventFacts = episodes.flatMap((episode, index) => {
      const eventEnd = episode.endUtc ?? end
      return [
        fact(pressKey, data.press.displayName, 'radius', 'eventTimestamp', episode.startUtc, 'iso8601', 'event', `Interruption ${index + 1}`, `event.${identity(`${episode.startUtc}\u0000${eventEnd}`)}.timestamp`, { timestamp: episode.startUtc, range: { start: episode.startUtc, end: eventEnd } }),
        fact(pressKey, data.press.displayName, 'radius', 'eventDurationMinutes', episode.durationMinutes, 'minutes', 'event', `Interruption ${index + 1} duration`, `event.${identity(`${episode.startUtc}\u0000${eventEnd}`)}.duration_minutes`, { range: { start: episode.startUtc, end: eventEnd } }),
      ]
    })
    const contextFacts = contextChanges.map((change) => fact(pressKey, data.press.displayName, 'production_context', change.field, change.current.value, null, 'event', `${change.field[0].toUpperCase()}${change.field.slice(1)}`, `context.${change.field}.${identity(change.atUtc)}.event`, { timestamp: change.atUtc, range: { start, end } })).map((item, index) => ({ ...item, usable: contextChanges[index].current.usable }))
    const summary = { coveragePercent: round(data.summary.dataCoveragePercent), productionPercent: null, productionInterruptions: data.summary.episodeCount, longestInterruptionMinutes: round(data.summary.longestEpisodeSeconds / 60) }
    const observations: IndustrialAnalyticalObservation[] = []
    let speedUnavailable = false
    if (focusEpisode && focusEvent && telemetryRange) {
      try {
        const speed = await this.telemetry.speed(pressKey, telemetryRange.start, telemetryRange.end, context.requestId, context.signal)
        const actual = industrialNumericSamples(speed.actual.samples)
        const robust = this.industrialAnalytics.robustNumericChange({ pressKey, variableId: speed.actual.canonicalId, unit: speed.actual.sourceUnit, range: telemetryRange, samples: actual, eventId: focusEpisode.episodeId })
        const aligned = this.industrialAnalytics.eventAlignedNumeric({ pressKey, variableId: speed.actual.canonicalId, unit: speed.actual.sourceUnit, range: telemetryRange, samples: actual, event: focusEvent })
        if (robust) observations.push(robust)
        if (aligned) observations.push(aligned)
        if (speed.setpoint) {
          const relationship = this.industrialAnalytics.relationshipObservation({ pressKey, leftVariableId: speed.setpoint.canonicalId, rightVariableId: speed.actual.canonicalId, range: telemetryRange, left: industrialNumericSamples(speed.setpoint.samples), right: actual, context: `Radius episode ${focusEpisode.episodeId}` })
          if (relationship) observations.push(relationship)
        }
      } catch {
        speedUnavailable = true
      }
      observations.push(this.industrialAnalytics.sequenceDeviation({
        pressKey,
        range: { start, end },
        occurrence: { episodeId: focusEpisode.episodeId, startUtc: focusEpisode.startUtc, endUtc: focusEpisode.endUtc ?? end, orderedStates: focusEpisode.statusSegments.map((segment) => ({ state: segment.statusDescription, durationSeconds: segment.durationSeconds })), returnAttempts: focusEpisode.returnToProductionAttemptCount },
        comparable: data.episodes.map((episode) => ({ episodeId: episode.episodeId, startUtc: episode.startUtc, endUtc: episode.endUtc ?? end, orderedStates: episode.statusSegments.map((segment) => ({ state: segment.statusDescription, durationSeconds: segment.durationSeconds })), returnAttempts: episode.returnToProductionAttemptCount })),
      }))
      if (contextResult.status === 'fulfilled') {
        for (const field of ['job', 'order', 'recipe']) {
          const changes = contextChanges.filter((change) => change.field === field && change.current.usable)
          if (!changes.length) continue
          const stateSamples: IndustrialStateSample[] = []
          if (changes[0]!.previous.usable && changes[0]!.previous.value !== null) stateSamples.push({ atUtc: start, value: changes[0]!.previous.value })
          stateSamples.push(...changes.map((change) => ({ atUtc: change.atUtc, value: change.current.value! })))
          observations.push(this.industrialAnalytics.valueTransitions({ pressKey, variableId: `production.${field}`, range: { start, end }, samples: stateSamples, event: focusEvent }))
        }
      }
    }
    const retainedObservations = observations.filter((observation) => observation.support.adequate && observation.material)
    const analyticsFacts = retainedObservations.flatMap((observation) => industrialFacts(observation, data.press.displayName))
    return { press: data.press.displayName, pressKey, range: { start, end }, coveragePercent: summary.coveragePercent, productionInterruptions: summary.productionInterruptions, longestInterruptionMinutes: summary.longestInterruptionMinutes, events: episodes, topRadiusDrivers, productionContext, industrialAnalytics: { calculatedCount: observations.length, retainedCount: retainedObservations.length, excludedCount: observations.length - retainedObservations.length, observations: retainedObservations }, queryCount: focusEpisode ? 3 : 1, facts: [...summaryFacts(pressKey, data.press.displayName, summary, 'current', { start, end }).filter((item) => item.metric !== 'productionPercent'), ...driverFacts(pressKey, data.press.displayName, topRadiusDrivers, 'event', { start, end }), ...eventFacts, ...contextFacts, ...analyticsFacts], limitations: [...(contextResult.status === 'rejected' ? ['Job/Order/Recipe context was unavailable; Radius evidence remains valid.'] : []), ...(speedUnavailable ? ['Trusted canonical speed evidence was unavailable for the bounded event window.'] : []), 'Industrial analytics is bounded to the strongest Radius event and trusted canonical speed/context signals; no broad tag scan is performed.'] }
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
    const productionChanges = productionResult.status === 'fulfilled' ? productionResult.value.changes.filter((change) => ['job', 'order', 'recipe'].includes(change.field)).slice(0, 20).map((change) => { const previous = sanitizeProductionContextIdentity(displayValue(change.previousValue)); const current = sanitizeProductionContextIdentity(displayValue(change.value)); return { atUtc: change.atUtc, field: change.field, previousValue: previous.value, value: current.value, usable: current.usable } }) : []
    const radiusFacts = segments.flatMap((segment, index) => segment.unavailable ? [] : [fact(pressKey, timeline.displayName, 'radius', 'radiusStateTimestamp', segment.startUtc, 'iso8601', 'event', `${segment.eventType} / ${segment.statusCode ?? '—'} / ${segment.statusDescription}`, `radius_segment.${identity(`${segment.startUtc}\u0000${segment.endUtc}`)}.timestamp`, { timestamp: segment.startUtc, range: { start: segment.startUtc, end: segment.endUtc } }), fact(pressKey, timeline.displayName, 'radius', 'radiusStateDurationMinutes', round((Date.parse(segment.endUtc) - Date.parse(segment.startUtc)) / 60_000), 'minutes', 'event', `${segment.statusDescription} duration`, `radius_segment.${identity(`${segment.startUtc}\u0000${segment.endUtc}`)}.duration_minutes`, { range: { start: segment.startUtc, end: segment.endUtc } })])
    const contextKey = identity(`${fromUtc}\u0000${toUtc}`)
    const speedFacts: AiGroundingFact[] = actualSpeed.available ? [
      fact(pressKey, timeline.displayName, 'telemetry', 'actualSpeedMinimum', actualSpeed.minimum, actualSpeed.unit, 'event', 'Actual Speed minimum', `telemetry.actual_speed.${contextKey}.minimum.event`, { range: { start: fromUtc, end: toUtc } }),
      fact(pressKey, timeline.displayName, 'telemetry', 'actualSpeedMaximum', actualSpeed.maximum, actualSpeed.unit, 'event', 'Actual Speed maximum', `telemetry.actual_speed.${contextKey}.maximum.event`, { range: { start: fromUtc, end: toUtc } }),
      fact(pressKey, timeline.displayName, 'telemetry', 'actualSpeedAverage', actualSpeed.average, actualSpeed.unit, 'event', 'Actual Speed average', `telemetry.actual_speed.${contextKey}.average.event`, { range: { start: fromUtc, end: toUtc } }),
      fact(pressKey, timeline.displayName, 'telemetry', 'actualSpeedLatest', actualSpeed.latest, actualSpeed.unit, 'event', 'Actual Speed latest', `telemetry.actual_speed.${contextKey}.latest.event`, { ...(actualSpeed.latestAtUtc ? { timestamp: actualSpeed.latestAtUtc } : {}), range: { start: fromUtc, end: toUtc } }),
    ] : []
    const contextFacts: AiGroundingFact[] = Object.entries(atEvent).filter(([field]) => ['job', 'order', 'recipe'].includes(field)).map(([field, raw]) => {
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
      limitations: [...(speedResult.status === 'rejected' ? ['Actual Speed was unavailable for this window.'] : []), ...(productionResult.status === 'rejected' ? ['Job/Order/Recipe context was unavailable for this window.'] : []), ...(timeline.segments.length > 30 ? ['Radius segments were bounded to the first 30 records in the requested context window.'] : [])],
    }
  }
}
