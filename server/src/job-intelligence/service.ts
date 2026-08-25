import { RADIUS_PRESS_KEYS, type RadiusPressKey } from '../radius/models.js'
import { RadiusUnavailableError, type RadiusService } from '../radius/radius-service.js'
import type { TelemetryFoundationService } from '../telemetry/telemetry-foundation-service.js'
import { PRODUCTION_CONTEXT_CANONICAL_IDS, PRODUCTION_CONTEXT_FIELDS, type PressEvidenceCapabilities, type PressSemanticHistoryEvidence, type ProductionContextEvidence, type ProductionContextField, type ProductionContextFieldEvidence, type TelemetrySample } from '../telemetry/telemetry-contracts.js'
import { JOB_ANALYSIS_DIMENSIONS, type FleetJobIntelligenceReport, type HistoricalRunSort, type JobAnalysisDimension, type JobDecisionCard, type JobGroupDefinition, type JobIntelligenceFinding, type JobIntelligenceReport, type JobRefinement, type JobRunInspector, type ProductionRun } from './contracts.js'
import { buildPressAffinity, deriveProductionRuns, evidenceSupport, matchesJobGroup, productionContextCoverage, summarizeIdentities, summarizeRadiusLosses, summarizeTransitions, type DeckActiveEvidence } from './engine.js'
import { buildFleetReport } from './fleet-engine.js'
import { aggregateRunLosses, InMemoryJobHistoryRepository, JOB_HISTORY_ANALYTICS_LIMIT, JOB_INTELLIGENCE_ALGORITHM_VERSION, type JobHistoryRepository } from './history-repository.js'
import { jobIntelligenceRadiusAcquisitionLimiter, type JobIntelligenceRadiusAcquisitionDiagnostics, type JobIntelligenceRadiusAcquisitionLimiter, type JobIntelligenceRadiusAcquisitionScope } from './radius-acquisition-limiter.js'

export const JOB_INTELLIGENCE_MAX_RANGE_MS = 7 * 24 * 60 * 60_000
export const JOB_NATURAL_BOUNDARY_CONTEXT_MS = 48 * 60 * 60_000
const FLEET_READ_CONCURRENCY = 2

interface PressRunResult { pressKey: RadiusPressKey; displayName: string; runs: ProductionRun[]; coverage: JobIntelligenceReport['coverage']; deckSupported: boolean }
interface LiveFleetEvidence { live: ProductionRun[]; coverage: FleetJobIntelligenceReport['coverage']; limitations: string[] }
interface RadiusAcquisitionDiagnostics { global: JobIntelligenceRadiusAcquisitionDiagnostics; lastFleet: JobIntelligenceRadiusAcquisitionDiagnostics | null }

function sameIdentity(left: ProductionRun, right: ProductionRun) { return JOB_ANALYSIS_DIMENSIONS.every((field) => left.identities[field] === right.identities[field]) }
function mergeHistoricalAndLiveForAnalysis(historical: ProductionRun[], live: ProductionRun[]) {
  const merged = new Map(historical.map((run) => [run.runId, run]))
  for (const run of live) {
    if (merged.has(run.runId)) { merged.set(run.runId, run); continue }
    const represented = run.boundaryCompleteness !== 'natural' && historical.some((stored) => stored.pressKey === run.pressKey && sameIdentity(stored, run) && Date.parse(stored.endUtc) > Date.parse(run.startUtc) && Date.parse(stored.startUtc) < Date.parse(run.endUtc))
    if (!represented) merged.set(run.runId, run)
  }
  return [...merged.values()].sort((left, right) => Date.parse(left.startUtc) - Date.parse(right.startUtc) || left.runId.localeCompare(right.runId))
}

function reportUrl(input: { pressKey: RadiusPressKey; fromUtc: string; toUtc: string; analyzeBy: JobAnalysisDimension; group?: JobGroupDefinition }): string {
  const query = new URLSearchParams({ press: input.pressKey, fromUtc: input.fromUtc, toUtc: input.toUtc, preset: 'custom', analyzeBy: input.analyzeBy })
  if (input.group) { query.set('operator', input.group.operator); query.set('query', input.group.query); if (input.group.positionStart) query.set('positionStart', String(input.group.positionStart)); if (input.group.positionEnd) query.set('positionEnd', String(input.group.positionEnd)); if (input.group.segmentIndex) query.set('segmentIndex', String(input.group.segmentIndex)); if (input.group.delimiter) query.set('delimiter', input.group.delimiter) }
  return `/job-intelligence?${query}`
}

function explorerUrl(path: string, pressKey: RadiusPressKey, fromUtc: string, toUtc: string): string {
  return `${path}?${new URLSearchParams({ press: pressKey, fromUtc, toUtc, preset: 'custom' })}`
}

function decisions(input: { press: PressRunResult; groupRuns: ProductionRun[]; crossPress: JobIntelligenceReport['crossPress']; transitions: JobIntelligenceReport['transitions']; losses: JobIntelligenceReport['radiusLosses']; reportUrl: string }): JobDecisionCard[] {
  const cards: JobDecisionCard[] = []
  const preferred = input.crossPress.find((row) => (row.support.level === 'strong' || row.support.level === 'moderate') && row.actualVersusComparableGoodPoints !== null)
  if (preferred) cards.push({ kind: 'preferred_press', label: 'Preferred press', headline: preferred.displayName, value: `${preferred.actualVersusComparableGoodPoints! >= 0 ? '+' : ''}${preferred.actualVersusComparableGoodPoints} pts`, detail: `versus comparable expectation · ${preferred.runCount} runs`, evidenceLevel: preferred.support.level, inspectUrl: input.reportUrl })
  const risk = input.transitions.find((row) => (row.support.level === 'strong' || row.support.level === 'moderate') && row.medianTransitionSeconds !== null)
  if (risk) cards.push({ kind: 'sequence_risk', label: 'Sequence risk', headline: `${risk.previousValue} → ${risk.currentValue}`, value: `${Math.round(risk.medianTransitionSeconds! / 60)} min`, detail: `median stable-production proxy on ${risk.pressKey.replace('press', 'Press ')}`, evidenceLevel: risk.support.level, inspectUrl: risk.evidenceUrl })
  const loss = input.losses[0]
  if (loss) cards.push({ kind: 'largest_loss', label: 'Largest loss', headline: loss.statusDescription, value: `${Math.round(loss.totalSeconds / 360) / 10} h`, detail: `${loss.eventType} · ${loss.occurrenceCount} exact Radius episodes`, evidenceLevel: input.groupRuns.length >= 5 ? 'moderate' : input.groupRuns.length >= 3 ? 'limited' : 'insufficient', inspectUrl: loss.evidenceUrl })
  const goodSeconds = input.groupRuns.reduce((sum, run) => sum + run.goodSeconds, 0); const interruptions = input.groupRuns.reduce((sum, run) => sum + run.productionInterruptionCount, 0); const rate = goodSeconds ? interruptions / (goodSeconds / 3600) : null
  if (rate !== null) cards.push({ kind: 'stability', label: 'Stability', headline: input.press.displayName, value: `${Math.round(rate * 10) / 10}/h`, detail: 'production interruptions per Good-time hour', evidenceLevel: input.groupRuns.length >= 5 ? 'moderate' : input.groupRuns.length >= 3 ? 'limited' : 'insufficient', inspectUrl: input.reportUrl })
  if (!cards.some((card) => card.evidenceLevel === 'strong' || card.evidenceLevel === 'moderate')) cards.unshift({ kind: 'insufficient_evidence', label: 'Recommendation', headline: 'Insufficient evidence', value: `${input.groupRuns.length} runs`, detail: 'No preferred press or sequence is declared from sparse support.', evidenceLevel: 'insufficient', inspectUrl: input.reportUrl })
  return cards.slice(0, 4)
}

function findings(cards: JobDecisionCard[], pressKey: RadiusPressKey): JobIntelligenceFinding[] {
  const category: Record<JobDecisionCard['kind'], JobIntelligenceFinding['category']> = { preferred_press: 'press_affinity_anomaly', sequence_risk: 'transition_anomaly', largest_loss: 'radius_loss_anomaly', stability: 'repeat_interruption_anomaly', insufficient_evidence: 'job_performance_anomaly' }
  return cards.filter((card) => card.kind !== 'insufficient_evidence').map((card, index) => ({ findingId: `job-intelligence.${pressKey}.${index}.${card.kind}`, category: category[card.kind], title: `${card.label}: ${card.headline}`, evidenceLevel: card.evidenceLevel, evidenceUrl: card.inspectUrl, deterministicInputs: [card.value, card.detail] }))
}

async function boundedMap<T, R>(values: T[], worker: (value: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const result: PromiseSettledResult<R>[] = new Array(values.length); let cursor = 0
  await Promise.all(Array.from({ length: Math.min(FLEET_READ_CONCURRENCY, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++
      try { result[index] = { status: 'fulfilled', value: await worker(values[index]!) } }
      catch (reason) { result[index] = { status: 'rejected', reason } }
    }
  }))
  return result
}

export async function readJobProductionContext(telemetry: TelemetryFoundationService, pressKey: RadiusPressKey, fromUtc: string, toUtc: string, capabilities: PressEvidenceCapabilities, requestId?: string, signal?: AbortSignal): Promise<ProductionContextEvidence> {
  try { return await telemetry.context(pressKey, fromUtc, toUtc, requestId, signal) }
  catch (error) {
    if (signal?.aborted) throw error
    const fields = {} as Record<ProductionContextField, ProductionContextFieldEvidence>
    for (const field of PRODUCTION_CONTEXT_FIELDS) {
      const canonicalId = PRODUCTION_CONTEXT_CANONICAL_IDS[field]
      const capability = capabilities.capabilities.find((item) => item.canonicalId === canonicalId)
      if (capability?.state === 'UNSUPPORTED') { fields[field] = { field, canonicalId, capabilityState: 'UNSUPPORTED', observationState: 'UNSUPPORTED', seed: null, changes: [] }; continue }
      try {
        const history = await telemetry.semanticHistory(pressKey, { fromUtc, toUtc, includeSeed: true, signals: [{ canonicalId, representation: 'changes' }] }, requestId, signal)
        const item = history.signals.find((candidate) => candidate.canonicalId === canonicalId)
        fields[field] = item ? { field, canonicalId, capabilityState: item.capabilityState, observationState: item.observationState, seed: item.seed, changes: item.changes } : { field, canonicalId, capabilityState: 'TEMPORARILY_UNAVAILABLE', observationState: 'UNSUPPORTED', seed: null, changes: [] }
      } catch (fieldError) {
        if (signal?.aborted) throw fieldError
        fields[field] = { field, canonicalId, capabilityState: 'TEMPORARILY_UNAVAILABLE', observationState: 'UNSUPPORTED', seed: null, changes: [] }
      }
    }
    const changes = JOB_ANALYSIS_DIMENSIONS.flatMap((field) => fields[field].changes.map((change) => ({ atUtc: change.observedAtUtc, field, canonicalId: fields[field].canonicalId, previousValueKind: change.previousValueKind, previousValue: change.previousValue, valueKind: change.valueKind, value: change.value, qualityState: change.qualityState }))).sort((left, right) => Date.parse(left.atUtc) - Date.parse(right.atUtc) || left.field.localeCompare(right.field))
    return { pressKey, sourceKey: capabilities.sourceKey, displayName: capabilities.displayName, fromUtc, toUtc, fields, changes }
  }
}

function productionContextFromHistory(history: PressSemanticHistoryEvidence): ProductionContextEvidence {
  const entries = PRODUCTION_CONTEXT_FIELDS.map((field): [ProductionContextField, ProductionContextFieldEvidence] => {
    const canonicalId = PRODUCTION_CONTEXT_CANONICAL_IDS[field]
    const item = history.signals.find((candidate) => candidate.canonicalId === canonicalId && candidate.deckNumber === null)
    if (!item) throw new Error(`Missing ${canonicalId} from combined Job Intelligence history`)
    return [field, { field, canonicalId, capabilityState: item.capabilityState, observationState: item.observationState, seed: item.seed, changes: item.changes }]
  })
  const fields = Object.fromEntries(entries) as Record<ProductionContextField, ProductionContextFieldEvidence>
  const changes = JOB_ANALYSIS_DIMENSIONS.flatMap((field) => fields[field].changes.map((change) => ({ atUtc: change.observedAtUtc, field, canonicalId: fields[field].canonicalId, previousValueKind: change.previousValueKind, previousValue: change.previousValue, valueKind: change.valueKind, value: change.value, qualityState: change.qualityState }))).sort((left, right) => Date.parse(left.atUtc) - Date.parse(right.atUtc) || left.field.localeCompare(right.field))
  return { pressKey: history.pressKey, sourceKey: history.sourceKey, displayName: history.displayName, fromUtc: history.fromUtc, toUtc: history.toUtc, fields, changes }
}

export class JobIntelligenceService {
  private readonly liveRunCache = new Map<string, { expiresAt: number; run: ProductionRun }>()
  private readonly fleetEvidenceCache = new Map<string, { expiresAt: number; value: Awaited<ReturnType<JobIntelligenceService['loadFleetRuns']>> }>()
  private readonly liveFleetEvidenceCache = new Map<string, { expiresAt: number; value: LiveFleetEvidence }>()
  private readonly liveFleetEvidenceInFlight = new Map<string, Promise<LiveFleetEvidence>>()
  private lastFleetAcquisitionDiagnostics: JobIntelligenceRadiusAcquisitionDiagnostics | null = null
  constructor(private readonly radius: RadiusService, private readonly telemetry: TelemetryFoundationService, private readonly history: JobHistoryRepository = new InMemoryJobHistoryRepository(), private readonly now: () => number = Date.now, private readonly radiusAcquisitionLimiter: JobIntelligenceRadiusAcquisitionLimiter = jobIntelligenceRadiusAcquisitionLimiter) {}

  radiusAcquisitionDiagnostics(): RadiusAcquisitionDiagnostics { return { global: this.radiusAcquisitionLimiter.diagnostics(), lastFleet: this.lastFleetAcquisitionDiagnostics ? { ...this.lastFleetAcquisitionDiagnostics } : null } }

  private async readCanonicalSpeed(pressKey: RadiusPressKey, fromUtc: string, toUtc: string, requestId?: string, signal?: AbortSignal): Promise<{ sourceUnit: string | null; canonicalUnitStatus: string | null; samples: TelemetrySample[] } | undefined> {
    try { const history = await this.telemetry.semanticHistory(pressKey, { fromUtc, toUtc, includeSeed: false, signals: [{ canonicalId: 'machine.speed.actual', representation: 'samples' }] }, requestId, signal); const speed = history.signals.find((item) => item.canonicalId === 'machine.speed.actual'); return speed ? { sourceUnit: speed.sourceUnit, canonicalUnitStatus: speed.canonicalUnitStatus, samples: speed.samples } : undefined } catch (error) { if (signal?.aborted) throw error; return undefined }
  }

  async buildPressRuns(pressKey: RadiusPressKey, fromUtc: string, toUtc: string, requestId?: string, signal?: AbortSignal, includeDecks = false, includeSpeed = false, knownCapabilities?: PressEvidenceCapabilities, acquisitionScope?: JobIntelligenceRadiusAcquisitionScope, naturalBoundaryContext = false): Promise<PressRunResult> {
    if (!this.radius.getRawTimeline) throw new RadiusUnavailableError()
    const evidenceFromUtc = naturalBoundaryContext ? new Date(Date.parse(fromUtc) - JOB_NATURAL_BOUNDARY_CONTEXT_MS).toISOString() : fromUtc
    const evidenceToUtc = naturalBoundaryContext ? new Date(Math.min(Date.parse(toUtc) + JOB_NATURAL_BOUNDARY_CONTEXT_MS, this.now())).toISOString() : toUtc
    const capabilities = knownCapabilities ?? await this.telemetry.capabilities.get(pressKey, requestId, signal)
    const timelinePromise = this.radiusAcquisitionLimiter.run(() => this.radius.getRawTimeline!(pressKey, evidenceFromUtc, evidenceToUtc), { ...(signal ? { signal } : {}), ...(acquisitionScope ? { scope: acquisitionScope } : {}) })
    try {
    const deckCapability = capabilities.capabilities.find((item) => item.canonicalId === 'deck.active')
    const speedCapability = includeSpeed ? capabilities.capabilities.find((item) => item.canonicalId === 'machine.speed.actual') : undefined
    const deckNumbers = includeDecks && deckCapability?.state === 'SUPPORTED' ? deckCapability.deckNumbers : []
    let context: ProductionContextEvidence
    let deckActive: DeckActiveEvidence[] = []
    let speed: { sourceUnit: string | null; canonicalUnitStatus: string | null; samples: TelemetrySample[] } | undefined
    if (deckNumbers.length || speedCapability?.state === 'SUPPORTED') {
      try {
        const history = await this.telemetry.semanticHistory(pressKey, { fromUtc: evidenceFromUtc, toUtc: evidenceToUtc, includeSeed: true, signals: [...PRODUCTION_CONTEXT_FIELDS.map((field) => ({ canonicalId: PRODUCTION_CONTEXT_CANONICAL_IDS[field], representation: 'changes' as const })), ...deckNumbers.map((deckNumber) => ({ canonicalId: 'deck.active', deckNumber, representation: 'changes' as const })), ...(speedCapability?.state === 'SUPPORTED' ? [{ canonicalId: 'machine.speed.actual', representation: 'samples' as const }] : [])] }, requestId, signal)
        context = productionContextFromHistory(history)
        deckActive = history.signals.filter((item) => item.canonicalId === 'deck.active' && item.deckNumber !== null).map((item) => ({ deckNumber: item.deckNumber!, seed: item.seed, changes: item.changes }))
        const actual = history.signals.find((item) => item.canonicalId === 'machine.speed.actual'); if (actual) speed = { sourceUnit: actual.sourceUnit, canonicalUnitStatus: actual.canonicalUnitStatus, samples: actual.samples }
      } catch (error) {
        if (signal?.aborted) throw error
        const [fallbackContext, deckHistory, fallbackSpeed] = await Promise.all([
          readJobProductionContext(this.telemetry, pressKey, evidenceFromUtc, evidenceToUtc, capabilities, requestId, signal),
          deckNumbers.length ? this.telemetry.semanticHistory(pressKey, { fromUtc: evidenceFromUtc, toUtc: evidenceToUtc, includeSeed: true, signals: deckNumbers.map((deckNumber) => ({ canonicalId: 'deck.active', deckNumber, representation: 'changes' })) }, requestId, signal) : Promise.resolve(null),
          speedCapability?.state === 'SUPPORTED' ? this.readCanonicalSpeed(pressKey, evidenceFromUtc, evidenceToUtc, requestId, signal) : Promise.resolve(undefined),
        ])
        context = fallbackContext
        deckActive = deckHistory?.signals.map((item) => ({ deckNumber: item.deckNumber!, seed: item.seed, changes: item.changes })) ?? []; speed = fallbackSpeed
      }
    } else {
      context = await readJobProductionContext(this.telemetry, pressKey, evidenceFromUtc, evidenceToUtc, capabilities, requestId, signal)
    }
    const timeline = await timelinePromise
    const runs = deriveProductionRuns({ pressKey, fromUtc: evidenceFromUtc, toUtc: evidenceToUtc, requestedFromUtc: fromUtc, requestedToUtc: toUtc, context, radiusSegments: timeline.segments, deckActive, ...(speed ? { speed } : {}) })
    return { pressKey, displayName: timeline.displayName, runs, coverage: productionContextCoverage(context, runs), deckSupported: deckCapability?.state === 'SUPPORTED' }
    } catch (error) {
      // An active pg query is bounded by statement_timeout but is not directly
      // abortable through the Radius contract. Drain it before unwinding so its
      // pool client and limiter permit are released on cancellation/error.
      await timelinePromise.catch(() => undefined)
      throw error
    }
  }

  private cacheRuns(runs: ProductionRun[]) {
    const expiresAt = this.now() + 10 * 60_000
    for (const run of runs) this.liveRunCache.set(run.runId, { expiresAt, run })
    for (const [key, value] of this.liveRunCache) if (value.expiresAt <= this.now() || this.liveRunCache.size > 500) this.liveRunCache.delete(key)
  }

  private async loadLiveFleetEvidence(fromUtc: string, toUtc: string, dimension: JobAnalysisDimension, requestId?: string, signal?: AbortSignal): Promise<LiveFleetEvidence> {
    const key = `${fromUtc}\u0000${toUtc}\u0000${dimension}`; const cached = this.liveFleetEvidenceCache.get(key); if (cached && cached.expiresAt > this.now()) return cached.value
    const pending = this.liveFleetEvidenceInFlight.get(key); if (pending) return pending
    // Values and report requests start together in the fleet UI. The shared scan is
    // deliberately detached from either HTTP abort signal so one caller cannot
    // cancel evidence still needed by the other caller.
    const work = (async (): Promise<LiveFleetEvidence> => {
      const acquisitionScope = this.radiusAcquisitionLimiter.createScope()
      const coverage: FleetJobIntelligenceReport['coverage'] = []; const limitations: string[] = []; const live: ProductionRun[] = []
      const capabilityResults = await boundedMap([...RADIUS_PRESS_KEYS], (pressKey) => this.telemetry.capabilities.get(pressKey, requestId))
      const eligible = RADIUS_PRESS_KEYS.flatMap((pressKey, index) => { const result = capabilityResults[index]; if (!result || result.status === 'rejected') { limitations.push(`${pressKey.replace('press', 'Press ')} capability evidence unavailable.`); return [] } const target = result.value.capabilities.find((item) => item.canonicalId === PRODUCTION_CONTEXT_CANONICAL_IDS[dimension]); return target?.state === 'UNSUPPORTED' ? [] : [{ pressKey, capabilities: result.value }] })
      const includeSpeed = Date.parse(toUtc) - Date.parse(fromUtc) <= 2 * 60 * 60_000
      if (!includeSpeed) limitations.push('Canonical running-speed evidence is materialized offline for long windows; this unmaterialized live tail is too wide for a synchronous fleet speed scan.')
      const results = await boundedMap(eligible, ({ pressKey, capabilities }) => this.buildPressRuns(pressKey, fromUtc, toUtc, requestId, undefined, true, includeSpeed, capabilities, acquisitionScope))
      results.forEach((result, index) => { if (result.status === 'fulfilled') { live.push(...result.value.runs); coverage.push({ pressKey: result.value.pressKey, fields: result.value.coverage, limitation: null }) } else limitations.push(`${eligible[index]!.pressKey.replace('press', 'Press ')} live-tail evidence unavailable.`) })
      this.lastFleetAcquisitionDiagnostics = acquisitionScope.diagnostics()
      const value = { live, coverage, limitations }; this.liveFleetEvidenceCache.set(key, { expiresAt: this.now() + 60_000, value }); while (this.liveFleetEvidenceCache.size > 10) this.liveFleetEvidenceCache.delete(this.liveFleetEvidenceCache.keys().next().value!); return value
    })()
    this.liveFleetEvidenceInFlight.set(key, work)
    try { return await work } finally { this.liveFleetEvidenceInFlight.delete(key) }
  }

  private async loadFleetRuns(input: { fromUtc: string; toUtc: string; dimension: JobAnalysisDimension; group?: JobGroupDefinition; refinements?: JobRefinement[] }, requestId?: string, signal?: AbortSignal) {
    const loadedHistory = await this.history.listRuns({ fromUtc: input.fromUtc, toUtc: input.toUtc, limit: JOB_HISTORY_ANALYTICS_LIMIT + 1, ...(input.group ? { identity: { dimension: input.dimension, group: input.group, refinements: input.refinements } } : {}) }); const historyTruncated = loadedHistory.length > JOB_HISTORY_ANALYTICS_LIMIT; const historical = loadedHistory.slice(0, JOB_HISTORY_ANALYTICS_LIMIT)
    const now = this.now(); const requestedEnd = Math.min(Date.parse(input.toUtc), now); const boundedTailFrom = Math.max(Date.parse(input.fromUtc), requestedEnd - JOB_INTELLIGENCE_MAX_RANGE_MS); const needsLiveTail = requestedEnd > Date.parse(input.fromUtc) && Date.parse(input.toUtc) >= now - JOB_INTELLIGENCE_MAX_RANGE_MS
    let tailFrom = boundedTailFrom; let materializedCoverageEstablished = historical.length > 0
    if (needsLiveTail && this.history.persistence === 'postgresql') {
      const checkpoints = await Promise.all(RADIUS_PRESS_KEYS.map((pressKey) => this.history.getCheckpoint(pressKey).catch(() => null))); const watermarks = checkpoints.flatMap((checkpoint) => checkpoint && Number.isFinite(Date.parse(checkpoint.watermarkUtc)) ? [Date.parse(checkpoint.watermarkUtc)] : [])
      if (watermarks.length === RADIUS_PRESS_KEYS.length) { tailFrom = Math.max(boundedTailFrom, Math.min(...watermarks) - 5 * 60_000); materializedCoverageEstablished = checkpoints.every((checkpoint) => Boolean(checkpoint && Date.parse(checkpoint.sourceFromUtc) <= Date.parse(input.fromUtc))) }
    }
    let coverage: FleetJobIntelligenceReport['coverage'] = []; const limitations: string[] = []; let live: ProductionRun[] = []
    if (historyTruncated) limitations.push(`The bounded analytical result reached ${JOB_HISTORY_ANALYTICS_LIMIT} materialized runs; narrow the time range or identity group for complete aggregation.`)
    if (needsLiveTail) {
      const evidence = await this.loadLiveFleetEvidence(new Date(tailFrom).toISOString(), new Date(requestedEnd).toISOString(), input.dimension, requestId, signal); live = evidence.live; coverage = [...evidence.coverage]; limitations.push(...evidence.limitations)
    }
    const merged = mergeHistoricalAndLiveForAnalysis(historical.map((item) => item.run), live)
    this.cacheRuns(live)
    if (Date.parse(input.fromUtc) < tailFrom && !materializedCoverageEstablished) limitations.push('Materialized history does not yet cover the requested period; results contain only the bounded recent live tail.')
    for (const pressKey of RADIUS_PRESS_KEYS) if (!coverage.some((item) => item.pressKey === pressKey) && historical.some((item) => item.run.pressKey === pressKey)) {
      const runs = historical.filter((item) => item.run.pressKey === pressKey).map((item) => item.run); const total = runs.reduce((sum, run) => sum + run.durationSeconds, 0)
      coverage.push({ pressKey, fields: JOB_ANALYSIS_DIMENSIONS.map((field) => { const covered = runs.filter((run) => run.identities[field]).reduce((sum, run) => sum + run.durationSeconds, 0); const percent = total ? Math.round(covered / total * 1_000) / 10 : 0; return { field, capability: covered ? 'available' as const : 'unavailable' as const, valueCoveragePercent: percent, confidence: covered ? percent >= 95 ? 'high' as const : percent >= 75 ? 'moderate' as const : 'limited' as const : 'unavailable' as const, limitation: covered ? percent < 95 ? 'Historical identity coverage is incomplete.' : null : 'No materialized identity evidence for this dimension.' } }), limitation: 'Coverage is derived from materialized historical runs.' })
    }
    return { runs: merged, historicalIds: new Set(historical.map((item) => item.run.runId)), liveIds: new Set(live.map((run) => run.runId)), coverage: coverage.sort((a, b) => Number(a.pressKey.slice(5)) - Number(b.pressKey.slice(5))), limitations }
  }

  private async fleetRuns(input: { fromUtc: string; toUtc: string; dimension: JobAnalysisDimension; group?: JobGroupDefinition; refinements?: JobRefinement[] }, requestId?: string, signal?: AbortSignal) {
    const key = `${input.fromUtc}\u0000${input.toUtc}\u0000${input.dimension}\u0000${JSON.stringify(input.group ?? null)}\u0000${JSON.stringify(input.refinements ?? [])}`; const cached = this.fleetEvidenceCache.get(key)
    if (cached && cached.expiresAt > this.now()) return cached.value
    const value = await this.loadFleetRuns(input, requestId, signal); this.fleetEvidenceCache.set(key, { expiresAt: this.now() + 60_000, value })
    while (this.fleetEvidenceCache.size > 20) this.fleetEvidenceCache.delete(this.fleetEvidenceCache.keys().next().value!)
    return value
  }

  async fleetReport(input: { fromUtc: string; toUtc: string; analyzeBy: JobAnalysisDimension; group: JobGroupDefinition; refinements?: JobRefinement[]; focusPressKey?: RadiusPressKey | null; offset?: number; limit?: number; historicalRunSort?: HistoricalRunSort }, requestId?: string, signal?: AbortSignal): Promise<FleetJobIntelligenceReport> {
    const evidence = await this.fleetRuns({ fromUtc: input.fromUtc, toUtc: input.toUtc, dimension: input.analyzeBy, group: input.group, refinements: input.refinements }, requestId, signal)
    return buildFleetReport({ runs: evidence.runs, dimension: input.analyzeBy, group: input.group, refinements: input.refinements ?? [], focusPressKey: input.focusPressKey ?? null, fromUtc: input.fromUtc, toUtc: input.toUtc, algorithmVersion: JOB_INTELLIGENCE_ALGORITHM_VERSION, historicalRunIds: evidence.historicalIds, liveRunIds: evidence.liveIds, offset: input.offset ?? 0, limit: Math.min(input.limit ?? 50, 100), historicalRunSort: input.historicalRunSort, coverage: evidence.coverage, limitations: evidence.limitations })
  }

  async values(input: { fromUtc: string; toUtc: string; analyzeBy: JobAnalysisDimension; query?: string; limit?: number }, requestId?: string, signal?: AbortSignal) {
    const evidence = await this.fleetRuns({ fromUtc: input.fromUtc, toUtc: input.toUtc, dimension: input.analyzeBy }, requestId, signal); const query = input.query?.trim().toLocaleLowerCase() ?? ''; const grouped = new Map<string, { runCount: number; pressKeys: Set<RadiusPressKey> }>()
    for (const run of evidence.runs) { const value = run.identities[input.analyzeBy]; if (!value || query && !value.toLocaleLowerCase().includes(query)) continue; const current = grouped.get(value) ?? { runCount: 0, pressKeys: new Set() }; current.runCount += 1; current.pressKeys.add(run.pressKey); grouped.set(value, current) }
    return { dimension: input.analyzeBy, values: [...grouped].map(([value, item]) => ({ value, runCount: item.runCount, pressKeys: [...item.pressKeys].sort() })).sort((a, b) => b.runCount - a.runCount || a.value.localeCompare(b.value)).slice(0, Math.min(input.limit ?? 50, 100)), limitations: evidence.limitations }
  }

  async runInspector(runId: string, _requestId?: string, _signal?: AbortSignal): Promise<JobRunInspector | null> {
    const stored = await this.history.getRun(runId); const cached = this.liveRunCache.get(runId); const run = stored?.run ?? (cached && cached.expiresAt > this.now() ? cached.run : null); if (!run) return null
    const stateSeconds = run.goodSeconds + run.makeReadySeconds + run.badSeconds; const percent = (seconds: number) => stateSeconds ? Math.round(seconds / stateSeconds * 1_000) / 10 : 0; const unavailableSeconds = run.unavailableSeconds ?? Math.max(0, run.durationSeconds - run.goodSeconds - run.makeReadySeconds - run.badSeconds - run.otherRadiusSeconds)
    const mainRadiusLosses = (run.radiusLossAggregates ?? aggregateRunLosses(run)).slice(0, 5)
    return { version: 'job-intelligence-run-v3', algorithmVersion: JOB_INTELLIGENCE_ALGORITHM_VERSION, support: evidenceSupport([run]), run: { runId: run.runId, pressKey: run.pressKey, startUtc: run.startUtc, endUtc: run.endUtc, durationSeconds: run.durationSeconds, identities: run.identities, previousIdentities: run.previousIdentities, goodPercent: percent(run.goodSeconds), makeReadyPercent: percent(run.makeReadySeconds), badPercent: percent(run.badSeconds), unavailablePercent: run.durationSeconds ? Math.round(unavailableSeconds / run.durationSeconds * 1_000) / 10 : 0, transitionSeconds: run.transitionToStableProductionSeconds, interruptions: run.runningPerformance?.interruptions ?? run.productionInterruptionCount, medianRunningSpeed: run.runningPerformance?.speed?.median ?? null, runningSpeedUnit: run.runningPerformance?.speed?.sourceUnit ?? null, identityConfidence: run.identityConfidence, dataInterrupted: run.dataInterrupted, identityTransition: run.identityTransition, transitionTiming: run.transitionTiming, deckConfiguration: run.deckConfiguration, mainRadiusLosses } }
  }

  async report(input: { pressKey: RadiusPressKey; fromUtc: string; toUtc: string; analyzeBy: JobAnalysisDimension; group?: JobGroupDefinition }, requestId?: string, signal?: AbortSignal): Promise<JobIntelligenceReport> {
    let selected: PressRunResult
    const partialPresses: RadiusPressKey[] = []
    let fleetRuns: ProductionRun[]
    if (input.group) {
      const capabilityResults = await boundedMap([...RADIUS_PRESS_KEYS], (pressKey) => this.telemetry.capabilities.get(pressKey, requestId, signal))
      const selectedIndex = RADIUS_PRESS_KEYS.indexOf(input.pressKey)
      const selectedCapabilities = capabilityResults[selectedIndex]
      if (!selectedCapabilities || selectedCapabilities.status === 'rejected') throw selectedCapabilities?.reason ?? new Error('Selected press capabilities unavailable')
      const targetCanonicalId = PRODUCTION_CONTEXT_CANONICAL_IDS[input.analyzeBy]
      const eligible = RADIUS_PRESS_KEYS.flatMap((pressKey, index) => {
        const result = capabilityResults[index]
        if (!result || result.status === 'rejected') { partialPresses.push(pressKey); return [] }
        const target = result.value.capabilities.find((item) => item.canonicalId === targetCanonicalId)
        return pressKey === input.pressKey || target?.state !== 'UNSUPPORTED' ? [{ pressKey, capabilities: result.value }] : []
      })
      const runResults = await boundedMap(eligible, ({ pressKey, capabilities }) => this.buildPressRuns(pressKey, input.fromUtc, input.toUtc, requestId, signal, pressKey === input.pressKey, false, capabilities))
      const selectedResult = runResults[eligible.findIndex((item) => item.pressKey === input.pressKey)]
      if (!selectedResult || selectedResult.status === 'rejected') throw selectedResult?.reason ?? new Error('Selected press evidence unavailable')
      selected = selectedResult.value
      fleetRuns = runResults.flatMap((result, index) => {
        if (result.status === 'fulfilled') return result.value.runs
        partialPresses.push(eligible[index]!.pressKey)
        return []
      })
    } else {
      selected = await this.buildPressRuns(input.pressKey, input.fromUtc, input.toUtc, requestId, signal, true)
      fleetRuns = selected.runs
    }
    const groupRuns = input.group ? selected.runs.filter((run) => { const value = run.identities[input.analyzeBy]; return value ? matchesJobGroup(value, input.group!) : false }) : selected.runs
    const crossPress = input.group ? buildPressAffinity(fleetRuns, input.analyzeBy, input.group) : []
    const transitions = summarizeTransitions(selected.runs, input.analyzeBy, input.group)
    const losses = summarizeRadiusLosses(groupRuns, input.pressKey, input.fromUtc, input.toUtc)
    const currentReportUrl = reportUrl(input)
    const decisionCards = decisions({ press: selected, groupRuns, crossPress, transitions, losses, reportUrl: currentReportUrl })
    const includedValues = [...new Set(groupRuns.flatMap((run) => run.identities[input.analyzeBy] ? [run.identities[input.analyzeBy]!] : []))].sort()
    return {
      version: 'job-intelligence-v1', generatedAtUtc: new Date().toISOString(), fromUtc: input.fromUtc, toUtc: input.toUtc, pressKey: input.pressKey, displayName: selected.displayName, analyzeBy: input.analyzeBy, metricName: 'Production State Efficiency',
      boundaryPolicy: { settlingWindowSeconds: 300, stableProductionConfirmationSeconds: 300, description: 'Consecutive usable identity changes separated by no more than five minutes form one settling cluster. Run segmentation may begin at the first indication, while first-seen, last-change, settled, Radius stable-production, and telemetry physical timestamps remain distinct evidence.' },
      coverage: selected.coverage, ranking: summarizeIdentities(selected.runs, input.analyzeBy), selectedGroup: input.group ? { definition: input.group, includedValues, runCount: groupRuns.length } : null, decisions: decisionCards, crossPress, transitions, radiusLosses: losses, findings: findings(decisionCards, input.pressKey),
      evidenceLinks: { rawRadius: explorerUrl('/raw-radius-explorer', input.pressKey, input.fromUtc, input.toUtc), telemetryEvents: explorerUrl('/telemetry-event-explorer', input.pressKey, input.fromUtc, input.toUtc) },
      limitations: ['Radius Good status is an operator-entered production state, not finished-product quality.', 'Transition-to-stable-production is a conservative Radius stable-production proxy unless separate telemetry physical timing is attached; metadata first-seen is never treated as unquestioned process onset.', 'Comparable performance is deterministic matching, not a causal estimate.', ...(selected.deckSupported ? ['Deck continuity uses only canonical deck.active 0/1 evidence with complete per-deck state at the run boundary.'] : ['Deterministic active-deck telemetry is unavailable on the selected press.']), ...(partialPresses.length ? [`Fleet evidence unavailable for ${partialPresses.map((item) => item.replace('press', 'Press ')).join(', ')}.`] : [])],
    }
  }
}
