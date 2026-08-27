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

const decks = (action: ChangeoverAction) => [...new Set(action.evidence.flatMap((item) => item.deckNumber === null ? [] : [item.deckNumber]))].sort((left, right) => left - right)

function EvidenceButtons({ items, selectedKeys, onSelect, raw }: { items: EvidenceItem[]; selectedKeys: string[]; onSelect(keys: string[]): void; raw?: boolean }) {
  return <div className="si-evidence-chronology__events">{items.map(({ action, key }) => { const changedDecks = decks(action); const selected = selectedKeys.length === 1 && selectedKeys[0] === key; return <button type="button" key={key} className={selected ? 'selected' : ''} aria-pressed={selected} style={raw ? undefined : { '--action-color': actionBandColor(action.actionCode) } as React.CSSProperties} title={`${action.displayName}\n${formatPlantDateTimeCt(action.startAt!)}${action.endAt && action.endAt !== action.startAt ? ` → ${formatPlantDateTimeCt(action.endAt)}` : ''}\n${action.explanation}`} onClick={() => onSelect([key])}><strong>{action.displayName}</strong>{changedDecks.length > 0 && <small>Deck{changedDecks.length === 1 ? '' : 's'} {changedDecks.join(', ')}</small>}</button> })}</div>
}

export function StopEvidenceChronology({ detail, selectedKeys, onSelect }: { detail: StopIntelligenceDetail; selectedKeys: string[]; onSelect(keys: string[]): void }) {
  if (!detail.changeoverActions.eligible) return <section className="si-action-summary si-action-summary--ineligible"><strong>Changeover actions not evaluated</strong><span>{detail.changeoverActions.reason}</span></section>
  const rows = evidenceChronologyRows(detail)
  const mappedCount = rows.reduce((sum, row) => sum + row.mapped.length, 0); const rawCount = rows.reduce((sum, row) => sum + row.raw.length, 0)
  return <section className="si-evidence-chronology" aria-label="Mapped and raw evidence on synchronized vertical timelines">
    <header><div><span className="eyebrow">Synchronized evidence chronology</span><h3>Mapped actions beside raw changes</h3></div><small>Both lanes share one scroll position and the same physical-behavior sequence.</small></header>
    <div className="si-evidence-chronology__head"><strong>Mapped actions · {mappedCount}</strong><span>Plant time</span><strong>Raw / unmapped · {rawCount}</strong></div>
    <div className="si-evidence-chronology__scroll">
      {rows.map((row) => <div className={`si-evidence-chronology__row state-${row.physical}`} key={row.atUtc}>
        <div className="si-evidence-chronology__lane mapped"><i/><EvidenceButtons items={row.mapped} selectedKeys={selectedKeys} onSelect={onSelect}/>{!row.mapped.length && <span className="si-evidence-chronology__quiet">{row.physicalLabel}</span>}</div>
        <time title={`${formatPlantDateTimeCt(row.atUtc)} → ${formatPlantDateTimeCt(row.toUtc)}`}>{formatPlantDateTimeCt(row.atUtc)}<small>{row.physicalLabel.replace(/ #\d+$/, '')}</small></time>
        <div className="si-evidence-chronology__lane raw"><i/><EvidenceButtons items={row.raw} selectedKeys={selectedKeys} onSelect={onSelect} raw/>{!row.raw.length && <span className="si-evidence-chronology__quiet">{row.physicalLabel}</span>}</div>
      </div>)}
    </div>
    <div className="si-timeline-legend"><span className="running">Running</span><span className="stopped">Stopped</span><span className="testing">Testing</span><span className="unknown">Unknown</span></div>
  </section>
}
