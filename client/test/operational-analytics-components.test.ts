import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import React, { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { OperationalAnalysisPage } from '../src/components/AnalyticsPages'
import { OperationalAnalyticsOverview } from '../src/components/OperationalAnalyticsOverview'
import { PressStateTimeline } from '../src/components/PressStateTimeline'
import type { AnalyticsStatusRef, OperationalAnalytics, RadiusOverview } from '../src/types/api'

Object.assign(globalThis, { React })

const makeReady: AnalyticsStatusRef = { identity: 'M\u001fMR\u001fMake Ready', eventType: 'M', category: 'Make Ready', statusCode: 'MR', statusDescription: 'Make Ready' }
const production: AnalyticsStatusRef = { identity: 'G\u001fRP\u001fRun Production', eventType: 'G', category: 'Good', statusCode: 'RP', statusDescription: 'Run Production' }
const evidence = { pressKey: 'press7' as const, displayName: 'Press 7', startUtc: '2026-08-10T12:00:00.000Z', endUtc: '2026-08-10T12:10:00.000Z', durationSeconds: 600, leftCensored: false, rightCensored: false, previousStatus: production, nextStatus: production }
const outcome = { target: production, numerator: 5, denominator: 5, percentage: 100, pressCount: 1, medianLagSeconds: 0, p90LagSeconds: 0, lowSupport: true, evidence: [evidence] }
const pattern = { anchorCount: 5, resolvedCount: 5, censoredCount: 0, outcomes: [outcome], paths: [{ states: [makeReady, production], count: 5, denominator: 5, percentage: 100, pressCount: 1, medianElapsedSeconds: 300, p90ElapsedSeconds: 420, lowSupport: true }] }

const analytics = {
  fromUtc: '2026-08-10T12:00:00.000Z', toUtc: '2026-08-10T13:00:00.000Z', scopePressKeys: ['press7'], scopePressCount: 1,
  annotationDisclaimer: 'Radius is operator-entered evidence, not physical truth.',
  coverage: { possibleSeconds: 3600, observedSeconds: 3000, unknownSeconds: 600, coveragePercentage: 83.3 },
  categories: [{ eventType: 'M', category: 'Make Ready', durationSeconds: 3000, percentageOfObserved: 100, percentageOfPossible: 83.3, occurrenceCount: 5, productionSeconds: 0 }],
  statusDrivers: [{ ...makeReady, durationSeconds: 3000, percentageOfObserved: 100, percentageWithinCategory: 100, occurrenceCount: 5, medianOccurrenceSeconds: 600, p90OccurrenceSeconds: 600, pressCount: 1, scopePressCount: 1, clippedOccurrenceCount: 1, evidence: [evidence] }],
  productionStops: pattern,
  beforeSuccessfulProduction: pattern,
  afterMakeReady: { ...pattern, confirmedProductionCount: 5, returnedToMakeReadyCount: 0, enteredBadCount: 0, enteredSStateCount: 0, failedToReachConfirmedProductionCount: 0, unresolvedCount: 0, medianSecondsToConfirmedProduction: 300, p90SecondsToConfirmedProduction: 420 },
  relationshipGroups: [{ anchor: makeReady, direction: 'after', maxTransitions: 1, denominator: 5, censoredCount: 1, outcomes: [outcome] }],
  anomalies: [],
} as OperationalAnalytics

const timelineOverview = {
  fromUtc: '2026-08-10T12:00:00.000Z', toUtc: '2026-08-10T13:00:00.000Z', plantTimeZone: 'America/Chicago', productionStatusDescription: 'Run Production', stateBreakdownRunConfirmationSeconds: 120,
  rangeEndIsLive: false, feedStatus: 'ONLINE', lastObservationUtc: '2026-08-10T13:00:00.000Z', offlinePressCount: 0, onlinePressCount: 1,
  summary: { pressesMonitored: 1, currentlyRunProduction: 1, currentlyNonProduction: 0, openEpisodes: 0, totalNonProductionSeconds: 1_140 }, unmappedPressKeys: [], episodeAnalysis: { sequenceFamilies: [] }, operationalAnalytics: analytics,
  presses: [{
    pressKey: 'press7', displayName: 'Press 7', radiusMachineId: 207, availability: 'online', lastRadiusStatus: null, lastObservationUtc: '2026-08-10T13:00:00.000Z', offlineSinceUtc: null, currentStatusDescription: 'Run Production', currentEventType: 'G', currentStatusAtUtc: '2026-08-10T12:31:00.000Z', isCurrentlyProduction: true,
    runProductionSeconds: 2_460, nonProductionSeconds: 1_140, offlineSeconds: 0, observedSeconds: 3_600, rangeSeconds: 3_600, dataCoveragePercent: 100, episodeCount: 1, openEpisodeCount: 0, longestEpisodeSeconds: 1_140,
    timelineSegments: [
      { kind: 'radius', machineId: 207, pressKey: 'press7', displayName: 'Press 7', eventType: 'M', statusCode: 'MR', statusDescription: 'Make Ready', startUtc: '2026-08-10T12:00:00.000Z', endUtc: '2026-08-10T12:20:00.000Z', durationSeconds: 1_200, isOpen: false, sourceGeneration: 'compact', isProduction: false },
      { kind: 'radius', machineId: 207, pressKey: 'press7', displayName: 'Press 7', eventType: 'G', statusCode: 'RP', statusDescription: 'Run Production', startUtc: '2026-08-10T12:20:00.000Z', endUtc: '2026-08-10T12:21:00.000Z', durationSeconds: 60, isOpen: false, sourceGeneration: 'compact', isProduction: true, stateBreakdownRunQualification: { state: 'short', returnUtc: null, confirmationSatisfiedUtc: null } },
      { kind: 'radius', machineId: 207, pressKey: 'press7', displayName: 'Press 7', eventType: 'M', statusCode: 'MR', statusDescription: 'Make Ready', startUtc: '2026-08-10T12:21:00.000Z', endUtc: '2026-08-10T12:30:00.000Z', durationSeconds: 540, isOpen: false, sourceGeneration: 'compact', isProduction: false },
      { kind: 'radius', machineId: 207, pressKey: 'press7', displayName: 'Press 7', eventType: 'G', statusCode: 'RP', statusDescription: 'Run Production', startUtc: '2026-08-10T12:30:00.000Z', endUtc: '2026-08-10T13:00:00.000Z', durationSeconds: 1_800, isOpen: false, sourceGeneration: 'compact', isProduction: true, stateBreakdownRunQualification: { state: 'sustained', returnUtc: '2026-08-10T12:30:00.000Z', confirmationSatisfiedUtc: '2026-08-10T12:32:00.000Z' } },
    ],
  }],
} as RadiusOverview

const runComparison = {
  pressKey: 'press7', displayName: 'Press 7', fromUtc: timelineOverview.fromUtc, toUtc: timelineOverview.toUtc, confirmationSeconds: 120, samePressMinimumRuns: 5, fleetMinimumPresses: 3, fleetMinimumRuns: 10, similarRelativeTolerance: .1, similarAbsoluteSeconds: 60,
  runs: [{ runId: 'press7:run1', sequenceNumber: 1, pressKey: 'press7', displayName: 'Press 7', startUtc: timelineOverview.fromUtc, endUtc: timelineOverview.toUtc, productionStartUtc: '2026-08-10T12:30:00.000Z', timeToProductionSeconds: 1_800, productionDurationSeconds: 1_800, totalDurationSeconds: 3_600, transitionCount: 3, distinctStatusCount: 2, shortRunAttemptCount: 1, shortRunAttemptDurationSeconds: 60, isPartial: false, dataInterrupted: false, eligibleForBenchmark: true,
    segments: timelineOverview.presses[0]!.timelineSegments.map((segment, index) => ({ segmentId: `segment-${index}`, exactIdentity: segment.kind === 'radius' ? `${segment.eventType}\u001f${segment.statusCode}\u001f${segment.statusDescription}` : null, eventType: segment.eventType, statusCode: segment.statusCode, statusDescription: segment.kind === 'radius' ? segment.statusDescription : null, startUtc: segment.startUtc, endUtc: segment.endUtc, durationSeconds: segment.durationSeconds, phase: index === 3 ? 'production' : 'pre-production', isUnavailable: segment.kind === 'offline', isShortRunAttempt: segment.stateBreakdownRunQualification?.state === 'short' })),
    timeToProductionBenchmark: { direction: 'low_support', samePress: { sampleRuns: 0, samplePresses: 0, sufficientSupport: false, average: null, median: null, delta: null, percentDelta: null, percentile: null }, fleet: { sampleRuns: 0, samplePresses: 0, sufficientSupport: false, average: null, median: null, delta: null, percentDelta: null, percentile: null } }, productionDurationBenchmark: { direction: 'low_support', samePress: { sampleRuns: 0, samplePresses: 0, sufficientSupport: false, average: null, median: null, delta: null, percentDelta: null, percentile: null } }, transitionBenchmark: {}, shortAttemptCountBenchmark: {}, shortAttemptDurationBenchmark: {}, statusSummaries: [], contributors: [], sequenceComparison: { commonSequence: [], runSequence: [], variation: false, sufficientSupport: false }, flags: ['1 short Run attempt'], rank: { timeToProduction: 1, productionDuration: 1, comparableRuns: 1 } }],
} as any

describe('operational analytics components', () => {
  it('makes Operational Analysis a one-activity investigation instead of a second Overview or sequence page', () => {
    const html = renderToStaticMarkup(createElement(OperationalAnalysisPage, { analytics, scopeLabel: 'Press 7', overview: timelineOverview, selectedPress: 'press7' }))
    assert.match(html, /From Radius phase to operational explanation/)
    assert.match(html, /Choose a broad Radius phase, narrow through ProcessIntelligence Operational Groups and Process Families/)
    assert.match(html, /Combinations and ordered behavior belong in Patterns &amp; Episodes/)
    assert.doesNotMatch(html, /State breakdown|Drivers &amp; recovery|Run breakdowns|Pattern prevalence/)
  })

  it('does not expose the former duplicated Operational Analysis tabs', () => {
    const html = renderToStaticMarkup(createElement(OperationalAnalysisPage, { analytics, scopeLabel: 'Press 7', overview: timelineOverview, selectedPress: 'press7' }))
    assert.doesNotMatch(html, /analysis-tabs|state-breakdown|status-drivers|patterns-panel/)
  })

  it('uses the global press scope and explains explicit unavailable spans', () => {
    const gapOverview = {
      ...timelineOverview,
      presses: [{
        ...timelineOverview.presses[0],
        timelineSegments: [{ kind: 'offline', machineId: 207, pressKey: 'press7', displayName: 'Press 7', eventType: null, statusCode: null, statusDescription: null, startUtc: timelineOverview.fromUtc, endUtc: timelineOverview.toUtc, durationSeconds: 3_600, isOpen: false, sourceGeneration: 'offline_inference', isProduction: false }],
      }],
    } as RadiusOverview
    const scoped = renderToStaticMarkup(createElement(PressStateTimeline, { overview: gapOverview, selectedPress: 'press7' }))
    const fleet = renderToStaticMarkup(createElement(PressStateTimeline, { overview: timelineOverview }))
    assert.doesNotMatch(scoped, /Selected press/)
    assert.match(fleet, /Selected press/)
    assert.match(scoped, /Data unavailable/)
    assert.match(scoped, /not forward-filled/)
  })

  it('renders coverage, unknown time, exact N/D, low-support qualification, and evidence drilldowns', () => {
    const html = renderToStaticMarkup(createElement(OperationalAnalyticsOverview, { analytics, scopeLabel: 'Press 7', onInvestigateStatus() {}, onInvestigateAnomaly() {} }))
    assert.match(html, /83\.3%/)
    assert.match(html, /Unknown \/ unobserved/)
    assert.match(html, /5\/5 · 100\.0%/)
    assert.match(html, /Dominant/)
    assert.match(html, /Low support/)
    assert.match(html, /Matching evidence/)
    assert.match(html, /Variation \/ non-matching evidence/)
    assert.match(html, /Press 7/)
  })

  it('renders an intentional empty state when no relationship or anomaly is calculable', () => {
    const empty = { ...analytics, relationshipGroups: [], anomalies: [] }
    const html = renderToStaticMarkup(createElement(OperationalAnalyticsOverview, { analytics: empty, scopeLabel: 'All 12 presses', onInvestigateStatus() {}, onInvestigateAnomaly() {} }))
    assert.match(html, /No complete state relationships can be calculated/)
    assert.match(html, /No deviations met the deterministic support threshold/)
    assert.match(html, /All 12 presses/)
  })
})
