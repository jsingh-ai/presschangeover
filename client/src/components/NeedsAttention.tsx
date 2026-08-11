import { completionLabel, formatDuration } from '../episode-presentation'
import { formatPlantDateTime } from '../time-ranges'
import type { EpisodeAttentionItem, OperationalEpisode, RadiusPressEpisodes } from '../types/api'
import { attentionItemsForPress } from '../workspace-state'

export function NeedsAttention({ result, onSelectFinding }: { result: RadiusPressEpisodes; onSelectFinding(item: EpisodeAttentionItem, episode: OperationalEpisode): void }) {
  const byId = new Map(result.episodes.map((episode) => [episode.episodeId, episode]))
  const items = attentionItemsForPress(result.analysis.attentionItems, result.press.pressKey)
  return (
    <section className="panel attention-panel" aria-labelledby="attention-title">
      <div className="section-heading"><div><p className="eyebrow">Explained exceptions</p><h2 id="attention-title">Needs attention</h2></div><span className="attention-count">{items.length}</span></div>
      {items.length === 0 ? <p className="quiet-copy">No {result.press.displayName} episodes met the deterministic attention rules for this range. P90 rules require at least five episodes.</p> : (
        <div className="attention-list">{items.map((item, index) => {
          const episode = byId.get(item.episodeId)
          return <button key={item.episodeId} type="button" disabled={!episode} onClick={() => episode && onSelectFinding(item, episode)}>
            <small className="attention-item-kicker">Exception {index + 1} · {formatPlantDateTime(item.startUtc)} CT</small>
            <strong>{item.descriptor}</strong>
            {episode && <span className="attention-item-facts"><em>{formatDuration(episode.durationSeconds)}</em><em>{completionLabel(episode)}</em><em>{episode.failedReturnToProductionAttempts} failed return{episode.failedReturnToProductionAttempts === 1 ? '' : 's'}</em></span>}
            <span className="attention-item-reason">Why it was flagged</span>
            <ul>{item.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
            <span className="attention-item-action">Open complete evidence →</span>
          </button>
        })}</div>
      )}
    </section>
  )
}
