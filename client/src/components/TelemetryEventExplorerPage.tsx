import React, { useEffect, useMemo, useRef, useState } from 'react'
import { getTelemetryEventCatalog, getTelemetryEventDetail, plotTelemetryEventRawSignal, plotTelemetryEventSignal, searchTelemetryEvents } from '../api/process-intelligence-api'
import { createCustomRange, createPresetRange, defaultCustomValues, formatPlantDateTime, formatSelectedRange, RangeValidationError, type SelectedRange } from '../time-ranges'
import type { RawExplorerChangedSignal, RawExplorerOccurrence, RawExplorerPlotResult, RawExplorerSignalHistory, RawUnmappedChangedSignal, RawUnmappedHistory, RawUnmappedPlotResult, TelemetryEventCatalog, TelemetryEventDetail, TelemetryEventOccurrence, TelemetryEventRule, TelemetryEventSearchInput } from '../types/api'
import type { TimedNumericSample } from '../types/evidence'
import { RawExplorerInspectionTooltip, rawExplorerNumberSamples, rawExplorerStateIntervals, rawUnmappedNumberSamples, rawUnmappedStateIntervals } from './RawRadiusExplorerPage'
import { SynchronizedTimeline, type TimelineIntervalTrack, type TimelineNumericTrack } from './SynchronizedTimeline'
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
function canonicalKey(signal: { canonicalId: string; deckNumber: number | null }) { return `canonical:${signal.canonicalId}:${signal.deckNumber ?? ''}` }
function rawKey(rawIdentity: string) { return `raw:${rawIdentity}` }
function sourceUnit(sourceUnit: string | null) { const safe = safeEngineeringSourceUnit({ sourceUnit }); return safe ? `${safe} · unverified` : 'Unit unverified' }
function ruleLabel(rule: TelemetryEventRule) { return rule.kind === 'threshold' ? `${rule.operator} ${number(rule.threshold)}` : `${rule.direction === 'either' ? 'Increase or decrease' : rule.direction === 'increase' ? 'Increase' : 'Decrease'} by ≥ ${number(rule.amount)} within ${rule.windowMinutes} minutes` }

export function telemetryEventMarkers(occurrence: TelemetryEventOccurrence): NonNullable<TimelineNumericTrack['markers']> {
  if (occurrence.eventType === 'threshold') return [
    { atUtc: occurrence.startUtc, label: 'Event start', kind: 'start' },
    ...(occurrence.extremeAtUtc ? [{ atUtc: occurrence.extremeAtUtc, label: 'Extreme', kind: 'extreme' as const }] : []),
    ...(!occurrence.clippedEnd ? [{ atUtc: occurrence.endUtc, label: 'Return', kind: 'end' as const }] : []),
  ]
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

  const primaryCanonical: RawExplorerSignalHistory | undefined = detail.primary.kind === 'canonical' ? { ...detail.primary.signal, friendlyName: occurrence.signalDisplayName, signalType: 'continuous', category: canonicalSignals.find(({ canonicalId }) => canonicalId === occurrence.canonicalId)?.category ?? 'repeat_other', scope: occurrence.deckNumber === null ? 'machine' : 'deck' } : undefined
  const primaryRaw: RawUnmappedHistory | undefined = detail.primary.kind === 'raw' ? { ...detail.primary.signal, reviewStatus: 'UNREVIEWED' } : undefined
  const primarySamples: TimedNumericSample[] = primaryCanonical ? rawExplorerNumberSamples(primaryCanonical) : primaryRaw ? rawUnmappedNumberSamples(primaryRaw) : []
  const eventTrack: TimelineNumericTrack = { id: 'telemetry-event-primary', label: `${occurrence.deckNumber ? `Deck ${occurrence.deckNumber} · ` : ''}${occurrence.signalDisplayName}`, unit: sourceUnit(occurrence.sourceUnit), samples: primarySamples, interpolation: 'linear', referenceLines: rule.kind === 'threshold' ? [{ value: rule.threshold, label: `Threshold ${rule.operator} ${number(rule.threshold)}` }] : [], markers: telemetryEventMarkers(occurrence), unavailableLabel: 'No valid numeric samples in this event context' }
  const rollSamples = detail.context.currentRollLength ? rawExplorerNumberSamples(detail.context.currentRollLength) : []
  const speedSamples = detail.context.speed.samples.flatMap((sample): TimedNumericSample[] => typeof sample.value === 'number' ? [{ ...sample, value: sample.value, valueKind: Number.isInteger(sample.value) ? 'integer' : 'numeric' }] : [])
  const radiusTrack: TimelineIntervalTrack = { id: 'event-radius', label: 'Raw Radius', intervals: detail.context.radiusSegments.map((segment) => ({ id: `${segment.pressKey}:${segment.startUtc}`, startUtc: segment.startUtc, endUtc: segment.endUtc, label: segment.kind === 'radius' ? `${segment.eventType} / ${segment.statusCode ?? '—'}` : 'Unavailable', details: segment.kind === 'radius' ? `${segment.eventType} / ${segment.statusCode ?? '—'} · ${segment.statusDescription}` : 'Radius unavailable', unavailable: segment.kind === 'offline', style: segment.kind === 'radius' ? { background: radiusHue(`${segment.eventType}|${segment.statusCode}|${segment.statusDescription}`) } : undefined })) }
  const eventAsRaw = { ...occurrence, eventType: 'TELEMETRY', statusCode: occurrence.eventType, statusDescription: occurrence.signalDisplayName } as RawExplorerOccurrence
  const intervalTracks: TimelineIntervalTrack[] = [radiusTrack, ...extraCanonical.filter(({ signalType }) => signalType === 'state_event').map((history) => ({ id: canonicalKey(history), label: `${history.deckNumber ? `Deck ${history.deckNumber} · ` : ''}${history.friendlyName}`, intervals: rawExplorerStateIntervals(history, eventAsRaw) })), ...extraRaw.filter(({ dataKind }) => dataKind !== 'numeric').map((history) => ({ id: rawKey(history.rawIdentity), label: `RAW · ${history.signalDisplayName}`, intervals: rawUnmappedStateIntervals(history, eventAsRaw) }))]
  const primaryCanonicalKey = occurrence.canonicalId ? canonicalKey({ canonicalId: occurrence.canonicalId, deckNumber: occurrence.deckNumber }) : undefined
  const numericTracks: TimelineNumericTrack[] = [eventTrack, { id: 'event-roll', label: 'Current Roll Length', unit: 'Unit unverified', samples: rollSamples, interpolation: 'step', connectObservedGaps: true, holdLastObservation: true, unavailableLabel: 'Current Roll Length unavailable' }, { id: 'event-speed', label: 'Actual Speed', unit: sourceUnit(detail.context.speed.sourceUnit), samples: speedSamples, interpolation: 'step', connectObservedGaps: true, holdLastObservation: true }, ...extraCanonical.filter((history) => history.signalType !== 'state_event' && canonicalKey(history) !== primaryCanonicalKey).map((history) => ({ id: canonicalKey(history), label: `${preview?.key === canonicalKey(history) ? 'PREVIEW · ' : ''}${history.deckNumber ? `Deck ${history.deckNumber} · ` : ''}${history.friendlyName}`, unit: sourceUnit(history.sourceUnit), samples: rawExplorerNumberSamples(history), interpolation: 'step' as const, connectObservedGaps: true, holdLastObservation: true })), ...extraRaw.filter((history) => history.dataKind === 'numeric' && historyRawIdentityNotPrimary(occurrence, history)).map((history) => ({ id: rawKey(history.rawIdentity), label: `${preview?.key === rawKey(history.rawIdentity) ? 'PREVIEW · ' : ''}RAW · ${history.signalDisplayName}`, unit: sourceUnit(history.sourceUnit), samples: rawUnmappedNumberSamples(history), interpolation: 'step' as const, connectObservedGaps: true, holdLastObservation: true }))]
  const tooltipCanonical = [...(primaryCanonical ? [primaryCanonical] : []), ...extraCanonical.filter((item) => canonicalKey(item) !== (primaryCanonical ? canonicalKey(primaryCanonical) : ''))]
  const tooltipRaw = [...(primaryRaw ? [primaryRaw] : []), ...extraRaw.filter((item) => item.rawIdentity !== primaryRaw?.rawIdentity)]
  return <section className="panel telemetry-event-investigation">
    <header className="event-investigation-header"><div><span className="eyebrow">Selected occurrence</span><h2>{occurrence.displayName}{occurrence.deckNumber ? ` · Deck ${occurrence.deckNumber}` : ''}</h2><p>{occurrence.signalDisplayName} · {ruleLabel(rule)}</p></div><div><strong>{duration(occurrence.durationSeconds)}</strong><small>{formatPlantDateTime(occurrence.startUtc)} CT</small></div></header>
    <div className={`raw-investigation-workspace${sidebarOpen ? '' : ' is-sidebar-collapsed'}`}>
      <section className="raw-chart-workspace"><div className="raw-chart-workspace__sticky">
        <div className="raw-pinned-strip"><strong>Pinned</strong>{!pins.length && <span>Pin signals to keep them while moving between occurrences.</span>}{pins.map((pin) => <button type="button" key={pin.key} onClick={() => void toggle(pin)}>{pin.kind === 'canonical' ? `${pin.signal.deckNumber ? `Deck ${pin.signal.deckNumber} · ` : ''}${pin.signal.friendlyName}` : pin.label}<span>×</span></button>)}</div>
        <div className="event-rule-banner"><strong>{ruleLabel(rule)}</strong><span>{occurrence.eventType === 'threshold' ? `Entry ${number(occurrence.entryValue)} · Extreme ${number(occurrence.extremeValue)}${occurrence.clippedEnd ? ' · active/clipped at range edge' : ` · Return ${number(occurrence.returnValue)}`}` : `Baseline ${number(occurrence.baselineValue)} · Trigger ${number(occurrence.triggerValue)} · Actual delta ${number(occurrence.actualDelta)} in ${duration(occurrence.elapsedSeconds ?? 0)}`}</span>{occurrence.dataGap && <b>Telemetry gap bounded this occurrence</b>}</div>
        <SynchronizedTimeline fromUtc={occurrence.chartFromUtc} toUtc={occurrence.chartToUtc} intervalTracks={intervalTracks} numericTracks={numericTracks} trackOrder={['numeric:telemetry-event-primary', 'numeric:event-roll', 'interval:event-radius', 'numeric:event-speed']} highlightedRange={{ fromUtc: occurrence.startUtc, toUtc: occurrence.endUtc, label: 'Detected telemetry event interval' }} renderInspectionTooltip={(atUtc) => <RawExplorerInspectionTooltip atUtc={atUtc} detail={detail.context} histories={tooltipCanonical} rawHistories={tooltipRaw} />} ariaLabel={`${occurrence.displayName} telemetry event, Radius, roll length, speed, and investigation signals`} />
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
  const customDefaults = useMemo(defaultCustomValues, [])
  const [customFrom, setCustomFrom] = useState(customDefaults.from); const [customTo, setCustomTo] = useState(customDefaults.to)
  const [catalog, setCatalog] = useState<TelemetryEventCatalog>({ canonicalVariables: [], rawVariables: [] })
  const [catalogLoading, setCatalogLoading] = useState(true); const [catalogError, setCatalogError] = useState<string>()
  const [sourceTab, setSourceTab] = useState<SourceTab>('canonical'); const [variableSearch, setVariableSearch] = useState('')
  const [selectedCanonicalId, setSelectedCanonicalId] = useState<string>(); const [rawPressKey, setRawPressKey] = useState<TelemetryEventSearchInput['pressKey']>('press3'); const [selectedRawIdentity, setSelectedRawIdentity] = useState<string>()
  const [pressKey, setPressKey] = useState<TelemetryEventSearchInput['pressKey']>('all'); const [deckNumber, setDeckNumber] = useState<TelemetryEventSearchInput['deckNumber']>('any')
  const [eventType, setEventType] = useState<'threshold' | 'delta'>('threshold'); const [operator, setOperator] = useState<'>' | '>=' | '<' | '<='>('>'); const [threshold, setThreshold] = useState('200')
  const [direction, setDirection] = useState<'increase' | 'decrease' | 'either'>('increase'); const [amount, setAmount] = useState('5'); const [windowMinutes, setWindowMinutes] = useState('10'); const [contextMinutes, setContextMinutes] = useState('30')
  const [result, setResult] = useState<Awaited<ReturnType<typeof searchTelemetryEvents>>>(); const [selectedIndex, setSelectedIndex] = useState(-1); const [loading, setLoading] = useState(false); const [error, setError] = useState<string>(); const [setupCollapsed, setSetupCollapsed] = useState(false); const [sidebarOpen, setSidebarOpen] = useState(true)
  const [pins, setPins] = useState<Pin[]>(() => { try { return typeof sessionStorage === 'undefined' ? [] : JSON.parse(sessionStorage.getItem(PIN_STORAGE_KEY) ?? '[]') as Pin[] } catch { return [] } })
  useEffect(() => { try { if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(PIN_STORAGE_KEY, JSON.stringify(pins)) } catch {} }, [pins])

  useEffect(() => { const controller = new AbortController(); setCatalogLoading(true); setCatalogError(undefined); void getTelemetryEventCatalog(undefined, undefined, undefined, controller.signal).then((value) => setCatalog((current) => ({ ...value, rawVariables: current.rawVariables }))).catch(() => setCatalogError('Trusted telemetry mappings could not be loaded.')).finally(() => setCatalogLoading(false)); return () => controller.abort() }, [])
  useEffect(() => { if (sourceTab !== 'raw' || rawPressKey === 'all') return; const controller = new AbortController(); setCatalogLoading(true); void getTelemetryEventCatalog(range.fromUtc, range.toUtc, rawPressKey, controller.signal).then((value) => setCatalog(value)).catch(() => setCatalogError('Raw numeric variables could not be loaded for this press and range.')).finally(() => setCatalogLoading(false)); return () => controller.abort() }, [sourceTab, rawPressKey, range.fromUtc, range.toUtc])

  const selectedCanonical = catalog.canonicalVariables.find(({ canonicalId }) => canonicalId === selectedCanonicalId)
  const compatiblePresses = selectedCanonical?.compatiblePresses ?? []
  const compatibleDecks = [...new Set(compatiblePresses.flatMap(({ deckNumbers }) => deckNumbers))].sort((a, b) => a - b)
  const variables = (sourceTab === 'canonical' ? catalog.canonicalVariables : catalog.rawVariables).filter((item) => !variableSearch.trim() || `${item.displayName} ${item.kind === 'canonical' ? item.canonicalId : `${item.rawIdentity} ${item.discoveryCategory}`}`.toLowerCase().includes(variableSearch.toLowerCase()))

  function setPreset(preset: 'last24' | 'custom') { try { setRange(preset === 'last24' ? createPresetRange('last24') : createCustomRange(customFrom, customTo)); setError(undefined) } catch (caught) { setError(caught instanceof RangeValidationError ? caught.message : 'Custom range is invalid.') } }
  async function runSearch() {
    setError(undefined)
    try {
      const source = sourceTab === 'canonical' ? selectedCanonical ? { kind: 'canonical' as const, canonicalId: selectedCanonical.canonicalId } : undefined : rawPressKey !== 'all' ? catalog.rawVariables.find(({ rawIdentity }) => rawIdentity === selectedRawIdentity) : undefined
      if (!source) throw new Error('Choose a trustworthy numeric telemetry variable.')
      const numeric = (value: string, label: string, positive = false) => { const parsed = Number(value); if (!Number.isFinite(parsed) || positive && parsed <= 0) throw new Error(`${label} must be ${positive ? 'greater than zero' : 'a valid number'}.`); return parsed }
      const rule: TelemetryEventRule = eventType === 'threshold' ? { kind: 'threshold', operator, threshold: numeric(threshold, 'Threshold') } : { kind: 'delta', direction, amount: numeric(amount, 'Change amount', true), windowMinutes: numeric(windowMinutes, 'Maximum minutes', true) }
      const chartContextMinutes = numeric(contextMinutes, 'Chart context minutes')
      const input: TelemetryEventSearchInput = source.kind === 'canonical' ? { fromUtc: range.fromUtc, toUtc: range.toUtc, source, pressKey, deckNumber: selectedCanonical?.scope === 'machine' ? null : deckNumber, rule, chartContextMinutes } : { fromUtc: range.fromUtc, toUtc: range.toUtc, source: { kind: 'raw', pressKey: source.pressKey, rawIdentity: source.rawIdentity, displayName: source.displayName }, pressKey: source.pressKey, deckNumber: null, rule, chartContextMinutes }
      setLoading(true); const next = await searchTelemetryEvents(input); setResult(next); setSelectedIndex(-1); setSetupCollapsed(true)
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Telemetry event search failed.') } finally { setLoading(false) }
  }

  const selected = selectedIndex >= 0 ? result?.occurrences[selectedIndex] : undefined
  return <div className="telemetry-event-explorer-page">
    <section className={`panel telemetry-event-setup${setupCollapsed ? ' is-collapsed' : ''}`}>
      {result && setupCollapsed ? <div className="raw-explorer-setup__collapsed"><div><span className="eyebrow">Current telemetry search</span><strong>{result.occurrences[0]?.signalDisplayName ?? selectedCanonical?.displayName ?? 'Telemetry event'} · {ruleLabel(result.setup.rule)}</strong><small>{result.summary.totalOccurrences} occurrences across {result.summary.compatiblePressesSearched.length} compatible presses</small></div><button type="button" className="secondary-action" onClick={() => setSetupCollapsed(false)}>Search another condition</button></div> : <>
        <div className="raw-explorer-title"><div><span className="eyebrow">Read-only event finder</span><h1>Telemetry Event Explorer</h1><p>Choose a telemetry condition, find every matching occurrence, then investigate it with synchronized telemetry and Radius context.</p></div></div>
        <div className="telemetry-event-setup-grid">
          <fieldset><legend>1 · Time range</legend><div className="raw-choice-row"><button type="button" className={range.preset === 'last24' ? 'filter-chip active' : 'filter-chip'} onClick={() => setPreset('last24')}>Last 24 hours</button><button type="button" className={range.preset === 'custom' ? 'filter-chip active' : 'filter-chip'} onClick={() => setPreset('custom')}>Custom</button></div>{range.preset === 'custom' && <div className="raw-custom-range"><label>Start (CT)<input type="datetime-local" value={customFrom} onChange={(event) => setCustomFrom(event.target.value)} /></label><label>End (CT)<input type="datetime-local" value={customTo} onChange={(event) => setCustomTo(event.target.value)} /></label><button type="button" className="secondary-action" onClick={() => setPreset('custom')}>Apply range</button></div>}<small>{formatSelectedRange(range)}</small></fieldset>
          <fieldset className="telemetry-event-variable"><legend>2 · Variable</legend><div className="raw-choice-row"><button type="button" className={sourceTab === 'canonical' ? 'filter-chip active' : 'filter-chip'} onClick={() => setSourceTab('canonical')}>Canonical</button><button type="button" className={sourceTab === 'raw' ? 'filter-chip active' : 'filter-chip'} onClick={() => setSourceTab('raw')}>Raw</button></div>{sourceTab === 'raw' && <label>Source press<select value={rawPressKey} onChange={(event) => { setRawPressKey(event.target.value as TelemetryEventSearchInput['pressKey']); setSelectedRawIdentity(undefined) }}>{['press3','press5','press6','press7','press8','press9','press10','press11','press12','press13','press14','press15'].map((key) => <option value={key} key={key}>{key.replace('press', 'Press ')}</option>)}</select></label>}<input type="search" value={variableSearch} onChange={(event) => setVariableSearch(event.target.value)} placeholder="Search numeric telemetry" />{catalogLoading && <small>Loading trusted telemetry catalog…</small>}{catalogError && <small role="alert">{catalogError}</small>}<div className="telemetry-event-variable-list">{variables.map((variable) => { const selected = variable.kind === 'canonical' ? selectedCanonicalId === variable.canonicalId : selectedRawIdentity === variable.rawIdentity; return <button type="button" className={selected ? 'is-selected' : ''} key={variable.kind === 'canonical' ? variable.canonicalId : variable.rawIdentity} onClick={() => variable.kind === 'canonical' ? (setSelectedCanonicalId(variable.canonicalId), setPressKey('all'), setDeckNumber(variable.scope === 'deck' ? 'any' : null)) : setSelectedRawIdentity(variable.rawIdentity)}><strong>{variable.displayName}</strong><small>{variable.kind === 'canonical' ? `${variable.canonicalId} · ${variable.compatiblePresses.length} compatible presses` : variable.rawIdentity}</small></button>})}</div></fieldset>
          <fieldset><legend>3 · Scope</legend>{sourceTab === 'raw' ? <p>Raw-only identities search their exact source press. No cross-press equivalence is guessed.</p> : selectedCanonical ? <><label>Press<select value={pressKey} onChange={(event) => setPressKey(event.target.value as TelemetryEventSearchInput['pressKey'])}><option value="all">All Compatible Presses</option>{compatiblePresses.map((press) => <option value={press.pressKey} key={press.pressKey}>{press.displayName}</option>)}</select></label>{selectedCanonical.scope === 'deck' && <label>Deck<select value={deckNumber ?? 'any'} onChange={(event) => setDeckNumber(event.target.value === 'any' ? 'any' : Number(event.target.value))}><option value="any">Any Deck</option>{compatibleDecks.map((deck) => <option value={deck} key={deck}>Deck {deck}</option>)}</select></label>}<small>Unsupported presses and decks are skipped; mappings are never inferred from similar tag names.</small></> : <p>Choose a canonical variable to see its compatible presses and decks.</p>}</fieldset>
          <fieldset><legend>4 · Condition</legend><div className="raw-choice-row"><button type="button" className={eventType === 'threshold' ? 'filter-chip active' : 'filter-chip'} onClick={() => setEventType('threshold')}>Threshold</button><button type="button" className={eventType === 'delta' ? 'filter-chip active' : 'filter-chip'} onClick={() => setEventType('delta')}>Delta / Change</button></div>{eventType === 'threshold' ? <div className="telemetry-event-rule-fields"><label>Operator<select value={operator} onChange={(event) => setOperator(event.target.value as typeof operator)}>{['>','>=','<','<='].map((value) => <option value={value} key={value}>{value}</option>)}</select></label><label>Threshold<input type="number" value={threshold} onChange={(event) => setThreshold(event.target.value)} /></label></div> : <div className="telemetry-event-rule-fields"><label>Direction<select value={direction} onChange={(event) => setDirection(event.target.value as typeof direction)}><option value="increase">Increase</option><option value="decrease">Decrease</option><option value="either">Either</option></select></label><label>Amount<input type="number" min="0" value={amount} onChange={(event) => setAmount(event.target.value)} /></label><label>Within minutes<input type="number" min="1" value={windowMinutes} onChange={(event) => setWindowMinutes(event.target.value)} /></label></div>}<label>Chart context (minutes)<input type="number" min="0" max="1440" value={contextMinutes} onChange={(event) => setContextMinutes(event.target.value)} /></label></fieldset>
        </div>{error && <div className="scope-progress scope-progress--error" role="alert">{error}</div>}<div className="raw-explorer-actions"><span className="raw-explorer-action-hint">Only trustworthy scalar numeric histories are eligible for event rules.</span><button type="button" className="primary-action" disabled={loading || (sourceTab === 'canonical' ? !selectedCanonical : !selectedRawIdentity)} onClick={() => void runSearch()}>{loading ? 'Searching historian…' : 'Find occurrences'}</button></div>
      </>}
    </section>
    {result && <section className="panel telemetry-event-results"><header><div><span className="eyebrow">Search results</span><h2>{result.occurrences[0]?.signalDisplayName ?? selectedCanonical?.displayName ?? 'Telemetry event'} · {ruleLabel(result.setup.rule)}</h2><p>{formatPlantDateTime(result.setup.fromUtc)}–{formatPlantDateTime(result.setup.toUtc)} CT</p></div><small>{result.performance.semanticHistoryRequests} bounded history requests · {Math.round(result.performance.totalMs)} ms</small></header><div className="raw-summary-metrics"><div><strong>{result.summary.totalOccurrences}</strong><span>Total occurrences</span></div><div><strong>{result.summary.resolvedSeries}</strong><span>Independent series</span></div><div><strong>{result.summary.compatiblePressesSearched.length}</strong><span>Presses searched</span></div></div><div className="raw-press-counts">{result.summary.pressCounts.map((press) => <span key={press.pressKey}><strong>{press.displayName}</strong> {press.occurrenceCount}</span>)}</div><div className="telemetry-event-occurrence-list">{result.occurrences.map((occurrence, index) => <button type="button" className={selectedIndex === index ? 'is-selected' : ''} key={occurrence.occurrenceId} onClick={() => setSelectedIndex(index)}><span><strong>{occurrence.displayName}{occurrence.deckNumber ? ` · Deck ${occurrence.deckNumber}` : ''}</strong><small>{formatPlantDateTime(occurrence.startUtc)} CT · {duration(occurrence.durationSeconds)}</small></span>{occurrence.eventType === 'threshold' ? <span><b>Entry {number(occurrence.entryValue)}</b><small>{occurrence.clippedEnd ? 'Active at range edge' : `Extreme ${number(occurrence.extremeValue)} · Return ${number(occurrence.returnValue)}`}</small></span> : <span><b>{occurrence.direction} {number(occurrence.actualDelta)}</b><small>{number(occurrence.baselineValue)} → {number(occurrence.triggerValue)} in {duration(occurrence.elapsedSeconds ?? 0)}</small></span>}</button>)}</div>{!result.occurrences.length && <p className="raw-empty">No matching telemetry occurrences were found in this range.</p>}</section>}
    {selected && result && <><nav className="telemetry-event-occurrence-nav" aria-label="Telemetry event occurrence navigation"><button type="button" className="secondary-action" disabled={selectedIndex <= 0} onClick={() => setSelectedIndex((current) => current - 1)}>← Previous</button><span>Occurrence {selectedIndex + 1} of {result.occurrences.length}</span><button type="button" className="secondary-action" disabled={selectedIndex >= result.occurrences.length - 1} onClick={() => setSelectedIndex((current) => current + 1)}>Next →</button></nav><EventInvestigation key={selected.occurrenceId} occurrence={selected} rule={result.setup.rule} pins={pins} onPinsChange={setPins} sidebarOpen={sidebarOpen} onSidebarOpenChange={setSidebarOpen} /></>}
  </div>
}
