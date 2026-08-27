import { useEffect, useMemo, useState } from 'react'
import { DateTime } from 'luxon'
import { getStopIntelligenceDetail, getStopIntelligenceFleet, recordStopIntelligenceCorrection } from '../api/process-intelligence-api'
import { createCustomRange, createPresetRange, defaultCustomValues, formatPlantDateTimeCt, formatSelectedRange, PLANT_TIME_ZONE, RangeValidationError, type SelectedRange } from '../time-ranges'
import type { RadiusPressKey } from '../types/api'
import type { TimedNumericSample } from '../types/evidence'
import type { ChangeoverAction, StopClassification, StopEvidenceItem, StopFleetEpisode, StopFleetPressSummary, StopIntelligenceCorrection, StopIntelligenceDetail, StopIntelligenceFleetReport, StopOperatorState, StopPredictedState } from '../types/stop-intelligence'
import { SynchronizedTimeline, type TimelineIntervalItem, type TimelineNumericTrack } from './SynchronizedTimeline'
import { actionSignalLabel, actionSignalTrackKey, selectedActionSignalContext, StopSynchronizedTimeline, stopActionKey, type ActionSignalContext } from './StopIntelligenceTimeline'
import { StopEvidenceChronology } from './StopEvidenceChronology'

export { buildStopTimelineModel, buildSelectedSignalTracks, selectedSignalSnapshots, stopInspectionSnapshot } from './StopIntelligenceTimeline'

const MAX_RANGE_MS = 72 * 60 * 60_000
const configuredPresses: RadiusPressKey[] = ['press3', 'press5', 'press6', 'press7', 'press8', 'press9', 'press10', 'press11', 'press12', 'press13', 'press14', 'press15']
export type StopFilter = 'ALL' | StopClassification
export const STOP_CLASSIFICATION_FILTERS: Array<{ value: StopFilter; label: string }> = [
  { value: 'ALL', label: 'All' }, { value: 'CHANGEOVER', label: 'Changeover' }, { value: 'DOWNTIME', label: 'Downtime' }, { value: 'UNCERTAIN', label: 'Uncertain' }, { value: 'IGNORE_BAD_DATA', label: 'Bad data' },
]

interface Props { range: SelectedRange; selectedPress?: RadiusPressKey; onRangeChange(range: SelectedRange): void; onPressChange(pressKey: RadiusPressKey | undefined): void }

const localInput = (utc: string) => DateTime.fromISO(utc, { zone: 'utc' }).setZone(PLANT_TIME_ZONE).toFormat("yyyy-MM-dd'T'HH:mm")
export function createStop72HourRange(now: DateTime = DateTime.now()): SelectedRange {
  const to = now.toUTC(); const from = to.minus({ hours: 72 })
  return { preset: 'custom', fromUtc: from.toISO()!, toUtc: to.toISO()!, customFromLocal: from.setZone(PLANT_TIME_ZONE).toFormat("yyyy-MM-dd'T'HH:mm"), customToLocal: to.setZone(PLANT_TIME_ZONE).toFormat("yyyy-MM-dd'T'HH:mm") }
}
export function shiftStopRange(range: SelectedRange, direction: -1 | 1): SelectedRange {
  const span = Date.parse(range.toUtc) - Date.parse(range.fromUtc)
  const fromUtc = new Date(Date.parse(range.fromUtc) + span * direction).toISOString(); const toUtc = new Date(Date.parse(range.toUtc) + span * direction).toISOString()
  return { preset: 'custom', fromUtc, toUtc, customFromLocal: localInput(fromUtc), customToLocal: localInput(toUtc) }
}
export function extendStopRangeLookback(range: SelectedRange, hours = 1): SelectedRange {
  const to = Date.parse(range.toUtc); const from = Date.parse(range.fromUtc)
  const requestedHours = Number.isFinite(hours) && hours > 0 ? hours : 1
  const fromUtc = new Date(Math.max(from - requestedHours * 60 * 60_000, to - MAX_RANGE_MS)).toISOString()
  return { preset: 'custom', fromUtc, toUtc: range.toUtc, customFromLocal: localInput(fromUtc), customToLocal: localInput(range.toUtc) }
}
export function extendStopRangeForward(range: SelectedRange, hours = 1, now: DateTime = DateTime.now()): SelectedRange {
  const to = Date.parse(range.toUtc); const from = Date.parse(range.fromUtc)
  const requestedHours = Number.isFinite(hours) && hours > 0 ? hours : 1
  const toUtc = new Date(Math.max(to, Math.min(to + requestedHours * 60 * 60_000, from + MAX_RANGE_MS, now.toMillis()))).toISOString()
  return { preset: 'custom', fromUtc: range.fromUtc, toUtc, customFromLocal: localInput(range.fromUtc), customToLocal: localInput(toUtc) }
}
export function adjacentStopPress(current: RadiusPressKey, direction: -1 | 1): RadiusPressKey {
  const index = Math.max(0, configuredPresses.indexOf(current)); return configuredPresses[(index + direction + configuredPresses.length) % configuredPresses.length]!
}

function StopRangeControls({ range, onChange }: { range: SelectedRange; onChange(range: SelectedRange): void }) {
  const defaults = defaultCustomValues(); const [customFrom, setCustomFrom] = useState(range.customFromLocal ?? defaults.from); const [customTo, setCustomTo] = useState(range.customToLocal ?? defaults.to)
  const [customOpen, setCustomOpen] = useState(false); const [error, setError] = useState<string>()
  const is72Hours = Math.abs(Date.parse(range.toUtc) - Date.parse(range.fromUtc) - MAX_RANGE_MS) < 1_000
  useEffect(() => { setCustomFrom(range.customFromLocal ?? localInput(range.fromUtc)); setCustomTo(range.customToLocal ?? localInput(range.toUtc)) }, [range.fromUtc, range.toUtc, range.customFromLocal, range.customToLocal])
  const choose = (next: SelectedRange) => { setError(undefined); setCustomOpen(false); onChange(next) }
  const applyCustom = () => { try { const next = createCustomRange(customFrom, customTo); if (Date.parse(next.toUtc) - Date.parse(next.fromUtc) > MAX_RANGE_MS) throw new RangeValidationError('Stop Intelligence supports a maximum 72-hour range.'); choose(next) } catch (cause) { setError(cause instanceof RangeValidationError ? cause.message : 'The custom range is invalid.') } }
  return <section className="si-range" aria-label="Stop Intelligence time range"><div className="si-range__presets" role="group" aria-label="Stop Intelligence time range choices"><button type="button" className={range.preset === 'today' ? 'active' : ''} onClick={() => choose(createPresetRange('today'))}>Today</button><button type="button" className={range.preset === 'last24' ? 'active' : ''} onClick={() => choose(createPresetRange('last24'))}>Last 24 hours</button><button type="button" className={is72Hours ? 'active' : ''} onClick={() => choose(createStop72HourRange())}>Last 72 hours</button><button type="button" className={customOpen ? 'active' : ''} aria-expanded={customOpen} onClick={() => { setCustomOpen((value) => !value); setError(undefined) }}>Custom</button></div><div className="si-range__window"><button type="button" aria-label="Previous time window" title="Previous time window" onClick={() => choose(shiftStopRange(range, -1))}>←</button><span><strong>{is72Hours ? '72-hour window' : range.preset === 'today' ? 'Today' : range.preset === 'last24' ? 'Last 24 hours' : 'Custom window'}</strong><small>{formatSelectedRange(range)}</small></span><button type="button" aria-label="Next time window" title="Next time window" disabled={Date.parse(range.toUtc) >= Date.now()} onClick={() => choose(shiftStopRange(range, 1))}>→</button></div>{customOpen && <div className="si-range__custom"><label><span>From · CT</span><input type="datetime-local" value={customFrom} onChange={(event) => setCustomFrom(event.target.value)}/></label><label><span>To · CT</span><input type="datetime-local" value={customTo} onChange={(event) => setCustomTo(event.target.value)}/></label><button type="button" onClick={applyCustom}>Apply</button></div>}{error && <p role="alert">{error}</p>}</section>
}

const goodQuality = (value: string) => ['good', 'true'].includes(value.trim().toLowerCase())
const classificationLabel = (value: StopClassification) => value === 'IGNORE_BAD_DATA' ? 'Bad / incomplete data' : value.replaceAll('_', ' ')
const words = (value: string) => value.replaceAll('_', ' ').toLowerCase().replace(/^./, (character) => character.toUpperCase())
const formatUtc = (value: string | null) => value ? formatPlantDateTimeCt(value) : 'Open / not observed'
export const formatStopDuration = (seconds: number) => seconds >= 3600 ? `${Math.floor(seconds / 3600)}h ${Math.round(seconds % 3600 / 60)}m` : seconds >= 60 ? `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s` : `${Math.round(seconds)}s`
export const filterStopEpisodes = (episodes: StopFleetEpisode[], filter: StopFilter) => filter === 'ALL' ? episodes : episodes.filter((episode) => episode.classification === filter)

export function stopDecisionSummary(detail: StopIntelligenceDetail) {
  const order = ['STRONG', 'MEDIUM', 'WEAK', 'UNUSABLE', 'UNAVAILABLE']
  const identity = detail.stop.identities.filter((item) => item.changed).sort((left, right) => order.indexOf(left.usefulness) - order.indexOf(right.usefulness))[0]
  return { classification: detail.stop.classification, confidence: detail.stop.confidence, identity, radiusProductionConflict: detail.stop.radiusAlignment === 'CONTRADICTORY' && detail.stop.radius.states.some((state) => state.isProduction) }
}

export function stopFleetTotals(presses: StopFleetPressSummary[]) {
  return presses.reduce((total, press) => ({ stops: total.stops + press.stopCount, physicalSeconds: total.physicalSeconds + press.totalPhysicalStopSeconds, changeovers: total.changeovers + press.changeoverCount, downtime: total.downtime + press.downtimeCount, uncertain: total.uncertain + press.uncertainCount, badData: total.badData + press.badDataCount }), { stops: 0, physicalSeconds: 0, changeovers: 0, downtime: 0, uncertain: 0, badData: 0 })
}

function ClassificationBadge({ value, confidence }: { value: StopClassification; confidence?: string }) {
  return <span className={`si-classification si-classification--${value.toLowerCase()}`}>{classificationLabel(value)}{confidence ? <small>{confidence}</small> : null}</span>
}

export interface FleetBandSegment extends TimelineIntervalItem {
  kind: 'running' | 'unknown' | 'episode'
  episode?: StopFleetEpisode
}

const within = (at: number, fromUtc: string, toUtc: string) => Date.parse(fromUtc) <= at && Date.parse(toUtc) > at
const localTime = (value: string) => formatPlantDateTimeCt(value)
const exactDuration = (seconds: number) => { const rounded = Math.max(0, Math.round(seconds)); const hours = Math.floor(rounded / 3600); const minutes = Math.floor(rounded % 3600 / 60); const remainder = rounded % 60; return `${hours ? `${hours}h ` : ''}${minutes || hours ? `${minutes}m ` : ''}${remainder}s` }

export function buildFleetBandSegments(press: StopFleetPressSummary, range: Pick<SelectedRange, 'fromUtc' | 'toUtc'>, filter: StopFilter, selectedId?: string): FleetBandSegment[] {
  const from = Date.parse(range.fromUtc); const to = Date.parse(range.toUtc)
  const boundaries = new Set<number>([from, to])
  for (const episode of press.episodes) boundaries.add(Math.max(from, Date.parse(episode.startAt))).add(Math.min(to, Date.parse(episode.endAt ?? range.toUtc)))
  for (const interval of press.speedContext.unknownIntervals) boundaries.add(Math.max(from, Date.parse(interval.fromUtc))).add(Math.min(to, Date.parse(interval.toUtc)))
  const ordered = [...boundaries].filter((value) => Number.isFinite(value) && value >= from && value <= to).sort((left, right) => left - right)
  return ordered.slice(0, -1).flatMap<FleetBandSegment>((start, index): FleetBandSegment[] => {
    const end = ordered[index + 1]!; if (end <= start) return []
    const midpoint = start + (end - start) / 2
    const unknown = press.speedContext.unknownIntervals.find((interval) => within(midpoint, interval.fromUtc, interval.toUtc))
    const episode = press.episodes.find((item) => within(midpoint, item.startAt, item.endAt ?? range.toUtc))
    const startUtc = new Date(start).toISOString(); const endUtc = new Date(end).toISOString()
    if (unknown) {
      const emphasize = press.pressKey === 'press15'
      const label = emphasize ? words(unknown.state) : 'Known offline context'
      return [{ id: `fleet-unknown:${start}:${end}`, startUtc, endUtc, label, kind: 'unknown' as const, className: `si-fleet-state ${emphasize ? 'si-fleet-state--unknown' : 'si-fleet-state--known-offline'}`, unavailable: emphasize, details: `${label}\n${localTime(startUtc)} → ${localTime(endUtc)}\n${exactDuration((end - start) / 1_000)}` }]
    }
    if (episode) return [{ id: `fleet:${episode.stopId}:${start}`, startUtc, endUtc, label: classificationLabel(episode.classification), kind: 'episode' as const, episode, className: `si-fleet-state si-fleet-state--${episode.classification.toLowerCase()} ${filter !== 'ALL' && filter !== episode.classification ? 'is-filter-muted' : ''} ${selectedId === episode.stopId ? 'is-selected' : ''}`.trim(), details: `${press.displayName}\n${classificationLabel(episode.classification)} · ${episode.confidence}\n${episode.leftCensored ? 'Start before available evidence' : `From ${localTime(episode.startAt)}`}\n${episode.rightCensored ? 'End after available evidence' : `To ${episode.endAt ? localTime(episode.endAt) : 'Open'}`}\n${episode.leftCensored || episode.rightCensored ? 'At least ' : ''}${exactDuration(episode.physicalDurationSeconds)}` }]
    return [{ id: `fleet-running:${start}:${end}`, startUtc, endUtc, label: 'Good Run', kind: 'running' as const, className: 'si-fleet-state si-fleet-state--running', details: `Good Run context\n${localTime(startUtc)} → ${localTime(endUtc)}\n${exactDuration((end - start) / 1_000)}` }]
  })
}

export type OperatorReviewedState = StopPredictedState | StopOperatorState
export type OperatorReviewStatus = 'predicted' | 'confirmed' | 'changed'
export interface OperatorReviewedSegment extends TimelineIntervalItem { state: OperatorReviewedState; corrected: boolean; reviewStatus: OperatorReviewStatus; sourceSegmentIds: string[] }
export const predictedFleetState = (segment: FleetBandSegment): StopPredictedState => segment.episode?.classification ?? (segment.kind === 'running' ? 'OBSERVABLE_NON_STOP' : 'UNKNOWN')
const reviewedStateLabel = (state: OperatorReviewedState) => state === 'GOOD_PRODUCTION' ? 'Good production' : state === 'OBSERVABLE_NON_STOP' ? 'Good Run' : state === 'IGNORE_BAD_DATA' ? 'Bad / incomplete data' : words(state)
const reviewedStateClass = (state: OperatorReviewedState) => state.toLowerCase().replaceAll('_', '-')
const correctionConfirmsPrediction = (predicted: StopPredictedState, corrected: StopOperatorState) => corrected === predicted || predicted === 'OBSERVABLE_NON_STOP' && corrected === 'GOOD_PRODUCTION'

export function buildOperatorReviewedSegments(segments: FleetBandSegment[], corrections: StopIntelligenceCorrection[]): OperatorReviewedSegment[] {
  if (!segments.length) return []
  const operatorDecisions = corrections.filter((item) => item.correctedState !== 'UNCERTAIN')
  const from = Date.parse(segments[0]!.startUtc); const to = Date.parse(segments.at(-1)!.endUtc)
  const boundaries = new Set<number>(segments.flatMap((segment) => [Date.parse(segment.startUtc), Date.parse(segment.endUtc)]))
  for (const correction of operatorDecisions) {
    const start = Math.max(from, Date.parse(correction.fromUtc)); const end = Math.min(to, Date.parse(correction.toUtc))
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) { boundaries.add(start); boundaries.add(end) }
  }
  const ordered = [...boundaries].sort((left, right) => left - right)
  const slices = ordered.slice(0, -1).flatMap<OperatorReviewedSegment>((start, index) => {
    const end = ordered[index + 1]!; if (end <= start) return []
    const midpoint = start + (end - start) / 2
    const source = segments.find((segment) => within(midpoint, segment.startUtc, segment.endUtc)); if (!source) return []
    const correction = operatorDecisions.filter((item) => Date.parse(item.fromUtc) <= midpoint && Date.parse(item.toUtc) > midpoint).sort((left, right) => Date.parse(right.createdAtUtc) - Date.parse(left.createdAtUtc))[0]
    const state: OperatorReviewedState = correction?.correctedState ?? predictedFleetState(source)
    const reviewStatus: OperatorReviewStatus = !correction ? 'predicted' : correctionConfirmsPrediction(correction.predictedState, correction.correctedState) ? 'confirmed' : 'changed'
    const startUtc = new Date(start).toISOString(); const endUtc = new Date(end).toISOString()
    const reviewLabel = reviewStatus === 'confirmed' ? '✓ Confirmed' : reviewStatus === 'changed' ? '◆ Reviewed change' : 'Not reviewed'
    return [{ id: `reviewed:${start}:${end}`, startUtc, endUtc, state, corrected: Boolean(correction), reviewStatus, sourceSegmentIds: [source.id], label: correction ? `${reviewLabel} · ${reviewedStateLabel(state)}` : reviewedStateLabel(state), className: `si-reviewed-state si-reviewed-state--${reviewedStateClass(state)} ${correction ? `is-operator-corrected is-operator-${reviewStatus}` : 'is-predicted'}`, details: `${reviewedStateLabel(state)}\n${reviewStatus === 'confirmed' ? `✓ Operator confirmed the ${reviewedStateLabel(correction!.predictedState)} prediction` : reviewStatus === 'changed' ? `◆ Operator changed the prediction from ${reviewedStateLabel(correction!.predictedState)}` : 'Not operator reviewed · mirrors the model prediction'}\n${localTime(startUtc)} → ${localTime(endUtc)}\n${exactDuration((end - start) / 1_000)}` }]
  })
  const merged: OperatorReviewedSegment[] = []
  for (const slice of slices) {
    const previous = merged.at(-1)
    if (previous && previous.state === slice.state && previous.reviewStatus === slice.reviewStatus && previous.endUtc === slice.startUtc) {
      previous.endUtc = slice.endUtc; previous.sourceSegmentIds.push(...slice.sourceSegmentIds)
      previous.id = `reviewed:${Date.parse(previous.startUtc)}:${Date.parse(previous.endUtc)}`
      previous.details = `${reviewedStateLabel(previous.state)}\n${previous.reviewStatus === 'confirmed' ? '✓ Operator-confirmed prediction' : previous.reviewStatus === 'changed' ? '◆ Operator-reviewed change' : 'Not operator reviewed · mirrors the model prediction'}\n${localTime(previous.startUtc)} → ${localTime(previous.endUtc)}\n${exactDuration((Date.parse(previous.endUtc) - Date.parse(previous.startUtc)) / 1_000)}`
    } else merged.push({ ...slice })
  }
  return merged
}

export function latestOperatorDecisionForSegment(segment: FleetBandSegment, corrections: StopIntelligenceCorrection[]): StopIntelligenceCorrection | undefined {
  const midpoint = Date.parse(segment.startUtc) + (Date.parse(segment.endUtc) - Date.parse(segment.startUtc)) / 2
  const overlapping = corrections.filter((item) => item.correctedState !== 'UNCERTAIN' && Date.parse(item.fromUtc) < Date.parse(segment.endUtc) && Date.parse(item.toUtc) > Date.parse(segment.startUtc))
  const coveringMidpoint = overlapping.filter((item) => Date.parse(item.fromUtc) <= midpoint && Date.parse(item.toUtc) > midpoint)
  return (coveringMidpoint.length ? coveringMidpoint : overlapping).sort((left, right) => Date.parse(right.createdAtUtc) - Date.parse(left.createdAtUtc))[0]
}

export function buildFleetSpeedTrack(press: StopFleetPressSummary): TimelineNumericTrack {
  const samples: TimedNumericSample[] = press.speedContext.observations.flatMap((observation) => typeof observation.speed !== 'number' || !goodQuality(observation.qualityState) ? [] : [{ observedAtUtc: observation.atUtc, receivedAtUtc: observation.atUtc, sourceTimestampUtc: observation.atUtc, qualityState: observation.qualityState, valueKind: 'numeric' as const, value: observation.speed }]).sort((left, right) => Date.parse(left.observedAtUtc) - Date.parse(right.observedAtUtc))
  const markers: NonNullable<TimelineNumericTrack['markers']> = press.radiusContext.states.flatMap((state, index) => {
    if (state.kind !== 'radius') return []
    const previous = press.radiusContext.states[index - 1]
    if (previous?.kind === 'radius' && previous.eventType === state.eventType && previous.statusCode === state.statusCode) return []
    const code = `${state.eventType ?? '—'}${state.statusCode ?? '—'}`
    const speed = samples.filter((sample) => Date.parse(sample.observedAtUtc) <= Date.parse(state.startUtc)).at(-1)?.value
    const speedLabel = speed === undefined ? 'Unknown' : `${Math.round(speed * 100) / 100}${press.speedContext.unit ? ` ${press.speedContext.unit}` : ''}`
    return [{ atUtc: state.startUtc, label: code, kind: 'radius-change' as const, color: String(radiusCodeStyle(state.eventType, state.statusCode)?.background ?? '#65747c'), value: speed ?? null, details: `Code ${code}\n${state.statusDescription ?? 'Radius description unavailable'}\nStart ${localTime(state.startUtc)}\nEnd ${localTime(state.endUtc)}\nDuration ${exactDuration((Date.parse(state.endUtc) - Date.parse(state.startUtc)) / 1_000)}\nActual speed ${speedLabel}` }]
  })
  return { id: `fleet-speed:${press.pressKey}`, label: 'Actual speed', unit: press.speedContext.unit, samples, connectObservedGaps: true, interpolation: 'step', holdLastObservation: true, showCursorValue: true, markers, breakIntervals: press.speedContext.unknownIntervals, referenceLines: [{ value: press.speedContext.stopThreshold, label: `Stop < ${press.speedContext.stopThreshold}` }, { value: press.speedContext.recoveryThreshold, label: `Recovery ≥ ${press.speedContext.recoveryThreshold}` }], unavailableLabel: 'No good observed speed samples' }
}

export function buildFleetRollLengthTrack(press: StopFleetPressSummary): TimelineNumericTrack {
  const context = press.rollLengthContext
  const samples: TimedNumericSample[] = (context?.observations ?? []).flatMap((observation) => !Number.isFinite(observation.value) || !goodQuality(observation.qualityState) ? [] : [{ observedAtUtc: observation.atUtc, receivedAtUtc: observation.atUtc, sourceTimestampUtc: observation.atUtc, qualityState: observation.qualityState, valueKind: 'numeric' as const, value: observation.value }]).sort((left, right) => Date.parse(left.observedAtUtc) - Date.parse(right.observedAtUtc))
  return { id: `fleet-roll-length:${press.pressKey}`, label: 'Roll length (actual)', unit: context?.unit ?? null, samples, connectObservedGaps: true, interpolation: 'linear', holdLastObservation: false, showCursorValue: true, breakIntervals: press.speedContext.unknownIntervals, unavailableLabel: context ? 'No good observed roll-length samples' : 'Canonical roll length is unavailable on this press' }
}

export const shouldEmphasizeAvailability = (press: StopFleetPressSummary) => press.pressKey === 'press15' && press.dataAvailabilityWarning

const stableColorHash = (value: string) => [...value].reduce((hash, character) => (hash * 31 + character.charCodeAt(0)) >>> 0, 2166136261)
export function radiusCodeStyle(eventType: string | null, statusCode: string | null): TimelineIntervalItem['style'] {
  const exactCode = `${eventType ?? 'UNKNOWN'}:${statusCode ?? 'UNKNOWN'}`.toUpperCase()
  const family = (eventType ?? '').trim().charAt(0).toUpperCase()
  const [baseHue, saturation] = family === 'G' ? [142, 58] : family === 'M' ? [212, 64] : family === 'B' ? [29, 72] : family === 'S' ? [278, 52] : [188, 42]
  const hash = stableColorHash(exactCode)
  const hue = baseHue + hash % 13 - 6
  const lightness = 33 + Math.floor(hash / 13) % 15
  return { background: `hsl(${hue} ${saturation}% ${lightness}%)`, color: '#fff' }
}

const identityPalettes = {
  'production.order': ['#5147a8', '#247686', '#9a572e', '#77477f', '#2d7059', '#87513f', '#3d638f', '#876b25'],
  'production.recipe': ['#984970', '#3b68a3', '#9b681e', '#4d7938', '#65509e', '#a04c47', '#287274', '#7d4f92'],
} as const
export function identityValueStyle(canonicalId: 'production.order' | 'production.recipe', ordinal: number): TimelineIntervalItem['style'] {
  const palette = identityPalettes[canonicalId]
  return { background: palette[ordinal % palette.length], color: '#fff' }
}

function fleetRadiusIntervals(press: StopFleetPressSummary): TimelineIntervalItem[] {
  return press.radiusContext.states.map((state, index) => {
    const value = state.kind === 'offline' ? 'OFFLINE' : `${state.eventType ?? '—'}${state.statusCode ?? '—'}`
    const family = (state.eventType ?? 'other').trim().charAt(0).toLowerCase() || 'other'
    const labelLane = index % 2 === 0 ? 'above' : 'below'
    return { id: `fleet-radius:${index}`, startUtc: state.startUtc, endUtc: state.endUtc, label: value, className: state.kind === 'offline' ? `si-fleet-radius si-fleet-radius--offline si-fleet-radius--${labelLane}` : `si-fleet-radius si-fleet-radius--${family} si-fleet-radius--${labelLane}`, style: state.kind === 'offline' ? undefined : radiusCodeStyle(state.eventType, state.statusCode), unavailable: state.kind === 'offline', details: `Code ${value}\n${state.statusDescription ?? 'Radius description unavailable'}\nStart ${localTime(state.startUtc)}\nEnd ${localTime(state.endUtc)}` }
  })
}

function fleetIdentityIntervals(press: StopFleetPressSummary, canonicalId: 'production.order' | 'production.recipe', range: Pick<SelectedRange, 'fromUtc' | 'toUtc'>): TimelineIntervalItem[] {
  const series = press.identityContext.find((item) => item.canonicalId === canonicalId)
  if (!series) return []
  const observations = [...series.observations].sort((left, right) => Date.parse(left.atUtc) - Date.parse(right.atUtc))
  const colorByValue = new Map<string, number>()
  for (const observation of observations) { const value = String(observation.value); if (!colorByValue.has(value)) colorByValue.set(value, colorByValue.size) }
  return observations.flatMap((observation, index) => {
    const start = Math.max(Date.parse(range.fromUtc), Date.parse(observation.atUtc)); const end = Math.min(Date.parse(range.toUtc), Date.parse(observations[index + 1]?.atUtc ?? range.toUtc))
    if (end <= start) return []
    const value = String(observation.value)
    return [{ id: `fleet-identity:${canonicalId}:${index}`, startUtc: new Date(start).toISOString(), endUtc: new Date(end).toISOString(), label: value, className: `si-fleet-identity si-fleet-identity--${canonicalId.split('.').at(-1)}`, style: identityValueStyle(canonicalId, colorByValue.get(value)!), details: `${canonicalId}\n${value}\n${localTime(new Date(start).toISOString())} → ${localTime(new Date(end).toISOString())}\n${series.rawIdentity ?? 'Raw identity unavailable'}` }]
  })
}

export function fleetHoverSnapshot(press: StopFleetPressSummary, segments: FleetBandSegment[], atUtc: string) {
  const at = Date.parse(atUtc); const segment = segments.find((item) => within(at, item.startUtc, item.endUtc)) ?? segments.at(-1)
  const unknown = segment?.kind === 'unknown'
  const nearestSpeed = unknown ? undefined : press.speedContext.observations.filter((item) => typeof item.speed === 'number' && goodQuality(item.qualityState)).sort((left, right) => Math.abs(Date.parse(left.atUtc) - at) - Math.abs(Date.parse(right.atUtc) - at))[0]
  const radius = press.radiusContext.states.find((item) => within(at, item.startUtc, item.endUtc))
  const identity = (canonicalId: 'production.order' | 'production.recipe') => press.identityContext.find((item) => item.canonicalId === canonicalId)?.observations.filter((item) => Date.parse(item.atUtc) <= at).sort((left, right) => Date.parse(left.atUtc) - Date.parse(right.atUtc)).at(-1)
  return { segment, nearestSpeed, radius, order: identity('production.order'), recipe: identity('production.recipe') }
}

export function investigationSegmentForReviewedInterval(reviewed: OperatorReviewedSegment, segments: FleetBandSegment[]): FleetBandSegment | undefined {
  if (reviewed.state !== 'CHANGEOVER') return undefined
  const sourceIds = new Set(reviewed.sourceSegmentIds)
  const direct = segments.find((segment) => sourceIds.has(segment.id) && segment.episode)
  if (direct) return direct
  const start = Date.parse(reviewed.startUtc); const end = Date.parse(reviewed.endUtc)
  return segments.find((segment) => segment.episode && Math.abs(Date.parse(segment.endUtc) - start) <= 1_000)
    ?? segments.find((segment) => segment.episode && Math.abs(Date.parse(segment.startUtc) - end) <= 1_000)
}

function FleetTimeline({ press, range, filter, selectedId, corrections, onSelectSegment }: { press: StopFleetPressSummary; range: Pick<SelectedRange, 'fromUtc' | 'toUtc'>; filter: StopFilter; selectedId?: string; corrections: StopIntelligenceCorrection[]; onSelectSegment(segment: FleetBandSegment, intent?: 'review' | 'investigate'): void }) {
  const segments = useMemo(() => buildFleetBandSegments(press, range, filter, selectedId), [press, range.fromUtc, range.toUtc, filter, selectedId]); const speedTrack = useMemo(() => buildFleetSpeedTrack(press), [press]); const rollLengthTrack = useMemo(() => buildFleetRollLengthTrack(press), [press])
  const reviewed = useMemo(() => buildOperatorReviewedSegments(segments, corrections), [segments, corrections])
  const baseTracks = [{ id: `fleet-order:${press.pressKey}`, label: 'Order', intervals: fleetIdentityIntervals(press, 'production.order', range), unavailableLabel: 'Order unavailable', className: 'si-fleet-track si-fleet-track--identity si-fleet-track--order' }, { id: `fleet-recipe:${press.pressKey}`, label: 'Recipe', intervals: fleetIdentityIntervals(press, 'production.recipe', range), unavailableLabel: 'Recipe unavailable', className: 'si-fleet-track si-fleet-track--identity si-fleet-track--recipe' }, { id: `fleet-radius:${press.pressKey}`, label: 'Raw Radius', intervals: fleetRadiusIntervals(press), unavailableLabel: press.radiusContext.reason, className: 'si-fleet-track si-fleet-track--radius', alwaysShowLabels: true }, { id: `fleet-state:${press.pressKey}`, label: 'Stop State · predicted', intervals: segments, className: 'si-fleet-track si-fleet-track--state' }]
  const reviewedTrack = { id: `fleet-reviewed:${press.pressKey}`, label: 'Operator-reviewed state · ✓ confirmed / ◆ changed', intervals: reviewed.map((segment) => segment.state === 'CHANGEOVER' && investigationSegmentForReviewedInterval(segment, segments) ? { ...segment, className: `${segment.className ?? ''} is-investigable`.trim(), details: `${segment.details ?? ''}\nClick to investigate this physical stop.` } : segment), className: 'si-fleet-track si-fleet-track--reviewed', alwaysShowLabels: true }
  const intervalTracks = [...baseTracks, reviewedTrack]
  const trackOrder = [`interval:fleet-order:${press.pressKey}`, `interval:fleet-recipe:${press.pressKey}`, `numeric:${rollLengthTrack.id}`, `interval:fleet-radius:${press.pressKey}`, `interval:fleet-state:${press.pressKey}`, `numeric:${speedTrack.id}`, `interval:${reviewedTrack.id}`]
  return <div className="si-fleet-synchronized"><SynchronizedTimeline fromUtc={range.fromUtc} toUtc={range.toUtc} intervalTracks={intervalTracks} numericTracks={[rollLengthTrack, speedTrack]} trackOrder={trackOrder} onSelect={(item, track) => { if (track.id.startsWith('fleet-state:')) { const segment = segments.find((candidate) => candidate.id === item.id); if (segment) onSelectSegment(segment); return } if (track.id.startsWith('fleet-reviewed:')) { const reviewedSegment = reviewed.find((candidate) => candidate.id === item.id); const segment = reviewedSegment ? investigationSegmentForReviewedInterval(reviewedSegment, segments) : undefined; if (segment) onSelectSegment(segment, 'investigate') } }} minimumCanvasWidth={920} ariaLabel={`${press.displayName} Order, Recipe, actual roll length, raw Radius, predicted Stop State, actual-speed, and always-visible operator-reviewed state timeline`}/></div>
}

function FleetRow({ press, range, filter, selectedId, corrections, onSelectSegment, onRangeChange }: { press: StopFleetPressSummary; range: SelectedRange; filter: StopFilter; selectedId?: string; corrections: StopIntelligenceCorrection[]; onSelectSegment(segment: FleetBandSegment, intent?: 'review' | 'investigate'): void; onRangeChange(range: SelectedRange): void }) {
  const rangeAtMaximum = Date.parse(range.toUtc) - Date.parse(range.fromUtc) >= MAX_RANGE_MS - 1_000
  const rangeEndsNow = Date.parse(range.toUtc) >= Date.now() - 1_000
  return <article className="si-press-row"><header><div><span className="eyebrow">Canonical speed · {press.pressKey === 'press14' && press.telemetryEvidenceState !== 'AVAILABLE' ? 'known offline context' : press.telemetryEvidenceState.replaceAll('_', ' ')}</span><h2>{press.displayName}</h2></div>{shouldEmphasizeAvailability(press) && <span className="si-availability-warning" title={press.warningReason ?? undefined}>Evidence warning</span>}</header><div className="si-press-metrics" aria-label={`${press.displayName} stop metrics`}><span><small>Stops</small><strong>{press.stopCount}</strong></span><span className="changeover"><small>Changeover</small><strong>{press.changeoverCount}</strong></span><span className="downtime"><small>Downtime</small><strong>{press.downtimeCount}</strong></span><span className="uncertain"><small>Uncertain</small><strong>{press.uncertainCount}</strong></span><span><small>Total stop time</small><strong>{formatStopDuration(press.totalPhysicalStopSeconds)}</strong></span>{press.badDataCount > 0 && <span className="bad-data"><small>Bad data</small><strong>{press.badDataCount}</strong></span>}</div><div className="si-range-extension-controls" aria-label="Extend the current Stop Intelligence timeline"><div className="si-lookback-control"><button type="button" disabled={rangeAtMaximum} onClick={() => onRangeChange(extendStopRangeLookback(range))} title={rangeAtMaximum ? 'The timeline already spans the 72-hour maximum.' : 'Add one earlier hour without changing the end time.'}><b aria-hidden="true">-1h</b><span><strong>Look back +1 hour</strong><small>Start moves earlier; end stays fixed</small></span></button></div><div className="si-lookforward-control"><button type="button" disabled={rangeAtMaximum || rangeEndsNow} onClick={() => onRangeChange(extendStopRangeForward(range))} title={rangeAtMaximum ? 'The timeline already spans the 72-hour maximum.' : rangeEndsNow ? 'The timeline already ends at the current time.' : 'Add one later hour without changing the start time.'}><span><strong>Look forward +1 hour</strong><small>Start stays fixed; end moves later</small></span><b aria-hidden="true">+1h</b></button></div></div><FleetTimeline press={press} range={range} filter={filter} selectedId={selectedId} corrections={corrections} onSelectSegment={onSelectSegment}/></article>
}

export interface SpeedChartModel { paths: string[]; unknown: Array<{ x: number; width: number; state: string }>; x(atUtc: string): number; y(speed: number): number; maximum: number }

// Kept as a deterministic regression seam for unknown-gap handling; the UI now uses SynchronizedTimeline.
export function buildStopSpeedChartModel(detail: StopIntelligenceDetail): SpeedChartModel {
  const context = detail.speedContext; const from = Date.parse(context.fromUtc); const span = Math.max(1, Date.parse(context.toUtc) - from)
  const numericMaximum = Math.max(context.recoveryThreshold * 1.2, ...context.observations.flatMap((item) => typeof item.speed === 'number' && Number.isFinite(item.speed) ? [item.speed] : []), 1)
  const x = (atUtc: string) => 28 + (Date.parse(atUtc) - from) / span * 744; const y = (speed: number) => 188 - Math.max(0, speed) / numericMaximum * 150
  const unknown = context.unknownIntervals.map((interval) => ({ x: x(interval.fromUtc), width: Math.max(2, x(interval.toUtc) - x(interval.fromUtc)), state: interval.state }))
  const overlapsUnknown = (left: string, right: string) => context.unknownIntervals.some((interval) => Date.parse(interval.fromUtc) < Date.parse(right) && Date.parse(interval.toUtc) > Date.parse(left))
  const paths: string[] = []; let current = ''
  context.observations.forEach((point, index) => { const previous = context.observations[index - 1]; const valid = typeof point.speed === 'number' && Number.isFinite(point.speed) && goodQuality(point.qualityState); const connected = valid && previous && typeof previous.speed === 'number' && Number.isFinite(previous.speed) && goodQuality(previous.qualityState) && !overlapsUnknown(previous.atUtc, point.atUtc); if (!valid) { if (current) paths.push(current); current = ''; return }; const command = `${connected && current ? 'L' : 'M'}${x(point.atUtc).toFixed(1)},${y(point.speed!).toFixed(1)}`; if (!connected && current) paths.push(current); current = command })
  if (current) paths.push(current)
  return { paths, unknown, x, y, maximum: numericMaximum }
}

function EvidenceList({ title, kind, items, missing }: { title: string; kind: 'supporting' | 'conflicting' | 'missing'; items?: StopEvidenceItem[]; missing?: string[] }) {
  const rows = items ?? (missing ?? []).map((code) => ({ code, explanation: words(code), category: 'AVAILABILITY', strength: 'SUPPORTING', canonicalIds: [], fromUtc: null, toUtc: null } as StopEvidenceItem))
  return <article className={`si-evidence-list si-evidence-list--${kind}`}><h3>{title}</h3>{rows.length ? rows.map((item) => <div key={`${kind}-${item.code}`}><i aria-hidden="true">{kind === 'supporting' ? '✓' : kind === 'conflicting' ? '!' : '○'}</i><span><strong>{item.explanation}</strong><small>{item.code} · {item.category} · {item.strength}{item.canonicalIds.length ? ` · ${item.canonicalIds.join(', ')}` : ''}</small></span></div>) : <p>None reported by the classification engine.</p>}</article>
}

const actionValue = (value: string | number | boolean | null) => value === null ? '—' : String(value)
function ActionEvidence({ action }: { action: ChangeoverAction }) {
  const visible = action.evidence.slice(0, 12)
  return <div className="si-action-detail"><p>{action.explanation}</p>{action.operatorConcept && <p><strong>Operator concept:</strong> {action.operatorConcept}</p>}{action.comparison && <p className="si-action-comparison">{action.comparison.interpretation}</p>}<div className="si-action-signals">{visible.map((evidence, index) => <article key={`${evidence.signalId}-${evidence.atUtc}-${index}`}><header><strong>Signal {evidence.signalId ?? '—'}</strong><span>{evidence.component ?? (evidence.deckNumber === null ? 'Press' : `Deck ${evidence.deckNumber}`)}</span><time>{formatUtc(evidence.atUtc)}</time></header><code>{evidence.canonicalId ?? 'No canonical identity'}</code><code>{evidence.rawIdentity ?? 'Raw identity unavailable'}</code><p>{actionValue(evidence.oldValue)} → {actionValue(evidence.newValue)}</p><small>Quality {evidence.originalQuality} · normalized {evidence.normalizedQuality}</small><small>{evidence.explanation}</small></article>)}</div>{action.evidenceCount > visible.length && <p className="si-action-limit">Showing 12 representative transitions from {action.evidenceCount}; the detector grouped the complete burst.</p>}{action.evidenceLimited && <p className="si-action-limit">The bounded API retained {action.evidence.length} of {action.evidenceCount} evidence transitions for this action.</p>}</div>
}

export interface ChangeoverActionGroup {
  actionCode: ChangeoverAction['actionCode']
  displayName: string
  confidence: ChangeoverAction['confidence']
  instances: Array<{ action: ChangeoverAction; key: string; number: number }>
}

export function groupChangeoverActions(actions: ChangeoverAction[]): ChangeoverActionGroup[] {
  const groups = new Map<string, ChangeoverActionGroup>()
  actions.forEach((action, index) => {
    const groupKey = `${action.confidence}:${action.actionCode}:${action.actionCode === 'UNCANONICALIZED_RAW_ACTIVITY' ? action.displayName : ''}`
    const current = groups.get(groupKey) ?? { actionCode: action.actionCode, displayName: action.displayName, confidence: action.confidence, instances: [] }
    current.instances.push({ action, key: stopActionKey(action, index), number: current.instances.length + 1 })
    groups.set(groupKey, current)
  })
  return [...groups.values()]
}

export type ActionTimingPhase = 'BEFORE_STOP' | 'DURING_STOP' | 'AFTER_STOP_RUN' | 'TIMING_UNKNOWN'
const ACTION_TIMING_PHASES = ['BEFORE_STOP', 'DURING_STOP', 'AFTER_STOP_RUN'] as const satisfies readonly ActionTimingPhase[]
const ACTION_TIMING_LABELS: Record<Exclude<ActionTimingPhase, 'TIMING_UNKNOWN'>, string> = { BEFORE_STOP: 'Before stop', DURING_STOP: 'During physical stop', AFTER_STOP_RUN: 'After stop · run mode' }

export function toggledActionSelection(current: string[], requested: string[]): string[] {
  const sameSelection = current.length === requested.length && requested.every((key) => current.includes(key))
  return sameSelection ? [] : requested
}

export function actionTimingPhase(action: ChangeoverAction, segment: StopIntelligenceDetail['stop']['physicalSegment']): ActionTimingPhase {
  if (!action.startAt) return 'TIMING_UNKNOWN'
  const start = Date.parse(action.startAt)
  const end = Date.parse(action.endAt ?? action.startAt)
  const stopStart = Date.parse(segment.startAt)
  const stopEnd = segment.endAt ? Date.parse(segment.endAt) : undefined
  if (!Number.isFinite(start)) return 'TIMING_UNKNOWN'
  if (Math.max(start, end) <= stopStart) return 'BEFORE_STOP'
  if (stopEnd !== undefined && start >= stopEnd) return 'AFTER_STOP_RUN'
  return 'DURING_STOP'
}

function LegacyActionSummary({ detail, selectedKeys, onSelect }: { detail: StopIntelligenceDetail; selectedKeys: string[]; onSelect(keys: string[]): void }) {
  const analysis = detail.changeoverActions
  if (!analysis.eligible) return <section className="si-action-summary si-action-summary--ineligible"><strong>Changeover actions not evaluated</strong><span>{analysis.reason}</span></section>
  const grouped = groupChangeoverActions([...analysis.actions, ...analysis.notDirectlyConfirmed])
  const actionGroup = (group: ChangeoverActionGroup, phase: ActionTimingPhase, rawEvidence = false) => {
    const instances = group.instances.filter(({ action }) => actionTimingPhase(action, detail.stop.physicalSegment) === phase)
    if (!instances.length) return null
    const allKeys = instances.map(({ key }) => key)
    const allSelected = allKeys.length === selectedKeys.length && allKeys.every((key) => selectedKeys.includes(key))
    return <section className={`si-action-group ${rawEvidence ? 'si-action-group--raw' : ''}`.trim()} key={`${group.confidence}:${phase}:${group.actionCode}:${group.displayName}`}><header><strong title={group.displayName}>{group.displayName}</strong>{!rawEvidence && <b>{instances.length}</b>}</header><div>{instances.map((instance) => <button type="button" key={instance.key} className={selectedKeys.length === 1 && selectedKeys[0] === instance.key ? 'selected' : ''} aria-pressed={selectedKeys.length === 1 && selectedKeys[0] === instance.key} title={`${group.displayName} · ${formatUtc(instance.action.startAt)}`} onClick={() => onSelect([instance.key])}><strong>{rawEvidence ? group.displayName : instance.number}</strong><small>{formatUtc(instance.action.startAt)}</small></button>)}{instances.length > 1 && <button type="button" className={allSelected ? 'selected' : ''} aria-pressed={allSelected} onClick={() => onSelect(allKeys)}><strong>All</strong><small>{instances.length} observations</small></button>}</div></section>
  }
  const confidenceRow = (confidence: ChangeoverAction['confidence'], empty: string) => {
    const confidenceGroups = grouped.filter((group) => group.confidence === confidence && group.actionCode !== 'UNCANONICALIZED_RAW_ACTIVITY')
    const timedCount = confidenceGroups.reduce((sum, group) => sum + group.instances.filter(({ action }) => actionTimingPhase(action, detail.stop.physicalSegment) !== 'TIMING_UNKNOWN').length, 0)
    return <article className={`si-action-matrix__row ${confidence.toLowerCase()}`}><header><strong>{words(confidence)}</strong><b>{timedCount}</b>{confidence === 'UNKNOWN' && <small>Not directly confirmed; this does not mean it did not happen.</small>}</header>{ACTION_TIMING_PHASES.map((phase) => <div className="si-action-matrix__cell" key={`${confidence}:${phase}`}>{confidenceGroups.map((group) => actionGroup(group, phase))}<span className="si-action-matrix__empty">{confidenceGroups.some((group) => group.instances.some(({ action }) => actionTimingPhase(action, detail.stop.physicalSegment) === phase)) ? '' : empty}</span></div>)}</article>
  }
  const rawGroups = grouped.filter((group) => group.actionCode === 'UNCANONICALIZED_RAW_ACTIVITY')
  const rawEvidenceRow = <article className="si-action-matrix__row raw"><header><strong>Raw / Unmapped</strong><small>Phase-distinct telemetry that has not been canonicalized. These observations are evidence, not named actions.</small></header>{ACTION_TIMING_PHASES.map((phase) => <div className="si-action-matrix__cell" key={`raw:${phase}`}>{rawGroups.map((group) => actionGroup(group, phase, true))}<span className="si-action-matrix__empty">{rawGroups.some((group) => group.instances.some(({ action }) => actionTimingPhase(action, detail.stop.physicalSegment) === phase)) ? '' : 'No phase-distinct raw evidence'}</span></div>)}</article>
  return <section className="si-action-summary" aria-label="Changeover actions and raw evidence by confidence and stop phase"><div className="si-action-summary__heading"><div><span className="eyebrow">Action evidence matrix</span><h3>What changed, and when?</h3></div><small>Rows show evidence confidence. Columns show timing relative to the measured physical stop. Raw/unmapped evidence remains separate and appears last.</small></div><div className="si-action-matrix__scroll"><div className="si-action-matrix__head"><span>Confidence</span>{ACTION_TIMING_PHASES.map((phase) => <strong key={phase}>{ACTION_TIMING_LABELS[phase]}</strong>)}</div>{confidenceRow('DETECTED', 'No detected actions')}{confidenceRow('INFERRED', 'No inferred actions')}{confidenceRow('UNKNOWN', 'No unknown actions')}{rawEvidenceRow}</div></section>
}

function ActionSummary({ detail, selectedKeys, onSelect }: { detail: StopIntelligenceDetail; selectedKeys: string[]; onSelect(keys: string[]): void }) {
  return <StopEvidenceChronology detail={detail} selectedKeys={selectedKeys} onSelect={onSelect}/>
}

function SelectedActionEvidence({ actions }: { actions: ChangeoverAction[] }) {
  if (!actions.length) return <section className="si-selected-action"><div><span className="eyebrow">Investigation evidence</span><strong>Select a named action or raw/unmapped telemetry tag to plot its evidence.</strong></div></section>
  const action = actions[0]!; const evidence = actions.flatMap((item) => item.evidence); const evidenceCount = actions.reduce((sum, item) => sum + item.evidenceCount, 0)
  const decks = new Set(evidence.flatMap((item) => item.deckNumber === null ? [] : [item.deckNumber])).size
  const rawEvidence = action.actionCode === 'UNCANONICALIZED_RAW_ACTIVITY'
  return <section className="si-selected-action" aria-live="polite"><div><span className="eyebrow">{rawEvidence ? 'Selected raw / unmapped evidence' : 'Selected action · signals plotted automatically'}</span><strong>{action.displayName}{actions.length > 1 ? ` · all ${actions.length} observations` : ''}</strong><p>{actions.length === 1 ? `${formatUtc(action.startAt)}${action.endAt && action.endAt !== action.startAt ? ` → ${formatUtc(action.endAt)}` : ''}` : `${formatUtc(actions[0]?.startAt)} → ${formatUtc(actions.at(-1)?.endAt ?? actions.at(-1)?.startAt ?? null)}`} · {evidenceCount} transitions{decks ? ` · ${decks} decks` : ''}</p><p>{action.explanation}</p>{!rawEvidence && <span className={`si-action-confidence si-action-confidence--${action.confidence.toLowerCase()}`}>{action.confidence}</span>}</div><div className="si-selected-action__evidence">{evidence.slice(0, 4).map((item, index) => <span key={`${item.atUtc}:${index}`} title={`${item.rawIdentity ?? 'Raw identity unavailable'} · ${item.explanation}`}><b>{item.canonicalId ?? item.rawIdentity ?? `Signal ${item.signalId ?? 'unknown'}`}</b><small>{actionValue(item.oldValue)} → {actionValue(item.newValue)} · {formatUtc(item.atUtc)}</small></span>)}{!evidence.length && <span>No direct signal transition is attached to this inference.</span>}</div></section>
}

function SelectedSignalControls({ signals, hiddenKeys, pinnedKeys, onToggleHidden, onTogglePinned }: { signals: ActionSignalContext[]; hiddenKeys: string[]; pinnedKeys: string[]; onToggleHidden(key: string): void; onTogglePinned(key: string): void }) {
  if (!signals.length) return null
  return <section className="si-selected-signal-controls" aria-label="Selected action signal visibility and pins"><header><div><span className="eyebrow">Selected action signals</span><strong>Choose which trends stay visible</strong></div><small>The eye hides a row. A pinned row stays when another action is selected.</small></header><div>{signals.map((signal) => { const key = actionSignalTrackKey(signal); const hidden = hiddenKeys.includes(key); const pinned = pinnedKeys.includes(key); const label = actionSignalLabel(signal); return <article key={key} className={`${hidden ? 'is-hidden' : ''} ${pinned ? 'is-pinned' : ''}`.trim()}><span title={label}>{label}</span><div><button type="button" className="si-signal-visibility" aria-label={`${hidden ? 'Show' : 'Hide'} ${label} trend`} aria-pressed={!hidden} title={`${hidden ? 'Show' : 'Hide'} trend`} onClick={() => onToggleHidden(key)}><span aria-hidden="true">👁</span></button><button type="button" className="si-signal-pin" aria-label={`${pinned ? 'Unpin' : 'Pin'} ${label} trend`} aria-pressed={pinned} title={`${pinned ? 'Unpin' : 'Pin'} trend`} onClick={() => onTogglePinned(key)}><span aria-hidden="true">📌</span></button></div></article> })}</div></section>
}

function TechnicalDetails({ detail, selectedAction }: { detail: StopIntelligenceDetail; selectedAction?: ChangeoverAction }) {
  const { stop } = detail; const segment = stop.physicalSegment
  return <details className="panel si-technical-details" id="si-technical-details"><summary><span>Technical evidence and source details</span><small>Identity, exact Radius states, setup families, boundaries, and raw action transitions</small></summary><div className="si-technical-details__content"><section><h3>Why this classification?</h3><div className="si-evidence-columns"><EvidenceList title="Supporting" kind="supporting" items={stop.supportingEvidence}/><EvidenceList title="Conflicting" kind="conflicting" items={stop.conflictingEvidence}/><EvidenceList title="Missing / unavailable" kind="missing" missing={stop.missingEvidence}/></div></section><section><h3>Movement / restart attempts</h3>{segment.movementAttempts.length ? <div className="si-attempt-list">{segment.movementAttempts.map((attempt) => <article key={attempt.sequenceNumber}><b>#{attempt.sequenceNumber}</b><span>{formatUtc(attempt.startAt)} → {formatUtc(attempt.endAt)}</span><strong>{formatStopDuration(attempt.durationSeconds)}</strong><small>Peak {attempt.peakSpeed === null ? '—' : Math.round(attempt.peakSpeed)} · avg {attempt.averageSpeed === null ? '—' : Math.round(attempt.averageSpeed)} ft/min</small><em className={attempt.reachedRecoveryThreshold ? 'reached' : ''}>{attempt.reachedRecoveryThreshold ? 'Reached recovery threshold' : 'Below recovery threshold'} · {attempt.failedRecoveryCount} failed</em></article>)}</div> : <p>No movement or restart attempts were observed.</p>}</section><section><h3>Press-specific identity context</h3><div className="si-identity-grid">{stop.identities.map((identity) => <article key={identity.field} className={identity.changed ? 'changed' : ''}><header><strong>{words(identity.field)}</strong><span>{identity.usefulness}</span></header><div><small>Before</small><b>{identity.beforeValue ?? 'Unavailable'}</b><i>→</i><small>After</small><b>{identity.afterValue ?? 'Unavailable'}</b></div><p>{identity.changed ? `Transition ${formatUtc(identity.firstChangeAtUtc)}` : 'No associated transition'} · {identity.settled ? `Settled ${formatUtc(identity.settledAtUtc)}` : 'Not settled'}</p><code>{identity.canonicalId ?? 'No mapped canonical signal'}</code></article>)}</div></section><section><h3>Exact Radius evidence · {stop.radiusAlignment}</h3><div className="si-radius-states">{stop.radius.states.map((state, index) => <article key={`${state.startUtc}:${index}`}><strong>{state.eventType ?? 'OFFLINE'} / {state.statusCode ?? '—'}</strong><span>{state.statusDescription ?? 'Radius unavailable'}</span><small>{formatUtc(state.startUtc)} → {formatUtc(state.endUtc)}</small></article>)}</div><p className="si-source-reason">{stop.radius.reason} Coverage {Math.round(stop.radius.coveragePercent)}%.</p></section><section><h3>Setup family evidence · not a required stage sequence</h3><div className="si-family-grid">{stop.families.map((family) => <article key={family.family} className={!family.available ? 'unavailable' : family.observed ? 'detected' : ''}><span>{words(family.family)}</span><strong>{!family.available ? 'UNAVAILABLE' : family.observed ? family.coordinated ? 'COORDINATED' : 'DETECTED' : 'NONE'}</strong><small>{family.changeCount} changes{family.deckNumbers.length ? ` · decks ${family.deckNumbers.join(', ')}` : ''}</small><p>{family.reason}</p></article>)}</div></section>{selectedAction && <section><h3>Selected action raw / canonical transitions</h3><ActionEvidence action={selectedAction}/></section>}<section><h3>Source boundaries</h3><p>Physical boundaries come only from canonical Actual Speed. Identity uses {detail.identityAssociationConfiguration.identitySettlingSeconds / 60}-minute settling with up to {detail.identityAssociationConfiguration.identityContextBeforeSeconds / 60} minutes before and {detail.identityAssociationConfiguration.identityContextAfterSeconds / 60} minutes after for retrospective association. Radius and setup telemetry explain evidence but cannot move the physical stop.</p><p>Left boundary: {segment.leftCensored ? segment.leftCensorReason ?? 'CENSORED' : 'OBSERVED'} · Right boundary: {segment.rightCensored ? segment.rightCensorReason ?? 'CENSORED' : 'OBSERVED RECOVERY'} · UNKNOWN intervals: {detail.speedContext.unknownIntervals.length}. UNKNOWN is never treated as zero.</p><p>Physical algorithm {segment.algorithmVersion}; configuration {segment.configVersion}; classification {stop.classificationVersion}.</p></section></div></details>
}

function LoadedInvestigation({ detail, onClose }: { detail: StopIntelligenceDetail; onClose(): void }) {
  const actions = [...detail.changeoverActions.actions, ...detail.changeoverActions.notDirectlyConfirmed]
  const [selectedActionKeys, setSelectedActionKeys] = useState<string[]>([])
  const [hiddenSignalKeys, setHiddenSignalKeys] = useState<string[]>([])
  const [pinnedSignalKeys, setPinnedSignalKeys] = useState<string[]>([])
  useEffect(() => { setSelectedActionKeys([]); setHiddenSignalKeys([]); setPinnedSignalKeys([]) }, [detail.stopId])
  const selectedActions = actions.filter((action, index) => selectedActionKeys.includes(stopActionKey(action, index))); const selectedAction = selectedActions[0]
  const selectedSignals = selectedActionSignalContext(detail.actionSignalContext, selectedActions)
  const controlledSignalKeySet = new Set([...selectedSignals.map(actionSignalTrackKey), ...pinnedSignalKeys])
  const controlledSignals = detail.actionSignalContext.filter((signal) => controlledSignalKeySet.has(actionSignalTrackKey(signal)))
  const visibleSignalKeys = controlledSignals.map(actionSignalTrackKey).filter((key) => !hiddenSignalKeys.includes(key))
  const stop = detail.stop; const segment = stop.physicalSegment; const decision = stopDecisionSummary(detail)
  const testingCount = segment.movementAttempts.filter((attempt) => !(attempt.reachedRecoveryThreshold && attempt.failedRecoveryCount === 0 && segment.endAt && Math.abs(Date.parse(attempt.endAt) - Date.parse(segment.endAt)) <= 1_000)).length
  const evidenceChips = [...stop.supportingEvidence.map((item) => ({ ...item, kind: 'supporting' as const })), ...stop.conflictingEvidence.map((item) => ({ ...item, kind: 'conflicting' as const }))].slice(0, 5)
  const selectActions = (keys: string[]) => setSelectedActionKeys((current) => toggledActionSelection(current, keys))
  const toggleHiddenSignal = (key: string) => setHiddenSignalKeys((current) => current.includes(key) ? current.filter((item) => item !== key) : [...current, key])
  const togglePinnedSignal = (key: string) => setPinnedSignalKeys((current) => current.includes(key) ? current.filter((item) => item !== key) : [...current, key])
  return <div className="si-investigation" id="stop-investigation"><section className={`si-decision si-decision--compact si-decision--${stop.classification.toLowerCase()}`}><header><div><span className="eyebrow">Selected physical stop · {detail.displayName}</span><strong>{formatUtc(segment.startAt)}</strong></div><button type="button" onClick={onClose}>Close investigation</button></header><div className="si-decision-chips"><span><small>Classification</small><ClassificationBadge value={stop.classification}/></span><span><small>Confidence</small><strong>{stop.confidence}</strong></span><span><small>Physical stop</small><strong>{formatStopDuration(segment.physicalDurationSeconds)}</strong></span><span><small>Testing</small><strong>{testingCount} speed-only increments</strong></span><span><small>Identity</small><strong>{decision.identity ? `${decision.identity.beforeValue ?? 'Unknown'} → ${decision.identity.afterValue ?? 'Unknown'}` : 'No transition'}</strong></span><span><small>Radius</small><strong>{stop.radiusAlignment}</strong></span><span className={detail.telemetryEvidenceState === 'AVAILABLE' ? '' : 'warning'}><small>Availability</small><strong>{words(detail.telemetryEvidenceState)}</strong></span><a href="#si-technical-details"><small>Evidence</small><strong>{stop.supportingEvidence.length} supporting · {stop.conflictingEvidence.length} conflicting · {stop.missingEvidence.length} missing</strong></a></div>{evidenceChips.length > 0 && <div className="si-decision-evidence-chips" aria-label="Compact classification evidence">{evidenceChips.map((item) => <a key={`${item.kind}:${item.code}`} className={item.kind} href="#si-technical-details" title={item.explanation}>{item.kind === 'supporting' ? '✓' : '!'} {words(item.code)}</a>)}</div>}</section><section className="panel si-visual-investigation"><div className="section-heading"><div><span className="eyebrow">±15 minute context · one synchronized wall-clock axis</span><h2>Visual investigation</h2><p>Move across any track for one shared inspection time. Select a named action band or an evidence chronology item; its signals plot immediately. Select it again to clear the plotted signals.</p></div><span>{detail.speedContext.unit ?? 'Unit unverified'}</span></div><StopSynchronizedTimeline detail={detail} selectedActions={selectedActions} selectedActionKey={selectedActionKeys.length === 1 ? selectedActionKeys[0] : undefined} visibleSignalKeys={visibleSignalKeys} hiddenSignalKeys={hiddenSignalKeys} pinnedSignalKeys={pinnedSignalKeys} onToggleHiddenSignal={toggleHiddenSignal} onTogglePinnedSignal={togglePinnedSignal} onSelectAction={(key) => selectActions([key])}/><SelectedActionEvidence actions={selectedActions}/><SelectedSignalControls signals={controlledSignals} hiddenKeys={hiddenSignalKeys} pinnedKeys={pinnedSignalKeys} onToggleHidden={toggleHiddenSignal} onTogglePinned={togglePinnedSignal}/><div className="si-timeline-legend"><span className="running">Running</span><span className="stopped">Stopped</span><span className="testing">Testing · speed-only movement</span><span className="unknown">UNKNOWN / unavailable</span></div></section><ActionSummary detail={detail} selectedKeys={selectedActionKeys} onSelect={selectActions}/><TechnicalDetails detail={detail} selectedAction={selectedAction}/></div>
}

function StopInvestigation({ detail, loading, error, onClose }: { detail?: StopIntelligenceDetail; loading: boolean; error?: string; onClose(): void }) {
  if (loading) return <section className="panel si-investigation-loading" role="status">Loading bounded evidence for the selected physical stop…</section>
  if (error) return <section className="panel unavailable-panel" role="alert"><h2>Selected stop unavailable</h2><p>{error}</p><button type="button" onClick={onClose}>Close investigation</button></section>
  return detail ? <LoadedInvestigation detail={detail} onClose={onClose}/> : null
}

const CORRECTION_OPTIONS: Array<{ value: StopOperatorState; label: string; description: string }> = [
  { value: 'CHANGEOVER', label: 'Changeover', description: 'Setup or job transition work.' },
  { value: 'DOWNTIME', label: 'Downtime', description: 'Unplanned or loss-producing stop.' },
  { value: 'ROUTINE', label: 'Routine', description: 'Expected routine work that is not a changeover.' },
  { value: 'GOOD_PRODUCTION', label: 'Good production', description: 'Confirmed productive running time.' },
]

const defaultCorrectionState = (state: StopPredictedState): StopOperatorState | undefined => state === 'OBSERVABLE_NON_STOP' ? 'GOOD_PRODUCTION' : state === 'CHANGEOVER' || state === 'DOWNTIME' ? state : undefined
const selectableOperatorState = (state: StopOperatorState | undefined) => state && CORRECTION_OPTIONS.some((option) => option.value === state) ? state : undefined
export const confirmsPrediction = (predicted: StopPredictedState, selected?: StopOperatorState) => selected !== undefined && correctionConfirmsPrediction(predicted, selected)
export const operatorDecisionButtonLabel = (predicted: StopPredictedState, selected: StopOperatorState | undefined, saving: boolean) => saving ? confirmsPrediction(predicted, selected) ? 'Confirming…' : 'Saving…' : confirmsPrediction(predicted, selected) ? 'Confirm' : 'Save decision'
export const operatorDecisionActionsVisible = (current: StopIntelligenceCorrection | undefined, selected: StopOperatorState | undefined) => !current || !confirmsPrediction(current.predictedState, current.correctedState) || selected !== current.correctedState

function StopSegmentDecisionDialog({ press, segment, current, persistence, saving, error, onClose, onInvestigate, onSave }: { press: RadiusPressKey; segment: FleetBandSegment; current?: StopIntelligenceCorrection; persistence: StopIntelligenceFleetReport['correctionPersistence']; saving: boolean; error?: string; onClose(): void; onInvestigate(): void; onSave(state: StopOperatorState, comment: string): void }) {
  const predicted = predictedFleetState(segment)
  const [choice, setChoice] = useState<StopOperatorState | undefined>(selectableOperatorState(current?.correctedState) ?? defaultCorrectionState(predicted))
  const [comment, setComment] = useState(current?.comment ?? '')
  useEffect(() => { setChoice(selectableOperatorState(current?.correctedState) ?? defaultCorrectionState(predicted)); setComment(current?.comment ?? '') }, [segment.id, current?.correctionId, predicted])
  const currentWasConfirmation = current ? confirmsPrediction(current.predictedState, current.correctedState) : false
  const showDecisionActions = operatorDecisionActionsVisible(current, choice)
  return <div className="si-correction-backdrop">
    <section className="si-correction-dialog" role="dialog" aria-modal="true" aria-labelledby="si-correction-title">
      <header><div><span className="eyebrow">{press.replace('press', 'Press ')} · operator review</span><h2 id="si-correction-title">Confirm or classify this timeline state</h2></div><button type="button" onClick={onClose} aria-label="Close state review">×</button></header>
      <div className="si-correction-summary"><span><small>Predicted</small><strong>{reviewedStateLabel(predicted)}</strong></span><span><small>Start</small><strong>{localTime(segment.startUtc)}</strong></span><span><small>End</small><strong>{localTime(segment.endUtc)}</strong></span><span><small>Duration</small><strong>{exactDuration((Date.parse(segment.endUtc) - Date.parse(segment.startUtc)) / 1_000)}</strong></span></div>
      <div className="si-current-correction" role="status"><span><small>Currently selected</small><strong>{choice ? reviewedStateLabel(choice) : 'Choose an operator decision'}</strong></span><small>{current ? currentWasConfirmation ? showDecisionActions ? 'Changing a saved confirmation' : '✓ Saved operator confirmation · choose another state to edit' : 'Saved operator decision' : 'Starts from the current prediction'}</small></div>
      <fieldset><legend>What should this time be recorded as?</legend><div className="si-correction-options">{CORRECTION_OPTIONS.map((option) => <button type="button" key={option.value} className={`si-correction-option si-correction-option--${reviewedStateClass(option.value)} ${choice === option.value ? 'selected' : ''}`} aria-pressed={choice === option.value} onClick={() => setChoice(option.value)}><strong>{option.label}</strong><small>{option.description}</small></button>)}</div></fieldset>
      {showDecisionActions ? <label className="si-correction-comment"><span>Comments <small>optional</small></span><textarea value={comment} maxLength={1_000} rows={3} placeholder="Add operator context or explain why this classification was chosen…" onChange={(event) => setComment(event.target.value)}/><small>{comment.length} / 1000 characters</small></label> : current?.comment ? <div className="si-saved-confirmation-comment"><small>Saved comment</small><p>{current.comment}</p></div> : null}
      <p className="si-correction-note">The predicted row stays unchanged. Your confirmation or decision is recorded separately with the original prediction and exact interval, then restored by its timestamp when this range is loaded again.{persistence === 'memory' ? ' The application database is unavailable, so this decision would not survive a service restart.' : ''}</p>
      {segment.episode ? <section className="si-investigate-evidence-callout"><div><span className="eyebrow">Telemetry details</span><h3>Investigate the bounded evidence</h3><p>Open the synchronized speed, Radius, identity, restart, and action evidence for this exact physical stop.</p></div><button type="button" onClick={onInvestigate}>Investigate evidence <span aria-hidden="true">→</span></button></section> : <section className="si-investigate-evidence-callout is-unavailable"><div><span className="eyebrow">Telemetry details</span><h3>No physical stop is attached</h3><p>This running context can be reviewed, but it has no bounded stop investigation.</p></div></section>}
      {error && <p className="si-correction-error" role="alert">{error}</p>}
      {showDecisionActions && <footer><div><button type="button" className="secondary-action" onClick={onClose}>Cancel</button><button type="button" className="primary-action" disabled={!choice || saving} onClick={() => choice && onSave(choice, comment)}>{operatorDecisionButtonLabel(predicted, choice, saving)}</button></div></footer>}
    </section>
  </div>
}

export function StopIntelligencePage({ range, selectedPress, onRangeChange, onPressChange }: Props) {
  const [filter, setFilter] = useState<StopFilter>('ALL'); const [report, setReport] = useState<StopIntelligenceFleetReport>(); const [loading, setLoading] = useState(true); const [error, setError] = useState<string>()
  const [resolvedScopeKey, setResolvedScopeKey] = useState<string>()
  const [selectedEpisode, setSelectedEpisode] = useState<StopFleetEpisode>(); const [detail, setDetail] = useState<StopIntelligenceDetail>(); const [detailLoading, setDetailLoading] = useState(false); const [detailError, setDetailError] = useState<string>()
  const [correctionTarget, setCorrectionTarget] = useState<FleetBandSegment>(); const [correctionSaving, setCorrectionSaving] = useState(false); const [correctionError, setCorrectionError] = useState<string>()
  const activePress = configuredPresses.includes(selectedPress as RadiusPressKey) ? selectedPress as RadiusPressKey : 'press15'
  const scopeKey = `${activePress}:${range.fromUtc}:${range.toUtc}`
  const rangeTooLarge = Date.parse(range.toUtc) - Date.parse(range.fromUtc) > MAX_RANGE_MS
  useEffect(() => { if (selectedPress !== activePress) onPressChange(activePress) }, [selectedPress, activePress, onPressChange])
  useEffect(() => { setSelectedEpisode(undefined); setDetail(undefined); setDetailError(undefined); setCorrectionTarget(undefined); setCorrectionError(undefined); if (rangeTooLarge) { setLoading(false); setError('Stop Intelligence supports a maximum 72-hour range so historian and Radius reads remain bounded.'); setResolvedScopeKey(scopeKey); return }; let active = true; const controller = new AbortController(); setLoading(true); setError(undefined); void getStopIntelligenceFleet(activePress, range.fromUtc, range.toUtc, controller.signal).then((value) => { if (active) { setReport(value); setResolvedScopeKey(scopeKey) } }).catch((cause) => { if (active && (cause as Error).name !== 'AbortError') { setError(`${activePress.replace('press', 'Press ')} stop evidence could not be loaded for this range.`); setResolvedScopeKey(scopeKey) } }).finally(() => active && setLoading(false)); return () => { active = false; controller.abort() } }, [activePress, range.fromUtc, range.toUtc, rangeTooLarge, scopeKey])
  useEffect(() => { if (!selectedEpisode) return; let active = true; const controller = new AbortController(); setDetail(undefined); setDetailError(undefined); setDetailLoading(true); void getStopIntelligenceDetail({ pressKey: selectedEpisode.pressKey, stopId: selectedEpisode.stopId, fromUtc: range.fromUtc, toUtc: range.toUtc }, controller.signal).then((value) => { if (active) { setDetail(value); window.setTimeout(() => document.getElementById('stop-investigation')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0) } }).catch((cause) => { if (active && (cause as Error).name !== 'AbortError') setDetailError('The selected read-only evidence could not be reconstructed.') }).finally(() => active && setDetailLoading(false)); return () => { active = false; controller.abort() } }, [selectedEpisode, range.fromUtc, range.toUtc])
  function closeDetail() { setSelectedEpisode(undefined); setDetail(undefined); setDetailError(undefined); setDetailLoading(false) }
  const currentReport = resolvedScopeKey === scopeKey ? report : undefined
  const currentError = resolvedScopeKey === scopeKey ? error : undefined
  const isPopulating = !rangeTooLarge && (loading || resolvedScopeKey !== scopeKey)
  const currentCorrection = correctionTarget ? latestOperatorDecisionForSegment(correctionTarget, currentReport?.operatorCorrections ?? []) : undefined
  const openSegmentReview = (segment: FleetBandSegment, intent: 'review' | 'investigate' = 'review') => {
    setCorrectionError(undefined)
    if (intent === 'investigate' && segment.episode) { setSelectedEpisode(segment.episode); setCorrectionTarget(undefined); return }
    setCorrectionTarget(segment)
  }
  const investigateCorrectionTarget = () => { if (!correctionTarget?.episode) return; setSelectedEpisode(correctionTarget.episode); setCorrectionTarget(undefined); setCorrectionError(undefined) }
  const saveCorrection = async (correctedState: StopOperatorState, comment: string) => {
    if (!correctionTarget) return
    setCorrectionSaving(true); setCorrectionError(undefined)
    try {
      const correction = await recordStopIntelligenceCorrection({ pressKey: activePress, segmentKey: correctionTarget.id, fromUtc: correctionTarget.startUtc, toUtc: correctionTarget.endUtc, predictedState: predictedFleetState(correctionTarget), correctedState, comment: comment.trim() || null })
      setReport((current) => current ? { ...current, operatorCorrections: [...current.operatorCorrections, correction] } : current)
      setCorrectionTarget(undefined)
    } catch { setCorrectionError('The operator decision could not be saved. The predicted timeline was not changed.') }
    finally { setCorrectionSaving(false) }
  }
  const scopedPresses = useMemo(() => currentReport?.presses.filter((press) => press.pressKey === activePress) ?? [], [currentReport, activePress]); const totals = stopFleetTotals(scopedPresses); const filteredCount = scopedPresses.reduce((sum, press) => sum + filterStopEpisodes(press.episodes, filter).length, 0)
  const changePress = (direction: -1 | 1) => { closeDetail(); onPressChange(adjacentStopPress(activePress, direction)) }
  return <div className="si-page"><section className="si-hero"><div><span className="eyebrow">Single press · deterministic prediction · operator review</span><h1>Stop Intelligence</h1><p>A real physical stop happened. What kind of stop was it?</p></div><div className="si-classification-key"><span className="changeover">Changeover</span><span className="downtime">Downtime</span><span className="uncertain">Uncertain</span><span className="bad-data">Bad / incomplete data</span></div></section><section className="si-controls" aria-label="Stop Intelligence controls"><div className="si-press-picker"><span>Press · one at a time</span><div><button type="button" aria-label="Previous press" onClick={() => changePress(-1)}>←</button><select value={activePress} onChange={(event) => { closeDetail(); onPressChange(event.target.value as RadiusPressKey) }}>{configuredPresses.map((press) => <option key={press} value={press}>{press.replace('press', 'Press ')}</option>)}</select><button type="button" aria-label="Next press" onClick={() => changePress(1)}>→</button></div></div><div><span>Time range · maximum 72 hours</span><StopRangeControls range={range} onChange={onRangeChange}/></div></section><div className="si-filter-bar" role="group" aria-label="Classification filters">{STOP_CLASSIFICATION_FILTERS.map((item) => <button key={item.value} type="button" className={filter === item.value ? 'active' : ''} aria-pressed={filter === item.value} onClick={() => { setFilter(item.value); closeDetail(); setCorrectionTarget(undefined) }}>{item.label}<span>{item.value === 'ALL' ? totals.stops : scopedPresses.reduce((sum, press) => sum + filterStopEpisodes(press.episodes, item.value).length, 0)}</span></button>)}</div>{isPopulating && <div className="scope-progress" role="status"><i aria-hidden="true"/>Loading {activePress.replace('press', 'Press ')} stop context for the selected time window…</div>}{currentError && <section className="panel unavailable-panel" role="alert"><h2>Stop evidence unavailable</h2><p>{currentError}</p></section>}{currentReport && !currentError && <><section className="si-fleet-summary si-fleet-summary--compact" aria-label={`${activePress.replace('press', 'Press ')} stop summary`}><article><small>Stops</small><strong>{totals.stops}</strong><span>{formatStopDuration(totals.physicalSeconds)} total</span></article><article className="changeover"><small>Changeover</small><strong>{totals.changeovers}</strong></article><article className="downtime"><small>Downtime</small><strong>{totals.downtime}</strong></article><article className="uncertain"><small>Uncertain</small><strong>{totals.uncertain}</strong></article><article className="bad-data"><small>Bad data</small><strong>{totals.badData}</strong></article></section><section className="si-fleet" aria-labelledby="si-fleet-title"><div className="section-heading"><div><span className="eyebrow">Selected press stop overview</span><h2 id="si-fleet-title">{activePress.replace('press', 'Press ')} timeline</h2></div><span>{filteredCount} visible episodes</span></div>{scopedPresses.map((press) => <FleetRow key={press.pressKey} press={press} range={range} filter={filter} selectedId={selectedEpisode?.stopId} corrections={currentReport.operatorCorrections.filter((item) => item.pressKey === press.pressKey)} onSelectSegment={openSegmentReview} onRangeChange={onRangeChange}/>)}{!isPopulating && !scopedPresses.length && <div className="empty-state">No Stop Intelligence data was returned for this press and time window.</div>}{scopedPresses.length > 0 && totals.stops === 0 && <div className="empty-state">No physical stops were detected in this range.</div>}</section></>}{correctionTarget && currentReport && <StopSegmentDecisionDialog press={activePress} segment={correctionTarget} current={currentCorrection} persistence={currentReport.correctionPersistence} saving={correctionSaving} error={correctionError} onClose={() => { setCorrectionTarget(undefined); setCorrectionError(undefined) }} onInvestigate={investigateCorrectionTarget} onSave={saveCorrection}/>}<StopInvestigation detail={detail} loading={detailLoading} error={detailError} onClose={closeDetail}/></div>
}
