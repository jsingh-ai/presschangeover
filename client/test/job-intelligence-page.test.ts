import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { areaFromPathname, areaPath } from '../src/navigation'

const page = readFileSync(new URL('../src/components/JobIntelligencePage.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
const api = readFileSync(new URL('../src/api/process-intelligence-api.ts', import.meta.url), 'utf8')
const smoke = readFileSync(new URL('../../scripts/job-intelligence-ui-smoke.mjs', import.meta.url), 'utf8')

describe('Job Intelligence client foundation', () => {
  it('is a first-class route with read-only fleet, values, and inspector calls', () => {
    assert.equal(areaFromPathname('/job-intelligence'), 'job-intelligence')
    assert.equal(areaPath('job-intelligence'), '/job-intelligence')
    for (const route of ['/api/job-intelligence/report', '/api/job-intelligence/values', '/api/job-intelligence/runs/']) assert.match(api, new RegExp(route.replaceAll('/', '\\/')))
    assert.doesNotMatch(api.match(/getJobIntelligenceReport[\s\S]*?\n\}/)?.[0] ?? '', /sendJson/)
  })

  it('renders the compact all-press comparison, previous-job effect, aggregate losses, and light inline run detail', () => {
    for (const label of ['How this selection runs across all presses', 'Changeover vs running', 'Why presses differ', 'Does the previous job appear to matter?', 'Historical production runs', 'Inline run evidence']) assert.match(page, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.match(page, /StateBar/)
    assert.match(page, /segment_equals/)
    assert.match(page, /includedValues/)
    assert.match(page, /All available/)
    assert.match(page, /identityChangeFirstSeenAtUtc/)
    assert.match(page, /identityLastChangeAtUtc/)
    assert.match(page, /identitySettledAtUtc/)
    assert.match(page, /incomingStableRadiusProductionStartUtc/)
    assert.match(page, /telemetryPhysicalProductionAtUtc/)
    assert.doesNotMatch(page, /radiusEpisodes/)
    assert.doesNotMatch(page, /speedSamples/)
    assert.doesNotMatch(page, /href=/)
    assert.doesNotMatch(page, /\bOEE\b/)
  })

  it('defines compact tables, an inspector, and responsive behavior', () => {
    assert.match(styles, /\.ji-decision-grid/)
    assert.match(styles, /\.ji-state-bar/)
    assert.match(styles, /\.ji-inline-table/)
    assert.match(styles, /\.ji-inspector-grid/)
    assert.match(styles, /@media \(max-width: 1100px\)/)
  })

  it('does not restart identity acquisition when auto-selection rerenders the page', () => {
    const valuesEffect = page.match(/useEffect\(\(\) => \{[\s\S]*?getJobIntelligenceValues[\s\S]*?\}, \[range, analyzeBy, valueQuery\]\)/)?.[0] ?? ''
    assert.match(valuesEffect, /setAppliedGroup\(\(current\) =>/)
    assert.doesNotMatch(valuesEffect, /\[range, analyzeBy, valueQuery, appliedGroup\]/)
    assert.equal((valuesEffect.match(/getJobIntelligenceValues\(/g) ?? []).length, 1)
  })

  it('keeps browser validation opt-in, single-session, sequential, and bounded', () => {
    assert.match(smoke, /JOB_INTELLIGENCE_LIVE_VALIDATION_APPROVED/)
    assert.match(smoke, /job-intelligence-ui-smoke\.lock/)
    assert.equal((smoke.match(/new WebSocket\(/g) ?? []).length, 1)
    assert.doesNotMatch(smoke, /Promise\.all/)
    assert.match(smoke, /attempts = 240/)
  })
})
