import type { RadiusService } from '../radius/radius-service.js'
import { RADIUS_PRESS_KEYS, type RawRadiusTimeline } from '../radius/models.js'
import type { PressSemanticSignalWithIdentity, TelemetryFoundationService } from '../telemetry/telemetry-foundation-service.js'
import type { DetailedHistoryState, PressEvidenceCapabilities, RawTelemetryChangesResponse, RawTelemetryHistoryResponse, TelemetrySample, TelemetryScalarValue, TelemetrySemanticSelector, TelemetrySourceSignal } from '../telemetry/telemetry-contracts.js'
import { canonicalSpeedConfiguration, stopIdentityAssociationConfiguration } from './configuration.js'
import { classifyStop, hasInStopSpeedTest } from './classification-engine.js'
import {
  type CanonicalSpeedObservation,
  type ChangeoverStabilizationPhase,
  STOP_INTELLIGENCE_ALGORITHM_VERSION,
  STOP_INTELLIGENCE_CLASSIFICATION_VERSION,
  type ClassifiedStop,
  type StopFleetEpisode,
  type StopFleetPressSummary,
  type StopIntelligenceDetail,
  type StopDeckStatusContext,
  type StopIntelligenceFleetReport,
  type StopIntelligenceReport,
  type StopIntelligenceRequest,
  type StopSpeedContext,
  type StopSetupFamily,
  type TelemetryAvailabilityInterval,
} from './contracts.js'
import { buildStopEvidence, STOP_FAMILY_CANONICAL_PATTERNS, stopIdentityDefinitions } from './evidence-model.js'
import { analyzePhysicalStops, bridgeMatchingSpeedStateEvidence, normalizeSpeedQuality } from './physical-stop-engine.js'
import { overlayRadius } from './radius-overlay.js'
import { buildChangeoverActions, buildUncanonicalizedRawActions, detectRequiredChangeoverActivity } from './action-engine.js'
import { buildChangeoverActivityWindows } from './changeover-stage-engine.js'
import { buildChangeoverStabilizationPhases } from './changeover-stabilization-engine.js'
import { InMemoryStopIntelligenceCorrectionRepository, StopIntelligenceCorrectionService } from './correction-service.js'

export class StopIntelligenceConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StopIntelligenceConfigurationError'
  }
}

const validTime = (value: string) => Number.isFinite(Date.parse(value))
const asObservation = (sample: TelemetrySample, atUtc = sample.observedAtUtc): CanonicalSpeedObservation => ({ atUtc, speed: typeof sample.value === 'number' ? sample.value : null, qualityState: sample.qualityState })
const STOP_DETAIL_CONTEXT_MS = 15 * 60_000
const LEADING_STOP_LOOKBACK_STEPS_MS = [6, 24, 72].map((hours) => hours * 60 * 60_000)
const RAW_DISCOVERY_CHUNK_MS = 2 * 60 * 60_000
const RAW_HISTORY_CONCURRENCY = 4
export const STOP_DETAIL_RAW_EVIDENCE_LIMIT = 12
const STOP_ANALYSIS_CACHE_TTL_MS = 5 * 60_000
const STOP_ANALYSIS_CACHE_LIMIT = 6
const PRODUCTION_ATTRIBUTE_RAW_CHUNK_MS = 24 * 60 * 60_000
const DECK_STATUS_ROLES = ['active', 'deck_out', 'print_on', 'print_off', 'status', 'position'] as const
type DeckStatusRole = (typeof DECK_STATUS_ROLES)[number]
const STOP_ACTION_CONTEXT_IDS = new Set(['production.order', 'production.recipe', 'production.roll', 'production.roll.length.actual'])
export const STOP_INTELLIGENCE_PRESS_KEYS: StopIntelligenceRequest['pressKey'][] = [...RADIUS_PRESS_KEYS]
export const stopIntelligenceStopId = (segment: Pick<ClassifiedStop['physicalSegment'], 'pressKey' | 'startAt'>) => `${segment.pressKey}-${Date.parse(segment.startAt)}`

interface AnalysisReadResult {
  report: StopIntelligenceReport
  speedHistory: TelemetrySample[]
  speedUnit: string | null
  sourceGaps: Array<{ startUtc: string; endUtc: string }>
  signals: PressSemanticSignalWithIdentity[]
  identityEvidenceCutoffUtc: string
  radiusTimeline: RawRadiusTimeline | null
}

function speedObservationsForRange(speed: PressSemanticSignalWithIdentity, fromUtc: string, toUtc: string): CanonicalSpeedObservation[] {
  const from = Date.parse(fromUtc); const to = Date.parse(toUtc)
  const values = [speed.seed, ...speed.samples].filter((value): value is TelemetrySample => Boolean(value) && validTime(value!.observedAtUtc)).sort((left, right) => Date.parse(left.observedAtUtc) - Date.parse(right.observedAtUtc))
  const prior = values.filter((value) => Date.parse(value.observedAtUtc) < from).at(-1)
  const observations = new Map<string, CanonicalSpeedObservation>()
  if (prior) observations.set(fromUtc, asObservation(prior, fromUtc))
  for (const value of values.filter((candidate) => { const at = Date.parse(candidate.observedAtUtc); return at >= from && at <= to })) observations.set(value.observedAtUtc, asObservation(value))
  return [...observations.values()].sort((left, right) => Date.parse(left.atUtc) - Date.parse(right.atUtc))
}

/** Finds the latest fully observed seven-minute recovery-speed interval before the visible range. */
export function latestSustainedGoodRunAnchor(input: { observations: CanonicalSpeedObservation[]; unavailable: TelemetryAvailabilityInterval[]; fromUtc: string; toUtc: string; recoveryThreshold: number; confirmationSeconds: number }): string | null {
  const from = Date.parse(input.fromUtc); const to = Date.parse(input.toUtc); const confirmationMs = input.confirmationSeconds * 1_000
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return null
  const observations = input.observations.filter((item) => validTime(item.atUtc) && Date.parse(item.atUtc) <= to).sort((left, right) => Date.parse(left.atUtc) - Date.parse(right.atUtc))
  const boundaries = new Set<number>([from, to])
  for (const item of observations) { const at = Date.parse(item.atUtc); if (at >= from && at <= to) boundaries.add(at) }
  for (const interval of input.unavailable) { boundaries.add(Math.max(from, Date.parse(interval.fromUtc))); boundaries.add(Math.min(to, Date.parse(interval.toUtc))) }
  const ordered = [...boundaries].filter(Number.isFinite).sort((left, right) => left - right)
  let observationIndex = -1; let currentRunStart: number | null = null; let latest: { start: number; end: number } | null = null
  for (let index = 0; index < ordered.length - 1; index += 1) {
    const start = ordered[index]!; const end = ordered[index + 1]!
    if (end <= start) continue
    while (observationIndex + 1 < observations.length && Date.parse(observations[observationIndex + 1]!.atUtc) <= start) observationIndex += 1
    const observation = observations[observationIndex]
    const unavailable = input.unavailable.some((interval) => Date.parse(interval.fromUtc) < end && Date.parse(interval.toUtc) > start)
    const running = !unavailable && observation && typeof observation.speed === 'number' && Number.isFinite(observation.speed) && normalizeSpeedQuality(observation.qualityState) === 'GOOD' && observation.speed >= input.recoveryThreshold
    if (running) {
      if (currentRunStart === null) currentRunStart = start
      continue
    }
    if (currentRunStart !== null && start - currentRunStart >= confirmationMs) latest = { start: currentRunStart, end: start }
    currentRunStart = null
  }
  if (currentRunStart !== null && to - currentRunStart >= confirmationMs) latest = { start: currentRunStart, end: to }
  return latest ? new Date(latest.end - confirmationMs).toISOString() : null
}

function availabilityIntervals(gaps: Array<{ startUtc: string; endUtc: string }>, fromUtc: string, toUtc: string): TelemetryAvailabilityInterval[] {
  const from = Date.parse(fromUtc); const to = Date.parse(toUtc)
  return gaps.flatMap((gap) => {
    const start = Math.max(from, Date.parse(gap.startUtc)); const end = Math.min(to, Date.parse(gap.endUtc))
    return end > start ? [{ fromUtc: new Date(start).toISOString(), toUtc: new Date(end).toISOString(), state: 'SOURCE_TELEMETRY_UNAVAILABLE' as const }] : []
  })
}

function reportEvidenceState(observations: CanonicalSpeedObservation[], sourceGaps: TelemetryAvailabilityInterval[], detailedState?: DetailedHistoryState): StopIntelligenceReport['telemetryEvidenceState'] {
  if (detailedState === 'INSUFFICIENT_DETAILED_TELEMETRY') return 'INSUFFICIENT_DETAILED_TELEMETRY'
  if (sourceGaps.some(({ state }) => state === 'SHARED_COLLECTION_OUTAGE') || sourceGaps.length && detailedState === 'SHARED_COLLECTION_OUTAGE') return 'SHARED_COLLECTION_OUTAGE'
  if (sourceGaps.some(({ state }) => state === 'SOURCE_TELEMETRY_UNAVAILABLE')) return 'SOURCE_TELEMETRY_UNAVAILABLE'
  if (sourceGaps.some(({ state }) => state === 'UNKNOWN_SPEED_QUALITY')) return 'UNKNOWN_SPEED_QUALITY'
  if (observations.some((item) => typeof item.speed === 'number' && normalizeSpeedQuality(item.qualityState) === 'GOOD')) return 'AVAILABLE'
  return observations.length ? 'UNKNOWN_SPEED_QUALITY' : 'INSUFFICIENT_DETAILED_TELEMETRY'
}

function fleetEpisode(stop: ClassifiedStop, changeoverActivityWindows: StopFleetEpisode['changeoverActivityWindows'] = []): StopFleetEpisode {
  const segment = stop.physicalSegment
  const segmentEnd = Date.parse(segment.endAt ?? segment.startAt)
  const overlap = (state: ClassifiedStop['radius']['states'][number]) => Math.max(0, Math.min(segmentEnd, Date.parse(state.endUtc)) - Math.max(Date.parse(segment.startAt), Date.parse(state.startUtc)))
  const radiusState = [...stop.radius.states].filter((state) => overlap(state) > 0).sort((left, right) => overlap(right) - overlap(left))[0]
  return {
    stopId: stopIntelligenceStopId(segment), pressKey: segment.pressKey, startAt: segment.startAt, endAt: segment.endAt,
    physicalDurationSeconds: segment.physicalDurationSeconds, classification: stop.classification, operationalClassification: stop.classification, changeoverStabilizationId: null, confidence: stop.confidence,
    movementAttemptCount: segment.movementAttempts.length, failedRecoveryCount: segment.failedRecoveryCount, radiusAlignment: stop.radiusAlignment,
    radiusStatusDescription: radiusState?.kind === 'offline' ? 'Unavailable' : radiusState?.statusDescription ?? null,
    primaryReasonCodes: [...stop.supportingEvidence, ...stop.conflictingEvidence].slice(0, 4).map(({ code }) => code),
    leftCensored: segment.leftCensored, rightCensored: segment.rightCensored,
    affectedByCollectionGap: ['SOURCE_TELEMETRY_UNAVAILABLE', 'SHARED_COLLECTION_OUTAGE'].includes(segment.leftCensorReason ?? '') || ['SOURCE_TELEMETRY_UNAVAILABLE', 'SHARED_COLLECTION_OUTAGE'].includes(segment.rightCensorReason ?? ''),
    affectedBySpeedQuality: segment.leftCensorReason === 'UNKNOWN_SPEED_QUALITY' || segment.rightCensorReason === 'UNKNOWN_SPEED_QUALITY',
    changeoverActivityWindows,
  }
}

export function mergeChangeoverStabilizationEpisodes(baseEpisodes: StopFleetEpisode[], phases: ChangeoverStabilizationPhase[], rangeToUtc: string): StopFleetEpisode[] {
  const consumed = new Set<string>()
  const merged = phases.flatMap((phase): StopFleetEpisode[] => {
    const start = Date.parse(phase.startAt); const end = Date.parse(phase.endAt)
    const constituents = baseEpisodes.filter((episode) => Date.parse(episode.startAt) < end && Date.parse(episode.endAt ?? rangeToUtc) > start)
    const trigger = constituents.find((episode) => episode.stopId === phase.triggerStopId)
    if (!trigger || !constituents.length) return []
    constituents.forEach(({ stopId }) => consumed.add(stopId))
    const physicalDurationSeconds = constituents.reduce((sum, episode) => sum + episode.physicalDurationSeconds, 0)
    const eventDurationSeconds = Math.max(0, (end - start) / 1_000)
    return [{
      ...trigger,
      startAt: phase.startAt,
      endAt: phase.endAt,
      physicalDurationSeconds,
      eventDurationSeconds,
      trialRunSeconds: Math.max(0, eventDurationSeconds - physicalDurationSeconds),
      mergedChangeover: true,
      constituentStopIds: constituents.map(({ stopId }) => stopId),
      classification: 'CHANGEOVER',
      operationalClassification: 'CHANGEOVER',
      changeoverStabilizationId: phase.stabilizationId,
      movementAttemptCount: constituents.reduce((sum, episode) => sum + episode.movementAttemptCount, 0),
      failedRecoveryCount: constituents.reduce((sum, episode) => sum + episode.failedRecoveryCount, 0),
      primaryReasonCodes: [...new Set(constituents.flatMap(({ primaryReasonCodes }) => primaryReasonCodes))].slice(0, 8),
      leftCensored: constituents[0]?.leftCensored ?? false,
      rightCensored: phase.status === 'STABILIZING' ? false : constituents.at(-1)?.rightCensored ?? false,
      affectedByCollectionGap: constituents.some(({ affectedByCollectionGap }) => affectedByCollectionGap),
      affectedBySpeedQuality: constituents.some(({ affectedBySpeedQuality }) => affectedBySpeedQuality),
    }]
  })
  return [...baseEpisodes.filter(({ stopId }) => !consumed.has(stopId)), ...merged].sort((left, right) => Date.parse(left.startAt) - Date.parse(right.startAt))
}

function fleetPress(report: StopIntelligenceReport, speedContext: StopSpeedContext, signals: PressSemanticSignalWithIdentity[], radiusTimeline: RawRadiusTimeline | null, productionAttributeContext: StopFleetPressSummary['productionAttributeContext']): StopFleetPressSummary {
  const baseEpisodes = report.classifiedStops.map((stop) => fleetEpisode(stop))
  const actionContext = buildActionSignalContext(signals, speedContext.fromUtc, speedContext.toUtc)
  const rollLength = actionContext.find((series) => series.canonicalId === 'production.roll.length.actual')
  const rollIdentity = actionContext.find((series) => series.canonicalId === 'production.roll')
  const order = actionContext.find((series) => series.canonicalId === 'production.order')
  const recipe = actionContext.find((series) => series.canonicalId === 'production.recipe')
  const changeoverStabilizationPhases = buildChangeoverStabilizationPhases({
    fromUtc: speedContext.fromUtc, toUtc: speedContext.toUtc, episodes: baseEpisodes,
    rollIdentityObservations: rollIdentity?.observations ?? [],
    rollLengthObservations: (rollLength?.observations ?? []).flatMap((observation) => typeof observation.value === 'number' && Number.isFinite(observation.value) ? [{ ...observation, value: observation.value }] : []),
    orderObservations: order?.observations, recipeObservations: recipe?.observations, rollLengthUnit: rollLength?.unit,
  })
  const episodes = mergeChangeoverStabilizationEpisodes(baseEpisodes, changeoverStabilizationPhases, speedContext.toUtc)
  const count = (classification: ClassifiedStop['classification']) => episodes.filter((item) => item.operationalClassification === classification).length
  const affected = episodes.some((item) => item.leftCensored || item.rightCensored || item.affectedByCollectionGap || item.affectedBySpeedQuality)
  const hasSourceGap = speedContext.unknownIntervals.some(({ state }) => state === 'SOURCE_TELEMETRY_UNAVAILABLE' || state === 'SHARED_COLLECTION_OUTAGE')
  const warning = report.telemetryEvidenceState !== 'AVAILABLE' || affected || hasSourceGap
  const rollLengthObservations = downsampleFleetRollLength((rollLength?.observations ?? []).flatMap((observation) => typeof observation.value === 'number' && Number.isFinite(observation.value) ? [{ atUtc: observation.atUtc, value: observation.value, qualityState: observation.qualityState }] : []))
  return {
    pressKey: report.configuration.pressKey, displayName: report.displayName, telemetryEvidenceState: report.telemetryEvidenceState,
    stopCount: episodes.length, totalPhysicalStopSeconds: episodes.reduce((sum, item) => sum + item.physicalDurationSeconds, 0),
    changeoverCount: count('CHANGEOVER'), downtimeCount: count('DOWNTIME'), uncertainCount: count('UNCERTAIN'), badDataCount: count('IGNORE_BAD_DATA'),
    changeoverPhysicalStopSeconds: episodes.filter((item) => item.operationalClassification === 'CHANGEOVER').reduce((sum, item) => sum + item.physicalDurationSeconds, 0),
    longestPhysicalStopSeconds: Math.max(0, ...baseEpisodes.map((item) => item.physicalDurationSeconds)), dataAvailabilityWarning: warning,
    warningReason: report.telemetryEvidenceState === 'SOURCE_TELEMETRY_UNAVAILABLE' ? 'The selected press telemetry is unavailable during part of this range; no physical speed boundary is fabricated.' : report.telemetryEvidenceState === 'SHARED_COLLECTION_OUTAGE' ? 'A shared telemetry collection outage is corroborated across independent press sources.' : report.telemetryEvidenceState === 'INSUFFICIENT_DETAILED_TELEMETRY' ? 'Detailed telemetry is unavailable for this period, so exact stop analysis cannot proceed.' : report.telemetryEvidenceState !== 'AVAILABLE' ? `Canonical speed evidence is ${report.telemetryEvidenceState.toLowerCase().replaceAll('_', ' ')}.` : affected ? 'One or more stops are censored or affected by incomplete telemetry.' : hasSourceGap ? 'The selected press telemetry is unavailable during part of this range.' : null,
    episodes, speedContext,
    radiusContext: {
      states: (radiusTimeline?.segments ?? []).map((state) => ({ kind: state.kind, startUtc: state.startUtc, endUtc: state.endUtc, eventType: state.eventType, statusCode: state.statusCode, statusDescription: state.statusDescription, isProduction: state.isProduction })),
      reason: radiusTimeline ? 'Exact raw Radius context for the selected press and time window.' : 'Raw Radius context is unavailable for this selected window.',
    },
    identityContext: actionContext.flatMap((series) => series.canonicalId === 'production.order' || series.canonicalId === 'production.recipe' || series.canonicalId === 'production.material' ? [{ signalId: series.signalId, canonicalId: series.canonicalId, rawIdentity: series.rawIdentity, observations: series.observations }] : []),
    rollLengthContext: rollLength && rollLengthObservations.length ? { signalId: rollLength.signalId, canonicalId: 'production.roll.length.actual', rawIdentity: rollLength.rawIdentity, unit: rollLength.unit, observations: rollLengthObservations } : null,
    productionAttributeContext, changeoverStabilizationPhases,
  }
}

const MAX_FLEET_SPEED_BUCKETS = 600
const MAX_FLEET_ROLL_LENGTH_BUCKETS = 720

export function downsampleFleetRollLength(observations: Array<{ atUtc: string; value: number; qualityState: string }>): Array<{ atUtc: string; value: number; qualityState: string }> {
  if (observations.length <= MAX_FLEET_ROLL_LENGTH_BUCKETS * 4) return observations
  const bucketSize = Math.ceil(observations.length / MAX_FLEET_ROLL_LENGTH_BUCKETS)
  const retained = new Map<string, { atUtc: string; value: number; qualityState: string }>()
  for (let index = 0; index < observations.length; index += bucketSize) {
    const bucket = observations.slice(index, index + bucketSize)
    const usable = bucket.filter((item) => Number.isFinite(item.value) && normalizeSpeedQuality(item.qualityState) === 'GOOD')
    for (const item of [bucket[0], usable.reduce((minimum, value) => value.value < minimum.value ? value : minimum, usable[0]!), usable.reduce((maximum, value) => value.value > maximum.value ? value : maximum, usable[0]!), bucket.at(-1)].filter((item): item is { atUtc: string; value: number; qualityState: string } => Boolean(item))) retained.set(item.atUtc, item)
  }
  return [...retained.values()].sort((left, right) => Date.parse(left.atUtc) - Date.parse(right.atUtc))
}

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

type ProductionAttribute = StopFleetPressSummary['productionAttributeContext'][number]['attribute']
export interface ProductionAttributeDefinition {
  attribute: ProductionAttribute
  label: string
  matches(signal: TelemetrySourceSignal): boolean
  preferredUnit: RegExp
}

const PRODUCTION_ATTRIBUTE_DEFINITIONS: ProductionAttributeDefinition[] = [
  { attribute: 'WEB_WIDTH', label: 'Web width', matches: ({ signalId }) => /(?:production[._]material[._]width|\.unwind\.web width \[)/i.test(signalId), preferredUnit: /^(?:in|inch)$/i },
  { attribute: 'FILM_THICKNESS', label: 'Film thickness', matches: ({ signalId }) => /(?:production[._]material[._]thickness|\.unwind\.thickness \[)/i.test(signalId), preferredUnit: /^mil$/i },
  { attribute: 'FILM_DENSITY', label: 'Film density', matches: ({ signalId }) => /(?:production[._]material[._]density|\.unwind\.density \[)/i.test(signalId), preferredUnit: /^(?:lb\/in|g\/cm)/i },
  { attribute: 'PLATE_REPEAT', label: 'Plate repeat', matches: ({ signalId }) => /\.printunit\.print repeat \[/i.test(signalId), preferredUnit: /^(?:in|inch)$/i },
]

/** Selects one machine-level source value per requested production attribute. */
export function productionAttributeRawCandidates(signals: TelemetrySourceSignal[]): Array<{ definition: ProductionAttributeDefinition; signal: TelemetrySourceSignal }> {
  return PRODUCTION_ATTRIBUTE_DEFINITIONS.flatMap((definition) => {
    const candidates = signals.filter((signal) => signal.enabled && definition.matches(signal))
      .sort((left, right) => Number(!definition.preferredUnit.test(left.sourceUnit?.trim() ?? '')) - Number(!definition.preferredUnit.test(right.sourceUnit?.trim() ?? '')) || left.id - right.id)
    return candidates[0] ? [{ definition, signal: candidates[0] }] : []
  })
}

export function productionAttributeDisplayUnit(attribute: ProductionAttribute, sourceUnit: string | null | undefined): string | null {
  const unit = sourceUnit?.trim()
  if (!unit) return null
  if (attribute === 'FILM_DENSITY') {
    if (/^g\/cm(?:3|³|�)?$/i.test(unit)) return 'g/cm³'
    if (/^lb\/in(?:3|³|�)?$/i.test(unit)) return 'lb/in³'
  }
  return unit
}

export function productionAttributeHistoryRanges(fromUtc: string, toUtc: string): Array<{ fromUtc: string; toUtc: string }> {
  const fromMs = Date.parse(fromUtc)
  const toMs = Date.parse(toUtc)
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return []
  const ranges: Array<{ fromUtc: string; toUtc: string }> = []
  for (let cursor = fromMs; cursor < toMs; cursor += PRODUCTION_ATTRIBUTE_RAW_CHUNK_MS) {
    ranges.push({ fromUtc: new Date(cursor).toISOString(), toUtc: new Date(Math.min(toMs, cursor + PRODUCTION_ATTRIBUTE_RAW_CHUNK_MS)).toISOString() })
  }
  return ranges
}

async function loadProductionAttributeContext(telemetry: TelemetryFoundationService, pressKey: StopIntelligenceRequest['pressKey'], fromUtc: string, toUtc: string, requestId?: string, signal?: AbortSignal): Promise<StopFleetPressSummary['productionAttributeContext']> {
  let catalog: TelemetrySourceSignal[]
  try { catalog = await telemetry.rawCatalog(pressKey, requestId, signal) }
  catch (error) { if (signal?.aborted) throw error; return [] }
  const loaded = await Promise.all(productionAttributeRawCandidates(catalog).map(async ({ definition, signal: candidate }) => {
    try {
      const histories: RawTelemetryHistoryResponse[] = []
      for (const range of productionAttributeHistoryRanges(fromUtc, toUtc)) histories.push(await telemetry.rawHistory(pressKey, candidate.signalId, range.fromUtc, range.toUtc, requestId, signal))
      const observations = new Map<string, { atUtc: string; value: number; qualityState: string }>()
      for (const observation of histories.flatMap(({ observations }) => observations)) {
        if (!validTime(observation.timestampUtc) || typeof observation.rawValue !== 'number' || !Number.isFinite(observation.rawValue) || normalizeSpeedQuality(observation.qualityState) !== 'GOOD') continue
        observations.set(observation.timestampUtc, { atUtc: observation.timestampUtc, value: observation.rawValue, qualityState: observation.qualityState })
      }
      const values = downsampleFleetRollLength([...observations.values()].sort((left, right) => Date.parse(left.atUtc) - Date.parse(right.atUtc)))
      const historyUnit = histories.map(({ sourceUnit }) => sourceUnit).find((unit) => unit?.trim())
      return values.length ? { attribute: definition.attribute, label: definition.label, rawIdentity: candidate.signalId, unit: productionAttributeDisplayUnit(definition.attribute, historyUnit || candidate.sourceUnit), observations: values } : null
    } catch (error) { if (signal?.aborted) throw error; return null }
  }))
  return loaded.filter((item): item is NonNullable<typeof item> => item !== null)
}

function fleetSpeedContext(result: AnalysisReadResult, fromUtc: string, toUtc: string): StopSpeedContext {
  const from = Date.parse(fromUtc); const to = Date.parse(toUtc)
  const ordered = result.speedHistory.filter((item) => validTime(item.observedAtUtc)).sort((left, right) => Date.parse(left.observedAtUtc) - Date.parse(right.observedAtUtc))
  const prior = ordered.filter((item) => Date.parse(item.observedAtUtc) < from).at(-1)
  const contextMap = new Map<string, CanonicalSpeedObservation>()
  if (prior) contextMap.set(fromUtc, asObservation(prior, fromUtc))
  for (const sample of ordered.filter((item) => { const at = Date.parse(item.observedAtUtc); return at >= from && at <= to })) contextMap.set(sample.observedAtUtc, asObservation(sample))
  const bridged = bridgeMatchingSpeedStateEvidence({ configuration: result.report.configuration, fromUtc, toUtc, observations: [...contextMap.values()], availabilityIntervals: availabilityIntervals(result.sourceGaps, fromUtc, toUtc) })
  return { fromUtc, toUtc, unit: result.speedUnit, stopThreshold: result.report.configuration.stopThreshold, recoveryThreshold: result.report.configuration.recoveryThreshold, observations: downsampleFleetSpeed(bridged.observations), unknownIntervals: bridged.availabilityIntervals }
}

function familyFor(canonicalId: string): StopSetupFamily | null {
  return STOP_FAMILY_CANONICAL_PATTERNS.find((value) => value.matches(canonicalId))?.family ?? null
}

export function evidenceSelectors(pressKey: StopIntelligenceRequest['pressKey'], capabilities: PressEvidenceCapabilities): { selectors: TelemetrySemanticSelector[]; supportedFamilies: StopSetupFamily[] } {
  const identityIds = new Set(stopIdentityDefinitions(pressKey).flatMap((value) => value.canonicalId ?? []))
  const supported = capabilities.capabilities.filter((value) => value.state === 'SUPPORTED' && value.historyQueryable)
  const selected = supported.filter((value) => identityIds.has(value.canonicalId) || STOP_ACTION_CONTEXT_IDS.has(value.canonicalId) || familyFor(value.canonicalId) !== null)
  const selectors: TelemetrySemanticSelector[] = [{ canonicalId: 'machine.speed.actual', representation: 'samples' }]
  const priority = (canonicalId: string) => identityIds.has(canonicalId) ? 0
    : STOP_ACTION_CONTEXT_IDS.has(canonicalId) ? 1
      : canonicalId === 'ink.washup.state' ? 2
        : /^(?:ink\.pump|ink\.viscosity)\./.test(canonicalId) ? 3
          : canonicalId.startsWith('impression.') ? 4
            : canonicalId.startsWith('deck.') ? 5
              : canonicalId.startsWith('register.') ? 6
                : 7
  for (const capability of selected.sort((left, right) => priority(left.canonicalId) - priority(right.canonicalId) || left.canonicalId.localeCompare(right.canonicalId))) {
    // Roll length is a dense counter. Asking for "changes" duplicates each
    // point with predecessor metadata even though the overview only needs the
    // observed series. State-like evidence continues to use exact changes.
    const changes = capability.canonicalId !== 'production.roll.length.actual' && (identityIds.has(capability.canonicalId) || capability.canonicalId === 'production.roll' || /^(?:deck|register|impression)\./.test(capability.canonicalId) || /^(?:ink\.washup\.state|ink\.pump\.(?:status|sequence)|ink\.viscosity\.(?:mode|status))$/.test(capability.canonicalId) || /(?:setpoint|rated|command)/i.test(capability.canonicalId))
    if (capability.deckNumbers.length) for (const deckNumber of capability.deckNumbers) selectors.push({ canonicalId: capability.canonicalId, deckNumber, representation: changes ? 'changes' : 'samples' })
    else selectors.push({ canonicalId: capability.canonicalId, representation: changes ? 'changes' : 'samples' })
  }
  const unique = new Map(selectors.map((value) => [`${value.canonicalId}:${value.deckNumber ?? ''}:${value.representation}`, value]))
  // The telemetry foundation already batches semantic reads. Keep the complete
  // list: presses 3-11 have enough per-deck signals that the former 120-selector
  // cap could silently omit impression or deck evidence on supported presses.
  const completeSelectors = [...unique.values()]
  return { selectors: completeSelectors, supportedFamilies: [...new Set(completeSelectors.flatMap((value) => familyFor(value.canonicalId) ?? []))] }
}

const selectorIdentity = ({ canonicalId, deckNumber }: { canonicalId: string; deckNumber?: number | null }) => `${canonicalId}:${deckNumber ?? ''}`
const isPumpFrequency = (canonicalId: string) => canonicalId === 'ink.pump.frequency.supply' || canonicalId === 'ink.pump.frequency.return'
const isDirectPumpState = (canonicalId: string) => /^(?:ink\.pump\.(?:status|sequence)|ink\.viscosity\.(?:mode|status))$/.test(canonicalId)

/**
 * The fleet overview starts with only what it can display or use as the
 * cheapest required changeover gate. Broad setup evidence is loaded only for
 * wash-positive candidates or for a selected investigation.
 */
export function overviewEvidenceSelectors(pressKey: StopIntelligenceRequest['pressKey'], capabilities: PressEvidenceCapabilities) {
  const full = evidenceSelectors(pressKey, capabilities)
  const identityIds = new Set(stopIdentityDefinitions(pressKey).flatMap((value) => value.canonicalId ?? []))
  const selectors = full.selectors.filter(({ canonicalId }) => canonicalId === 'machine.speed.actual' || identityIds.has(canonicalId) || STOP_ACTION_CONTEXT_IDS.has(canonicalId) || canonicalId === 'ink.washup.state')
  return { selectors, supportedFamilies: [...new Set(selectors.flatMap((value) => familyFor(value.canonicalId) ?? []))] }
}

export function candidateClassificationSelectors(pressKey: StopIntelligenceRequest['pressKey'], capabilities: PressEvidenceCapabilities) {
  const full = evidenceSelectors(pressKey, capabilities)
  const selectors = full.selectors.filter(({ canonicalId }) => canonicalId.startsWith('impression.') || isDirectPumpState(canonicalId))
  return { selectors, supportedFamilies: [...new Set(selectors.flatMap((value) => familyFor(value.canonicalId) ?? []))] }
}

export function pumpFrequencySelectors(pressKey: StopIntelligenceRequest['pressKey'], capabilities: PressEvidenceCapabilities): TelemetrySemanticSelector[] {
  return evidenceSelectors(pressKey, capabilities).selectors
    .filter(({ canonicalId }) => isPumpFrequency(canonicalId))
    .map((selector) => ({ ...selector, representation: 'samples' }))
}

function mergeEvidenceSignals(...groups: PressSemanticSignalWithIdentity[][]): PressSemanticSignalWithIdentity[] {
  const merged = new Map<string, PressSemanticSignalWithIdentity>()
  const pointKey = (point: TelemetrySample) => `${point.observedAtUtc}:${JSON.stringify(point.value)}`
  for (const signal of groups.flat()) {
    const key = selectorIdentity(signal)
    const existing = merged.get(key)
    if (!existing) { merged.set(key, signal); continue }
    const samples = new Map([...existing.samples, ...signal.samples].map((point) => [pointKey(point), point]))
    const changes = new Map([...existing.changes, ...signal.changes].map((point) => [`${pointKey(point)}:${JSON.stringify(point.previousValue)}`, point]))
    const seeds = [existing.seed, signal.seed].filter((point): point is TelemetrySample => Boolean(point)).sort((left, right) => Date.parse(left.observedAtUtc) - Date.parse(right.observedAtUtc))
    merged.set(key, {
      ...existing,
      seed: seeds[0] ?? null,
      samples: [...samples.values()].sort((left, right) => Date.parse(left.observedAtUtc) - Date.parse(right.observedAtUtc)),
      changes: [...changes.values()].sort((left, right) => Date.parse(left.observedAtUtc) - Date.parse(right.observedAtUtc)),
      observationState: samples.size || changes.size ? 'SUPPORTED_WITH_OBSERVATIONS' : seeds.length ? 'SUPPORTED_WITH_SEED_ONLY' : existing.observationState,
    })
  }
  return [...merged.values()]
}

function evidenceIntegrity(segment: ClassifiedStop['physicalSegment']): 'VALID' | 'LIMITED' | 'INVALID' {
  if (segment.physicalDurationSeconds <= 0) return 'INVALID'
  if (segment.leftCensorReason && !['RANGE_START', 'RANGE_END'].includes(segment.leftCensorReason) || segment.rightCensorReason && !['RANGE_START', 'RANGE_END'].includes(segment.rightCensorReason)) return 'LIMITED'
  return 'VALID'
}

function buildActionSignalContext(signals: PressSemanticSignalWithIdentity[], fromUtc: string, toUtc: string): StopIntelligenceDetail['actionSignalContext'] {
  const from = Date.parse(fromUtc); const to = Date.parse(toUtc)
  return signals.flatMap((signal) => {
    if (signal.historianSignalId === null) return []
    const sourcePoints = [signal.seed, ...signal.samples, ...signal.changes].filter((point): point is TelemetrySample => Boolean(point) && validTime(point!.observedAtUtc) && normalizeSpeedQuality(point!.qualityState) === 'GOOD').sort((left, right) => Date.parse(left.observedAtUtc) - Date.parse(right.observedAtUtc))
    const observations = new Map<string, { atUtc: string; value: string | number | boolean; qualityState: string }>()
    const prior = sourcePoints.filter((point) => Date.parse(point.observedAtUtc) < from).at(-1)
    if (prior) observations.set(fromUtc, { atUtc: fromUtc, value: prior.value, qualityState: prior.qualityState })
    const firstChange = signal.changes.filter((point) => validTime(point.observedAtUtc) && Date.parse(point.observedAtUtc) >= from && Date.parse(point.observedAtUtc) <= to).sort((left, right) => Date.parse(left.observedAtUtc) - Date.parse(right.observedAtUtc))[0]
    if (!prior && firstChange && normalizeSpeedQuality(firstChange.previousQualityState) === 'GOOD') observations.set(fromUtc, { atUtc: fromUtc, value: firstChange.previousValue, qualityState: firstChange.previousQualityState })
    for (const point of sourcePoints) {
      const at = Date.parse(point.observedAtUtc)
      if (at >= from && at <= to) observations.set(point.observedAtUtc, { atUtc: point.observedAtUtc, value: point.value, qualityState: point.qualityState })
    }
    if (!observations.size) return []
    return [{ signalId: signal.historianSignalId, canonicalId: signal.canonicalId, rawIdentity: signal.rawSignalId, component: signal.deckNumber === null ? signal.sourceSelector : `Deck ${signal.deckNumber}`, deckNumber: signal.deckNumber, unit: signal.sourceUnit, representation: signal.representation, observations: [...observations.values()].sort((left, right) => Date.parse(left.atUtc) - Date.parse(right.atUtc)) }]
  })
}

function actionReferencedSignals(signals: PressSemanticSignalWithIdentity[], analysis: StopIntelligenceDetail['changeoverActions']): PressSemanticSignalWithIdentity[] {
  const evidence = [...analysis.actions, ...analysis.notDirectlyConfirmed].flatMap((action) => action.evidence)
  const signalIds = new Set(evidence.flatMap((item) => item.signalId === null ? [] : [item.signalId]))
  const semanticKeys = new Set(evidence.flatMap((item) => item.canonicalId === null ? [] : [`${item.canonicalId}:${item.deckNumber ?? ''}`]))
  return signals.filter((signal) => signal.canonicalId === 'machine.speed.actual' || STOP_ACTION_CONTEXT_IDS.has(signal.canonicalId) || signalIds.has(signal.historianSignalId ?? -1) || semanticKeys.has(`${signal.canonicalId}:${signal.deckNumber ?? ''}`))
}

const rawScalar = (value: unknown): value is TelemetryScalarValue => typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)

function buildRawActionSignalContext(histories: RawTelemetryHistoryResponse[]): StopIntelligenceDetail['actionSignalContext'] {
  return histories.flatMap((history) => {
    const observations = history.observations.flatMap((observation) => rawScalar(observation.rawValue) && normalizeSpeedQuality(observation.qualityState) === 'GOOD'
      ? [{ atUtc: observation.timestampUtc, value: observation.rawValue, qualityState: observation.qualityState }]
      : [])
    if (observations.length < 2) return []
    return [{ signalId: null, canonicalId: 'raw.uncanonicalized', rawIdentity: history.rawIdentity, component: history.signalDisplayName, deckNumber: null, unit: history.sourceUnit, representation: history.dataKind === 'numeric' ? 'samples' as const : 'changes' as const, observations }]
  })
}

function deckStatusRole(identity: { rawIdentity: string; displayName: string }): DeckStatusRole | null {
  const normalized = `${identity.displayName} ${identity.rawIdentity}`.toLowerCase().replaceAll('-', '_')
  if (/\.color deck\s+(?:10|[1-9])\.status\s*\[0\/1\]\s*$/i.test(identity.rawIdentity)) return 'status'
  if (/\.color deck\s+(?:10|[1-9])\.position\s*\[#\]\s*$/i.test(identity.rawIdentity)) return 'position'
  if (!/(?:^|[._])deck(?:[._]|$)/i.test(identity.rawIdentity)) return null
  if (/(?:^|[._])deck[_\.]?deck_out(?:\[\d+\])?(?:\s|$)|(?:^|[._])deck_out(?:\[\d+\])?(?:\s|$)/.test(normalized)) return 'deck_out'
  if (/(?:^|[._])deck[_\.]?print_off(?:\[\d+\])?(?:\s|$)|(?:^|[._])print_off(?:\[\d+\])?(?:\s|$)/.test(normalized)) return 'print_off'
  if (/(?:^|[._])deck[_\.]?print_on(?:\[\d+\])?(?:\s|$)|(?:^|[._])print_on(?:\[\d+\])?(?:\s|$)/.test(normalized)) return 'print_on'
  if (/(?:^|[._])deck[_\.]?active(?:\[\d+\])?(?:\s|$)|(?:^|[._])active(?:\[\d+\])?(?:\s|$)/.test(normalized)) return 'active'
  return null
}

export interface DeckStatusRawCandidate { role: DeckStatusRole; rawIdentity: string; deckNumber: number | null }

export function deckStatusRawCandidates(signals: TelemetrySourceSignal[]): DeckStatusRawCandidate[] {
  const candidates = signals.flatMap((signal) => {
    const role = deckStatusRole({ rawIdentity: signal.signalId, displayName: signal.displayName })
    if (!role) return []
    const indexed = signal.signalId.match(/\[(\d+)\]\s*$/)
    const colorDeck = signal.signalId.match(/\.color deck\s+(10|[1-9])\.(?:status|position)\s*\[(?:0\/1|#)\]\s*$/i)
    const deckNumber = colorDeck ? Number(colorDeck[1]) : indexed ? Number(indexed[1]) : null
    if (deckNumber !== null && (deckNumber < 1 || deckNumber > 10)) return []
    return [{ role, rawIdentity: signal.signalId, deckNumber }]
  }).sort((left, right) => left.rawIdentity.length - right.rawIdentity.length || left.rawIdentity.localeCompare(right.rawIdentity))
  const selected = new Map<string, DeckStatusRawCandidate>()
  for (const candidate of candidates) {
    const key = `${candidate.role}:${candidate.deckNumber ?? 'container'}`
    if (!selected.has(key)) selected.set(key, candidate)
  }
  return [...selected.values()]
}

function booleanValue(item: unknown): boolean | null {
  if (typeof item === 'boolean') return item
  if (typeof item === 'number' && Number.isFinite(item)) return item !== 0
  if (typeof item === 'string') {
    const normalized = item.trim().toLowerCase()
    if (['1', 'true', 'on'].includes(normalized)) return true
    if (['0', 'false', 'off'].includes(normalized)) return false
  }
  return null
}

function deckBoolean(value: unknown, deckNumber: number, sourceDeckNumber: number | null): boolean | null {
  if (sourceDeckNumber !== null) return sourceDeckNumber === deckNumber ? booleanValue(value) : null
  if (!Array.isArray(value) || deckNumber >= value.length) return null
  return booleanValue(value[deckNumber])
}

function deckScalar(value: unknown, deckNumber: number, sourceDeckNumber: number | null): TelemetryScalarValue | null {
  if (sourceDeckNumber !== null) return sourceDeckNumber === deckNumber && rawScalar(value) ? value : null
  if (!Array.isArray(value) || deckNumber >= value.length) return null
  return rawScalar(value[deckNumber]) ? value[deckNumber] : null
}

function integerValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim())
  return null
}

const unavailableDeckStatus = (fromUtc: string, toUtc: string, reason: string): StopDeckStatusContext => ({
  fromUtc, toUtc, availability: 'UNAVAILABLE', reason, sourceIdentities: [], decks: Array.from({ length: 10 }, (_, index) => ({ deckNumber: index + 1, intervals: [{ startUtc: fromUtc, endUtc: toUtc, state: 'UNKNOWN', active: null, printing: null, out: null }], events: [] })),
})

export function buildDeckStatusContext(histories: Array<{ role: DeckStatusRole; deckNumber?: number | null; history: RawTelemetryHistoryResponse }>, fromUtc: string, toUtc: string): StopDeckStatusContext {
  const from = Date.parse(fromUtc); const to = Date.parse(toUtc)
  if (!histories.length || !Number.isFinite(from) || !Number.isFinite(to) || to <= from) return unavailableDeckStatus(fromUtc, toUtc, 'No usable raw deck-status containers were available for this press.')
  const sourceIdentities = histories.map(({ role, history }) => ({ role, rawIdentity: history.rawIdentity }))
  const points = new Map<DeckStatusRole, Array<{ at: number; value: unknown; deckNumber: number | null }>>()
  for (const role of DECK_STATUS_ROLES) {
    points.set(role, histories.filter((item) => item.role === role).flatMap(({ deckNumber = null, history }) => history.observations.flatMap((observation) => {
      const at = Date.parse(observation.timestampUtc)
      const usableShape = deckNumber === null ? Array.isArray(observation.rawValue) : rawScalar(observation.rawValue)
      return Number.isFinite(at) && normalizeSpeedQuality(observation.qualityState) === 'GOOD' && usableShape ? [{ at, value: observation.rawValue, deckNumber }] : []
    })).sort((left, right) => left.at - right.at))
  }
  const boundaryTimes = new Set<number>([from, to])
  for (const values of points.values()) for (const point of values) if (point.at >= from && point.at <= to) boundaryTimes.add(point.at)
  const boundaries = [...boundaryTimes].sort((left, right) => left - right)
  const scalarAt = (role: DeckStatusRole, at: number, deckNumber: number) => {
    const point = points.get(role)?.filter((candidate) => candidate.at <= at && (candidate.deckNumber === null || candidate.deckNumber === deckNumber)).at(-1)
    return point ? deckScalar(point.value, deckNumber, point.deckNumber) : null
  }
  const valueAt = (role: DeckStatusRole, at: number, deckNumber: number) => booleanValue(scalarAt(role, at, deckNumber))
  const roleComplete = (role: DeckStatusRole) => histories.some((item) => item.role === role && (item.deckNumber ?? null) === null)
    || new Set(histories.filter((item) => item.role === role).flatMap((item) => item.deckNumber ?? [])).size === 10
  const rubyPositionContract = roleComplete('status') && roleComplete('position')
  const decks = Array.from({ length: 10 }, (_, index) => {
    const deckNumber = index + 1
    const intervals: StopDeckStatusContext['decks'][number]['intervals'] = []
    for (let boundaryIndex = 0; boundaryIndex < boundaries.length - 1; boundaryIndex += 1) {
      const start = boundaries[boundaryIndex]!; const end = boundaries[boundaryIndex + 1]!
      if (end <= start) continue
      let active = valueAt('active', start, deckNumber); let printing = valueAt('print_on', start, deckNumber); let out = valueAt('deck_out', start, deckNumber)
      let state: StopDeckStatusContext['decks'][number]['intervals'][number]['state']
      if (rubyPositionContract) {
        active = valueAt('status', start, deckNumber)
        const position = integerValue(scalarAt('position', start, deckNumber))
        printing = active === true && position === 3 ? true : active === null || position === null || position === 0 ? null : false
        out = active === true && position === 1 ? true : active === null || position === null || position === 0 ? null : false
        state = active === true && position === 3 ? 'PRINTING'
          : active === true && position === 2 ? 'READY'
            : active === true && position === 1 ? 'OUT'
              : active === false && position === 1 ? 'INACTIVE'
                : 'UNKNOWN'
      } else state = printing === true ? 'PRINTING' : out === true ? 'OUT' : active === true ? 'READY' : active === false ? 'INACTIVE' : 'UNKNOWN'
      const previous = intervals.at(-1)
      if (previous && previous.state === state && previous.active === active && previous.printing === printing && previous.out === out) previous.endUtc = new Date(end).toISOString()
      else intervals.push({ startUtc: new Date(start).toISOString(), endUtc: new Date(end).toISOString(), state, active, printing, out })
    }
    const printOffPoints = points.get('print_off') ?? []
    const events = printOffPoints.flatMap((point, pointIndex) => {
      if (point.at < from || point.at > to || deckBoolean(point.value, deckNumber, point.deckNumber) !== true) return []
      const previous = printOffPoints.slice(0, pointIndex).filter((candidate) => candidate.deckNumber === null || candidate.deckNumber === deckNumber).at(-1)
      if (previous && deckBoolean(previous.value, deckNumber, previous.deckNumber) === true) return []
      return [{ atUtc: new Date(point.at).toISOString(), kind: 'PRINT_OFF_COMMAND' as const, label: 'Print-off command' }]
    })
    return { deckNumber, intervals, events }
  })
  const coreAvailable = roleComplete('print_on') && roleComplete('deck_out')
  return {
    fromUtc, toUtc, availability: rubyPositionContract || coreAvailable && roleComplete('active') ? 'AVAILABLE' : 'PARTIAL',
    reason: rubyPositionContract
      ? 'Validated Ruby Status/Position telemetry was normalized into printing, ready, out, and inactive states for Decks 1–10; Position 0 and unexpected combinations remain unknown.'
      : coreAvailable ? 'Observed raw deck status was normalized into Decks 1–10 across scalar-indexed and array-container press layouts.' : 'Only part of the raw deck-status set was available, so unknown intervals remain explicit.',
    sourceIdentities, decks,
  }
}

async function loadDeckStatusContext(telemetry: TelemetryFoundationService, pressKey: StopIntelligenceRequest['pressKey'], fromUtc: string, toUtc: string, requestId?: string, signal?: AbortSignal): Promise<StopDeckStatusContext> {
  try {
    const catalog = await telemetry.rawCatalog(pressKey, requestId, signal)
    const candidates = deckStatusRawCandidates(catalog)
    if (!candidates.length) {
      const unverifiedStateTags = catalog.filter((item) => /color deck\s+(?:10|[1-9])\.(?:status|position)(?:\s|\[|$)/i.test(item.signalId))
      return unavailableDeckStatus(fromUtc, toUtc, unverifiedStateTags.length
        ? `Deck Status/Position tags were found for ${pressKey}, but their enum meanings are not validated as printing, out, ready, or inactive. No deck state was inferred.`
        : 'No recognized raw deck-status signals were discovered for this press.')
    }
    const historyFromUtc = new Date(Date.parse(fromUtc) - STOP_DETAIL_CONTEXT_MS).toISOString()
    const loaded: Array<{ role: DeckStatusRole; deckNumber: number | null; history: RawTelemetryHistoryResponse }> = []
    for (let index = 0; index < candidates.length; index += RAW_HISTORY_CONCURRENCY) {
      const batch = await Promise.all(candidates.slice(index, index + RAW_HISTORY_CONCURRENCY).map(async (candidate) => ({ role: candidate.role, deckNumber: candidate.deckNumber, history: await telemetry.rawHistory(pressKey, candidate.rawIdentity, historyFromUtc, toUtc, requestId, signal) })))
      loaded.push(...batch)
    }
    return buildDeckStatusContext(loaded, fromUtc, toUtc)
  } catch {
    return unavailableDeckStatus(fromUtc, toUtc, 'Raw deck-status history was temporarily unavailable. No deck state was inferred.')
  }
}

export function uncanonicalizedRawCandidates(signals: RawTelemetryChangesResponse['signals'], canonicalRawIdentities: Iterable<string>): RawTelemetryChangesResponse['signals'] {
  const represented = new Set(canonicalRawIdentities)
  return signals
    .filter((item) => item.plottable && item.changeCount > 0 && item.unavailableObservationCount === 0 && item.dataKind !== 'container' && !represented.has(item.rawIdentity) && !item.alternateRawIdentities.some((identity) => represented.has(identity)))
    .sort((left, right) => right.changeCount - left.changeCount || left.displayName.localeCompare(right.displayName))
}

function boundedRawRanges(fromUtc: string, toUtc: string) {
  const from = Date.parse(fromUtc); const to = Date.parse(toUtc)
  const ranges: Array<{ fromUtc: string; toUtc: string }> = []
  for (let cursor = from; cursor < to; cursor += RAW_DISCOVERY_CHUNK_MS) ranges.push({ fromUtc: new Date(cursor).toISOString(), toUtc: new Date(Math.min(to, cursor + RAW_DISCOVERY_CHUNK_MS)).toISOString() })
  return ranges
}

async function loadRawDiscoveries(telemetry: TelemetryFoundationService, pressKey: StopIntelligenceRequest['pressKey'], fromUtc: string, toUtc: string, requestId?: string, signal?: AbortSignal) {
  const results: RawTelemetryChangesResponse[] = []
  const ranges = boundedRawRanges(fromUtc, toUtc)
  for (let index = 0; index < ranges.length; index += RAW_HISTORY_CONCURRENCY) {
    const batch = await Promise.all(ranges.slice(index, index + RAW_HISTORY_CONCURRENCY).map(({ fromUtc: chunkFromUtc, toUtc: chunkToUtc }) => Promise.resolve()
      .then(() => telemetry.rawChanges(pressKey, chunkFromUtc, chunkToUtc, requestId, signal)).catch(() => undefined)))
    results.push(...batch.filter((item): item is RawTelemetryChangesResponse => Boolean(item)))
  }
  return { results, requestedChunkCount: ranges.length }
}

function deduplicateRawCandidates(candidates: RawTelemetryChangesResponse['signals']): RawTelemetryChangesResponse['signals'] {
  const selected = new Map<string, RawTelemetryChangesResponse['signals'][number]>()
  for (const candidate of candidates) {
    const existing = selected.get(candidate.rawIdentity)
    if (!existing) selected.set(candidate.rawIdentity, candidate)
    else selected.set(candidate.rawIdentity, { ...existing, changeCount: existing.changeCount + candidate.changeCount, usableObservationCount: existing.usableObservationCount + candidate.usableObservationCount, unavailableObservationCount: existing.unavailableObservationCount + candidate.unavailableObservationCount })
  }
  return [...selected.values()].sort((left, right) => right.changeCount - left.changeCount || left.displayName.localeCompare(right.displayName))
}

export function selectBoundedRawEvidenceCandidates(signals: RawTelemetryChangesResponse['signals'], canonicalRawIdentities: Iterable<string>) {
  const discovered = deduplicateRawCandidates(uncanonicalizedRawCandidates(signals, canonicalRawIdentities))
  return { discovered, selected: discovered.slice(0, STOP_DETAIL_RAW_EVIDENCE_LIMIT) }
}

/** Physical bounds come only from validated speed. Other sources cannot move them. */
export class StopIntelligenceService {
  private readonly analysisCache = new Map<string, { completedAt: number; result: AnalysisReadResult }>()

  constructor(private readonly telemetry: TelemetryFoundationService, private readonly radius?: RadiusService, private readonly now = () => Date.now(), private readonly corrections = new StopIntelligenceCorrectionService(new InMemoryStopIntelligenceCorrectionRepository())) {}

  async analyze(input: StopIntelligenceRequest, requestId?: string, signal?: AbortSignal): Promise<StopIntelligenceReport> {
    return (await this.analyzeWithReadData(input, requestId, signal)).report
  }

  async fleet(input: StopIntelligenceRequest, requestId?: string, signal?: AbortSignal, options: { cache?: 'default' | 'bypass' } = {}): Promise<StopIntelligenceFleetReport> {
    const [result, operatorCorrections] = await Promise.all([
      this.analyzeWithReadData(input, requestId, signal, options.cache !== 'bypass'),
      this.corrections.list(input.pressKey, input.fromUtc, input.toUtc),
    ])
    const press = fleetPress(result.report, fleetSpeedContext(result, input.fromUtc, input.toUtc), result.signals, result.radiusTimeline, [])
    return { fromUtc: input.fromUtc, toUtc: input.toUtc, algorithmVersion: STOP_INTELLIGENCE_ALGORITHM_VERSION, classificationVersion: STOP_INTELLIGENCE_CLASSIFICATION_VERSION, presses: [press], operatorCorrections, correctionPersistence: this.corrections.persistence }
  }

  async productionAttributes(input: StopIntelligenceRequest, requestId?: string, signal?: AbortSignal): Promise<StopFleetPressSummary['productionAttributeContext']> {
    return loadProductionAttributeContext(this.telemetry, input.pressKey, input.fromUtc, input.toUtc, requestId, signal)
  }

  async detail(input: StopIntelligenceRequest & { stopId: string; includeRaw?: boolean }, requestId?: string, signal?: AbortSignal): Promise<StopIntelligenceDetail | null> {
    const result = await this.analyzeWithReadData(input, requestId, signal)
    const stop = result.report.classifiedStops.find((item) => stopIntelligenceStopId(item.physicalSegment) === input.stopId)
    if (!stop) return null
    const phaseActionContext = buildActionSignalContext(
      result.signals.filter((item) => STOP_ACTION_CONTEXT_IDS.has(item.canonicalId)),
      input.fromUtc,
      input.toUtc,
    )
    const phaseRollIdentity = phaseActionContext.find((series) => series.canonicalId === 'production.roll')
    const phaseRollLength = phaseActionContext.find((series) => series.canonicalId === 'production.roll.length.actual')
    const phaseOrder = phaseActionContext.find((series) => series.canonicalId === 'production.order')
    const phaseRecipe = phaseActionContext.find((series) => series.canonicalId === 'production.recipe')
    const phaseEpisodes = result.report.classifiedStops.map((item) => fleetEpisode(item))
    const changeoverStabilizationPhases = buildChangeoverStabilizationPhases({
      fromUtc: input.fromUtc, toUtc: input.toUtc, episodes: phaseEpisodes,
      rollIdentityObservations: phaseRollIdentity?.observations ?? [],
      rollLengthObservations: (phaseRollLength?.observations ?? []).flatMap((observation) => typeof observation.value === 'number' && Number.isFinite(observation.value) ? [{ ...observation, value: observation.value }] : []),
      orderObservations: phaseOrder?.observations, recipeObservations: phaseRecipe?.observations, rollLengthUnit: phaseRollLength?.unit,
    })
    const changeoverStabilizationPhase = changeoverStabilizationPhases.find((phase) => phase.triggerStopId === input.stopId || phase.continuationStopIds.includes(input.stopId))
    const mergedChangeoverEvent = changeoverStabilizationPhase
      ? mergeChangeoverStabilizationEpisodes(phaseEpisodes, [changeoverStabilizationPhase], input.toUtc).find((episode) => episode.changeoverStabilizationId === changeoverStabilizationPhase.stabilizationId)
      : undefined
    const constituentIds = new Set(mergedChangeoverEvent?.constituentStopIds ?? [])
    const constituentStops = result.report.classifiedStops.filter((item) => constituentIds.has(stopIntelligenceStopId(item.physicalSegment)))
    let analysisStop: ClassifiedStop = changeoverStabilizationPhase && mergedChangeoverEvent ? {
      ...stop,
      classification: 'CHANGEOVER',
      physicalSegment: {
        ...stop.physicalSegment,
        startAt: changeoverStabilizationPhase.startAt,
        endAt: changeoverStabilizationPhase.endAt,
        physicalDurationSeconds: mergedChangeoverEvent.eventDurationSeconds ?? stop.physicalSegment.physicalDurationSeconds,
        zeroSpeedSeconds: constituentStops.reduce((sum, item) => sum + item.physicalSegment.zeroSpeedSeconds, 0),
        lowMovementSeconds: constituentStops.reduce((sum, item) => sum + item.physicalSegment.lowMovementSeconds, 0),
        movementAttempts: constituentStops.flatMap((item) => item.physicalSegment.movementAttempts).map((attempt, index) => ({ ...attempt, sequenceNumber: index + 1 })),
        failedRecoveryCount: constituentStops.reduce((sum, item) => sum + item.physicalSegment.failedRecoveryCount, 0),
        failedRecoveryStreaks: constituentStops.flatMap((item) => item.physicalSegment.failedRecoveryStreaks),
        rightCensored: false,
        rightCensorReason: null,
      },
      radius: overlayRadius({ ...stop.physicalSegment, startAt: changeoverStabilizationPhase.startAt, endAt: changeoverStabilizationPhase.endAt, physicalDurationSeconds: mergedChangeoverEvent.eventDurationSeconds ?? stop.physicalSegment.physicalDurationSeconds }, input.toUtc, result.radiusTimeline?.segments),
    } : stop
    let analysisStops = constituentIds.size ? [...result.report.classifiedStops.filter((item) => !constituentIds.has(stopIntelligenceStopId(item.physicalSegment))), analysisStop] : result.report.classifiedStops
    const fromUtc = new Date(Date.parse(analysisStop.physicalSegment.startAt) - STOP_DETAIL_CONTEXT_MS).toISOString()
    const physicalEnd = analysisStop.physicalSegment.endAt ?? input.toUtc
    const toUtc = new Date(Math.min(Date.parse(input.toUtc) + STOP_DETAIL_CONTEXT_MS, Date.parse(physicalEnd) + STOP_DETAIL_CONTEXT_MS)).toISOString()
    const capabilities = await this.telemetry.capabilities.get(input.pressKey, requestId, signal)
    const fullSelection = evidenceSelectors(input.pressKey, capabilities)
    const directPumpAvailable = fullSelection.selectors.some(({ canonicalId }) => isDirectPumpState(canonicalId))
    const existingSignalKeys = new Set(result.signals.map(selectorIdentity))
    const missingDetailSelectors = fullSelection.selectors.filter((selector) => {
      if (existingSignalKeys.has(selectorIdentity(selector))) return false
      if (selector.canonicalId === 'machine.speed.actual' || STOP_ACTION_CONTEXT_IDS.has(selector.canonicalId) || selector.canonicalId === 'ink.washup.state') return false
      return !(directPumpAvailable && isPumpFrequency(selector.canonicalId))
    })
    let detailSignals = result.signals
    if (missingDetailSelectors.length && Date.parse(toUtc) > Date.parse(fromUtc)) {
      const supplemental = await this.telemetry.semanticHistoryWithIdentity(input.pressKey, { fromUtc, toUtc, includeSeed: true, signals: missingDetailSelectors }, requestId, signal)
      detailSignals = mergeEvidenceSignals(result.signals, supplemental.signals)
    }
    const detailedEvidence = buildStopEvidence({ pressKey: input.pressKey, segment: stop.physicalSegment, allSegments: result.report.segments, signals: detailSignals, physicalRangeEndUtc: input.toUtc, identityEvidenceCutoffUtc: result.identityEvidenceCutoffUtc, identityAssociationConfiguration: result.report.identityAssociationConfiguration, supportedFamilies: fullSelection.supportedFamilies })
    const detailedRequiredActivity = detectRequiredChangeoverActivity({ segment: stop.physicalSegment, signals: detailSignals, rangeEndUtc: input.toUtc, evidenceCutoffUtc: result.identityEvidenceCutoffUtc })
    const detailedSpeedObservations = result.speedHistory.map((sample) => asObservation(sample))
    const detailedStop = classifyStop({ segment: stop.physicalSegment, ...detailedEvidence, evidenceIntegrity: evidenceIntegrity(stop.physicalSegment), radius: stop.radius, requiredChangeoverEvidence: { ...detailedRequiredActivity, speedTestReturnedToZero: hasInStopSpeedTest(stop.physicalSegment, detailedSpeedObservations) } })
    analysisStop = changeoverStabilizationPhase && mergedChangeoverEvent
      ? { ...detailedStop, classification: 'CHANGEOVER', physicalSegment: analysisStop.physicalSegment, radius: analysisStop.radius }
      : detailedStop
    analysisStops = constituentIds.size ? [...result.report.classifiedStops.filter((item) => !constituentIds.has(stopIntelligenceStopId(item.physicalSegment))), analysisStop] : result.report.classifiedStops.map((item) => stopIntelligenceStopId(item.physicalSegment) === input.stopId ? analysisStop : item)
    const ordered = result.speedHistory.filter((item) => validTime(item.observedAtUtc)).sort((left, right) => Date.parse(left.observedAtUtc) - Date.parse(right.observedAtUtc))
    const prior = ordered.filter((item) => Date.parse(item.observedAtUtc) < Date.parse(fromUtc)).at(-1)
    const contextMap = new Map<string, CanonicalSpeedObservation>()
    if (prior) contextMap.set(fromUtc, asObservation(prior, fromUtc))
    for (const sample of ordered.filter((item) => { const at = Date.parse(item.observedAtUtc); return at >= Date.parse(fromUtc) && at <= Date.parse(toUtc) })) contextMap.set(sample.observedAtUtc, asObservation(sample))
    const bridgedSpeed = bridgeMatchingSpeedStateEvidence({ configuration: result.report.configuration, fromUtc, toUtc, observations: [...contextMap.values()], availabilityIntervals: availabilityIntervals(result.sourceGaps, fromUtc, toUtc) })
    const radiusTimeline = this.radius?.getRawTimeline ? await this.radius.getRawTimeline(input.pressKey, fromUtc, toUtc).catch(() => null) : null
    const canonicalActions = buildChangeoverActions({ stop: analysisStop, allStops: analysisStops, signals: detailSignals, speedSignal: detailSignals.find((item) => item.canonicalId === 'machine.speed.actual' && item.deckNumber === null), rangeEndUtc: input.toUtc, evidenceCutoffUtc: result.identityEvidenceCutoffUtc })
    // Deck state is core stop evidence: it drives the ten deck rows and the
    // Deck Out/Deck In stages. Keep only broad unmapped discovery optional.
    const deckStatusPromise = loadDeckStatusContext(this.telemetry, input.pressKey, fromUtc, toUtc, requestId, signal)
    const rawDiscovery = input.includeRaw ? await loadRawDiscoveries(this.telemetry, input.pressKey, fromUtc, toUtc, requestId, signal) : { results: [], requestedChunkCount: 0 }
    const canonicallyRepresentedRawIdentities = new Set(detailSignals.flatMap((item) => item.rawSignalId ? [item.rawSignalId] : []))
    const rawCandidateSelection = selectBoundedRawEvidenceCandidates(rawDiscovery.results.flatMap((item) => item.signals), canonicallyRepresentedRawIdentities)
    const discoveredRawCandidates = rawCandidateSelection.discovered
    const rawCandidates = rawCandidateSelection.selected
    const rawHistories: RawTelemetryHistoryResponse[] = []
    for (let index = 0; index < rawCandidates.length; index += RAW_HISTORY_CONCURRENCY) {
      const batch = await Promise.all(rawCandidates.slice(index, index + RAW_HISTORY_CONCURRENCY).map((item) => Promise.resolve().then(() => this.telemetry.rawHistory(input.pressKey, item.rawIdentity, fromUtc, toUtc, requestId, signal)).catch(() => undefined)))
      rawHistories.push(...batch.filter((item): item is RawTelemetryHistoryResponse => Boolean(item)))
    }
    const rawActions = buildUncanonicalizedRawActions({ stop: analysisStop, allStops: analysisStops, histories: rawHistories })
    const rawAvailability = rawDiscovery.results.map((item) => item.rawHistoryAvailability).find((item) => item?.state === 'RAW_HISTORY_EXPIRED')
      ?? rawDiscovery.results.map((item) => item.rawHistoryAvailability).find(Boolean)
    const plottedRawIdentities = new Set(rawActions.flatMap((action) => action.evidence.flatMap((evidence) => evidence.rawIdentity ?? [])))
    const rawUnmappedContext: StopIntelligenceDetail['rawUnmappedContext'] = !input.includeRaw
      ? { availability: 'NOT_LOADED', discoveredSignalCount: 0, loadedSignalCount: 0, plottedSignalCount: 0, reason: 'Raw and unmapped telemetry is available as an optional on-demand enrichment.' }
      : !rawDiscovery.results.length
      ? { availability: 'UNAVAILABLE', discoveredSignalCount: 0, loadedSignalCount: 0, plottedSignalCount: 0, reason: 'Raw/unmapped discovery was unavailable for this investigation window.' }
      : plottedRawIdentities.size
        ? { availability: rawCandidates.length < discoveredRawCandidates.length ? 'PARTIAL' : 'AVAILABLE', discoveredSignalCount: discoveredRawCandidates.length, loadedSignalCount: rawHistories.length, plottedSignalCount: plottedRawIdentities.size, reason: `${rawCandidates.length < discoveredRawCandidates.length ? `Showing the ${rawCandidates.length} most active of ${discoveredRawCandidates.length} changing raw signals. ` : ''}Observed changing signals without a canonical mapping are plotted below the shared chronology (${rawDiscovery.results.length}/${rawDiscovery.requestedChunkCount} raw discovery windows available).` }
        : rawAvailability?.state === 'RAW_HISTORY_EXPIRED'
          ? { availability: 'RAW_HISTORY_EXPIRED', discoveredSignalCount: discoveredRawCandidates.length, loadedSignalCount: rawHistories.length, plottedSignalCount: 0, reason: rawAvailability.reason }
          : { availability: 'NO_CHANGES', discoveredSignalCount: discoveredRawCandidates.length, loadedSignalCount: rawHistories.length, plottedSignalCount: 0, reason: rawAvailability?.reason ?? 'No changing, plottable, uncanonicalized signal was observed in this investigation window.' }
    const changeoverActions = { ...canonicalActions, actions: [...canonicalActions.actions, ...rawActions].sort((left, right) => Date.parse(left.startAt ?? '9999-12-31') - Date.parse(right.startAt ?? '9999-12-31') || left.actionCode.localeCompare(right.actionCode)) }
    const deckStatusContext = await deckStatusPromise
    const stageSpeedObservations = bridgedSpeed.observations
    const displaySpeedObservations = downsampleFleetSpeed(stageSpeedObservations)
    const changeoverActivityWindows = buildChangeoverActivityWindows({ stop: analysisStop, actions: changeoverActions.actions, signals: detailSignals, speedObservations: stageSpeedObservations, deckStatus: deckStatusContext, rangeEndUtc: input.toUtc })
    return {
      stopId: input.stopId, displayName: result.report.displayName, rangeFromUtc: input.fromUtc, rangeToUtc: input.toUtc,
      telemetryEvidenceState: result.report.telemetryEvidenceState, identityAssociationConfiguration: result.report.identityAssociationConfiguration, stop: analysisStop, changeoverStabilizationPhase, mergedChangeoverEvent,
      speedContext: { fromUtc, toUtc, unit: result.speedUnit, stopThreshold: result.report.configuration.stopThreshold, recoveryThreshold: result.report.configuration.recoveryThreshold, observations: displaySpeedObservations, unknownIntervals: bridgedSpeed.availabilityIntervals },
      radiusContext: { fromUtc, toUtc, states: (radiusTimeline?.segments ?? []).map((state) => ({ kind: state.kind, startUtc: state.startUtc, endUtc: state.endUtc, eventType: state.eventType, statusCode: state.statusCode, statusDescription: state.statusDescription, isProduction: state.isProduction })), reason: radiusTimeline ? 'Radius states for the complete visual investigation context window.' : 'Radius context was unavailable for this visual investigation window.' },
      actionSignalContext: [...buildActionSignalContext(actionReferencedSignals(detailSignals, canonicalActions), fromUtc, toUtc), ...buildRawActionSignalContext(rawHistories)],
      deckStatusContext,
      changeoverActivityWindows,
      rawUnmappedContext,
      changeoverActions,
    }
  }

  private async analyzeWithReadData(input: StopIntelligenceRequest, requestId?: string, signal?: AbortSignal, useCache = true): Promise<AnalysisReadResult> {
    const cacheKey = `${input.pressKey}|${input.fromUtc}|${input.toUtc}`
    const cached = useCache ? this.analysisCache.get(cacheKey) : undefined
    if (cached && this.now() - cached.completedAt <= STOP_ANALYSIS_CACHE_TTL_MS) return cached.result
    if (cached) this.analysisCache.delete(cacheKey)

    const identityAssociationConfiguration = stopIdentityAssociationConfiguration(input.pressKey)
    if (!identityAssociationConfiguration) throw new StopIntelligenceConfigurationError(`No Stop Intelligence canonical policy is configured for ${input.pressKey}.`)
    const source = await this.telemetry.sources.resolve(input.pressKey, requestId, signal)

    const capabilities = await this.telemetry.capabilities.get(input.pressKey, requestId, signal)
    const selection = overviewEvidenceSelectors(input.pressKey, capabilities)
    const evidenceFromUtc = new Date(Date.parse(input.fromUtc) - identityAssociationConfiguration.identityContextBeforeSeconds * 1_000).toISOString()
    const requestedEvidenceCutoff = Date.parse(input.toUtc) + identityAssociationConfiguration.identityContextAfterSeconds * 1_000
    const identityEvidenceCutoffUtc = new Date(Math.min(requestedEvidenceCutoff, this.now())).toISOString()
    const historyToUtc = new Date(Math.max(Date.parse(input.toUtc), Date.parse(identityEvidenceCutoffUtc))).toISOString()
    let [history, radiusTimeline] = await Promise.all([
      this.telemetry.semanticHistoryWithIdentity(input.pressKey, { fromUtc: evidenceFromUtc, toUtc: historyToUtc, includeSeed: true, signals: selection.selectors }, requestId, signal),
      this.radius?.getRawTimeline ? this.radius.getRawTimeline(input.pressKey, input.fromUtc, input.toUtc).catch(() => null) : Promise.resolve(null),
    ])
    let speed = history.signals.find((item) => item.canonicalId === 'machine.speed.actual' && item.deckNumber === null)
    if (!speed || speed.historianSignalId === null) throw new StopIntelligenceConfigurationError(`Canonical actual-speed history is unavailable for ${input.pressKey}.`)
    const configuration = canonicalSpeedConfiguration(input.pressKey, { sourceId: source.source.id, canonicalSpeedSignalId: speed.historianSignalId })
    if (!configuration) throw new StopIntelligenceConfigurationError(`Resolved canonical speed identity does not match the validated mapping for ${input.pressKey}.`)

    const from = Date.parse(input.fromUtc); const to = Date.parse(input.toUtc)
    const visibleObservations = speedObservationsForRange(speed, input.fromUtc, input.toUtc)
    const visibleGaps = availabilityIntervals(history.readDiagnostics?.sourceGaps ?? [], input.fromUtc, input.toUtc)
    const initialAnalysis = analyzePhysicalStops({ configuration, fromUtc: input.fromUtc, toUtc: input.toUtc, observations: visibleObservations, availabilityIntervals: visibleGaps })
    const leadingCensoredStop = initialAnalysis.segments.find((segment) => segment.leftCensored && segment.leftCensorReason === 'RANGE_START' && Date.parse(segment.startAt) <= from && Date.parse(segment.endAt ?? input.toUtc) > from)
    let analysisFromUtc = input.fromUtc
    let classificationRadiusTimeline = radiusTimeline

    if (leadingCensoredStop) {
      let scanFromUtc = evidenceFromUtc
      let scanObservations = speedObservationsForRange(speed, scanFromUtc, input.fromUtc)
      let scanUnavailable = availabilityIntervals(history.readDiagnostics?.sourceGaps ?? [], scanFromUtc, input.fromUtc)
      let scanBridged = bridgeMatchingSpeedStateEvidence({ configuration, fromUtc: scanFromUtc, toUtc: input.fromUtc, observations: scanObservations, availabilityIntervals: scanUnavailable })
      let goodRunAnchor = latestSustainedGoodRunAnchor({ observations: scanBridged.observations, unavailable: scanBridged.availabilityIntervals, fromUtc: scanFromUtc, toUtc: input.fromUtc, recoveryThreshold: configuration.recoveryThreshold, confirmationSeconds: configuration.recoveryConfirmationSeconds })
      for (const lookbackMs of LEADING_STOP_LOOKBACK_STEPS_MS) {
        if (goodRunAnchor) break
        const chunkFromUtc = new Date(from - lookbackMs).toISOString()
        if (Date.parse(chunkFromUtc) >= Date.parse(scanFromUtc)) continue
        let scanHistory: Awaited<ReturnType<TelemetryFoundationService['semanticHistoryWithIdentity']>>
        try {
          scanHistory = await this.telemetry.semanticHistoryWithIdentity(input.pressKey, { fromUtc: chunkFromUtc, toUtc: scanFromUtc, includeSeed: true, signals: [{ canonicalId: 'machine.speed.actual', representation: 'samples' }] }, requestId, signal)
        } catch (error) {
          if (signal?.aborted) throw error
          break
        }
        const scanSpeed = scanHistory.signals.find((item) => item.canonicalId === 'machine.speed.actual' && item.deckNumber === null)
        if (scanSpeed) {
          const observations = speedObservationsForRange(scanSpeed, chunkFromUtc, scanFromUtc)
          scanObservations = [...new Map([...observations, ...scanObservations].map((item) => [item.atUtc, item])).values()].sort((left, right) => Date.parse(left.atUtc) - Date.parse(right.atUtc))
          scanUnavailable = [...scanUnavailable, ...availabilityIntervals(scanHistory.readDiagnostics?.sourceGaps ?? [], chunkFromUtc, scanFromUtc)]
        }
        scanFromUtc = chunkFromUtc
        scanBridged = bridgeMatchingSpeedStateEvidence({ configuration, fromUtc: scanFromUtc, toUtc: input.fromUtc, observations: scanObservations, availabilityIntervals: scanUnavailable })
        goodRunAnchor = latestSustainedGoodRunAnchor({ observations: scanBridged.observations, unavailable: scanBridged.availabilityIntervals, fromUtc: scanFromUtc, toUtc: input.fromUtc, recoveryThreshold: configuration.recoveryThreshold, confirmationSeconds: configuration.recoveryConfirmationSeconds })
      }

      if (goodRunAnchor) {
        analysisFromUtc = goodRunAnchor
        const expandedEvidenceFromUtc = new Date(Date.parse(goodRunAnchor) - identityAssociationConfiguration.identityContextBeforeSeconds * 1_000).toISOString()
        try {
          const [expandedHistory, expandedRadius] = await Promise.all([
            this.telemetry.semanticHistoryWithIdentity(input.pressKey, { fromUtc: expandedEvidenceFromUtc, toUtc: historyToUtc, includeSeed: true, signals: selection.selectors }, requestId, signal),
            this.radius?.getRawTimeline ? this.radius.getRawTimeline(input.pressKey, goodRunAnchor, input.toUtc).catch(() => null) : Promise.resolve(null),
          ])
          const expandedSpeed = expandedHistory.signals.find((item) => item.canonicalId === 'machine.speed.actual' && item.deckNumber === null)
          if (expandedSpeed?.historianSignalId === configuration.canonicalSpeedSignalId) {
            history = expandedHistory
            speed = expandedSpeed
            classificationRadiusTimeline = expandedRadius ?? radiusTimeline
          } else analysisFromUtc = input.fromUtc
        } catch (error) {
          if (signal?.aborted) throw error
          analysisFromUtc = input.fromUtc
        }
      }
    }

    const observations = speedObservationsForRange(speed, analysisFromUtc, input.toUtc)
    const gaps = availabilityIntervals(history.readDiagnostics?.sourceGaps ?? [], analysisFromUtc, input.toUtc)
    const expandedAnalysis = analyzePhysicalStops({ configuration, fromUtc: analysisFromUtc, toUtc: input.toUtc, observations, availabilityIntervals: gaps })
    const segments = expandedAnalysis.segments.filter((segment) => Date.parse(segment.startAt) < to && Date.parse(segment.endAt ?? input.toUtc) > from)
    const loadedSupportedFamilies = new Set(selection.supportedFamilies)

    // CHANGEOVER is an AND decision: complete physical evidence, a speed test,
    // wash, pump/ink, and impression must all be present. Wash is sparse and
    // inexpensive, so stops that cannot pass that gate never trigger the broad
    // impression/pump reads.
    const followupSelection = candidateClassificationSelectors(input.pressKey, capabilities)
    const washPositiveCandidates = segments.filter((segment) => {
      if (evidenceIntegrity(segment) !== 'VALID' || segment.leftCensored || segment.rightCensored || !hasInStopSpeedTest(segment, observations)) return false
      return detectRequiredChangeoverActivity({ segment, signals: history.signals, rangeEndUtc: input.toUtc, evidenceCutoffUtc: identityEvidenceCutoffUtc }).washActivity
    })
    const followupHistories: Array<Awaited<ReturnType<TelemetryFoundationService['semanticHistoryWithIdentity']>>> = []
    if (followupSelection.selectors.length) {
      for (const segment of washPositiveCandidates) {
        const candidateFromUtc = new Date(Date.parse(segment.startAt) - STOP_DETAIL_CONTEXT_MS).toISOString()
        const candidateToUtc = new Date(Math.min(Date.parse(segment.endAt ?? input.toUtc) + STOP_DETAIL_CONTEXT_MS, Date.parse(identityEvidenceCutoffUtc))).toISOString()
        if (Date.parse(candidateToUtc) > Date.parse(candidateFromUtc)) followupHistories.push(await this.telemetry.semanticHistoryWithIdentity(input.pressKey, { fromUtc: candidateFromUtc, toUtc: candidateToUtc, includeSeed: true, signals: followupSelection.selectors }, requestId, signal))
      }
      if (followupHistories.length) followupSelection.supportedFamilies.forEach((family) => loadedSupportedFamilies.add(family))
    }
    if (followupHistories.length) history = { ...history, signals: mergeEvidenceSignals(history.signals, ...followupHistories.map(({ signals }) => signals)) }

    // Dense analog pump frequency is a last-resort detector. Direct status,
    // sequence, and viscosity state are preferred. Only a candidate that has
    // already passed every other required gate may request frequency samples.
    const frequencySelection = pumpFrequencySelectors(input.pressKey, capabilities)
    if (frequencySelection.length) {
      const frequencyHistories: Array<Awaited<ReturnType<TelemetryFoundationService['semanticHistoryWithIdentity']>>> = []
      for (const segment of washPositiveCandidates) {
        const required = detectRequiredChangeoverActivity({ segment, signals: history.signals, rangeEndUtc: input.toUtc, evidenceCutoffUtc: identityEvidenceCutoffUtc })
        if (!required.washActivity || !required.impressionAdjustment || required.pumpInkActivity) continue
        const candidateFromUtc = new Date(Date.parse(segment.startAt) - STOP_DETAIL_CONTEXT_MS).toISOString()
        const candidateToUtc = new Date(Math.min(Date.parse(segment.endAt ?? input.toUtc) + STOP_DETAIL_CONTEXT_MS, Date.parse(identityEvidenceCutoffUtc))).toISOString()
        if (Date.parse(candidateToUtc) > Date.parse(candidateFromUtc)) frequencyHistories.push(await this.telemetry.semanticHistoryWithIdentity(input.pressKey, { fromUtc: candidateFromUtc, toUtc: candidateToUtc, includeSeed: true, signals: frequencySelection }, requestId, signal))
      }
      if (frequencyHistories.length) history = { ...history, signals: mergeEvidenceSignals(history.signals, ...frequencyHistories.map(({ signals }) => signals)) }
    }
    const classifiedStops = segments.map((segment) => {
      const evidence = buildStopEvidence({ pressKey: input.pressKey, segment, allSegments: expandedAnalysis.segments, signals: history.signals, physicalRangeEndUtc: input.toUtc, identityEvidenceCutoffUtc, identityAssociationConfiguration, supportedFamilies: [...loadedSupportedFamilies] })
      const integrity = evidenceIntegrity(segment)
      const requiredActivity = detectRequiredChangeoverActivity({ segment, signals: history.signals, rangeEndUtc: input.toUtc, evidenceCutoffUtc: identityEvidenceCutoffUtc })
      return classifyStop({ segment, ...evidence, evidenceIntegrity: integrity, radius: overlayRadius(segment, input.toUtc, classificationRadiusTimeline?.segments), requiredChangeoverEvidence: { ...requiredActivity, speedTestReturnedToZero: hasInStopSpeedTest(segment, observations) } })
    })
    const displayObservations = speedObservationsForRange(speed, input.fromUtc, input.toUtc)
    const displayEvidence = bridgeMatchingSpeedStateEvidence({ configuration, fromUtc: input.fromUtc, toUtc: input.toUtc, observations: displayObservations, availabilityIntervals: availabilityIntervals(history.readDiagnostics?.sourceGaps ?? [], input.fromUtc, input.toUtc) })
    const result: AnalysisReadResult = {
      report: { ...expandedAnalysis, fromUtc: input.fromUtc, toUtc: input.toUtc, segments, displayName: history.displayName, telemetryEvidenceState: reportEvidenceState(displayEvidence.observations, displayEvidence.availabilityIntervals, history.readDiagnostics?.historicalAvailability?.state), identityAssociationConfiguration, classifiedStops },
      speedHistory: [speed.seed, ...speed.samples].filter((item): item is TelemetrySample => Boolean(item)),
      speedUnit: typeof speed.sourceUnit === 'string' && speed.sourceUnit.trim() ? speed.sourceUnit.trim() : input.pressKey === 'press14' || input.pressKey === 'press15' ? 'ft/min' : null,
      sourceGaps: history.readDiagnostics?.sourceGaps ?? [],
      signals: history.signals,
      identityEvidenceCutoffUtc,
      radiusTimeline,
    }
    if (useCache && !signal?.aborted) {
      this.analysisCache.set(cacheKey, { completedAt: this.now(), result })
      while (this.analysisCache.size > STOP_ANALYSIS_CACHE_LIMIT) this.analysisCache.delete(this.analysisCache.keys().next().value!)
    }
    return result
  }
}
