import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { seededSnapshot } from '../src/classification/seeds.js'
import { analyzeOperationalActivity } from '../src/radius/activity-analysis.js'
import { analyzeRunPatterns } from '../src/radius/pattern-analysis.js'
import { exactRadiusIdentity } from '../src/radius/radius-identity.js'
import type { RadiusOverview, RadiusPressKey, RadiusStateSegment, RadiusStatusSegment } from '../src/radius/models.js'

const snapshot = seededSnapshot()

function segment(pressKey: RadiusPressKey, startMinute: number, durationMinutes: number, eventType: string, statusCode: string, statusDescription: string): RadiusStateSegment {
  const identity = exactRadiusIdentity({ eventType, statusCode, statusDescription })
  const mapping = snapshot.classifications.find((item) => item.identity === identity)
  const group = snapshot.groups.find(({ id }) => id === mapping?.operationalGroupId)
  const family = snapshot.families.find(({ id }) => id === mapping?.processFamilyId)
  const start = Date.parse('2026-08-01T00:00:00.000Z') + startMinute * 60_000
  return {
    kind: 'radius', machineId: Number(pressKey.slice(5)), pressKey, displayName: `Press ${pressKey.slice(5)}`,
    startUtc: new Date(start).toISOString(), endUtc: new Date(start + durationMinutes * 60_000).toISOString(), durationSeconds: durationMinutes * 60,
    isOpen: false, sourceGeneration: 'compact', eventType, statusCode, statusDescription,
    isProduction: eventType === 'G' && statusDescription === 'Run Production',
    classification: mapping && group && family ? { ...mapping, operationalGroupName: group.displayName, operationalGroupDescription: group.description, operationalGroupLightColor: group.lightColor, operationalGroupDarkColor: group.darkColor, operationalGroupIcon: group.icon, processFamilyName: family.displayName, mappingVersion: snapshot.version, isFallback: false } : undefined,
  }
}

function press(pressKey: RadiusPressKey, segments: RadiusStatusSegment[]) {
  const observedSeconds = segments.reduce((sum, item) => sum + (item.kind === 'radius' ? item.durationSeconds : 0), 0)
  return { pressKey, displayName: `Press ${pressKey.slice(5)}`, radiusMachineId: Number(pressKey.slice(5)), availability: 'online', lastRadiusStatus: null, lastObservationUtc: null, offlineSinceUtc: null, currentStatusDescription: null, currentEventType: null, currentStatusAtUtc: null, isCurrentlyProduction: null, runProductionSeconds: 0, nonProductionSeconds: 0, offlineSeconds: 0, observedSeconds, rangeSeconds: 7_200, dataCoveragePercent: observedSeconds / 72, episodeCount: 0, openEpisodeCount: 0, longestEpisodeSeconds: 0, timelineSegments: segments }
}

function overview(presses: ReturnType<typeof press>[]): RadiusOverview {
  return { fromUtc: '2026-08-01T00:00:00.000Z', toUtc: '2026-08-01T02:00:00.000Z', plantTimeZone: 'America/Chicago', productionStatusDescription: 'Run Production', stateBreakdownRunConfirmationSeconds: 120, rangeEndIsLive: false, feedStatus: 'ONLINE', lastObservationUtc: null, offlinePressCount: 0, onlinePressCount: presses.length, summary: { pressesMonitored: presses.length, currentlyRunProduction: 0, currentlyNonProduction: 0, openEpisodes: 0, totalNonProductionSeconds: 0 }, unmappedPressKeys: [], presses, classificationVersion: snapshot.version, operationalGroups: snapshot.groups } as unknown as RadiusOverview
}

const p3 = press('press3', [
  segment('press3', 0, 3, 'G', '150', 'Run Production'),
  segment('press3', 3, 10, 'M', '16', 'Make Ready'),
  segment('press3', 13, 5, 'B', '99', 'Plates: Wash'),
  segment('press3', 18, 3, 'G', '150', 'Run Production'),
  segment('press3', 30, 8, 'M', '16', 'Make Ready'),
  segment('press3', 38, 1, 'G', '150', 'Run Production'),
  segment('press3', 39, 4, 'B', '95', 'Press Problem / Impression'),
  segment('press3', 43, 6, 'M', '16', 'Make Ready'),
  segment('press3', 49, 3, 'G', '150', 'Run Production'),
])
const p5 = press('press5', [segment('press5', 0, 3, 'G', '150', 'Run Production'), segment('press5', 3, 20, 'M', '16', 'Make Ready'), segment('press5', 23, 10, 'B', '99', 'Plates: Wash'), segment('press5', 33, 5, 'G', '150', 'Run Production')])
const fixture = overview([p3, p5])

describe('canonical one-activity analysis', () => {
  it('selects each supported semantic level and preserves exact identity evidence', () => {
    for (const selection of [
      { level: 'radius_state' as const, key: 'B', label: 'Bad' },
      { level: 'operational_group' as const, key: 'ROUTINE_PROCESS', label: 'Routine Process' },
      { level: 'process_family' as const, key: 'CLEANING_WASH', label: 'Cleaning / Wash' },
      { level: 'exact_status' as const, key: exactRadiusIdentity({ eventType: 'B', statusCode: '99', statusDescription: 'Plates: Wash' }), label: 'Plates: Wash' },
    ]) assert.equal(analyzeOperationalActivity(fixture, snapshot, selection).selection.level, selection.level)
    const result = analyzeOperationalActivity(fixture, snapshot, { level: 'process_family', key: 'CLEANING_WASH', label: '' })
    assert.equal(result.summary.totalDurationSeconds, 900)
    assert.equal(result.summary.occurrenceCount, 2)
    assert.equal(result.summary.medianOccurrenceSeconds, 450)
    assert.equal(result.summary.longestOccurrenceSeconds, 600)
    assert.equal(result.summary.pressesObserved, 2)
    assert.deepEqual(result.pressBreakdown.slice(0, 2).map(({ displayName, durationSeconds, occurrenceCount }) => [displayName, durationSeconds, occurrenceCount]), [['Press 5', 600, 1], ['Press 3', 300, 1]])
    assert.equal(result.radiusStateComposition[0]?.eventType, 'B')
    assert.equal(result.semanticBreakdown[0]?.label, 'B / 99 / Plates: Wash')
    assert.equal(result.occurrences[0]?.exactIdentities[0]?.identity, exactRadiusIdentity({ eventType: 'B', statusCode: '99', statusDescription: 'Plates: Wash' }))
    assert.equal(result.occurrences[0]?.segments[0]?.processFamilyName, 'Cleaning / Wash')
    assert.equal(result.occurrences[0]?.segments[0]?.startUtc, result.occurrences[0]?.startUtc)
  })

  it('buckets trends, duration distribution, coverage, and excludes unavailable time', () => {
    const offline = { kind: 'offline' as const, machineId: 3, pressKey: 'press3' as const, displayName: 'Press 3', startUtc: '2026-08-01T01:00:00.000Z', endUtc: '2026-08-01T01:10:00.000Z', durationSeconds: 600, isOpen: false, sourceGeneration: 'offline_inference' as const, eventType: null, statusCode: null, statusDescription: null, isProduction: false as const }
    const value = analyzeOperationalActivity(overview([press('press3', [...p3.timelineSegments, offline])]), snapshot, { level: 'radius_state', key: 'B', label: '' })
    assert.equal(value.trendBucket, 'hour')
    assert.ok(value.trend.length > 0)
    assert.equal(value.durationDistribution.reduce((sum, item) => sum + item.occurrenceCount, 0), value.summary.occurrenceCount)
    assert.ok(value.summary.sourceCoveragePercent < 100)
    assert.equal(value.summary.classificationCoveragePercent, 100)
  })

  it('pages exact occurrence evidence without changing full-scope accounting', () => {
    const selection = { level: 'radius_state' as const, key: 'M', label: 'Make Ready' }
    const first = analyzeOperationalActivity(fixture, snapshot, selection, { offset: 0, limit: 1 })
    const second = analyzeOperationalActivity(fixture, snapshot, selection, { offset: 1, limit: 1 })
    assert.equal(first.evidenceOffset, 0)
    assert.equal(second.evidenceOffset, 1)
    assert.equal(first.evidenceLimit, 1)
    assert.equal(first.occurrences.length, 1)
    assert.equal(second.occurrences.length, 1)
    assert.notEqual(first.occurrences[0]?.occurrenceId, second.occurrences[0]?.occurrenceId)
    assert.equal(first.totalOccurrenceCount, second.totalOccurrenceCount)
    assert.equal(first.summary.totalDurationSeconds, second.summary.totalDurationSeconds)
  })

  it('contains no database writes', () => {
    const source = readFileSync(new URL('../src/radius/activity-analysis.ts', import.meta.url), 'utf8')
    assert.doesNotMatch(source, /\b(?:INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|TRUNCATE\s+TABLE|ALTER\s+TABLE|CREATE\s+(?:TABLE|INDEX|TRIGGER))\b/i)
  })
})

describe('canonical Operational Run pattern analysis', () => {
  it('reuses canonical Runs, groups stable patterns, and reports eligible denominators', () => {
    const value = analyzeRunPatterns(fixture, snapshot)
    assert.equal(value.totalRuns, 3)
    assert.equal(value.eligibleRuns, 3)
    assert.equal(value.uniquePatternCount, 2)
    assert.ok(value.patterns.every(({ classificationVersion, patternKey }) => classificationVersion === 1 && patternKey.startsWith('v1-')))
    assert.ok(value.patterns.every(({ runSharePercent }) => runSharePercent > 0))
    assert.ok(value.selectedPattern?.pressStats.every(({ matchedRuns, eligibleRuns, matchRatePercent }) => matchRatePercent === matchedRuns / eligibleRuns * 100))
  })

  it('collapses only contiguous duplicates, preserves re-entry and short attempts', () => {
    const value = analyzeRunPatterns(fixture, snapshot)
    const reentry = value.patterns.find(({ containsReentry }) => containsReentry)
    assert.ok(reentry)
    assert.deepEqual(reentry?.orderedGroupLabels, ['Changeover & Setup', 'Run Production (short attempt)', 'Adjustment & Quality', 'Changeover & Setup', 'Production'])
    assert.equal(reentry?.shortAttemptRunCount, 1)
  })

  it('supports Contains All and chronological In This Order', () => {
    const conditions = [
      { level: 'operational_group' as const, key: 'CHANGEOVER_SETUP', label: '' },
      { level: 'process_family' as const, key: 'CLEANING_WASH', label: '' },
    ]
    const contains = analyzeRunPatterns(fixture, snapshot, { conditions, matchMode: 'contains_all' })
    const ordered = analyzeRunPatterns(fixture, snapshot, { conditions, matchMode: 'in_order' })
    const reversed = analyzeRunPatterns(fixture, snapshot, { conditions: [...conditions].reverse(), matchMode: 'in_order' })
    assert.equal(contains.builder?.matchedRuns, 2)
    assert.equal(ordered.builder?.matchedRuns, 2)
    assert.equal(reversed.builder?.matchedRuns, 0)
    assert.equal(contains.builder?.pressesObserved, 2)
  })

  it('detects hierarchical redundancy and unions overlapping duration', () => {
    const value = analyzeRunPatterns(fixture, snapshot, { conditions: [
      { level: 'operational_group', key: 'ROUTINE_PROCESS', label: '' },
      { level: 'process_family', key: 'CLEANING_WASH', label: '' },
    ], matchMode: 'contains_all' })
    assert.match(value.builder?.redundantConditionMessage ?? '', /already implied/)
    assert.equal(value.builder?.totalSelectedActivitySeconds, 900)
    assert.ok(value.matchedRuns.every(({ conditionDurations, selectedActivitySeconds }) => selectedActivitySeconds <= conditionDurations.reduce((sum, item) => sum + item.durationSeconds, 0)))
  })

  it('does not bridge unavailable data and contains no database writes', () => {
    const offline = { kind: 'offline' as const, machineId: 3, pressKey: 'press3' as const, displayName: 'Press 3', startUtc: '2026-08-01T00:10:00.000Z', endUtc: '2026-08-01T00:20:00.000Z', durationSeconds: 600, isOpen: false, sourceGeneration: 'offline_inference' as const, eventType: null, statusCode: null, statusDescription: null, isProduction: false as const }
    const input = overview([press('press3', [segment('press3', 0, 10, 'M', '16', 'Make Ready'), offline, segment('press3', 20, 5, 'B', '99', 'Plates: Wash'), segment('press3', 25, 3, 'G', '150', 'Run Production')])])
    const value = analyzeRunPatterns(input, snapshot)
    assert.ok(value.excludedInterruptedRuns > 0)
    assert.equal(value.eligibleRuns, 0)
    const source = readFileSync(new URL('../src/radius/pattern-analysis.ts', import.meta.url), 'utf8')
    assert.doesNotMatch(source, /\b(?:INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|TRUNCATE\s+TABLE|ALTER\s+TABLE|CREATE\s+(?:TABLE|INDEX|TRIGGER))\b/i)
  })
})
