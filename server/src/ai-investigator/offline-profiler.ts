import type { AiInvestigatorToolDefinition } from './read-only-tools.js'

export const OFFLINE_TOKEN_ESTIMATE_METHOD = 'ceil(exact UTF-8 request bytes / 4); no local model tokenizer installed'

export interface OfflineRequestProfile {
  exactRequestBytes: number
  estimatedInputTokens: number
  estimateMethod: string
  contributors: Array<{ name: string; exactBytes: number }>
}

export function exactUtf8Bytes(value: unknown): number {
  return Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8')
}

function schemaFrom(payload: Record<string, unknown>): unknown {
  const text = payload.text
  if (!text || typeof text !== 'object') return undefined
  const format = (text as Record<string, unknown>).format
  return format && typeof format === 'object' ? (format as Record<string, unknown>).schema : undefined
}

function repeatedFieldBytes(value: unknown): number {
  const counts = new Map<string, number>()
  const visit = (item: unknown) => {
    if (Array.isArray(item)) { item.forEach(visit); return }
    if (!item || typeof item !== 'object') return
    for (const [key, nested] of Object.entries(item as Record<string, unknown>)) { counts.set(key, (counts.get(key) ?? 0) + 1); visit(nested) }
  }
  visit(value)
  return [...counts].reduce((sum, [key, count]) => sum + Math.max(0, count - 1) * exactUtf8Bytes(key), 0)
}

function stringMatchBytes(value: unknown, pattern: RegExp): number {
  const text = JSON.stringify(value); const matches = text.match(pattern) ?? []
  return matches.reduce((sum, match) => sum + exactUtf8Bytes(match), 0)
}

function embeddedInput(payloadInput: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(payloadInput)) return undefined
  const first = payloadInput[0]
  if (!first || typeof first !== 'object' || typeof (first as Record<string, unknown>).content !== 'string') return undefined
  try { const value = JSON.parse((first as Record<string, unknown>).content as string) as unknown; return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined } catch { return undefined }
}

function nested(value: Record<string, unknown> | undefined, ...path: string[]): unknown {
  let cursor: unknown = value
  for (const key of path) { if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) return undefined; cursor = (cursor as Record<string, unknown>)[key] }
  return cursor
}

export function profileAiResponsesRequest(payload: Record<string, unknown>): OfflineRequestProfile {
  const tools = Array.isArray(payload.tools) ? payload.tools as AiInvestigatorToolDefinition[] : []
  const input = payload.input
  const schema = schemaFrom(payload)
  const embedded = embeddedInput(input)
  const stateFacts = nested(embedded, 'state', 'facts') ?? nested(embedded, 'candidates')
  const rangeTable = nested(embedded, 'state', 'ranges') ?? nested(embedded, 'ranges')
  const toolLedger = nested(embedded, 'state', 'collectedTools')
  const limitations = nested(embedded, 'state', 'limitations') ?? nested(embedded, 'limitations')
  const contributors = [
    { name: 'model-facing input', exactBytes: exactUtf8Bytes(input) },
    { name: 'structured output schema', exactBytes: schema === undefined ? 0 : exactUtf8Bytes(schema) },
    { name: 'instructions', exactBytes: exactUtf8Bytes(payload.instructions ?? '') },
    { name: 'tool definitions total', exactBytes: exactUtf8Bytes(tools) },
    { name: 'tool parameter schemas', exactBytes: tools.reduce((sum, tool) => sum + exactUtf8Bytes(tool.parameters), 0) },
    { name: 'tool names/descriptions', exactBytes: tools.reduce((sum, tool) => sum + exactUtf8Bytes({ name: tool.name, description: tool.description }), 0) },
    { name: 'repeated field names in input', exactBytes: repeatedFieldBytes(input) },
    { name: 'fact identifiers in input', exactBytes: stringMatchBytes(input, /press(?:3|5|6|7|8|9|10|11|12|13|14|15)\.[a-z0-9_.-]+/g) },
    { name: 'timestamps in input', exactBytes: stringMatchBytes(input, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z/g) },
    { name: 'source/role/unit words in input', exactBytes: stringMatchBytes(input, /(?:radius|telemetry|production_context|comparison|coverage|current|baseline|delta|event|percent|percentage_points|minutes|count|iso8601)/g) },
    { name: 'compact fact/candidate records', exactBytes: stateFacts === undefined ? 0 : exactUtf8Bytes(stateFacts) },
    { name: 'range table', exactBytes: rangeTable === undefined ? 0 : exactUtf8Bytes(rangeTable) },
    { name: 'completed-tool ledger', exactBytes: toolLedger === undefined ? 0 : exactUtf8Bytes(toolLedger) },
    { name: 'limitations', exactBytes: limitations === undefined ? 0 : exactUtf8Bytes(limitations) },
    { name: 'metric names in input', exactBytes: stringMatchBytes(input, /(?:coveragePercent|productionPercent|productionPercentagePointDelta|interruptions|interruptionDelta|longestInterruptionMinutes|longestInterruptionDeltaMinutes|radiusDriverDurationMinutes|eventTimestamp|eventDurationMinutes)/g) },
  ].filter((item) => item.exactBytes > 0).sort((left, right) => right.exactBytes - left.exactBytes)
  const exactRequestBytes = exactUtf8Bytes(payload)
  return { exactRequestBytes, estimatedInputTokens: Math.ceil(exactRequestBytes / 4), estimateMethod: OFFLINE_TOKEN_ESTIMATE_METHOD, contributors }
}

export function cumulativeOfflineProfile(requests: Record<string, unknown>[]) {
  const profiles = requests.map(profileAiResponsesRequest)
  const totals = new Map<string, number>()
  for (const profile of profiles) for (const contributor of profile.contributors) totals.set(contributor.name, (totals.get(contributor.name) ?? 0) + contributor.exactBytes)
  return {
    requestCount: profiles.length,
    exactRequestBytes: profiles.reduce((sum, profile) => sum + profile.exactRequestBytes, 0),
    estimatedInputTokens: profiles.reduce((sum, profile) => sum + profile.estimatedInputTokens, 0),
    estimateMethod: OFFLINE_TOKEN_ESTIMATE_METHOD,
    contributors: [...totals].map(([name, exactBytes]) => ({ name, exactBytes })).sort((left, right) => right.exactBytes - left.exactBytes),
    requests: profiles,
  }
}
