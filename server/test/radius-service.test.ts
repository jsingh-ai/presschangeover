import assert from 'node:assert/strict'
import test from 'node:test'
import type { EnabledRadiusConfig } from '../src/config.js'
import type { RadiusRepository } from '../src/radius/radius-repository.js'
import { DatabaseRadiusService } from '../src/radius/radius-service.js'
import type { RadiusObservation } from '../src/radius/models.js'

const config: EnabledRadiusConfig = {
  enabled: true,
  host: '127.0.0.1',
  port: 5432,
  database: 'press_radius_db',
  user: 'processintelligence_readonly',
  password: 'test-only-password',
  schema: 'public',
  table: 'machine_status_history',
  currentTable: 'machine_status_current',
  eventsTable: 'machine_status_events',
  pollRunsTable: 'machine_status_poll_runs',
  timestampMode: 'timestamptz',
  effectiveCutoverUtc: '2026-08-10T14:29:00.415Z',
  expectedMachineCount: 12,
  productionEventType: 'G',
  productionStatusDescription: 'Run Production',
  staleSeconds: 180,
  mappings: [{ pressKey: 'press13', displayName: 'Press 13', machineId: 213 }],
}

test('a past press range derives its end state from history and never leaks machine_status_current', async () => {
  const firstMs = Date.parse('2026-08-08T05:00:00.000Z')
  const observations: RadiusObservation[] = Array.from({ length: 62 }, (_, index) => ({
    machineId: 213,
    eventType: 'M',
    statusCode: 'MR',
    statusDescription: 'Historical Make Ready',
    fetchedAtUtc: new Date(firstMs + index * 60_000).toISOString(),
    sourceGeneration: 'legacy',
  }))
  const repository = {
    assessAccess: async () => ({
      databaseMatches: true,
      schemaMatches: true,
      canConnect: true,
      canUseSchema: true,
      canSelect: true,
      hasWritePrivilege: false,
      hasCreatePrivilege: false,
      elevatedRole: false,
    }),
    getObservations: async () => observations,
    getPollRuns: async () => [],
    getCurrentStates: async () => [{
      machineId: 213,
      eventType: 'G',
      statusCode: 'RUN',
      statusDescription: 'Run Production',
      fetchedAtUtc: '2026-08-11T04:00:00.000Z',
      sourceGeneration: 'current' as const,
      isPresent: true,
    }],
  } as unknown as RadiusRepository
  const service = new DatabaseRadiusService(
    repository,
    config,
    'America/Chicago',
    () => new Date('2026-08-11T04:10:00.000Z'),
  )

  const result = await service.getPressEpisodes(
    'press13',
    '2026-08-08T05:00:00.000Z',
    '2026-08-08T06:00:00.000Z',
  )

  assert.equal(result.rangeEndIsLive, false)
  assert.equal(result.currentStatusDescription, 'Historical Make Ready')
  assert.equal(result.currentEventType, 'M')
  assert.notEqual(result.currentStatusAtUtc, '2026-08-11T04:00:00.000Z')
  assert.equal(result.timelineSegments[0].sourceGeneration, 'legacy')
})
