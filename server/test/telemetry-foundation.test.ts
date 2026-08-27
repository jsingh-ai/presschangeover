import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import type { TelemetryClient } from '../src/telemetry/telemetry-api-client.js'
import { sourceWideEvidenceGaps, TelemetryFoundationService } from '../src/telemetry/telemetry-foundation-service.js'
import type { TelemetrySemanticHistoryResponse } from '../src/telemetry/telemetry-contracts.js'
import { TelemetryApiError } from '../src/telemetry/telemetry-error.js'
import { parseSemanticHistoryResponse } from '../src/telemetry/telemetry-response-parsers.js'
import { TelemetrySourceRegistry } from '../src/telemetry/telemetry-source-registry.js'
import { mixedHistoryFixture, motionFixture, press12CapabilitiesFixture, press12EvidenceFixture, press14CapabilitiesFixture, press14ContextFixture, press14SpeedFixture, press5CapabilitiesFixture, press5SpeedFixture, sourcesFixture } from './fixtures/telemetry-fixtures.js'

function baseClient(overrides: Partial<TelemetryClient> = {}): TelemetryClient {
  return {
    getHealth: async () => ({ service: 'TelemetryQueryApi', status: 'healthy' }),
    getDatabaseHealth: async () => ({ service: 'TelemetryQueryApi', database: 'historian', status: 'healthy' }),
    getSources: async () => sourcesFixture,
    getCapabilities: async (sourceId) => sourceId === 41 ? press5CapabilitiesFixture : sourceId === 42 ? press12CapabilitiesFixture : press14CapabilitiesFixture,
    getMachineSpeedHistory: async () => press14SpeedFixture,
    querySemanticHistory: async () => mixedHistoryFixture,
    getPhysicalState: async () => motionFixture,
    ...overrides,
  }
}

test('source registry resolves press keys from source metadata without encoded IDs and caches metadata', async () => {
  let calls = 0
  const registry = new TelemetrySourceRegistry(baseClient({ getSources: async () => { calls += 1; return [{ id: 9876, sourceKey: 'press5', displayName: 'Press 5', enabled: true }] } }), 300_000)
  assert.equal((await registry.resolve('press5')).source.id, 9876)
  assert.equal((await registry.resolve('press5')).source.id, 9876)
  assert.equal(calls, 1)
  await assert.rejects(registry.resolve('press3'), (error: unknown) => error instanceof TelemetryApiError && error.kind === 'unsupported_source')
})

test('source registry distinguishes missing, disabled, and temporarily unavailable sources', async () => {
  const statuses = await new TelemetrySourceRegistry(baseClient()).presses()
  assert.equal(statuses.find(({ pressKey }) => pressKey === 'press3')?.availability, 'NO_SOURCE')
  assert.equal(statuses.find(({ pressKey }) => pressKey === 'press15')?.availability, 'DISABLED')
  const unavailable = await new TelemetrySourceRegistry(baseClient({ getSources: async () => { throw new TelemetryApiError('unavailable') } })).presses()
  assert.ok(unavailable.every(({ availability }) => availability === 'TEMPORARILY_UNAVAILABLE'))
})

test('capability registry preserves supported and unsupported evidence and uses marked last-good metadata', async () => {
  let now = 0
  let fail = false
  const service = new TelemetryFoundationService(baseClient({ getCapabilities: async () => { if (fail) throw new TelemetryApiError('unavailable'); return press5CapabilitiesFixture } }), { metadataTtlMs: 10, now: () => now })
  const fresh = await service.capabilities.get('press5')
  assert.equal(fresh.capabilities.find(({ canonicalId }) => canonicalId === 'deck.active')?.state, 'SUPPORTED')
  fail = true; now = 20
  const stale = await service.capabilities.get('press5')
  assert.equal(stale.metadataStatus, 'STALE')
  assert.equal(stale.capabilities[0]?.state, 'TEMPORARILY_UNAVAILABLE')
  assert.equal(stale.capabilities[0]?.lastKnownState, 'SUPPORTED')
})

test('production capability fixtures preserve P5 deck, P12 unsupported deck, and P14 Job/Material limitations', async () => {
  const service = new TelemetryFoundationService(baseClient())
  assert.equal((await service.capabilities.get('press5')).capabilities.find(({ canonicalId }) => canonicalId === 'deck.print_on')?.state, 'SUPPORTED')
  assert.equal((await service.capabilities.get('press12')).capabilities.find(({ canonicalId }) => canonicalId === 'deck.active')?.state, 'UNSUPPORTED')
  const p14 = await service.capabilities.get('press14')
  assert.equal(p14.capabilities.find(({ canonicalId }) => canonicalId === 'production.job')?.state, 'UNSUPPORTED')
  assert.equal(p14.capabilities.find(({ canonicalId }) => canonicalId === 'production.material')?.state, 'UNSUPPORTED')
})

test('capability registry emits UNKNOWN for absent core metadata and TEMPORARILY_UNAVAILABLE on a cold capability outage', async () => {
  const sparse = { ...press5CapabilitiesFixture, capabilities: press5CapabilitiesFixture.capabilities.filter(({ canonicalId }) => canonicalId !== 'machine.speed.actual') }
  const unknown = await new TelemetryFoundationService(baseClient({ getCapabilities: async () => sparse })).capabilities.get('press5')
  assert.equal(unknown.capabilities.find(({ canonicalId }) => canonicalId === 'machine.speed.actual')?.state, 'UNKNOWN')
  const unavailable = await new TelemetryFoundationService(baseClient({ getCapabilities: async () => { throw new TelemetryApiError('unavailable') } })).capabilities.get('press5')
  assert.equal(unavailable.metadataStatus, 'STALE')
  assert.ok(unavailable.capabilities.every(({ state }) => state === 'TEMPORARILY_UNAVAILABLE'))
})

test('semantic history preserves samples, changes, mixed modes, deck identity, seed timestamp, typed zero and false', async () => {
  const service = new TelemetryFoundationService(baseClient())
  const evidence = await service.semanticHistory('press5', { fromUtc: mixedHistoryFixture.fromUtc, toUtc: mixedHistoryFixture.toUtc, includeSeed: true, signals: mixedHistoryFixture.signals.map(({ canonicalId, deckNumber, representation }) => ({ canonicalId, ...(deckNumber === null ? {} : { deckNumber }), representation })) })
  const order = evidence.signals.find(({ canonicalId }) => canonicalId === 'production.order')!
  const deck = evidence.signals.find(({ canonicalId }) => canonicalId === 'deck.active')!
  const temperature = evidence.signals.find(({ canonicalId }) => canonicalId === 'ink.temperature.actual')!
  const boolean = evidence.signals.find(({ canonicalId }) => canonicalId === 'test.boolean')!
  assert.equal(order.representation, 'changes')
  assert.equal(order.changes[0]?.previousValue, 'ORDER-REDACTED')
  assert.equal(order.changes[0]?.previousSourceTimestampUtc, '2026-08-12T03:29:20.000Z')
  assert.equal(order.changes[0]?.qualityState, 'true')
  assert.equal(deck.deckNumber, 2)
  assert.equal(deck.seed?.value, 0)
  assert.equal(deck.observationState, 'SUPPORTED_WITH_SEED_ONLY')
  assert.equal(temperature.representation, 'samples')
  assert.equal(temperature.samples[0]?.value, 22.25)
  assert.equal(temperature.seed?.observedAtUtc, '2026-08-12T03:29:25.000Z')
  assert.notEqual(temperature.seed?.observedAtUtc, evidence.fromUtc)
  assert.equal(boolean.seed?.value, false)
})

test('semantic history distinguishes unsupported and supported-with-no-observations', async () => {
  const fixture = structuredClone(mixedHistoryFixture)
  fixture.signals.push({ ...fixture.signals[1]!, canonicalId: 'supported.empty', deckNumber: null, seedSample: null, changes: [] })
  const service = new TelemetryFoundationService(baseClient({ querySemanticHistory: async () => fixture }))
  const evidence = await service.semanticHistory('press5', { fromUtc: fixture.fromUtc, toUtc: fixture.toUtc, includeSeed: true, signals: fixture.signals.map(({ canonicalId, representation }) => ({ canonicalId, representation })) })
  assert.equal(evidence.signals.find(({ canonicalId }) => canonicalId === 'production.job')?.observationState, 'UNSUPPORTED')
  assert.equal(evidence.signals.find(({ canonicalId }) => canonicalId === 'supported.empty')?.observationState, 'SUPPORTED_WITH_NO_SAMPLES_IN_RANGE')
})

test('bounded semantic history chunks ranges at two hours, merges exact bounds, and deduplicates boundaries', async () => {
  const began = Date.parse('2026-08-17T00:00:00.000Z'); const calls: Array<{ fromUtc: string; toUtc: string }> = []
  const sample = (observedAtUtc: string, value: number) => ({ observedAtUtc, receivedAtUtc: observedAtUtc, sourceTimestampUtc: observedAtUtc, qualityState: 'GOOD', valueKind: 'numeric' as const, value })
  const service = new TelemetryFoundationService(baseClient({ querySemanticHistory: async (_sourceId, query) => {
    calls.push({ fromUtc: query.fromUtc, toUtc: query.toUtc }); const template = mixedHistoryFixture.signals.find(({ canonicalId }) => canonicalId === 'ink.temperature.actual')!
    return { ...mixedHistoryFixture, fromUtc: query.fromUtc, toUtc: query.toUtc, signals: [{ ...template, canonicalId: query.signals[0]!.canonicalId, deckNumber: null, samples: [sample(query.fromUtc, Date.parse(query.fromUtc)), sample(query.toUtc, Date.parse(query.toUtc))], changes: [] }] }
  } }))
  const result = await service.semanticHistory('press5', { fromUtc: new Date(began).toISOString(), toUtc: new Date(began + 5 * 60 * 60_000).toISOString(), includeSeed: false, signals: [{ canonicalId: 'ink.temperature.actual', representation: 'samples' }] }, 'bounded-test')
  assert.equal(calls.length, 3); assert.ok(calls.every((call) => Date.parse(call.toUtc) - Date.parse(call.fromUtc) <= 2 * 60 * 60_000))
  assert.equal(result.fromUtc, new Date(began).toISOString()); assert.equal(result.toUtc, new Date(began + 5 * 60 * 60_000).toISOString())
  assert.equal(result.signals[0]!.samples.length, 4); assert.equal(result.readDiagnostics?.boundaryDuplicatesRemoved, 2)
})

test('bounded semantic history preserves detected gaps and reuses identical reads within one analysis', async () => {
  let calls = 0; const start = '2026-08-17T00:00:00.000Z'; const end = '2026-08-17T01:00:00.000Z'
  const at = (minute: number) => new Date(Date.parse(start) + minute * 60_000).toISOString()
  const sample = (minute: number) => ({ observedAtUtc: at(minute), receivedAtUtc: at(minute), sourceTimestampUtc: at(minute), qualityState: 'GOOD', valueKind: 'numeric' as const, value: minute })
  const template = mixedHistoryFixture.signals.find(({ canonicalId }) => canonicalId === 'ink.temperature.actual')!
  const service = new TelemetryFoundationService(baseClient({ querySemanticHistory: async (_sourceId, query) => { calls += 1; return { ...mixedHistoryFixture, fromUtc: query.fromUtc, toUtc: query.toUtc, signals: [{ ...template, canonicalId: 'ink.temperature.actual', deckNumber: null, samples: [0, 1, 2, 30, 31].map(sample), changes: [] }] } } }))
  const query = { fromUtc: start, toUtc: end, includeSeed: false, signals: [{ canonicalId: 'ink.temperature.actual', representation: 'samples' as const }] }
  const first = await service.semanticHistory('press5', query, 'same-analysis'); const second = await service.semanticHistory('press5', query, 'same-analysis')
  assert.equal(calls, 1); assert.equal(first.readDiagnostics?.gaps.length, 1); assert.equal(first.readDiagnostics?.gaps[0]?.startUtc, at(2)); assert.equal(first.readDiagnostics?.gaps[0]?.endUtc, at(30)); assert.equal(second.readDiagnostics?.cacheHits, 1)
})

test('source-wide availability preserves quiet transition-first telemetry with heartbeat witnesses', () => {
  const start = '2026-08-17T00:00:00.000Z'; const atMinute = (minute: number) => new Date(Date.parse(start) + minute * 60_000).toISOString()
  const points = (minutes: number[]) => minutes.map((minute) => ({ observedAtUtc: atMinute(minute), receivedAtUtc: atMinute(minute), sourceTimestampUtc: atMinute(minute), qualityState: 'GOOD', valueKind: 'numeric' as const, value: 0 }))
  const signal = (canonicalId: string, minutes: number[]) => ({ canonicalId, deckNumber: null, samples: points(minutes), changes: [] })
  const range = { start, end: atMinute(45) }
  assert.deepEqual(sourceWideEvidenceGaps([signal('machine.speed.actual', [0, 5, 10, 15, 20, 25, 30, 35, 40]), signal('physical.motion_state', [0, 5, 10, 15, 20, 25, 30, 35, 40])] as never, range), [])
  assert.deepEqual(sourceWideEvidenceGaps([signal('production.recipe', [0, 30]), signal('physical.motion_state', [0, 5, 10, 15, 20, 25, 30, 35, 40])] as never, range), [])
  assert.deepEqual(sourceWideEvidenceGaps([signal('machine.speed.actual', [0, 5, 10, 35, 40]), signal('physical.motion_state', [0, 5, 10, 15, 20, 25, 30, 35, 40])] as never, range), [])
})

test('source-wide availability marks a corroborated multi-signal heartbeat outage', () => {
  const start = '2026-08-17T00:00:00.000Z'; const atMinute = (minute: number) => new Date(Date.parse(start) + minute * 60_000).toISOString()
  const signal = (canonicalId: string, minutes: number[]) => ({ canonicalId, deckNumber: null, samples: minutes.map((minute) => ({ observedAtUtc: atMinute(minute), receivedAtUtc: atMinute(minute), sourceTimestampUtc: atMinute(minute), qualityState: 'GOOD', valueKind: 'numeric' as const, value: minute })), changes: [] })
  const gaps = sourceWideEvidenceGaps([signal('machine.speed.actual', [0, 5, 10, 35, 40, 45]), signal('physical.motion_state', [0, 5, 10, 35, 40, 45])] as never, { start, end: atMinute(45) })
  assert.deepEqual(gaps, [{ startUtc: atMinute(10), endUtc: atMinute(35), durationMs: 25 * 60_000, witnessCount: 2 }])
})

test('analysis cache reuses exact, selector-subset, contained-range, and combined reads with exact clipping', async () => {
  let calls = 0; const start = '2026-08-17T00:00:00.000Z'; const end = '2026-08-17T01:00:00.000Z'
  const at = (minute: number) => new Date(Date.parse(start) + minute * 60_000).toISOString()
  const sample = (minute: number, qualityState = 'GOOD') => ({ observedAtUtc: at(minute), receivedAtUtc: at(minute), sourceTimestampUtc: at(minute), qualityState, valueKind: 'numeric' as const, value: minute })
  const template = mixedHistoryFixture.signals.find(({ canonicalId }) => canonicalId === 'ink.temperature.actual')!
  const selectors = [{ canonicalId: 'ink.temperature.actual', representation: 'samples' as const }, { canonicalId: 'dryer.tunnel.temperature.actual', representation: 'samples' as const }]
  const service = new TelemetryFoundationService(baseClient({ querySemanticHistory: async (_sourceId, query) => {
    calls += 1
    return { ...mixedHistoryFixture, fromUtc: query.fromUtc, toUtc: query.toUtc, includeSeed: query.includeSeed, signals: query.signals.map((selector) => ({ ...template, canonicalId: selector.canonicalId, deckNumber: null, representation: selector.representation, seedSample: sample(-1), samples: [sample(0), sample(1), sample(2), sample(10), sample(11), sample(12, 'BAD'), sample(30), sample(31), sample(50)], changes: [] })) }
  } }))
  const broad = { fromUtc: start, toUtc: end, includeSeed: true, signals: selectors }
  await service.semanticHistory('press5', broad, 'range-cache')
  const exact = await service.semanticHistory('press5', broad, 'range-cache')
  const subset = await service.semanticHistory('press5', { ...broad, signals: selectors.slice(0, 1) }, 'range-cache')
  const contained = await service.semanticHistory('press5', { ...broad, fromUtc: at(10), toUtc: at(40) }, 'range-cache')
  const combined = await service.semanticHistory('press5', { ...broad, fromUtc: at(10), toUtc: at(40), signals: selectors.slice(0, 1) }, 'range-cache')
  assert.equal(calls, 1)
  assert.equal(exact.readDiagnostics?.cacheHitType, 'EXACT'); assert.equal(exact.readDiagnostics?.exactCacheHits, 1)
  assert.equal(subset.readDiagnostics?.cacheHitType, 'SELECTOR_SUBSET'); assert.equal(subset.readDiagnostics?.selectorSubsetCacheHits, 1); assert.equal(subset.signals.length, 1)
  assert.equal(contained.readDiagnostics?.cacheHitType, 'CONTAINED_RANGE'); assert.equal(contained.readDiagnostics?.containedRangeCacheHits, 1)
  assert.equal(combined.readDiagnostics?.cacheHitType, 'CONTAINED_RANGE_SELECTOR_SUBSET'); assert.equal(combined.readDiagnostics?.containedRangeSelectorSubsetCacheHits, 1)
  assert.deepEqual(combined.signals[0]?.samples.map(({ observedAtUtc }) => observedAtUtc), [at(10), at(11), at(12), at(30), at(31)])
  assert.equal(combined.signals[0]?.seed?.value, 2)
  assert.equal(combined.signals[0]?.samples.find(({ observedAtUtc }) => observedAtUtc === at(12))?.qualityState, 'BAD')
  assert.equal(combined.readDiagnostics?.gaps.length, 1); assert.deepEqual(combined.readDiagnostics?.gaps[0], { canonicalId: 'ink.temperature.actual', deckNumber: null, startUtc: at(12), endUtc: at(30), durationMs: 18 * 60_000 })
  assert.equal(combined.readDiagnostics?.telemetryRequests, 0); assert.equal(combined.readDiagnostics?.chunkCount, 0); assert.equal(combined.readDiagnostics?.pointsReturned, 0)
})

function contextFixture(): TelemetrySemanticHistoryResponse {
  const supported = (canonicalId: string, value: string) => ({ ...mixedHistoryFixture.signals[0]!, canonicalId, seedSample: { ...mixedHistoryFixture.signals[0]!.seedSample!, value }, changes: canonicalId === 'production.roll' ? mixedHistoryFixture.signals[0]!.changes : [] })
  return { ...mixedHistoryFixture, signals: [supported('production.job', 'JOB-REDACTED'), supported('production.order', 'ORDER-REDACTED'), supported('production.recipe', 'RECIPE-REDACTED'), supported('production.customer', 'CUSTOMER-REDACTED'), supported('production.material', 'MATERIAL-REDACTED'), supported('production.roll', 'ROLL-REDACTED')] }
}

test('context keeps Job, Order, Recipe, Customer, Material, and Roll independent and emits neutral changes', async () => {
  let requestRepresentations: string[] = []
  const service = new TelemetryFoundationService(baseClient({ querySemanticHistory: async (_sourceId, query) => { requestRepresentations = query.signals.map(({ representation }) => representation); return contextFixture() } }))
  const context = await service.context('press5', mixedHistoryFixture.fromUtc, mixedHistoryFixture.toUtc)
  assert.deepEqual(Object.keys(context.fields), ['job', 'order', 'recipe', 'customer', 'material', 'roll'])
  assert.notEqual(context.fields.job.canonicalId, context.fields.order.canonicalId)
  assert.ok(requestRepresentations.every((item) => item === 'changes'))
  assert.equal(context.changes[0]?.field, 'roll')
  assert.equal('jobStarted' in context.changes[0]!, false)
})

test('context preserves P14 unsupported Job and Material', async () => {
  const fixture = contextFixture()
  fixture.sourceId = 43; fixture.sourceKey = 'press14'; fixture.displayName = 'Press 14'
  for (const canonicalId of ['production.job', 'production.material']) {
    const index = fixture.signals.findIndex((item) => item.canonicalId === canonicalId)
    fixture.signals[index] = { canonicalId, deckNumber: null, supported: false, mappingStatus: 'UNAVAILABLE', historianSignalId: null, rawSignalId: null, sourceUnit: null, canonicalUnitStatus: null, valueKind: null, sourceSelector: null, selectedVariant: null, representation: 'changes', seedSample: null, samples: [], changes: [] }
  }
  const service = new TelemetryFoundationService(baseClient({ querySemanticHistory: async () => fixture }))
  const context = await service.context('press14', fixture.fromUtc, fixture.toUtc)
  assert.equal(context.fields.job.observationState, 'UNSUPPORTED')
  assert.equal(context.fields.material.observationState, 'UNSUPPORTED')
  assert.equal(context.fields.order.observationState, 'SUPPORTED_WITH_SEED_ONLY')
})

test('speed preserves actual/setpoint samples, blank or ft/min units, and unverified status without conversion', async () => {
  const service = new TelemetryFoundationService(baseClient())
  const result = await service.speed('press14', press14SpeedFixture.fromUtc, press14SpeedFixture.toUtc)
  assert.deepEqual(result.actual.samples.map(({ value }) => value), [0, 25.5])
  assert.equal(result.setpoint?.samples[0]?.value, 100)
  assert.equal(result.actual.sourceUnit, 'ft/min')
  assert.equal(result.actual.canonicalUnitStatus, 'unverified')
  const blank = structuredClone(press14SpeedFixture); blank.sourceId = 41; blank.sourceKey = 'press5'; blank.displayName = 'Press 5'; blank.actual.sourceUnit = null; blank.setpoint!.sourceUnit = null
  const p5 = await new TelemetryFoundationService(baseClient({ getMachineSpeedHistory: async () => blank })).speed('press5', blank.fromUtc, blank.toUtc)
  assert.equal(p5.actual.sourceUnit, null)
})

test('motion preserves RUNNING, STOPPED, TRANSITION, UNKNOWN and never calls it production', async () => {
  const result = await new TelemetryFoundationService(baseClient()).motion('press5', motionFixture.fromUtc, motionFixture.toUtc)
  assert.deepEqual(result.segments.map(({ state }) => state), ['RUNNING', 'STOPPED', 'TRANSITION', 'UNKNOWN'])
  assert.equal(result.segments[0]?.actualSpeedAtStart, 30)
  assert.doesNotMatch(JSON.stringify(result), /production state/i)
})

test('curated deck/process evidence requests raw canonical signals and derives no deck counts or fault labels', async () => {
  let selectors: Array<{ canonicalId: string; deckNumber?: number }> = []
  const service = new TelemetryFoundationService(baseClient({ querySemanticHistory: async (_sourceId, query) => { selectors = query.signals; return { ...mixedHistoryFixture, signals: mixedHistoryFixture.signals.filter(({ canonicalId }) => query.signals.some((item) => item.canonicalId === canonicalId)) } } }))
  const result = await service.evidence('press5', { fromUtc: mixedHistoryFixture.fromUtc, toUtc: mixedHistoryFixture.toUtc, includeSeed: true, categories: ['deck_states', 'ink_temperature'], deckNumbers: [2, 3], representation: 'changes' })
  assert.ok(selectors.some(({ canonicalId, deckNumber }) => canonicalId === 'deck.print_on' && deckNumber === 2))
  assert.ok(selectors.some(({ canonicalId, deckNumber }) => canonicalId === 'deck.print_off' && deckNumber === 3))
  assert.equal('activeDeckCount' in result, false)
  assert.doesNotMatch(JSON.stringify(result), /began printing|problem|failed/i)
})

test('curated evidence batches large supported selector sets at the frozen upstream limit', async () => {
  const deckNumbers = Array.from({ length: 10 }, (_, index) => index + 1)
  const capabilityTemplate = press5CapabilitiesFixture.capabilities.find(({ canonicalId }) => canonicalId === 'deck.active')!
  const capabilities = {
    ...press5CapabilitiesFixture,
    capabilities: [
      ...press5CapabilitiesFixture.capabilities.filter(({ canonicalId }) => !canonicalId.startsWith('deck.')),
      ...['deck.active', 'deck.print_on', 'deck.print_off', 'register.long.actual_or_correction', 'register.side.actual_or_correction', 'impression.anilox.drive_side', 'ink.washup.state', 'ink.pump.status'].map((canonicalId) => ({ ...capabilityTemplate, canonicalId, deckNumbers })),
    ],
  }
  const batchSizes: number[] = []
  const template = mixedHistoryFixture.signals.find(({ canonicalId }) => canonicalId === 'deck.active')!
  const service = new TelemetryFoundationService(baseClient({
    getCapabilities: async () => capabilities,
    querySemanticHistory: async (_sourceId, query) => {
      batchSizes.push(query.signals.length)
      return { ...mixedHistoryFixture, signals: query.signals.map(({ canonicalId, deckNumber = null, representation }) => ({ ...template, canonicalId, deckNumber, representation })) }
    },
  }))
  const result = await service.evidence('press5', { fromUtc: mixedHistoryFixture.fromUtc, toUtc: mixedHistoryFixture.toUtc, includeSeed: true, categories: ['deck_states', 'register', 'impression', 'wash', 'pump'], representation: 'changes' })
  assert.ok(batchSizes.length > 1)
  assert.ok(batchSizes.every((size) => size <= 50))
  assert.equal(result.signals.length, batchSizes.reduce((sum, size) => sum + size, 0))
  assert.ok(result.signals.length > 50)
})

test('telemetry cancellation and outage remain typed and independent', async () => {
  const controller = new AbortController(); controller.abort()
  await assert.rejects(new TelemetryFoundationService(baseClient()).sources.resolve('press5', undefined, controller.signal), (error: unknown) => error instanceof TelemetryApiError && error.kind === 'cancelled')
  const down = new TelemetryFoundationService(baseClient({ getSources: async () => { throw new TelemetryApiError('unavailable') } }))
  await assert.rejects(down.speed('press5', press14SpeedFixture.fromUtc, press14SpeedFixture.toUtc), (error: unknown) => error instanceof TelemetryApiError && error.kind === 'unavailable')
})

test('semantic history preserves a missing source timestamp without rejecting valid historian time', () => {
  const signal = mixedHistoryFixture.signals[0]!
  const seedSample = { ...(signal.seedSample ?? signal.samples[0]!), sourceTimestampUtc: null }
  const parsed = parseSemanticHistoryResponse({ ...mixedHistoryFixture, signals: [{ ...signal, seedSample, samples: [], changes: [] }] })
  assert.equal(parsed.signals[0]?.seedSample?.sourceTimestampUtc, null)
  assert.ok(parsed.signals[0]?.seedSample?.observedAtUtc)
  assert.ok(parsed.signals[0]?.seedSample?.receivedAtUtc)
})

test('telemetry foundation contains no database writes and uses read-only upstream routes', async () => {
  const files = ['telemetry-api-client.ts', 'telemetry-source-registry.ts', 'telemetry-capability-registry.ts', 'telemetry-foundation-service.ts']
  const source = (await Promise.all(files.map((file) => readFile(new URL(`../src/telemetry/${file}`, import.meta.url), 'utf8')))).join('\n')
  assert.doesNotMatch(source, /\bINSERT\s+INTO\b|\bUPDATE\s+\w+\s+SET\b|\bDELETE\s+FROM\b|\bCREATE\s+TABLE\b|\bALTER\s+TABLE\b|\bDROP\s+TABLE\b/i)
  assert.doesNotMatch(source, /mqtt|collector|press_radius_db|classification_documents/i)
  assert.match(source, /machine-speed-history/)
  assert.match(source, /semantic-history\/query/)
})

test('sanitized production fixtures cover P5, P12, and P14 without real business values', () => {
  assert.equal(press5SpeedFixture.actual.sourceUnit, null)
  assert.ok(mixedHistoryFixture.signals.some(({ canonicalId }) => canonicalId === 'deck.active'))
  assert.ok(mixedHistoryFixture.signals.some(({ canonicalId }) => canonicalId === 'ink.temperature.actual'))
  assert.ok(press12EvidenceFixture.signals.some(({ canonicalId }) => canonicalId === 'register.long.actual_or_correction'))
  assert.ok(press12EvidenceFixture.signals.some(({ canonicalId, changes }) => canonicalId === 'ink.washup.state' && changes[0]?.value === 512))
  assert.ok(press12EvidenceFixture.signals.some(({ canonicalId, changes }) => canonicalId === 'ink.pump.status' && changes[0]?.value === 11))
  assert.equal(press14ContextFixture.signals.find(({ canonicalId }) => canonicalId === 'production.job')?.supported, false)
  assert.equal(press14ContextFixture.signals.find(({ canonicalId }) => canonicalId === 'production.material')?.supported, false)
  assert.equal(press14SpeedFixture.actual.sourceUnit, 'ft/min')
  assert.doesNotMatch(JSON.stringify({ mixedHistoryFixture, press12EvidenceFixture, press14ContextFixture }), /Acme|customer-name|actual-customer/i)
})
