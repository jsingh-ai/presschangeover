import { useEffect, useMemo, useState } from 'react'
import { getCuratedPhysicalEvidence, getPressMotion, getPressSpeed, getPressTelemetryCapabilities, getProductionContext } from '../api/process-intelligence-api'
import { formatPlantDateTime } from '../time-ranges'
import type { RadiusPressKey } from '../types/api'
import type { CuratedPhysicalEvidence, PhysicalEvidenceCategory, PressMotionEvidence, PressSpeedEvidence, PressTelemetryCapabilities, ProductionContextEvidence, ProductionContextField, SemanticSignalEvidence, SignalCapability, TelemetryChange } from '../types/evidence'
import type { TimelineEvent, TimelineEventTrack, TimelineIntervalTrack, TimelineNumericTrack } from './SynchronizedTimeline'

const TWO_HOURS_MS = 2 * 60 * 60 * 1_000
export const CONTEXT_LABELS: Record<ProductionContextField, string> = { job: 'Job', order: 'Order', recipe: 'Recipe', customer: 'Customer', material: 'Material', roll: 'Roll' }

export interface BoundedEvidenceRange { fromUtc: string; toUtc: string; focused: boolean }

export function boundedEvidenceRange(fromUtc: string, toUtc: string, padShortRange = true): BoundedEvidenceRange {
  const start = Date.parse(fromUtc)
  const end = Date.parse(toUtc)
  const padding = 10 * 60 * 1_000
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return { fromUtc, toUtc, focused: false }
  const duration = end - start
  if (duration <= TWO_HOURS_MS) {
    const boundedPadding = padShortRange ? Math.min(padding, Math.max(0, (TWO_HOURS_MS - duration) / 2)) : 0
    return { fromUtc: new Date(start - boundedPadding).toISOString(), toUtc: new Date(end + boundedPadding).toISOString(), focused: false }
  }
  const midpoint = start + duration / 2
  return { fromUtc: new Date(midpoint - TWO_HOURS_MS / 2).toISOString(), toUtc: new Date(midpoint + TWO_HOURS_MS / 2).toISOString(), focused: true }
}

export function curatedCategoriesForCapabilities(capabilities: SignalCapability[]): PhysicalEvidenceCategory[] {
  const supported = new Set(capabilities.filter(({ state }) => state === 'SUPPORTED').map(({ canonicalId }) => canonicalId))
  const categories: PhysicalEvidenceCategory[] = []
  if (['deck.active', 'deck.print_on', 'deck.print_off'].some((id) => supported.has(id))) categories.push('deck_states')
  if ([...supported].some((id) => id.startsWith('register.'))) categories.push('register')
  if ([...supported].some((id) => id.startsWith('impression.'))) categories.push('impression')
  if (supported.has('ink.washup.state')) categories.push('wash')
  if (supported.has('ink.pump.status')) categories.push('pump')
  return categories
}

export interface PressTelemetryEvidenceState {
  range: BoundedEvidenceRange
  capabilities?: PressTelemetryCapabilities
  context?: ProductionContextEvidence
  motion?: PressMotionEvidence
  speed?: PressSpeedEvidence
  physical?: CuratedPhysicalEvidence
  loading: boolean
  error: boolean
}

interface StoredEvidence extends Omit<PressTelemetryEvidenceState, 'range'> { key: string }

export function usePressTelemetryEvidence(pressKey: RadiusPressKey | undefined, fromUtc: string, toUtc: string, options: { enabled?: boolean; padShortRange?: boolean } = {}): PressTelemetryEvidenceState {
  const enabled = options.enabled ?? true
  const range = useMemo(() => boundedEvidenceRange(fromUtc, toUtc, options.padShortRange ?? true), [fromUtc, toUtc, options.padShortRange])
  const key = `${pressKey ?? ''}:${range.fromUtc}:${range.toUtc}`
  const [stored, setStored] = useState<StoredEvidence>({ key: '', loading: false, error: false })

  useEffect(() => {
    if (!enabled || !pressKey) return
    const controller = new AbortController()
    setStored({ key, loading: true, error: false })
    void getPressTelemetryCapabilities(pressKey, controller.signal).then(async (capabilities) => {
      const next: StoredEvidence = { key, capabilities, loading: true, error: false }
      const supported = (canonicalId: string) => capabilities.capabilities.some((item) => item.canonicalId === canonicalId && item.state === 'SUPPORTED')
      const requests: Promise<void>[] = []
      if (supported('machine.speed.actual')) requests.push(getPressSpeed(pressKey, range.fromUtc, range.toUtc, controller.signal).then((value) => { next.speed = value }))
      if (supported('physical.motion_state')) requests.push(getPressMotion(pressKey, range.fromUtc, range.toUtc, controller.signal).then((value) => { next.motion = value }))
      if (capabilities.capabilities.some((item) => item.canonicalId.startsWith('production.') && item.state === 'SUPPORTED')) requests.push(getProductionContext(pressKey, range.fromUtc, range.toUtc, controller.signal).then((value) => { next.context = value }))
      const categories = curatedCategoriesForCapabilities(capabilities.capabilities)
      if (categories.length) requests.push(getCuratedPhysicalEvidence(pressKey, { fromUtc: range.fromUtc, toUtc: range.toUtc, includeSeed: false, categories, representation: 'changes' }, controller.signal).then((value) => { next.physical = value }))
      const results = await Promise.allSettled(requests)
      if (!controller.signal.aborted) setStored({ ...next, loading: false, error: results.some(({ status }) => status === 'rejected') })
    }).catch((error) => {
      if (!controller.signal.aborted && !(error instanceof DOMException && error.name === 'AbortError')) setStored({ key, loading: false, error: true })
    })
    return () => controller.abort()
  }, [enabled, pressKey, range.fromUtc, range.toUtc, key])

  if (!enabled || stored.key !== key) return { range, loading: enabled && Boolean(pressKey), error: false }
  return { range, capabilities: stored.capabilities, context: stored.context, motion: stored.motion, speed: stored.speed, physical: stored.physical, loading: stored.loading, error: stored.error }
}

export function contextIntervalTracks(context?: ProductionContextEvidence): TimelineIntervalTrack[] {
  if (!context) return []
  const end = Date.parse(context.toUtc)
  return (Object.keys(CONTEXT_LABELS) as ProductionContextField[]).map((field) => {
    const evidence = context.fields[field]
    const values = [
      ...(evidence.seed ? [{ atUtc: context.fromUtc, value: evidence.seed.value }] : []),
      ...evidence.changes.map((change) => ({ atUtc: change.observedAtUtc, value: change.value })),
    ].sort((left, right) => Date.parse(left.atUtc) - Date.parse(right.atUtc))
    return { id: `context-${field}`, label: CONTEXT_LABELS[field], unavailableLabel: evidence.capabilityState === 'UNSUPPORTED' ? 'Unsupported for this press' : evidence.capabilityState === 'SUPPORTED' ? 'Supported, but no value observed in this range' : 'Capability unknown or temporarily unavailable', intervals: values.map((value, index) => ({
      id: `context:${field}:${value.atUtc}:${index}`,
      startUtc: value.atUtc,
      endUtc: new Date(Math.max(Date.parse(value.atUtc) + 1_000, Math.min(end, Date.parse(values[index + 1]?.atUtc ?? context.toUtc)))).toISOString(),
      label: String(value.value),
      details: `${CONTEXT_LABELS[field]} context: ${String(value.value)}\nObserved from ${formatPlantDateTime(value.atUtc)} CT`,
      className: 'context-timeline-value',
    })) }
  })
}

export function contextEventTrack(context?: ProductionContextEvidence): TimelineEventTrack | undefined {
  if (!context) return undefined
  return {
    id: 'context-changes', label: 'Context changes', unavailableLabel: 'No context changes observed in this range',
    events: context.changes.map((change, index) => ({
      id: `context-event:${change.field}:${change.atUtc}:${index}`,
      atUtc: change.atUtc,
      category: 'context',
      label: `${CONTEXT_LABELS[change.field]} changed`,
      detail: `${String(change.previousValue)} → ${String(change.value)}. Observed ${formatPlantDateTime(change.atUtc)} CT`,
    })),
  }
}

export function motionIntervalTrack(motion?: PressMotionEvidence, capability?: SignalCapability): TimelineIntervalTrack | undefined {
  if (!motion && !capability) return undefined
  return {
    id: 'motion', label: 'Physical Motion', unavailableLabel: capability?.state === 'UNSUPPORTED' ? 'Unsupported for this press' : capability?.state === 'SUPPORTED' ? 'Supported, but no physical state observed in this range' : 'Capability unknown or temporarily unavailable', intervals: (motion?.segments ?? []).map((segment, index) => ({
      id: `motion:${index}:${segment.fromUtc}`, startUtc: segment.fromUtc, endUtc: segment.toUtc, label: segment.state,
      details: `Physical Motion: ${segment.state}\n${formatPlantDateTime(segment.fromUtc)} – ${formatPlantDateTime(segment.toUtc)} CT\n${Math.round(segment.durationMs / 1_000)} seconds`,
      className: `physical-motion physical-motion--${segment.state.toLowerCase()}`, unavailable: segment.state === 'UNKNOWN',
    })),
  }
}

export function actualSpeedTrack(speed: PressSpeedEvidence | undefined, capability?: SignalCapability): TimelineNumericTrack | undefined {
  if (!speed && !capability) return undefined
  return {
    id: 'actual-speed', label: 'Actual Speed', samples: speed?.actual.samples ?? [], unit: speed?.actual.sourceUnit,
    unavailableLabel: capability?.state === 'SUPPORTED' ? 'Supported, but no samples observed in this range' : capability?.state === 'UNSUPPORTED' ? 'Unsupported for this press' : 'Capability unknown or temporarily unavailable',
  }
}

function signalCategory(canonicalId: string): string {
  if (canonicalId.startsWith('deck.')) return 'deck'
  if (canonicalId.startsWith('register.')) return 'register'
  if (canonicalId.startsWith('impression.')) return 'impression'
  if (canonicalId === 'ink.washup.state') return 'wash'
  if (canonicalId === 'ink.pump.status') return 'pump'
  return 'physical'
}

export function physicalChangeLabel(signal: SemanticSignalEvidence, change: TelemetryChange): string {
  const deck = signal.deckNumber === null ? '' : `Deck ${signal.deckNumber} `
  if (signal.canonicalId === 'deck.active') return `${deck}active signal ${String(change.previousValue)} → ${String(change.value)}`
  if (signal.canonicalId === 'deck.print_on') return `${deck}print-on signal ${String(change.previousValue)} → ${String(change.value)}`
  if (signal.canonicalId === 'deck.print_off') return `${deck}print-off signal ${String(change.previousValue)} → ${String(change.value)}`
  if (signal.canonicalId === 'ink.washup.state') return `Wash-state code ${String(change.previousValue)} → ${String(change.value)}`
  if (signal.canonicalId === 'ink.pump.status') return `Pump-state code ${String(change.previousValue)} → ${String(change.value)}`
  if (signal.canonicalId.startsWith('register.')) return `${deck}register signal ${String(change.previousValue)} → ${String(change.value)}`
  if (signal.canonicalId.startsWith('impression.')) return `${deck}impression signal ${String(change.previousValue)} → ${String(change.value)}`
  return `${signal.canonicalId} signal ${String(change.previousValue)} → ${String(change.value)}`
}

export function physicalEventTrack(physical?: CuratedPhysicalEvidence): TimelineEventTrack | undefined {
  if (!physical) return undefined
  const events: TimelineEvent[] = physical.signals.flatMap((signal) => signal.changes.map((change, index) => ({
    id: `physical-event:${signal.canonicalId}:${signal.deckNumber ?? ''}:${change.observedAtUtc}:${index}`,
    atUtc: change.observedAtUtc,
    category: signalCategory(signal.canonicalId),
    deckNumber: signal.deckNumber,
    label: physicalChangeLabel(signal, change),
    detail: `${signal.canonicalId}. Raw telemetry change observed ${formatPlantDateTime(change.observedAtUtc)} CT`,
  })))
  return events.length ? { id: 'physical-events', label: 'Physical Events', events } : undefined
}

export function telemetrySummary(evidence: PressTelemetryEvidenceState) {
  const speedSamples = evidence.speed?.actual.samples ?? []
  const speedValues = speedSamples.map(({ value }) => value)
  return {
    availability: evidence.loading ? 'Loading' : evidence.error && !evidence.capabilities ? 'Unavailable' : evidence.error ? 'Partially available' : evidence.capabilities ? 'Available' : 'Not requested',
    motionChanges: Math.max(0, (evidence.motion?.segments.length ?? 0) - 1),
    speedSamples: speedSamples.length,
    speedMinimum: speedValues.length ? Math.min(...speedValues) : null,
    speedMaximum: speedValues.length ? Math.max(...speedValues) : null,
    contextChanges: evidence.context?.changes.length ?? 0,
    physicalChanges: evidence.physical?.signals.reduce((sum, signal) => sum + signal.changes.length, 0) ?? 0,
  }
}
