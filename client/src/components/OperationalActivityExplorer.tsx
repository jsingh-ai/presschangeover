import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { getActivityAnalysis } from '../api/process-intelligence-api'
import { formatDuration } from '../episode-presentation'
import { formatPlantDateTime } from '../time-ranges'
import type { ActivityAnalysis, ActivityCatalogItem, ActivityLevel, ActivityOccurrence, ActivitySelection, OperationalAnalytics, OverviewTimelineInterval, RadiusPressKey } from '../types/api'
import { EvidenceDrawerShell } from './EvidenceDrawerShell'
import { PhysicalEvidencePanel } from './PhysicalEvidencePanel'
import { SynchronizedTimeline, type TimelineIntervalItem, type TimelineIntervalTrack } from './SynchronizedTimeline'
import { boundedEvidenceRange, MAX_FULL_TELEMETRY_RANGE_MS, telemetrySummary, usePressTelemetryEvidence, type PressTelemetryEvidenceState } from './TelemetryEvidenceTimeline'
import { UnifiedProcessTimeline } from './UnifiedProcessTimeline'
import { timelineFamilyLabel } from './RadiusOverview'

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
  if (selection.operationalGroupKey) url.searchParams.set('activityGroup', selection.operationalGroupKey)
  else url.searchParams.delete('activityGroup')
  url.searchParams.delete('evidence')
  url.searchParams.delete('occurrenceId')
  window.history[mode === 'push' ? 'pushState' : 'replaceState']({}, '', `${url.pathname}?${url.searchParams}`)
}

function activityFromUrl(): ActivitySelection | undefined {
  if (typeof window === 'undefined') return undefined
  const query = new URLSearchParams(window.location.search)
  const level = query.get('activityLevel')
  const key = query.get('activityKey')
  const operationalGroupKey = query.get('activityGroup')
  return key && levelOrder.includes(level as ActivityLevel) ? { level: level as ActivityLevel, key, label: key, ...(operationalGroupKey ? { operationalGroupKey } : {}) } : undefined
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
      return values.length ? <section key={level}><h3>{levelLabels[level]}</h3>{values.map((item) => <button type="button" key={`${item.level}:${item.operationalGroupKey ?? ''}:${item.key}`} onClick={() => { onSelect(item); setQuery(''); setOpen(false) }}><strong>{item.label}</strong>{item.level === 'process_family' && item.operationalGroupName && <small>{item.operationalGroupName}</small>}{item.description && <small>{item.description}</small>}{item.needsClassification && <em>Needs Classification</em>}</button>)}</section> : null
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
  const supportsUpstreamPath = (item: ActivityCatalogItem) => {
    if (level !== 'radius_state' && path.radius_state && item.eventType !== path.radius_state) return false
    if ((level === 'process_family' || level === 'exact_status') && path.operational_group && item.operationalGroupKey !== path.operational_group) return false
    if (level === 'exact_status' && path.process_family && item.processFamilyKey !== path.process_family) return false
    return true
  }
  if (level === 'radius_state') return catalog.filter((item) => item.level === level)
  if (level === 'exact_status') return exactStatuses.filter(supportsUpstreamPath)
  return catalog.filter((item) => item.level === level && (level !== 'process_family' || !path.operational_group || item.operationalGroupKey === path.operational_group) && exactStatuses.some((status) => supportsUpstreamPath(status) && (level === 'operational_group' ? status.operationalGroupKey === item.key : status.processFamilyKey === item.key)))
}

function pathContains(path: ActivityGuidePath, selected: ActivityCatalogItem) {
  return path[selected.level] === selected.key && (selected.level !== 'process_family' || !selected.operationalGroupKey || path.operational_group === selected.operationalGroupKey)
}

function ActivityOption({ item, active, analyzing, onClick }: { item: ActivityCatalogItem; active: boolean; analyzing: boolean; onClick(): void }) {
  return <button type="button" className={`activity-guide__option${active ? ' is-active' : ''}`} aria-pressed={active} onClick={onClick}>
    <span><strong>{item.label}</strong>{item.description && <small>{item.description}</small>}</span>
    <span className="activity-guide__option-meta">{item.level !== 'exact_status' && item.durationSeconds !== undefined && <><b>{compact(item.durationSeconds)}</b><small>{(item.percentageOfObservedTime ?? 0).toFixed(1)}% observed</small></>}{active && <em>{analyzing ? 'Analyzing' : 'Selected'}</em>}</span>
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
        {ready && <div className="activity-guide__options">{options.map((item) => <ActivityOption key={`${item.operationalGroupKey ?? ''}:${item.key}`} item={item} active={path[level] === item.key} analyzing={selected.level === level && selected.key === item.key && (level !== 'process_family' || selected.operationalGroupKey === item.operationalGroupKey)} onClick={() => chooseLevel(item)} />)}</div>}
        {!ready ? <p className="activity-guide__empty">Select an Operational Group to continue.</p> : !options.length && <p className="activity-guide__empty">No mapped choices are available under the current path.</p>}
      </section>
    })}</div>
    <div className="activity-guide__codes">
      <button type="button" className="activity-guide__codes-toggle" aria-expanded={codesOpen} aria-controls="activity-exact-codes" onClick={() => setCodesOpen((value) => !value)}><span><strong>{codesOpen ? 'Hide' : 'Show'} exact Radius codes</strong><small>Optional deepest level · {exactStatuses.length} codes match the current path</small></span><b aria-hidden="true">{codesOpen ? '−' : '+'}</b></button>
      {codesOpen && <div id="activity-exact-codes" className="activity-guide__exact"><div className="activity-guide__options">{exactStatuses.map((item) => <ActivityOption key={item.key} item={item} active={path.exact_status === item.key} analyzing={selected.level === 'exact_status' && selected.key === item.key} onClick={() => chooseLevel(item)} />)}</div>{!exactStatuses.length && <p className="activity-guide__empty">No exact Radius codes match this path.</p>}</div>}
    </div>
    <div className="activity-guide__search">
      <label htmlFor="activity-guide-search">Search all activities and codes <span>optional shortcut</span></label>
      <div><input id="activity-guide-search" type="search" value={query} placeholder="Search a phase, explanation, family, description, or code" onChange={(event) => setQuery(event.target.value)} autoComplete="off" />{query && <button type="button" onClick={() => setQuery('')}>Clear</button>}</div>
      {normalizedQuery && <div className="activity-guide__search-results" aria-live="polite">{searchMatches.length ? searchMatches.map((item) => <button type="button" key={`${item.level}:${item.operationalGroupKey ?? ''}:${item.key}`} onClick={() => choose(item)}><span><small>{levelLabels[item.level]}{item.level === 'process_family' && item.operationalGroupName ? ` · ${item.operationalGroupName}` : ''}</small><strong>{item.label}</strong>{item.description && <em>{item.description}</em>}</span><b>Analyze</b></button>) : <p>No activity or Radius code matches “{query.trim()}”.</p>}</div>}
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

function HorizontalBars({ values, metric, onPress }: { values: ActivityAnalysis['pressBreakdown']; metric: 'duration' | 'occurrences' | 'average'; onPress(key: RadiusPressKey): void }) {
  const average = (item: ActivityAnalysis['pressBreakdown'][number]) => item.occurrenceCount > 0 ? item.durationSeconds / item.occurrenceCount : 0
  const value = (item: ActivityAnalysis['pressBreakdown'][number]) => metric === 'duration' ? item.durationSeconds : metric === 'occurrences' ? item.occurrenceCount : average(item)
  const maximum = Math.max(0, ...values.map(value))
  return <div className="analysis-bars">{[...values].sort((a, b) => a.displayName.localeCompare(b.displayName, undefined, { numeric: true })).map((item) => <button type="button" key={item.pressKey} onClick={() => onPress(item.pressKey)} aria-label={`${item.displayName}; ${compact(item.durationSeconds)} total; ${item.occurrenceCount} occurrences; ${item.occurrenceCount ? compact(average(item)) : 'no average'} per occurrence; ${item.coveragePercent.toFixed(1)} percent Radius coverage`}><span>{item.displayName}</span><i><b style={{ width: barWidth(value(item), maximum) }} /></i><strong>{metric === 'duration' ? compact(item.durationSeconds) : metric === 'occurrences' ? item.occurrenceCount : item.occurrenceCount ? compact(average(item)) : '—'}</strong></button>)}</div>
}

function intervalMatchesSelection(interval: OverviewTimelineInterval, selection: ActivitySelection) {
  if (interval.isUnavailable) return false
  if (selection.level === 'radius_state') return interval.eventType === selection.key
  if (selection.level === 'operational_group') return interval.operationalGroupKey === selection.key
  if (selection.level === 'process_family') return interval.processFamilyKey === selection.key && (!selection.operationalGroupKey || interval.operationalGroupKey === selection.operationalGroupKey)
  return [interval.eventType ?? '', interval.statusCode ?? '', interval.statusDescription ?? ''].join('\u001f') === selection.key
}

function rangeStateClass(eventType: string | null) {
  return eventType === 'G' ? 'good' : eventType === 'M' ? 'make-ready' : eventType === 'B' ? 'bad' : eventType === 'S' ? 'safety' : eventType ? 'other' : 'offline'
}

export function fullRangeActivityTracks(intervals: OverviewTimelineInterval[], selection: ActivitySelection) {
  const track = (layer: 'radius' | 'group' | 'family'): TimelineIntervalTrack => ({
    id: layer === 'radius' ? 'radius' : layer === 'group' ? 'operational-group' : 'process-family',
    label: layer === 'radius' ? 'Radius recorded' : layer === 'group' ? 'Operational Group' : 'Process Family',
    unavailableLabel: 'No Radius evidence was available in this range',
    intervals: intervals.map((interval): TimelineIntervalItem => {
      const label = interval.isUnavailable ? 'Data unavailable' : layer === 'radius' ? interval.radiusStateLabel : layer === 'group' ? interval.operationalGroupLabel : timelineFamilyLabel(interval)
      const matched = intervalMatchesSelection(interval, selection)
      return {
        id: `activity-range:${layer}:${interval.intervalId}`,
        startUtc: interval.startUtc,
        endUtc: interval.endUtc,
        label,
        details: `${label}\n${formatPlantDateTime(interval.startUtc)} – ${formatPlantDateTime(interval.endUtc)} CT\n${matched ? `Matches selected ${levelLabels[selection.level]}: ${selection.label}` : `Context outside selected ${levelLabels[selection.level]}`}`,
        unavailable: interval.isUnavailable,
        className: `overview-gantt-segment overview-gantt-segment--${layer === 'radius' ? rangeStateClass(interval.eventType) : layer} activity-range-segment activity-range-segment--${matched ? 'match' : interval.isUnavailable ? 'unavailable' : 'context'}`,
        style: layer === 'group' ? { '--overview-light': interval.operationalGroupLightColor ?? '#68727d', '--overview-dark': interval.operationalGroupDarkColor ?? '#9ca8b5' } as CSSProperties : undefined,
      }
    }),
  })
  return { radius: track('radius'), group: track('group'), family: track('family') }
}

function occurrenceTimelineIntervals(occurrences: ActivityOccurrence[], pressKey?: RadiusPressKey): OverviewTimelineInterval[] {
  return occurrences.filter((occurrence) => !pressKey || occurrence.pressKey === pressKey).flatMap((occurrence) => occurrence.segments.map((segment) => ({
    intervalId: segment.segmentId, startUtc: segment.startUtc, endUtc: segment.endUtc, durationSeconds: segment.durationSeconds, isUnavailable: false,
    eventType: segment.eventType, statusCode: segment.statusCode, statusDescription: segment.statusDescription, radiusStateLabel: segment.eventType,
    operationalGroupKey: segment.operationalGroupKey, operationalGroupLabel: segment.operationalGroupName, operationalGroupLightColor: null, operationalGroupDarkColor: null,
    processFamilyKey: segment.processFamilyKey, processFamilyLabel: segment.processFamilyName, classificationNeedsReview: false,
    classificationStatus: segment.needsClassification ? 'needs_classification' as const : 'mapped' as const,
  })))
}

export function occurrenceEvidenceTracks(occurrence: ActivityOccurrence, clip?: { fromUtc: string; toUtc: string }): { radius: TimelineIntervalTrack; group: TimelineIntervalTrack } {
  const from = Date.parse(clip?.fromUtc ?? occurrence.startUtc)
  const to = Date.parse(clip?.toUtc ?? occurrence.endUtc)
  const intervals = occurrence.segments.flatMap((segment): Array<{ segment: ActivityOccurrence['segments'][number]; startUtc: string; endUtc: string }> => {
    const start = Math.max(from, Date.parse(segment.startUtc))
    const end = Math.min(to, Date.parse(segment.endUtc))
    return end > start ? [{ segment, startUtc: new Date(start).toISOString(), endUtc: new Date(end).toISOString() }] : []
  })
  const interval = (layer: 'radius' | 'group'): TimelineIntervalTrack => ({
    id: layer === 'radius' ? 'radius' : 'operational-group',
    label: layer === 'radius' ? 'Radius recorded' : 'Operational Group',
    unavailableLabel: 'No Radius evidence was available in this interval',
    intervals: intervals.map(({ segment, startUtc, endUtc }) => {
      const label = layer === 'radius' ? `${segment.eventType} / ${segment.statusCode ?? '—'} / ${segment.statusDescription}` : segment.operationalGroupName
      return {
        id: `occurrence:${layer}:${segment.segmentId}`,
        startUtc,
        endUtc,
        label,
        details: `${label}\n${formatPlantDateTime(startUtc)} – ${formatPlantDateTime(endUtc)} CT`,
        className: `overview-gantt-segment overview-gantt-segment--${layer === 'radius' ? rangeStateClass(segment.eventType) : 'group'}`,
        style: layer === 'group' ? { '--overview-light': '#64748b', '--overview-dark': '#94a3b8' } as CSSProperties : undefined,
      }
    }),
  })
  return { radius: interval('radius'), group: interval('group') }
}

function FullRangePhysicalSignature({ data, pressKey, displayName, intervals, evidence, telemetryAvailable, onPress }: { data: ActivityAnalysis; pressKey?: RadiusPressKey; displayName?: string; intervals: OverviewTimelineInterval[]; evidence: PressTelemetryEvidenceState; telemetryAvailable: boolean; onPress(key: RadiusPressKey): void }) {
  const tracks = fullRangeActivityTracks(intervals, data.selection)
  const summary = telemetrySummary(evidence)
  const sourceUnit = evidence.speed?.actual.sourceUnit ?? 'source units'
  const pressChoices = data.pressBreakdown.filter(({ occurrenceCount }) => occurrenceCount > 0).sort((left, right) => left.displayName.localeCompare(right.displayName, undefined, { numeric: true }))
  return <section className="panel physical-signature-summary activity-range-signature" aria-labelledby="physical-signature-title">
    <div className="section-heading"><div><p className="eyebrow">Complete selected range · matching activity highlighted</p><h2 id="physical-signature-title">Physical signature across the full time range</h2><p>{formatPlantDateTime(data.fromUtc)} – {formatPlantDateTime(data.toUtc)} CT · {displayName ?? 'No matching press'}</p></div></div>
    {pressKey && pressChoices.length > 1 && <div className="activity-signature-presses" role="group" aria-label="Timeline press"><span>Timeline press</span><div>{pressChoices.map((press) => <button type="button" key={press.pressKey} className={press.pressKey === pressKey ? 'is-active' : ''} aria-pressed={press.pressKey === pressKey} onClick={() => onPress(press.pressKey)}><strong>{press.displayName}</strong><small>{press.occurrenceCount} {press.occurrenceCount === 1 ? 'occurrence' : 'occurrences'}</small></button>)}</div></div>}
    <p className="activity-range-classification"><span>Published Classification v{data.classificationVersion}</span><strong>{data.selection.operationalGroupName ? `${data.selection.operationalGroupName} → ` : ''}{data.selection.label}</strong><small>{data.selection.level === 'process_family' ? 'Only exact Radius identities assigned to this Operational Group and Process Family pair are highlighted.' : 'The highlighted intervals use this same published classification response.'}</small></p>
    <p className="activity-range-explanation"><strong>{data.selection.label}</strong> is emphasized; surrounding Radius and ProcessIntelligence states remain visible so its timing is not detached from the rest of the selected range.</p>
    {!pressKey || !intervals.length ? <p className="empty-state">No matching activity is available to establish a press timeline in this range.</p> : telemetryAvailable ? <>
      {evidence.loading && <div className="scope-progress" role="status"><i />Loading motion and speed for the complete selected range…</div>}
      <UnifiedProcessTimeline fromUtc={data.fromUtc} toUtc={data.toUtc} ariaLabel={`${displayName} full selected-range activity and physical signature`} radiusTrack={tracks.radius} groupTrack={tracks.group} familyTrack={tracks.family} telemetry={evidence} />
      <dl className="compact-facts physical-signature-facts"><div><dt>Telemetry</dt><dd>{summary.availability}</dd></div><div><dt>Motion state changes</dt><dd>{summary.motionChanges}</dd></div><div><dt>Actual Speed</dt><dd>{summary.speedSamples} samples{summary.speedMinimum !== null && summary.speedMaximum !== null ? ` · ${summary.speedMinimum}–${summary.speedMaximum} ${sourceUnit}` : ''}</dd></div><div><dt>Context changes</dt><dd>{summary.contextChanges}</dd></div><div><dt>Physical signal changes</dt><dd>{summary.physicalChanges}</dd></div></dl>
      {evidence.error && <p className="message message--warning">Some telemetry is temporarily unavailable. The complete Radius and ProcessIntelligence chronology remains usable.</p>}
    </> : <>
      <p className="telemetry-range-note">This range exceeds 24 hours. Complete Radius and ProcessIntelligence chronology is shown on the exact selected-range axis. Motion and speed are not replaced with an unrelated two-hour event window.</p>
      <UnifiedProcessTimeline fromUtc={data.fromUtc} toUtc={data.toUtc} ariaLabel={`${displayName} complete selected-range activity chronology`} radiusTrack={tracks.radius} groupTrack={tracks.group} familyTrack={tracks.family} />
    </>}
  </section>
}

export function OccurrenceEvidenceDrawer({ occurrence, classificationVersion, evidence, onClose }: { occurrence: ActivityOccurrence; classificationVersion: number; evidence?: PressTelemetryEvidenceState; onClose(): void }) {
  const needsClassification = occurrence.exactIdentities.some(({ needsClassification }) => needsClassification)
  const evidenceRange = evidence?.range ?? boundedEvidenceRange(occurrence.startUtc, occurrence.endUtc)
  const tracks = occurrenceEvidenceTracks(occurrence, evidenceRange)
  return <EvidenceDrawerShell eyebrow="Evidence · activity occurrence" title={`${occurrence.displayName} · ${occurrence.radiusStateLabel}`} context="Radius, ProcessIntelligence, context, and physical evidence" onClose={onClose}>
    <div className="drawer-content">
      <section className="drawer-section"><h3>Time</h3><dl className="drawer-interval-grid"><div><dt>Start</dt><dd>{formatPlantDateTime(occurrence.startUtc)} CT</dd></div><div><dt>End</dt><dd>{formatPlantDateTime(occurrence.endUtc)} CT</dd></div><div><dt>Duration</dt><dd>{compact(occurrence.durationSeconds)}</dd></div></dl></section>
      <section className="drawer-section"><h3>Radius recorded</h3>{occurrence.exactIdentities.map((identity) => <dl className="compact-facts" key={identity.identity}><div><dt>Event type</dt><dd>{identity.eventType}</dd></div><div><dt>Status code</dt><dd>{identity.statusCode ?? '—'}</dd></div><div><dt>Status description</dt><dd>{identity.statusDescription}</dd></div><div><dt>Observed Radius time</dt><dd>{compact(identity.durationSeconds)}</dd></div></dl>)}</section>
      <section className="drawer-section"><h3>ProcessIntelligence semantic interpretation</h3><dl className="compact-facts"><div><dt>Operational Group</dt><dd>{occurrence.operationalGroupName}</dd></div><div><dt>Process Family</dt><dd>{occurrence.processFamilyName}</dd></div><div><dt>Classification status</dt><dd>{needsClassification ? 'Needs Classification' : `Mapped · published v${classificationVersion}`}</dd></div></dl></section>
      <PhysicalEvidencePanel pressKey={occurrence.pressKey} fromUtc={occurrence.startUtc} toUtc={occurrence.endUtc} evidence={evidence} semanticIntervalTracks={[tracks.radius, tracks.group]} />
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
  const [selectedOccurrence, setSelectedOccurrence] = useState<ActivityOccurrence>()
  const [focusedOccurrenceId, setFocusedOccurrenceId] = useState<string>()
  const evidence = occurrences.filter((item) => !pressFocus || item.pressKey === pressFocus)
  const focusedOccurrence = evidence.find(({ occurrenceId }) => occurrenceId === focusedOccurrenceId)
    ?? [...evidence].sort((left, right) => Date.parse(left.startUtc) - Date.parse(right.startUtc) || left.occurrenceId.localeCompare(right.occurrenceId))[0]
  const signaturePressKey = pressFocus ?? focusedOccurrence?.pressKey ?? data.pressBreakdown.find(({ occurrenceCount }) => occurrenceCount > 0)?.pressKey
  const signaturePress = data.pressBreakdown.find(({ pressKey }) => pressKey === signaturePressKey)
  const classifiedTimeline = data.pressTimelines?.find(({ pressKey }) => pressKey === signaturePressKey)
  const signatureIntervals = classifiedTimeline?.timelineIntervals ?? occurrenceTimelineIntervals(occurrences, signaturePressKey)
  const telemetryAvailable = Date.parse(data.toUtc) - Date.parse(data.fromUtc) <= MAX_FULL_TELEMETRY_RANGE_MS
  const rangeTelemetry = usePressTelemetryEvidence(signaturePressKey, data.fromUtc, data.toUtc, { enabled: Boolean(signaturePressKey) && telemetryAvailable, fullRange: true, padShortRange: false })
  const drawerTelemetry = usePressTelemetryEvidence(selectedOccurrence?.pressKey, selectedOccurrence?.startUtc ?? data.fromUtc, selectedOccurrence?.endUtc ?? data.toUtc, { enabled: Boolean(selectedOccurrence) })
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
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setFocusedOccurrenceId(occurrence.occurrenceId); setPressFocus(occurrence.pressKey) }
  }
  const exactOccurrences = <section className="panel activity-evidence"><div className="section-heading"><div><p className="eyebrow">Exact occurrences</p><h2>Radius and classification evidence</h2><p>Select a row to show that press across the complete time range above. Use Open evidence for this occurrence’s detail drawer.</p></div>{pressFocus && <button type="button" className="clear-focus" onClick={() => setPressFocus(undefined)}>Clear local evidence focus</button>}</div>{pressFocus && <p className="focus-chip">Local evidence focus: {data.pressBreakdown.find(({ pressKey }) => pressKey === pressFocus)?.displayName}</p>}<div className="analysis-table-scroll"><table><thead><tr><th>Press</th><th>Start</th><th>End</th><th>Duration</th><th>Radius identity</th><th>Operational Group</th><th>Process Family</th><th>Classification status</th><th>Evidence</th></tr></thead><tbody>{evidence.map((item) => <tr key={item.occurrenceId} className={`clickable-row ${focusedOccurrence?.occurrenceId === item.occurrenceId ? 'is-focused' : ''}`} tabIndex={0} role="button" aria-pressed={focusedOccurrence?.occurrenceId === item.occurrenceId} aria-label={`Show ${item.displayName} across the complete selected range`} onClick={() => { setFocusedOccurrenceId(item.occurrenceId); setPressFocus(item.pressKey) }} onKeyDown={(event) => rowKey(event, item)}><th>{item.displayName}</th><td>{formatPlantDateTime(item.startUtc)} CT</td><td>{formatPlantDateTime(item.endUtc)} CT</td><td>{compact(item.durationSeconds)}</td><td>{item.exactIdentities.map((identity) => <span className="exact-evidence" key={identity.identity}>{identity.eventType} / {identity.statusCode ?? '—'} / {identity.statusDescription}</span>)}</td><td>{item.operationalGroupName}</td><td>{item.processFamilyName}</td><td>{item.exactIdentities.some(({ needsClassification }) => needsClassification) ? 'Needs Classification' : `Mapped · v${data.classificationVersion}`}</td><td><button type="button" className="secondary-action" onClick={(event) => { event.stopPropagation(); openOccurrence(item) }}>Open evidence</button></td></tr>)}</tbody></table></div>{occurrences.length < data.totalOccurrenceCount && <div className="evidence-paging"><p>Showing {occurrences.length} of {data.totalOccurrenceCount} exact occurrences. Summaries use the full scope.</p><button type="button" disabled={loadingMore || !onLoadMore} onClick={onLoadMore}>{loadingMore ? 'Loading…' : `Load next ${Math.min(data.evidenceLimit, data.totalOccurrenceCount - occurrences.length)}`}</button></div>}</section>

  return <>
    <section className="panel activity-header"><p className="eyebrow">{levelLabels[data.selection.level]}</p><h2>{data.selection.label}</h2><p>{data.selection.description || 'Observed Radius activity in the selected scope.'}</p>{data.selection.level === 'exact_status' && <p><b>Radius recorded:</b> {data.selection.eventType} / {data.selection.statusCode ?? '—'} / {data.selection.statusDescription}<br /><b>Classified as:</b> {data.selection.operationalGroupName} → {data.selection.processFamilyName}</p>}<Metrics data={data} /><div className="activity-quality"><span>Radius Coverage <b>{data.summary.sourceCoveragePercent.toFixed(1)}%</b></span><span>Classification Coverage <b>{data.summary.classificationCoveragePercent.toFixed(1)}%</b></span><span>Published Classification <b>v{data.classificationVersion}</b></span></div></section>
    <div className="activity-analysis-summary-grid" aria-label="Operational activity summaries"><section className="panel activity-press-comparison"><div className="section-heading"><div><p className="eyebrow">Press comparison</p><h2>Time and frequency by press</h2><p>Every column uses the same numeric press order. Average is total selected-activity time divided by occurrences.</p></div></div><div className="activity-press-metric-grid"><article><h3>Total Time</h3><HorizontalBars values={data.pressBreakdown} metric="duration" onPress={setPressFocus} /></article><article><h3>Occurrences</h3><HorizontalBars values={data.pressBreakdown} metric="occurrences" onPress={setPressFocus} /></article><article><h3>Average</h3><small>Total time ÷ occurrences</small><HorizontalBars values={data.pressBreakdown} metric="average" onPress={setPressFocus} /></article></div></section>
      <section className="panel"><div className="section-heading"><div><p className="eyebrow">Duration distribution</p><h2>Occurrence duration</h2></div></div>{data.summary.occurrenceCount >= 5 ? <div className="distribution-bars">{data.durationDistribution.map((item) => <div key={item.key}><span>{item.label}</span><i><b style={{ width: barWidth(item.occurrenceCount, maxBucket) }} /></i><strong>{item.occurrenceCount}</strong></div>)}</div> : <p className="empty-state">At least five occurrences are required for a useful duration distribution.</p>}{data.summary.p95OccurrenceSeconds !== null && <p className="quiet-copy">P95 occurrence duration: {compact(data.summary.p95OccurrenceSeconds)} · shown because at least 20 occurrences are available.</p>}</section>
      <section className="panel"><div className="section-heading"><div><p className="eyebrow">Semantic composition</p><h2>{data.selection.level === 'radius_state' ? 'Operational groups' : data.selection.level === 'operational_group' ? 'Process families' : 'Exact supporting Radius evidence'}</h2></div></div><div className="semantic-bars">{data.semanticBreakdown.map((item) => <div key={`${item.level}:${item.key}`}><span>{item.label}</span><i><b style={{ width: barWidth(item.durationSeconds, maxSemantic) }} /></i><strong>{compact(item.durationSeconds)} · {item.percentage.toFixed(1)}%</strong></div>)}</div></section></div>
    <FullRangePhysicalSignature data={data} pressKey={signaturePressKey} displayName={signaturePress?.displayName ?? focusedOccurrence?.displayName} intervals={signatureIntervals} evidence={rangeTelemetry} telemetryAvailable={telemetryAvailable} onPress={setPressFocus} />
    {exactOccurrences}
    {selectedOccurrence && <OccurrenceEvidenceDrawer occurrence={selectedOccurrence} classificationVersion={data.classificationVersion} evidence={drawerTelemetry} onClose={closeOccurrence} />}
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
      const resolved = { level: value.selection.level, key: value.selection.key, label: value.selection.label, operationalGroupKey: value.selection.operationalGroupKey }
      setSelection(resolved)
      const query = new URLSearchParams(window.location.search)
      if (!query.has('activityLevel') || !query.has('activityKey')) updateActivityUrl(resolved, 'replace')
    }).catch(() => { if (!controller.signal.aborted) setError(true) }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => { controller.abort(); pageRequest.current?.abort() }
  }, [fromUtc, toUtc, pressKey, selection.level, selection.key, selection.operationalGroupKey])

  useEffect(() => {
    const restore = () => {
      const restored = activityFromUrl()
      if (restored) setSelection(restored)
    }
    window.addEventListener('popstate', restore)
    return () => window.removeEventListener('popstate', restore)
  }, [])

  const choose = (item: ActivityCatalogItem) => {
    const next = { level: item.level, key: item.key, label: item.label, operationalGroupKey: item.operationalGroupKey }
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
  const activeChoice = data?.catalog.find((item) => item.level === selection.level && item.key === selection.key && (selection.level !== 'process_family' || !selection.operationalGroupKey || item.operationalGroupKey === selection.operationalGroupKey)) ?? data?.selection
  return <div className="activity-explorer">{data && activeChoice && <GuidedActivityPicker catalog={data.catalog} selected={activeChoice} onSelect={choose} />}{loading && <div className="scope-progress" role="status"><i />Updating activity analysis…</div>}{error && <p className="message message--warning">Activity analysis could not be loaded for this selection. Previously loaded evidence remains visible.</p>}{data && <OperationalActivityExplorerView data={data} analytics={_analytics} occurrences={occurrences} loadingMore={loadingMore} onLoadMore={loadMore} />}</div>
}
