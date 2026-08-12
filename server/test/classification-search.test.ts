import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { InMemoryClassificationRepository } from '../src/classification/classification-repository.js'
import { ClassificationService, ClassificationValidationError } from '../src/classification/classification-service.js'
import type { ObservedIdentitySnapshot } from '../src/classification/observed-identity-cache.js'
import { exactRadiusIdentity } from '../src/radius/radius-identity.js'

const unavailable: ObservedIdentitySnapshot = { identities: [], status: 'unavailable', asOfUtc: null }

function service() {
  return new ClassificationService(new InMemoryClassificationRepository())
}

describe('deterministic published classification search', () => {
  it('ranks exact group, family, and status names from the published document', async () => {
    const search = service()
    assert.equal((await search.search('Routine Process', 10, unavailable)).results[0].type, 'group')
    assert.equal((await search.search('Make Ready', 10, unavailable)).results[0].type, 'exact_status')
    assert.equal((await search.search('Make Ready', 20, unavailable)).results.some(({ type, title }) => type === 'family' && title === 'Make Ready'), true)
    const production = (await search.search('Run Production', 10, unavailable)).results[0]
    assert.equal(production.title, 'Run Production')
    assert.equal(production.matchReason, 'Exact status match')
  })

  it('normalizes case, whitespace, punctuation, prefixes, multiple tokens, and repeated terms', async () => {
    const search = service()
    assert.equal((await search.search('  RUN    PRODUCTION ', 10, unavailable)).results[0].title, 'Run Production')
    assert.equal((await search.search('plates wash', 10, unavailable)).results[0].statusDescription, 'Plates: Wash')
    assert.equal((await search.search('press prob', 10, unavailable)).results[0].statusDescription, 'Press Problem / Impression')
    assert.equal((await search.search('mechanical electrical', 10, unavailable)).results.some(({ title }) => title === 'Mechanical / Electrical'), true)
    assert.equal((await search.search('make make ready', 10, unavailable)).results.length > 0, true)
  })

  it('returns no result safely, validates empty search, and enforces the supplied result limit', async () => {
    const search = service()
    assert.equal((await search.search('definitely absent taxonomy phrase', 10, unavailable)).results.length, 0)
    assert.equal((await search.search('make', 2, unavailable)).results.length, 2)
    await assert.rejects(() => search.search('---', 10, unavailable), ClassificationValidationError)
  })

  it('preserves exact Radius identity metadata and published version traceability', async () => {
    const response = await service().search('Plates Wash', 10, unavailable)
    const result = response.results.find(({ statusDescription }) => statusDescription === 'Plates: Wash')
    assert.equal(response.publishedVersion, 1)
    assert.equal(result?.eventType, 'B')
    assert.equal(result?.statusCode, '99')
    assert.equal(result?.statusDescription, 'Plates: Wash')
    assert.equal(result?.groups[0].displayName, 'Routine Process')
    assert.equal(result?.family?.displayName, 'Cleaning / Wash')
  })

  it('excludes unpublished draft edits and rebuilds automatically after publication', async () => {
    const repository = new InMemoryClassificationRepository()
    const search = new ClassificationService(repository)
    const admin = { id: 'classification.admin', canEdit: true }
    const draft = await search.createDraft(admin, 1)
    const changed = await search.editGroup(admin, 'PRODUCTION', { displayName: 'Making Product' }, draft.revision)
    assert.equal((await search.search('Making Product', 10, unavailable)).results.some(({ title }) => title === 'Making Product'), false)
    await search.publish(admin, changed.revision, [])
    const published = await search.search('Making Product', 10, unavailable)
    assert.equal(published.publishedVersion, 2)
    assert.equal(published.results[0].type, 'group')
  })

  it('returns unknown observed identities as Needs classification without inferring a group or family', async () => {
    const raw = { eventType: 'Z', statusCode: 'NEW-7', statusDescription: 'Make Ready Mystery' }
    const observed: ObservedIdentitySnapshot = {
      identities: [{ ...raw, identity: exactRadiusIdentity(raw), eventCount: 1, lastSeenUtc: '2026-08-11T18:00:00.000Z' }],
      status: 'fresh',
      asOfUtc: '2026-08-11T18:00:00.000Z',
    }
    const result = (await service().search('Make Ready Mystery', 10, observed)).results[0]
    assert.equal(result.needsClassification, true)
    assert.equal(result.publishedClassification, false)
    assert.deepEqual(result.groups, [])
    assert.equal(result.family, null)
  })

  it('keeps published search usable when observed Radius enrichment is unavailable', async () => {
    const response = await service().search('Make Ready', 10, unavailable)
    assert.equal(response.observedIdentityStatus, 'unavailable')
    assert.equal(response.results.some(({ publishedClassification }) => publishedClassification), true)
  })
})
