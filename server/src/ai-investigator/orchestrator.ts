import { randomUUID } from 'node:crypto'
import OpenAI from 'openai'
import type { ResponseInput, ResponseInputItem } from 'openai/resources/responses/responses'
import type { AiInvestigatorConfig } from '../config.js'
import type { RadiusPressKey } from '../radius/models.js'
import { AI_INVESTIGATOR_CONTENT_SCHEMA, AI_INVESTIGATOR_DISCOVERY_SCHEMA, AI_INVESTIGATOR_DISCOVERY_TEXT_FORMAT, AiInvestigatorValidationError, parseAiInvestigatorDiscoveryDraft, type AiGroundingFact, type AiInvestigatorContent, type AiInvestigatorDraftContent, type AiInvestigatorRequest, type AiInvestigatorResult, validateAiInvestigatorDiscoveryDraft, validateAiInvestigatorDraft } from './contracts.js'
import { buildDiscoveryPreflight, DISCOVERY_CANDIDATE_LIMIT, DISCOVERY_INSTRUCTIONS, DISCOVERY_OUTPUT_TOKENS, DISCOVERY_PROMPT_CACHE_KEY, expandDiscoveryDraft, validateDiscoveryReferences } from './discovery.js'
import { groundAiInvestigatorDraft } from './grounding.js'
import { AiInvestigatorReadOnlyToolRegistry, type AiInvestigatorToolDefinition, type AiInvestigatorToolExecutor, type AiToolResult } from './read-only-tools.js'

export interface AiInvestigatorLogger {
  info(message: string): void
  error(message: string): void
}

export interface AiModelToolCall { type: 'function_call'; callId: string; name: string; arguments: string }
export interface AiModelHttpMetadata {
  requestId?: string
  processingMs?: string
  limitTokens?: string
  remainingTokens?: string
  resetTokens?: string
  limitRequests?: string
  remainingRequests?: string
  resetRequests?: string
  limitProjectTokens?: string
  remainingProjectTokens?: string
  resetProjectTokens?: string
  retryAfter?: string
}
export interface AiModelResponse {
  id: string
  outputText: string
  outputItems: unknown[]
  toolCalls: AiModelToolCall[]
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number }
  http?: AiModelHttpMetadata
  responseStatus?: string
  incompleteReason?: string
  refused?: boolean
  outputItemTypes?: string[]
  parsedOutput?: unknown | null
}

export type AiModelPhase = 'investigation' | 'final_synthesis' | 'grounding_correction'
export type AiModelToolChoice = 'auto' | 'none'

export interface AiModelRequestOptions {
  structuredOutputSchema?: Record<string, unknown>
  structuredOutputFormat?: unknown
  structuredOutputName?: string
  maxOutputTokens?: number
  promptCacheKey?: string
}

class AiModelStructuredOutputError extends Error {
  constructor(
    public readonly responseId: string | undefined,
    public readonly responseStatus: string | undefined,
    public readonly incompleteReason: string | undefined,
    public readonly outputItemTypes: string[],
    public readonly refused: boolean,
    public readonly usage: AiModelResponse['usage'],
    public readonly http: AiModelHttpMetadata,
    public readonly validationDiagnostic: { validationStage: 'sdk_parse'; schemaCode: string; path: string; expected?: string; receivedType: string },
  ) {
    super('structured_output_invalid')
    this.name = 'AiModelStructuredOutputError'
  }
}

export interface AiInvestigatorModelClient {
  create(input: unknown[], instructions: string, tools: AiInvestigatorToolDefinition[], toolChoice: AiModelToolChoice, signal: AbortSignal, options?: AiModelRequestOptions): Promise<AiModelResponse>
}

const SAFE_OPENAI_HEADERS = {
  processingMs: 'openai-processing-ms',
  limitTokens: 'x-ratelimit-limit-tokens',
  remainingTokens: 'x-ratelimit-remaining-tokens',
  resetTokens: 'x-ratelimit-reset-tokens',
  limitRequests: 'x-ratelimit-limit-requests',
  remainingRequests: 'x-ratelimit-remaining-requests',
  resetRequests: 'x-ratelimit-reset-requests',
  limitProjectTokens: 'x-ratelimit-limit-project-tokens',
  remainingProjectTokens: 'x-ratelimit-remaining-project-tokens',
  resetProjectTokens: 'x-ratelimit-reset-project-tokens',
  retryAfter: 'retry-after',
} as const

function headerValue(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== 'object') return undefined
  const reader = headers as { get?: (key: string) => unknown }
  const value = typeof reader.get === 'function' ? reader.get(name) : (headers as Record<string, unknown>)[name] ?? (headers as Record<string, unknown>)[name.toLowerCase()]
  return typeof value === 'string' && value.length ? value : undefined
}

export function safeOpenAiHttpMetadata(headers: unknown, requestId?: unknown): AiModelHttpMetadata {
  const metadata: AiModelHttpMetadata = {}
  const resolvedRequestId = typeof requestId === 'string' ? requestId : headerValue(headers, 'x-request-id')
  if (resolvedRequestId) metadata.requestId = resolvedRequestId
  for (const [key, header] of Object.entries(SAFE_OPENAI_HEADERS) as Array<[keyof Omit<AiModelHttpMetadata, 'requestId'>, string]>) {
    const value = headerValue(headers, header)
    if (value) metadata[key] = value
  }
  return metadata
}

function safeOutputItemTypes(output: unknown): string[] {
  if (!Array.isArray(output)) return []
  const types = output.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const record = item as Record<string, unknown>; const itemType = typeof record.type === 'string' ? record.type : 'unknown'
    if (itemType !== 'message' || !Array.isArray(record.content)) return [itemType]
    return [itemType, ...record.content.flatMap((content) => content && typeof content === 'object' && typeof (content as Record<string, unknown>).type === 'string' ? [(content as Record<string, unknown>).type as string] : [])]
  })
  return [...new Set(types)]
}

function safeResponseEnvelope(value: unknown, headers: unknown): Pick<AiModelResponse, 'id' | 'responseStatus' | 'incompleteReason' | 'refused' | 'outputItemTypes' | 'usage' | 'http'> {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const incomplete = record.incomplete_details && typeof record.incomplete_details === 'object' ? record.incomplete_details as Record<string, unknown> : {}
  const usage = record.usage && typeof record.usage === 'object' ? record.usage as Record<string, unknown> : {}
  const outputItemTypes = safeOutputItemTypes(record.output)
  return {
    id: typeof record.id === 'string' ? record.id : 'unknown_response',
    responseStatus: typeof record.status === 'string' ? record.status : undefined,
    incompleteReason: typeof incomplete.reason === 'string' ? incomplete.reason : undefined,
    refused: outputItemTypes.includes('refusal'),
    outputItemTypes,
    usage: Object.keys(usage).length ? { inputTokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined, outputTokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined, totalTokens: typeof usage.total_tokens === 'number' ? usage.total_tokens : undefined } : undefined,
    http: safeOpenAiHttpMetadata(headers),
  }
}

function safeSdkParseDiagnostic(error: unknown): AiModelStructuredOutputError['validationDiagnostic'] {
  if (error instanceof SyntaxError) return { validationStage: 'sdk_parse', schemaCode: 'malformed_json', path: '$', expected: 'JSON object', receivedType: 'string' }
  const issues = error && typeof error === 'object' && Array.isArray((error as { issues?: unknown }).issues) ? (error as { issues: Array<Record<string, unknown>> }).issues : []
  const issue = issues[0]; const rawPath = Array.isArray(issue?.path) ? issue.path : []
  const path = rawPath.reduce<string>((result, part) => typeof part === 'number' ? `${result}[${part}]` : `${result ? `${result}.` : ''}${typeof part === 'string' && /^[A-Za-z][A-Za-z0-9_-]*$/.test(part) ? part : 'field'}`, '') || '$'
  const expected = rawPath.at(-1) === 'importance' || rawPath.at(-1) === 'confidence' ? 'high|medium|low' : typeof issue?.expected === 'string' ? issue.expected : undefined
  return { validationStage: 'sdk_parse', schemaCode: typeof issue?.code === 'string' ? issue.code : 'sdk_parse_failed', path, expected, receivedType: typeof issue?.received === 'string' ? issue.received : 'unknown' }
}

export class OpenAiResponsesInvestigatorClient implements AiInvestigatorModelClient {
  private readonly client: OpenAI

  constructor(private readonly config: AiInvestigatorConfig, fetchImplementation?: typeof fetch) {
    if (!config.apiKey) throw new Error('ai_investigator_not_configured')
    this.client = new OpenAI({ apiKey: config.apiKey, timeout: config.openAiTimeoutMs, maxRetries: 0, ...(fetchImplementation ? { fetch: fetchImplementation } : {}) })
  }

  async create(input: unknown[], instructions: string, tools: AiInvestigatorToolDefinition[], toolChoice: AiModelToolChoice, signal: AbortSignal, options: AiModelRequestOptions = {}): Promise<AiModelResponse> {
    const payload = buildAiResponsesRequestPayload(this.config.model, input, instructions, tools, toolChoice, options)
    const requestOptions = { signal, timeout: this.config.openAiTimeoutMs, maxRetries: 0 }
    if (options.structuredOutputFormat && toolChoice === 'none') {
      const operation = this.client.responses.parse(payload as never, requestOptions)
      const rawResponse = await operation.asResponse(); const rawEnvelope = await rawResponse.clone().json().catch(() => undefined)
      let response
      try { response = await operation }
      catch (error) {
        const envelope = safeResponseEnvelope(rawEnvelope, rawResponse.headers)
        throw new AiModelStructuredOutputError(envelope.id, envelope.responseStatus, envelope.incompleteReason, envelope.outputItemTypes ?? [], envelope.refused ?? false, envelope.usage, envelope.http ?? {}, safeSdkParseDiagnostic(error))
      }
      const toolCalls = response.output.filter((item) => item.type === 'function_call').map((item) => ({ type: 'function_call' as const, callId: item.call_id, name: item.name, arguments: item.arguments }))
      const outputItemTypes = safeOutputItemTypes(response.output)
      return { id: response.id, outputText: response.output_text, outputItems: [], toolCalls, parsedOutput: response.output_parsed, responseStatus: response.status, incompleteReason: response.incomplete_details?.reason, refused: outputItemTypes.includes('refusal'), outputItemTypes, usage: response.usage ? { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens, totalTokens: response.usage.total_tokens } : undefined, http: safeOpenAiHttpMetadata(rawResponse.headers) }
    }
    const wrapped = await this.client.responses.create(payload as never, requestOptions).withResponse()
    const response = wrapped.data
    const toolCalls = response.output.filter((item) => item.type === 'function_call').map((item) => ({ type: 'function_call' as const, callId: item.call_id, name: item.name, arguments: item.arguments }))
    const outputItemTypes = safeOutputItemTypes(response.output)
    return { id: response.id, outputText: response.output_text, outputItems: [], toolCalls, responseStatus: response.status, incompleteReason: response.incomplete_details?.reason, refused: outputItemTypes.includes('refusal'), outputItemTypes, usage: response.usage ? { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens, totalTokens: response.usage.total_tokens } : undefined, http: safeOpenAiHttpMetadata(wrapped.response.headers, wrapped.request_id) }
  }
}

export function buildAiResponsesRequestPayload(model: string, input: unknown[], instructions: string, tools: AiInvestigatorToolDefinition[], toolChoice: AiModelToolChoice, options: AiModelRequestOptions = {}) {
  const schema = options.structuredOutputSchema ?? AI_INVESTIGATOR_CONTENT_SCHEMA
  const format = options.structuredOutputFormat ?? { type: 'json_schema', name: options.structuredOutputName ?? 'process_intelligence_investigation', strict: true, schema }
  return {
    model,
    instructions,
    input: input as ResponseInput,
    ...(tools.length ? { tools } : {}),
    tool_choice: toolChoice,
    text: toolChoice === 'none' ? { verbosity: 'low', format } : { verbosity: 'low' },
    max_output_tokens: options.maxOutputTokens ?? (toolChoice === 'auto' ? INVESTIGATION_OUTPUT_TOKENS : FINAL_OUTPUT_TOKENS),
    ...(options.promptCacheKey ? { prompt_cache_key: options.promptCacheKey } : {}),
    store: false,
  }
}

class AiTimeoutError extends Error {
  constructor(public readonly kind: 'overall' | 'tool') { super(`ai_${kind}_timeout`); this.name = 'AiTimeoutError' }
}

export interface ToolEvidence { name: string; arguments: unknown; result?: AiToolResult; error?: string; durationMs: number }

export const SYSTEM_INSTRUCTIONS = `You are the advisory ProcessIntelligence AI Investigator. Use only supplied read-only functions; never claim database, historian, filesystem, network, control, MQTT, acknowledgement, or configuration access. When collectedTools is empty, call get_fleet_operational_summary first. Otherwise never repeat a completed tool with the same arguments; select only materially different candidates and a few necessary follow-ups. Use the preceding equal-duration baseline when useful. Supplied facts are authoritative: cite exact ids, never invent or recalculate values, counts, durations, comparisons, identities, or timestamps, and select related current/baseline/delta ids together. Sources are server-owned; unusable production context is not evidence. Separate facts, comparisons, and cautious interpretations; never assert root cause or contradict a material comparison. Unavailable data is a limitation; insufficient baseline must be stated. Return at most five ranked findings. Links must be relative /raw-radius-explorer, /telemetry-event-explorer, /overview, or /operational-analysis paths. No HTML.`
export const FINAL_SYNTHESIS_INSTRUCTIONS = `${SYSTEM_INSTRUCTIONS} Evidence collection is complete. Tools are disabled. Produce the complete structured investigation only from supplied facts.`
const CORRECTION_INSTRUCTIONS = `${SYSTEM_INSTRUCTIONS} Tools are disabled. Correct or omit rejected findings using only supplied fact ids and return the complete response.`
const INVESTIGATION_OUTPUT_TOKENS = 600
const FINAL_OUTPUT_TOKENS = 2_400

function safeLog(logger: AiInvestigatorLogger | false, level: 'info' | 'error', value: Record<string, unknown>) {
  if (logger) logger[level](JSON.stringify(value))
}

function parseToolArguments(raw: string): unknown {
  if (Buffer.byteLength(raw, 'utf8') > 20_000) throw new Error('invalid_ai_tool_arguments')
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { throw new Error('invalid_ai_tool_arguments') }
  return parsed
}

function errorCode(error: unknown): string {
  if (error instanceof AiTimeoutError) return error.kind === 'tool' ? 'tool_timeout' : 'overall_timeout'
  if (error && typeof error === 'object') {
    const candidate = error as { status?: unknown; code?: unknown }
    if (candidate.status === 429 && candidate.code === 'rate_limit_exceeded') return 'openai_rate_limit'
  }
  if (error instanceof Error && /^[a-z0-9_]+$/.test(error.message)) return error.message
  return 'tool_unavailable'
}

function safeModelError(error: unknown): Record<string, unknown> {
  if (!error || typeof error !== 'object') return { errorType: typeof error }
  const candidate = error as { constructor?: { name?: string }; status?: unknown; code?: unknown; type?: unknown; request_id?: unknown; headers?: unknown; responseId?: unknown; responseStatus?: unknown; incompleteReason?: unknown; outputItemTypes?: unknown; refused?: unknown; usage?: unknown; http?: unknown; validationDiagnostic?: unknown }
  const usage = candidate.usage && typeof candidate.usage === 'object' ? candidate.usage as Record<string, unknown> : {}
  const http = candidate.http && typeof candidate.http === 'object' ? candidate.http as Record<string, unknown> : {}
  const safeHttp = Object.fromEntries(['requestId', 'processingMs', 'limitTokens', 'remainingTokens', 'resetTokens', 'limitRequests', 'remainingRequests', 'resetRequests', 'limitProjectTokens', 'remainingProjectTokens', 'resetProjectTokens', 'retryAfter'].flatMap((key) => typeof http[key] === 'string' ? [[key, http[key]]] : []))
  const diagnostic = candidate.validationDiagnostic && typeof candidate.validationDiagnostic === 'object' ? candidate.validationDiagnostic as Record<string, unknown> : {}
  const safeDiagnostic: Record<string, unknown> = Object.fromEntries(['validationStage', 'schemaCode', 'path', 'expected', 'receivedType', 'candidateId', 'factId'].flatMap((key) => typeof diagnostic[key] === 'string' && String(diagnostic[key]).length <= 240 ? [[key, diagnostic[key]]] : []))
  if (typeof diagnostic.findingIndex === 'number' && Number.isInteger(diagnostic.findingIndex)) safeDiagnostic.findingIndex = diagnostic.findingIndex
  return {
    errorType: candidate.constructor?.name ?? 'Error',
    ...(typeof candidate.status === 'number' ? { status: candidate.status } : {}),
    ...(typeof candidate.code === 'string' ? { code: candidate.code } : {}),
    ...(typeof candidate.type === 'string' ? { type: candidate.type } : {}),
    ...(typeof candidate.responseId === 'string' && candidate.responseId.length <= 200 ? { responseId: candidate.responseId } : {}),
    ...(typeof candidate.responseStatus === 'string' ? { responseStatus: candidate.responseStatus } : {}),
    ...(typeof candidate.incompleteReason === 'string' ? { incompleteReason: candidate.incompleteReason } : {}),
    ...(Array.isArray(candidate.outputItemTypes) && candidate.outputItemTypes.every((item) => typeof item === 'string') ? { outputItemTypes: candidate.outputItemTypes } : {}),
    ...(typeof candidate.refused === 'boolean' ? { refused: candidate.refused } : {}),
    ...(Object.keys(usage).length ? { usage: { inputTokens: typeof usage.inputTokens === 'number' ? usage.inputTokens : undefined, outputTokens: typeof usage.outputTokens === 'number' ? usage.outputTokens : undefined, totalTokens: typeof usage.totalTokens === 'number' ? usage.totalTokens : undefined } } : {}),
    ...safeDiagnostic,
    ...safeHttp,
    ...safeOpenAiHttpMetadata(candidate.headers, candidate.request_id),
  }
}

function isRateLimit(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const candidate = error as { status?: unknown; code?: unknown }
  return candidate.status === 429 && candidate.code === 'rate_limit_exceeded'
}

function durationHeaderMs(value: string | undefined): number | undefined {
  if (!value) return undefined
  if (/^\d+(?:\.\d+)?$/.test(value)) return Number(value) * 1_000
  let total = 0; let matched = ''; const pattern = /(\d+(?:\.\d+)?)(ms|s|m|h)/g
  for (const part of value.matchAll(pattern)) { matched += part[0]; const amount = Number(part[1]); total += part[2] === 'ms' ? amount : part[2] === 's' ? amount * 1_000 : part[2] === 'm' ? amount * 60_000 : amount * 3_600_000 }
  return matched === value && Number.isFinite(total) ? total : undefined
}

function retryDelayMs(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined
  const candidate = error as { request_id?: unknown; headers?: unknown }
  const metadata = safeOpenAiHttpMetadata(candidate.headers, candidate.request_id)
  const delays = [durationHeaderMs(metadata.retryAfter), durationHeaderMs(metadata.resetTokens), durationHeaderMs(metadata.resetProjectTokens), durationHeaderMs(metadata.resetRequests)].filter((value): value is number => value !== undefined)
  return delays.length ? Math.max(...delays) : undefined
}

async function waitFor(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason ?? new AiTimeoutError('overall')
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds)
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason ?? new AiTimeoutError('overall')) }, { once: true })
  })
}

function utf8Bytes(value: unknown): number { return Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8') }
export function estimateAiInputTokens(input: unknown[], instructions: string, tools: AiInvestigatorToolDefinition[], structuredOutput = tools.length === 0): number {
  return Math.ceil((utf8Bytes(input) + utf8Bytes(instructions) + utf8Bytes(tools) + (structuredOutput ? utf8Bytes(AI_INVESTIGATOR_CONTENT_SCHEMA) : 0)) / 4)
}

function compactFact(fact: AiGroundingFact, rangeId: string | undefined) {
  return { id: fact.factId, press: fact.pressKey, source: fact.source, metric: fact.metric, value: fact.value, unit: fact.unit, role: fact.role, usable: fact.usable, ...(fact.timestamp ? { timestamp: fact.timestamp } : {}), ...(rangeId ? { rangeId } : {}) }
}

function evidenceLimitations(evidence: ToolEvidence[]): string[] {
  return [...new Set(evidence.flatMap((item) => Array.isArray(item.result?.limitations) ? item.result.limitations.filter((value): value is string => typeof value === 'string') : []))]
}

export function compactInvestigationState(evidence: ToolEvidence[]) {
  const collectedTools = new Map<string, { name: string; arguments: unknown; ok: boolean; error?: string }>()
  for (const item of evidence) {
    const compact = { name: item.name, arguments: item.arguments, ok: Boolean(item.result), ...(item.error ? { error: item.error } : {}) }
    collectedTools.set(`${item.name}:${JSON.stringify(item.arguments)}`, compact)
  }
  const facts = groundingFacts(evidence); const rangeIds = new Map<string, string>(); const ranges: Array<{ id: string; start: string; end: string }> = []
  for (const fact of facts) {
    if (!fact.range) continue
    const key = `${fact.range.start}\u0000${fact.range.end}`
    if (!rangeIds.has(key)) { const id = `r${ranges.length + 1}`; rangeIds.set(key, id); ranges.push({ id, ...fact.range }) }
  }
  return {
    collectedTools: [...collectedTools.values()],
    ranges,
    facts: facts.map((fact) => compactFact(fact, fact.range ? rangeIds.get(`${fact.range.start}\u0000${fact.range.end}`) : undefined)),
    limitations: evidenceLimitations(evidence),
  }
}

function fleetTable(evidence: ToolEvidence[]) {
  const fleet = evidence.find((item) => item.name === 'get_fleet_operational_summary' && item.result)?.result
  const presses = fleet?.presses
  if (!Array.isArray(presses)) return []
  const rows = presses.slice(0, 12).flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const row = item as Record<string, unknown>
    return [[String(row.press ?? ''), String(row.coveragePercent ?? 'Unavailable'), String(row.productionPercent ?? 'Unavailable'), String(row.productionInterruptions ?? 'Unavailable'), String(row.longestInterruptionMinutes ?? 'Unavailable')]]
  })
  return rows.length ? [{ title: 'Deterministic press summary', columns: ['Press', 'Coverage %', 'Production %', 'Interruptions', 'Longest interruption (min)'], rows }] : []
}

function groundingFacts(evidence: ToolEvidence[]): AiGroundingFact[] {
  const facts = new Map<string, AiGroundingFact>()
  for (const item of evidence) {
    const candidates = item.result?.facts
    if (!Array.isArray(candidates)) continue
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== 'object' || typeof (candidate as AiGroundingFact).factId !== 'string') continue
      const fact = candidate as AiGroundingFact
      const existing = facts.get(fact.factId)
      if (existing && JSON.stringify(existing) !== JSON.stringify(fact)) throw new Error('conflicting_grounding_fact')
      facts.set(fact.factId, fact)
    }
  }
  return [...facts.values()]
}

function partialContent(status: 'partial' | 'timeout' | 'error', evidence: ToolEvidence[], reason: string): AiInvestigatorContent {
  if (reason === 'openai_rate_limit') return { summary: 'AI Investigator is temporarily rate limited. Try again after the token window resets.', findings: [], tables: fleetTable(evidence), limitations: ['No unsupported root-cause conclusion was generated.'] }
  const prefix = status === 'timeout' ? 'Analysis reached its time budget.' : status === 'error' ? 'The AI service could not complete the investigation.' : 'Analysis stopped at its configured exploration limit.'
  return { summary: `${prefix} Safe deterministic evidence collected before it stopped is shown below.`, findings: [], tables: fleetTable(evidence), limitations: [reason, 'No unsupported root-cause conclusion was generated.'] }
}

function requestPrompt(request: AiInvestigatorRequest): string {
  const duration = Date.parse(request.range.endUtc) - Date.parse(request.range.startUtc)
  const baselineEnd = request.range.startUtc
  const baselineStart = new Date(Date.parse(baselineEnd) - duration).toISOString()
  return JSON.stringify({ task: 'Discover unusual behavior', requestedScope: request.scope.pressKey ?? 'all', currentPeriod: request.range, recommendedBaseline: { startUtc: baselineStart, endUtc: baselineEnd }, constraints: { rankedFindingsMaximum: 5, manualVerificationRequired: true } })
}

export class AiInvestigatorOrchestrator {
  constructor(
    private readonly config: AiInvestigatorConfig,
    private readonly registry: AiInvestigatorToolExecutor,
    private readonly model: AiInvestigatorModelClient,
    private readonly logger: AiInvestigatorLogger | false = console,
    private readonly now: () => Date = () => new Date(),
    private readonly random: () => number = Math.random,
    private readonly wait: (milliseconds: number, signal: AbortSignal) => Promise<void> = waitFor,
  ) {}

  async analyzeDiscovery(request: AiInvestigatorRequest, requestSignal?: AbortSignal): Promise<AiInvestigatorResult> {
    const analysisId = randomUUID(); const started = this.now(); const startedAt = started.toISOString()
    const deadline = new AbortController(); const deadlineTimer = setTimeout(() => deadline.abort(new AiTimeoutError('overall')), this.config.totalTimeoutMs)
    const signal = requestSignal ? AbortSignal.any([deadline.signal, requestSignal]) : deadline.signal
    let evidence: ToolEvidence[] = []
    const finish = (status: AiInvestigatorResult['status'], content: AiInvestigatorContent, grounding: AiInvestigatorResult['grounding']) => {
      const completedAt = this.now().toISOString()
      const result: AiInvestigatorResult = { analysisId, status, scope: { pressKey: request.scope.pressKey, startUtc: request.range.startUtc, endUtc: request.range.endUtc, analysis: request.analysis }, startedAt, completedAt, elapsedMs: Math.max(0, Date.parse(completedAt) - started.getTime()), toolCallsUsed: evidence.length, grounding, ...content }
      safeLog(this.logger, status === 'error' ? 'error' : 'info', { event: 'ai_investigator_finished', architecture: 'single_synthesis', analysisId, status, elapsedMs: result.elapsedMs, toolCallsUsed: evidence.length, grounding })
      return result
    }
    safeLog(this.logger, 'info', { event: 'ai_investigator_started', architecture: 'single_synthesis', analysisId, scope: request.scope.pressKey ?? 'all', startUtc: request.range.startUtc, endUtc: request.range.endUtc, modelConfigured: true, model: this.config.model })
    try {
      const candidateLimit = Math.min(request.scope.pressKey ? 1 : DISCOVERY_CANDIDATE_LIMIT, Math.max(0, this.config.maxToolCalls - 2))
      const preflight = await buildDiscoveryPreflight(this.registry, request, signal, { requestId: analysisId, candidateLimit, maxParallelTools: this.config.maxParallelTools, toolTimeoutMs: this.config.toolTimeoutMs })
      evidence = preflight.evidence
      for (const item of evidence) safeLog(this.logger, 'info', { event: 'ai_investigator_tool', architecture: 'single_synthesis', analysisId, tool: item.name, durationMs: item.durationMs, success: true, payloadBytes: utf8Bytes(item.result) })
      const input: unknown[] = [{ role: 'user', content: JSON.stringify(preflight.modelInput) } satisfies ResponseInputItem]
      const options: AiModelRequestOptions = { structuredOutputSchema: AI_INVESTIGATOR_DISCOVERY_SCHEMA, structuredOutputFormat: AI_INVESTIGATOR_DISCOVERY_TEXT_FORMAT, structuredOutputName: 'process_intelligence_discovery', maxOutputTokens: DISCOVERY_OUTPUT_TOKENS, promptCacheKey: DISCOVERY_PROMPT_CACHE_KEY }
      const payload = buildAiResponsesRequestPayload(this.config.model, input, DISCOVERY_INSTRUCTIONS, [], 'none', options)
      safeLog(this.logger, 'info', { event: 'ai_investigator_model_request', architecture: 'single_synthesis', analysisId, requestNumber: 1, phase: 'final_synthesis', toolsEnabled: false, toolChoice: 'none', availableTools: [], candidateCount: preflight.candidates.length, estimatedInputTokens: Math.ceil(utf8Bytes(payload) / 4), maxOutputTokens: DISCOVERY_OUTPUT_TOKENS, requestBytes: utf8Bytes(payload), modelFacingEvidenceBytes: utf8Bytes(preflight.modelInput), toolResultsIncluded: evidence.length, priorModelMessagesIncluded: 0, priorModelResultsIncluded: 0 })
      let response: AiModelResponse
      try {
        response = await this.model.create(input, DISCOVERY_INSTRUCTIONS, [], 'none', signal, options)
        safeLog(this.logger, 'info', { event: 'ai_investigator_model_response', architecture: 'single_synthesis', analysisId, requestNumber: 1, responseId: response.id, phase: 'final_synthesis', responseStatus: response.responseStatus, incompleteReason: response.incompleteReason, refused: response.refused ?? false, outputItemTypes: response.outputItemTypes ?? [], usage: response.usage, ...response.http })
      } catch (error) {
        if (error instanceof AiModelStructuredOutputError) safeLog(this.logger, 'error', { event: 'ai_investigator_validation_failed', architecture: 'single_synthesis', analysisId, responseId: error.responseId, responseStatus: error.responseStatus, incompleteReason: error.incompleteReason, refused: error.refused, outputItemTypes: error.outputItemTypes, ...error.validationDiagnostic })
        safeLog(this.logger, 'error', { event: 'ai_investigator_model_failure', architecture: 'single_synthesis', analysisId, requestNumber: 1, phase: 'final_synthesis', ...safeModelError(error) })
        throw error
      }
      if (response.refused) { safeLog(this.logger, 'error', { event: 'ai_investigator_validation_failed', architecture: 'single_synthesis', analysisId, responseId: response.id, validationStage: 'response_status', schemaCode: 'openai_refusal', path: '$', receivedType: 'refusal', responseStatus: response.responseStatus, outputItemTypes: response.outputItemTypes ?? [] }); throw new Error('openai_refusal') }
      if (response.responseStatus === 'incomplete') { safeLog(this.logger, 'error', { event: 'ai_investigator_validation_failed', architecture: 'single_synthesis', analysisId, responseId: response.id, validationStage: 'response_status', schemaCode: 'openai_incomplete', path: '$', expected: 'completed', receivedType: 'incomplete', incompleteReason: response.incompleteReason, outputItemTypes: response.outputItemTypes ?? [] }); throw new Error('openai_incomplete') }
      if (response.toolCalls.length) throw new Error('invalid_final_synthesis')
      let compactDraft
      try {
        if ('parsedOutput' in response) {
          if (response.parsedOutput === null || response.parsedOutput === undefined) throw new Error('structured_output_missing')
          compactDraft = validateAiInvestigatorDiscoveryDraft(response.parsedOutput)
        } else {
          if (!response.outputText) throw new Error('structured_output_missing')
          compactDraft = parseAiInvestigatorDiscoveryDraft(response.outputText)
        }
        safeLog(this.logger, 'info', { event: 'ai_investigator_validation_passed', architecture: 'single_synthesis', analysisId, responseId: response.id, validationStage: 'final_schema', findingCount: compactDraft.findings.length })
      } catch (error) {
        if (error instanceof AiInvestigatorValidationError) safeLog(this.logger, 'error', { event: 'ai_investigator_validation_failed', architecture: 'single_synthesis', analysisId, responseId: response.id, ...error.diagnostic })
        else safeLog(this.logger, 'error', { event: 'ai_investigator_validation_failed', architecture: 'single_synthesis', analysisId, responseId: response.id, validationStage: 'final_schema', schemaCode: 'structured_output_missing', path: '$', expected: 'parsed object', receivedType: 'missing', outputItemTypes: response.outputItemTypes ?? [] })
        throw error
      }
      const references = validateDiscoveryReferences(compactDraft, preflight.candidates, preflight.facts)
      for (const issue of references.issues) safeLog(this.logger, 'error', { event: 'ai_investigator_validation_failed', architecture: 'single_synthesis', analysisId, responseId: response.id, ...issue })
      if (!references.issues.length) safeLog(this.logger, 'info', { event: 'ai_investigator_validation_passed', architecture: 'single_synthesis', analysisId, responseId: response.id, validationStage: 'grounding_reference', findingCount: references.accepted.findings.length })
      const expanded = expandDiscoveryDraft(references.accepted, preflight.facts, preflight.candidates.flatMap(({ observations }) => observations))
      expanded.limitations = [...new Set([...expanded.limitations, ...preflight.limitations])]
      const grounded = groundAiInvestigatorDraft(expanded, preflight.facts, request, fleetTable(evidence))
      const referenceOmitted = new Set(references.issues.map((issue) => issue.findingIndex)).size
      const grounding = { acceptedUnchanged: grounded.content.findings.length, corrected: 0, omitted: grounded.omitted + referenceOmitted, correctionAttempted: false }
      if (!grounded.issues.length && !references.issues.length) return finish('complete', grounded.content, grounding)
      if (grounded.issues.length) safeLog(this.logger, 'info', { event: 'ai_investigator_grounding_rejected', architecture: 'single_synthesis', analysisId, issueCount: grounded.issues.length, issues: grounded.issues.map(({ findingRank, code }) => ({ findingRank, code })) })
      grounded.content.summary = 'Some AI interpretations could not be verified. Only findings grounded in deterministic ProcessIntelligence evidence are shown.'
      grounded.content.limitations = [...grounded.content.limitations, 'Some AI interpretations could not be verified against deterministic ProcessIntelligence evidence and were omitted.']
      return finish('partial', grounded.content, grounding)
    } catch (error) {
      const code = deadline.signal.aborted ? 'overall_timeout' : errorCode(error)
      safeLog(this.logger, 'error', { event: 'ai_investigator_failure', architecture: 'single_synthesis', analysisId, error: code, ...safeModelError(error) })
      const status = deadline.signal.aborted ? 'timeout' : 'error'
      return finish(status, partialContent(status, evidence, code), { acceptedUnchanged: 0, corrected: 0, omitted: 0, correctionAttempted: false })
    } finally { clearTimeout(deadlineTimer) }
  }

  analyze(request: AiInvestigatorRequest, requestSignal?: AbortSignal): Promise<AiInvestigatorResult> {
    return this.analyzeWithToolSelection(request, requestSignal)
  }

  async analyzeWithToolSelection(request: AiInvestigatorRequest, requestSignal?: AbortSignal): Promise<AiInvestigatorResult> {
    const analysisId = randomUUID(); const started = this.now(); const startedAt = started.toISOString(); const deadlineAt = Date.now() + this.config.totalTimeoutMs
    const deadline = new AbortController(); const deadlineTimer = setTimeout(() => deadline.abort(new AiTimeoutError('overall')), this.config.totalTimeoutMs)
    const signal = requestSignal ? AbortSignal.any([deadline.signal, requestSignal]) : deadline.signal
    const evidence: ToolEvidence[] = []; let toolCallsUsed = 0; let toolRounds = 0
    let modelRequestNumber = 0; let rateLimitRetryUsed = false; let cumulativeEstimatedInputTokens = 0; let cumulativeActualInputTokens = 0; let cumulativeActualOutputTokens = 0
    let grounding = { acceptedUnchanged: 0, corrected: 0, omitted: 0, correctionAttempted: false }
    const requestedWork = JSON.parse(requestPrompt(request)) as unknown
    safeLog(this.logger, 'info', { event: 'ai_investigator_started', analysisId, scope: request.scope.pressKey ?? 'all', startUtc: request.range.startUtc, endUtc: request.range.endUtc, modelConfigured: true, model: this.config.model })

    const finish = (status: AiInvestigatorResult['status'], content: AiInvestigatorContent) => {
      const completedAt = this.now().toISOString(); const result: AiInvestigatorResult = { analysisId, status, scope: { pressKey: request.scope.pressKey, startUtc: request.range.startUtc, endUtc: request.range.endUtc, analysis: request.analysis }, startedAt, completedAt, elapsedMs: Math.max(0, Date.parse(completedAt) - started.getTime()), toolCallsUsed, grounding, ...content }
      safeLog(this.logger, status === 'error' ? 'error' : 'info', { event: 'ai_investigator_finished', analysisId, status, elapsedMs: result.elapsedMs, toolCallsUsed, toolRounds, grounding })
      return result
    }

    const requestModel = async (phase: AiModelPhase, instructions: string, tools: AiInvestigatorToolDefinition[], toolChoice: AiModelToolChoice, phaseDetails: Record<string, unknown> = {}, priorModelResultsIncluded = 0) => {
      const state = compactInvestigationState(evidence)
      const input: unknown[] = [{ role: 'user', content: JSON.stringify({ request: requestedWork, state, phase, ...phaseDetails }) } satisfies ResponseInputItem]
      const evidenceBytes = evidence.reduce((sum, item) => sum + (item.result ? utf8Bytes(item.result) : 0), 0)
      const modelFacingEvidenceBytes = utf8Bytes(state)
      const estimatedInputTokens = estimateAiInputTokens(input, instructions, tools, toolChoice === 'none')
      const maxOutputTokens = toolChoice === 'auto' ? INVESTIGATION_OUTPUT_TOKENS : FINAL_OUTPUT_TOKENS
      while (true) {
        modelRequestNumber += 1; cumulativeEstimatedInputTokens += estimatedInputTokens
        const requestNumber = modelRequestNumber
        safeLog(this.logger, 'info', { event: 'ai_investigator_model_request', analysisId, requestNumber, phase, toolRound: toolRounds, toolCallsUsed, toolsEnabled: tools.length > 0 && toolChoice !== 'none', toolChoice, availableTools: tools.map((tool) => tool.name), estimatedInputTokens, cumulativeEstimatedInputTokens, maxOutputTokens, inputBytes: utf8Bytes(input), instructionBytes: utf8Bytes(instructions), toolDefinitionBytes: utf8Bytes(tools), evidenceBytes, modelFacingEvidenceBytes, toolResultsIncluded: state.collectedTools.filter((item) => item.ok).length, priorModelMessagesIncluded: 0, priorModelResultsIncluded })
        try {
          const response = await this.model.create(input, instructions, tools, toolChoice, signal)
          cumulativeActualInputTokens += response.usage?.inputTokens ?? 0; cumulativeActualOutputTokens += response.usage?.outputTokens ?? 0
          safeLog(this.logger, 'info', { event: 'ai_investigator_model_response', analysisId, requestNumber, responseId: response.id, phase, toolRound: toolRounds, toolCallsUsed, requestedTools: response.toolCalls.map((call) => call.name), usage: response.usage, cumulativeActualInputTokens, cumulativeActualOutputTokens, ...response.http })
          return response
        } catch (error) {
          const safeError = safeModelError(error)
          safeLog(this.logger, 'error', { event: 'ai_investigator_model_failure', analysisId, requestNumber, phase, toolRound: toolRounds, toolCallsUsed, toolsEnabled: tools.length > 0 && toolChoice !== 'none', toolChoice, ...safeError })
          const resetDelay = retryDelayMs(error); const jitterMs = 25 + Math.floor(this.random() * 76); const remainingMs = Math.max(0, deadlineAt - Date.now())
          const retryable = isRateLimit(error) && !rateLimitRetryUsed && resetDelay !== undefined && resetDelay + jitterMs + this.config.openAiTimeoutMs < remainingMs
          if (!retryable) throw error
          rateLimitRetryUsed = true
          safeLog(this.logger, 'info', { event: 'ai_investigator_model_retry', analysisId, requestNumber, phase, retryNumber: 1, waitMs: resetDelay + jitterMs, remainingMs, ...safeError })
          await this.wait(resetDelay + jitterMs, signal)
        }
      }
    }

    const synthesize = async (reason: string) => {
      const response = await requestModel('final_synthesis', FINAL_SYNTHESIS_INSTRUCTIONS, [], 'none', { evidenceCollectionComplete: true, reason })
      if (response.toolCalls.length || !response.outputText) throw new Error('invalid_final_synthesis')
      const draft = validateAiInvestigatorDraft(JSON.parse(response.outputText))
      const facts = groundingFacts(evidence); const tables = fleetTable(evidence)
      const first = groundAiInvestigatorDraft(draft, facts, request, tables)
      if (!first.issues.length) {
        grounding = { acceptedUnchanged: first.content.findings.length, corrected: 0, omitted: 0, correctionAttempted: false }
        return finish('complete', first.content)
      }
      grounding.correctionAttempted = true
      safeLog(this.logger, 'info', { event: 'ai_investigator_grounding_rejected', analysisId, issueCount: first.issues.length, issues: first.issues.map(({ findingRank, code }) => ({ findingRank, code })) })
      const correction = await requestModel('grounding_correction', CORRECTION_INSTRUCTIONS, [], 'none', { groundingCorrectionRequired: true, rejectedDraft: draft, issues: first.issues.map(({ findingRank, code, detail }) => ({ findingRank, code, detail })) }, 1)
      if (correction.toolCalls.length || !correction.outputText) throw new Error('invalid_grounding_correction')
      const correctedDraft = validateAiInvestigatorDraft(JSON.parse(correction.outputText))
      const corrected = groundAiInvestigatorDraft(correctedDraft, facts, request, tables)
      const unchanged = correctedDraft.findings.filter((item) => first.acceptedRanks.includes(item.rank) && draft.findings.some((original) => original.rank === item.rank && JSON.stringify(original) === JSON.stringify(item))).length
      grounding = { acceptedUnchanged: unchanged, corrected: corrected.content.findings.length - unchanged, omitted: corrected.omitted, correctionAttempted: true }
      if (!corrected.issues.length) return finish('complete', corrected.content)
      const content = corrected.content
      content.summary = 'Some AI interpretations could not be verified. Only findings grounded in deterministic ProcessIntelligence evidence are shown.'
      content.limitations = [...content.limitations, 'Some AI interpretations could not be verified against deterministic ProcessIntelligence evidence and were omitted.']
      return finish('partial', content)
    }

    try {
      while (!signal.aborted) {
        const response = await requestModel('investigation', SYSTEM_INSTRUCTIONS, this.registry.definitions, 'auto')
        if (!response.toolCalls.length) return await synthesize('model_completed_evidence_collection')
        if (toolRounds >= this.config.maxToolRounds) return await synthesize('maximum_tool_rounds_reached')
        toolRounds += 1
        const remaining = this.config.maxToolCalls - toolCallsUsed
        if (remaining <= 0) return await synthesize('maximum_tool_calls_reached')
        const executable = response.toolCalls.slice(0, remaining)
        const skipped = response.toolCalls.slice(remaining)
        const evidenceOffset = evidence.length
        for (let offset = 0; offset < executable.length; offset += this.config.maxParallelTools) {
          if (signal.aborted) throw new AiTimeoutError('overall')
          const batch = executable.slice(offset, offset + this.config.maxParallelTools)
          await Promise.all(batch.map(async (call) => {
            toolCallsUsed += 1
            let parsed: unknown
            const began = Date.now()
            try {
              parsed = parseToolArguments(call.arguments)
              const toolController = new AbortController(); const timer = setTimeout(() => toolController.abort(new AiTimeoutError('tool')), this.config.toolTimeoutMs)
              const toolSignal = AbortSignal.any([signal, toolController.signal])
              try {
                const operation = this.registry.execute(call.name, parsed, { requestId: analysisId, signal: toolSignal })
                const result = await Promise.race([operation, new Promise<never>((_resolve, reject) => toolSignal.addEventListener('abort', () => reject(toolSignal.reason ?? new AiTimeoutError('tool')), { once: true }))])
                const durationMs = Date.now() - began; const item = { name: call.name, arguments: parsed, result, durationMs }; evidence.push(item)
                safeLog(this.logger, 'info', { event: 'ai_investigator_tool', analysisId, tool: call.name, durationMs, success: true, payloadBytes: Buffer.byteLength(JSON.stringify(result), 'utf8') })
                return
              } finally { clearTimeout(timer) }
            } catch (error) {
              const code = errorCode(error); const durationMs = Date.now() - began; evidence.push({ name: call.name, arguments: parsed ?? null, error: code, durationMs })
              safeLog(this.logger, 'error', { event: 'ai_investigator_tool', analysisId, tool: call.name, durationMs, success: false, error: code })
              if (signal.aborted) throw new AiTimeoutError('overall')
              return
            }
          }))
        }
        const newEvidence = evidence.slice(evidenceOffset)
        const detailEvidenceComplete = newEvidence.some((item) => item.result && (item.name === 'get_press_event_summary' || item.name === 'get_event_context'))
        if (detailEvidenceComplete) return await synthesize('detail_evidence_collected')
        if (skipped.length || toolCallsUsed >= this.config.maxToolCalls) return await synthesize('maximum_tool_calls_reached')
        if (toolRounds >= this.config.maxToolRounds) return await synthesize('maximum_tool_rounds_reached')
      }
      throw new AiTimeoutError('overall')
    } catch (error) {
      if (deadline.signal.aborted || error instanceof AiTimeoutError && error.kind === 'overall') return finish('timeout', partialContent('timeout', evidence, `Maximum analysis time was ${Math.round(this.config.totalTimeoutMs / 1_000)} seconds.`))
      const code = errorCode(error)
      safeLog(this.logger, 'error', { event: 'ai_investigator_failure', analysisId, error: code })
      return finish('error', partialContent('error', evidence, code))
    } finally {
      clearTimeout(deadlineTimer)
    }
  }
}

export function createAiInvestigatorOrchestrator(config: AiInvestigatorConfig, registry: AiInvestigatorReadOnlyToolRegistry, logger: AiInvestigatorLogger | false = console): AiInvestigatorOrchestrator | undefined {
  if (!config.enabled || !config.apiKey) return undefined
  return new AiInvestigatorOrchestrator(config, registry, new OpenAiResponsesInvestigatorClient(config), logger)
}

export function investigatorDisplayName(pressKey: RadiusPressKey): string {
  return pressKey.replace('press', 'Press ')
}
