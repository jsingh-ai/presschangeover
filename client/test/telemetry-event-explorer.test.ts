import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { areaFromPathname, areaPath } from '../src/navigation'
import { adjacentPreviewOption, filterTelemetryEventOccurrences, reconstructPreviewStateTimeline, TelemetryEventExplorerPage, telemetryEventMarkers, type PreviewOption } from '../src/components/TelemetryEventExplorerPage'
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

  it('navigates the ordered compatible preview sources in both directions with wraparound', () => {
    const options: PreviewOption[] = [
      { pressKey: 'press3', deckNumber: null, label: 'Press 3' },
      { pressKey: 'press5', deckNumber: 1, label: 'Press 5 · Deck 1' },
      { pressKey: 'press5', deckNumber: 2, label: 'Press 5 · Deck 2' },
    ]
    assert.equal(adjacentPreviewOption(options, options[0], 1), options[1])
    assert.equal(adjacentPreviewOption(options, options[1], -1), options[0])
    assert.equal(adjacentPreviewOption(options, options.at(-1), 1), options[0])
    assert.equal(adjacentPreviewOption(options, options[0], -1), options.at(-1))
    assert.equal(adjacentPreviewOption([options[0]!], options[0], 1), options[0])
    assert.equal(adjacentPreviewOption([], undefined, 1), undefined)
    assert.match(pageSource, /aria-label="Previous preview source"/)
    assert.match(pageSource, /aria-label="Next preview source"/)
    assert.match(pageSource, /disabled=\{options\.length <= 1\}/)
    assert.match(styles, /telemetry-variable-preview__previous/)
  })

  it('filters occurrence results from the clickable press-count controls', () => {
    const occurrences = [{ pressKey: 'press5', occurrenceId: 'p5-1' }, { pressKey: 'press3', occurrenceId: 'p3-1' }, { pressKey: 'press5', occurrenceId: 'p5-2' }] as TelemetryEventOccurrence[]
    assert.deepEqual(filterTelemetryEventOccurrences(occurrences, 'press5').map(({ occurrenceId }) => occurrenceId), ['p5-1', 'p5-2'])
    assert.equal(filterTelemetryEventOccurrences(occurrences, 'all'), occurrences)
    assert.match(pageSource, /aria-label="Filter occurrences by press"/)
    assert.match(pageSource, /setResultPressFilter\(press\.pressKey\)/)
    assert.match(pageSource, /visibleOccurrences\.map/)
  })

  it('starts a genuinely new search instead of leaving prior results and investigation mounted', () => {
    assert.match(pageSource, /function searchAnotherCondition\(\)/)
    assert.match(pageSource, /setResult\(undefined\); setResultPressFilter\('all'\); setSelectedIndex\(-1\)/)
    assert.match(pageSource, /setSelectedCanonicalId\(undefined\); setSelectedRaw\(undefined\)/)
    assert.match(pageSource, /setPreviewOption\(undefined\); setPreview\(undefined\); setPreviewLoading\(false\)/)
    assert.match(pageSource, /setEventType\('threshold'\); setOperator\('>'\); setThreshold\('200'\)/)
    assert.match(pageSource, /onClick=\{searchAnotherCondition\}>Search another condition/)
  })

  it('applies a custom range explicitly and keeps its loading overlay tied to the current preview request', () => {
    assert.match(pageSource, /function applyCustomRange\(\)/)
    assert.match(pageSource, /setPreviewRefreshKey\(\(current\) => current \+ 1\)/)
    assert.match(pageSource, /previewRequestId\.current === requestId/)
    assert.match(pageSource, /fromUtc: range\.fromUtc, toUtc: range\.toUtc/)
    assert.doesNotMatch(pageSource, /toMs - 60 \* 60_000/)
    assert.match(pageSource, /Uses the complete active page time range/)
    assert.match(pageSource, /rangeMode === 'custom'/)
    assert.match(pageSource, /Applying time range/)
    assert.match(pageSource, /telemetry-find-occurrences/)
    assert.match(pageSource, /telemetry-occurrence-button/)
    assert.match(styles, /telemetry-event-range-overlay/)
    assert.match(styles, /telemetry-preview-source-control button\.telemetry-icon-button/)
    assert.match(styles, /telemetry-event-custom-range \.telemetry-apply-range/)
  })

  it('reconstructs repeated strings and booleans as proportional distinct-state intervals', () => {
    const at = (minute: number) => `2026-08-17T12:${String(minute).padStart(2, '0')}:00.000Z`
    const state = (minute: number, value: string | boolean) => ({ atUtc: at(minute), value, qualityState: 'GOOD' })
    const strings = reconstructPreviewStateTimeline({ fromUtc: at(0), toUtc: at(50), observations: [state(0, 'A'), state(5, 'A'), state(10, 'A'), state(20, 'B'), state(30, 'B'), state(40, 'A very long categorical value that only fits wide segments'), state(50, 'A very long categorical value that only fits wide segments')] })
    assert.deepEqual(strings.intervals.map(({ kind, value, startUtc, endUtc, durationSeconds }) => ({ kind, value, startUtc, endUtc, durationSeconds })), [
      { kind: 'state', value: 'A', startUtc: at(0), endUtc: at(20), durationSeconds: 1_200 },
      { kind: 'state', value: 'B', startUtc: at(20), endUtc: at(40), durationSeconds: 1_200 },
      { kind: 'state', value: 'A very long categorical value that only fits wide segments', startUtc: at(40), endUtc: at(50), durationSeconds: 600 },
    ])
    assert.equal(strings.currentValue, 'A very long categorical value that only fits wide segments')
    assert.equal(strings.previousValue, 'B')

    const unchanged = reconstructPreviewStateTimeline({ fromUtc: at(0), toUtc: at(10), observations: [state(0, 'A'), state(5, 'A'), state(10, 'A')] })
    assert.deepEqual(unchanged.intervals.map(({ kind, value }) => [kind, value]), [['state', 'A']])
    assert.equal(unchanged.previousValue, undefined)

    const booleans = reconstructPreviewStateTimeline({ fromUtc: at(0), toUtc: at(25), observations: [state(0, false), state(5, false), state(10, true), state(15, true), state(20, false), state(25, false)] })
    assert.deepEqual(booleans.intervals.map(({ value }) => value), [false, true, false])
    assert.equal(booleans.currentValue, false)
    assert.equal(booleans.previousValue, true)
  })

  it('marks meaningful historian gaps without bridging state and preserves narrow transitions', () => {
    const at = (minute: number) => `2026-08-17T12:${String(minute).padStart(2, '0')}:00.000Z`
    const result = reconstructPreviewStateTimeline({ fromUtc: at(0), toUtc: at(30), observations: [
      { atUtc: at(0), value: 'A', qualityState: 'GOOD' },
      { atUtc: at(1), value: 'A', qualityState: 'GOOD' },
      { atUtc: at(2), value: 'B', qualityState: 'GOOD' },
      { atUtc: at(3), value: 'B', qualityState: 'GOOD' },
      { atUtc: at(20), value: 'C', qualityState: 'GOOD' },
      { atUtc: at(21), value: 'C', qualityState: 'GOOD' },
      { atUtc: at(22), value: 'C', qualityState: 'GOOD' },
    ] })
    assert.deepEqual(result.intervals.map(({ kind, value, startUtc, endUtc }) => ({ kind, value, startUtc, endUtc })), [
      { kind: 'state', value: 'A', startUtc: at(0), endUtc: at(2) },
      { kind: 'state', value: 'B', startUtc: at(2), endUtc: at(3) },
      { kind: 'gap', value: undefined, startUtc: at(3), endUtc: at(20) },
      { kind: 'state', value: 'C', startUtc: at(20), endUtc: at(22) },
      { kind: 'gap', value: undefined, startUtc: at(22), endUtc: at(30) },
    ])
    assert.match(timelineSource, /width >= 4/)
    assert.match(pageSource, /State start/)
    assert.match(pageSource, /Source \$\{preview\.rawIdentity\}/)
  })

  it('keeps regularly recorded scalar values visible when historian quality is bad or invalid', () => {
    const result = reconstructPreviewStateTimeline({ fromUtc: '2026-08-17T00:00:00.000Z', toUtc: '2026-08-17T00:20:00.000Z', observations: [
      { atUtc: '2026-08-16T23:59:00.000Z', value: 'ORDER-1', qualityState: 'bad' },
      { atUtc: '2026-08-17T00:04:00.000Z', value: 'ORDER-1', qualityState: 'bad' },
      { atUtc: '2026-08-17T00:09:00.000Z', value: 'ORDER-1', qualityState: 'invalid' },
      { atUtc: '2026-08-17T00:14:00.000Z', value: 'ORDER-2', qualityState: 'bad' },
      { atUtc: '2026-08-17T00:19:00.000Z', value: 'ORDER-2', qualityState: 'good' },
    ] })
    assert.deepEqual(result.intervals.map(({ kind, value, startUtc, endUtc }) => ({ kind, value, startUtc, endUtc })), [
      { kind: 'state', value: 'ORDER-1', startUtc: '2026-08-17T00:00:00.000Z', endUtc: '2026-08-17T00:14:00.000Z' },
      { kind: 'state', value: 'ORDER-2', startUtc: '2026-08-17T00:14:00.000Z', endUtc: '2026-08-17T00:20:00.000Z' },
    ])
    assert.equal(result.currentValue, 'ORDER-2')
    assert.equal(result.previousValue, 'ORDER-1')
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
    assert.match(pageSource, /raw-fixed-pin">Actual Speed/)
    assert.match(pageSource, /raw-fixed-pin">Current Roll Length/)
    assert.match(pageSource, /isAlwaysPinnedCanonical/)
    assert.match(styles, /synchronized-timeline__inspection-tooltip[^}]*overflow: visible/)
    assert.match(styles, /raw-inspection-tooltip dl[^}]*overflow: visible/)
  })
})
