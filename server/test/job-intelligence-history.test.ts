import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFile } from 'node:fs/promises'
import { mergeContinuousProductionRuns, mergeHistoricalAndLiveRuns, JobHistoryMaterializer } from '../src/job-intelligence/history-materializer.js'
import { aggregateRunLosses, InMemoryJobHistoryRepository, JOB_INTELLIGENCE_ALGORITHM_VERSION, materializedRun, PostgresJobHistoryRepository } from '../src/job-intelligence/history-repository.js'
import type { ProductionRun } from '../src/job-intelligence/contracts.js'

const day = 24 * 60 * 60_000
const start = '2026-01-01T00:00:00.000Z'
const at = (milliseconds: number) => new Date(Date.parse(start) + milliseconds).toISOString()

function run(id: string, fromMs: number, toMs: number, options: { material?: string; interrupted?: boolean; settled?: boolean } = {}): ProductionRun {
  const durationSeconds = (toMs - fromMs) / 1_000
  return {
    runId: id, pressKey: 'press5', startUtc: at(fromMs), endUtc: at(toMs), durationSeconds,
    identities: { order: 'O1', recipe: 'R1', customer: 'C1', ...(options.material === undefined ? {} : { material: options.material }) }, previousIdentities: null, nextIdentities: null,
    boundaryFields: [], contextSettlingSeconds: 0,
    identityTransition: { identityChangeFirstSeenAtUtc: null, identityLastChangeAtUtc: null, identitySettledAtUtc: options.settled === false ? null : at(fromMs + 300_000), settleState: options.settled === false ? 'pending_range_end' : 'confirmed', previousResolvedIdentity: null, finalResolvedIdentity: { order: 'O1', recipe: 'R1', customer: 'C1', ...(options.material === undefined ? {} : { material: options.material }) }, inferredBoundary: false },
    dataInterrupted: options.interrupted ?? false, coveragePercent: 100, identityConfidence: 'high', goodSeconds: durationSeconds, makeReadySeconds: 0, badSeconds: 0, otherRadiusSeconds: 0, productionInterruptionCount: 0,
    transitionToStableProductionSeconds: null, transitionMetric: 'unavailable', transitionTiming: { outgoingStableRadiusProductionEndUtc: null, incomingStableRadiusProductionStartUtc: at(fromMs), radiusStableProductionProxySeconds: null, metadataFirstSeenToStableSeconds: null, metadataSettledToStableSeconds: null, telemetryPhysicalProductionAtUtc: null, timingUncertaintySeconds: null },
    radiusEpisodes: [{ eventType: 'G', statusCode: '10', statusDescription: 'Run Production', startUtc: at(fromMs), endUtc: at(toMs), durationSeconds }], deckConfiguration: null,
  }
}

describe('Job Intelligence historical store', () => {
  it('defines exactly three minimal derived tables and never copies raw source histories', async () => {
    const migration = await readFile(new URL('../migrations/002_job_intelligence_minimal_derived.sql', import.meta.url), 'utf8')
    const safetyMigration = await readFile(new URL('../migrations/003_job_intelligence_checkpoint_safety.sql', import.meta.url), 'utf8')
    assert.equal(migration.match(/CREATE TABLE/gi)?.length, 3)
    for (const table of ['job_intelligence_runs', 'job_intelligence_run_losses', 'job_intelligence_materialization_state']) assert.match(migration, new RegExp(`CREATE TABLE public\\.${table}`))
    for (const field of ['identity_first_seen_at', 'identity_last_change_at', 'identity_settled_at', 'identity_uncertainty_seconds', 'previous_recipe', 'transition_make_ready_seconds', 'transition_bad_seconds', 'running_good_seconds', 'speed_median', 'speed_time_weighted_mean', 'speed_p90', 'deck_evidence_available', 'source_fingerprint']) assert.match(migration, new RegExp(`\\b${field}\\b`))
    assert.doesNotMatch(migration, /radius_episode|raw_telemetry|telemetry_sample|CREATE (DATABASE|SCHEMA|ROLE)|ALTER ROLE|press_radius_db|TelemetryQueryApi/i)
    assert.doesNotMatch(safetyMigration, /CREATE TABLE|radius_episode|raw_telemetry|telemetry_sample|press_radius_db|TelemetryQueryApi/i)
    for (const field of ['started_at_utc', 'finished_at_utc', 'last_success_at_utc', 'lease_run_id', 'lease_expires_at_utc', 'last_error_message']) assert.match(safetyMigration, new RegExp(`\\b${field}\\b`))
    assert.equal(migration.match(/CREATE INDEX/gi)?.length, 6)
    const source = await readFile(new URL('../src/job-intelligence/history-repository.ts', import.meta.url), 'utf8')
    assert.doesNotMatch(source, /press_radius_db|machine_status_|telemetry historian/i)
    assert.match(source, /RUN_TABLE = 'public\.job_intelligence_runs'/); assert.match(source, /LOSS_TABLE = 'public\.job_intelligence_run_losses'/); assert.match(source, /STATE_TABLE = 'public\.job_intelligence_materialization_state'/)
  })

  it('stores sparse per-run exact-loss aggregates rather than every Radius episode', () => {
    const value = run('losses', 0, day); value.radiusEpisodes = [{ eventType: 'M', statusCode: '47', statusDescription: 'Setup Job', startUtc: at(0), endUtc: at(60_000), durationSeconds: 60 }, { eventType: 'M', statusCode: '47', statusDescription: 'Setup Job', startUtc: at(120_000), endUtc: at(300_000), durationSeconds: 180 }, { eventType: 'G', statusCode: '10', statusDescription: 'Run Production', startUtc: at(300_000), endUtc: at(day), durationSeconds: day / 1_000 - 300 }]
    assert.deepEqual(aggregateRunLosses(value), [{ eventType: 'M', statusCode: '47', statusDescription: 'Setup Job', category: 'make_ready', totalSeconds: 240, occurrenceCount: 2, medianEpisodeSeconds: 120 }])
  })

  it('writes only the three allowlisted derived structures with a complete parameterized compact row', async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = []
    const client = { query: async (sql: string, values: unknown[] = []) => { calls.push({ sql, values }); return { rowCount: sql.includes('INSERT INTO public.job_intelligence_runs') ? 1 : 0, rows: [] } }, release() {} }
    const repository = new PostgresJobHistoryRepository({ connect: async () => client } as never); const value = run('sql-run', 0, day); value.radiusEpisodes.unshift({ eventType: 'M', statusCode: '47', statusDescription: 'Setup Job', startUtc: at(0), endUtc: at(60_000), durationSeconds: 60 })
    await repository.upsertRuns([materializedRun(value, start, at(day), { isClosed: true })])
    const insert = calls.find((call) => call.sql.includes('INSERT INTO public.job_intelligence_runs'))!; const placeholders = [...insert.sql.matchAll(/\$(\d+)/g)].map((match) => Number(match[1])); assert.equal(Math.max(...placeholders), insert.values.length); assert.equal(insert.values.length, 62)
    const mutationSql = calls.map((call) => call.sql).filter((sql) => /\b(?:INSERT|UPDATE|DELETE|MERGE)\b/i.test(sql)).join('\n')
    assert.doesNotMatch(mutationSql, /press_radius|machine_status|telemetry|historian|classification_documents/i); assert.match(mutationSql, /job_intelligence_runs/); assert.match(mutationSql, /job_intelligence_run_losses/)
  })

  it('keeps production materialization independent of classification persistence', async () => {
    const backfill = await readFile(new URL('../src/job-intelligence/backfill.ts', import.meta.url), 'utf8')
    const representative = await readFile(new URL('../src/job-intelligence/representative-validation.ts', import.meta.url), 'utf8')
    for (const source of [backfill, representative]) {
      assert.doesNotMatch(source, /createClassificationService|ClassifiedRadiusService|classification_documents|classifications\.initialize/)
      assert.match(source, /createMaterializationRadiusService/); assert.match(source, /acquireMaterializationPreflight/); assert.match(source, /radiusOwner\?\.close\(\)/)
    }
  })

  it('uses stable versioned IDs and remains duplicate-free across repeated upserts', async () => {
    const repository = new InMemoryJobHistoryRepository(); const value = materializedRun(run('stable-run', 0, day), start, at(day))
    assert.equal(value.sourceFingerprint, materializedRun(run('stable-run', 0, day), at(-day), at(2 * day)).sourceFingerprint)
    await repository.upsertRuns([value, value]); await repository.upsertRuns([structuredClone(value)])
    const stored = await repository.listRuns({})
    assert.equal(stored.length, 1); assert.equal(stored[0]!.run.runId, 'stable-run'); assert.equal(stored[0]!.algorithmVersion, JOB_INTELLIGENCE_ALGORITHM_VERSION)
  })

  it('updates an open run to closed without changing its identity', async () => {
    const repository = new InMemoryJobHistoryRepository(); const open = materializedRun(run('open-run', 0, day, { settled: false }), start, at(day), { isClosed: false })
    await repository.upsertRuns([open]); await repository.upsertRuns([materializedRun(run('open-run', 0, 2 * day), start, at(3 * day), { isClosed: true })])
    const stored = await repository.getRun('open-run')
    assert.equal(stored?.isClosed, true); assert.equal(stored?.run.endUtc, at(2 * day))
  })

  it('merges a recent live continuation but never bridges a source gap', () => {
    const historical = materializedRun(run('left', 0, day), start, at(day), { isClosed: false })
    const merged = mergeHistoricalAndLiveRuns([historical], [run('window-run', day, 2 * day)], at(day - 300_000), at(2 * day))
    assert.equal(merged.length, 1); assert.equal(merged[0]!.run.runId, 'left'); assert.equal(merged[0]!.run.endUtc, at(2 * day))
    assert.equal(mergeContinuousProductionRuns(run('gap-left', 0, day, { interrupted: true }), run('gap-right', day, 2 * day)), null)
  })

  it('resumes from its checkpoint after an interrupted bounded backfill', async () => {
    const repository = new InMemoryJobHistoryRepository(); let fail = true; const requests: string[] = []
    const materializer = new JobHistoryMaterializer(repository, async (_press, fromUtc, toUtc) => { requests.push(`${fromUtc}/${toUtc}`); if (fail && Date.parse(fromUtc) >= Date.parse(start) + 7 * day - 300_000) throw new Error('temporary'); return [] }, () => new Date('2026-02-01T00:00:00.000Z'))
    await assert.rejects(() => materializer.backfillPress({ pressKey: 'press5', fromUtc: start, toUtc: at(10 * day) }))
    const failed = await repository.getCheckpoint('press5'); assert.equal(failed?.state, 'failed'); assert.equal(failed?.watermarkUtc, at(7 * day))
    fail = false; const result = await materializer.backfillPress({ pressKey: 'press5', fromUtc: start, toUtc: at(10 * day) })
    assert.equal(result.resumedFromUtc, at(7 * day)); assert.equal(result.chunksCompleted, 1); assert.equal((await repository.getCheckpoint('press5'))?.state, 'complete'); assert.equal(requests.length, 3)
  })

  it('extends an existing checkpoint backward once, then resumes the expanded range', async () => {
    const repository = new InMemoryJobHistoryRepository(); const representativeFrom = at(8 * day); const representativeTo = at(9 * day)
    const materializer = new JobHistoryMaterializer(repository, async () => [], () => new Date('2026-02-01T00:00:00.000Z'))
    await materializer.backfillPress({ pressKey: 'press5', fromUtc: representativeFrom, toUtc: representativeTo })

    let acquisitions = 0; let fail = true
    const broad = new JobHistoryMaterializer(repository, async () => { acquisitions += 1; if (fail && acquisitions === 2) throw new Error('interrupted broad history'); return [] }, () => new Date('2026-02-02T00:00:00.000Z'))
    await assert.rejects(() => broad.backfillPress({ pressKey: 'press5', fromUtc: start, toUtc: at(10 * day) }))
    const failed = await repository.getCheckpoint('press5')
    assert.equal(failed?.sourceFromUtc, start); assert.equal(failed?.watermarkUtc, at(7 * day))

    fail = false
    const resumed = await broad.backfillPress({ pressKey: 'press5', fromUtc: start, toUtc: at(10 * day) })
    assert.equal(resumed.resumedFromUtc, at(7 * day)); assert.equal(acquisitions, 3)
  })

  it('marks a pre-processing Radius connection failure failed without facts or watermark advancement', async () => {
    const repository = new InMemoryJobHistoryRepository(); const failure = Object.assign(new Error('too many connections for role processintelligence_readonly'), { code: '53300' })
    const materializer = new JobHistoryMaterializer(repository, async () => { throw failure }, () => new Date(start))
    await assert.rejects(() => materializer.backfillPress({ pressKey: 'press5', fromUtc: start, toUtc: at(day) }), failure)
    const checkpoint = await repository.getCheckpoint('press5')
    assert.equal(checkpoint?.state, 'failed'); assert.equal(checkpoint?.watermarkUtc, start); assert.equal(checkpoint?.sourceToUtc, start)
    assert.equal(checkpoint?.lastErrorCode, 'radius_connection:53300'); assert.equal(checkpoint?.finishedAtUtc, start); assert.equal(checkpoint?.leaseId, null)
    assert.deepEqual(await repository.listRuns({}), [])
  })

  it('preserves an earlier committed safe chunk when the next source acquisition fails', async () => {
    const repository = new InMemoryJobHistoryRepository(); let acquisition = 0
    const materializer = new JobHistoryMaterializer(repository, async () => { acquisition += 1; if (acquisition === 2) throw new Error('bounded source failed'); return [run('safe-run', 0, 6 * day)] }, () => new Date(start))
    await assert.rejects(() => materializer.backfillPress({ pressKey: 'press5', fromUtc: start, toUtc: at(10 * day) }))
    const checkpoint = await repository.getCheckpoint('press5'); const stored = await repository.listRuns({})
    assert.equal(checkpoint?.state, 'failed'); assert.equal(checkpoint?.watermarkUtc, at(7 * day)); assert.equal(checkpoint?.sourceToUtc, at(7 * day))
    assert.deepEqual(stored.map((item) => item.run.runId), ['safe-run'])
  })

  it('moves cancellation out of running without advancing or creating facts', async () => {
    const repository = new InMemoryJobHistoryRepository(); const controller = new AbortController()
    const materializer = new JobHistoryMaterializer(repository, async () => { controller.abort(); throw new Error('cancelled active source') }, () => new Date(start))
    await assert.rejects(() => materializer.backfillPress({ pressKey: 'press5', fromUtc: start, toUtc: at(day), signal: controller.signal }))
    const checkpoint = await repository.getCheckpoint('press5')
    assert.equal(checkpoint?.state, 'failed'); assert.equal(checkpoint?.lastErrorCode, 'cancelled'); assert.equal(checkpoint?.watermarkUtc, start); assert.equal(checkpoint?.leaseId, null)
    assert.equal((await repository.listRuns({})).length, 0)
  })

  it('rolls a failed fact/checkpoint commit back to the prior safe state', async () => {
    class FailingCommitRepository extends InMemoryJobHistoryRepository {
      override async commitChunk() { throw new Error('application persistence failed') }
    }
    const repository = new FailingCommitRepository(); const materializer = new JobHistoryMaterializer(repository, async () => [run('must-not-appear', 0, day)], () => new Date(start))
    await assert.rejects(() => materializer.backfillPress({ pressKey: 'press5', fromUtc: start, toUtc: at(2 * day) }), /application persistence failed/)
    const checkpoint = await repository.getCheckpoint('press5')
    assert.equal(checkpoint?.state, 'failed'); assert.equal(checkpoint?.lastErrorCode, 'persistence'); assert.equal(checkpoint?.watermarkUtc, start); assert.equal((await repository.listRuns({})).length, 0)
  })

  it('recovers a stale running lease from the last safe boundary without duplicating runs', async () => {
    const repository = new InMemoryJobHistoryRepository(); const existing = materializedRun(run('existing', 0, day), start, at(day), { isClosed: true }); await repository.upsertRuns([existing])
    const claimed = await repository.tryClaimCheckpoint({ pressKey: 'press5', algorithmVersion: JOB_INTELLIGENCE_ALGORITHM_VERSION, initialWatermarkUtc: at(day), sourceFromUtc: start, sourceToUtc: at(2 * day), leaseId: 'crashed-worker', startedAtUtc: start, leaseExpiresAtUtc: at(1_000) })
    assert.equal(claimed?.state, 'running')
    let blockedBuilds = 0; const blocked = new JobHistoryMaterializer(repository, async () => { blockedBuilds += 1; return [] }, () => new Date(Date.parse(start) + 500), 1_000)
    await assert.rejects(() => blocked.backfillPress({ pressKey: 'press5', fromUtc: start, toUtc: at(2 * day) }), /already_running/); assert.equal(blockedBuilds, 0)
    let nowMs = Date.parse(start) + 2_000; const materializer = new JobHistoryMaterializer(repository, async () => [run('existing', 0, day)], () => new Date(nowMs), 1_000)
    const result = await materializer.backfillPress({ pressKey: 'press5', fromUtc: start, toUtc: at(2 * day) })
    assert.equal(result.resumedFromUtc, at(day)); assert.equal((await repository.listRuns({})).length, 1); assert.equal((await repository.getCheckpoint('press5'))?.state, 'complete')
    nowMs += 1_000
  })

  it('reruns successfully after failure without duplicate run or loss facts', async () => {
    const repository = new InMemoryJobHistoryRepository(); let fail = true; const complete = run('retry-run', 0, day); complete.radiusEpisodes.unshift({ eventType: 'M', statusCode: '47', statusDescription: 'Setup Job', startUtc: at(0), endUtc: at(60_000), durationSeconds: 60 })
    const materializer = new JobHistoryMaterializer(repository, async () => { if (fail) throw new Error('first attempt failed'); return [complete] }, () => new Date(start))
    await assert.rejects(() => materializer.backfillPress({ pressKey: 'press5', fromUtc: start, toUtc: at(2 * day) }))
    fail = false; await materializer.backfillPress({ pressKey: 'press5', fromUtc: start, toUtc: at(2 * day) }); await materializer.backfillPress({ pressKey: 'press5', fromUtc: start, toUtc: at(2 * day), resume: false })
    const stored = await repository.listRuns({}); const checkpoint = await repository.getCheckpoint('press5')
    assert.equal(stored.length, 1); assert.equal(stored[0]?.run.radiusLossAggregates?.length, 1); assert.equal(checkpoint?.state, 'complete'); assert.equal(checkpoint?.lastErrorCode, null); assert.ok(checkpoint?.lastSuccessAtUtc)
  })

  it('defers a chunk-boundary run and rereads it whole without losing compact facts', async () => {
    const repository = new InMemoryJobHistoryRepository(); const requests: Array<{ fromUtc: string; toUtc: string }> = []
    const closed = run('closed', 0, 6 * day); const partial = run('boundary', 6 * day, 7 * day); const complete = run('boundary', 6 * day, 8 * day); const tail = run('tail', 8 * day, 10 * day)
    complete.runningPerformance = { stableProductionStartUtc: complete.startUtc, observedSeconds: 2 * day / 1_000, goodSeconds: 2 * day / 1_000, badSeconds: 0, interruptions: 0, interruptionsPerProductionHour: 0, medianUninterruptedGoodSeconds: 2 * day / 1_000, restartCount: 0, speed: { canonicalId: 'machine.speed.actual', sourceUnit: 'fpm', canonicalUnitStatus: 'canonical', sampleCount: 100, median: 500, p25: 480, p75: 520, p90: 540, timeWeightedMean: 502 } }
    const materializer = new JobHistoryMaterializer(repository, async (_press, fromUtc, toUtc) => {
      requests.push({ fromUtc, toUtc })
      return Date.parse(toUtc) <= Date.parse(start) + 7 * day ? [closed, partial] : [complete, tail]
    }, () => new Date('2026-02-01T00:00:00.000Z'))
    const first = await materializer.backfillPress({ pressKey: 'press5', fromUtc: start, toUtc: at(10 * day), resume: false })
    assert.equal(first.chunksCompleted, 2); assert.equal(requests[1]?.fromUtc, at(6 * day - 300_000))
    const stored = await repository.listRuns({}); assert.deepEqual(stored.map((item) => item.run.runId), ['closed', 'boundary'])
    const boundary = await repository.getRun('boundary'); assert.equal(boundary?.run.goodSeconds, 2 * day / 1_000); assert.equal(boundary?.run.runningPerformance?.speed?.median, 500); assert.equal(boundary?.isClosed, true)
    assert.equal(first.watermarkUtc, at(8 * day)); assert.equal((await repository.getCheckpoint('press5'))?.sourceToUtc, at(8 * day))
    await materializer.backfillPress({ pressKey: 'press5', fromUtc: start, toUtc: at(10 * day), resume: false })
    assert.equal((await repository.listRuns({})).length, 2)
  })

  it('preserves missing identity dimensions instead of synthesizing values', async () => {
    const repository = new InMemoryJobHistoryRepository(); await repository.upsertRuns([materializedRun(run('missing-material', 0, day), start, at(day))])
    const stored = await repository.getRun('missing-material')
    assert.equal(stored?.run.identities.material, undefined); assert.equal(stored?.run.identities.recipe, 'R1')
  })
})
