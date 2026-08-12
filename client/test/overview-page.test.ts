import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import React, { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { RadiusOverview } from '../src/components/RadiusOverview'
import type { OverviewGroupAllocation, OverviewPressAllocation, OverviewRadiusStateAllocation, OverviewTimelineInterval, RadiusOverview as RadiusOverviewModel, RadiusPressKey } from '../src/types/api'

Object.assign(globalThis, { React })

function family(key: string, name: string, seconds: number, groupSeconds: number, stateSeconds: number, observedSeconds: number, needsClassification = false) {
  return { key, name, durationSeconds: seconds, nonProductionSeconds: seconds, shareOfGroupPercent: seconds / groupSeconds * 100, shareOfRadiusStatePercent: seconds / stateSeconds * 100, shareOfObservedPercent: seconds / observedSeconds * 100, sourceIdentityCount: 1, needsClassification, pressContributions: [{ pressKey: 'press5' as const, displayName: 'Press 5', durationSeconds: seconds, shareOfCategoryPercent: 100 }] }
}

function group(key: string, name: string, seconds: number, stateSeconds: number, observedSeconds: number, familyName: string, color: string, needsClassification = false): OverviewGroupAllocation {
  return { key, name, description: `${name} evidence`, lightColor: color, darkColor: color, durationSeconds: seconds, shareOfRadiusStatePercent: seconds / stateSeconds * 100, shareOfObservedPercent: seconds / observedSeconds * 100, nonProductionSeconds: key === 'PRODUCTION' ? 0 : seconds, families: [family(familyName.toUpperCase().replaceAll(' ', '_'), familyName, seconds, seconds, stateSeconds, observedSeconds, needsClassification)], needsClassification, pressContributions: [{ pressKey: 'press5', displayName: 'Press 5', durationSeconds: seconds, shareOfCategoryPercent: 100 }] }
}

function radiusState(eventType: string, displayLabel: string, seconds: number, observedSeconds: number, groups: OverviewGroupAllocation[], productionSeconds = 0): OverviewRadiusStateAllocation {
  const nonProductionSeconds = seconds - productionSeconds
  const nonProductionGroup = groups.filter(({ nonProductionSeconds: value }) => value > 0).sort((a, b) => b.nonProductionSeconds - a.nonProductionSeconds)[0]
  const nonProductionFamily = nonProductionGroup?.families[0]
  return { eventType, displayLabel, durationSeconds: seconds, shareOfObservedPercent: seconds / observedSeconds * 100, canonicalProductionSeconds: productionSeconds, nonProductionSeconds, nonProductionShareOfObservedPercent: nonProductionSeconds / observedSeconds * 100, operationalGroups: groups, largestNonProductionGroupKey: nonProductionGroup?.key ?? null, largestNonProductionFamilyKey: nonProductionFamily?.key ?? null }
}

const observed = 3_000
const productionGroup = group('PRODUCTION', 'Production', 1_200, 1_200, observed, 'Production', '#18864b')
const routineGroup = group('ROUTINE_PROCESS', 'Routine Process', 600, 1_200, observed, 'Cleaning / Wash', '#7546a8')
const adjustmentGroup = group('ADJUSTMENT_QUALITY', 'Adjustment & Quality', 600, 1_200, observed, 'Impression / Print Adjustment', '#bd3535')
const setupGroup = group('CHANGEOVER_SETUP', 'Changeover & Setup', 600, 600, observed, 'Make Ready', '#2563b8')
const good = radiusState('G', 'Run Production', 1_200, observed, [productionGroup], 1_200)
const bad = radiusState('B', 'Bad', 1_200, observed, [routineGroup, adjustmentGroup])
const makeReady = radiusState('M', 'Make Ready', 600, observed, [setupGroup])

function interval(id: string, start: string, end: string, seconds: number, eventType: string | null, state: string, groupItem?: OverviewGroupAllocation, familyName?: string): OverviewTimelineInterval {
  const unavailable = eventType === null
  return { intervalId: id, startUtc: start, endUtc: end, durationSeconds: seconds, isUnavailable: unavailable, eventType, radiusStateLabel: state, statusCode: unavailable ? null : '100', statusDescription: unavailable ? null : state, operationalGroupKey: groupItem?.key ?? null, operationalGroupLabel: unavailable ? 'Data unavailable' : groupItem?.name ?? 'Needs Classification', operationalGroupLightColor: groupItem?.lightColor ?? null, operationalGroupDarkColor: groupItem?.darkColor ?? null, processFamilyKey: familyName?.toUpperCase().replaceAll(' ', '_') ?? null, processFamilyLabel: familyName ?? null, classificationNeedsReview: !unavailable && !groupItem, classificationStatus: unavailable ? 'unavailable' : groupItem ? 'mapped' : 'needs_classification' }
}

const timeline = [
  interval('g', '2026-08-11T12:00:00.000Z', '2026-08-11T12:20:00.000Z', 1_200, 'G', 'Run Production', productionGroup, 'Production'),
  interval('b1', '2026-08-11T12:20:00.000Z', '2026-08-11T12:30:00.000Z', 600, 'B', 'Bad', routineGroup, 'Cleaning / Wash'),
  interval('b2', '2026-08-11T12:30:00.000Z', '2026-08-11T12:40:00.000Z', 600, 'B', 'Bad', adjustmentGroup, 'Impression / Print Adjustment'),
  interval('off', '2026-08-11T12:40:00.000Z', '2026-08-11T12:50:00.000Z', 600, null, 'Data unavailable'),
  interval('m', '2026-08-11T12:50:00.000Z', '2026-08-11T13:00:00.000Z', 600, 'M', 'Make Ready', setupGroup, 'Make Ready'),
]

function allocation(pressKey: RadiusPressKey, productionShare: number, rank: number | null, eligible = true): OverviewPressAllocation {
  return { pressKey, displayName: `Press ${pressKey.slice(5)}`, wallClockSeconds: 3_600, observedSeconds: observed, unavailableSeconds: 600, coveragePercent: eligible ? 83.333 : 50, productionSeconds: productionShare / 100 * observed, productionSharePercent: productionShare, nonProductionSeconds: observed - productionShare / 100 * observed, nonProductionSharePercent: 100 - productionShare, fleetProductionRank: rank, productionDeltaVsFleetMedianPoints: productionShare - 60, rankingEligible: eligible, rankingExclusionReason: eligible ? null : 'coverage_below_80_percent', classificationCoveragePercent: 98, needsClassificationSeconds: 60, largestNonProductionRadiusStateEventType: 'B', radiusStateBreakdown: [good, makeReady, bad], timelineIntervals: timeline }
}

const press13 = allocation('press13', 81, 1)
const press12 = allocation('press12', 79, 2)
const press11 = allocation('press11', 26, 3)
const press10 = allocation('press10', 90, null, false)
const allocations = [press13, press12, press11, press10]

const overview = {
  fromUtc: '2026-08-11T12:00:00.000Z', toUtc: '2026-08-11T13:00:00.000Z', plantTimeZone: 'America/Chicago', productionStatusDescription: 'Run Production', stateBreakdownRunConfirmationSeconds: 120,
  rangeEndIsLive: false, feedStatus: 'ONLINE', lastObservationUtc: null, offlinePressCount: 0, onlinePressCount: 4,
  summary: { pressesMonitored: 4, currentlyRunProduction: 2, currentlyNonProduction: 2, openEpisodes: 0, totalNonProductionSeconds: 3_240 }, unmappedPressKeys: [],
  presses: allocations.map((item) => ({ pressKey: item.pressKey, displayName: item.displayName, radiusMachineId: 1, availability: 'online', lastRadiusStatus: null, lastObservationUtc: null, offlineSinceUtc: null, currentStatusDescription: null, currentEventType: null, currentStatusAtUtc: null, isCurrentlyProduction: null, runProductionSeconds: item.productionSeconds, nonProductionSeconds: item.nonProductionSeconds, offlineSeconds: item.unavailableSeconds, observedSeconds: item.observedSeconds, rangeSeconds: item.wallClockSeconds, dataCoveragePercent: item.coveragePercent, episodeCount: 0, openEpisodeCount: 0, longestEpisodeSeconds: 0, timelineSegments: [] })),
  classificationVersion: 4, operationalGroups: [],
  decisionSupport: {
    minimumCoveragePercent: 80, minimumObservedSeconds: 1_800, classificationVersion: 4,
    fleetSummary: { wallClockSeconds: 14_400, observedSeconds: 12_000, unavailableSeconds: 2_400, coveragePercent: 83.333, productionSeconds: 7_800, productionSharePercent: 65, nonProductionSeconds: 4_200, nonProductionSharePercent: 35, rankablePressCount: 3, pressCount: 4, productionMedianPercent: 60, classificationCoveragePercent: 98, needsClassificationSeconds: 240, largestNonProductionRadiusStateEventType: 'B' },
    pressAllocations: allocations, rankingPressKeys: ['press13', 'press12', 'press11'], topRunningPressKeys: ['press13', 'press12', 'press11'], needsAttentionPressKeys: ['press11', 'press12', 'press13'], fleetRadiusStateBreakdown: [good, makeReady, bad], focusItems: ['Press 13 has the highest observed Run Production share.', 'Press 11 has the lowest eligible Run Production share. Bad accounts for the largest share of its remaining observed time.', 'Bad is the fleet largest non-production Radius state. Routine Process represents the largest semantic portion.'], excludedPressKeys: ['press10'],
  },
} as unknown as RadiusOverviewModel

describe('Radius state hierarchy Overview', () => {
  it('removes the Operations/Raw toggle and raw-code-heavy Overview presentation', () => {
    const html = renderToStaticMarkup(createElement(RadiusOverview, { overview }))
    assert.doesNotMatch(html, /Overview interpretation level|Raw Radius evidence|Exact Radius evidence|>Operations</)
    assert.doesNotMatch(html, /B \/ 999|status code/i)
  })

  it('keeps the fleet decision layer intact', () => {
    const html = renderToStaticMarkup(createElement(RadiusOverview, { overview }))
    for (const label of ['Fleet snapshot', 'Highest Run Production Share', 'Worth Reviewing', 'What Stands Out']) assert.match(html, new RegExp(label))
    assert.match(html, /Run Production/)
    assert.doesNotMatch(html, />Good</)
  })

  it('renders Fleet Radius State Allocation with raw Radius S-state wording rather than assuming Safety', () => {
    const html = renderToStaticMarkup(createElement(RadiusOverview, { overview }))
    assert.match(html, /Fleet Radius State Allocation/)
    assert.match(html, /100% of observed Radius time per press/)
    assert.match(html, /Run Production/)
    assert.doesNotMatch(html, />Good</)
    assert.match(html, /Make Ready/)
    assert.match(html, /Bad/)
    assert.match(html, /Radius S state/)
    assert.doesNotMatch(html, />Safety</)
    assert.match(html, /Select semantic breakdown/)
  })

  it('defaults the merged Where Fleet Time Went hierarchy to largest state, group, and family', () => {
    const html = renderToStaticMarkup(createElement(RadiusOverview, { overview }))
    assert.match(html, /Where Fleet Time Went/)
    assert.match(html, /Radius said/)
    assert.match(html, /What made up Bad time/)
    assert.match(html, /Routine Process/)
    assert.match(html, /Cleaning \/ Wash/)
    assert.match(html, /% of Bad/)
    assert.match(html, /% of Routine Process/)
  })

  it('stops the normal hierarchy at process family', () => {
    const html = renderToStaticMarkup(createElement(RadiusOverview, { overview }))
    assert.match(html, /Process families within Routine Process/)
    assert.doesNotMatch(html, /Event<\/th>|Code<\/th>|Occurrences<\/th>|exact Radius evidence/i)
  })

  it('ranks press minutes and category percentages for the selected group and family', () => {
    const modified = structuredClone(overview)
    const routine = modified.decisionSupport!.fleetRadiusStateBreakdown.find(({ eventType }) => eventType === 'B')!.operationalGroups[0]
    routine.pressContributions = [
      { pressKey: 'press13', displayName: 'Press 13', durationSeconds: 420, shareOfCategoryPercent: 70 },
      { pressKey: 'press5', displayName: 'Press 5', durationSeconds: 180, shareOfCategoryPercent: 30 },
    ]
    routine.families[0].pressContributions = routine.pressContributions
    const html = renderToStaticMarkup(createElement(RadiusOverview, { overview: modified }))
    assert.match(html, /Press contribution to Routine Process/)
    assert.match(html, /Press contribution to Cleaning \/ Wash/)
    const contributionHtml = html.slice(html.indexOf('Press contribution to Routine Process'))
    assert.ok(contributionHtml.indexOf('Press 13') < contributionHtml.indexOf('Press 5'))
    assert.match(contributionHtml, /7\.0 min/)
    assert.match(html, /70\.0%/)
  })

  it('keeps Needs Classification and separates semantic coverage from Radius coverage', () => {
    const needs = group('NEEDS_CLASSIFICATION', 'Needs Classification', 120, 1_200, observed, 'Needs Classification', '#68727d', true)
    const modified = structuredClone(overview)
    modified.decisionSupport!.fleetRadiusStateBreakdown.find(({ eventType }) => eventType === 'B')!.operationalGroups.push(needs)
    const html = renderToStaticMarkup(createElement(RadiusOverview, { overview: modified }))
    assert.match(html, /Needs Classification/)
    assert.match(html, /Radius data coverage/)
    assert.match(html, /Classification coverage/)
  })

  it('keeps the ranking table compact and combines Radius-state and semantic evidence', () => {
    const html = renderToStaticMarkup(createElement(RadiusOverview, { overview }))
    assert.match(html, /Rank by<select/)
    assert.match(html, /Run Production Share/)
    assert.match(html, /Largest non-production Radius state/)
    assert.match(html, /Largest process group/)
    assert.match(html, /Process family/)
    assert.match(html, /Press 10/)
    assert.match(html, /Not ranked/)
  })

  it('renders compact single-press summary, fleet position, and Radius state distribution', () => {
    const html = renderToStaticMarkup(createElement(RadiusOverview, { overview, selectedPress: 'press11' }))
    assert.match(html, /Press 11 summary/)
    assert.match(html, /Position in fleet/)
    assert.match(html, /Radius State Distribution/)
    assert.match(html, /Largest non-production Radius state/)
    assert.match(html, /Routine Process/)
    assert.match(html, /Cleaning \/ Wash/)
    assert.doesNotMatch(html, /Top Running Presses/)
  })

  it('renders synchronized Radius and Process tracks on the same timeline', () => {
    const html = renderToStaticMarkup(createElement(RadiusOverview, { overview, selectedPress: 'press11' }))
    assert.match(html, /Synchronized process evidence/)
    assert.match(html, />Radius state</)
    assert.match(html, />Process group</)
    assert.match(html, /Press 11 synchronized evidence/)
    assert.match(html, /Scrollable wall-clock timeline/)
    assert.match(html, /Routine Process/)
    assert.match(html, /Adjustment &amp; Quality/)
  })

  it('shows Data unavailable on both chronology tracks without classifying it', () => {
    const html = renderToStaticMarkup(createElement(RadiusOverview, { overview, selectedPress: 'press11' }))
    assert.ok((html.match(/Data unavailable/g) ?? []).length >= 2)
    assert.match(html, /Machine state is unknown/)
    assert.match(html, /overview-gantt-segment--offline/)
  })

  it('provides linked hover/focus and persistent click selection behavior', () => {
    const source = readFileSync(new URL('../src/components/SynchronizedTimeline.tsx', import.meta.url), 'utf8')
    assert.match(source, /overlap\(item, hovered\)/)
    assert.match(source, /onMouseEnter=\{\(\) => focusInterval\(item\)\}/)
    assert.match(source, /onFocus=\{\(\) => focusInterval\(item\)\}/)
    assert.match(source, /onClick=\{\(\) => onSelect\?\.\(item, track\)\}/)
    assert.match(source, /selectedId === item\.id/)
  })

  it('keeps long-range Radius chronology and integrates bounded physical detail on-page', () => {
    const modified = structuredClone(overview)
    modified.toUtc = '2026-08-11T16:00:00.000Z'
    const html = renderToStaticMarkup(createElement(RadiusOverview, { overview: modified, selectedPress: 'press11' }))
    assert.match(html, /Select any interval to update the bounded telemetry window below/)
    assert.match(html, /Focused telemetry for the selected interval/)
    assert.match(html, /bounded to two hours/)
    assert.match(html, /Radius recorded/)
    assert.match(html, /Operational Group/)
    assert.match(html, /Process Family/)
    assert.doesNotMatch(html, /Open exact evidence/)
  })

  it('keeps the responsive light/dark implementation free of page-level overflow', () => {
    const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
    assert.match(css, /\.overview-page \{[^}]*overflow-x: clip/)
    assert.match(css, /:root\[data-theme="dark"\] \.overview-gantt-segment--process/)
    assert.match(css, /@media \(max-width: 980px\)/)
    assert.match(css, /@media \(max-width: 700px\)/)
    assert.match(css, /@media \(max-width: 460px\)/)
  })
})
