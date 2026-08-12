import { useEffect, useMemo, useState } from 'react'
import { getActivityAnalysis } from '../api/process-intelligence-api'
import { formatDuration } from '../episode-presentation'
import { formatPlantDateTime } from '../time-ranges'
import type { ActivityAnalysis, ActivityCatalogItem, ActivityLevel, ActivitySelection, OperationalAnalytics, RadiusPressKey } from '../types/api'

const levelLabels: Record<ActivityLevel, string> = { radius_state: 'Radius State', operational_group: 'Operational Group', process_family: 'Process Family', exact_status: 'Exact Radius Status' }
const levelOrder: ActivityLevel[] = ['radius_state', 'operational_group', 'process_family', 'exact_status']

function compact(seconds: number | null) { return seconds === null ? 'Not enough evidence' : formatDuration(Math.round(seconds)) }
function barWidth(value: number, maximum: number) { return maximum > 0 ? `${Math.max(value > 0 ? 1 : 0, value / maximum * 100)}%` : '0%' }

export function ActivityPicker({ catalog, selected, prompt = 'Search one activity', onSelect }: { catalog: ActivityCatalogItem[]; selected?: ActivityCatalogItem; prompt?: string; onSelect(item: ActivityCatalogItem): void }) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const matches = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return catalog.filter((item) => !normalized || `${item.label} ${item.description ?? ''} ${item.eventType ?? ''} ${item.statusCode ?? ''}`.toLowerCase().includes(normalized)).slice(0, 40)
  }, [catalog, query])
  return <div className="activity-picker">
    <label htmlFor="activity-search">{prompt}</label>
    <div className="activity-picker__input"><input id="activity-search" value={query} placeholder={selected?.label ?? 'Type a state, group, family, or exact Radius status'} autoComplete="off" onFocus={() => setOpen(true)} onChange={(event) => { setQuery(event.target.value); setOpen(true) }} aria-expanded={open} aria-controls="activity-results" />{selected && <span>{levelLabels[selected.level]}</span>}</div>
    {open && <div id="activity-results" className="activity-picker__results">{levelOrder.map((level) => {
      const values = matches.filter((item) => item.level === level)
      return values.length ? <section key={level}><h3>{levelLabels[level]}</h3>{values.map((item) => <button type="button" key={`${item.level}:${item.key}`} onClick={() => { onSelect(item); setQuery(''); setOpen(false) }}><strong>{item.label}</strong>{item.description && <small>{item.description}</small>}{item.needsClassification && <em>Needs Classification</em>}</button>)}</section> : null
    })}<button type="button" className="activity-picker__close" onClick={() => setOpen(false)}>Close results</button></div>}
    <p>Analyze one activity here. Use Pattern Builder for activities that occur together or in sequence.</p>
  </div>
}

function Metrics({ data }: { data: ActivityAnalysis }) {
  const values = [
    ['Total time', compact(data.summary.totalDurationSeconds)], ['Occurrences', data.summary.occurrenceCount.toLocaleString()],
    ['Presses', `${data.summary.pressesObserved} / ${data.summary.scopePresses}`], ['Median occurrence', compact(data.summary.medianOccurrenceSeconds)],
    ['Longest occurrence', compact(data.summary.longestOccurrenceSeconds)], ['Share of observed time', `${data.summary.shareOfObservedPercent.toFixed(1)}%`],
  ]
  return <dl className="activity-metrics">{values.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
}

function HorizontalBars({ values, metric, onPress }: { values: ActivityAnalysis['pressBreakdown']; metric: 'duration' | 'occurrences' | 'share'; onPress(key: RadiusPressKey): void }) {
  const value = (item: ActivityAnalysis['pressBreakdown'][number]) => metric === 'duration' ? item.durationSeconds : metric === 'occurrences' ? item.occurrenceCount : item.shareOfObservedPercent
  const maximum = Math.max(0, ...values.map(value))
  return <div className="analysis-bars">{[...values].sort((a, b) => value(b) - value(a)).map((item) => <button type="button" key={item.pressKey} onClick={() => onPress(item.pressKey)} title={`${item.displayName}\n${compact(item.durationSeconds)}\n${item.occurrenceCount} occurrences\nMedian ${compact(item.medianOccurrenceSeconds)}\n${item.shareOfObservedPercent.toFixed(1)}% of observed time\n${item.coveragePercent.toFixed(1)}% source coverage`}><span>{item.displayName}</span><i><b style={{ width: barWidth(value(item), maximum) }} /></i><strong>{metric === 'duration' ? compact(item.durationSeconds) : metric === 'occurrences' ? item.occurrenceCount : `${item.shareOfObservedPercent.toFixed(1)}%`}</strong></button>)}</div>
}

function StateComposition({ data, onState }: { data: ActivityAnalysis; onState(eventType: string): void }) {
  let cursor = 0
  const colors: Record<string, string> = { G: '#27805e', M: '#d3a332', B: '#ba4949', S: '#e1762c' }
  const stops = data.radiusStateComposition.map((item) => { const start = cursor; cursor += item.percentage; return `${colors[item.eventType] ?? '#788795'} ${start}% ${cursor}%` })
  return <div className="activity-composition"><button type="button" className="activity-donut" style={{ background: stops.length ? `conic-gradient(${stops.join(',')})` : undefined }} aria-label="Radius-state composition; select a legend item to focus evidence"><span>{data.radiusStateComposition.length}<small>states</small></span></button><div>{data.radiusStateComposition.map((item) => <button type="button" key={item.eventType} onClick={() => onState(item.eventType)}><i style={{ background: colors[item.eventType] ?? '#788795' }} /><span>{item.label}<small>{compact(item.durationSeconds)}</small></span><strong>{item.percentage.toFixed(1)}%</strong></button>)}</div></div>
}

function ActivityTrend({ data, metric }: { data: ActivityAnalysis; metric: 'duration' | 'occurrences' }) {
  const values = data.trend.map((item) => metric === 'duration' ? item.durationSeconds : item.occurrenceCount)
  const maximum = Math.max(0, ...values)
  return <div className="activity-trend" role="img" aria-label={`${data.selection.label} ${data.trendBucket} ${metric} trend`}>{data.trend.map((item, index) => <div key={item.bucketStartUtc} title={`${formatPlantDateTime(item.bucketStartUtc)} CT\n${compact(item.durationSeconds)}\n${item.occurrenceCount} occurrences`}><i style={{ height: barWidth(values[index]!, maximum) }} /><span>{data.trendBucket === 'day' ? formatPlantDateTime(item.bucketStartUtc).split(',')[0] : new Date(item.bucketStartUtc).toLocaleTimeString([], { hour: 'numeric' })}</span></div>)}</div>
}

function StopsRecoverySummary({ analytics }: { analytics: OperationalAnalytics }) {
  return <section className="panel activity-recovery" aria-labelledby="activity-recovery-title"><div className="section-heading"><div><p className="eyebrow">Separate recovery lens · existing 300-second rule</p><h2 id="activity-recovery-title">Stops &amp; Recovery</h2><p>Aggregate production-stop and confirmed-return evidence remains available without duplicating Run sequence analysis.</p></div></div><dl className="activity-metrics"><div><dt>Production stops</dt><dd>{analytics.productionStops.anchorCount}</dd></div><div><dt>Resolved stop outcomes</dt><dd>{analytics.productionStops.resolvedCount} / {analytics.productionStops.anchorCount}</dd></div><div><dt>Confirmed returns</dt><dd>{analytics.beforeSuccessfulProduction.anchorCount}</dd></div><div><dt>Boundary / unavailable</dt><dd>{analytics.productionStops.censoredCount}</dd></div></dl></section>
}

export function OperationalActivityExplorerView({ data, analytics }: { data: ActivityAnalysis; analytics: OperationalAnalytics }) {
  const [pressFocus, setPressFocus] = useState<RadiusPressKey>()
  const [stateFocus, setStateFocus] = useState<string>()
  const [pressMetric, setPressMetric] = useState<'duration' | 'occurrences' | 'share'>('duration')
  const [trendMetric, setTrendMetric] = useState<'duration' | 'occurrences'>('duration')
  const evidence = data.occurrences.filter((item) => (!pressFocus || item.pressKey === pressFocus) && (!stateFocus || item.exactIdentities.some(({ eventType }) => eventType === stateFocus)))
  const maxSemantic = Math.max(0, ...data.semanticBreakdown.map(({ durationSeconds }) => durationSeconds))
  const maxBucket = Math.max(0, ...data.durationDistribution.map(({ occurrenceCount }) => occurrenceCount))
  return <>
    <section className="panel activity-header"><p className="eyebrow">{levelLabels[data.selection.level]}</p><h2>{data.selection.label}</h2><p>{data.selection.description || 'Observed Radius activity in the selected scope.'}</p>{data.selection.level === 'exact_status' && <p><b>Radius recorded:</b> {data.selection.eventType} / {data.selection.statusCode ?? '—'} / {data.selection.statusDescription}<br /><b>Classified as:</b> {data.selection.operationalGroupName} → {data.selection.processFamilyName}</p>}<Metrics data={data} /><div className="activity-quality"><span>Radius source coverage <b>{data.summary.sourceCoveragePercent.toFixed(1)}%</b></span><span>Classification coverage <b>{data.summary.classificationCoveragePercent.toFixed(1)}%</b></span><span>Published Classification <b>v{data.classificationVersion}</b></span></div></section>
    <div className="activity-two-column"><section className="panel"><div className="section-heading"><div><p className="eyebrow">Where</p><h2>By press</h2></div><div className="segmented-control">{(['duration', 'occurrences', 'share'] as const).map((item) => <button type="button" key={item} className={pressMetric === item ? 'active' : ''} onClick={() => setPressMetric(item)}>{item === 'duration' ? 'Total Time' : item === 'occurrences' ? 'Occurrences' : 'Observed Share'}</button>)}</div></div><HorizontalBars values={data.pressBreakdown} metric={pressMetric} onPress={setPressFocus} /></section>
      <section className="panel"><div className="section-heading"><div><p className="eyebrow">Radius ↔ semantic meaning</p><h2>Radius states that recorded this activity</h2></div></div><StateComposition data={data} onState={setStateFocus} /><p className="annotation-disclaimer">Radius recorded the broad state; Published Classification supplies the operational meaning.</p></section></div>
    <div className="activity-two-column"><section className="panel"><div className="section-heading"><div><p className="eyebrow">When</p><h2>{data.trendBucket === 'day' ? 'Daily' : 'Hourly'} trend</h2></div><div className="segmented-control"><button type="button" className={trendMetric === 'duration' ? 'active' : ''} onClick={() => setTrendMetric('duration')}>Duration</button><button type="button" className={trendMetric === 'occurrences' ? 'active' : ''} onClick={() => setTrendMetric('occurrences')}>Occurrences</button></div></div>{data.trend.length ? <ActivityTrend data={data} metric={trendMetric} /> : <p className="empty-state">No matching activity occurred in this range.</p>}</section>
      <section className="panel"><div className="section-heading"><div><p className="eyebrow">How long and how often</p><h2>Occurrence duration</h2></div></div>{data.summary.occurrenceCount >= 5 ? <div className="distribution-bars">{data.durationDistribution.map((item) => <div key={item.key}><span>{item.label}</span><i><b style={{ width: barWidth(item.occurrenceCount, maxBucket) }} /></i><strong>{item.occurrenceCount}</strong></div>)}</div> : <p className="empty-state">At least five occurrences are required for a useful duration distribution.</p>}{data.summary.p95OccurrenceSeconds !== null && <p className="quiet-copy">P95 occurrence duration: {compact(data.summary.p95OccurrenceSeconds)} · shown because at least 20 occurrences are available.</p>}</section></div>
    <section className="panel"><div className="section-heading"><div><p className="eyebrow">Semantic composition</p><h2>{data.selection.level === 'radius_state' ? 'Operational groups' : data.selection.level === 'operational_group' ? 'Process families' : 'Exact supporting Radius evidence'}</h2></div></div><div className="semantic-bars">{data.semanticBreakdown.map((item) => <div key={`${item.level}:${item.key}`}><span>{item.label}</span><i><b style={{ width: barWidth(item.durationSeconds, maxSemantic) }} /></i><strong>{compact(item.durationSeconds)} · {item.percentage.toFixed(1)}%</strong></div>)}</div></section>
    <section className="panel activity-evidence"><div className="section-heading"><div><p className="eyebrow">Actual observed occurrences</p><h2>Occurrence evidence</h2><p>Exact Radius history is retained beneath the semantic classification.</p></div>{(pressFocus || stateFocus) && <button type="button" className="clear-focus" onClick={() => { setPressFocus(undefined); setStateFocus(undefined) }}>Clear local evidence focus</button>}</div>{pressFocus && <p className="focus-chip">Evidence currently focused on {data.pressBreakdown.find(({ pressKey }) => pressKey === pressFocus)?.displayName}</p>}{stateFocus && <p className="focus-chip">Radius state focus: {data.radiusStateComposition.find(({ eventType }) => eventType === stateFocus)?.label}</p>}<div className="analysis-table-scroll"><table><thead><tr><th>Press</th><th>Start</th><th>End</th><th>Duration</th><th>Radius state</th><th>Operational group</th><th>Process family</th><th>Exact Radius status</th></tr></thead><tbody>{evidence.map((item) => <tr key={item.occurrenceId}><th>{item.displayName}</th><td>{formatPlantDateTime(item.startUtc)} CT</td><td>{formatPlantDateTime(item.endUtc)} CT</td><td>{compact(item.durationSeconds)}</td><td>{item.radiusStateLabel}</td><td>{item.operationalGroupName}</td><td>{item.processFamilyName}</td><td>{item.exactIdentities.map((identity) => <span className="exact-evidence" key={identity.identity}>{identity.eventType} / {identity.statusCode ?? '—'} / {identity.statusDescription} · {compact(identity.durationSeconds)}{identity.needsClassification ? ' · Needs Classification' : ''}</span>)}</td></tr>)}</tbody></table></div>{data.totalOccurrenceCount > data.evidenceLimit && <p className="quiet-copy">Showing the newest {data.evidenceLimit} of {data.totalOccurrenceCount} occurrences. All summaries and charts use the full scope.</p>}</section>
    <StopsRecoverySummary analytics={analytics} />
  </>
}

export function OperationalActivityExplorer({ fromUtc, toUtc, pressKey, analytics }: { fromUtc: string; toUtc: string; pressKey?: RadiusPressKey; analytics: OperationalAnalytics }) {
  const [data, setData] = useState<ActivityAnalysis>()
  const [selection, setSelection] = useState<ActivitySelection>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  useEffect(() => { let active = true; setLoading(true); setError(false); void getActivityAnalysis(fromUtc, toUtc, selection, pressKey).then((value) => { if (active) { setData(value); setSelection({ level: value.selection.level, key: value.selection.key, label: value.selection.label }) } }).catch(() => active && setError(true)).finally(() => active && setLoading(false)); return () => { active = false } }, [fromUtc, toUtc, pressKey, selection?.level, selection?.key])
  return <div className="activity-explorer">{data && <ActivityPicker catalog={data.catalog} selected={data.selection} onSelect={setSelection} />}{loading && <div className="scope-progress" role="status"><i />Updating activity analysis…</div>}{error && <p className="message message--warning">Activity analysis could not be loaded for this selection.</p>}{data && <OperationalActivityExplorerView data={data} analytics={analytics} />}</div>
}
