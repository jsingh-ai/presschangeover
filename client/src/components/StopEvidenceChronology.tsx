import type { CSSProperties } from 'react'
import { formatPlantDateTimeCt } from '../time-ranges'
import type { ChangeoverAction, StopIntelligenceDetail } from '../types/stop-intelligence'
import { actionBandColor, physicalBehaviorIntervals, stopActionKey } from './StopIntelligenceTimeline'

type EvidenceItem = { action: ChangeoverAction; key: string }
export type EvidenceChronologyRow = {
  atUtc: string
  toUtc: string
  physical: 'running' | 'stopped' | 'testing' | 'unknown'
  physicalLabel: string
  mapped: EvidenceItem[]
  raw: EvidenceItem[]
}

export type EvidenceChronologyMarker = EvidenceItem & { atUtc: string; position: number; lane: number }

const FIVE_SECONDS = 5_000
const physicalKind = (className?: string): EvidenceChronologyRow['physical'] => className?.includes('testing') ? 'testing' : className?.includes('stopped') ? 'stopped' : className?.includes('running') ? 'running' : 'unknown'

export function evidenceChronologyRows(detail: StopIntelligenceDetail): EvidenceChronologyRow[] {
  const from = Date.parse(detail.speedContext.fromUtc); const to = Date.parse(detail.speedContext.toUtc)
  const physical = physicalBehaviorIntervals(detail)
  const actions = [...detail.changeoverActions.actions, ...detail.changeoverActions.notDirectlyConfirmed]
    .map((action, index) => ({ action, key: stopActionKey(action, index) }))
    .filter(({ action }) => action.startAt && Number.isFinite(Date.parse(action.startAt)))
  const groupedActions = new Map<number, EvidenceItem[]>()
  for (const item of actions) {
    const bucket = Math.round(Date.parse(item.action.startAt!) / FIVE_SECONDS) * FIVE_SECONDS
    groupedActions.set(bucket, [...(groupedActions.get(bucket) ?? []), item])
  }
  const times = new Set<number>([from, to])
  for (const interval of physical) { times.add(Date.parse(interval.startUtc)); times.add(Date.parse(interval.endUtc)) }
  for (const at of groupedActions.keys()) if (at >= from && at <= to) times.add(at)
  const ordered = [...times].filter(Number.isFinite).sort((left, right) => left - right)
  return ordered.slice(0, -1).map((at, index) => {
    const interval = physical.find((item) => Date.parse(item.startUtc) <= at && Date.parse(item.endUtc) > at)
    const items = groupedActions.get(at) ?? []
    return {
      atUtc: new Date(at).toISOString(), toUtc: new Date(ordered[index + 1]!).toISOString(), physical: physicalKind(interval?.className), physicalLabel: interval?.label ?? 'Unknown',
      mapped: items.filter(({ action }) => action.actionCode !== 'UNCANONICALIZED_RAW_ACTIVITY'),
      raw: items.filter(({ action }) => action.actionCode === 'UNCANONICALIZED_RAW_ACTIVITY'),
    }
  })
}

function markerLayout(items: EvidenceItem[], from: number, to: number, canvasWidth: number): EvidenceChronologyMarker[] {
  const span = Math.max(1, to - from)
  // Pack by rendered distance instead of a fixed percentage. A fixed 11% gap
  // wastes lanes as the scrollable canvas grows, leaving markers far from the
  // shared rail even though they no longer overlap visually.
  const minimumSeparation = Math.min(11, 110 / canvasWidth * 100)
  const laneEnds: number[] = []
  return [...items].sort((left, right) => Date.parse(left.action.startAt!) - Date.parse(right.action.startAt!)).map((item) => {
    const at = Date.parse(item.action.startAt!)
    const position = Math.max(1, Math.min(99, (at - from) / span * 100))
    let lane = laneEnds.findIndex((lastPosition) => position - lastPosition >= minimumSeparation)
    if (lane < 0) lane = laneEnds.length
    laneEnds[lane] = position
    return { ...item, atUtc: item.action.startAt!, position, lane }
  })
}

export function evidenceChronologyMarkers(detail: StopIntelligenceDetail) {
  const from = Date.parse(detail.speedContext.fromUtc); const to = Date.parse(detail.speedContext.toUtc)
  const rows = evidenceChronologyRows(detail)
  const mapped = rows.flatMap(({ mapped }) => mapped); const raw = rows.flatMap(({ raw }) => raw)
  const canvasWidth = Math.max(900, (mapped.length + raw.length) * 76)
  return {
    mapped: markerLayout(mapped, from, to, canvasWidth),
    raw: markerLayout(raw, from, to, canvasWidth),
    canvasWidth,
  }
}

const decks = (action: ChangeoverAction) => [...new Set(action.evidence.flatMap((item) => item.deckNumber === null ? [] : [item.deckNumber]))].sort((left, right) => left - right)

function EvidenceMarker({ marker, raw, selected, onSelect }: { marker: EvidenceChronologyMarker; raw?: boolean; selected: boolean; onSelect(): void }) {
  const { action, position, lane } = marker
  const changedDecks = decks(action)
  const style = { '--marker-position': `${position}%`, '--marker-lane': lane, '--action-color': raw ? '#657981' : actionBandColor(action.actionCode) } as CSSProperties
  return <button type="button" className={`si-evidence-horizontal__marker ${raw ? 'raw' : 'mapped'} ${selected ? 'selected' : ''}`} aria-pressed={selected} style={style} title={`${action.displayName}\n${formatPlantDateTimeCt(action.startAt!)}${action.endAt && action.endAt !== action.startAt ? ` → ${formatPlantDateTimeCt(action.endAt)}` : ''}\n${action.explanation}`} onClick={onSelect}><strong>{action.displayName}</strong>{changedDecks.length > 0 && <small>Deck{changedDecks.length === 1 ? '' : 's'} {changedDecks.join(', ')}</small>}<time>{formatPlantDateTimeCt(action.startAt!)}</time></button>
}

const tickTimes = (from: number, to: number) => [0, .25, .5, .75, 1].map((fraction) => ({ fraction, atUtc: new Date(from + (to - from) * fraction).toISOString() }))

export function StopEvidenceChronology({ detail, selectedKeys, onSelect }: { detail: StopIntelligenceDetail; selectedKeys: string[]; onSelect(keys: string[]): void }) {
  if (!detail.changeoverActions.eligible) return <section className="si-action-summary si-action-summary--ineligible"><strong>Changeover actions not evaluated</strong><span>{detail.changeoverActions.reason}</span></section>
  const from = Date.parse(detail.speedContext.fromUtc); const to = Date.parse(detail.speedContext.toUtc); const span = Math.max(1, to - from)
  const markers = evidenceChronologyMarkers(detail)
  const mappedLanes = Math.max(1, ...markers.mapped.map(({ lane }) => lane + 1)); const rawLanes = Math.max(1, ...markers.raw.map(({ lane }) => lane + 1))
  const physical = physicalBehaviorIntervals(detail)
  const canvasWidth = markers.canvasWidth
  return <section className="si-evidence-chronology" aria-label="Mapped and raw evidence on one synchronized horizontal timeline">
    <header><div><span className="eyebrow">Synchronized evidence chronology</span><h3>Mapped actions above · raw / unmapped below</h3></div><small>Select any labeled marker to plot its evidence. Every marker uses the same physical-behavior time rail.</small></header>
    <div className="si-evidence-horizontal__summary"><strong>Mapped actions · {markers.mapped.length}</strong><span>One shared wall-clock timeline · CT</span><strong>Raw / unmapped · {markers.raw.length}</strong></div>
    <div className="si-evidence-horizontal__viewport" tabIndex={0} aria-label="Horizontally scrollable evidence timeline">
      <div className="si-evidence-horizontal__canvas" style={{ '--evidence-canvas-width': `${canvasWidth}px`, '--mapped-lanes': mappedLanes, '--raw-lanes': rawLanes } as CSSProperties}>
        <div className="si-evidence-horizontal__lane si-evidence-horizontal__lane--mapped" aria-label="Mapped actions above timeline">{markers.mapped.map((marker) => <EvidenceMarker key={marker.key} marker={marker} selected={selectedKeys.length === 1 && selectedKeys[0] === marker.key} onSelect={() => onSelect([marker.key])}/>)}</div>
        <div className="si-evidence-horizontal__rail" aria-label="Physical behavior timeline">
          {physical.map((interval) => { const left = Math.max(0, (Date.parse(interval.startUtc) - from) / span * 100); const right = Math.min(100, (Date.parse(interval.endUtc) - from) / span * 100); return <span key={`${interval.startUtc}:${interval.endUtc}`} className={`state-${physicalKind(interval.className)}`} style={{ left: `${left}%`, width: `${Math.max(.12, right - left)}%` }} title={`${interval.label}\n${formatPlantDateTimeCt(interval.startUtc)} → ${formatPlantDateTimeCt(interval.endUtc)}`}>{right - left >= 8 ? interval.label.replace(/ #\d+$/, '') : ''}</span> })}
        </div>
        <div className="si-evidence-horizontal__lane si-evidence-horizontal__lane--raw" aria-label="Raw and unmapped observations below timeline">{markers.raw.length ? markers.raw.map((marker) => <EvidenceMarker key={marker.key} marker={marker} raw selected={selectedKeys.length === 1 && selectedKeys[0] === marker.key} onSelect={() => onSelect([marker.key])}/>) : <div className="si-evidence-horizontal__empty"><strong>Raw / unmapped</strong><span>{detail.rawUnmappedContext.reason}</span></div>}</div>
        <div className="si-evidence-horizontal__axis">{tickTimes(from, to).map(({ fraction, atUtc }) => <time key={fraction} style={{ left: `${fraction * 100}%` }}>{formatPlantDateTimeCt(atUtc)}</time>)}</div>
      </div>
    </div>
    <div className="si-timeline-legend"><span className="running">Running</span><span className="stopped">Stopped</span><span className="testing">Testing</span><span className="unknown">Unknown</span></div>
  </section>
}
