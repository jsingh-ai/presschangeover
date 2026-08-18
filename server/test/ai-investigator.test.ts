import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { describe, it } from 'node:test'
import { createApp } from '../src/app.js'
import type { AiInvestigatorConfig } from '../src/config.js'
import type { RadiusOverview, RadiusPressEpisodes } from '../src/radius/models.js'
import type { RadiusService } from '../src/radius/radius-service.js'
import type { TelemetryFoundationService } from '../src/telemetry/telemetry-foundation-service.js'
import type { TelemetryClient } from '../src/telemetry/telemetry-api-client.js'
import { parseAiInvestigatorRequest, validateAiInvestigatorDraft, type AiGroundingFact, type AiInvestigatorDraftContent } from '../src/ai-investigator/contracts.js'
import { groundAiInvestigatorDraft } from '../src/ai-investigator/grounding.js'
import { AiInvestigatorReadOnlyToolRegistry, AI_INVESTIGATOR_TOOL_NAMES, sanitizeProductionContextIdentity } from '../src/ai-investigator/read-only-tools.js'
import { AiInvestigatorOrchestrator, compactInvestigationState, estimateAiInputTokens, safeOpenAiHttpMetadata, type AiInvestigatorLogger, type AiInvestigatorModelClient, type AiModelResponse, type AiModelToolChoice, type ToolEvidence } from '../src/ai-investigator/orchestrator.js'

const start = '2026-08-16T12:00:00.000Z'; const end = '2026-08-17T12:00:00.000Z'
const request = { scope: { pressKey: null }, range: { startUtc: start, endUtc: end }, analysis: 'discover_unusual_behavior' as const }
const config: AiInvestigatorConfig = { enabled: true, apiKey: 'test-secret-never-return', model: 'test-model', totalTimeoutMs: 500, toolTimeoutMs: 50, openAiTimeoutMs: 100, maxToolCalls: 8, maxToolRounds: 4, maxParallelTools: 3 }
const content: AiInvestigatorDraftContent = { summary: 'No material candidates selected.', findings: [], limitations: ['Advisory result.'] }
const draftFinding: AiInvestigatorDraftContent = { summary: 'One bounded finding.', findings: [{ rank: 1, pressKey: 'press11', title: 'More interruptions', importance: 'medium', confidence: 'medium', whyItMatters: 'The deterministic comparison warrants review.', facts: [{ label: 'Interruptions', factIds: ['press11.interruptions.current', 'press11.interruptions.baseline', 'press11.interruptions.delta'] }], timestampFactIds: [], evidenceFactIds: ['press11.interruptions.current'], productionContextFactIds: { job: null, order: null, recipe: null }, recommendedInvestigation: 'Open the synchronized evidence.', links: [{ label: 'Open Radius Explorer', href: '/raw-radius-explorer' }] }], limitations: ['Advisory result.'] }

function modelQueue(responses: AiModelResponse[]): AiInvestigatorModelClient {
  let index = 0
  return { create: async () => responses[index++] ?? { id: `response-${index}`, outputText: JSON.stringify(content), outputItems: [], toolCalls: [] } }
}

function responseWithCalls(...calls: Array<{ name: string; arguments: unknown }>): AiModelResponse {
  return { id: 'tool-response', outputText: '', outputItems: calls.map((call, index) => ({ type: 'function_call', call_id: `call-${index}`, name: call.name, arguments: JSON.stringify(call.arguments) })), toolCalls: calls.map((call, index) => ({ type: 'function_call', callId: `call-${index}`, name: call.name, arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments) })) }
}

const finalResponse: AiModelResponse = { id: 'final-response', outputText: JSON.stringify(content), outputItems: [], toolCalls: [], usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 } }

function overview(): RadiusOverview {
  return { fromUtc: start, toUtc: end, plantTimeZone: 'America/Chicago', productionStatusDescription: 'Run Production', stateBreakdownRunConfirmationSeconds: 300, rangeEndIsLive: false, feedStatus: 'ONLINE', lastObservationUtc: end, offlinePressCount: 0, onlinePressCount: 1, summary: { pressesMonitored: 1, currentlyRunProduction: 0, currentlyNonProduction: 1, openEpisodes: 0, totalNonProductionSeconds: 10_800 }, unmappedPressKeys: [], presses: [{ pressKey: 'press3', displayName: 'Press 3', radiusMachineId: 203, availability: 'online', lastRadiusStatus: null, lastObservationUtc: end, offlineSinceUtc: null, currentStatusDescription: 'Run Production', currentEventType: 'G', currentStatusAtUtc: end, isCurrentlyProduction: true, runProductionSeconds: 72_000, nonProductionSeconds: 10_800, offlineSeconds: 3_600, observedSeconds: 82_800, rangeSeconds: 86_400, dataCoveragePercent: 95.8, episodeCount: 2, openEpisodeCount: 0, longestEpisodeSeconds: 900, timelineSegments: [{ kind: 'radius', machineId: 203, pressKey: 'press3', displayName: 'Press 3', startUtc: start, endUtc: end, durationSeconds: 72_000, isOpen: false, sourceGeneration: 'compact', eventType: 'G', statusCode: '150', statusDescription: 'Run Production', isProduction: true }] }], episodeAnalysis: { sequenceFamilies: [] }, operationalAnalytics: { fromUtc: start, toUtc: end, scopePressKeys: ['press3'], scopePressCount: 1, annotationDisclaimer: '', coverage: { possibleSeconds: 86_400, observedSeconds: 82_800, unknownSeconds: 3_600, coveragePercentage: 95.8 }, categories: [], statusDrivers: [], productionStops: { anchorCount: 2, resolvedCount: 2, censoredCount: 0, outcomes: [], paths: [] }, beforeSuccessfulProduction: { anchorCount: 0, resolvedCount: 0, censoredCount: 0, outcomes: [], paths: [] }, afterMakeReady: { anchorCount: 0, resolvedCount: 0, censoredCount: 0, outcomes: [], paths: [], confirmedProductionCount: 0, returnedToMakeReadyCount: 0, enteredBadCount: 0, enteredSStateCount: 0, failedToReachConfirmedProductionCount: 0, unresolvedCount: 0, medianSecondsToConfirmedProduction: null, p90SecondsToConfirmedProduction: null }, relationshipGroups: [], anomalies: [] } }
}

function pressEpisodes(): RadiusPressEpisodes {
  const fleet = overview(); const press = fleet.presses[0]
  return {
    fromUtc: start, toUtc: end, plantTimeZone: fleet.plantTimeZone, stateBreakdownRunConfirmationSeconds: fleet.stateBreakdownRunConfirmationSeconds, rangeEndIsLive: false,
    press: { pressKey: 'press3', displayName: 'Press 3', machineId: 203 }, availability: 'online', lastRadiusStatus: null, lastObservationUtc: end, offlineSinceUtc: null,
    currentStatusDescription: press.currentStatusDescription, currentEventType: press.currentEventType, currentStatusAtUtc: press.currentStatusAtUtc, isCurrentlyProduction: press.isCurrentlyProduction,
    timelineSegments: press.timelineSegments, episodes: [], analysis: {}, operationalAnalytics: fleet.operationalAnalytics, runComparison: {},
    summary: { episodeCount: press.episodeCount, openEpisodeCount: press.openEpisodeCount, totalNonProductionSeconds: press.nonProductionSeconds, runProductionSeconds: press.runProductionSeconds, offlineSeconds: press.offlineSeconds, observedSeconds: press.observedSeconds, rangeSeconds: press.rangeSeconds, dataCoveragePercent: press.dataCoveragePercent, averageEpisodeSeconds: 450, longestEpisodeSeconds: press.longestEpisodeSeconds },
  } as unknown as RadiusPressEpisodes
}

function press14Overview(): RadiusOverview {
  const fleet = overview()
  const source = fleet.presses[0]
  return {
    ...fleet,
    presses: [{
      ...source,
      pressKey: 'press14',
      displayName: 'Press 14',
      radiusMachineId: 214,
      timelineSegments: source.timelineSegments.map((segment) => ({ ...segment, pressKey: 'press14', displayName: 'Press 14', machineId: 214 })),
    }],
    operationalAnalytics: { ...fleet.operationalAnalytics, scopePressKeys: ['press14'] },
  }
}

function press14Radius(): RadiusService {
  const load = async () => press14Overview()
  return {
    getHealth: async () => ({ status: 'healthy', configured: true }),
    getOverview: load,
    getAnalysisOverview: load,
    getPressEpisodes: async () => {
      const fleet = press14Overview(); const press = fleet.presses[0]
      return {
        ...pressEpisodes(),
        press: { pressKey: 'press14', displayName: 'Press 14', machineId: 214 },
        timelineSegments: press.timelineSegments,
        operationalAnalytics: fleet.operationalAnalytics,
      } as RadiusPressEpisodes
    },
    getEpisode: async () => { throw new Error('unused') },
  }
}

function radiusWithOverview(load: () => Promise<RadiusOverview>): RadiusService {
  return { getHealth: async () => ({ status: 'healthy', configured: true }), getOverview: load, getAnalysisOverview: load, getPressEpisodes: async () => pressEpisodes(), getEpisode: async () => { throw new Error('unused') } }
}

function registry(radius: RadiusService) { return new AiInvestigatorReadOnlyToolRegistry(radius, {} as TelemetryFoundationService) }

describe('AI Investigator read-only boundary', () => {
  it('contains only the four approved typed read-only tools and no generic database capability', () => {
    assert.deepEqual(AI_INVESTIGATOR_TOOL_NAMES, ['get_fleet_operational_summary', 'compare_press_period', 'get_press_event_summary', 'get_event_context'])
    assert.ok(AI_INVESTIGATOR_TOOL_NAMES.every((name) => !/sql|database|shell|http|mqtt|write|ack|config/i.test(name)))
    assert.ok(registry(radiusWithOverview(async () => overview())).definitions.every(({ type, strict, parameters }) => type === 'function' && strict && parameters.additionalProperties === false))
  })

  it('rejects unknown tools and malformed model arguments before a data service is called', async () => {
    let calls = 0; const tools = registry(radiusWithOverview(async () => { calls += 1; return overview() }))
    await assert.rejects(tools.execute('execute_sql', { sql: 'select 1' }, { requestId: 'one', signal: new AbortController().signal }), /unknown_ai_investigator_tool/)
    const orchestrator = new AiInvestigatorOrchestrator(config, tools, modelQueue([{ id: 'bad', outputText: '', outputItems: [], toolCalls: [{ type: 'function_call', callId: 'one', name: 'get_fleet_operational_summary', arguments: '{bad json' }] }, finalResponse]), false)
    const result = await orchestrator.analyze(request)
    assert.equal(result.status, 'complete'); assert.equal(calls, 0)
  })

  it('rejects invalid presses, excessive ranges, and excessive result limits', async () => {
    assert.throws(() => parseAiInvestigatorRequest({ ...request, scope: { pressKey: 'press4' } }), /invalid_ai_investigator_press/)
    assert.throws(() => parseAiInvestigatorRequest({ ...request, range: { startUtc: '2026-08-01T00:00:00.000Z', endUtc: end } }), /invalid_ai_investigator_range/)
    const tools = registry(radiusWithOverview(async () => overview()))
    await assert.rejects(tools.execute('get_press_event_summary', { press: 'press3', start, end, topN: 11 }, { requestId: 'one', signal: new AbortController().signal }), /invalid_ai_tool_limit/)
    await assert.rejects(tools.execute('get_press_event_summary', { press: 'press3', start: '2026-08-15T11:59:59.000Z', end, topN: 5 }, { requestId: 'one', signal: new AbortController().signal }), /invalid_ai_tool_range/)
    await assert.rejects(tools.execute('get_fleet_operational_summary', { press: 'press4', start, end }, { requestId: 'one', signal: new AbortController().signal }), /invalid_ai_tool_press/)
  })

  it('bounds tool payloads to compact evidence measured in KB', async () => {
    const result = await registry(radiusWithOverview(async () => overview())).execute('get_fleet_operational_summary', { press: null, start, end }, { requestId: 'one', signal: new AbortController().signal })
    const bytes = Buffer.byteLength(JSON.stringify(result), 'utf8')
    assert.ok(bytes > 100 && bytes < 10 * 1024, `payload was ${bytes} bytes`)
  })

  it('enforces the per-tool timeout and can still produce a structured final response', async () => {
    const never = () => new Promise<RadiusOverview>(() => {})
    const toolCall = responseWithCalls({ name: 'get_fleet_operational_summary', arguments: { start, end, press: null } })
    const began = Date.now(); const result = await new AiInvestigatorOrchestrator({ ...config, toolTimeoutMs: 20 }, registry(radiusWithOverview(never)), modelQueue([toolCall, finalResponse]), false).analyze(request)
    assert.equal(result.status, 'complete'); assert.equal(result.toolCallsUsed, 1); assert.ok(Date.now() - began < 300)
  })

  it('overall deadline cancels the active query and does not begin additional tools', async () => {
    let calls = 0; const never = async () => { calls += 1; return new Promise<RadiusOverview>(() => {}) }
    const proposed = responseWithCalls({ name: 'get_fleet_operational_summary', arguments: { start, end, press: null } }, { name: 'get_fleet_operational_summary', arguments: { start, end, press: 'press3' } })
    const result = await new AiInvestigatorOrchestrator({ ...config, totalTimeoutMs: 25, toolTimeoutMs: 200, maxParallelTools: 1 }, registry(radiusWithOverview(never)), modelQueue([proposed]), false).analyze(request)
    assert.equal(result.status, 'timeout'); assert.equal(calls, 1)
  })

  it('enforces maximum total tool calls and tool rounds', async () => {
    let calls = 0; const load = async () => { calls += 1; return overview() }; const proposed = responseWithCalls({ name: 'get_fleet_operational_summary', arguments: { start, end, press: null } }, { name: 'get_fleet_operational_summary', arguments: { start, end, press: 'press3' } })
    const callLimited = await new AiInvestigatorOrchestrator({ ...config, maxToolCalls: 1 }, registry(radiusWithOverview(load)), modelQueue([proposed]), false).analyze(request)
    assert.equal(callLimited.status, 'complete'); assert.equal(callLimited.toolCallsUsed, 1); assert.equal(calls, 1)
    const oneCall = responseWithCalls({ name: 'get_fleet_operational_summary', arguments: { start, end, press: null } })
    const roundLimited = await new AiInvestigatorOrchestrator({ ...config, maxToolRounds: 1 }, registry(radiusWithOverview(load)), modelQueue([oneCall, finalResponse]), false).analyze(request)
    assert.equal(roundLimited.status, 'complete'); assert.equal(roundLimited.toolCallsUsed, 1); assert.equal(calls, 2)
  })

  it('allows four full tool rounds and then performs explicit tool-free synthesis', async () => {
    const oneCall = responseWithCalls({ name: 'get_fleet_operational_summary', arguments: { start, end, press: null } })
    const responses = [oneCall, oneCall, oneCall, oneCall, finalResponse]; let index = 0; const choices: AiModelToolChoice[] = []; const toolCounts: number[] = []
    const model: AiInvestigatorModelClient = { create: async (_input, _instructions, tools, toolChoice) => { toolCounts.push(tools.length); choices.push(toolChoice); return responses[index++] } }
    const result = await new AiInvestigatorOrchestrator(config, registry(radiusWithOverview(async () => overview())), model, false).analyze(request)
    assert.equal(result.status, 'complete'); assert.equal(result.toolCallsUsed, 4)
    assert.deepEqual(toolCounts, [4, 4, 4, 4, 0]); assert.deepEqual(choices, ['auto', 'auto', 'auto', 'auto', 'none'])
  })

  it('reproduces single-press evidence collection and transitions to tool-free grounded synthesis', async () => {
    const pressRequest = { ...request, scope: { pressKey: 'press3' as const } }
    const baselineStart = '2026-08-15T12:00:00.000Z'
    const grounded: AiInvestigatorDraftContent = { ...draftFinding, findings: [{ ...draftFinding.findings[0], pressKey: 'press3', facts: [{ label: 'Production', factIds: ['press3.production_percent.current'] }], evidenceFactIds: ['press3.production_percent.current'] }] }
    const responses = [
      responseWithCalls({ name: 'get_fleet_operational_summary', arguments: { start, end, press: 'press3' } }),
      responseWithCalls({ name: 'compare_press_period', arguments: { press: 'press3', currentStart: start, currentEnd: end, baselineStart, baselineEnd: start } }),
      responseWithCalls({ name: 'get_press_event_summary', arguments: { press: 'press3', start, end, topN: 5 } }),
      { id: 'grounded-final', outputText: JSON.stringify(grounded), outputItems: [], toolCalls: [] } satisfies AiModelResponse,
    ]
    let index = 0; const choices: AiModelToolChoice[] = []; const toolCounts: number[] = []
    const model: AiInvestigatorModelClient = { create: async (_input, _instructions, tools, toolChoice) => { toolCounts.push(tools.length); choices.push(toolChoice); return responses[index++] } }
    const result = await new AiInvestigatorOrchestrator(config, registry(radiusWithOverview(async () => overview())), model, false).analyze(pressRequest)
    assert.equal(result.status, 'complete'); assert.equal(result.toolCallsUsed, 3); assert.equal(result.findings.length, 1)
    assert.deepEqual(toolCounts, [4, 4, 4, 0]); assert.deepEqual(choices, ['auto', 'auto', 'auto', 'none'])
  })

  it('does not dispatch a function call returned during final synthesis', async () => {
    let calls = 0; const load = async () => { calls += 1; return overview() }
    const forbiddenFinalCall = responseWithCalls({ name: 'get_fleet_operational_summary', arguments: { start, end, press: null } })
    const result = await new AiInvestigatorOrchestrator(config, registry(radiusWithOverview(load)), modelQueue([finalResponse, forbiddenFinalCall]), false).analyze(request)
    assert.equal(result.status, 'error'); assert.equal(result.toolCallsUsed, 0); assert.equal(calls, 0); assert.match(result.limitations.join(' '), /invalid_final_synthesis/)
  })

  it('reports an OpenAI token-rate rejection accurately instead of tool_unavailable', async () => {
    const rateLimit = Object.assign(new Error('Rate limit reached for tokens'), { status: 429, code: 'rate_limit_exceeded', type: 'tokens' })
    const model: AiInvestigatorModelClient = { create: async () => { throw rateLimit } }
    const result = await new AiInvestigatorOrchestrator(config, registry(radiusWithOverview(async () => overview())), model, false).analyze(request)
    assert.equal(result.status, 'error'); assert.equal(result.summary, 'AI Investigator is temporarily rate limited. Try again after the token window resets.'); assert.deepEqual(result.limitations, ['No unsupported root-cause conclusion was generated.'])
  })

  it('retains grounding facts once without replaying raw tool or model payloads', () => {
    const fact = groundingFact({ factId: 'press14.production_percent.current', pressKey: 'press14', metric: 'productionPercent', value: 40.7, unit: 'percent', role: 'current', range: { start, end } })
    const result = { presses: [{ pressKey: 'press14', largeRawField: 'do-not-resend' }], facts: [fact], limitations: ['Bounded evidence.'] }
    const evidence: ToolEvidence[] = [
      { name: 'get_fleet_operational_summary', arguments: { start, end, press: 'press14' }, result, durationMs: 1 },
      { name: 'get_fleet_operational_summary', arguments: { start, end, press: 'press14' }, result, durationMs: 1 },
    ]
    const state = compactInvestigationState(evidence); const serialized = JSON.stringify(state)
    assert.equal(state.collectedTools.length, 1); assert.equal(state.facts.length, 1)
    assert.match(serialized, /press14\.production_percent\.current/); assert.match(serialized, /"role":"current"/); assert.match(serialized, /"unit":"percent"/); assert.match(serialized, /"usable":true/)
    assert.doesNotMatch(serialized, /largeRawField|do-not-resend|function_call_output|outputItems/)
  })

  it('measures a material mocked transcript reduction before deployment', async () => {
    const tools = registry(radiusWithOverview(async () => overview())); const signal = new AbortController().signal; const baselineStart = '2026-08-15T12:00:00.000Z'
    const calls = [
      { name: 'get_fleet_operational_summary', arguments: { start, end, press: 'press3' } },
      { name: 'compare_press_period', arguments: { press: 'press3', currentStart: start, currentEnd: end, baselineStart, baselineEnd: start } },
      { name: 'get_press_event_summary', arguments: { press: 'press3', start, end, topN: 5 } },
    ] as const
    const fullResults = await Promise.all(calls.map((call) => tools.execute(call.name, call.arguments, { requestId: 'measurement', signal })))
    const grounded: AiInvestigatorDraftContent = { ...draftFinding, findings: [{ ...draftFinding.findings[0], pressKey: 'press3', facts: [{ label: 'Production', factIds: ['press3.production_percent.current'] }], evidenceFactIds: ['press3.production_percent.current'] }] }
    const queued = calls.map((call) => responseWithCalls(call)); queued.push({ id: 'measurement-final', outputText: JSON.stringify(grounded), outputItems: [], toolCalls: [] })
    const observed: Array<{ input: unknown[]; instructions: string; tools: typeof tools.definitions; choice: AiModelToolChoice }> = []; let index = 0
    const model: AiInvestigatorModelClient = { create: async (input, instructions, definitions, choice) => { observed.push({ input, instructions, tools: definitions, choice }); return queued[index++] } }
    const result = await new AiInvestigatorOrchestrator(config, tools, model, false).analyze({ ...request, scope: { pressKey: 'press3' } })
    assert.equal(result.status, 'complete'); assert.equal(observed.length, 4)

    const legacyInputs: unknown[][] = [structuredClone(observed[0].input)]; const evidenceBytes = [0]
    for (let turn = 0; turn < calls.length; turn += 1) {
      const next = structuredClone(legacyInputs[turn]); next.push(...queued[turn].outputItems, { type: 'function_call_output', call_id: `call-${turn}`, output: JSON.stringify({ ok: true, result: fullResults[turn] }) })
      legacyInputs.push(next); evidenceBytes.push(evidenceBytes[turn] + Buffer.byteLength(JSON.stringify(fullResults[turn]), 'utf8'))
    }
    const before = observed.map((item, turn) => estimateAiInputTokens(legacyInputs[turn], item.instructions, item.tools, true)); const after = observed.map((item) => estimateAiInputTokens(item.input, item.instructions, item.tools, item.choice === 'none'))
    const beforeCumulative = before.reduce((sum, value) => sum + value, 0); const afterCumulative = after.reduce((sum, value) => sum + value, 0); const reductionPercent = Math.round((1 - afterCumulative / beforeCumulative) * 1_000) / 10
    const measurement = { before: { perTurnEstimatedInputTokens: before, cumulativeEstimatedInputTokens: beforeCumulative, evidenceBytes, outputReservations: [1000, 1000, 1000, 4000], cumulativeReservedOutputTokens: 7000 }, after: { perTurnEstimatedInputTokens: after, cumulativeEstimatedInputTokens: afterCumulative, evidenceBytes, modelFacingEvidenceBytes: observed.map((item) => Buffer.byteLength(JSON.stringify(item.input), 'utf8')), outputReservations: [600, 600, 600, 2400], cumulativeReservedOutputTokens: 4200 }, reductionPercent }
    console.log(`AI_INVESTIGATOR_TOKEN_MEASUREMENT ${JSON.stringify(measurement)}`)
    assert.ok(reductionPercent >= 30, `expected at least 30% reduction, measured ${reductionPercent}%`)
  })

  it('captures only allowlisted OpenAI response metadata', () => {
    const metadata = safeOpenAiHttpMetadata(new Headers({ 'x-request-id': 'req-safe', 'openai-processing-ms': '17', 'x-ratelimit-limit-tokens': '30000', 'x-ratelimit-remaining-tokens': '12000', 'x-ratelimit-reset-tokens': '3s', 'x-ratelimit-limit-requests': '500', 'x-ratelimit-remaining-requests': '499', 'x-ratelimit-reset-requests': '1s', 'x-ratelimit-limit-project-tokens': '60000', 'x-ratelimit-remaining-project-tokens': '42000', 'x-ratelimit-reset-project-tokens': '4s', 'retry-after': '2', authorization: 'Bearer never-log' }))
    assert.deepEqual(metadata, { requestId: 'req-safe', processingMs: '17', limitTokens: '30000', remainingTokens: '12000', resetTokens: '3s', limitRequests: '500', remainingRequests: '499', resetRequests: '1s', limitProjectTokens: '60000', remainingProjectTokens: '42000', resetProjectTokens: '4s', retryAfter: '2' })
    assert.doesNotMatch(JSON.stringify(metadata), /authorization|Bearer/)
  })

  it('logs bounded request measurements, actual usage, and safe response metadata', async () => {
    const entries: Array<Record<string, unknown>> = []; const logger: AiInvestigatorLogger = { info: (value) => entries.push(JSON.parse(value) as Record<string, unknown>), error: (value) => entries.push(JSON.parse(value) as Record<string, unknown>) }
    const response = { ...finalResponse, http: { requestId: 'req-safe', processingMs: '12', remainingTokens: '9000', resetTokens: '1s' } }
    await new AiInvestigatorOrchestrator(config, registry(radiusWithOverview(async () => overview())), modelQueue([response, response]), logger).analyze(request)
    const requests = entries.filter((item) => item.event === 'ai_investigator_model_request'); const responses = entries.filter((item) => item.event === 'ai_investigator_model_response')
    assert.deepEqual(requests.map((item) => item.requestNumber), [1, 2]); assert.deepEqual(requests.map((item) => item.maxOutputTokens), [600, 2400])
    assert.ok(requests.every((item) => typeof item.estimatedInputTokens === 'number' && item.priorModelMessagesIncluded === 0)); assert.equal(responses[0].requestId, 'req-safe'); assert.equal(responses[0].remainingTokens, '9000'); assert.equal(responses[0].cumulativeActualInputTokens, 100)
  })

  it('retries one genuine 429 only when its reset fits the authoritative 45-second deadline', async () => {
    let calls = 0; const waits: number[] = []
    const rateLimit = () => Object.assign(new Error('rate limited'), { status: 429, code: 'rate_limit_exceeded', type: 'tokens', request_id: 'req-rate', headers: new Headers({ 'retry-after': '0', 'x-ratelimit-reset-tokens': '0s' }) })
    const model: AiInvestigatorModelClient = { create: async () => { calls += 1; if (calls === 1) throw rateLimit(); return finalResponse } }
    const result = await new AiInvestigatorOrchestrator({ ...config, totalTimeoutMs: 45_000 }, registry(radiusWithOverview(async () => overview())), model, false, () => new Date(), () => 0, async (milliseconds) => { waits.push(milliseconds) }).analyze(request)
    assert.equal(result.status, 'complete'); assert.equal(calls, 3); assert.deepEqual(waits, [25])
  })

  it('does not retry a 429 whose reset cannot fit the deadline', async () => {
    let calls = 0
    const rateLimit = Object.assign(new Error('rate limited'), { status: 429, code: 'rate_limit_exceeded', type: 'tokens', headers: new Headers({ 'retry-after': '30', 'x-ratelimit-reset-tokens': '30s' }) })
    const model: AiInvestigatorModelClient = { create: async () => { calls += 1; throw rateLimit } }
    const result = await new AiInvestigatorOrchestrator({ ...config, totalTimeoutMs: 45_000, openAiTimeoutMs: 20_000 }, registry(radiusWithOverview(async () => overview())), model, false).analyze(request)
    assert.equal(result.status, 'error'); assert.equal(calls, 1)
  })

  it('never loops when the single bounded retry also receives 429', async () => {
    let calls = 0; const rateLimit = Object.assign(new Error('rate limited'), { status: 429, code: 'rate_limit_exceeded', type: 'tokens', headers: new Headers({ 'retry-after': '0' }) })
    const model: AiInvestigatorModelClient = { create: async () => { calls += 1; throw rateLimit } }
    const result = await new AiInvestigatorOrchestrator({ ...config, totalTimeoutMs: 45_000 }, registry(radiusWithOverview(async () => overview())), model, false, () => new Date(), () => 0, async () => {}).analyze(request)
    assert.equal(result.status, 'error'); assert.equal(calls, 2)
  })

  it('performs at most one no-tool grounding correction and returns grounded content', async () => {
    const invalid: AiInvestigatorDraftContent = { ...draftFinding, findings: [{ ...draftFinding.findings[0], pressKey: 'press3', facts: [{ label: 'Production', factIds: ['press3.invented.value'] }], evidenceFactIds: ['press3.invented.value'] }] }
    const corrected: AiInvestigatorDraftContent = { ...draftFinding, findings: [{ ...draftFinding.findings[0], pressKey: 'press3', facts: [{ label: 'Production', factIds: ['press3.production_percent.current'] }], evidenceFactIds: ['press3.production_percent.current'] }] }
    const responses = [responseWithCalls({ name: 'get_fleet_operational_summary', arguments: { start, end, press: null } }), finalResponse, { id: 'invalid', outputText: JSON.stringify(invalid), outputItems: [], toolCalls: [] } satisfies AiModelResponse, { id: 'corrected', outputText: JSON.stringify(corrected), outputItems: [], toolCalls: [] } satisfies AiModelResponse]
    let index = 0; const toolCounts: number[] = []; const choices: AiModelToolChoice[] = []
    const model: AiInvestigatorModelClient = { create: async (_input, _instructions, tools, toolChoice) => { toolCounts.push(tools.length); choices.push(toolChoice); return responses[index++] } }
    const result = await new AiInvestigatorOrchestrator(config, registry(radiusWithOverview(async () => overview())), model, false).analyze(request)
    assert.equal(result.status, 'complete'); assert.equal(result.toolCallsUsed, 1)
    assert.deepEqual(toolCounts, [4, 4, 0, 0]); assert.deepEqual(choices, ['auto', 'auto', 'none', 'none']); assert.deepEqual(result.grounding, { acceptedUnchanged: 0, corrected: 1, omitted: 0, correctionAttempted: true })
    assert.equal(result.findings[0].facts[0].value, '87%')
  })

  it('validates the strict final contract and rejects arbitrary or unsafe output', () => {
    assert.deepEqual(validateAiInvestigatorDraft(content), content)
    assert.throws(() => validateAiInvestigatorDraft({ ...content, html: '<script>' }), /invalid_investigator_response/)
    assert.throws(() => validateAiInvestigatorDraft({ ...draftFinding, findings: [{ ...draftFinding.findings[0], links: [{ label: 'bad', href: 'https://internal.example' }] }] }), /invalid_investigator_response/)
    assert.throws(() => validateAiInvestigatorDraft({ ...draftFinding, findings: [{ ...draftFinding.findings[0], timestampFactIds: ['press11.event.bad'], extra: 'bad' }] }), /invalid_investigator_response/)
  })
})

function groundingFact(overrides: Partial<AiGroundingFact> & Pick<AiGroundingFact, 'factId' | 'pressKey' | 'metric' | 'value' | 'role'>): AiGroundingFact {
  return { press: overrides.pressKey.replace('press', 'Press '), source: 'radius', unit: null, usable: overrides.value !== null, label: overrides.metric, ...overrides }
}

describe('AI Investigator deterministic grounding', () => {
  const press14Facts: AiGroundingFact[] = [
    groundingFact({ factId: 'press14.longest_interruption_minutes.current', pressKey: 'press14', metric: 'longestInterruptionMinutes', value: 384.7, unit: 'minutes', role: 'current' }),
    groundingFact({ factId: 'press14.longest_interruption_minutes.baseline', pressKey: 'press14', metric: 'longestInterruptionMinutes', value: 549.8, unit: 'minutes', role: 'baseline' }),
    groundingFact({ factId: 'press14.longest_interruption_minutes.delta', pressKey: 'press14', source: 'comparison', metric: 'longestInterruptionDeltaMinutes', value: -165.1, unit: 'minutes', role: 'delta' }),
  ]

  it('reconstructs the Press 14 baseline and negative delta without accepting model-owned values', () => {
    const draft: AiInvestigatorDraftContent = { ...draftFinding, findings: [{ ...draftFinding.findings[0], pressKey: 'press14', facts: [{ label: 'Longest interruption', factIds: press14Facts.map((item) => item.factId) }], evidenceFactIds: ['press14.longest_interruption_minutes.current'] }] }
    const result = groundAiInvestigatorDraft(draft, press14Facts, request)
    assert.equal(result.issues.length, 0)
    assert.equal(result.content.findings[0].facts[0].comparison, 'Current 384.7 min; baseline 549.8 min; change -165.1 min')
    assert.doesNotMatch(JSON.stringify(result.content), /225\.1|\+165\.1/)
    const invented = { ...draft, findings: [{ ...draft.findings[0], whyItMatters: 'The baseline was 225.1 min and the interruption increased 159.6 min.' }] }
    assert.ok(groundAiInvestigatorDraft(invented, press14Facts, request).issues.some((item) => item.code === 'unsupported_numeric_claim'))
  })

  it('catches Press 6 flat language when interruptions changed from 9 to 14', () => {
    const facts = [
      groundingFact({ factId: 'press6.interruptions.current', pressKey: 'press6', metric: 'interruptions', value: 14, unit: 'count', role: 'current' }),
      groundingFact({ factId: 'press6.interruptions.baseline', pressKey: 'press6', metric: 'interruptions', value: 9, unit: 'count', role: 'baseline' }),
      groundingFact({ factId: 'press6.interruptions.delta', pressKey: 'press6', source: 'comparison', metric: 'interruptionDelta', value: 5, unit: 'count', role: 'delta' }),
    ]
    const draft: AiInvestigatorDraftContent = { ...draftFinding, findings: [{ ...draftFinding.findings[0], pressKey: 'press6', title: 'Essentially flat', whyItMatters: 'No material change was seen.', facts: [{ label: 'Interruptions', factIds: facts.map((item) => item.factId) }], evidenceFactIds: ['press6.interruptions.current'] }] }
    const result = groundAiInvestigatorDraft(draft, facts, request)
    assert.equal(result.content.findings.length, 0)
    assert.ok(result.issues.some((item) => item.code === 'interpretation_contradiction'))
  })

  it('rejects unknown, malformed timestamp, and cross-press references', () => {
    const timestamp = groundingFact({ factId: 'press14.event.valid.timestamp', pressKey: 'press14', metric: 'eventTimestamp', value: '2026-08-17T04:00:00.000Z', unit: 'iso8601', role: 'event', timestamp: '2026-08-17T04:00:00.000Z', range: { start, end } })
    const malformed = { ...timestamp, factId: 'press14.event.bad.timestamp', value: '2026-08-17T4', timestamp: '2026-08-17T4' }
    const base = { ...draftFinding.findings[0], pressKey: 'press14' as const, facts: [{ label: 'Longest interruption', factIds: press14Facts.map((item) => item.factId) }], evidenceFactIds: ['press14.longest_interruption_minutes.current'] }
    assert.equal(groundAiInvestigatorDraft({ ...draftFinding, findings: [{ ...base, timestampFactIds: [timestamp.factId] }] }, [...press14Facts, timestamp], request).issues.length, 0)
    assert.ok(groundAiInvestigatorDraft({ ...draftFinding, findings: [{ ...base, timestampFactIds: [malformed.factId] }] }, [...press14Facts, malformed], request).issues.some((item) => item.code === 'invalid_grounded_timestamp'))
    assert.ok(groundAiInvestigatorDraft({ ...draftFinding, findings: [{ ...base, facts: [{ label: 'Invented', factIds: ['press14.unknown.fact'] }] }] }, press14Facts, request).issues.some((item) => item.code === 'unknown_fact_id'))
    assert.ok(groundAiInvestigatorDraft({ ...draftFinding, findings: [{ ...base, facts: [{ label: 'Wrong press', factIds: ['press10.interruptions.current'] }] }] }, [groundingFact({ factId: 'press10.interruptions.current', pressKey: 'press10', metric: 'interruptions', value: 7, role: 'current' })], request).issues.some((item) => item.code === 'cross_press_fact'))
  })

  it('uses authoritative source buckets and sanitizes unusable production identities', () => {
    const radius = groundingFact({ factId: 'press14.production_percent.current', pressKey: 'press14', metric: 'productionPercent', value: 37.5, unit: 'percent', role: 'current' })
    const draft: AiInvestigatorDraftContent = { ...draftFinding, findings: [{ ...draftFinding.findings[0], pressKey: 'press14', facts: [{ label: 'Production', factIds: [radius.factId] }], evidenceFactIds: [radius.factId] }] }
    const finding = groundAiInvestigatorDraft(draft, [radius], request).content.findings[0]
    assert.deepEqual(finding.telemetryEvidence, []); assert.deepEqual(finding.radiusEvidence, ['productionPercent: 37.5%'])
    assert.deepEqual(sanitizeProductionContextIdentity('[0,0,0,0,0,0]'), { value: null, usable: false })
    assert.deepEqual(sanitizeProductionContextIdentity('0'), { value: '0', usable: true })
  })
})

const telemetryClient: TelemetryClient = { getHealth: async () => ({ service: 'TelemetryQueryApi', status: 'healthy' }), getDatabaseHealth: async () => ({ service: 'TelemetryQueryApi', database: 'historian', status: 'healthy' }), getSources: async () => [], getPhysicalState: async () => { throw new Error('unused') } }

async function call(path: string, options?: RequestInit, appConfig?: AiInvestigatorConfig, model?: AiInvestigatorModelClient, radiusService?: RadiusService) {
  const app = createApp({ telemetryClient, radiusService, logger: false, aiInvestigatorConfig: appConfig, aiInvestigatorModelClient: model })
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>((resolve) => server.once('listening', resolve)); const address = server.address() as AddressInfo
  try { const response = await fetch(`http://127.0.0.1:${address.port}${path}`, options); return { status: response.status, text: await response.text() } } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) }
}

describe('AI Investigator HTTP boundary', () => {
  it('parses one valid Press 14 JSON object and reaches the discovery orchestrator exactly once', async () => {
    let modelCalls = 0
    const model: AiInvestigatorModelClient = { create: async (input) => {
      modelCalls += 1
      assert.equal(typeof input[0], 'object')
      return { ...finalResponse, id: 'press14-http-boundary' }
    } }
    const press14Request = { ...request, scope: { pressKey: 'press14' as const } }
    const result = await call('/api/ai-investigator/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(press14Request) }, config, model, press14Radius())
    assert.equal(result.status, 200)
    assert.equal((JSON.parse(result.text) as { status: string }).status, 'complete')
    assert.equal(modelCalls, 1)
  })

  it('returns invalid_request_body for malformed JSON without reaching the model', async () => {
    let modelCalls = 0
    const model: AiInvestigatorModelClient = { create: async () => { modelCalls += 1; return finalResponse } }
    const result = await call('/api/ai-investigator/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{scope:{pressKey:"press14"}}' }, config, model, press14Radius())
    assert.equal(result.status, 400)
    assert.deepEqual(JSON.parse(result.text), { error: 'invalid_request_body' })
    assert.equal(modelCalls, 0)
  })

  it('rejects invalid press, range, and analysis schemas without reaching the model', async () => {
    let modelCalls = 0
    const model: AiInvestigatorModelClient = { create: async () => { modelCalls += 1; return finalResponse } }
    const invalidBodies = [
      { ...request, scope: { pressKey: 'press4' } },
      { ...request, range: { startUtc: end, endUtc: start } },
      { ...request, analysis: 'diagnose_root_cause' },
    ]
    for (const body of invalidBodies) {
      const result = await call('/api/ai-investigator/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, config, model, press14Radius())
      assert.equal(result.status, 400)
    }
    assert.equal(modelCalls, 0)
  })

  it('starts safely without a key and returns a useful not-configured state', async () => {
    const disabled = { ...config, enabled: false, apiKey: undefined }
    const status = await call('/api/ai-investigator/status', undefined, disabled)
    assert.equal(status.status, 200); assert.equal((JSON.parse(status.text) as { configured: boolean }).configured, false)
    const analyze = await call('/api/ai-investigator/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) }, disabled)
    assert.equal(analyze.status, 503); assert.match(analyze.text, /not configured/)
  })

  it('never returns the OpenAI key from status or analysis configuration', async () => {
    const status = await call('/api/ai-investigator/status', undefined, config, modelQueue([finalResponse]))
    assert.equal(status.status, 200); assert.doesNotMatch(status.text, /test-secret-never-return|apiKey|OPENAI_API_KEY/)
  })
})
