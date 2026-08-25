import { randomUUID } from 'node:crypto'
import { loadJobMaterializerRadiusConfig, loadServerConfig } from '../config.js'
import { RADIUS_PRESS_KEYS, type RadiusPressKey } from '../radius/models.js'
import { TelemetryApiClient } from '../telemetry/telemetry-api-client.js'
import { TelemetryFoundationService } from '../telemetry/telemetry-foundation-service.js'
import { JobHistoryMaterializer } from './history-materializer.js'
import { createJobHistoryRepository } from './history-repository.js'
import { acquireMaterializationPreflight } from './materialization-preflight.js'
import { createMaterializationRadiusService } from './materialization-runtime.js'
import { JobIntelligenceService } from './service.js'

const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/

function option(name: string): string | undefined {
  const prefix = `--${name}=`
  return process.argv.slice(2).find((item) => item.startsWith(prefix))?.slice(prefix.length)
}

function timestamp(name: string): string {
  const value = option(name)
  if (!value || !UTC.test(value) || !Number.isFinite(Date.parse(value))) throw new Error(`missing_or_invalid_${name}`)
  return new Date(value).toISOString()
}

const fromUtc = timestamp('from')
const toUtc = timestamp('to')
if (Date.parse(toUtc) <= Date.parse(fromUtc)) throw new Error('invalid_job_history_range')
const selectedPress = option('press')
if (selectedPress && !RADIUS_PRESS_KEYS.includes(selectedPress as RadiusPressKey)) throw new Error('invalid_press')
const pressKeys = selectedPress ? [selectedPress as RadiusPressKey] : [...RADIUS_PRESS_KEYS]
const resume = !process.argv.slice(2).includes('--no-resume')
const maintenanceMode = process.argv.slice(2).includes('--maintenance-mode')

const controller = new AbortController()
process.once('SIGINT', () => controller.abort())
process.once('SIGTERM', () => controller.abort())

const preflight = await acquireMaterializationPreflight({ maintenanceMode })
let radiusOwner: Awaited<ReturnType<typeof createMaterializationRadiusService>> | undefined
let history: ReturnType<typeof createJobHistoryRepository> | undefined
try {
  const config = loadServerConfig()
  const materializerRadius = loadJobMaterializerRadiusConfig(config.radius)
  history = createJobHistoryRepository(config.classificationDatabase)
  await history.initialize()
  radiusOwner = await createMaterializationRadiusService(materializerRadius, config.plantTimeZone)
  let telemetryRequestCount = 0
  const telemetry = new TelemetryFoundationService(new TelemetryApiClient(config.telemetryApi, (...args) => { telemetryRequestCount += 1; return fetch(...args) }))
  const jobs = new JobIntelligenceService(radiusOwner.service, telemetry, history)
  const materializer = new JobHistoryMaterializer(history, async (pressKey, chunkFromUtc, chunkToUtc, requestId, signal) => (await jobs.buildPressRuns(pressKey, chunkFromUtc, chunkToUtc, requestId, signal, true, true, undefined, undefined, true)).runs)

  const began = Date.now(); const initialStatements = history.diagnostics().statementCount; const results = []
  for (const pressKey of pressKeys) {
    if (controller.signal.aborted) throw new Error('job_history_cancelled')
    const result = await materializer.backfillPress({ pressKey, fromUtc, toUtc, requestId: `job-history-${randomUUID()}`, signal: controller.signal, resume })
    results.push(result)
    console.log(JSON.stringify({ event: 'job_history_press_complete', ...result }))
  }
  console.log(JSON.stringify({ event: 'job_history_backfill_complete', fromUtc, toUtc, pressCount: results.length, elapsedMs: Date.now() - began, chunksCompleted: results.reduce((sum, item) => sum + item.chunksCompleted, 0), runsWritten: results.reduce((sum, item) => sum + item.runsWritten, 0), telemetryRequestCount, sqlStatementCount: history.diagnostics().statementCount - initialStatements, sourceSafety: radiusOwner.sourceSafety, physicalRadiusConnectionCap: radiusOwner.maximumConnections }))
  console.log(JSON.stringify({ event: 'job_history_radius_acquisition_diagnostics', ...jobs.radiusAcquisitionDiagnostics().global, physicalRadiusConnectionCap: radiusOwner.maximumConnections }))
} finally {
  await radiusOwner?.close()
  await history?.close()
  await preflight.release()
}
