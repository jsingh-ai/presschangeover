import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { it } from 'node:test'
import pg from 'pg'
import type { ProductionRun } from '../src/job-intelligence/contracts.js'
import { JOB_INTELLIGENCE_ALGORITHM_VERSION, materializedRun } from '../src/job-intelligence/history-repository.js'
import { createDisposableJobValidationRepository, JOB_VALIDATION_DATABASE_MARKER, loadDisposableJobValidationDatabaseConfig } from '../src/job-intelligence/validation-database.js'

const enabled = process.env.JOB_POSTGRES_CONTRACT === '1'

it('round-trips the independent Job semantic contract through real migrations and PostgreSQL', { skip: !enabled }, async () => {
  const config = loadDisposableJobValidationDatabaseConfig(process.env, { enabled: false })
  const adminUser = process.env.JOB_VALIDATION_DB_ADMIN_USER?.trim(); const adminPassword = process.env.JOB_VALIDATION_DB_ADMIN_PASSWORD?.trim()
  if (!adminUser || !adminPassword) throw new Error('job_postgres_contract_admin_credentials_required')
  const admin = new pg.Pool({ ...config, user: adminUser, password: adminPassword, max: 1, application_name: 'ProcessIntelligenceJobContractMigration' })
  let repository: Awaited<ReturnType<typeof createDisposableJobValidationRepository>> | undefined
  try {
    const marker = await admin.query("SELECT obj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=current_database()")
    if (marker.rows[0]?.marker !== JOB_VALIDATION_DATABASE_MARKER) throw new Error('job_postgres_contract_disposable_marker_mismatch')
    const existing = await admin.query("SELECT to_regclass('public.job_intelligence_runs') AS runs,to_regclass('public.job_intelligence_run_losses') AS losses,to_regclass('public.job_intelligence_materialization_state') AS state")
    if (existing.rows[0]?.runs || existing.rows[0]?.losses || existing.rows[0]?.state) throw new Error('job_postgres_contract_requires_fresh_disposable_database')
    for (const migration of ['002_job_intelligence_minimal_derived.sql', '003_job_intelligence_checkpoint_safety.sql', '004_job_intelligence_natural_run_contract.sql']) {
      const source = await readFile(new URL(`../migrations/${migration}`, import.meta.url), 'utf8')
      await admin.query(source.split(/\r?\n/).filter((line) => !line.startsWith('\\')).join('\n'))
    }
    repository = await createDisposableJobValidationRepository(config); await repository.initialize()

    const domain: ProductionRun = {
      runId: 'press5.job.3839909e9f7ef05f', previousRunId: 'press5.job.contractoracle0000', pressKey: 'press5', startUtc: '2026-01-01T00:00:00.123Z', endUtc: '2026-01-01T01:00:00.123Z', durationSeconds: 3_600, boundaryCompleteness: 'natural', persistenceEligible: true,
      identities: { order: 'CURRENT-ORDER', recipe: 'CURRENT-RECIPE', customer: '', material: 'CURRENT-MATERIAL' }, previousIdentities: { order: 'ADJACENT-ORDER', recipe: 'ADJACENT-RECIPE' }, nextIdentities: null, boundaryFields: ['order', 'recipe'], contextSettlingSeconds: 301,
      identityTransition: { identityChangeFirstSeenAtUtc: '2026-01-01T00:00:00.123Z', identityLastChangeAtUtc: '2026-01-01T00:00:01.124Z', identitySettledAtUtc: '2026-01-01T00:05:01.124Z', settleState: 'confirmed', previousResolvedIdentity: { order: 'METADATA-ORDER', recipe: 'METADATA-RECIPE', customer: '' }, finalResolvedIdentity: { order: 'CURRENT-ORDER', recipe: 'CURRENT-RECIPE', customer: '', material: 'CURRENT-MATERIAL' }, inferredBoundary: true },
      identityAvailability: { order: 'available', recipe: 'available', customer: 'available', material: 'available' }, dataInterrupted: false, coveragePercent: 99.5, identityConfidence: 'high', goodSeconds: 3_000, makeReadySeconds: 300, badSeconds: 120, otherRadiusSeconds: 60, unavailableSeconds: 120, productionStateEfficiency: 87.7, productionInterruptionCount: 2, interruptionsPerProductionHour: 2.4,
      transitionToStableProductionSeconds: 600, transitionMakeReadySeconds: 300, transitionBadSeconds: 120, transitionValid: true, transitionMetric: 'radius_stable_production_proxy', transitionTiming: { outgoingStableRadiusProductionEndUtc: null, incomingStableRadiusProductionStartUtc: '2026-01-01T00:10:00.123Z', radiusStableProductionProxySeconds: 600, metadataFirstSeenToStableSeconds: 600, metadataSettledToStableSeconds: 299, telemetryPhysicalProductionAtUtc: null, timingUncertaintySeconds: 301 }, radiusEpisodes: [],
      radiusLossAggregates: [{ eventType: 'M', statusCode: null, statusDescription: 'Exact setup', category: 'make_ready', totalSeconds: 300, occurrenceCount: 2, medianEpisodeSeconds: 150 }, { eventType: 'B', statusCode: '0', statusDescription: 'Exact defect', category: 'bad', totalSeconds: 120, occurrenceCount: 1, medianEpisodeSeconds: 120 }],
      deckConfiguration: { activeDecks: [3, 1, 3], reusedDecks: [3, 1], addedDecks: [4], removedDecks: [2], changedDeckCount: 2, evidenceCanonicalId: 'deck.active' },
      runningPerformance: { stableProductionStartUtc: '2026-01-01T00:10:00.123Z', observedSeconds: 2_720, goodSeconds: 2_600, badSeconds: 120, interruptions: 2, interruptionsPerProductionHour: 2.8, medianUninterruptedGoodSeconds: 900, restartCount: 2, speed: { canonicalId: 'machine.speed.actual', sourceUnit: '', canonicalUnitStatus: 'unverified', sampleCount: 4, median: 500, p25: -0, p75: 520, p90: 540, timeWeightedMean: 501 } },
    }
    const encoded = materializedRun(domain, '2025-12-31T23:00:00.000Z', '2026-01-01T02:00:00.000Z', { calculatedAtUtc: '2026-02-01T00:00:00.000Z', isClosed: true })
    await repository.upsertRuns([encoded]); const rows = await repository.listRuns({ pressKeys: ['press5'] })
    assert.equal(rows.length, 1); const actual = rows[0]!
    // Independent contract oracle: these literals are not produced by the repository decoder or canonicalizer.
    assert.deepEqual({ runId: actual.run.runId, startUtc: actual.run.startUtc, endUtc: actual.run.endUtc, durationSeconds: actual.run.durationSeconds, identities: actual.run.identities, previousIdentities: actual.run.previousIdentities, transitionPrevious: actual.run.identityTransition.previousResolvedIdentity, activeDecks: actual.run.deckConfiguration?.activeDecks, speedP25: actual.run.runningPerformance?.speed?.p25, speedP75: actual.run.runningPerformance?.speed?.p75, losses: actual.run.radiusLossAggregates }, {
      runId: 'press5.job.3839909e9f7ef05f', startUtc: '2026-01-01T00:00:00.123Z', endUtc: '2026-01-01T01:00:00.123Z', durationSeconds: 3_600, identities: { order: 'CURRENT-ORDER', recipe: 'CURRENT-RECIPE', customer: '', material: 'CURRENT-MATERIAL' }, previousIdentities: { order: 'ADJACENT-ORDER', recipe: 'ADJACENT-RECIPE' }, transitionPrevious: { order: 'METADATA-ORDER', recipe: 'METADATA-RECIPE', customer: '' }, activeDecks: [1, 3], speedP25: 0, speedP75: 520, losses: [{ eventType: 'B', statusCode: '0', statusDescription: 'Exact defect', category: 'bad', totalSeconds: 120, occurrenceCount: 1, medianEpisodeSeconds: 120 }, { eventType: 'M', statusCode: null, statusDescription: 'Exact setup', category: 'make_ready', totalSeconds: 300, occurrenceCount: 2, medianEpisodeSeconds: 150 }],
    })
    assert.equal(actual.algorithmVersion, JOB_INTELLIGENCE_ALGORITHM_VERSION); assert.equal(actual.isClosed, true); assert.equal(actual.sourceFingerprint, encoded.sourceFingerprint)
    const variability = await admin.query('SELECT speed_variability FROM public.job_intelligence_runs WHERE algorithm_version=$1 AND run_id=$2', [JOB_INTELLIGENCE_ALGORITHM_VERSION, domain.runId])
    assert.equal(Number(variability.rows[0]?.speed_variability), 520)
  } finally {
    await repository?.close(); await admin.end()
  }
})
