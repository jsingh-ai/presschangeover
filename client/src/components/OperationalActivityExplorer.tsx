import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { getActivityAnalysis } from '../api/process-intelligence-api'
import { formatDuration } from '../episode-presentation'
import { formatPlantDateTime } from '../time-ranges'
import type { ActivityAnalysis, ActivityCatalogItem, ActivityLevel, ActivityOccurrence, ActivityOccurrenceSegment, ActivitySelection, OperationalAnalytics, RadiusPressKey } from '../types/api'
import type { TimedNumericSample } from '../types/evidence'
import { EvidenceDrawerShell } from './EvidenceDrawerShell'
import { PhysicalEvidencePanel } from './PhysicalEvidencePanel'
import { SynchronizedTimeline, type TimelineIntervalItem, type TimelineIntervalTrack } from './SynchronizedTimeline'
import { telemetrySummary, usePressTelemetryEvidence, type PressTelemetryEvidenceState } from './TelemetryEvidenceTimeline'
import { UnifiedProcessTimeline } from './UnifiedProcessTimeline'

const levelLabels: Record<ActivityLevel, string> = { radius_state: 'Radius State', operational_group: 'Operational Group', process_family: 'Process Family', exact_status: 'Exact Radius Status' }
const levelOrder: ActivityLevel[] = ['radius_state', 'operational_group', 'process_family', 'exact_status']
const guideLevelCopy: Record<Exclude<ActivityLevel, 'exact_status'>, { step: string; title: string; help: string }> = {
  radius_state: { step: '1', title: 'Radius phase', help: 'Start with the broad phase Radius recorded.' },
  operational_group: { step: '2', title: 'Operational Group', help: 'Narrow to the ProcessIntelligence explanation of what was happening.' },
  process_family: { step: '3', title: 'Process Family', help: 'Choose the more specific kind of work when useful.' },
}

export type ActivityGuidePath = Partial<Record<ActivityLevel, string>>

function compact(seconds: number | null) { return seconds === null ? 'Not enough evidence' : formatDuration(Math.round(seconds)) }
function barWidth(value: number, maximum: number) { return maximum > 0 ? `${Math.max(value > 0 ? 1 : 0, value / maximum * 100)}%` : '0%' }

function updateActivityUrl(selection: ActivitySelection, mode: 'push' | 'replace' = 'push') {
  const url = new URL(window.location.href)
  url.searchParams.set('activityLevel', selection.level)
  url.searchParams.set('activityKey', selection.key)
  url.searchParams.delete('evidence')
  url.searchParams.delete('occurrenceId')
  window.history[mode === 'push' ? 'pushState' : 'replaceState']({}, '', `${url.pathname}?${url.searchParams}`)
}

function activityFromUrl(): ActivitySelection | undefined {
  if (typeof window === 'undefined') return undefined
  const query = new URLSearchParams(window.location.search)
  const level = query.get('activityLevel')
  const key = query.get('activityKey')
  return key && levelOrder.includes(level as ActivityLevel) ? { level: level as ActivityLevel, key, label: key } : undefined
}

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

function catalogText(item: ActivityCatalogItem) {
  return [item.label, item.description, item.eventType, item.statusCode, item.statusDescription, item.operationalGroupName, item.processFamilyName].filter(Boolean).join(' ').toLowerCase()
}

export function activityGuidePath(item: ActivityCatalogItem): ActivityGuidePath {
  if (item.level === 'radius_state') return { radius_state: item.key }
  if (item.level === 'operational_group') return { operational_group: item.key }
  if (item.level === 'process_family') return { operational_group: item.operationalGroupKey ?? undefined, process_family: item.key }
  return {
    radius_state: item.eventType ?? undefined,
    operational_group: item.operationalGroupKey ?? undefined,
    process_family: item.processFamilyKey ?? undefined,
    exact_status: item.key,
  }
}

export function guidedActivityOptions(catalog: ActivityCatalogItem[], level: ActivityLevel, path: ActivityGuidePath) {
  const exactStatuses = catalog.filter((item) => item.level === 'exact_status')
  const supportsPath = (item: ActivityCatalogItem) => {
    if (path.radius_state && item.eventType !== path.radius_state) return false
    if (path.operational_group && item.operationalGroupKey !== path.operational_group) return false
    if (path.process_family && item.processFamilyKey !== path.process_family) return false
    return true
  }
  if (level === 'radius_state') return catalog.filter((item) => item.level === level)
  if (level === 'exact_status') return exactStatuses.filter(supportsPath)
  return catalog.filter((item) => item.level === level && exactStatuses.some((status) => supportsPath(status) && (level === 'operational_group' ? status.operationalGroupKey === item.key : status.processFamilyKey === item.key)))
}

function pathContains(path: ActivityGuidePath, selected: ActivityCatalogItem) {
  return path[selected.level] === selected.key
}

function ActivityOption({ item, active, onClick }: { item: ActivityCatalogItem; active: boolean; onClick(): void }) {
  return <button type="button" className={`activity-guide__option${active ? ' is-active' : ''}`} aria-pressed={active} onClick={onClick}>
    <span><strong>{item.label}</strong>{item.description && <small>{item.description}</small>}</span>
    {active && <em>Analyzing</em>}
  </button>
}

export function GuidedActivityPicker({ catalog, selected, onSelect }: { catalog: ActivityCatalogItem[]; selected: ActivityCatalogItem; onSelect(item: ActivityCatalogItem): void }) {
  const [path, setPath] = useState<ActivityGuidePath>(() => activityGuidePath(selected))
  const [query, setQuery] = useState('')
  const [codesOpen, setCodesOpen] = useState(selected.level === 'exact_status')

  useEffect(() => {
    if (!pathContains(path, selected)) {
      const next = activityGuidePath(selected)
      setPath(next)
      if (selected.level === 'exact_status') setCodesOpen(true)
    }
  }, [path, selected])

  const choose = (item: ActivityCatalogItem, nextPath = activityGuidePath(item)) => {
    setPath(nextPath)
    setQuery('')
    if (item.level === 'exact_status') setCodesOpen(true)
    onSelect(item)
  }
  const chooseLevel = (item: ActivityCatalogItem) => {
    if (item.level === 'radius_state') choose(item, { radius_state: item.key })
    else if (item.level === 'operational_group') choose(item, { radius_state: path.radius_state, operational_group: item.key })
    else if (item.level === 'process_family') choose(item, { radius_state: path.radius_state, operational_group: path.operational_group, process_family: item.key })
    else choose(item, { ...path, exact_status: item.key })
  }
  const normalizedQuery = query.trim().toLowerCase()
  const searchMatches = normalizedQuery ? catalog.filter((item) => catalogText(item).includes(normalizedQuery)).slice(0, 30) : []
  const stages = (['radius_state', 'operational_group', 'process_family'] as const).map((level) => ({ level, options: guidedActivityOptions(catalog, level, path) }))
  const exactStatuses = guidedActivityOptions(catalog, 'exact_status', path)

  return <section className="panel activity-guide" aria-labelledby="activity-guide-title">
    <div className="activity-guide__heading">
      <div><p className="eyebrow">Guided activity selection</p><h2 id="activity-guide-title">Choose the operational question</h2><p>Move from the broad Radius phase to ProcessIntelligence meaning. Open exact Radius codes only when you need that level of evidence.</p></div>
      <div className="activity-guide__active" aria-live="polite"><span>Currently analyzing</span><strong>{selected.label}</strong><small>{levelLabels[selected.level]}</small></div>
    </div>
    <div className="activity-guide__path" aria-label="Current selection path">
      {levelOrder.map((level) => path[level] && <span key={level}><small>{levelLabels[level]}</small><strong>{catalog.find((item) => item.level === level && item.key === path[level])?.label ?? path[level]}</strong></span>)}
    </div>
    <div className="activity-guide__stages">{stages.map(({ level, options }) => {
      const copy = guideLevelCopy[level]
      const ready = level === 'radius_state' || level === 'operational_group' || Boolean(path.operational_group)
      return <section className={`activity-guide__stage${ready ? '' : ' is-muted'}`} key={level} aria-labelledby={`activity-guide-${level}`}>
        <header><span>{copy.step}</span><div><h3 id={`activity-guide-${level}`}>{copy.title}</h3><p>{copy.help}</p></div></header>
        {ready && <div className="activity-guide__options">{options.map((item) => <ActivityOption key={item.key} item={item} active={selected.level === level && selected.key === item.key} onClick={() => chooseLevel(item)} />)}</div>}
        {!ready ? <p className="activity-guide__empty">Select an Operational Group to continue.</p> : !options.length && <p className="activity-guide__empty">No mapped choices are available under the current path.</p>}
      </section>
    })}</div>
    <div className="activity-guide__codes">
      <button type="button" className="activity-guide__codes-toggle" aria-expanded={codesOpen} aria-controls="activity-exact-codes" onClick={() => setCodesOpen((value) => !value)}><span><strong>{codesOpen ? 'Hide' : 'Show'} exact Radius codes</strong><small>Optional deepest level · {exactStatuses.length} codes match the current path</small></span><b aria-hidden="true">{codesOpen ? '−' : '+'}</b></button>
      {codesOpen && <div id="activity-exact-codes" className="activity-guide__exact"><div className="activity-guide__options">{exactStatuses.map((item) => <ActivityOption key={item.key} item={item} active={selected.level === 'exact_status' && selected.key === item.key} onClick={() => chooseLevel(item)} />)}</div>{!exactStatuses.length && <p className="activity-guide__empty">No exact Radius codes match this path.</p>}</div>}
    </div>
    <div className="activity-guide__search">
      <label htmlFor="activity-guide-search">Search all activities and codes <span>optional shortcut</span></label>
      <div><input id="activity-guide-search" type="search" value={query} placeholder="Search a phase, explanation, family, description, or code" onChange={(event) => setQuery(event.target.value)} autoComplete="off" />{query && <button type="button" onClick={() => setQuery('')}>Clear</button>}</div>
      {normalizedQuery && <div className="activity-guide__search-results" aria-live="polite">{searchMatches.length ? searchMatches.map((item) => <button type="button" key={`${item.level}:${item.key}`} onClick={() => choose(item)}><span><small>{levelLabels[item.level]}</small><strong>{item.label}</strong>{item.description && <em>{item.description}</em>}</span><b>Analyze</b></button>) : <p>No activity or Radius code matches “{query.trim()}”.</p>}</div>}
    </div>
    <p className="activity-guide__purpose">Each choice replaces the one activity being quantified below. Use Patterns &amp; Episodes when you need combinations or sequence.</p>
  </section>
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
  return <div className="analysis-bars">{[...values].sort((a, b) => value(b) - value(a)).map((item) => <button type="button" key={item.pressKey} onClick={() => onPress(item.pressKey)} aria-label={`${item.displayName}; ${compact(item.durationSeconds)}; ${item.occurrenceCount} occurrences; ${item.shareOfObservedPercent.toFixed(1)} percent of observed time; ${item.coveragePercent.toFixed(1)} percent Radius coverage`}><span>{item.displayName}</span><i><b style={{ width: barWidth(value(item), maximum) }} /></i><strong>{metric === 'duration' ? compact(item.durationSeconds) : metric === 'occurrences' ? item.occurrenceCount : `${item.shareOfObservedPercent.toFixed(1)}%`}</strong></button>)}</div>
}

function StateComposition({ data, onState }: { data: ActivityAnalysis; onState(eventType: string): void }) {
  let cursor = 0
  const colors: Record<string, string> = { G: '#27805e', M: '#d3a332', B: '#ba4949', S: '#e1762c' }
  const stops = data.radiusStateComposition.map((item) => { const start = cursor; cursor += item.percentage; return `${colors[item.eventType] ?? '#788795'} ${start}% ${cursor}%` })
  return <div className="activity-composition"><div className="activity-donut" style={{ background: stops.length ? `conic-gradient(${stops.join(',')})` : undefined }} role="img" aria-label={`${data.radiusStateComposition.length} Radius states in this part-to-whole composition`}><span>{data.radiusStateComposition.length}<small>states</small></span></div><div>{data.radiusStateComposition.map((item) => <button type="button" key={item.eventType} onClick={() => onState(item.eventType)}><i style={{ background: colors[item.eventType] ?? '#788795' }} /><span>{item.label}<small>{compact(item.durationSeconds)}</small></span><strong>{item.percentage.toFixed(1)}%</strong></button>)}</div></div>
}

function ActivityTrend({ data, metric }: { data: ActivityAnalysis; metric: 'duration' | 'occurrences' }) {
  const samples: TimedNumericSample[] = data.trend.map((item) => ({ observedAtUtc: item.bucketStartUtc, receivedAtUtc: item.bucketStartUtc, sourceTimestampUtc: item.bucketStartUtc, qualityState: 'AGGREGATED_RADIUS_EVIDENCE', valueKind: 'numeric', value: metric === 'duration' ? item.durationSeconds : item.occurrenceCount }))
  return <SynchronizedTimeline fromUtc={data.fromUtc} toUtc={data.toUtc} ariaLabel={`${data.selection.label} ${data.trendBucket} ${metric} trend`} intervalTracks={[]} numericTracks={[{ id: `trend-${metric}`, label: metric === 'duration' ? 'Activity duration' : 'Occurrences', unit: metric === 'duration' ? 'seconds' : 'count', samples, unavailableLabel: 'No matching activity occurred in this range' }]} />
}

type OccurrenceLayer = 'radius' | 'group' | 'family'

function occurrenceLayer(segment: ActivityOccurrenceSegment, layer: OccurrenceLayer) {
  if (layer === 'radius') return { key: `${segment.eventType}:${segment.statusCode}:${segment.statusDescription}`, label: `${segment.eventType} / ${segment.statusCode ?? '—'} / ${segment.statusDescription}` }
  if (layer === 'group') return { key: segment.operationalGroupKey, label: segment.operationalGroupName }
  return { key: segment.processFamilyKey, label: segment.processFamilyName }
}

export function occurrenceTrack(occurrence: ActivityOccurrence, layer: OccurrenceLayer, clip?: { fromUtc: string; toUtc: string }): TimelineIntervalTrack {
  const from = Date.parse(clip?.fromUtc ?? occurrence.startUtc)
  const to = Date.parse(clip?.toUtc ?? occurrence.endUtc)
  const intervals: TimelineIntervalItem[] = []
  for (const segment of occurrence.segments) {
    const start = Math.max(from, Date.parse(segment.startUtc))
    const end = Math.min(to, Date.parse(segment.endUtc))
    if (end <= start) continue
    const startUtc = new Date(start).toISOString()
    const endUtc = new Date(end).toISOString()
    const identity = occurrenceLayer(segment, layer)
    const previous = intervals.at(-1)
    if (layer !== 'radius' && previous?.endUtc === startUtc && previous.id.startsWith(`${layer}:${identity.key}:`)) {
      previous.endUtc = endUtc
      previous.details = `${identity.label}\n${formatPlantDateTime(previous.startUtc)} – ${formatPlantDateTime(previous.endUtc)} CT`
      continue
    }
    intervals.push({ id: `${layer}:${identity.key}:${segment.segmentId}`, startUtc, endUtc, label: identity.label, details: `${identity.label}\n${formatPlantDateTime(startUtc)} – ${formatPlantDateTime(endUtc)} CT`, className: `run-relative-segment run-relative-segment--${layer === 'family' ? 'family' : segment.eventType === 'G' ? 'good' : segment.eventType === 'M' ? 'make-ready' : segment.eventType === 'B' ? 'bad' : 'other'}` })
  }
  return { id: layer === 'radius' ? 'radius' : layer === 'group' ? 'operational-group' : 'process-family', label: layer === 'radius' ? 'Radius recorded' : layer === 'group' ? 'Operational Group' : 'Process Family', intervals }
}

function FocusedOccurrenceTimeline({ occurrence, evidence, onOpen }: { occurrence: ActivityOccurrence; evidence: PressTelemetryEvidenceState; onOpen(): void }) {
  const summary = telemetrySummary(evidence)
  const sourceUnit = evidence.speed?.actual.sourceUnit ?? 'source units'
  const fullTracks = { radius: occurrenceTrack(occurrence, 'radius'), group: occurrenceTrack(occurrence, 'group'), family: occurrenceTrack(occurrence, 'family') }
  const focusedTracks = evidence.range.focused
    ? { radius: occurrenceTrack(occurrence, 'radius', evidence.range), group: occurrenceTrack(occurrence, 'group', evidence.range), family: occurrenceTrack(occurrence, 'family', evidence.range) }
    : fullTracks
  return <section className="panel physical-signature-summary" aria-labelledby="physical-signature-title">
    <div className="section-heading"><div><p className="eyebrow">Focused occurrence · not representative of every occurrence</p><h2 id="physical-signature-title">Physical signature for {occurrence.displayName}</h2><p>{formatPlantDateTime(occurrence.startUtc)} – {formatPlantDateTime(occurrence.endUtc)} CT · {compact(occurrence.durationSeconds)}</p></div><button type="button" className="primary-action" onClick={onOpen}>Open full evidence</button></div>
    {evidence.range.focused && <><p className="telemetry-range-note">This occurrence exceeds two hours. Complete Radius and semantic chronology remains below; telemetry is not silently chunked or truncated.</p><SynchronizedTimeline fromUtc={occurrence.startUtc} toUtc={occurrence.endUtc} ariaLabel={`${occurrence.displayName} complete occurrence chronology`} intervalTracks={[fullTracks.radius, fullTracks.group, fullTracks.family]} /><h3>Focused two-hour telemetry window</h3><p className="quiet-copy">{formatPlantDateTime(evidence.range.fromUtc)} – {formatPlantDateTime(evidence.range.toUtc)} CT · midpoint-focused physical detail</p></>}
    <UnifiedProcessTimeline fromUtc={evidence.range.fromUtc} toUtc={evidence.range.toUtc} ariaLabel={`${occurrence.displayName} focused occurrence synchronized evidence`} radiusTrack={focusedTracks.radius} groupTrack={focusedTracks.group} familyTrack={focusedTracks.family} telemetry={evidence} />
    <dl className="compact-facts physical-signature-facts"><div><dt>Telemetry</dt><dd>{summary.availability}</dd></div><div><dt>Motion state changes</dt><dd>{summary.motionChanges}</dd></div><div><dt>Actual Speed</dt><dd>{summary.speedSamples} samples{summary.speedMinimum !== null && summary.speedMaximum !== null ? ` · ${summary.speedMinimum}–${summary.speedMaximum} ${sourceUnit}` : ''}</dd></div><div><dt>Context changes</dt><dd>{summary.contextChanges}</dd></div><div><dt>Physical signal changes</dt><dd>{summary.physicalChanges}</dd></div></dl>
    {evidence.error && <p className="message message--warning">Some telemetry is temporarily unavailable. Radius, Operational Group, and Process Family evidence remain usable.</p>}
  </section>
}

function OccurrenceEvidenceDrawer({ occurrence, classificationVersion, evidence, onClose }: { occurrence: ActivityOccurrence; classificationVersion: number; evidence?: PressTelemetryEvidenceState; onClose(): void }) {
  const needsClassification = occurrence.exactIdentities.some(({ needsClassification }) => needsClassification)
  return <EvidenceDrawerShell eyebrow="Evidence · activity occurrence" title={`${occurrence.displayName} · ${occurrence.radiusStateLabel}`} context="Radius, ProcessIntelligence, context, and physical evidence" onClose={onClose}>
    <div className="drawer-content">
      <section className="drawer-section"><h3>Time</h3><dl className="drawer-interval-grid"><div><dt>Start</dt><dd>{formatPlantDateTime(occurrence.startUtc)} CT</dd></div><div><dt>End</dt><dd>{formatPlantDateTime(occurrence.endUtc)} CT</dd></div><div><dt>Duration</dt><dd>{compact(occurrence.durationSeconds)}</dd></div></dl></section>
      <section className="drawer-section"><h3>Radius recorded</h3>{occurrence.exactIdentities.map((identity) => <dl className="compact-facts" key={identity.identity}><div><dt>Event type</dt><dd>{identity.eventType}</dd></div><div><dt>Status code</dt><dd>{identity.statusCode ?? '—'}</dd></div><div><dt>Status description</dt><dd>{identity.statusDescription}</dd></div><div><dt>Observed Radius time</dt><dd>{compact(identity.durationSeconds)}</dd></div></dl>)}</section>
      <section className="drawer-section"><h3>ProcessIntelligence semantic interpretation</h3><dl className="compact-facts"><div><dt>Operational Group</dt><dd>{occurrence.operationalGroupName}</dd></div><div><dt>Process Family</dt><dd>{occurrence.processFamilyName}</dd></div><div><dt>Classification status</dt><dd>{needsClassification ? 'Needs Classification' : `Mapped · published v${classificationVersion}`}</dd></div></dl></section>
      <PhysicalEvidencePanel pressKey={occurrence.pressKey} fromUtc={occurrence.startUtc} toUtc={occurrence.endUtc} evidence={evidence} />
      <section className="drawer-section"><h3>Evidence quality</h3><dl className="compact-facts"><div><dt>Radius evidence</dt><dd>Available for the original interval</dd></div><div><dt>Classification support</dt><dd>{needsClassification ? 'Needs Classification' : 'Published mapping available'}</dd></div><div><dt>Telemetry</dt><dd>Capability-gated and independently loaded above</dd></div></dl></section>
    </div>
  </EvidenceDrawerShell>
}

interface OperationalActivityExplorerViewProps {
  data: ActivityAnalysis
  analytics?: OperationalAnalytics
  occurrences?: ActivityOccurrence[]
  loadingMore?: boolean
  onLoadMore?(): void
}

export function OperationalActivityExplorerView({ data, occurrences = data.occurrences, loadingMore = false, onLoadMore }: OperationalActivityExplorerViewProps) {
  const [pressFocus, setPressFocus] = useState<RadiusPressKey>()
  const [stateFocus, setStateFocus] = useState<string>()
  const [pressMetric, setPressMetric] = useState<'duration' | 'occurrences' | 'share'>('duration')
  const [trendMetric, setTrendMetric] = useState<'duration' | 'occurrences'>('duration')
  const [selectedOccurrence, setSelectedOccurrence] = useState<ActivityOccurrence>()
  const [focusedOccurrenceId, setFocusedOccurrenceId] = useState<string>()
  const evidence = occurrences.filter((item) => (!pressFocus || item.pressKey === pressFocus) && (!stateFocus || item.exactIdentities.some(({ eventType }) => eventType === stateFocus)))
  const focusedOccurrence = evidence.find(({ occurrenceId }) => occurrenceId === focusedOccurrenceId)
    ?? [...evidence].sort((left, right) => Date.parse(left.startUtc) - Date.parse(right.startUtc) || left.occurrenceId.localeCompare(right.occurrenceId))[0]
  const focusedTelemetry = usePressTelemetryEvidence(focusedOccurrence?.pressKey, focusedOccurrence?.startUtc ?? data.fromUtc, focusedOccurrence?.endUtc ?? data.toUtc, { enabled: Boolean(focusedOccurrence) })
  const maxSemantic = Math.max(0, ...data.semanticBreakdown.map(({ durationSeconds }) => durationSeconds))
  const maxBucket = Math.max(0, ...data.durationDistribution.map(({ occurrenceCount }) => occurrenceCount))

  useEffect(() => {
    if (focusedOccurrence && focusedOccurrence.occurrenceId !== focusedOccurrenceId) setFocusedOccurrenceId(focusedOccurrence.occurrenceId)
  }, [focusedOccurrence, focusedOccurrenceId])

  useEffect(() => {
    const restore = () => {
      const query = new URLSearchParams(window.location.search)
      setSelectedOccurrence(query.get('evidence') === 'occurrence' ? occurrences.find(({ occurrenceId }) => occurrenceId === query.get('occurrenceId')) : undefined)
    }
    restore()
    window.addEventListener('popstate', restore)
    return () => window.removeEventListener('popstate', restore)
  }, [occurrences])

  const openOccurrence = (occurrence: ActivityOccurrence) => {
    setFocusedOccurrenceId(occurrence.occurrenceId)
    const url = new URL(window.location.href)
    url.searchParams.set('evidence', 'occurrence')
    url.searchParams.set('occurrenceId', occurrence.occurrenceId)
    window.history.pushState({ processIntelligenceEvidenceDrawer: true }, '', `${url.pathname}?${url.searchParams}`)
    setSelectedOccurrence(occurrence)
  }
  const closeOccurrence = useCallback(() => {
    setSelectedOccurrence(undefined)
    if ((window.history.state as { processIntelligenceEvidenceDrawer?: boolean } | null)?.processIntelligenceEvidenceDrawer) { window.history.back(); return }
    const url = new URL(window.location.href)
    url.searchParams.delete('evidence')
    url.searchParams.delete('occurrenceId')
    window.history.replaceState({}, '', `${url.pathname}?${url.searchParams}`)
  }, [])
  const rowKey = (event: KeyboardEvent<HTMLTableRowElement>, occurrence: ActivityOccurrence) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setFocusedOccurrenceId(occurrence.occurrenceId) }
  }

  return <>
    <section className="panel activity-header"><p className="eyebrow">{levelLabels[data.selection.level]}</p><h2>{data.selection.label}</h2><p>{data.selection.description || 'Observed Radius activity in the selected scope.'}</p>{data.selection.level === 'exact_status' && <p><b>Radius recorded:</b> {data.selection.eventType} / {data.selection.statusCode ?? '—'} / {data.selection.statusDescription}<br /><b>Classified as:</b> {data.selection.operationalGroupName} → {data.selection.processFamilyName}</p>}<Metrics data={data} /><div className="activity-quality"><span>Radius Coverage <b>{data.summary.sourceCoveragePercent.toFixed(1)}%</b></span><span>Classification Coverage <b>{data.summary.classificationCoveragePercent.toFixed(1)}%</b></span><span>Published Classification <b>v{data.classificationVersion}</b></span></div></section>
    <div className="activity-two-column"><section className="panel"><div className="section-heading"><div><p className="eyebrow">Press comparison</p><h2>Duration, occurrences, and share by press</h2></div><div className="segmented-control">{(['duration', 'occurrences', 'share'] as const).map((item) => <button type="button" key={item} className={pressMetric === item ? 'active' : ''} onClick={() => setPressMetric(item)}>{item === 'duration' ? 'Total Time' : item === 'occurrences' ? 'Occurrences' : 'Observed Share'}</button>)}</div></div><HorizontalBars values={data.pressBreakdown} metric={pressMetric} onPress={setPressFocus} /></section>
      <section className="panel"><div className="section-heading"><div><p className="eyebrow">Radius ↔ semantic meaning</p><h2>Radius composition</h2></div></div><StateComposition data={data} onState={setStateFocus} /><p className="annotation-disclaimer">Radius recorded the broad state; Published Classification supplies the operational meaning.</p></section></div>
    <div className="activity-two-column"><section className="panel"><div className="section-heading"><div><p className="eyebrow">Time trend</p><h2>{data.trendBucket === 'day' ? 'Daily' : 'Hourly'} line trend</h2></div><div className="segmented-control"><button type="button" className={trendMetric === 'duration' ? 'active' : ''} onClick={() => setTrendMetric('duration')}>Duration</button><button type="button" className={trendMetric === 'occurrences' ? 'active' : ''} onClick={() => setTrendMetric('occurrences')}>Occurrences</button></div></div><ActivityTrend data={data} metric={trendMetric} /></section>
      <section className="panel"><div className="section-heading"><div><p className="eyebrow">Duration distribution</p><h2>Occurrence duration</h2></div></div>{data.summary.occurrenceCount >= 5 ? <div className="distribution-bars">{data.durationDistribution.map((item) => <div key={item.key}><span>{item.label}</span><i><b style={{ width: barWidth(item.occurrenceCount, maxBucket) }} /></i><strong>{item.occurrenceCount}</strong></div>)}</div> : <p className="empty-state">At least five occurrences are required for a useful duration distribution.</p>}{data.summary.p95OccurrenceSeconds !== null && <p className="quiet-copy">P95 occurrence duration: {compact(data.summary.p95OccurrenceSeconds)} · shown because at least 20 occurrences are available.</p>}</section></div>
    <section className="panel"><div className="section-heading"><div><p className="eyebrow">Semantic composition</p><h2>{data.selection.level === 'radius_state' ? 'Operational groups' : data.selection.level === 'operational_group' ? 'Process families' : 'Exact supporting Radius evidence'}</h2></div></div><div className="semantic-bars">{data.semanticBreakdown.map((item) => <div key={`${item.level}:${item.key}`}><span>{item.label}</span><i><b style={{ width: barWidth(item.durationSeconds, maxSemantic) }} /></i><strong>{compact(item.durationSeconds)} · {item.percentage.toFixed(1)}%</strong></div>)}</div></section>
    <section className="panel activity-evidence"><div className="section-heading"><div><p className="eyebrow">Exact occurrences</p><h2>Radius and classification evidence</h2><p>Select a row to update the focused physical signature. Use Open evidence for the complete detail drawer.</p></div>{(pressFocus || stateFocus) && <button type="button" className="clear-focus" onClick={() => { setPressFocus(undefined); setStateFocus(undefined) }}>Clear local evidence focus</button>}</div>{pressFocus && <p className="focus-chip">Local evidence focus: {data.pressBreakdown.find(({ pressKey }) => pressKey === pressFocus)?.displayName}</p>}{stateFocus && <p className="focus-chip">Local Radius-state focus: {data.radiusStateComposition.find(({ eventType }) => eventType === stateFocus)?.label}</p>}<div className="analysis-table-scroll"><table><thead><tr><th>Press</th><th>Start</th><th>End</th><th>Duration</th><th>Radius identity</th><th>Operational Group</th><th>Process Family</th><th>Classification status</th><th>Evidence</th></tr></thead><tbody>{evidence.map((item) => <tr key={item.occurrenceId} className={`clickable-row ${focusedOccurrence?.occurrenceId === item.occurrenceId ? 'is-focused' : ''}`} tabIndex={0} role="button" aria-pressed={focusedOccurrence?.occurrenceId === item.occurrenceId} aria-label={`Focus ${item.displayName} occurrence at ${formatPlantDateTime(item.startUtc)}`} onClick={() => setFocusedOccurrenceId(item.occurrenceId)} onKeyDown={(event) => rowKey(event, item)}><th>{item.displayName}</th><td>{formatPlantDateTime(item.startUtc)} CT</td><td>{formatPlantDateTime(item.endUtc)} CT</td><td>{compact(item.durationSeconds)}</td><td>{item.exactIdentities.map((identity) => <span className="exact-evidence" key={identity.identity}>{identity.eventType} / {identity.statusCode ?? '—'} / {identity.statusDescription}</span>)}</td><td>{item.operationalGroupName}</td><td>{item.processFamilyName}</td><td>{item.exactIdentities.some(({ needsClassification }) => needsClassification) ? 'Needs Classification' : `Mapped · v${data.classificationVersion}`}</td><td><button type="button" className="secondary-action" onClick={(event) => { event.stopPropagation(); openOccurrence(item) }}>Open evidence</button></td></tr>)}</tbody></table></div>{occurrences.length < data.totalOccurrenceCount && <div className="evidence-paging"><p>Showing {occurrences.length} of {data.totalOccurrenceCount} exact occurrences. Summaries use the full scope.</p><button type="button" disabled={loadingMore || !onLoadMore} onClick={onLoadMore}>{loadingMore ? 'Loading…' : `Load next ${Math.min(data.evidenceLimit, data.totalOccurrenceCount - occurrences.length)}`}</button></div>}</section>
    {focusedOccurrence ? <FocusedOccurrenceTimeline occurrence={focusedOccurrence} evidence={focusedTelemetry} onOpen={() => openOccurrence(focusedOccurrence)} /> : <section className="panel empty-state"><h2>Physical signature</h2><p>No occurrence is available in the current evidence page and local focus.</p></section>}
    {selectedOccurrence && <OccurrenceEvidenceDrawer occurrence={selectedOccurrence} classificationVersion={data.classificationVersion} evidence={selectedOccurrence.occurrenceId === focusedOccurrence?.occurrenceId ? focusedTelemetry : undefined} onClose={closeOccurrence} />}
  </>
}

export function OperationalActivityExplorer({ fromUtc, toUtc, pressKey, analytics: _analytics }: { fromUtc: string; toUtc: string; pressKey?: RadiusPressKey; analytics: OperationalAnalytics }) {
  const [data, setData] = useState<ActivityAnalysis>()
  const [occurrences, setOccurrences] = useState<ActivityOccurrence[]>([])
  const [selection, setSelection] = useState<ActivitySelection>(() => activityFromUrl() ?? { level: 'radius_state', key: 'B', label: 'Bad' })
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState(false)
  const pageRequest = useRef<AbortController | undefined>(undefined)

  useEffect(() => {
    pageRequest.current?.abort()
    const controller = new AbortController()
    setLoading(true)
    setError(false)
    void getActivityAnalysis(fromUtc, toUtc, selection, pressKey, controller.signal).then((value) => {
      if (controller.signal.aborted) return
      setData(value)
      setOccurrences(value.occurrences)
      const resolved = { level: value.selection.level, key: value.selection.key, label: value.selection.label }
      setSelection(resolved)
      const query = new URLSearchParams(window.location.search)
      if (!query.has('activityLevel') || !query.has('activityKey')) updateActivityUrl(resolved, 'replace')
    }).catch(() => { if (!controller.signal.aborted) setError(true) }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => { controller.abort(); pageRequest.current?.abort() }
  }, [fromUtc, toUtc, pressKey, selection.level, selection.key])

  useEffect(() => {
    const restore = () => {
      const restored = activityFromUrl()
      if (restored) setSelection(restored)
    }
    window.addEventListener('popstate', restore)
    return () => window.removeEventListener('popstate', restore)
  }, [])

  const choose = (item: ActivityCatalogItem) => {
    const next = { level: item.level, key: item.key, label: item.label }
    updateActivityUrl(next)
    setSelection(next)
  }
  const loadMore = () => {
    if (!data || loadingMore || occurrences.length >= data.totalOccurrenceCount) return
    pageRequest.current?.abort()
    const controller = new AbortController()
    pageRequest.current = controller
    setLoadingMore(true)
    void getActivityAnalysis(fromUtc, toUtc, selection, pressKey, controller.signal, occurrences.length).then((page) => { if (!controller.signal.aborted) setOccurrences((current) => [...current, ...page.occurrences.filter((item) => !current.some(({ occurrenceId }) => occurrenceId === item.occurrenceId))]) }).catch(() => { if (!controller.signal.aborted) setError(true) }).finally(() => { if (!controller.signal.aborted) setLoadingMore(false) })
  }
  const activeChoice = data?.catalog.find((item) => item.level === selection.level && item.key === selection.key) ?? data?.selection
  return <div className="activity-explorer">{data && activeChoice && <GuidedActivityPicker catalog={data.catalog} selected={activeChoice} onSelect={choose} />}{loading && <div className="scope-progress" role="status"><i />Updating activity analysis…</div>}{error && <p className="message message--warning">Activity analysis could not be loaded for this selection. Previously loaded evidence remains visible.</p>}{data && <OperationalActivityExplorerView data={data} analytics={_analytics} occurrences={occurrences} loadingMore={loadingMore} onLoadMore={loadMore} />}</div>
}
