import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { AddressInfo } from 'node:net'
import { createApp } from '../src/app.js'
import { deriveProductionRuns, evidenceSupport, matchesJobGroup, summarizeIdentities, summarizeRadiusLosses, summarizeTransitions } from '../src/job-intelligence/engine.js'
import { JobIntelligenceService, readJobProductionContext } from '../src/job-intelligence/service.js'
import { JobIntelligenceRadiusAcquisitionLimiter } from '../src/job-intelligence/radius-acquisition-limiter.js'
import type { RadiusService } from '../src/radius/radius-service.js'
import type { RadiusStatusSegment } from '../src/radius/models.js'
import type { TelemetryClient } from '../src/telemetry/telemetry-api-client.js'
import type { TelemetryFoundationService } from '../src/telemetry/telemetry-foundation-service.js'
import type { PressEvidenceCapabilities, ProductionContextEvidence } from '../src/telemetry/telemetry-contracts.js'

const start = '2026-08-20T00:00:00.000Z'
const at = (minutes: number) => new Date(Date.parse(start) + minutes * 60_000).toISOString()

function field(field: 'job' | 'order' | 'recipe' | 'customer' | 'material' | 'roll', value: string | null) {
  return { field, canonicalId: `production.${field}`, capabilityState: 'SUPPORTED' as const, observationState: value === null ? 'SUPPORTED_WITH_NO_SAMPLES_IN_RANGE' as const : 'SUPPORTED_WITH_SEED_ONLY' as const, seed: value === null ? null : { observedAtUtc: at(-1), receivedAtUtc: at(-1), sourceTimestampUtc: at(-1), qualityState: 'good', valueKind: 'string' as const, value }, changes: [] }
}

function context(): ProductionContextEvidence {
  return {
    pressKey: 'press5', sourceKey: 'press5', displayName: 'Press 5', fromUtc: start, toUtc: at(240),
    fields: { job: field('job', null), order: field('order', 'A'), recipe: field('recipe', 'R1'), customer: field('customer', 'C1'), material: field('material', 'M1'), roll: field('roll', null) },
    changes: [
      { atUtc: at(60), field: 'order', canonicalId: 'production.order', previousValueKind: 'string', previousValue: 'A', valueKind: 'string', value: 'B', qualityState: 'good' },
      { atUtc: at(61), field: 'recipe', canonicalId: 'production.recipe', previousValueKind: 'string', previousValue: 'R1', valueKind: 'string', value: 'R2', qualityState: 'good' },
      { atUtc: at(64), field: 'customer', canonicalId: 'production.customer', previousValueKind: 'string', previousValue: 'C1', valueKind: 'string', value: 'C2', qualityState: 'good' },
    ],
  }
}

function segment(startMinute: number, endMinute: number, eventType: string, description: string, statusCode: string): RadiusStatusSegment {
  return { kind: 'radius', machineId: 205, pressKey: 'press5', displayName: 'Press 5', startUtc: at(startMinute), endUtc: at(endMinute), durationSeconds: (endMinute - startMinute) * 60, isOpen: false, sourceGeneration: 'compact', eventType, statusCode, statusDescription: description, isProduction: eventType === 'G' && description === 'Run Production' }
}

function gap(startMinute: number, endMinute: number): RadiusStatusSegment {
  return { kind: 'offline', machineId: 205, pressKey: 'press5', displayName: 'Press 5', startUtc: at(startMinute), endUtc: at(endMinute), durationSeconds: (endMinute - startMinute) * 60, isOpen: false, sourceGeneration: 'offline_inference', eventType: null, statusCode: null, statusDescription: null, isProduction: false }
}

describe('Job Intelligence production-run derivation', () => {
  it('coalesces asynchronous identity changes while preserving first, final, and settled timing', () => {
    const runs = deriveProductionRuns({ pressKey: 'press5', fromUtc: start, toUtc: at(240), context: context(), radiusSegments: [segment(0, 30, 'G', 'Run Production', '10'), segment(30, 70, 'M', 'Plate / Register', '20'), segment(70, 180, 'G', 'Run Production', '10'), segment(180, 240, 'B', 'Web Break', '30')] })
    assert.equal(runs.length, 2)
    const incoming = runs[1]!
    assert.equal(incoming.startUtc, at(60))
    assert.deepEqual(incoming.identities, { order: 'B', recipe: 'R2', customer: 'C2', material: 'M1' })
    assert.deepEqual(incoming.previousIdentities, { order: 'A', recipe: 'R1', customer: 'C1', material: 'M1' })
    assert.deepEqual(incoming.identityTransition.previousResolvedIdentity, incoming.previousIdentities)
    assert.equal(incoming.identityTransition.identityChangeFirstSeenAtUtc, at(60))
    assert.equal(incoming.identityTransition.identityLastChangeAtUtc, at(64))
    assert.equal(incoming.identityTransition.identitySettledAtUtc, at(69))
    assert.equal(incoming.identityTransition.settleState, 'confirmed')
    assert.equal(incoming.transitionTiming.incomingStableRadiusProductionStartUtc, at(70))
    assert.equal(incoming.transitionTiming.metadataFirstSeenToStableSeconds, 600)
    assert.equal(incoming.transitionTiming.metadataSettledToStableSeconds, 60)
    assert.equal(incoming.transitionTiming.timingUncertaintySeconds, 540)
    assert.equal(incoming.transitionToStableProductionSeconds, 2400)
    const transition = summarizeTransitions(runs, 'order')[0]!
    assert.deepEqual(transition.fingerprint.exactRadiusSequence[0], { eventType: 'M', statusCode: '20', statusDescription: 'Plate / Register' })
    assert.equal(transition.fingerprint.medianTimingUncertaintySeconds, 540)
    assert.equal(transition.fingerprint.telemetryPhysicalTiming, 'not_loaded_in_summary')
    assert.deepEqual(summarizeTransitions(runs, 'material'), [])
  })

  it('does not let a missing identity field invalidate the other dimensions', () => {
    const fixture = context(); fixture.fields.material = { ...fixture.fields.material, capabilityState: 'UNSUPPORTED', observationState: 'UNSUPPORTED', seed: null }
    const runs = deriveProductionRuns({ pressKey: 'press5', fromUtc: start, toUtc: at(240), context: fixture, radiusSegments: [segment(0, 240, 'G', 'Run Production', '10')] })
    assert.equal(runs[0]?.identities.material, undefined)
    assert.equal(runs[0]?.identities.order, 'A')
  })

  it('keeps exact Radius identity in loss summaries and uses documented support thresholds', () => {
    const runs = deriveProductionRuns({ pressKey: 'press5', fromUtc: start, toUtc: at(240), context: context(), radiusSegments: [segment(0, 30, 'G', 'Run Production', '10'), segment(30, 70, 'M', 'Plate / Register', '20'), segment(70, 180, 'G', 'Run Production', '10'), segment(180, 240, 'B', 'Web Break', '30')] })
    const losses = summarizeRadiusLosses(runs, 'press5', start, at(240))
    assert.deepEqual(losses.map(({ eventType, statusCode, statusDescription }) => ({ eventType, statusCode, statusDescription })), [{ eventType: 'B', statusCode: '30', statusDescription: 'Web Break' }, { eventType: 'M', statusCode: '20', statusDescription: 'Plate / Register' }])
    assert.equal(evidenceSupport(runs).level, 'insufficient')
    assert.equal(summarizeIdentities(runs, 'order').length, 2)
  })

  it('splits Radius gaps without assigning them to a state or a transition proxy', () => {
    const fixture = context(); fixture.changes = []
    const runs = deriveProductionRuns({ pressKey: 'press5', fromUtc: start, toUtc: at(120), context: fixture, radiusSegments: [segment(0, 60, 'G', 'Run Production', '10'), gap(60, 70), segment(70, 120, 'G', 'Run Production', '10')] })
    assert.equal(runs.length, 2)
    assert.deepEqual(runs.map(({ startUtc, endUtc, goodSeconds }) => ({ startUtc, endUtc, goodSeconds })), [{ startUtc: at(0), endUtc: at(60), goodSeconds: 3_600 }, { startUtc: at(70), endUtc: at(120), goodSeconds: 3_000 }])
    assert.equal(runs[1]!.identityTransition.settleState, 'after_data_gap')
    assert.equal(runs[1]!.previousIdentities, null)
    assert.equal(runs[1]!.transitionToStableProductionSeconds, null)
    assert.equal(runs[1]!.transitionMetric, 'unavailable')
    assert.equal(runs[1]!.transitionTiming.metadataFirstSeenToStableSeconds, null)
    assert.equal(runs[1]!.transitionTiming.incomingStableRadiusProductionStartUtc, at(70))
  })

  it('derives running-only stability and canonical actual-speed distributions without treating speed as state', () => {
    const fixture = context(); fixture.changes = []; fixture.toUtc = at(120)
    const samples = [10, 50, 65, 75, 110].map((minute, index) => ({ observedAtUtc: at(minute), receivedAtUtc: at(minute), sourceTimestampUtc: at(minute), qualityState: 'good', valueKind: 'number', value: [100, 200, 999, 300, 400][index] }))
    const runs = deriveProductionRuns({ pressKey: 'press5', fromUtc: start, toUtc: at(120), context: fixture, radiusSegments: [segment(0, 60, 'G', 'Run Production', '10'), segment(60, 70, 'B', 'Web Break', '30'), segment(70, 120, 'G', 'Run Production', '10')], speed: { sourceUnit: 'fpm', canonicalUnitStatus: 'canonical', samples: samples as never[] } })
    const running = runs[0]!.runningPerformance!
    assert.equal(running.goodSeconds, 6_600); assert.equal(running.badSeconds, 600); assert.equal(running.interruptions, 1); assert.equal(running.restartCount, 1); assert.equal(running.medianUninterruptedGoodSeconds, 3_300)
    assert.deepEqual(running.speed, { canonicalId: 'machine.speed.actual', sourceUnit: 'fpm', canonicalUnitStatus: 'canonical', sampleCount: 4, median: 250, p25: 175, p75: 325, p90: 370, timeWeightedMean: 215 })
    assert.equal(deriveProductionRuns({ pressKey: 'press5', fromUtc: start, toUtc: at(120), context: fixture, radiusSegments: [segment(0, 120, 'G', 'Run Production', '10')] })[0]?.runningPerformance?.speed, null)
  })
})

describe('Job Intelligence bounded group matching', () => {
  const value = '16900-2300-NPU01-0858'
  it('supports exact, bounded text, position, and generic delimiter segments', () => {
    assert.equal(matchesJobGroup(value, { operator: 'exact', query: value }), true)
    assert.equal(matchesJobGroup(value, { operator: 'contains', query: '2300' }), true)
    assert.equal(matchesJobGroup(value, { operator: 'starts_with', query: '16900' }), true)
    assert.equal(matchesJobGroup(value, { operator: 'ends_with', query: '0858' }), true)
    assert.equal(matchesJobGroup(value, { operator: 'position_range', query: 'NPU01', positionStart: 12, positionEnd: 16 }), true)
    assert.equal(matchesJobGroup(value, { operator: 'segment_equals', query: 'NPU01', segmentIndex: 3, delimiter: '-' }), true)
  })
})

describe('Job Intelligence degraded identity reads', () => {
  it('isolates a temporarily unavailable identity field without discarding usable fields', async () => {
    const identityCapabilities = [...['job','order','recipe','customer','roll'].map((field) => ({ canonicalId: `production.${field}`, state: 'SUPPORTED' as const, deckNumbers: [], historyQueryable: true, evidenceKind: 'semantic_history' as const })), { canonicalId: 'production.material', state: 'UNSUPPORTED' as const, deckNumbers: [], historyQueryable: false, evidenceKind: null }]
    const capabilities = { pressKey: 'press14', sourceId: 14, sourceKey: 'press14', displayName: 'Press 14', metadataStatus: 'FRESH', capabilities: identityCapabilities } as PressEvidenceCapabilities
    const telemetry = {
      context: async () => { throw new Error('combined identity query unavailable') },
      semanticHistory: async (_pressKey: string, query: { signals: Array<{ canonicalId: string }> }) => {
        const canonicalId = query.signals[0]!.canonicalId
        if (canonicalId === 'production.order') throw new Error('field unavailable')
        return { pressKey: 'press14', sourceKey: 'press14', displayName: 'Press 14', fromUtc: start, toUtc: at(240), includeSeed: true, signals: [{ canonicalId, deckNumber: null, capabilityState: 'SUPPORTED', observationState: 'SUPPORTED_WITH_SEED_ONLY', mappingStatus: 'MAPPED', sourceUnit: 'text', canonicalUnitStatus: 'unverified', representation: 'changes', seed: { observedAtUtc: at(-1), receivedAtUtc: at(-1), sourceTimestampUtc: at(-1), qualityState: 'good', valueKind: 'string', value: canonicalId === 'production.recipe' ? 'R14' : 'usable' }, samples: [], changes: [] }] }
      },
    } as unknown as TelemetryFoundationService
    const result = await readJobProductionContext(telemetry, 'press14', start, at(240), capabilities)
    assert.equal(result.fields.order.capabilityState, 'TEMPORARILY_UNAVAILABLE')
    assert.equal(result.fields.material.capabilityState, 'UNSUPPORTED')
    assert.equal(result.fields.recipe.seed?.value, 'R14')
    assert.equal(result.fields.customer.seed?.value, 'usable')
  })
})

describe('Job Intelligence grouped acquisition reuse', () => {
  it('combines selected identity/deck history, overlaps fleet work, and skips unsupported target dimensions', async () => {
    const radiusPresses: string[] = []
    const contextPresses: string[] = []
    const semanticRequests: Array<{ pressKey: string; canonicalIds: string[] }> = []
    const identityFields = ['job', 'order', 'recipe', 'customer', 'material', 'roll'] as const
    const capabilityFor = (pressKey: string): PressEvidenceCapabilities => ({
      pressKey: pressKey as PressEvidenceCapabilities['pressKey'], sourceId: Number(pressKey.slice(5)), sourceKey: pressKey, displayName: pressKey.replace('press', 'Press '), metadataStatus: 'FRESH',
      capabilities: [...identityFields.map((name) => ({ canonicalId: `production.${name}`, state: name === 'material' && (pressKey === 'press14' || pressKey === 'press15') ? 'UNSUPPORTED' as const : 'SUPPORTED' as const, deckNumbers: [], historyQueryable: true, evidenceKind: 'semantic_history' as const })), { canonicalId: 'deck.active', state: pressKey === 'press5' ? 'SUPPORTED' as const : 'UNSUPPORTED' as const, deckNumbers: pressKey === 'press5' ? [1] : [], historyQueryable: pressKey === 'press5', evidenceKind: pressKey === 'press5' ? 'semantic_history' as const : null }],
    })
    const telemetry = {
      capabilities: { get: async (pressKey: string) => capabilityFor(pressKey) },
      context: async (pressKey: string) => { contextPresses.push(pressKey); return { ...context(), pressKey, sourceKey: pressKey, displayName: pressKey.replace('press', 'Press ') } },
      semanticHistory: async (pressKey: string, query: { signals: Array<{ canonicalId: string; deckNumber?: number }> }) => {
        semanticRequests.push({ pressKey, canonicalIds: query.signals.map((item) => `${item.canonicalId}:${item.deckNumber ?? ''}`) })
        const fixture = context()
        return {
          pressKey, sourceKey: pressKey, displayName: 'Press 5', fromUtc: start, toUtc: at(240), includeSeed: true,
          signals: [...Object.values(fixture.fields).map((item) => ({ canonicalId: item.canonicalId, deckNumber: null, capabilityState: item.capabilityState, observationState: item.observationState, mappingStatus: 'MAPPED', sourceUnit: null, canonicalUnitStatus: 'not_applicable', representation: 'changes', seed: item.seed, samples: [], changes: item.changes })), { canonicalId: 'deck.active', deckNumber: 1, capabilityState: 'SUPPORTED', observationState: 'SUPPORTED_WITH_SEED_ONLY', mappingStatus: 'MAPPED', sourceUnit: null, canonicalUnitStatus: 'not_applicable', representation: 'changes', seed: { observedAtUtc: at(-1), receivedAtUtc: at(-1), sourceTimestampUtc: at(-1), qualityState: 'good', valueKind: 'number', value: 1 }, samples: [], changes: [] }],
        }
      },
    } as unknown as TelemetryFoundationService
    const radius = {
      getRawTimeline: async (pressKey: string) => { radiusPresses.push(pressKey); return { pressKey, displayName: pressKey.replace('press', 'Press '), fromUtc: start, toUtc: at(240), segments: [segment(0, 240, 'G', 'Run Production', '10')] } },
    } as unknown as RadiusService

    const report = await new JobIntelligenceService(radius, telemetry).report({ pressKey: 'press5', fromUtc: start, toUtc: at(240), analyzeBy: 'material', group: { operator: 'exact', query: 'M1' } }, 'reuse-test')

    assert.equal(report.selectedGroup?.runCount, 1)
    assert.deepEqual([...radiusPresses].sort(), ['press10', 'press11', 'press12', 'press13', 'press3', 'press5', 'press6', 'press7', 'press8', 'press9'])
    assert.equal(contextPresses.length, 9)
    assert.equal(semanticRequests.length, 1)
    assert.equal(semanticRequests[0]!.pressKey, 'press5')
    assert.equal(semanticRequests[0]!.canonicalIds.includes('deck.active:1'), true)
    assert.equal(semanticRequests[0]!.canonicalIds.includes('production.material:'), true)
  })

  function fleetAcquisitionFixture() {
    let radiusAcquisitions = 0; let activeRadiusAcquisitions = 0; let peakRadiusAcquisitions = 0
    const limiter = new JobIntelligenceRadiusAcquisitionLimiter()
    const identityFields = ['job', 'order', 'recipe', 'customer', 'material', 'roll'] as const
    const telemetry = {
      capabilities: { get: async (pressKey: string) => ({
        pressKey, sourceId: Number(pressKey.slice(5)), sourceKey: pressKey, displayName: pressKey.replace('press', 'Press '), metadataStatus: 'FRESH',
        capabilities: [...identityFields.map((name) => ({ canonicalId: `production.${name}`, state: 'SUPPORTED', deckNumbers: [], historyQueryable: true, evidenceKind: 'semantic_history' })), { canonicalId: 'deck.active', state: 'UNSUPPORTED', deckNumbers: [], historyQueryable: false, evidenceKind: null }],
      }) },
      context: async (pressKey: string) => ({ ...context(), pressKey, sourceKey: pressKey, displayName: pressKey.replace('press', 'Press ') }),
    } as unknown as TelemetryFoundationService
    const radius = {
      getRawTimeline: async (pressKey: string) => {
        radiusAcquisitions += 1; activeRadiusAcquisitions += 1; peakRadiusAcquisitions = Math.max(peakRadiusAcquisitions, activeRadiusAcquisitions)
        await new Promise((resolve) => setTimeout(resolve, 5))
        activeRadiusAcquisitions -= 1
        return { pressKey, displayName: pressKey.replace('press', 'Press '), fromUtc: start, toUtc: at(240), segments: [] }
      },
    } as unknown as RadiusService
    return { service: new JobIntelligenceService(radius, telemetry, undefined, () => Date.parse(at(240)), limiter), acquisitions: () => radiusAcquisitions, peakAcquisitions: () => peakRadiusAcquisitions, limiter }
  }

  it('single-flights two simultaneous equivalent fleet requests into one Radius acquisition per press', async () => {
    const fixture = fleetAcquisitionFixture()
    await Promise.all([
      fixture.service.values({ fromUtc: start, toUtc: at(240), analyzeBy: 'recipe' }, 'equivalent-a'),
      fixture.service.values({ fromUtc: start, toUtc: at(240), analyzeBy: 'recipe' }, 'equivalent-b'),
    ])
    assert.equal(fixture.acquisitions(), 12)
    const diagnostics = fixture.service.radiusAcquisitionDiagnostics().lastFleet!
    assert.equal(diagnostics.concurrencyCap, 1); assert.equal(diagnostics.active, 0); assert.equal(diagnostics.queued, 0); assert.equal(diagnostics.peakQueued <= 1, true); assert.equal(diagnostics.peakActive, 1); assert.equal(diagnostics.totalAcquisitions, 12); assert.equal(diagnostics.completed, 12); assert.equal(diagnostics.failed, 0); assert.equal(diagnostics.cancelledWhileQueued, 0)
  })

  it('single-flights simultaneous values and report requests over the same fleet evidence window', async () => {
    const fixture = fleetAcquisitionFixture()
    await Promise.all([
      fixture.service.values({ fromUtc: start, toUtc: at(240), analyzeBy: 'recipe' }, 'values'),
      fixture.service.fleetReport({ fromUtc: start, toUtc: at(240), analyzeBy: 'recipe', group: { operator: 'exact', query: 'R1' } }, 'report'),
    ])
    assert.equal(fixture.acquisitions(), 12)
    assert.equal(fixture.service.radiusAcquisitionDiagnostics().lastFleet?.peakActive, 1)
    assert.equal(fixture.service.radiusAcquisitionDiagnostics().lastFleet?.totalAcquisitions, 12)
  })

  it('enforces the global cap across distinct fleet scans that cannot single-flight together', async () => {
    const fixture = fleetAcquisitionFixture()
    await Promise.all([
      fixture.service.values({ fromUtc: start, toUtc: at(240), analyzeBy: 'recipe' }, 'distinct-recipe'),
      fixture.service.values({ fromUtc: start, toUtc: at(240), analyzeBy: 'material' }, 'distinct-material'),
    ])
    assert.equal(fixture.acquisitions(), 24); assert.equal(fixture.peakAcquisitions(), 1)
    assert.equal(fixture.limiter.diagnostics().peakActive, 1); assert.equal(fixture.limiter.diagnostics().active, 0); assert.equal(fixture.limiter.diagnostics().queued, 0)
  })
})

describe('Job Intelligence HTTP validation', () => {
  const telemetryClient = {
    getHealth: async () => ({ service: 'TelemetryQueryApi', status: 'healthy' }),
    getDatabaseHealth: async () => ({ service: 'TelemetryQueryApi', database: 'telemetry', status: 'healthy' }),
    getSources: async () => [],
    getPhysicalState: async () => { throw new Error('not called') },
  } as TelemetryClient

  async function request(path: string) {
    const server = createApp({ telemetryClient, logger: false }).listen(0, '127.0.0.1')
    await new Promise<void>((resolve) => server.once('listening', resolve)); const address = server.address() as AddressInfo
    try { const response = await fetch(`http://127.0.0.1:${address.port}${path}`); return { status: response.status, body: await response.json() as { error?: string } } }
    finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) }
  }

  it('rejects invalid dimensions and ranges beyond the bounded materialized-history horizon before source access', async () => {
    const invalid = await request(`/api/job-intelligence/report?analyzeBy=job&operator=exact&query=R-100&fromUtc=${encodeURIComponent(start)}&toUtc=${encodeURIComponent(at(60))}`)
    assert.deepEqual(invalid, { status: 400, body: { error: 'invalid_job_analysis_dimension' } })
    const tooLargeEnd = new Date(Date.parse(start) + 11 * 366 * 24 * 60 * 60_000).toISOString()
    const tooLarge = await request(`/api/job-intelligence/report?analyzeBy=recipe&operator=exact&query=R-100&fromUtc=${encodeURIComponent(start)}&toUtc=${encodeURIComponent(tooLargeEnd)}`)
    assert.deepEqual(tooLarge, { status: 400, body: { error: 'job_intelligence_range_too_large' } })
  })
})
