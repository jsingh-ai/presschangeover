import pg from 'pg'
import type { AppDatabaseConfig } from '../config.js'
import type { RadiusPressKey } from '../radius/models.js'
import { canonicalJobFingerprint, canonicalJobRun, canonicalJobTimestamp } from './canonical-run.js'
import type { JobAnalysisDimension, JobGroupDefinition, JobRefinement, JobRunLossAggregate, ProductionRun } from './contracts.js'

const { Pool } = pg
export const JOB_INTELLIGENCE_ALGORITHM_VERSION = 'job-intelligence-2026.08.v3-minimal'
export const JOB_HISTORY_ANALYTICS_LIMIT = 25_000
const MAX_HISTORY_ROWS = JOB_HISTORY_ANALYTICS_LIMIT + 1
const RUN_TABLE = 'public.job_intelligence_runs'
const LOSS_TABLE = 'public.job_intelligence_run_losses'
const STATE_TABLE = 'public.job_intelligence_materialization_state'

export interface MaterializedProductionRun {
  algorithmVersion: string
  calculatedAtUtc: string
  sourceFromUtc: string
  sourceToUtc: string
  sourceFingerprint: string
  isClosed: boolean
  run: ProductionRun
}

export interface JobHistoryCheckpoint {
  pressKey: RadiusPressKey
  algorithmVersion: string
  watermarkUtc: string
  sourceFromUtc: string
  sourceToUtc: string
  state: 'running' | 'complete' | 'failed'
  updatedAtUtc: string
  startedAtUtc: string | null
  finishedAtUtc: string | null
  lastSuccessAtUtc: string | null
  leaseId: string | null
  leaseExpiresAtUtc: string | null
  lastErrorCode: string | null
  lastErrorMessage: string | null
}

export interface JobHistoryCheckpointClaim {
  pressKey: RadiusPressKey
  algorithmVersion: string
  initialWatermarkUtc: string
  sourceFromUtc: string
  sourceToUtc: string
  leaseId: string
  startedAtUtc: string
  leaseExpiresAtUtc: string
}

export interface JobHistoryQuery {
  fromUtc?: string
  toUtc?: string
  pressKeys?: RadiusPressKey[]
  algorithmVersion?: string
  limit?: number
  identity?: { dimension: JobAnalysisDimension; group: JobGroupDefinition; refinements?: JobRefinement[] }
}

export interface JobHistoryRepository {
  readonly persistence: 'postgresql' | 'memory'
  diagnostics(): { statementCount: number }
  close(): Promise<void>
  initialize(): Promise<void>
  upsertRuns(runs: MaterializedProductionRun[]): Promise<void>
  listRuns(query: JobHistoryQuery): Promise<MaterializedProductionRun[]>
  getRun(runId: string, algorithmVersion?: string): Promise<MaterializedProductionRun | null>
  getCheckpoint(pressKey: RadiusPressKey, algorithmVersion?: string): Promise<JobHistoryCheckpoint | null>
  tryClaimCheckpoint(claim: JobHistoryCheckpointClaim): Promise<JobHistoryCheckpoint | null>
  commitChunk(runs: MaterializedProductionRun[], checkpoint: JobHistoryCheckpoint, leaseId: string): Promise<void>
  failCheckpoint(leaseId: string, checkpoint: JobHistoryCheckpoint): Promise<boolean>
}

const percentile = (values: number[], fraction: number) => { const ordered = [...values].sort((a, b) => a - b); const position = (ordered.length - 1) * fraction; const low = Math.floor(position); const high = Math.ceil(position); return low === high ? ordered[low]! : ordered[low]! + (ordered[high]! - ordered[low]!) * (position - low) }

export function aggregateRunLosses(run: ProductionRun): JobRunLossAggregate[] {
  const grouped = new Map<string, ProductionRun['radiusEpisodes']>()
  for (const episode of run.radiusEpisodes) {
    if (episode.eventType !== 'M' && episode.eventType !== 'B') continue
    const key = `${episode.eventType}\u0000${episode.statusCode ?? ''}\u0000${episode.statusDescription}`; grouped.set(key, [...(grouped.get(key) ?? []), episode])
  }
  return [...grouped.values()].map((episodes): JobRunLossAggregate => ({ eventType: episodes[0]!.eventType, statusCode: episodes[0]!.statusCode, statusDescription: episodes[0]!.statusDescription, category: episodes[0]!.eventType === 'M' ? 'make_ready' : 'bad', totalSeconds: episodes.reduce((sum, episode) => sum + episode.durationSeconds, 0), occurrenceCount: episodes.length, medianEpisodeSeconds: percentile(episodes.map((episode) => episode.durationSeconds), .5) })).sort((a, b) => b.totalSeconds - a.totalSeconds || a.statusDescription.localeCompare(b.statusDescription))
}

export function materializedRun(run: ProductionRun, sourceFromUtc: string, sourceToUtc: string, options: { calculatedAtUtc?: string; algorithmVersion?: string; isClosed?: boolean } = {}): MaterializedProductionRun {
  const algorithmVersion = options.algorithmVersion ?? JOB_INTELLIGENCE_ALGORITHM_VERSION; const calculatedAtUtc = options.calculatedAtUtc ?? new Date().toISOString(); const isClosed = options.isClosed ?? Date.parse(run.endUtc) < Date.parse(sourceToUtc); const losses = run.radiusLossAggregates ?? aggregateRunLosses(run)
  const compactRun = canonicalJobRun({ ...run, transitionMakeReadySeconds: run.transitionMakeReadySeconds ?? transitionPhaseSeconds(run, 'M'), transitionBadSeconds: run.transitionBadSeconds ?? transitionPhaseSeconds(run, 'B'), transitionValid: run.transitionValid ?? (!run.dataInterrupted && run.transitionToStableProductionSeconds !== null), radiusEpisodes: [], radiusLossAggregates: losses })
  return { algorithmVersion, calculatedAtUtc: canonicalJobTimestamp(calculatedAtUtc)!, sourceFromUtc: canonicalJobTimestamp(sourceFromUtc)!, sourceToUtc: canonicalJobTimestamp(sourceToUtc)!, sourceFingerprint: canonicalJobFingerprint(algorithmVersion, compactRun), isClosed, run: compactRun }
}

function matches(value: string | undefined, group: JobGroupDefinition) {
  if (!value) return false
  const candidate = value.toLocaleLowerCase(); const expected = group.query.trim().toLocaleLowerCase()
  if (group.operator === 'exact') return candidate === expected
  if (group.operator === 'contains') return candidate.includes(expected)
  if (group.operator === 'starts_with') return candidate.startsWith(expected)
  if (group.operator === 'ends_with') return candidate.endsWith(expected)
  if (group.operator === 'position_range') return candidate.slice((group.positionStart ?? 1) - 1, group.positionEnd ?? group.positionStart ?? 1) === expected
  return value.split(group.delimiter || '-')[Math.max(1, group.segmentIndex ?? 1) - 1]?.toLocaleLowerCase() === expected
}

function matchesQuery(item: MaterializedProductionRun, query: JobHistoryQuery) {
  const version = query.algorithmVersion ?? JOB_INTELLIGENCE_ALGORITHM_VERSION; const from = query.fromUtc ? Date.parse(query.fromUtc) : -Infinity; const to = query.toUtc ? Date.parse(query.toUtc) : Infinity; const presses = query.pressKeys ? new Set(query.pressKeys) : null
  return item.algorithmVersion === version && Date.parse(item.run.endUtc) > from && Date.parse(item.run.startUtc) < to && (!presses || presses.has(item.run.pressKey)) && (!query.identity || matches(item.run.identities[query.identity.dimension], query.identity.group) && (query.identity.refinements ?? []).every((refinement) => matches(refinement.previousIdentity ? item.run.previousIdentities?.[refinement.dimension] : item.run.identities[refinement.dimension], refinement.group)))
}

export class InMemoryJobHistoryRepository implements JobHistoryRepository {
  readonly persistence = 'memory' as const
  private readonly runs = new Map<string, MaterializedProductionRun>(); private readonly checkpoints = new Map<string, JobHistoryCheckpoint>()
  diagnostics() { return { statementCount: 0 } }
  async close() {}
  async initialize() {}
  async upsertRuns(values: MaterializedProductionRun[]) { for (const value of values) { const key = `${value.algorithmVersion}\u0000${value.run.runId}`; const prior = this.runs.get(key); if (!prior || !prior.isClosed || prior.sourceFingerprint !== value.sourceFingerprint) this.runs.set(key, structuredClone(value)) } }
  async listRuns(query: JobHistoryQuery) { return [...this.runs.values()].filter((item) => matchesQuery(item, query)).sort((a, b) => Date.parse(a.run.startUtc) - Date.parse(b.run.startUtc) || a.run.runId.localeCompare(b.run.runId)).slice(0, Math.min(query.limit ?? MAX_HISTORY_ROWS, MAX_HISTORY_ROWS)).map((item) => structuredClone(item)) }
  async getRun(runId: string, algorithmVersion = JOB_INTELLIGENCE_ALGORITHM_VERSION) { const value = this.runs.get(`${algorithmVersion}\u0000${runId}`); return value ? structuredClone(value) : null }
  async getCheckpoint(pressKey: RadiusPressKey, algorithmVersion = JOB_INTELLIGENCE_ALGORITHM_VERSION) { const value = this.checkpoints.get(`${algorithmVersion}\u0000${pressKey}`); return value ? structuredClone(value) : null }
  async tryClaimCheckpoint(claim: JobHistoryCheckpointClaim) {
    const key = `${claim.algorithmVersion}\u0000${claim.pressKey}`; const current = this.checkpoints.get(key)
    if (current?.state === 'running' && current.leaseExpiresAtUtc && Date.parse(current.leaseExpiresAtUtc) > Date.parse(claim.startedAtUtc)) return null
    const value: JobHistoryCheckpoint = current ? { ...current, state: 'running', updatedAtUtc: claim.startedAtUtc, startedAtUtc: claim.startedAtUtc, finishedAtUtc: null, leaseId: claim.leaseId, leaseExpiresAtUtc: claim.leaseExpiresAtUtc, lastErrorCode: null, lastErrorMessage: null } : { pressKey: claim.pressKey, algorithmVersion: claim.algorithmVersion, watermarkUtc: claim.initialWatermarkUtc, sourceFromUtc: claim.sourceFromUtc, sourceToUtc: claim.initialWatermarkUtc, state: 'running', updatedAtUtc: claim.startedAtUtc, startedAtUtc: claim.startedAtUtc, finishedAtUtc: null, lastSuccessAtUtc: null, leaseId: claim.leaseId, leaseExpiresAtUtc: claim.leaseExpiresAtUtc, lastErrorCode: null, lastErrorMessage: null }
    this.checkpoints.set(key, structuredClone(value)); return structuredClone(value)
  }
  async commitChunk(values: MaterializedProductionRun[], checkpoint: JobHistoryCheckpoint, leaseId: string) {
    const checkpointKey = `${checkpoint.algorithmVersion}\u0000${checkpoint.pressKey}`; const current = this.checkpoints.get(checkpointKey)
    if (!current || current.state !== 'running' || current.leaseId !== leaseId) throw new Error('job_history_materialization_lease_lost')
    const nextRuns = new Map(this.runs)
    for (const value of values) { const key = `${value.algorithmVersion}\u0000${value.run.runId}`; const prior = nextRuns.get(key); if (!prior || !prior.isClosed || prior.sourceFingerprint !== value.sourceFingerprint) nextRuns.set(key, structuredClone(value)) }
    this.runs.clear(); for (const [key, value] of nextRuns) this.runs.set(key, value)
    this.checkpoints.set(checkpointKey, structuredClone(checkpoint))
  }
  async failCheckpoint(leaseId: string, checkpoint: JobHistoryCheckpoint) {
    const key = `${checkpoint.algorithmVersion}\u0000${checkpoint.pressKey}`; const current = this.checkpoints.get(key)
    if (!current || current.state !== 'running' || current.leaseId !== leaseId) return false
    this.checkpoints.set(key, structuredClone(checkpoint)); return true
  }
}

function transitionPhaseSeconds(run: ProductionRun, eventType: 'M' | 'B') {
  const stableAt = run.transitionTiming.incomingStableRadiusProductionStartUtc; if (!stableAt) return null
  const start = Date.parse(run.startUtc); const end = Date.parse(stableAt)
  return run.radiusEpisodes.filter((episode) => episode.eventType === eventType).reduce((sum, episode) => sum + Math.max(0, Math.min(Date.parse(episode.endUtc), end) - Math.max(Date.parse(episode.startUtc), start)) / 1_000, 0)
}

function identities(prefix: string, row: Record<string, unknown>) { return Object.fromEntries((['order', 'recipe', 'customer', 'material'] as const).flatMap((field) => row[`${prefix}${field}`] === null || row[`${prefix}${field}`] === undefined ? [] : [[field, persistenceText(row[`${prefix}${field}`])!]])) }
export function persistenceTimestamp(value: unknown) { if (value === null || value === undefined) return null; if (!(value instanceof Date) && typeof value !== 'string') throw new Error('invalid_job_persistence_timestamp'); return canonicalJobTimestamp(value) }
export function persistenceText(value: unknown) { if (value === null || value === undefined) return null; if (typeof value !== 'string') throw new Error('invalid_job_persistence_text'); return value }
function persistenceNumber(value: unknown) { const number = typeof value === 'number' ? value : typeof value === 'string' && value !== '' ? Number(value) : Number.NaN; if (!Number.isFinite(number)) throw new Error('invalid_job_persistence_number'); return Object.is(number, -0) ? 0 : number }
function numberOrNull(value: unknown) { return value === null || value === undefined ? null : persistenceNumber(value) }
function persistenceBoolean(value: unknown) { if (typeof value !== 'boolean') throw new Error('invalid_job_persistence_boolean'); return value }

function asMaterialized(row: Record<string, unknown>): MaterializedProductionRun {
  const current = identities('', row); const previous = identities('previous_', row); const settled = persistenceTimestamp(row.identitySettledAt); const first = persistenceTimestamp(row.identityFirstSeenAt); const last = persistenceTimestamp(row.identityLastChangeAt); const stable = persistenceTimestamp(row.stableProductionAt); const speedMedian = numberOrNull(row.speedMedian); const deckAvailable = persistenceBoolean(row.deckEvidenceAvailable)
  const losses = (row.losses ?? []) as JobRunLossAggregate[]; const runningGood = persistenceNumber(row.runningGoodSeconds); const runningBad = persistenceNumber(row.runningBadSeconds); const runningObserved = runningGood + runningBad
  const run: ProductionRun = {
    runId: persistenceText(row.runId)!, previousRunId: persistenceText(row.previousRunId), nextRunId: persistenceText(row.nextRunId), pressKey: persistenceText(row.pressKey)! as RadiusPressKey, startUtc: persistenceTimestamp(row.runStartUtc)!, endUtc: persistenceTimestamp(row.runEndUtc)!, durationSeconds: persistenceNumber(row.durationSeconds), identities: current, previousIdentities: Object.keys(previous).length ? previous : null, nextIdentities: Object.keys(identities('next_', row)).length ? identities('next_', row) : null,
    boundaryFields: Object.keys(previous).filter((field) => previous[field] !== current[field]) as JobAnalysisDimension[], contextSettlingSeconds: first && settled ? Math.max(0, (Date.parse(settled) - Date.parse(first)) / 1_000) : 0,
    identityTransition: { identityChangeFirstSeenAtUtc: first, identityLastChangeAtUtc: last, identitySettledAtUtc: settled, settleState: persistenceText(row.settleState)! as ProductionRun['identityTransition']['settleState'], previousResolvedIdentity: Object.keys(previous).length ? previous : null, finalResolvedIdentity: current, inferredBoundary: persistenceBoolean(row.inferredBoundary) },
    dataInterrupted: persistenceBoolean(row.sourceGap), identityAvailability: (row.identityAvailability ?? {}) as ProductionRun['identityAvailability'], coveragePercent: persistenceNumber(row.coveragePercent), identityConfidence: persistenceText(row.identityConfidence)! as ProductionRun['identityConfidence'], goodSeconds: persistenceNumber(row.goodSeconds), makeReadySeconds: persistenceNumber(row.makeReadySeconds), badSeconds: persistenceNumber(row.badSeconds), otherRadiusSeconds: persistenceNumber(row.otherRadiusSeconds), unavailableSeconds: persistenceNumber(row.unavailableSeconds), productionStateEfficiency: numberOrNull(row.productionStateEfficiency), productionInterruptionCount: persistenceNumber(row.interruptionCount), interruptionsPerProductionHour: numberOrNull(row.interruptionsPerHour), transitionToStableProductionSeconds: numberOrNull(row.transitionSeconds), transitionMakeReadySeconds: numberOrNull(row.transitionMakeReadySeconds), transitionBadSeconds: numberOrNull(row.transitionBadSeconds), transitionValid: persistenceBoolean(row.transitionValid), transitionMetric: row.transitionValid ? 'radius_stable_production_proxy' : 'unavailable',
    transitionTiming: { outgoingStableRadiusProductionEndUtc: null, incomingStableRadiusProductionStartUtc: stable, radiusStableProductionProxySeconds: numberOrNull(row.transitionSeconds), metadataFirstSeenToStableSeconds: first && stable ? (Date.parse(stable) - Date.parse(first)) / 1_000 : null, metadataSettledToStableSeconds: settled && stable ? (Date.parse(stable) - Date.parse(settled)) / 1_000 : null, telemetryPhysicalProductionAtUtc: null, timingUncertaintySeconds: numberOrNull(row.identityUncertaintySeconds) },
    radiusEpisodes: [], radiusLossAggregates: losses,
    deckConfiguration: deckAvailable ? { activeDecks: (row.activeDecks ?? []) as number[], reusedDecks: (row.reusedDecks ?? []) as number[], addedDecks: (row.addedDecks ?? []) as number[], removedDecks: (row.removedDecks ?? []) as number[], changedDeckCount: persistenceNumber(row.changedDeckCount), evidenceCanonicalId: 'deck.active' } : null,
    runningPerformance: { stableProductionStartUtc: stable, observedSeconds: runningObserved, goodSeconds: runningGood, badSeconds: runningBad, interruptions: persistenceNumber(row.interruptionCount), interruptionsPerProductionHour: numberOrNull(row.interruptionsPerHour), medianUninterruptedGoodSeconds: numberOrNull(row.medianGoodEpisodeSeconds), restartCount: persistenceNumber(row.restartCount), speed: speedMedian === null ? null : { canonicalId: 'machine.speed.actual', sourceUnit: persistenceText(row.speedSourceUnit), canonicalUnitStatus: persistenceText(row.speedUnitStatus), sampleCount: persistenceNumber(row.speedSampleCount), median: speedMedian, p25: persistenceNumber(row.speedP25), p75: persistenceNumber(row.speedP75), p90: persistenceNumber(row.speedP90), timeWeightedMean: numberOrNull(row.speedTimeWeightedMean) } },
  }
  return { algorithmVersion: persistenceText(row.algorithmVersion)!, calculatedAtUtc: persistenceTimestamp(row.calculatedAtUtc)!, sourceFromUtc: persistenceTimestamp(row.sourceFromUtc)!, sourceToUtc: persistenceTimestamp(row.sourceToUtc)!, sourceFingerprint: persistenceText(row.sourceFingerprint)!, isClosed: persistenceBoolean(row.isClosed), run: canonicalJobRun(run) }
}

const selectColumns = `r.algorithm_version AS "algorithmVersion", r.run_id AS "runId", r.press_key AS "pressKey", r.previous_run_id AS "previousRunId", NULL::text AS "nextRunId", r.run_start_utc AS "runStartUtc", r.run_end_utc AS "runEndUtc", r.duration_seconds AS "durationSeconds", r.order_value AS "order", r.recipe_value AS "recipe", r.customer_value AS "customer", r.material_value AS "material", r.previous_order AS "previous_order", r.previous_recipe AS "previous_recipe", r.previous_customer AS "previous_customer", r.previous_material AS "previous_material", NULL::text AS "next_order", NULL::text AS "next_recipe", NULL::text AS "next_customer", NULL::text AS "next_material", r.identity_first_seen_at AS "identityFirstSeenAt", r.identity_last_change_at AS "identityLastChangeAt", r.identity_settled_at AS "identitySettledAt", r.identity_uncertainty_seconds AS "identityUncertaintySeconds", r.settle_state AS "settleState", r.inferred_boundary AS "inferredBoundary", r.identity_availability AS "identityAvailability", r.identity_confidence AS "identityConfidence", r.coverage_percent AS "coveragePercent", r.source_gap AS "sourceGap", r.good_seconds AS "goodSeconds", r.make_ready_seconds AS "makeReadySeconds", r.bad_seconds AS "badSeconds", r.other_radius_seconds AS "otherRadiusSeconds", r.unavailable_seconds AS "unavailableSeconds", r.production_state_efficiency AS "productionStateEfficiency", r.stable_production_at AS "stableProductionAt", r.transition_seconds AS "transitionSeconds", r.transition_make_ready_seconds AS "transitionMakeReadySeconds", r.transition_bad_seconds AS "transitionBadSeconds", r.transition_valid AS "transitionValid", r.running_good_seconds AS "runningGoodSeconds", r.running_bad_seconds AS "runningBadSeconds", r.interruption_count AS "interruptionCount", r.interruptions_per_hour AS "interruptionsPerHour", r.restart_count AS "restartCount", r.median_good_episode_seconds AS "medianGoodEpisodeSeconds", r.speed_source_unit AS "speedSourceUnit", r.speed_unit_status AS "speedUnitStatus", r.speed_sample_count AS "speedSampleCount", r.speed_median AS "speedMedian", r.speed_time_weighted_mean AS "speedTimeWeightedMean", r.speed_p25 AS "speedP25", r.speed_p75 AS "speedP75", r.speed_p90 AS "speedP90", r.deck_evidence_available AS "deckEvidenceAvailable", r.active_decks AS "activeDecks", r.reused_decks AS "reusedDecks", r.added_decks AS "addedDecks", r.removed_decks AS "removedDecks", r.changed_deck_count AS "changedDeckCount", r.is_closed AS "isClosed", r.source_from_utc AS "sourceFromUtc", r.source_to_utc AS "sourceToUtc", r.calculated_at_utc AS "calculatedAtUtc", r.source_fingerprint AS "sourceFingerprint", COALESCE((SELECT jsonb_agg(jsonb_build_object('eventType', l.event_type, 'statusCode', NULLIF(l.status_code,''), 'statusDescription', l.status_description, 'category', l.loss_category, 'totalSeconds', l.total_seconds, 'occurrenceCount', l.occurrence_count, 'medianEpisodeSeconds', l.median_episode_seconds) ORDER BY l.total_seconds DESC) FROM ${LOSS_TABLE} l WHERE l.algorithm_version=r.algorithm_version AND l.run_id=r.run_id), '[]'::jsonb) AS losses`
const checkpointColumns = `press_key AS "pressKey",algorithm_version AS "algorithmVersion",processed_through_utc AS "watermarkUtc",source_coverage_start_utc AS "sourceFromUtc",source_coverage_end_utc AS "sourceToUtc",state,updated_at_utc AS "updatedAtUtc",started_at_utc AS "startedAtUtc",finished_at_utc AS "finishedAtUtc",last_success_at_utc AS "lastSuccessAtUtc",lease_run_id AS "leaseId",lease_expires_at_utc AS "leaseExpiresAtUtc",last_error_code AS "lastErrorCode",last_error_message AS "lastErrorMessage"`
function checkpointFromRow(row: Record<string, unknown>): JobHistoryCheckpoint { return { ...row, watermarkUtc: persistenceTimestamp(row.watermarkUtc)!, sourceFromUtc: persistenceTimestamp(row.sourceFromUtc)!, sourceToUtc: persistenceTimestamp(row.sourceToUtc)!, updatedAtUtc: persistenceTimestamp(row.updatedAtUtc)!, startedAtUtc: persistenceTimestamp(row.startedAtUtc), finishedAtUtc: persistenceTimestamp(row.finishedAtUtc), lastSuccessAtUtc: persistenceTimestamp(row.lastSuccessAtUtc), leaseExpiresAtUtc: persistenceTimestamp(row.leaseExpiresAtUtc), leaseId: row.leaseId === null || row.leaseId === undefined ? null : String(row.leaseId), lastErrorCode: row.lastErrorCode === null || row.lastErrorCode === undefined ? null : String(row.lastErrorCode), lastErrorMessage: row.lastErrorMessage === null || row.lastErrorMessage === undefined ? null : String(row.lastErrorMessage) } as JobHistoryCheckpoint }

export class PostgresJobHistoryRepository implements JobHistoryRepository {
  readonly persistence = 'postgresql' as const
  private statementCount = 0
  constructor(private readonly pool: pg.Pool) {}
  diagnostics() { return { statementCount: this.statementCount } }
  async close() { await this.pool.end() }
  private query(text: string, values?: unknown[]) { this.statementCount += 1; return this.pool.query(text, values) }
  private countedClient(client: pg.PoolClient): Pick<pg.PoolClient, 'query'> { return { query: ((text: string, values?: unknown[]) => { this.statementCount += 1; return client.query(text, values) }) as pg.PoolClient['query'] } }
  async initialize() { const result = await this.query(`SELECT to_regclass($1) AS runs, to_regclass($2) AS losses, to_regclass($3) AS state,(SELECT count(*)::integer FROM information_schema.columns WHERE table_schema='public' AND table_name='job_intelligence_materialization_state' AND column_name=ANY($4::text[])) AS "safetyColumnCount"`, [RUN_TABLE, LOSS_TABLE, STATE_TABLE, ['started_at_utc','finished_at_utc','last_success_at_utc','lease_run_id','lease_expires_at_utc','last_error_message']]); if (!result.rows[0]?.runs || !result.rows[0]?.losses || !result.rows[0]?.state) throw new Error('job_intelligence_history_migration_missing'); if (Number(result.rows[0]?.safetyColumnCount) !== 6) throw new Error('job_intelligence_checkpoint_safety_migration_missing') }

  private async writeRuns(client: Pick<pg.PoolClient, 'query'>, values: MaterializedProductionRun[]) {
      for (const value of values) {
        const run = value.run; const running = run.runningPerformance; const speed = running?.speed; const deck = run.deckConfiguration; const losses = run.radiusLossAggregates ?? aggregateRunLosses(run)
        const result = await client.query(`INSERT INTO ${RUN_TABLE} (algorithm_version,run_id,press_key,previous_run_id,run_start_utc,run_end_utc,duration_seconds,order_value,recipe_value,customer_value,material_value,previous_order,previous_recipe,previous_customer,previous_material,identity_first_seen_at,identity_last_change_at,identity_settled_at,identity_uncertainty_seconds,settle_state,inferred_boundary,identity_availability,identity_confidence,coverage_percent,source_gap,good_seconds,make_ready_seconds,bad_seconds,other_radius_seconds,unavailable_seconds,production_state_efficiency,stable_production_at,transition_seconds,transition_make_ready_seconds,transition_bad_seconds,transition_valid,running_good_seconds,running_bad_seconds,interruption_count,interruptions_per_hour,restart_count,median_good_episode_seconds,speed_source_unit,speed_unit_status,speed_sample_count,speed_median,speed_time_weighted_mean,speed_p25,speed_p75,speed_p90,speed_variability,deck_evidence_available,active_decks,reused_decks,added_decks,removed_decks,changed_deck_count,is_closed,source_from_utc,source_to_utc,calculated_at_utc,source_fingerprint) VALUES (${Array.from({ length: 62 }, (_, index) => `$${index + 1}`).join(',')}) ON CONFLICT (algorithm_version,run_id) DO UPDATE SET run_end_utc=EXCLUDED.run_end_utc,duration_seconds=EXCLUDED.duration_seconds,identity_last_change_at=EXCLUDED.identity_last_change_at,identity_settled_at=EXCLUDED.identity_settled_at,identity_uncertainty_seconds=EXCLUDED.identity_uncertainty_seconds,settle_state=EXCLUDED.settle_state,identity_availability=EXCLUDED.identity_availability,identity_confidence=EXCLUDED.identity_confidence,coverage_percent=EXCLUDED.coverage_percent,source_gap=EXCLUDED.source_gap,good_seconds=EXCLUDED.good_seconds,make_ready_seconds=EXCLUDED.make_ready_seconds,bad_seconds=EXCLUDED.bad_seconds,other_radius_seconds=EXCLUDED.other_radius_seconds,unavailable_seconds=EXCLUDED.unavailable_seconds,production_state_efficiency=EXCLUDED.production_state_efficiency,stable_production_at=EXCLUDED.stable_production_at,transition_seconds=EXCLUDED.transition_seconds,transition_make_ready_seconds=EXCLUDED.transition_make_ready_seconds,transition_bad_seconds=EXCLUDED.transition_bad_seconds,transition_valid=EXCLUDED.transition_valid,running_good_seconds=EXCLUDED.running_good_seconds,running_bad_seconds=EXCLUDED.running_bad_seconds,interruption_count=EXCLUDED.interruption_count,interruptions_per_hour=EXCLUDED.interruptions_per_hour,restart_count=EXCLUDED.restart_count,median_good_episode_seconds=EXCLUDED.median_good_episode_seconds,speed_source_unit=EXCLUDED.speed_source_unit,speed_unit_status=EXCLUDED.speed_unit_status,speed_sample_count=EXCLUDED.speed_sample_count,speed_median=EXCLUDED.speed_median,speed_time_weighted_mean=EXCLUDED.speed_time_weighted_mean,speed_p25=EXCLUDED.speed_p25,speed_p75=EXCLUDED.speed_p75,speed_p90=EXCLUDED.speed_p90,speed_variability=EXCLUDED.speed_variability,deck_evidence_available=EXCLUDED.deck_evidence_available,active_decks=EXCLUDED.active_decks,reused_decks=EXCLUDED.reused_decks,added_decks=EXCLUDED.added_decks,removed_decks=EXCLUDED.removed_decks,changed_deck_count=EXCLUDED.changed_deck_count,is_closed=EXCLUDED.is_closed,source_from_utc=LEAST(${RUN_TABLE}.source_from_utc,EXCLUDED.source_from_utc),source_to_utc=GREATEST(${RUN_TABLE}.source_to_utc,EXCLUDED.source_to_utc),calculated_at_utc=EXCLUDED.calculated_at_utc,source_fingerprint=EXCLUDED.source_fingerprint WHERE NOT ${RUN_TABLE}.is_closed OR ${RUN_TABLE}.source_fingerprint<>EXCLUDED.source_fingerprint RETURNING run_id`, [value.algorithmVersion,run.runId,run.pressKey,run.previousRunId??null,run.startUtc,run.endUtc,run.durationSeconds,run.identities.order??null,run.identities.recipe??null,run.identities.customer??null,run.identities.material??null,run.previousIdentities?.order??null,run.previousIdentities?.recipe??null,run.previousIdentities?.customer??null,run.previousIdentities?.material??null,run.identityTransition.identityChangeFirstSeenAtUtc,run.identityTransition.identityLastChangeAtUtc,run.identityTransition.identitySettledAtUtc,run.transitionTiming.timingUncertaintySeconds,run.identityTransition.settleState,run.identityTransition.inferredBoundary,JSON.stringify(run.identityAvailability??{}),run.identityConfidence,run.coveragePercent,run.dataInterrupted,run.goodSeconds,run.makeReadySeconds,run.badSeconds,run.otherRadiusSeconds,run.unavailableSeconds??Math.max(0,run.durationSeconds-run.goodSeconds-run.makeReadySeconds-run.badSeconds-run.otherRadiusSeconds),run.productionStateEfficiency??null,run.transitionTiming.incomingStableRadiusProductionStartUtc,run.transitionToStableProductionSeconds,run.transitionMakeReadySeconds??transitionPhaseSeconds(run,'M'),run.transitionBadSeconds??transitionPhaseSeconds(run,'B'),run.transitionValid??(!run.dataInterrupted&&run.transitionToStableProductionSeconds!==null),running?.goodSeconds??0,running?.badSeconds??0,running?.interruptions??run.productionInterruptionCount,running?.interruptionsPerProductionHour??run.interruptionsPerProductionHour??null,running?.restartCount??0,running?.medianUninterruptedGoodSeconds??null,speed?.sourceUnit??null,speed?.canonicalUnitStatus??null,speed?.sampleCount??0,speed?.median??null,speed?.timeWeightedMean??null,speed?.p25??null,speed?.p75??null,speed?.p90??null,speed?speed.p75-speed.p25:null,Boolean(deck),deck?.activeDecks??[],deck?.reusedDecks??[],deck?.addedDecks??[],deck?.removedDecks??[],deck?.changedDeckCount??0,value.isClosed,value.sourceFromUtc,value.sourceToUtc,value.calculatedAtUtc,value.sourceFingerprint])
        if (!result.rowCount) continue
        await client.query(`DELETE FROM ${LOSS_TABLE} WHERE algorithm_version=$1 AND run_id=$2`, [value.algorithmVersion,run.runId])
        for (const loss of losses) await client.query(`INSERT INTO ${LOSS_TABLE} (algorithm_version,run_id,press_key,event_type,status_code,status_description,loss_category,total_seconds,occurrence_count,median_episode_seconds) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [value.algorithmVersion,run.runId,run.pressKey,loss.eventType,loss.statusCode ?? '',loss.statusDescription,loss.category,loss.totalSeconds,loss.occurrenceCount,loss.medianEpisodeSeconds])
      }
  }

  async upsertRuns(values: MaterializedProductionRun[]) {
    if (!values.length) return
    const client = await this.pool.connect()
    const counted = this.countedClient(client)
    try { await counted.query('BEGIN'); await this.writeRuns(counted, values); await counted.query('COMMIT') }
    catch (error) { await counted.query('ROLLBACK'); throw error }
    finally { client.release() }
  }

  private queryParts(query: JobHistoryQuery) {
    const conditions = ['r.algorithm_version=$1']; const values: unknown[] = [query.algorithmVersion ?? JOB_INTELLIGENCE_ALGORITHM_VERSION]
    if (query.fromUtc) { values.push(query.fromUtc); conditions.push(`r.run_end_utc>$${values.length}`) }
    if (query.toUtc) { values.push(query.toUtc); conditions.push(`r.run_start_utc<$${values.length}`) }
    if (query.pressKeys?.length) { values.push(query.pressKeys); conditions.push(`r.press_key=ANY($${values.length}::text[])`) }
    const addGroup = (column: string, group: JobGroupDefinition) => { values.push(group.query.trim().toLocaleLowerCase()); const expected = `$${values.length}`; if (group.operator==='exact') conditions.push(`LOWER(${column})=${expected}`); else if(group.operator==='contains') conditions.push(`LOWER(${column}) LIKE '%'||${expected}||'%'`); else if(group.operator==='starts_with') conditions.push(`LOWER(${column}) LIKE ${expected}||'%'`); else if(group.operator==='ends_with') conditions.push(`LOWER(${column}) LIKE '%'||${expected}`); else if(group.operator==='position_range'){values.push(group.positionStart??1,(group.positionEnd??group.positionStart??1)-(group.positionStart??1)+1);conditions.push(`LOWER(SUBSTRING(${column} FROM $${values.length-1} FOR $${values.length}))=${expected}`)}else{values.push(group.delimiter||'-',Math.max(1,group.segmentIndex??1));conditions.push(`LOWER(SPLIT_PART(${column},$${values.length-1},$${values.length}))=${expected}`)} }
    if(query.identity){addGroup(identityColumn(query.identity.dimension),query.identity.group);for(const refinement of query.identity.refinements??[])addGroup(refinement.previousIdentity?`r.previous_${refinement.dimension}`:identityColumn(refinement.dimension),refinement.group)}
    return { conditions, values }
  }

  async listRuns(query: JobHistoryQuery) { const {conditions,values}=this.queryParts(query);values.push(Math.min(query.limit??MAX_HISTORY_ROWS,MAX_HISTORY_ROWS));const result=await this.query(`SELECT ${selectColumns} FROM ${RUN_TABLE} r WHERE ${conditions.join(' AND ')} ORDER BY r.run_start_utc,r.run_id LIMIT $${values.length}`,values);return result.rows.map(asMaterialized) }
  async getRun(runId:string,algorithmVersion=JOB_INTELLIGENCE_ALGORITHM_VERSION){const result=await this.query(`SELECT ${selectColumns} FROM ${RUN_TABLE} r WHERE r.algorithm_version=$1 AND r.run_id=$2`,[algorithmVersion,runId]);if(!result.rows.length)return null;const item=asMaterialized(result.rows[0]);const next=await this.query(`SELECT run_id,order_value,recipe_value,customer_value,material_value FROM ${RUN_TABLE} WHERE algorithm_version=$1 AND press_key=$2 AND run_start_utc>$3 ORDER BY run_start_utc LIMIT 1`,[algorithmVersion,item.run.pressKey,item.run.startUtc]);if(next.rows[0]){item.run.nextRunId=String(next.rows[0].run_id);item.run.nextIdentities=Object.fromEntries((['order','recipe','customer','material'] as const).flatMap((field)=>next.rows[0][`${field}_value`]===null?[]:[[field,String(next.rows[0][`${field}_value`])]]))}return item}
  async getCheckpoint(pressKey:RadiusPressKey,algorithmVersion=JOB_INTELLIGENCE_ALGORITHM_VERSION){const result=await this.query(`SELECT ${checkpointColumns} FROM ${STATE_TABLE} WHERE algorithm_version=$1 AND press_key=$2`,[algorithmVersion,pressKey]);return result.rows.length?checkpointFromRow(result.rows[0]):null}
  async tryClaimCheckpoint(claim:JobHistoryCheckpointClaim){const result=await this.query(`INSERT INTO ${STATE_TABLE} (algorithm_version,press_key,processed_through_utc,source_coverage_start_utc,source_coverage_end_utc,state,updated_at_utc,started_at_utc,finished_at_utc,last_success_at_utc,lease_run_id,lease_expires_at_utc,last_error_code,last_error_message) VALUES ($1,$2,$3,$4,$3,'running',$6,$6,NULL,NULL,$5,$7,NULL,NULL) ON CONFLICT (algorithm_version,press_key) DO UPDATE SET state='running',updated_at_utc=EXCLUDED.updated_at_utc,started_at_utc=EXCLUDED.started_at_utc,finished_at_utc=NULL,lease_run_id=EXCLUDED.lease_run_id,lease_expires_at_utc=EXCLUDED.lease_expires_at_utc,last_error_code=NULL,last_error_message=NULL WHERE ${STATE_TABLE}.state<>'running' OR ${STATE_TABLE}.lease_expires_at_utc IS NULL OR ${STATE_TABLE}.lease_expires_at_utc<=EXCLUDED.started_at_utc RETURNING ${checkpointColumns}`,[claim.algorithmVersion,claim.pressKey,claim.initialWatermarkUtc,claim.sourceFromUtc,claim.leaseId,claim.startedAtUtc,claim.leaseExpiresAtUtc]);return result.rows.length?checkpointFromRow(result.rows[0]):null}
  async commitChunk(values:MaterializedProductionRun[],checkpoint:JobHistoryCheckpoint,leaseId:string){const client=await this.pool.connect();const counted=this.countedClient(client);try{await counted.query('BEGIN');await this.writeRuns(counted,values);const result=await counted.query(`UPDATE ${STATE_TABLE} SET processed_through_utc=$3,source_coverage_start_utc=$4,source_coverage_end_utc=$5,state=$6,updated_at_utc=$7,finished_at_utc=$8,last_success_at_utc=$9,lease_run_id=$10,lease_expires_at_utc=$11,last_error_code=$12,last_error_message=$13 WHERE algorithm_version=$1 AND press_key=$2 AND state='running' AND lease_run_id=$14`,[checkpoint.algorithmVersion,checkpoint.pressKey,checkpoint.watermarkUtc,checkpoint.sourceFromUtc,checkpoint.sourceToUtc,checkpoint.state,checkpoint.updatedAtUtc,checkpoint.finishedAtUtc,checkpoint.lastSuccessAtUtc,checkpoint.leaseId,checkpoint.leaseExpiresAtUtc,checkpoint.lastErrorCode,checkpoint.lastErrorMessage,leaseId]);if(result.rowCount!==1)throw new Error('job_history_materialization_lease_lost');await counted.query('COMMIT')}catch(error){await counted.query('ROLLBACK');throw error}finally{client.release()}}
  async failCheckpoint(leaseId:string,checkpoint:JobHistoryCheckpoint){const result=await this.query(`UPDATE ${STATE_TABLE} SET state='failed',updated_at_utc=$3,finished_at_utc=$4,lease_run_id=NULL,lease_expires_at_utc=NULL,last_error_code=$5,last_error_message=$6 WHERE algorithm_version=$1 AND press_key=$2 AND state='running' AND lease_run_id=$7`,[checkpoint.algorithmVersion,checkpoint.pressKey,checkpoint.updatedAtUtc,checkpoint.finishedAtUtc,checkpoint.lastErrorCode,checkpoint.lastErrorMessage,leaseId]);return result.rowCount===1}
}

const identityColumn=(dimension:JobAnalysisDimension)=>`r.${dimension}_value`
export function createJobHistoryRepository(config:AppDatabaseConfig):JobHistoryRepository{if(!config.enabled)return new InMemoryJobHistoryRepository();return new PostgresJobHistoryRepository(new Pool({host:config.host,port:config.port,database:config.database,user:config.user,password:config.password,max:2,connectionTimeoutMillis:2_000,idleTimeoutMillis:10_000,query_timeout:15_000,statement_timeout:15_000,application_name:'ProcessIntelligenceJobMinimalHistory',allowExitOnIdle:true}))}
