import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { MACHINE_INTELLIGENCE_MAX_RANGE_MS, MACHINE_INTELLIGENCE_PRESS_KEYS, machineIntelligenceChunks, mergeMachineIntelligenceReports, recipeFamily } from '../src/machine-intelligence'
import { areaFromPathname, areaPath } from '../src/navigation'
import type { PressDowntimePressReport } from '../src/types/press-downtime'

const page = readFileSync(new URL('../src/components/MachineIntelligencePage.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')

describe('Machine Intelligence client foundation', () => {
  it('replaces Job Intelligence while retaining its legacy route', () => {
    assert.equal(areaFromPathname('/machine-intelligence'), 'machine-intelligence')
    assert.equal(areaFromPathname('/job-intelligence'), 'machine-intelligence')
    assert.equal(areaPath('machine-intelligence'), '/machine-intelligence')
    assert.equal(MACHINE_INTELLIGENCE_PRESS_KEYS.length, 12)
  })

  it('supports bounded long-range progressive reads and explicit recipe families', () => {
    assert.equal(MACHINE_INTELLIGENCE_MAX_RANGE_MS, 31 * 24 * 60 * 60_000)
    assert.equal(machineIntelligenceChunks('2026-08-01T00:00:00.000Z', '2026-08-15T00:00:00.000Z').length, 5)
    assert.equal(recipeFamily('1600-GAP01-E459'), '1600-GAP01')
    assert.equal(recipeFamily('1600-GAP01'), '1600-GAP01')
  })

  it('keeps one occurrence when the same identity crosses bounded read windows', () => {
    const report = (fromUtc: string, toUtc: string, recipe: string, category: 'CHANGEOVER' | 'GOOD_RUN'): PressDowntimePressReport => {
      const durationSeconds = (Date.parse(toUtc) - Date.parse(fromUtc)) / 1000
      const totals = { CHANGEOVER: category === 'CHANGEOVER' ? durationSeconds : 0, GOOD_RUN: category === 'GOOD_RUN' ? durationSeconds : 0, DOWNTIME: 0, MISSING_DATA: 0 }
      const segment = { segmentId: fromUtc, occurrenceId: fromUtc, category, startUtc: fromUtc, endUtc: toUtc, durationSeconds, source: 'PREDICTION' as const, underlyingState: category, stopId: null }
      const occurrence = { occurrenceId: fromUtc, occurrenceNumber: 1, startUtc: fromUtc, endUtc: toUtc, durationSeconds, order: 'O1', recipe, identityComplete: true, boundaryFields: [] as Array<'order' | 'recipe'>, totals, segments: [segment], rollSummary: { total: 0, good: 0, changeover: 0, goodLength: 0, changeoverLength: 0 }, rolls: [] }
      return { version: 'press-downtime-v1.3.0', generatedAtUtc: toUtc, fromUtc, toUtc, pressKey: 'press15', displayName: 'Press 15', availability: 'AVAILABLE', reason: null, totals, classificationTimeline: [segment], speedTrend: { unit: 'ft/min', observations: [] }, identityTimeline: [{ segmentId: fromUtc, startUtc: fromUtc, endUtc: toUtc, durationSeconds, order: 'O1', recipe, missingFields: [] }], radiusTimeline: [{ segmentId: fromUtc, category: 'G', startUtc: fromUtc, endUtc: toUtc, durationSeconds, eventType: 'G', statusCode: '150', statusDescription: 'Run Production' }], radiusTotals: { G: durationSeconds, B: 0, M: 0, MISSING_DATA: 0 }, rollSummary: occurrence.rollSummary, jobGroups: [{ groupId: fromUtc, order: 'O1', recipe, identityComplete: true, occurrenceCount: 1, firstStartUtc: fromUtc, lastEndUtc: toUtc, totals, rollSummary: occurrence.rollSummary, rolls: [], occurrences: [occurrence] }], correctionPersistence: 'memory', policy: { identityBoundary: 'ANY_OBSERVED_ORDER_OR_RECIPE_CHANGE', temporaryIdentityGaps: 'MISSING_TIME_WITHOUT_NEW_OCCURRENCE', repeatedIdentity: 'GROUPED_OCCURRENCES', operatorReview: 'LATEST_REVIEW_OVERRIDES_PREDICTION', routineAndUncertain: 'DOWNTIME', badOrUnavailableEvidence: 'MISSING_DATA' } }
    }
    const merged = mergeMachineIntelligenceReports([report('2026-08-01T00:00:00.000Z', '2026-08-04T00:00:00.000Z', '1600-GAP01-E459', 'CHANGEOVER'), report('2026-08-04T00:00:00.000Z', '2026-08-05T00:00:00.000Z', '1600-GAP01-E459', 'GOOD_RUN')])
    assert.equal(merged.jobGroups.length, 1)
    assert.equal(merged.jobGroups[0]?.occurrences.length, 1)
    assert.equal(merged.jobGroups[0]?.totals.CHANGEOVER, 72 * 3_600)
    assert.equal(merged.jobGroups[0]?.totals.GOOD_RUN, 24 * 3_600)
  })

  it('keeps fleet comparisons visual and places detail in nested expansions', () => {
    for (const label of ['Process Intelligence time', 'Radius time', 'Process Intelligence and Radius by press', 'Good and changeover rolls by press', 'Day-by-day comparison', 'Job occurrences and recipe history', 'Time segments', 'Roll evidence']) assert.match(page, new RegExp(label))
    assert.match(page, /Telemetry \+ operator review/)
    assert.match(page, /Radius remains visible/)
    assert.match(page, /<details className="mi-recipe"/)
    assert.match(page, /<details className="mi-occurrence"/)
    assert.doesNotMatch(page, /biggest opportunity|preferred press/i)
    for (const selector of ['.mi-overview-pair', '.mi-chart-row', '.mi-press-header', '.mi-recipe', '.mi-occurrence']) assert.match(styles, new RegExp(selector.replace('.', '\\.')))
  })
})
