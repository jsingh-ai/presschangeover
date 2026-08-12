import { useEffect, useMemo, useState } from 'react'
import { getCuratedPhysicalEvidence, getPressMotion, getPressSpeed, getPressTelemetryCapabilities, getProductionContext } from '../api/process-intelligence-api'
import { formatPlantDateTime } from '../time-ranges'
import type { RadiusPressKey } from '../types/api'
import type { CuratedPhysicalEvidence, PressMotionEvidence, PressSpeedEvidence, PressTelemetryCapabilities, ProductionContextEvidence, SignalCapability } from '../types/evidence'
import { SynchronizedTimeline } from './SynchronizedTimeline'

const TWO_HOURS_MS = 2 * 60 * 60 * 1_000
const CONTEXT_LABELS = { job: 'Job', order: 'Order', recipe: 'Recipe', customer: 'Customer', material: 'Material', roll: 'Roll' } as const

export function boundedEvidenceRange(fromUtc: string, toUtc: string): { fromUtc: string; toUtc: string; focused: boolean } {
  const start = Date.parse(fromUtc)
  const end = Date.parse(toUtc)
  const padding = 10 * 60 * 1_000
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return { fromUtc, toUtc, focused: false }
  const duration = end - start
  if (duration <= TWO_HOURS_MS) {
    const boundedPadding = Math.min(padding, Math.max(0, (TWO_HOURS_MS - duration) / 2))
    return { fromUtc: new Date(start - boundedPadding).toISOString(), toUtc: new Date(end + boundedPadding).toISOString(), focused: false }
  }
  const midpoint = start + (end - start) / 2
  return { fromUtc: new Date(midpoint - TWO_HOURS_MS / 2).toISOString(), toUtc: new Date(midpoint + TWO_HOURS_MS / 2).toISOString(), focused: true }
}

export function capabilityLabel(capability: SignalCapability | undefined): string {
  if (!capability) return 'Unknown capability'
  if (capability.state === 'SUPPORTED') return 'Supported'
  if (capability.state === 'UNSUPPORTED') return 'Unsupported'
  if (capability.state === 'TEMPORARILY_UNAVAILABLE') return capability.lastKnownState ? `Temporarily unavailable · last known ${capability.lastKnownState.toLowerCase()}` : 'Temporarily unavailable'
  return 'Unknown capability'
}

function currentContext(context: ProductionContextEvidence, field: keyof typeof CONTEXT_LABELS): string | undefined {
  const evidence = context.fields[field]
  const latest = evidence.changes.at(-1)
  const value = latest?.value ?? evidence.seed?.value
  return value === undefined ? undefined : String(value)
}

function signalLabel(canonicalId: string, deckNumber: number | null): string {
  const label = canonicalId.replaceAll('.', ' ')
  return `${label}${deckNumber === null ? '' : ` · Deck ${deckNumber}`}`
}

interface PhysicalEvidencePanelProps {
  pressKey: RadiusPressKey
  fromUtc: string
  toUtc: string
}

export function PhysicalEvidencePanel({ pressKey, fromUtc, toUtc }: PhysicalEvidencePanelProps) {
  const range = useMemo(() => boundedEvidenceRange(fromUtc, toUtc), [fromUtc, toUtc])
  const [capabilities, setCapabilities] = useState<PressTelemetryCapabilities>()
  const [speed, setSpeed] = useState<PressSpeedEvidence>()
  const [motion, setMotion] = useState<PressMotionEvidence>()
  const [context, setContext] = useState<ProductionContextEvidence>()
  const [physical, setPhysical] = useState<CuratedPhysicalEvidence>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError(false)
    setCapabilities(undefined)
    setSpeed(undefined)
    setMotion(undefined)
    setContext(undefined)
    setPhysical(undefined)
    void getPressTelemetryCapabilities(pressKey, controller.signal).then(async (result) => {
      if (controller.signal.aborted) return
      setCapabilities(result)
      const supported = (canonicalId: string) => result.capabilities.some((item) => item.canonicalId === canonicalId && item.state === 'SUPPORTED')
      const hasContext = result.capabilities.some((item) => item.canonicalId.startsWith('production.') && item.state === 'SUPPORTED')
      const hasCurated = result.capabilities.some((item) => /^(deck\.|register\.|impression\.|wash\.|pump\.|viscosity\.|ink\.temperature)/.test(item.canonicalId) && item.state === 'SUPPORTED')
      const requests: Promise<void>[] = []
      if (supported('machine.speed.actual')) requests.push(getPressSpeed(pressKey, range.fromUtc, range.toUtc, controller.signal).then(setSpeed))
      if (supported('physical.motion_state')) requests.push(getPressMotion(pressKey, range.fromUtc, range.toUtc, controller.signal).then(setMotion))
      if (hasContext) requests.push(getProductionContext(pressKey, range.fromUtc, range.toUtc, controller.signal).then(setContext))
      if (hasCurated) requests.push(getCuratedPhysicalEvidence(pressKey, { fromUtc: range.fromUtc, toUtc: range.toUtc, categories: ['deck_states', 'register', 'impression', 'wash', 'pump'], representation: 'changes' }, controller.signal).then(setPhysical))
      const results = await Promise.allSettled(requests)
      if (!controller.signal.aborted && results.some(({ status }) => status === 'rejected')) setError(true)
    }).catch((requestError) => {
      if (!controller.signal.aborted && !(requestError instanceof DOMException && requestError.name === 'AbortError')) setError(true)
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [pressKey, range.fromUtc, range.toUtc])

  const speedCapability = capabilities?.capabilities.find(({ canonicalId }) => canonicalId === 'machine.speed.actual')
  const motionCapability = capabilities?.capabilities.find(({ canonicalId }) => canonicalId === 'physical.motion_state')
  const contextValues = context ? (Object.keys(CONTEXT_LABELS) as Array<keyof typeof CONTEXT_LABELS>).map((field) => ({ field, value: currentContext(context, field) })).filter((item): item is { field: keyof typeof CONTEXT_LABELS; value: string } => item.value !== undefined) : []
  const actualSamples = speed?.actual.samples ?? []
  const motionIntervals = motion?.segments.map((segment, index) => ({ id: `motion:${index}:${segment.fromUtc}`, startUtc: segment.fromUtc, endUtc: segment.toUtc, label: segment.state, details: `Physical Motion: ${segment.state}\n${formatPlantDateTime(segment.fromUtc)} – ${formatPlantDateTime(segment.toUtc)}\n${Math.round(segment.durationMs / 1_000)} seconds`, className: `physical-motion physical-motion--${segment.state.toLowerCase()}`, unavailable: segment.state === 'UNKNOWN' })) ?? []

  return <section className="drawer-section physical-evidence" aria-labelledby="physical-evidence-title">
    <div className="section-heading"><div><p className="eyebrow">Independent source</p><h3 id="physical-evidence-title">Physical telemetry evidence</h3><p>Telemetry is shown as independent physical evidence. It does not correct Radius or redefine the ProcessIntelligence classification.</p></div></div>
    {range.focused && <p className="telemetry-range-note">The selected interval exceeds two hours. Physical detail is focused on a bounded two-hour window around its midpoint; Radius evidence above retains the original interval.</p>}
    <p className="quiet-copy">Physical window: {formatPlantDateTime(range.fromUtc)} – {formatPlantDateTime(range.toUtc)} CT</p>
    {loading && <div className="drawer-loading" role="status">Loading bounded telemetry after drawer open…</div>}
    {!loading && !capabilities && <p className="message message--warning">Telemetry capability metadata is temporarily unavailable. Radius and classification evidence remain available.</p>}
    {capabilities && <>
      <dl className="compact-facts evidence-capabilities"><div><dt>Actual Speed</dt><dd>{capabilityLabel(speedCapability)}</dd></div><div><dt>Physical Motion</dt><dd>{capabilityLabel(motionCapability)}</dd></div><div><dt>Telemetry metadata</dt><dd>{capabilities.metadataStatus}</dd></div></dl>
      {(motionIntervals.length > 0 || actualSamples.length > 0) && <SynchronizedTimeline fromUtc={range.fromUtc} toUtc={range.toUtc} ariaLabel={`${capabilities.displayName} physical evidence`} intervalTracks={motionIntervals.length ? [{ id: 'motion', label: 'Physical Motion', intervals: motionIntervals }] : []} numericTracks={[{ id: 'actual-speed', label: 'Actual Speed', samples: actualSamples, unavailableLabel: speedCapability?.state === 'SUPPORTED' ? 'Supported, but no samples were observed in this range' : capabilityLabel(speedCapability) }]} />}
      {speed && <p className="quiet-copy">Actual Speed: {speed.actual.samples.length ? `${speed.actual.samples.length} raw samples` : 'supported but no samples in range'}{speed.actual.sourceUnit ? ` · source metadata reports ${speed.actual.sourceUnit}; values are not converted` : ' · source units are unverified'}</p>}
      {context && <section className="physical-evidence__section"><h4>Job / production context</h4>{contextValues.length ? <dl className="compact-facts">{contextValues.map(({ field, value }) => <div key={field}><dt>{CONTEXT_LABELS[field]}</dt><dd>{value}</dd></div>)}</dl> : <p className="empty-state">Supported context fields have no values in this range.</p>}{context.changes.length > 0 && <ol className="context-change-list">{context.changes.map((change, index) => <li key={`${change.atUtc}:${change.field}:${index}`}><time>{formatPlantDateTime(change.atUtc)} CT</time><strong>{CONTEXT_LABELS[change.field]}</strong><span>{String(change.previousValue)} → {String(change.value)}</span></li>)}</ol>}</section>}
      {physical && <section className="physical-evidence__section"><h4>Supported signal changes</h4>{physical.signals.length ? <ul className="physical-signal-list">{physical.signals.map((signal) => <li key={`${signal.canonicalId}:${signal.deckNumber ?? ''}`}><strong>{signalLabel(signal.canonicalId, signal.deckNumber)}</strong><span>{signal.observationState === 'SUPPORTED_WITH_NO_SAMPLES_IN_RANGE' ? 'Supported, but no changes in range' : `${signal.changes.length} raw code/value change${signal.changes.length === 1 ? '' : 's'}`}</span>{signal.changes.slice(0, 8).map((change, index) => <small key={`${change.observedAtUtc}:${index}`}>{formatPlantDateTime(change.observedAtUtc)} CT · {String(change.previousValue)} → {String(change.value)}</small>)}</li>)}</ul> : <p className="empty-state">No supported deck, register, impression, wash, or pump signals were returned.</p>}</section>}
    </>}
    {error && <p className="message message--warning">Some telemetry evidence could not be loaded. Available Radius evidence and any successful telemetry sections remain visible.</p>}
  </section>
}
