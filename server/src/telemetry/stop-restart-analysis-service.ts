import type { RadiusPressKey } from '../radius/models.js'
import { ENGINEERING_CLUE_CATALOG, type EngineeringCategory, type EngineeringSignalType } from './engineering-clue-analysis.js'
import type { PressSemanticSignalEvidence, TelemetryChange, TelemetrySample, TelemetrySemanticSelector } from './telemetry-contracts.js'
import { TelemetryFoundationService } from './telemetry-foundation-service.js'
import {
  PRE_STOP_REFERENCE_POLICY,
  PHYSICAL_SPEED_POLICY,
  alignSignalToSpeed,
  buildStopPhases,
  descriptiveStats,
  matchPhysicalStop,
  numericObservations,
  physicalSpeedBucket,
  referenceDeviation,
  speedBucketReferences,
  summarizeRadiusTiming,
  type DescriptiveStats,
  type NumericObservation,
  type PhysicalSpeedBucket,
  type SpeedBucketReference,
  type StopPhases,
} from './stop-restart-analysis.js'

export interface StopRestartOccurrenceInput {
  occurrenceId: string
  pressKey: RadiusPressKey
  displayName: string
  startUtc: string
  endUtc: string
  operationalGroupKey: string
  operationalGroupName: string
  processFamilyKey: string
  processFamilyName: string
  exactIdentities: Array<{ eventType: string; statusCode: string | null; statusDescription: string }>
}

export interface StopRestartCandidateInput { canonicalId: string; deckNumber?: number; friendlyName?: string; signalType?: EngineeringSignalType; category?: EngineeringCategory; source: 'clue' | 'pin' | 'priority' }
export interface StopRestartAnalysisInput { occurrence: StopRestartOccurrenceInput; candidates: StopRestartCandidateInput[] }
export interface RadiusTimingAnalysisInput { exactIdentity: { eventType: string; statusCode: string | null; statusDescription: string }; occurrences: Array<{ occurrenceId: string; pressKey: RadiusPressKey; displayName: string; startUtc: string }> }
export interface FleetSpeedContextInput { fromUtc: string; toUtc: string; pressKeys: RadiusPressKey[] }
export type RecoveryClassification = 'RETURNED_TOWARD_REFERENCE' | 'REMAINED_SHIFTED' | 'AFTER_RESTART_SPEED_NOT_COMPARABLE' | 'INSUFFICIENT_AFTER_RESTART_EVIDENCE'

export interface PreStopFlag {
  canonicalId: string
  deckNumber: number | null
  friendlyName: string
  signalType: EngineeringSignalType
  category: EngineeringCategory
  direction: 'ABOVE' | 'BELOW'
  current: DescriptiveStats
  reference: DescriptiveStats
  afterRestart: DescriptiveStats | null
  speedBucket: PhysicalSpeedBucket
  referencePercentile: number
  robustDeviation: number
  excludedReferenceObservationsWithoutFreshSpeed: number
  recovery: RecoveryClassification
  wording: string
}

export interface StopRestartContextEvent { atUtc: string; kind: 'SPEED' | 'RADIUS' | 'MOTION' | 'RAW_STATE'; label: string; canonicalId?: string; deckNumber?: number | null }
export interface StopRestartResponse {
  occurrence: StopRestartOccurrenceInput
  analysisWindow: { fromUtc: string; toUtc: string }
  physicalStopMatch: ReturnType<typeof matchPhysicalStop>
  phases: StopPhases | null
  radiusTiming: { offsetSeconds: number | null; wording: string }
  speedContext: { preStopBucket: PhysicalSpeedBucket | null; currentPercentile: number | null; referencePeriod: { fromUtc: string; toUtc: string; hours: number }; samePressBuckets: SpeedBucketReference[] }
  preStopFlags: PreStopFlag[]
  noFlagMessage: string | null
  stopRestartContext: StopRestartContextEvent[]
  referenceMetadata: { status: 'AVAILABLE' | 'NOT_APPLICABLE' | 'INSUFFICIENT' | 'TEMPORARILY_UNAVAILABLE'; chunkHours: number; requestCount: number; candidateCount: number; excludedObservationsWithoutFreshSpeed: number; automaticCandidateLimit: number; flagLimit: number; cache: 'hit' | 'miss'; message: string }
  performance: { upstreamCalls: number; currentSelectors: number; referenceSelectors: number; totalMs: number; responsePayloadBytes: number }
}

const HIGH_VALUE_MACHINE = ['web_tension.chill_draw.actual', 'unwind.tension.actual', 'rewind.tension.actual', 'dryer.tunnel.temperature.actual']
const CONTEXT_IDS = ['deck.active', 'deck.print_on', 'deck.print_off', 'ink.pump.status', 'ink.pump.sequence', 'ink.washup.state']
const REFERENCE_CACHE_MAXIMUM = 32
const REFERENCE_CACHE_TTL_MS = 5 * 60_000
const TIMING_CACHE_MAXIMUM = 160

interface ReferenceSignalSummary { buckets: Record<PhysicalSpeedBucket, DescriptiveStats | null>; excluded: number }
interface ReferenceSummary { speedBuckets: SpeedBucketReference[]; speedValues: Record<PhysicalSpeedBucket, number[]>; signals: Map<string, ReferenceSignalSummary>; requestCount: number; createdAt: number }

const signalKey = ({ canonicalId, deckNumber }: { canonicalId: string; deckNumber?: number | null }) => `${canonicalId}:${deckNumber ?? ''}`
const delay = (milliseconds: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => { const timer = setTimeout(resolve, milliseconds); signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason) }, { once: true }) })
const catalogItem = (canonicalId: string) => ENGINEERING_CLUE_CATALOG.find((item) => item.canonicalId === canonicalId)
const sampleAt = (sample: TelemetrySample) => ({ atUtc: sample.observedAtUtc, value: typeof sample.value === 'number' ? sample.value : Number.NaN })
const within = (samples: NumericObservation[], fromUtc: string | null, toUtc: string | null) => !fromUtc || !toUtc ? [] : samples.filter(({ atUtc }) => Date.parse(atUtc) >= Date.parse(fromUtc) && Date.parse(atUtc) <= Date.parse(toUtc))

function candidates(input: StopRestartCandidateInput[], capabilities: Awaited<ReturnType<TelemetryFoundationService['capabilities']['get']>>['capabilities']): StopRestartCandidateInput[] {
  const requested = [...input]
  for (const canonicalId of HIGH_VALUE_MACHINE) requested.push({ canonicalId, source: 'priority' })
  const unique = requested.filter((item, index, all) => all.findIndex((candidate) => signalKey(candidate) === signalKey(item)) === index)
  return unique.filter((item) => {
    const definition = catalogItem(item.canonicalId)
    const capability = capabilities.find(({ canonicalId }) => canonicalId === item.canonicalId)
    return definition?.signalType === 'continuous' && capability?.state === 'SUPPORTED' && capability.historyQueryable && (item.deckNumber === undefined || capability.deckNumbers.includes(item.deckNumber))
  }).slice(0, PRE_STOP_REFERENCE_POLICY.maximumAutomaticCandidates)
}

function contextSelectors(capabilities: Awaited<ReturnType<TelemetryFoundationService['capabilities']['get']>>['capabilities'], decks: number[]): TelemetrySemanticSelector[] {
  return CONTEXT_IDS.flatMap((canonicalId) => {
    const capability = capabilities.find((item) => item.canonicalId === canonicalId)
    if (capability?.state !== 'SUPPORTED' || !capability.historyQueryable) return []
    return decks.filter((deck) => capability.deckNumbers.includes(deck)).map((deckNumber) => ({ canonicalId, deckNumber, representation: 'changes' as const }))
  }).slice(0, 24)
}

function contextChange(change: TelemetryChange, signal: PressSemanticSignalEvidence): StopRestartContextEvent {
  return { atUtc: change.observedAtUtc, kind: 'RAW_STATE', canonicalId: signal.canonicalId, deckNumber: signal.deckNumber, label: `${signal.deckNumber === null ? 'Machine' : `Deck ${signal.deckNumber}`} ${signal.canonicalId} raw ${String(change.previousValue)} → ${String(change.value)}` }
}

function recovery(current: DescriptiveStats, reference: DescriptiveStats, after: DescriptiveStats | null, sameBucket: boolean): RecoveryClassification {
  if (!sameBucket) return 'AFTER_RESTART_SPEED_NOT_COMPARABLE'
  if (!after || after.count < PRE_STOP_REFERENCE_POLICY.minimumCurrentObservations) return 'INSUFFICIENT_AFTER_RESTART_EVIDENCE'
  const beforeDistance = Math.abs(current.median - reference.median); const afterDistance = Math.abs(after.median - reference.median)
  if (after.median >= reference.p05 && after.median <= reference.p95 || afterDistance <= beforeDistance * .5) return 'RETURNED_TOWARD_REFERENCE'
  return 'REMAINED_SHIFTED'
}

export class StopRestartAnalysisService {
  private readonly referenceCache = new Map<string, ReferenceSummary>()
  private readonly timingCache = new Map<string, { createdAt: number; match: ReturnType<typeof matchPhysicalStop> }>()
  constructor(private readonly telemetry: TelemetryFoundationService, private readonly now: () => number = Date.now) {}

  private cached(key: string): ReferenceSummary | undefined {
    const value = this.referenceCache.get(key)
    if (!value || this.now() - value.createdAt > REFERENCE_CACHE_TTL_MS) { this.referenceCache.delete(key); return undefined }
    this.referenceCache.delete(key); this.referenceCache.set(key, value); return value
  }

  private store(key: string, value: ReferenceSummary) {
    this.referenceCache.set(key, value)
    while (this.referenceCache.size > REFERENCE_CACHE_MAXIMUM) this.referenceCache.delete(this.referenceCache.keys().next().value!)
  }

  private cachedTiming(key: string) {
    const value = this.timingCache.get(key)
    if (!value || this.now() - value.createdAt > REFERENCE_CACHE_TTL_MS) { this.timingCache.delete(key); return undefined }
    this.timingCache.delete(key); this.timingCache.set(key, value); return value.match
  }

  private storeTiming(key: string, match: ReturnType<typeof matchPhysicalStop>) {
    this.timingCache.set(key, { createdAt: this.now(), match })
    while (this.timingCache.size > TIMING_CACHE_MAXIMUM) this.timingCache.delete(this.timingCache.keys().next().value!)
  }

  private async reference(pressKey: RadiusPressKey, fromUtc: string, toUtc: string, selected: StopRestartCandidateInput[], cacheBucket: PhysicalSpeedBucket | 'ALL_SPEED_BUCKETS', requestId?: string, signal?: AbortSignal): Promise<{ value: ReferenceSummary; cache: 'hit' | 'miss'; upstreamRequestCount: number }> {
    const key = `${pressKey}|${fromUtc}|${toUtc}|${cacheBucket}|${selected.map(signalKey).join(',')}`
    const cached = this.cached(key); if (cached) return { value: cached, cache: 'hit', upstreamRequestCount: 0 }
    const speed: NumericObservation[] = []; const signalValues = new Map<string, NumericObservation[]>()
    const chunkMs = PRE_STOP_REFERENCE_POLICY.chunkHours * 60 * 60_000
    let requestCount = 0
    for (let cursor = Date.parse(fromUtc); cursor < Date.parse(toUtc); cursor += chunkMs) {
      if (signal?.aborted) throw signal.reason
      const chunk = { fromUtc: new Date(cursor).toISOString(), toUtc: new Date(Math.min(Date.parse(toUtc), cursor + chunkMs)).toISOString(), includeSeed: false, signals: [{ canonicalId: 'machine.speed.actual', representation: 'samples' as const }, ...selected.map(({ canonicalId, deckNumber }) => ({ canonicalId, ...(deckNumber === undefined ? {} : { deckNumber }), representation: 'samples' as const }))] }
      let history
      try { requestCount += 1; history = await this.telemetry.semanticHistory(pressKey, chunk, requestId, signal) }
      catch (error) { if (signal?.aborted) throw error; await delay(250, signal); requestCount += 1; history = await this.telemetry.semanticHistory(pressKey, chunk, requestId, signal) }
      for (const item of history.signals) {
        const points = item.samples.map(sampleAt).filter(({ value }) => Number.isFinite(value))
        if (item.canonicalId === 'machine.speed.actual') speed.push(...points)
        else signalValues.set(signalKey(item), [...signalValues.get(signalKey(item)) ?? [], ...points])
      }
    }
    const alignedSpeed = Object.fromEntries(['STOPPED', 'LOW_TRANSITION', 'RUNNING', 'HIGH_SPEED_RUNNING'].map((bucket) => [bucket, speed.filter(({ value }) => physicalSpeedBucket(value) === bucket).map(({ value }) => value)])) as ReferenceSummary['speedValues']
    const signals = new Map<string, ReferenceSignalSummary>()
    for (const item of selected) {
      const aligned = alignSignalToSpeed(signalValues.get(signalKey(item)) ?? [], speed)
      signals.set(signalKey(item), { buckets: Object.fromEntries(Object.entries(aligned.values).map(([bucket, values]) => [bucket, descriptiveStats(values)])) as ReferenceSignalSummary['buckets'], excluded: aligned.excludedWithoutFreshSpeed })
    }
    const value = { speedBuckets: speedBucketReferences(speed, fromUtc, toUtc), speedValues: alignedSpeed, signals, requestCount, createdAt: this.now() }
    this.store(key, value); return { value, cache: 'miss', upstreamRequestCount: requestCount }
  }

  async analyze(input: StopRestartAnalysisInput, requestId?: string, signal?: AbortSignal): Promise<StopRestartResponse> {
    const started = this.now(); const occurrence = input.occurrence
    const window = { fromUtc: new Date(Date.parse(occurrence.startUtc) - PHYSICAL_SPEED_POLICY.detailedWindowBeforeMs).toISOString(), toUtc: new Date(Date.parse(occurrence.startUtc) + PHYSICAL_SPEED_POLICY.detailedWindowAfterMs).toISOString() }
    const capabilitySet = await this.telemetry.capabilities.get(occurrence.pressKey, requestId, signal)
    const selected = candidates(input.candidates, capabilitySet.capabilities)
    const decks = [...new Set(selected.flatMap(({ deckNumber }) => deckNumber === undefined ? [] : [deckNumber]))].slice(0, 4)
    const stateSelectors = contextSelectors(capabilitySet.capabilities, decks)
    const semanticSelectors: TelemetrySemanticSelector[] = [{ canonicalId: 'machine.speed.actual', representation: 'samples' }, ...selected.map(({ canonicalId, deckNumber }) => ({ canonicalId, ...(deckNumber === undefined ? {} : { deckNumber }), representation: 'samples' as const })), ...stateSelectors]
    const [current, motion] = await Promise.all([
      this.telemetry.semanticHistory(occurrence.pressKey, { ...window, includeSeed: true, signals: semanticSelectors }, requestId, signal),
      this.telemetry.motion(occurrence.pressKey, window.fromUtc, window.toUtc, requestId, signal).catch(() => undefined),
    ])
    const speedSignal = current.signals.find(({ canonicalId }) => canonicalId === 'machine.speed.actual')
    const speed = numericObservations(speedSignal?.samples ?? [])
    const match = matchPhysicalStop(speed, occurrence.startUtc)
    const phases = match.status === 'MATCHED' && match.selected ? buildStopPhases(speed, match.selected) : null
    let referenceStatus: StopRestartResponse['referenceMetadata']['status'] = phases?.stableRunningBefore.supported ? 'AVAILABLE' : 'NOT_APPLICABLE'
    let referenceCache: 'hit' | 'miss' = 'miss'; let referenceRequests = 0; let samePressBuckets: SpeedBucketReference[] = []; let excluded = 0; const flags: PreStopFlag[] = []
    const referenceTo = new Date(Date.parse(window.fromUtc)).toISOString(); const referenceFrom = new Date(Date.parse(referenceTo) - PRE_STOP_REFERENCE_POLICY.referenceHours * 60 * 60_000).toISOString()
    if (phases?.stableRunningBefore.supported && phases.stableRunningBefore.bucket) {
      try {
        const result = await this.reference(occurrence.pressKey, referenceFrom, referenceTo, selected, phases.stableRunningBefore.bucket, requestId, signal)
        referenceCache = result.cache; referenceRequests = result.upstreamRequestCount; samePressBuckets = result.value.speedBuckets
        const bucket = phases.stableRunningBefore.bucket
        for (const identity of selected) {
          const item = current.signals.find((candidate) => signalKey(candidate) === signalKey(identity)); if (!item) continue
          const currentPoints = within(numericObservations(item.samples), phases.stableRunningBefore.fromUtc, phases.stableRunningBefore.toUtc)
          const currentStats = descriptiveStats(currentPoints.map(({ value }) => value)); const reference = result.value.signals.get(signalKey(identity)); const referenceStats = reference?.buckets[bucket] ?? null
          excluded += reference?.excluded ?? 0
          if (!currentStats || currentStats.count < PRE_STOP_REFERENCE_POLICY.minimumCurrentObservations || !referenceStats || referenceStats.count < PRE_STOP_REFERENCE_POLICY.minimumReferenceObservations) continue
          const deviation = referenceDeviation(currentStats, referenceStats); if (!deviation.qualifies || !deviation.direction) continue
          const afterPoints = phases.sustainedRunningAgain.supported ? within(numericObservations(item.samples), phases.sustainedRunningAgain.fromUtc, phases.sustainedRunningAgain.toUtc) : []
          const afterStats = descriptiveStats(afterPoints.map(({ value }) => value))
          const definition = catalogItem(identity.canonicalId)!
          const recoveryState = recovery(currentStats, referenceStats, afterStats, phases.sustainedRunningAgain.bucket === bucket)
          flags.push({ canonicalId: identity.canonicalId, deckNumber: identity.deckNumber ?? null, friendlyName: identity.friendlyName ?? definition.friendlyName, signalType: definition.signalType, category: identity.category ?? definition.category, direction: deviation.direction, current: currentStats, reference: referenceStats, afterRestart: afterStats, speedBucket: bucket, referencePercentile: deviation.referencePercentile, robustDeviation: deviation.robustDeviation, excludedReferenceObservationsWithoutFreshSpeed: reference?.excluded ?? 0, recovery: recoveryState, wording: `${identity.friendlyName ?? definition.friendlyName} was observed ${deviation.direction.toLowerCase()} the same-press, comparable-speed historical reference while the press was still physically running. This is worth inspecting and remains descriptive evidence only.` })
        }
        flags.sort((left, right) => right.robustDeviation - left.robustDeviation || left.friendlyName.localeCompare(right.friendlyName)); flags.splice(PRE_STOP_REFERENCE_POLICY.maximumFlags)
        if (!samePressBuckets.some(({ observationCount }) => observationCount > 0)) referenceStatus = 'INSUFFICIENT'
      } catch (error) { if (signal?.aborted) throw error; referenceStatus = 'TEMPORARILY_UNAVAILABLE' }
    }
    const selectedOffset = match.selected ? match.selected.radiusOffsetSeconds : null
    const offsetText = selectedOffset === null ? 'No single physical stop was associated with this Radius occurrence.' : selectedOffset >= 0 ? `Radius was recorded ${Math.round(selectedOffset)} seconds before the observed physical stop.` : `Radius was recorded ${Math.round(Math.abs(selectedOffset))} seconds after the observed physical stop.`
    const context: StopRestartContextEvent[] = []
    if (phases?.deceleration.fromUtc) context.push({ atUtc: phases.deceleration.fromUtc, kind: 'SPEED', label: 'Speed left the prior physical running bucket; observed lead-up / deceleration began.' })
    if (match.selected) context.push({ atUtc: match.selected.atUtc, kind: 'SPEED', label: `Actual speed entered STOPPED at observed value ${match.selected.observedSpeed}.` })
    context.push({ atUtc: occurrence.startUtc, kind: 'RADIUS', label: `Radius recorded ${occurrence.exactIdentities.map(({ eventType, statusCode, statusDescription }) => `${eventType} / ${statusCode ?? '—'} / ${statusDescription}`).join('; ')}.` })
    for (const item of current.signals.filter(({ representation }) => representation === 'changes')) context.push(...item.changes.map((change) => contextChange(change, item)))
    if (motion) for (const segment of motion.segments.slice(1)) context.push({ atUtc: segment.fromUtc, kind: 'MOTION', label: `Physical Motion ${segment.state} observed.` })
    for (const attempt of phases?.restartAttempts ?? []) context.push({ atUtc: attempt.startUtc, kind: 'SPEED', label: attempt.sustainedRunning ? `Restart attempt ${attempt.attempt} reached physical running; sustained running was confirmed at ${attempt.sustainedConfirmedAtUtc}.` : `Restart attempt ${attempt.attempt} reached ${attempt.maximumObservedSpeed.toFixed(1)} (${attempt.highestBucket})${attempt.returnedToStopped ? ' and returned to STOPPED' : ''}.` })
    context.sort((left, right) => Date.parse(left.atUtc) - Date.parse(right.atUtc)); context.splice(120)
    const bucket = phases?.stableRunningBefore.bucket ?? null
    const referenceBucketValues = bucket && samePressBuckets.length ? samePressBuckets.find((item) => item.bucket === bucket) : undefined
    const currentMedian = phases?.stableRunningBefore.stats?.median
    const currentPercentile = currentMedian !== undefined && referenceBucketValues?.stats ? currentMedian <= referenceBucketValues.stats.p25 ? 25 : currentMedian >= referenceBucketValues.stats.p95 ? 95 : currentMedian >= referenceBucketValues.stats.p75 ? 75 : 50 : null
    const completed = this.now()
    const response: StopRestartResponse = { occurrence, analysisWindow: window, physicalStopMatch: match, phases, radiusTiming: { offsetSeconds: selectedOffset === null ? null : -selectedOffset, wording: offsetText }, speedContext: { preStopBucket: bucket, currentPercentile, referencePeriod: { fromUtc: referenceFrom, toUtc: referenceTo, hours: PRE_STOP_REFERENCE_POLICY.referenceHours }, samePressBuckets }, preStopFlags: flags, noFlagMessage: match.status === 'MATCHED' && !flags.length ? 'No strong pre-stop deviation was identified against the available comparable-speed reference.' : null, stopRestartContext: context, referenceMetadata: { status: referenceStatus, chunkHours: PRE_STOP_REFERENCE_POLICY.chunkHours, requestCount: referenceRequests, candidateCount: selected.length, excludedObservationsWithoutFreshSpeed: excluded, automaticCandidateLimit: PRE_STOP_REFERENCE_POLICY.maximumAutomaticCandidates, flagLimit: PRE_STOP_REFERENCE_POLICY.maximumFlags, cache: referenceCache, message: `Same-press reference uses the preceding ${PRE_STOP_REFERENCE_POLICY.referenceHours} hours in sequential ${PRE_STOP_REFERENCE_POLICY.chunkHours}-hour chunks. It is not a lifetime normal or an engineering limit.` }, performance: { upstreamCalls: 3 + referenceRequests, currentSelectors: semanticSelectors.length, referenceSelectors: selected.length + 1, totalMs: completed - started, responsePayloadBytes: 0 } }
    response.performance.responsePayloadBytes = Buffer.byteLength(JSON.stringify(response), 'utf8')
    return response
  }

  async analyzeRadiusTiming(input: RadiusTimingAnalysisInput, requestId?: string, signal?: AbortSignal) {
    const started = this.now()
    const observations = []
    let upstreamCalls = 0; let cacheHits = 0
    for (const occurrence of input.occurrences.slice(0, 30)) {
      if (signal?.aborted) throw signal.reason
      const key = `${occurrence.pressKey}|${occurrence.startUtc}`
      let match = this.cachedTiming(key)
      if (match) cacheHits += 1
      else {
        const fromUtc = new Date(Date.parse(occurrence.startUtc) - PHYSICAL_SPEED_POLICY.stopSearchBeforeMs).toISOString()
        const toUtc = new Date(Date.parse(occurrence.startUtc) + PHYSICAL_SPEED_POLICY.stopSearchAfterMs).toISOString()
        const history = await this.telemetry.semanticHistory(occurrence.pressKey, { fromUtc, toUtc, includeSeed: true, signals: [{ canonicalId: 'machine.speed.actual', representation: 'samples' }] }, requestId, signal)
        upstreamCalls += 1
        match = matchPhysicalStop(numericObservations(history.signals.find(({ canonicalId }) => canonicalId === 'machine.speed.actual')?.samples ?? []), occurrence.startUtc)
        this.storeTiming(key, match)
      }
      observations.push({ occurrenceId: occurrence.occurrenceId, pressKey: occurrence.pressKey, displayName: occurrence.displayName, matchStatus: match.status, offsetSeconds: match.selected ? -match.selected.radiusOffsetSeconds : null })
    }
    const summary = summarizeRadiusTiming(observations)
    return { exactIdentity: input.exactIdentity, ...summary, support: { analyzedOccurrenceCount: observations.length, maximumOccurrences: 30, pressMedianMinimumMatched: 3, nearThresholdSeconds: 30 }, performance: { upstreamCalls, cacheHits, totalMs: this.now() - started } }
  }

  async fleetSpeedContext(input: FleetSpeedContextInput, requestId?: string, signal?: AbortSignal) {
    const started = this.now(); const presses = []; let upstreamCalls = 0
    for (const pressKey of [...new Set(input.pressKeys)].slice(0, 6)) {
      if (signal?.aborted) throw signal.reason
      try {
        const result = await this.reference(pressKey, input.fromUtc, input.toUtc, [], 'ALL_SPEED_BUCKETS', requestId, signal)
        upstreamCalls += result.upstreamRequestCount
        presses.push({ pressKey, status: 'AVAILABLE' as const, buckets: result.value.speedBuckets, cache: result.cache })
      } catch (error) {
        if (signal?.aborted) throw error
        presses.push({ pressKey, status: 'TEMPORARILY_UNAVAILABLE' as const, buckets: [], cache: 'miss' as const })
      }
    }
    return { referencePeriod: { fromUtc: input.fromUtc, toUtc: input.toUtc, hours: (Date.parse(input.toUtc) - Date.parse(input.fromUtc)) / 3_600_000 }, presses, rawEngineeringComparison: { status: 'DEFERRED' as const, message: 'Direct raw fleet comparison is unavailable because engineering representation is not verified as comparable.' }, performance: { upstreamCalls, totalMs: this.now() - started } }
  }
}
