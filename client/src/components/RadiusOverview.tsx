import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import type {
  OverviewFamilyAllocation,
  OverviewGroupAllocation,
  OverviewPressContribution,
  OverviewPressAllocation,
  OverviewRadiusStateAllocation,
  OverviewTimelineInterval,
  RadiusOverview as RadiusOverviewModel,
  RadiusPressKey,
} from '../types/api'
import { formatPlantDateTime } from '../time-ranges'
import type { TimelineIntervalItem, TimelineIntervalTrack } from './SynchronizedTimeline'
import { MAX_FULL_TELEMETRY_RANGE_MS, usePressTelemetryEvidence } from './TelemetryEvidenceTimeline'
import { UnifiedProcessTimeline } from './UnifiedProcessTimeline'

interface RadiusOverviewProps {
  overview: RadiusOverviewModel
  selectedPress?: RadiusPressKey
}

interface TimelineRange {
  id: string
  layer: 'radius' | 'group' | 'family'
  startUtc: string
  endUtc: string
  durationSeconds: number
  label: string
  eventType: string | null
  groupKey: string | null
  lightColor: string | null
  darkColor: string | null
  isUnavailable: boolean
  intervals: OverviewTimelineInterval[]
}

function duration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const hours = Math.floor(total / 3_600)
  const minutes = Math.floor(total % 3_600 / 60)
  const remainder = total % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return remainder > 0 ? `${minutes}m ${remainder}s` : `${minutes}m`
  return `${remainder}s`
}

function minutes(seconds: number): string {
  const value = seconds / 60
  return `${value >= 10 ? Math.round(value).toLocaleString() : value.toFixed(1)} min`
}

function pct(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(1)}%`
}

function delta(value: number | null): string {
  return value === null ? 'Not comparable' : `${value >= 0 ? '+' : ''}${value.toFixed(1)} pp`
}

function semanticStyle(group: Pick<OverviewGroupAllocation, 'lightColor' | 'darkColor'>): CSSProperties {
  return { '--overview-light': group.lightColor, '--overview-dark': group.darkColor } as CSSProperties
}

function processStyle(range: TimelineRange): CSSProperties {
  return { '--overview-light': range.lightColor ?? '#68727d', '--overview-dark': range.darkColor ?? '#9ca8b5' } as CSSProperties
}

function stateClass(eventType: string | null): string {
  if (eventType === 'G') return 'good'
  if (eventType === 'M') return 'make-ready'
  if (eventType === 'B') return 'bad'
  if (eventType === 'S') return 'safety'
  return eventType ? 'other' : 'offline'
}

function exclusionReason(press: OverviewPressAllocation): string {
  return press.rankingExclusionReason === 'coverage_below_80_percent'
    ? `${press.coveragePercent.toFixed(1)}% Radius coverage`
    : `${duration(press.observedSeconds)} observed`
}

function stateFor(press: OverviewPressAllocation, eventType: string | null): OverviewRadiusStateAllocation | undefined {
  return press.radiusStateBreakdown.find((state) => state.eventType === eventType)
}

function largestState(states: OverviewRadiusStateAllocation[], preferred?: string | null): OverviewRadiusStateAllocation | undefined {
  return states.find(({ eventType }) => eventType === preferred)
    ?? [...states].filter(({ nonProductionSeconds }) => nonProductionSeconds > 0).sort((a, b) => b.nonProductionSeconds - a.nonProductionSeconds)[0]
    ?? states[0]
}

function largestGroup(state?: OverviewRadiusStateAllocation): OverviewGroupAllocation | undefined {
  return state?.operationalGroups.find(({ key }) => key === state.largestNonProductionGroupKey)
    ?? state?.operationalGroups[0]
}

function largestFamily(state?: OverviewRadiusStateAllocation, group?: OverviewGroupAllocation): OverviewFamilyAllocation | undefined {
  return group?.families.find(({ key }) => key === state?.largestNonProductionFamilyKey)
    ?? group?.families[0]
}

function familyDisplayName(family: Pick<OverviewFamilyAllocation, 'key' | 'name' | 'needsClassification'>): string {
  if (family.needsClassification) return 'Needs Classification'
  return family.key === 'UNKNOWN' ? 'Unspecified by current classification' : family.name
}

export function timelineFamilyLabel(interval: OverviewTimelineInterval): string {
  if (interval.classificationStatus === 'needs_classification') return 'Needs Classification'
  if (interval.processFamilyKey === 'UNKNOWN') return interval.classificationNeedsReview ? 'Needs review' : 'Unspecified by current classification'
  return interval.processFamilyLabel ?? 'Needs Classification'
}

function rawIdentity(interval: OverviewTimelineInterval): string {
  return `${interval.eventType ?? '—'} / ${interval.statusCode ?? '—'} / ${interval.statusDescription ?? '(empty)'}`
}

function SnapshotMetric({ label, value, detail, accent }: { label: string; value: string; detail: string; accent?: string }) {
  return <div className={`overview-snapshot-metric ${accent ? `overview-snapshot-metric--${accent}` : ''}`}><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>
}

function RankCard({ press, top }: { press: OverviewPressAllocation; top: boolean }) {
  const state = largestState(press.radiusStateBreakdown, press.largestNonProductionRadiusStateEventType)
  const group = largestGroup(state)
  const family = largestFamily(state, group)
  return <article className="overview-rank-card">
    <div className="overview-rank-card__title"><span>{top ? `#${press.fleetProductionRank}` : 'Review'}</span><strong>{press.displayName}</strong><b>{pct(press.productionSharePercent)}</b></div>
    <div className="overview-rank-facts"><span>{duration(press.productionSeconds)} Run Production</span><span>{delta(press.productionDeltaVsFleetMedianPoints)} vs median</span><span>{press.coveragePercent.toFixed(1)}% coverage</span></div>
    <div className="overview-rank-states" aria-label={`${press.displayName} Radius state distribution`}>{press.radiusStateBreakdown.map((item) => <span key={item.eventType}><i className={`radius-state-dot radius-state-dot--${stateClass(item.eventType)}`} />{item.displayLabel} {item.shareOfObservedPercent.toFixed(1)}%</span>)}</div>
    {state && <p><strong>Largest non-production Radius state:</strong> {state.displayLabel} · {state.nonProductionShareOfObservedPercent.toFixed(1)}%{group ? <> <span aria-hidden="true">→</span> {group.name} · {group.shareOfObservedPercent.toFixed(1)}%</> : null}{family ? <> <span aria-hidden="true">→</span> {familyDisplayName(family)} · {family.shareOfObservedPercent.toFixed(1)}%</> : null}</p>}
  </article>
}

function RadiusStateLegend() {
  return <div className="overview-radius-legend" aria-label="Radius state legend">{[['G', 'Run Production'], ['M', 'Make Ready'], ['B', 'Bad'], ['S', 'Radius S state']].map(([eventType, label]) => <span key={eventType}><i className={`radius-state-dot radius-state-dot--${stateClass(eventType)}`} />{label}</span>)}</div>
}

function AllocationDetail({ press, state }: { press: OverviewPressAllocation; state: OverviewRadiusStateAllocation }) {
  return <div className="overview-allocation-detail" role="region" aria-label={`${press.displayName} ${state.displayLabel} semantic breakdown`}>
    <div><span>Selected Radius state</span><strong>{press.displayName} · {state.displayLabel}</strong><small>{duration(state.durationSeconds)} · {state.shareOfObservedPercent.toFixed(1)}% of observed time</small></div>
    <div><span>What made up this state</span>{state.operationalGroups.slice(0, 4).map((group) => <p key={group.key}><i style={semanticStyle(group)} /> <strong>{group.name}</strong> {duration(group.durationSeconds)} · {group.shareOfRadiusStatePercent.toFixed(1)}% of {state.displayLabel}</p>)}</div>
    <div><span>Leading process families</span>{state.operationalGroups.flatMap((group) => group.families).sort((a, b) => b.durationSeconds - a.durationSeconds).slice(0, 4).map((family) => <p key={family.key}><strong>{familyDisplayName(family)}</strong> {duration(family.durationSeconds)} · {family.shareOfRadiusStatePercent.toFixed(1)}% of {state.displayLabel}</p>)}</div>
  </div>
}

function AllocationBar({ press, selectedEventType, onSelect }: { press: OverviewPressAllocation; selectedEventType?: string; onSelect(eventType: string): void }) {
  return <div className="overview-allocation-row">
    <strong>{press.displayName}</strong>
    <div className="overview-stack" aria-label={`${press.displayName}: ${pct(press.productionSharePercent)} Run Production, ${press.coveragePercent.toFixed(1)}% coverage`}>
      {press.radiusStateBreakdown.filter(({ shareOfObservedPercent }) => shareOfObservedPercent > 0).map((state) => <button type="button" key={state.eventType} className={`overview-stack-segment overview-stack-segment--${stateClass(state.eventType)} ${selectedEventType === state.eventType ? 'selected' : ''}`} style={{ width: `${state.shareOfObservedPercent}%` }} onClick={() => onSelect(state.eventType)} title={`${state.displayLabel}\n${duration(state.durationSeconds)}\n${state.shareOfObservedPercent.toFixed(1)}% of observed time\nSelect to see its semantic breakdown`} aria-label={`${state.displayLabel}, ${duration(state.durationSeconds)}, ${state.shareOfObservedPercent.toFixed(1)} percent of observed time. Select semantic breakdown.`} />)}
    </div>
    <span><b>{pct(press.productionSharePercent)}</b> Run Production</span>
    <span>{press.coveragePercent.toFixed(1)}% coverage</span>
  </div>
}

function PressContributionList({ contributions, category }: { contributions: OverviewPressContribution[]; category: string }) {
  return <div className="overview-press-contributions"><p>Press contribution to {category}</p><ol>{contributions.map((item) => <li key={item.pressKey}><span><b>{item.displayName}</b><small>{minutes(item.durationSeconds)}</small></span><strong>{item.shareOfCategoryPercent.toFixed(1)}%</strong></li>)}</ol></div>
}

function HierarchyExplorer({ title, eyebrow, states, selectedState, selectedGroup, selectedFamily, showPressContributions = false, onState, onGroup, onFamily }: {
  title: string; eyebrow: string; states: OverviewRadiusStateAllocation[]
  selectedState?: string; selectedGroup?: string; selectedFamily?: string
  showPressContributions?: boolean
  onState(eventType: string): void; onGroup(key: string): void; onFamily(key: string): void
}) {
  const state = states.find(({ eventType }) => eventType === selectedState) ?? states[0]
  const group = state?.operationalGroups.find(({ key }) => key === selectedGroup) ?? state?.operationalGroups[0]
  const family = group?.families.find(({ key }) => key === selectedFamily) ?? group?.families[0]
  return <section className="panel overview-section overview-hierarchy" aria-labelledby="overview-hierarchy-title">
    <div className="overview-section-heading"><div><p className="eyebrow">{eyebrow}</p><h2 id="overview-hierarchy-title">{title}</h2><p>Start with what Radius reported, then see the published operational meaning and the process families that made up that time.</p></div><small>Radius state <b>→</b> Process group <b>→</b> Process family</small></div>
    <div className="overview-hierarchy-states" role="list" aria-label="Radius states">{states.map((item) => <button type="button" role="listitem" key={item.eventType} className={`overview-state-card overview-state-card--${stateClass(item.eventType)} ${item.eventType === state?.eventType ? 'active' : ''}`} onClick={() => onState(item.eventType)}><span>{item.displayLabel}</span><strong>{item.shareOfObservedPercent.toFixed(1)}%</strong><small>{duration(item.durationSeconds)} · observed time</small></button>)}</div>
    {state && <div className="overview-hierarchy-path">
      <article className="overview-hierarchy-parent"><p className="eyebrow">Radius said</p><h3>{state.displayLabel}</h3><strong>{duration(state.durationSeconds)}</strong><span>{state.shareOfObservedPercent.toFixed(1)}% of observed time</span></article>
      <div className="overview-hierarchy-level"><p className="eyebrow">What made up {state.displayLabel} time</p><div className="overview-group-list">{state.operationalGroups.map((item) => <button type="button" key={item.key} className={item.key === group?.key ? 'active' : ''} onClick={() => onGroup(item.key)} style={semanticStyle(item)}><span><i aria-hidden="true" />{item.name}</span><strong>{duration(item.durationSeconds)}</strong><small>{item.shareOfRadiusStatePercent.toFixed(1)}% of {state.displayLabel} · {item.shareOfObservedPercent.toFixed(1)}% overall</small></button>)}</div>{showPressContributions && group && <PressContributionList contributions={group.pressContributions} category={group.name} />}</div>
      {group && <div className="overview-hierarchy-level overview-hierarchy-families"><p className="eyebrow">Process families within {group.name}</p><div className="overview-family-list">{group.families.map((item) => <button type="button" key={item.key} className={item.key === family?.key ? 'active' : ''} onClick={() => onFamily(item.key)}><span>{familyDisplayName(item)}{item.key === 'UNKNOWN' && <em>{item.needsClassification ? 'Needs Classification' : 'Radius identity is not specific enough for a process family'}</em>}</span><strong>{duration(item.durationSeconds)}</strong><small>{item.shareOfGroupPercent.toFixed(1)}% of {group.name} · {item.shareOfRadiusStatePercent.toFixed(1)}% of {state.displayLabel} · {item.shareOfObservedPercent.toFixed(1)}% overall</small></button>)}</div>{family && <p className="overview-family-context"><strong>{familyDisplayName(family)}</strong> is observed across {duration(family.durationSeconds)} in this scope. {family.sourceIdentityCount} Radius {family.sourceIdentityCount === 1 ? 'identity contributes' : 'identities contribute'}; exact raw-code changes are shown in the synchronized timeline.</p>}{showPressContributions && family && <PressContributionList contributions={family.pressContributions} category={familyDisplayName(family)} />}</div>}
    </div>}
  </section>
}

function RankingTable({ presses }: { presses: OverviewPressAllocation[] }) {
  const [rankBy, setRankBy] = useState('production')
  const value = (press: OverviewPressAllocation) => rankBy === 'production'
    ? press.productionSharePercent ?? -1
    : rankBy === 'coverage'
      ? press.coveragePercent
      : stateFor(press, rankBy)?.shareOfObservedPercent ?? 0
  const sorted = [...presses].sort((left, right) => value(right) - value(left) || left.displayName.localeCompare(right.displayName, undefined, { numeric: true }))
  return <section className="panel overview-section" aria-labelledby="overview-ranking-title">
    <div className="overview-section-heading"><div><p className="eyebrow">Comparable presses</p><h2 id="overview-ranking-title">Press ranking</h2><p>Run Production is the Good (G) Radius state and remains the production ranking metric.</p></div><label className="overview-rank-select">Rank by<select value={rankBy} onChange={(event) => setRankBy(event.target.value)}><option value="production">Run Production Share</option><option value="M">Make Ready Share</option><option value="B">Bad Share</option><option value="S">Radius S-state Share</option><option value="coverage">Data Coverage</option></select></label></div>
    <div className="overview-table-scroll"><table className="overview-table"><thead><tr><th scope="col">Rank</th><th scope="col">Press</th><th scope="col">Run Production</th><th scope="col">Largest non-production Radius state</th><th scope="col">Largest process group</th><th scope="col">Process family</th><th scope="col">Coverage</th></tr></thead><tbody>{sorted.map((press, index) => {
      const state = largestState(press.radiusStateBreakdown, press.largestNonProductionRadiusStateEventType)
      const group = largestGroup(state)
      const family = largestFamily(state, group)
      return <tr key={press.pressKey}><td>{index + 1}</td><th scope="row">{press.displayName}</th><td>{pct(press.productionSharePercent)}</td><td>{state ? `${state.displayLabel} · ${state.nonProductionShareOfObservedPercent.toFixed(1)}%` : 'None observed'}</td><td>{group ? `${group.name} · ${group.shareOfObservedPercent.toFixed(1)}%` : '—'}</td><td>{family ? familyDisplayName(family) : '—'}</td><td>{press.coveragePercent.toFixed(1)}%</td></tr>
    })}</tbody></table></div>
  </section>
}

function mergeTimeline(intervals: OverviewTimelineInterval[], layer: TimelineRange['layer']): TimelineRange[] {
  const merged: TimelineRange[] = []
  for (const interval of intervals) {
    const label = interval.isUnavailable ? 'Data unavailable' : layer === 'radius' ? interval.radiusStateLabel : layer === 'group' ? interval.operationalGroupLabel : timelineFamilyLabel(interval)
    const key = interval.isUnavailable ? 'unavailable' : layer === 'radius' ? interval.eventType : layer === 'group' ? interval.operationalGroupKey : `${interval.processFamilyKey ?? 'unclassified'}:${label}`
    const previous = merged.at(-1)
    if (previous && previous.endUtc === interval.startUtc && previous.id.startsWith(`${layer}:${key}:`)) {
      previous.endUtc = interval.endUtc
      previous.durationSeconds += interval.durationSeconds
      previous.intervals.push(interval)
      continue
    }
    merged.push({
      id: `${layer}:${key}:${interval.intervalId}`,
      layer,
      startUtc: interval.startUtc,
      endUtc: interval.endUtc,
      durationSeconds: interval.durationSeconds,
      label,
      eventType: interval.eventType,
      groupKey: interval.operationalGroupKey,
      lightColor: interval.operationalGroupLightColor,
      darkColor: interval.operationalGroupDarkColor,
      isUnavailable: interval.isUnavailable,
      intervals: [interval],
    })
  }
  return merged
}

function compositionTitle(range: TimelineRange, observedSeconds: number): string {
  if (range.isUnavailable) return `DATA UNAVAILABLE\n${formatPlantDateTime(range.startUtc)} – ${formatPlantDateTime(range.endUtc)}\n${duration(range.durationSeconds)}\nNo Radius observations were available. Machine state is unknown.`
  const totals = new Map<string, number>()
  for (const interval of range.intervals) {
    const label = range.layer === 'radius' ? interval.operationalGroupLabel : range.layer === 'group' ? timelineFamilyLabel(interval) : interval.operationalGroupLabel
    totals.set(label, (totals.get(label) ?? 0) + interval.durationSeconds)
  }
  const composition = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([label, seconds]) => `${label}: ${duration(seconds)}`).join('\n')
  const familyLabels = [...new Set(range.intervals.map(timelineFamilyLabel))].slice(0, 3).join(', ')
  return `${range.label.toUpperCase()}\n${formatPlantDateTime(range.startUtc)} – ${formatPlantDateTime(range.endUtc)}\n${duration(range.durationSeconds)} · ${(range.durationSeconds / Math.max(1, observedSeconds) * 100).toFixed(1)}% of observed time\n${range.layer === 'radius' ? 'Operational Group composition' : range.layer === 'group' ? 'Process Family composition' : 'Operational Group composition'}:\n${composition}${familyLabels ? `\nProcess families: ${familyLabels}` : ''}`
}

const RADIUS_RAW_CODE_HUES = [210, 230, 250, 270, 290, 195, 30, 45, 55] as const

export function radiusRawCodeStyle(variant: number): CSSProperties {
  const hue = RADIUS_RAW_CODE_HUES[variant % RADIUS_RAW_CODE_HUES.length]!
  const lightness = [36, 44, 52][Math.floor(variant / RADIUS_RAW_CODE_HUES.length) % 3]!
  return { background: `hsl(${hue} 62% ${lightness}%)`, color: lightness >= 50 ? '#14202b' : '#fff' }
}

export function radiusRawCodeTrack(intervals: OverviewTimelineInterval[]): TimelineIntervalTrack {
  const ordered = [...intervals].sort((left, right) => Date.parse(left.startUtc) - Date.parse(right.startUtc))
  const identities = [...new Set(ordered.filter(({ isUnavailable }) => !isUnavailable).map(rawIdentity))].sort()
  const colorByIdentity = new Map(identities.map((identity, index) => [identity, index]))
  const items: TimelineIntervalItem[] = []
  for (const interval of ordered) {
    const identity = interval.isUnavailable ? 'Data unavailable' : rawIdentity(interval)
    const previous = items.at(-1)
    if (previous && previous.endUtc === interval.startUtc && previous.label === identity && previous.unavailable === interval.isUnavailable) {
      previous.endUtc = interval.endUtc
      previous.details = interval.isUnavailable
        ? `Radius raw code unavailable\n${formatPlantDateTime(previous.startUtc)} – ${formatPlantDateTime(previous.endUtc)} CT`
        : `Exact Radius identity: ${identity}\n${formatPlantDateTime(previous.startUtc)} – ${formatPlantDateTime(previous.endUtc)} CT`
      continue
    }
    items.push({
      id: `radius-raw:${interval.intervalId}`,
      startUtc: interval.startUtc,
      endUtc: interval.endUtc,
      label: identity,
      details: interval.isUnavailable
        ? `Radius raw code unavailable\n${formatPlantDateTime(interval.startUtc)} – ${formatPlantDateTime(interval.endUtc)} CT`
        : `Exact Radius identity: ${identity}\n${formatPlantDateTime(interval.startUtc)} – ${formatPlantDateTime(interval.endUtc)} CT`,
      className: 'radius-raw-code-interval',
      style: interval.isUnavailable ? undefined : radiusRawCodeStyle(colorByIdentity.get(identity) ?? 0),
      unavailable: interval.isUnavailable,
    })
  }
  return {
    id: 'radius-raw-codes',
    label: 'Radius raw codes',
    unavailableLabel: 'No Radius raw code observed in this range',
    intervals: items,
  }
}

function clipTrack(track: TimelineIntervalTrack, fromUtc: string, toUtc: string): TimelineIntervalTrack {
  const from = Date.parse(fromUtc)
  const to = Date.parse(toUtc)
  return {
    ...track,
    intervals: track.intervals.flatMap((interval) => {
      const start = Math.max(from, Date.parse(interval.startUtc))
      const end = Math.min(to, Date.parse(interval.endUtc))
      return end > start ? [{ ...interval, startUtc: new Date(start).toISOString(), endUtc: new Date(end).toISOString() }] : []
    }),
  }
}

function SelectedPeriod({ range, observedSeconds }: { range: TimelineRange; observedSeconds: number }) {
  if (range.isUnavailable) return <div className="overview-selected-period"><p className="eyebrow">Selected period</p><h3>Data unavailable</h3><strong>{duration(range.durationSeconds)}</strong><p>No Radius observations were available. Machine state is unknown and no semantic classification is inferred.</p></div>
  const groups = new Map<string, { label: string; seconds: number; families: Map<string, number> }>()
  const states = new Map<string, number>()
  for (const interval of range.intervals) {
    states.set(interval.radiusStateLabel, (states.get(interval.radiusStateLabel) ?? 0) + interval.durationSeconds)
    const key = interval.operationalGroupKey ?? 'unclassified'
    const group = groups.get(key) ?? { label: interval.operationalGroupLabel, seconds: 0, families: new Map<string, number>() }
    group.seconds += interval.durationSeconds
    const family = timelineFamilyLabel(interval)
    group.families.set(family, (group.families.get(family) ?? 0) + interval.durationSeconds)
    groups.set(key, group)
  }
  const identities = [...new Map(range.intervals.map((interval) => [rawIdentity(interval), interval])).entries()]
  return <div className="overview-selected-period"><p className="eyebrow">Selected period · integrated evidence</p><div className="overview-selected-period__heading"><h3>{range.label}</h3><strong>{duration(range.durationSeconds)}</strong><span>{(range.durationSeconds / Math.max(1, observedSeconds) * 100).toFixed(1)}% of observed press time</span></div><div className="overview-selected-period__grid"><div><span>Exact Radius identities</span>{identities.map(([identity, interval]) => <p key={identity}><strong>{identity}</strong>{interval.classificationNeedsReview ? 'Needs review' : interval.classificationStatus === 'needs_classification' ? 'Needs Classification' : 'Published mapping'}</p>)}</div><div><span>ProcessIntelligence interpretation</span>{[...groups.entries()].map(([key, group]) => <div key={key}><p><strong>{group.label}</strong>{duration(group.seconds)}</p>{[...group.families.entries()].map(([label, seconds]) => <small key={label}>{label} · {duration(seconds)}</small>)}</div>)}</div></div></div>
}

function SynchronizedGantt({ overview, press }: { overview: RadiusOverviewModel; press: OverviewPressAllocation }) {
  const radiusRanges = useMemo(() => mergeTimeline(press.timelineIntervals, 'radius'), [press.timelineIntervals])
  const groupRanges = useMemo(() => mergeTimeline(press.timelineIntervals, 'group'), [press.timelineIntervals])
  const familyRanges = useMemo(() => mergeTimeline(press.timelineIntervals, 'family'), [press.timelineIntervals])
  const defaultRange = [...radiusRanges].reverse().find(({ isUnavailable }) => !isUnavailable) ?? radiusRanges.at(-1)
  const [selected, setSelected] = useState<TimelineRange | undefined>(defaultRange)
  useEffect(() => setSelected(defaultRange), [press.pressKey, overview.fromUtc, overview.toUtc])
  const byId = new Map([...radiusRanges, ...groupRanges, ...familyRanges].map((range) => [range.id, range]))
  const item = (range: TimelineRange): TimelineIntervalItem => ({
    id: range.id,
    startUtc: range.startUtc,
    endUtc: range.endUtc,
    label: range.label,
    details: compositionTitle(range, press.observedSeconds),
    unavailable: range.isUnavailable,
    className: `overview-gantt-segment overview-gantt-segment--${range.layer} overview-gantt-segment--${stateClass(range.layer === 'radius' ? range.eventType : range.isUnavailable ? null : 'other')}`,
    style: range.layer === 'group' ? processStyle(range) : undefined,
  })
  const rangeDuration = Date.parse(overview.toUtc) - Date.parse(overview.fromUtc)
  const fullRangeTelemetry = rangeDuration <= MAX_FULL_TELEMETRY_RANGE_MS
  const telemetryFromUtc = fullRangeTelemetry ? overview.fromUtc : selected?.startUtc ?? overview.fromUtc
  const telemetryToUtc = fullRangeTelemetry ? overview.toUtc : selected?.endUtc ?? overview.toUtc
  const telemetry = usePressTelemetryEvidence(press.pressKey, telemetryFromUtc, telemetryToUtc, { padShortRange: !fullRangeTelemetry, fullRange: fullRangeTelemetry })
  const speedCapability = telemetry.capabilities?.capabilities.find(({ canonicalId }) => canonicalId === 'machine.speed.actual')
  const motionCapability = telemetry.capabilities?.capabilities.find(({ canonicalId }) => canonicalId === 'physical.motion_state')
  const radiusTrack: TimelineIntervalTrack = { id: 'radius', label: 'Radius recorded', intervals: radiusRanges.map(item) }
  const groupTrack: TimelineIntervalTrack = { id: 'operational-group', label: 'Operational Group', intervals: groupRanges.map(item) }
  const familyTrack: TimelineIntervalTrack = { id: 'process-family', label: 'Process Family', intervals: familyRanges.map(item) }
  const radiusRawTrack = radiusRawCodeTrack(press.timelineIntervals)
  const focusedRadius = clipTrack(radiusTrack, telemetry.range.fromUtc, telemetry.range.toUtc)
  const focusedRadiusRaw = clipTrack(radiusRawTrack, telemetry.range.fromUtc, telemetry.range.toUtc)
  const focusedGroup = clipTrack(groupTrack, telemetry.range.fromUtc, telemetry.range.toUtc)
  const focusedFamily = clipTrack(familyTrack, telemetry.range.fromUtc, telemetry.range.toUtc)
  const selectTimelineItem = (item: TimelineIntervalItem) => setSelected(byId.get(item.id) ?? radiusRanges.find((range) => Date.parse(item.startUtc) >= Date.parse(range.startUtc) && Date.parse(item.startUtc) < Date.parse(range.endUtc)) ?? selected)
  return <section className="panel overview-section overview-gantt" aria-labelledby="overview-gantt-title"><div className="overview-section-heading"><div><p className="eyebrow">Complete selected-press evidence</p><h2 id="overview-gantt-title">Synchronized process evidence</h2><p>Production context, exact Radius changes, ProcessIntelligence meaning, motion, speed, and physical events are integrated here—no segment sidebar is required.</p></div></div>{telemetry.loading && <div className="scope-progress" role="status"><i />Loading telemetry for the complete selected range…</div>}{telemetry.error && <p className="message message--warning">Some telemetry is temporarily unavailable. Radius and ProcessIntelligence chronology remain available.</p>}{fullRangeTelemetry ? <><p className="telemetry-range-note">Telemetry covers the complete selected range from {formatPlantDateTime(overview.fromUtc)} through {formatPlantDateTime(overview.toUtc)} CT. No two-hour focus window is substituted.</p><UnifiedProcessTimeline fromUtc={overview.fromUtc} toUtc={overview.toUtc} ariaLabel={`${press.displayName} complete selected-range synchronized evidence`} selectedId={selected?.id} radiusTrack={radiusTrack} radiusRawTrack={radiusRawTrack} groupTrack={groupTrack} familyTrack={familyTrack} telemetry={telemetry} onSelect={selectTimelineItem} /></> : <><p className="telemetry-range-note">This range exceeds 24 hours. Complete Radius and ProcessIntelligence chronology is shown; select an interval for bounded raw telemetry.</p><UnifiedProcessTimeline fromUtc={overview.fromUtc} toUtc={overview.toUtc} ariaLabel={`${press.displayName} complete synchronized chronology`} selectedId={selected?.id} radiusTrack={radiusTrack} radiusRawTrack={radiusRawTrack} groupTrack={groupTrack} familyTrack={familyTrack} onSelect={selectTimelineItem} /><section className="overview-inline-telemetry" aria-labelledby="overview-inline-telemetry-title"><h3 id="overview-inline-telemetry-title">Focused telemetry for the selected interval</h3><p>{formatPlantDateTime(telemetry.range.fromUtc)} – {formatPlantDateTime(telemetry.range.toUtc)} CT · bounded to two hours</p><UnifiedProcessTimeline fromUtc={telemetry.range.fromUtc} toUtc={telemetry.range.toUtc} ariaLabel={`${press.displayName} focused synchronized telemetry`} selectedId={selected?.id} radiusTrack={focusedRadius} radiusRawTrack={focusedRadiusRaw} groupTrack={focusedGroup} familyTrack={focusedFamily} telemetry={telemetry} onSelect={selectTimelineItem} /></section></>}{telemetry.capabilities && <div className="timeline-quality-row"><span>Telemetry metadata <b>{telemetry.capabilities.metadataStatus}</b></span><span>Physical Motion <b>{motionCapability?.state ?? 'UNKNOWN'}</b></span><span>Actual Speed <b>{speedCapability?.state ?? 'UNKNOWN'}</b></span><span>Observed physical changes <b>{telemetry.physical?.signals.reduce((sum, signal) => sum + signal.changes.length, 0) ?? 0}</b></span></div>}{selected && <SelectedPeriod range={selected} observedSeconds={press.observedSeconds} />}</section>
}

function Coverage({ data, press }: { data: NonNullable<RadiusOverviewModel['decisionSupport']>; press?: OverviewPressAllocation }) {
  const coverage = press?.coveragePercent ?? data.fleetSummary.coveragePercent
  const observed = press?.observedSeconds ?? data.fleetSummary.observedSeconds
  const unavailable = press?.unavailableSeconds ?? data.fleetSummary.unavailableSeconds
  const classificationCoverage = press?.classificationCoveragePercent ?? data.fleetSummary.classificationCoveragePercent
  const needs = press?.needsClassificationSeconds ?? data.fleetSummary.needsClassificationSeconds
  const excluded = data.excludedPressKeys.map((key) => data.pressAllocations.find((item) => item.pressKey === key)).filter((item): item is OverviewPressAllocation => Boolean(item))
  return <section className="panel overview-section overview-coverage" aria-labelledby="coverage-title"><div className="overview-section-heading"><div><p className="eyebrow">Evidence quality</p><h2 id="coverage-title">Data and classification coverage</h2><p>Radius coverage measures whether observations exist. Classification coverage measures how much observed time has a published semantic mapping.</p></div></div><div className="overview-coverage-summary"><div><span>Radius data coverage</span><strong>{coverage.toFixed(1)}%</strong><small>{duration(observed)} observed · {duration(unavailable)} unavailable</small></div><div><span>Classification coverage</span><strong>{classificationCoverage.toFixed(1)}%</strong><small>{duration(needs)} Needs Classification</small></div></div>{!press && (excluded.length ? <ul>{excluded.map((item) => <li key={item.pressKey}><strong>{item.displayName}</strong><span>{exclusionReason(item)}</span><b>Not ranked</b></li>)}</ul> : <p>All {data.fleetSummary.pressCount} presses meet the {data.minimumCoveragePercent}% / {duration(data.minimumObservedSeconds)} ranking threshold.</p>)}</section>
}

function FleetOverview({ overview, selectedState, selectedGroup, selectedFamily, onState, onGroup, onFamily }: { overview: RadiusOverviewModel; selectedState?: string; selectedGroup?: string; selectedFamily?: string; onState(value: string): void; onGroup(value: string): void; onFamily(value: string): void }) {
  const data = overview.decisionSupport!
  const byKey = new Map(data.pressAllocations.map((press) => [press.pressKey, press]))
  const top = data.topRunningPressKeys.map((key) => byKey.get(key)).filter((press): press is OverviewPressAllocation => Boolean(press))
  const attention = data.needsAttentionPressKeys.map((key) => byKey.get(key)).filter((press): press is OverviewPressAllocation => Boolean(press))
  const ranked = data.rankingPressKeys.map((key) => byKey.get(key)).filter((press): press is OverviewPressAllocation => Boolean(press))
  const [allocationSelection, setAllocationSelection] = useState<{ pressKey: RadiusPressKey; eventType: string }>()
  const selectedAllocationPress = allocationSelection ? byKey.get(allocationSelection.pressKey) : undefined
  const selectedAllocationState = selectedAllocationPress ? stateFor(selectedAllocationPress, allocationSelection?.eventType ?? null) : undefined
  const state = largestState(data.fleetRadiusStateBreakdown, data.fleetSummary.largestNonProductionRadiusStateEventType)
  return <>
    <section className="overview-snapshot" aria-labelledby="fleet-snapshot-title"><div className="overview-snapshot-heading"><div><p className="eyebrow">Selected-period evidence</p><h2 id="fleet-snapshot-title">Fleet snapshot</h2></div><small>Published Classification v{data.classificationVersion}</small></div><div className="overview-snapshot-grid overview-radius-snapshot-grid">{[['G', 'production'], ['M', 'make-ready'], ['B', 'bad'], ['S', 'safety']].map(([eventType, accent]) => { const item = data.fleetRadiusStateBreakdown.find((candidate) => candidate.eventType === eventType); return <SnapshotMetric key={eventType} label={eventType === 'S' ? 'Radius S state' : item?.displayLabel ?? (eventType === 'G' ? 'Run Production' : eventType === 'M' ? 'Make Ready' : 'Bad')} value={pct(item?.shareOfObservedPercent ?? 0)} detail={`${duration(item?.durationSeconds ?? 0)} of observed Radius time`} accent={accent} /> })}<SnapshotMetric label="Radius Coverage" value={`${data.fleetSummary.coveragePercent.toFixed(1)}%`} detail={`${data.fleetSummary.rankablePressCount} / ${data.fleetSummary.pressCount} presses rankable`} /></div></section>
    <div className="overview-rank-panels"><section className="panel overview-rank-panel" aria-labelledby="top-running-title"><div className="overview-section-heading"><div><p className="eyebrow">Highest eligible Run Production share</p><h2 id="top-running-title">Highest Run Production Share</h2></div></div>{top.length ? top.map((press) => <RankCard key={press.pressKey} press={press} top />) : <p className="empty-state">No presses meet the ranking coverage requirements.</p>}</section><section className="panel overview-rank-panel" aria-labelledby="attention-title"><div className="overview-section-heading"><div><p className="eyebrow">Lowest eligible Run Production share</p><h2 id="attention-title">Worth Reviewing</h2></div></div>{attention.length ? attention.map((press) => <RankCard key={press.pressKey} press={press} top={false} />) : <p className="empty-state">At least two eligible presses are required for a lowest-share comparison.</p>}</section></div>
    <section className="panel overview-section overview-stands-out" aria-labelledby="stands-out-title"><div className="overview-section-heading"><div><p className="eyebrow">Deterministic selected-period summary</p><h2 id="stands-out-title">What Stands Out</h2></div></div>{data.focusItems.length ? <ol>{data.focusItems.map((item) => <li key={item}>{item}</li>)}</ol> : <p className="empty-state">There is not enough observed Radius time to produce a fleet comparison.</p>}</section>
    <section className="panel overview-section" aria-labelledby="fleet-allocation-title"><div className="overview-section-heading"><div><p className="eyebrow">100% of observed Radius time per press</p><h2 id="fleet-allocation-title">Fleet Radius State Allocation</h2><p>Select a Run Production, Make Ready, Bad, or Radius S-state segment to see the published classification. Unavailable time remains separate through coverage.</p></div><RadiusStateLegend /></div><div className="overview-allocation-list">{data.pressAllocations.map((press) => <AllocationBar key={press.pressKey} press={press} selectedEventType={allocationSelection?.pressKey === press.pressKey ? allocationSelection.eventType : undefined} onSelect={(eventType) => setAllocationSelection({ pressKey: press.pressKey, eventType })} />)}</div>{selectedAllocationPress && selectedAllocationState && <AllocationDetail press={selectedAllocationPress} state={selectedAllocationState} />}</section>
    <HierarchyExplorer title="Where Fleet Time Went" eyebrow="Radius evidence explained by Published Classification" states={data.fleetRadiusStateBreakdown} selectedState={selectedState} selectedGroup={selectedGroup} selectedFamily={selectedFamily} showPressContributions onState={onState} onGroup={onGroup} onFamily={onFamily} />
    <RankingTable presses={ranked} />
    <Coverage data={data} />
  </>
}

function SinglePressOverview({ overview, selectedPress, selectedState, selectedGroup, selectedFamily, onState, onGroup, onFamily }: { overview: RadiusOverviewModel; selectedPress: RadiusPressKey; selectedState?: string; selectedGroup?: string; selectedFamily?: string; onState(value: string): void; onGroup(value: string): void; onFamily(value: string): void }) {
  const data = overview.decisionSupport!
  const press = data.pressAllocations.find((candidate) => candidate.pressKey === selectedPress)
  if (!press) return <section className="panel empty-state">The selected press is not mapped in this Radius range.</section>
  const state = largestState(press.radiusStateBreakdown, press.largestNonProductionRadiusStateEventType)
  const group = largestGroup(state)
  const family = largestFamily(state, group)
  const otherEligible = Math.max(0, data.fleetSummary.rankablePressCount - 1)
  return <>
    <section className="overview-snapshot" aria-labelledby="press-summary-title"><div className="overview-snapshot-heading"><div><p className="eyebrow">Selected press</p><h2 id="press-summary-title">{press.displayName} summary</h2></div><small>Published Classification v{data.classificationVersion}</small></div><div className="overview-snapshot-grid"><SnapshotMetric label="Run Production" value={pct(press.productionSharePercent)} detail={duration(press.productionSeconds)} accent="production" /><SnapshotMetric label="Fleet rank" value={press.rankingEligible ? `${press.fleetProductionRank} / ${data.fleetSummary.rankablePressCount}` : 'Not ranked'} detail={`${delta(press.productionDeltaVsFleetMedianPoints)} vs median`} /><SnapshotMetric label="Radius coverage" value={`${press.coveragePercent.toFixed(1)}%`} detail={`${duration(press.unavailableSeconds)} unavailable`} /><SnapshotMetric label="Largest non-production Radius state" value={state?.displayLabel ?? 'None observed'} detail={state ? `${state.nonProductionShareOfObservedPercent.toFixed(1)}% · ${duration(state.nonProductionSeconds)}` : 'No non-production time'} /></div>{state && <div className="overview-summary-path"><span><b>{state.displayLabel}</b>{state.nonProductionShareOfObservedPercent.toFixed(1)}% of observed time outside canonical production</span>{group && <span><b>{group.name}</b>{group.shareOfObservedPercent.toFixed(1)}% of observed time</span>}{family && <span><b>{familyDisplayName(family)}</b>{family.shareOfObservedPercent.toFixed(1)}% of observed time</span>}</div>}</section>
    <section className="panel overview-section overview-position" aria-labelledby="position-title"><div className="overview-section-heading"><div><p className="eyebrow">Comparable fleet context</p><h2 id="position-title">Position in fleet</h2></div></div><dl><div><dt>Run Production rank</dt><dd>{press.rankingEligible ? `${press.fleetProductionRank} / ${data.fleetSummary.rankablePressCount}` : 'Not ranked'}</dd></div><div><dt>Run Production</dt><dd>{pct(press.productionSharePercent)}</dd></div><div><dt>Fleet median</dt><dd>{pct(data.fleetSummary.productionMedianPercent)}</dd></div><div><dt>Difference</dt><dd>{delta(press.productionDeltaVsFleetMedianPoints)}</dd></div></dl><p>{press.rankingEligible && press.fleetProductionRank !== null ? `${press.displayName} spent a larger observed Run Production share than ${Math.max(0, data.fleetSummary.rankablePressCount - press.fleetProductionRank)} of ${otherEligible} other rankable presses.` : `${press.displayName} is not ranked: ${exclusionReason(press)}.`}</p></section>
    <section className="panel overview-section" aria-labelledby="distribution-title"><div className="overview-section-heading"><div><p className="eyebrow">Observed Radius time only</p><h2 id="distribution-title">Radius State Distribution</h2><p>These broad states describe what Radius reported; the semantic hierarchy below explains what each state represented.</p></div><RadiusStateLegend /></div><div className="overview-distribution">{press.radiusStateBreakdown.map((item) => <div key={item.eventType}><span><i className={`radius-state-dot radius-state-dot--${stateClass(item.eventType)}`} />{item.displayLabel}</span><div><i className={`overview-radius-fill overview-radius-fill--${stateClass(item.eventType)}`} style={{ width: `${item.shareOfObservedPercent}%` }} /></div><strong>{item.shareOfObservedPercent.toFixed(1)}%</strong><small>{duration(item.durationSeconds)}</small></div>)}</div><p className="overview-unavailable-note"><strong>Data unavailable:</strong> {duration(press.unavailableSeconds)} · {(100 - press.coveragePercent).toFixed(1)}% of selected wall-clock time</p></section>
    <SynchronizedGantt overview={overview} press={press} />
    <HierarchyExplorer title={`Where ${press.displayName} Spent Its Time`} eyebrow="Selected press Radius states explained" states={press.radiusStateBreakdown} selectedState={selectedState} selectedGroup={selectedGroup} selectedFamily={selectedFamily} onState={onState} onGroup={onGroup} onFamily={onFamily} />
    <Coverage data={data} press={press} />
  </>
}

export function RadiusOverview({ overview, selectedPress }: RadiusOverviewProps) {
  const data = overview.decisionSupport
  const activePress = selectedPress ? data?.pressAllocations.find(({ pressKey }) => pressKey === selectedPress) : undefined
  const scopeStates = activePress?.radiusStateBreakdown ?? data?.fleetRadiusStateBreakdown ?? []
  const defaultState = largestState(scopeStates, activePress?.largestNonProductionRadiusStateEventType ?? data?.fleetSummary.largestNonProductionRadiusStateEventType)
  const defaultGroup = largestGroup(defaultState)
  const defaultFamily = largestFamily(defaultState, defaultGroup)
  const [selectedState, setSelectedState] = useState<string | undefined>(defaultState?.eventType)
  const [selectedGroup, setSelectedGroup] = useState<string | undefined>(defaultGroup?.key)
  const [selectedFamily, setSelectedFamily] = useState<string | undefined>(defaultFamily?.key)
  const chooseState = (eventType: string) => {
    const state = scopeStates.find((item) => item.eventType === eventType)
    const group = largestGroup(state)
    setSelectedState(eventType)
    setSelectedGroup(group?.key)
    setSelectedFamily(largestFamily(state, group)?.key)
  }
  const chooseGroup = (key: string) => {
    const state = scopeStates.find((item) => item.eventType === selectedState)
    const group = state?.operationalGroups.find((item) => item.key === key)
    setSelectedGroup(key)
    setSelectedFamily(largestFamily(state, group)?.key)
  }
  useEffect(() => {
    setSelectedState(defaultState?.eventType)
    setSelectedGroup(defaultGroup?.key)
    setSelectedFamily(defaultFamily?.key)
  }, [selectedPress, overview.fromUtc, overview.toUtc, defaultState?.eventType, defaultGroup?.key, defaultFamily?.key])
  const feedMessage = useMemo(() => overview.feedStatus === 'ONLINE' ? null : overview.feedStatus === 'OFFLINE' ? 'Radius evidence is unavailable at the selected range end. Historical observed spans remain visible.' : 'Radius coverage is partial for the selected range. Ranking eligibility accounts for each press separately.', [overview.feedStatus])
  return <>
    <div className="overview-toolbar"><div><strong>{selectedPress ? activePress?.displayName ?? selectedPress : 'All Presses'}</strong><span>{formatPlantDateTime(overview.fromUtc)} – {formatPlantDateTime(overview.toUtc)} CT</span></div><div className="overview-hierarchy-key"><span>Radius state</span><b>→</b><span>Process group</span><b>→</b><span>Process family</span></div></div>
    {feedMessage && <div className="feed-banner feed-banner--degraded" role="status">{feedMessage}</div>}
    {!data ? <section className="panel unavailable-panel"><h2>Overview classification unavailable</h2><p>The read-only Radius response did not include a published classification view. Radius evidence remains available in Operational Analysis.</p></section>
      : data.fleetSummary.observedSeconds === 0 ? <section className="panel unavailable-panel"><h2>No observed Radius data</h2><p>The selected period contains only Data unavailable. No press is ranked and no operational meaning is inferred.</p></section>
        : selectedPress
          ? <SinglePressOverview overview={overview} selectedPress={selectedPress} selectedState={selectedState} selectedGroup={selectedGroup} selectedFamily={selectedFamily} onState={chooseState} onGroup={chooseGroup} onFamily={setSelectedFamily} />
          : <FleetOverview overview={overview} selectedState={selectedState} selectedGroup={selectedGroup} selectedFamily={selectedFamily} onState={chooseState} onGroup={chooseGroup} onFamily={setSelectedFamily} />}
  </>
}
