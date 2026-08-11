import { formatDuration } from '../episode-presentation'
import type { EpisodeStateSummary, RadiusPressEpisodes } from '../types/api'

function StateRows({ values, empty }: { values: EpisodeStateSummary[]; empty: string }) {
  if (values.length === 0) return <p className="quiet-copy">{empty}</p>
  return <ol className="ranked-list">{values.slice(0, 4).map((value) => (
    <li key={`${value.eventType}-${value.statusDescription}`}>
      <span>{value.statusDescription}</span><strong>{value.percentage.toFixed(1)}%</strong>
      <small>{value.count} occurrence{value.count === 1 ? '' : 's'} · median dwell {formatDuration(value.medianDwellSeconds)}</small>
    </li>
  ))}</ol>
}

export function PatternSummary({ result }: { result: RadiusPressEpisodes }) {
  const { analysis } = result
  const afterMakeReady = analysis.transitionSummaries.find(({ fromStatusDescription }) => fromStatusDescription.toLowerCase() === 'make ready')
  const commonSequence = analysis.sequenceFamilies[0]
  return (
    <section className="panel" aria-labelledby="pattern-title">
      <div className="section-heading"><div><p className="eyebrow">Deterministic patterns</p><h2 id="pattern-title">What normally happens</h2></div></div>
      <div className="pattern-grid">
        <article>
          <h3>After production stops</h3>
          <StateRows values={analysis.firstStates} empty="No episode starts are available in this range." />
        </article>
        <article>
          <h3>After Make Ready</h3>
          <StateRows values={afterMakeReady?.outcomes ?? []} empty="No Make Ready transitions are available in this range." />
        </article>
        <article>
          <h3>Before successful production</h3>
          <StateRows values={analysis.finalStatesBeforeSuccess} empty="No confirmed production returns are available in this range." />
        </article>
        <article>
          <h3>Duration and return pattern</h3>
          <dl className="compact-facts">
            <div><dt>Median episode</dt><dd>{analysis.medianDurationSeconds === null ? 'Insufficient data' : formatDuration(analysis.medianDurationSeconds)}</dd></div>
            <div><dt>P75 / P90</dt><dd>{analysis.p75DurationSeconds === null ? 'Needs at least 5 episodes' : `${formatDuration(analysis.p75DurationSeconds)} / ${formatDuration(analysis.p90DurationSeconds ?? 0)}`}</dd></div>
            <div><dt>First-return success</dt><dd>{analysis.failedReturns.firstReturnSuccessRate === null ? 'No completed episodes' : `${analysis.failedReturns.firstReturnSuccessRate.toFixed(1)}%`}</dd></div>
            <div><dt>Failed returns</dt><dd>{analysis.failedReturns.oneFailedReturnCount} one · {analysis.failedReturns.multipleFailedReturnCount} multiple</dd></div>
            <div><dt>Most time-consuming phase</dt><dd>{analysis.mostTimeConsumingPhase?.statusDescription ?? 'No phase data'}</dd></div>
          </dl>
        </article>
      </div>
      <div className="sequence-summary">
        <h3>Common sequence families</h3>
        {commonSequence ? <p className="primary-sequence"><span>{commonSequence.states.join(' → ')}</span><strong>{commonSequence.count} · {commonSequence.percentage.toFixed(1)}% · median {formatDuration(commonSequence.medianDurationSeconds)}</strong></p> : <p className="quiet-copy">No sequence families are available.</p>}
        {analysis.sequenceFamilies.length > 1 && <details><summary>Show {analysis.sequenceFamilies.length - 1} less-common variant{analysis.sequenceFamilies.length === 2 ? '' : 's'}</summary><ol className="sequence-list">{analysis.sequenceFamilies.slice(1).map((family) => <li key={family.sequenceKey}><span>{family.states.join(' → ')}</span><strong>{family.count} · {family.percentage.toFixed(1)}% · median {formatDuration(family.medianDurationSeconds)}</strong></li>)}</ol></details>}
      </div>
    </section>
  )
}
