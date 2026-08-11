import type { RadiusStatusSegment } from '../types/api'
import { formatPlantDateTime } from '../time-ranges'

interface SegmentDetailProps {
  segment: RadiusStatusSegment
  onBack?(): void
  embedded?: boolean
}

function duration(seconds: number): string {
  const rounded = Math.max(0, Math.round(seconds))
  const hours = Math.floor(rounded / 3_600)
  const minutes = Math.floor((rounded % 3_600) / 60)
  const remainingSeconds = rounded % 60
  if (hours > 0) return `${hours}h ${minutes}m ${remainingSeconds}s`
  if (minutes > 0) return `${minutes}m ${remainingSeconds}s`
  return `${remainingSeconds}s`
}

function sourceLabel(segment: RadiusStatusSegment): string {
  switch (segment.sourceGeneration) {
    case 'legacy': return 'Legacy Radius history'
    case 'compact': return 'Compact Radius event history'
    case 'hybrid': return 'Legacy and compact Radius history'
    case 'offline_inference': return 'Inferred from collector heartbeat gap'
  }
}

export function SegmentDetail({ segment, onBack, embedded = false }: SegmentDetailProps) {
  const classification = segment.kind === 'offline'
    ? 'Data unavailable · machine state unknown'
    : segment.classification?.operationalGroupName ?? 'Administrative & Unknown'
  const status = segment.kind === 'offline'
    ? 'Offline / No Radius Data'
    : segment.statusDescription

  return (
    <>
      {!embedded && onBack && <button className="text-action" type="button" onClick={onBack}>← {segment.displayName} history</button>}
      {!embedded && <section
        className="detail-heading segment-detail-heading"
        data-press-key={segment.pressKey}
        data-start-utc={segment.startUtc}
        data-end-utc={segment.endUtc}
      >
        <div>
          <p className="eyebrow">Historical Radius segment</p>
          <h2>{status}</h2>
          <p className="detail-subtitle">{segment.displayName} · {classification}</p>
        </div>
        <div className="attempt-summary">
          <span>Start <strong>{formatPlantDateTime(segment.startUtc)} CT</strong></span>
          <span>End <strong>{formatPlantDateTime(segment.endUtc)} CT</strong></span>
        </div>
      </section>}
      <section className="panel segment-detail-grid" aria-label="Historical segment details">
        <div><span>Duration</span><strong>{duration(segment.durationSeconds)}</strong></div>
        <div><span>Event type</span><strong>{segment.eventType ?? '—'}</strong></div>
        <div><span>Status code</span><strong>{segment.statusCode ?? '—'}</strong></div>
        <div><span>Classification</span><strong>{classification}</strong></div>
        {segment.kind === 'radius' && <><div><span>Exact Radius identity</span><strong>{segment.eventType} / {segment.statusCode ?? '—'} / {segment.statusDescription || '(empty)'}</strong></div><div><span>Process family</span><strong>{segment.classification?.processFamilyName ?? 'Unknown'}</strong></div><div><span>Mapping confidence</span><strong>{segment.classification?.isFallback ? 'Unmapped fallback · review required' : `${segment.classification?.confidence ?? 'LOW'}${segment.classification?.needsReview ? ' · needs review' : ''}`}</strong></div><div><span>Mapping version</span><strong>{segment.classification?.mappingVersion ? `v${segment.classification.mappingVersion}` : 'Seed fallback'}</strong></div></>}
        <div><span>Interval coverage</span><strong>{segment.kind === 'offline' ? '0%' : '100%'}</strong></div>
        <div><span>Storage source</span><strong>{sourceLabel(segment)}</strong></div>
      </section>
      <p className="message">
        Exact interval available for future telemetry correlation: {segment.pressKey}, {segment.startUtc} to {segment.endUtc}.
      </p>
    </>
  )
}
