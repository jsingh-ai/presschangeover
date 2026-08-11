import type { TelemetrySource } from '../types/api'

interface PressListProps {
  sources: TelemetrySource[]
  selectedId?: number
  loading: boolean
  onSelect(source: TelemetrySource): void
}

export function PressList({
  sources,
  selectedId,
  loading,
  onSelect,
}: PressListProps) {
  return (
    <section className="panel" aria-labelledby="press-sources-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Telemetry sources</p>
          <h2 id="press-sources-title">Presses</h2>
        </div>
        {!loading && <span className="count-badge">{sources.length}</span>}
      </div>

      {loading && <p className="muted">Loading press sources…</p>}
      {!loading && sources.length === 0 && (
        <p className="muted">No telemetry sources are currently available.</p>
      )}
      <div className="press-grid">
        {sources.map((source) => (
          <button
            className={`press-card${selectedId === source.id ? ' press-card--selected' : ''}`}
            key={source.id}
            type="button"
            onClick={() => onSelect(source)}
          >
            <span>
              <strong>{source.displayName}</strong>
              <small>{source.sourceKey}</small>
            </span>
            <span className={source.enabled ? 'enabled' : 'disabled'}>
              {source.enabled ? 'Enabled' : 'Disabled'}
            </span>
          </button>
        ))}
      </div>
    </section>
  )
}
