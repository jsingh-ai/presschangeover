import { AI_INVESTIGATOR_CONTENT_SCHEMA, AI_INVESTIGATOR_DISCOVERY_SCHEMA } from '../src/ai-investigator/contracts.js'
import { buildDiscoveryPreflight, DISCOVERY_INSTRUCTIONS, DISCOVERY_OUTPUT_TOKENS } from '../src/ai-investigator/discovery.js'
import { cumulativeOfflineProfile, profileAiResponsesRequest } from '../src/ai-investigator/offline-profiler.js'
import { buildAiResponsesRequestPayload, compactInvestigationState, FINAL_SYNTHESIS_INSTRUCTIONS, SYSTEM_INSTRUCTIONS, type ToolEvidence } from '../src/ai-investigator/orchestrator.js'
import { DiscoveryFixtureExecutor, fixtureCurrent } from '../test/fixtures/ai-investigator-discovery-fixture.js'

const model = 'gpt-5.2'
const toolDefinitions = new DiscoveryFixtureExecutor().definitions
const signal = new AbortController().signal

function input(value: unknown): unknown[] { return [{ role: 'user', content: JSON.stringify(value) }] }
function currentPayload(state: unknown, final: boolean) {
  return buildAiResponsesRequestPayload(model, input({ request: { task: 'Discover unusual behavior', currentPeriod: fixtureCurrent }, state }), final ? FINAL_SYNTHESIS_INSTRUCTIONS : SYSTEM_INSTRUCTIONS, final ? [] : toolDefinitions, final ? 'none' : 'auto', final ? { structuredOutputSchema: AI_INVESTIGATOR_CONTENT_SCHEMA as unknown as Record<string, unknown>, maxOutputTokens: 2_400 } : { maxOutputTokens: 600 })
}
function optimizedPayload(value: unknown, final: boolean) {
  return buildAiResponsesRequestPayload(model, input(value), DISCOVERY_INSTRUCTIONS, final ? [] : toolDefinitions, final ? 'none' : 'auto', final ? { structuredOutputSchema: AI_INVESTIGATOR_DISCOVERY_SCHEMA as unknown as Record<string, unknown>, structuredOutputName: 'process_intelligence_discovery', maxOutputTokens: DISCOVERY_OUTPUT_TOKENS } : { maxOutputTokens: 400 })
}

async function scenario(pressKey: 'press14' | null) {
  const request = { scope: { pressKey }, range: fixtureCurrent, analysis: 'discover_unusual_behavior' as const }
  const preflight = await buildDiscoveryPreflight(new DiscoveryFixtureExecutor(), request, signal)
  const currentEvidence = preflight.evidence.find((item) => item.name === 'get_fleet_operational_summary' && (item.arguments as { start: string }).start === fixtureCurrent.startUtc)!
  const comparison: ToolEvidence = { name: 'compare_press_period', arguments: { press: pressKey ?? 'ranked candidates' }, result: { facts: preflight.facts.filter((fact) => !['eventTimestamp', 'eventDurationMinutes'].includes(fact.metric) && fact.source !== 'production_context'), limitations: preflight.limitations }, durationMs: 0 }
  const eventEvidence = preflight.evidence.filter((item) => item.name === 'get_press_event_summary')
  const states = [[], [currentEvidence], [currentEvidence, comparison], [currentEvidence, comparison, ...eventEvidence]].map((evidence) => compactInvestigationState(evidence as ToolEvidence[]))
  const currentMulti = cumulativeOfflineProfile(states.map((state, index) => currentPayload(state, index === states.length - 1)))
  const compact = preflight.modelInput as Record<string, unknown>
  const requestOnly = { version: compact.version, task: compact.task, scope: compact.scope, ranges: compact.ranges }
  const scored = { ...requestOnly, selection: compact.selection, candidates: (compact.candidates as unknown[]).map((candidate) => { const value = candidate as Record<string, unknown>; return { id: value.id, score: value.score } }) }
  const optimizedMulti = cumulativeOfflineProfile([optimizedPayload(requestOnly, false), optimizedPayload(scored, false), optimizedPayload(compact, false), optimizedPayload(compact, true)])
  const singlePayload = optimizedPayload(compact, true); const singleSynthesis = cumulativeOfflineProfile([singlePayload])
  return { currentMulti, optimizedMulti, singleSynthesis, analytics: preflight.analytics, performance: preflight.performance, topContributors: currentMulti.contributors.slice(0, 10) }
}

const press14 = await scenario('press14'); const allPresses = await scenario(null)
const candidatePackages = []
for (const candidateLimit of [3, 5, 12]) {
  const preflight = await buildDiscoveryPreflight(new DiscoveryFixtureExecutor(), { scope: { pressKey: null }, range: fixtureCurrent, analysis: 'discover_unusual_behavior' }, signal, { candidateLimit })
  const profile = profileAiResponsesRequest(optimizedPayload(preflight.modelInput, true))
  candidatePackages.push({ candidateLimit, candidateCount: preflight.candidates.length, exactRequestBytes: profile.exactRequestBytes, estimatedInputTokens: profile.estimatedInputTokens })
}
const report = { generatedOffline: true, openAiCalls: 0, press14, allPresses, candidatePackages }
if (press14.singleSynthesis.estimatedInputTokens > 3_000) throw new Error(`press14_discovery_input_budget_exceeded:${press14.singleSynthesis.estimatedInputTokens}`)
if (allPresses.singleSynthesis.estimatedInputTokens > 6_000) throw new Error(`all_press_discovery_input_budget_exceeded:${allPresses.singleSynthesis.estimatedInputTokens}`)
if (process.argv.includes('--summary')) console.log(JSON.stringify({
  generatedOffline: report.generatedOffline, openAiCalls: report.openAiCalls,
  press14: { currentMulti: press14.currentMulti.estimatedInputTokens, optimizedMulti: press14.optimizedMulti.estimatedInputTokens, singleSynthesis: press14.singleSynthesis.estimatedInputTokens, outputTokens: DISCOVERY_OUTPUT_TOKENS, analytics: press14.analytics, performance: press14.performance },
  allPresses: { currentMulti: allPresses.currentMulti.estimatedInputTokens, optimizedMulti: allPresses.optimizedMulti.estimatedInputTokens, singleSynthesis: allPresses.singleSynthesis.estimatedInputTokens, outputTokens: DISCOVERY_OUTPUT_TOKENS, analytics: allPresses.analytics, performance: allPresses.performance },
  allPressesCurrentTopContributors: allPresses.topContributors,
  candidatePackages,
}, null, 2))
else console.log(JSON.stringify(report, null, 2))
