import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import React, { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { searchClassifications } from '../src/api/process-intelligence-api'
import { IntelligentSearchPage, IntelligentSearchResults } from '../src/components/IntelligentSearchPage'
import type { ClassificationSearchResponse, ClassificationSearchResult } from '../src/types/api'

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
  it('renders the accessible search input and deterministic retrieval language', () => {
    const html = renderToStaticMarkup(createElement(IntelligentSearchPage))
    assert.match(html, /Intelligent Search/)
    assert.match(html, /role="search"/)
    assert.match(html, /Search statuses, Process Families, or Operational Groups/)
    assert.match(html, /Make Ready, Plates: Wash, press problem/)
    assert.match(html, /never changes a classification/)
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

  it('renders exact-status hierarchy and preserved Radius identity metadata', () => {
    const html = renderToStaticMarkup(createElement(IntelligentSearchResults, { response: response([result({})]) }))
    assert.match(html, /Exact Radius status/)
    assert.match(html, /Changeover &amp; Setup/)
    assert.match(html, /Radius recorded/)
    assert.match(html, /M \/ 16 \/ Make Ready/)
    assert.match(html, /Classified as Group/)
    assert.match(html, /Analyze Activity/)
    assert.match(html, /Find Runs/)
    assert.match(html, /View Mapping/)
    assert.match(html, /\/operational-analysis\?activityLevel=exact_status&amp;activityKey=M%1F16%1FMake\+Ready/)
    assert.match(html, /\/patterns-episodes\?patternTab=builder&amp;patternMode=contains_all/)
    assert.match(html, /\/administration\/state-classification\?identity=M%1F16%1FMake\+Ready/)
    assert.match(html, /Published v1/)
    assert.match(html, /tabindex="0"/)
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
    assert.match(renderToStaticMarkup(createElement(IntelligentSearchResults, { loading: true })), /Searching the published classification/)
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
