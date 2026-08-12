import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { getCuratedPhysicalEvidence, getPressMotion, getPressSpeed, getPressTelemetryCapabilities, getProductionContext } from '../api/process-intelligence-api'
import { formatPlantDateTime } from '../time-ranges'
import type { RadiusPressKey } from '../types/api'
import type { ContextChange, CuratedPhysicalEvidence, PhysicalEvidenceCategory, PressMotionEvidence, PressSpeedEvidence, PressTelemetryCapabilities, ProductionContextEvidence, ProductionContextField, SemanticSignalEvidence, SignalCapability, SpeedSignalEvidence, TelemetryChange, TimedNumericSample, TimedStateInterval, TimedTelemetryValue } from '../types/evidence'
import type { TimelineEvent, TimelineEventTrack, TimelineIntervalTrack, TimelineNumericTrack } from './SynchronizedTimeline'

const TWO_HOURS_MS = 2 * 60 * 60 * 1_000
export const MAX_FULL_TELEMETRY_RANGE_MS = 24 * 60 * 60 * 1_000
export const CONTEXT_LABELS: Record<ProductionContextField, string> = { job: 'Job', order: 'Order', recipe: 'Recipe', customer: 'Customer', material: 'Material', roll: 'Roll' }
export const VISIBLE_CONTEXT_FIELDS = ['order', 'recipe', 'customer', 'material', 'roll'] as const satisfies readonly ProductionContextField[]
type VisibleContextField = (typeof VISIBLE_CONTEXT_FIELDS)[number]

const CONTEXT_BASE_HUES: Record<VisibleContextField, number> = { order: 212, recipe: 276, customer: 26, material: 162, roll: 332 }
const CONTEXT_COLOR_VARIANTS = [
  { hue: 0, saturation: 68, lightness: 38 },
  { hue: 18, saturation: 72, lightness: 46 },
  { hue: -15, saturation: 60, lightness: 34 },
  { hue: 32, saturation: 75, lightness: 40 },
  { hue: -28, saturation: 65, lightness: 47 },
] as const

export function contextIntervalStyle(field: VisibleContextField, variant: number): CSSProperties {
  const color = CONTEXT_COLOR_VARIANTS[variant % CONTEXT_COLOR_VARIANTS.length]!
  const hue = (CONTEXT_BASE_HUES[field] + color.hue + 360) % 360
  return {
    background: `hsl(${hue} ${color.saturation}% ${color.lightness}%)`,
    color: color.lightness >= 46 ? '#14202b' : '#fff',
  }
}

export function contextDisplayValue(value: unknown): { label: string; usable: boolean } {
  const raw = String(value ?? '')
  if (!raw.trim()) return { label: 'Blank source value', usable: false }
  if (/^\[\s*0(?:\s*,\s*0)*\s*\]$/.test(raw)) return { label: 'No usable source value', usable: false }
  return { label: raw, usable: true }
}

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

interface EvidenceChunk { fromUtc: string; toUtc: string }
interface ChunkEvidence {
  context?: ProductionContextEvidence
  motion?: PressMotionEvidence
  speed?: PressSpeedEvidence
  physical?: CuratedPhysicalEvidence
  error: boolean
}

export function telemetryEvidenceChunks(fromUtc: string, toUtc: string): EvidenceChunk[] {
  const from = Date.parse(fromUtc)
  const to = Date.parse(toUtc)
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return []
  const chunks: EvidenceChunk[] = []
  let cursor = from
  while (cursor < to) {
    const nextBoundary = (Math.floor(cursor / TWO_HOURS_MS) + 1) * TWO_HOURS_MS
    const chunkEnd = Math.min(to, nextBoundary)
    chunks.push({ fromUtc: new Date(cursor).toISOString(), toUtc: new Date(chunkEnd).toISOString() })
    cursor = chunkEnd
  }
  return chunks
}

function uniqueBy<T>(items: T[], identity: (item: T) => string): T[] {
  return [...new Map(items.map((item) => [identity(item), item])).values()]
}

function timedIdentity(item: TimedTelemetryValue): string {
  return `${item.observedAtUtc}:${item.valueKind}:${String(item.value)}`
}

function changeIdentity(item: TelemetryChange): string {
  return `${timedIdentity(item)}:${item.previousValueKind}:${String(item.previousValue)}`
}

function mergeSpeedSignal(signals: SpeedSignalEvidence[]): SpeedSignalEvidence | undefined {
  const first = signals[0]
  if (!first) return undefined
  const samples = uniqueBy(signals.flatMap(({ samples }) => samples), timedIdentity).sort((left, right) => Date.parse(left.observedAtUtc) - Date.parse(right.observedAtUtc)) as TimedNumericSample[]
  return { ...first, observationState: samples.length ? 'SUPPORTED_WITH_OBSERVATIONS' : 'SUPPORTED_WITH_NO_SAMPLES_IN_RANGE', samples }
}

function mergeMotionSegments(evidence: PressMotionEvidence[]): TimedStateInterval[] {
  const merged: TimedStateInterval[] = []
  for (const chunk of evidence.sort((left, right) => Date.parse(left.fromUtc) - Date.parse(right.fromUtc))) {
    const segments = [...chunk.segments].sort((left, right) => Date.parse(left.fromUtc) - Date.parse(right.fromUtc))
    const previous = merged.at(-1)
    const warmup = segments[0]
    const resolved = segments[1]
    if (previous && warmup?.state === 'TRANSITION' && warmup.fromUtc === chunk.fromUtc && warmup.toUtc === resolved?.fromUtc && previous.toUtc === warmup.fromUtc && previous.state === resolved.state && warmup.reason?.startsWith('DEBOUNCE_')) {
      previous.toUtc = warmup.toUtc
      previous.durationMs += warmup.durationMs
      previous.durationSeconds = previous.durationMs / 1_000
      segments.shift()
    }
    for (const segment of segments) {
      const prior = merged.at(-1)
      if (prior && prior.state === segment.state && prior.toUtc === segment.fromUtc) {
        prior.toUtc = segment.toUtc
        prior.durationMs += segment.durationMs
        prior.durationSeconds = prior.durationMs / 1_000
      } else {
        merged.push({ ...segment })
      }
    }
  }
  return merged
}

export function mergeTelemetryEvidenceChunks(chunks: ChunkEvidence[], fromUtc: string, toUtc: string): Pick<PressTelemetryEvidenceState, 'context' | 'motion' | 'speed' | 'physical'> {
  const contexts = chunks.flatMap(({ context }) => context ? [context] : [])
  const speeds = chunks.flatMap(({ speed }) => speed ? [speed] : [])
  const motions = chunks.flatMap(({ motion }) => motion ? [motion] : [])
  const physicalEvidence = chunks.flatMap(({ physical }) => physical ? [physical] : [])
  const result: Pick<PressTelemetryEvidenceState, 'context' | 'motion' | 'speed' | 'physical'> = {}

  if (contexts.length) {
    const first = contexts[0]!
    const fields = Object.fromEntries((Object.keys(CONTEXT_LABELS) as ProductionContextField[]).map((field) => {
      const entries = contexts.map(({ fields }) => fields[field])
      const base = entries[0]!
      const changes = uniqueBy(entries.flatMap(({ changes }) => changes), changeIdentity).sort((left, right) => Date.parse(left.observedAtUtc) - Date.parse(right.observedAtUtc))
      const seed = entries.find(({ seed }) => seed)?.seed ?? null
      return [field, { ...base, seed, changes, observationState: changes.length ? 'SUPPORTED_WITH_OBSERVATIONS' : seed ? 'SUPPORTED_WITH_SEED_ONLY' : base.observationState }]
    })) as ProductionContextEvidence['fields']
    const changes = uniqueBy(contexts.flatMap(({ changes }) => changes), (item: ContextChange) => `${item.atUtc}:${item.field}:${String(item.previousValue)}:${String(item.value)}`).sort((left, right) => Date.parse(left.atUtc) - Date.parse(right.atUtc) || left.field.localeCompare(right.field))
    result.context = { ...first, fromUtc, toUtc, fields, changes }
  }

  if (speeds.length) {
    const first = speeds[0]!
    const actual = mergeSpeedSignal(speeds.map(({ actual }) => actual))!
    const setpoint = mergeSpeedSignal(speeds.flatMap(({ setpoint }) => setpoint ? [setpoint] : [])) ?? null
    result.speed = { ...first, fromUtc, toUtc, actual, setpoint }
  }

  if (motions.length) {
    const first = motions[0]!
    const segments = mergeMotionSegments(motions)
    const durationsMs = { RUNNING: 0, STOPPED: 0, TRANSITION: 0, UNKNOWN: 0 }
    segments.forEach(({ state, durationMs }) => { durationsMs[state] += durationMs })
    result.motion = { ...first, fromUtc, toUtc, segments, summary: { durationsMs, durationsSeconds: Object.fromEntries(Object.entries(durationsMs).map(([state, duration]) => [state, duration / 1_000])) as PressMotionEvidence['summary']['durationsSeconds'], segmentCount: segments.length } }
  }

  if (physicalEvidence.length) {
    const first = physicalEvidence[0]!
    const grouped = new Map<string, SemanticSignalEvidence[]>()
    physicalEvidence.flatMap(({ signals }) => signals).forEach((signal) => {
      const key = `${signal.canonicalId}:${signal.deckNumber ?? ''}`
      grouped.set(key, [...(grouped.get(key) ?? []), signal])
    })
    const signals = [...grouped.values()].map((entries) => {
      const base = entries[0]!
      const changes = uniqueBy(entries.flatMap(({ changes }) => changes), changeIdentity).sort((left, right) => Date.parse(left.observedAtUtc) - Date.parse(right.observedAtUtc))
      const samples = uniqueBy(entries.flatMap(({ samples }) => samples), timedIdentity).sort((left, right) => Date.parse(left.observedAtUtc) - Date.parse(right.observedAtUtc))
      return { ...base, changes, samples, seed: entries.find(({ seed }) => seed)?.seed ?? null, observationState: changes.length || samples.length ? 'SUPPORTED_WITH_OBSERVATIONS' : base.observationState }
    })
    result.physical = { ...first, fromUtc, toUtc, requestedCategories: [...new Set(physicalEvidence.flatMap(({ requestedCategories }) => requestedCategories))], capabilities: uniqueBy(physicalEvidence.flatMap(({ capabilities }) => capabilities), ({ canonicalId }) => canonicalId), signals }
  }
  return result
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await task(items[index]!)
    }
  }))
  return results
}

export function usePressTelemetryEvidence(pressKey: RadiusPressKey | undefined, fromUtc: string, toUtc: string, options: { enabled?: boolean; padShortRange?: boolean; fullRange?: boolean } = {}): PressTelemetryEvidenceState {
  const enabled = options.enabled ?? true
  const duration = Date.parse(toUtc) - Date.parse(fromUtc)
  const useFullRange = options.fullRange === true && duration > 0 && duration <= MAX_FULL_TELEMETRY_RANGE_MS
  const range = useMemo(() => useFullRange ? { fromUtc, toUtc, focused: false } : boundedEvidenceRange(fromUtc, toUtc, options.padShortRange ?? true), [fromUtc, toUtc, options.padShortRange, useFullRange])
  const chunks = useMemo(() => useFullRange ? telemetryEvidenceChunks(range.fromUtc, range.toUtc) : [{ fromUtc: range.fromUtc, toUtc: range.toUtc }], [range.fromUtc, range.toUtc, useFullRange])
  const key = `${pressKey ?? ''}:${range.fromUtc}:${range.toUtc}`
  const [stored, setStored] = useState<StoredEvidence>({ key: '', loading: false, error: false })
  const chunkCache = useRef(new Map<string, ChunkEvidence>())

  useEffect(() => {
    if (!enabled || !pressKey) return
    const controller = new AbortController()
    setStored({ key, loading: true, error: false })
    void getPressTelemetryCapabilities(pressKey, controller.signal).then(async (capabilities) => {
      const supported = (canonicalId: string) => capabilities.capabilities.some((item) => item.canonicalId === canonicalId && item.state === 'SUPPORTED')
      const categories = curatedCategoriesForCapabilities(capabilities.capabilities)
      const evidence = await mapWithConcurrency(chunks, 3, async (chunk): Promise<ChunkEvidence> => {
        const cacheKey = `${pressKey}:${chunk.fromUtc}:${chunk.toUtc}:${categories.join(',')}`
        const cached = chunkCache.current.get(cacheKey)
        if (cached) return cached
        const next: ChunkEvidence = { error: false }
        const requests: Promise<void>[] = []
        if (supported('machine.speed.actual')) requests.push(getPressSpeed(pressKey, chunk.fromUtc, chunk.toUtc, controller.signal).then((value) => { next.speed = value }))
        if (supported('physical.motion_state')) requests.push(getPressMotion(pressKey, chunk.fromUtc, chunk.toUtc, controller.signal).then((value) => { next.motion = value }))
        if (capabilities.capabilities.some((item) => item.canonicalId.startsWith('production.') && item.state === 'SUPPORTED')) requests.push(getProductionContext(pressKey, chunk.fromUtc, chunk.toUtc, controller.signal).then((value) => { next.context = value }))
        if (categories.length) requests.push(getCuratedPhysicalEvidence(pressKey, { fromUtc: chunk.fromUtc, toUtc: chunk.toUtc, includeSeed: false, categories, representation: 'changes' }, controller.signal).then((value) => { next.physical = value }))
        const results = await Promise.allSettled(requests)
        next.error = results.some(({ status }) => status === 'rejected')
        if (!next.error && Date.parse(chunk.toUtc) < Date.now() - 60_000) {
          chunkCache.current.set(cacheKey, next)
          while (chunkCache.current.size > 128) chunkCache.current.delete(chunkCache.current.keys().next().value!)
        }
        return next
      })
      const merged = mergeTelemetryEvidenceChunks(evidence, range.fromUtc, range.toUtc)
      if (!controller.signal.aborted) setStored({ key, capabilities, ...merged, loading: false, error: evidence.some(({ error }) => error) })
    }).catch((error) => {
      if (!controller.signal.aborted && !(error instanceof DOMException && error.name === 'AbortError')) setStored({ key, loading: false, error: true })
    })
    return () => controller.abort()
  }, [enabled, pressKey, range.fromUtc, range.toUtc, key, chunks])

  if (!enabled || stored.key !== key) return { range, loading: enabled && Boolean(pressKey), error: false }
  return { range, capabilities: stored.capabilities, context: stored.context, motion: stored.motion, speed: stored.speed, physical: stored.physical, loading: stored.loading, error: stored.error }
}

export function contextIntervalTracks(context?: ProductionContextEvidence): TimelineIntervalTrack[] {
  if (!context) return []
  const end = Date.parse(context.toUtc)
  return VISIBLE_CONTEXT_FIELDS.map((field) => {
    const evidence = context.fields[field]
    const values = [
      ...(evidence.seed ? [{ atUtc: context.fromUtc, value: evidence.seed.value }] : []),
      ...evidence.changes.map((change) => ({ atUtc: change.observedAtUtc, value: change.value })),
    ].sort((left, right) => Date.parse(left.atUtc) - Date.parse(right.atUtc)).map((value) => ({ ...value, display: contextDisplayValue(value.value) }))
    const colorByValue = new Map<string, number>()
    values.forEach(({ value, display }) => {
      const key = `${typeof value}:${String(value)}`
      if (display.usable && !colorByValue.has(key)) colorByValue.set(key, colorByValue.size)
    })
    return { id: `context-${field}`, label: CONTEXT_LABELS[field], unavailableLabel: evidence.capabilityState === 'UNSUPPORTED' ? 'Unsupported for this press' : evidence.capabilityState === 'SUPPORTED' ? 'Supported, but no value observed in this range' : 'Capability unknown or temporarily unavailable', intervals: values.map((value, index) => ({
      id: `context:${field}:${value.atUtc}:${index}`,
      startUtc: value.atUtc,
      endUtc: new Date(Math.max(Date.parse(value.atUtc) + 1_000, Math.min(end, Date.parse(values[index + 1]?.atUtc ?? context.toUtc)))).toISOString(),
      label: value.display.label,
      details: `${CONTEXT_LABELS[field]} context: ${value.display.label}\nRaw source value: ${String(value.value)}\nObserved from ${formatPlantDateTime(value.atUtc)} CT`,
      className: `context-timeline-value context-timeline-value--${field}`,
      style: value.display.usable ? contextIntervalStyle(field, colorByValue.get(`${typeof value.value}:${String(value.value)}`) ?? 0) : undefined,
      unavailable: !value.display.usable,
    })) }
  })
}

export function contextEventTrack(context?: ProductionContextEvidence): TimelineEventTrack | undefined {
  if (!context) return undefined
  return {
    id: 'context-changes', label: 'Context changes', unavailableLabel: 'No context changes observed in this range',
    events: context.changes.filter((change) => VISIBLE_CONTEXT_FIELDS.includes(change.field as VisibleContextField)).map((change, index) => ({
      id: `context-event:${change.field}:${change.atUtc}:${index}`,
      atUtc: change.atUtc,
      category: `context-${change.field}`,
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
    connectObservedGaps: true, interpolation: 'step',
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
    contextChanges: evidence.context?.changes.filter(({ field }) => field !== 'job').length ?? 0,
    physicalChanges: evidence.physical?.signals.reduce((sum, signal) => sum + signal.changes.length, 0) ?? 0,
  }
}
