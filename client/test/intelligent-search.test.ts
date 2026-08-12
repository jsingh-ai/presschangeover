import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import React, { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { getClassificationFamilies, getClassificationGroups, getClassificationIdentities, searchClassifications } from '../src/api/process-intelligence-api'
import { IntelligentSearchIndex, IntelligentSearchPage, IntelligentSearchResults } from '../src/components/IntelligentSearchPage'
import type { ClassificationSearchResponse, ClassificationSearchResult, ClassificationWorkspace, OperationalGroup, ProcessFamily } from '../src/types/api'

Object.assign(globalThis, { React })

function result(overrides: Partial<ClassificationSearchResult>): ClassificationSearchResult {
  return {
    id: 'exact:M\u001f16\u001fMake Ready', type: 'exact_status', title: 'Make Ready', score: 1_100, matchReason: 'Exact status match', description: 'Published mapping',
    groups: [{ key: 'CHANGEOVER_SETUP', displayName: 'Changeover & Setup' }], family: { key: 'MAKE_READY', displayName: 'Make Ready' },
    eventType: 'M', statusCode: '16', statusDescription: 'Make Ready', needsClassification: false, publishedClassification: true,
    ...overrides,
  }
}

function response(results: ClassificationSearchResult[], observedIdentityStatus: ClassificationSearchResponse['observedIdentityStatus'] = 'cached'): ClassificationSearchResponse {
  return { query: 'make ready', publishedVersion: 1, observedIdentityStatus, observedIdentityAsOf: '2026-08-11T12:00:00.000Z', results }
}

describe('Intelligent Search presentation', () => {
  it('explains the page purpose, offers examples, and exposes an optional press focus', () => {
    const html = renderToStaticMarkup(createElement(IntelligentSearchPage))
    assert.match(html, /Intelligent Search/)
    assert.match(html, /role="search"/)
    assert.match(html, /What work, Radius wording, or code are you looking for/)
    assert.match(html, /Try Make Ready, Cleaning, Register, or 150/)
    assert.match(html, /What are you trying to find/)
    assert.match(html, /Browse the search index/)
    assert.match(html, /every exact identity currently observed in the Radius data/)
    assert.match(html, /Types of Work/)
    assert.match(html, /Specific Work/)
    assert.match(html, /Radius Codes/)
    assert.match(html, /Quick search examples/)
    assert.match(html, /Type of work/)
    assert.match(html, /Specific work/)
    assert.match(html, /Radius wording or code/)
    assert.match(html, /Browse repeated patterns/)
    assert.match(html, /Optional press focus/)
    assert.match(html, /All Presses/)
    assert.match(html, /Press 3/)
    assert.match(html, /Press 15/)
    assert.doesNotMatch(html, /Deterministic retrieval/)
  })

  it('uses the encoded query API and returns typed search results', async () => {
    const originalFetch = globalThis.fetch
    let requested = ''
    globalThis.fetch = (async (input) => {
      requested = String(input)
      return new Response(JSON.stringify(response([result({})])), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch
    try {
      const body = await searchClassifications('Plates: Wash', 10)
      assert.match(requested, /q=Plates%3A\+Wash/)
      assert.match(requested, /limit=10/)
      assert.equal(body.results[0].type, 'exact_status')
    } finally { globalThis.fetch = originalFetch }
  })

  it('loads the three read-only index sources independently', async () => {
    const originalFetch = globalThis.fetch
    const requested: string[] = []
    globalThis.fetch = (async (input) => {
      const url = String(input)
      requested.push(url)
      const body = url.endsWith('/groups') ? [] : url.endsWith('/process-families') ? [] : []
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch
    try {
      await Promise.all([getClassificationGroups(), getClassificationFamilies(), getClassificationIdentities()])
      assert.deepEqual(requested.sort(), ['/api/classification/groups', '/api/classification/identities', '/api/classification/process-families'])
    } finally { globalThis.fetch = originalFetch }
  })

  it('renders every available index kind as understandable selectable entries', () => {
    const groups: OperationalGroup[] = [{ id: 'group-changeover', key: 'CHANGEOVER_SETUP', displayName: 'Changeover & Setup', description: 'Job setup work.', lightColor: '#123456', darkColor: '#abcdef', icon: 'changeover', sortOrder: 20 }]
    const families: ProcessFamily[] = [{ id: 'family-wash', key: 'CLEANING_WASH', displayName: 'Cleaning / Wash', description: 'Cleaning work.', sortOrder: 30 }]
    const identities: ClassificationWorkspace['observedIdentities'] = [{ identity: 'M\u001f16\u001fMake Ready', eventType: 'M', statusCode: '16', statusDescription: 'Make Ready', eventCount: 42, lastSeenUtc: '2026-08-12T12:00:00.000Z' }, { identity: 'H\u001f\u001f', eventType: 'H', statusCode: null, statusDescription: '', eventCount: 5, lastSeenUtc: '2026-08-12T12:00:00.000Z' }]
    const initialData = { groups, families, identities }
    const groupHtml = renderToStaticMarkup(createElement(IntelligentSearchIndex, { initialData, initialKind: 'groups', onPick() {} }))
    const familyHtml = renderToStaticMarkup(createElement(IntelligentSearchIndex, { initialData, initialKind: 'families', onPick() {} }))
    const identityHtml = renderToStaticMarkup(createElement(IntelligentSearchIndex, { initialData, initialKind: 'identities', onPick() {} }))
    assert.match(groupHtml, /Changeover &amp; Setup/)
    assert.match(groupHtml, /1 available/)
    assert.match(familyHtml, /Cleaning \/ Wash/)
    assert.match(identityHtml, /Make Ready/)
    assert.match(identityHtml, /M \/ 16 · observed 42 times/)
    assert.match(identityHtml, /1 available/)
    assert.doesNotMatch(identityHtml, /H \/ No code/)
  })

  it('renders exact-status hierarchy and preserved Radius identity metadata', () => {
    const html = renderToStaticMarkup(createElement(IntelligentSearchResults, { response: response([result({})]) }))
    assert.match(html, /Exact Radius status/)
    assert.match(html, /Changeover &amp; Setup/)
    assert.match(html, /Radius recorded/)
    assert.match(html, /M \/ 16 \/ Make Ready/)
    assert.match(html, /Classified as Group/)
    assert.match(html, /Analyze this activity/)
    assert.match(html, /Start a pattern with this step/)
    assert.match(html, /See how it is classified/)
    assert.match(html, /\/operational-analysis\?activityLevel=exact_status&amp;activityKey=M%1F16%1FMake\+Ready/)
    assert.match(html, /\/patterns-episodes\?patternTab=builder&amp;patternMode=in_order/)
    assert.match(html, /\/administration\/state-classification\?identity=M%1F16%1FMake\+Ready/)
    assert.match(html, /Published v1/)
    assert.match(html, /tabindex="0"/)
  })

  it('carries a selected press into analysis and pattern destinations without hiding shared matches', () => {
    const html = renderToStaticMarkup(createElement(IntelligentSearchResults, { response: response([result({})]), pressKey: 'press10' }))
    assert.match(html, /Press 10/)
    assert.match(html, /Actions will open with this press selected/)
    assert.match(html, /Analyze on Press 10/)
    assert.match(html, /\/operational-analysis\?press=press10&amp;activityLevel=exact_status/)
    assert.match(html, /\/patterns-episodes\?press=press10&amp;patternTab=builder/)
    assert.match(html, /does not hide shared classification matches/)
  })

  it('renders family and group relationships without fabricating a single parent', () => {
    const family = result({ id: 'family:MAKE_READY', type: 'family', title: 'Make Ready', eventType: null, statusCode: null, statusDescription: null, family: { key: 'MAKE_READY', displayName: 'Make Ready' } })
    const group = result({ id: 'group:PRODUCTION', type: 'group', title: 'Production', eventType: null, statusCode: null, statusDescription: null, family: null, groups: [{ key: 'PRODUCTION', displayName: 'Production' }] })
    const html = renderToStaticMarkup(createElement(IntelligentSearchResults, { response: response([family, group]) }))
    assert.match(html, /Process Family/)
    assert.match(html, /Used across groups/)
    assert.match(html, /Operational Group/)
    assert.match(html, /Stable key/)
  })

  it('marks unknown observed identities as Needs classification with no inferred hierarchy', () => {
    const unknown = result({ id: 'observed:Z', title: 'Unreviewed operator value', groups: [], family: null, eventType: 'Z', statusCode: 'NEW', statusDescription: 'Unreviewed operator value', needsClassification: true, publishedClassification: false })
    const html = renderToStaticMarkup(createElement(IntelligentSearchResults, { response: response([unknown], 'fresh') }))
    assert.match(html, /Needs Classification/)
    assert.match(html, /Z \/ NEW \/ Unreviewed operator value/)
    assert.match(html, /Open exact identity in Classification Admin/)
    assert.doesNotMatch(html, /<dt>Classified as Group<\/dt>/)
    assert.doesNotMatch(html, /<dt>Process Family<\/dt>/)
  })

  it('renders loading, error, unavailable-enrichment, and no-result states', () => {
    assert.match(renderToStaticMarkup(createElement(IntelligentSearchResults, { loading: true })), /Searching the operating language/)
    assert.match(renderToStaticMarkup(createElement(IntelligentSearchResults, { error: 'Try again' })), /role="alert"/)
    const empty = renderToStaticMarkup(createElement(IntelligentSearchResults, { response: response([], 'unavailable') }))
    assert.match(empty, /No classification matches/)
    assert.match(empty, /Live observed-identity enrichment is temporarily unavailable/)
  })

  it('uses responsive and theme-aware styling', async () => {
    const css = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8')
    assert.match(css, /\.intelligent-search-page/)
    assert.match(css, /@media \(max-width: 860px\)/)
    assert.match(css, /var\(--surface\)/)
    assert.match(css, /:root\[data-theme="dark"\]/)
  })
})
