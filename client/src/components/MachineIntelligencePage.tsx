import { DateTime } from 'luxon'
import { useEffect, useMemo, useState } from 'react'
import { getMachineIntelligenceOverview } from '../api/process-intelligence-api'
import { MACHINE_INTELLIGENCE_MAX_RANGE_MS, MACHINE_INTELLIGENCE_PRESS_KEYS, machineOpportunitySeconds } from '../machine-intelligence'
import { createCustomRange, PLANT_TIME_ZONE, RangeValidationError } from '../time-ranges'
import type { RadiusPressKey } from '../types/api'
import type { MachineIntelligenceFleetOverview, MachineIntelligencePressOverview } from '../types/machine-intelligence'

type Preset = 'last24' | 'last72' | 'last14' | 'custom'
interface MachineRange { preset: Preset; fromUtc: string; toUtc: string }
const colors = { CHANGEOVER: '#3478c9', GOOD_RUN: '#2f946b', DOWNTIME: '#cf5157', MISSING_DATA: '#8b929d', G: '#2f946b', M: '#d29b31', B: '#cf5157' }

const duration = (seconds: number) => { const hours = Math.floor(seconds / 3_600); const minutes = Math.floor(seconds % 3_600 / 60); return hours ? `${hours}h ${minutes}m` : `${minutes}m` }
const percent = (value: number, total: number) => total ? value / total * 100 : 0
const localTime = (value: string) => new Intl.DateTimeFormat('en-US', { timeZone: PLANT_TIME_ZONE, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value))
const inputTime = (value: string) => DateTime.fromISO(value).setZone(PLANT_TIME_ZONE).toFormat("yyyy-MM-dd'T'HH:mm")
const presetRange = (preset: Exclude<Preset, 'custom'>, now = DateTime.now()): MachineRange => { const hours = preset === 'last24' ? 24 : preset === 'last72' ? 72 : 14 * 24; const to = now.toUTC(); return { preset, fromUtc: to.minus({ hours }).toISO()!, toUtc: to.toISO()! } }

function initialRange(): MachineRange {
  const query = new URLSearchParams(window.location.search); const fromUtc = query.get('fromUtc'); const toUtc = query.get('toUtc'); const preset = query.get('preset') as Preset | null
  const span = fromUtc && toUtc ? Date.parse(toUtc) - Date.parse(fromUtc) : NaN
  return fromUtc && toUtc && span > 0 && span <= MACHINE_INTELLIGENCE_MAX_RANGE_MS ? { preset: preset === 'last24' || preset === 'last72' || preset === 'last14' ? preset : 'custom', fromUtc, toUtc } : presetRange('last24')
}

function RangeControls({ range, onChange }: { range: MachineRange; onChange(value: MachineRange): void }) {
  const [open, setOpen] = useState(range.preset === 'custom'); const [from, setFrom] = useState(inputTime(range.fromUtc)); const [to, setTo] = useState(inputTime(range.toUtc)); const [error, setError] = useState<string>()
  const choose = (preset: Exclude<Preset, 'custom'>) => { setOpen(false); setError(undefined); onChange(presetRange(preset)) }
  const apply = () => { try { const selected = createCustomRange(from, to); if (Date.parse(selected.toUtc) - Date.parse(selected.fromUtc) > MACHINE_INTELLIGENCE_MAX_RANGE_MS) throw new RangeValidationError('Machine Intelligence supports up to 31 days.'); setOpen(false); setError(undefined); onChange({ preset: 'custom', fromUtc: selected.fromUtc, toUtc: selected.toUtc }) } catch (caught) { setError(caught instanceof Error ? caught.message : 'Invalid range.') } }
  return <section className="mi-range"><div className="mi-range-buttons" role="group" aria-label="Machine Intelligence time range"><button className={range.preset === 'last24' ? 'active' : ''} onClick={() => choose('last24')}>24 Hours</button><button className={range.preset === 'last72' ? 'active' : ''} onClick={() => choose('last72')}>72 Hours</button><button className={range.preset === 'last14' ? 'active' : ''} onClick={() => choose('last14')}>14 Days</button><button className={range.preset === 'custom' ? 'active' : ''} onClick={() => setOpen((value) => !value)}>Custom</button></div><strong>{localTime(range.fromUtc)} - {localTime(range.toUtc)} CT</strong>{open && <div className="mi-custom"><label>From - CT<input type="datetime-local" value={from} onChange={(event) => setFrom(event.target.value)} /></label><label>To - CT<input type="datetime-local" value={to} onChange={(event) => setTo(event.target.value)} /></label><button onClick={apply}>Apply</button></div>}{error && <p role="alert">{error}</p>}</section>
}

function Stack({ values, total, labels }: { values: Array<{ key: string; value: number; color: string }>; total: number; labels: string[] }) {
  return <div className="mi-stack" role="img" aria-label={labels.join(', ')}>{values.filter((item) => item.value > 0).map((item) => <span key={item.key} style={{ width: `${percent(item.value, total)}%`, background: item.color }} title={`${item.key}: ${duration(item.value)}`} />)}</div>
}

interface ChartProps { reports: Map<RadiusPressKey, MachineIntelligencePressOverview>; unavailable: Set<RadiusPressKey>; loading: boolean }

function MissingRow({ pressKey, unavailable, loading }: { pressKey: RadiusPressKey; unavailable: boolean; loading: boolean }) {
  return <div className="mi-chart-row mi-chart-row--pending"><strong>{pressKey.replace('press', 'Press ')}</strong><span>{loading ? 'Loading overview' : unavailable ? 'Unavailable' : 'No evidence'}</span><small>-</small></div>
}

function FleetTimeChart({ reports, unavailable, loading, source }: ChartProps & { source: 'process' | 'radius' }) {
  const processKeys = ['GOOD_RUN', 'CHANGEOVER', 'DOWNTIME', 'MISSING_DATA'] as const; const radiusKeys = ['G', 'M', 'B', 'MISSING_DATA'] as const
  return <section className="mi-chart"><header><div><span>{source === 'process' ? 'Telemetry-led + reviewed' : 'Operator/status annotation'}</span><h2>{source === 'process' ? 'Process Intelligence time' : 'Radius time'}</h2></div><div className="mi-key">{(source === 'process' ? processKeys : radiusKeys).map((key) => <i key={key}><b style={{ background: colors[key] }} />{key === 'GOOD_RUN' ? 'Good' : key === 'CHANGEOVER' ? 'Changeover' : key === 'DOWNTIME' ? 'Downtime' : key === 'MISSING_DATA' ? 'Missing' : key}</i>)}</div></header><div className="mi-chart-rows">{MACHINE_INTELLIGENCE_PRESS_KEYS.map((pressKey) => { const report = reports.get(pressKey); if (!report) return <MissingRow key={pressKey} pressKey={pressKey} unavailable={unavailable.has(pressKey)} loading={loading}/>; const values = source === 'process' ? processKeys.map((key) => ({ key, value: report.totals[key], color: colors[key] })) : radiusKeys.map((key) => ({ key, value: report.radiusTotals[key], color: colors[key] })); const total = values.reduce((sum, item) => sum + item.value, 0); return <div className="mi-chart-row" key={report.pressKey}><strong>{report.displayName}</strong><Stack values={values} total={total} labels={values.map((item) => `${item.key} ${duration(item.value)}`)} /><small>{duration(total)}</small></div> })}</div></section>
}

function OpportunityChart({ reports, unavailable, loading }: ChartProps) {
  const maximum = Math.max(1, ...[...reports.values()].map(machineOpportunitySeconds))
  return <section className="mi-chart mi-opportunity"><header><div><span>Comparable non-good time</span><h2>Process Intelligence and Radius by press</h2></div><div className="mi-key"><i><b style={{ background: '#3478c9' }}/>PI changeover</i><i><b style={{ background: '#cf5157' }}/>PI downtime</i><i><b style={{ background: '#d29b31' }}/>Radius M</i><i><b style={{ background: '#b56355' }}/>Radius B</i></div></header><div className="mi-chart-rows">{MACHINE_INTELLIGENCE_PRESS_KEYS.map((pressKey) => { const report = reports.get(pressKey); if (!report) return <MissingRow key={pressKey} pressKey={pressKey} unavailable={unavailable.has(pressKey)} loading={loading}/>; const opportunity = machineOpportunitySeconds(report); const radiusLoss = report.radiusTotals.M + report.radiusTotals.B; return <div className="mi-chart-row" key={report.pressKey}><strong>{report.displayName}</strong><div className="mi-opportunity-pair"><div><i>PI</i><span className="mi-opportunity-track" style={{ width: `${Math.max(1, opportunity / maximum * 100)}%` }}><b style={{ width: `${percent(report.totals.CHANGEOVER, opportunity)}%` }} /><b style={{ width: `${percent(report.totals.DOWNTIME, opportunity)}%` }} /></span></div><div><i>R</i><span className="mi-radius-loss-track" style={{ width: `${Math.max(1, radiusLoss / maximum * 100)}%` }}><b style={{ width: `${percent(report.radiusTotals.M, radiusLoss)}%` }} /><b style={{ width: `${percent(report.radiusTotals.B, radiusLoss)}%` }} /></span></div></div><small>{duration(opportunity)} PI</small></div> })}</div></section>
}

function RollChart({ reports, unavailable, loading }: ChartProps) {
  const maximum = Math.max(1, ...[...reports.values()].map((report) => report.rollSummary.total))
  return <section className="mi-chart mi-roll-chart"><header><div><span>Canonical roll-length telemetry</span><h2>Good and changeover rolls by press</h2></div><div className="mi-key"><i><b style={{ background: '#2f946b' }}/>Good roll</i><i><b style={{ background: '#3478c9' }}/>Changeover roll</i></div></header><div className="mi-chart-rows">{MACHINE_INTELLIGENCE_PRESS_KEYS.map((pressKey) => { const report = reports.get(pressKey); if (!report) return <MissingRow key={pressKey} pressKey={pressKey} unavailable={unavailable.has(pressKey)} loading={loading}/>; const rolls = report.rollSummary; return <div className="mi-chart-row" key={pressKey}><strong>{report.displayName}</strong><div className="mi-roll-track" style={{ width: `${Math.max(1, rolls.total / maximum * 100)}%` }} title={`${rolls.good} good rolls (${Math.round(rolls.goodLength).toLocaleString()} length) - ${rolls.changeover} changeover rolls (${Math.round(rolls.changeoverLength).toLocaleString()} length)`}><span style={{ width: `${percent(rolls.good, rolls.total)}%` }}/><span style={{ width: `${percent(rolls.changeover, rolls.total)}%` }}/></div><small>{rolls.total} rolls</small></div> })}</div></section>
}

export function MachineIntelligencePage() {
  const [range, setRange] = useState<MachineRange>(initialRange); const [overview, setOverview] = useState<MachineIntelligenceFleetOverview>(); const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  useEffect(() => {
    const controller = new AbortController(); setStatus('loading'); setOverview(undefined)
    getMachineIntelligenceOverview(range.fromUtc, range.toUtc, controller.signal).then((result) => { if (!controller.signal.aborted) { setOverview(result); setStatus('ready') } }).catch(() => { if (!controller.signal.aborted) setStatus('error') })
    return () => controller.abort()
  }, [range.fromUtc, range.toUtc])
  const reports = useMemo(() => new Map(overview?.presses.map((report) => [report.pressKey, report]) ?? []), [overview]); const unavailable = useMemo(() => new Set(overview?.unavailablePresses.map((item) => item.pressKey) ?? []), [overview])
  const changeRange = (value: MachineRange) => { setRange(value); const url = new URL(window.location.href); url.searchParams.set('preset', value.preset); url.searchParams.set('fromUtc', value.fromUtc); url.searchParams.set('toUtc', value.toUtc); history.replaceState({}, '', `${url.pathname}?${url.searchParams}`) }
  const chartProps = { reports, unavailable, loading: status === 'loading' }
  return <div className="mi-page"><section className="mi-hero"><div><span className="eyebrow">Unified fleet overview</span><h1>Machine Intelligence</h1><p>Compare Process Intelligence, Radius, non-good time, and roll outcomes across every press.</p></div><div><span>Overview evidence</span><strong>Telemetry + operator review</strong><small>Radius remains visible as recorded operational context.</small></div></section><RangeControls range={range} onChange={changeRange}/>{status === 'loading' && <p className="mi-overview-status" role="status">Loading fleet overview...</p>}{status === 'error' && <p className="mi-overview-status mi-overview-status--error" role="alert">The fleet overview could not be loaded. Try the range again.</p>}<section className="mi-overview-pair"><FleetTimeChart {...chartProps} source="process"/><FleetTimeChart {...chartProps} source="radius"/></section><section className="mi-overview-pair"><OpportunityChart {...chartProps}/><RollChart {...chartProps}/></section><details className="mi-method"><summary>Evidence policy and limitations</summary><p>Process Intelligence time is derived from physical telemetry classifications with the latest operator review overriding prediction. Radius is displayed beside the same period as separate operator/status annotation. Routine and model-uncertain stops count as downtime, while unavailable or bad evidence stays Missing Data. This page requests one read-only fleet summary and does not build job, recipe, occurrence, or press drill-down data.</p></details></div>
}
