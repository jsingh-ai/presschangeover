import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { areaFromPathname, areaPath } from '../src/navigation'
import { TelemetryEventExplorerPage, telemetryEventMarkers } from '../src/components/TelemetryEventExplorerPage'
import type { TelemetryEventOccurrence } from '../src/types/api'

const pageSource = readFileSync(new URL('../src/components/TelemetryEventExplorerPage.tsx', import.meta.url), 'utf8')
const timelineSource = readFileSync(new URL('../src/components/SynchronizedTimeline.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')

const occurrence: TelemetryEventOccurrence = { occurrenceId: 'one', sourceKind: 'canonical', pressKey: 'press14', displayName: 'Press 14', deckNumber: 1, canonicalId: 'anilox.drive.temperature.actual', rawIdentity: 'Press14.Deck1.AniloxTemperature', signalDisplayName: 'Anilox Drive Temperature', sourceUnit: 'degC', canonicalUnitStatus: 'VERIFIED', valueKind: 'numeric', dataKind: 'numeric', pressOccurrenceIndex: 1, pressOccurrenceCount: 1, startUtc: '2026-08-17T10:01:00.000Z', endUtc: '2026-08-17T10:02:00.000Z', durationSeconds: 60, chartFromUtc: '2026-08-17T09:31:00.000Z', chartToUtc: '2026-08-17T10:32:00.000Z', eventType: 'threshold', clippedEnd: false, dataGap: false, entryValue: 204, returnValue: 199, extremeValue: 207, extremeAtUtc: '2026-08-17T10:01:30.000Z' }

describe('Telemetry Event Explorer UI', () => {
  it('adds the sibling route and renders an understandable condition-first setup', () => {
    assert.equal(areaFromPathname('/telemetry-event-explorer'), 'telemetry-event-explorer')
    assert.equal(areaPath('telemetry-event-explorer'), '/telemetry-event-explorer')
    const html = renderToStaticMarkup(createElement(TelemetryEventExplorerPage))
    assert.match(html, /Telemetry Event Explorer/)
    assert.match(html, /Choose a telemetry condition/)
    assert.match(pageSource, /All Compatible Presses/)
    assert.match(pageSource, /Any Deck/)
    assert.match(html, /Threshold/)
    assert.match(html, /Delta \/ Change/)
    assert.match(html, /Value Change/)
  })

  it('creates threshold and delta annotations at exact event timestamps', () => {
    assert.deepEqual(telemetryEventMarkers(occurrence).map(({ label, atUtc }) => ({ label, atUtc })), [{ label: 'Event start', atUtc: occurrence.startUtc }, { label: 'Extreme', atUtc: occurrence.extremeAtUtc }, { label: 'Return', atUtc: occurrence.endUtc }])
    const delta = { ...occurrence, eventType: 'delta' as const, baselineAtUtc: '2026-08-17T10:00:00.000Z', triggerAtUtc: occurrence.startUtc, maximumExcursionAtUtc: occurrence.extremeAtUtc }
    assert.deepEqual(telemetryEventMarkers(delta).map(({ label }) => label), ['Baseline', 'First trigger', 'Maximum excursion'])
    assert.match(timelineSource, /referenceLines/)
    assert.match(timelineSource, /numeric-marker/)
    const change = { ...occurrence, eventType: 'value_change' as const, dataKind: 'string' as const, previousValue: 'ABC', newValue: 'XYZ', transitionAtUtc: occurrence.startUtc }
    assert.deepEqual(telemetryEventMarkers(change).map(({ label, atUtc }) => ({ label, atUtc })), [{ label: 'ABC → XYZ', atUtc: occurrence.startUtc }])
  })

  it('previews numeric and state histories and searches the complete paged raw catalog', () => {
    assert.match(pageSource, /previewTelemetryEventVariable/)
    assert.match(pageSource, /Selected variable preview/)
    assert.match(pageSource, /Minimum/)
    assert.match(pageSource, /Maximum/)
    assert.match(pageSource, /Current:/)
    assert.match(pageSource, /Preview source/)
    assert.match(pageSource, /searchTelemetryEventRawCatalog/)
    assert.match(pageSource, /Search the full raw catalog/)
    assert.match(pageSource, /Load 50 more/)
    assert.match(pageSource, /250/)
    assert.match(pageSource, /No usable recent history/)
    assert.match(pageSource, /selectedDataKind === 'boolean'/)
  })

  it('reuses the synchronized Raw Radius investigation interactions and bounded split layout', () => {
    assert.match(pageSource, /RawExplorerInspectionTooltip/)
    assert.match(pageSource, /SynchronizedTimeline/)
    assert.match(pageSource, /Current Roll Length/)
    assert.match(pageSource, /Raw Radius/)
    assert.match(pageSource, /Actual Speed/)
    assert.match(pageSource, /PREVIEW/)
    assert.match(pageSource, /sessionStorage/)
    assert.match(pageSource, /Previous/)
    assert.match(pageSource, /Next/)
    assert.match(pageSource, /raw-investigation-workspace/)
    assert.match(styles, /grid-template-columns: minmax\(0, 2fr\) minmax\(20rem, 1fr\)/)
  })
})
