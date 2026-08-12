import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import React, { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { GuidedActivityPicker, OperationalActivityExplorerView, activityGuidePath, fullRangeActivityTracks, guidedActivityOptions } from '../src/components/OperationalActivityExplorer'
import { Builder, DiscoveredPatterns } from '../src/components/PatternExplorer'
import type { ActivityAnalysis, OperationalAnalytics, PatternAnalysis } from '../src/types/api'

Object.assign(globalThis, { React })

const catalog = [
  { level: 'radius_state', key: 'B', label: 'Bad', description: 'Bad state', eventType: 'B', statusCode: null, statusDescription: null, operationalGroupKey: null, operationalGroupName: null, processFamilyKey: null, processFamilyName: null, needsClassification: false, durationSeconds: 49_200, percentageOfObservedTime: 73 },
  { level: 'operational_group', key: 'MAINTENANCE_INTERVENTION', label: 'Maintenance Intervention', description: 'Maintenance activity', eventType: null, statusCode: null, statusDescription: null, operationalGroupKey: 'MAINTENANCE_INTERVENTION', operationalGroupName: 'Maintenance Intervention', processFamilyKey: null, processFamilyName: null, needsClassification: false, durationSeconds: 16_260, percentageOfObservedTime: 24.1 },
  { level: 'operational_group', key: 'ROUTINE_PROCESS', label: 'Routine Process', description: 'Normal recurring process work', eventType: null, statusCode: null, statusDescription: null, operationalGroupKey: 'ROUTINE_PROCESS', operationalGroupName: 'Routine Process', processFamilyKey: null, processFamilyName: null, needsClassification: false, durationSeconds: 49_200, percentageOfObservedTime: 73 },
  { level: 'process_family', key: 'CLEANING_WASH', label: 'Cleaning / Wash', description: 'Cleaning family', eventType: null, statusCode: null, statusDescription: null, operationalGroupKey: 'ROUTINE_PROCESS', operationalGroupName: 'Routine Process', processFamilyKey: 'CLEANING_WASH', processFamilyName: 'Cleaning / Wash', needsClassification: false, durationSeconds: 15_300, percentageOfObservedTime: 22.7 },
  { level: 'exact_status', key: 'B\u001f99\u001fPlates: Wash', label: 'B / 99 / Plates: Wash', description: null, eventType: 'B', statusCode: '99', statusDescription: 'Plates: Wash', operationalGroupKey: 'ROUTINE_PROCESS', operationalGroupName: 'Routine Process', processFamilyKey: 'CLEANING_WASH', processFamilyName: 'Cleaning / Wash', needsClassification: false },
] as ActivityAnalysis['catalog']

const activity = {
  fromUtc: '2026-08-01T00:00:00.000Z', toUtc: '2026-08-08T00:00:00.000Z', classificationVersion: 1, selection: catalog[1], catalog,
  summary: { totalDurationSeconds: 49_200, occurrenceCount: 47, medianOccurrenceSeconds: 660, p95OccurrenceSeconds: 2_400, longestOccurrenceSeconds: 4_020, pressesObserved: 9, scopePresses: 12, shareOfObservedPercent: 2.8, sourceCoveragePercent: 91.2, classificationCoveragePercent: 99.8 },
  pressBreakdown: [{ pressKey: 'press11', displayName: 'Press 11', durationSeconds: 16_260, occurrenceCount: 12, medianOccurrenceSeconds: 720, shareOfObservedPercent: 4.2, coveragePercent: 92 }],
  radiusStateComposition: [{ eventType: 'B', label: 'Bad', durationSeconds: 35_916, percentage: 73 }, { eventType: 'M', label: 'Make Ready', durationSeconds: 13_284, percentage: 27 }],
  semanticBreakdown: [{ key: 'MAINTENANCE', label: 'Maintenance', level: 'process_family', durationSeconds: 49_200, percentage: 100 }],
  trend: [{ bucketStartUtc: '2026-08-01T00:00:00.000Z', durationSeconds: 7_200, occurrenceCount: 5 }], trendBucket: 'day',
  durationDistribution: [{ key: 'under_5m', label: '< 5m', occurrenceCount: 7 }, { key: '5_15m', label: '5–15m', occurrenceCount: 20 }, { key: '15_30m', label: '15–30m', occurrenceCount: 12 }, { key: '30_60m', label: '30–60m', occurrenceCount: 7 }, { key: 'over_60m', label: '> 60m', occurrenceCount: 1 }],
  occurrences: [{ occurrenceId: 'o1', pressKey: 'press11', displayName: 'Press 11', startUtc: '2026-08-01T01:00:00.000Z', endUtc: '2026-08-01T01:12:00.000Z', durationSeconds: 720, eventType: 'B', radiusStateLabel: 'Bad', operationalGroupKey: 'MAINTENANCE_INTERVENTION', operationalGroupName: 'Maintenance Intervention', processFamilyKey: 'MAINTENANCE', processFamilyName: 'Maintenance', segments: [{ segmentId: 's1', startUtc: '2026-08-01T01:00:00.000Z', endUtc: '2026-08-01T01:12:00.000Z', durationSeconds: 720, eventType: 'B', statusCode: '123', statusDescription: 'Maintenance', operationalGroupKey: 'MAINTENANCE_INTERVENTION', operationalGroupName: 'Maintenance Intervention', processFamilyKey: 'MAINTENANCE', processFamilyName: 'Maintenance', needsClassification: false }], exactIdentities: [{ identity: 'B\u001f123\u001fMaintenance', eventType: 'B', statusCode: '123', statusDescription: 'Maintenance', durationSeconds: 720, needsClassification: false }] }],
  totalOccurrenceCount: 47, evidenceOffset: 0, evidenceLimit: 100,
} as ActivityAnalysis

const analytics = { productionStops: { anchorCount: 20, resolvedCount: 18, censoredCount: 2 }, beforeSuccessfulProduction: { anchorCount: 16 } } as OperationalAnalytics

const pattern = {
  patternKey: 'v1-abc', classificationVersion: 1, orderedGroupKeys: ['CHANGEOVER_SETUP', 'ROUTINE_PROCESS', 'PRODUCTION'], orderedGroupLabels: ['Changeover & Setup', 'Routine Process', 'Production'], runCount: 42, runSharePercent: 22.8, pressesObserved: 9, medianTimeToProductionSeconds: 3_120, medianPreProductionSeconds: 3_120, medianProductionSeconds: 7_200, shortAttemptRunCount: 3, matchedRunIds: ['r1'], containsReentry: false,
  pressStats: [{ pressKey: 'press13', displayName: 'Press 13', matchedRuns: 9, eligibleRuns: 24, matchRatePercent: 37.5, medianTimeToProductionSeconds: 3_000 }],
  familyVariations: [{ orderedFamilyKeys: ['MAKE_READY', 'CLEANING_WASH', 'PRODUCTION'], orderedFamilyLabels: ['Make Ready', 'Cleaning / Wash', 'Production'], runCount: 17, runShareWithinPatternPercent: 40.5 }],
}
const run = { runId: 'r1', pressKey: 'press13', displayName: 'Press 13', startUtc: '2026-08-01T01:00:00.000Z', endUtc: '2026-08-01T03:00:00.000Z', totalDurationSeconds: 7_200, timeToProductionSeconds: 3_120, productionDurationSeconds: 4_080, shortRunAttemptCount: 1, transitionCount: 4, isPartial: false, dataInterrupted: false, eligible: true, groupSequence: pattern.orderedGroupLabels, familySequence: ['Make Ready', 'Cleaning / Wash', 'Production'], selectedActivitySeconds: 900, conditionDurations: [{ conditionKey: 'operational_group:MAINTENANCE_INTERVENTION', durationSeconds: 600 }, { conditionKey: 'process_family:CLEANING_WASH', durationSeconds: 300 }] }
const patterns = { fromUtc: activity.fromUtc, toUtc: activity.toUtc, classificationVersion: 1, catalog, totalRuns: 200, eligibleRuns: 184, excludedPartialRuns: 9, excludedInterruptedRuns: 7, excludedOpenRuns: 3, uniquePatternCount: 17, shortAttemptRuns: 14, patterns: [pattern], selectedPattern: pattern, matchedRuns: [run], evidenceLimit: 200, builder: null } as PatternAnalysis

describe('one-activity explorer presentation', () => {
  it('guides Radius phase to explained group and family, with codes optional and the active choice explicit', () => {
    const exact = catalog.find((item) => item.level === 'exact_status')!
    const path = activityGuidePath(exact)
    assert.deepEqual(path, { radius_state: 'B', operational_group: 'ROUTINE_PROCESS', process_family: 'CLEANING_WASH', exact_status: exact.key })
    assert.deepEqual(guidedActivityOptions(catalog, 'operational_group', { radius_state: 'B' }).map(({ key }) => key), ['ROUTINE_PROCESS'])
    assert.deepEqual(guidedActivityOptions(catalog, 'process_family', { radius_state: 'B', operational_group: 'ROUTINE_PROCESS' }).map(({ key }) => key), ['CLEANING_WASH'])
    assert.deepEqual(guidedActivityOptions(catalog, 'exact_status', path).map(({ key }) => key), [exact.key])
    const html = renderToStaticMarkup(createElement(GuidedActivityPicker, { catalog, selected: exact, onSelect() {} }))
    for (const copy of ['Guided activity selection', 'Currently analyzing', 'Radius phase', 'Operational Group', 'Process Family', 'Hide exact Radius codes', 'optional shortcut', 'Each choice replaces the one activity']) assert.match(html, new RegExp(copy))
    assert.match(html, /B \/ 99 \/ Plates: Wash/)
    assert.match(html, /73\.0% observed/)
    assert.match(html, /22\.7% observed/)
    assert.doesNotMatch(html, /Search one activity/)
  })

  it('keeps peer choices visible while highlighting every selected path level', () => {
    const expandedCatalog = [
      ...catalog,
      { level: 'process_family', key: 'INK_COLOR', label: 'Ink / Color', description: 'Ink family', eventType: null, statusCode: null, statusDescription: null, operationalGroupKey: 'ROUTINE_PROCESS', operationalGroupName: 'Routine Process', processFamilyKey: 'INK_COLOR', processFamilyName: 'Ink / Color', needsClassification: false },
      { level: 'exact_status', key: 'B\u001f77\u001fInk adjustment', label: 'B / 77 / Ink adjustment', description: null, eventType: 'B', statusCode: '77', statusDescription: 'Ink adjustment', operationalGroupKey: 'ROUTINE_PROCESS', operationalGroupName: 'Routine Process', processFamilyKey: 'INK_COLOR', processFamilyName: 'Ink / Color', needsClassification: false },
      { level: 'exact_status', key: 'B\u001f55\u001fMechanical issue', label: 'B / 55 / Mechanical issue', description: null, eventType: 'B', statusCode: '55', statusDescription: 'Mechanical issue', operationalGroupKey: 'MAINTENANCE_INTERVENTION', operationalGroupName: 'Maintenance Intervention', processFamilyKey: 'MAINTENANCE', processFamilyName: 'Maintenance', needsClassification: false },
    ] as ActivityAnalysis['catalog']
    const selectedPath = { radius_state: 'B', operational_group: 'ROUTINE_PROCESS', process_family: 'CLEANING_WASH' }
    assert.deepEqual(guidedActivityOptions(expandedCatalog, 'operational_group', selectedPath).map(({ key }) => key).sort(), ['MAINTENANCE_INTERVENTION', 'ROUTINE_PROCESS'])
    assert.deepEqual(guidedActivityOptions(expandedCatalog, 'process_family', selectedPath).map(({ key }) => key).sort(), ['CLEANING_WASH', 'INK_COLOR'])
    const html = renderToStaticMarkup(createElement(GuidedActivityPicker, { catalog, selected: catalog.find((item) => item.level === 'exact_status')!, onSelect() {} }))
    assert.equal((html.match(/aria-pressed="true"/g) ?? []).length, 4)
    assert.equal((html.match(/>Selected<\/em>/g) ?? []).length, 3)
    assert.equal((html.match(/>Analyzing<\/em>/g) ?? []).length, 1)
  })

  it('keeps duplicate family names grouped under the selected Operational Group', () => {
    const duplicateFamilies = [
      ...catalog,
      { ...catalog[3]!, operationalGroupKey: 'ADJUSTMENT_QUALITY', operationalGroupName: 'Adjustment & Quality', key: 'INK_COLOR', label: 'Ink / Color', processFamilyKey: 'INK_COLOR', processFamilyName: 'Ink / Color' },
      { ...catalog[3]!, operationalGroupKey: 'FAULT_RECOVERY', operationalGroupName: 'Fault & Recovery', key: 'INK_COLOR', label: 'Ink / Color', processFamilyKey: 'INK_COLOR', processFamilyName: 'Ink / Color' },
      { ...catalog[4]!, operationalGroupKey: 'ADJUSTMENT_QUALITY', operationalGroupName: 'Adjustment & Quality', key: 'M\u001f50\u001fMake Ready - Color Match', eventType: 'M', statusCode: '50', statusDescription: 'Make Ready - Color Match', processFamilyKey: 'INK_COLOR', processFamilyName: 'Ink / Color' },
      { ...catalog[4]!, operationalGroupKey: 'FAULT_RECOVERY', operationalGroupName: 'Fault & Recovery', key: 'B\u001f145-6\u001fInk Spill', eventType: 'B', statusCode: '145-6', statusDescription: 'Ink Spill', processFamilyKey: 'INK_COLOR', processFamilyName: 'Ink / Color' },
    ] as ActivityAnalysis['catalog']
    assert.deepEqual(guidedActivityOptions(duplicateFamilies, 'process_family', { operational_group: 'ADJUSTMENT_QUALITY' }).map(({ operationalGroupKey, key }) => [operationalGroupKey, key]), [['ADJUSTMENT_QUALITY', 'INK_COLOR']])
  })

  it('shows magnitude, frequency, press, state, trend, distribution, semantic, and exact evidence', () => {
    const html = renderToStaticMarkup(createElement(OperationalActivityExplorerView, { data: activity, analytics }))
    for (const copy of ['Total time', 'Occurrences', 'Median occurrence', 'Longest occurrence', 'Press comparison', 'Occurrence duration', 'Process families', 'Exact occurrences', 'B / 123 / Maintenance', 'Physical signature']) assert.match(html, new RegExp(copy))
    assert.match(html, /Radius Coverage/)
    assert.match(html, /Classification Coverage/)
    assert.match(html, /Load next 46/)
    assert.match(html, /Complete selected range/)
    assert.match(html, /exact selected-range axis/)
    assert.match(html, /Operational Group/)
    assert.match(html, /Process Family/)
    assert.match(html, /Open evidence/)
    assert.doesNotMatch(html, /Stops &amp; Recovery/)
    assert.ok(html.indexOf('Physical signature across the full time range') < html.indexOf('Exact occurrences'))
    assert.ok(html.indexOf('Exact occurrences') < html.indexOf('Press comparison'))
    assert.doesNotMatch(html, /Radius composition|Radius ↔ semantic meaning|Full-range activity trend|Daily line trend/)
    assert.match(html, /Press comparison[\s\S]*Duration distribution/)
  })

  it('plots complete-range Radius and semantic context while highlighting only the selected activity', () => {
    const intervals = [
      { intervalId: 'one', startUtc: activity.fromUtc, endUtc: '2026-08-02T00:00:00.000Z', durationSeconds: 86_400, isUnavailable: false, eventType: 'B', statusCode: '123', statusDescription: 'Maintenance', radiusStateLabel: 'Bad', operationalGroupKey: 'MAINTENANCE_INTERVENTION', operationalGroupLabel: 'Maintenance Intervention', operationalGroupLightColor: '#345678', operationalGroupDarkColor: '#89abcd', processFamilyKey: 'MAINTENANCE', processFamilyLabel: 'Maintenance', classificationNeedsReview: false, classificationStatus: 'mapped' },
      { intervalId: 'two', startUtc: '2026-08-02T00:00:00.000Z', endUtc: activity.toUtc, durationSeconds: 518_400, isUnavailable: false, eventType: 'G', statusCode: '150', statusDescription: 'Run Production', radiusStateLabel: 'Good', operationalGroupKey: 'PRODUCTION', operationalGroupLabel: 'Production', operationalGroupLightColor: '#456789', operationalGroupDarkColor: '#9abcde', processFamilyKey: 'PRODUCTION', processFamilyLabel: 'Production', classificationNeedsReview: false, classificationStatus: 'mapped' },
    ] as any
    const tracks = fullRangeActivityTracks(intervals, { level: 'operational_group', key: 'MAINTENANCE_INTERVENTION', label: 'Maintenance Intervention' })
    for (const track of [tracks.radius, tracks.group, tracks.family]) {
      assert.equal(track.intervals.length, 2)
      assert.match(track.intervals[0]!.className ?? '', /activity-range-segment--match/)
      assert.match(track.intervals[1]!.className ?? '', /activity-range-segment--context/)
    }
  })

  it('highlights a shared family only inside its selected parent group', () => {
    const intervals = [
      { intervalId: 'adjustment', startUtc: activity.fromUtc, endUtc: '2026-08-02T00:00:00.000Z', durationSeconds: 86_400, isUnavailable: false, eventType: 'M', statusCode: '50', statusDescription: 'Make Ready - Color Match', radiusStateLabel: 'Make Ready', operationalGroupKey: 'ADJUSTMENT_QUALITY', operationalGroupLabel: 'Adjustment & Quality', operationalGroupLightColor: null, operationalGroupDarkColor: null, processFamilyKey: 'INK_COLOR', processFamilyLabel: 'Ink / Color', classificationNeedsReview: false, classificationStatus: 'mapped' },
      { intervalId: 'fault', startUtc: '2026-08-02T00:00:00.000Z', endUtc: activity.toUtc, durationSeconds: 518_400, isUnavailable: false, eventType: 'B', statusCode: '145-6', statusDescription: 'Ink Spill', radiusStateLabel: 'Bad', operationalGroupKey: 'FAULT_RECOVERY', operationalGroupLabel: 'Fault & Recovery', operationalGroupLightColor: null, operationalGroupDarkColor: null, processFamilyKey: 'INK_COLOR', processFamilyLabel: 'Ink / Color', classificationNeedsReview: false, classificationStatus: 'mapped' },
    ] as any
    const tracks = fullRangeActivityTracks(intervals, { level: 'process_family', key: 'INK_COLOR', label: 'Ink / Color', operationalGroupKey: 'ADJUSTMENT_QUALITY' })
    for (const track of [tracks.radius, tracks.group, tracks.family]) {
      assert.match(track.intervals[0]!.className ?? '', /activity-range-segment--match/)
      assert.match(track.intervals[1]!.className ?? '', /activity-range-segment--context/)
    }
  })

  it('renders all timeline press choices as explicit buttons with one clear active press', () => {
    const secondBreakdown = { ...activity.pressBreakdown[0]!, pressKey: 'press12' as const, displayName: 'Press 12', occurrenceCount: 4 }
    const secondOccurrence = { ...activity.occurrences[0]!, occurrenceId: 'o2', pressKey: 'press12' as const, displayName: 'Press 12' }
    const html = renderToStaticMarkup(createElement(OperationalActivityExplorerView, { data: { ...activity, pressBreakdown: [...activity.pressBreakdown, secondBreakdown], occurrences: [...activity.occurrences, secondOccurrence], totalOccurrenceCount: 2 }, analytics }))
    assert.match(html, /activity-signature-presses/)
    assert.match(html, /Press 11/)
    assert.match(html, /Press 12/)
    assert.equal((html.match(/aria-pressed="true"/g) ?? []).length >= 1, true)
    assert.doesNotMatch(html, /<select/)
  })

  it('provides local press focus and responsive theme-aware styling', () => {
    const source = readFileSync(new URL('../src/components/OperationalActivityExplorer.tsx', import.meta.url), 'utf8')
    const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
    assert.match(source, /setPressFocus/)
    assert.doesNotMatch(source, /setStateFocus/)
    assert.match(source, /Clear local evidence focus/)
    assert.match(css, /@media \(max-width: 980px\)/)
    assert.match(css, /@media \(max-width: 700px\)/)
    assert.match(css, /@media \(max-width: 460px\)/)
    assert.match(css, /var\(--surface\)/)
  })
})

describe('pattern-first presentation', () => {
  it('shows discovered prevalence, rate denominators, family variations, and matched Runs', () => {
    const html = renderToStaticMarkup(createElement(DiscoveredPatterns, { data: patterns, onPattern() {}, onPressFocus() {} }))
    for (const copy of ['Eligible Runs', 'Unique patterns', 'Pattern prevalence', 'Selected pattern', 'Match rate by press', '9 / 24 · 37.5%', 'Process Family variations', 'Matched Run evidence']) assert.match(html, new RegExp(copy))
    assert.match(html, /Changeover &amp; Setup.*Routine Process.*Production/)
  })

  it('shows the multi-condition builder, modes, union-duration explanation, and matched-vs-other donut', () => {
    const builderData = { ...patterns, builder: { conditions: [catalog[1], catalog[3]], matchMode: 'contains_all', redundantConditionMessage: null, matchedRuns: 12, matchSharePercent: 6.5, pressesObserved: 5, medianTimeToProductionSeconds: 3_780, medianSelectedActivitySeconds: 900, totalSelectedActivitySeconds: 16_620, pressStats: [{ pressKey: 'press11', displayName: 'Press 11', matchedRuns: 5, eligibleRuns: 19, matchRatePercent: 26.3, selectedActivitySeconds: 7_200, medianTimeToProductionSeconds: 4_000 }], topPatterns: [{ patternKey: pattern.patternKey, labels: pattern.orderedGroupLabels, runCount: 6, percentageOfMatches: 50 }] } } as PatternAnalysis
    const html = renderToStaticMarkup(createElement(Builder, { data: builderData, conditions: [catalog[1], catalog[3]], mode: 'contains_all', onConditions() {}, onMode() {}, onRefresh() {} }))
    for (const copy of ['Maintenance Intervention', 'Cleaning / Wash', 'Contains All', 'In This Order', 'Matched Runs', 'Matched Run evidence', 'union of matching intervals']) assert.match(html, new RegExp(copy))
    assert.match(html, /5 \/ 19 · 26.3%/)
    assert.doesNotMatch(html, /Good Pattern|Bad Pattern|Watch Pattern/)
  })
})
