import type { RadiusService } from '../radius/radius-service.js'
import type { PressSemanticSignalWithIdentity, TelemetryFoundationService } from '../telemetry/telemetry-foundation-service.js'
import type { PressEvidenceCapabilities, TelemetrySample, TelemetrySemanticSelector } from '../telemetry/telemetry-contracts.js'
import { canonicalSpeedConfiguration, stopIdentityAssociationConfiguration } from './configuration.js'
import { classifyStop } from './classification-engine.js'
import {
  type CanonicalSpeedObservation,
  STOP_INTELLIGENCE_ALGORITHM_VERSION,
  STOP_INTELLIGENCE_CLASSIFICATION_VERSION,
  type ClassifiedStop,
  type StopFleetEpisode,
  type StopFleetPressSummary,
  type StopIntelligenceDetail,
  type StopIntelligenceFleetReport,
  type StopIntelligenceReport,
  type StopIntelligenceRequest,
  type StopSpeedContext,
  type StopSetupFamily,
  type TelemetryAvailabilityInterval,
} from './contracts.js'
import { buildStopEvidence, STOP_FAMILY_CANONICAL_PATTERNS, stopIdentityDefinitions } from './evidence-model.js'
import { analyzePhysicalStops, normalizeSpeedQuality } from './physical-stop-engine.js'
import { overlayRadius } from './radius-overlay.js'
import { buildChangeoverActions } from './action-engine.js'

export class StopIntelligenceConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StopIntelligenceConfigurationError'
  }
}

const validTime = (value: string) => Number.isFinite(Date.parse(value))
const asObservation = (sample: TelemetrySample, atUtc = sample.observedAtUtc): CanonicalSpeedObservation => ({ atUtc, speed: typeof sample.value === 'number' ? sample.value : null, qualityState: sample.qualityState })
const STOP_DETAIL_CONTEXT_MS = 15 * 60_000
export const STOP_INTELLIGENCE_PRESS_KEYS: StopIntelligenceRequest['pressKey'][] = ['press14', 'press15']
export const stopIntelligenceStopId = (segment: Pick<ClassifiedStop['physicalSegment'], 'pressKey' | 'startAt'>) => `${segment.pressKey}-${Date.parse(segment.startAt)}`

interface AnalysisReadResult {
  report: StopIntelligenceReport
  speedHistory: TelemetrySample[]
  sourceGaps: Array<{ startUtc: string; endUtc: string }>
  signals: PressSemanticSignalWithIdentity[]
  identityEvidenceCutoffUtc: string
}

function availabilityIntervals(gaps: Array<{ startUtc: string; endUtc: string }>, fromUtc: string, toUtc: string): TelemetryAvailabilityInterval[] {
  const from = Date.parse(fromUtc); const to = Date.parse(toUtc)
  return gaps.flatMap((gap) => {
    const start = Math.max(from, Date.parse(gap.startUtc)); const end = Math.min(to, Date.parse(gap.endUtc))
    return end > start ? [{ fromUtc: new Date(start).toISOString(), toUtc: new Date(end).toISOString(), state: 'UNKNOWN_COLLECTION' as const }] : []
  })
}

function reportEvidenceState(observations: CanonicalSpeedObservation[], gaps: TelemetryAvailabilityInterval[]): StopIntelligenceReport['telemetryEvidenceState'] {
  if (observations.some((item) => typeof item.speed === 'number' && normalizeSpeedQuality(item.qualityState) === 'GOOD')) return 'AVAILABLE'
  return gaps.length || !observations.length ? 'UNKNOWN_COLLECTION' : 'UNKNOWN_SPEED_QUALITY'
}

function speedQualityIntervals(samples: TelemetrySample[], fromUtc: string, toUtc: string): TelemetryAvailabilityInterval[] {
  const from = Date.parse(fromUtc); const to = Date.parse(toUtc)
  const ordered = samples.filter((item) => validTime(item.observedAtUtc)).sort((left, right) => Date.parse(left.observedAtUtc) - Date.parse(right.observedAtUtc))
  const intervals: TelemetryAvailabilityInterval[] = []
  for (let index = 0; index < ordered.length; index += 1) {
    const sample = ordered[index]!
    if (normalizeSpeedQuality(sample.qualityState) === 'GOOD') continue
    const nextGood = ordered.slice(index + 1).find((item) => normalizeSpeedQuality(item.qualityState) === 'GOOD')
    const start = Math.max(from, Date.parse(sample.observedAtUtc)); const end = Math.min(to, nextGood ? Date.parse(nextGood.observedAtUtc) : to)
    if (end > start) intervals.push({ fromUtc: new Date(start).toISOString(), toUtc: new Date(end).toISOString(), state: 'UNKNOWN_SPEED_QUALITY' })
  }
  return intervals
}

function fleetEpisode(stop: ClassifiedStop): StopFleetEpisode {
  const segment = stop.physicalSegment
  const segmentEnd = Date.parse(segment.endAt ?? segment.startAt)
  const overlap = (state: ClassifiedStop['radius']['states'][number]) => Math.max(0, Math.min(segmentEnd, Date.parse(state.endUtc)) - Math.max(Date.parse(segment.startAt), Date.parse(state.startUtc)))
  const radiusState = [...stop.radius.states].filter((state) => overlap(state) > 0).sort((left, right) => overlap(right) - overlap(left))[0]
  return {
    stopId: stopIntelligenceStopId(segment), pressKey: segment.pressKey, startAt: segment.startAt, endAt: segment.endAt,
    physicalDurationSeconds: segment.physicalDurationSeconds, classification: stop.classification, confidence: stop.confidence,
    movementAttemptCount: segment.movementAttempts.length, failedRecoveryCount: segment.failedRecoveryCount, radiusAlignment: stop.radiusAlignment,
    radiusStatusDescription: radiusState?.kind === 'offline' ? 'Unavailable' : radiusState?.statusDescription ?? null,
    primaryReasonCodes: [...stop.supportingEvidence, ...stop.conflictingEvidence].slice(0, 4).map(({ code }) => code),
    leftCensored: segment.leftCensored, rightCensored: segment.rightCensored,
    affectedByCollectionGap: segment.leftCensorReason === 'UNKNOWN_COLLECTION' || segment.rightCensorReason === 'UNKNOWN_COLLECTION',
    affectedBySpeedQuality: segment.leftCensorReason === 'UNKNOWN_SPEED_QUALITY' || segment.rightCensorReason === 'UNKNOWN_SPEED_QUALITY',
  }
}

function fleetPress(report: StopIntelligenceReport, speedContext: StopSpeedContext): StopFleetPressSummary {
  const episodes = report.classifiedStops.map(fleetEpisode)
  const count = (classification: ClassifiedStop['classification']) => episodes.filter((item) => item.classification === classification).length
  const affected = episodes.some((item) => item.leftCensored || item.rightCensored || item.affectedByCollectionGap || item.affectedBySpeedQuality)
  const hasSourceGap = speedContext.unknownIntervals.some(({ state }) => state === 'UNKNOWN_COLLECTION')
  const warning = report.telemetryEvidenceState !== 'AVAILABLE' || affected || hasSourceGap
  return {
    pressKey: report.configuration.pressKey, displayName: report.displayName, telemetryEvidenceState: report.telemetryEvidenceState,
    stopCount: episodes.length, totalPhysicalStopSeconds: episodes.reduce((sum, item) => sum + item.physicalDurationSeconds, 0),
    changeoverCount: count('CHANGEOVER'), downtimeCount: count('DOWNTIME'), uncertainCount: count('UNCERTAIN'), badDataCount: count('IGNORE_BAD_DATA'),
    changeoverPhysicalStopSeconds: episodes.filter((item) => item.classification === 'CHANGEOVER').reduce((sum, item) => sum + item.physicalDurationSeconds, 0),
    longestPhysicalStopSeconds: Math.max(0, ...episodes.map((item) => item.physicalDurationSeconds)), dataAvailabilityWarning: warning,
    warningReason: report.telemetryEvidenceState !== 'AVAILABLE' ? `Canonical speed evidence is ${report.telemetryEvidenceState.toLowerCase().replaceAll('_', ' ')}.` : affected ? 'One or more stops are censored or affected by incomplete telemetry.' : hasSourceGap ? 'A corroborated telemetry collection gap occurs in the selected range.' : null,
    episodes, speedContext,
  }
}

const MAX_FLEET_SPEED_BUCKETS = 600

export function downsampleFleetSpeed(observations: CanonicalSpeedObservation[]): CanonicalSpeedObservation[] {
  if (observations.length <= MAX_FLEET_SPEED_BUCKETS * 4) return observations
  const bucketSize = Math.ceil(observations.length / MAX_FLEET_SPEED_BUCKETS)
  const retained = new Map<string, CanonicalSpeedObservation>()
  for (let index = 0; index < observations.length; index += bucketSize) {
    const bucket = observations.slice(index, index + bucketSize)
    const numeric = bucket.filter((item): item is CanonicalSpeedObservation & { speed: number } => typeof item.speed === 'number' && normalizeSpeedQuality(item.qualityState) === 'GOOD')
    for (const item of [bucket[0], numeric.reduce((minimum, item) => item.speed < minimum.speed ? item : minimum, numeric[0]!), numeric.reduce((maximum, item) => item.speed > maximum.speed ? item : maximum, numeric[0]!), bucket.at(-1)].filter((item): item is CanonicalSpeedObservation => Boolean(item))) retained.set(item.atUtc, item)
  }
  return [...retained.values()].sort((left, right) => Date.parse(left.atUtc) - Date.parse(right.atUtc))
}

function fleetSpeedContext(result: AnalysisReadResult, fromUtc: string, toUtc: string): StopSpeedContext {
  const from = Date.parse(fromUtc); const to = Date.parse(toUtc)
  const ordered = result.speedHistory.filter((item) => validTime(item.observedAtUtc)).sort((left, right) => Date.parse(left.observedAtUtc) - Date.parse(right.observedAtUtc))
  const prior = ordered.filter((item) => Date.parse(item.observedAtUtc) < from).at(-1)
  const contextMap = new Map<string, CanonicalSpeedObservation>()
  if (prior) contextMap.set(fromUtc, asObservation(prior, fromUtc))
  for (const sample of ordered.filter((item) => { const at = Date.parse(item.observedAtUtc); return at >= from && at <= to })) contextMap.set(sample.observedAtUtc, asObservation(sample))
  const unknownIntervals = [...availabilityIntervals(result.sourceGaps, fromUtc, toUtc), ...speedQualityIntervals(ordered, fromUtc, toUtc)].sort((left, right) => Date.parse(left.fromUtc) - Date.parse(right.fromUtc))
  return { fromUtc, toUtc, unit: 'ft/min', stopThreshold: result.report.configuration.stopThreshold, recoveryThreshold: result.report.configuration.recoveryThreshold, observations: downsampleFleetSpeed([...contextMap.values()].sort((left, right) => Date.parse(left.atUtc) - Date.parse(right.atUtc))), unknownIntervals }
}

function familyFor(canonicalId: string): StopSetupFamily | null {
  return STOP_FAMILY_CANONICAL_PATTERNS.find((value) => value.matches(canonicalId))?.family ?? null
}

function evidenceSelectors(pressKey: StopIntelligenceRequest['pressKey'], capabilities: PressEvidenceCapabilities): { selectors: TelemetrySemanticSelector[]; supportedFamilies: StopSetupFamily[] } {
  const identityIds = new Set(stopIdentityDefinitions(pressKey).flatMap((value) => value.canonicalId ?? []))
  const supported = capabilities.capabilities.filter((value) => value.state === 'SUPPORTED' && value.historyQueryable)
  const selected = supported.filter((value) => identityIds.has(value.canonicalId) || familyFor(value.canonicalId) !== null)
  const selectors: TelemetrySemanticSelector[] = [{ canonicalId: 'machine.speed.actual', representation: 'samples' }]
  for (const capability of selected.sort((left, right) => Number(!identityIds.has(left.canonicalId)) - Number(!identityIds.has(right.canonicalId)) || left.canonicalId.localeCompare(right.canonicalId))) {
    const changes = identityIds.has(capability.canonicalId) || /^(?:deck|register|impression)\./.test(capability.canonicalId) || capability.canonicalId === 'ink.washup.state' || capability.canonicalId === 'ink.pump.status' || /(?:setpoint|rated|command)/i.test(capability.canonicalId)
    if (capability.deckNumbers.length) for (const deckNumber of capability.deckNumbers) selectors.push({ canonicalId: capability.canonicalId, deckNumber, representation: changes ? 'changes' : 'samples' })
    else selectors.push({ canonicalId: capability.canonicalId, representation: changes ? 'changes' : 'samples' })
  }
  const unique = new Map(selectors.map((value) => [`${value.canonicalId}:${value.deckNumber ?? ''}:${value.representation}`, value]))
  const boundedSelectors = [...unique.values()].slice(0, 120)
  return { selectors: boundedSelectors, supportedFamilies: [...new Set(boundedSelectors.flatMap((value) => familyFor(value.canonicalId) ?? []))] }
}

/** Physical bounds come only from validated speed. Other sources cannot move them. */
export class StopIntelligenceService {
  constructor(private readonly telemetry: TelemetryFoundationService, private readonly radius?: RadiusService, private readonly now = () => Date.now()) {}

  async analyze(input: StopIntelligenceRequest, requestId?: string, signal?: AbortSignal): Promise<StopIntelligenceReport> {
    return (await this.analyzeWithReadData(input, requestId, signal)).report
  }

  async fleet(input: Pick<StopIntelligenceRequest, 'fromUtc' | 'toUtc'>, requestId?: string, signal?: AbortSignal): Promise<StopIntelligenceFleetReport> {
    const presses: StopFleetPressSummary[] = []
    // Deliberately sequential: Radius has a strict connection budget and fleet summary is the only fan-out path.
    for (const pressKey of STOP_INTELLIGENCE_PRESS_KEYS) {
      const result = await this.analyzeWithReadData({ ...input, pressKey }, requestId, signal)
      presses.push(fleetPress(result.report, fleetSpeedContext(result, input.fromUtc, input.toUtc)))
    }
    return { ...input, algorithmVersion: STOP_INTELLIGENCE_ALGORITHM_VERSION, classificationVersion: STOP_INTELLIGENCE_CLASSIFICATION_VERSION, presses }
  }

  async detail(input: StopIntelligenceRequest & { stopId: string }, requestId?: string, signal?: AbortSignal): Promise<StopIntelligenceDetail | null> {
    const result = await this.analyzeWithReadData(input, requestId, signal)
    const stop = result.report.classifiedStops.find((item) => stopIntelligenceStopId(item.physicalSegment) === input.stopId)
    if (!stop) return null
    const fromUtc = new Date(Date.parse(stop.physicalSegment.startAt) - STOP_DETAIL_CONTEXT_MS).toISOString()
    const physicalEnd = stop.physicalSegment.endAt ?? input.toUtc
    const toUtc = new Date(Math.min(Date.parse(input.toUtc) + STOP_DETAIL_CONTEXT_MS, Date.parse(physicalEnd) + STOP_DETAIL_CONTEXT_MS)).toISOString()
    const ordered = result.speedHistory.filter((item) => validTime(item.observedAtUtc)).sort((left, right) => Date.parse(left.observedAtUtc) - Date.parse(right.observedAtUtc))
    const prior = ordered.filter((item) => Date.parse(item.observedAtUtc) < Date.parse(fromUtc)).at(-1)
    const contextMap = new Map<string, CanonicalSpeedObservation>()
    if (prior) contextMap.set(fromUtc, asObservation(prior, fromUtc))
    for (const sample of ordered.filter((item) => { const at = Date.parse(item.observedAtUtc); return at >= Date.parse(fromUtc) && at <= Date.parse(toUtc) })) contextMap.set(sample.observedAtUtc, asObservation(sample))
    const unknownIntervals = [...availabilityIntervals(result.sourceGaps, fromUtc, toUtc), ...speedQualityIntervals(ordered, fromUtc, toUtc)].sort((left, right) => Date.parse(left.fromUtc) - Date.parse(right.fromUtc))
    return {
      stopId: input.stopId, displayName: result.report.displayName, rangeFromUtc: input.fromUtc, rangeToUtc: input.toUtc,
      telemetryEvidenceState: result.report.telemetryEvidenceState, identityAssociationConfiguration: result.report.identityAssociationConfiguration, stop,
      speedContext: { fromUtc, toUtc, unit: 'ft/min', stopThreshold: result.report.configuration.stopThreshold, recoveryThreshold: result.report.configuration.recoveryThreshold, observations: [...contextMap.values()].sort((left, right) => Date.parse(left.atUtc) - Date.parse(right.atUtc)), unknownIntervals },
      changeoverActions: buildChangeoverActions({ stop, allStops: result.report.classifiedStops, signals: result.signals, speedSignal: result.signals.find((item) => item.canonicalId === 'machine.speed.actual' && item.deckNumber === null), rangeEndUtc: input.toUtc, evidenceCutoffUtc: result.identityEvidenceCutoffUtc }),
    }
  }

  private async analyzeWithReadData(input: StopIntelligenceRequest, requestId?: string, signal?: AbortSignal): Promise<AnalysisReadResult> {
    const configuration = canonicalSpeedConfiguration(input.pressKey)
    const identityAssociationConfiguration = stopIdentityAssociationConfiguration(input.pressKey)
    if (!configuration || !identityAssociationConfiguration) throw new StopIntelligenceConfigurationError(`No Stop Intelligence mapping is configured for ${input.pressKey}.`)
    const source = await this.telemetry.sources.resolve(input.pressKey, requestId, signal)
    if (source.source.id !== configuration.sourceId) throw new StopIntelligenceConfigurationError(`Configured source ${configuration.sourceId} does not match resolved source ${source.source.id} for ${input.pressKey}.`)

    const capabilities = await this.telemetry.capabilities.get(input.pressKey, requestId, signal)
    const selection = evidenceSelectors(input.pressKey, capabilities)
    const evidenceFromUtc = new Date(Date.parse(input.fromUtc) - identityAssociationConfiguration.identityContextBeforeSeconds * 1_000).toISOString()
    const requestedEvidenceCutoff = Date.parse(input.toUtc) + identityAssociationConfiguration.identityContextAfterSeconds * 1_000
    const identityEvidenceCutoffUtc = new Date(Math.min(requestedEvidenceCutoff, this.now())).toISOString()
    const historyToUtc = new Date(Math.max(Date.parse(input.toUtc), Date.parse(identityEvidenceCutoffUtc))).toISOString()
    const [history, radiusTimeline] = await Promise.all([
      this.telemetry.semanticHistoryWithIdentity(input.pressKey, { fromUtc: evidenceFromUtc, toUtc: historyToUtc, includeSeed: true, signals: selection.selectors }, requestId, signal),
      this.radius?.getRawTimeline ? this.radius.getRawTimeline(input.pressKey, input.fromUtc, input.toUtc).catch(() => null) : Promise.resolve(null),
    ])
    const speed = history.signals.find((item) => item.canonicalId === configuration.canonicalId && item.deckNumber === null)
    if (!speed || speed.historianSignalId !== configuration.canonicalSpeedSignalId) throw new StopIntelligenceConfigurationError(`Resolved canonical speed signal does not match configured historian signal ${configuration.canonicalSpeedSignalId} for ${input.pressKey}.`)

    const from = Date.parse(input.fromUtc); const to = Date.parse(input.toUtc)
    const prior = [speed.seed, ...speed.samples].filter((value): value is TelemetrySample => Boolean(value) && validTime(value!.observedAtUtc) && Date.parse(value!.observedAtUtc) < from).sort((left, right) => Date.parse(left.observedAtUtc) - Date.parse(right.observedAtUtc)).at(-1)
    const observationMap = new Map<string, CanonicalSpeedObservation>()
    if (prior) observationMap.set(input.fromUtc, asObservation(prior, input.fromUtc))
    for (const value of speed.samples.filter((candidate) => { const at = Date.parse(candidate.observedAtUtc); return at >= from && at <= to })) observationMap.set(value.observedAtUtc, asObservation(value))
    const observations = [...observationMap.values()].sort((left, right) => Date.parse(left.atUtc) - Date.parse(right.atUtc))
    const gaps = availabilityIntervals(history.readDiagnostics?.sourceGaps ?? [], input.fromUtc, input.toUtc)
    const analysis = analyzePhysicalStops({ configuration, fromUtc: input.fromUtc, toUtc: input.toUtc, observations, availabilityIntervals: gaps })
    const classifiedStops = analysis.segments.map((segment) => {
      const evidence = buildStopEvidence({ pressKey: input.pressKey, segment, allSegments: analysis.segments, signals: history.signals, physicalRangeEndUtc: input.toUtc, identityEvidenceCutoffUtc, identityAssociationConfiguration, supportedFamilies: selection.supportedFamilies })
      const integrity = segment.physicalDurationSeconds <= 0 ? 'INVALID' : segment.leftCensorReason === 'UNKNOWN_COLLECTION' || segment.rightCensorReason === 'UNKNOWN_COLLECTION' || segment.leftCensorReason === 'UNKNOWN_SPEED_QUALITY' || segment.rightCensorReason === 'UNKNOWN_SPEED_QUALITY' ? 'LIMITED' : 'VALID'
      return classifyStop({ segment, ...evidence, evidenceIntegrity: integrity, radius: overlayRadius(segment, input.toUtc, radiusTimeline?.segments) })
    })
    return {
      report: { ...analysis, displayName: history.displayName, telemetryEvidenceState: reportEvidenceState(observations, gaps), identityAssociationConfiguration, classifiedStops },
      speedHistory: [speed.seed, ...speed.samples].filter((item): item is TelemetrySample => Boolean(item)),
      sourceGaps: history.readDiagnostics?.sourceGaps ?? [],
      signals: history.signals,
      identityEvidenceCutoffUtc,
    }
  }
}
