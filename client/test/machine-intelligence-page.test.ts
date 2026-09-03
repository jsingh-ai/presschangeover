import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { MACHINE_INTELLIGENCE_MAX_RANGE_MS, MACHINE_INTELLIGENCE_PRESS_KEYS, machineOpportunitySeconds } from '../src/machine-intelligence'
import { areaFromPathname, areaPath } from '../src/navigation'

const page = readFileSync(new URL('../src/components/MachineIntelligencePage.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')

describe('Machine Intelligence overview', () => {
  it('retains the route, supported presses, and 31-day range', () => {
    assert.equal(areaFromPathname('/machine-intelligence'), 'machine-intelligence')
    assert.equal(areaFromPathname('/job-intelligence'), 'machine-intelligence')
    assert.equal(areaPath('machine-intelligence'), '/machine-intelligence')
    assert.equal(MACHINE_INTELLIGENCE_PRESS_KEYS.length, 12)
    assert.equal(MACHINE_INTELLIGENCE_MAX_RANGE_MS, 31 * 24 * 60 * 60_000)
    assert.match(page, /presetRange\('last24'\)/)
  })

  it('calculates comparable non-good time from the overview contract', () => {
    assert.equal(machineOpportunitySeconds({ pressKey: 'press3', displayName: 'Press 3', availability: 'AVAILABLE', reason: null, totals: { CHANGEOVER: 20, DOWNTIME: 30, GOOD_RUN: 40, MISSING_DATA: 10 }, radiusTotals: { G: 0, M: 0, B: 0, MISSING_DATA: 0 }, rollSummary: { total: 0, good: 0, changeover: 0, goodLength: 0, changeoverLength: 0 } }), 50)
  })

  it('keeps the four fleet comparisons and removes all press drill-down UI', () => {
    for (const label of ['Process Intelligence time', 'Radius time', 'Process Intelligence and Radius by press', 'Good and changeover rolls by press']) assert.match(page, new RegExp(label))
    assert.match(page, /getMachineIntelligenceOverview/)
    for (const removed of ['PressDetails', 'Occurrence', 'DailyEvidence', 'recipeFamily', 'machineIntelligenceChunks', 'mi-press-header', 'mi-load-status']) assert.doesNotMatch(page, new RegExp(removed))
    for (const removedStyle of ['.mi-press-header', '.mi-recipe', '.mi-occurrence']) assert.doesNotMatch(styles, new RegExp(removedStyle.replace('.', '\\.')))
  })
})
