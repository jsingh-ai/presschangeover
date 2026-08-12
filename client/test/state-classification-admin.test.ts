import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import React, { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ClassificationStateCard, ClassificationWorkflow } from '../src/components/StateClassificationPage'
import { updateClassifications } from '../src/api/process-intelligence-api'
import type { ClassificationWorkspace, OperationalGroup } from '../src/types/api'

Object.assign(globalThis, { React })

const groups: OperationalGroup[] = [
  { id: 'production', key: 'PRODUCTION', displayName: 'Production', description: 'Production activity', lightColor: '#18864b', darkColor: '#39c978', icon: 'production', sortOrder: 10 },
  { id: 'routine', key: 'ROUTINE_PROCESS', displayName: 'Routine Process', description: 'Routine process activity', lightColor: '#0f827b', darkColor: '#35c7bd', icon: 'process', sortOrder: 20 },
]

const state = {
  identity: 'B\u001f99\u001fPlates: Wash', eventType: 'B', statusCode: '99', statusDescription: 'Plates: Wash',
  operationalGroupId: 'routine', operationalGroupKey: 'ROUTINE_PROCESS', processFamilyId: 'wash', processFamilyKey: 'CLEANING_WASH',
  displayLabel: null, explanation: 'Published mapping', confidence: 'HIGH', needsReview: false, defaultTimelineVisibility: true, obsolete: false,
  eventCount: 42, lastSeenUtc: '2026-08-11T12:00:00.000Z', isFallback: false,
} as ClassificationWorkspace['effectiveClassifications'][number]

function workspace(canEdit = true): ClassificationWorkspace {
  return {
    published: { version: 4, publishedAtUtc: '2026-08-11T10:00:00.000Z', publishedBy: 'application-user', groups, families: [], classifications: [] },
    draft: { baseVersion: 4, revision: 3, updatedAtUtc: '2026-08-11T11:00:00.000Z', updatedBy: 'application-user', groups, families: [], classifications: [], changes: [{ action: 'STATE_MOVED', target: state.identity, summary: 'Moved state.', atUtc: '2026-08-11T11:00:00.000Z', actor: 'application-user' }] },
    effectiveGroups: groups, effectiveClassifications: [state], observedIdentities: [], families: [], versions: [], audit: [],
    unmappedCount: 0, reviewRequiredCount: 0, canEdit, actor: 'application-user', persistence: 'postgresql', observedIdentityStatus: 'fresh', observedIdentityAsOf: null,
  }
}

describe('State Classification administration workflow', () => {
  it('shows the active published version and requires current validation before publication', () => {
    const pending = renderToStaticMarkup(createElement(ClassificationWorkflow, {
      workspace: workspace(), busy: false, onStartDraft() {}, onDiscard() {}, onValidate() {}, onPublish() {},
    }))
    assert.match(pending, /Published v4 is live/)
    assert.match(pending, /Draft revision 3/)
    assert.match(pending, /Publish v5/)
    assert.match(pending, /Publish v5<\/button>/)
    assert.match(pending, /disabled=""[^>]*>Publish v5/)

    const ready = renderToStaticMarkup(createElement(ClassificationWorkflow, {
      workspace: workspace(), busy: false, validatedRevision: 3,
      validation: { valid: true, errors: [], warnings: [], mappedCount: 99, fallbackCount: 0, reviewRequiredCount: 0 },
      onStartDraft() {}, onDiscard() {}, onValidate() {}, onPublish() {},
    }))
    assert.match(ready, /Current draft validated/)
    assert.doesNotMatch(ready, /disabled=""[^>]*>Publish v5/)
  })

  it('enables the category dropdown whenever the application store is writable', () => {
    const editable = renderToStaticMarkup(createElement(ClassificationStateCard, {
      item: state, groups, canEdit: true, busy: false, selected: false,
      onToggle() {}, onInspect() {}, onMove() {},
    }))
    const locked = renderToStaticMarkup(createElement(ClassificationStateCard, {
      item: state, groups, canEdit: false, busy: false, selected: false,
      onToggle() {}, onInspect() {}, onMove() {},
    }))
    assert.match(editable, /Move to category/)
    assert.doesNotMatch(editable, /select[^>]+disabled/)
    assert.match(locked, /select[^>]+disabled/)
    assert.match(locked, /Writable application store required/)
  })

  it('sends an immediate draft move with the current revision and destination category', async () => {
    const previousFetch = globalThis.fetch
    let request: { url: string; method?: string; body?: string } | undefined
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      request = { url: String(input), method: init?.method, body: String(init?.body) }
      return new Response(JSON.stringify(workspace().draft), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch
    try {
      await updateClassifications(3, [{ eventType: 'B', statusCode: '99', statusDescription: 'Plates: Wash' }], { operationalGroupKey: 'PRODUCTION', needsReview: false })
      assert.equal(request?.url, '/api/classification/draft/classifications')
      assert.equal(request?.method, 'PATCH')
      assert.deepEqual(JSON.parse(request!.body!), {
        identities: [{ eventType: 'B', statusCode: '99', statusDescription: 'Plates: Wash' }],
        expectedRevision: 3,
        operationalGroupKey: 'PRODUCTION',
        needsReview: false,
      })
    } finally {
      globalThis.fetch = previousFetch
    }
  })
})
