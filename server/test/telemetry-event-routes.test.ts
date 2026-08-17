import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { createApp } from '../src/app.js'
import type { TelemetryClient } from '../src/telemetry/telemetry-api-client.js'

const semanticHistoryRanges: Array<{ fromUtc: string; toUtc: string }> = []

const client: TelemetryClient = {
  getHealth: async () => ({ service: 'TelemetryQueryApi', status: 'healthy' }),
  getDatabaseHealth: async () => ({ service: 'TelemetryQueryApi', database: 'historian', status: 'healthy' }),
  getSources: async () => [{ id: 14, sourceKey: 'press14', displayName: 'Press 14', enabled: true }],
  getCapabilities: async (sourceId) => ({ sourceId, sourceKey: 'press14', displayName: 'Press 14', capabilities: [{ canonicalId: 'anilox.drive.temperature.actual', supported: true, deckNumbers: [1], historyQueryable: true, evidenceKind: 'semantic_history' }] }),
  querySemanticHistory: async (sourceId, query) => { semanticHistoryRanges.push({ fromUtc: query.fromUtc, toUtc: query.toUtc }); return { sourceId, sourceKey: 'press14', displayName: 'Press 14', fromUtc: query.fromUtc, toUtc: query.toUtc, includeSeed: query.includeSeed, signals: query.signals.map((selector) => ({ canonicalId: selector.canonicalId, deckNumber: selector.deckNumber ?? null, supported: true, mappingStatus: 'MAPPED', historianSignalId: 1401, rawSignalId: 'Press14.Deck1.AniloxTemperature', sourceUnit: 'degC', canonicalUnitStatus: 'VERIFIED', valueKind: 'numeric', sourceSelector: 'trusted', selectedVariant: null, representation: selector.representation, seedSample: null, samples: [{ observedAtUtc: '2026-08-17T10:00:00.000Z', receivedAtUtc: '2026-08-17T10:00:00.000Z', sourceTimestampUtc: '2026-08-17T10:00:00.000Z', qualityState: 'GOOD', valueKind: 'numeric', value: 198 }, { observedAtUtc: '2026-08-17T10:01:00.000Z', receivedAtUtc: '2026-08-17T10:01:00.000Z', sourceTimestampUtc: '2026-08-17T10:01:00.000Z', qualityState: 'GOOD', valueKind: 'numeric', value: 204 }, { observedAtUtc: '2026-08-17T10:02:00.000Z', receivedAtUtc: '2026-08-17T10:02:00.000Z', sourceTimestampUtc: '2026-08-17T10:02:00.000Z', qualityState: 'GOOD', valueKind: 'numeric', value: 199 }], changes: [] })) } },
  getPhysicalState: async () => { throw new Error('unused') },
}

async function call(path: string, body?: unknown) {
  const app = createApp({ telemetryClient: client, logger: false })
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>((resolve) => server.once('listening', resolve)); const address = server.address() as AddressInfo
  try { const response = await fetch(`http://127.0.0.1:${address.port}${path}`, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() as Record<string, unknown> } }
  finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) }
}

test('event catalog and threshold search routes expose trusted mapped numeric series', async () => {
  const catalog = await call('/api/telemetry/event-explorer/catalog')
  assert.equal(catalog.status, 200)
  assert.ok((catalog.body.canonicalVariables as Array<{ canonicalId: string }>).some(({ canonicalId }) => canonicalId === 'anilox.drive.temperature.actual'))
  const search = await call('/api/telemetry/event-explorer/search', { fromUtc: '2026-08-17T10:00:00.000Z', toUtc: '2026-08-17T10:10:00.000Z', source: { kind: 'canonical', canonicalId: 'anilox.drive.temperature.actual' }, pressKey: 'all', deckNumber: 'any', rule: { kind: 'threshold', operator: '>', threshold: 200 }, chartContextMinutes: 30 })
  assert.equal(search.status, 200)
  const summary = search.body.summary as { totalOccurrences: number; resolvedSeries: number }
  assert.deepEqual(summary, { ...summary, totalOccurrences: 1, resolvedSeries: 1 })
  const occurrence = (search.body.occurrences as Array<{ pressKey: string; deckNumber: number; rawIdentity: string; startUtc: string; endUtc: string }>)[0]
  assert.deepEqual(occurrence, { ...occurrence!, pressKey: 'press14', deckNumber: 1, rawIdentity: 'Press14.Deck1.AniloxTemperature', startUtc: '2026-08-17T10:01:00.000Z', endUtc: '2026-08-17T10:02:00.000Z' })
})

test('event search route rejects malformed rules before upstream work', async () => {
  const response = await call('/api/telemetry/event-explorer/search', { fromUtc: '2026-08-17T10:00:00.000Z', toUtc: '2026-08-17T10:10:00.000Z', source: { kind: 'canonical', canonicalId: 'anilox.drive.temperature.actual' }, pressKey: 'all', deckNumber: 'any', rule: { kind: 'delta', direction: 'increase', amount: 0, windowMinutes: 10 }, chartContextMinutes: 30 })
  assert.equal(response.status, 400)
  assert.deepEqual(response.body, { error: 'invalid_telemetry_event_rule' })
})

test('event preview accepts the full selected range while bounding every historian read to two hours', async () => {
  semanticHistoryRanges.length = 0
  const fromUtc = '2026-08-16T10:00:00.000Z'; const toUtc = '2026-08-17T10:00:00.000Z'
  const response = await call('/api/telemetry/event-explorer/preview', { fromUtc, toUtc, source: { kind: 'canonical', canonicalId: 'anilox.drive.temperature.actual' }, pressKey: 'press14', deckNumber: 1 })
  assert.equal(response.status, 200)
  assert.equal(response.body.fromUtc, fromUtc); assert.equal(response.body.toUtc, toUtc)
  assert.equal(semanticHistoryRanges.length, 12)
  assert.ok(semanticHistoryRanges.every((range) => Date.parse(range.toUtc) - Date.parse(range.fromUtc) <= 2 * 60 * 60_000))

  semanticHistoryRanges.length = 0
  const tooLong = await call('/api/telemetry/event-explorer/preview', { fromUtc: '2026-07-16T10:00:00.000Z', toUtc, source: { kind: 'canonical', canonicalId: 'anilox.drive.temperature.actual' }, pressKey: 'press14', deckNumber: 1 })
  assert.equal(tooLong.status, 400); assert.equal(semanticHistoryRanges.length, 0)
})
