import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { AiInvestigatorConfig } from '../src/config.js'
import { AI_INVESTIGATOR_DISCOVERY_SCHEMA, validateAiInvestigatorDiscoveryDraft, type AiInvestigatorDiscoveryDraftContent } from '../src/ai-investigator/contracts.js'
import { buildDiscoveryPreflight, DISCOVERY_INSTRUCTIONS, DISCOVERY_OUTPUT_TOKENS, expandDiscoveryDraft } from '../src/ai-investigator/discovery.js'
import { groundAiInvestigatorDraft } from '../src/ai-investigator/grounding.js'
import { buildAiResponsesRequestPayload, AiInvestigatorOrchestrator, type AiInvestigatorModelClient } from '../src/ai-investigator/orchestrator.js'
import { profileAiResponsesRequest } from '../src/ai-investigator/offline-profiler.js'
import { DiscoveryFixtureExecutor, fixtureCurrent } from './fixtures/ai-investigator-discovery-fixture.js'

const request = { scope: { pressKey: null }, range: fixtureCurrent, analysis: 'discover_unusual_behavior' as const }
const config: AiInvestigatorConfig = { enabled: true, apiKey: 'offline-test', model: 'test-model', totalTimeoutMs: 2_000, toolTimeoutMs: 500, openAiTimeoutMs: 500, maxToolCalls: 8, maxToolRounds: 4, maxParallelTools: 3 }

function value(preflight: Awaited<ReturnType<typeof buildDiscoveryPreflight>>, id: string) { return preflight.facts.find((fact) => fact.factId === id)?.value }

describe('AI Investigator deterministic discovery preflight', () => {
  it('ranks transparently and enforces the V1 hard maximum of five all-press candidates', async () => {
    const profiles = []
    for (const candidateLimit of [3, 5, 12]) {
      const preflight = await buildDiscoveryPreflight(new DiscoveryFixtureExecutor(), request, new AbortController().signal, { candidateLimit })
      assert.equal(preflight.candidates.length, Math.min(candidateLimit, 5))
      const payload = buildAiResponsesRequestPayload('test-model', [{ role: 'user', content: JSON.stringify(preflight.modelInput) }], DISCOVERY_INSTRUCTIONS, [], 'none', { structuredOutputSchema: AI_INVESTIGATOR_DISCOVERY_SCHEMA as unknown as Record<string, unknown>, structuredOutputName: 'process_intelligence_discovery', maxOutputTokens: DISCOVERY_OUTPUT_TOKENS })
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
    assert.equal(JSON.stringify(preflight.modelInput).includes('samples'), false)
  })

  it('expands the compact model draft into the rich grounded UI contract server-side', async () => {
    const preflight = await buildDiscoveryPreflight(new DiscoveryFixtureExecutor(), { ...request, scope: { pressKey: 'press14' } }, new AbortController().signal)
    const draft: AiInvestigatorDiscoveryDraftContent = { summary: 'Press 14 has material comparative signals.', findings: [{ rank: 1, pressKey: 'press14', title: 'Production time declined', importance: 'high', confidence: 'high', interpretation: 'The deterministic comparison warrants review.', factIds: ['press14.production_percent.delta', 'press14.longest_interruption_minutes.delta', 'press14.radius_driver.driver1.duration_minutes.current'], recommendedInvestigation: 'Inspect the synchronized Radius episodes.' }], limitations: ['Advisory result.'] }
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
    const draft: AiInvestigatorDiscoveryDraftContent = { summary: 'One material signal.', findings: [{ rank: 1, pressKey: 'press14', title: 'Production time declined', importance: 'high', confidence: 'high', interpretation: 'The deterministic comparison warrants review.', factIds: ['press14.production_percent.delta'], recommendedInvestigation: 'Inspect Radius episodes.' }], limitations: [] }
    const model: AiInvestigatorModelClient = { create: async (_input, _instructions, tools, _choice, _signal, options) => { observed.push({ tools: tools.length, options }); return { id: 'offline-model', outputText: JSON.stringify(draft), outputItems: [], toolCalls: [] } } }
    const result = await new AiInvestigatorOrchestrator(config, executor, model, false).analyzeDiscovery({ ...request, scope: { pressKey: 'press14' } })
    assert.equal(result.status, 'complete'); assert.equal(result.findings.length, 1); assert.equal(result.toolCallsUsed, 3)
    assert.equal(observed.length, 1); assert.equal(observed[0].tools, 0)
    assert.deepEqual((observed[0].options as { structuredOutputName: string; maxOutputTokens: number }).structuredOutputName, 'process_intelligence_discovery')
  })

  it('stops after the first failed discovery synthesis request without retry or fallback', async () => {
    let calls = 0
    const model: AiInvestigatorModelClient = { create: async () => { calls += 1; const error = new Error('rate limited') as Error & { status: number }; error.status = 429; throw error } }
    const result = await new AiInvestigatorOrchestrator(config, new DiscoveryFixtureExecutor(), model, false).analyzeDiscovery({ ...request, scope: { pressKey: 'press14' } })
    assert.equal(result.status, 'error'); assert.equal(calls, 1)
  })
})
