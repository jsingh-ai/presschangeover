import { randomUUID } from 'node:crypto'
import OpenAI from 'openai'
import type { ResponseInput, ResponseInputItem, ResponseOutputItem } from 'openai/resources/responses/responses'
import type { AiInvestigatorConfig } from '../config.js'
import type { RadiusPressKey } from '../radius/models.js'
import { AI_INVESTIGATOR_CONTENT_SCHEMA, type AiGroundingFact, type AiInvestigatorContent, type AiInvestigatorDraftContent, type AiInvestigatorRequest, type AiInvestigatorResult, validateAiInvestigatorDraft } from './contracts.js'
import { groundAiInvestigatorDraft } from './grounding.js'
import { AiInvestigatorReadOnlyToolRegistry, type AiInvestigatorToolDefinition, type AiToolResult } from './read-only-tools.js'

export interface AiInvestigatorLogger {
  info(message: string): void
  error(message: string): void
}

export interface AiModelToolCall { type: 'function_call'; callId: string; name: string; arguments: string }
export interface AiModelResponse {
  id: string
  outputText: string
  outputItems: unknown[]
  toolCalls: AiModelToolCall[]
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number }
}

export type AiModelPhase = 'investigation' | 'final_synthesis' | 'grounding_correction'
export type AiModelToolChoice = 'auto' | 'none'

export interface AiInvestigatorModelClient {
  create(input: unknown[], instructions: string, tools: AiInvestigatorToolDefinition[], toolChoice: AiModelToolChoice, signal: AbortSignal): Promise<AiModelResponse>
}

export class OpenAiResponsesInvestigatorClient implements AiInvestigatorModelClient {
  private readonly client: OpenAI

  constructor(private readonly config: AiInvestigatorConfig) {
    if (!config.apiKey) throw new Error('ai_investigator_not_configured')
    this.client = new OpenAI({ apiKey: config.apiKey, timeout: config.openAiTimeoutMs, maxRetries: 0 })
  }

  async create(input: unknown[], instructions: string, tools: AiInvestigatorToolDefinition[], toolChoice: AiModelToolChoice, signal: AbortSignal): Promise<AiModelResponse> {
    const response = await this.client.responses.create({
      model: this.config.model,
      instructions,
      input: input as ResponseInput,
      ...(tools.length ? { tools } : {}),
      tool_choice: toolChoice,
      include: ['reasoning.encrypted_content'],
      text: { verbosity: 'low', format: { type: 'json_schema', name: 'process_intelligence_investigation', strict: true, schema: AI_INVESTIGATOR_CONTENT_SCHEMA } },
      max_output_tokens: toolChoice === 'auto' ? 1_000 : 4_000,
      store: false,
    }, { signal, timeout: this.config.openAiTimeoutMs, maxRetries: 0 })
    const toolCalls = response.output.filter((item) => item.type === 'function_call').map((item) => ({ type: 'function_call' as const, callId: item.call_id, name: item.name, arguments: item.arguments }))
    return { id: response.id, outputText: response.output_text, outputItems: response.output as ResponseOutputItem[], toolCalls, usage: response.usage ? { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens, totalTokens: response.usage.total_tokens } : undefined }
  }
}

class AiTimeoutError extends Error {
  constructor(public readonly kind: 'overall' | 'tool') { super(`ai_${kind}_timeout`); this.name = 'AiTimeoutError' }
}

interface ToolEvidence { name: string; arguments: unknown; result?: AiToolResult; error?: string; durationMs: number }

const SYSTEM_INSTRUCTIONS = `You are the advisory ProcessIntelligence AI Investigator. You may use ONLY the supplied read-only functions. Never claim database, historian, filesystem, network, machine-control, Radius-control, MQTT, acknowledgement, or configuration access. Begin with get_fleet_operational_summary for the requested scope. Identify only materially different candidate presses, then use at most a few follow-up tools. Compare the requested period with the immediately preceding equal-duration baseline where useful. The supplied fact objects are authoritative. Every displayed deterministic fact must cite its exact factId. Never invent or recalculate numeric values, percentages, counts, durations, comparisons, identities, or timestamps; select the server-calculated current/baseline/delta fact IDs together. Do not create free-form timestamp ranges: cite timestamp fact IDs only. Evidence source is server-owned; do not reclassify Radius facts as telemetry. Null or unusable Job/Order/Recipe values are not evidence. Separate directly calculated FACTS, deterministic COMPARISONS, and cautious INTERPRETATIONS. Never assert a root cause or defect without evidence. Do not call behavior flat, unchanged, stable, or immaterial when selected comparison facts show a material change. Treat unavailable data as a limitation, never as a process event. If baseline evidence is insufficient, say "Insufficient baseline". Return no more than five ranked findings. Links must be relative ProcessIntelligence paths beginning with /raw-radius-explorer, /telemetry-event-explorer, /overview, or /operational-analysis. Do not emit HTML.`
const FINAL_SYNTHESIS_INSTRUCTIONS = `${SYSTEM_INSTRUCTIONS} Evidence collection is complete. Do not call tools. Produce the complete structured investigation using only facts already supplied in prior tool results.`
const CORRECTION_INSTRUCTIONS = `${SYSTEM_INSTRUCTIONS} This is the single grounding-correction response. Do not call any tools. Correct or omit each cited invalid finding using only fact IDs already supplied in prior tool results. Return the complete corrected structured response.`

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
  const candidate = error as { constructor?: { name?: string }; status?: unknown; code?: unknown; type?: unknown; request_id?: unknown }
  return {
    errorType: candidate.constructor?.name ?? 'Error',
    ...(typeof candidate.status === 'number' ? { status: candidate.status } : {}),
    ...(typeof candidate.code === 'string' ? { code: candidate.code } : {}),
    ...(typeof candidate.type === 'string' ? { type: candidate.type } : {}),
    ...(typeof candidate.request_id === 'string' ? { requestId: candidate.request_id } : {}),
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
    private readonly registry: AiInvestigatorReadOnlyToolRegistry,
    private readonly model: AiInvestigatorModelClient,
    private readonly logger: AiInvestigatorLogger | false = console,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async analyze(request: AiInvestigatorRequest, requestSignal?: AbortSignal): Promise<AiInvestigatorResult> {
    const analysisId = randomUUID(); const started = this.now(); const startedAt = started.toISOString()
    const deadline = new AbortController(); const deadlineTimer = setTimeout(() => deadline.abort(new AiTimeoutError('overall')), this.config.totalTimeoutMs)
    const signal = requestSignal ? AbortSignal.any([deadline.signal, requestSignal]) : deadline.signal
    const evidence: ToolEvidence[] = []; let toolCallsUsed = 0; let toolRounds = 0
    let grounding = { acceptedUnchanged: 0, corrected: 0, omitted: 0, correctionAttempted: false }
    let input: unknown[] = [{ role: 'user', content: requestPrompt(request) } satisfies ResponseInputItem]
    safeLog(this.logger, 'info', { event: 'ai_investigator_started', analysisId, scope: request.scope.pressKey ?? 'all', startUtc: request.range.startUtc, endUtc: request.range.endUtc, modelConfigured: true, model: this.config.model })

    const finish = (status: AiInvestigatorResult['status'], content: AiInvestigatorContent) => {
      const completedAt = this.now().toISOString(); const result: AiInvestigatorResult = { analysisId, status, scope: { pressKey: request.scope.pressKey, startUtc: request.range.startUtc, endUtc: request.range.endUtc, analysis: request.analysis }, startedAt, completedAt, elapsedMs: Math.max(0, Date.parse(completedAt) - started.getTime()), toolCallsUsed, grounding, ...content }
      safeLog(this.logger, status === 'error' ? 'error' : 'info', { event: 'ai_investigator_finished', analysisId, status, elapsedMs: result.elapsedMs, toolCallsUsed, toolRounds, grounding })
      return result
    }

    const requestModel = async (phase: AiModelPhase, instructions: string, tools: AiInvestigatorToolDefinition[], toolChoice: AiModelToolChoice) => {
      safeLog(this.logger, 'info', { event: 'ai_investigator_model_request', analysisId, phase, toolRound: toolRounds, toolCallsUsed, toolsEnabled: tools.length > 0 && toolChoice !== 'none', toolChoice, availableTools: tools.map((tool) => tool.name) })
      try {
        const response = await this.model.create(input, instructions, tools, toolChoice, signal)
        safeLog(this.logger, 'info', { event: 'ai_investigator_model_response', analysisId, responseId: response.id, phase, toolRound: toolRounds, toolCallsUsed, requestedTools: response.toolCalls.map((call) => call.name), usage: response.usage })
        return response
      } catch (error) {
        safeLog(this.logger, 'error', { event: 'ai_investigator_model_failure', analysisId, phase, toolRound: toolRounds, toolCallsUsed, toolsEnabled: tools.length > 0 && toolChoice !== 'none', toolChoice, ...safeModelError(error) })
        throw error
      }
    }

    const synthesize = async (reason: string) => {
      input.push({ role: 'user', content: JSON.stringify({ evidenceCollectionComplete: true, reason, instruction: 'Produce the final structured investigation from supplied evidence. Tools are disabled.' }) } satisfies ResponseInputItem)
      const response = await requestModel('final_synthesis', FINAL_SYNTHESIS_INSTRUCTIONS, [], 'none')
      input.push(...response.outputItems)
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
      input.push({ role: 'user', content: JSON.stringify({ groundingCorrectionRequired: true, issues: first.issues.map(({ findingRank, code, detail }) => ({ findingRank, code, detail })), instruction: 'Correct or omit invalid findings. Use only exact supplied fact IDs. Do not call tools.' }) } satisfies ResponseInputItem)
      const correction = await requestModel('grounding_correction', CORRECTION_INSTRUCTIONS, [], 'none')
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
        input.push(...response.outputItems)
        if (!response.toolCalls.length) return await synthesize('model_completed_evidence_collection')
        if (toolRounds >= this.config.maxToolRounds) return await synthesize('maximum_tool_rounds_reached')
        toolRounds += 1
        const remaining = this.config.maxToolCalls - toolCallsUsed
        if (remaining <= 0) return await synthesize('maximum_tool_calls_reached')
        const executable = response.toolCalls.slice(0, remaining)
        const skipped = response.toolCalls.slice(remaining)
        const outputs: unknown[] = []
        const evidenceOffset = evidence.length
        for (let offset = 0; offset < executable.length; offset += this.config.maxParallelTools) {
          if (signal.aborted) throw new AiTimeoutError('overall')
          const batch = executable.slice(offset, offset + this.config.maxParallelTools)
          const batchOutputs = await Promise.all(batch.map(async (call) => {
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
                return { type: 'function_call_output', call_id: call.callId, output: JSON.stringify({ ok: true, result }) }
              } finally { clearTimeout(timer) }
            } catch (error) {
              const code = errorCode(error); const durationMs = Date.now() - began; evidence.push({ name: call.name, arguments: parsed ?? null, error: code, durationMs })
              safeLog(this.logger, 'error', { event: 'ai_investigator_tool', analysisId, tool: call.name, durationMs, success: false, error: code })
              if (signal.aborted) throw new AiTimeoutError('overall')
              return { type: 'function_call_output', call_id: call.callId, output: JSON.stringify({ ok: false, error: code }) }
            }
          }))
          outputs.push(...batchOutputs)
        }
        outputs.push(...skipped.map((call) => ({ type: 'function_call_output', call_id: call.callId, output: JSON.stringify({ ok: false, error: 'maximum_tool_calls_reached' }) })))
        input.push(...outputs)
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
