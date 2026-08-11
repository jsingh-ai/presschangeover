import type { OperationalEpisode } from '../types/api'
import { formatPlantDateTime } from '../time-ranges'

interface EpisodeDetailProps {
  episode: OperationalEpisode
  onBack?(): void
  embedded?: boolean
  label?: string
}

function duration(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  const remainder = Math.round(seconds % 60)
  return `${minutes}m ${remainder.toString().padStart(2, '0')}s`
}

export function EpisodeDetail({ episode, onBack, embedded = false, label }: EpisodeDetailProps) {
  const displaySegments = episode.displaySegments?.length ? episode.displaySegments : episode.statusSegments
  const completion = episode.dataInterrupted
    ? 'Data interrupted'
    : episode.isOpen
      ? 'Open'
      : duration(episode.durationSeconds)
  return (
    <>
      {!embedded && onBack && <button className="text-action" type="button" onClick={onBack}>← {episode.displayName} episodes</button>}
      {!embedded && <section className="detail-heading">
        <div>
          <p className="eyebrow">Radius episode detail</p>
          <h2>{label ?? episode.primaryStatusDescription}</h2>
          <p className="detail-subtitle">Started {formatPlantDateTime(episode.startUtc)} · {completion}</p>
        </div>
        <div className="attempt-summary">
          <span>Return attempts <strong>{episode.returnToProductionAttemptCount}</strong></span>
          <span>Failed attempts <strong>{episode.failedReturnToProductionAttempts}</strong></span>
        </div>
      </section>}
      <section className="panel">
        <div className="section-heading"><div><p className="eyebrow">Exact Radius descriptions preserved</p><h2>Status sequence</h2></div></div>
        <div className="table-wrap">
          <table className="episode-table sequence-table">
            <thead><tr><th>Status</th><th>Event</th><th>Code</th><th>Start</th><th>End</th><th>Duration</th><th>Source</th><th>Return state</th></tr></thead>
            <tbody>
              {displaySegments.map((segment, index) => (
                <tr key={`${segment.startUtc}-${index}`}>
                  <td>{segment.kind === 'offline' ? 'Data unavailable' : segment.statusDescription}</td>
                  <td>{segment.eventType ?? '—'}</td>
                  <td>{segment.statusCode ?? '—'}</td>
                  <td>{formatPlantDateTime(segment.startUtc)}</td>
                  <td>{formatPlantDateTime(segment.endUtc)}</td>
                  <td>{duration(segment.durationSeconds)}</td>
                  <td>{segment.sourceGeneration === 'offline_inference' ? 'Data availability' : segment.sourceGeneration === 'legacy' ? 'Legacy' : segment.sourceGeneration === 'compact' ? 'Compact' : 'Legacy + compact'}</td>
                  <td>{segment.kind === 'radius' && segment.returnToProduction ? <span className={`return-state ${segment.returnToProduction}`}>{segment.returnToProduction}</span> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {episode.confirmedProductionStartUtc && (
          <p className="confirmation-note">Run Production started <strong>{formatPlantDateTime(episode.confirmedProductionStartUtc)}</strong> and confirmation was satisfied <strong>{episode.confirmationSatisfiedUtc ? formatPlantDateTime(episode.confirmationSatisfiedUtc) : 'after five minutes'}</strong>. Trusted episode end remains the production start.</p>
        )}
        {episode.dataInterrupted && <p className="message message--offline">Radius observations stopped. Operational duration ends at the gap start; the display row continues through {episode.displayEndUtc ? formatPlantDateTime(episode.displayEndUtc) : 'the visible unavailable interval'} so the interruption remains explicit.</p>}
        {episode.startedAfterDataGap && <p className="message message--offline">This episode starts with the first trustworthy non-production observation after a data gap; its true earlier start is unknown.</p>}
        {episode.isOpen && <p className="message message--warning">This episode remains open because five continuous minutes of Run Production have not been confirmed.</p>}
      </section>
    </>
  )
}
