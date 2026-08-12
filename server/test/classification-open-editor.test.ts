import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createClassificationAuthorizer } from '../src/classification/create-classification-service.js'

test('classification editing has no user authorization gate when the writable application store is configured', () => {
  const request = {} as Parameters<ReturnType<typeof createClassificationAuthorizer>>[0]
  assert.deepEqual(createClassificationAuthorizer(true)(request), { id: 'application-user', canEdit: true })
  assert.deepEqual(createClassificationAuthorizer(false)(request), { id: 'read-only-memory', canEdit: false })
})
