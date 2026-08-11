import type { ServiceStatus } from '../types/api'

interface StatusItem {
  label: string
  status: ServiceStatus
  detail?: string
}

interface SystemStatusProps {
  items: StatusItem[]
}

const STATUS_LABELS: Record<ServiceStatus, string> = {
  loading: 'Checking',
  healthy: 'Healthy',
  unavailable: 'Unavailable',
}

export function SystemStatus({ items }: SystemStatusProps) {
  return (
    <section className="panel" aria-labelledby="system-status-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Connectivity</p>
          <h2 id="system-status-title">System status</h2>
        </div>
      </div>
      <div className="status-grid">
        {items.map((item) => (
          <div className="status-card" key={item.label}>
            <span
              className={`status-indicator status-indicator--${item.status}`}
              aria-hidden="true"
            />
            <div>
              <strong>{item.label}</strong>
              <span>{STATUS_LABELS[item.status]}</span>
              {item.detail && <small>{item.detail}</small>}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
