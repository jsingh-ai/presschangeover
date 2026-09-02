import { DateTime } from 'luxon'
import type { PointerEvent } from 'react'
import { useEffect, useState } from 'react'
import { getPressDowntimePress } from '../api/process-intelligence-api'
import { createCustomRange, PLANT_TIME_ZONE, RangeValidationError } from '../time-ranges'
import type { RadiusPressKey } from '../types/api'
import type { PressDowntimeCategory, PressDowntimeJobGroup, PressDowntimePressReport, PressDowntimeSegment } from '../types/press-downtime'

export const PRESS_DOWNTIME_PRESS_KEYS: RadiusPressKey[] = ['press3', 'press5', 'press6', 'press7', 'press8', 'press9', 'press10', 'press11', 'press12', 'press13', 'press14', 'press15']
export const PRESS_DOWNTIME_MAX_RANGE_MS = 72 * 60 * 60_000
type PressDowntimePreset = 'last24' | 'last72' | 'custom'
export interface PressDowntimeRange { preset: PressDowntimePreset; fromUtc: string; toUtc: string; customFromLocal?: string; customToLocal?: string }
interface CardState { status: 'idle' | 'loading' | 'ready' | 'error'; report?: PressDowntimePressReport; error?: string }

export function createPressDowntimePresetRange(preset: 'last24' | 'last72', now = DateTime.now()): PressDowntimeRange {
  const to = now.toUTC(); const hours = preset === 'last72' ? 72 : 24
  return { preset, fromUtc: to.minus({ hours }).toISO()!, toUtc: to.toISO()! }
}

export function validPressDowntimeRange(fromUtc: string, toUtc: string): boolean {
  const duration = Date.parse(toUtc) - Date.parse(fromUtc)
  return Number.isFinite(duration) && duration > 0 && duration <= PRESS_DOWNTIME_MAX_RANGE_MS
}

function initialRange(): PressDowntimeRange {
  const query = new URLSearchParams(window.location.search); const fromUtc = query.get('fromUtc'); const toUtc = query.get('toUtc'); const preset = query.get('preset')
  if (fromUtc && toUtc && validPressDowntimeRange(fromUtc, toUtc)) return { preset: preset === 'last72' ? 'last72' : preset === 'last24' ? 'last24' : 'custom', fromUtc, toUtc }
  return createPressDowntimePresetRange('last24')
}

const duration = (value: number) => {
  const seconds = Math.max(0, Math.round(value)); const hours = Math.floor(seconds / 3_600); const minutes = Math.floor(seconds % 3_600 / 60); const remainder = seconds % 60
  return hours ? `${hours}h ${minutes}m` : minutes ? `${minutes}m ${remainder}s` : `${remainder}s`
}
const localTime = (value: string) => new Intl.DateTimeFormat('en-US', { timeZone: PLANT_TIME_ZONE, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(new Date(value))
const localInputTime = (value: string) => DateTime.fromISO(value).setZone(PLANT_TIME_ZONE).toFormat("yyyy-MM-dd'T'HH:mm")
const categoryLabel: Record<PressDowntimeCategory, string> = { CHANGEOVER: 'Changeover', GOOD_RUN: 'Good Run', DOWNTIME: 'Downtime', MISSING_DATA: 'Missing Data' }
const categories = Object.keys(categoryLabel) as PressDowntimeCategory[]

function rangeLabel(range: PressDowntimeRange) {
  return `${localTime(range.fromUtc)} – ${localTime(range.toUtc)} CT`
}

function PressDowntimeRangeControls({ range, onChange }: { range: PressDowntimeRange; onChange(next: PressDowntimeRange): void }) {
  const [customOpen, setCustomOpen] = useState(range.preset === 'custom'); const [from, setFrom] = useState(range.customFromLocal ?? localInputTime(range.fromUtc)); const [to, setTo] = useState(range.customToLocal ?? localInputTime(range.toUtc)); const [error, setError] = useState<string>()
  useEffect(() => {
    if (customOpen) return
    setFrom(range.customFromLocal ?? localInputTime(range.fromUtc))
    setTo(range.customToLocal ?? localInputTime(range.toUtc))
  }, [customOpen, range.customFromLocal, range.customToLocal, range.fromUtc, range.toUtc])
  const preset = (value: 'last24' | 'last72') => { setCustomOpen(false); setError(undefined); onChange(createPressDowntimePresetRange(value)) }
  const apply = () => {
    try {
      const selected = createCustomRange(from, to)
      if (!validPressDowntimeRange(selected.fromUtc, selected.toUtc)) throw new RangeValidationError('Custom range cannot exceed 72 hours.')
      setCustomOpen(false); setError(undefined); onChange({ ...selected, preset: 'custom' })
    } catch (caught) { setError(caught instanceof RangeValidationError ? caught.message : 'The custom range is invalid.') }
  }
  return <section className="pd-range-controls" aria-label="Press Downtime time range"><div className="pd-range-main"><div className="pd-range-buttons" role="group" aria-label="Time range choices"><button type="button" className={range.preset === 'last24' ? 'active' : ''} aria-pressed={range.preset === 'last24'} onClick={() => preset('last24')}>Last 24 Hours</button><button type="button" className={range.preset === 'last72' ? 'active' : ''} aria-pressed={range.preset === 'last72'} onClick={() => preset('last72')}>Last 72 Hours</button><button type="button" className={range.preset === 'custom' ? 'active' : ''} aria-pressed={range.preset === 'custom'} aria-expanded={customOpen} onClick={() => { setCustomOpen((value) => !value); setError(undefined) }}>Custom</button></div><div className="pd-selected-range"><small>Selected window</small><strong>{rangeLabel(range)}</strong></div></div>{customOpen && <div className="pd-custom-range"><label><span>From · CT</span><input type="datetime-local" value={from} onChange={(event) => setFrom(event.target.value)}/></label><label><span>To · CT</span><input type="datetime-local" value={to} onChange={(event) => setTo(event.target.value)}/></label><button type="button" onClick={apply}>Apply range</button></div>}{error && <p className="range-error" role="alert">{error}</p>}</section>
}

function timelinePosition(startUtc: string, endUtc: string, fromUtc: string, toUtc: string) {
  const from = Date.parse(fromUtc); const span = Math.max(1, Date.parse(toUtc) - from)
  return { left: `${Math.max(0, Math.min(100, (Date.parse(startUtc) - from) / span * 100))}%`, width: `${Math.max(.12, Math.min(100, (Date.parse(endUtc) - Date.parse(startUtc)) / span * 100))}%` }
}

const stableColorHash = (value: string) => [...value].reduce((hash, character) => (hash * 31 + character.charCodeAt(0)) >>> 0, 2166136261)
function identityValueColor(kind: 'order' | 'recipe', value: string): string {
  const palettes = {
    order: ['#5147a8', '#247686', '#9a572e', '#77477f', '#2d7059', '#87513f', '#3d638f', '#876b25'],
    recipe: ['#984970', '#3b68a3', '#9b681e', '#4d7938', '#65509e', '#a04c47', '#287274', '#7d4f92'],
  }
  return palettes[kind][stableColorHash(value) % palettes[kind].length]!
}

interface TimeSplitItem { key: string; label: string; seconds: number; className: string }
function TimeSplitSummary({ title, subtitle, items }: { title: string; subtitle: string; items: TimeSplitItem[] }) {
  const total = Math.max(1, items.reduce((sum, item) => sum + item.seconds, 0))
  return <article className="pd-time-split"><header><div><strong>{title}</strong><small>{subtitle}</small></div><b>{duration(total)}</b></header><div className="pd-time-split-bar" aria-label={`${title} allocation`}>{items.filter((item) => item.seconds > 0).map((item) => <span key={item.key} className={item.className} style={{ width: `${item.seconds / total * 100}%` }} title={`${item.label} · ${duration(item.seconds)} · ${Math.round(item.seconds / total * 100)}%`}/>)}</div><div className="pd-time-split-values">{items.map((item) => <span key={item.key} className={item.className}><i/><small>{item.label}</small><strong>{duration(item.seconds)}</strong><em>{Math.round(item.seconds / total * 100)}%</em></span>)}</div></article>
}

function PressDowntimeSpeedTrend({ report }: { report: PressDowntimePressReport }) {
  const observations = report.speedTrend.observations
  const [cursor, setCursor] = useState<{ position: number; atUtc: string; value: number } | null>(null)
  const from = Date.parse(report.fromUtc); const to = Date.parse(report.toUtc); const span = Math.max(1, to - from)
  const maximum = Math.max(1, ...observations.map(({ value }) => value))
  const path = observations.map((observation, index) => {
    const x = Math.max(0, Math.min(1_000, (Date.parse(observation.atUtc) - from) / span * 1_000))
    const y = 64 - Math.max(0, Math.min(1, observation.value / maximum)) * 54
    return `${index ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`
  }).join(' ')
  const move = (event: PointerEvent<SVGSVGElement>) => {
    if (!observations.length) return
    const bounds = event.currentTarget.getBoundingClientRect(); const position = Math.max(0, Math.min(1, (event.clientX - bounds.left) / Math.max(1, bounds.width))); const at = from + span * position
    const nearest = observations.reduce((best, observation) => Math.abs(Date.parse(observation.atUtc) - at) < Math.abs(Date.parse(best.atUtc) - at) ? observation : best)
    setCursor({ position, atUtc: nearest.atUtc, value: nearest.value })
  }
  return <div className="pd-speed-track" onPointerLeave={() => setCursor(null)}>{observations.length ? <><svg viewBox="0 0 1000 72" preserveAspectRatio="none" role="img" aria-label={`Actual speed in ${report.speedTrend.unit ?? 'configured units'}`} onPointerMove={move}><path d={path}/></svg>{cursor && <><i className="pd-speed-crosshair" style={{ left: `${cursor.position * 100}%` }}/><output className="pd-speed-value" style={{ left: `clamp(4rem, ${cursor.position * 100}%, calc(100% - 4rem))` }}><time>{localTime(cursor.atUtc)} CT</time><strong>{Math.round(cursor.value * 100) / 100} {report.speedTrend.unit ?? ''}</strong></output></>}</> : <span className="pd-speed-empty">No trustworthy speed samples</span>}</div>
}

function PressComparisonTimeline({ report }: { report: PressDowntimePressReport }) {
  const radiusItems: TimeSplitItem[] = [{ key: 'radius-good', label: 'Good', seconds: report.radiusTotals.G, className: 'radius-g' }, { key: 'radius-make-ready', label: 'Make Ready', seconds: report.radiusTotals.M, className: 'radius-m' }, { key: 'radius-bad', label: 'Bad', seconds: report.radiusTotals.B, className: 'radius-b' }, { key: 'radius-missing', label: 'Missing', seconds: report.radiusTotals.MISSING_DATA, className: 'radius-missing-data' }]
  const processItems: TimeSplitItem[] = [{ key: 'our-good', label: 'Good Run', seconds: report.totals.GOOD_RUN, className: 'ours-good' }, { key: 'our-changeover', label: 'Changeover', seconds: report.totals.CHANGEOVER, className: 'ours-changeover' }, { key: 'our-downtime', label: 'Downtime', seconds: report.totals.DOWNTIME, className: 'ours-downtime' }, { key: 'our-missing', label: 'Missing', seconds: report.totals.MISSING_DATA, className: 'ours-missing-data' }]
  const identityRow = (kind: 'order' | 'recipe') => <div className="pd-gantt-row"><strong>{kind === 'order' ? 'Order' : 'Recipe'}</strong><div className="pd-gantt-track pd-identity-track">{report.identityTimeline.map((segment) => { const value = segment[kind]; const missing = segment.missingFields.includes(kind); return <span key={`${kind}-${segment.segmentId}`} className={`pd-identity-band ${missing ? 'is-missing' : ''}`} style={{ ...timelinePosition(segment.startUtc, segment.endUtc, report.fromUtc, report.toUtc), ...(!missing && value ? { background: identityValueColor(kind, value) } : {}) }} title={`${kind === 'order' ? 'Order' : 'Recipe'} · ${missing ? 'Unavailable' : value ?? 'Unavailable'}\n${localTime(segment.startUtc)} → ${localTime(segment.endUtc)}`}><b>{missing ? 'Unavailable' : value ?? 'Unavailable'}</b></span> })}</div></div>
  return <section className="pd-comparison" aria-label={`${report.displayName} Radius and ProcessIntelligence comparison`}><header><div><small>Press-level decision context</small><strong>Radius versus ProcessIntelligence</strong></div><span>{localTime(report.fromUtc)} → {localTime(report.toUtc)}</span></header><div className="pd-comparison-summary"><TimeSplitSummary title="Radius time split" subtitle="Reported G / M / B states" items={radiusItems}/><TimeSplitSummary title="ProcessIntelligence time split" subtitle="Our production and loss classification" items={processItems}/></div><section className="pd-aligned-evidence"><header><div><strong>Aligned operating timeline</strong><small>Compare states with speed and job identity on one time axis.</small></div></header><div className="pd-gantt"><div className="pd-gantt-row"><strong>Raw Radius</strong><div className="pd-gantt-track">{report.radiusTimeline.map((segment) => <span key={segment.segmentId} className={`radius-${segment.category.toLowerCase().replace('_', '-')}`} style={timelinePosition(segment.startUtc, segment.endUtc, report.fromUtc, report.toUtc)} title={`${segment.eventType ?? 'Missing'}${segment.statusCode ?? ''} · ${segment.statusDescription ?? 'Missing Radius data'}\n${localTime(segment.startUtc)} → ${localTime(segment.endUtc)} · ${duration(segment.durationSeconds)}`}/>)}</div></div><div className="pd-gantt-row"><strong>Our state</strong><div className="pd-gantt-track">{report.classificationTimeline.map((segment) => <span key={segment.segmentId} className={`ours-${segment.category.toLowerCase().replace('_', '-')}`} style={timelinePosition(segment.startUtc, segment.endUtc, report.fromUtc, report.toUtc)} title={`${categoryLabel[segment.category]} · ${segment.source === 'OPERATOR_REVIEW' ? 'Operator reviewed' : 'Predicted'}\n${localTime(segment.startUtc)} → ${localTime(segment.endUtc)} · ${duration(segment.durationSeconds)}`}/>)}</div></div><div className="pd-gantt-row pd-gantt-row--speed"><strong>Actual speed</strong><PressDowntimeSpeedTrend report={report}/></div>{identityRow('order')}{identityRow('recipe')}</div></section></section>
}

function SegmentList({ group, category }: { group: PressDowntimeJobGroup; category: PressDowntimeCategory }) {
  const segments = group.occurrences.flatMap((occurrence) => occurrence.segments.filter((segment) => segment.category === category).map((segment) => ({ ...segment, occurrenceNumber: occurrence.occurrenceNumber })))
  if (!segments.length) return <p className="pd-no-segments">No {categoryLabel[category].toLowerCase()} segments.</p>
  return <div className="pd-segment-list">{segments.map((segment) => <div key={segment.segmentId} className="pd-segment-row"><span className={`pd-segment-dot is-${category.toLowerCase().replace('_', '-')}`} aria-hidden="true"/><span><strong>Occurrence {segment.occurrenceNumber}</strong><small>{localTime(segment.startUtc)} → {localTime(segment.endUtc)}</small></span><span><strong>{duration(segment.durationSeconds)}</strong><small>{segment.source === 'OPERATOR_REVIEW' ? 'Operator reviewed' : segment.source === 'DATA_AVAILABILITY' ? 'Unavailable evidence' : 'Predicted'}</small></span></div>)}</div>
}

const categoryContext: Record<PressDowntimeCategory, string> = {
  GOOD_RUN: 'Productive running time',
  CHANGEOVER: 'Setup and make-ready time',
  DOWNTIME: 'Other stops, including routine and uncertain',
  MISSING_DATA: 'Unavailable evidence, excluded from production and loss',
}

function JobTimeAllocation({ group }: { group: PressDowntimeJobGroup }) {
  const total = Math.max(1, categories.reduce((sum, category) => sum + group.totals[category], 0))
  const segmentCount = group.occurrences.reduce((sum, occurrence) => sum + occurrence.segments.length, 0)
  return <section className="pd-job-time"><header><div><small>Time decision</small><strong>Production versus loss</strong></div><b>{duration(total)} observed</b></header><div className="pd-job-time-bar">{categories.filter((category) => group.totals[category] > 0).map((category) => <span key={category} className={`is-${category.toLowerCase().replace('_', '-')}`} style={{ width: `${group.totals[category] / total * 100}%` }} title={`${categoryLabel[category]} · ${duration(group.totals[category])}`}/>)}</div><div className="pd-job-time-list">{categories.map((category) => <div key={category} className={`is-${category.toLowerCase().replace('_', '-')}`}><i/><span><strong>{categoryLabel[category]}</strong><small>{categoryContext[category]}</small></span><b>{duration(group.totals[category])}</b><em>{Math.round(group.totals[category] / total * 100)}%</em></div>)}</div><details className="pd-time-detail"><summary>Review exact time segments <span>{segmentCount}</span></summary><div>{categories.map((category) => <section key={category}><header className={`is-${category.toLowerCase().replace('_', '-')}`}><span><i/><strong>{categoryLabel[category]}</strong></span><b>{duration(group.totals[category])}</b></header><SegmentList group={group} category={category}/></section>)}</div></details></section>
}

function RollOutcome({ group }: { group: PressDowntimeJobGroup }) {
  const unit = group.rolls.find((roll) => roll.unit)?.unit
  const total = Math.max(1, group.rollSummary.total); const goodPercent = Math.round(group.rollSummary.good / total * 100); const changeoverPercent = Math.round(group.rollSummary.changeover / total * 100)
  return <section className="pd-roll-outcome"><header><div><small>Roll decision</small><strong>Roll outcome</strong></div><b>{group.rollSummary.total} completed</b></header><div className="pd-roll-headline"><span><small>Good rolls</small><strong>{group.rollSummary.good}</strong><em>{Math.round(group.rollSummary.goodLength).toLocaleString()} {unit ?? ''}</em></span><span><small>Changeover rolls</small><strong>{group.rollSummary.changeover}</strong><em>{Math.round(group.rollSummary.changeoverLength).toLocaleString()} {unit ?? ''}</em></span></div><div className="pd-roll-share" aria-label="Good versus changeover roll count">{group.rollSummary.good > 0 && <span className="good" style={{ width: `${goodPercent}%` }}/>} {group.rollSummary.changeover > 0 && <span className="changeover" style={{ width: `${changeoverPercent}%` }}/>}</div><p><strong>{group.rollSummary.total ? `${goodPercent}% good rolls` : 'No completed rolls'}</strong><span>Classification follows when roll length increased: during changeover versus outside changeover.</span></p>{group.rolls.length ? <details className="pd-roll-breakdown"><summary>Review roll sizes and classifications</summary><div>{group.rolls.map((roll) => { const occurrence = group.occurrences.find((item) => item.occurrenceId === roll.occurrenceId); return <span key={roll.rollId} className={roll.category.toLowerCase()}><b>{Math.round(roll.length).toLocaleString()} {roll.unit ?? ''}</b><small>{roll.category === 'CHANGEOVER' ? 'Changeover roll' : 'Good roll'} · Occurrence {occurrence?.occurrenceNumber ?? '—'} · {localTime(roll.endUtc)}</small></span> })}</div></details> : <p className="pd-no-rolls">No completed roll reset was observed for this job in the selected window.</p>}</section>
}

function JobInstances({ group }: { group: PressDowntimeJobGroup }) {
  return <section className="pd-job-instances"><header><div><small>Time sequence</small><strong>Job instances</strong><p>A temporary Order or Recipe gap appears as Missing Data inside the same instance; it does not create another instance.</p></div><b>{group.occurrenceCount}</b></header><div>{group.occurrences.map((occurrence) => <article key={occurrence.occurrenceId}><header><b>Instance {occurrence.occurrenceNumber}</b><span>{localTime(occurrence.startUtc)} → {localTime(occurrence.endUtc)}</span><strong>{duration(occurrence.durationSeconds)}</strong><em>{occurrence.rollSummary.total} completed roll{occurrence.rollSummary.total === 1 ? '' : 's'}</em></header><div className="pd-instance-state-track" aria-label={`Instance ${occurrence.occurrenceNumber} time allocation`}>{occurrence.segments.map((segment) => <span key={segment.segmentId} className={`is-${segment.category.toLowerCase().replace('_', '-')}`} style={timelinePosition(segment.startUtc, segment.endUtc, occurrence.startUtc, occurrence.endUtc)} title={`${categoryLabel[segment.category]} · ${localTime(segment.startUtc)} → ${localTime(segment.endUtc)} · ${duration(segment.durationSeconds)}`}/>)}</div><footer>{categories.map((category) => <span key={category} className={`is-${category.toLowerCase().replace('_', '-')}`}><i/><small>{categoryLabel[category]}</small><strong>{duration(occurrence.totals[category])}</strong></span>)}</footer></article>)}</div></section>
}

function JobGroup({ group }: { group: PressDowntimeJobGroup }) {
  return <article className="pd-job-group"><header><div className="pd-job-title"><small>Job identity</small><strong>Order {group.order ?? 'Unavailable'}</strong><span>Recipe {group.recipe ?? 'Unavailable'}</span></div><span className="pd-occurrence-count">{group.occurrenceCount} instance{group.occurrenceCount === 1 ? '' : 's'}</span></header>{!group.identityComplete && <p className="pd-identity-warning">This group has incomplete Order or Recipe evidence.</p>}<div className="pd-job-decision-grid"><RollOutcome group={group}/><JobTimeAllocation group={group}/></div><JobInstances group={group}/></article>
}

function PressCard({ pressKey, state, expanded, onToggle }: { pressKey: RadiusPressKey; state: CardState; expanded: boolean; onToggle(): void }) {
  const report = state.report
  const status = state.status === 'idle' ? 'Open to load' : state.status === 'loading' ? 'Loading' : state.status === 'error' ? 'Unavailable' : report?.availability === 'AVAILABLE' ? 'Complete' : report?.availability === 'PARTIAL' ? 'Partial data' : 'Missing data'
  return <article className={`pd-press-card ${expanded ? 'is-expanded' : 'is-collapsed'} ${state.status === 'loading' ? 'is-loading' : ''}`} aria-busy={state.status === 'loading'}><header className="pd-press-header"><button type="button" onClick={onToggle} aria-expanded={expanded}><span><small>Order + Recipe job occurrences</small><strong>{report?.displayName ?? pressKey.replace('press', 'Press ')}</strong></span><em className={`pd-status is-${state.status === 'ready' ? report?.availability.toLowerCase() : state.status}`}>{state.status === 'loading' && <i/>}{status}</em><b aria-hidden="true">{expanded ? '−' : '+'}</b></button></header>{expanded && <div className="pd-press-body">{state.status === 'loading' && !report && <div className="pd-card-loading" role="status"><i/><span>Loading this press only…</span></div>}{state.status === 'error' && !report && <div className="pd-card-error"><strong>This press could not be loaded.</strong><span>{state.error}</span></div>}{report && <><PressComparisonTimeline report={report}/>{report.reason && <p className="pd-data-note">{report.reason}</p>}<section className="pd-jobs-section"><header><div><small>Job-level decisions</small><strong>Roll outcome and time loss by job</strong><p>Use each job to see whether completed rolls were made during changeover and where nonproductive time accumulated.</p></div><b>{report.jobGroups.length} job{report.jobGroups.length === 1 ? '' : 's'}</b></header><div className="pd-job-list">{report.jobGroups.map((group) => <JobGroup key={group.groupId} group={group}/>)}{!report.jobGroups.length && <div className="pd-card-error"><strong>No job identity was resolved.</strong><span>Order and Recipe evidence did not produce a job occurrence in this window.</span></div>}</div></section></>}</div>}</article>
}

export function PressDowntimePage() {
  const [range, setRange] = useState<PressDowntimeRange>(initialRange)
  const [expanded, setExpanded] = useState<Set<RadiusPressKey>>(() => new Set(['press3']))
  const [cards, setCards] = useState<Record<string, CardState>>(() => Object.fromEntries(PRESS_DOWNTIME_PRESS_KEYS.map((pressKey) => [pressKey, { status: 'idle' }])))
  useEffect(() => {
    const controller = new AbortController(); let active = true
    const pending = [...expanded].filter((pressKey) => cards[pressKey]?.report?.fromUtc !== range.fromUtc || cards[pressKey]?.report?.toUtc !== range.toUtc)
    if (pending.length) setCards((current) => ({ ...current, ...Object.fromEntries(pending.map((pressKey) => [pressKey, { status: 'loading' }])) }))
    for (const pressKey of pending) void getPressDowntimePress(pressKey, range.fromUtc, range.toUtc, controller.signal).then((report) => { if (active) setCards((current) => ({ ...current, [pressKey]: { status: 'ready', report } })) }).catch(() => { if (active) setCards((current) => ({ ...current, [pressKey]: { status: 'error', error: 'Read-only Stop Intelligence or job identity evidence is unavailable for this range.' } })) })
    return () => { active = false; controller.abort() }
  }, [range.fromUtc, range.toUtc, [...expanded].join('|')])
  const changeRange = (next: PressDowntimeRange) => { const url = new URL(window.location.href); url.searchParams.set('fromUtc', next.fromUtc); url.searchParams.set('toUtc', next.toUtc); url.searchParams.set('preset', next.preset); window.history.replaceState({}, '', `${url.pathname}?${url.searchParams}`); setRange(next) }
  const toggle = (pressKey: RadiusPressKey) => { const opening = !expanded.has(pressKey); setExpanded((current) => { const next = new Set(current); if (opening) next.add(pressKey); else next.delete(pressKey); return next }) }
  return <div className="pd-page"><section className="pd-hero"><div><span className="eyebrow">Fleet job-time accounting</span><h1>Press Downtime</h1><p>Every Order + Recipe occurrence, grouped by identity and reconciled across Changeover, Good Run, Downtime, Radius G/B/M, and completed rolls.</p></div><div className="pd-policy"><span>Operator review overrides prediction</span><span>Routine + uncertain → downtime</span></div></section><PressDowntimeRangeControls range={range} onChange={changeRange}/><section className="pd-press-grid" aria-label="Press Downtime by press">{PRESS_DOWNTIME_PRESS_KEYS.map((pressKey) => <PressCard key={pressKey} pressKey={pressKey} state={cards[pressKey] ?? { status: 'idle' }} expanded={expanded.has(pressKey)} onToggle={() => toggle(pressKey)}/>)}</section></div>
}

export function pressDowntimeSegments(group: PressDowntimeJobGroup, category: PressDowntimeCategory): PressDowntimeSegment[] {
  return group.occurrences.flatMap((occurrence) => occurrence.segments.filter((segment) => segment.category === category))
}
