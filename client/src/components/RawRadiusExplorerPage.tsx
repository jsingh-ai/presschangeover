import { useEffect, useMemo, useRef, useState } from 'react'
import { DateTime } from 'luxon'
import { exploreRawRadius, getRawRadiusIdentities, getRawRadiusOccurrenceDetail, plotRawRadiusSignal, plotRawUnmappedSignal, setRawTelemetryReview } from '../api/process-intelligence-api'
import { SynchronizedTimeline, type TimelineIntervalItem, type TimelineIntervalTrack, type TimelineNumericTrack } from './SynchronizedTimeline'
import { createCustomRange, createPresetRange, defaultCustomValues, formatPlantDateTime, formatSelectedRange, PLANT_TIME_ZONE, RangeValidationError, restoreSelectedRange, type SelectedRange } from '../time-ranges'
import type { RawExplorerCategory, RawExplorerChangedSignal, RawExplorerDetail, RawExplorerIdentity, RawExplorerNumericSummary, RawExplorerOccurrence, RawExplorerPlotResult, RawExplorerResult, RawExplorerSignalHistory, RawExplorerStateSummary, RawRadiusPhase, RawTelemetryReviewStatus, RawTelemetryScalar, RawTelemetryValue, RawUnmappedChangedSignal, RawUnmappedHistory, RawUnmappedPlotResult } from '../types/api'
import type { TimedNumericSample } from '../types/evidence'
import { safeEngineeringSourceUnit } from './EngineeringTelemetryInspector'

const MAX_WINDOW_MINUTES = 1_440
export const CURRENT_ROLL_LENGTH_CANONICAL_ID = 'production.roll.length.actual'
const INITIAL_OCCURRENCE_COUNT = 20
const LOAD_MORE_COUNT = 20
export const DEFAULT_RAW_EXPLORER_LOOKBACK_MINUTES = 10
export const DEFAULT_RAW_EXPLORER_CONTEXT_MINUTES = 30
const PHASES: Array<{ key: RawRadiusPhase; label: string }> = [
  { key: 'G', label: 'Good (G)' }, { key: 'B', label: 'Bad (B)' }, { key: 'M', label: 'Make Ready (M)' }, { key: 'S', label: 'Radius S State (S)' },
]

class RequestQueue {
  private active = 0
  private readonly waiting: Array<() => void> = []
  constructor(private readonly limit: number) {}
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiting.push(resolve))
    this.active += 1
    try { return await work() } finally { this.active -= 1; this.waiting.shift()?.() }
  }
}

const detailQueue = new RequestQueue(1)
const plotQueue = new RequestQueue(3)

function durationLabel(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`
  const hours = Math.floor(seconds / 3_600)
  const minutes = Math.round((seconds % 3_600) / 60)
  return `${hours ? `${hours}h ` : ''}${minutes}m`
}

export function formatRawExplorerNumber(value: number, maximumFractionDigits = 1): string {
  const normalized = Object.is(value, -0) ? 0 : value
  return new Intl.NumberFormat('en-US', { maximumFractionDigits, minimumFractionDigits: 0 }).format(normalized)
}

function scalarLabel(value: RawTelemetryScalar, maximumFractionDigits = 2): string {
  if (value === null) return 'null'
  if (typeof value === 'number') return formatRawExplorerNumber(value, maximumFractionDigits)
  return String(value)
}

function signalKey(signal: { canonicalId: string; deckNumber: number | null }): string {
  return `${signal.canonicalId}:${signal.deckNumber ?? ''}`
}

function rawSignalKey(signal: { rawIdentity: string }): string { return `raw:${signal.rawIdentity}` }
function rawSignalLabel(signal: { displayName?: string; signalDisplayName?: string }): string { return `RAW · ${signal.displayName ?? signal.signalDisplayName ?? 'Unmapped signal'}` }

function rawValueLabel(value: RawTelemetryValue, maximumFractionDigits = 2): string {
  if (Array.isArray(value)) return `[${value.length} values]`
  if (value && typeof value === 'object') return 'Structured value'
  return scalarLabel(value, maximumFractionDigits)
}

function signalLabel(signal: { friendlyName: string; deckNumber: number | null }): string {
  return `${signal.deckNumber === null ? 'Machine' : `Deck ${signal.deckNumber}`} · ${signal.friendlyName}`
}

function evidenceUnit(sourceUnit: string | null): string {
  const safe = safeEngineeringSourceUnit({ sourceUnit })
  return safe ? `${safe} · unverified` : 'Unit unverified'
}

function rawExplorerEvidenceUnit(signal: { canonicalId: string; sourceUnit: string | null }): string {
  return signal.canonicalId.startsWith('production.') && signal.canonicalId.includes('.length') ? 'Unit unverified' : evidenceUnit(signal.sourceUnit)
}

export function rawExplorerNumberSamples(history: RawExplorerSignalHistory): TimedNumericSample[] {
  const source = history.representation === 'samples' ? [history.seed, ...history.samples] : [history.seed, ...history.changes]
  const values = source.flatMap((sample) => sample && typeof sample.value === 'number' ? [{ ...sample, valueKind: Number.isInteger(sample.value) ? 'integer' as const : 'numeric' as const, value: sample.value }] : [])
  const unique = new Map(values.map((sample) => [`${sample.observedAtUtc}|${sample.value}`, sample]))
  return [...unique.values()].sort((left, right) => Date.parse(left.observedAtUtc) - Date.parse(right.observedAtUtc))
}

export function rawExplorerStateIntervals(history: RawExplorerSignalHistory, occurrence: RawExplorerOccurrence): TimelineIntervalItem[] {
  const changes = history.changes.filter((change) => Date.parse(change.observedAtUtc) < Date.parse(occurrence.chartToUtc)).sort((a, b) => Date.parse(a.observedAtUtc) - Date.parse(b.observedAtUtc))
  if (!history.seed && !changes.length) return []
  let cursor = occurrence.chartFromUtc
  let value: RawTelemetryScalar = history.seed?.value ?? changes[0]?.previousValue ?? null
  const intervals: TimelineIntervalItem[] = []
  for (const change of changes) {
    if (Date.parse(change.observedAtUtc) <= Date.parse(occurrence.chartFromUtc)) { value = change.value; continue }
    intervals.push({ id: `${signalKey(history)}:${cursor}`, startUtc: cursor, endUtc: change.observedAtUtc, label: scalarLabel(value), details: `${signalLabel(history)}: ${scalarLabel(value)}` })
    cursor = change.observedAtUtc
    value = change.value
  }
  if (Date.parse(cursor) < Date.parse(occurrence.chartToUtc)) intervals.push({ id: `${signalKey(history)}:${cursor}`, startUtc: cursor, endUtc: occurrence.chartToUtc, label: scalarLabel(value), details: `${signalLabel(history)}: ${scalarLabel(value)}` })
  return intervals
}

export function rawUnmappedNumberSamples(history: RawUnmappedHistory): TimedNumericSample[] {
  return history.observations.flatMap((observation): TimedNumericSample[] => typeof observation.rawValue === 'number' && Number.isFinite(observation.rawValue) ? [{ observedAtUtc: observation.timestampUtc, receivedAtUtc: observation.receivedAtUtc, sourceTimestampUtc: observation.sourceTimestampUtc, qualityState: observation.qualityState, valueKind: Number.isInteger(observation.rawValue) ? 'integer' : 'numeric', value: observation.rawValue }] : [])
}

export function rawUnmappedStateIntervals(history: RawUnmappedHistory, occurrence: RawExplorerOccurrence): TimelineIntervalItem[] {
  const observations = history.observations.filter((item) => (typeof item.rawValue === 'string' || typeof item.rawValue === 'number' || typeof item.rawValue === 'boolean' || item.rawValue === null) && Date.parse(item.timestampUtc) < Date.parse(occurrence.chartToUtc)).sort((a, b) => Date.parse(a.timestampUtc) - Date.parse(b.timestampUtc))
  if (!observations.length) return []
  const intervals: TimelineIntervalItem[] = []
  for (let index = 0; index < observations.length; index += 1) {
    const item = observations[index]!
    const startUtc = Date.parse(item.timestampUtc) < Date.parse(occurrence.chartFromUtc) ? occurrence.chartFromUtc : item.timestampUtc
    const endUtc = observations[index + 1]?.timestampUtc ?? occurrence.chartToUtc
    if (Date.parse(startUtc) < Date.parse(endUtc)) intervals.push({ id: `${rawSignalKey(history)}:${item.timestampUtc}`, startUtc, endUtc, label: rawValueLabel(item.rawValue), details: `${rawSignalLabel(history)}: ${rawValueLabel(item.rawValue)} · observed ${formatCrosshairTime(item.timestampUtc)} CT` })
  }
  return intervals
}

export function latestNumericAtOrBefore(samples: TimedNumericSample[], atUtc: string): TimedNumericSample | undefined {
  const at = Date.parse(atUtc)
  return samples.filter((sample) => Date.parse(sample.observedAtUtc) <= at).sort((left, right) => Date.parse(left.observedAtUtc) - Date.parse(right.observedAtUtc)).at(-1)
}

function stateAt(history: RawExplorerSignalHistory, atUtc: string): { value: RawTelemetryScalar; observedAtUtc: string } | undefined {
  const candidates = [history.seed, ...history.changes].filter((item) => item && Date.parse(item.observedAtUtc) <= Date.parse(atUtc)).sort((a, b) => Date.parse(a!.observedAtUtc) - Date.parse(b!.observedAtUtc))
  const item = candidates.at(-1)
  return item ? { value: item.value, observedAtUtc: item.observedAtUtc } : undefined
}

function rawObservationAt(history: RawUnmappedHistory, atUtc: string) {
  return history.observations.filter((item) => Date.parse(item.timestampUtc) <= Date.parse(atUtc)).sort((a, b) => Date.parse(a.timestampUtc) - Date.parse(b.timestampUtc)).at(-1)
}

const CATEGORY_LABELS: Record<RawExplorerCategory, string> = {
  speed: 'Speed', web_tension: 'Web / Tension', dryer: 'Dryer', ink: 'Deck State', viscosity: 'Ink / Viscosity', temperature: 'Temperature', pump: 'Pump / Wash', wash: 'Pump / Wash', register: 'Register', impression: 'Impression', torque: 'Drive / Torque', drive_temperature: 'Drive / Torque', doctor_blade: 'Doctor Blade', repeat_other: 'Repeat / Other', motion: 'Motion',
}

const CATEGORY_ORDER = ['Speed', 'Web / Tension', 'Dryer', 'Ink / Viscosity', 'Temperature', 'Pump / Wash', 'Register', 'Impression', 'Anilox', 'Plate Cylinder', 'Doctor Blade', 'Repeat / Other', 'Deck State', 'Drive / Torque', 'Motion']

export function rawExplorerCategoryLabel(signal: Pick<RawExplorerChangedSignal, 'canonicalId' | 'category'>): string {
  if (signal.category === 'torque' || signal.category === 'drive_temperature') {
    if (signal.canonicalId.startsWith('anilox.')) return 'Anilox'
    if (signal.canonicalId.startsWith('plate_cylinder.')) return 'Plate Cylinder'
  }
  return CATEGORY_LABELS[signal.category]
}

export interface RawExplorerScopeGroup {
  key: string
  label: string
  deckNumber: number | null
  signalCount: number
  categories: Array<{ label: string; signals: RawExplorerChangedSignal[] }>
}

export function groupRawExplorerSignals(signals: RawExplorerChangedSignal[]): RawExplorerScopeGroup[] {
  const scopes = new Map<string, RawExplorerScopeGroup>()
  for (const signal of signals) {
    const deckNumber = signal.deckNumber
    const key = deckNumber === null ? 'machine' : `deck:${deckNumber}`
    const scope = scopes.get(key) ?? { key, label: deckNumber === null ? 'Machine' : `Deck ${deckNumber}`, deckNumber, signalCount: 0, categories: [] }
    const categoryLabel = rawExplorerCategoryLabel(signal)
    const category = scope.categories.find(({ label }) => label === categoryLabel) ?? { label: categoryLabel, signals: [] }
    if (!scope.categories.includes(category)) scope.categories.push(category)
    category.signals.push(signal)
    scope.signalCount += 1
    scopes.set(key, scope)
  }
  return [...scopes.values()].sort((left, right) => (left.deckNumber ?? 0) - (right.deckNumber ?? 0)).map((scope) => ({ ...scope, categories: scope.categories.sort((left, right) => CATEGORY_ORDER.indexOf(left.label) - CATEGORY_ORDER.indexOf(right.label)) }))
}

export function rawExplorerNumericPresentation(summary: RawExplorerNumericSummary) {
  const direction = summary.netDelta > 0 ? '↑' : summary.netDelta < 0 ? '↓' : '—'
  const positive = Math.abs(summary.largestPositiveExcursion)
  const negative = Math.abs(summary.largestNegativeExcursion)
  const biggestDirection = positive > negative ? '↑' : negative > positive ? '↓' : summary.largestAbsoluteExcursion ? '↕' : '—'
  return {
    started: formatRawExplorerNumber(summary.firstValue), ended: formatRawExplorerNumber(summary.lastValue),
    overall: summary.netDelta === 0 ? 'No overall change' : `${direction} ${formatRawExplorerNumber(Math.abs(summary.netDelta))} overall`,
    lowest: formatRawExplorerNumber(summary.minimum), highest: formatRawExplorerNumber(summary.maximum),
    biggestMove: summary.largestAbsoluteExcursion === 0 ? 'No move from the start' : `${biggestDirection} ${formatRawExplorerNumber(summary.largestAbsoluteExcursion)}`,
  }
}

export function rawExplorerStatePresentation(summary: RawExplorerStateSummary) {
  return { sequence: [summary.firstValue, ...summary.transitions.map(({ value }) => value)].map((value) => scalarLabel(value)).join(' → '), changes: summary.transitions.length }
}

function formatCrosshairTime(value: string): string {
  return DateTime.fromISO(value, { zone: 'utc' }).setZone(PLANT_TIME_ZONE).toFormat('h:mm:ss a')
}

export function RawExplorerInspectionTooltip({ atUtc, detail, histories, rawHistories = [] }: { atUtc: string; detail: RawExplorerDetail; histories: RawExplorerSignalHistory[]; rawHistories?: RawUnmappedHistory[] }) {
  const radius = detail.radiusSegments.find((item) => Date.parse(item.startUtc) <= Date.parse(atUtc) && Date.parse(item.endUtc) > Date.parse(atUtc))
  const currentRoll = detail.currentRollLength ? latestNumericAtOrBefore(rawExplorerNumberSamples(detail.currentRollLength), atUtc) : undefined
  const speedSamples = detail.speed.samples.flatMap((sample): TimedNumericSample[] => typeof sample.value === 'number' ? [{ ...sample, valueKind: Number.isInteger(sample.value) ? 'integer' : 'numeric', value: sample.value }] : [])
  const speed = latestNumericAtOrBefore(speedSamples, atUtc)
  return <div className="raw-inspection-tooltip">
    <header><span>Wall-clock time</span><strong>{formatCrosshairTime(atUtc)} CT</strong></header>
    <dl>
      <div><dt>Current Roll Length</dt><dd>{currentRoll ? scalarLabel(currentRoll.value) : 'Unavailable'}{currentRoll && <small>Last observed: {formatCrosshairTime(currentRoll.observedAtUtc)} CT</small>}</dd></div>
      <div><dt>Radius</dt><dd>{radius?.kind === 'radius' ? `${radius.eventType} / ${radius.statusCode ?? '—'} / ${radius.statusDescription}` : radius ? 'Data unavailable' : 'No observed state'}</dd></div>
      <div><dt>Actual Speed</dt><dd>{speed ? scalarLabel(speed.value) : 'No observed value yet'}{speed && <small>Last observed: {formatCrosshairTime(speed.observedAtUtc)} CT</small>}</dd></div>
      {histories.map((history) => { const observed = history.signalType === 'state_event' ? stateAt(history, atUtc) : latestNumericAtOrBefore(rawExplorerNumberSamples(history), atUtc); return <div key={signalKey(history)}><dt>{signalLabel(history)}</dt><dd>{observed ? scalarLabel(observed.value) : 'No observed value yet'}{observed && <small>Last observed: {formatCrosshairTime(observed.observedAtUtc)} CT</small>}</dd></div> })}
      {rawHistories.map((history) => { const observed = rawObservationAt(history, atUtc); return <div key={rawSignalKey(history)}><dt>{rawSignalLabel(history)}</dt><dd>{observed ? rawValueLabel(observed.rawValue) : 'No observed value yet'}{observed && <small>Supporting observation: {formatCrosshairTime(observed.timestampUtc)} CT</small>}</dd></div> })}
    </dl>
  </div>
}

function timelineHue(value: string): string {
  let hash = 0
  for (const character of value) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0
  return `hsl(${Math.abs(hash) % 360} 58% 46%)`
}

function setupFromUrl(identities: RawExplorerIdentity[]): { range: SelectedRange; phase: RawRadiusPhase; identity?: RawExplorerIdentity; lookback: string; context: string } {
  const query = new URLSearchParams(window.location.search)
  const range = restoreSelectedRange(query.get('fromUtc'), query.get('toUtc'), query.get('preset')) ?? createPresetRange('last24')
  const phase = (['G', 'B', 'M', 'S'].includes(query.get('phase') ?? '') ? query.get('phase') : 'G') as RawRadiusPhase
  const identity = identities.find((item) => item.eventType === phase && item.statusCode === query.get('statusCode') && item.statusDescription === query.get('statusDescription'))
  return { range, phase, identity, lookback: query.get('lookback') ?? String(DEFAULT_RAW_EXPLORER_LOOKBACK_MINUTES), context: query.get('context') ?? String(DEFAULT_RAW_EXPLORER_CONTEXT_MINUTES) }
}

export function filterRawExplorerIdentities(identities: RawExplorerIdentity[], phase: RawRadiusPhase, search: string): RawExplorerIdentity[] {
  const query = search.trim().toLowerCase()
  return identities.filter((identity) => identity.eventType === phase && (!query || `${identity.eventType} / ${identity.statusCode} / ${identity.statusDescription}`.toLowerCase().includes(query)))
}

function explorerUrl(range: SelectedRange, identity: RawExplorerIdentity, lookback: number, context: number): string {
  const query = new URLSearchParams({ preset: range.preset, fromUtc: range.fromUtc, toUtc: range.toUtc, phase: identity.eventType, statusCode: identity.statusCode, statusDescription: identity.statusDescription, lookback: String(lookback), context: String(context) })
  return `/raw-radius-explorer?${query}`
}

function setupSignature(range: SelectedRange, identity: RawExplorerIdentity | undefined, lookback: string | number, context: string | number): string {
  return `${range.fromUtc}|${range.toUtc}|${identity?.identity ?? ''}|${lookback}|${context}`
}

export function rawExplorerOccurrenceWindowKey(occurrence: RawExplorerOccurrence, lookbackMinutes: number, contextMinutes: number): string {
  return `${occurrence.occurrenceId}|${occurrence.chartFromUtc}|${occurrence.chartToUtc}|${lookbackMinutes}|${contextMinutes}`
}

export function validateRawExplorerWindow(value: string, label: string, allowZero: boolean): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < (allowZero ? 0 : 1)) throw new Error(`${label} must be a whole number of minutes${allowZero ? ' at or above 0' : ' above 0'}.`)
  if (parsed > MAX_WINDOW_MINUTES) throw new Error(`${label} cannot exceed ${MAX_WINDOW_MINUTES.toLocaleString()} minutes (24 hours).`)
  return parsed
}

const RAW_CATEGORY_ORDER = ['Production / Roll', 'Web / Tension', 'Dryer / Air / Temperature', 'Ink / Viscosity', 'Drive / Machine State', 'Deck', 'State / Event', 'Auxiliary Equipment', 'Other', 'Containers / Arrays']

export function groupRawUnmappedSignals(signals: RawUnmappedChangedSignal[]) {
  const grouped = new Map<string, RawUnmappedChangedSignal[]>()
  for (const signal of signals.filter(({ reviewStatus }) => reviewStatus !== 'IGNORE')) grouped.set(signal.discoveryCategory, [...(grouped.get(signal.discoveryCategory) ?? []), signal])
  const categories = [...grouped].map(([category, values]) => ({ category, signals: values })).sort((left, right) => {
    const leftOrder = RAW_CATEGORY_ORDER.indexOf(left.category); const rightOrder = RAW_CATEGORY_ORDER.indexOf(right.category)
    return (leftOrder < 0 ? RAW_CATEGORY_ORDER.length : leftOrder) - (rightOrder < 0 ? RAW_CATEGORY_ORDER.length : rightOrder) || left.category.localeCompare(right.category)
  })
  return { categories, ignored: signals.filter(({ reviewStatus }) => reviewStatus === 'IGNORE') }
}

export type RawExplorerSidebarTab = 'all' | 'canonical' | 'raw'
export interface RawExplorerBrowserItem {
  key: string
  kind: 'canonical' | 'raw'
  label: string
  plottable: boolean
  searchText: string
}

export function filterRawExplorerBrowserItems(items: RawExplorerBrowserItem[], tab: RawExplorerSidebarTab, search: string) {
  const query = search.trim().toLowerCase()
  return items.filter((item) => (tab === 'all' || item.kind === tab) && (!query || item.searchText.toLowerCase().includes(query)))
}

export function adjacentPreviewKey(items: RawExplorerBrowserItem[], currentKey: string | undefined, direction: -1 | 1) {
  const plottable = items.filter(({ plottable }) => plottable)
  if (!plottable.length) return undefined
  const currentIndex = plottable.findIndex(({ key }) => key === currentKey)
  const nextIndex = currentIndex < 0 ? (direction > 0 ? 0 : plottable.length - 1) : (currentIndex + direction + plottable.length) % plottable.length
  return plottable[nextIndex]?.key
}

export function investigationTrackKeys(pinnedKeys: string[], previewKey: string | undefined) {
  return [...pinnedKeys, ...(previewKey && !pinnedKeys.includes(previewKey) ? [previewKey] : [])]
}

function RawPinButton({ pinned, plotting, onPin }: { pinned: boolean; plotting: boolean; onPin: () => void }) {
  return <button type="button" className={`secondary-action raw-pin-action${pinned ? ' is-active' : ''}`} disabled={plotting} aria-pressed={pinned} onClick={(event) => { event.stopPropagation(); onPin() }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4h6l-1 5 3 3v1H7v-1l3-3-1-5Zm3 9v7" /></svg><span>{plotting ? 'Loading…' : pinned ? 'Unpin' : 'Pin'}</span></button>
}

function CanonicalSignalRow({ signal, selected, pinned, plotting, onPreview, onPin }: { signal: RawExplorerChangedSignal; selected: boolean; pinned: boolean; plotting: boolean; onPreview: () => void; onPin: () => void }) {
  const alreadyShown = signal.canonicalId === CURRENT_ROLL_LENGTH_CANONICAL_ID && signal.deckNumber === null
  const summary = signal.summary
  const numeric = summary.kind === 'numeric' ? rawExplorerNumericPresentation(summary) : undefined
  const state = summary.kind === 'state' ? rawExplorerStatePresentation(summary) : undefined
  return <div className={`raw-change-row raw-browser-row ${selected ? 'is-previewed' : ''} ${pinned ? 'is-pinned' : ''}`.trim()} data-canonical-id={signal.canonicalId} data-signal-type={signal.signalType} role="button" tabIndex={0} aria-pressed={selected} onClick={onPreview} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onPreview() } }}>
    <div><div className="raw-signal-heading"><strong>{signal.friendlyName}</strong>{selected && <span>{alreadyShown ? 'Selected' : 'Preview'}</span>}{pinned && <span>Pinned</span>}</div><small>{signal.canonicalId}</small>{numeric && <div className="raw-numeric-summary"><span>Started <b>{numeric.started}</b></span><span>Ended <b>{numeric.ended}</b></span><strong>{numeric.overall}</strong><span>Lowest <b>{numeric.lowest}</b></span><span>Highest <b>{numeric.highest}</b></span><span>Biggest move <b>{numeric.biggestMove}</b></span></div>}{state && <div className="raw-state-summary"><span>Changed</span><strong>{state.sequence}</strong><small>{state.changes} {state.changes === 1 ? 'change' : 'changes'}</small></div>}</div>
    <div className="raw-row-actions">{alreadyShown ? <span className="raw-row-status">Already shown</span> : <RawPinButton pinned={pinned} plotting={plotting} onPin={onPin} />}</div>
  </div>
}

function RawUnmappedSignalRow({ signal, selected, pinned, plotting, reviewing, onPreview, onPin, onReview }: { signal: RawUnmappedChangedSignal; selected: boolean; pinned: boolean; plotting: boolean; reviewing: boolean; onPreview: () => void; onPin: () => void; onReview: (status: RawTelemetryReviewStatus) => void }) {
  const numeric = typeof signal.firstValue === 'number' && typeof signal.lastValue === 'number'
  const stateSequence = signal.transitionSequence.length ? signal.transitionSequence : [signal.firstValue, signal.lastValue]
  const unit = safeEngineeringSourceUnit({ sourceUnit: signal.sourceUnit })
  return <div className={`raw-change-row raw-unmapped-row raw-browser-row ${selected ? 'is-previewed' : ''} ${pinned ? 'is-pinned' : ''}`.trim()} data-raw-identity={signal.rawIdentity} data-data-kind={signal.dataKind} role="button" tabIndex={0} aria-pressed={selected} onClick={onPreview} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onPreview() } }}>
    <div><div className="raw-signal-heading"><strong>{signal.displayName}</strong><span>RAW / UNMAPPED</span>{selected && <span>{signal.plottable && signal.dataKind !== 'container' ? 'Preview' : 'Selected'}</span>}{pinned && <span>Pinned</span>}</div>
      <small>{signal.discoveryCategory}{unit ? ` · ${unit} (raw / unverified)` : ' · Unit unverified'}</small>
      {signal.dataKind === 'container' ? <div className="raw-state-summary"><span>Container changed</span><strong>Not yet expanded</strong>{signal.knownShape && <small>{signal.knownShape}</small>}</div> : numeric ? <div className="raw-numeric-summary"><span>Started <b>{formatRawExplorerNumber(signal.firstValue as number)}</b></span><span>Ended <b>{formatRawExplorerNumber(signal.lastValue as number)}</b></span><strong>{(signal.lastValue as number) === (signal.firstValue as number) ? 'No overall change' : `${(signal.lastValue as number) > (signal.firstValue as number) ? '↑' : '↓'} ${formatRawExplorerNumber(Math.abs((signal.lastValue as number) - (signal.firstValue as number)))} overall`}</strong><span>Lowest <b>{signal.minimum === null ? 'Unavailable' : formatRawExplorerNumber(signal.minimum)}</b></span><span>Highest <b>{signal.maximum === null ? 'Unavailable' : formatRawExplorerNumber(signal.maximum)}</b></span></div> : <div className="raw-state-summary"><span>Changed</span><strong>{stateSequence.map((value) => rawValueLabel(value)).join(' → ')}{signal.transitionSequenceTruncated ? ' → …' : ''}</strong><small>{signal.changeCount} {signal.changeCount === 1 ? 'change' : 'changes'}</small></div>}
      <details className="raw-identity-detail"><summary>Exact raw identity</summary><code>{signal.rawIdentity}</code></details>
    </div>
    <div className="raw-row-actions"><label onClick={(event) => event.stopPropagation()}>Review<select aria-label={`Review ${signal.displayName}`} value={signal.reviewStatus} disabled={reviewing} onClick={(event) => event.stopPropagation()} onChange={(event) => { event.stopPropagation(); onReview(event.target.value as RawTelemetryReviewStatus) }}><option value="UNREVIEWED">Unreviewed</option><option value="USEFUL">Useful</option><option value="NEEDS_MAPPING">Needs Mapping</option><option value="IGNORE">Ignore</option></select></label>
      {signal.plottable && signal.dataKind !== 'container' && <RawPinButton pinned={pinned} plotting={plotting} onPin={onPin} />}
    </div>
  </div>
}

function OccurrenceCard({ occurrence, lookbackMinutes, contextMinutes, expanded, onToggle }: { occurrence: RawExplorerOccurrence; lookbackMinutes: number; contextMinutes: number; expanded: boolean; onToggle: () => void }) {
  const [detail, setDetail] = useState<RawExplorerDetail>()
  const [detailError, setDetailError] = useState<string>()
  const [detailLoading, setDetailLoading] = useState(false)
  const detailRequested = useRef(false)
  const [detailAttempt, setDetailAttempt] = useState(0)
  const [plotError, setPlotError] = useState<string>()
  const [plotting, setPlotting] = useState<Set<string>>(new Set())
  const cache = useRef(new Map<string, RawExplorerPlotResult>())
  const [rawPlotting, setRawPlotting] = useState<Set<string>>(new Set())
  const rawCache = useRef(new Map<string, RawUnmappedPlotResult>())
  const [reviewing, setReviewing] = useState<Set<string>>(new Set())
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [sidebarTab, setSidebarTab] = useState<RawExplorerSidebarTab>('all')
  const [telemetrySearch, setTelemetrySearch] = useState('')
  const [selectedBrowserKey, setSelectedBrowserKey] = useState<string>()
  const [previewKey, setPreviewKey] = useState<string>()
  const [pinnedKeys, setPinnedKeys] = useState<string[]>([])
  const sidebarRef = useRef<HTMLElement>(null)
  const sidebarScrollTop = useRef(0)

  useEffect(() => {
    if (!expanded || detail || detailRequested.current) return
    detailRequested.current = true
    const controller = new AbortController()
    setDetailError(undefined); setDetailLoading(true)
    void detailQueue.run(() => getRawRadiusOccurrenceDetail(occurrence, lookbackMinutes, controller.signal)).then((next) => { if (!controller.signal.aborted) setDetail(next) }).catch((error) => { detailRequested.current = false; if (error?.name !== 'AbortError') setDetailError('This occurrence could not load. No other occurrence telemetry was requested at the same time.') }).finally(() => { if (!controller.signal.aborted) setDetailLoading(false) })
    return () => { controller.abort(); detailRequested.current = false; setDetailLoading(false) }
  }, [expanded, detail, detailAttempt, occurrence, lookbackMinutes])

  function retryDetail() {
    detailRequested.current = false
    setDetail(undefined); setDetailError(undefined); setDetailLoading(false)
    setDetailAttempt((current) => current + 1)
  }

  async function ensureCanonicalHistory(signal: RawExplorerChangedSignal): Promise<boolean> {
    const key = signalKey(signal)
    if (cache.current.has(key)) return true
    setPlotError(undefined)
    setPlotting((current) => new Set(current).add(key))
    try {
      const response = await plotQueue.run(() => plotRawRadiusSignal(occurrence, signal))
      cache.current.set(key, response)
      return true
    } catch { setPlotError(`${signalLabel(signal)} could not be plotted. Existing tracks remain available.`) }
    finally { setPlotting((current) => { const next = new Set(current); next.delete(key); return next }) }
    return false
  }

  async function ensureRawHistory(signal: RawUnmappedChangedSignal): Promise<boolean> {
    const key = rawSignalKey(signal)
    if (!signal.plottable || signal.dataKind === 'container') return false
    if (rawCache.current.has(key)) return true
    setPlotError(undefined); setRawPlotting((current) => new Set(current).add(key))
    try {
      const response = await plotQueue.run(() => plotRawUnmappedSignal(occurrence, signal.rawIdentity))
      rawCache.current.set(key, response)
      return true
    } catch { setPlotError(`${rawSignalLabel(signal)} could not be plotted. Existing tracks remain available.`) }
    finally { setRawPlotting((current) => { const next = new Set(current); next.delete(key); return next }) }
    return false
  }

  async function updateReview(signal: RawUnmappedChangedSignal, reviewStatus: RawTelemetryReviewStatus) {
    const key = rawSignalKey(signal); setReviewing((current) => new Set(current).add(key)); setPlotError(undefined)
    try {
      const saved = await setRawTelemetryReview(occurrence.pressKey, signal.rawIdentity, reviewStatus)
      setDetail((current) => current ? { ...current, rawTelemetry: { ...current.rawTelemetry, signals: current.rawTelemetry.signals.map((item) => item.rawIdentity === signal.rawIdentity ? { ...item, reviewStatus: saved.reviewStatus } : item) } } : current)
      const cached = rawCache.current.get(key)
      if (cached) rawCache.current.set(key, { ...cached, signal: { ...cached.signal, reviewStatus: saved.reviewStatus } })
    } catch { setPlotError(`${signal.displayName} review status could not be saved.`) }
    finally { setReviewing((current) => { const next = new Set(current); next.delete(key); return next }) }
  }

  const canonicalSignals = detail?.changedSignals ?? []
  const rawSignals = detail?.rawTelemetry.signals ?? []
  const browserItems: RawExplorerBrowserItem[] = [
    ...canonicalSignals.map((signal) => ({ key: signalKey(signal), kind: 'canonical' as const, label: signalLabel(signal), plottable: !(signal.canonicalId === CURRENT_ROLL_LENGTH_CANONICAL_ID && signal.deckNumber === null), searchText: [signal.friendlyName, signal.canonicalId, signal.category, signal.scope, signal.deckNumber === null ? 'Machine' : `Deck ${signal.deckNumber}`].join(' ') })),
    ...rawSignals.map((signal) => ({ key: rawSignalKey(signal), kind: 'raw' as const, label: rawSignalLabel(signal), plottable: signal.plottable && signal.dataKind !== 'container', searchText: [signal.displayName, signal.rawIdentity, signal.discoveryCategory, signal.dataKind].join(' ') }))
  ]
  const filteredBrowserItems = filterRawExplorerBrowserItems(browserItems, sidebarTab, telemetrySearch)
  const filteredKeys = new Set(filteredBrowserItems.map((item) => item.key))
  const filteredCanonicalSignals = canonicalSignals.filter((signal) => filteredKeys.has(signalKey(signal)))
  const filteredRawSignals = rawSignals.filter((signal) => filteredKeys.has(rawSignalKey(signal)))
  const groups = groupRawExplorerSignals(filteredCanonicalSignals)
  const rawGroups = groupRawUnmappedSignals(filteredRawSignals)
  const investigationKeys = investigationTrackKeys(pinnedKeys, previewKey)
  const histories = investigationKeys.flatMap((key) => cache.current.get(key)?.signal ?? [])
  const rawHistories = investigationKeys.flatMap((key) => rawCache.current.get(key)?.signal ?? [])
  const previewCandidates = filteredBrowserItems.filter((item) => item.plottable)
  const previewIndex = previewCandidates.findIndex((item) => item.key === previewKey)

  function browserItemFor(key: string) { return browserItems.find((item) => item.key === key) }
  function canonicalSignalFor(key: string) { return canonicalSignals.find((signal) => signalKey(signal) === key) }
  function rawSignalFor(key: string) { return rawSignals.find((signal) => rawSignalKey(signal) === key) }

  async function previewBrowserItem(item: RawExplorerBrowserItem) {
    setSelectedBrowserKey(item.key)
    if (!item.plottable) { setPreviewKey(undefined); return }
    const loaded = item.kind === 'canonical'
      ? await ensureCanonicalHistory(canonicalSignalFor(item.key)!)
      : await ensureRawHistory(rawSignalFor(item.key)!)
    if (loaded) setPreviewKey(item.key)
  }

  async function togglePinnedItem(item: RawExplorerBrowserItem) {
    if (!item.plottable) return
    if (pinnedKeys.includes(item.key)) { setPinnedKeys((current) => current.filter((key) => key !== item.key)); return }
    const loaded = item.kind === 'canonical'
      ? await ensureCanonicalHistory(canonicalSignalFor(item.key)!)
      : await ensureRawHistory(rawSignalFor(item.key)!)
    if (loaded) setPinnedKeys((current) => current.includes(item.key) ? current : [...current, item.key])
  }

  function movePreview(direction: -1 | 1) {
    const key = adjacentPreviewKey(filteredBrowserItems, previewKey, direction)
    const item = key ? browserItemFor(key) : undefined
    if (item) void previewBrowserItem(item)
  }

  function hideSidebar() {
    sidebarScrollTop.current = sidebarRef.current?.scrollTop ?? 0
    setSidebarOpen(false)
  }

  function showSidebar() {
    setSidebarOpen(true)
    requestAnimationFrame(() => { if (sidebarRef.current) sidebarRef.current.scrollTop = sidebarScrollTop.current })
  }

  const canonicalLabel = (history: RawExplorerSignalHistory) => `${previewKey === signalKey(history) && !pinnedKeys.includes(previewKey) ? 'PREVIEW · ' : ''}${signalLabel(history)}`
  const rawLabel = (history: RawUnmappedHistory) => `${previewKey === rawSignalKey(history) && !pinnedKeys.includes(previewKey) ? 'PREVIEW · ' : ''}${rawSignalLabel(history)}`
  const radiusTrack: TimelineIntervalTrack = { id: 'raw-radius', label: 'Raw Radius context', intervals: (detail?.radiusSegments ?? []).map((segment) => ({ id: `${segment.pressKey}:${segment.startUtc}`, startUtc: segment.startUtc, endUtc: segment.endUtc, label: segment.kind === 'offline' ? 'Offline / unavailable' : `${segment.eventType} / ${segment.statusCode ?? '—'}`, details: segment.kind === 'offline' ? 'Radius data unavailable' : `${segment.eventType} / ${segment.statusCode ?? '—'} · ${segment.statusDescription}`, unavailable: segment.kind === 'offline', style: segment.kind === 'radius' ? { background: timelineHue(`${segment.eventType}|${segment.statusCode}|${segment.statusDescription}`) } : undefined })) }
  const intervalTracks: TimelineIntervalTrack[] = [radiusTrack, ...histories.filter((item) => item.signalType === 'state_event').map((history) => ({ id: signalKey(history), label: canonicalLabel(history), intervals: rawExplorerStateIntervals(history, occurrence) })), ...rawHistories.filter((item) => item.dataKind !== 'numeric').map((history) => ({ id: rawSignalKey(history), label: rawLabel(history), intervals: rawUnmappedStateIntervals(history, occurrence) }))]
  const speedSamples = (detail?.speed.samples ?? []).flatMap((sample): TimedNumericSample[] => typeof sample.value === 'number' ? [{ ...sample, valueKind: Number.isInteger(sample.value) ? 'integer' : 'numeric', value: sample.value }] : [])
  const currentRollSamples = detail?.currentRollLength ? rawExplorerNumberSamples(detail.currentRollLength) : []
  const numericTracks: TimelineNumericTrack[] = [{ id: 'current-roll-length', label: 'Current Roll Length', unit: 'Unit unverified', samples: currentRollSamples, interpolation: 'step', connectObservedGaps: true, holdLastObservation: true, unavailableLabel: 'Current Roll Length unavailable' }, { id: 'actual-speed', label: 'Actual speed', unit: evidenceUnit(detail?.speed.sourceUnit ?? null), samples: speedSamples, interpolation: 'step', connectObservedGaps: true, holdLastObservation: true, unavailableLabel: 'No actual-speed observation is available for this chart context' }, ...histories.filter((item) => item.signalType !== 'state_event').map((history) => ({ id: signalKey(history), label: canonicalLabel(history), unit: rawExplorerEvidenceUnit(history), samples: rawExplorerNumberSamples(history), interpolation: 'step' as const, connectObservedGaps: true, holdLastObservation: true, unavailableLabel: 'No observed value is available for this chart context' })), ...rawHistories.filter((item) => item.dataKind === 'numeric').map((history) => ({ id: rawSignalKey(history), label: rawLabel(history), unit: evidenceUnit(history.sourceUnit), samples: rawUnmappedNumberSamples(history), interpolation: 'step' as const, connectObservedGaps: true, holdLastObservation: true, unavailableLabel: 'No observed raw value is available for this chart context' }))]
  const trackOrder = ['numeric:current-roll-length', 'interval:raw-radius', 'numeric:actual-speed', ...histories.map((history) => `${history.signalType === 'state_event' ? 'interval' : 'numeric'}:${signalKey(history)}`), ...rawHistories.map((history) => `${history.dataKind === 'numeric' ? 'numeric' : 'interval'}:${rawSignalKey(history)}`)]
  const selectedRadiusId = detail?.radiusSegments.find((segment) => segment.kind === 'radius' && segment.startUtc === occurrence.startUtc && segment.endUtc === occurrence.endUtc) ? `${occurrence.pressKey}:${occurrence.startUtc}` : undefined
  return <article className={`raw-occurrence-card ${expanded ? 'is-expanded' : 'is-collapsed'}`}>
    <button type="button" className="raw-occurrence-card__header" aria-expanded={expanded} onClick={onToggle}><div><span>{occurrence.displayName} · occurrence {occurrence.pressOccurrenceIndex} of {occurrence.pressOccurrenceCount}</span><h3>{occurrence.eventType} / {occurrence.statusCode} / {occurrence.statusDescription}</h3><small>Change Lookback {lookbackMinutes}m · Chart Context {contextMinutes}m before and after</small></div><div><strong>{durationLabel(occurrence.durationSeconds)}</strong><small>{formatPlantDateTime(occurrence.startUtc)}–{formatPlantDateTime(occurrence.endUtc)} CT</small><span className="raw-occurrence-toggle">{expanded ? 'Hide evidence' : 'Open evidence'} <b aria-hidden="true">⌄</b></span></div></button>
    {expanded && detailLoading && <div className="raw-occurrence-placeholder" role="status"><strong>Scanning this occurrence…</strong><span>Checking the full {lookbackMinutes}-minute telemetry lookback. Other occurrences are paused.</span></div>}
    {expanded && detailError && <div className="scope-progress scope-progress--error" role="alert"><span>{detailError}</span><button type="button" className="secondary-action" onClick={retryDetail}>Retry evidence</button></div>}
    {expanded && detail && <>
      <div className={`raw-investigation-workspace${sidebarOpen ? '' : ' is-sidebar-collapsed'}`}>
        <section className="raw-chart-workspace">
          <div className="raw-chart-workspace__sticky">
            <div className="raw-pinned-strip"><strong>Pinned</strong>{!pinnedKeys.length && <span>Pin signals from the telemetry browser to compare them here.</span>}{pinnedKeys.map((key) => { const item = browserItemFor(key); return item && <button type="button" key={key} onClick={() => void togglePinnedItem(item)}>{item.label}<span aria-hidden="true">×</span></button> })}</div>
            <div className="raw-preview-navigator"><div><span className="eyebrow">Temporary trace</span><strong>{previewKey ? browserItemFor(previewKey)?.label : 'Select a telemetry row to preview it'}</strong></div><div><span>{previewIndex >= 0 ? `${previewIndex + 1} of ${previewCandidates.length}` : `${previewCandidates.length} available`}</span><button type="button" aria-label="Previous filtered telemetry signal" disabled={!previewCandidates.length} onClick={() => movePreview(-1)}>‹</button><button type="button" aria-label="Next filtered telemetry signal" disabled={!previewCandidates.length} onClick={() => movePreview(1)}>›</button></div></div>
            <SynchronizedTimeline fromUtc={occurrence.chartFromUtc} toUtc={occurrence.chartToUtc} intervalTracks={intervalTracks} numericTracks={numericTracks} trackOrder={trackOrder} selectedId={selectedRadiusId} highlightedRange={{ fromUtc: occurrence.startUtc, toUtc: occurrence.endUtc, label: 'Selected raw Radius occurrence' }} renderInspectionTooltip={(atUtc) => <RawExplorerInspectionTooltip atUtc={atUtc} detail={detail} histories={histories} rawHistories={rawHistories} />} ariaLabel={`${occurrence.displayName} raw Radius occurrence and telemetry`} />
            {plotError && <div className="scope-progress scope-progress--error" role="alert">{plotError}</div>}
          </div>
        </section>
        <aside ref={sidebarRef} className="raw-telemetry-browser" aria-hidden={!sidebarOpen} onScroll={(event) => { sidebarScrollTop.current = event.currentTarget.scrollTop }}>
          <div className="raw-telemetry-browser__toolbar"><div><span className="eyebrow">Changed Before Radius Entry</span><strong>{filteredBrowserItems.length} of {browserItems.length} signals</strong><small>Strict half-open window · {formatPlantDateTime(detail.lookback.fromUtc)} to {formatPlantDateTime(detail.lookback.toUtc)} CT</small></div><button type="button" className="secondary-action" onClick={hideSidebar}>Hide</button>
            <div className="raw-browser-tabs" role="tablist" aria-label="Telemetry source"><button type="button" role="tab" aria-selected={sidebarTab === 'all'} onClick={() => setSidebarTab('all')}>All <span>{browserItems.length}</span></button><button type="button" role="tab" aria-selected={sidebarTab === 'canonical'} onClick={() => setSidebarTab('canonical')}>Canonical <span>{canonicalSignals.length}</span></button><button type="button" role="tab" aria-selected={sidebarTab === 'raw'} onClick={() => setSidebarTab('raw')}>Raw <span>{rawSignals.length}</span></button></div>
            <input type="search" aria-label="Search telemetry" value={telemetrySearch} onChange={(event) => setTelemetrySearch(event.target.value)} placeholder="Search name, ID, category, or deck" />
          </div>
          {!filteredBrowserItems.length && <p className="raw-empty">{telemetrySearch.trim() ? 'No telemetry matches this tab and search.' : 'No changed telemetry was found in this lookback for the selected source.'}</p>}
          {sidebarTab !== 'raw' && groups.map((group) => <details className="raw-change-scope" data-scope={group.key} key={group.key}><summary><strong>{group.label}</strong><span>{group.signalCount} changed</span></summary><div className="raw-change-categories">{group.categories.map((category) => <details className="raw-change-category" key={category.label}><summary><strong>{category.label}</strong><span>{category.signals.length}</span></summary>{category.signals.map((signal) => { const id = signalKey(signal); return <CanonicalSignalRow key={id} signal={signal} selected={selectedBrowserKey === id} pinned={pinnedKeys.includes(id)} plotting={plotting.has(id)} onPreview={() => void previewBrowserItem(browserItemFor(id)!)} onPin={() => void togglePinnedItem(browserItemFor(id)!)} /> })}</details>)}</div></details>)}
          {sidebarTab !== 'canonical' && <section className="raw-unmapped-section">
            {detail.rawTelemetry.status === 'unavailable' && <div className="raw-telemetry-unavailable" role="status"><strong>Raw/unmapped telemetry did not finish loading.</strong><span>This is not a zero-change result. Canonical evidence remains available, and you can retry this occurrence by itself.</span><button type="button" className="secondary-action" onClick={retryDetail}>Retry raw telemetry</button></div>}
            {rawGroups.categories.map(({ category, signals }) => <details className="raw-unmapped-category" key={category}><summary><strong>{category}</strong><span>{signals.length} changed</span></summary>{signals.map((signal) => { const key = rawSignalKey(signal); return <RawUnmappedSignalRow key={key} signal={signal} selected={selectedBrowserKey === key} pinned={pinnedKeys.includes(key)} plotting={rawPlotting.has(key)} reviewing={reviewing.has(key)} onPreview={() => void previewBrowserItem(browserItemFor(key)!)} onPin={() => void togglePinnedItem(browserItemFor(key)!)} onReview={(status) => void updateReview(signal, status)} /> })}</details>)}
            {!!rawGroups.ignored.length && <details className="raw-unmapped-category raw-ignored"><summary><strong>Ignored</strong><span>{rawGroups.ignored.length} recoverable</span></summary>{rawGroups.ignored.map((signal) => { const key = rawSignalKey(signal); return <RawUnmappedSignalRow key={key} signal={signal} selected={selectedBrowserKey === key} pinned={pinnedKeys.includes(key)} plotting={rawPlotting.has(key)} reviewing={reviewing.has(key)} onPreview={() => void previewBrowserItem(browserItemFor(key)!)} onPin={() => void togglePinnedItem(browserItemFor(key)!)} onReview={(status) => void updateReview(signal, status)} /> })}</details>}
          </section>}
        </aside>
        {!sidebarOpen && <button type="button" className="raw-telemetry-reopen" onClick={showSidebar}>‹ Telemetry <span>{filteredBrowserItems.length}</span></button>}
      </div>
      <details className="raw-card-diagnostics"><summary>Request diagnostics</summary><p>{detail.performance.selectorCount} discovery selectors · {detail.performance.semanticHistoryRequests} bounded history requests · {detail.performance.payloadBytes.toLocaleString()} response bytes · {Math.round(detail.performance.totalMs)} ms server time</p></details>
    </>}
  </article>
}

export function RawRadiusExplorerPage() {
  const [identities, setIdentities] = useState<RawExplorerIdentity[]>([])
  const [identityError, setIdentityError] = useState<string>()
  const initial = useMemo(() => setupFromUrl([]), [])
  const [range, setRange] = useState<SelectedRange>(initial.range)
  const [phase, setPhase] = useState<RawRadiusPhase>(initial.phase)
  const [selectedIdentity, setSelectedIdentity] = useState<RawExplorerIdentity>()
  const [search, setSearch] = useState('')
  const [lookback, setLookback] = useState(initial.lookback)
  const [context, setContext] = useState(initial.context)
  const customDefaults = useMemo(defaultCustomValues, [])
  const [customFrom, setCustomFrom] = useState(initial.range.customFromLocal ?? customDefaults.from)
  const [customTo, setCustomTo] = useState(initial.range.customToLocal ?? customDefaults.to)
  const [result, setResult] = useState<RawExplorerResult>()
  const [appliedSignature, setAppliedSignature] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [visibleCount, setVisibleCount] = useState(INITIAL_OCCURRENCE_COUNT)
  const [openOccurrenceId, setOpenOccurrenceId] = useState<string>()
  const [setupCollapsed, setSetupCollapsed] = useState(false)
  const restoredFromUrl = useRef(false)

  useEffect(() => {
    const controller = new AbortController()
    setIdentityError(undefined)
    void getRawRadiusIdentities(range.fromUtc, range.toUtc, controller.signal).then((values) => {
      setIdentities(values)
      if (!restoredFromUrl.current) {
        const restored = setupFromUrl(values)
        setPhase(restored.phase); setLookback(restored.lookback); setContext(restored.context); setSelectedIdentity(restored.identity)
        restoredFromUrl.current = true
      } else setSelectedIdentity((current) => values.find(({ identity }) => identity === current?.identity))
    }).catch(() => setIdentityError('Raw Radius identities could not be loaded.'))
    return () => controller.abort()
  }, [range.fromUtc, range.toUtc])

  useEffect(() => {
    if (!identities.length) return
    const onPopState = () => {
      if (window.location.pathname !== '/raw-radius-explorer') return
      const restored = setupFromUrl(identities)
      setRange(restored.range); setPhase(restored.phase); setLookback(restored.lookback); setContext(restored.context); setSelectedIdentity(restored.identity); setError(undefined); setVisibleCount(INITIAL_OCCURRENCE_COUNT)
      if (!restored.identity) { setResult(undefined); setAppliedSignature(undefined); setOpenOccurrenceId(undefined); setSetupCollapsed(false); return }
      try {
        const changeLookbackMinutes = validateRawExplorerWindow(restored.lookback, 'Change Lookback', false)
        const chartContextMinutes = validateRawExplorerWindow(restored.context, 'Chart Context', true)
        setLoading(true)
        void exploreRawRadius({ fromUtc: restored.range.fromUtc, toUtc: restored.range.toUtc, identity: { eventType: restored.identity.eventType, statusCode: restored.identity.statusCode, statusDescription: restored.identity.statusDescription }, changeLookbackMinutes, chartContextMinutes })
          .then((next) => { setResult(next); setOpenOccurrenceId(next.occurrences[0]?.occurrenceId); setAppliedSignature(setupSignature(restored.range, restored.identity, restored.lookback, restored.context)); setSetupCollapsed(true) })
          .catch(() => setError('The restored exploration could not be loaded.'))
          .finally(() => setLoading(false))
      } catch (caught) { setError(caught instanceof Error ? caught.message : 'The restored setup is invalid.') }
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [identities])

  const filteredIdentities = useMemo(() => filterRawExplorerIdentities(identities, phase, search), [identities, phase, search])
  const draftSignature = setupSignature(range, selectedIdentity, lookback, context)
  const settingsChanged = Boolean(result && appliedSignature !== draftSignature)

  function selectPreset(preset: 'last24' | 'custom') {
    if (preset === 'last24') { setRange(createPresetRange('last24')); setError(undefined); return }
    try { setRange(createCustomRange(customFrom, customTo)); setError(undefined) } catch (caught) { setError(caught instanceof RangeValidationError ? caught.message : 'Custom range is invalid.') }
  }

  async function runExplorer() {
    setError(undefined)
    try {
      if (!selectedIdentity) throw new Error('Choose an exact raw Radius code before exploring.')
      const changeLookbackMinutes = validateRawExplorerWindow(lookback, 'Change Lookback', false)
      const chartContextMinutes = validateRawExplorerWindow(context, 'Chart Context', true)
      const setup = { fromUtc: range.fromUtc, toUtc: range.toUtc, identity: { eventType: selectedIdentity.eventType, statusCode: selectedIdentity.statusCode, statusDescription: selectedIdentity.statusDescription }, changeLookbackMinutes, chartContextMinutes }
      setLoading(true)
      const next = await exploreRawRadius(setup)
      setResult(next); setOpenOccurrenceId(next.occurrences[0]?.occurrenceId); setAppliedSignature(draftSignature); setVisibleCount(INITIAL_OCCURRENCE_COUNT); setSetupCollapsed(true)
      window.history.pushState({}, '', explorerUrl(range, selectedIdentity, changeLookbackMinutes, chartContextMinutes))
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'The raw Radius exploration could not be completed.') }
    finally { setLoading(false) }
  }

  const visibleOccurrences = result?.occurrences.slice(0, visibleCount) ?? []
  let previousPress = ''
  return <div className="raw-radius-explorer-page">
    <section className={`panel raw-explorer-setup${setupCollapsed ? ' is-collapsed' : ''}`}>
      {result && <div className="raw-explorer-setup__collapsed" hidden={!setupCollapsed}><div><span className="eyebrow">Current exploration</span><strong>{result.setup.identity.eventType} / {result.setup.identity.statusCode} / {result.setup.identity.statusDescription}</strong><small>{result.summary.totalOccurrences.toLocaleString()} {result.summary.totalOccurrences === 1 ? 'occurrence' : 'occurrences'} · {formatPlantDateTime(result.setup.fromUtc)}–{formatPlantDateTime(result.setup.toUtc)} CT</small></div><button type="button" className="secondary-action raw-search-another" onClick={() => setSetupCollapsed(false)} aria-expanded={!setupCollapsed} aria-controls="raw-explorer-setup-fields"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.5 15.5 4 4" /></svg><span>Search another code</span></button></div>}
      <div id="raw-explorer-setup-fields" hidden={setupCollapsed}>
        <div className="raw-explorer-title"><div><span className="eyebrow">Read-only evidence workspace</span><h1>Raw Radius Code Explorer</h1><p>Choose an exact Radius-recorded state, find every occurrence, then compare its wall-clock context with actual speed and signals that changed immediately before entry.</p></div>{settingsChanged && <span className="settings-changed" role="status">Settings changed · Explore to apply</span>}</div>
        <div className="raw-setup-grid">
        <fieldset><legend>Time range</legend><div className="raw-choice-row"><button type="button" className={range.preset === 'last24' ? 'filter-chip active' : 'filter-chip'} onClick={() => selectPreset('last24')}>Last 24 hours</button><button type="button" className={range.preset === 'custom' ? 'filter-chip active' : 'filter-chip'} onClick={() => selectPreset('custom')}>Custom</button></div>{range.preset === 'custom' && <div className="raw-custom-range"><label>Start (CT)<input type="datetime-local" value={customFrom} onChange={(event) => setCustomFrom(event.target.value)} /></label><label>End (CT)<input type="datetime-local" value={customTo} onChange={(event) => setCustomTo(event.target.value)} /></label><button type="button" className="secondary-action" onClick={() => selectPreset('custom')}>Set custom range</button></div>}<small>{formatSelectedRange(range)}</small></fieldset>
        <fieldset><legend>Radius phase</legend><div className="raw-choice-row">{PHASES.map((item) => <button type="button" key={item.key} className={phase === item.key ? 'filter-chip active' : 'filter-chip'} onClick={() => { setPhase(item.key); setSelectedIdentity(undefined) }}>{item.label}</button>)}</div></fieldset>
        <fieldset className="raw-code-picker"><legend>Exact raw code</legend><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search code or recorded description" aria-label="Search exact raw Radius codes" />{identityError && <p role="alert">{identityError}</p>}<div className="raw-code-list" role="listbox" aria-label={`${phase} raw Radius codes`}>{filteredIdentities.map((identity) => <button type="button" role="option" aria-selected={selectedIdentity?.identity === identity.identity} className={selectedIdentity?.identity === identity.identity ? 'raw-code-option is-selected' : 'raw-code-option'} key={identity.identity} onClick={() => setSelectedIdentity(identity)}><strong>{identity.eventType} / {identity.statusCode}</strong><span>{identity.statusDescription}</span><small>{identity.eventCount.toLocaleString()} observed events</small></button>)}</div></fieldset>
        <fieldset className="raw-window-settings"><legend>Evidence windows</legend><label>Change Lookback (minutes)<input type="number" min="1" max={MAX_WINDOW_MINUTES} step="1" value={lookback} onChange={(event) => setLookback(event.target.value)} /><small>Signals are checked in [occurrence start − lookback, occurrence start).</small></label><label>Chart Context (minutes)<input type="number" min="0" max={MAX_WINDOW_MINUTES} step="1" value={context} onChange={(event) => setContext(event.target.value)} /><small>Surrounding time shown before and after each occurrence.</small></label><small>Maximum: 1,440 minutes (24 hours) per setting.</small></fieldset>
        </div>
        {error && <div className="scope-progress scope-progress--error" role="alert">{error}</div>}
        <div className="raw-explorer-actions">{selectedIdentity ? <div className="raw-selected-code"><span>Selected</span><strong>{selectedIdentity.eventType} / {selectedIdentity.statusCode}</strong><span>{selectedIdentity.statusDescription}</span></div> : <span className="raw-explorer-action-hint">Choose an exact Radius code to continue.</span>}<button type="button" className="primary-action raw-explore-action" onClick={() => void runExplorer()} disabled={loading || !identities.length || !selectedIdentity}>{loading ? 'Exploring…' : <><span>Explore</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14m-5-5 5 5-5 5" /></svg></>}</button></div>
      </div>
    </section>

    {result && <>
      <section className="panel raw-result-summary"><header><div><span className="eyebrow">Complete selected scope</span><h2>{result.setup.identity.eventType} / {result.setup.identity.statusCode} / {result.setup.identity.statusDescription}</h2><p>{formatPlantDateTime(result.setup.fromUtc)}–{formatPlantDateTime(result.setup.toUtc)} CT</p><p><strong>Change Lookback {result.setup.changeLookbackMinutes} minutes</strong> · <strong>Chart Context {result.setup.chartContextMinutes} minutes before and after</strong></p></div><span>{result.performance.payloadBytes.toLocaleString()} bytes · {Math.round(result.performance.totalMs)} ms</span></header><div className="raw-summary-metrics"><div><strong>{result.summary.totalOccurrences.toLocaleString()}</strong><span>Occurrences</span></div><div><strong>{result.summary.pressesContainingCode}</strong><span>Presses containing code</span></div><div><strong>{durationLabel(result.summary.totalObservedDurationSeconds)}</strong><span>Total observed duration</span></div></div><div className="raw-press-counts">{result.summary.pressCounts.map((press) => <span key={press.pressKey}><strong>{press.displayName}</strong> {press.occurrenceCount}</span>)}</div></section>
      {!result.occurrences.length && <section className="panel raw-empty"><h2>No occurrences found</h2><p>The exact raw identity was not observed in this time range.</p></section>}
      <section className="raw-occurrence-results" aria-label="Raw Radius occurrences">{visibleOccurrences.map((occurrence) => { const heading = occurrence.pressKey !== previousPress; previousPress = occurrence.pressKey; return <div key={rawExplorerOccurrenceWindowKey(occurrence, result.setup.changeLookbackMinutes, result.setup.chartContextMinutes)}>{heading && <h2 className="raw-press-heading">{occurrence.displayName}<span>{result.summary.pressCounts.find((press) => press.pressKey === occurrence.pressKey)?.occurrenceCount ?? 0} occurrences</span></h2>}<OccurrenceCard occurrence={occurrence} lookbackMinutes={result.setup.changeLookbackMinutes} contextMinutes={result.setup.chartContextMinutes} expanded={openOccurrenceId === occurrence.occurrenceId} onToggle={() => setOpenOccurrenceId((current) => current === occurrence.occurrenceId ? undefined : occurrence.occurrenceId)} /></div> })}</section>
      {visibleCount < result.occurrences.length && <div className="raw-load-more"><button type="button" className="secondary-action" onClick={() => setVisibleCount((current) => Math.min(result.occurrences.length, current + LOAD_MORE_COUNT))}>Load 20 more</button><span>Showing {visibleOccurrences.length} of {result.occurrences.length} occurrences</span></div>}
    </>}
  </div>
}
