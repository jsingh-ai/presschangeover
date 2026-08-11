import { formatDuration } from '../episode-presentation'
import type { EpisodeAttentionItem, FleetEpisodeAnalysis, OperationalEpisode, RadiusPressEpisodes, RadiusStatusSegment } from '../types/api'
import { CrossPressComparison } from './CrossPressComparison'
import { EpisodeComparisonBoard } from './EpisodeComparisonBoard'
import { NeedsAttention } from './NeedsAttention'
import { PatternSummary } from './PatternSummary'
import { PressDetail } from './PressDetail'

interface Props {
  result: RadiusPressEpisodes
  fleetAnalysis: FleetEpisodeAnalysis
  onClear(): void
  onPrevious?(): void
  onNext?(): void
  hasPrevious?: boolean
  hasNext?: boolean
  onBackToOverview?(): void
  inline?: boolean
  onSelectEpisode(episode: OperationalEpisode): void
  onSelectSegment(segment: RadiusStatusSegment): void
  onSelectFinding(item: EpisodeAttentionItem, episode: OperationalEpisode): void
}

export function OperatingRunSnapshot({ result }: { result: RadiusPressEpisodes }) {
  const runs = result.runComparison?.runs ?? []
  if (!runs.length) return null
  const latest = runs[0]!
  const sustainedReturns = runs.filter(({ productionStartUtc }) => productionStartUtc !== null).length
  const shortAttempts = runs.reduce((total, run) => total + run.shortRunAttemptCount, 0)
  const partialRuns = runs.filter(({ isPartial, dataInterrupted }) => isPartial || dataInterrupted).length
  return <section className="panel focused-run-snapshot" aria-labelledby="focused-run-snapshot-title">
    <div className="section-heading"><div><p className="eyebrow">Operating Run context</p><h2 id="focused-run-snapshot-title">Run snapshot</h2><p className="section-description">Compact context from the existing 120-second State Breakdown Run definition. Downtime Episode Comparison remains the primary investigation below.</p></div></div>
    <dl>
      <div><dt>Runs in period</dt><dd>{runs.length}</dd></div>
      <div><dt>Sustained returns</dt><dd>{sustainedReturns}</dd></div>
      <div><dt>Short Run attempts</dt><dd>{shortAttempts}</dd></div>
      <div><dt>Partial / interrupted</dt><dd>{partialRuns}</dd></div>
      <div><dt>Latest Run total</dt><dd>{formatDuration(latest.totalDurationSeconds)}</dd></div>
      <div><dt>Latest time to production</dt><dd>{latest.timeToProductionSeconds === null ? 'Not reached' : formatDuration(latest.timeToProductionSeconds)}</dd></div>
      <div><dt>Latest production duration</dt><dd>{formatDuration(latest.productionDurationSeconds)}</dd></div>
    </dl>
  </section>
}

export function SelectedPressWorkspace({ result, fleetAnalysis, onClear, onPrevious, onNext, hasPrevious = false, hasNext = false, onBackToOverview, inline = false, onSelectEpisode, onSelectSegment, onSelectFinding }: Props) {
  return <section className={inline ? 'selected-workspace selected-workspace--inline' : 'selected-workspace'} aria-label={`${result.press.displayName} decision workspace`}>
    <div className={inline ? 'selected-press-bar selected-press-bar--inline' : 'selected-press-bar'}>
      <div><p className="eyebrow">Focused press investigation</p>{inline ? <h2>{result.press.displayName} details</h2> : <button type="button" className="selected-press-chip" onClick={onClear} aria-label={`Clear ${result.press.displayName} focus`}>{result.press.displayName}<span aria-hidden="true">×</span></button>}</div>
      <div className="selected-press-facts">
        <span><strong>{result.summary.episodeCount}</strong> episodes</span>
        <span><strong>{formatDuration(result.summary.totalNonProductionSeconds)}</strong> non-production</span>
        <span><strong>{result.summary.dataCoveragePercent.toFixed(1)}%</strong> coverage</span>
        <span><strong>{result.rangeEndIsLive ? 'Now' : 'Range end'}:</strong> {result.availability === 'offline' ? 'Offline / No Radius Data' : result.currentStatusDescription ?? 'No known state'}</span>
      </div>
      <div className="selected-press-actions">
        {(onPrevious || onNext) && <div className="press-cycle-controls" role="group" aria-label="Cycle focused press"><button type="button" onClick={onPrevious} disabled={!hasPrevious} aria-label="Previous press">←</button><button type="button" onClick={onNext} disabled={!hasNext} aria-label="Next press">→</button></div>}
        {onBackToOverview && <button type="button" className="back-to-overview" onClick={onBackToOverview}>Back to overview</button>}
      </div>
    </div>
    <OperatingRunSnapshot result={result} />
    <EpisodeComparisonBoard result={result} onSelectEpisode={onSelectEpisode} onSelectSegment={onSelectSegment} />
    <div className="decision-grid">
      <PatternSummary result={result} />
      <NeedsAttention result={result} onSelectFinding={onSelectFinding} />
    </div>
    <CrossPressComparison analysis={fleetAnalysis} selectedPress={result.press.pressKey} />
    <details className="investigation-drawer"><summary>Historical timeline and transition log</summary><PressDetail result={result} onBack={onClear} onSelectEpisode={onSelectEpisode} onSelectSegment={onSelectSegment} embedded /></details>
  </section>
}
