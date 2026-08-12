import { useState } from 'react'
import { formatPlantDateTime } from '../time-ranges'
import type { RadiusPressKey } from '../types/api'
import type { ProductionContextEvidence, SignalCapability } from '../types/evidence'
import { SynchronizedTimeline } from './SynchronizedTimeline'
import { actualSpeedTrack, boundedEvidenceRange, CONTEXT_LABELS, contextDisplayValue, contextEventTrack, contextIntervalTracks, motionIntervalTrack, physicalEventTrack, usePressTelemetryEvidence, type PressTelemetryEvidenceState } from './TelemetryEvidenceTimeline'

export { boundedEvidenceRange }

function currentContext(context: ProductionContextEvidence, field: keyof typeof CONTEXT_LABELS): string | undefined {
  const evidence = context.fields[field]
  const value = evidence.changes.at(-1)?.value ?? evidence.seed?.value
  return value === undefined ? undefined : contextDisplayValue(value).label
}

function signalLabel(canonicalId: string, deckNumber: number | null): string {
  const label = canonicalId.replaceAll('.', ' ')
  return `${label}${deckNumber === null ? '' : ` · Deck ${deckNumber}`}`
}

export function capabilityLabel(capability: SignalCapability | undefined): string {
  if (!capability) return 'Unknown capability'
  if (capability.state === 'SUPPORTED') return 'Supported'
  if (capability.state === 'UNSUPPORTED') return 'Unsupported'
  if (capability.state === 'TEMPORARILY_UNAVAILABLE') return capability.lastKnownState ? `Temporarily unavailable · last known ${capability.lastKnownState.toLowerCase()}` : 'Temporarily unavailable'
  return 'Unknown capability'
}

interface PhysicalEvidencePanelProps {
  pressKey: RadiusPressKey
  fromUtc: string
  toUtc: string
  evidence?: PressTelemetryEvidenceState
  showTimeline?: boolean
}

export function PhysicalEvidencePanel({ pressKey, fromUtc, toUtc, evidence, showTimeline = true }: PhysicalEvidencePanelProps) {
  const loaded = usePressTelemetryEvidence(pressKey, fromUtc, toUtc, { enabled: !evidence })
  const resolved = evidence ?? loaded
  const { range, capabilities, speed, motion, context, physical, loading, error } = resolved
  const [expandedSignals, setExpandedSignals] = useState<Set<string>>(() => new Set())
  const speedCapability = capabilities?.capabilities.find(({ canonicalId }) => canonicalId === 'machine.speed.actual')
  const motionCapability = capabilities?.capabilities.find(({ canonicalId }) => canonicalId === 'physical.motion_state')
  const contextValues = context ? (Object.keys(CONTEXT_LABELS) as Array<keyof typeof CONTEXT_LABELS>).map((field) => ({ field, value: currentContext(context, field) })).filter((item): item is { field: keyof typeof CONTEXT_LABELS; value: string } => item.value !== undefined) : []
  const motionTrack = motionIntervalTrack(motion, motionCapability)
  const speedTrack = actualSpeedTrack(speed, speedCapability)
  const contextEvents = contextEventTrack(context)
  const physicalEvents = physicalEventTrack(physical)
  const changedSignals = physical?.signals.filter(({ changes }) => changes.length > 0) ?? []

  return <section className="drawer-section physical-evidence" aria-labelledby="physical-evidence-title">
    <div className="section-heading"><div><p className="eyebrow">Independent source</p><h3 id="physical-evidence-title">Physical telemetry evidence</h3><p>Telemetry is shown as independent physical evidence. It does not correct Radius or redefine the ProcessIntelligence classification.</p></div></div>
    {range.focused && <p className="telemetry-range-note">The selected interval exceeds two hours. Physical detail is focused on the identified two-hour midpoint window; Radius evidence retains the original interval.</p>}
    <p className="quiet-copy">Physical window: {formatPlantDateTime(range.fromUtc)} – {formatPlantDateTime(range.toUtc)} CT</p>
    {loading && <div className="drawer-loading" role="status">Loading bounded telemetry…</div>}
    {!loading && !capabilities && <p className="message message--warning">Telemetry capability metadata is temporarily unavailable. Radius and classification evidence remain available.</p>}
    {capabilities && <>
      <dl className="compact-facts evidence-capabilities"><div><dt>Actual Speed</dt><dd>{capabilityLabel(speedCapability)}</dd></div><div><dt>Physical Motion</dt><dd>{capabilityLabel(motionCapability)}</dd></div><div><dt>Telemetry metadata</dt><dd>{capabilities.metadataStatus}</dd></div></dl>
      {showTimeline && <SynchronizedTimeline fromUtc={range.fromUtc} toUtc={range.toUtc} ariaLabel={`${capabilities.displayName} synchronized physical evidence`} intervalTracks={[...contextIntervalTracks(context), ...(motionTrack ? [motionTrack] : [])]} numericTracks={speedTrack ? [speedTrack] : []} eventTracks={[contextEvents, physicalEvents].filter((track): track is NonNullable<typeof track> => Boolean(track))} />}
      {speed && <p className="quiet-copy">Actual Speed: {speed.actual.samples.length ? `${speed.actual.samples.length} raw samples` : 'supported but no samples in range'}{speed.actual.sourceUnit ? ` · source metadata reports ${speed.actual.sourceUnit}; values are not converted` : ' · source units are unverified'}</p>}
      {context && <section className="physical-evidence__section"><h4>Job / production context</h4>{contextValues.length ? <dl className="compact-facts">{contextValues.map(({ field, value }) => <div key={field}><dt>{CONTEXT_LABELS[field]}</dt><dd>{value}</dd></div>)}</dl> : <p className="empty-state">Supported context fields have no values in this range.</p>}{context.changes.length > 0 && <ol className="context-change-list">{context.changes.map((change, index) => <li key={`${change.atUtc}:${change.field}:${index}`}><time>{formatPlantDateTime(change.atUtc)} CT</time><strong>{CONTEXT_LABELS[change.field]}</strong><span>{String(change.previousValue)} → {String(change.value)}</span></li>)}</ol>}</section>}
      {physical && <section className="physical-evidence__section"><h4>Observed signal changes</h4>{changedSignals.length ? <ul className="physical-signal-list">{changedSignals.map((signal) => {
        const key = `${signal.canonicalId}:${signal.deckNumber ?? ''}`
        const expanded = expandedSignals.has(key)
        const visible = expanded ? signal.changes : signal.changes.slice(0, 8)
        return <li key={key}><strong>{signalLabel(signal.canonicalId, signal.deckNumber)}</strong><span>{signal.observationState === 'SUPPORTED_WITH_NO_SAMPLES_IN_RANGE' ? 'Supported, but no changes in range' : signal.changes.length > 8 && !expanded ? `8 of ${signal.changes.length} changes shown` : `${signal.changes.length} raw code/value change${signal.changes.length === 1 ? '' : 's'} shown`}</span>{visible.map((change, index) => <small key={`${change.observedAtUtc}:${index}`}>{formatPlantDateTime(change.observedAtUtc)} CT · {String(change.previousValue)} → {String(change.value)}</small>)}{signal.changes.length > 8 && <button type="button" className="secondary-action" onClick={() => setExpandedSignals((current) => { const next = new Set(current); if (expanded) next.delete(key); else next.add(key); return next })}>{expanded ? 'Show first 8 changes' : `Show all ${signal.changes.length} changes`}</button>}</li>
      })}</ul> : <p className="empty-state">No deck, register, impression, wash, or pump changes were observed in this range.</p>}</section>}
    </>}
    {error && <p className="message message--warning">Some telemetry evidence could not be loaded. Available Radius evidence and successful telemetry sections remain visible.</p>}
  </section>
}
