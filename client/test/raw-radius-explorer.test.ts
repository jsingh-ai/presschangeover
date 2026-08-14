import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { areaFromPathname, areaPath } from '../src/navigation'
import { DEFAULT_RAW_EXPLORER_CONTEXT_MINUTES, DEFAULT_RAW_EXPLORER_LOOKBACK_MINUTES, filterRawExplorerIdentities, rawExplorerNumberSamples, rawExplorerStateIntervals, validateRawExplorerWindow } from '../src/components/RawRadiusExplorerPage'
import type { RawExplorerOccurrence, RawExplorerSignalHistory, RawTelemetryChange, RawTelemetrySample } from '../src/types/api'

const pageSource = readFileSync(new URL('../src/components/RawRadiusExplorerPage.tsx', import.meta.url), 'utf8')
const apiSource = readFileSync(new URL('../src/api/process-intelligence-api.ts', import.meta.url), 'utf8')
const shellSource = readFileSync(new URL('../src/components/ApplicationShell.tsx', import.meta.url), 'utf8')

const sample = (observedAtUtc: string, value: number | string): RawTelemetrySample => ({ observedAtUtc, receivedAtUtc: observedAtUtc, sourceTimestampUtc: observedAtUtc, qualityState: 'GOOD', valueKind: typeof value === 'number' ? 'numeric' : 'string', value })
const change = (observedAtUtc: string, previousValue: number | string, value: number | string): RawTelemetryChange => ({ ...sample(observedAtUtc, value), previousObservedAtUtc: '2026-08-13T11:59:00.000Z', previousReceivedAtUtc: '2026-08-13T11:59:00.000Z', previousSourceTimestampUtc: '2026-08-13T11:59:00.000Z', previousQualityState: 'GOOD', previousValueKind: typeof previousValue === 'number' ? 'numeric' : 'string', previousValue })
const occurrence: RawExplorerOccurrence = { occurrenceId: 'one', pressKey: 'press3', displayName: 'Press 3', pressOccurrenceIndex: 1, pressOccurrenceCount: 1, eventType: 'B', statusCode: '400', statusDescription: 'Recorded', startUtc: '2026-08-13T12:00:00.000Z', endUtc: '2026-08-13T12:10:00.000Z', durationSeconds: 600, chartFromUtc: '2026-08-13T11:30:00.000Z', chartToUtc: '2026-08-13T12:40:00.000Z' }

function history(partial: Partial<RawExplorerSignalHistory>): RawExplorerSignalHistory {
  return { canonicalId: 'ink.pump.status', deckNumber: 4, friendlyName: 'Pump status', signalType: 'state_event', category: 'pump', scope: 'deck', representation: 'changes', sourceUnit: null, canonicalUnitStatus: 'UNVERIFIED', seed: null, samples: [], changes: [], ...partial }
}

describe('Raw Radius Code Explorer client', () => {
  it('owns a top-level route and navigation item', () => {
    assert.equal(areaFromPathname('/raw-radius-explorer'), 'raw-radius-explorer')
    assert.equal(areaPath('raw-radius-explorer'), '/raw-radius-explorer')
    assert.match(shellSource, /Raw Radius Explorer/)
  })

  it('validates positive lookback, nonnegative context, and reports the explicit 1,440-minute maximum', () => {
    assert.equal(DEFAULT_RAW_EXPLORER_LOOKBACK_MINUTES, 10)
    assert.equal(DEFAULT_RAW_EXPLORER_CONTEXT_MINUTES, 30)
    assert.equal(validateRawExplorerWindow('15', 'Change Lookback', false), 15)
    assert.equal(validateRawExplorerWindow('0', 'Chart Context', true), 0)
    assert.equal(validateRawExplorerWindow('1440', 'Chart Context', true), 1_440)
    assert.throws(() => validateRawExplorerWindow('0', 'Change Lookback', false), /above 0/)
    assert.throws(() => validateRawExplorerWindow('1441', 'Chart Context', true), /cannot exceed 1,440 minutes/)
  })

  it('filters G/B/M/S and searches the complete exact identity without merging same-code descriptions', () => {
    const identities = [
      { identity: 'G-one', eventType: 'G', statusCode: '1', statusDescription: 'Good one', eventCount: 1, lastSeenUtc: null },
      { identity: 'B-one', eventType: 'B', statusCode: '29', statusDescription: 'Electrical: Press Other', eventCount: 1, lastSeenUtc: null },
      { identity: 'B-two', eventType: 'B', statusCode: '29', statusDescription: 'Different description', eventCount: 1, lastSeenUtc: null },
      { identity: 'M-one', eventType: 'M', statusCode: '47', statusDescription: 'Make Ready', eventCount: 1, lastSeenUtc: null },
      { identity: 'S-one', eventType: 'S', statusCode: '400', statusDescription: 'Sort', eventCount: 1, lastSeenUtc: null },
    ] as const
    assert.deepEqual(filterRawExplorerIdentities([...identities], 'G', '').map(({ identity }) => identity), ['G-one'])
    assert.deepEqual(filterRawExplorerIdentities([...identities], 'B', 'B / 29 / different').map(({ identity }) => identity), ['B-two'])
    assert.deepEqual(filterRawExplorerIdentities([...identities], 'M', '').map(({ identity }) => identity), ['M-one'])
    assert.deepEqual(filterRawExplorerIdentities([...identities], 'S', '').map(({ identity }) => identity), ['S-one'])
  })

  it('plots state history as intervals and step-reference history as numeric steps', () => {
    const state = history({ seed: sample('2026-08-13T11:29:00.000Z', 1), changes: [change('2026-08-13T11:55:00.000Z', 1, 11), change('2026-08-13T12:05:00.000Z', 11, 1)] })
    assert.deepEqual(rawExplorerStateIntervals(state, occurrence).map(({ startUtc, endUtc, label }) => ({ startUtc, endUtc, label })), [
      { startUtc: occurrence.chartFromUtc, endUtc: '2026-08-13T11:55:00.000Z', label: '1' },
      { startUtc: '2026-08-13T11:55:00.000Z', endUtc: '2026-08-13T12:05:00.000Z', label: '11' },
      { startUtc: '2026-08-13T12:05:00.000Z', endUtc: occurrence.chartToUtc, label: '1' },
    ])
    const step = history({ canonicalId: 'machine.speed.setpoint', deckNumber: null, friendlyName: 'Speed setpoint', signalType: 'step_reference', category: 'speed', scope: 'machine', seed: sample('2026-08-13T11:29:00.000Z', 15), changes: [change('2026-08-13T11:55:00.000Z', 15, 40)] })
    assert.deepEqual(rawExplorerNumberSamples(step).map(({ value }) => value), [15, 40])
  })

  it('keeps draft settings unapplied, loads cards incrementally, and caches per-card plots in insertion order', () => {
    assert.match(pageSource, /Settings changed · Explore to apply/)
    assert.match(pageSource, /INITIAL_OCCURRENCE_COUNT = 20/)
    assert.match(pageSource, /Load 20 more/)
    assert.match(pageSource, /IntersectionObserver/)
    assert.match(pageSource, /new RequestQueue\(2\)/)
    assert.match(pageSource, /detailRequested\.current/)
    assert.match(pageSource, /cache\.current\.has\(key\)/)
    assert.match(pageSource, /setActivePlots\(\(current\) => \[\.\.\.current, key\]\)/)
  })

  it('uses exact raw identity, synchronized speed, half-open discovery, and no classification language', () => {
    assert.match(pageSource, /Radius S State/)
    assert.match(pageSource, /Raw Radius context/)
    assert.match(pageSource, /Actual speed/)
    assert.match(pageSource, /Strict half-open window/)
    assert.match(pageSource, /highlightedRange=/)
    assert.match(pageSource, /onInspectionTimeChange/)
    assert.match(apiSource, /raw-explorer\/identities/)
    assert.match(apiSource, /raw-explorer\/detail/)
    assert.match(apiSource, /raw-explorer\/plot/)
    assert.doesNotMatch(pageSource, /operational group|process family|classified as|root cause|safety state/i)
  })
})
