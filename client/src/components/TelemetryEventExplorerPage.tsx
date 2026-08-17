import React, { useEffect, useMemo, useRef, useState } from 'react'
import { getTelemetryEventCatalog, getTelemetryEventDetail, plotTelemetryEventRawSignal, plotTelemetryEventSignal, previewTelemetryEventVariable, searchTelemetryEventRawCatalog, searchTelemetryEvents } from '../api/process-intelligence-api'
import { createCustomRange, createPresetRange, defaultCustomValues, formatPlantDateTime, formatSelectedRange, RangeValidationError, type SelectedRange } from '../time-ranges'
import type { RadiusPressKey, RawExplorerChangedSignal, RawExplorerOccurrence, RawExplorerPlotResult, RawExplorerSignalHistory, RawUnmappedChangedSignal, RawUnmappedHistory, RawUnmappedPlotResult, TelemetryEventCatalog, TelemetryEventDetail, TelemetryEventOccurrence, TelemetryEventPreview, TelemetryEventRawCatalogItem, TelemetryEventRawCatalogResult, TelemetryEventRule, TelemetryEventScalar, TelemetryEventSearchInput, TelemetryEventSource } from '../types/api'
import type { TimedNumericSample } from '../types/evidence'
import { RawExplorerInspectionTooltip, rawExplorerNumberSamples, rawExplorerStateIntervals, rawUnmappedNumberSamples, rawUnmappedStateIntervals } from './RawRadiusExplorerPage'
import { SynchronizedTimeline, type TimelineEventTrack, type TimelineIntervalTrack, type TimelineNumericTrack } from './SynchronizedTimeline'
import { safeEngineeringSourceUnit } from './EngineeringTelemetryInspector'

type SourceTab = 'canonical' | 'raw'
type BrowserTab = 'all' | 'canonical' | 'raw'
type Pin = { kind: 'canonical'; key: string; signal: RawExplorerChangedSignal } | { kind: 'raw'; key: string; rawIdentity: string; label: string }
const PIN_STORAGE_KEY = 'process-intelligence-telemetry-event-pins'

function duration(seconds: number) {
  if (seconds < 60) return `${Math.round(seconds)}s`
  const hours = Math.floor(seconds / 3_600); const minutes = Math.round((seconds % 3_600) / 60)
  return `${hours ? `${hours}h ` : ''}${minutes}m`
}

function number(value: number | undefined | null) { return value === undefined || value === null ? '—' : new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value) }
function scalar(value: TelemetryEventScalar | undefined | null) { return value === undefined || value === null ? '—' : typeof value === 'number' ? number(value) : typeof value === 'boolean' ? value ? 'True' : 'False' : value || '(empty)' }
function canonicalKey(signal: { canonicalId: string; deckNumber: number | null }) { return `canonical:${signal.canonicalId}:${signal.deckNumber ?? ''}` }
function rawKey(rawIdentity: string) { return `raw:${rawIdentity}` }
function sourceUnit(sourceUnit: string | null) { const safe = safeEngineeringSourceUnit({ sourceUnit }); return safe ? `${safe} · unverified` : 'Unit unverified' }
function ruleLabel(rule: TelemetryEventRule) {
  if (rule.kind === 'threshold') return `${rule.operator} ${number(rule.threshold)}`
  if (rule.kind === 'delta') return `${rule.direction === 'either' ? 'Increase or decrease' : rule.direction === 'increase' ? 'Increase' : 'Decrease'} by ≥ ${number(rule.amount)} within ${rule.windowMinutes} minutes`
  if (rule.match === 'becomes') return `Becomes ${scalar(rule.becomesValue)}`
  if (rule.match === 'from_to') return `${scalar(rule.fromValue)} → ${scalar(rule.toValue)}`
  return 'Any value change'
}

export type PreviewOption = { pressKey: RadiusPressKey; deckNumber: number | null; label: string }

function ChevronIcon({ direction }: { direction: 'left' | 'right' }) {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d={direction === 'left' ? 'm12.5 4.5-5 5.5 5 5.5' : 'm7.5 4.5 5 5.5-5 5.5'} /></svg>
}

function SearchIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5" /><path d="m12.3 12.3 4 4" /></svg>
}

function ApplyRangeIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 6.5h12M6.5 3.5v3M13.5 3.5v3M4.5 6v10h11V6" /><path d="m7 11 2 2 4-4" /></svg>
}

export function adjacentPreviewOption(options: PreviewOption[], selectedOption: PreviewOption | undefined, direction: -1 | 1): PreviewOption | undefined {
  if (!options.length) return undefined
  const currentIndex = selectedOption ? options.findIndex((option) => option.pressKey === selectedOption.pressKey && option.deckNumber === selectedOption.deckNumber) : -1
  if (currentIndex < 0) return direction > 0 ? options[0] : options.at(-1)
  return options[(currentIndex + direction + options.length) % options.length]
}

const PREVIEW_MINIMUM_SIGNIFICANT_GAP_MS = 330_000

export interface PreviewStateInterval {
  kind: 'state' | 'gap'
  startUtc: string
  endUtc: string
  durationSeconds: number
  value?: TelemetryEventScalar
}

export interface PreviewStateTimeline {
  intervals: PreviewStateInterval[]
  distinctStates: TelemetryEventPreview['observations']
  currentValue?: TelemetryEventScalar
  previousValue?: TelemetryEventScalar
  significantGapMs: number
}

function samePreviewScalar(left: TelemetryEventScalar, right: TelemetryEventScalar) {
  return typeof left === typeof right && Object.is(left, right)
}

function usablePreviewObservation(observation: TelemetryEventPreview['observations'][number]) {
  if (!Number.isFinite(Date.parse(observation.atUtc)) || typeof observation.value === 'number' && !Number.isFinite(observation.value)) return false
  const quality = observation.qualityState?.toUpperCase() ?? ''
  return !['BAD', 'INVALID', 'UNAVAILABLE', 'NO_DATA', 'NODATA'].some((token) => quality.includes(token))
}

export function reconstructPreviewStateTimeline(preview: Pick<TelemetryEventPreview, 'fromUtc' | 'toUtc' | 'observations'>): PreviewStateTimeline {
  const fromMs = Date.parse(preview.fromUtc); const toMs = Date.parse(preview.toUtc)
  const byTimestamp = new Map<number, TelemetryEventPreview['observations'][number]>()
  for (const observation of preview.observations.filter(usablePreviewObservation).sort((left, right) => Date.parse(left.atUtc) - Date.parse(right.atUtc))) {
    const at = Date.parse(observation.atUtc)
    if (at <= toMs) byTimestamp.set(at, { ...observation, atUtc: new Date(at).toISOString() })
  }
  const ordered = [...byTimestamp.values()]
  const seed = ordered.filter(({ atUtc }) => Date.parse(atUtc) < fromMs).at(-1)
  const inRange = ordered.filter(({ atUtc }) => Date.parse(atUtc) >= fromMs && Date.parse(atUtc) <= toMs)
  const cadence = [...(seed ? [seed] : []), ...inRange]
  const gaps = cadence.slice(1).map((observation, index) => Date.parse(observation.atUtc) - Date.parse(cadence[index]!.atUtc)).filter((gap) => gap > 0).sort((left, right) => left - right)
  const median = gaps.length ? gaps[Math.floor((gaps.length - 1) / 2)]! : 0
  const significantGapMs = Math.max(PREVIEW_MINIMUM_SIGNIFICANT_GAP_MS, median * 5)
  const distinctStates: TelemetryEventPreview['observations'] = []
  for (const observation of cadence) if (!distinctStates.length || !samePreviewScalar(distinctStates.at(-1)!.value, observation.value)) distinctStates.push(observation)

  const intervals: PreviewStateInterval[] = []
  const addInterval = (kind: PreviewStateInterval['kind'], start: number, end: number, value?: TelemetryEventScalar) => {
    const boundedStart = Math.max(fromMs, start); const boundedEnd = Math.min(toMs, end)
    if (boundedEnd > boundedStart) intervals.push({ kind, startUtc: new Date(boundedStart).toISOString(), endUtc: new Date(boundedEnd).toISOString(), durationSeconds: (boundedEnd - boundedStart) / 1_000, ...(kind === 'state' ? { value } : {}) })
  }

  let activeValue = seed?.value
  let activeStart = seed ? fromMs : undefined
  let previousAt = seed ? Date.parse(seed.atUtc) : undefined
  for (const observation of inRange) {
    const at = Date.parse(observation.atUtc)
    if (activeValue === undefined || activeStart === undefined || previousAt === undefined) {
      addInterval('gap', fromMs, at)
      activeValue = observation.value; activeStart = at; previousAt = at
      continue
    }
    const hasGap = at - previousAt > significantGapMs
    if (hasGap) {
      addInterval('state', activeStart, previousAt, activeValue)
      addInterval('gap', previousAt, at)
      activeValue = observation.value; activeStart = at
    } else if (!samePreviewScalar(activeValue, observation.value)) {
      addInterval('state', activeStart, at, activeValue)
      activeValue = observation.value; activeStart = at
    }
    previousAt = at
  }
  if (activeValue !== undefined && activeStart !== undefined && previousAt !== undefined) {
    if (toMs - previousAt > significantGapMs) {
      addInterval('state', activeStart, previousAt, activeValue)
      addInterval('gap', previousAt, toMs)
    } else addInterval('state', activeStart, toMs, activeValue)
  } else addInterval('gap', fromMs, toMs)

  return { intervals, distinctStates, currentValue: distinctStates.at(-1)?.value, previousValue: distinctStates.at(-2)?.value, significantGapMs }
}

function previewStateTone(value: TelemetryEventScalar) {
  let hash = 0
  for (const character of String(value)) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0
  return Math.abs(hash) % 3
}

function previewIntervals(preview: TelemetryEventPreview, timeline: PreviewStateTimeline) {
  const source = `${preview.displayName}${preview.deckNumber ? ` · Deck ${preview.deckNumber}` : ''}`
  return timeline.intervals.map((interval, index) => {
    const time = `${formatPlantDateTime(interval.startUtc)}–${formatPlantDateTime(interval.endUtc)} CT`
    const details = interval.kind === 'gap'
      ? `${preview.signalDisplayName}\nData unavailable\n${time}\nDuration ${duration(interval.durationSeconds)}\n${source}\nSource ${preview.rawIdentity}`
      : `${preview.signalDisplayName}\nValue ${scalar(interval.value)}\nState start ${formatPlantDateTime(interval.startUtc)} CT\nState end ${formatPlantDateTime(interval.endUtc)} CT\nDuration ${duration(interval.durationSeconds)}\n${source}\nSource ${preview.rawIdentity}`
    return { id: `preview:${interval.kind}:${interval.startUtc}:${index}`, startUtc: interval.startUtc, endUtc: interval.endUtc, label: interval.kind === 'gap' ? 'Data gap' : scalar(interval.value), details, unavailable: interval.kind === 'gap', className: interval.kind === 'state' ? `telemetry-variable-preview__state telemetry-variable-preview__state--${previewStateTone(interval.value!)}` : 'telemetry-variable-preview__gap' }
  })
}

function PreviewStateInspectionTooltip({ preview, timeline, atUtc }: { preview: TelemetryEventPreview; timeline: PreviewStateTimeline; atUtc: string }) {
  const at = Date.parse(atUtc)
  const interval = timeline.intervals.find(({ startUtc, endUtc }, index) => Date.parse(startUtc) <= at && (Date.parse(endUtc) > at || index === timeline.intervals.length - 1 && Date.parse(endUtc) === at))
  return <div className="raw-inspection-tooltip">
    <header><span>Selected variable</span><strong>{preview.signalDisplayName}</strong></header>
    <dl>
      <div><dt>Value</dt><dd>{interval?.kind === 'state' ? scalar(interval.value) : 'Data unavailable'}</dd></div>
      <div><dt>State start</dt><dd>{interval ? `${formatPlantDateTime(interval.startUtc)} CT` : 'Unavailable'}</dd></div>
      <div><dt>State end</dt><dd>{interval ? `${formatPlantDateTime(interval.endUtc)} CT` : 'Unavailable'}</dd></div>
      <div><dt>Duration</dt><dd>{interval ? duration(interval.durationSeconds) : 'Unavailable'}</dd></div>
      <div><dt>Source</dt><dd>{preview.displayName}{preview.deckNumber ? ` · Deck ${preview.deckNumber}` : ''}<small>{preview.rawIdentity}</small></dd></div>
    </dl>
  </div>
}

function VariablePreview({ preview, loading, error, options, selectedOption, onOptionChange }: { preview?: TelemetryEventPreview; loading: boolean; error?: string; options: PreviewOption[]; selectedOption?: PreviewOption; onOptionChange: (option: PreviewOption) => void }) {
  if (!options.length) return <section className="telemetry-variable-preview"><strong>Variable preview</strong><p>Choose a variable with a compatible source to inspect its recent values.</p></section>
  const numericSamples: TimedNumericSample[] = preview?.observations.flatMap((observation) => typeof observation.value === 'number' && Number.isFinite(observation.value) ? [{ observedAtUtc: observation.atUtc, receivedAtUtc: observation.atUtc, sourceTimestampUtc: observation.atUtc, qualityState: observation.qualityState ?? 'Good', valueKind: Number.isInteger(observation.value) ? 'integer' : 'numeric', value: observation.value }] : []) ?? []
  const numericValues = numericSamples.map(({ value }) => value)
  const recent = preview ? [...preview.observations].sort((left, right) => Date.parse(right.atUtc) - Date.parse(left.atUtc)).slice(0, 5) : []
  const stateTimeline = preview && preview.dataKind !== 'numeric' ? reconstructPreviewStateTimeline(preview) : undefined
  const recentStates = stateTimeline ? [...stateTimeline.distinctStates].reverse().slice(0, 5) : []
  const latest = preview?.dataKind === 'numeric' ? recent[0] : recentStates[0]
  return <section className="telemetry-variable-preview" aria-live="polite">
    <header><div><span className="eyebrow">Selected variable preview</span><strong>{preview?.signalDisplayName ?? 'Loading selected time range…'}</strong><small className="telemetry-variable-preview__range">{preview ? `${formatPlantDateTime(preview.fromUtc)}–${formatPlantDateTime(preview.toUtc)} CT` : 'Uses the complete active page time range'}</small></div><div className="telemetry-preview-source-control"><button type="button" className="secondary-action telemetry-icon-button" aria-label="Previous preview source" title="Previous preview source" disabled={options.length <= 1} onClick={() => { const next = adjacentPreviewOption(options, selectedOption, -1); if (next) onOptionChange(next) }}><ChevronIcon direction="left" /></button><label>Preview source<select value={selectedOption ? `${selectedOption.pressKey}:${selectedOption.deckNumber ?? ''}` : ''} onChange={(event) => { const next = options.find((option) => `${option.pressKey}:${option.deckNumber ?? ''}` === event.target.value); if (next) onOptionChange(next) }}>{options.map((option) => <option key={`${option.pressKey}:${option.deckNumber ?? ''}`} value={`${option.pressKey}:${option.deckNumber ?? ''}`}>{option.label}</option>)}</select></label><button type="button" className="secondary-action telemetry-icon-button" aria-label="Next preview source" title="Next preview source" disabled={options.length <= 1} onClick={() => { const next = adjacentPreviewOption(options, selectedOption, 1); if (next) onOptionChange(next) }}><ChevronIcon direction="right" /></button></div></header>
    {loading && <p>Loading the selected time range preview…</p>}
    {error && <p role="alert">{error}</p>}
    {preview && <><div className="telemetry-variable-preview__identity"><span>{preview.displayName}{preview.deckNumber ? ` · Deck ${preview.deckNumber}` : ''}</span><span>{preview.dataType}{preview.sourceUnit ? ` · ${preview.sourceUnit}` : ''}</span><small title={preview.rawIdentity}>{preview.rawIdentity}</small></div>{!preview.observations.length ? <p>No usable recent history was returned for this source. You can still choose another compatible source.</p> : preview.dataKind === 'numeric' ? <><SynchronizedTimeline fromUtc={preview.fromUtc} toUtc={preview.toUtc} intervalTracks={[]} numericTracks={[{ id: 'variable-preview', label: preview.signalDisplayName, unit: preview.sourceUnit, samples: numericSamples, interpolation: 'step', connectObservedGaps: true, holdLastObservation: true }]} minimumCanvasWidth={420} ariaLabel={`${preview.signalDisplayName} recent preview`} /><div className="telemetry-variable-preview__summary"><span>Latest <strong>{scalar(latest?.value)}</strong></span><span>Minimum <strong>{numericValues.length ? number(Math.min(...numericValues)) : '—'}</strong></span><span>Maximum <strong>{numericValues.length ? number(Math.max(...numericValues)) : '—'}</strong></span><span>{latest ? `${formatPlantDateTime(latest.atUtc)} CT` : 'No timestamp'}</span></div></> : <><SynchronizedTimeline fromUtc={preview.fromUtc} toUtc={preview.toUtc} intervalTracks={[{ id: 'variable-preview-state', label: preview.signalDisplayName, intervals: previewIntervals(preview, stateTimeline!) }]} renderInspectionTooltip={(atUtc) => <PreviewStateInspectionTooltip preview={preview} timeline={stateTimeline!} atUtc={atUtc} />} minimumCanvasWidth={420} ariaLabel={`${preview.signalDisplayName} recent state preview`} /><div className="telemetry-variable-preview__changes"><strong>Current: {scalar(stateTimeline?.currentValue)}</strong><span className="telemetry-variable-preview__previous">Previous: {scalar(stateTimeline?.previousValue)}</span>{recentStates.slice(1).map((item, index) => <span key={`${item.atUtc}:${index}`}>{scalar(item.value)} → {scalar(recentStates[index]?.value)} · {formatPlantDateTime(recentStates[index]!.atUtc)} CT</span>)}</div></>}</>}
  </section>
}

export function telemetryEventMarkers(occurrence: TelemetryEventOccurrence): NonNullable<TimelineNumericTrack['markers']> {
  if (occurrence.eventType === 'threshold') return [
    { atUtc: occurrence.startUtc, label: 'Event start', kind: 'start' },
    ...(occurrence.extremeAtUtc ? [{ atUtc: occurrence.extremeAtUtc, label: 'Extreme', kind: 'extreme' as const }] : []),
    ...(!occurrence.clippedEnd ? [{ atUtc: occurrence.endUtc, label: 'Return', kind: 'end' as const }] : []),
  ]
  if (occurrence.eventType === 'value_change') return [{ atUtc: occurrence.transitionAtUtc ?? occurrence.startUtc, label: `${scalar(occurrence.previousValue)} → ${scalar(occurrence.newValue)}`, kind: 'trigger' }]
  return [
    ...(occurrence.baselineAtUtc ? [{ atUtc: occurrence.baselineAtUtc, label: 'Baseline', kind: 'baseline' as const }] : []),
    ...(occurrence.triggerAtUtc ? [{ atUtc: occurrence.triggerAtUtc, label: 'First trigger', kind: 'trigger' as const }] : []),
    ...(occurrence.maximumExcursionAtUtc ? [{ atUtc: occurrence.maximumExcursionAtUtc, label: 'Maximum excursion', kind: 'extreme' as const }] : []),
  ]
}

function radiusHue(value: string) { let hash = 0; for (const character of value) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0; return `hsl(${Math.abs(hash) % 360} 58% 46%)` }

function EventInvestigation({ occurrence, rule, pins, onPinsChange, sidebarOpen, onSidebarOpenChange }: { occurrence: TelemetryEventOccurrence; rule: TelemetryEventRule; pins: Pin[]; onPinsChange: (pins: Pin[]) => void; sidebarOpen: boolean; onSidebarOpenChange: (open: boolean) => void }) {
  const [detail, setDetail] = useState<TelemetryEventDetail>()
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(true)
  const [browserTab, setBrowserTab] = useState<BrowserTab>('all')
  const [search, setSearch] = useState('')
  const [preview, setPreview] = useState<Pin>()
  const [plotting, setPlotting] = useState(new Set<string>())
  const canonicalCache = useRef(new Map<string, RawExplorerPlotResult>())
  const rawCache = useRef(new Map<string, RawUnmappedPlotResult>())
  const sidebarRef = useRef<HTMLElement>(null); const scrollTop = useRef(0)

  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError(undefined); setDetail(undefined)
    void getTelemetryEventDetail(occurrence, controller.signal).then(setDetail).catch((caught) => { if ((caught as Error).name !== 'AbortError') setError('This telemetry occurrence could not load its synchronized evidence.') }).finally(() => setLoading(false))
    return () => controller.abort()
  }, [occurrence])

  async function loadPin(pin: Pin) {
    if (pin.kind === 'canonical') {
      if (canonicalCache.current.has(pin.key)) return true
      try { canonicalCache.current.set(pin.key, await plotTelemetryEventSignal(occurrence, pin.signal)); return true } catch { return false }
    }
    if (rawCache.current.has(pin.key)) return true
    try { rawCache.current.set(pin.key, await plotTelemetryEventRawSignal(occurrence, pin.rawIdentity)); return true } catch { return false }
  }

  useEffect(() => { if (!detail) return; for (const pin of pins) void loadPin(pin) }, [detail])

  async function inspect(pin: Pin) {
    setPlotting((current) => new Set(current).add(pin.key))
    const loaded = await loadPin(pin)
    setPlotting((current) => { const next = new Set(current); next.delete(pin.key); return next })
    if (loaded) setPreview(pin)
  }

  async function toggle(pin: Pin) {
    if (pins.some(({ key }) => key === pin.key)) { onPinsChange(pins.filter(({ key }) => key !== pin.key)); return }
    setPlotting((current) => new Set(current).add(pin.key)); const loaded = await loadPin(pin); setPlotting((current) => { const next = new Set(current); next.delete(pin.key); return next })
    if (loaded) onPinsChange([...pins, pin])
  }

  if (loading) return <section className="panel event-investigation-loading" role="status">Loading synchronized telemetry and Radius context…</section>
  if (error || !detail) return <section className="panel scope-progress scope-progress--error" role="alert">{error ?? 'Evidence is unavailable.'}</section>

  const canonicalSignals = detail.context.changedSignals
  const rawSignals = detail.context.rawTelemetry.signals
  const allRows: Array<{ pin: Pin; label: string; search: string }> = [
    ...canonicalSignals.map((signal) => ({ pin: { kind: 'canonical' as const, key: canonicalKey(signal), signal }, label: `${signal.deckNumber === null ? 'Machine' : `Deck ${signal.deckNumber}`} · ${signal.friendlyName}`, search: `${signal.friendlyName} ${signal.canonicalId} ${signal.category} ${signal.deckNumber ?? 'machine'}` })),
    ...rawSignals.filter(({ reviewStatus }) => reviewStatus !== 'IGNORE').map((signal) => ({ pin: { kind: 'raw' as const, key: rawKey(signal.rawIdentity), rawIdentity: signal.rawIdentity, label: `RAW · ${signal.displayName}` }, label: `RAW · ${signal.displayName}`, search: `${signal.displayName} ${signal.rawIdentity} ${signal.discoveryCategory}` })),
  ]
  const query = search.trim().toLowerCase()
  const rows = allRows.filter(({ pin, search: text }) => (browserTab === 'all' || pin.kind === browserTab) && (!query || text.toLowerCase().includes(query)))
  const active = [...pins, ...(preview && !pins.some(({ key }) => key === preview.key) ? [preview] : [])]
  const extraCanonical = active.flatMap((pin) => pin.kind === 'canonical' ? canonicalCache.current.get(pin.key)?.signal ?? [] : [])
  const extraRaw = active.flatMap((pin) => pin.kind === 'raw' ? rawCache.current.get(pin.key)?.signal ?? [] : [])

  const primaryIsState = occurrence.eventType === 'value_change' && occurrence.dataKind !== 'numeric'
  const primaryCanonical: RawExplorerSignalHistory | undefined = detail.primary.kind === 'canonical' ? { ...detail.primary.signal, friendlyName: occurrence.signalDisplayName, signalType: primaryIsState ? 'state_event' : 'continuous', category: canonicalSignals.find(({ canonicalId }) => canonicalId === occurrence.canonicalId)?.category ?? 'repeat_other', scope: occurrence.deckNumber === null ? 'machine' : 'deck' } : undefined
  const primaryRaw: RawUnmappedHistory | undefined = detail.primary.kind === 'raw' ? { ...detail.primary.signal, reviewStatus: 'UNREVIEWED' } : undefined
  const primarySamples: TimedNumericSample[] = primaryCanonical ? rawExplorerNumberSamples(primaryCanonical) : primaryRaw ? rawUnmappedNumberSamples(primaryRaw) : []
  const eventTrack: TimelineNumericTrack = { id: 'telemetry-event-primary', label: `${occurrence.deckNumber ? `Deck ${occurrence.deckNumber} · ` : ''}${occurrence.signalDisplayName}`, unit: sourceUnit(occurrence.sourceUnit), samples: primarySamples, interpolation: 'linear', referenceLines: rule.kind === 'threshold' ? [{ value: rule.threshold, label: `Threshold ${rule.operator} ${number(rule.threshold)}` }] : [], markers: telemetryEventMarkers(occurrence), unavailableLabel: 'No valid numeric samples in this event context' }
  const rollSamples = detail.context.currentRollLength ? rawExplorerNumberSamples(detail.context.currentRollLength) : []
  const speedSamples = detail.context.speed.samples.flatMap((sample): TimedNumericSample[] => typeof sample.value === 'number' ? [{ ...sample, value: sample.value, valueKind: Number.isInteger(sample.value) ? 'integer' : 'numeric' }] : [])
  const radiusTrack: TimelineIntervalTrack = { id: 'event-radius', label: 'Raw Radius', intervals: detail.context.radiusSegments.map((segment) => ({ id: `${segment.pressKey}:${segment.startUtc}`, startUtc: segment.startUtc, endUtc: segment.endUtc, label: segment.kind === 'radius' ? `${segment.eventType} / ${segment.statusCode ?? '—'}` : 'Unavailable', details: segment.kind === 'radius' ? `${segment.eventType} / ${segment.statusCode ?? '—'} · ${segment.statusDescription}` : 'Radius unavailable', unavailable: segment.kind === 'offline', style: segment.kind === 'radius' ? { background: radiusHue(`${segment.eventType}|${segment.statusCode}|${segment.statusDescription}`) } : undefined })) }
  const eventAsRaw = { ...occurrence, eventType: 'TELEMETRY', statusCode: occurrence.eventType, statusDescription: occurrence.signalDisplayName } as RawExplorerOccurrence
  const primaryCanonicalKey = occurrence.canonicalId ? canonicalKey({ canonicalId: occurrence.canonicalId, deckNumber: occurrence.deckNumber }) : undefined
  const primaryStateTrack: TimelineIntervalTrack | undefined = primaryIsState ? { id: 'telemetry-event-primary-state', label: `${occurrence.deckNumber ? `Deck ${occurrence.deckNumber} · ` : ''}${occurrence.signalDisplayName}`, intervals: primaryCanonical ? rawExplorerStateIntervals(primaryCanonical, eventAsRaw) : primaryRaw ? rawUnmappedStateIntervals(primaryRaw, eventAsRaw) : [], unavailableLabel: 'No usable state history in this event context' } : undefined
  const intervalTracks: TimelineIntervalTrack[] = [...(primaryStateTrack ? [primaryStateTrack] : []), radiusTrack, ...extraCanonical.filter((history) => history.signalType === 'state_event' && canonicalKey(history) !== primaryCanonicalKey).map((history) => ({ id: canonicalKey(history), label: `${history.deckNumber ? `Deck ${history.deckNumber} · ` : ''}${history.friendlyName}`, intervals: rawExplorerStateIntervals(history, eventAsRaw) })), ...extraRaw.filter((history) => history.dataKind !== 'numeric' && historyRawIdentityNotPrimary(occurrence, history)).map((history) => ({ id: rawKey(history.rawIdentity), label: `RAW · ${history.signalDisplayName}`, intervals: rawUnmappedStateIntervals(history, eventAsRaw) }))]
  const eventTracks: TimelineEventTrack[] = primaryIsState ? [{ id: 'telemetry-event-transition', label: 'Detected transition', events: [{ id: occurrence.occurrenceId, atUtc: occurrence.transitionAtUtc ?? occurrence.startUtc, label: `${scalar(occurrence.previousValue)} → ${scalar(occurrence.newValue)}`, category: 'value-change', detail: 'Exact telemetry value transition' }] }] : []
  const numericTracks: TimelineNumericTrack[] = [...(primaryIsState ? [] : [eventTrack]), { id: 'event-roll', label: 'Current Roll Length', unit: 'Unit unverified', samples: rollSamples, interpolation: 'step', connectObservedGaps: true, holdLastObservation: true, unavailableLabel: 'Current Roll Length unavailable' }, { id: 'event-speed', label: 'Actual Speed', unit: sourceUnit(detail.context.speed.sourceUnit), samples: speedSamples, interpolation: 'step', connectObservedGaps: true, holdLastObservation: true }, ...extraCanonical.filter((history) => history.signalType !== 'state_event' && canonicalKey(history) !== primaryCanonicalKey).map((history) => ({ id: canonicalKey(history), label: `${preview?.key === canonicalKey(history) ? 'PREVIEW · ' : ''}${history.deckNumber ? `Deck ${history.deckNumber} · ` : ''}${history.friendlyName}`, unit: sourceUnit(history.sourceUnit), samples: rawExplorerNumberSamples(history), interpolation: 'step' as const, connectObservedGaps: true, holdLastObservation: true })), ...extraRaw.filter((history) => history.dataKind === 'numeric' && historyRawIdentityNotPrimary(occurrence, history)).map((history) => ({ id: rawKey(history.rawIdentity), label: `${preview?.key === rawKey(history.rawIdentity) ? 'PREVIEW · ' : ''}RAW · ${history.signalDisplayName}`, unit: sourceUnit(history.sourceUnit), samples: rawUnmappedNumberSamples(history), interpolation: 'step' as const, connectObservedGaps: true, holdLastObservation: true }))]
  const tooltipCanonical = [...(primaryCanonical ? [primaryCanonical] : []), ...extraCanonical.filter((item) => canonicalKey(item) !== (primaryCanonical ? canonicalKey(primaryCanonical) : ''))]
  const tooltipRaw = [...(primaryRaw ? [primaryRaw] : []), ...extraRaw.filter((item) => item.rawIdentity !== primaryRaw?.rawIdentity)]
  return <section className="panel telemetry-event-investigation">
    <header className="event-investigation-header"><div><span className="eyebrow">Selected occurrence</span><h2>{occurrence.displayName}{occurrence.deckNumber ? ` · Deck ${occurrence.deckNumber}` : ''}</h2><p>{occurrence.signalDisplayName} · {ruleLabel(rule)}</p></div><div><strong>{duration(occurrence.durationSeconds)}</strong><small>{formatPlantDateTime(occurrence.startUtc)} CT</small></div></header>
    <div className={`raw-investigation-workspace${sidebarOpen ? '' : ' is-sidebar-collapsed'}`}>
      <section className="raw-chart-workspace"><div className="raw-chart-workspace__sticky">
        <div className="raw-pinned-strip"><strong>Pinned</strong>{!pins.length && <span>Pin signals to keep them while moving between occurrences.</span>}{pins.map((pin) => <button type="button" key={pin.key} onClick={() => void toggle(pin)}>{pin.kind === 'canonical' ? `${pin.signal.deckNumber ? `Deck ${pin.signal.deckNumber} · ` : ''}${pin.signal.friendlyName}` : pin.label}<span>×</span></button>)}</div>
        <div className="event-rule-banner"><strong>{ruleLabel(rule)}</strong><span>{occurrence.eventType === 'threshold' ? `Entry ${number(occurrence.entryValue)} · Extreme ${number(occurrence.extremeValue)}${occurrence.clippedEnd ? ' · active/clipped at range edge' : ` · Return ${number(occurrence.returnValue)}`}` : occurrence.eventType === 'delta' ? `Baseline ${number(occurrence.baselineValue)} · Trigger ${number(occurrence.triggerValue)} · Actual delta ${number(occurrence.actualDelta)} in ${duration(occurrence.elapsedSeconds ?? 0)}` : `${scalar(occurrence.previousValue)} → ${scalar(occurrence.newValue)} at ${formatPlantDateTime(occurrence.transitionAtUtc ?? occurrence.startUtc)} CT`}</span>{occurrence.dataGap && <b>Telemetry gap bounded this occurrence</b>}</div>
        <SynchronizedTimeline fromUtc={occurrence.chartFromUtc} toUtc={occurrence.chartToUtc} intervalTracks={intervalTracks} numericTracks={numericTracks} eventTracks={eventTracks} trackOrder={[primaryIsState ? 'interval:telemetry-event-primary-state' : 'numeric:telemetry-event-primary', 'event:telemetry-event-transition', 'numeric:event-roll', 'interval:event-radius', 'numeric:event-speed']} highlightedRange={occurrence.eventType === 'value_change' ? undefined : { fromUtc: occurrence.startUtc, toUtc: occurrence.endUtc, label: 'Detected telemetry event interval' }} renderInspectionTooltip={(atUtc) => <RawExplorerInspectionTooltip atUtc={atUtc} detail={detail.context} histories={tooltipCanonical} rawHistories={tooltipRaw} />} ariaLabel={`${occurrence.displayName} telemetry event, Radius, roll length, speed, and investigation signals`} />
      </div></section>
      <aside ref={sidebarRef} className="raw-telemetry-browser" aria-hidden={!sidebarOpen} onScroll={(event) => { scrollTop.current = event.currentTarget.scrollTop }}>
        <div className="raw-telemetry-browser__toolbar"><div><span className="eyebrow">Telemetry browser</span><strong>{rows.length} of {allRows.length} signals</strong><small>Changed before this event; history loads only when previewed or pinned.</small></div><button type="button" className="secondary-action" onClick={() => { scrollTop.current = sidebarRef.current?.scrollTop ?? 0; onSidebarOpenChange(false) }}>Hide</button><div className="raw-browser-tabs" role="tablist">{(['all', 'canonical', 'raw'] as const).map((tab) => <button type="button" role="tab" aria-selected={browserTab === tab} key={tab} onClick={() => setBrowserTab(tab)}>{tab[0]!.toUpperCase() + tab.slice(1)} <span>{tab === 'all' ? allRows.length : allRows.filter(({ pin }) => pin.kind === tab).length}</span></button>)}</div><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search signal, category, deck, or raw ID" /></div>
        <div className="telemetry-event-browser-rows">{rows.map(({ pin, label }) => { const pinned = pins.some(({ key }) => key === pin.key); return <article key={pin.key} className={preview?.key === pin.key ? 'is-previewed' : ''} onClick={() => void inspect(pin)}><div><strong>{label}</strong><small>{pin.kind === 'canonical' ? pin.signal.canonicalId : pin.rawIdentity}</small></div><footer><button type="button" className="secondary-action" disabled={plotting.has(pin.key)} onClick={(event) => { event.stopPropagation(); void inspect(pin) }}>{plotting.has(pin.key) ? 'Loading…' : 'Preview'}</button><button type="button" className={pinned ? 'is-active' : ''} onClick={(event) => { event.stopPropagation(); void toggle(pin) }}>{pinned ? 'Unpin' : 'Pin'}</button></footer></article> })}{!rows.length && <p className="raw-empty">No signals match this tab and search.</p>}</div>
      </aside>
      {!sidebarOpen && <button type="button" className="raw-telemetry-reopen" onClick={() => { onSidebarOpenChange(true); requestAnimationFrame(() => { if (sidebarRef.current) sidebarRef.current.scrollTop = scrollTop.current }) }}>‹ Telemetry <span>{allRows.length}</span></button>}
    </div>
  </section>
}

function historyRawIdentityNotPrimary(occurrence: TelemetryEventOccurrence, history: { rawIdentity: string }) { return occurrence.sourceKind !== 'raw' || occurrence.rawIdentity !== history.rawIdentity }

export function TelemetryEventExplorerPage() {
  const [range, setRange] = useState<SelectedRange>(() => createPresetRange('last24'))
  const [rangeMode, setRangeMode] = useState<'last24' | 'custom'>('last24')
  const customDefaults = useMemo(defaultCustomValues, [])
  const [customFrom, setCustomFrom] = useState(customDefaults.from); const [customTo, setCustomTo] = useState(customDefaults.to)
  const [catalog, setCatalog] = useState<TelemetryEventCatalog>({ canonicalVariables: [] })
  const [catalogLoading, setCatalogLoading] = useState(true); const [catalogError, setCatalogError] = useState<string>()
  const [sourceTab, setSourceTab] = useState<SourceTab>('canonical'); const [variableSearch, setVariableSearch] = useState('')
  const [selectedCanonicalId, setSelectedCanonicalId] = useState<string>(); const [rawPressKey, setRawPressKey] = useState<RadiusPressKey>('press3'); const [selectedRaw, setSelectedRaw] = useState<TelemetryEventRawCatalogItem>()
  const [rawCatalog, setRawCatalog] = useState<TelemetryEventRawCatalogResult>(); const [rawCatalogLoading, setRawCatalogLoading] = useState(false); const [rawCatalogError, setRawCatalogError] = useState<string>(); const [rawPage, setRawPage] = useState(0)
  const [pressKey, setPressKey] = useState<TelemetryEventSearchInput['pressKey']>('all'); const [deckNumber, setDeckNumber] = useState<TelemetryEventSearchInput['deckNumber']>('any')
  const [eventType, setEventType] = useState<'threshold' | 'delta' | 'value_change'>('threshold'); const [operator, setOperator] = useState<'>' | '>=' | '<' | '<='>('>'); const [threshold, setThreshold] = useState('200')
  const [direction, setDirection] = useState<'increase' | 'decrease' | 'either'>('increase'); const [amount, setAmount] = useState('5'); const [windowMinutes, setWindowMinutes] = useState('10'); const [contextMinutes, setContextMinutes] = useState('30')
  const [valueMatch, setValueMatch] = useState<'any' | 'becomes' | 'from_to'>('any'); const [becomesValue, setBecomesValue] = useState(''); const [fromValue, setFromValue] = useState(''); const [toValue, setToValue] = useState('')
  const [previewOption, setPreviewOption] = useState<PreviewOption>(); const [preview, setPreview] = useState<TelemetryEventPreview>(); const [previewLoading, setPreviewLoading] = useState(false); const [previewError, setPreviewError] = useState<string>()
  const [previewRefreshKey, setPreviewRefreshKey] = useState(0); const [rangeApplyPending, setRangeApplyPending] = useState(false); const previewRequestId = useRef(0)
  const [result, setResult] = useState<Awaited<ReturnType<typeof searchTelemetryEvents>>>(); const [selectedIndex, setSelectedIndex] = useState(-1); const [loading, setLoading] = useState(false); const [error, setError] = useState<string>(); const [setupCollapsed, setSetupCollapsed] = useState(false); const [sidebarOpen, setSidebarOpen] = useState(true)
  const [pins, setPins] = useState<Pin[]>(() => { try { return typeof sessionStorage === 'undefined' ? [] : JSON.parse(sessionStorage.getItem(PIN_STORAGE_KEY) ?? '[]') as Pin[] } catch { return [] } })
  useEffect(() => { try { if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(PIN_STORAGE_KEY, JSON.stringify(pins)) } catch {} }, [pins])

  useEffect(() => { const controller = new AbortController(); setCatalogLoading(true); setCatalogError(undefined); void getTelemetryEventCatalog(controller.signal).then(setCatalog).catch(() => setCatalogError('Trusted telemetry mappings could not be loaded.')).finally(() => setCatalogLoading(false)); return () => controller.abort() }, [])
  useEffect(() => {
    if (sourceTab !== 'raw') return
    const controller = new AbortController(); const timer = window.setTimeout(() => {
      const offset = rawPage * 50
      if (rawPage === 0) { setRawCatalog(undefined); setRawCatalogError(undefined) }
      setRawCatalogLoading(true)
      void searchTelemetryEventRawCatalog(rawPressKey, variableSearch, offset, 50, controller.signal).then((next) => setRawCatalog((current) => rawPage > 0 && current && current.query === next.query && current.pressKey === next.pressKey ? { ...next, offset: 0, limit: current.items.length + next.items.length, items: [...current.items, ...next.items] } : next)).catch((caught) => { if ((caught as Error).name !== 'AbortError') setRawCatalogError('The complete raw signal catalog could not be loaded for this press.') }).finally(() => setRawCatalogLoading(false))
    }, 250)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [sourceTab, rawPressKey, variableSearch, rawPage])

  const selectedCanonical = catalog.canonicalVariables.find(({ canonicalId }) => canonicalId === selectedCanonicalId)
  const compatiblePresses = selectedCanonical?.compatiblePresses ?? []
  const compatibleDecks = [...new Set(compatiblePresses.flatMap(({ deckNumbers }) => deckNumbers))].sort((a, b) => a - b)
  const canonicalVariables = catalog.canonicalVariables.filter((item) => !variableSearch.trim() || `${item.displayName} ${item.canonicalId}`.toLowerCase().includes(variableSearch.toLowerCase()))
  const selectedDataKind = preview?.dataKind ?? (sourceTab === 'canonical' ? selectedCanonical?.dataKind : selectedRaw?.dataKind)
  const previewOptions = useMemo((): PreviewOption[] => {
    if (sourceTab === 'raw') return selectedRaw ? [{ pressKey: selectedRaw.pressKey, deckNumber: null, label: selectedRaw.pressKey.replace('press', 'Press ') }] : []
    if (!selectedCanonical) return []
    return selectedCanonical.compatiblePresses.flatMap((compatible): PreviewOption[] => selectedCanonical.scope === 'machine' ? [{ pressKey: compatible.pressKey, deckNumber: null, label: compatible.displayName }] : compatible.deckNumbers.map((deck): PreviewOption => ({ pressKey: compatible.pressKey, deckNumber: deck, label: `${compatible.displayName} · Deck ${deck}` }))).filter((option) => (pressKey === 'all' || option.pressKey === pressKey) && (deckNumber === 'any' || deckNumber === null || option.deckNumber === deckNumber))
  }, [sourceTab, selectedRaw, selectedCanonical, pressKey, deckNumber])

  useEffect(() => { setPreviewOption((current) => previewOptions.find((option) => current && option.pressKey === current.pressKey && option.deckNumber === current.deckNumber) ?? previewOptions[0]) }, [selectedCanonicalId, selectedRaw?.rawIdentity, pressKey, deckNumber, previewOptions.length])
  useEffect(() => {
    const source: TelemetryEventSource | undefined = sourceTab === 'canonical' ? selectedCanonical ? { kind: 'canonical', canonicalId: selectedCanonical.canonicalId } : undefined : selectedRaw ? { kind: 'raw', pressKey: selectedRaw.pressKey, rawIdentity: selectedRaw.rawIdentity, displayName: selectedRaw.displayName, dataType: selectedRaw.dataType, dataKind: selectedRaw.dataKind } : undefined
    if (!source || !previewOption) { setPreview(undefined); setPreviewError(undefined); setRangeApplyPending(false); return }
    const requestId = ++previewRequestId.current; const controller = new AbortController()
    setPreviewLoading(true); setPreviewError(undefined); setPreview(undefined)
    void previewTelemetryEventVariable({ source, pressKey: previewOption.pressKey, deckNumber: previewOption.deckNumber, fromUtc: range.fromUtc, toUtc: range.toUtc }, controller.signal).then((next) => { if (previewRequestId.current === requestId) setPreview(next) }).catch((caught) => { if ((caught as Error).name !== 'AbortError' && previewRequestId.current === requestId) setPreviewError('History is unavailable for this source and selected time range. Choose another compatible source or continue with the search.') }).finally(() => { if (previewRequestId.current === requestId) { setPreviewLoading(false); setRangeApplyPending(false) } })
    return () => controller.abort()
  }, [sourceTab, selectedCanonicalId, selectedRaw?.rawIdentity, previewOption?.pressKey, previewOption?.deckNumber, range.fromUtc, range.toUtc, previewRefreshKey])

  useEffect(() => { if (selectedDataKind && selectedDataKind !== 'numeric') setEventType('value_change') }, [selectedDataKind])

  function selectLast24Hours() { setRangeMode('last24'); setRange(createPresetRange('last24')); setError(undefined) }
  function applyCustomRange() {
    try {
      const next = createCustomRange(customFrom, customTo)
      setError(undefined); setRangeMode('custom'); setRangeApplyPending(Boolean((sourceTab === 'canonical' ? selectedCanonical : selectedRaw) && previewOption)); setRange(next); setPreviewRefreshKey((current) => current + 1)
    } catch (caught) { setRangeApplyPending(false); setError(caught instanceof RangeValidationError ? caught.message : 'Custom range is invalid.') }
  }
  async function runSearch() {
    setError(undefined)
    try {
      const source: TelemetryEventSource | undefined = sourceTab === 'canonical' ? selectedCanonical ? { kind: 'canonical' as const, canonicalId: selectedCanonical.canonicalId } : undefined : selectedRaw ? { kind: 'raw' as const, pressKey: selectedRaw.pressKey, rawIdentity: selectedRaw.rawIdentity, displayName: selectedRaw.displayName, dataType: selectedRaw.dataType, dataKind: selectedRaw.dataKind } : undefined
      if (!source) throw new Error('Choose a trustworthy scalar telemetry variable.')
      const numeric = (value: string, label: string, positive = false) => { const parsed = Number(value); if (!Number.isFinite(parsed) || positive && parsed <= 0) throw new Error(`${label} must be ${positive ? 'greater than zero' : 'a valid number'}.`); return parsed }
      const parsedScalar = (value: string, label: string): TelemetryEventScalar => {
        if (selectedDataKind === 'numeric') return numeric(value, label)
        if (selectedDataKind === 'boolean') { if (value === 'true') return true; if (value === 'false') return false; throw new Error(`${label} must be True or False.`) }
        if (!value.length) throw new Error(`${label} cannot be empty.`)
        return value
      }
      const rule: TelemetryEventRule = eventType === 'threshold' ? { kind: 'threshold', operator, threshold: numeric(threshold, 'Threshold') } : eventType === 'delta' ? { kind: 'delta', direction, amount: numeric(amount, 'Change amount', true), windowMinutes: numeric(windowMinutes, 'Maximum minutes', true) } : valueMatch === 'becomes' ? { kind: 'value_change', match: 'becomes', becomesValue: parsedScalar(becomesValue, 'New value') } : valueMatch === 'from_to' ? { kind: 'value_change', match: 'from_to', fromValue: parsedScalar(fromValue, 'Previous value'), toValue: parsedScalar(toValue, 'New value') } : { kind: 'value_change', match: 'any' }
      const chartContextMinutes = numeric(contextMinutes, 'Chart context minutes')
      const input: TelemetryEventSearchInput = source.kind === 'canonical' ? { fromUtc: range.fromUtc, toUtc: range.toUtc, source, pressKey, deckNumber: selectedCanonical?.scope === 'machine' ? null : deckNumber, rule, chartContextMinutes } : { fromUtc: range.fromUtc, toUtc: range.toUtc, source, pressKey: source.pressKey, deckNumber: null, rule, chartContextMinutes }
      setLoading(true); const next = await searchTelemetryEvents(input); setResult(next); setSelectedIndex(-1); setSetupCollapsed(true)
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Telemetry event search failed.') } finally { setLoading(false) }
  }

  const selected = selectedIndex >= 0 ? result?.occurrences[selectedIndex] : undefined
  const previewValues = [...new Set(preview?.observations.map(({ value }) => String(value)) ?? [])].slice(-20)
  return <div className="telemetry-event-explorer-page">
    <section className={`panel telemetry-event-setup${setupCollapsed ? ' is-collapsed' : ''}`}>
      {rangeApplyPending && <div className="telemetry-event-range-overlay" role="status" aria-live="polite"><i aria-hidden="true" /><div><strong>Applying time range</strong><span>Loading the selected variable preview for this exact window…</span></div></div>}
      {result && setupCollapsed ? <div className="raw-explorer-setup__collapsed"><div><span className="eyebrow">Current telemetry search</span><strong>{result.occurrences[0]?.signalDisplayName ?? selectedCanonical?.displayName ?? 'Telemetry event'} · {ruleLabel(result.setup.rule)}</strong><small>{result.summary.totalOccurrences} occurrences across {result.summary.compatiblePressesSearched.length} compatible presses</small></div><button type="button" className="secondary-action" onClick={() => setSetupCollapsed(false)}>Search another condition</button></div> : <>
        <div className="raw-explorer-title"><div><span className="eyebrow">Read-only event finder</span><h1>Telemetry Event Explorer</h1><p>Choose a telemetry condition, find every matching occurrence, then investigate it with synchronized telemetry and Radius context.</p></div></div>
        <div className="telemetry-event-setup-grid">
          <fieldset><legend>1 · Time range</legend><div className="raw-choice-row"><button type="button" className={rangeMode === 'last24' ? 'filter-chip active' : 'filter-chip'} onClick={selectLast24Hours}>Last 24 hours</button><button type="button" className={rangeMode === 'custom' ? 'filter-chip active' : 'filter-chip'} onClick={() => setRangeMode('custom')}>Custom</button></div>{rangeMode === 'custom' && <div className="raw-custom-range telemetry-event-custom-range"><label>Start (CT)<input type="datetime-local" value={customFrom} onChange={(event) => setCustomFrom(event.target.value)} /></label><label>End (CT)<input type="datetime-local" value={customTo} onChange={(event) => setCustomTo(event.target.value)} /></label><button type="button" className="secondary-action telemetry-apply-range" disabled={rangeApplyPending} onClick={applyCustomRange}><ApplyRangeIcon />{rangeApplyPending ? 'Applying…' : 'Apply range'}</button></div>}<small>{formatSelectedRange(range)}</small></fieldset>
          <fieldset className="telemetry-event-variable"><legend>2 · Variable</legend>
            <div className="raw-choice-row"><button type="button" className={sourceTab === 'canonical' ? 'filter-chip active' : 'filter-chip'} onClick={() => { setSourceTab('canonical'); setVariableSearch('') }}>Canonical</button><button type="button" className={sourceTab === 'raw' ? 'filter-chip active' : 'filter-chip'} onClick={() => { setSourceTab('raw'); setVariableSearch(''); setRawPage(0) }}>Raw</button></div>
            {sourceTab === 'raw' && <label>Source press<select value={rawPressKey} onChange={(event) => { setRawPressKey(event.target.value as RadiusPressKey); setSelectedRaw(undefined); setRawPage(0) }}>{['press3','press5','press6','press7','press8','press9','press10','press11','press12','press13','press14','press15'].map((key) => <option value={key} key={key}>{key.replace('press', 'Press ')}</option>)}</select></label>}
            <input type="search" value={variableSearch} onChange={(event) => { setVariableSearch(event.target.value); setRawPage(0) }} placeholder={sourceTab === 'raw' ? 'Search the full raw catalog' : 'Search canonical variables'} />
            {sourceTab === 'canonical' && catalogLoading && <small>Loading trusted telemetry mappings…</small>}{catalogError && <small role="alert">{catalogError}</small>}{rawCatalogError && sourceTab === 'raw' && <small role="alert">{rawCatalogError}</small>}
            {sourceTab === 'raw' && <small>{rawCatalog ? `${rawCatalog.items.length} of ${rawCatalog.total} matches · ${rawCatalog.catalogTotal} signals in catalog` : 'Loading the complete source catalog…'}</small>}
            <div className="telemetry-event-variable-list">{sourceTab === 'canonical' ? canonicalVariables.map((variable) => <button type="button" className={selectedCanonicalId === variable.canonicalId ? 'is-selected' : ''} key={variable.canonicalId} onClick={() => { setPreview(undefined); setSelectedCanonicalId(variable.canonicalId); setPressKey('all'); setDeckNumber(variable.scope === 'deck' ? 'any' : null) }}><strong>{variable.displayName}</strong><small>{variable.canonicalId} · {variable.dataKind} · {variable.compatiblePresses.length} compatible presses</small></button>) : rawCatalog?.items.map((variable) => <button type="button" className={selectedRaw?.rawIdentity === variable.rawIdentity ? 'is-selected' : ''} key={variable.rawIdentity} onClick={() => { setPreview(undefined); setSelectedRaw(variable) }}><strong>{variable.displayName}</strong><small>{variable.dataType} · {variable.rawIdentity}</small></button>)}</div>
            {sourceTab === 'raw' && rawCatalog && rawCatalog.items.length < rawCatalog.total && <button type="button" className="secondary-action telemetry-event-load-more" disabled={rawCatalogLoading} onClick={() => setRawPage((page) => page + 1)}>{rawCatalogLoading ? 'Loading…' : 'Load 50 more'}</button>}
          </fieldset>
          <fieldset><legend>3 · Scope</legend>{sourceTab === 'raw' ? <p>Raw-only identities search their exact source press. No cross-press equivalence is guessed.</p> : selectedCanonical ? <><label>Press<select value={pressKey} onChange={(event) => setPressKey(event.target.value as TelemetryEventSearchInput['pressKey'])}><option value="all">All Compatible Presses</option>{compatiblePresses.map((press) => <option value={press.pressKey} key={press.pressKey}>{press.displayName}</option>)}</select></label>{selectedCanonical.scope === 'deck' && <label>Deck<select value={deckNumber ?? 'any'} onChange={(event) => setDeckNumber(event.target.value === 'any' ? 'any' : Number(event.target.value))}><option value="any">Any Deck</option>{compatibleDecks.map((deck) => <option value={deck} key={deck}>Deck {deck}</option>)}</select></label>}<small>Unsupported presses and decks are skipped; mappings are never inferred from similar tag names.</small></> : <p>Choose a canonical variable to see its compatible presses and decks.</p>}</fieldset>
          <fieldset><legend>4 · Condition</legend>
            <div className="raw-choice-row">{(!selectedDataKind || selectedDataKind === 'numeric') && <><button type="button" className={eventType === 'threshold' ? 'filter-chip active' : 'filter-chip'} onClick={() => setEventType('threshold')}>Threshold</button><button type="button" className={eventType === 'delta' ? 'filter-chip active' : 'filter-chip'} onClick={() => setEventType('delta')}>Delta / Change</button></>}<button type="button" className={eventType === 'value_change' ? 'filter-chip active' : 'filter-chip'} onClick={() => setEventType('value_change')}>Value Change</button></div>
            {eventType === 'threshold' ? <div className="telemetry-event-rule-fields"><label>Operator<select value={operator} onChange={(event) => setOperator(event.target.value as typeof operator)}>{['>','>=','<','<='].map((value) => <option value={value} key={value}>{value}</option>)}</select></label><label>Threshold<input type="number" value={threshold} onChange={(event) => setThreshold(event.target.value)} /></label></div> : eventType === 'delta' ? <div className="telemetry-event-rule-fields"><label>Direction<select value={direction} onChange={(event) => setDirection(event.target.value as typeof direction)}><option value="increase">Increase</option><option value="decrease">Decrease</option><option value="either">Either</option></select></label><label>Amount<input type="number" min="0" value={amount} onChange={(event) => setAmount(event.target.value)} /></label><label>Within minutes<input type="number" min="1" value={windowMinutes} onChange={(event) => setWindowMinutes(event.target.value)} /></label></div> : selectedDataKind === 'boolean' ? <label>Change to find<select value={valueMatch === 'any' ? 'any' : `${fromValue}:${toValue}`} onChange={(event) => { if (event.target.value === 'any') { setValueMatch('any'); return } const [from, to] = event.target.value.split(':'); setValueMatch('from_to'); setFromValue(from!); setToValue(to!) }}><option value="any">Any toggle</option><option value="false:true">False → True</option><option value="true:false">True → False</option></select></label> : <div className="telemetry-event-value-rule"><label>Match<select value={valueMatch} onChange={(event) => setValueMatch(event.target.value as typeof valueMatch)}><option value="any">Any value change</option><option value="becomes">Becomes</option><option value="from_to">From → To</option></select></label>{valueMatch === 'becomes' && <label>New value<input type={selectedDataKind === 'numeric' ? 'number' : 'text'} list="telemetry-preview-values" value={becomesValue} onChange={(event) => setBecomesValue(event.target.value)} /></label>}{valueMatch === 'from_to' && <div className="telemetry-event-rule-fields"><label>Previous value<input type={selectedDataKind === 'numeric' ? 'number' : 'text'} list="telemetry-preview-values" value={fromValue} onChange={(event) => setFromValue(event.target.value)} /></label><label>New value<input type={selectedDataKind === 'numeric' ? 'number' : 'text'} list="telemetry-preview-values" value={toValue} onChange={(event) => setToValue(event.target.value)} /></label></div>}<datalist id="telemetry-preview-values">{previewValues.map((value) => <option value={value} key={value} />)}</datalist></div>}
            <label>Chart context (minutes)<input type="number" min="0" max="1440" value={contextMinutes} onChange={(event) => setContextMinutes(event.target.value)} /></label>
          </fieldset>
          <VariablePreview preview={preview} loading={previewLoading} error={previewError} options={previewOptions} selectedOption={previewOption} onOptionChange={setPreviewOption} />
        </div>{error && <div className="scope-progress scope-progress--error" role="alert">{error}</div>}<div className="raw-explorer-actions"><span className="raw-explorer-action-hint">Numeric variables support Threshold, Delta, and Value Change. String and boolean variables use exact Value Change rules.</span><button type="button" className="primary-action telemetry-find-occurrences" disabled={loading || (sourceTab === 'canonical' ? !selectedCanonical : !selectedRaw)} onClick={() => void runSearch()}><SearchIcon />{loading ? 'Searching historian…' : 'Find occurrences'}</button></div>
      </>}
    </section>
    {result && <section className="panel telemetry-event-results"><header><div><span className="eyebrow">Search results</span><h2>{result.occurrences[0]?.signalDisplayName ?? selectedCanonical?.displayName ?? selectedRaw?.displayName ?? 'Telemetry event'} · {ruleLabel(result.setup.rule)}</h2><p>{formatPlantDateTime(result.setup.fromUtc)}–{formatPlantDateTime(result.setup.toUtc)} CT</p></div><small>{result.performance.semanticHistoryRequests} bounded history requests · {Math.round(result.performance.totalMs)} ms</small></header><div className="raw-summary-metrics"><div><strong>{result.summary.totalOccurrences}</strong><span>Total occurrences</span></div><div><strong>{result.summary.resolvedSeries}</strong><span>Independent series</span></div><div><strong>{result.summary.compatiblePressesSearched.length}</strong><span>Presses searched</span></div></div><div className="raw-press-counts">{result.summary.pressCounts.map((press) => <span key={press.pressKey}><strong>{press.displayName}</strong> {press.occurrenceCount}</span>)}</div><div className="telemetry-event-occurrence-list">{result.occurrences.map((occurrence, index) => <button type="button" className={selectedIndex === index ? 'is-selected' : ''} key={occurrence.occurrenceId} onClick={() => setSelectedIndex(index)}><span><strong>{occurrence.displayName}{occurrence.deckNumber ? ` · Deck ${occurrence.deckNumber}` : ''}</strong><small>{formatPlantDateTime(occurrence.startUtc)} CT{occurrence.eventType === 'value_change' ? '' : ` · ${duration(occurrence.durationSeconds)}`}</small></span>{occurrence.eventType === 'threshold' ? <span><b>Entry {number(occurrence.entryValue)}</b><small>{occurrence.clippedEnd ? 'Active at range edge' : `Extreme ${number(occurrence.extremeValue)} · Return ${number(occurrence.returnValue)}`}</small></span> : occurrence.eventType === 'delta' ? <span><b>{occurrence.direction} {number(occurrence.actualDelta)}</b><small>{number(occurrence.baselineValue)} → {number(occurrence.triggerValue)} in {duration(occurrence.elapsedSeconds ?? 0)}</small></span> : <span><b>{scalar(occurrence.previousValue)} → {scalar(occurrence.newValue)}</b><small>Value changed at this timestamp</small></span>}</button>)}</div>{!result.occurrences.length && <p className="raw-empty">No matching telemetry occurrences were found in this range.</p>}</section>}
    {selected && result && <><nav className="telemetry-event-occurrence-nav" aria-label="Telemetry event occurrence navigation"><button type="button" className="secondary-action telemetry-occurrence-button" disabled={selectedIndex <= 0} onClick={() => setSelectedIndex((current) => current - 1)}><ChevronIcon direction="left" />Previous</button><span>Occurrence {selectedIndex + 1} of {result.occurrences.length}</span><button type="button" className="secondary-action telemetry-occurrence-button" disabled={selectedIndex >= result.occurrences.length - 1} onClick={() => setSelectedIndex((current) => current + 1)}>Next<ChevronIcon direction="right" /></button></nav><EventInvestigation key={selected.occurrenceId} occurrence={selected} rule={result.setup.rule} pins={pins} onPinsChange={setPins} sidebarOpen={sidebarOpen} onSidebarOpenChange={setSidebarOpen} /></>}
  </div>
}
