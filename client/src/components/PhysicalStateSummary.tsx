import type {
  PhysicalState,
  PhysicalStateResponse,
  TelemetrySource,
} from '../types/api'

interface PhysicalStateSummaryProps {
  source: TelemetrySource
  result?: PhysicalStateResponse
  loading: boolean
  error?: string
  onLoad(): void
}

const STATES: PhysicalState[] = [
  'RUNNING',
  'STOPPED',
  'TRANSITION',
  'UNKNOWN',
]

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1_000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}m ${seconds.toString().padStart(2, '0')}s`
}

export function PhysicalStateSummary({
  source,
  result,
  loading,
  error,
  onLoad,
}: PhysicalStateSummaryProps) {
  return (
    <section className="panel" aria-labelledby="physical-state-title">
      <div className="section-heading action-heading">
        <div>
          <p className="eyebrow">Selected press</p>
          <h2 id="physical-state-title">{source.displayName}</h2>
          <span className="source-key">{source.sourceKey}</span>
        </div>
        <button
          className="primary-action"
          type="button"
          disabled={loading || !source.enabled}
          onClick={onLoad}
        >
          {loading ? 'Loading…' : 'Load last 30 minutes'}
        </button>
      </div>

      {error && <p className="message message--error">{error}</p>}
      {!result && !error && !loading && (
        <p className="muted">
          Request a recent physical-state summary through the local API.
        </p>
      )}
      {result && (
        <>
          <div className="summary-grid">
            {STATES.map((state) => (
              <div className="summary-item" key={state}>
                <span>{state}</span>
                <strong>
                  {formatDuration(result.summary.durationsMs[state])}
                </strong>
              </div>
            ))}
            <div className="summary-item">
              <span>SEGMENTS</span>
              <strong>{result.summary.segmentCount}</strong>
            </div>
          </div>
          {result.segments.length === 0 && (
            <p className="muted">No physical-state segments in this range.</p>
          )}
        </>
      )}
    </section>
  )
}
