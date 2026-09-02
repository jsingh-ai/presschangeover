import { formatPlantDateTimeCt } from '../time-ranges'
import type { StopIntelligenceDetail } from '../types/stop-intelligence'
import type { TimelineIntervalItem, TimelineIntervalTrack } from './SynchronizedTimeline'

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

const clampedIso = (at: number, from: number, to: number) => new Date(Math.max(from, Math.min(to, at))).toISOString()

export function deckStatusIntervalLabel(state: DeckStatusState) { return STATE_LABELS[state] }

/** Deck state is rendered as ten compact native rows on the investigation's shared time axis. */
export function buildDeckStatusTimelineTracks(detail: StopIntelligenceDetail): TimelineIntervalTrack[] {
  const context = detail.deckStatusContext
  if (context.availability === 'UNAVAILABLE') return [{ id: 'deck-status-availability', label: 'Deck status', intervals: [], unavailableLabel: context.reason }]
  const from = Date.parse(detail.speedContext.fromUtc)
  const to = Date.parse(detail.speedContext.toUtc)
  const span = Math.max(1, to - from)
  const markerDuration = Math.max(1_000, span * .0012)
  const unavailableLabel = context.availability === 'PARTIAL' ? context.reason : 'No observed deck state in this context window'

  return context.decks
    .filter(({ deckNumber }) => deckNumber >= 1 && deckNumber <= 10)
    .sort((left, right) => left.deckNumber - right.deckNumber)
    .map((deck) => {
      const states: TimelineIntervalItem[] = deck.intervals.flatMap((interval, index) => {
        const start = Math.max(from, Date.parse(interval.startUtc))
        const end = Math.min(to, Date.parse(interval.endUtc))
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return []
        const label = deckStatusIntervalLabel(interval.state)
        const startUtc = new Date(start).toISOString(); const endUtc = new Date(end).toISOString()
        return [{
          id: `deck-status:${deck.deckNumber}:state:${index}`,
          startUtc,
          endUtc,
          label,
          className: `si-deck-timeline-state state-${interval.state.toLowerCase()}`,
          details: `Deck ${deck.deckNumber} · ${label}\n${formatPlantDateTimeCt(startUtc)} → ${formatPlantDateTimeCt(endUtc)}\n${duration(startUtc, endUtc)}`,
        }]
      })
      const events: TimelineIntervalItem[] = deck.events.flatMap((event, index) => {
        const at = Date.parse(event.atUtc)
        if (!Number.isFinite(at) || at < from || at > to) return []
        const start = Math.max(from, at - markerDuration / 2)
        const end = Math.min(to, Math.max(start + 1_000, at + markerDuration / 2))
        return [{
          id: `deck-status:${deck.deckNumber}:event:${index}`,
          startUtc: clampedIso(start, from, to),
          endUtc: clampedIso(end, from, to),
          label: event.label,
          compactLabel: '',
          className: 'si-deck-timeline-event',
          details: `Deck ${deck.deckNumber} · ${event.label}\n${formatPlantDateTimeCt(event.atUtc)}`,
        }]
      })
      return {
        id: `deck-status-${deck.deckNumber}`,
        label: `Deck ${deck.deckNumber}`,
        className: 'si-deck-timeline-row',
        intervals: [...states, ...events],
        unavailableLabel,
      }
    })
}
