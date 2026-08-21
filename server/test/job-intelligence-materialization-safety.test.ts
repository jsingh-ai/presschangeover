import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { JOB_INTELLIGENCE_MATERIALIZER_RADIUS_ROLE, loadJobMaterializerRadiusConfig, type EnabledRadiusConfig } from '../src/config.js'
import { acquireMaterializationPreflight, knownMaterializationConsumers, knownProductionWebConsumers } from '../src/job-intelligence/materialization-preflight.js'
import { createMaterializationRadiusService, JOB_INTELLIGENCE_MATERIALIZATION_RADIUS_CONNECTION_CAP } from '../src/job-intelligence/materialization-runtime.js'
import { InMemoryJobHistoryRepository } from '../src/job-intelligence/history-repository.js'
import { JobIntelligenceRadiusAcquisitionLimiter } from '../src/job-intelligence/radius-acquisition-limiter.js'
import { JobIntelligenceService } from '../src/job-intelligence/service.js'
import { createRadiusQueryExecutor, RADIUS_SERVICE_DEFAULT_MAX_CONNECTIONS } from '../src/radius/create-radius-service.js'

const radiusConfig: EnabledRadiusConfig = {
  enabled: true, host: '127.0.0.1', port: 5432, database: 'press_radius_db', user: 'processintelligence_readonly', password: 'not-used', schema: 'public', table: 'machine_status_history', currentTable: 'machine_status_current', eventsTable: 'machine_status_events', pollRunsTable: 'machine_status_poll_runs', timestampMode: 'timestamptz', effectiveCutoverUtc: '2026-08-10T14:29:00.415Z', expectedMachineCount: 12, productionEventType: 'G', productionStatusDescription: 'Run Production', staleSeconds: 180, mappings: [{ pressKey: 'press5', machineId: 205, displayName: 'Press 5' }],
}

const privileges = ['machine_status_current', 'machine_status_events', 'machine_status_history', 'machine_status_poll_runs'].map((tableName) => ({ role: 'processintelligence_readonly', tableName, select: true, insert: false, update: false, delete: false, truncate: false }))
function safePool(overrides: { privilegeRows?: typeof privileges; readOnly?: string } = {}) {
  let ended = 0
  return { pool: { query: async (sql: string) => sql.startsWith('SHOW') ? { rows: [{ default_transaction_read_only: overrides.readOnly ?? 'on' }] } : { rows: overrides.privilegeRows ?? privileges }, end: async () => { ended += 1 } }, ended: () => ended }
}

describe('Job Intelligence maintenance materialization safety', () => {
  it('reuses only the existing production read-only Radius role and never requires dedicated credentials', () => {
    assert.equal(JOB_INTELLIGENCE_MATERIALIZER_RADIUS_ROLE, 'processintelligence_readonly')
    assert.deepEqual(loadJobMaterializerRadiusConfig(radiusConfig), radiusConfig)
    assert.throws(() => loadJobMaterializerRadiusConfig({ ...radiusConfig, user: 'unexpected' }), /existing_production_readonly_role/)
  })

  it('detects duplicate materializers, validation consumers, and a lingering production web process', () => {
    const processes = [
      { pid: 10, name: 'node.exe', commandLine: 'node scripts/job-intelligence-validation-host.mjs' },
      { pid: 11, name: 'node.exe', commandLine: 'node dist/job-intelligence/backfill.js' },
      { pid: 12, name: 'msedge.exe', commandLine: '--headless --user-data-dir=C:\\ProcessIntelligence\\staging\\profile' },
      { pid: 13, name: 'node.exe', commandLine: 'node C:\\ProcessIntelligence\\app\\server\\dist\\index.js' },
    ]
    assert.deepEqual(knownMaterializationConsumers(processes, 99).map(({ pid }) => pid), [10, 11, 12])
    assert.deepEqual(knownProductionWebConsumers(processes, 99).map(({ pid }) => pid), [13])
  })

  it('fails closed without explicit maintenance mode or while the Windows service is running', async () => {
    await assert.rejects(() => acquireMaterializationPreflight({ maintenanceMode: false, serviceState: async () => 'Stopped', listProcesses: async () => [] }), /explicit_maintenance_mode_required/)
    await assert.rejects(() => acquireMaterializationPreflight({ maintenanceMode: true, serviceState: async () => 'Running', listProcesses: async () => [] }), /service_must_be_stopped:Running/)
  })

  it('releases its exclusive lock after a process-gate failure and admits one stopped-service owner', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ji-maintenance-preflight-')); const lockPath = join(directory, 'gate.lock')
    try {
      await assert.rejects(() => acquireMaterializationPreflight({ maintenanceMode: true, serviceState: async () => 'Stopped', lockPath, ownPid: 99, listProcesses: async () => [{ pid: 10, name: 'node.exe', commandLine: 'node representative-validation.js' }] }), /consumers_active:10/)
      const acquired = await acquireMaterializationPreflight({ maintenanceMode: true, serviceState: async () => 'Stopped', lockPath, ownPid: 99, listProcesses: async () => [] })
      assert.equal(acquired.serviceState, 'Stopped'); await acquired.release()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('sets every physical source session read-only, verifies exact privileges, caps at one, and closes once', async () => {
    let configuredMax: number | undefined; let configuredUser: string | undefined; let applicationName: string | undefined; let startupOptions: string | undefined
    const mock = safePool()
    const owner = await createMaterializationRadiusService(radiusConfig, 'America/Chicago', { poolFactory: (config) => { configuredMax = config.max; configuredUser = config.user; applicationName = config.application_name; startupOptions = config.options; return mock.pool } })
    assert.equal(RADIUS_SERVICE_DEFAULT_MAX_CONNECTIONS, 5); assert.equal(JOB_INTELLIGENCE_MATERIALIZATION_RADIUS_CONNECTION_CAP, 1); assert.equal(owner.maximumConnections, 1); assert.equal(configuredMax, 1); assert.equal(configuredUser, 'processintelligence_readonly'); assert.equal(applicationName, 'ProcessIntelligenceJobMaterializer'); assert.equal(startupOptions, '-c default_transaction_read_only=on')
    assert.equal(owner.sourceSafety.defaultTransactionReadOnly, 'on'); assert.equal(owner.sourceSafety.privileges.length, 4)
    await owner.close(); await owner.close(); assert.equal(mock.ended(), 1)
  })

  it('closes the source pool and refuses acquisition if read-only state or a source privilege is unsafe', async () => {
    const writable = safePool({ privilegeRows: privileges.map((item, index) => index ? item : { ...item, update: true }) })
    await assert.rejects(() => createMaterializationRadiusService(radiusConfig, 'America/Chicago', { poolFactory: () => writable.pool }), /source_privilege_violation/)
    assert.equal(writable.ended(), 1)
    const readWrite = safePool({ readOnly: 'off' })
    await assert.rejects(() => createMaterializationRadiusService(radiusConfig, 'America/Chicago', { poolFactory: () => readWrite.pool }), /session_not_read_only/)
    assert.equal(readWrite.ended(), 1)
  })

  it('serializes internally fanned-out SQL and continues after an error without starvation', async () => {
    let active = 0; let peak = 0; const order: number[] = []
    const executor = createRadiusQueryExecutor(async (text) => { const index = Number(text); active += 1; peak = Math.max(peak, active); order.push(index); try { await new Promise((resolve) => setTimeout(resolve, 2)); if (index === 3) throw new Error('bounded query failed'); return { rows: [] } } finally { active -= 1 } }, true)
    const results = await Promise.allSettled(Array.from({ length: 9 }, (_value, index) => executor.query(String(index))))
    assert.equal(peak, 1); assert.equal(active, 0); assert.deepEqual(order, [0, 1, 2, 3, 4, 5, 6, 7, 8]); assert.equal(results[3]?.status, 'rejected'); assert.equal(results[8]?.status, 'fulfilled')
  })

  it('drains an active bounded Radius acquisition before returning telemetry cancellation', async () => {
    let releaseRadius!: () => void; let settled = false
    const radius = { getRawTimeline: async () => new Promise<{ pressKey: 'press5'; displayName: string; fromUtc: string; toUtc: string; segments: [] }>((resolve) => { releaseRadius = () => resolve({ pressKey: 'press5', displayName: 'Press 5', fromUtc: '2026-01-01T00:00:00.000Z', toUtc: '2026-01-01T01:00:00.000Z', segments: [] }) }) }
    const controller = new AbortController(); const telemetry = { context: async () => { controller.abort(); throw new Error('telemetry cancelled') } }
    const limiter = new JobIntelligenceRadiusAcquisitionLimiter(1); const service = new JobIntelligenceService(radius as never, telemetry as never, new InMemoryJobHistoryRepository(), Date.now, limiter)
    const capabilities = { pressKey: 'press5', sourceId: 205, sourceKey: 'press5', displayName: 'Press 5', metadataStatus: 'available', capabilities: [] }
    const pending = service.buildPressRuns('press5', '2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z', 'cancel-test', controller.signal, false, false, capabilities as never).then(() => null, (error: Error) => error).finally(() => { settled = true })
    await new Promise((resolve) => setTimeout(resolve, 5)); assert.equal(settled, false); assert.equal(limiter.diagnostics().active, 1)
    releaseRadius(); const error = await pending
    assert.equal(error?.message, 'telemetry cancelled'); assert.equal(limiter.diagnostics().active, 0); assert.equal(limiter.diagnostics().queued, 0)
  })
})
