import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { loadJobMaterializerRadiusConfig, loadServerConfig } from '../config.js'
import { RADIUS_PRESS_KEYS, type RadiusPressKey } from '../radius/models.js'
import { TelemetryApiClient } from '../telemetry/telemetry-api-client.js'
import { TelemetryFoundationService } from '../telemetry/telemetry-foundation-service.js'
import type { ProductionRun } from './contracts.js'
import { JobHistoryMaterializer } from './history-materializer.js'
import { createJobHistoryRepository, materializedRun, type MaterializedProductionRun } from './history-repository.js'
import { acquireMaterializationPreflight } from './materialization-preflight.js'
import { createMaterializationRadiusService } from './materialization-runtime.js'
import { JobIntelligenceService } from './service.js'

const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/
const option = (name: string) => process.argv.slice(2).find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3)
const timestamp = (name: string) => { const value = option(name); if (!value || !UTC.test(value) || !Number.isFinite(Date.parse(value))) throw new Error(`missing_or_invalid_${name}`); return new Date(value).toISOString() }
const fromUtc = timestamp('from'); const toUtc = timestamp('to'); const press = option('press')
const maintenanceMode = process.argv.slice(2).includes('--maintenance-mode')
if (Date.parse(toUtc) <= Date.parse(fromUtc)) throw new Error('invalid_job_history_range')
if (!press || !RADIUS_PRESS_KEYS.includes(press as RadiusPressKey)) throw new Error('invalid_press')
const pressKey = press as RadiusPressKey

function parityView(run: ProductionRun) {
  return {
    identity: { pressKey: run.pressKey, startUtc: run.startUtc, endUtc: run.endUtc, identities: run.identities, previousIdentities: run.previousIdentities },
    state: { goodSeconds: run.goodSeconds, makeReadySeconds: run.makeReadySeconds, badSeconds: run.badSeconds, unavailableSeconds: run.unavailableSeconds ?? Math.max(0, run.durationSeconds - run.goodSeconds - run.makeReadySeconds - run.badSeconds - run.otherRadiusSeconds) },
    transition: { identityTransition: run.identityTransition, transitionSeconds: run.transitionToStableProductionSeconds, transitionMakeReadySeconds: run.transitionMakeReadySeconds, transitionBadSeconds: run.transitionBadSeconds, transitionValid: run.transitionValid, dataInterrupted: run.dataInterrupted },
    running: run.runningPerformance ? { interruptions: run.runningPerformance.interruptions, restartCount: run.runningPerformance.restartCount, medianUninterruptedGoodSeconds: run.runningPerformance.medianUninterruptedGoodSeconds, speed: run.runningPerformance.speed } : null,
    decks: run.deckConfiguration,
    losses: run.radiusLossAggregates ?? [],
  }
}

function assertParity(liveRuns: ProductionRun[], stored: MaterializedProductionRun[]) {
  const closedLive = liveRuns.filter((run) => Date.parse(run.endUtc) < Date.parse(toUtc)).map((run) => materializedRun(run, fromUtc, toUtc, { isClosed: true }))
  const storedById = new Map(stored.map((item) => [item.run.runId, item]))
  const results = closedLive.map((expected) => {
    const actual = storedById.get(expected.run.runId)
    const categories = actual ? Object.fromEntries(Object.entries(parityView(expected.run)).map(([name, value]) => [name, isDeepStrictEqual(value, parityView(actual.run)[name as keyof ReturnType<typeof parityView>])])) : {}
    const fingerprint = actual?.sourceFingerprint === expected.sourceFingerprint
    return { runId: expected.run.runId, present: Boolean(actual), fingerprint, categories }
  })
  if (closedLive.length !== stored.length || results.some((result) => !result.present || !result.fingerprint || Object.values(result.categories).some((value) => !value))) throw new Error(`job_history_parity_failed:${JSON.stringify(results)}`)
  return results
}

const preflight = await acquireMaterializationPreflight({ maintenanceMode })
let radiusOwner: Awaited<ReturnType<typeof createMaterializationRadiusService>> | undefined
let history: ReturnType<typeof createJobHistoryRepository> | undefined
try {
  const config = loadServerConfig()
  const materializerRadius = loadJobMaterializerRadiusConfig(config.radius)
  if (!config.classificationDatabase.enabled) throw new Error('job_history_application_database_not_configured')
  history = createJobHistoryRepository(config.classificationDatabase)
  await history.initialize()
  const initial = await history.listRuns({ fromUtc, toUtc, pressKeys: [pressKey] })
  let telemetryRequestCount = 0
  radiusOwner = await createMaterializationRadiusService(materializerRadius, config.plantTimeZone)
  const telemetry = new TelemetryFoundationService(new TelemetryApiClient(config.telemetryApi, (...args) => { telemetryRequestCount += 1; return fetch(...args) }))
  const jobs = new JobIntelligenceService(radiusOwner.service, telemetry, history)
  let capturedLive: ProductionRun[] = []
  const materializer = new JobHistoryMaterializer(history, async (selectedPress, chunkFromUtc, chunkToUtc, requestId, signal) => {
    const runs = (await jobs.buildPressRuns(selectedPress, chunkFromUtc, chunkToUtc, requestId, signal, true, true)).runs
    capturedLive.push(...runs)
    return runs
  })

  async function execute(resume: boolean) {
    capturedLive = []
    const before = jobs.radiusAcquisitionDiagnostics().global
    const telemetryBefore = telemetryRequestCount
    const statementsBefore = history!.diagnostics().statementCount
    const began = Date.now()
    const result = await materializer.backfillPress({ pressKey, fromUtc, toUtc, requestId: `job-history-validation-${randomUUID()}`, resume })
    const elapsedMs = Date.now() - began
    const after = jobs.radiusAcquisitionDiagnostics().global
    return { result, elapsedMs, radiusAcquisitions: after.totalAcquisitions - before.totalAcquisitions, peakRadiusConcurrency: after.peakActive, telemetryRequestCount: telemetryRequestCount - telemetryBefore, sqlStatementCount: history!.diagnostics().statementCount - statementsBefore, liveRuns: capturedLive }
  }

  const first = await execute(false)
  const firstStored = await history.listRuns({ fromUtc, toUtc, pressKeys: [pressKey] })
  const firstParity = assertParity(first.liveRuns, firstStored)
  const firstLossRows = firstStored.reduce((sum, item) => sum + (item.run.radiusLossAggregates?.length ?? 0), 0)
  const firstCheckpoint = await history.getCheckpoint(pressKey)
  const second = await execute(false)
  const secondStored = await history.listRuns({ fromUtc, toUtc, pressKeys: [pressKey] })
  const secondParity = assertParity(second.liveRuns, secondStored)
  const secondLossRows = secondStored.reduce((sum, item) => sum + (item.run.radiusLossAggregates?.length ?? 0), 0)
  const checkpoint = await history.getCheckpoint(pressKey)
  const idempotent = firstStored.length === secondStored.length && firstLossRows === secondLossRows && isDeepStrictEqual(firstStored, secondStored) && firstCheckpoint?.watermarkUtc === checkpoint?.watermarkUtc && checkpoint?.state === 'complete'
  if (!idempotent) throw new Error('job_history_idempotency_failed')

  console.log(JSON.stringify({
    event: 'job_history_representative_validation_complete', pressKey, fromUtc, toUtc,
    initialRunRows: initial.length,
    first: { elapsedMs: first.elapsedMs, radiusAcquisitions: first.radiusAcquisitions, peakRadiusConcurrency: first.peakRadiusConcurrency, telemetryRequestCount: first.telemetryRequestCount, sqlStatementCount: first.sqlStatementCount, result: first.result, runRows: firstStored.length, lossRows: firstLossRows, parity: firstParity },
    second: { elapsedMs: second.elapsedMs, radiusAcquisitions: second.radiusAcquisitions, peakRadiusConcurrency: second.peakRadiusConcurrency, telemetryRequestCount: second.telemetryRequestCount, sqlStatementCount: second.sqlStatementCount, result: second.result, runRows: secondStored.length, lossRows: secondLossRows, parity: secondParity },
    idempotent,
    checkpoint,
    globalRadiusDiagnostics: jobs.radiusAcquisitionDiagnostics().global,
    physicalRadiusConnectionCap: radiusOwner.maximumConnections,
    sourceSafety: radiusOwner.sourceSafety,
  }))
} finally {
  await radiusOwner?.close()
  await history?.close()
  await preflight.release()
}
