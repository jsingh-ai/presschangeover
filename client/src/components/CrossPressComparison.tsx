import { formatDuration } from '../episode-presentation'
import type { FleetEpisodeAnalysis, RadiusPressKey } from '../types/api'

export function CrossPressComparison({ analysis, selectedPress }: { analysis: FleetEpisodeAnalysis; selectedPress: RadiusPressKey }) {
  const matching = analysis.sequenceFamilies.filter((family) => family.presses.some(({ pressKey, episodeCount }) => pressKey === selectedPress && episodeCount >= 2))
  const comparable = matching.filter(({ comparable }) => comparable).slice(0, 3)
  return (
    <section className="panel" aria-labelledby="cross-press-title">
      <div className="section-heading"><div><p className="eyebrow">Like-for-like cohorts</p><h2 id="cross-press-title">Cross-press comparison</h2></div></div>
      {comparable.length === 0 ? <p className="quiet-copy">Insufficient samples for a responsible cross-press comparison. The same exact sequence needs at least two episodes on this press and two on another press in the selected range.</p> : comparable.map((family) => (
        <article className="cross-press-family" key={family.sequenceKey}>
          <h3>{family.states.join(' → ')}</h3>
          <div className="cross-press-table" role="table" aria-label="Equivalent sequence comparison">
            <div className="cross-press-head" role="row"><span>Press</span><span>Episodes</span><span>Median total</span><span>Median phase</span><span>Failed return</span></div>
            {family.presses.filter(({ episodeCount }) => episodeCount >= 2).map((press) => <div className={press.pressKey === selectedPress ? 'selected' : ''} role="row" key={press.pressKey}><strong>{press.displayName}</strong><span>{press.episodeCount}</span><span>{formatDuration(press.medianDurationSeconds)}</span><span>{formatDuration(press.medianPhaseDurationSeconds)}</span><span>{press.failedReturnRate.toFixed(1)}%</span></div>)}
          </div>
        </article>
      ))}
    </section>
  )
}
