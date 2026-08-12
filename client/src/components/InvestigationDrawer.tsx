import { useMemo } from 'react'
import { completionLabel, formatDuration, signedDurationDifference } from '../episode-presentation'
import { formatPlantDateTime } from '../time-ranges'
import type {
  EpisodeAttentionItem,
  OperationalEpisode,
  RadiusPressEpisodes,
  RadiusStateSegment,
  RadiusStatusSegment,
} from '../types/api'
import type { InvestigationRoute } from '../workspace-state'
import { EpisodeDetail } from './EpisodeDetail'
import { SegmentDetail } from './SegmentDetail'
import { EvidenceDrawerShell } from './EvidenceDrawerShell'
import { PhysicalEvidencePanel } from './PhysicalEvidencePanel'

interface Props {
  route: Exclude<InvestigationRoute, { mode: 'status' } | { mode: 'anomaly' }>
  result?: RadiusPressEpisodes
  episode?: OperationalEpisode
  segment?: RadiusStatusSegment
  finding?: EpisodeAttentionItem
  loading?: boolean
  onClose(): void
  onSelectSegment?(segment: RadiusStatusSegment): void
  contextSegments?: RadiusStatusSegment[]
}

function findEpisodeForSegment(result: RadiusPressEpisodes, segment: RadiusStatusSegment | undefined) {
  if (!segment) return undefined
  return result.episodes.find((episode) => (episode.displaySegments?.length ? episode.displaySegments : episode.statusSegments).some(
    (candidate) => candidate.startUtc === segment.startUtc && candidate.endUtc === segment.endUtc,
  ))
}

function surroundingPhases(result: RadiusPressEpisodes | undefined, segment: RadiusStatusSegment | undefined, contextSegments: RadiusStatusSegment[] | undefined) {
  if (!result || !segment) return {}
  const candidates = contextSegments?.length ? contextSegments : result.timelineSegments
  let navigationCandidates = segment.kind === 'radius'
    ? candidates.filter((candidate) => candidate.kind === 'radius')
    : candidates
  let index = navigationCandidates.findIndex(
    (candidate) => candidate.startUtc === segment.startUtc && candidate.endUtc === segment.endUtc,
  )
  if (index < 0 && candidates !== result.timelineSegments) {
    navigationCandidates = segment.kind === 'radius'
      ? result.timelineSegments.filter((candidate) => candidate.kind === 'radius')
      : result.timelineSegments
    index = navigationCandidates.findIndex(
      (candidate) => candidate.startUtc === segment.startUtc && candidate.endUtc === segment.endUtc,
    )
  }
  return index < 0 ? {} : {
    previous: navigationCandidates[index - 1],
    next: navigationCandidates[index + 1],
  }
}

function largestPhaseDifference(result: RadiusPressEpisodes, episode: OperationalEpisode | undefined) {
  if (!episode) return undefined
  return episode.statusSegments
    .filter(({ isProduction }) => !isProduction)
    .map((segment) => {
      const benchmark = result.analysis.phaseBenchmarks.find(
        (candidate) => candidate.eventType === segment.eventType && candidate.statusDescription === segment.statusDescription,
      )
      return benchmark && benchmark.sampleCount >= 3
        ? { segment, benchmark, difference: segment.durationSeconds - benchmark.medianDurationSeconds }
        : undefined
    })
    .filter((value): value is NonNullable<typeof value> => value !== undefined)
    .sort((left, right) => right.difference - left.difference)[0]
}

function stateTone(segment: RadiusStateSegment): string {
  if (segment.isProduction) return 'production'
  if (segment.eventType === 'M') return 'make-ready'
  if (segment.eventType === 'B') return 'bad'
  if (segment.eventType === 'S') return 'safety'
  if (segment.eventType === 'G') return 'good-other'
  return 'other'
}

function phaseTone(segment: RadiusStatusSegment): string {
  return segment.kind === 'offline' ? 'offline' : stateTone(segment)
}

function phaseLabel(segment: RadiusStatusSegment | undefined, emptyLabel = 'No adjacent state in range'): string {
  return !segment ? emptyLabel : segment.kind === 'offline' ? 'Offline / No Radius Data' : segment.statusDescription
}

export function InvestigationDrawer({ route, result, episode, segment, finding, loading = false, onClose, onSelectSegment, contextSegments }: Props) {
  const segmentEpisode = useMemo(() => result ? findEpisodeForSegment(result, segment) : undefined, [result, segment])
  const contextEpisode = route.mode === 'segment' ? segmentEpisode : episode
  const phases = surroundingPhases(result, segment, contextSegments)
  const profile = contextEpisode && result?.analysis.episodeProfiles.find(({ episodeId }) => episodeId === contextEpisode.episodeId)
  const largestDifference = result ? largestPhaseDifference(result, episode) : undefined
  const confirmedProduction = result && episode?.confirmedProductionStartUtc
    ? result.timelineSegments.find((candidate) => candidate.kind === 'radius' && candidate.isProduction && Date.parse(candidate.startUtc) <= Date.parse(episode.confirmedProductionStartUtc!) && Date.parse(candidate.endUtc) > Date.parse(episode.confirmedProductionStartUtc!))
    : undefined

  const stateSegment = segment?.kind === 'radius' ? segment as RadiusStateSegment : undefined
  const benchmark = stateSegment && result?.analysis.phaseBenchmarks.find(
    (candidate) => candidate.eventType === stateSegment.eventType && candidate.statusDescription === stateSegment.statusDescription,
  )
  const phaseDifference = stateSegment && benchmark ? stateSegment.durationSeconds - benchmark.medianDurationSeconds : null
  const phasePercentage = stateSegment && segmentEpisode && segmentEpisode.durationSeconds > 0
    ? (stateSegment.durationSeconds / segmentEpisode.durationSeconds) * 100
    : null

  const segmentPressLabel = route.mode === 'segment' && route.pressKey ? route.pressKey.replace('press', 'Press ') : undefined
  const pressLabel = result?.press.displayName ?? segmentPressLabel ?? 'Press investigation'
  return <EvidenceDrawerShell eyebrow={`Evidence · ${route.mode}`} title={pressLabel} context={route.mode === 'segment' ? 'Exact Radius interval' : 'Operational evidence'} tone={stateSegment ? stateTone(stateSegment) : 'neutral'} loading={loading} onClose={onClose}>
      {!loading && route.mode === 'segment' && segment && <div className="drawer-content">
        <section className="drawer-state-context" aria-label="Adjacent Radius states">
          <button
            className={`drawer-state-block drawer-state-block--${phases.previous ? phaseTone(phases.previous) : 'empty'}`}
            type="button"
            disabled={!phases.previous || !onSelectSegment}
            onClick={() => phases.previous && onSelectSegment?.(phases.previous)}
            title={phases.previous ? `Open previous state: ${phaseLabel(phases.previous)}` : 'No previous state in this range'}
          >
            <span className="drawer-state-block-direction" aria-hidden="true">←</span><small>Previous state</small><strong>{phaseLabel(phases.previous, 'No previous state in range')}</strong>
          </button>
          <div className={`drawer-state-block drawer-state-block--${phaseTone(segment)}`} aria-current="step">
            <small>Current state</small><strong>{phaseLabel(segment)}</strong>
          </div>
          <button
            className={`drawer-state-block drawer-state-block--${phases.next ? phaseTone(phases.next) : 'empty'}`}
            type="button"
            disabled={!phases.next || !onSelectSegment}
            onClick={() => phases.next && onSelectSegment?.(phases.next)}
            title={phases.next ? `Open next state: ${phaseLabel(phases.next)}` : 'No next state in this range'}
          >
            <span className="drawer-state-block-direction" aria-hidden="true">→</span><small>Next state</small><strong>{phaseLabel(phases.next, 'No next state in range')}</strong>
          </button>
        </section>
        <div className="drawer-segment-hero drawer-segment-hero--neutral">
          <div className="drawer-segment-hero-heading"><div><span>Exact Radius phase</span><strong>{segment.kind === 'offline' ? 'Offline / No Radius Data' : segment.statusDescription}</strong></div><em>{segment.kind === 'offline' ? 'No data' : segment.isProduction ? 'Production' : 'Non-production'}</em></div>
          <div className="drawer-interval-grid">
            <div><span>Start</span><strong>{formatPlantDateTime(segment.startUtc)}</strong><small>Plant time · CT</small></div>
            <div><span>End</span><strong>{formatPlantDateTime(segment.endUtc)}</strong><small>Plant time · CT</small></div>
            <div><span>Duration</span><strong>{formatDuration(segment.durationSeconds)}</strong><small>{segment.isOpen ? 'Still open' : 'Completed interval'}</small></div>
          </div>
        </div>
        {stateSegment?.returnToProduction === 'confirmed' && <p className="confirmation-note">Confirmed production evidence: {formatPlantDateTime(stateSegment.startUtc)} to {formatPlantDateTime(stateSegment.endUtc)} CT. The episode ended at {formatPlantDateTime(segmentEpisode?.endUtc ?? stateSegment.startUtc)} CT.</p>}
        <SegmentDetail segment={segment} embedded />
        {segment.kind === 'radius' && <PhysicalEvidencePanel pressKey={segment.pressKey} fromUtc={segment.startUtc} toUtc={segment.endUtc} />}
        <section className="drawer-analysis" aria-label="Phase comparison">
          <h3>Episode context</h3>
          <dl className="compact-facts">
            <div><dt>Episode</dt><dd>{profile?.descriptor ?? 'Not part of a reconstructed episode'}</dd></div>
            <div><dt>Share of episode</dt><dd>{stateSegment?.returnToProduction === 'confirmed' ? 'Confirmation evidence · not downtime' : phasePercentage === null ? 'Not applicable' : `${phasePercentage.toFixed(1)}%`}</dd></div>
            <div><dt>Previous state</dt><dd>{phases.previous?.statusDescription ?? 'Production before episode / unavailable'}</dd></div>
            <div><dt>Next state</dt><dd>{phases.next?.statusDescription ?? 'No later phase in episode'}</dd></div>
            <div><dt>Comparable median</dt><dd>{benchmark && benchmark.sampleCount >= 3 ? formatDuration(benchmark.medianDurationSeconds) : 'Insufficient samples'}</dd></div>
            <div><dt>Difference</dt><dd>{phaseDifference !== null && benchmark && benchmark.sampleCount >= 3 ? signedDurationDifference(phaseDifference) : 'Insufficient samples'}</dd></div>
            <div><dt>Unusually long</dt><dd>{benchmark?.p90DurationSeconds !== null && benchmark?.p90DurationSeconds !== undefined && stateSegment && stateSegment.durationSeconds > benchmark.p90DurationSeconds ? 'Yes · above P90' : 'No supported finding'}</dd></div>
          </dl>
          {contextEpisode && <p className="drawer-sequence">{contextEpisode.statusSegments.map(({ statusDescription }) => statusDescription).join(' → ')}</p>}
        </section>
      </div>}
      {!loading && result && route.mode === 'episode' && episode && <div className="drawer-content">
        <div className="drawer-focus-title"><span>Operational episode</span><strong>{profile?.descriptor ?? episode.primaryStatusDescription}</strong></div>
        <dl className="drawer-summary compact-facts">
          <div><dt>Trusted start</dt><dd>{formatPlantDateTime(episode.startUtc)} CT</dd></div>
          <div><dt>Trusted end</dt><dd>{episode.endUtc ? `${formatPlantDateTime(episode.endUtc)} CT` : 'Open'}</dd></div>
          {episode.dataInterrupted && <div><dt>End of visible episode</dt><dd>{episode.displayEndUtc ? `${formatPlantDateTime(episode.displayEndUtc)} CT` : 'Unavailable interval end unknown'}</dd></div>}
          <div><dt>{episode.dataInterrupted ? 'Observed Radius duration' : 'Duration'}</dt><dd>{formatDuration(episode.observedDurationSeconds ?? episode.durationSeconds)}</dd></div>
          {episode.dataInterrupted && <div><dt>Wall-clock duration</dt><dd>{formatDuration(episode.wallClockDurationSeconds ?? episode.durationSeconds)}</dd></div>}
          {episode.dataInterrupted && <div><dt>Data unavailable</dt><dd>{formatDuration(episode.unavailableDurationSeconds ?? 0)}</dd></div>}
          <div><dt>Compared with press median</dt><dd>{result.analysis.medianDurationSeconds === null ? 'Insufficient samples' : signedDurationDifference(episode.durationSeconds - result.analysis.medianDurationSeconds)}</dd></div>
        </dl>
        <EpisodeDetail episode={episode} label={profile?.descriptor} embedded />
      </div>}
      {!loading && result && route.mode === 'attention' && finding && episode && <div className="drawer-content">
        <div className="drawer-focus-title"><span>Why this is worth reviewing</span><strong>{finding.descriptor}</strong></div>
        <p className="exception-summary">This is a deterministic exception from the observed Radius sequence—not a predicted cause. The evidence below shows the exact interval, the rule that triggered it, the comparison cohort, and what happened during recovery.</p>
        <section className="exception-evidence-card">
          <h3>What happened</h3>
          <div className="drawer-interval-grid">
            <div><span>Start</span><strong>{formatPlantDateTime(episode.startUtc)}</strong><small>Plant time · CT</small></div>
            <div><span>Trusted end</span><strong>{episode.endUtc ? formatPlantDateTime(episode.endUtc) : 'Still open'}</strong><small>{episode.dataInterrupted ? 'Ends at data gap' : 'Plant time · CT'}</small></div>
            <div><span>Duration</span><strong>{formatDuration(episode.durationSeconds)}</strong><small>{completionLabel(episode)}</small></div>
          </div>
          <dl className="compact-facts exception-facts">
            <div><dt>Status transitions</dt><dd>{episode.statusSegments.length}</dd></div>
            <div><dt>Primary time driver</dt><dd>{episode.primaryStatusDescription}</dd></div>
            <div><dt>Observed sequence</dt><dd>{episode.statusSegments.map(({ statusDescription }) => statusDescription).join(' → ')}</dd></div>
          </dl>
        </section>
        <section className="exception-evidence-card exception-evidence-card--reason">
          <h3>Why it was flagged</h3>
          <ul className="finding-reasons">{finding.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
          <dl className="compact-facts exception-facts">
            <div><dt>Comparison population</dt><dd>{result.analysis.episodeCount} {result.press.displayName} episode{result.analysis.episodeCount === 1 ? '' : 's'}</dd></div>
            <div><dt>Press median</dt><dd>{result.analysis.medianDurationSeconds === null ? 'Insufficient samples' : formatDuration(result.analysis.medianDurationSeconds)}</dd></div>
            <div><dt>Difference from median</dt><dd>{result.analysis.medianDurationSeconds === null ? 'Insufficient samples' : signedDurationDifference(episode.durationSeconds - result.analysis.medianDurationSeconds)}</dd></div>
            <div><dt>Press P90 threshold</dt><dd>{result.analysis.p90DurationSeconds === null ? 'Requires at least 5 episodes' : formatDuration(result.analysis.p90DurationSeconds)}</dd></div>
            <div><dt>Largest comparable phase difference</dt><dd>{largestDifference ? `${largestDifference.segment.statusDescription}: ${signedDurationDifference(largestDifference.difference)} vs ${formatDuration(largestDifference.benchmark.medianDurationSeconds)} median (${largestDifference.benchmark.sampleCount} samples)` : 'Insufficient matched phase samples'}</dd></div>
          </dl>
        </section>
        <section className="exception-evidence-card">
          <h3>Recovery and data confidence</h3>
          <dl className="compact-facts exception-facts">
            <div><dt>Production return attempts</dt><dd>{episode.returnToProductionAttemptCount}</dd></div>
            <div><dt>Failed returns under 5 minutes</dt><dd>{episode.failedReturnToProductionAttempts}</dd></div>
            <div><dt>Confirmed production start</dt><dd>{episode.confirmedProductionStartUtc ? `${formatPlantDateTime(episode.confirmedProductionStartUtc)} CT` : 'Not confirmed'}</dd></div>
            <div><dt>Confirmation satisfied</dt><dd>{episode.confirmationSatisfiedUtc ? `${formatPlantDateTime(episode.confirmationSatisfiedUtc)} CT` : 'Not satisfied in range'}</dd></div>
            <div><dt>Full production observed after recovery</dt><dd>{confirmedProduction ? `${formatDuration(confirmedProduction.durationSeconds)} · through ${formatPlantDateTime(confirmedProduction.endUtc)} CT` : 'No sustained production span available'}</dd></div>
            <div><dt>Data confidence</dt><dd>{episode.dataInterrupted ? 'Interrupted by offline data' : episode.startedAfterDataGap ? 'Started after an offline gap; earlier start unknown' : episode.startedBeforeRange ? 'Already active at range start' : 'Continuous observations through the episode'}</dd></div>
          </dl>
        </section>
        <EpisodeDetail episode={episode} label={profile?.descriptor} embedded />
      </div>}
      {!loading && result && ((route.mode === 'segment' && !segment) || (route.mode === 'episode' && !episode) || (route.mode === 'attention' && (!episode || !finding))) && <p className="drawer-missing">This investigation is not present in the selected range.</p>}
  </EvidenceDrawerShell>
}
