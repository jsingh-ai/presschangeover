import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import type { TelemetryClient } from '../src/telemetry/telemetry-api-client.js'
import { TelemetryFoundationService } from '../src/telemetry/telemetry-foundation-service.js'
import type { TelemetrySemanticHistoryResponse } from '../src/telemetry/telemetry-contracts.js'
import { TelemetryApiError } from '../src/telemetry/telemetry-error.js'
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

test('telemetry cancellation and outage remain typed and independent', async () => {
  const controller = new AbortController(); controller.abort()
  await assert.rejects(new TelemetryFoundationService(baseClient()).sources.resolve('press5', undefined, controller.signal), (error: unknown) => error instanceof TelemetryApiError && error.kind === 'cancelled')
  const down = new TelemetryFoundationService(baseClient({ getSources: async () => { throw new TelemetryApiError('unavailable') } }))
  await assert.rejects(down.speed('press5', press14SpeedFixture.fromUtc, press14SpeedFixture.toUtc), (error: unknown) => error instanceof TelemetryApiError && error.kind === 'unavailable')
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
