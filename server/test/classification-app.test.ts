import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { describe, it } from 'node:test'
import type { Express } from 'express'
import { createApp } from '../src/app.js'
import { InMemoryClassificationRepository } from '../src/classification/classification-repository.js'
import { ClassificationService } from '../src/classification/classification-service.js'
import { exactRadiusIdentity } from '../src/radius/radius-identity.js'
import type { RadiusService } from '../src/radius/radius-service.js'
import type { TelemetryClient } from '../src/telemetry/telemetry-api-client.js'

const telemetryClient = {
  getHealth: async () => ({ service: 'TelemetryQueryApi', status: 'healthy' }),
  getDatabaseHealth: async () => ({ service: 'TelemetryQueryApi', status: 'healthy', database: 'telemetry' }),
  getSources: async () => [],
  getPhysicalState: async () => { throw new Error('not used') },
} as TelemetryClient

const raw = { eventType: 'G', statusCode: '20', statusDescription: 'Run' }
const radiusService = {
  getObservedIdentities: async () => [{ ...raw, identity: exactRadiusIdentity(raw), eventCount: 12, lastSeenUtc: '2026-08-11T12:00:00.000Z' }],
} as RadiusService

async function withServer(app: Express, action: (baseUrl: string) => Promise<void>) {
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  try { await action(`http://127.0.0.1:${(server.address() as AddressInfo).port}`) }
  finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) }
}

describe('classification administration API', () => {
  it('lists published semantics but rejects unauthorized mutation', async () => {
    const classificationService = new ClassificationService(new InMemoryClassificationRepository())
    const app = createApp({ telemetryClient, radiusService, classificationService, classificationAuthorizer: () => ({ id: 'viewer', canEdit: false }), logger: false })
    await withServer(app, async (baseUrl) => {
      const workspaceResponse = await fetch(`${baseUrl}/api/classification/workspace`)
      assert.equal(workspaceResponse.status, 200)
      const workspace = await workspaceResponse.json() as { canEdit: boolean; effectiveClassifications: Array<{ operationalGroupKey: string }> }
      assert.equal(workspace.canEdit, false)
      assert.equal(workspace.effectiveClassifications[0].operationalGroupKey, 'PRODUCTION')
      const mutation = await fetch(`${baseUrl}/api/classification/draft`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVersion: 1 }) })
      assert.equal(mutation.status, 403)
      assert.deepEqual(await mutation.json(), { error: 'classification_forbidden' })
    })
  })

  it('creates an authorized draft and enforces optimistic revision conflicts', async () => {
    const classificationService = new ClassificationService(new InMemoryClassificationRepository())
    const app = createApp({ telemetryClient, radiusService, classificationService, classificationAuthorizer: () => ({ id: 'classification.admin', canEdit: true }), logger: false })
    await withServer(app, async (baseUrl) => {
      const created = await fetch(`${baseUrl}/api/classification/draft`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVersion: 1 }) })
      assert.equal(created.status, 201)
      const update = await fetch(`${baseUrl}/api/classification/draft/groups/PRODUCTION`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: 1, displayName: 'Making Product' }) })
      assert.equal(update.status, 200)
      const conflict = await fetch(`${baseUrl}/api/classification/draft/groups/PRODUCTION`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: 1, displayName: 'Stale edit' }) })
      assert.equal(conflict.status, 409)
    })
  })
})
