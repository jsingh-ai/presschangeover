import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { areaFromPathname, areaPath } from '../src/navigation'

const page = readFileSync(new URL('../src/components/ChangeoverIntelligencePage.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
const api = readFileSync(new URL('../src/api/process-intelligence-api.ts', import.meta.url), 'utf8')

describe('Changeover Intelligence client product', () => {
  it('is a first-class read-only route with report and bounded inspector APIs', () => {
    assert.equal(areaFromPathname('/changeover-intelligence'), 'changeover-intelligence')
    assert.equal(areaPath('changeover-intelligence'), '/changeover-intelligence')
    assert.match(api, /\/api\/changeover-intelligence\/report/)
    assert.match(api, /\/api\/changeover-intelligence\/changeovers\//)
    assert.doesNotMatch(api.match(/getChangeoverIntelligenceReport[\s\S]*?\n\}/)?.[0] ?? '', /sendJson/)
  })

  it('renders fleet, physical phases, sequences, pairs, trends, and inline aligned evidence', () => {
    for (const label of ['Fleet changeover summary', 'All-press performance board', 'Where changeover time goes', 'Minutes per changeover by press', 'Exact evidence', 'Failed recovery & sequence', 'Order-to-Order transitions', 'Daily physical changeover timeline', 'Inline evidence', 'Raw Radius', 'Adjusted physical window', 'Typical historical sequences']) assert.match(page, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    for (const timing of ['identityChangeFirstSeenAtUtc', 'identityLastChangeAtUtc', 'identitySettledAtUtc', 'physicalStartUtc', 'physicalRecoveryUtc', 'recoveryConfirmedAtUtc']) assert.match(page, new RegExp(timing))
    assert.match(page, /CUSTOM DEFINITION/)
    assert.match(page, /All stops \(context\)/)
    assert.match(page, /All available/)
    assert.match(page, /LIMITED HISTORY/)
    assert.match(page, /recoveryCohorts/)
    assert.match(page, /originalDurationSeconds/)
    assert.match(page, /failedRecoveryAttempts\.map/)
    assert.match(page, /co-daily-detail/)
    assert.doesNotMatch(page, /\bAI\b/)
  })

  it('provides a normal desktop fleet grid and aligned evidence tracks', () => {
    assert.match(styles, /\.co-fleet-grid/)
    assert.match(styles, /repeat\(4, minmax\(0, 1fr\)\)/)
    assert.match(styles, /\.co-speed-chart/)
    assert.match(styles, /\.co-segment-track/)
    assert.match(styles, /\.co-inspector-grid/)
  })
})
