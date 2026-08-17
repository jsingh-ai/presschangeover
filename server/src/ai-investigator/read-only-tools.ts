import type { RadiusService } from '../radius/radius-service.js'
import { RADIUS_PRESS_KEYS, type RadiusPressKey, type RadiusStatusSegment } from '../radius/models.js'
import type { TelemetryFoundationService } from '../telemetry/telemetry-foundation-service.js'
import type { ProductionContextChange, ProductionContextEvidence, TelemetrySample, TelemetryScalarValue } from '../telemetry/telemetry-contracts.js'
import { AI_INVESTIGATOR_MAX_RANGE_MS } from './contracts.js'

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
const MAX_TOOL_PAYLOAD_BYTES = 64 * 1024
const MAX_EVENT_CONTEXT_MINUTES = 60
const MAX_EVENT_SUMMARY_RANGE_MS = 24 * 60 * 60_000
const TELEMETRY_SLICE_MS = 2 * 60 * 60_000

const PRESS_SCHEMA = { type: ['string', 'null'], enum: [...RADIUS_PRESS_KEYS, null] }
const UTC_SCHEMA = { type: 'string', description: 'UTC ISO-8601 timestamp ending in Z.' }

export const AI_INVESTIGATOR_TOOL_DEFINITIONS: AiInvestigatorToolDefinition[] = [
  {
    type: 'function', name: 'get_fleet_operational_summary', strict: true,
    description: 'Return compact deterministic Radius operational facts for the fleet or one press. Use this first to identify candidate presses.',
    parameters: { type: 'object', additionalProperties: false, required: ['start', 'end', 'press'], properties: { start: UTC_SCHEMA, end: UTC_SCHEMA, press: PRESS_SCHEMA } },
  },
  {
    type: 'function', name: 'compare_press_period', strict: true,
    description: 'Compare one press over a current period with one immediately comparable baseline period using deterministic Radius analytics.',
    parameters: { type: 'object', additionalProperties: false, required: ['press', 'currentStart', 'currentEnd', 'baselineStart', 'baselineEnd'], properties: { press: { type: 'string', enum: RADIUS_PRESS_KEYS }, currentStart: UTC_SCHEMA, currentEnd: UTC_SCHEMA, baselineStart: UTC_SCHEMA, baselineEnd: UTC_SCHEMA } },
  },
  {
    type: 'function', name: 'get_press_event_summary', strict: true,
    description: 'Return a bounded list of important operational episodes, long Radius states, and available Job/Order/Recipe changes for one press.',
    parameters: { type: 'object', additionalProperties: false, required: ['press', 'start', 'end', 'topN'], properties: { press: { type: 'string', enum: RADIUS_PRESS_KEYS }, start: UTC_SCHEMA, end: UTC_SCHEMA, topN: { type: 'integer', minimum: 1, maximum: 10 } } },
  },
  {
    type: 'function', name: 'get_event_context', strict: true,
    description: 'Return compact Radius, actual-speed, and Job/Order/Recipe context around one timestamp. The surrounding window is strictly bounded.',
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
    return [field, { value: sample ? displayValue(sample.value) : null, observedAtUtc: sample?.observedAtUtc ?? null, observationState: item.observationState }]
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

function safePayload(result: AiToolResult): AiToolResult {
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_TOOL_PAYLOAD_BYTES) throw new Error('ai_tool_payload_too_large')
  return result
}

export class AiInvestigatorReadOnlyToolRegistry {
  readonly definitions = AI_INVESTIGATOR_TOOL_DEFINITIONS

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
    return {
      range: { start, end }, scope: selectedPress ?? 'all', feedStatus: overview.feedStatus, lastObservationUtc: overview.lastObservationUtc,
      presses: presses.map((item) => ({
        press: item.displayName, pressKey: item.pressKey, coveragePercent: round(item.dataCoveragePercent), productionPercent: percent(item.runProductionSeconds, item.observedSeconds), productionMinutes: round(item.runProductionSeconds / 60), nonProductionMinutes: round(item.nonProductionSeconds / 60), unavailableMinutes: round(item.offlineSeconds / 60), productionInterruptions: item.episodeCount, longestInterruptionMinutes: round(item.longestEpisodeSeconds / 60), currentRadiusState: item.currentStatusDescription,
        leadingRadiusStates: compactRadiusStates(item.timelineSegments),
      })),
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
    return { press: currentData.displayName, pressKey, current: { range: current, ...currentSummary }, baseline: { range: baseline, ...baselineSummary }, differences: { productionPercentagePoints: currentSummary.productionPercent === null || baselineSummary.productionPercent === null ? null : round(currentSummary.productionPercent - baselineSummary.productionPercent), productionInterruptions: currentSummary.productionInterruptions - baselineSummary.productionInterruptions, longestInterruptionMinutes: currentSummary.longestInterruptionMinutes === null || baselineSummary.longestInterruptionMinutes === null ? null : round(currentSummary.longestInterruptionMinutes - baselineSummary.longestInterruptionMinutes) }, baselineSufficient: baselineData.dataCoveragePercent >= 80, limitations: ['Job counts are omitted because no compact aggregate is available without additional telemetry queries.'] }
  }

  private async pressEvents(args: Record<string, unknown>, context: AiToolExecutionContext): Promise<AiToolResult> {
    if (!exactKeys(args, ['press', 'start', 'end', 'topN'])) throw new Error('invalid_ai_tool_arguments')
    const pressKey = press(args.press); const { start, end } = range(args.start, args.end); const topN = integer(args.topN, 1, 10)
    if (Date.parse(end) - Date.parse(start) > MAX_EVENT_SUMMARY_RANGE_MS) throw new Error('invalid_ai_tool_range')
    const [radiusResult, contextResult] = await Promise.allSettled([this.radius.getPressEpisodes(pressKey, start, end), this.productionContextChanges(pressKey, start, end, context)])
    if (radiusResult.status === 'rejected') throw radiusResult.reason
    const data = radiusResult.value
    const episodes = data.episodes.slice().sort((left, right) => right.durationSeconds - left.durationSeconds).slice(0, topN).map((episode) => ({ startUtc: episode.startUtc, endUtc: episode.endUtc, durationMinutes: round(episode.durationSeconds / 60), completionStatus: episode.completionStatus, dataInterrupted: episode.dataInterrupted, primaryRadiusState: episode.primaryStatusDescription, returnAttempts: episode.returnToProductionAttemptCount, failedReturnAttempts: episode.failedReturnToProductionAttempts }))
    const productionContext = contextResult.status === 'fulfilled' ? { available: true, changes: contextResult.value.filter((change) => ['job', 'order', 'recipe'].includes(change.field)).slice(0, 30).map((change) => ({ atUtc: change.atUtc, field: change.field, previousValue: displayValue(change.previousValue), value: displayValue(change.value) })) } : { available: false, changes: [] }
    return { press: data.press.displayName, pressKey, range: { start, end }, coveragePercent: round(data.summary.dataCoveragePercent), productionInterruptions: data.summary.episodeCount, longestInterruptionMinutes: round(data.summary.longestEpisodeSeconds / 60), events: episodes, topRadiusDrivers: data.operationalAnalytics.statusDrivers.slice().sort((left, right) => right.durationSeconds - left.durationSeconds).slice(0, topN).map((item) => ({ eventType: item.eventType, statusCode: item.statusCode, statusDescription: item.statusDescription, durationMinutes: round(item.durationSeconds / 60), occurrences: item.occurrenceCount })), productionContext, limitations: [...(contextResult.status === 'rejected' ? ['Job/Order/Recipe context was unavailable; Radius evidence remains valid.'] : []), 'Broad telemetry threshold and delta scanning is intentionally deferred in Phase 1.'] }
  }

  private async eventContext(args: Record<string, unknown>, context: AiToolExecutionContext): Promise<AiToolResult> {
    if (!exactKeys(args, ['press', 'timestamp', 'beforeMinutes', 'afterMinutes'])) throw new Error('invalid_ai_tool_arguments')
    const pressKey = press(args.press); const timestamp = utc(args.timestamp); const beforeMinutes = integer(args.beforeMinutes, 1, MAX_EVENT_CONTEXT_MINUTES); const afterMinutes = integer(args.afterMinutes, 1, MAX_EVENT_CONTEXT_MINUTES)
    const fromUtc = new Date(Date.parse(timestamp) - beforeMinutes * 60_000).toISOString(); const toUtc = new Date(Date.parse(timestamp) + afterMinutes * 60_000).toISOString()
    if (!this.radius.getRawTimeline) throw new Error('radius_timeline_unavailable')
    const [radiusResult, productionResult, speedResult] = await Promise.allSettled([this.radius.getRawTimeline(pressKey, fromUtc, toUtc), this.telemetry.context(pressKey, fromUtc, toUtc, context.requestId, context.signal), this.telemetry.speed(pressKey, fromUtc, toUtc, context.requestId, context.signal)])
    if (radiusResult.status === 'rejected') throw radiusResult.reason
    const timeline = radiusResult.value; const offlineSeconds = timeline.segments.filter((segment) => segment.kind === 'offline').reduce((sum, segment) => sum + segment.durationSeconds, 0)
    return {
      press: timeline.displayName, pressKey, timestamp, range: { start: fromUtc, end: toUtc },
      radius: { coveragePercent: round(100 - offlineSeconds / ((Date.parse(toUtc) - Date.parse(fromUtc)) / 1_000) * 100), segments: timeline.segments.slice(0, 30).map((segment) => segment.kind === 'offline' ? { startUtc: segment.startUtc, endUtc: segment.endUtc, unavailable: true } : { startUtc: segment.startUtc, endUtc: segment.endUtc, unavailable: false, eventType: segment.eventType, statusCode: segment.statusCode, statusDescription: segment.statusDescription }) },
      actualSpeed: speedResult.status === 'fulfilled' ? { available: true, unit: speedResult.value.actual.sourceUnit, ...speedSummary(speedResult.value.actual.samples) } : { available: false, observationCount: 0 },
      productionContext: productionResult.status === 'fulfilled' ? { available: true, atEvent: contextAt(productionResult.value, timestamp), changes: productionResult.value.changes.filter((change) => ['job', 'order', 'recipe'].includes(change.field)).slice(0, 20).map((change) => ({ atUtc: change.atUtc, field: change.field, previousValue: displayValue(change.previousValue), value: displayValue(change.value) })) } : { available: false, atEvent: {}, changes: [] },
      limitations: [...(speedResult.status === 'rejected' ? ['Actual Speed was unavailable for this window.'] : []), ...(productionResult.status === 'rejected' ? ['Job/Order/Recipe context was unavailable for this window.'] : []), ...(timeline.segments.length > 30 ? ['Radius segments were bounded to the first 30 records in the requested context window.'] : [])],
    }
  }
}
