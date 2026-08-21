import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { areaFromPathname, areaPath } from '../src/navigation'

const page = readFileSync(new URL('../src/components/JobIntelligencePage.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
const api = readFileSync(new URL('../src/api/process-intelligence-api.ts', import.meta.url), 'utf8')

describe('Job Intelligence client foundation', () => {
  it('is a first-class route with a read-only report call', () => {
    assert.equal(areaFromPathname('/job-intelligence'), 'job-intelligence')
    assert.equal(areaPath('job-intelligence'), '/job-intelligence')
    assert.match(api, /\/api\/job-intelligence\/report/)
    assert.doesNotMatch(api.match(/getJobIntelligenceReport[\s\S]*?\n\}/)?.[0] ?? '', /sendJson/)
  })

  it('renders concise decision, composition, affinity, transition, and exact-loss sections', () => {
    for (const label of ['Decisions', 'Raw performance', 'Comparable / adjusted performance', 'Cross-press affinity', 'Previous → current', 'Exact Radius reasons']) assert.match(page, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.match(page, /StateBar/)
    assert.match(page, /segment_equals/)
    assert.match(page, /includedValues/)
    assert.doesNotMatch(page, /\bOEE\b/)
  })

  it('defines compact graphical rows and responsive behavior', () => {
    assert.match(styles, /\.ji-decision-grid/)
    assert.match(styles, /\.ji-state-bar/)
    assert.match(styles, /\.ji-ranking-row/)
    assert.match(styles, /\.ji-transition-list/)
    assert.match(styles, /@media \(max-width: 1180px\)/)
  })
})
