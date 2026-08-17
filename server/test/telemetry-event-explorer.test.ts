import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { RadiusService } from '../src/radius/radius-service.js'
import { RawRadiusExplorerService } from '../src/raw-radius-explorer/raw-radius-explorer-service.js'
import { TelemetryEventExplorerService } from '../src/telemetry-event-explorer/telemetry-event-explorer-service.js'
import type { TelemetrySemanticSelector } from '../src/telemetry/telemetry-contracts.js'
import type { PressSemanticSignalWithIdentity, TelemetryFoundationService } from '../src/telemetry/telemetry-foundation-service.js'

const fromUtc = '2026-08-17T10:00:00.000Z'
const toUtc = '2026-08-17T10:10:00.000Z'
const radius = { getHealth: async () => ({ status: 'healthy', configured: true }), getOverview: async () => { throw new Error('unused') }, getPressEpisodes: async () => { throw new Error('unused') }, getEpisode: async () => { throw new Error('unused') } } as RadiusService

function history(selector: TelemetrySemanticSelector, pressKey: string): PressSemanticSignalWithIdentity {
  const sample = (minute: number, value: number) => ({ observedAtUtc: `2026-08-17T10:0${minute}:00.000Z`, receivedAtUtc: `2026-08-17T10:0${minute}:00.000Z`, sourceTimestampUtc: `2026-08-17T10:0${minute}:00.000Z`, qualityState: 'GOOD', valueKind: 'numeric' as const, value })
  return { canonicalId: selector.canonicalId, deckNumber: selector.deckNumber ?? null, capabilityState: 'SUPPORTED', observationState: 'SUPPORTED_WITH_OBSERVATIONS', mappingStatus: 'MAPPED', historianSignalId: Number(`${pressKey.replace('press', '')}${selector.deckNumber ?? 0}`), rawSignalId: `${pressKey}.trusted.deck${selector.deckNumber}.anilox_temperature`, sourceSelector: null, selectedVariant: 'trusted', sourceUnit: 'degC', canonicalUnitStatus: 'VERIFIED', representation: 'samples', seed: null, samples: [sample(0, 198), sample(1, 202), sample(2, 199)], changes: [] }
}

function fixture() {
  const calls: Array<{ pressKey: string; selectors: TelemetrySemanticSelector[]; fromUtc: string; toUtc: string }> = []
  const telemetry = {
    capabilities: { get: async (pressKey: string) => {
      if (pressKey !== 'press14' && pressKey !== 'press15') throw new Error('unsupported')
      return { pressKey, displayName: pressKey === 'press14' ? 'Press 14' : 'Press 15', capabilities: [{ canonicalId: 'anilox.drive.temperature.actual', state: 'SUPPORTED', deckNumbers: [1, 2], historyQueryable: true, evidenceKind: 'semantic_history' }] }
    } },
    semanticHistoryWithIdentity: async (pressKey: string, query: { fromUtc: string; toUtc: string; signals: TelemetrySemanticSelector[] }) => { calls.push({ pressKey, selectors: query.signals, fromUtc: query.fromUtc, toUtc: query.toUtc }); return { signals: query.signals.map((selector) => history(selector, pressKey)) } },
  } as unknown as TelemetryFoundationService
  const raw = new RawRadiusExplorerService(radius, telemetry)
  return { service: new TelemetryEventExplorerService(telemetry, radius, raw), calls }
}

describe('Telemetry Event Explorer service', () => {
  it('resolves All Compatible Presses + Any Deck only through trusted mappings and never merges series', async () => {
    const { service } = fixture()
    const result = await service.search({ fromUtc, toUtc, source: { kind: 'canonical', canonicalId: 'anilox.drive.temperature.actual' }, pressKey: 'all', deckNumber: 'any', rule: { kind: 'threshold', operator: '>', threshold: 200 }, chartContextMinutes: 20 })
    assert.equal(result.summary.resolvedSeries, 4)
    assert.equal(result.summary.totalOccurrences, 4)
    assert.deepEqual(result.summary.compatiblePressesSearched, ['press14', 'press15'])
    assert.deepEqual(result.summary.compatibleDecksSearched, [1, 2])
    assert.deepEqual(result.summary.pressCounts.map(({ pressKey, occurrenceCount }) => ({ pressKey, occurrenceCount })), [{ pressKey: 'press14', occurrenceCount: 2 }, { pressKey: 'press15', occurrenceCount: 2 }])
    assert.equal(new Set(result.occurrences.map(({ occurrenceId }) => occurrenceId)).size, 4)
    assert.ok(result.occurrences.every(({ rawIdentity }) => rawIdentity.includes('.trusted.')))
  })

  it('limits a selected deck and keeps every upstream history request within two hours', async () => {
    const { service, calls } = fixture()
    const result = await service.search({ fromUtc, toUtc: '2026-08-17T14:10:00.000Z', source: { kind: 'canonical', canonicalId: 'anilox.drive.temperature.actual' }, pressKey: 'press14', deckNumber: 1, rule: { kind: 'delta', direction: 'increase', amount: 4, windowMinutes: 10 }, chartContextMinutes: 30 })
    assert.ok(result.occurrences.every(({ pressKey, deckNumber }) => pressKey === 'press14' && deckNumber === 1))
    assert.ok(calls.every(({ selectors }) => selectors.length === 1 && selectors[0]?.deckNumber === 1))
    assert.ok(calls.every((call) => Date.parse(call.toUtc) - Date.parse(call.fromUtc) <= 2 * 60 * 60_000))
  })
})
