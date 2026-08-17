import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { describe, it } from 'node:test'
import { createApp } from '../src/app.js'
import type { AiInvestigatorConfig } from '../src/config.js'
import type { RadiusOverview } from '../src/radius/models.js'
import type { RadiusService } from '../src/radius/radius-service.js'
import type { TelemetryFoundationService } from '../src/telemetry/telemetry-foundation-service.js'
import type { TelemetryClient } from '../src/telemetry/telemetry-api-client.js'
import { parseAiInvestigatorRequest, validateAiInvestigatorContent, type AiInvestigatorContent } from '../src/ai-investigator/contracts.js'
import { AiInvestigatorReadOnlyToolRegistry, AI_INVESTIGATOR_TOOL_NAMES } from '../src/ai-investigator/read-only-tools.js'
import { AiInvestigatorOrchestrator, type AiInvestigatorModelClient, type AiModelResponse } from '../src/ai-investigator/orchestrator.js'

const start = '2026-08-16T12:00:00.000Z'; const end = '2026-08-17T12:00:00.000Z'
const request = { scope: { pressKey: null }, range: { startUtc: start, endUtc: end }, analysis: 'discover_unusual_behavior' as const }
const config: AiInvestigatorConfig = { enabled: true, apiKey: 'test-secret-never-return', model: 'test-model', totalTimeoutMs: 500, toolTimeoutMs: 50, openAiTimeoutMs: 100, maxToolCalls: 8, maxToolRounds: 4, maxParallelTools: 3 }
const content: AiInvestigatorContent = { summary: 'One bounded finding.', findings: [{ rank: 1, press: 'Press 11', title: 'More interruptions', importance: 'medium', confidence: 'medium', whyItMatters: 'FACT: six interruptions. COMPARISON: one previously. INTERPRETATION: worth review.', facts: [{ label: 'Interruptions', value: '6', comparison: 'Previous period: 1' }], timestamps: ['2026-08-17T10:00:00.000Z'], radiusEvidence: ['B / 82 lasted 18 minutes'], telemetryEvidence: ['Actual Speed fell to 0'], productionContext: { job: '', order: '910877', recipe: 'Recipe A' }, recommendedInvestigation: 'Open the synchronized evidence.', links: [{ label: 'Open Radius Explorer', href: '/raw-radius-explorer' }] }], tables: [{ title: 'Press comparison', columns: ['Press', 'Stops'], rows: [['Press 11', '6']] }], limitations: ['Advisory result.'] }

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

function radiusWithOverview(load: () => Promise<RadiusOverview>): RadiusService {
  return { getHealth: async () => ({ status: 'healthy', configured: true }), getOverview: load, getAnalysisOverview: load, getPressEpisodes: async () => { throw new Error('unused') }, getEpisode: async () => { throw new Error('unused') } }
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
    assert.equal(callLimited.status, 'partial'); assert.equal(callLimited.toolCallsUsed, 1); assert.equal(calls, 1)
    const oneCall = responseWithCalls({ name: 'get_fleet_operational_summary', arguments: { start, end, press: null } })
    const roundLimited = await new AiInvestigatorOrchestrator({ ...config, maxToolRounds: 1 }, registry(radiusWithOverview(load)), modelQueue([oneCall, oneCall]), false).analyze(request)
    assert.equal(roundLimited.status, 'partial'); assert.equal(roundLimited.toolCallsUsed, 1); assert.equal(calls, 2)
  })

  it('validates the strict final contract and rejects arbitrary or unsafe output', () => {
    assert.deepEqual(validateAiInvestigatorContent(content), content)
    assert.throws(() => validateAiInvestigatorContent({ ...content, html: '<script>' }), /invalid_investigator_response/)
    assert.throws(() => validateAiInvestigatorContent({ ...content, findings: [{ ...content.findings[0], links: [{ label: 'bad', href: 'https://internal.example' }] }] }), /invalid_investigator_response/)
    assert.throws(() => validateAiInvestigatorContent({ ...content, tables: [{ title: 'bad', columns: ['a', 'b'], rows: [['one']] }] }), /invalid_investigator_response/)
  })
})

const telemetryClient: TelemetryClient = { getHealth: async () => ({ service: 'TelemetryQueryApi', status: 'healthy' }), getDatabaseHealth: async () => ({ service: 'TelemetryQueryApi', database: 'historian', status: 'healthy' }), getSources: async () => [], getPhysicalState: async () => { throw new Error('unused') } }

async function call(path: string, options?: RequestInit, appConfig?: AiInvestigatorConfig, model?: AiInvestigatorModelClient) {
  const app = createApp({ telemetryClient, logger: false, aiInvestigatorConfig: appConfig, aiInvestigatorModelClient: model })
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>((resolve) => server.once('listening', resolve)); const address = server.address() as AddressInfo
  try { const response = await fetch(`http://127.0.0.1:${address.port}${path}`, options); return { status: response.status, text: await response.text() } } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) }
}

describe('AI Investigator HTTP boundary', () => {
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
