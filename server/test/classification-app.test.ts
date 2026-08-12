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
  it('serves static published taxonomy endpoints without querying Radius', async () => {
    let observedCalls = 0
    const unavailableObserved = {
      getObservedIdentities: async () => { observedCalls += 1; throw new Error('statement timeout') },
    } as unknown as RadiusService
    const classificationService = new ClassificationService(new InMemoryClassificationRepository())
    const app = createApp({ telemetryClient, radiusService: unavailableObserved, classificationService, logger: false })
    await withServer(app, async (baseUrl) => {
      for (const [path, expectedCount] of [
        ['/api/classification/groups', 8],
        ['/api/classification/process-families', 16],
        ['/api/classification/classifications', 99],
        ['/api/classification/versions', 0],
      ] as const) {
        const response = await fetch(`${baseUrl}${path}`)
        assert.equal(response.status, 200)
        assert.equal((await response.json() as unknown[]).length, expectedCount)
      }
      assert.equal(observedCalls, 0)
    })
  })

  it('returns published workspace data with explicit unavailable enrichment after a Radius timeout', async () => {
    const unavailableObserved = {
      getObservedIdentities: async () => { throw new Error('canceling statement due to statement timeout') },
    } as unknown as RadiusService
    const classificationService = new ClassificationService(new InMemoryClassificationRepository())
    const app = createApp({ telemetryClient, radiusService: unavailableObserved, classificationService, logger: false })
    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/classification/workspace`)
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('x-observed-identity-status'), 'unavailable')
      const workspace = await response.json() as { observedIdentityStatus: string; effectiveGroups: unknown[]; effectiveClassifications: unknown[] }
      assert.equal(workspace.observedIdentityStatus, 'unavailable')
      assert.equal(workspace.effectiveGroups.length, 8)
      assert.equal(workspace.effectiveClassifications.length, 99)
    })
  })

  it('reuses the observed identity cache and exposes fresh then cached coverage', async () => {
    let observedCalls = 0
    const cachedRadius = {
      getObservedIdentities: async () => { observedCalls += 1; return radiusService.getObservedIdentities!() },
    } as unknown as RadiusService
    const classificationService = new ClassificationService(new InMemoryClassificationRepository())
    const app = createApp({ telemetryClient, radiusService: cachedRadius, classificationService, logger: false })
    await withServer(app, async (baseUrl) => {
      const first = await fetch(`${baseUrl}/api/classification/workspace`)
      const second = await fetch(`${baseUrl}/api/classification/workspace`)
      assert.equal((await first.json() as { observedIdentityStatus: string }).observedIdentityStatus, 'fresh')
      assert.equal((await second.json() as { observedIdentityStatus: string }).observedIdentityStatus, 'cached')
      assert.equal(observedCalls, 1)
    })
  })

  it('searches published taxonomy without waiting for optional Radius enrichment', async () => {
    const unavailableObserved = {
      getObservedIdentities: async () => { throw new Error('statement timeout') },
    } as unknown as RadiusService
    const classificationService = new ClassificationService(new InMemoryClassificationRepository())
    const app = createApp({ telemetryClient, radiusService: unavailableObserved, classificationService, logger: false })
    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/classification/search?q=Make%20Ready&limit=5`)
      assert.equal(response.status, 200)
      const result = await response.json() as { publishedVersion: number; observedIdentityStatus: string; results: Array<{ title: string }> }
      assert.equal(result.publishedVersion, 1)
      assert.equal(result.observedIdentityStatus, 'unavailable')
      assert.equal(result.results.some(({ title }) => title === 'Make Ready'), true)
      assert.equal((await fetch(`${baseUrl}/api/classification/search?q=%20%20`)).status, 400)
      assert.equal((await fetch(`${baseUrl}/api/classification/search?q=make&limit=999`)).status, 400)
    })
  })

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
