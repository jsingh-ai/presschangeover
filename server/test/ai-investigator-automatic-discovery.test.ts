import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildDeterministicDiscovery } from '../src/ai-investigator/discovery-presentation.js'
import { buildDiscoveryPreflight } from '../src/ai-investigator/discovery.js'
import { buildCategoricalTemporalEvidenceProgram } from '../src/industrial-analytics/temporal-evidence.js'
import { DiscoveryFixtureExecutor, fixtureCurrent } from './fixtures/ai-investigator-discovery-fixture.js'

const request = { scope: { pressKey: 'press14' as const }, range: fixtureCurrent, analysis: 'discover_unusual_behavior' as const }

describe('AI Investigator automatic visual discovery', () => {
  it('generates bounded numeric, speed, Radius, context, recurrence, and Event Learning findings without raw scanning', async () => {
    const preflight = await buildDiscoveryPreflight(new DiscoveryFixtureExecutor(true), request, new AbortController().signal, { includeDiagnostics: true })
    const result = buildDeterministicDiscovery(preflight, request)
    assert.ok(result.findings.length >= 5 && result.findings.length <= 8)
    assert.equal(result.bounds.maximumFindings, 8); assert.equal(result.bounds.automaticRawSignalScans, 0); assert.equal(result.eventLearning.reusedSharedEngine, true)
    assert.ok(result.eventLearning.enrichedFindings > 0)
    const categories = new Set(result.findings.map((finding) => finding.category)); assert.ok(categories.has('telemetry')); assert.ok(categories.has('speed')); assert.ok(categories.has('radius')); assert.ok(categories.has('context'))
    assert.ok(result.findings.some((finding) => finding.title === 'Production interruption recurrence'))
    assert.ok(result.findings.some((finding) => finding.visualization.kind === 'sparkline'))
    assert.ok(result.findings.some((finding) => finding.visualization.kind === 'sequence'))
    assert.ok(result.findings.every((finding) => finding.whyShown.length > 0 && finding.rankingFactors.length > 0 && finding.links[0]?.label === 'Verify'))
    assert.ok(result.findings.some((finding) => finding.links[0]?.href.includes('/telemetry-event-explorer?') && finding.links[0].href.includes('autorun=1')))
    assert.ok(result.findings.some((finding) => finding.links[0]?.href.includes('/raw-radius-explorer?') && finding.links[0].href.includes('fromUtc=')))
    assert.deepEqual(result.evidenceGraph, { registeredFacts: preflight.evidenceGraph.registeredFacts, unresolvedReferences: 0, crossPressViolations: 0 })
  })

  it('surfaces a bounded boolean/state transition as a state card', async () => {
    const preflight = await buildDiscoveryPreflight(new DiscoveryFixtureExecutor(true), request, new AbortController().signal)
    const candidate = preflight.candidates[0]!
    const state = buildCategoricalTemporalEvidenceProgram({ candidateId: 'press14', pressKey: 'press14', eventId: 'press14-state-event', canonicalId: 'impression.enabled', datatype: 'categorical', range: { start: '2026-08-17T03:40:00.000Z', end: '2026-08-17T04:30:00.000Z' }, event: { start: '2026-08-17T04:00:00.000Z', end: '2026-08-17T04:10:00.000Z' }, samples: [{ atUtc: '2026-08-17T03:40:00.000Z', value: true }, { atUtc: '2026-08-17T04:00:00.000Z', value: false }, { atUtc: '2026-08-17T04:10:00.000Z', value: true }], selectedBecause: ['authoritative state transition'] })!
    const result = buildDeterministicDiscovery({ ...preflight, candidates: [{ ...candidate, traces: [state, ...(candidate.traces ?? []).slice(0, 6)] }] }, request)
    const finding = result.findings.find((item) => item.category === 'state')
    assert.ok(finding); assert.equal(finding.visualization.kind, 'state'); assert.match(finding.metric, /true -> false/); assert.ok(finding.links[0]?.href.includes('eventType=value_change'))
  })
})
