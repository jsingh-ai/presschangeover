import type { OperationalEpisode, RadiusPressEpisodes, RadiusStatusSegment } from '../types/api'
import { formatPlantDateTime } from '../time-ranges'
import { OperationalTimeline } from './OperationalTimeline'

interface PressDetailProps {
  result: RadiusPressEpisodes
  onBack(): void
  onSelectEpisode(episode: OperationalEpisode): void
  onSelectSegment(segment: RadiusStatusSegment): void
  embedded?: boolean
}

function duration(seconds: number): string {
  const rounded = Math.max(0, Math.round(seconds))
  const hours = Math.floor(rounded / 3_600)
  const minutes = Math.floor((rounded % 3_600) / 60)
  const remainingSeconds = rounded % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${remainingSeconds}s`
  return `${remainingSeconds}s`
}

function episodeStatus(episode: OperationalEpisode): string {
  if (episode.completionStatus === 'DATA_INTERRUPTED') return 'Data interrupted'
  if (episode.completionStatus === 'OPEN') return 'Open'
  return 'Closed'
}

export function PressDetail({ result, onBack, onSelectEpisode, onSelectSegment, embedded = false }: PressDetailProps) {
  const lastKnown = result.lastRadiusStatus
    ? `${result.lastRadiusStatus.statusDescription} (Event ${result.lastRadiusStatus.eventType})`
    : 'No Radius observation in the bounded data window'

  return (
    <>
      {!embedded && <button className="text-action" type="button" onClick={onBack}>← Radius overview</button>}
      {!embedded && <section className="detail-heading">
        <div><p className="eyebrow">Press breakdown</p><h2>{result.press.displayName}</h2></div>
        <div className="current-status">
          <span>{result.rangeEndIsLive ? 'Live availability' : 'Availability at range end'}</span>
          <strong>{result.availability === 'online' ? 'Online' : 'Offline'}</strong>
          {result.availability === 'online' ? (
            <small>{result.rangeEndIsLive ? 'Current Radius status' : 'Historical state at range end'}: {result.currentStatusDescription ?? 'No data'}{result.currentEventType ? ` · Event ${result.currentEventType}` : ''}</small>
          ) : (
            <small>Last known Radius status: {lastKnown}</small>
          )}
          <small>Last observation: {result.lastObservationUtc ? formatPlantDateTime(result.lastObservationUtc) : 'Not available'}</small>
          {result.offlineSinceUtc && <small>Offline since: {formatPlantDateTime(result.offlineSinceUtc)}</small>}
        </div>
      </section>}
      {!embedded && <p className="selected-detail-range">
        Selected range: <strong>{formatPlantDateTime(result.fromUtc)} CT</strong> to <strong>{formatPlantDateTime(result.toUtc)} CT</strong>
      </p>}
      {!embedded && <section className="metric-grid metric-grid--detail">
        <div><span>Episodes</span><strong>{result.summary.episodeCount}</strong></div>
        <div><span>Open</span><strong>{result.summary.openEpisodeCount}</strong></div>
        <div><span>Non-production</span><strong>{duration(result.summary.totalNonProductionSeconds)}</strong></div>
        <div><span>Offline</span><strong>{duration(result.summary.offlineSeconds)}</strong></div>
        <div><span>Data coverage</span><strong>{result.summary.dataCoveragePercent.toFixed(1)}%</strong></div>
        <div><span>Longest episode</span><strong>{duration(result.summary.longestEpisodeSeconds)}</strong></div>
      </section>}
      <section className="panel" aria-labelledby="press-timeline-title">
        <div className="section-heading">
          <div><p className="eyebrow">Selected historical range</p><h2 id="press-timeline-title">State timeline</h2></div>
        </div>
        <OperationalTimeline
          press={{
            pressKey: result.press.pressKey,
            displayName: result.press.displayName,
            availability: result.availability,
            currentStatusDescription: result.currentStatusDescription,
            timelineSegments: result.timelineSegments,
            nonProductionSeconds: result.summary.totalNonProductionSeconds,
            dataCoveragePercent: result.summary.dataCoveragePercent,
          }}
          fromUtc={result.fromUtc}
          toUtc={result.toUtc}
          onSelectSegment={onSelectSegment}
        />
      </section>
      <section className="panel">
        <div className="section-heading"><div><p className="eyebrow">Collapsed operational transitions</p><h2>Historical change log</h2></div></div>
        {result.timelineSegments.length === 0 ? (
          <p className="empty-state">No trustworthy Radius states exist in this range.</p>
        ) : (
          <div className="table-wrap">
            <table className="episode-table history-table">
              <thead><tr><th>Start</th><th>State</th><th>Event</th><th>Duration</th><th>Source</th></tr></thead>
              <tbody>
                {result.timelineSegments.map((segment) => (
                  <tr key={`${segment.startUtc}-${segment.endUtc}`}>
                    <td><button type="button" onClick={() => onSelectSegment(segment)}>{formatPlantDateTime(segment.startUtc)}</button></td>
                    <td>{segment.kind === 'offline' ? 'Offline / No Radius Data' : segment.statusDescription}</td>
                    <td>{segment.eventType ?? '—'}</td>
                    <td>{duration(segment.durationSeconds)}</td>
                    <td>{segment.sourceGeneration === 'legacy' ? 'Legacy' : segment.sourceGeneration === 'compact' ? 'Compact' : segment.sourceGeneration === 'hybrid' ? 'Legacy + compact' : 'Offline inference'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {!embedded && <section className="panel">
        <div className="section-heading"><div><p className="eyebrow">Derived from Radius</p><h2>Operational episodes</h2></div></div>
        {result.episodes.length === 0 ? (
          <p className="empty-state">No observed non-production episodes occurred in this range.</p>
        ) : (
          <div className="table-wrap">
            <table className="episode-table">
              <thead><tr><th>Episode</th><th>Start</th><th>End</th><th>Duration</th><th>Main reason</th><th>Status</th></tr></thead>
              <tbody>
                {result.episodes.map((episode) => (
                  <tr key={episode.episodeId}>
                    <td><button type="button" onClick={() => onSelectEpisode(episode)}>{result.analysis.episodeProfiles.find(({ episodeId }) => episodeId === episode.episodeId)?.descriptor ?? episode.primaryStatusDescription}</button></td>
                    <td>{formatPlantDateTime(episode.startUtc)}{episode.startedBeforeRange && <small>Carry-in</small>}{episode.startedAfterDataGap && <small>Started after data gap</small>}</td>
                    <td>{episode.endUtc ? formatPlantDateTime(episode.endUtc) : '—'}</td>
                    <td>{duration(episode.durationSeconds)}</td>
                    <td>{episode.primaryStatusDescription}</td>
                    <td><span className={`state-pill ${episode.completionStatus.toLowerCase()}`}>{episodeStatus(episode)}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>}
    </>
  )
}
