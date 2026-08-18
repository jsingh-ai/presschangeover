import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { AI_INVESTIGATOR_DISCOVERY_SCHEMA, AI_INVESTIGATOR_DISCOVERY_TEXT_FORMAT, AiInvestigatorValidationError, parseAiInvestigatorDiscoveryDraft, validateAiInvestigatorDiscoveryDraft, type AiGroundingFact, type AiInvestigatorDiscoveryDraftContent } from '../src/ai-investigator/contracts.js'
import { DISCOVERY_INSTRUCTIONS, DISCOVERY_OUTPUT_TOKENS, expandDiscoveryDraft, validateDiscoveryReferences, type DiscoveryCandidate } from '../src/ai-investigator/discovery.js'
import { groundAiInvestigatorDraft } from '../src/ai-investigator/grounding.js'
import { AiInvestigatorOrchestrator, OpenAiResponsesInvestigatorClient, type AiInvestigatorLogger, type AiInvestigatorModelClient } from '../src/ai-investigator/orchestrator.js'
import type { AiInvestigatorConfig } from '../src/config.js'
import { DiscoveryFixtureExecutor, fixtureCurrent } from './fixtures/ai-investigator-discovery-fixture.js'

const config: AiInvestigatorConfig = { enabled: true, apiKey: 'offline-test', model: 'test-model', totalTimeoutMs: 2_000, toolTimeoutMs: 500, openAiTimeoutMs: 500, maxToolCalls: 8, maxToolRounds: 4, maxParallelTools: 3 }
const request = { scope: { pressKey: 'press14' as const }, range: fixtureCurrent, analysis: 'discover_unusual_behavior' as const }
const range = { start: '2026-08-17T00:13:07.427Z', end: '2026-08-18T00:13:07.427Z' }
const baseline = { start: '2026-08-16T00:13:07.427Z', end: range.start }

function fact(factId: string, metric: string, value: string | number, unit: string, role: AiGroundingFact['role'], source: AiGroundingFact['source'], label: string, factRange = range, pressKey: AiGroundingFact['pressKey'] = 'press14'): AiGroundingFact {
  return { factId, pressKey, press: pressKey === 'press14' ? 'Press 14' : 'Press 10', source, metric, value, unit, role, usable: true, label, range: factRange }
}

const press14Facts: AiGroundingFact[] = [
  fact('press14.coverage_percent.current', 'coveragePercent', 100, 'percent', 'current', 'coverage', 'Data coverage'),
  fact('press14.production_percent.current', 'productionPercent', 47.8, 'percent', 'current', 'radius', 'Production time'),
  fact('press14.production_percent.baseline', 'productionPercent', 65.4, 'percent', 'baseline', 'radius', 'Production time', baseline),
  fact('press14.production_percent.delta', 'productionPercentagePointDelta', -17.6, 'percentage_points', 'delta', 'comparison', 'Production time change'),
  fact('press14.interruptions.current', 'interruptions', 9, 'count', 'current', 'radius', 'Production interruptions'),
  fact('press14.interruptions.baseline', 'interruptions', 8, 'count', 'baseline', 'radius', 'Production interruptions', baseline),
  fact('press14.interruptions.delta', 'interruptionDelta', 1, 'count', 'delta', 'comparison', 'Interruption change'),
  fact('press14.longest_interruption_minutes.current', 'longestInterruptionMinutes', 248.1, 'minutes', 'current', 'radius', 'Longest interruption'),
  fact('press14.longest_interruption_minutes.baseline', 'longestInterruptionMinutes', 141.8, 'minutes', 'baseline', 'radius', 'Longest interruption', baseline),
  fact('press14.longest_interruption_minutes.delta', 'longestInterruptionDeltaMinutes', 106.3, 'minutes', 'delta', 'comparison', 'Longest interruption change'),
  fact('press14.radius_driver.4d9381aa87.duration_minutes.current', 'radiusDriverDurationMinutes', 687.7, 'minutes', 'current', 'radius', 'G / 150 / Run Production'),
  fact('press14.radius_driver.4d9381aa87.duration_minutes.baseline', 'radiusDriverDurationMinutes', 942.4, 'minutes', 'baseline', 'radius', 'G / 150 / Run Production', baseline),
  fact('press14.radius_driver.4d9381aa87.duration_minutes.delta', 'radiusDriverDurationDeltaMinutes', -254.7, 'minutes', 'delta', 'comparison', 'G / 150 / Run Production duration change'),
  fact('press14.industrial.5547235925bfab.commonSequenceCount.event', 'industrial.radius_sequence_deviation.commonSequenceCount', 4, 'episodes', 'event', 'radius', 'Common Radius sequence support'),
  fact('press14.industrial.5547235925bfab.commonSequenceSharePercent.event', 'industrial.radius_sequence_deviation.commonSequenceSharePercent', 50, 'percent', 'event', 'radius', 'Common Radius sequence share'),
  fact('press14.industrial.5547235925bfab.extraStepCount.event', 'industrial.radius_sequence_deviation.extraStepCount', 14, 'count', 'event', 'radius', 'Extra Radius steps'),
  fact('press14.industrial.5547235925bfab.loopCount.event', 'industrial.radius_sequence_deviation.loopCount', 5, 'count', 'event', 'radius', 'Looped Radius steps'),
]

const candidate: DiscoveryCandidate = { pressKey: 'press14', press: 'Press 14', signalCount: 7, productionDelta: -17.6, interruptionDelta: 1, longestDelta: 106.3, observations: [], facts: press14Facts }

function judgment(overrides: Partial<AiInvestigatorDiscoveryDraftContent['findings'][number]> = {}): AiInvestigatorDiscoveryDraftContent['findings'][number] {
  return { candidateId: 'press14', title: 'Operating shift merits review', importance: 'high', confidence: 'high', factIds: ['press14.production_percent.delta'], interpretation: 'The supplied changes align into a material operating shift.', whyWorthInvestigating: 'The combination is more decision-relevant than any one metric alone.', recommendedInvestigation: 'Review the synchronized Radius sequence with the operating team.', ...overrides }
}

function diagnostic(operation: () => unknown) {
  try { operation(); assert.fail('expected validation failure') }
  catch (error) { assert.ok(error instanceof AiInvestigatorValidationError); return error.diagnostic }
}

describe('AI Investigator authoritative structured output', () => {
  it('derives the strict OpenAI schema and local runtime type from one Zod contract', () => {
    assert.equal(AI_INVESTIGATOR_DISCOVERY_TEXT_FORMAT.type, 'json_schema')
    assert.equal(AI_INVESTIGATOR_DISCOVERY_TEXT_FORMAT.strict, true)
    assert.deepEqual(AI_INVESTIGATOR_DISCOVERY_TEXT_FORMAT.schema, AI_INVESTIGATOR_DISCOVERY_SCHEMA)
    const root = AI_INVESTIGATOR_DISCOVERY_SCHEMA as { additionalProperties: boolean; properties: { findings: { items: { additionalProperties: boolean; required: string[]; properties: Record<string, unknown> } } } }
    assert.equal(root.additionalProperties, false); assert.equal(root.properties.findings.items.additionalProperties, false)
    assert.deepEqual(root.properties.findings.items.required, ['candidateId', 'title', 'importance', 'confidence', 'factIds', 'interpretation', 'whyWorthInvestigating', 'recommendedInvestigation'])
    assert.equal('rank' in root.properties.findings.items.properties, false); assert.equal('pressKey' in root.properties.findings.items.properties, false)
  })

  it('uses the installed SDK parsed Responses result with strict tool-free Structured Outputs', async () => {
    const valid = { summary: 'One judgment.', findings: [judgment()], limitations: [] }
    let sent: Record<string, unknown> | undefined
    const fakeFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(JSON.stringify({
        id: 'resp-offline-parsed', object: 'response', created_at: 1, status: 'completed', error: null, incomplete_details: null, model: 'test-model',
        output: [{ id: 'msg-offline', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(valid), annotations: [] }] }],
        usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
      }), { status: 200, headers: { 'content-type': 'application/json', 'x-request-id': 'req-offline-parsed' } })
    }) as typeof fetch
    const client = new OpenAiResponsesInvestigatorClient(config, fakeFetch)
    const response = await client.create([{ role: 'user', content: '{}' }], DISCOVERY_INSTRUCTIONS, [], 'none', new AbortController().signal, { structuredOutputSchema: AI_INVESTIGATOR_DISCOVERY_SCHEMA, structuredOutputFormat: AI_INVESTIGATOR_DISCOVERY_TEXT_FORMAT, maxOutputTokens: DISCOVERY_OUTPUT_TOKENS })
    assert.deepEqual(response.parsedOutput, valid); assert.equal(response.responseStatus, 'completed'); assert.equal(response.http?.requestId, 'req-offline-parsed')
    const text = sent?.text as { format: { type: string; strict: boolean } }
    assert.deepEqual({ format: text.format.type, strict: text.format.strict, toolChoice: sent?.tool_choice, store: sent?.store }, { format: 'json_schema', strict: true, toolChoice: 'none', store: false })
  })

  it('retains only safe response metadata when SDK parsing fails', async () => {
    const invalid = { summary: 'must not be logged', findings: [{ ...judgment(), importance: 'urgent' }], limitations: [] }
    const fakeFetch = (async () => new Response(JSON.stringify({
      id: 'resp-offline-invalid', object: 'response', created_at: 1, status: 'completed', error: null, incomplete_details: null, model: 'test-model',
      output: [{ id: 'msg-offline-invalid', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(invalid), annotations: [] }] }],
      usage: { input_tokens: 101, output_tokens: 51, total_tokens: 152 },
    }), { status: 200, headers: { 'content-type': 'application/json', 'x-request-id': 'req-offline-invalid' } })) as typeof fetch
    const client = new OpenAiResponsesInvestigatorClient(config, fakeFetch)
    await assert.rejects(
      client.create([{ role: 'user', content: '{}' }], DISCOVERY_INSTRUCTIONS, [], 'none', new AbortController().signal, { structuredOutputSchema: AI_INVESTIGATOR_DISCOVERY_SCHEMA, structuredOutputFormat: AI_INVESTIGATOR_DISCOVERY_TEXT_FORMAT, maxOutputTokens: DISCOVERY_OUTPUT_TOKENS }),
      (error: unknown) => {
        const safe = error as { message?: string; responseId?: string; responseStatus?: string; outputItemTypes?: string[]; usage?: { totalTokens?: number }; http?: { requestId?: string }; validationDiagnostic?: { validationStage?: string; path?: string; expected?: string; receivedType?: string } }
        assert.deepEqual({ message: safe.message, responseId: safe.responseId, responseStatus: safe.responseStatus, outputItemTypes: safe.outputItemTypes, totalTokens: safe.usage?.totalTokens, requestId: safe.http?.requestId, diagnostic: safe.validationDiagnostic }, {
          message: 'structured_output_invalid', responseId: 'resp-offline-invalid', responseStatus: 'completed', outputItemTypes: ['message', 'output_text'], totalTokens: 152, requestId: 'req-offline-invalid', diagnostic: { validationStage: 'sdk_parse', path: 'findings[0].importance', expected: 'high|medium|low', receivedType: 'unknown', schemaCode: 'invalid_value' },
        })
        assert.doesNotMatch(JSON.stringify(error), /must not be logged|urgent/)
        return true
      },
    )
  })

  it('emits safe field-level diagnostics for missing IDs, enums, extra fields, required fields, and malformed JSON', () => {
    const valid = { summary: 'Review supplied candidates.', findings: [judgment()], limitations: [] }
    assert.deepEqual(validateAiInvestigatorDiscoveryDraft(valid), valid)
    assert.deepEqual(validateAiInvestigatorDiscoveryDraft({ summary: 'No material judgment.', findings: [], limitations: [] }).findings, [])
    assert.equal(diagnostic(() => validateAiInvestigatorDiscoveryDraft({ ...valid, findings: [{ ...judgment(), candidateId: undefined }] })).path, 'findings[0].candidateId')
    assert.equal(diagnostic(() => validateAiInvestigatorDiscoveryDraft({ ...valid, findings: [{ ...judgment(), importance: 'urgent' }] })).expected, 'high|medium|low')
    assert.equal(diagnostic(() => validateAiInvestigatorDiscoveryDraft({ ...valid, findings: [{ ...judgment(), deterministicValue: 47.8 }] })).receivedType, 'property')
    assert.equal(diagnostic(() => validateAiInvestigatorDiscoveryDraft({ ...valid, findings: [{ ...judgment(), recommendedInvestigation: undefined }] })).receivedType, 'missing')
    assert.equal(diagnostic(() => validateAiInvestigatorDiscoveryDraft({ ...valid, findings: Array.from({ length: 6 }, () => judgment()) })).schemaCode, 'too_big')
    assert.equal(diagnostic(() => parseAiInvestigatorDiscoveryDraft('{bad json')).schemaCode, 'malformed_json')
  })

  it('rejects unknown candidate, unknown fact, and cross-press references without fuzzy matching', () => {
    const crossPress = fact('press10.production_percent.current', 'productionPercent', 60, 'percent', 'current', 'radius', 'Production time', range, 'press10')
    const base = { summary: 'One judgment.', findings: [judgment()], limitations: [] }
    assert.deepEqual(validateDiscoveryReferences(base, [candidate], press14Facts).issues, [])
    assert.equal(validateDiscoveryReferences({ ...base, findings: [judgment({ candidateId: 'press15' })] }, [candidate], press14Facts).issues[0].code, 'unknown_candidate_id')
    assert.equal(validateDiscoveryReferences({ ...base, findings: [judgment({ factIds: ['press14.unknown.fact'] })] }, [candidate], press14Facts).issues[0].code, 'unknown_fact_id')
    assert.equal(validateDiscoveryReferences({ ...base, findings: [judgment({ factIds: [crossPress.factId] })] }, [candidate], [...press14Facts, crossPress]).issues[0].code, 'cross_press_fact')
    assert.equal(validateDiscoveryReferences({ ...base, findings: [judgment(), judgment()] }, [candidate], press14Facts).issues[0].code, 'duplicate_candidate_id')
    const unusable = { ...press14Facts.find((item) => item.factId === 'press14.production_percent.delta')!, usable: false }
    assert.equal(validateDiscoveryReferences(base, [candidate], [...press14Facts.filter((item) => item.factId !== unusable.factId), unusable]).issues[0].code, 'unusable_fact')
    const invalidSource = { ...press14Facts.find((item) => item.factId === 'press14.production_percent.delta')!, source: 'model' } as unknown as AiGroundingFact
    assert.equal(validateDiscoveryReferences(base, [candidate], [...press14Facts.filter((item) => item.factId !== invalidSource.factId), invalidSource]).issues[0].code, 'invalid_fact_source')
  })

  it('reconstructs complete UI findings from multiple plausible judgments over the exact Press 14 fact package', () => {
    const judgments: AiInvestigatorDiscoveryDraftContent[] = [
      { summary: 'Comparative operating changes merit review.', findings: [judgment({ factIds: ['press14.production_percent.delta', 'press14.radius_driver.4d9381aa87.duration_minutes.delta', 'press14.longest_interruption_minutes.delta'] })], limitations: [] },
      { summary: 'The event sequence is the strongest investigation lead.', findings: [judgment({ title: 'Sequence complexity increased investigation priority', importance: 'medium', factIds: ['press14.industrial.5547235925bfab.commonSequenceCount.event', 'press14.industrial.5547235925bfab.commonSequenceSharePercent.event', 'press14.industrial.5547235925bfab.extraStepCount.event', 'press14.industrial.5547235925bfab.loopCount.event'] })], limitations: [] },
    ]
    for (const draft of judgments) {
      const validated = validateAiInvestigatorDiscoveryDraft(draft); const references = validateDiscoveryReferences(validated, [candidate], press14Facts)
      assert.equal(references.issues.length, 0)
      const grounded = groundAiInvestigatorDraft(expandDiscoveryDraft(references.accepted, press14Facts), press14Facts, { scope: { pressKey: 'press14' }, range: { startUtc: range.start, endUtc: range.end }, analysis: 'discover_unusual_behavior' })
      assert.equal(grounded.issues.length, 0); assert.equal(grounded.content.findings.length, 1)
      assert.equal(grounded.content.findings[0].rank, 1); assert.equal(grounded.content.findings[0].press, 'Press 14')
      assert.match(grounded.content.findings[0].whyItMatters, /decision-relevant/)
      assert.ok(grounded.content.findings[0].links.every((link) => link.href.startsWith('/')))
    }
    const comparative = groundAiInvestigatorDraft(expandDiscoveryDraft(judgments[0], press14Facts), press14Facts, { scope: { pressKey: 'press14' }, range: { startUtc: range.start, endUtc: range.end }, analysis: 'discover_unusual_behavior' })
    assert.match(comparative.content.findings[0].facts[0].comparison, /Current 47.8%; baseline 65.4%; change -17.6 percentage points/)
    assert.match(comparative.content.findings[0].facts[1].comparison, /Current 687.7 min; baseline 942.4 min; change -254.7 min/)
    assert.match(comparative.content.findings[0].facts[2].comparison, /Current 248.1 min; baseline 141.8 min; change \+106.3 min/)
  })

  it('prefers SDK parsed output and maps refusal, incomplete, and missing output distinctly with one model call each', async () => {
    const valid = { summary: 'One judgment.', findings: [judgment()], limitations: [] }
    const cases = [
      { response: { id: 'refusal', outputText: '', outputItems: [], toolCalls: [], responseStatus: 'completed', refused: true, outputItemTypes: ['message', 'refusal'] }, reason: 'openai_refusal' },
      { response: { id: 'incomplete', outputText: '', outputItems: [], toolCalls: [], responseStatus: 'incomplete', incompleteReason: 'max_output_tokens', outputItemTypes: ['reasoning'] }, reason: 'openai_incomplete' },
      { response: { id: 'missing', outputText: '', outputItems: [], toolCalls: [], responseStatus: 'completed', parsedOutput: null, outputItemTypes: ['message'] }, reason: 'structured_output_missing' },
    ]
    for (const item of cases) {
      let calls = 0; const model: AiInvestigatorModelClient = { create: async () => { calls += 1; return item.response } }
      const result = await new AiInvestigatorOrchestrator(config, new DiscoveryFixtureExecutor(), model, false).analyzeDiscovery(request)
      assert.equal(result.status, 'error'); assert.match(result.limitations.join(' '), new RegExp(item.reason)); assert.equal(calls, 1)
    }
    const parsedModel: AiInvestigatorModelClient = { create: async () => ({ id: 'parsed', outputText: '{not used', outputItems: [], toolCalls: [], responseStatus: 'completed', parsedOutput: valid }) }
    const parsed = await new AiInvestigatorOrchestrator(config, new DiscoveryFixtureExecutor(), parsedModel, false).analyzeDiscovery(request)
    assert.equal(parsed.status, 'complete'); assert.equal(parsed.findings.length, 1)
  })

  it('logs sanitized structural diagnostics without retaining generated content', async () => {
    const entries: Array<Record<string, unknown>> = []; const logger: AiInvestigatorLogger = { info: (line) => entries.push(JSON.parse(line) as Record<string, unknown>), error: (line) => entries.push(JSON.parse(line) as Record<string, unknown>) }
    const model: AiInvestigatorModelClient = { create: async () => ({ id: 'bad-importance', outputText: JSON.stringify({ summary: 'secret summary', findings: [{ ...judgment(), importance: 'urgent' }], limitations: [] }), outputItems: [], toolCalls: [] }) }
    const result = await new AiInvestigatorOrchestrator(config, new DiscoveryFixtureExecutor(), model, logger).analyzeDiscovery(request)
    assert.equal(result.status, 'error')
    const entry = entries.find((item) => item.event === 'ai_investigator_validation_failed' && item.validationStage === 'final_schema')
    assert.deepEqual({ path: entry?.path, expected: entry?.expected, receivedType: entry?.receivedType, findingIndex: entry?.findingIndex }, { path: 'findings[0].importance', expected: 'high|medium|low', receivedType: 'string', findingIndex: 0 })
    assert.doesNotMatch(JSON.stringify(entries), /secret summary|urgent/)
  })
})
