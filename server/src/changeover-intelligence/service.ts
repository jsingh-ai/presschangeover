import type { RadiusPressKey } from '../radius/models.js'
import { RADIUS_PRESS_KEYS } from '../radius/models.js'
import type { RadiusService } from '../radius/radius-service.js'
import type { ProductionContextEvidence } from '../telemetry/telemetry-contracts.js'
import type { TelemetryFoundationService } from '../telemetry/telemetry-foundation-service.js'
import { usableJobIdentity } from '../job-intelligence/engine.js'
import { changeoverRadiusAcquisitionGuard } from './radius-acquisition-guard.js'
import { DateTime } from 'luxon'
import {
  CHANGEOVER_ALGORITHM_VERSION,
  CHANGEOVER_CONFIRMATION_SECONDS_DEFAULT,
  CHANGEOVER_RECOVERY_SPEED_DEFAULT,
  CHANGEOVER_STOP_SPEED_DEFAULT,
  type ChangeoverDefinition,
  type ChangeoverInspector,
  type ChangeoverInspectorInput,
  type ChangeoverReport,
  type ChangeoverReportInput,
  type ConfirmedChangeover,
  type EvidenceState,
} from './contracts.js'
import { assembleChangeovers, detectPhysicalStops, distribution, summarizeDaily, summarizeExactReasons, summarizePhases, summarizePresses, summarizeRecoveryCohorts, summarizeSequences, summarizeTransitionPairs, support } from './engine.js'

const MAX_LIVE_HISTORY_MS = 24 * 60 * 60_000
const CACHE_MS = 30_000
const INSPECTOR_CONTEXT_MS = 10 * 60_000

interface CacheEntry { expiresAt: number; report: ChangeoverReport }

function definition(input: Pick<ChangeoverReportInput, 'stopSpeed' | 'recoverySpeed' | 'recoveryConfirmationSeconds'>): ChangeoverDefinition {
  const defaults = input.stopSpeed === CHANGEOVER_STOP_SPEED_DEFAULT && input.recoverySpeed === CHANGEOVER_RECOVERY_SPEED_DEFAULT && input.recoveryConfirmationSeconds === CHANGEOVER_CONFIRMATION_SECONDS_DEFAULT
  return { stopSpeed: input.stopSpeed, recoverySpeed: input.recoverySpeed, recoveryConfirmationSeconds: input.recoveryConfirmationSeconds, source: defaults ? 'DEFAULT' : 'CUSTOM', stopRule: 'speed_below_threshold_debounced', recoveryRule: 'first_speed_above_threshold_sustained', identityRule: 'resolved_order_changed' }
}

function requestKey(input: ChangeoverReportInput): string {
  return JSON.stringify([input.fromUtc, input.toUtc, input.stopSpeed, input.recoverySpeed, input.recoveryConfirmationSeconds])
}

function projectReport(report: ChangeoverReport, input: ChangeoverReportInput, cache: ChangeoverReport['diagnostics']['cache']): ChangeoverReport {
  const selected = input.mode === 'CHANGEOVERS' ? report.changeovers : report.allStops
  const complete = selected.filter((item) => item.physical.durationSeconds !== null)
  const completedChangeovers = report.changeovers.filter((item) => item.physical.durationSeconds !== null)
  const values = complete.flatMap((item) => item.physical.durationSeconds === null ? [] : [item.physical.durationSeconds])
  const daily = summarizeDaily(complete, report.analyzedFromUtc, report.analyzedToUtc)
  const evidenceState: EvidenceState = report.diagnostics.successfulPressCount === 0 ? 'FAILED' : report.diagnostics.successfulPressCount < report.diagnostics.pressCount || report.diagnostics.radiusUnavailablePressCount ? 'PARTIAL' : selected.some((item) => item.evidenceState === 'INSUFFICIENT_EVIDENCE') ? 'INSUFFICIENT_EVIDENCE' : 'COMPLETE'
  return { ...report, mode: input.mode, focusPressKey: input.focusPressKey, evidenceState, support: support(selected.length), fleet: report.fleet.map((press) => ({ ...press, focused: press.pressKey === input.focusPressKey })), duration: distribution(values), phases: summarizePhases(completedChangeovers), exactReasons: summarizeExactReasons(completedChangeovers), sequences: summarizeSequences(completedChangeovers), recoveryCohorts: summarizeRecoveryCohorts(completedChangeovers), daily, trends: daily.map((item) => ({ periodStartUtc: `${item.date}T00:00:00`, count: item.count, medianDurationSeconds: item.medianDurationSeconds, p90DurationSeconds: distribution(complete.filter((event) => DateTimeSafeDate(event.physical.physicalStartUtc) === item.date).flatMap((event) => event.physical.durationSeconds === null ? [] : [event.physical.durationSeconds])).p90 })), diagnostics: { ...report.diagnostics, cache } }
}

function abortError() { const error = new Error('Request was cancelled'); error.name = 'AbortError'; return error }

function waitForConsumer<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise<T>((resolve, reject) => {
    const cancelled = () => reject(abortError())
    signal.addEventListener('abort', cancelled, { once: true })
    promise.then((value) => { signal.removeEventListener('abort', cancelled); if (!signal.aborted) resolve(value) }, (error) => { signal.removeEventListener('abort', cancelled); if (!signal.aborted) reject(error) })
  })
}

function emptyContext(pressKey: RadiusPressKey, displayName: string, fromUtc: string, toUtc: string): ProductionContextEvidence {
  const field = (name: 'job' | 'order' | 'recipe' | 'customer' | 'material' | 'roll') => ({ field: name, canonicalId: `production.${name}`, capabilityState: 'UNKNOWN' as const, observationState: 'UNSUPPORTED' as const, seed: null, changes: [] })
  return { pressKey, sourceKey: pressKey, displayName, fromUtc, toUtc, fields: { job: field('job'), order: field('order'), recipe: field('recipe'), customer: field('customer'), material: field('material'), roll: field('roll') }, changes: [] }
}

async function readPhysicalAndOrder(telemetry: TelemetryFoundationService, pressKey: RadiusPressKey, fromUtc: string, toUtc: string, requestId?: string, signal?: AbortSignal) {
  const history = await telemetry.semanticHistory(pressKey, { fromUtc, toUtc, includeSeed: true, signals: [{ canonicalId: 'machine.speed.actual', representation: 'samples' }, { canonicalId: 'production.order', representation: 'changes' }] }, requestId, signal)
  const actual = history.signals.find((item) => item.canonicalId === 'machine.speed.actual' && item.deckNumber === null)
  if (!actual) throw new Error('changeover_actual_speed_unavailable')
  const order = history.signals.find((item) => item.canonicalId === 'production.order' && item.deckNumber === null)
  const context = emptyContext(pressKey, history.displayName, fromUtc, toUtc)
  if (order) {
    context.fields.order = { field: 'order', canonicalId: 'production.order', capabilityState: order.capabilityState, observationState: order.observationState, seed: order.seed, changes: order.changes }
    context.changes = order.changes.map((change) => ({ atUtc: change.observedAtUtc, field: 'order', canonicalId: 'production.order', previousValueKind: change.previousValueKind, previousValue: change.previousValue, valueKind: change.valueKind, value: change.value, qualityState: change.qualityState }))
  }
  return { displayName: history.displayName, actual: { sourceUnit: actual.sourceUnit, samples: actual.samples }, context, readDiagnostics: history.readDiagnostics }
}

export class ChangeoverIntelligenceService {
  private readonly cache = new Map<string, CacheEntry>()
  private readonly inFlight = new Map<string, Promise<ChangeoverReport>>()

  constructor(private readonly radius: RadiusService, private readonly telemetry: TelemetryFoundationService, private readonly now: () => Date = () => new Date()) {}

  async report(input: ChangeoverReportInput, requestId?: string, signal?: AbortSignal): Promise<ChangeoverReport> {
    const key = requestKey(input); const cached = this.cache.get(key)
    if (cached && cached.expiresAt > this.now().getTime()) return projectReport(cached.report, input, 'HIT')
    const shared = this.inFlight.get(key)
    if (shared) return waitForConsumer(shared.then((report) => projectReport(report, input, 'SHARED')), signal)
    const acquisition = this.buildReport(input, requestId).then((report) => { this.cache.set(key, { expiresAt: this.now().getTime() + CACHE_MS, report }); return report }).finally(() => this.inFlight.delete(key))
    this.inFlight.set(key, acquisition)
    return waitForConsumer(acquisition.then((report) => projectReport(report, input, 'MISS')), signal)
  }

  private async buildReport(input: ChangeoverReportInput, requestId?: string): Promise<ChangeoverReport> {
    const requestedStart = Date.parse(input.fromUtc); const requestedEnd = Date.parse(input.toUtc)
    const limited = requestedEnd - requestedStart > MAX_LIVE_HISTORY_MS
    const analyzedStart = limited ? requestedEnd - MAX_LIVE_HISTORY_MS : requestedStart
    const analyzedFromUtc = new Date(analyzedStart).toISOString(); const analyzedToUtc = input.toUtc
    const rule = definition(input); const allEvents: ConfirmedChangeover[] = []; const metadataOnly: ChangeoverReport['metadataOnlyTransitions'] = []
    const pressStates = new Map<RadiusPressKey, { displayName: string; evidenceState: EvidenceState; metadataOnly: number }>()
    let successfulPressCount = 0; let radiusUnavailablePressCount = 0; let telemetryUnavailablePressCount = 0; let radiusAcquisitions = 0; let telemetryChunkCount = 0; let telemetryRequestCount = 0

    // Deliberately sequential by press. This is the only fleet Radius loop in the product.
    for (const pressKey of RADIUS_PRESS_KEYS) {
      const displayName = pressKey.replace('press', 'Press ')
      let evidence
      try { evidence = await readPhysicalAndOrder(this.telemetry, pressKey, analyzedFromUtc, analyzedToUtc, requestId) } catch { telemetryUnavailablePressCount += 1; pressStates.set(pressKey, { displayName, evidenceState: 'FAILED', metadataOnly: 0 }); continue }
      telemetryChunkCount += evidence.readDiagnostics?.chunkCount ?? 0
      telemetryRequestCount += evidence.readDiagnostics?.telemetryRequests ?? 0
      const stops = detectPhysicalStops(evidence.actual.samples, rule)
      let radiusSegments
      if (this.radius.getRawTimeline) {
        radiusAcquisitions += 1
        try { radiusSegments = (await changeoverRadiusAcquisitionGuard.run(() => this.radius.getRawTimeline!(pressKey, analyzedFromUtc, analyzedToUtc))).segments } catch { radiusUnavailablePressCount += 1 }
      } else radiusUnavailablePressCount += 1
      const assembled = assembleChangeovers({ pressKey, displayName: evidence.displayName || displayName, context: evidence.context, stops, definition: rule, ...(radiusSegments ? { radiusSegments } : {}) })
      allEvents.push(...assembled.events); metadataOnly.push(...assembled.metadataOnlyTransitions.map((transition) => ({ pressKey, displayName: evidence.displayName || displayName, transition })))
      successfulPressCount += 1
      const pressState: EvidenceState = stops.some((item) => item.evidenceState !== 'CONFIRMED') || assembled.events.some((item) => item.evidenceState === 'INSUFFICIENT_EVIDENCE') ? 'INSUFFICIENT_EVIDENCE' : stops.length && !radiusSegments ? 'PARTIAL' : 'COMPLETE'
      pressStates.set(pressKey, { displayName: evidence.displayName || displayName, evidenceState: pressState, metadataOnly: assembled.metadataOnlyTransitions.length })
    }

    const changeovers = allEvents.filter((item) => item.classification === 'CONFIRMED_CHANGEOVER')
    const selected = input.mode === 'CHANGEOVERS' ? changeovers : allEvents
    const complete = selected.filter((item) => item.physical.durationSeconds !== null)
    const evidenceState: EvidenceState = successfulPressCount === 0 ? 'FAILED' : successfulPressCount < RADIUS_PRESS_KEYS.length || radiusUnavailablePressCount ? 'PARTIAL' : selected.some((item) => item.evidenceState === 'INSUFFICIENT_EVIDENCE') ? 'INSUFFICIENT_EVIDENCE' : 'COMPLETE'
    const durations = complete.flatMap((item) => item.physical.durationSeconds === null ? [] : [item.physical.durationSeconds])
    const daily = summarizeDaily(complete, analyzedFromUtc, analyzedToUtc)
    return {
      version: 'changeover-intelligence-report-v1', algorithmVersion: CHANGEOVER_ALGORITHM_VERSION, generatedAtUtc: this.now().toISOString(), requestedFromUtc: input.fromUtc, requestedToUtc: input.toUtc, analyzedFromUtc, analyzedToUtc,
      historyState: limited ? 'LIMITED_HISTORY' : 'AVAILABLE', historyMessage: limited ? 'The requested range exceeds the safe live-source window. Results show the most recent 24 hours only; no broad live-history scan was attempted.' : null,
      mode: input.mode, definition: rule, focusPressKey: input.focusPressKey, evidenceState, support: support(changeovers.length), fleet: summarizePresses(allEvents, input.focusPressKey, pressStates), changeovers, allStops: allEvents, metadataOnlyTransitions: metadataOnly, duration: distribution(durations), phases: summarizePhases(complete), exactReasons: summarizeExactReasons(complete), sequences: summarizeSequences(complete), recoveryCohorts: summarizeRecoveryCohorts(complete), transitionPairs: summarizeTransitionPairs(changeovers), daily, trends: daily.map((item) => ({ periodStartUtc: `${item.date}T00:00:00`, count: item.count, medianDurationSeconds: item.medianDurationSeconds, p90DurationSeconds: distribution(complete.filter((event) => DateTimeSafeDate(event.physical.physicalStartUtc) === item.date).flatMap((event) => event.physical.durationSeconds === null ? [] : [event.physical.durationSeconds])).p90 })),
      diagnostics: { pressCount: RADIUS_PRESS_KEYS.length, successfulPressCount, radiusUnavailablePressCount, telemetryUnavailablePressCount, sequentialRadiusAcquisitions: radiusAcquisitions, radiusConcurrencyCap: changeoverRadiusAcquisitionGuard.cap, peakConcurrentRadiusAcquisitions: changeoverRadiusAcquisitionGuard.diagnostics().lifetimePeak, radiusQueuedAtCompletion: changeoverRadiusAcquisitionGuard.diagnostics().queued, telemetryChunkCount, telemetryRequestCount, cache: 'MISS' },
    }
  }

  async inspect(input: ChangeoverInspectorInput, requestId?: string, signal?: AbortSignal): Promise<ChangeoverInspector | null> {
    if (signal?.aborted) throw abortError()
    const rule = definition(input); const start = Date.parse(input.physicalStartUtc) - INSPECTOR_CONTEXT_MS; const end = Date.parse(input.physicalRecoveryUtc) + (input.recoveryConfirmationSeconds * 1_000) + INSPECTOR_CONTEXT_MS
    const fromUtc = new Date(start).toISOString(); const toUtc = new Date(end).toISOString()
    const evidence = await readPhysicalAndOrder(this.telemetry, input.pressKey, fromUtc, toUtc, requestId, signal)
    let radiusSegments
    try { radiusSegments = this.radius.getRawTimeline ? (await changeoverRadiusAcquisitionGuard.run(() => this.radius.getRawTimeline!(input.pressKey, fromUtc, toUtc), { signal })).segments : undefined } catch (error) { if (signal?.aborted) throw error; radiusSegments = undefined }
    const assembled = assembleChangeovers({ pressKey: input.pressKey, displayName: evidence.displayName, context: evidence.context, stops: detectPhysicalStops(evidence.actual.samples, rule), definition: rule, ...(radiusSegments ? { radiusSegments } : {}) })
    const event = assembled.events.find((item) => item.changeoverId === input.changeoverId && item.physical.physicalStartUtc === input.physicalStartUtc && item.physical.physicalRecoveryUtc === input.physicalRecoveryUtc)
    if (!event) return null
    const orderSeed = evidence.context.fields.order.seed; const orderTrack: ChangeoverInspector['orderTrack'] = []
    if (orderSeed) orderTrack.push({ atUtc: orderSeed.observedAtUtc, value: usableJobIdentity(orderSeed.value, orderSeed.qualityState), kind: 'SEED' })
    for (const change of evidence.context.changes.filter((item) => item.field === 'order')) orderTrack.push({ atUtc: change.atUtc, value: usableJobIdentity(change.value, change.qualityState), kind: 'CHANGE' })
    for (const transition of assembled.metadataOnlyTransitions.concat(assembled.events.map((item) => item.orderTransition))) if (transition.identitySettledAtUtc) orderTrack.push({ atUtc: transition.identitySettledAtUtc, value: transition.finalResolvedOrder, kind: 'SETTLED' })
    orderTrack.sort((a, b) => Date.parse(a.atUtc) - Date.parse(b.atUtc))
    return { version: 'changeover-intelligence-inspector-v1', algorithmVersion: CHANGEOVER_ALGORITHM_VERSION, generatedAtUtc: this.now().toISOString(), definition: rule, event, speed: { canonicalId: 'machine.speed.actual', sourceUnit: evidence.actual.sourceUnit, samples: evidence.actual.samples }, orderTrack }
  }
}

function DateTimeSafeDate(value: string): string { return DateTime.fromISO(value, { zone: 'utc' }).setZone('America/Chicago').toISODate() ?? '' }
