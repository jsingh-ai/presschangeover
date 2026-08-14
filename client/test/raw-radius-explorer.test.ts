import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import React, { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { areaFromPathname, areaPath } from '../src/navigation'
import { DEFAULT_RAW_EXPLORER_CONTEXT_MINUTES, DEFAULT_RAW_EXPLORER_LOOKBACK_MINUTES, filterRawExplorerIdentities, formatRawExplorerNumber, groupRawExplorerSignals, groupRawUnmappedSignals, latestNumericAtOrBefore, RawExplorerInspectionTooltip, rawExplorerNumberSamples, rawExplorerNumericPresentation, rawExplorerStateIntervals, rawExplorerStatePresentation, rawUnmappedNumberSamples, rawUnmappedStateIntervals, validateRawExplorerWindow } from '../src/components/RawRadiusExplorerPage'
import { numericPaths, positionInspectionTooltip } from '../src/components/SynchronizedTimeline'
import type { RawExplorerChangedSignal, RawExplorerDetail, RawExplorerOccurrence, RawExplorerSignalHistory, RawTelemetryChange, RawTelemetrySample, RawUnmappedChangedSignal, RawUnmappedHistory } from '../src/types/api'

const pageSource = readFileSync(new URL('../src/components/RawRadiusExplorerPage.tsx', import.meta.url), 'utf8')
const apiSource = readFileSync(new URL('../src/api/process-intelligence-api.ts', import.meta.url), 'utf8')
const shellSource = readFileSync(new URL('../src/components/ApplicationShell.tsx', import.meta.url), 'utf8')
const timelineSource = readFileSync(new URL('../src/components/SynchronizedTimeline.tsx', import.meta.url), 'utf8')

Object.assign(globalThis, { React })

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

  it('holds sparse change-only observations without manufacturing timestamps or false gaps', () => {
    const sparse = [sample('2026-08-13T11:25:00.000Z', 900), sample('2026-08-13T12:05:00.000Z', 700)] as Array<RawTelemetrySample & { value: number }>
    const paths = numericPaths(sparse, Date.parse(occurrence.chartFromUtc), 80 * 60_000, 1_000, 88, true, 'step', true)
    assert.equal(paths.paths.length, 1)
    assert.match(paths.paths[0]!, /^M 0\.00 /)
    assert.match(paths.paths[0]!, /L 1000\.00 /)
    assert.deepEqual(sparse.map(({ observedAtUtc }) => observedAtUtc), ['2026-08-13T11:25:00.000Z', '2026-08-13T12:05:00.000Z'])
    assert.equal(latestNumericAtOrBefore(sparse, '2026-08-13T12:04:59.000Z')?.value, 900)
    assert.equal(latestNumericAtOrBefore(sparse, '2026-08-13T12:05:00.000Z')?.value, 700)
    assert.match(pageSource, /connectObservedGaps: true/)
    assert.match(pageSource, /holdLastObservation: true/)
  })

  it('shows a floating crosshair tooltip with Radius, speed, numeric, state, and actual observation times', () => {
    const numeric = history({ canonicalId: 'anilox.drive.torque.actual', friendlyName: 'Anilox Drive Torque', signalType: 'continuous', category: 'torque', representation: 'samples', seed: sample('2026-08-13T11:50:00.000Z', 17.4), samples: [sample('2026-08-13T12:02:00.000Z', 18.1)] })
    const state = history({ seed: sample('2026-08-13T11:50:00.000Z', 1), changes: [change('2026-08-13T12:03:00.000Z', 1, 11)] })
    const detail = {
      occurrence,
      lookback: { fromUtc: '2026-08-13T11:45:00.000Z', toUtc: occurrence.startUtc, halfOpen: true },
      radiusSegments: [{ kind: 'radius', machineId: 3, pressKey: 'press3', displayName: 'Press 3', startUtc: occurrence.startUtc, endUtc: occurrence.endUtc, durationSeconds: 600, isOpen: false, sourceGeneration: 'legacy', eventType: 'B', statusCode: '400', statusDescription: 'Recorded', isProduction: false }],
      currentRollLength: history({ canonicalId: 'production.roll.length.actual', deckNumber: null, friendlyName: 'Current Roll Length', signalType: 'step_reference', category: 'repeat_other', scope: 'machine', seed: sample('2026-08-13T11:50:00.000Z', 14_900), changes: [change('2026-08-13T12:02:00.000Z', 14_900, 14_915)] }),
      speed: { sourceUnit: 'fpm', canonicalUnitStatus: 'UNVERIFIED', samples: [sample('2026-08-13T12:01:00.000Z', 847)] },
      changedSignals: [], performance: { totalMs: 1, selectorCount: 2, semanticHistoryRequests: 1, speedHistoryMs: 1, payloadBytes: 10 },
    } as RawExplorerDetail
    const html = renderToStaticMarkup(createElement(RawExplorerInspectionTooltip, { atUtc: '2026-08-13T12:04:00.000Z', detail, histories: [numeric, state] }))
    assert.match(html, /Wall-clock time/)
    assert.match(html, /Current Roll Length/)
    assert.match(html, /14,915/)
    assert.match(html, /B \/ 400 \/ Recorded/)
    assert.match(html, /Actual Speed/)
    assert.match(html, /847/)
    assert.match(html, /Deck 4 · Anilox Drive Torque/)
    assert.match(html, /Deck 4 · Pump status/)
    assert.match(html, />11</)
    assert.ok((html.match(/Last observed:/g) ?? []).length >= 4)
    assert.match(timelineSource, /renderInspectionTooltip/)
    assert.match(timelineSource, /moveCrosshairWithKeyboard/)
    assert.match(timelineSource, /createPortal/)
    assert.match(timelineSource, /INSPECTION_TOOLTIP_GAP = 24/)
    assert.deepEqual(positionInspectionTooltip({ x: 400, y: 400 }, { width: 200, height: 100 }, { width: 1_000, height: 800 }), { left: 424, top: 276 })
    assert.deepEqual(positionInspectionTooltip({ x: 950, y: 50 }, { width: 200, height: 100 }, { width: 1_000, height: 800 }), { left: 726, top: 74 })
    assert.match(pageSource, /\['numeric:current-roll-length', 'interval:raw-radius', 'numeric:actual-speed'/)
    assert.match(pageSource, /Current Roll Length unavailable/)
    assert.match(pageSource, /alreadyShown \? 'Already shown'/)
    assert.match(pageSource, /unit: 'Unit unverified'/)
    assert.doesNotMatch(pageSource, /raw-crosshair-readout/)
  })

  it('uses rounded plain-language numeric and state summaries', () => {
    const numeric = rawExplorerNumericPresentation({ kind: 'numeric', firstValue: 112.489, lastValue: 110.47, netDelta: -2.01892, minimum: 107.03, maximum: 112.5714938, largestPositiveExcursion: .082405, largestNegativeExcursion: -5.45933, largestAbsoluteExcursion: 5.45933, observationCount: 8 })
    assert.deepEqual(numeric, { started: '112.5', ended: '110.5', overall: '↓ 2 overall', lowest: '107', highest: '112.6', biggestMove: '↓ 5.5' })
    assert.equal(formatRawExplorerNumber(112.5714938), '112.6')
    assert.deepEqual(rawExplorerStatePresentation({ kind: 'state', firstValue: 1, lastValue: 1, transitions: [{ atUtc: '2026-08-13T11:50:00.000Z', previousValue: 1, value: 11 }, { atUtc: '2026-08-13T11:55:00.000Z', previousValue: 11, value: 1 }] }), { sequence: '1 → 11 → 1', changes: 2 })
    assert.doesNotMatch(pageSource, /["'`]Δ|\+exc|−exc|max \|exc\||IQR|robust deviation/i)
    for (const label of ['Started', 'Ended', 'Lowest', 'Highest', 'Biggest move', 'Changed']) assert.match(pageSource, new RegExp(label))
  })

  it('keeps Machine separate and puts each populated deck around its internal categories', () => {
    const changed = (canonicalId: string, deckNumber: number | null, friendlyName: string, category: RawExplorerChangedSignal['category']): RawExplorerChangedSignal => ({ canonicalId, deckNumber, friendlyName, category, signalType: 'continuous', scope: deckNumber === null ? 'machine' : 'deck', summary: { kind: 'numeric', firstValue: 1, lastValue: 2, netDelta: 1, minimum: 1, maximum: 2, largestPositiveExcursion: 1, largestNegativeExcursion: 0, largestAbsoluteExcursion: 1, observationCount: 2 }, sourceUnit: null, canonicalUnitStatus: null })
    const groups = groupRawExplorerSignals([
      changed('dryer.tunnel.temperature.actual', null, 'Dryer', 'dryer'),
      changed('production.order.length.actual', null, 'Order Length', 'repeat_other'),
      changed('ink.viscosity.actual', 4, 'Viscosity', 'viscosity'),
      changed('ink.pump.status', 4, 'Pump', 'pump'),
      changed('register.long.preset', 7, 'Register', 'register'),
    ])
    assert.deepEqual(groups.map(({ label }) => label), ['Machine', 'Deck 4', 'Deck 7'])
    assert.deepEqual(groups[0]?.categories.map(({ label }) => label), ['Dryer', 'Repeat / Other'])
    assert.deepEqual(groups[1]?.categories.map(({ label }) => label), ['Ink / Viscosity', 'Pump / Wash'])
    assert.equal(groups.some(({ label }) => label === 'Deck 1'), false)
    assert.match(pageSource, /className="raw-change-scope"/)
    assert.match(pageSource, /className="raw-change-categories"/)
    assert.match(pageSource, /Remove plot/)
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
    assert.match(pageSource, /renderInspectionTooltip/)
    assert.match(apiSource, /raw-explorer\/identities/)
    assert.match(apiSource, /raw-explorer\/detail/)
    assert.match(apiSource, /raw-explorer\/plot/)
    assert.match(apiSource, /raw-explorer\/raw-plot/)
    assert.match(apiSource, /raw-explorer\/raw-review/)
    assert.doesNotMatch(pageSource, /operational group|process family|classified as|root cause|safety state/i)
  })

  it('organizes changed raw telemetry separately by discovery category and keeps ignored evidence recoverable', () => {
    const raw = (rawIdentity: string, discoveryCategory: string, reviewStatus: RawUnmappedChangedSignal['reviewStatus'], dataKind = 'numeric'): RawUnmappedChangedSignal => ({ rawIdentity, displayName: rawIdentity.split('.').at(-1)!, dataType: dataKind, dataKind, sourceUnit: null, discoveryCategory, plottable: dataKind !== 'container', usableObservationCount: 2, unavailableObservationCount: 0, firstValue: dataKind === 'container' ? [0] : 1, lastValue: dataKind === 'container' ? [1] : 2, minimum: dataKind === 'numeric' ? 1 : null, maximum: dataKind === 'numeric' ? 2 : null, changeCount: 1, largestAbsoluteStep: dataKind === 'numeric' ? 1 : null, positiveMovementPresent: dataKind === 'numeric', negativeMovementPresent: false, transitionSequence: dataKind === 'state' ? [0, 1, 0] : [], transitionSequenceTruncated: false, knownShape: dataKind === 'container' ? 'array[13]' : null, alternateRepresentationCount: 0, alternateRawIdentities: [], reviewStatus })
    const grouped = groupRawUnmappedSignals([raw('Press12.roll', 'Production / Roll', 'UNREVIEWED'), raw('Press12.state', 'State / Event', 'NEEDS_MAPPING', 'state'), raw('Press12.deck.print_on', 'Containers / Arrays', 'USEFUL', 'container'), raw('Press12.ignore', 'Other', 'IGNORE')])
    assert.deepEqual(grouped.categories.map(({ category }) => category), ['Production / Roll', 'State / Event', 'Containers / Arrays'])
    assert.deepEqual(grouped.ignored.map(({ rawIdentity }) => rawIdentity), ['Press12.ignore'])
    assert.match(pageSource, /CANONICAL TELEMETRY/)
    assert.match(pageSource, /RAW \/ UNMAPPED TELEMETRY/)
    assert.match(pageSource, /Container changed/)
    assert.match(pageSource, /Not yet expanded/)
    assert.match(pageSource, /Needs Mapping/)
    assert.match(pageSource, /raw-ignored/)
  })

  it('plots raw numeric and state observations on the shared timeline without synthetic timestamps', () => {
    const base: RawUnmappedHistory = { press: 'press12', displayName: 'Press 12', rawIdentity: 'Press12.unique', signalDisplayName: 'unique', dataType: 'numeric', dataKind: 'numeric', sourceUnit: null, plottable: true, fromUtc: occurrence.chartFromUtc, toUtc: occurrence.chartToUtc, historianReadCount: 1, alternateRepresentationCount: 0, alternateRawIdentities: [], reviewStatus: 'UNREVIEWED', observations: [] }
    const numeric: RawUnmappedHistory = { ...base, observations: [{ timestampUtc: '2026-08-13T11:40:00.000Z', receivedAtUtc: '2026-08-13T11:40:01.000Z', sourceTimestampUtc: '2026-08-13T11:40:00.000Z', qualityState: 'GOOD', dataType: 'numeric', rawValue: 14.8 }, { timestampUtc: '2026-08-13T12:05:00.000Z', receivedAtUtc: '2026-08-13T12:05:01.000Z', sourceTimestampUtc: '2026-08-13T12:05:00.000Z', qualityState: 'GOOD', dataType: 'numeric', rawValue: 24 }] }
    assert.deepEqual(rawUnmappedNumberSamples(numeric).map(({ observedAtUtc, value }) => ({ observedAtUtc, value })), [{ observedAtUtc: '2026-08-13T11:40:00.000Z', value: 14.8 }, { observedAtUtc: '2026-08-13T12:05:00.000Z', value: 24 }])
    const state: RawUnmappedHistory = { ...base, dataType: 'boolean', dataKind: 'boolean', observations: [{ timestampUtc: '2026-08-13T11:45:00.000Z', receivedAtUtc: '2026-08-13T11:45:00.000Z', sourceTimestampUtc: '2026-08-13T11:45:00.000Z', qualityState: 'GOOD', dataType: 'boolean', rawValue: false }, { timestampUtc: '2026-08-13T12:03:00.000Z', receivedAtUtc: '2026-08-13T12:03:00.000Z', sourceTimestampUtc: '2026-08-13T12:03:00.000Z', qualityState: 'GOOD', dataType: 'boolean', rawValue: true }] }
    assert.deepEqual(rawUnmappedStateIntervals(state, occurrence).map(({ startUtc, endUtc, label }) => ({ startUtc, endUtc, label })), [{ startUtc: '2026-08-13T11:45:00.000Z', endUtc: '2026-08-13T12:03:00.000Z', label: 'false' }, { startUtc: '2026-08-13T12:03:00.000Z', endUtc: occurrence.chartToUtc, label: 'true' }])
    assert.match(pageSource, /rawHistories=/)
    assert.match(pageSource, /RAW ·/)
    assert.match(pageSource, /Supporting observation:/)
    assert.match(pageSource, /connectObservedGaps: true/)
    assert.match(pageSource, /holdLastObservation: true/)
  })
})
