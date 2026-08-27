import { formatPlantDateTimeCt } from '../time-ranges'
import type { StopIntelligenceDetail } from '../types/stop-intelligence'

type DeckStatusState = StopIntelligenceDetail['deckStatusContext']['decks'][number]['intervals'][number]['state']

const STATE_LABELS: Record<DeckStatusState, string> = {
  PRINTING: 'Printing',
  OUT: 'Deck out',
  READY: 'Active / ready',
  INACTIVE: 'Inactive',
  UNKNOWN: 'Unknown',
}

const duration = (fromUtc: string, toUtc: string) => {
  const seconds = Math.max(0, Math.round((Date.parse(toUtc) - Date.parse(fromUtc)) / 1_000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60); const remainder = seconds % 60
  return `${minutes}m${remainder ? ` ${remainder}s` : ''}`
}

export function deckStatusIntervalLabel(state: DeckStatusState) { return STATE_LABELS[state] }

export function StopDeckStatusGantt({ detail }: { detail: StopIntelligenceDetail }) {
  const context = detail.deckStatusContext
  const from = Date.parse(context.fromUtc); const to = Date.parse(context.toUtc); const span = Math.max(1, to - from)
  const position = (atUtc: string) => Math.max(0, Math.min(100, (Date.parse(atUtc) - from) / span * 100))
  const stopStart = position(detail.stop.physicalSegment.startAt)
  const stopEnd = position(detail.stop.physicalSegment.endAt ?? context.toUtc)
  if (context.availability === 'UNAVAILABLE') return <details className="si-deck-status si-deck-status--unavailable"><summary><span><strong>Deck status · Decks 1–10</strong><small>Raw deck-position and print engagement were unavailable.</small></span><b>Unavailable</b></summary><p>{context.reason}</p></details>
  return <details className="si-deck-status" open>
    <summary><span><strong>Deck status · Decks 1–10</strong><small>One compact view of print engagement, out position, active/ready time, and print-off commands.</small></span><b>{context.availability === 'AVAILABLE' ? 'Observed' : 'Partial'}</b></summary>
    <div className="si-deck-status__body">
      <div className="si-deck-status__legend"><span className="printing">Printing</span><span className="out">Deck out</span><span className="ready">Active / ready</span><span className="inactive">Inactive</span><span className="command">Print-off command</span><span className="unknown">Unknown</span></div>
      <div className="si-deck-status__axis"><span style={{ left: '0%' }}>{formatPlantDateTimeCt(context.fromUtc)}</span><span className="stop-start" style={{ left: `${stopStart}%` }}>Stop</span><span className="stop-end" style={{ left: `${stopEnd}%` }}>Recovery</span><span style={{ left: '100%' }}>{formatPlantDateTimeCt(context.toUtc)}</span></div>
      <div className="si-deck-status__rows">
        {context.decks.filter(({ deckNumber }) => deckNumber >= 1 && deckNumber <= 10).map((deck) => <div className="si-deck-status__row" key={deck.deckNumber}><strong>Deck {deck.deckNumber}</strong><div className="si-deck-status__track">
          <i className="si-deck-status__stop-window" style={{ left: `${stopStart}%`, width: `${Math.max(0, stopEnd - stopStart)}%` }}/>
          {deck.intervals.map((interval, index) => { const left = position(interval.startUtc); const right = position(interval.endUtc); const label = deckStatusIntervalLabel(interval.state); return <span key={`${interval.startUtc}:${index}`} className={`si-deck-status__interval state-${interval.state.toLowerCase()}`} style={{ left: `${left}%`, width: `${Math.max(.12, right - left)}%` }} title={`Deck ${deck.deckNumber} · ${label}\n${formatPlantDateTimeCt(interval.startUtc)} → ${formatPlantDateTimeCt(interval.endUtc)}\n${duration(interval.startUtc, interval.endUtc)}`} aria-label={`Deck ${deck.deckNumber}, ${label}, ${formatPlantDateTimeCt(interval.startUtc)} to ${formatPlantDateTimeCt(interval.endUtc)}`}/> })}
          {deck.events.map((event, index) => <span key={`${event.atUtc}:${index}`} className="si-deck-status__event" style={{ left: `${position(event.atUtc)}%` }} title={`Deck ${deck.deckNumber} · ${event.label}\n${formatPlantDateTimeCt(event.atUtc)}`} aria-label={`Deck ${deck.deckNumber}, ${event.label}, ${formatPlantDateTimeCt(event.atUtc)}`}/>)}
        </div></div>)}
      </div>
      <p>{context.reason} Hover a segment for its exact time range.</p>
    </div>
  </details>
}
