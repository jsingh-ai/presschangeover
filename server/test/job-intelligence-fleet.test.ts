import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { AddressInfo } from 'node:net'
import { buildFleetReport, matchesFleetSelection, metricDistribution } from '../src/job-intelligence/fleet-engine.js'
import { createApp } from '../src/app.js'
import { InMemoryJobHistoryRepository, materializedRun } from '../src/job-intelligence/history-repository.js'
import type { TelemetryClient } from '../src/telemetry/telemetry-api-client.js'
import type { JobRefinement, ProductionRun } from '../src/job-intelligence/contracts.js'
import type { RadiusPressKey } from '../src/radius/models.js'

const start = Date.parse('2026-08-01T00:00:00.000Z')
const at = (hours: number) => new Date(start + hours * 3_600_000).toISOString()

function run(id: string, pressKey: RadiusPressKey, hour: number, input: { recipe?: string; material?: string; customer?: string; previousRecipe?: string; previousMaterial?: string; good?: number; makeReady?: number; bad?: number; transition?: number | null; interrupted?: boolean; deck?: number | null; speed?: number | null } = {}): ProductionRun {
  const good = input.good ?? 2_700; const makeReady = input.makeReady ?? 600; const bad = input.bad ?? 300; const recipe = input.recipe ?? 'A-NPU01-X'; const material = input.material ?? 'PP'; const transition = input.transition === undefined ? 900 : input.transition
  const identities = { order: `O-${id}`, recipe, customer: input.customer ?? 'POLITEX', material }
  const previousIdentities = input.previousRecipe || input.previousMaterial ? { recipe: input.previousRecipe ?? 'PREV', material: input.previousMaterial ?? material, customer: 'POLITEX' } : null
  return {
    runId: id, pressKey, startUtc: at(hour), endUtc: at(hour + 1), durationSeconds: 3_600, identities, previousIdentities, nextIdentities: null, boundaryFields: previousIdentities ? ['recipe'] : [], contextSettlingSeconds: previousIdentities ? 300 : 0,
    identityTransition: { identityChangeFirstSeenAtUtc: previousIdentities ? at(hour) : null, identityLastChangeAtUtc: previousIdentities ? new Date(Date.parse(at(hour)) + 60_000).toISOString() : null, identitySettledAtUtc: previousIdentities ? new Date(Date.parse(at(hour)) + 360_000).toISOString() : null, settleState: previousIdentities ? 'confirmed' : 'range_start', previousResolvedIdentity: previousIdentities, finalResolvedIdentity: identities, inferredBoundary: Boolean(previousIdentities) },
    dataInterrupted: input.interrupted ?? false, coveragePercent: 100, identityConfidence: 'high', goodSeconds: good, makeReadySeconds: makeReady, badSeconds: bad, otherRadiusSeconds: 0, productionInterruptionCount: 1, transitionToStableProductionSeconds: transition, transitionMetric: transition === null ? 'unavailable' : 'radius_stable_production_proxy',
    transitionTiming: { outgoingStableRadiusProductionEndUtc: previousIdentities ? at(hour) : null, incomingStableRadiusProductionStartUtc: transition === null ? null : new Date(Date.parse(at(hour)) + transition * 1_000).toISOString(), radiusStableProductionProxySeconds: transition, metadataFirstSeenToStableSeconds: transition, metadataSettledToStableSeconds: transition === null ? null : transition - 360, telemetryPhysicalProductionAtUtc: null, timingUncertaintySeconds: previousIdentities ? 360 : null },
    radiusEpisodes: [{ eventType: 'M', statusCode: '20', statusDescription: 'Registration', startUtc: at(hour), endUtc: new Date(Date.parse(at(hour)) + makeReady * 1_000).toISOString(), durationSeconds: makeReady }, { eventType: 'G', statusCode: '10', statusDescription: 'Run Production', startUtc: new Date(Date.parse(at(hour)) + makeReady * 1_000).toISOString(), endUtc: at(hour + 1), durationSeconds: good + bad }],
    deckConfiguration: input.deck === null || input.deck === undefined ? null : { activeDecks: [1, input.deck], reusedDecks: [1], addedDecks: [input.deck], removedDecks: [], changedDeckCount: 1, evidenceCanonicalId: 'deck.active' },
    runningPerformance: { stableProductionStartUtc: new Date(Date.parse(at(hour)) + (transition ?? 0) * 1_000).toISOString(), observedSeconds: good + bad, goodSeconds: good, badSeconds: bad, interruptions: 1, interruptionsPerProductionHour: 1 / (good / 3600), medianUninterruptedGoodSeconds: good / 2, restartCount: 1, speed: input.speed === null || input.speed === undefined ? null : { canonicalId: 'machine.speed.actual', sourceUnit: 'fpm', canonicalUnitStatus: 'canonical', sampleCount: 20, median: input.speed, p25: input.speed - 10, p75: input.speed + 10, p90: input.speed + 15, timeWeightedMean: input.speed - 2 } },
  }
}

const report = (runs: ProductionRun[], refinements: JobRefinement[] = [], focusPressKey: RadiusPressKey | null = null, sort: Parameters<typeof buildFleetReport>[0]['historicalRunSort'] = 'newest') => buildFleetReport({ runs, dimension: 'recipe', group: { operator: 'contains', query: 'NPU01' }, refinements, focusPressKey, fromUtc: at(0), toUtc: at(200), algorithmVersion: 'test-v2', historicalRunIds: new Set(runs.map((item) => item.runId)), liveRunIds: new Set(), offset: 0, limit: 50, historicalRunSort: sort, coverage: [] })

describe('Job Intelligence fleet-first reporting', () => {
  it('serves a materialized fleet report, value list, and run inspector without requiring a press or rereading live sources', async () => {
    const runs = [run('http-p5', 'press5', 1), run('http-p8', 'press8', 2)]
    const repository = new InMemoryJobHistoryRepository(); await repository.upsertRuns(runs.map((item) => materializedRun(item, at(0), at(100), { isClosed: true })))
    const telemetryClient = { getHealth: async () => ({ service: 'TelemetryQueryApi', status: 'healthy' }), getDatabaseHealth: async () => ({ service: 'TelemetryQueryApi', database: 'telemetry', status: 'healthy' }), getSources: async () => [], getPhysicalState: async () => { throw new Error('not called') } } as TelemetryClient
    const server = createApp({ telemetryClient, jobHistoryRepository: repository, logger: false }).listen(0, '127.0.0.1'); await new Promise<void>((resolve) => server.once('listening', resolve)); const address = server.address() as AddressInfo
    try {
      const base = `http://127.0.0.1:${address.port}/api/job-intelligence`; const range = `fromUtc=${encodeURIComponent(at(0))}&toUtc=${encodeURIComponent(at(100))}&analyzeBy=recipe`
      const response = await fetch(`${base}/report?${range}&operator=contains&query=NPU01&focusPressKey=press5`); assert.equal(response.status, 200)
      const body = await response.json() as ReturnType<typeof report>; assert.deepEqual(body.selection.matchingPresses, ['press5', 'press8']); assert.equal(body.focusPressKey, 'press5')
      const values = await (await fetch(`${base}/values?${range}`)).json() as { values: Array<{ value: string }> }; assert.deepEqual(values.values.map((item) => item.value), ['A-NPU01-X'])
      const inspector = await fetch(`${base}/runs/http-p5`); assert.equal(inspector.status, 200)
      const inspectorBody = await inspector.json() as { version: string; run: { runId: string; identityTransition: unknown; transitionTiming: unknown; mainRadiusLosses: unknown[]; radiusEpisodes?: unknown; speedSamples?: unknown } }
      assert.equal(inspectorBody.version, 'job-intelligence-run-v3'); assert.equal(inspectorBody.run.runId, 'http-p5')
      assert.ok(inspectorBody.run.identityTransition); assert.ok(inspectorBody.run.transitionTiming); assert.equal(inspectorBody.run.mainRadiusLosses.length, 1)
      assert.equal(inspectorBody.run.radiusEpisodes, undefined); assert.equal(inspectorBody.run.speedSamples, undefined)
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) }
  })

  it('returns every matching press and keeps optional focus as a highlight rather than a filter', () => {
    const runs = [run('p5-a', 'press5', 1), run('p8-a', 'press8', 2), run('other', 'press10', 3, { recipe: 'OTHER' })]
    const result = report(runs, [], 'press5')
    assert.deepEqual(result.selection.matchingPresses, ['press5', 'press8'])
    assert.equal(result.focusPressKey, 'press5'); assert.equal(result.presses.length, 2); assert.deepEqual(result.selection.includedValues, ['A-NPU01-X'])
  })

  it('recomputes the actual population for cross-dimension and previous-identity refinements', () => {
    const pp = run('pp', 'press5', 1, { material: 'PP', previousMaterial: 'LDPE' }); const ldpe = run('ldpe', 'press8', 2, { material: 'LDPE', previousMaterial: 'PP' }); const customer = run('customer', 'press10', 3, { material: 'PP', customer: 'OTHER' })
    const materialRefinement: JobRefinement[] = [{ dimension: 'material', group: { operator: 'exact', query: 'PP' } }, { dimension: 'customer', group: { operator: 'exact', query: 'POLITEX' } }]
    assert.deepEqual(report([pp, ldpe, customer], materialRefinement).selection.matchingPresses, ['press5'])
    const previous: JobRefinement[] = [{ dimension: 'material', group: { operator: 'exact', query: 'PP' }, previousIdentity: true }]
    assert.equal(matchesFleetSelection(ldpe, 'recipe', { operator: 'contains', query: 'NPU01' }, previous), true)
    assert.deepEqual(report([pp, ldpe], previous).selection.matchingPresses, ['press8'])
  })

  it('returns compact transition and loss aggregates, deck evidence, and excludes same-value or gap transitions', () => {
    const valid = [run('a', 'press5', 1, { previousRecipe: 'GAP01', transition: 600, deck: 2, speed: 600 }), run('b', 'press8', 2, { previousRecipe: 'GAP01', transition: 1_200, speed: 650 })]
    valid[0]!.radiusEpisodes.push({ eventType: 'M', statusCode: '21', statusDescription: 'Later cleaning', startUtc: new Date(Date.parse(valid[0]!.startUtc) + 1_800_000).toISOString(), endUtc: new Date(Date.parse(valid[0]!.startUtc) + 2_400_000).toISOString(), durationSeconds: 600 }); valid[0]!.makeReadySeconds += 600
    const same = run('same', 'press10', 3, { previousRecipe: 'A-NPU01-X' }); const gap = run('gap', 'press11', 4, { previousRecipe: 'ABC04', interrupted: true })
    const result = report([...valid, same, gap])
    const cell = result.transitionMatrix.find((item) => item.previousValue === 'GAP01')!
    assert.deepEqual(cell.durationSeconds, { n: 2, median: 900, p25: 750, p75: 1_050, p90: 1_140 })
    assert.equal(result.transitionMatrix.some((item) => item.previousValue === 'ABC04'), false)
    assert.equal(result.transitionMatrix.some((item) => item.previousValue === 'A-NPU01-X'), false)
    assert.equal(cell.makeReadySeconds.median, 600); assert.equal(result.presses.find((item) => item.pressKey === 'press5')?.changeover.makeReadySecondsPerTransition, 600)
    const exact = result.radiusLossComparison.find((item) => item.statusDescription === 'Registration')!
    assert.equal(exact.statusCode, '20'); assert.equal(exact.presses[0]?.evidenceRuns[0]?.runId.length! > 0, true)
    assert.equal('evidenceRuns' in cell, false)
    assert.equal(result.presses.find((item) => item.pressKey === 'press5')?.deckEvidence, 'available')
    assert.equal(result.presses.find((item) => item.pressKey === 'press8')?.deckEvidence, 'unavailable')
  })

  it('sorts bounded historical pages deterministically and exposes sample sizes', () => {
    const runs = [run('fast', 'press5', 1, { speed: 700, good: 3_200, makeReady: 300, bad: 100 }), run('slow', 'press8', 2, { speed: 500, good: 2_000, makeReady: 1_000, bad: 600 })]
    assert.equal(report(runs, [], null, 'worst_good').historicalRuns.items[0]?.runId, 'slow')
    assert.equal(report(runs, [], null, 'highest_speed').historicalRuns.items[0]?.runId, 'fast')
    assert.equal(metricDistribution([1, 2, 3, 100]).n, 4)
  })
})
