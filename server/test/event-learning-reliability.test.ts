import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { describe, it } from 'node:test'
import { createApp } from '../src/app.js'
import type { RadiusService } from '../src/radius/radius-service.js'
import { RawRadiusExplorerService } from '../src/raw-radius-explorer/raw-radius-explorer-service.js'
import { TelemetryEventExplorerService } from '../src/telemetry-event-explorer/telemetry-event-explorer-service.js'
import type { TelemetryClient } from '../src/telemetry/telemetry-api-client.js'
import type { TelemetrySemanticSelector } from '../src/telemetry/telemetry-contracts.js'
import type { PressSemanticSignalWithIdentity, TelemetryFoundationService } from '../src/telemetry/telemetry-foundation-service.js'

const fromUtc = '2026-08-17T10:00:00.000Z'
const toUtc = '2026-08-17T10:10:00.000Z'
const radius = { getHealth: async () => ({ status: 'healthy', configured: true }), getOverview: async () => { throw new Error('unused') }, getPressEpisodes: async () => { throw new Error('unused') }, getEpisode: async () => { throw new Error('unused') }, getRawTimeline: async (pressKey: string, rangeFromUtc: string, rangeToUtc: string) => ({ pressKey, displayName: 'Press 14', fromUtc: rangeFromUtc, toUtc: rangeToUtc, segments: [] }) } as RadiusService

function history(selector: TelemetrySemanticSelector): PressSemanticSignalWithIdentity {
  const sample = (minute: number, value: number) => ({ observedAtUtc: `2026-08-17T10:0${minute}:00.000Z`, receivedAtUtc: `2026-08-17T10:0${minute}:00.000Z`, sourceTimestampUtc: `2026-08-17T10:0${minute}:00.000Z`, qualityState: 'GOOD' as const, valueKind: 'numeric' as const, value })
  const values = selector.canonicalId === 'machine.speed.actual' ? [100, 80, 60, 55] : [198, 204, 207, 199]
  return { canonicalId: selector.canonicalId, deckNumber: selector.deckNumber ?? null, capabilityState: 'SUPPORTED', observationState: 'SUPPORTED_WITH_OBSERVATIONS', mappingStatus: 'MAPPED', historianSignalId: 1401, rawSignalId: `press14.trusted.${selector.canonicalId}`, sourceSelector: null, selectedVariant: 'trusted', sourceUnit: selector.canonicalId === 'machine.speed.actual' ? 'fpm' : 'degC', canonicalUnitStatus: 'VERIFIED', representation: selector.representation, seed: null, samples: values.map((value, minute) => sample(minute, value)), changes: [], valueKind: 'numeric' }
}

function fixture() {
  const telemetry = {
    capabilities: { get: async () => ({ pressKey: 'press14', displayName: 'Press 14', capabilities: [{ canonicalId: 'anilox.drive.temperature.actual', state: 'SUPPORTED', deckNumbers: [1], historyQueryable: true, evidenceKind: 'semantic_history' }] }) },
    semanticHistoryWithIdentity: async (_pressKey: string, query: { signals: TelemetrySemanticSelector[] }) => ({ signals: query.signals.map(history) }),
    semanticHistory: async (_pressKey: string, query: { signals: TelemetrySemanticSelector[] }) => ({ signals: query.signals.map((selector) => { const value = history(selector); return { canonicalId: value.canonicalId, deckNumber: value.deckNumber, capabilityState: value.capabilityState, observationState: value.observationState, mappingStatus: value.mappingStatus, sourceUnit: value.sourceUnit, canonicalUnitStatus: value.canonicalUnitStatus, representation: value.representation, seed: value.seed, samples: value.samples, changes: value.changes } }) }),
    rawCatalog: async () => [],
    rawHistory: async () => { throw new Error('unused') },
  } as unknown as TelemetryFoundationService
  return new TelemetryEventExplorerService(telemetry, radius, new RawRadiusExplorerService(radius, telemetry))
}

async function report(service: TelemetryEventExplorerService, occurrenceCount: number) {
  const search = await service.search({ fromUtc, toUtc, source: { kind: 'canonical', canonicalId: 'anilox.drive.temperature.actual' }, pressKey: 'press14', deckNumber: 1, rule: { kind: 'threshold', operator: '>', threshold: 200 }, chartContextMinutes: 20 })
  const selected = search.occurrences[0]!
  const occurrences = [...Array.from({ length: Math.max(0, occurrenceCount - 1) }, (_item, index) => ({ ...selected, occurrenceId: `historical-${index}` })), selected]
  return service.eventLearningReport({ occurrence: selected, occurrences })
}

describe('Event Learning reliability isolation', () => {
  it('keeps normal optional relationship calculation available', async () => {
    const service = fixture()
    const analytics = (service as unknown as { analytics: { numericRelationship: (input: unknown) => unknown } }).analytics
    const original = analytics.numericRelationship.bind(analytics); let calls = 0
    analytics.numericRelationship = (input) => { calls += 1; return original(input) }
    const result = await report(service, 3)
    assert.ok(calls > 0)
    assert.equal(result.status, 'SUCCESS')
    assert.deepEqual(result.relationshipAnalysis, { status: 'AVAILABLE', reason: null })
  })

  it('returns the otherwise-valid report as PARTIAL when optional relationships throw', async () => {
    const service = fixture()
    const analytics = (service as unknown as { analytics: { numericRelationship: () => never } }).analytics
    analytics.numericRelationship = () => { throw new Error('forced optional failure') }
    const result = await report(service, 3)
    assert.equal(result.status, 'PARTIAL')
    assert.deepEqual(result.relationshipAnalysis, { status: 'UNAVAILABLE', reason: 'RELATIONSHIP_ANALYSIS_FAILED' })
    assert.deepEqual(result.relationships, [])
    assert.equal(result.target.detector, 'threshold')
    assert.ok(result.selectedOccurrence)
    assert.ok(result.historicalFingerprint)
    assert.ok(Array.isArray(result.phaseComparison))
    assert.match(result.coverage.limitations.join(' '), /RELATIONSHIP_ANALYSIS_FAILED/)
  })

  it('keeps insufficient evidence successful and distinct from partial technical degradation', async () => {
    const result = await report(fixture(), 1)
    assert.equal(result.status, 'INSUFFICIENT_EVIDENCE')
    assert.deepEqual(result.relationshipAnalysis, { status: 'AVAILABLE', reason: null })
    assert.equal(result.historicalFingerprint.qualifiedOccurrences, 1)
  })

  it('maps an oversized JSON request to the bounded HTTP 413 contract', async () => {
    const app = createApp({ telemetryClient: {} as TelemetryClient, logger: false })
    const server = app.listen(0, '127.0.0.1')
    await new Promise<void>((resolve) => server.once('listening', resolve))
    const address = server.address() as AddressInfo
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/telemetry/event-explorer/report`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ padding: 'x'.repeat(300 * 1024) }) })
      assert.equal(response.status, 413)
      assert.deepEqual(await response.json(), { error: 'request_payload_too_large' })
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  })
})
