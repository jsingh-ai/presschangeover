import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AiInvestigatorPage } from '../src/components/AiInvestigatorPage'
import { parseTelemetryEventDeepLink } from '../src/components/TelemetryEventExplorerPage'
import { areaFromPathname, areaPath } from '../src/navigation'

const source = readFileSync(new URL('../src/components/AiInvestigatorVisualPage.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
const api = readFileSync(new URL('../src/api/process-intelligence-api.ts', import.meta.url), 'utf8')

describe('AI Investigator page', () => {
  it('keeps only press and time as the automatic discovery inputs', () => {
    assert.equal(areaFromPathname('/ai-investigator'), 'ai-investigator')
    assert.equal(areaPath('ai-investigator'), '/ai-investigator')
    const html = renderToStaticMarkup(createElement(AiInvestigatorPage))
    assert.match(html, /What was unusual/)
    assert.match(html, /Advisory and read-only/)
    assert.match(html, /All Presses/)
    assert.match(html, /Last 24 Hours/)
    assert.match(html, /Last 8 Hours/)
    assert.match(html, /Press \+ time/)
    assert.doesNotMatch(html, /Analysis<select/)
    assert.match(html, /Maximum 45 seconds/)
  })

  it('renders compact visuals with collapsed evidence and clears stale results on every input edit', () => {
    assert.match(source, /AI Investigator is not configured on this server/)
    assert.match(source, /Screening trusted canonical signals/)
    assert.match(source, /Anomaly \/ event timeline/)
    assert.match(source, /MiniSparkline/)
    assert.match(source, /ai-recurrence-chart/)
    assert.match(source, /Historical fingerprint/)
    assert.match(source, /<summary>Details<\/summary>/)
    assert.match(source, />Verify<\/a>/)
    assert.match(source, /clearStale\(\)/)
    assert.match(styles, /ai-event-timeline/)
    assert.match(styles, /ai-compact-findings/)
    assert.match(styles, /ai-fingerprint-bar/)
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

  it('restores an exact bounded canonical Verify link and requests one automatic search', () => {
    const restored = parseTelemetryEventDeepLink('?preset=custom&fromUtc=2026-08-20T10%3A00%3A00.000Z&toUtc=2026-08-20T12%3A00%3A00.000Z&canonicalId=machine.speed.actual&press=press14&eventType=delta&direction=decrease&amount=12.5&windowMinutes=10&context=30&autorun=1&occurrenceStart=2026-08-20T11%3A00%3A00.000Z')
    assert.equal(restored.canonicalId, 'machine.speed.actual'); assert.equal(restored.pressKey, 'press14'); assert.equal(restored.eventType, 'delta'); assert.equal(restored.direction, 'decrease'); assert.equal(restored.amount, '12.5'); assert.equal(restored.autorun, true)
    assert.deepEqual([restored.range?.fromUtc, restored.range?.toUtc], ['2026-08-20T10:00:00.000Z', '2026-08-20T12:00:00.000Z'])
  })
})
