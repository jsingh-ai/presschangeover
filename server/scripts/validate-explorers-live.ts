import { resolve } from 'node:path'
import { loadServerConfig } from '../src/config.js'
import { localProcessIntelligenceBaseUrl, ProcessIntelligenceExplorerHttpClient, validateRawRadiusOverHttp, validateTelemetryEventsOverHttp } from './explorer-http-validation.js'
import { writeValidationCheckpoint } from './validation-checkpoint.js'

const argument = (name: string) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined }
const endUtc = argument('--end') ?? new Date().toISOString()
const startUtc = argument('--start') ?? new Date(Date.parse(endUtc) - 24 * 60 * 60_000).toISOString()
const artifactPath = resolve(argument('--artifact') ?? 'staging/processintelligence-explorer-validation.json')
let activePhase = 'startup'

const artifact: {
  validation: string
  status: 'RUNNING' | 'READY_TO_DEPLOY' | 'NOT_READY'
  generatedAtUtc: string
  updatedAtUtc: string
  range: { startUtc: string; endUtc: string }
  completedPhases: string[]
  safety: Record<string, unknown>
  radiusConnectivity: unknown
  rawRadius: unknown
  telemetryEvent: unknown
  readiness: unknown
  failure: unknown
} = {
  validation: 'processintelligence-explorer-phase-a-read-only-production-validation',
  status: 'RUNNING',
  generatedAtUtc: new Date().toISOString(),
  updatedAtUtc: new Date().toISOString(),
  range: { startUtc, endUtc },
  completedPhases: [],
  safety: {
    databaseWrites: 0,
    schemaChanges: 0,
    rawUnmappedAutomaticScans: 0,
    serviceRestartsBeforeReadiness: 0,
    productionValidationInvocations: 1,
    maximumConnectionRetries: 1,
    connectionRetriesUsed: 0,
    analyticalRetries: 0,
    maximumDatabaseConnections: 0,
    directRadiusDatabaseConnections: 0,
    validationTransport: 'processintelligence_http',
  },
  radiusConnectivity: null,
  rawRadius: null,
  telemetryEvent: null,
  readiness: null,
  failure: null,
}

async function checkpoint(phase?: string) {
  if (phase && !artifact.completedPhases.includes(phase)) artifact.completedPhases.push(phase)
  artifact.updatedAtUtc = new Date().toISOString()
  await writeValidationCheckpoint(artifactPath, artifact)
}

function classifyFailure(error: unknown) {
  const message = error instanceof Error ? error.message : ''
  if (/timeout exceeded when trying to connect|connection.*timeout/i.test(message)) return 'readonly_radius_connection_timeout'
  return /^[a-z0-9_:.-]+$/i.test(message) ? message.slice(0, 160) : 'explorer_validation_phase_failed'
}

async function httpCompatibility(api: ProcessIntelligenceExplorerHttpClient) {
  const began = Date.now()
  try {
    await api.assertCompatibleServer()
    return { status: 'healthy' as const, reason: null, durationMs: Date.now() - began }
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    const reason = message === 'processintelligence_http_validation_contract_unavailable'
      ? message
      : 'processintelligence_http_unavailable'
    return { status: 'unavailable' as const, reason, durationMs: Date.now() - began }
  }
}

async function run() {
  await checkpoint()
  if (Date.parse(endUtc) - Date.parse(startUtc) <= 0 || Date.parse(endUtc) - Date.parse(startUtc) > 24 * 60 * 60_000) throw new Error('validation_range_must_be_at_most_24_hours')

  const config = loadServerConfig()
  if (!config.radius.enabled || config.radius.user !== 'processintelligence_readonly') throw new Error('readonly_radius_configuration_required')
  const api = new ProcessIntelligenceExplorerHttpClient(localProcessIntelligenceBaseUrl(config.host, config.port))
  artifact.safety = { ...artifact.safety, radiusRole: config.radius.user, processIntelligenceBaseUrl: localProcessIntelligenceBaseUrl(config.host, config.port).origin }

  activePhase = 'processintelligence_http_connectivity'
  const attempts = [await httpCompatibility(api)]
  if (attempts[0]!.status !== 'healthy' && attempts[0]!.reason === 'processintelligence_http_unavailable') {
    artifact.safety.connectionRetriesUsed = 1
    attempts.push(await httpCompatibility(api))
  }
  if (attempts.at(-1)!.status !== 'healthy') {
    artifact.radiusConnectivity = { status: 'unavailable', transport: 'processintelligence_http', attempts, retryUsed: attempts.length - 1, directPostgresConnections: 0 }
    await checkpoint('processintelligence_http_connectivity')
    throw new Error(attempts.at(-1)!.reason ?? 'processintelligence_http_unavailable')
  }

  activePhase = 'radius_connectivity'
  const radiusBegan = Date.now()
  const radiusHealth = await api.radiusHealth()
  const radiusDurationMs = Date.now() - radiusBegan
  artifact.radiusConnectivity = {
    status: radiusHealth.status,
    transport: 'processintelligence_http',
    processIntelligenceAttempts: attempts,
    durationMs: radiusDurationMs,
    retryUsed: attempts.length - 1,
    directPostgresConnections: 0,
  }
  await checkpoint('radius_connectivity')
  if (radiusHealth.status !== 'healthy') throw new Error('readonly_radius_connectivity_failed')

  activePhase = 'raw_radius_representative_validation'
  const rawRadius = await validateRawRadiusOverHttp({ api, startUtc, endUtc, maximumRepresentatives: 1 })
  artifact.rawRadius = rawRadius
  await checkpoint('raw_radius_representative_validation')
  if (rawRadius.diagnostics.rawUnmappedCalls.total !== 0) throw new Error('raw_unmapped_automatic_scan_detected')
  if (rawRadius.status !== 'PASS') throw new Error('raw_radius_history_validation_failed')

  activePhase = 'telemetry_event_representative_validation'
  const telemetryEvent = await validateTelemetryEventsOverHttp({ api, startUtc, endUtc })
  artifact.telemetryEvent = telemetryEvent
  await checkpoint('telemetry_event_representative_validation')
  if (telemetryEvent.diagnostics.rawUnmappedCalls.total !== 0) throw new Error('raw_unmapped_automatic_scan_detected')

  activePhase = 'final_readiness'
  const gates = {
    radiusConnectivityPassed: radiusHealth.status === 'healthy',
    validationUsesHttpOnly: rawRadius.diagnostics.directPostgresConnections === 0 && telemetryEvent.diagnostics.directPostgresConnections === 0,
    rawRadiusPassed: rawRadius.status === 'PASS',
    telemetryEventPassed: telemetryEvent.status === 'PASS',
    exactRadiusIdentityPreserved: rawRadius.gates.exactStatusCodePreserved,
    conservativePhysicalSemantics: rawRadius.gates.conservativePhysicalSemantics,
    suggestionsBoundedCanonical: rawRadius.gates.suggestionsBoundedCanonical && telemetryEvent.gates.suggestionsBoundedCanonical,
    explorerPayloadsBounded: rawRadius.representatives.every((item) => item.payloadBytes.evidence < 65_536 && item.payloadBytes.history < 65_536)
      && [telemetryEvent.delta, telemetryEvent.valueChange].filter(Boolean).every((item) => item!.payloadBytes.evidence < 65_536 && item!.payloadBytes.history < 65_536),
    noQueryExplosion: rawRadius.gates.boundedHttpRequests && telemetryEvent.gates.boundedHttpRequests,
    noRawUnmappedAutomaticScans: rawRadius.diagnostics.rawUnmappedCalls.total === 0 && telemetryEvent.diagnostics.rawUnmappedCalls.total === 0,
    noWritesOrSchemaChanges: artifact.safety.databaseWrites === 0 && artifact.safety.schemaChanges === 0,
  }
  artifact.safety = { ...artifact.safety, rawUnmappedAutomaticScans: telemetryEvent.diagnostics.rawUnmappedCalls.total }
  artifact.readiness = { gates }
  artifact.status = Object.values(gates).every(Boolean) ? 'READY_TO_DEPLOY' : 'NOT_READY'
  if (artifact.status === 'NOT_READY') artifact.failure = { phase: activePhase, code: 'explorer_release_gate_failed', failedGates: Object.entries(gates).filter(([, passed]) => !passed).map(([name]) => name) }
  await checkpoint('final_readiness')

  console.log(`Explorer validation artifact: ${artifactPath}`)
  console.log(`Radius connectivity through ProcessIntelligence HTTP: ${radiusHealth.status} in ${radiusDurationMs} ms; HTTP retry used: ${attempts.length - 1}`)
  console.log(`Raw Radius: ${rawRadius.status}, ${rawRadius.runtimeMs} ms, ${rawRadius.representatives.length} representatives`)
  console.log(`Telemetry Event: ${telemetryEvent.status}, ${telemetryEvent.runtimeMs} ms, Delta: ${Boolean(telemetryEvent.delta)}, Value Change: ${Boolean(telemetryEvent.valueChange)}`)
  if (artifact.status !== 'READY_TO_DEPLOY') throw new Error('explorer_release_gate_failed')
}

await run().catch(async (error: unknown) => {
  artifact.status = 'NOT_READY'
  if (!artifact.failure) artifact.failure = { phase: activePhase, code: classifyFailure(error) }
  try { await checkpoint() } catch { /* Preserve the original validation failure. */ }
  console.error(`Explorer validation stopped in ${activePhase}: ${classifyFailure(error)}`)
  process.exitCode = 1
})
