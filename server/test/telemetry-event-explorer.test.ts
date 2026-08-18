import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { RadiusService } from '../src/radius/radius-service.js'
import { RawRadiusExplorerService } from '../src/raw-radius-explorer/raw-radius-explorer-service.js'
import { TelemetryEventExplorerService } from '../src/telemetry-event-explorer/telemetry-event-explorer-service.js'
import type { TelemetrySemanticSelector } from '../src/telemetry/telemetry-contracts.js'
import type { PressSemanticSignalWithIdentity, TelemetryFoundationService } from '../src/telemetry/telemetry-foundation-service.js'

const fromUtc = '2026-08-17T10:00:00.000Z'
const toUtc = '2026-08-17T10:10:00.000Z'
const radius = { getHealth: async () => ({ status: 'healthy', configured: true }), getOverview: async () => { throw new Error('unused') }, getPressEpisodes: async () => { throw new Error('unused') }, getEpisode: async () => { throw new Error('unused') }, getRawTimeline: async (pressKey: string, rangeFromUtc: string, rangeToUtc: string) => ({ pressKey, displayName: 'Press 14', fromUtc: rangeFromUtc, toUtc: rangeToUtc, segments: [] }) } as RadiusService

function history(selector: TelemetrySemanticSelector, pressKey: string): PressSemanticSignalWithIdentity {
  const sample = (minute: number, value: number | boolean | string, valueKind: 'numeric' | 'boolean' | 'string' = 'numeric') => ({ observedAtUtc: `2026-08-17T10:0${minute}:00.000Z`, receivedAtUtc: `2026-08-17T10:0${minute}:00.000Z`, sourceTimestampUtc: `2026-08-17T10:0${minute}:00.000Z`, qualityState: 'GOOD', valueKind, value })
  const state = selector.canonicalId === 'production.job' ? { valueKind: 'string' as const, samples: [sample(0, `${pressKey}-A`, 'string'), sample(1, `${pressKey}-A`, 'string'), sample(2, `${pressKey}-B`, 'string')] } : selector.canonicalId === 'deck.active' ? { valueKind: 'boolean' as const, samples: [sample(0, false, 'boolean'), sample(1, false, 'boolean'), sample(2, true, 'boolean')] } : { valueKind: 'numeric' as const, samples: [sample(0, 198), sample(1, 202), sample(2, 199)] }
  return { canonicalId: selector.canonicalId, deckNumber: selector.deckNumber ?? null, capabilityState: 'SUPPORTED', observationState: 'SUPPORTED_WITH_OBSERVATIONS', mappingStatus: 'MAPPED', historianSignalId: Number(`${pressKey.replace('press', '')}${selector.deckNumber ?? 0}`), rawSignalId: `${pressKey}.trusted.${selector.canonicalId}.deck${selector.deckNumber ?? 'machine'}`, sourceSelector: null, selectedVariant: 'trusted', sourceUnit: selector.canonicalId === 'anilox.drive.temperature.actual' ? 'degC' : null, canonicalUnitStatus: 'VERIFIED', representation: 'samples', seed: null, samples: state.samples, changes: [], valueKind: state.valueKind }
}

function fixture() {
  const calls: Array<{ pressKey: string; selectors: TelemetrySemanticSelector[]; fromUtc: string; toUtc: string }> = []
  const telemetry = {
    capabilities: { get: async (pressKey: string) => {
      if (pressKey !== 'press14' && pressKey !== 'press15') throw new Error('unsupported')
      return { pressKey, displayName: pressKey === 'press14' ? 'Press 14' : 'Press 15', capabilities: [{ canonicalId: 'anilox.drive.temperature.actual', state: 'SUPPORTED', deckNumbers: [1, 2], historyQueryable: true, evidenceKind: 'semantic_history' }, { canonicalId: 'production.job', state: 'SUPPORTED', deckNumbers: [], historyQueryable: true, evidenceKind: 'semantic_history' }, { canonicalId: 'deck.active', state: 'SUPPORTED', deckNumbers: [1, 2], historyQueryable: true, evidenceKind: 'semantic_history' }] }
    } },
    semanticHistoryWithIdentity: async (pressKey: string, query: { fromUtc: string; toUtc: string; signals: TelemetrySemanticSelector[] }) => { calls.push({ pressKey, selectors: query.signals, fromUtc: query.fromUtc, toUtc: query.toUtc }); return { signals: query.signals.map((selector) => history(selector, pressKey)) } },
    semanticHistory: async (pressKey: string, query: { fromUtc: string; toUtc: string; signals: TelemetrySemanticSelector[] }) => ({ signals: query.signals.map((selector) => { const value = history(selector, pressKey); return { canonicalId: value.canonicalId, deckNumber: value.deckNumber, capabilityState: value.capabilityState, observationState: value.observationState, mappingStatus: value.mappingStatus, sourceUnit: value.sourceUnit, canonicalUnitStatus: value.canonicalUnitStatus, representation: value.representation, seed: value.seed, samples: value.samples, changes: value.changes } }) }),
    rawCatalog: async (pressKey: string) => Array.from({ length: 120 }, (_, index) => ({ id: index + 1, sourceId: 1, signalId: `${pressKey}.raw.signal.${String(index).padStart(3, '0')}`, displayName: index === 117 ? 'Late Boolean Flag' : index === 118 ? 'Late Job Name' : index === 119 ? 'Container Payload' : `Raw Signal ${index}`, sourceUnit: index === 0 ? 'degF' : null, valueKind: index === 117 ? 'boolean' : index === 118 ? 'string' : index === 119 ? 'object' : 'numeric', enabled: true })),
    rawHistory: async (pressKey: string, rawIdentity: string, rangeFromUtc: string, rangeToUtc: string) => {
      const index = Number(rawIdentity.split('.').at(-1)); const values: unknown[] = index === 117 ? ['', false, false, true] : index === 118 ? ['ABC', 'ABC', 'XYZ'] : index === 119 ? [{ nested: true }] : index === 116 ? [] : [120, 125, 123]
      return { press: pressKey, displayName: pressKey.replace('press', 'Press '), rawIdentity, signalDisplayName: index === 117 ? 'Late Boolean Flag' : index === 118 ? 'Late Job Name' : `Raw Signal ${index}`, dataType: index === 117 ? 'boolean' : index === 118 ? 'string' : index === 119 ? 'object' : 'numeric', dataKind: index === 117 ? 'mixed' : index === 119 ? 'container' : index === 118 ? 'string' : 'numeric', sourceUnit: index === 0 ? 'degF' : null, plottable: index !== 117 && index !== 119, fromUtc: rangeFromUtc, toUtc: rangeToUtc, historianReadCount: 1, alternateRepresentationCount: 0, alternateRawIdentities: [], observations: values.map((rawValue, itemIndex) => ({ timestampUtc: `2026-08-17T10:0${itemIndex}:00.000Z`, receivedAtUtc: `2026-08-17T10:0${itemIndex}:00.000Z`, sourceTimestampUtc: `2026-08-17T10:0${itemIndex}:00.000Z`, qualityState: 'GOOD', dataType: typeof rawValue, rawValue })) }
    },
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

  it('keeps cross-press Job changes and Any Deck boolean changes isolated by exact resolved series', async () => {
    const { service } = fixture()
    const jobs = await service.search({ fromUtc, toUtc, source: { kind: 'canonical', canonicalId: 'production.job' }, pressKey: 'all', deckNumber: null, rule: { kind: 'value_change', match: 'any' }, chartContextMinutes: 20 })
    assert.equal(jobs.summary.resolvedSeries, 2); assert.equal(jobs.summary.totalOccurrences, 2)
    assert.deepEqual(jobs.occurrences.map(({ pressKey, previousValue, newValue }) => ({ pressKey, previousValue, newValue })), [{ pressKey: 'press14', previousValue: 'press14-A', newValue: 'press14-B' }, { pressKey: 'press15', previousValue: 'press15-A', newValue: 'press15-B' }])
    const decks = await service.search({ fromUtc, toUtc, source: { kind: 'canonical', canonicalId: 'deck.active' }, pressKey: 'press14', deckNumber: 'any', rule: { kind: 'value_change', match: 'from_to', fromValue: false, toValue: true }, chartContextMinutes: 20 })
    assert.equal(decks.summary.resolvedSeries, 2); assert.equal(decks.summary.totalOccurrences, 2)
    assert.deepEqual(decks.occurrences.map(({ deckNumber }) => deckNumber), [1, 2])
    assert.equal(new Set(decks.occurrences.map(({ occurrenceId }) => occurrenceId)).size, 2)
  })

  it('searches the complete raw catalog beyond the initial page and retains nonnumeric scalars', async () => {
    const { service } = fixture()
    const first = await service.rawCatalog('press14', '', 0, 50)
    assert.equal(first.items.length, 50); assert.equal(first.catalogTotal, 120)
    assert.ok(!first.items.some(({ displayName }) => displayName === 'Late Job Name'))
    const late = await service.rawCatalog('press14', 'late', 0, 50)
    assert.equal(late.total, 2)
    assert.deepEqual(late.items.map(({ displayName, dataKind }) => ({ displayName, dataKind })), [{ displayName: 'Late Boolean Flag', dataKind: 'boolean' }, { displayName: 'Late Job Name', dataKind: 'string' }])
  })

  it('previews each scalar datatype, preserves no-history/container states, and filters mixed boolean artifacts', async () => {
    const { service } = fixture()
    const source = (index: number, displayName: string) => ({ kind: 'raw' as const, pressKey: 'press14' as const, rawIdentity: `press14.raw.signal.${String(index).padStart(3, '0')}`, displayName })
    const numeric = await service.preview({ source: source(0, 'Temperature'), pressKey: 'press14', deckNumber: null, fromUtc, toUtc })
    assert.equal(numeric.dataKind, 'numeric'); assert.equal(numeric.observations.length, 3)
    const text = await service.preview({ source: source(118, 'Late Job Name'), pressKey: 'press14', deckNumber: null, fromUtc, toUtc })
    assert.deepEqual(text.observations.map(({ value }) => value), ['ABC', 'ABC', 'XYZ'])
    const bool = await service.preview({ source: source(117, 'Late Boolean Flag'), pressKey: 'press14', deckNumber: null, fromUtc, toUtc })
    assert.equal(bool.plottable, true); assert.deepEqual(bool.observations.map(({ value }) => value), [false, false, true])
    const booleanEvents = await service.search({ fromUtc, toUtc, source: source(117, 'Late Boolean Flag'), pressKey: 'press14', deckNumber: null, rule: { kind: 'value_change', match: 'any' }, chartContextMinutes: 20 })
    assert.deepEqual(booleanEvents.occurrences.map(({ previousValue, newValue }) => [previousValue, newValue]), [[false, true]])
    const empty = await service.preview({ source: source(116, 'No History'), pressKey: 'press14', deckNumber: null, fromUtc, toUtc })
    assert.deepEqual(empty.observations, [])
    const container = await service.preview({ source: source(119, 'Container Payload'), pressKey: 'press14', deckNumber: null, fromUtc, toUtc })
    assert.equal(container.plottable, false); assert.deepEqual(container.observations, [])
  })

  it('summarizes only matching bounded search occurrences without target-control claims', async () => {
    const { service } = fixture(); const result = await service.search({ fromUtc, toUtc, source: { kind: 'canonical', canonicalId: 'anilox.drive.temperature.actual' }, pressKey: 'press14', deckNumber: 1, rule: { kind: 'threshold', operator: '>', threshold: 200 }, chartContextMinutes: 20 }); const selected = result.occurrences[0]!
    const supplied = Array.from({ length: 600 }, (_item, index) => ({ ...selected, occurrenceId: `event-${index}`, durationSeconds: index + 1 }))
    const summary = service.historicalSummary({ occurrence: selected, occurrences: supplied })
    assert.equal(summary.supportCount, 500); assert.equal(summary.metrics.truncatedAt, 500); assert.match(summary.scope, /exact source identity/); assert.doesNotMatch(summary.limitations.join(' '), /cause|control cohort/i)
  })

  it('builds the canonical-only bounded target-event report through shared fingerprints', async () => {
    const { service, calls } = fixture(); const result = await service.search({ fromUtc, toUtc, source: { kind: 'canonical', canonicalId: 'anilox.drive.temperature.actual' }, pressKey: 'press14', deckNumber: 1, rule: { kind: 'threshold', operator: '>', threshold: 200 }, chartContextMinutes: 20 }); const selected = result.occurrences[0]!
    const report = await service.eventLearningReport({ occurrence: selected, occurrences: result.occurrences })
    assert.equal(report.reportKind, 'telemetry_event'); assert.equal(report.coverage.automaticRawSignalScans, 0); assert.ok(report.performance.payloadBytes > 0)
    assert.ok(report.performance.cohortOccurrences <= 30); assert.ok(report.coverage.candidateSignals <= 12)
    assert.ok(calls.every((call) => Date.parse(call.toUtc) - Date.parse(call.fromUtc) <= 2 * 60 * 60_000))
    assert.match(report.coverage.limitations.join(' '), /canonical-only|do not establish causation/i)
  })
})
