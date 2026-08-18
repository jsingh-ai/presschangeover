import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { OperationalEpisode, RadiusStatusSegment } from '../src/radius/models.js'
import type { PressSemanticSignalWithIdentity } from '../src/telemetry/telemetry-foundation-service.js'
import type { CapabilityAssessment, TelemetrySample } from '../src/telemetry/telemetry-contracts.js'
import { assessContextualBaseline, buildProductionContextIdentity, contextualBaseline, resolveProductionContextCapabilities, segmentProductionContextEpisodes, usableProductionContextValue, type ProductionContextEpisode } from '../src/industrial-analytics/production-context.js'
import { selectBoundedEventTelemetry, speedRecoveryObservation } from '../src/industrial-analytics/event-telemetry.js'

const start = '2026-08-17T00:00:00.000Z'
const at = (hour: number, minute = 0) => new Date(Date.parse(start) + (hour * 60 + minute) * 60_000).toISOString()
function sample(value: string | number | boolean, observedAtUtc = start): TelemetrySample { return { observedAtUtc, receivedAtUtc: observedAtUtc, sourceTimestampUtc: observedAtUtc, qualityState: 'GOOD', valueKind: typeof value === 'number' ? 'numeric' : typeof value === 'boolean' ? 'boolean' : 'string', value } }
function signal(canonicalId: string, value: string, rawSignalId: string): PressSemanticSignalWithIdentity { return { canonicalId, deckNumber: null, capabilityState: 'SUPPORTED', observationState: 'SUPPORTED_WITH_SEED_ONLY', mappingStatus: 'MAPPED', sourceUnit: null, canonicalUnitStatus: null, representation: 'changes', seed: sample(value), samples: [], changes: [], valueKind: 'string', historianSignalId: 1, rawSignalId, sourceSelector: null, selectedVariant: 'primary' } }
function radius(startUtc: string, endUtc: string, eventType: string, statusDescription: string, isProduction: boolean): RadiusStatusSegment { return { kind: 'radius', machineId: 14, pressKey: 'press14', displayName: 'Press 14', startUtc, endUtc, durationSeconds: (Date.parse(endUtc) - Date.parse(startUtc)) / 1_000, isOpen: false, sourceGeneration: 'compact', eventType, statusCode: null, statusDescription, isProduction } }
const noOperationalEpisodes: OperationalEpisode[] = []

describe('production context capabilities and identity', () => {
  it('retains exact trusted identity, datatype, coverage, and only usable Press 14 dimensions', () => {
    const signals = [signal('production.recipe', 'R-14', 'trusted.recipe.14'), signal('production.customer', 'C-14', 'trusted.customer.14')]
    const capabilities = resolveProductionContextCapabilities({ range: { start, end: at(6) }, signals })
    assert.deepEqual(capabilities.filter(({ usable }) => usable).map(({ field }) => field), ['recipe', 'customer'])
    assert.deepEqual(capabilities.find(({ field }) => field === 'recipe'), { field: 'recipe', canonicalId: 'production.recipe', rawIdentity: 'trusted.recipe.14', dataType: 'string', capabilityState: 'SUPPORTED', availability: 'available', capabilityAvailability: 'CAPABILITY_AVAILABLE', valueAvailability: 'VALUE_USABLE', recentCoveragePercent: 100, usable: true, sentinelBehavior: null })
    const identity = buildProductionContextIdentity('press14', { job: null, recipe: 'R-14', customer: 'C-14', material: 'Unavailable' })!
    assert.deepEqual(identity.dimensionNames, ['recipe', 'customer'])
    assert.equal(identity.summary, 'Recipe R-14 · Customer C-14')
    assert.equal(buildProductionContextIdentity('press10', { order: 'O-10', recipe: 'R-10' })!.summary, 'Order O-10 · Recipe R-10')
    assert.notEqual(identity.contextKey, buildProductionContextIdentity('press14', { customer: 'C-14' })!.contextKey)
  })

  it('treats sentinels and missing values as absent rather than unchanged', () => {
    for (const value of [null, undefined, '', '   ', 'Unavailable', 'unknown', '0000', 0, [0, 0, 0], '[0, 0, 0, 0, 0, 0]', [null, '', '0'], '[null, "", 0]']) assert.equal(usableProductionContextValue(value), null)
    assert.equal(usableProductionContextValue(false), false)
  })

  it('separates capability availability from recent value usability', () => {
    const unusable = signal('production.job', '[0, 0, 0]', 'trusted.job.14'); const unsupported = { ...signal('production.material', 'M-1', 'trusted.material.14'), capabilityState: 'UNSUPPORTED' as const }
    const capabilities = resolveProductionContextCapabilities({ range: { start, end: at(6) }, signals: [unusable, unsupported] })
    assert.deepEqual(capabilities.find(({ field }) => field === 'job') && { capability: capabilities.find(({ field }) => field === 'job')!.capabilityAvailability, value: capabilities.find(({ field }) => field === 'job')!.valueAvailability }, { capability: 'CAPABILITY_AVAILABLE', value: 'VALUE_UNAVAILABLE' })
    assert.deepEqual(capabilities.find(({ field }) => field === 'material') && { capability: capabilities.find(({ field }) => field === 'material')!.capabilityAvailability, value: capabilities.find(({ field }) => field === 'material')!.valueAvailability }, { capability: 'CAPABILITY_UNAVAILABLE', value: 'VALUE_UNAVAILABLE' })
  })
})

describe('production context episode segmentation and behavior', () => {
  it('does not split repeated values, splits context changes, and never bridges a data gap', () => {
    const episodes = segmentProductionContextEpisodes({ pressKey: 'press14', range: { start, end: at(6) }, initialValues: { recipe: 'A', customer: 'C' }, observations: [{ atUtc: at(1), field: 'recipe', value: 'A' }, { atUtc: at(2), field: 'recipe', value: 'B' }], gaps: [{ start: at(3), end: at(4) }] })
    assert.deepEqual(episodes.map(({ startUtc, endUtc, identity, startedAfterDataGap }) => ({ startUtc, endUtc, recipe: identity.dimensions.recipe, startedAfterDataGap })), [
      { startUtc: start, endUtc: at(2), recipe: 'A', startedAfterDataGap: false },
      { startUtc: at(2), endUtc: at(3), recipe: 'B', startedAfterDataGap: false },
      { startUtc: at(4), endUtc: at(6), recipe: 'B', startedAfterDataGap: true },
    ])
  })

  it('attaches Radius duration, interruption, return, repeated-state, and loop evidence', () => {
    const segments = [radius(at(0), at(1), 'G', 'Production', true), radius(at(1), at(1, 20), 'M', 'Make Ready', false), radius(at(1, 20), at(1, 30), 'B', 'Sleeves', false), radius(at(1, 30), at(1, 40), 'M', 'Make Ready', false), radius(at(1, 40), at(2), 'G', 'Production', true)]
    const episode = segmentProductionContextEpisodes({ pressKey: 'press14', range: { start, end: at(2) }, initialValues: { recipe: 'A', customer: 'C' }, observations: [], radiusSegments: segments, operationalEpisodes: noOperationalEpisodes })[0]!
    assert.equal(episode.metrics.productionSeconds, 4_800)
    assert.equal(episode.metrics.makeReadySeconds, 1_800)
    assert.equal(episode.metrics.productionInterruptions, 1)
    assert.equal(episode.metrics.returnsToProduction, 1)
    assert.equal(episode.metrics.longestInterruptionSeconds, 2_400)
    assert.deepEqual(episode.metrics.repeatedRadiusStates, ['Production', 'Make Ready'])
    assert.ok(episode.metrics.loopCount >= 1)
  })
})

function contextEpisode(index: number, dimensions: Record<string, string>, interruptions = 1): ProductionContextEpisode {
  const identity = buildProductionContextIdentity('press14', dimensions)!
  return { episodeId: `episode-${index}`, pressKey: 'press14', identity, startUtc: at(index), endUtc: at(index + 1), durationSeconds: 3_600, coveragePercent: 100, startedBy: null, endedBy: null, startedAfterDataGap: false, contextChangeCount: 0, metrics: { productionSeconds: 2_000, makeReadySeconds: 1_000, badSeconds: 0, safetySeconds: 0, otherRadiusSeconds: 0, unavailableSeconds: 0, productionInterruptions: interruptions, returnsToProduction: 1, longestInterruptionSeconds: 600, totalInterruptionSeconds: 900, returnAttempts: 1, failedReturnAttempts: 0, radiusDrivers: [{ eventType: 'M', statusCode: '10', statusDescription: 'Make Ready', durationSeconds: 900, occurrences: 1 }], repeatedRadiusStates: [], loopCount: 0 } }
}

describe('contextual baselines', () => {
  it('requires three prior episodes and exposes exact-context provenance', () => {
    const current = contextEpisode(8, { recipe: 'A', customer: 'C' }, 6)
    assert.equal(contextualBaseline(current, [contextEpisode(1, { recipe: 'A', customer: 'C' })]), null)
    const baseline = contextualBaseline(current, [1, 2, 3].map((index) => contextEpisode(index, { recipe: 'A', customer: 'C' }, index)))!
    assert.equal(baseline.fallbackLevel, 1)
    assert.deepEqual(baseline.matchingDimensions, ['recipe', 'customer'])
    assert.equal(baseline.sampleCount, 3)
    assert.match(baseline.label, /same Recipe \+ Customer/)
  })

  it('falls back transparently to the strongest supported subset', () => {
    const current = contextEpisode(8, { recipe: 'A', customer: 'C' })
    const prior = [1, 2, 3].map((index) => contextEpisode(index, { recipe: 'A', customer: `other-${index}` }))
    const baseline = contextualBaseline(current, prior)!
    assert.equal(baseline.fallbackLevel, 2)
    assert.deepEqual(baseline.matchingDimensions, ['recipe'])
  })

  it('reports actual N when bounded history cannot meet N>=3', () => {
    const assessment = assessContextualBaseline(contextEpisode(8, { recipe: 'A' }), [contextEpisode(1, { recipe: 'A' }), contextEpisode(2, { recipe: 'B' })])
    assert.equal(assessment.status, 'INSUFFICIENT_CONTEXTUAL_HISTORY'); assert.equal(assessment.actualSupport, 2); assert.equal(assessment.baseline, null); assert.equal(assessment.minimumRequired, 3)
  })
})

describe('bounded event telemetry and speed recovery', () => {
  it('selects only trusted supported canonical series and obeys the hard maximum', () => {
    const capabilities: CapabilityAssessment[] = ['ink.temperature.actual', 'anilox.drive.torque.actual', 'doctor_blade.pressure', 'ink.washup.state', 'ink.pump.status', 'unwind.tension.actual'].map((canonicalId) => ({ canonicalId, state: 'SUPPORTED', deckNumbers: canonicalId.includes('ink.') || canonicalId.includes('anilox.') || canonicalId.includes('doctor_') ? [1, 2, 3] : [], historyQueryable: true, evidenceKind: 'semantic_history' }))
    capabilities.push({ canonicalId: 'register.long.actual_or_correction', state: 'UNSUPPORTED', deckNumbers: [1], historyQueryable: true, evidenceKind: 'semantic_history' })
    const selected = selectBoundedEventTelemetry(capabilities, 5)
    assert.equal(selected.length, 5)
    assert.ok(selected.every((item) => item.canonicalId !== 'register.long.actual_or_correction'))
    assert.ok(selected.every((item) => capabilities.some((capability) => capability.canonicalId === item.canonicalId && capability.state === 'SUPPORTED')))
  })

  it('summarizes multiple acceleration attempts without exposing raw samples', () => {
    const values = [200, 195, 100, 0, 10, 60, 30, 80, 50, 170, 180, 185]
    const samples = values.map((value, index) => sample(value, at(0, index * 2)))
    const observation = speedRecoveryObservation({ pressKey: 'press14', event: { id: 'event-1', start: at(0, 4), end: at(0, 8) }, range: { start, end: at(0, 24) }, samples, unit: 'fpm' })!
    assert.equal(observation.family, 'speed_recovery')
    assert.ok(Number(observation.metrics.accelerationAttempts) >= 2)
    assert.ok(Number(observation.metrics.failedAccelerations) >= 1)
    assert.equal('samples' in observation.metrics, false)
  })
})
