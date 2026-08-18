import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { AiInvestigatorConfig } from '../src/config.js'
import { AI_INVESTIGATOR_DISCOVERY_SCHEMA, AI_INVESTIGATOR_DISCOVERY_TEXT_FORMAT, validateAiInvestigatorDiscoveryDraft, type AiInvestigatorDiscoveryDraftContent } from '../src/ai-investigator/contracts.js'
import { buildDiscoveryPreflight, compactDiscoveryTraceForModel, compactModelInput, DISCOVERY_INSTRUCTIONS, DISCOVERY_MODEL_NUMERIC_LANDMARK_LIMIT, DISCOVERY_MODEL_NUMERIC_SEGMENT_LIMIT, DISCOVERY_OUTPUT_TOKENS, DISCOVERY_SELECTED_MODEL_TELEMETRY_TRACE_LIMIT, DISCOVERY_SELECTED_MODEL_TRACE_LIMIT, expandDiscoveryDraft, selectDiscoveryModelTraces } from '../src/ai-investigator/discovery.js'
import { groundAiInvestigatorDraft } from '../src/ai-investigator/grounding.js'
import { buildAiResponsesRequestPayload, AiInvestigatorOrchestrator, type AiInvestigatorModelClient } from '../src/ai-investigator/orchestrator.js'
import { profileAiResponsesRequest } from '../src/ai-investigator/offline-profiler.js'
import { DiscoveryFixtureExecutor, fixtureBaseline, fixtureCurrent } from './fixtures/ai-investigator-discovery-fixture.js'

const request = { scope: { pressKey: null }, range: fixtureCurrent, analysis: 'discover_unusual_behavior' as const }
const config: AiInvestigatorConfig = { enabled: true, apiKey: 'offline-test', model: 'test-model', totalTimeoutMs: 2_000, toolTimeoutMs: 500, openAiTimeoutMs: 500, maxToolCalls: 8, maxToolRounds: 4, maxParallelTools: 3 }

function value(preflight: Awaited<ReturnType<typeof buildDiscoveryPreflight>>, id: string) { return preflight.facts.find((fact) => fact.factId === id)?.value }

describe('AI Investigator deterministic discovery preflight', () => {
  it('ranks transparently and enforces the V1 hard maximum of five all-press candidates', async () => {
    const profiles = []
    for (const candidateLimit of [3, 5, 12]) {
      const preflight = await buildDiscoveryPreflight(new DiscoveryFixtureExecutor(), request, new AbortController().signal, { candidateLimit })
      assert.equal(preflight.candidates.length, Math.min(candidateLimit, 5))
      const payload = buildAiResponsesRequestPayload('test-model', [{ role: 'user', content: JSON.stringify(preflight.modelInput) }], DISCOVERY_INSTRUCTIONS, [], 'none', { structuredOutputSchema: AI_INVESTIGATOR_DISCOVERY_SCHEMA, structuredOutputFormat: AI_INVESTIGATOR_DISCOVERY_TEXT_FORMAT, structuredOutputName: 'process_intelligence_discovery', maxOutputTokens: DISCOVERY_OUTPUT_TOKENS })
      const profile = profileAiResponsesRequest(payload)
      assert.equal(profile.exactRequestBytes, Buffer.byteLength(JSON.stringify(payload), 'utf8'))
      profiles.push({ candidateLimit, ...profile })
    }
    assert.deepEqual(profiles.map((profile) => profile.candidateLimit), [3, 5, 12])
    assert.ok(profiles[0].exactRequestBytes < profiles[1].exactRequestBytes)
    assert.equal(profiles[1].exactRequestBytes, profiles[2].exactRequestBytes)
  })

  it('retains all named offline quality regressions in the default top-five package', async () => {
    const preflight = await buildDiscoveryPreflight(new DiscoveryFixtureExecutor(), request, new AbortController().signal)
    assert.deepEqual(preflight.candidates.map((candidate) => candidate.pressKey), ['press14', 'press13', 'press10', 'press12', 'press6'])
    assert.equal(value(preflight, 'press14.production_percent.current'), 40.7)
    assert.equal(value(preflight, 'press14.production_percent.baseline'), 63.8)
    assert.equal(value(preflight, 'press14.longest_interruption_minutes.current'), 384.7)
    assert.equal(value(preflight, 'press14.longest_interruption_minutes.baseline'), 549.8)
    assert.equal(value(preflight, 'press14.longest_interruption_minutes.delta'), -165.1)
    assert.equal(value(preflight, 'press10.production_percent.delta'), -20)
    assert.equal(value(preflight, 'press10.longest_interruption_minutes.delta'), 120)
    assert.equal(value(preflight, 'press13.interruptions.delta'), 8)
    assert.equal(value(preflight, 'press6.interruptions.current'), 14)
    assert.equal(value(preflight, 'press6.interruptions.baseline'), 9)
    assert.equal(value(preflight, 'press6.interruptions.delta'), 5)
    assert.match(preflight.facts.filter((fact) => ['press10', 'press13', 'press14'].includes(fact.pressKey) && fact.metric === 'radiusDriverDurationMinutes').map((fact) => fact.label).join(' '), /Sheet feed|delivery jam|web break/)
    assert.ok(preflight.candidates.every((candidate) => candidate.observations.length <= 3 && candidate.observations.every((observation) => observation.support.adequate && observation.material)))
    assert.equal(preflight.analytics.modelCandidates, 5); assert.equal(preflight.analytics.grouped, preflight.candidates.reduce((sum, candidate) => sum + candidate.observations.length, 0))
    assert.ok(preflight.candidates.every((candidate) => candidate.observations.length <= 1))
    assert.equal(JSON.stringify(preflight.modelInput).includes('samples'), false)
  })

  it('requests full temporal detail for only the first two fleet candidates', async () => {
    const executor = new DiscoveryFixtureExecutor(true)
    await buildDiscoveryPreflight(executor, request, new AbortController().signal)
    const detailLevels = executor.calls
      .filter((call) => call.name === 'get_press_event_summary')
      .map((call) => (call.arguments as { detailLevel: string }).detailLevel)
    assert.deepEqual(detailLevels, ['fleet', 'fleet', 'fleet_summary', 'fleet_summary', 'fleet_summary'])
  })

  it('keeps compact selected-press and fleet serialization within hard token gates', async () => {
    const estimate = async (pressKey: 'press14' | null) => {
      const preflight = await buildDiscoveryPreflight(new DiscoveryFixtureExecutor(), { ...request, scope: { pressKey } }, new AbortController().signal)
      const payload = buildAiResponsesRequestPayload('test-model', [{ role: 'user', content: JSON.stringify(preflight.modelInput) }], DISCOVERY_INSTRUCTIONS, [], 'none', { structuredOutputSchema: AI_INVESTIGATOR_DISCOVERY_SCHEMA, structuredOutputFormat: AI_INVESTIGATOR_DISCOVERY_TEXT_FORMAT, structuredOutputName: 'process_intelligence_discovery', maxOutputTokens: DISCOVERY_OUTPUT_TOKENS })
      assert.equal(JSON.stringify(preflight.modelInput).includes('validationDiagnostics'), false)
      assert.deepEqual(preflight.instrumentation.sectionTokenContributions.map(({ section }) => section), ['overall summary', 'context', 'Radius sequence evidence', 'temporal traces', 'telemetry events', 'baseline evidence', 'relationships', 'persistence', 'first divergence', 'Radius/telemetry alignment', 'limitations'])
      return profileAiResponsesRequest(payload).estimatedInputTokens
    }
    assert.ok(await estimate('press14') <= 2_500); assert.ok(await estimate(null) <= 6_000)
  })

  it('keeps bounded temporal programs within selected and fleet token/detail limits without raw arrays', async () => {
    const estimate = async (pressKey: 'press14' | null) => {
      const preflight = await buildDiscoveryPreflight(new DiscoveryFixtureExecutor(true), { ...request, scope: { pressKey } }, new AbortController().signal)
      const payload = buildAiResponsesRequestPayload('test-model', [{ role: 'user', content: JSON.stringify(preflight.modelInput) }], DISCOVERY_INSTRUCTIONS, [], 'none', { structuredOutputSchema: AI_INVESTIGATOR_DISCOVERY_SCHEMA, structuredOutputFormat: AI_INVESTIGATOR_DISCOVERY_TEXT_FORMAT, structuredOutputName: 'process_intelligence_discovery', maxOutputTokens: DISCOVERY_OUTPUT_TOKENS })
      const serialized = JSON.stringify(preflight.modelInput); assert.equal(serialized.includes('samples'), false); assert.equal(serialized.includes('rawSignalId'), false); assert.ok(preflight.candidates.filter((candidate) => (candidate.traces?.length ?? 0) > 0).length <= 2); assert.ok(preflight.candidates.every((candidate) => (candidate.traces?.length ?? 0) <= 8 && (candidate.traces?.filter((trace) => trace.datatype === 'numeric' || trace.datatype === 'categorical').length ?? 0) <= 6))
      return profileAiResponsesRequest(payload).estimatedInputTokens
    }
    assert.ok(await estimate('press14') <= 2_500); assert.ok(await estimate(null) <= 6_000)
  })

  it('keeps authoritative traces rich while bounding the selected-press model view to three telemetry traces plus Radius and context', async () => {
    const preflight = await buildDiscoveryPreflight(new DiscoveryFixtureExecutor(true), { ...request, scope: { pressKey: 'press14' } }, new AbortController().signal)
    const candidate = preflight.candidates[0]!
    assert.equal(candidate.traces?.length, 6)
    const modelTraces = selectDiscoveryModelTraces(candidate.traces ?? [], true)
    assert.equal(modelTraces.length, DISCOVERY_SELECTED_MODEL_TRACE_LIMIT)
    assert.equal(modelTraces.filter((trace) => trace.datatype === 'numeric' || trace.datatype === 'categorical').length, DISCOVERY_SELECTED_MODEL_TELEMETRY_TRACE_LIMIT)
    assert.equal(modelTraces.filter((trace) => trace.datatype === 'radius').length, 1)
    assert.equal(modelTraces.filter((trace) => trace.datatype === 'production_context').length, 1)
    assert.equal(candidate.traces?.some((trace) => trace.canonicalId === 'drive.load.actual'), true)
    assert.equal(modelTraces.some((trace) => trace.canonicalId === 'drive.load.actual'), false)
    const fourthSignalFact = { ...candidate.facts[0]!, factId: 'press14.telemetry.drive_load.strongest_delta.event', source: 'telemetry' as const, metric: 'strongest10mDelta', value: 12.5, unit: 'percent', role: 'event' as const, label: 'Drive load strongest 10-minute Delta' }
    const modelInput = compactModelInput({ ...request, scope: { pressKey: 'press14' } }, { start: fixtureCurrent.startUtc, end: fixtureCurrent.endUtc }, { start: fixtureBaseline.startUtc, end: fixtureBaseline.endUtc }, [{ ...candidate, facts: [...candidate.facts, fourthSignalFact] }], ['press14'], [], 3, [])
    const modelFacts = (modelInput.candidates[0] as { facts: unknown[][] }).facts
    assert.equal(modelFacts.some((fact) => fact[0] === fourthSignalFact.factId), true)
  })

  it('preserves observed critical numeric landmarks while bounding the compact model trace', async () => {
    const preflight = await buildDiscoveryPreflight(new DiscoveryFixtureExecutor(true), { ...request, scope: { pressKey: 'press14' } }, new AbortController().signal)
    const trace = preflight.candidates[0]!.traces!.find((item) => item.datatype === 'numeric')!
    assert.equal(trace.datatype, 'numeric')
    const compact = compactDiscoveryTraceForModel(trace)
    const segments = compact[8] as unknown[][]
    const landmarks = compact[9] as Array<[number, number, string[]]>
    assert.ok(segments.length <= DISCOVERY_MODEL_NUMERIC_SEGMENT_LIMIT)
    assert.ok(landmarks.length <= DISCOVERY_MODEL_NUMERIC_LANDMARK_LIMIT)
    const kinds = new Set(landmarks.flatMap((item) => item[2]))
    for (const required of ['EVENT_START', 'EVENT_END', 'MINIMUM', 'MAXIMUM']) assert.ok(kinds.has(required), `missing ${required}`)
    assert.ok(kinds.has('DELTA_BASELINE') || kinds.has('DELTA_TRIGGER') || kinds.has('DELTA_EXTREME'))
    const observedPairs = new Set(trace.landmarks.map((item) => `${item.relativeMinutes}:${item.value}`))
    assert.ok(landmarks.every(([relativeMinutes, observedValue]) => observedPairs.has(`${relativeMinutes}:${observedValue}`)))
  })

  it('expands the compact model draft into the rich grounded UI contract server-side', async () => {
    const preflight = await buildDiscoveryPreflight(new DiscoveryFixtureExecutor(), { ...request, scope: { pressKey: 'press14' } }, new AbortController().signal)
    const draft: AiInvestigatorDiscoveryDraftContent = { summary: 'Press 14 has material comparative signals.', findings: [{ candidateId: 'press14', title: 'Production time declined', importance: 'high', confidence: 'high', interpretation: 'The deterministic comparison warrants review.', whyWorthInvestigating: 'The combined changes merit an operator review.', factIds: ['press14.production_percent.delta', 'press14.longest_interruption_minutes.delta', 'press14.radius_driver.driver1.duration_minutes.current'], traceIds: [], recommendedInvestigation: 'Inspect the synchronized Radius episodes.' }], limitations: ['Advisory result.'] }
    assert.deepEqual(validateAiInvestigatorDiscoveryDraft(draft), draft)
    const expanded = expandDiscoveryDraft(draft, preflight.facts)
    assert.deepEqual(expanded.findings[0].facts[0].factIds, ['press14.production_percent.delta', 'press14.production_percent.current', 'press14.production_percent.baseline'])
    assert.deepEqual(expanded.findings[0].links.map((link) => link.href), ['/raw-radius-explorer?press=press14', '/overview?press=press14'])
    const grounded = groundAiInvestigatorDraft(expanded, preflight.facts, { ...request, scope: { pressKey: 'press14' } })
    assert.equal(grounded.issues.length, 0)
    assert.match(grounded.content.findings[0].facts[0].comparison, /Current 40.7%; baseline 63.8%; change -23.1 percentage points/)
    assert.match(grounded.content.findings[0].facts[1].comparison, /Current 384.7 min; baseline 549.8 min; change -165.1 min/)
  })

  it('uses exactly one tool-free model synthesis request on the deployed API path', async () => {
    const executor = new DiscoveryFixtureExecutor(); const observed: Array<{ tools: number; options: unknown }> = []
    const draft: AiInvestigatorDiscoveryDraftContent = { summary: 'One material signal.', findings: [{ candidateId: 'press14', title: 'Production time declined', importance: 'high', confidence: 'high', interpretation: 'The deterministic comparison warrants review.', whyWorthInvestigating: 'The change is material enough to prioritize.', factIds: ['press14.production_percent.delta'], traceIds: [], recommendedInvestigation: 'Inspect Radius episodes.' }], limitations: [] }
    const model: AiInvestigatorModelClient = { create: async (_input, _instructions, tools, _choice, _signal, options) => { observed.push({ tools: tools.length, options }); return { id: 'offline-model', outputText: JSON.stringify(draft), outputItems: [], toolCalls: [] } } }
    const result = await new AiInvestigatorOrchestrator(config, executor, model, false).analyzeDiscovery({ ...request, scope: { pressKey: 'press14' } })
    assert.equal(result.status, 'complete'); assert.equal(result.findings.length, 1); assert.equal(result.toolCallsUsed, 3)
    assert.equal(observed.length, 1); assert.equal(observed[0].tools, 0)
    assert.deepEqual((observed[0].options as { structuredOutputName: string; maxOutputTokens: number }).structuredOutputName, 'process_intelligence_discovery')
    const format = (observed[0].options as { structuredOutputFormat?: { type?: string; name?: string; strict?: boolean; schema?: { properties?: { findings?: { maxItems?: number } } } } }).structuredOutputFormat
    assert.deepEqual({ type: format?.type, name: format?.name, strict: format?.strict, maxItems: format?.schema?.properties?.findings?.maxItems }, { type: 'json_schema', name: 'process_intelligence_discovery', strict: true, maxItems: 1 })
  })

  it('stops after the first failed discovery synthesis request without retry or fallback', async () => {
    let calls = 0
    const model: AiInvestigatorModelClient = { create: async () => { calls += 1; const error = new Error('rate limited') as Error & { status: number }; error.status = 429; throw error } }
    const result = await new AiInvestigatorOrchestrator(config, new DiscoveryFixtureExecutor(), model, false).analyzeDiscovery({ ...request, scope: { pressKey: 'press14' } })
    assert.equal(result.status, 'error'); assert.equal(calls, 1)
  })
})
