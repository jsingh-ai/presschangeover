import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { IndustrialAnalyticalObservation, IndustrialAnalysisFamily } from '../src/industrial-analytics/contracts.js'
import type { RadiusPressKey } from '../src/radius/models.js'
import type { AiInvestigatorConfig } from '../src/config.js'
import type { AiGroundingFact, AiInvestigatorDiscoveryDraftContent } from '../src/ai-investigator/contracts.js'
import { buildDiscoveryPreflight, expandDiscoveryDraft, validateDiscoveryReferences } from '../src/ai-investigator/discovery.js'
import { createIndustrialObservationFacts, createRadiusDriverDurationFact, radiusDriverIdentity, validateDiscoveryEvidenceGraph } from '../src/ai-investigator/evidence-graph.js'
import { groundAiInvestigatorDraft } from '../src/ai-investigator/grounding.js'
import { AiInvestigatorOrchestrator, type AiInvestigatorLogger, type AiInvestigatorModelClient } from '../src/ai-investigator/orchestrator.js'
import { AI_INVESTIGATOR_TOOL_DEFINITIONS, type AiInvestigatorToolExecutor, type AiToolExecutionContext, type AiToolResult } from '../src/ai-investigator/read-only-tools.js'
import { DiscoveryFixtureExecutor, fixtureCurrent } from './fixtures/ai-investigator-discovery-fixture.js'

const config: AiInvestigatorConfig = { enabled: true, apiKey: 'offline-test', model: 'test-model', totalTimeoutMs: 2_000, toolTimeoutMs: 500, openAiTimeoutMs: 500, maxToolCalls: 8, maxToolRounds: 4, maxParallelTools: 3 }
const current = { startUtc: '2026-08-17T00:43:54.573Z', endUtc: '2026-08-18T00:43:54.573Z' }
const baseline = { startUtc: '2026-08-16T00:43:54.573Z', endUtc: current.startUtc }
const request = { scope: { pressKey: 'press14' as const }, range: current, analysis: 'discover_unusual_behavior' as const }
const runDriver = { eventType: 'G', statusCode: '150', statusDescription: 'Run Production', occurrences: 1 }
const makeReadyDriver = { eventType: 'M', statusCode: '47', statusDescription: 'Make Ready - Time Required to Setup Job', occurrences: 1 }

function summaryFact(metric: string, value: number, suffix: string, role: 'current' | 'baseline', range: { startUtc: string; endUtc: string }): AiGroundingFact {
  const labels: Record<string, string> = { coveragePercent: 'Data coverage', productionPercent: 'Production time', interruptions: 'Production interruptions', longestInterruptionMinutes: 'Longest interruption' }
  const units: Record<string, string> = { coveragePercent: 'percent', productionPercent: 'percent', interruptions: 'count', longestInterruptionMinutes: 'minutes' }
  return { factId: `press14.${suffix}.${role}`, pressKey: 'press14', press: 'Press 14', source: metric === 'coveragePercent' ? 'coverage' : 'radius', metric, value, unit: units[metric]!, role, usable: true, label: labels[metric]!, range: { start: range.startUtc, end: range.endUtc } }
}

function fleetResult(period: 'current' | 'baseline'): AiToolResult {
  const isCurrent = period === 'current'; const range = isCurrent ? current : baseline
  const values = isCurrent ? { coverage: 99.6, production: 49, interruptions: 11, longest: 222.7, run: 702, makeReady: 132 } : { coverage: 100, production: 65.4, interruptions: 8, longest: 172.5, run: 942.4, makeReady: 64.3 }
  const drivers = [{ ...runDriver, durationMinutes: values.run }, { ...makeReadyDriver, durationMinutes: values.makeReady }]
  const role = isCurrent ? 'current' : 'baseline'
  return {
    range: { start: range.startUtc, end: range.endUtc }, scope: 'press14',
    presses: [{ pressKey: 'press14', press: 'Press 14', coveragePercent: values.coverage, productionPercent: values.production, productionInterruptions: values.interruptions, longestInterruptionMinutes: values.longest, leadingRadiusStates: drivers }],
    facts: [
      summaryFact('coveragePercent', values.coverage, 'coverage_percent', role, range), summaryFact('productionPercent', values.production, 'production_percent', role, range),
      summaryFact('interruptions', values.interruptions, 'interruptions', role, range), summaryFact('longestInterruptionMinutes', values.longest, 'longest_interruption_minutes', role, range),
      ...drivers.map((driver) => createRadiusDriverDurationFact({ pressKey: 'press14', press: 'Press 14', driver, role, range: { start: range.startUtc, end: range.endUtc } })),
    ],
    limitations: [],
  }
}

class RadiusDriverFailureFixture implements AiInvestigatorToolExecutor {
  readonly definitions = AI_INVESTIGATOR_TOOL_DEFINITIONS
  async execute(name: string, rawArguments: unknown, _context: AiToolExecutionContext): Promise<AiToolResult> {
    const args = rawArguments as Record<string, unknown>
    if (name === 'get_fleet_operational_summary') return fleetResult(args.start === current.startUtc ? 'current' : 'baseline')
    if (name === 'get_press_event_summary') return { press: 'Press 14', pressKey: 'press14', range: { start: current.startUtc, end: current.endUtc }, facts: [{ ...summaryFact('longestInterruptionMinutes', 384.7, 'longest_interruption_minutes', 'current', current), label: 'Event-summary longest interruption' }], industrialAnalytics: { calculatedCount: 0, retainedCount: 0, observations: [] }, limitations: [] }
    throw new Error('fixture_tool_not_implemented')
  }
}

function observation(family: IndustrialAnalysisFamily, index: number): IndustrialAnalyticalObservation {
  const metricsByFamily: Record<IndustrialAnalysisFamily, Record<string, string | number | null>> = {
    baseline_deviation: { unit: 'minutes', current: 12, baseline: 8, delta: 4 }, robust_numeric_change: { unit: 'rpm', median: 10, startEndDelta: 3, largestDelta: 4, standardDeviation: 1.2 },
    event_aligned_change: { unit: 'rpm', beforeMedian: 8, eventMedian: 12, afterMedian: 9, beforeToEventDelta: 4 }, value_state_transition: { transitionCount: 3, transitionsNearEvent: 2, stateBefore: 'A', stateAfter: 'B' },
    radius_sequence_deviation: { commonSequenceCount: 4, commonSequenceSharePercent: 50, extraStepCount: 14, loopCount: 5 }, numeric_relationship: { pearson: 0.8, spearman: 0.75, bestLagMinutes: 2, bestLagCorrelation: 0.84 },
    cross_press_comparison: { unit: 'percent', pressMedian: 49, compatiblePressMedian: 62, delta: -13 },
  }
  return { observationId: `industrial.family${index}`, family, pressKey: 'press14', deckNumber: null, range: { start: current.startUtc, end: current.endUtc }, comparisonRange: null, eventId: null, variableIds: [`variable.${index}`], factIds: [], metrics: metricsByFamily[family], support: { sampleCount: 10, comparisonSampleCount: 10, coveragePercent: 100, comparisonCoveragePercent: 100, adequate: true, minimumRequired: 3, reason: null }, evidenceSource: family === 'radius_sequence_deviation' ? 'radius' : family === 'baseline_deviation' || family === 'cross_press_comparison' ? 'comparison' : 'telemetry', magnitudeInputs: { magnitude: index + 1 }, material: true, limitations: [], explorer: null }
}

describe('AI Investigator evidence graph', () => {
  it('registers the exact live Radius-driver current/baseline/delta triplet and reconstructs every selectable fact', async () => {
    assert.equal(radiusDriverIdentity(makeReadyDriver), 'cf62e67cbd')
    const preflight = await buildDiscoveryPreflight(new RadiusDriverFailureFixture(), request, new AbortController().signal, { candidateLimit: 1 })
    const missingBefore = 'press14.radius_driver.cf62e67cbd.duration_minutes.baseline'
    const makeReadyObservation = preflight.candidates[0]!.observations.find((item) => item.factIds.includes(missingBefore))
    assert.ok(makeReadyObservation)
    assert.deepEqual(makeReadyObservation.factIds, ['press14.radius_driver.cf62e67cbd.duration_minutes.current', missingBefore, 'press14.radius_driver.cf62e67cbd.duration_minutes.delta'])
    assert.ok(preflight.facts.some((fact) => fact.factId === missingBefore && fact.role === 'baseline' && fact.value === 64.3))
    assert.equal(preflight.facts.find((fact) => fact.factId === 'press14.longest_interruption_minutes.current')?.value, 222.7)
    assert.deepEqual({ valid: preflight.evidenceGraph.valid, unresolved: preflight.evidenceGraph.unresolvedReferences, crossPress: preflight.evidenceGraph.crossPressViolations, unusable: preflight.evidenceGraph.unusableAdvertisedFacts }, { valid: true, unresolved: 0, crossPress: 0, unusable: 0 })
    for (const factId of preflight.candidates[0]!.facts.map((fact) => fact.factId)) {
      const draft: AiInvestigatorDiscoveryDraftContent = { summary: 'Synthetic reference validation.', findings: [{ candidateId: 'press14', title: 'Review deterministic evidence', importance: 'medium', confidence: 'medium', factIds: [factId], interpretation: 'The selected evidence merits review.', whyWorthInvestigating: 'It is part of the validated candidate package.', recommendedInvestigation: 'Inspect the corresponding evidence.' }], limitations: [] }
      const references = validateDiscoveryReferences(draft, preflight.candidates, preflight.facts)
      assert.equal(references.issues.length, 0, factId)
      const grounded = groundAiInvestigatorDraft(expandDiscoveryDraft(references.accepted, preflight.facts), preflight.facts, request)
      assert.equal(grounded.issues.length, 0, factId); assert.equal(grounded.content.findings.length, 1, factId)
    }
  })

  it('holds graph invariants for Press 14, Press 10, Press 13, Press 6, and synthetic All Presses', async () => {
    for (const pressKey of ['press14', 'press10', 'press13', 'press6'] as RadiusPressKey[]) {
      const preflight = await buildDiscoveryPreflight(new DiscoveryFixtureExecutor(), { scope: { pressKey }, range: fixtureCurrent, analysis: 'discover_unusual_behavior' }, new AbortController().signal)
      assert.deepEqual({ valid: preflight.evidenceGraph.valid, unresolved: preflight.evidenceGraph.unresolvedReferences, crossPress: preflight.evidenceGraph.crossPressViolations, unusable: preflight.evidenceGraph.unusableAdvertisedFacts }, { valid: true, unresolved: 0, crossPress: 0, unusable: 0 }, pressKey)
    }
    const fleet = await buildDiscoveryPreflight(new DiscoveryFixtureExecutor(), { scope: { pressKey: null }, range: fixtureCurrent, analysis: 'discover_unusual_behavior' }, new AbortController().signal)
    assert.equal(fleet.candidates.length, 5); assert.equal(fleet.evidenceGraph.valid, true); assert.equal(fleet.evidenceGraph.unresolvedReferences, 0); assert.equal(fleet.evidenceGraph.crossPressViolations, 0); assert.equal(fleet.evidenceGraph.unusableAdvertisedFacts, 0)
  })

  it('validates registered facts for every Industrial Analytics family including Pearson, Spearman, and lag metrics', () => {
    const families: IndustrialAnalysisFamily[] = ['baseline_deviation', 'robust_numeric_change', 'event_aligned_change', 'value_state_transition', 'radius_sequence_deviation', 'numeric_relationship', 'cross_press_comparison']
    const observations = families.map(observation); const facts = observations.flatMap((item) => createIndustrialObservationFacts(item, 'Press 14'))
    const candidate = { pressKey: 'press14' as const, observations, facts }
    const modelInput = { candidates: [{ id: 'press14', observations: observations.map((item) => [item.observationId, item.family, null, item.variableIds, item.factIds]), facts: facts.map((fact) => [fact.factId]) }] }
    const result = validateDiscoveryEvidenceGraph({ facts, observations, candidates: [candidate], modelInput })
    assert.equal(result.valid, true); assert.equal(result.unresolvedReferences, 0); assert.equal(result.crossPressViolations, 0); assert.equal(result.unusableAdvertisedFacts, 0)
    const relationship = observations.find((item) => item.family === 'numeric_relationship')!
    assert.ok(['pearson', 'spearman', 'bestLagMinutes', 'bestLagCorrelation'].every((metric) => relationship.factIds.some((factId) => factId.includes(`.${metric}.event`))))
  })

  it('detects missing, cross-press, unusable, and model-only references', () => {
    const sourceObservation = observation('baseline_deviation', 1); const facts = createIndustrialObservationFacts(sourceObservation, 'Press 14'); const candidate = { pressKey: 'press14' as const, observations: [sourceObservation], facts }
    const missingObservation = { ...sourceObservation, factIds: [...sourceObservation.factIds, 'press14.missing.fact'] }
    assert.ok(validateDiscoveryEvidenceGraph({ facts, observations: [missingObservation], candidates: [{ ...candidate, observations: [missingObservation] }] }).issues.some((item) => item.code === 'unknown_fact_id'))
    const crossPress = { ...facts[0]!, pressKey: 'press10' as const }
    assert.ok(validateDiscoveryEvidenceGraph({ facts: [crossPress, ...facts.slice(1)], observations: [sourceObservation], candidates: [candidate] }).issues.some((item) => item.code === 'cross_press_fact'))
    const unusable = { ...facts[0]!, usable: false }
    assert.ok(validateDiscoveryEvidenceGraph({ facts: [unusable, ...facts.slice(1)], observations: [sourceObservation], candidates: [candidate] }).issues.some((item) => item.code === 'unusable_fact'))
    const modelInput = { candidates: [{ id: 'press14', observations: [[sourceObservation.observationId, sourceObservation.family, null, sourceObservation.variableIds, ['press14.model.only']]], facts: facts.map((fact) => [fact.factId]) }] }
    assert.ok(validateDiscoveryEvidenceGraph({ facts, observations: [sourceObservation], candidates: [candidate], modelInput }).issues.some((item) => item.code === 'unknown_model_fact_id'))
  })

  it('fails before OpenAI and logs only safe evidence diagnostics for an inconsistent package', async () => {
    const executor = new RadiusDriverFailureFixture()
    const original = executor.execute.bind(executor)
    executor.execute = async (name, args, context) => {
      const result = await original(name, args, context)
      if (name !== 'get_press_event_summary') return result
      const inconsistent = observation('event_aligned_change', 99); inconsistent.factIds = ['press14.internal.missing.event']
      return { ...result, industrialAnalytics: { calculatedCount: 1, retainedCount: 1, observations: [inconsistent] } }
    }
    let modelCalls = 0; const model: AiInvestigatorModelClient = { create: async () => { modelCalls += 1; throw new Error('model_must_not_run') } }
    const entries: Array<Record<string, unknown>> = []; const logger: AiInvestigatorLogger = { info: (line) => entries.push(JSON.parse(line) as Record<string, unknown>), error: (line) => entries.push(JSON.parse(line) as Record<string, unknown>) }
    const result = await new AiInvestigatorOrchestrator(config, executor, model, logger).analyzeDiscovery(request)
    assert.equal(result.status, 'error'); assert.equal(modelCalls, 0); assert.match(result.limitations.join(' '), /invalid_discovery_evidence/)
    const entry = entries.find((item) => item.event === 'ai_investigator_evidence_graph_validation_failed')
    assert.deepEqual({ stage: entry?.generationStage, code: entry?.code, candidateId: entry?.candidateId, observationId: entry?.observationId, factId: entry?.factId }, { stage: 'observation_registry', code: 'unknown_fact_id', candidateId: 'press14', observationId: inconsistentId(), factId: 'press14.internal.missing.event' })
    assert.doesNotMatch(JSON.stringify(entries), /eventMedian|beforeMedian|model_must_not_run/)
  })
})

function inconsistentId() { return 'industrial.family99' }
