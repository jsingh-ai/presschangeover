import type { RadiusService } from '../radius/radius-service.js'
import { RADIUS_PRESS_KEYS, type RawRadiusTimeline } from '../radius/models.js'
import type { PressSemanticSignalWithIdentity, TelemetryFoundationService } from '../telemetry/telemetry-foundation-service.js'
import type { DetailedHistoryState, PressEvidenceCapabilities, RawTelemetryChangesResponse, RawTelemetryHistoryResponse, TelemetrySample, TelemetryScalarValue, TelemetrySemanticSelector, TelemetrySourceSignal } from '../telemetry/telemetry-contracts.js'
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
  type StopDeckStatusContext,
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
import { buildChangeoverActions, buildUncanonicalizedRawActions } from './action-engine.js'
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
const RAW_HISTORY_CONCURRENCY = 4
const DECK_STATUS_ROLES = ['active', 'deck_out', 'print_on', 'print_off'] as const
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

function availabilityIntervals(gaps: Array<{ startUtc: string; endUtc: string }>, fromUtc: string, toUtc: string): TelemetryAvailabilityInterval[] {
  const from = Date.parse(fromUtc); const to = Date.parse(toUtc)
  return gaps.flatMap((gap) => {
    const start = Math.max(from, Date.parse(gap.startUtc)); const end = Math.min(to, Date.parse(gap.endUtc))
    return end > start ? [{ fromUtc: new Date(start).toISOString(), toUtc: new Date(end).toISOString(), state: 'SOURCE_TELEMETRY_UNAVAILABLE' as const }] : []
  })
}

function reportEvidenceState(observations: CanonicalSpeedObservation[], sourceGaps: TelemetryAvailabilityInterval[], detailedState?: DetailedHistoryState): StopIntelligenceReport['telemetryEvidenceState'] {
  if (detailedState === 'INSUFFICIENT_DETAILED_TELEMETRY') return 'INSUFFICIENT_DETAILED_TELEMETRY'
  if (detailedState === 'SHARED_COLLECTION_OUTAGE') return 'SHARED_COLLECTION_OUTAGE'
  if (sourceGaps.length || detailedState === 'SOURCE_TELEMETRY_UNAVAILABLE') return 'SOURCE_TELEMETRY_UNAVAILABLE'
  if (observations.some((item) => typeof item.speed === 'number' && normalizeSpeedQuality(item.qualityState) === 'GOOD')) return 'AVAILABLE'
  return observations.length ? 'UNKNOWN_SPEED_QUALITY' : 'INSUFFICIENT_DETAILED_TELEMETRY'
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
    affectedByCollectionGap: ['SOURCE_TELEMETRY_UNAVAILABLE', 'SHARED_COLLECTION_OUTAGE'].includes(segment.leftCensorReason ?? '') || ['SOURCE_TELEMETRY_UNAVAILABLE', 'SHARED_COLLECTION_OUTAGE'].includes(segment.rightCensorReason ?? ''),
    affectedBySpeedQuality: segment.leftCensorReason === 'UNKNOWN_SPEED_QUALITY' || segment.rightCensorReason === 'UNKNOWN_SPEED_QUALITY',
  }
}

function fleetPress(report: StopIntelligenceReport, speedContext: StopSpeedContext, signals: PressSemanticSignalWithIdentity[], radiusTimeline: RawRadiusTimeline | null): StopFleetPressSummary {
  const episodes = report.classifiedStops.map(fleetEpisode)
  const count = (classification: ClassifiedStop['classification']) => episodes.filter((item) => item.classification === classification).length
  const affected = episodes.some((item) => item.leftCensored || item.rightCensored || item.affectedByCollectionGap || item.affectedBySpeedQuality)
  const hasSourceGap = speedContext.unknownIntervals.some(({ state }) => state === 'SOURCE_TELEMETRY_UNAVAILABLE' || state === 'SHARED_COLLECTION_OUTAGE')
  const warning = report.telemetryEvidenceState !== 'AVAILABLE' || affected || hasSourceGap
  const actionContext = buildActionSignalContext(signals, speedContext.fromUtc, speedContext.toUtc)
  const rollLength = actionContext.find((series) => series.canonicalId === 'production.roll.length.actual')
  const rollLengthObservations = downsampleFleetRollLength((rollLength?.observations ?? []).flatMap((observation) => typeof observation.value === 'number' && Number.isFinite(observation.value) ? [{ atUtc: observation.atUtc, value: observation.value, qualityState: observation.qualityState }] : []))
  return {
    pressKey: report.configuration.pressKey, displayName: report.displayName, telemetryEvidenceState: report.telemetryEvidenceState,
    stopCount: episodes.length, totalPhysicalStopSeconds: episodes.reduce((sum, item) => sum + item.physicalDurationSeconds, 0),
    changeoverCount: count('CHANGEOVER'), downtimeCount: count('DOWNTIME'), uncertainCount: count('UNCERTAIN'), badDataCount: count('IGNORE_BAD_DATA'),
    changeoverPhysicalStopSeconds: episodes.filter((item) => item.classification === 'CHANGEOVER').reduce((sum, item) => sum + item.physicalDurationSeconds, 0),
    longestPhysicalStopSeconds: Math.max(0, ...episodes.map((item) => item.physicalDurationSeconds)), dataAvailabilityWarning: warning,
    warningReason: report.telemetryEvidenceState === 'SOURCE_TELEMETRY_UNAVAILABLE' ? 'The selected press telemetry is unavailable during part of this range; no physical speed boundary is fabricated.' : report.telemetryEvidenceState === 'SHARED_COLLECTION_OUTAGE' ? 'A shared telemetry collection outage is corroborated across independent press sources.' : report.telemetryEvidenceState === 'INSUFFICIENT_DETAILED_TELEMETRY' ? 'Detailed telemetry is unavailable for this period, so exact stop analysis cannot proceed.' : report.telemetryEvidenceState !== 'AVAILABLE' ? `Canonical speed evidence is ${report.telemetryEvidenceState.toLowerCase().replaceAll('_', ' ')}.` : affected ? 'One or more stops are censored or affected by incomplete telemetry.' : hasSourceGap ? 'The selected press telemetry is unavailable during part of this range.' : null,
    episodes, speedContext,
    radiusContext: {
      states: (radiusTimeline?.segments ?? []).map((state) => ({ kind: state.kind, startUtc: state.startUtc, endUtc: state.endUtc, eventType: state.eventType, statusCode: state.statusCode, statusDescription: state.statusDescription, isProduction: state.isProduction })),
      reason: radiusTimeline ? 'Exact raw Radius context for the selected press and time window.' : 'Raw Radius context is unavailable for this selected window.',
    },
    identityContext: actionContext.flatMap((series) => series.canonicalId === 'production.order' || series.canonicalId === 'production.recipe' ? [{ signalId: series.signalId, canonicalId: series.canonicalId, rawIdentity: series.rawIdentity, observations: series.observations }] : []),
    rollLengthContext: rollLength && rollLengthObservations.length ? { signalId: rollLength.signalId, canonicalId: 'production.roll.length.actual', rawIdentity: rollLength.rawIdentity, unit: rollLength.unit, observations: rollLengthObservations } : null,
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

function fleetSpeedContext(result: AnalysisReadResult, fromUtc: string, toUtc: string): StopSpeedContext {
  const from = Date.parse(fromUtc); const to = Date.parse(toUtc)
  const ordered = result.speedHistory.filter((item) => validTime(item.observedAtUtc)).sort((left, right) => Date.parse(left.observedAtUtc) - Date.parse(right.observedAtUtc))
  const prior = ordered.filter((item) => Date.parse(item.observedAtUtc) < from).at(-1)
  const contextMap = new Map<string, CanonicalSpeedObservation>()
  if (prior) contextMap.set(fromUtc, asObservation(prior, fromUtc))
  for (const sample of ordered.filter((item) => { const at = Date.parse(item.observedAtUtc); return at >= from && at <= to })) contextMap.set(sample.observedAtUtc, asObservation(sample))
  const unknownIntervals = [...availabilityIntervals(result.sourceGaps, fromUtc, toUtc), ...speedQualityIntervals(ordered, fromUtc, toUtc)].sort((left, right) => Date.parse(left.fromUtc) - Date.parse(right.fromUtc))
  return { fromUtc, toUtc, unit: result.speedUnit, stopThreshold: result.report.configuration.stopThreshold, recoveryThreshold: result.report.configuration.recoveryThreshold, observations: downsampleFleetSpeed([...contextMap.values()].sort((left, right) => Date.parse(left.atUtc) - Date.parse(right.atUtc))), unknownIntervals }
}

function familyFor(canonicalId: string): StopSetupFamily | null {
  return STOP_FAMILY_CANONICAL_PATTERNS.find((value) => value.matches(canonicalId))?.family ?? null
}

function evidenceSelectors(pressKey: StopIntelligenceRequest['pressKey'], capabilities: PressEvidenceCapabilities): { selectors: TelemetrySemanticSelector[]; supportedFamilies: StopSetupFamily[] } {
  const identityIds = new Set(stopIdentityDefinitions(pressKey).flatMap((value) => value.canonicalId ?? []))
  const supported = capabilities.capabilities.filter((value) => value.state === 'SUPPORTED' && value.historyQueryable)
  const selected = supported.filter((value) => identityIds.has(value.canonicalId) || STOP_ACTION_CONTEXT_IDS.has(value.canonicalId) || familyFor(value.canonicalId) !== null)
  const selectors: TelemetrySemanticSelector[] = [{ canonicalId: 'machine.speed.actual', representation: 'samples' }]
  const priority = (canonicalId: string) => identityIds.has(canonicalId) ? 0 : STOP_ACTION_CONTEXT_IDS.has(canonicalId) ? 1 : familyFor(canonicalId) === 'WASH_PUMP_INK' ? 2 : 3
  for (const capability of selected.sort((left, right) => priority(left.canonicalId) - priority(right.canonicalId) || left.canonicalId.localeCompare(right.canonicalId))) {
    const changes = identityIds.has(capability.canonicalId) || capability.canonicalId === 'production.roll' || /^(?:deck|register|impression)\./.test(capability.canonicalId) || /^(?:ink\.washup\.state|ink\.pump\.(?:status|sequence)|ink\.viscosity\.(?:mode|status))$/.test(capability.canonicalId) || /(?:setpoint|rated|command)/i.test(capability.canonicalId)
    if (capability.deckNumbers.length) for (const deckNumber of capability.deckNumbers) selectors.push({ canonicalId: capability.canonicalId, deckNumber, representation: changes ? 'changes' : 'samples' })
    else selectors.push({ canonicalId: capability.canonicalId, representation: changes ? 'changes' : 'samples' })
  }
  const unique = new Map(selectors.map((value) => [`${value.canonicalId}:${value.deckNumber ?? ''}:${value.representation}`, value]))
  const boundedSelectors = [...unique.values()].slice(0, 120)
  return { selectors: boundedSelectors, supportedFamilies: [...new Set(boundedSelectors.flatMap((value) => familyFor(value.canonicalId) ?? []))] }
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
  const displayName = identity.displayName.trim().toLowerCase()
  const suffix = identity.rawIdentity.toLowerCase().split('.').at(-1) ?? ''
  const role = DECK_STATUS_ROLES.find((candidate) => candidate === displayName || candidate === suffix)
  return role && /(?:^|\.)deck(?:\.|$)/i.test(identity.rawIdentity) ? role : null
}

export function deckStatusRawCandidates(signals: TelemetrySourceSignal[]): Array<{ role: DeckStatusRole; rawIdentity: string }> {
  const candidates = signals.flatMap((signal) => {
    const role = deckStatusRole({ rawIdentity: signal.signalId, displayName: signal.displayName })
    return role ? [{ role, rawIdentity: signal.signalId }] : []
  }).sort((left, right) => left.rawIdentity.length - right.rawIdentity.length || left.rawIdentity.localeCompare(right.rawIdentity))
  const selected = new Map<DeckStatusRole, { role: DeckStatusRole; rawIdentity: string }>()
  for (const candidate of candidates) if (!selected.has(candidate.role)) selected.set(candidate.role, candidate)
  return [...selected.values()]
}

function deckBoolean(value: unknown, deckNumber: number): boolean | null {
  if (!Array.isArray(value) || deckNumber >= value.length) return null
  const item = value[deckNumber]
  if (typeof item === 'boolean') return item
  if (typeof item === 'number' && Number.isFinite(item)) return item !== 0
  if (typeof item === 'string') {
    const normalized = item.trim().toLowerCase()
    if (['1', 'true', 'on'].includes(normalized)) return true
    if (['0', 'false', 'off'].includes(normalized)) return false
  }
  return null
}

const unavailableDeckStatus = (fromUtc: string, toUtc: string, reason: string): StopDeckStatusContext => ({
  fromUtc, toUtc, availability: 'UNAVAILABLE', reason, sourceIdentities: [], decks: Array.from({ length: 10 }, (_, index) => ({ deckNumber: index + 1, intervals: [{ startUtc: fromUtc, endUtc: toUtc, state: 'UNKNOWN', active: null, printing: null, out: null }], events: [] })),
})

export function buildDeckStatusContext(histories: Array<{ role: DeckStatusRole; history: RawTelemetryHistoryResponse }>, fromUtc: string, toUtc: string): StopDeckStatusContext {
  const from = Date.parse(fromUtc); const to = Date.parse(toUtc)
  if (!histories.length || !Number.isFinite(from) || !Number.isFinite(to) || to <= from) return unavailableDeckStatus(fromUtc, toUtc, 'No usable raw deck-status containers were available for this press.')
  const byRole = new Map(histories.map((item) => [item.role, item.history]))
  const sourceIdentities = histories.map(({ role, history }) => ({ role, rawIdentity: history.rawIdentity }))
  const points = new Map<DeckStatusRole, Array<{ at: number; value: unknown }>>()
  for (const role of DECK_STATUS_ROLES) {
    const history = byRole.get(role)
    points.set(role, (history?.observations ?? []).flatMap((observation) => {
      const at = Date.parse(observation.timestampUtc)
      return Number.isFinite(at) && normalizeSpeedQuality(observation.qualityState) === 'GOOD' && Array.isArray(observation.rawValue) ? [{ at, value: observation.rawValue }] : []
    }).sort((left, right) => left.at - right.at))
  }
  const boundaryTimes = new Set<number>([from, to])
  for (const values of points.values()) for (const point of values) if (point.at >= from && point.at <= to) boundaryTimes.add(point.at)
  const boundaries = [...boundaryTimes].sort((left, right) => left - right)
  const valueAt = (role: DeckStatusRole, at: number, deckNumber: number) => {
    const point = points.get(role)?.filter((candidate) => candidate.at <= at).at(-1)
    return point ? deckBoolean(point.value, deckNumber) : null
  }
  const decks = Array.from({ length: 10 }, (_, index) => {
    const deckNumber = index + 1
    const intervals: StopDeckStatusContext['decks'][number]['intervals'] = []
    for (let boundaryIndex = 0; boundaryIndex < boundaries.length - 1; boundaryIndex += 1) {
      const start = boundaries[boundaryIndex]!; const end = boundaries[boundaryIndex + 1]!
      if (end <= start) continue
      const active = valueAt('active', start, deckNumber); const printing = valueAt('print_on', start, deckNumber); const out = valueAt('deck_out', start, deckNumber)
      const state = printing === true ? 'PRINTING' : out === true ? 'OUT' : active === true ? 'READY' : active === false ? 'INACTIVE' : 'UNKNOWN'
      const previous = intervals.at(-1)
      if (previous && previous.state === state && previous.active === active && previous.printing === printing && previous.out === out) previous.endUtc = new Date(end).toISOString()
      else intervals.push({ startUtc: new Date(start).toISOString(), endUtc: new Date(end).toISOString(), state, active, printing, out })
    }
    const printOffPoints = points.get('print_off') ?? []
    const events = printOffPoints.flatMap((point, pointIndex) => {
      if (point.at < from || point.at > to || deckBoolean(point.value, deckNumber) !== true) return []
      const previous = printOffPoints.slice(0, pointIndex).at(-1)
      if (previous && deckBoolean(previous.value, deckNumber) === true) return []
      return [{ atUtc: new Date(point.at).toISOString(), kind: 'PRINT_OFF_COMMAND' as const, label: 'Print-off command' }]
    })
    return { deckNumber, intervals, events }
  })
  const presentRoles = new Set(histories.map(({ role }) => role))
  const coreAvailable = presentRoles.has('print_on') && presentRoles.has('deck_out')
  return {
    fromUtc, toUtc, availability: coreAvailable && presentRoles.has('active') ? 'AVAILABLE' : 'PARTIAL',
    reason: coreAvailable ? 'Raw deck containers were split into Decks 1–10. Printing and out-position are observed; active/ready is supporting context.' : 'Only part of the raw deck-status container set was available, so unknown intervals remain explicit.',
    sourceIdentities, decks,
  }
}

async function loadDeckStatusContext(telemetry: TelemetryFoundationService, pressKey: StopIntelligenceRequest['pressKey'], fromUtc: string, toUtc: string, requestId?: string, signal?: AbortSignal): Promise<StopDeckStatusContext> {
  try {
    const candidates = deckStatusRawCandidates(await telemetry.rawCatalog(pressKey, requestId, signal))
    if (!candidates.length) return unavailableDeckStatus(fromUtc, toUtc, 'No recognized raw deck-status containers were discovered for this press.')
    const historyFromUtc = new Date(Date.parse(fromUtc) - STOP_DETAIL_CONTEXT_MS).toISOString()
    const loaded = await Promise.all(candidates.map(async (candidate) => ({ role: candidate.role, history: await telemetry.rawHistory(pressKey, candidate.rawIdentity, historyFromUtc, toUtc, requestId, signal) })))
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

/** Physical bounds come only from validated speed. Other sources cannot move them. */
export class StopIntelligenceService {
  constructor(private readonly telemetry: TelemetryFoundationService, private readonly radius?: RadiusService, private readonly now = () => Date.now(), private readonly corrections = new StopIntelligenceCorrectionService(new InMemoryStopIntelligenceCorrectionRepository())) {}

  async analyze(input: StopIntelligenceRequest, requestId?: string, signal?: AbortSignal): Promise<StopIntelligenceReport> {
    return (await this.analyzeWithReadData(input, requestId, signal)).report
  }

  async fleet(input: StopIntelligenceRequest, requestId?: string, signal?: AbortSignal): Promise<StopIntelligenceFleetReport> {
    const [result, operatorCorrections] = await Promise.all([this.analyzeWithReadData(input, requestId, signal), this.corrections.list(input.pressKey, input.fromUtc, input.toUtc)])
    const press = fleetPress(result.report, fleetSpeedContext(result, input.fromUtc, input.toUtc), result.signals, result.radiusTimeline)
    return { fromUtc: input.fromUtc, toUtc: input.toUtc, algorithmVersion: STOP_INTELLIGENCE_ALGORITHM_VERSION, classificationVersion: STOP_INTELLIGENCE_CLASSIFICATION_VERSION, presses: [press], operatorCorrections, correctionPersistence: this.corrections.persistence }
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
    const radiusTimeline = this.radius?.getRawTimeline ? await this.radius.getRawTimeline(input.pressKey, fromUtc, toUtc).catch(() => null) : null
    const canonicalActions = buildChangeoverActions({ stop, allStops: result.report.classifiedStops, signals: result.signals, speedSignal: result.signals.find((item) => item.canonicalId === 'machine.speed.actual' && item.deckNumber === null), rangeEndUtc: input.toUtc, evidenceCutoffUtc: result.identityEvidenceCutoffUtc })
    const deckStatusPromise = loadDeckStatusContext(this.telemetry, input.pressKey, fromUtc, toUtc, requestId, signal)
    const rawDiscovery = canonicalActions.eligible ? await Promise.resolve().then(() => this.telemetry.rawChanges(input.pressKey, fromUtc, toUtc, requestId, signal)).catch(() => undefined) : undefined
    const canonicallyRepresentedRawIdentities = new Set(result.signals.flatMap((item) => item.rawSignalId ? [item.rawSignalId] : []))
    const rawCandidates = uncanonicalizedRawCandidates(rawDiscovery?.signals ?? [], canonicallyRepresentedRawIdentities)
    const rawHistories: RawTelemetryHistoryResponse[] = []
    for (let index = 0; index < rawCandidates.length; index += RAW_HISTORY_CONCURRENCY) {
      const batch = await Promise.all(rawCandidates.slice(index, index + RAW_HISTORY_CONCURRENCY).map((item) => Promise.resolve().then(() => this.telemetry.rawHistory(input.pressKey, item.rawIdentity, fromUtc, toUtc, requestId, signal)).catch(() => undefined)))
      rawHistories.push(...batch.filter((item): item is RawTelemetryHistoryResponse => Boolean(item)))
    }
    const rawActions = buildUncanonicalizedRawActions({ stop, allStops: result.report.classifiedStops, histories: rawHistories })
    const changeoverActions = { ...canonicalActions, actions: [...canonicalActions.actions, ...rawActions].sort((left, right) => Date.parse(left.startAt ?? '9999-12-31') - Date.parse(right.startAt ?? '9999-12-31') || left.actionCode.localeCompare(right.actionCode)) }
    const deckStatusContext = await deckStatusPromise
    return {
      stopId: input.stopId, displayName: result.report.displayName, rangeFromUtc: input.fromUtc, rangeToUtc: input.toUtc,
      telemetryEvidenceState: result.report.telemetryEvidenceState, identityAssociationConfiguration: result.report.identityAssociationConfiguration, stop,
      speedContext: { fromUtc, toUtc, unit: result.speedUnit, stopThreshold: result.report.configuration.stopThreshold, recoveryThreshold: result.report.configuration.recoveryThreshold, observations: [...contextMap.values()].sort((left, right) => Date.parse(left.atUtc) - Date.parse(right.atUtc)), unknownIntervals },
      radiusContext: { fromUtc, toUtc, states: (radiusTimeline?.segments ?? []).map((state) => ({ kind: state.kind, startUtc: state.startUtc, endUtc: state.endUtc, eventType: state.eventType, statusCode: state.statusCode, statusDescription: state.statusDescription, isProduction: state.isProduction })), reason: radiusTimeline ? 'Radius states for the complete visual investigation context window.' : 'Radius context was unavailable for this visual investigation window.' },
      actionSignalContext: [...buildActionSignalContext(result.signals, fromUtc, toUtc), ...buildRawActionSignalContext(rawHistories)],
      deckStatusContext,
      changeoverActions,
    }
  }

  private async analyzeWithReadData(input: StopIntelligenceRequest, requestId?: string, signal?: AbortSignal): Promise<AnalysisReadResult> {
    const identityAssociationConfiguration = stopIdentityAssociationConfiguration(input.pressKey)
    if (!identityAssociationConfiguration) throw new StopIntelligenceConfigurationError(`No Stop Intelligence canonical policy is configured for ${input.pressKey}.`)
    const source = await this.telemetry.sources.resolve(input.pressKey, requestId, signal)

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
    const speed = history.signals.find((item) => item.canonicalId === 'machine.speed.actual' && item.deckNumber === null)
    if (!speed || speed.historianSignalId === null) throw new StopIntelligenceConfigurationError(`Canonical actual-speed history is unavailable for ${input.pressKey}.`)
    const configuration = canonicalSpeedConfiguration(input.pressKey, { sourceId: source.source.id, canonicalSpeedSignalId: speed.historianSignalId })
    if (!configuration) throw new StopIntelligenceConfigurationError(`Resolved canonical speed identity does not match the validated mapping for ${input.pressKey}.`)

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
      const integrity = segment.physicalDurationSeconds <= 0 ? 'INVALID' : segment.leftCensorReason && !['RANGE_START', 'RANGE_END'].includes(segment.leftCensorReason) || segment.rightCensorReason && !['RANGE_START', 'RANGE_END'].includes(segment.rightCensorReason) ? 'LIMITED' : 'VALID'
      return classifyStop({ segment, ...evidence, evidenceIntegrity: integrity, radius: overlayRadius(segment, input.toUtc, radiusTimeline?.segments) })
    })
    return {
      report: { ...analysis, displayName: history.displayName, telemetryEvidenceState: reportEvidenceState(observations, gaps, history.readDiagnostics?.historicalAvailability?.state), identityAssociationConfiguration, classifiedStops },
      speedHistory: [speed.seed, ...speed.samples].filter((item): item is TelemetrySample => Boolean(item)),
      speedUnit: typeof speed.sourceUnit === 'string' && speed.sourceUnit.trim() ? speed.sourceUnit.trim() : input.pressKey === 'press14' || input.pressKey === 'press15' ? 'ft/min' : null,
      sourceGaps: history.readDiagnostics?.sourceGaps ?? [],
      signals: history.signals,
      identityEvidenceCutoffUtc,
      radiusTimeline,
    }
  }
}
