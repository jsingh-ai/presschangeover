import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AiInvestigatorPage } from '../src/components/AiInvestigatorPage'
import { areaFromPathname, areaPath } from '../src/navigation'

const source = readFileSync(new URL('../src/components/AiInvestigatorPage.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
const api = readFileSync(new URL('../src/api/process-intelligence-api.ts', import.meta.url), 'utf8')

describe('AI Investigator page', () => {
  it('adds the requested route and advisory structured-analysis controls', () => {
    assert.equal(areaFromPathname('/ai-investigator'), 'ai-investigator')
    assert.equal(areaPath('ai-investigator'), '/ai-investigator')
    const html = renderToStaticMarkup(createElement(AiInvestigatorPage))
    assert.match(html, /AI Investigator/)
    assert.match(html, /Advisory and read-only/)
    assert.match(html, /All Presses/)
    assert.match(html, /Last 24 Hours/)
    assert.match(html, /Last 8 Hours/)
    assert.match(html, /Discover unusual behavior/)
    assert.match(html, /Maximum analysis time: 45 seconds/)
  })

  it('renders bounded progress, not-configured, timeout, findings, tables, metadata, and retry states', () => {
    assert.match(source, /AI Investigator is not configured on this server/)
    assert.match(source, /Preparing operational summary/)
    assert.match(source, /Comparing recent behavior/)
    assert.match(source, /Investigating candidate presses/)
    assert.match(source, /Building findings/)
    assert.match(source, /Analysis reached its \{maxSeconds\}-second time budget/)
    assert.match(source, /Ranked findings/)
    assert.match(source, /Deterministic evidence/)
    assert.match(source, /Analysis metadata/)
    assert.match(source, /Read-only data calls/)
    assert.doesNotMatch(source, /Approved tool calls/)
    assert.match(source, /Object\.entries\(finding\.productionContext\)/)
    assert.match(source, /Grounded temporal trace/)
    assert.match(source, /finding\.traceEvidence/)
    assert.match(source, /not a root-cause conclusion/)
    assert.match(styles, /ai-temporal-trace/)
    assert.doesNotMatch(source, /Job<\/dt><dd>\{finding\.productionContext\.job \|\| 'Unavailable'/)
    assert.match(source, /Retry/)
    assert.match(source, /Cancel/)
  })

  it('uses a server API with a browser deadline and renders model content only as React text', () => {
    assert.match(api, /\/api\/ai-investigator\/status/)
    assert.match(api, /\/api\/ai-investigator\/analyze/)
    assert.match(source, /status\.maximumAnalysisMs \+ 5_000/)
    assert.doesNotMatch(source, /dangerouslySetInnerHTML/)
    assert.match(styles, /ai-investigator-page/)
    assert.match(styles, /data-theme="dark".*importance-high/)
    assert.match(styles, /@media \(max-width: 680px\)/)
  })
})
