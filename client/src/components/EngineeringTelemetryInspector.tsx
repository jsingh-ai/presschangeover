import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DateTime } from 'luxon'
import { getPressMotion, getPressSemanticHistory, getPressTelemetryCapabilities } from '../api/process-intelligence-api'
import {
  ENGINEERING_CATEGORY_LABELS, ENGINEERING_SIGNAL_CATALOG, browserCategoryForClue, capabilityFor, signalDefinition, signalKey,
  type EngineeringBrowserCategory, type EngineeringSignalIdentity,
} from '../engineering-signal-catalog'
import { createCustomRange, formatPlantDateTime, PLANT_TIME_ZONE } from '../time-ranges'
import type { ActivityOccurrence } from '../types/api'
import type { EngineeringClueResponse, PressSemanticHistoryEvidence, PressTelemetryCapabilities, SemanticSignalEvidence, SignalCapability, StopRestartResponse, TelemetryChange, TimedNumericSample, TimedTelemetryValue } from '../types/evidence'
import { SynchronizedTimeline, type TimelineEventTrack, type TimelineIntervalTrack, type TimelineNumericTrack } from './SynchronizedTimeline'

const MAX_WINDOW_MS = 2 * 60 * 60 * 1_000
const MAX_PINS = 12
const PIN_STORAGE_KEY = 'process-intelligence.engineering-telemetry-pins.v1'

export type EngineeringEvidenceWindowMode = 'occurrence' | 'padding5' | 'padding15' | 'padding30' | 'entry' | 'middle' | 'exit' | 'custom'
export interface EngineeringEvidenceWindow { fromUtc: string; toUtc: string; mode: EngineeringEvidenceWindowMode; message?: string }
export interface EngineeringInspectorTarget { scope: 'machine' | 'deck'; deckNumber?: number; category: EngineeringBrowserCategory; canonicalId?: string; requestId: number }
export interface EngineeringPin extends EngineeringSignalIdentity {}

export function appendEngineeringPin(current: EngineeringPin[], value: EngineeringPin, maximum = MAX_PINS): { pins: EngineeringPin[]; message: string } {
  if (current.some((item) => signalKey(item) === signalKey(value))) return { pins: current, message: 'That signal is already pinned.' }
  if (current.length >= maximum) return { pins: current, message: `Up to ${maximum} signals can be pinned at once.` }
  return { pins: [...current, value], message: `${signalDefinition(value.canonicalId)?.friendlyName ?? value.canonicalId} pinned.` }
}

function iso(ms: number): string { return new Date(ms).toISOString() }

export function engineeringEvidenceWindow(occurrence: Pick<ActivityOccurrence, 'startUtc' | 'endUtc'>, mode: EngineeringEvidenceWindowMode, custom?: { fromUtc: string; toUtc: string }): EngineeringEvidenceWindow {
  const start = Date.parse(occurrence.startUtc)
  const end = Date.parse(occurrence.endUtc)
  const duration = Math.max(1, end - start)
  if (mode === 'custom') {
    const from = Date.parse(custom?.fromUtc ?? '')
    const to = Date.parse(custom?.toUtc ?? '')
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw new Error('Choose a valid custom start and end time.')
    if (to - from > MAX_WINDOW_MS) throw new Error('Custom evidence windows must be two hours or less.')
    return { fromUtc: iso(from), toUtc: iso(to), mode }
  }
  if (duration > MAX_WINDOW_MS) {
    if (mode === 'middle') { const midpoint = start + duration / 2; return { fromUtc: iso(midpoint - MAX_WINDOW_MS / 2), toUtc: iso(midpoint + MAX_WINDOW_MS / 2), mode } }
    if (mode === 'exit') return { fromUtc: iso(end - MAX_WINDOW_MS), toUtc: iso(end), mode }
    return { fromUtc: iso(start), toUtc: iso(start + MAX_WINDOW_MS), mode: 'entry' }
  }
  if (mode === 'occurrence') return { fromUtc: occurrence.startUtc, toUtc: occurrence.endUtc, mode }
  const padding = mode === 'padding5' ? 5 * 60_000 : mode === 'padding30' ? 30 * 60_000 : 15 * 60_000
  const desired = duration + padding * 2
  if (desired <= MAX_WINDOW_MS) return { fromUtc: iso(start - padding), toUtc: iso(end + padding), mode }
  const available = MAX_WINDOW_MS - duration
  const before = Math.min(padding, Math.max(0, available / 2))
  const after = Math.max(0, available - before)
  return { fromUtc: iso(start - before), toUtc: iso(end + after), mode, message: `The requested padding exceeds the two-hour telemetry limit. The complete occurrence is retained with ${Math.round(before / 60_000)} minutes before and ${Math.round(after / 60_000)} minutes after.` }
}

function readPins(): EngineeringPin[] {
  if (typeof window === 'undefined') return []
  try {
    const value = JSON.parse(window.sessionStorage.getItem(PIN_STORAGE_KEY) ?? '[]') as unknown
    if (!Array.isArray(value)) return []
    return value.filter((item): item is EngineeringPin => Boolean(item) && typeof item === 'object' && typeof (item as EngineeringPin).canonicalId === 'string' && ((item as EngineeringPin).deckNumber === undefined || Number.isInteger((item as EngineeringPin).deckNumber))).slice(0, MAX_PINS)
  } catch { return [] }
}

export function useEngineeringPins() {
  const [pins, setPins] = useState<EngineeringPin[]>(readPins)
  const [message, setMessage] = useState('')
  useEffect(() => { try { window.sessionStorage.setItem(PIN_STORAGE_KEY, JSON.stringify(pins)) } catch { /* session storage is an optional convenience */ } }, [pins])
  const pin = useCallback((value: EngineeringPin) => {
    setPins((current) => {
      const result = appendEngineeringPin(current, value)
      setMessage(result.message)
      return result.pins
    })
  }, [])
  const unpin = useCallback((value: EngineeringPin) => setPins((current) => current.filter((item) => signalKey(item) !== signalKey(value))), [])
  const clear = useCallback(() => { setPins([]); setMessage('Pinned signals cleared.') }, [])
  return { pins, pin, unpin, clear, message, maximum: MAX_PINS }
}

type HistoryStatus = { state: 'loading' | 'loaded' | 'error'; signal?: SemanticSignalEvidence }

function motionAsSignal(fromUtc: string, motion: Awaited<ReturnType<typeof getPressMotion>>): SemanticSignalEvidence {
  const value = (at: string, state: string): TimedTelemetryValue => ({ observedAtUtc: at, receivedAtUtc: at, sourceTimestampUtc: at, qualityState: 'DERIVED', valueKind: 'string', value: state })
  const changes: TelemetryChange[] = motion.segments.slice(1).map((segment, index) => ({ ...value(segment.fromUtc, segment.state), previousObservedAtUtc: motion.segments[index]!.fromUtc, previousReceivedAtUtc: motion.segments[index]!.fromUtc, previousSourceTimestampUtc: motion.segments[index]!.fromUtc, previousQualityState: 'DERIVED', previousValueKind: 'string', previousValue: motion.segments[index]!.state }))
  const first = motion.segments[0]
  return { canonicalId: 'physical.motion_state', deckNumber: null, capabilityState: 'SUPPORTED', observationState: first ? 'SUPPORTED_WITH_OBSERVATIONS' : 'SUPPORTED_WITH_NO_SAMPLES_IN_RANGE', mappingStatus: 'MAPPED', sourceUnit: null, canonicalUnitStatus: null, representation: 'changes', seed: first ? value(first.fromUtc || fromUtc, first.state) : null, samples: [], changes }
}

function chunk<T>(values: T[], size: number): T[][] { return Array.from({ length: Math.ceil(values.length / size) }, (_, index) => values.slice(index * size, (index + 1) * size)) }

function useEngineeringHistory(pressKey: ActivityOccurrence['pressKey'], window: EngineeringEvidenceWindow, signals: Array<EngineeringSignalIdentity & { signalType: 'continuous' | 'step_reference' | 'state_event' }>) {
  const cache = useRef(new Map<string, HistoryStatus>())
  const requestVersion = useRef(0)
  const [, render] = useState(0)
  const windowKey = `${pressKey}:${window.fromUtc}:${window.toUtc}`
  const requestedKey = signals.map(signalKey).join('|')
  useEffect(() => {
    const controller = new AbortController()
    const version = ++requestVersion.current
    const missing = signals.filter((signal) => !cache.current.has(`${windowKey}:${signalKey(signal)}`))
    if (!missing.length) return () => controller.abort()
    missing.forEach((signal) => cache.current.set(`${windowKey}:${signalKey(signal)}`, { state: 'loading' }))
    render((value) => value + 1)
    const normal = missing.filter(({ canonicalId }) => canonicalId !== 'physical.motion_state')
    const tasks: Array<Promise<void>> = chunk(normal, 50).map(async (batch) => {
      const response: PressSemanticHistoryEvidence = await getPressSemanticHistory(pressKey, { fromUtc: window.fromUtc, toUtc: window.toUtc, includeSeed: true, signals: batch.map((signal) => ({ ...signal, representation: signal.signalType === 'continuous' ? 'samples' : 'changes' })) }, controller.signal)
      if (controller.signal.aborted || version !== requestVersion.current) return
      batch.forEach((identity) => {
        const signal = response.signals.find((item) => signalKey({ canonicalId: item.canonicalId, ...(item.deckNumber === null ? {} : { deckNumber: item.deckNumber }) }) === signalKey(identity))
        cache.current.set(`${windowKey}:${signalKey(identity)}`, signal ? { state: 'loaded', signal } : { state: 'error' })
      })
    })
    if (missing.some(({ canonicalId }) => canonicalId === 'physical.motion_state')) tasks.push(getPressMotion(pressKey, window.fromUtc, window.toUtc, controller.signal).then((motion) => { if (!controller.signal.aborted && version === requestVersion.current) cache.current.set(`${windowKey}:physical.motion_state:`, { state: 'loaded', signal: motionAsSignal(window.fromUtc, motion) }) }))
    void Promise.all(tasks).catch(() => {
      if (controller.signal.aborted || version !== requestVersion.current) return
      missing.forEach((signal) => { const key = `${windowKey}:${signalKey(signal)}`; if (cache.current.get(key)?.state === 'loading') cache.current.set(key, { state: 'error' }) })
    }).finally(() => {
      if (controller.signal.aborted || version !== requestVersion.current) return
      while (cache.current.size > 160) cache.current.delete(cache.current.keys().next().value as string)
      render((value) => value + 1)
    })
    return () => {
      controller.abort()
      missing.forEach((signal) => { const key = `${windowKey}:${signalKey(signal)}`; if (cache.current.get(key)?.state === 'loading') cache.current.delete(key) })
    }
  }, [pressKey, window.fromUtc, window.toUtc, requestedKey])
  return useCallback((identity: EngineeringSignalIdentity) => cache.current.get(`${windowKey}:${signalKey(identity)}`), [windowKey])
}

export function safeEngineeringSourceUnit(signal?: Pick<SemanticSignalEvidence, 'sourceUnit'>): string | null {
  const unit = signal?.sourceUnit?.trim()
  return unit && !/^\d+$/.test(unit) ? unit : null
}
const sourceUnit = safeEngineeringSourceUnit

function signalPoints(signal: SemanticSignalEvidence, fromUtc: string, toUtc: string): TimedNumericSample[] {
  const points: TimedNumericSample[] = []
  const add = (at: string, item: TimedTelemetryValue | { value: unknown; valueKind: string }) => { if (typeof item.value === 'number' && Number.isFinite(item.value)) points.push({ observedAtUtc: at, receivedAtUtc: at, sourceTimestampUtc: at, qualityState: 'VISUAL', valueKind: item.valueKind === 'integer' ? 'integer' : 'numeric', value: item.value }) }
  if (signal.representation === 'samples') return signal.samples.filter((sample): sample is TimedNumericSample => typeof sample.value === 'number' && Number.isFinite(sample.value))
  const entering = signal.seed ?? (signal.changes[0] ? { ...signal.changes[0], value: signal.changes[0].previousValue, valueKind: signal.changes[0].previousValueKind } : undefined)
  if (entering) add(fromUtc, entering)
  signal.changes.forEach((change) => add(change.observedAtUtc, change))
  const last = points.at(-1)
  if (last && Date.parse(last.observedAtUtc) < Date.parse(toUtc)) points.push({ ...last, observedAtUtc: toUtc })
  return points
}

function stateIntervals(identity: EngineeringSignalIdentity, signal: SemanticSignalEvidence, fromUtc: string, toUtc: string): TimelineIntervalTrack {
  const points: Array<{ atUtc: string; value: unknown; observedAtUtc: string }> = []
  const entering = signal.seed ?? (signal.changes[0] ? { ...signal.changes[0], value: signal.changes[0].previousValue, observedAtUtc: signal.changes[0].previousObservedAtUtc } : undefined)
  if (entering) points.push({ atUtc: fromUtc, value: entering.value, observedAtUtc: entering.observedAtUtc })
  signal.changes.forEach((change) => points.push({ atUtc: change.observedAtUtc, value: change.value, observedAtUtc: change.observedAtUtc }))
  const definition = signalDefinition(identity.canonicalId)
  const palette = ['#6657a8', '#3f6f9f', '#8a5e9d', '#4d689e', '#75568d', '#49658c']
  return { id: `engineering-state:${signalKey(identity)}`, label: `${identity.deckNumber ? `Deck ${identity.deckNumber} · ` : ''}${definition?.friendlyName ?? identity.canonicalId}`, unavailableLabel: 'No raw state observation in this evidence window', intervals: points.map((point, index) => { const raw = String(point.value); const hash = [...raw].reduce((sum, character) => sum + character.charCodeAt(0), 0); return { id: `${signalKey(identity)}:${point.atUtc}:${index}`, startUtc: point.atUtc, endUtc: points[index + 1]?.atUtc ?? toUtc, label: raw, details: `Raw value ${raw}; observed ${formatPlantDateTime(point.observedAtUtc)} CT`, style: { background: palette[hash % palette.length] } } }).filter((item) => Date.parse(item.endUtc) > Date.parse(item.startUtc)) }
}

function observationCount(signal?: SemanticSignalEvidence): number { return signal ? (signal.representation === 'samples' ? signal.samples.length : signal.changes.length + Number(Boolean(signal.seed))) : 0 }

export function engineeringSignalReadout(identity: EngineeringSignalIdentity, signal: SemanticSignalEvidence | undefined, atUtc: string) {
  if (!signal) return { value: 'Not available', observedAtUtc: undefined as string | undefined, differenceMs: undefined as number | undefined }
  const at = Date.parse(atUtc)
  const definition = signalDefinition(identity.canonicalId)
  if (definition?.signalType === 'continuous') {
    const candidates = signal.samples.filter(({ value }) => typeof value === 'number' && Number.isFinite(value))
    const nearest = candidates.reduce<typeof candidates[number] | undefined>((best, item) => !best || Math.abs(Date.parse(item.observedAtUtc) - at) < Math.abs(Date.parse(best.observedAtUtc) - at) ? item : best, undefined)
    return nearest ? { value: String(nearest.value), observedAtUtc: nearest.observedAtUtc, differenceMs: Math.abs(Date.parse(nearest.observedAtUtc) - at) } : { value: 'No observed sample', observedAtUtc: undefined, differenceMs: undefined }
  }
  const candidates: TimedTelemetryValue[] = [...(signal.seed ? [signal.seed] : []), ...signal.changes].filter((item) => Date.parse(item.observedAtUtc) <= at).sort((left, right) => Date.parse(left.observedAtUtc) - Date.parse(right.observedAtUtc))
  const latest = candidates.at(-1)
  return latest ? { value: definition?.signalType === 'state_event' ? `raw code ${String(latest.value)}` : String(latest.value), observedAtUtc: latest.observedAtUtc, differenceMs: at - Date.parse(latest.observedAtUtc) } : { value: 'No prior observation', observedAtUtc: undefined, differenceMs: undefined }
}

function supportLabel(capability?: SignalCapability): string {
  if (!capability) return 'Capability unknown'
  if (capability.state === 'SUPPORTED') return 'Supported'
  if (capability.state === 'UNSUPPORTED') return 'Not available on this press'
  if (capability.state === 'TEMPORARILY_UNAVAILABLE') return 'Temporarily unavailable'
  return 'Capability unknown'
}

function toLocalInput(value: string): string { return DateTime.fromISO(value, { zone: 'utc' }).setZone(PLANT_TIME_ZONE).toFormat("yyyy-MM-dd'T'HH:mm") }

function traceCollections(identities: EngineeringPin[], history: (identity: EngineeringSignalIdentity) => HistoryStatus | undefined, window: EngineeringEvidenceWindow) {
  const numericTracks: TimelineNumericTrack[] = []
  const intervalTracks: TimelineIntervalTrack[] = []
  identities.forEach((identity) => {
    const definition = signalDefinition(identity.canonicalId)
    const signal = history(identity)?.signal
    if (!definition || !signal) return
    if (definition.signalType === 'state_event' || (definition.signalType === 'step_reference' && !signalPoints(signal, window.fromUtc, window.toUtc).length)) intervalTracks.push(stateIntervals(identity, signal, window.fromUtc, window.toUtc))
    else numericTracks.push({ id: `engineering-numeric:${signalKey(identity)}`, label: `${identity.deckNumber ? `Deck ${identity.deckNumber} · ` : ''}${definition.friendlyName}`, samples: signalPoints(signal, window.fromUtc, window.toUtc), unit: safeEngineeringSourceUnit(signal), interpolation: definition.signalType === 'step_reference' ? 'step' : 'linear', connectObservedGaps: definition.signalType === 'step_reference', unavailableLabel: 'No numeric observations in this evidence window' })
  })
  return { numericTracks, intervalTracks }
}

function EngineeringTrace({ identities, history, window, occurrence, stopAnalysis, inspectionUtc, onInspectionTimeChange, ariaLabel }: { identities: EngineeringPin[]; history(identity: EngineeringSignalIdentity): HistoryStatus | undefined; window: EngineeringEvidenceWindow; occurrence: ActivityOccurrence; stopAnalysis?: StopRestartResponse; inspectionUtc: string; onInspectionTimeChange(value: string): void; ariaLabel: string }) {
  const tracks = traceCollections(identities, history, window)
  const trackOrder = identities.flatMap((identity) => {
    const key = signalKey(identity)
    if (tracks.intervalTracks.some(({ id }) => id === `engineering-state:${key}`)) return [`interval:engineering-state:${key}`]
    if (tracks.numericTracks.some(({ id }) => id === `engineering-numeric:${key}`)) return [`numeric:engineering-numeric:${key}`]
    return []
  })
  const referenceEvents: TimelineEventTrack = { id: 'engineering-occurrence-boundaries', label: 'Occurrence boundaries', events: [
    { id: 'engineering-occurrence-start', atUtc: occurrence.startUtc, label: 'Occurrence starts', category: 'occurrence-start', detail: 'Focused Radius occurrence entry' },
    { id: 'engineering-occurrence-end', atUtc: occurrence.endUtc, label: 'Occurrence ends', category: 'occurrence-end', detail: 'Focused Radius occurrence exit' },
  ].filter((event) => Date.parse(event.atUtc) >= Date.parse(window.fromUtc) && Date.parse(event.atUtc) <= Date.parse(window.toUtc)) }
  if (stopAnalysis?.phases?.deceleration.fromUtc) referenceEvents.events.push({ id: 'engineering-deceleration', atUtc: stopAnalysis.phases.deceleration.fromUtc, label: 'Observed deceleration', category: 'physical-deceleration', detail: 'Actual speed left the prior physical-running bucket' })
  if (stopAnalysis?.physicalStopMatch.selected) referenceEvents.events.push({ id: 'engineering-physical-stop', atUtc: stopAnalysis.physicalStopMatch.selected.atUtc, label: 'Physical stop', category: 'physical-stop', detail: `Observed actual speed ${stopAnalysis.physicalStopMatch.selected.observedSpeed}` })
  if (stopAnalysis?.phases?.sustainedRunningConfirmedAtUtc) referenceEvents.events.push({ id: 'engineering-running-resumed', atUtc: stopAnalysis.phases.sustainedRunningConfirmedAtUtc, label: 'Sustained physical running confirmed', category: 'physical-restart', detail: 'Separate 120-second physical-running confirmation policy' })
  referenceEvents.events = referenceEvents.events.filter((event) => Date.parse(event.atUtc) >= Date.parse(window.fromUtc) && Date.parse(event.atUtc) <= Date.parse(window.toUtc))
  return <><SynchronizedTimeline fromUtc={window.fromUtc} toUtc={window.toUtc} ariaLabel={ariaLabel} intervalTracks={tracks.intervalTracks} numericTracks={tracks.numericTracks} eventTracks={[referenceEvents]} trackOrder={trackOrder} highlightedRange={{ fromUtc: occurrence.startUtc, toUtc: occurrence.endUtc, label: 'Focused occurrence' }} onInspectionTimeChange={onInspectionTimeChange} />
    <section className="engineering-crosshair-readout" aria-live="polite"><h4>Inspection time · {formatPlantDateTime(inspectionUtc)} CT</h4><div>{identities.map((identity) => { const definition = signalDefinition(identity.canonicalId); const signal = history(identity)?.signal; const value = engineeringSignalReadout(identity, signal, inspectionUtc); const difference = value.differenceMs === undefined ? '' : value.differenceMs < 1_000 ? ' · at inspection time' : ` · ${Math.round(value.differenceMs / 1_000)}s from inspection`; return <article key={signalKey(identity)}><span>{identity.deckNumber ? `Deck ${identity.deckNumber} · ` : 'Machine · '}{definition?.friendlyName ?? identity.canonicalId}</span><strong>{value.value}</strong><small>{value.observedAtUtc ? `observed ${formatPlantDateTime(value.observedAtUtc)} CT${difference}` : 'No observation timestamp available'}{safeEngineeringSourceUnit(signal) ? ` · Source unit: ${safeEngineeringSourceUnit(signal)} — unverified` : ' · Unit unverified'}</small></article> })}</div></section></>
}

export function EngineeringTelemetryInspector({ occurrence, clues, stopAnalysis, target, pins, onPin, onUnpin, onClearPins, pinMessage, pinMaximum }: { occurrence: ActivityOccurrence; clues?: EngineeringClueResponse; stopAnalysis?: StopRestartResponse; target?: EngineeringInspectorTarget; pins: EngineeringPin[]; onPin(pin: EngineeringPin): void; onUnpin(pin: EngineeringPin): void; onClearPins(): void; pinMessage: string; pinMaximum: number }) {
  const longOccurrence = Date.parse(occurrence.endUtc) - Date.parse(occurrence.startUtc) > MAX_WINDOW_MS
  const [mode, setMode] = useState<EngineeringEvidenceWindowMode>(longOccurrence ? 'entry' : 'padding15')
  const [customStart, setCustomStart] = useState(toLocalInput(occurrence.startUtc))
  const [customEnd, setCustomEnd] = useState(toLocalInput(occurrence.endUtc))
  const [customError, setCustomError] = useState('')
  const [customWindow, setCustomWindow] = useState<EngineeringEvidenceWindow>()
  const [capabilityResponse, setCapabilities] = useState<PressTelemetryCapabilities>()
  const [capabilityError, setCapabilityError] = useState(false)
  const [scopeDeck, setScopeDeck] = useState<number | null>(null)
  const [category, setCategory] = useState<EngineeringBrowserCategory>('speed_command')
  const [selectedSignal, setSelectedSignal] = useState<EngineeringPin>()
  const [inspectionUtc, setInspectionUtc] = useState(occurrence.startUtc)
  const lastTarget = useRef(0)

  useEffect(() => { setMode(longOccurrence ? 'entry' : 'padding15'); setCustomStart(toLocalInput(occurrence.startUtc)); setCustomEnd(toLocalInput(occurrence.endUtc)); setCustomWindow(undefined); setInspectionUtc(occurrence.startUtc) }, [occurrence.occurrenceId, longOccurrence])
  useEffect(() => {
    const controller = new AbortController(); setCapabilityError(false)
    void getPressTelemetryCapabilities(occurrence.pressKey, controller.signal).then((value) => { if (!controller.signal.aborted) setCapabilities(value) }).catch(() => { if (!controller.signal.aborted) { setCapabilityError(true); setCapabilities(undefined) } })
    return () => controller.abort()
  }, [occurrence.pressKey])
  useEffect(() => {
    if (!target || target.requestId === lastTarget.current) return
    lastTarget.current = target.requestId; setScopeDeck(target.scope === 'deck' ? target.deckNumber ?? 1 : null); setCategory(target.category)
    if (target.canonicalId) setSelectedSignal({ canonicalId: target.canonicalId, ...(target.deckNumber ? { deckNumber: target.deckNumber } : {}) })
  }, [target])

  const window = customWindow && mode === 'custom' ? customWindow : engineeringEvidenceWindow(occurrence, mode === 'custom' ? (longOccurrence ? 'entry' : 'padding15') : mode)
  const capabilities = capabilityResponse?.pressKey === occurrence.pressKey ? capabilityResponse : undefined
  const capabilityList = capabilities?.capabilities ?? []
  const clueBySignal = useMemo(() => new Map((clues?.signalClues ?? []).map((clue) => [signalKey({ canonicalId: clue.canonicalId, ...(clue.deckNumber === null ? {} : { deckNumber: clue.deckNumber }) }), clue])), [clues])
  const definitionsForScope = ENGINEERING_SIGNAL_CATALOG.filter((definition) => definition.scope === (scopeDeck === null ? 'machine' : 'deck'))
  const potentiallyApplicable = (definition: typeof ENGINEERING_SIGNAL_CATALOG[number]) => {
    const capability = capabilityList.find(({ canonicalId }) => canonicalId === definition.canonicalId)
    if (!capability || capability.state === 'UNSUPPORTED') return false
    return scopeDeck === null || capability.state !== 'SUPPORTED' || capability.deckNumbers.includes(scopeDeck)
  }
  const categories = [...new Set(definitionsForScope.filter(potentiallyApplicable).map(({ browserCategory }) => browserCategory))]
  const resolvedCategory = categories.includes(category) ? category : categories[0]
  useEffect(() => { if (resolvedCategory && resolvedCategory !== category) setCategory(resolvedCategory) }, [resolvedCategory, category])
  const browserSignals = resolvedCategory ? definitionsForScope.filter((definition) => definition.browserCategory === resolvedCategory).map((definition) => ({ canonicalId: definition.canonicalId, ...(scopeDeck === null ? {} : { deckNumber: scopeDeck }), signalType: definition.signalType })) : []
  const loadable = (identity: EngineeringSignalIdentity) => { const capability = capabilityFor(capabilityList, identity); return capability?.state === 'SUPPORTED' && (capability.historyQueryable || identity.canonicalId === 'physical.motion_state') }
  const desired = [...pins.map((pin) => ({ ...pin, signalType: signalDefinition(pin.canonicalId)?.signalType ?? 'continuous' as const })), ...browserSignals].filter((item, index, all) => loadable(item) && all.findIndex((candidate) => signalKey(candidate) === signalKey(item)) === index)
  const history = useEngineeringHistory(occurrence.pressKey, window, desired)
  const orderedBrowserSignals = [...browserSignals].sort((left, right) => {
    const leftKey = signalKey(left); const rightKey = signalKey(right)
    const score = (key: string, identity: EngineeringSignalIdentity) => Number(clueBySignal.get(key)?.isClue) * 100 + Number(pins.some((pin) => signalKey(pin) === key)) * 50 + Number(history(identity)?.state === 'loaded') * 10 + Number(loadable(identity))
    return score(rightKey, right) - score(leftKey, left) || (signalDefinition(left.canonicalId)?.friendlyName ?? left.canonicalId).localeCompare(signalDefinition(right.canonicalId)?.friendlyName ?? right.canonicalId)
  })
  const supportedPins = pins.filter(loadable)

  const chooseScope = (deckNumber: number | null) => {
    setScopeDeck(deckNumber)
    const scopeKey = deckNumber === null ? 'machine' : `deck-${deckNumber}`
    const strongest = clues?.whereToLook.find((item) => item.scopeKey === scopeKey)
    if (strongest) setCategory(browserCategoryForClue(strongest.category))
  }
  const applyCustom = () => {
    try { const range = createCustomRange(customStart, customEnd); const result = engineeringEvidenceWindow(occurrence, 'custom', { fromUtc: range.fromUtc, toUtc: range.toUtc }); setCustomWindow(result); setCustomError(''); setMode('custom') } catch (error) { setCustomError(error instanceof Error ? error.message : 'The custom window is invalid.') }
  }
  const deckBadge = (deckNumber: number | null) => {
    const scopeKey = deckNumber === null ? 'machine' : `deck-${deckNumber}`
    const cells = clues?.categoryCells.filter((cell) => cell.scopeKey === scopeKey) ?? []
    const count = cells.reduce((sum, cell) => sum + cell.clueSignals, 0)
    if (count) return `${count} ${count === 1 ? 'clue' : 'clues'}`
    if (cells.some(({ status }) => status === 'insufficient' || status === 'temporarily_unavailable')) return 'Limited observation'
    return 'No supported shift detected'
  }
  const presets: Array<[EngineeringEvidenceWindowMode, string]> = longOccurrence
    ? [['entry', 'Around entry'], ['middle', 'Middle 2 hours'], ['exit', 'Around exit']]
    : [['occurrence', 'Occurrence only'], ['padding5', '±5 minutes'], ['padding15', '±15 minutes'], ['padding30', '±30 minutes']]

  return <section className="engineering-inspector" id="engineering-telemetry-inspector" aria-labelledby="engineering-inspector-title">
    <div className="section-heading"><div><p className="eyebrow">Detailed historical investigation</p><h2 id="engineering-inspector-title">Engineering Telemetry</h2><p>Inspect capability-supported machine and deck signals around this occurrence. Clues guide the starting point; browsing remains available without a clue.</p></div></div>
    {!clues?.whereToLook.length && <p className="message">No strong telemetry clue was identified for this occurrence. You can still inspect available engineering signals below.</p>}
    <section className="engineering-window-controls" aria-labelledby="engineering-window-title"><div><h3 id="engineering-window-title">Evidence window</h3>{longOccurrence && <p className="message message--warning">This occurrence is longer than the two-hour detailed telemetry window. Choose the portion to inspect.</p>}{window.message && <p className="message">{window.message}</p>}</div><div className="engineering-window-presets">{presets.map(([value, label]) => <button type="button" key={value} className={mode === value ? 'is-selected' : ''} aria-pressed={mode === value} onClick={() => { setMode(value); setCustomError('') }}>{label}</button>)}</div><div className="engineering-custom-window"><label>Custom start<input type="datetime-local" value={customStart} onChange={(event) => setCustomStart(event.target.value)} /></label><label>Custom end<input type="datetime-local" value={customEnd} onChange={(event) => setCustomEnd(event.target.value)} /></label><button type="button" onClick={applyCustom}>Apply custom</button></div>{customError && <p className="message message--warning" role="alert">{customError}</p>}<dl className="engineering-window-facts"><div><dt>Window start</dt><dd>{formatPlantDateTime(window.fromUtc)} CT</dd></div><div><dt>Window end</dt><dd>{formatPlantDateTime(window.toUtc)} CT</dd></div><div><dt>Occurrence start</dt><dd>{formatPlantDateTime(occurrence.startUtc)} CT</dd></div><div><dt>Occurrence end</dt><dd>{formatPlantDateTime(occurrence.endUtc)} CT</dd></div></dl></section>
    <section className="engineering-pins" aria-labelledby="engineering-pins-title"><div className="section-heading"><div><h3 id="engineering-pins-title">Pinned Signals</h3><p>{pins.length} of {pinMaximum} · pins remain for Previous/Next occurrence and this browser session.</p></div>{pins.length > 0 && <button type="button" className="secondary-action" onClick={onClearPins}>Clear all</button>}</div>{pinMessage && <p className="engineering-pin-message" role="status">{pinMessage}</p>}{pins.length ? <><div className="engineering-pin-chips">{pins.map((pin) => { const definition = signalDefinition(pin.canonicalId); const capability = capabilityFor(capabilityList, pin); return <span key={signalKey(pin)} className={loadable(pin) ? '' : 'is-unavailable'}>{pin.deckNumber ? `Deck ${pin.deckNumber} · ` : 'Machine · '}{definition?.friendlyName ?? pin.canonicalId}<small>{supportLabel(capability)}</small><button type="button" aria-label={`Unpin ${definition?.friendlyName ?? pin.canonicalId}`} onClick={() => onUnpin(pin)}>×</button></span> })}</div>{supportedPins.length > 0 && <EngineeringTrace identities={supportedPins} history={history} window={window} occurrence={occurrence} stopAnalysis={stopAnalysis} inspectionUtc={inspectionUtc} onInspectionTimeChange={setInspectionUtc} ariaLabel="Pinned engineering signals synchronized to the focused occurrence" />}</> : <p className="empty-state">Pin up to 12 useful signals to compare them as stacked rows on one shared time axis.</p>}</section>
    <section className="engineering-browser" aria-labelledby="engineering-browser-title"><div className="section-heading"><div><h3 id="engineering-browser-title">Signal Browser</h3><p>Only mapped, capability-applicable canonical signals are shown. Unmapped discovery candidates and topology-uncertain Deck 11/12 signals are excluded.</p></div></div>{capabilityError && <p className="message message--warning">Capability metadata is temporarily unavailable. Pinned identities are retained; Operational Analysis remains usable.</p>}{!capabilities && !capabilityError && <div className="scope-progress" role="status"><i />Loading press capabilities…</div>}{capabilities && <><div className="engineering-scope-tabs" role="tablist" aria-label="Machine and deck selection">{[null, ...Array.from({ length: 10 }, (_, index) => index + 1)].map((deckNumber) => <button type="button" role="tab" aria-selected={scopeDeck === deckNumber} className={scopeDeck === deckNumber ? 'is-selected' : ''} key={deckNumber ?? 'machine'} onClick={() => chooseScope(deckNumber)}><strong>{deckNumber === null ? 'Machine Overview' : `Deck ${deckNumber}`}</strong><small>{deckBadge(deckNumber)}</small></button>)}</div>{categories.length ? <><div className="engineering-category-tabs" aria-label="Engineering categories">{categories.map((value) => <button type="button" key={value} className={resolvedCategory === value ? 'is-selected' : ''} aria-pressed={resolvedCategory === value} onClick={() => setCategory(value)}>{ENGINEERING_CATEGORY_LABELS[value]}</button>)}</div><div className="engineering-signal-list">{orderedBrowserSignals.map((identity) => { const definition = signalDefinition(identity.canonicalId)!; const key = signalKey(identity); const capability = capabilityFor(capabilityList, identity); const record = history(identity); const clue = clueBySignal.get(key); const pinned = pins.some((pin) => signalKey(pin) === key); const supported = loadable(identity); const count = observationCount(record?.signal); return <article key={key} className={`${selectedSignal && signalKey(selectedSignal) === key ? 'is-highlighted' : ''} ${supported ? '' : 'is-unavailable'}`}><div><span>{definition.friendlyName}</span>{clue?.isClue && <b>Clue in this occurrence</b>}<code>{definition.canonicalId}</code></div><dl><div><dt>Type</dt><dd>{definition.signalType.replace('_', ' / ')}</dd></div><div><dt>Support</dt><dd>{supportLabel(capability)}</dd></div><div><dt>Evidence</dt><dd>{record?.state === 'loading' ? 'Loading…' : record?.state === 'error' ? 'Temporarily unavailable' : record?.state === 'loaded' ? `${count} observed ${definition.signalType === 'continuous' ? 'samples' : 'values/transitions'}` : supported ? 'Not yet loaded' : supportLabel(capability)}</dd></div><div><dt>Unit</dt><dd>{sourceUnit(record?.signal) ? `Source unit: ${sourceUnit(record?.signal)} — unverified` : 'Unit unverified'}</dd></div></dl>{definition.ambiguous && <p className="engineering-ambiguity">Advanced · Semantics vary by source / press family.</p>}<details><summary>Signal details</summary><dl><div><dt>Canonical ID</dt><dd>{definition.canonicalId}</dd></div><div><dt>Deck</dt><dd>{identity.deckNumber ?? 'Machine'}</dd></div><div><dt>Representation</dt><dd>{definition.signalType === 'continuous' ? 'samples' : 'changes with seed'}</dd></div><div><dt>Mapping</dt><dd>{record?.signal?.mappingStatus ?? 'Capability metadata only'}</dd></div><div><dt>Unit verification</dt><dd>{record?.signal?.canonicalUnitStatus ?? 'unverified'}</dd></div><div><dt>Raw source</dt><dd>Not exposed by the current client capability contract</dd></div></dl></details><footer><button type="button" className="secondary-action" disabled={!supported} onClick={() => setSelectedSignal(identity)}>Inspect trace</button><button type="button" disabled={!supported && !pinned} onClick={() => pinned ? onUnpin(identity) : onPin(identity)}>{pinned ? 'Unpin' : 'Pin'}</button></footer></article> })}</div></> : <p className="empty-state">No engineering category is available for this scope on {occurrence.displayName}.</p>}</>}</section>
    {selectedSignal && loadable(selectedSignal) && <section className="engineering-selected-trace"><div className="section-heading"><div><p className="eyebrow">Detailed trace</p><h3>{selectedSignal.deckNumber ? `Deck ${selectedSignal.deckNumber} · ` : 'Machine · '}{signalDefinition(selectedSignal.canonicalId)?.friendlyName}</h3><p>{selectedSignal.canonicalId}</p></div><button type="button" className="secondary-action" onClick={() => setSelectedSignal(undefined)}>Close trace</button></div><EngineeringTrace identities={[selectedSignal]} history={history} window={window} occurrence={occurrence} stopAnalysis={stopAnalysis} inspectionUtc={inspectionUtc} onInspectionTimeChange={setInspectionUtc} ariaLabel="Selected engineering signal synchronized to the focused occurrence" /></section>}
  </section>
}
