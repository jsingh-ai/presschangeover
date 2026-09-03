import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { DateTime } from 'luxon'
import { actionTimingPhase, adjacentStopPress, buildFleetBandSegments, buildFleetRollLengthTrack, buildFleetSpeedTrack, buildOperatorReviewedSegments, buildProductionAttributeTracks, buildSelectedSignalTracks, buildStopSpeedChartModel, buildStopTimelineModel, changeoverRequirementChecks, confirmsPrediction, createStop72HourRange, extendStopRangeForward, extendStopRangeLookback, filterStopEpisodes, fleetHoverSnapshot, groupChangeoverActions, identityValueStyle, investigationSegmentForReviewedInterval, latestOperatorDecisionForSegment, operatorDecisionActionsVisible, operatorDecisionButtonLabel, predictedFleetState, radiusCodeStyle, selectedSignalSnapshots, shiftStopRange, shouldEmphasizeAvailability, STOP_CLASSIFICATION_FILTERS, stopDecisionSummary, stopFleetTotals, stopInspectionSnapshot, toggledActionSelection } from '../src/components/StopIntelligencePage'
import { actionBandColor, actionSignalTrackKey, investigationRadiusCodeStyle, selectedActionSignalContext } from '../src/components/StopIntelligenceTimeline'
import { evidenceChronologyMarkers, evidenceChronologyRows } from '../src/components/StopEvidenceChronology'
import { buildDeckStatusTimelineTracks, deckStatusIntervalLabel } from '../src/components/StopDeckStatusGantt'
import { numericPaths, numericValueAtCursor } from '../src/components/SynchronizedTimeline'
import { areaFromPathname, areaPath } from '../src/navigation'
import { formatPlantDateTimeCt } from '../src/time-ranges'
import type { StopFleetEpisode, StopFleetPressSummary, StopIntelligenceCorrection, StopIntelligenceDetail } from '../src/types/stop-intelligence'

const page = readFileSync(new URL('../src/components/StopIntelligencePage.tsx', import.meta.url), 'utf8')
const timeline = readFileSync(new URL('../src/components/StopIntelligenceTimeline.tsx', import.meta.url), 'utf8')
const chronology = readFileSync(new URL('../src/components/StopEvidenceChronology.tsx', import.meta.url), 'utf8')
const deckStatus = readFileSync(new URL('../src/components/StopDeckStatusGantt.tsx', import.meta.url), 'utf8')
const synchronizedTimeline = readFileSync(new URL('../src/components/SynchronizedTimeline.tsx', import.meta.url), 'utf8')
const api = readFileSync(new URL('../src/api/process-intelligence-api.ts', import.meta.url), 'utf8')
const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const types = readFileSync(new URL('../src/types/stop-intelligence.ts', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
const fleetTimelineSource = page.slice(page.indexOf('function FleetTimeline'), page.indexOf('function FleetRow'))

const episode = (classification: StopFleetEpisode['classification'], stopId: string): StopFleetEpisode => ({ stopId, pressKey: 'press14', startAt: '2026-08-25T20:00:00.000Z', endAt: '2026-08-25T20:10:00.000Z', physicalDurationSeconds: 600, classification, confidence: 'HIGH', movementAttemptCount: 2, failedRecoveryCount: 1, radiusAlignment: 'CONTRADICTORY', radiusStatusDescription: 'Run Production', primaryReasonCodes: ['RECIPE_CHANGED'], leftCensored: false, rightCensored: false, affectedByCollectionGap: false, affectedBySpeedQuality: false, changeoverActivityWindows: [] })
const press = (overrides: Partial<StopFleetPressSummary> = {}): StopFleetPressSummary => ({ pressKey: 'press14', displayName: 'Press 14', telemetryEvidenceState: 'AVAILABLE', stopCount: 4, totalPhysicalStopSeconds: 2_400, changeoverCount: 1, downtimeCount: 1, uncertainCount: 1, badDataCount: 1, changeoverPhysicalStopSeconds: 600, longestPhysicalStopSeconds: 900, dataAvailabilityWarning: false, warningReason: null, episodes: [episode('CHANGEOVER', 'c'), episode('DOWNTIME', 'd'), episode('UNCERTAIN', 'u'), episode('IGNORE_BAD_DATA', 'b')], speedContext: { fromUtc: '2026-08-25T19:45:00.000Z', toUtc: '2026-08-25T20:25:00.000Z', unit: 'ft/min', stopThreshold: 1, recoveryThreshold: 595, observations: [{ atUtc: '2026-08-25T19:50:00.000Z', speed: 800, qualityState: 'GOOD' }, { atUtc: '2026-08-25T20:00:00.000Z', speed: 0, qualityState: 'GOOD' }, { atUtc: '2026-08-25T20:10:00.000Z', speed: 700, qualityState: 'GOOD' }], unknownIntervals: [] }, radiusContext: { states: [{ kind: 'radius', startUtc: '2026-08-25T19:45:00.000Z', endUtc: '2026-08-25T20:25:00.000Z', eventType: 'G', statusCode: '150', statusDescription: 'Run Production', isProduction: true }], reason: 'Raw Radius available.' }, identityContext: [{ signalId: 20, canonicalId: 'production.order', rawIdentity: 'Order', observations: [{ atUtc: '2026-08-25T19:45:00.000Z', value: 'ORD-100', qualityState: 'GOOD' }] }, { signalId: 21, canonicalId: 'production.recipe', rawIdentity: 'Recipe', observations: [{ atUtc: '2026-08-25T19:45:00.000Z', value: 'REC-A', qualityState: 'GOOD' }] }, { signalId: 23, canonicalId: 'production.material', rawIdentity: 'Material', observations: [{ atUtc: '2026-08-25T19:45:00.000Z', value: 'MAT-A', qualityState: 'GOOD' }, { atUtc: '2026-08-25T20:05:00.000Z', value: 'MAT-B', qualityState: 'GOOD' }] }], rollLengthContext: { signalId: 22, canonicalId: 'production.roll.length.actual', rawIdentity: 'RollLength', unit: 'ft', observations: [{ atUtc: '2026-08-25T19:45:00.000Z', value: 0, qualityState: 'GOOD' }, { atUtc: '2026-08-25T19:55:00.000Z', value: 500, qualityState: 'GOOD' }, { atUtc: '2026-08-25T20:00:00.000Z', value: 0, qualityState: 'GOOD' }, { atUtc: '2026-08-25T20:10:00.000Z', value: 400, qualityState: 'GOOD' }] }, ...overrides })

const visualDetail = (): StopIntelligenceDetail => ({
  stopId: 'visual-stop', displayName: 'Press 14', rangeFromUtc: '2026-08-25T19:45:00.000Z', rangeToUtc: '2026-08-25T20:25:00.000Z', telemetryEvidenceState: 'SOURCE_TELEMETRY_UNAVAILABLE',
  identityAssociationConfiguration: { pressKey: 'press14', identityContextBeforeSeconds: 900, identityContextAfterSeconds: 900, identitySettlingSeconds: 120 },
  speedContext: { fromUtc: '2026-08-25T19:45:00.000Z', toUtc: '2026-08-25T20:25:00.000Z', unit: 'ft/min', stopThreshold: 1, recoveryThreshold: 595, observations: [{ atUtc: '2026-08-25T19:50:00.000Z', speed: 800, qualityState: 'GOOD' }, { atUtc: '2026-08-25T20:00:00.000Z', speed: 0, qualityState: 'GOOD' }, { atUtc: '2026-08-25T20:04:00.000Z', speed: 90, qualityState: 'GOOD' }, { atUtc: '2026-08-25T20:06:00.000Z', speed: null, qualityState: 'BAD' }, { atUtc: '2026-08-25T20:10:00.000Z', speed: 700, qualityState: 'GOOD' }], unknownIntervals: [{ fromUtc: '2026-08-25T20:06:00.000Z', toUtc: '2026-08-25T20:07:00.000Z', state: 'SOURCE_TELEMETRY_UNAVAILABLE' }] },
  radiusContext: { fromUtc: '2026-08-25T19:45:00.000Z', toUtc: '2026-08-25T20:25:00.000Z', states: [{ kind: 'radius', startUtc: '2026-08-25T19:45:00.000Z', endUtc: '2026-08-25T20:25:00.000Z', eventType: 'RUN', statusCode: '100', statusDescription: 'Run Production', isProduction: true }], reason: 'Full context Radius evidence.' },
  actionSignalContext: [
    { signalId: 10, canonicalId: 'deck.position', rawIdentity: 'Deck 1 Position', component: 'Deck 1', deckNumber: 1, unit: 'position', representation: 'changes', observations: [{ atUtc: '2026-08-25T19:45:00.000Z', value: 0, qualityState: 'GOOD' }, { atUtc: '2026-08-25T20:03:10.000Z', value: 1, qualityState: 'GOOD' }, { atUtc: '2026-08-25T20:03:20.000Z', value: 2, qualityState: 'GOOD' }] },
    { signalId: 11, canonicalId: 'deck.mode', rawIdentity: 'Deck 1 Mode', component: 'Deck 1', deckNumber: 1, unit: null, representation: 'changes', observations: [{ atUtc: '2026-08-25T19:45:00.000Z', value: 'idle', qualityState: 'GOOD' }, { atUtc: '2026-08-25T20:03:30.000Z', value: 'setup', qualityState: 'GOOD' }, { atUtc: '2026-08-25T20:12:00.000Z', value: 'run', qualityState: 'GOOD' }] },
    { signalId: 12, canonicalId: 'deck.position', rawIdentity: 'Deck 2 Position', component: 'Deck 2', deckNumber: 2, unit: 'position', representation: 'changes', observations: [{ atUtc: '2026-08-25T19:45:00.000Z', value: 0, qualityState: 'GOOD' }] },
  ],
  deckStatusContext: {
    fromUtc: '2026-08-25T19:45:00.000Z', toUtc: '2026-08-25T20:25:00.000Z', availability: 'AVAILABLE', reason: 'Raw deck containers split into Decks 1–10.', sourceIdentities: [{ role: 'active', rawIdentity: 'P14.deck.active' }, { role: 'deck_out', rawIdentity: 'P14.deck.deck_out' }, { role: 'print_on', rawIdentity: 'P14.deck.print_on' }, { role: 'print_off', rawIdentity: 'P14.deck.print_off' }],
    decks: Array.from({ length: 10 }, (_, index) => ({ deckNumber: index + 1, intervals: [{ startUtc: '2026-08-25T19:45:00.000Z', endUtc: '2026-08-25T20:00:00.000Z', state: 'PRINTING' as const, active: true, printing: true, out: false }, { startUtc: '2026-08-25T20:00:00.000Z', endUtc: '2026-08-25T20:10:00.000Z', state: 'OUT' as const, active: true, printing: false, out: true }, { startUtc: '2026-08-25T20:10:00.000Z', endUtc: '2026-08-25T20:25:00.000Z', state: 'PRINTING' as const, active: true, printing: true, out: false }], events: index === 0 ? [{ atUtc: '2026-08-25T20:00:00.000Z', kind: 'PRINT_OFF_COMMAND' as const, label: 'Print-off command' }] : [] })),
  },
  changeoverActivityWindows: [{ id: 'visual:job-out', kind: 'job-out', label: 'Job Out', startAt: '2026-08-25T20:00:00.000Z', endAt: '2026-08-25T20:03:00.000Z', source: 'TELEMETRY_INFERRED', explanation: 'Physical stop boundary.', evidenceDetails: ['Actual speed entered the stop.'] }, { id: 'visual:wash', kind: 'wash', label: 'Washing of Ink', startAt: '2026-08-25T20:01:00.000Z', endAt: '2026-08-25T20:07:00.000Z', source: 'TELEMETRY', explanation: 'First through last wash activity.', evidenceDetails: ['Wash activity window.'] }, { id: 'visual:register', kind: 'register', label: 'Registration Setup', startAt: '2026-08-25T20:03:00.000Z', endAt: '2026-08-25T20:08:00.000Z', source: 'TELEMETRY', explanation: 'First through last registration activity.', evidenceDetails: ['Registration activity window.'] }, { id: 'visual:impression', kind: 'impression', label: 'Impression Setup', startAt: '2026-08-25T20:04:00.000Z', endAt: '2026-08-25T20:09:00.000Z', source: 'TELEMETRY', explanation: 'First through last impression activity.', evidenceDetails: ['Impression activity window.'] }, { id: 'visual:color', kind: 'color-check', label: 'Color Check', startAt: '2026-08-25T20:08:00.000Z', endAt: '2026-08-25T20:10:00.000Z', source: 'TELEMETRY', explanation: 'Stopped speed and pump activity.', evidenceDetails: ['Pump changed while speed was stopped.'] }],
  stop: {
    physicalSegment: { pressKey: 'press14', sourceId: 1, speedSignalId: 2, startAt: '2026-08-25T20:00:00.000Z', endAt: '2026-08-25T20:10:00.000Z', leftCensored: false, rightCensored: false, leftCensorReason: null, rightCensorReason: null, physicalDurationSeconds: 600, zeroSpeedSeconds: 500, lowMovementSeconds: 100, movementAttempts: [{ startAt: '2026-08-25T20:03:00.000Z', endAt: '2026-08-25T20:04:00.000Z', durationSeconds: 60, averageSpeed: 45, peakSpeed: 90, reachedRecoveryThreshold: false, failedRecoveryCount: 1, sequenceNumber: 1 }], failedRecoveryCount: 1, failedRecoveryStreaks: [{ startAt: '2026-08-25T20:03:30.000Z', endAt: '2026-08-25T20:03:45.000Z', durationSeconds: 15, reason: 'DROPPED_BELOW_RECOVERY', movementAttemptSequenceNumber: 1 }], algorithmVersion: 'physical-v1', configVersion: 'config-v1' },
    classification: 'CHANGEOVER', confidence: 'HIGH', classificationVersion: 'classification-v1',
    identities: [{ field: 'recipe', usefulness: 'STRONG', available: true, canonicalId: 'production.recipe', beforeValue: 'R-100', afterValue: 'R-200', changed: true, settled: true, firstChangeAtUtc: '2026-08-25T20:05:00.000Z', lastChangeAtUtc: '2026-08-25T20:05:00.000Z', settledAtUtc: '2026-08-25T20:05:30.000Z', associationOffsetSeconds: 300, intermediateValues: [], reason: 'Recipe changed once and settled.' }], identityBefore: { recipe: 'R-100' }, identityAfter: { recipe: 'R-200' }, families: [], supportingEvidence: [], conflictingEvidence: [], missingEvidence: [], radiusAlignment: 'CONTRADICTORY',
    radius: { alignment: 'CONTRADICTORY', firstNonProductionAtUtc: null, firstProductionReturnAtUtc: null, physicalStartOffsetSeconds: null, physicalEndOffsetSeconds: null, coveredSeconds: 600, physicalSeconds: 600, coveragePercent: 100, states: [{ kind: 'radius', startUtc: '2026-08-25T20:00:00.000Z', endUtc: '2026-08-25T20:10:00.000Z', eventType: 'RUN', statusCode: '100', statusDescription: 'Run Production', isProduction: true }], reason: 'Radius remained in production.' },
  },
  changeoverActions: { eligible: true, reason: 'Eligible changeover.', windowFromUtc: '2026-08-25T19:45:00.000Z', windowToUtc: '2026-08-25T20:25:00.000Z', detectorVersion: 'actions-v1', actions: [{ actionCode: 'DECK_MOVEMENT', displayName: 'Deck movement', operatorConcept: 'Deck setup', confidence: 'DETECTED', startAt: '2026-08-25T20:03:00.000Z', endAt: '2026-08-25T20:04:00.000Z', explanation: 'Coordinated deck transitions.', evidenceCount: 3, evidenceLimited: false, comparison: null, detectorVersion: 'actions-v1', evidence: [{ signalId: 10, canonicalId: 'deck.position', rawIdentity: 'Deck 1 Position', component: 'Deck', deckNumber: 1, atUtc: '2026-08-25T20:03:10.000Z', oldValue: 0, newValue: 1, originalQuality: 'Good', normalizedQuality: 'GOOD', explanation: 'Deck moved.' }, { signalId: 10, canonicalId: 'deck.position', rawIdentity: 'Deck 1 Position', component: 'Deck', deckNumber: 1, atUtc: '2026-08-25T20:03:20.000Z', oldValue: 1, newValue: 2, originalQuality: 'Good', normalizedQuality: 'GOOD', explanation: 'Deck moved again.' }, { signalId: 11, canonicalId: 'deck.mode', rawIdentity: 'Deck 1 Mode', component: 'Deck', deckNumber: 1, atUtc: '2026-08-25T20:03:30.000Z', oldValue: 'idle', newValue: 'setup', originalQuality: 'Good', normalizedQuality: 'GOOD', explanation: 'Deck entered setup.' }] }], notDirectlyConfirmed: [{ actionCode: 'CHOPOVER', displayName: 'Chopover', operatorConcept: null, confidence: 'UNKNOWN', startAt: null, endAt: null, explanation: 'No direct mapped evidence.', evidence: [], evidenceCount: 0, evidenceLimited: false, comparison: null, detectorVersion: 'actions-v1' }] },
})

describe('Stop Intelligence fleet overview', () => {
  it('keeps the new route active and the legacy Changeover route detached', () => {
    assert.equal(areaFromPathname('/stop-intelligence'), 'stop-intelligence')
    assert.equal(areaPath('stop-intelligence'), '/stop-intelligence')
    assert.match(app, /<StopIntelligencePage range={range} selectedPress={selectedPress}/)
    assert.doesNotMatch(app, /<ChangeoverIntelligencePage/)
  })

  it('renders fleet rows, precise physical-stop metrics, and classification counts', () => {
    assert.match(page, /si-press-row/)
    assert.match(page, /Total stop time/)
    assert.doesNotMatch(page, /Changeover physical stop/)
    assert.doesNotMatch(page, /Longest physical stop/)
    assert.deepEqual(stopFleetTotals([press(), press({ pressKey: 'press15' })]), { stops: 8, physicalSeconds: 4_800, changeovers: 2, downtime: 2, uncertain: 2, badData: 2 })
  })

  it('supports the five simple classification filters without changing backend authority', () => {
    assert.deepEqual(STOP_CLASSIFICATION_FILTERS.map(({ value }) => value), ['ALL', 'CHANGEOVER', 'DOWNTIME', 'UNCERTAIN', 'IGNORE_BAD_DATA'])
    assert.deepEqual(filterStopEpisodes(press().episodes, 'CHANGEOVER').map(({ stopId }) => stopId), ['c'])
    assert.equal(filterStopEpisodes(press().episodes, 'ALL').length, 4)
    assert.doesNotMatch(page, /setClassification|reclassif|reviewed_by|reviewed_at/i)
  })

  it('loads lightweight fleet data first and selected-stop detail only on episode selection', () => {
    assert.match(api, /getStopIntelligenceFleet/)
    assert.match(api, /getStopIntelligenceDetail/)
    assert.match(api, /getStopIntelligenceProductionAttributes/)
    assert.match(api, /\/api\/stop-intelligence\/fleet/)
    assert.match(api, /\/production-attributes\?\$\{rangeQuery/)
    assert.match(api, /\/stops\/\$\{encodeURIComponent\(input\.stopId\)\}/)
    assert.match(page, /onSelectSegment={openSegmentReview}/)
    assert.match(page, /id="stop-investigation"/)
    assert.match(page, /Close investigation/)
    assert.match(api, /if \(input\.includeRaw\) parameters\.set\('includeRaw', 'true'\)/)
    assert.match(page, /Load raw evidence/)
    assert.match(page, /includeRaw: true/)
    assert.match(page, /Loaded only when opened/)
    assert.match(page, /getStopIntelligenceProductionAttributes/)
    assert.match(types, /'NOT_LOADED'.*'PARTIAL'/)
  })

  it('uses one press at a time and shifts bounded windows by their exact duration', () => {
    assert.doesNotMatch(page, /All Presses/i)
    assert.match(page, /Press · one at a time/)
    assert.match(page, /Previous press/)
    assert.match(page, /Next press/)
    assert.equal(adjacentStopPress('press14', 1), 'press15')
    assert.equal(adjacentStopPress('press15', 1), 'press3')
    assert.equal(adjacentStopPress('press3', -1), 'press15')
    for (const pressKey of ['press3', 'press5', 'press6', 'press7', 'press8', 'press9', 'press10', 'press11', 'press12', 'press13', 'press14', 'press15']) assert.match(page, new RegExp(`'${pressKey}'`))
    const range = createStop72HourRange()
    assert.equal(Date.parse(range.toUtc) - Date.parse(range.fromUtc), 72 * 60 * 60_000)
    const next = shiftStopRange(range, 1)
    assert.equal(next.fromUtc, range.toUtc)
    assert.equal(Date.parse(next.toUtc) - Date.parse(next.fromUtc), 72 * 60 * 60_000)
    assert.match(page, /Last 72 hours/)
    assert.match(page, /maximum 72 hours/)
  })

  it('extends only the timeline start by one hour and preserves the selected end', () => {
    const initial = { preset: 'custom' as const, fromUtc: '2026-08-25T20:00:00.000Z', toUtc: '2026-08-25T23:00:00.000Z' }
    const first = extendStopRangeLookback(initial)
    const second = extendStopRangeLookback(first)
    assert.deepEqual([first.fromUtc, first.toUtc], ['2026-08-25T19:00:00.000Z', initial.toUtc])
    assert.deepEqual([second.fromUtc, second.toUtc], ['2026-08-25T18:00:00.000Z', initial.toUtc])
    const maximum = extendStopRangeLookback(createStop72HourRange())
    assert.equal(Date.parse(maximum.toUtc) - Date.parse(maximum.fromUtc), 72 * 60 * 60_000)
    assert.match(page, /Look back \+1 hour/)
    assert.match(page, /onRangeChange\(extendStopRangeLookback\(range\)\)/)
    assert.match(styles, /\.si-lookback-control/)
    const fleetRow = page.slice(page.indexOf('function FleetRow'), page.indexOf('export interface SpeedChartModel'))
    assert.ok(fleetRow.indexOf('si-press-metrics') < fleetRow.indexOf('si-range-extension-controls'))
    assert.ok(fleetRow.indexOf('si-range-extension-controls') < fleetRow.indexOf('<FleetTimeline'))
  })

  it('extends only the timeline end by one hour without passing now or 72 hours', () => {
    const initial = { preset: 'custom' as const, fromUtc: '2026-08-25T20:00:00.000Z', toUtc: '2026-08-25T23:00:00.000Z' }
    const now = DateTime.fromISO('2026-08-26T02:00:00.000Z')
    const first = extendStopRangeForward(initial, 1, now)
    const second = extendStopRangeForward(first, 1, now)
    assert.deepEqual([first.fromUtc, first.toUtc], [initial.fromUtc, '2026-08-26T00:00:00.000Z'])
    assert.deepEqual([second.fromUtc, second.toUtc], [initial.fromUtc, '2026-08-26T01:00:00.000Z'])
    const cappedAtNow = extendStopRangeForward(second, 4, now)
    assert.equal(cappedAtNow.toUtc, '2026-08-26T02:00:00.000Z')
    assert.match(page, /Look forward \+1 hour/)
    assert.match(page, /onRangeChange\(extendStopRangeForward\(range\)\)/)
    assert.match(styles, /\.si-lookforward-control/)
  })
})

describe('fleet timeline as the primary stop navigator', () => {
  const range = { fromUtc: '2026-08-25T19:45:00.000Z', toUtc: '2026-08-25T20:25:00.000Z' }
  const navigationPress = () => press({
    episodes: [
      { ...episode('DOWNTIME', 'down'), startAt: '2026-08-25T19:55:00.000Z', endAt: '2026-08-25T20:00:00.000Z', physicalDurationSeconds: 300, radiusStatusDescription: 'Web Break' },
      { ...episode('CHANGEOVER', 'change'), startAt: '2026-08-25T20:05:00.000Z', endAt: '2026-08-25T20:10:00.000Z', physicalDurationSeconds: 300 },
      { ...episode('UNCERTAIN', 'uncertain'), startAt: '2026-08-25T20:15:00.000Z', endAt: '2026-08-25T20:18:00.000Z', physicalDurationSeconds: 180 },
      { ...episode('IGNORE_BAD_DATA', 'bad'), startAt: '2026-08-25T20:20:00.000Z', endAt: '2026-08-25T20:22:00.000Z', physicalDurationSeconds: 120 },
    ],
    speedContext: { ...press().speedContext, unknownIntervals: [{ fromUtc: '2026-08-25T20:02:00.000Z', toUtc: '2026-08-25T20:03:00.000Z', state: 'SOURCE_TELEMETRY_UNAVAILABLE' }] },
  })

  it('builds continuous running, downtime, changeover, uncertain, and data-quality bands', () => {
    const segments = buildFleetBandSegments(navigationPress(), range, 'ALL')
    assert.equal(segments[0]?.startUtc, range.fromUtc)
    assert.equal(segments.at(-1)?.endUtc, range.toUtc)
    assert.ok(segments.some(({ kind, className, label }) => kind === 'running' && label === 'Good Run' && className?.includes('si-fleet-state--running')))
    for (const classification of ['downtime', 'changeover', 'uncertain', 'ignore_bad_data']) assert.ok(segments.some(({ className }) => className?.includes(`si-fleet-state--${classification}`)))
    assert.ok(segments.some(({ kind }) => kind === 'unknown'))
  })

  it('keeps every stop present under filters and only de-emphasizes nonmatches', () => {
    const segments = buildFleetBandSegments(navigationPress(), range, 'CHANGEOVER')
    assert.deepEqual(segments.filter(({ episode }) => episode).map(({ episode }) => episode!.stopId), ['down', 'change', 'uncertain', 'bad'])
    assert.equal(segments.find(({ episode }) => episode?.stopId === 'change')?.className?.includes('is-filter-muted'), false)
    assert.equal(segments.find(({ episode }) => episode?.stopId === 'down')?.className?.includes('is-filter-muted'), true)
  })

  it('keeps physical running visible until two over-9k rolls qualify with the second starting within one hour', () => {
    const value = navigationPress()
    value.episodes = value.episodes.map((item) => item.stopId === 'uncertain' ? { ...item, operationalClassification: 'CHANGEOVER', changeoverStabilizationId: 'phase-1' } : item)
    value.changeoverStabilizationPhases = [{
      stabilizationId: 'phase-1', triggerStopId: 'change', startAt: '2026-08-25T20:05:00.000Z', endAt: range.toUtc,
      status: 'STABILIZING', stabilizedAt: null, goodProductionStartAt: null, minimumRollLength: 9_000, requiredConsecutiveRolls: 2, completionWindowSeconds: 3_600,
      qualifyingRolls: [{ rollId: 'ROLL-A', startAt: '2026-08-25T20:08:00.000Z', productionStartAt: '2026-08-25T20:10:00.000Z', completedAt: '2026-08-25T20:14:00.000Z', completedLength: 17_135, unit: 'ft' }],
      continuationStopIds: ['uncertain'], reason: 'Awaiting a second qualifying roll.',
    }]
    const segments = buildFleetBandSegments(value, range, 'ALL')
    const trialRun = segments.find((item) => item.kind === 'running' && item.stabilizationPhase)
    const continuation = segments.find((item) => item.episode?.stopId === 'uncertain')
    assert.equal(trialRun?.label, 'Changeover · trial run')
    assert.equal(predictedFleetState(trialRun!), 'CHANGEOVER')
    assert.equal(continuation?.label, 'Changeover continuation')
    assert.equal(continuation?.episode?.classification, 'UNCERTAIN')
    assert.equal(predictedFleetState(continuation!), 'CHANGEOVER')
    assert.deepEqual(filterStopEpisodes(value.episodes, 'CHANGEOVER').map(({ stopId }) => stopId), ['change', 'uncertain'])
  })

  it('renders a stabilized sequence as one selectable Changeover event instead of separate stop and run blocks', () => {
    const value = navigationPress()
    value.episodes = [{ ...value.episodes[1]!, startAt: '2026-08-25T20:05:00.000Z', endAt: range.toUtc, classification: 'CHANGEOVER', operationalClassification: 'CHANGEOVER', mergedChangeover: true, constituentStopIds: ['change', 'uncertain'], eventDurationSeconds: 1_200, physicalDurationSeconds: 480, trialRunSeconds: 720, changeoverStabilizationId: 'phase-merged' }]
    value.changeoverStabilizationPhases = [{ stabilizationId: 'phase-merged', triggerStopId: 'change', startAt: '2026-08-25T20:05:00.000Z', endAt: range.toUtc, status: 'STABILIZING', stabilizedAt: null, goodProductionStartAt: null, minimumRollLength: 9_000, requiredConsecutiveRolls: 2, completionWindowSeconds: 3_600, qualifyingRolls: [], continuationStopIds: ['uncertain'], reason: 'Awaiting proof.' }]
    const segments = buildFleetBandSegments(value, range, 'ALL')
    const merged = segments.filter(({ episode }) => episode)
    assert.equal(merged.length, 1)
    assert.deepEqual([merged[0]!.startUtc, merged[0]!.endUtc, merged[0]!.label], ['2026-08-25T20:05:00.000Z', range.toUtc, 'CHANGEOVER'])
    assert.match(merged[0]!.details ?? '', /One merged Changeover event/)
    assert.match(merged[0]!.details ?? '', /physically stopped 8m 0s · trial running 12m 0s/)
  })

  it('aligns the speed trace to the same range and breaks it across UNKNOWN', () => {
    const track = buildFleetSpeedTrack(navigationPress())
    assert.equal(track.id, 'fleet-speed:press14')
    assert.equal(track.samples.length, 3)
    assert.equal(track.connectObservedGaps, true)
    assert.equal(track.interpolation, 'step')
    assert.equal(track.holdLastObservation, true)
    assert.equal(track.showCursorValue, true)
    assert.equal(track.breakIntervals?.length, 1)
    assert.equal(numericPaths(track.samples, Date.parse(range.fromUtc), Date.parse(range.toUtc) - Date.parse(range.fromUtc), 1_000, 88, track.connectObservedGaps, track.interpolation, track.holdLastObservation, [], []).paths.length, 1)
    assert.equal(numericPaths(track.samples, Date.parse(range.fromUtc), Date.parse(range.toUtc) - Date.parse(range.fromUtc), 1_000, 88, track.connectObservedGaps, track.interpolation, track.holdLastObservation, [], track.breakIntervals).paths.length, 2)
    assert.deepEqual(track.referenceLines?.map(({ value }) => value), [1, 595])
    assert.equal(numericValueAtCursor(track, '2026-08-25T20:06:00.000Z')?.value, 0)
    assert.equal(numericValueAtCursor(track, '2026-08-25T20:11:00.000Z')?.value, 700)
    const markerPress = navigationPress()
    markerPress.radiusContext.states = [
      { kind: 'radius', startUtc: range.fromUtc, endUtc: '2026-08-25T20:00:00.000Z', eventType: 'G', statusCode: '150', statusDescription: 'Run Production', isProduction: true },
      { kind: 'radius', startUtc: '2026-08-25T20:00:00.000Z', endUtc: range.toUtc, eventType: 'M', statusCode: '047', statusDescription: 'Make Ready', isProduction: false },
    ]
    const radiusMarker = buildFleetSpeedTrack(markerPress).markers?.[1]
    assert.deepEqual([radiusMarker?.label, radiusMarker?.kind, radiusMarker?.value], ['M047', 'radius-change', 0])
    assert.equal(radiusMarker?.color, radiusCodeStyle('M', '047').background)
    for (const detail of ['Code M047', 'Make Ready', 'Start ', 'End ', 'Duration ', 'Actual speed 0 ft/min']) assert.match(radiusMarker?.details ?? '', new RegExp(detail))
    assert.match(synchronizedTimeline, /<time>\{timeLabel\(inspectionUtc/)
    assert.match(page, /detail\.speedContext\.unit \?\? 'Unit unverified'/)
    assert.match(styles, /si-fleet-synchronized \.synchronized-timeline__numeric \{ height: 8\.4rem/)
    assert.match(styles, /synchronized-timeline__numeric-marker--radius-change::after/)
  })

  it('plots canonical actual roll length between Material and Raw Radius when the press exposes it', () => {
    const value = navigationPress()
    const track = buildFleetRollLengthTrack(value)
    assert.equal(track.label, 'Roll length (actual)')
    assert.equal(track.unit, 'ft')
    assert.deepEqual(track.samples.map(({ value }) => value), [0, 500, 0, 400])
    assert.equal(track.interpolation, 'linear')
    assert.equal(track.showCursorValue, true)
    assert.equal(buildFleetRollLengthTrack({ ...value, rollLengthContext: null }).samples.length, 0)
    assert.match(buildFleetRollLengthTrack({ ...value, rollLengthContext: null }).unavailableLabel ?? '', /unavailable on this press/)
    assert.match(page, /`numeric:\$\{rollLengthTrack\.id\}`[\s\S]*`interval:fleet-radius:/)
    assert.match(styles, /aria-label\^="Roll length \(actual\)"/)
  })

  it('adds discovered material and plate values below roll length only when the operator opens the toggle', () => {
    const value = press({ productionAttributeContext: [
      { attribute: 'WEB_WIDTH', label: 'Web width', rawIdentity: 'production_material_width', unit: 'inch', observations: [{ atUtc: '2026-08-25T19:45:00.000Z', value: 38, qualityState: 'GOOD' }, { atUtc: '2026-08-25T20:00:00.000Z', value: 40, qualityState: 'GOOD' }] },
      { attribute: 'FILM_THICKNESS', label: 'Film thickness', rawIdentity: 'production_material_thickness', unit: 'mil', observations: [{ atUtc: '2026-08-25T19:45:00.000Z', value: 2.5, qualityState: 'GOOD' }] },
    ] })
    const tracks = buildProductionAttributeTracks(value)
    assert.deepEqual(tracks.map(({ label }) => label), ['Web width', 'Film thickness'])
    assert.equal(tracks[0]?.showCursorValue, true)
    assert.equal(tracks[0]?.markers?.[0]?.label, '→ 40 inch')
    assert.match(fleetTimelineSource, /showProductionAttributes/)
    assert.match(fleetTimelineSource, /numeric:`\$\{rollLengthTrack\.id\}`|`numeric:\$\{rollLengthTrack\.id\}`/)
    assert.match(fleetTimelineSource, /visibleProductionAttributeTracks\.map[\s\S]*interval:fleet-radius/)
    assert.match(page, /Show'\} material &amp; plate values/)
  })

  it('keeps known Press 14 offline context quiet and emphasizes Press 15 data-quality warnings', () => {
    const press14 = navigationPress()
    press14.telemetryEvidenceState = 'SOURCE_TELEMETRY_UNAVAILABLE'
    press14.dataAvailabilityWarning = true
    const press15 = { ...press14, pressKey: 'press15' as const, displayName: 'Press 15' }
    const press14Unknown = buildFleetBandSegments(press14, range, 'ALL').find(({ kind }) => kind === 'unknown')
    const press15Unknown = buildFleetBandSegments(press15, range, 'ALL').find(({ kind }) => kind === 'unknown')
    assert.equal(shouldEmphasizeAvailability(press14), false)
    assert.equal(shouldEmphasizeAvailability(press15), true)
    assert.match(press14Unknown?.className ?? '', /si-fleet-state--known-offline/)
    assert.equal(press14Unknown?.unavailable, false)
    assert.match(press15Unknown?.className ?? '', /si-fleet-state--unknown/)
    assert.equal(press15Unknown?.unavailable, true)
  })

  it('provides compact stop and running hover snapshots without technical codes', () => {
    const value = navigationPress(); const segments = buildFleetBandSegments(value, range, 'ALL')
    const stop = fleetHoverSnapshot(value, segments, '2026-08-25T20:06:00.000Z')
    assert.equal(stop.segment?.episode?.stopId, 'change')
    assert.equal(stop.segment?.episode?.radiusStatusDescription, 'Run Production')
    assert.equal(stop.radius?.statusCode, '150')
    assert.equal(stop.order?.value, 'ORD-100')
    assert.equal(stop.recipe?.value, 'REC-A')
    assert.equal(stop.material?.value, 'MAT-B')
    const running = fleetHoverSnapshot(value, segments, '2026-08-25T19:50:00.000Z')
    assert.equal(running.segment?.kind, 'running')
    assert.equal(running.nearestSpeed?.speed, 800)
    const censoredValue = navigationPress(); censoredValue.episodes = [{ ...censoredValue.episodes[0]!, leftCensored: true, physicalDurationSeconds: 600 }]
    const censored = buildFleetBandSegments(censoredValue, range, 'ALL').find(({ episode }) => episode)
    assert.match(censored?.details ?? '', /Start before available evidence/)
    assert.match(censored?.details ?? '', /At least 10m 0s/)
    assert.doesNotMatch(timeline, /primaryReasonCodes/)
  })

  it('renders Stop Intelligence hover and investigation timestamps in Central Time', () => {
    assert.equal(formatPlantDateTimeCt('2026-08-25T20:00:00.000Z'), 'Aug 25, 3:00:00 PM CT')
    const stopIntelligenceSources = [page, timeline, chronology, deckStatus, synchronizedTimeline].join('\n')
    assert.doesNotMatch(stopIntelligenceSources, /timeZone:\s*['"]UTC['"]/)
    assert.doesNotMatch(stopIntelligenceSources, /\+\s*['"] UTC['"]/)
    assert.match(page, /formatPlantDateTimeCt\(value\)/)
    assert.match(timeline, /formatPlantDateTimeCt\(value\)/)
    assert.match(chronology, /formatPlantDateTimeCt\(action\.startAt!\)/)
    assert.match(deckStatus, /formatPlantDateTimeCt\(startUtc\)/)
    assert.match(synchronizedTimeline, /Wall clock · CT/)
  })

  it('uses the shared crosshair and direct block selection with persistent highlighting', () => {
    assert.doesNotMatch(fleetTimelineSource, /renderInspectionTooltip/)
    assert.doesNotMatch(page, /si-fleet-tooltip/)
    assert.match(page, /showCursorValue: true/)
    assert.match(styles, /synchronized-timeline__numeric-cursor-value/)
    assert.match(page, /selectedId === episode\.stopId \? 'is-selected'/)
    assert.match(page, /if \(segment\) onSelectSegment\(segment\)/)
    assert.match(styles, /si-fleet-state--running[^}]*#31825d/)
    assert.match(styles, /si-fleet-state--downtime[^}]*#b64743/)
    assert.match(styles, /si-fleet-state--changeover[^}]*#2c72a8/)
    assert.match(styles, /si-fleet-track--state \.synchronized-timeline__interval,[\s\S]*?cursor: pointer/)
    for (const track of ['Raw Radius', 'Stop State · predicted', 'Operator-reviewed state', 'Order', 'Recipe', 'Material', 'Roll length \\(actual\\)', 'Actual speed']) assert.match(page, new RegExp(track))
  })

  it('places identity above Radius and uses stable family-aware colors for exact values', () => {
    const orderPosition = page.indexOf('label: \'Order\'')
    const recipePosition = page.indexOf('label: \'Recipe\'')
    const materialPosition = page.indexOf('label: \'Material\'')
    const radiusPosition = page.indexOf("label: 'Raw Radius'")
    const stopPosition = page.indexOf("label: 'Stop State · predicted'")
    assert.ok(orderPosition < recipePosition && recipePosition < materialPosition && materialPosition < radiusPosition && radiusPosition < stopPosition)
    assert.match(page, /`interval:fleet-recipe:[\s\S]*`interval:fleet-material:[\s\S]*`numeric:\$\{rollLengthTrack\.id\}`[\s\S]*`interval:fleet-radius:/)
    assert.deepEqual(radiusCodeStyle('G', '150'), radiusCodeStyle('G', '150'))
    assert.match(String(radiusCodeStyle('G', '150')?.background), /^hsl\(1[3-4]\d /)
    assert.match(String(radiusCodeStyle('M', '210')?.background), /^hsl\(2[0-1]\d /)
    assert.match(String(radiusCodeStyle('B', '310')?.background), /^hsl\([23]\d /)
    assert.notEqual(radiusCodeStyle('M', '210')?.background, radiusCodeStyle('M', '220')?.background)
    assert.notEqual(identityValueStyle('production.order', 0)?.background, identityValueStyle('production.order', 1)?.background)
    assert.notEqual(identityValueStyle('production.recipe', 0)?.background, identityValueStyle('production.recipe', 1)?.background)
    assert.notEqual(identityValueStyle('production.material', 0)?.background, identityValueStyle('production.material', 1)?.background)
    assert.match(styles, /si-fleet-radius--g[^}]*#31825d/)
    assert.match(styles, /si-fleet-radius--m[^}]*#326fa1/)
    assert.match(styles, /si-fleet-radius--b[^}]*#b56b26/)
    assert.match(page, /alwaysShowLabels: true/)
    assert.match(page, /si-fleet-radius--\$\{labelLane\}/)
    assert.match(styles, /si-fleet-track--identity[\s\S]*?min-height: 1\.55rem/)
    assert.match(styles, /si-fleet-track--identity \.synchronized-timeline__interval[\s\S]*?font-weight: 400/)
    assert.match(styles, /si-fleet-radius--above > span/)
    assert.match(styles, /si-fleet-radius--below > span/)
    assert.match(page, /details: `Code \$\{value\}\\n\$\{state\.statusDescription/)
    assert.match(page, /\\nStart \$\{localTime\(state\.startUtc\)\}\\nEnd \$\{localTime\(state\.endUtc\)\}/)
    assert.match(styles, /si-fleet-track--radius \.synchronized-timeline__interval \{ cursor: pointer/)
  })

  it('keeps predictions immutable and marks the exact confirmed or changed operator-reviewed slices', () => {
    const value = navigationPress(); value.episodes = [{ ...value.episodes[1]!, classification: 'CHANGEOVER', stopId: 'change', startAt: '2026-08-25T20:00:00.000Z', endAt: '2026-08-25T20:10:00.000Z' }]
    value.speedContext.unknownIntervals = []
    const segments = buildFleetBandSegments(value, range, 'ALL')
    const followingRun = segments.find((segment) => segment.kind === 'running' && segment.startUtc === '2026-08-25T20:10:00.000Z')!
    const correction: StopIntelligenceCorrection = { correctionId: 'correction-1', pressKey: 'press14', segmentKey: followingRun.id, fromUtc: followingRun.startUtc, toUtc: followingRun.endUtc, predictedState: predictedFleetState(followingRun), correctedState: 'CHANGEOVER', comment: null, createdAtUtc: '2026-08-26T01:00:00.000Z' }
    const reviewed = buildOperatorReviewedSegments(segments, [correction])
    const changeovers = reviewed.filter((segment) => segment.state === 'CHANGEOVER')
    assert.deepEqual(changeovers.map(({ startUtc, endUtc, reviewStatus }) => [startUtc, endUtc, reviewStatus]), [
      ['2026-08-25T20:00:00.000Z', '2026-08-25T20:10:00.000Z', 'predicted'],
      ['2026-08-25T20:10:00.000Z', range.toUtc, 'changed'],
    ])
    assert.equal(segments.find((segment) => segment.id === followingRun.id)?.kind, 'running')
    assert.match(changeovers[1]?.className ?? '', /is-operator-changed/)

    const predictedChangeover = segments.find((segment) => segment.episode?.stopId === 'change')!
    const confirmation: StopIntelligenceCorrection = { correctionId: 'confirmation-1', pressKey: 'press14', segmentKey: predictedChangeover.id, fromUtc: predictedChangeover.startUtc, toUtc: predictedChangeover.endUtc, predictedState: 'CHANGEOVER', correctedState: 'CHANGEOVER', comment: null, createdAtUtc: '2026-08-26T01:01:00.000Z' }
    const confirmed = buildOperatorReviewedSegments(segments, [correction, confirmation]).find((segment) => segment.reviewStatus === 'confirmed')!
    assert.match(confirmed.className ?? '', /is-operator-confirmed/)
    assert.match(confirmed.label, /✓ Confirmed/)
    assert.match(confirmed.details ?? '', /Operator confirmed/)
    assert.match(styles, /\.is-predicted[^}]*opacity: \.34/)
    assert.match(styles, /\.is-operator-confirmed::before[^}]*content: '✓'/)
    assert.equal(investigationSegmentForReviewedInterval(confirmed, segments)?.episode?.stopId, 'change')
    assert.equal(investigationSegmentForReviewedInterval(changeovers[1]!, segments)?.episode?.stopId, 'change')
    assert.match(page, /const intervalTracks = \[\.\.\.baseTracks, reviewedTrack\]/)
    assert.doesNotMatch(page, /hasVisibleCorrection/)
    assert.match(page, /onSelectSegment\(segment, 'investigate'\)/)
  })

  it('separates evidence investigation from state correction and includes Routine', () => {
    assert.match(api, /recordStopIntelligenceCorrection/)
    assert.match(page, /Investigate evidence/)
    assert.match(page, /operatorDecisionButtonLabel\(predicted, choice, saving\)/)
    assert.equal(operatorDecisionButtonLabel('CHANGEOVER', 'CHANGEOVER', false), 'Confirm')
    assert.equal(operatorDecisionButtonLabel('DOWNTIME', 'DOWNTIME', false), 'Confirm')
    assert.equal(operatorDecisionButtonLabel('CHANGEOVER', 'DOWNTIME', false), 'Save decision')
    assert.equal(confirmsPrediction('OBSERVABLE_NON_STOP', 'GOOD_PRODUCTION'), true)
    const confirmed: StopIntelligenceCorrection = { correctionId: 'confirmed', pressKey: 'press14', segmentKey: 'fleet:test', fromUtc: range.fromUtc, toUtc: range.toUtc, predictedState: 'CHANGEOVER', correctedState: 'CHANGEOVER', comment: null, createdAtUtc: range.toUtc }
    assert.equal(operatorDecisionActionsVisible(confirmed, 'CHANGEOVER'), false)
    assert.equal(operatorDecisionActionsVisible(confirmed, 'DOWNTIME'), true)
    assert.equal(operatorDecisionActionsVisible(undefined, 'CHANGEOVER'), true)
    assert.match(page, /showDecisionActions && <footer>/)
    assert.match(page, /Changing a saved confirmation/)
    assert.match(page, /value: 'ROUTINE'/)
    assert.match(page, /value: 'GOOD_PRODUCTION'/)
    const optionsSource = page.slice(page.indexOf('const CORRECTION_OPTIONS'), page.indexOf('const defaultCorrectionState'))
    assert.doesNotMatch(optionsSource, /value: 'UNCERTAIN'/)
    assert.match(page, /The predicted row stays unchanged/)
    assert.match(page, /Currently selected/)
    assert.match(page, /defaultCorrectionState\(predicted\)/)
    assert.match(page, /Comments <small>optional<\/small>/)
    assert.match(page, /maxLength=\{1_000\}/)
    assert.match(page, /comment: comment\.trim\(\) \|\| null/)
    assert.match(api, /comment\?: string \| null/)
    assert.match(page, /si-investigate-evidence-callout/)
    assert.match(page, /Investigate the bounded evidence/)
    assert.match(page, /Open the synchronized speed, Radius, identity, restart, and action evidence/)
    assert.match(page, /const intervalTracks = \[\.\.\.baseTracks, reviewedTrack\]/)
    assert.match(page, /`interval:fleet-state:\$\{press\.pressKey\}`, `numeric:\$\{speedTrack\.id\}`, `interval:\$\{reviewedTrack\.id\}`/)
    assert.doesNotMatch(styles, /si-fleet-track--changeover-stages/)
    assert.match(styles, /aria-label\^="Actual speed"\]\) \{ order: 9 !important/)
    assert.match(styles, /si-fleet-track--reviewed \{ order: 10 !important/)
    assert.match(styles, /si-correction-dialog/)
    assert.match(styles, /:root:not\(\[data-theme="dark"\]\) \.si-decision/)
  })

  it('restores the latest operator decision by timestamp even when a reconstructed segment key changes', () => {
    const segment = buildFleetBandSegments(navigationPress(), range, 'ALL').find(({ kind }) => kind === 'episode')!
    const older: StopIntelligenceCorrection = { correctionId: 'older', pressKey: 'press14', segmentKey: 'old-segment-key', fromUtc: segment.startUtc, toUtc: segment.endUtc, predictedState: 'CHANGEOVER', correctedState: 'CHANGEOVER', comment: null, createdAtUtc: '2026-08-26T01:00:00.000Z' }
    const latest: StopIntelligenceCorrection = { ...older, correctionId: 'latest', segmentKey: 'another-old-key', correctedState: 'DOWNTIME', createdAtUtc: '2026-08-26T02:00:00.000Z' }
    assert.equal(latestOperatorDecisionForSegment(segment, [older, latest])?.correctionId, 'latest')
    assert.match(page, /latestOperatorDecisionForSegment\(correctionTarget/)
    assert.match(page, /restored by its timestamp/)
  })
})

describe('selected physical-stop investigation', () => {
  it('keeps speed behavior in the physical timeline instead of presenting it as an action', () => {
    assert.doesNotMatch(timeline, /case 'TRIAL_RUN'|case 'FAILED_RECOVERY'|case 'PHYSICAL_RECOVERY'/)
    const model = buildStopTimelineModel(visualDetail())
    assert.deepEqual([...new Set(model.intervalTracks.find(({ id }) => id === 'physical')?.intervals.map(({ label }) => label.replace(/ #\d+$/, '')))], ['Running', 'Stopped', 'Testing'])
  })

  it('shows classification, confidence, physical duration, speed-only testing count, and structured evidence groups', () => {
    for (const value of ['Classification', 'Confidence', 'Physical stop', 'Testing', 'Why this classification?', 'Supporting', 'Conflicting', 'Missing / unavailable']) assert.match(page, new RegExp(value.replace(/[?]/g, '\\?'), 'i'))
    assert.match(page, /item\.explanation/)
    assert.match(page, /item\.code/)
  })

  it('makes a Radius Run Production contradiction explicit and preserves exact raw status fields', () => {
    assert.match(page, /CONTRADICTORY/)
    assert.match(page, /state\.eventType/)
    assert.match(page, /state\.statusCode/)
    assert.match(page, /state\.statusDescription/)
    assert.match(timeline, /si-radius-production/)
  })

  it('presents censoring, collection gaps, speed quality, and UNKNOWN separately from zero', () => {
    for (const value of ['Left boundary', 'Right boundary', 'UNKNOWN intervals', 'UNKNOWN is never treated as zero']) assert.match(page, new RegExp(value))
    assert.match(types, /SOURCE_TELEMETRY_UNAVAILABLE/)
    assert.match(types, /UNKNOWN_SPEED_QUALITY/)
    assert.match(page, /leftCensored/)
    assert.match(page, /rightCensored/)
  })

  it('draws exact stop and recovery thresholds and breaks the speed trace across unknown evidence', () => {
    const detail = { speedContext: { fromUtc: '2026-08-25T19:45:00.000Z', toUtc: '2026-08-25T20:25:00.000Z', stopThreshold: 1, recoveryThreshold: 595, unit: 'ft/min', observations: [{ atUtc: '2026-08-25T19:50:00.000Z', speed: 800, qualityState: 'GOOD' }, { atUtc: '2026-08-25T20:00:00.000Z', speed: 0, qualityState: 'GOOD' }, { atUtc: '2026-08-25T20:05:00.000Z', speed: null, qualityState: 'BAD' }, { atUtc: '2026-08-25T20:10:00.000Z', speed: 700, qualityState: 'GOOD' }], unknownIntervals: [{ fromUtc: '2026-08-25T20:05:00.000Z', toUtc: '2026-08-25T20:10:00.000Z', state: 'SOURCE_TELEMETRY_UNAVAILABLE' }] } } as StopIntelligenceDetail
    const model = buildStopSpeedChartModel(detail)
    assert.equal(model.unknown.length, 1)
    assert.equal(model.paths.length, 2)
    assert.match(timeline, /`Stop < \$\{detail\.speedContext\.stopThreshold\}`/)
    assert.match(timeline, /`Recovery ≥ \$\{detail\.speedContext\.recoveryThreshold\}`/)
    assert.match(timeline, /Physical stop/)
    assert.match(timeline, /Physical recovery/)
  })

  it('shows compact aligned restart attempts and press-specific identity without assuming Order', () => {
    for (const value of ['Movement / restart attempts', 'Peak', 'averageSpeed', 'Reached recovery threshold', 'Below recovery threshold', 'Identity context', 'Before', 'After', 'Settled']) assert.match(page, new RegExp(value, 'i'))
    assert.match(page, /words\(identity\.field\)/)
    assert.match(page, /identity\.canonicalId/)
    assert.doesNotMatch(page, /primaryIdentity.*field === 'order'/)
  })

  it('keeps setup classification evidence at family level while action discovery avoids a required stage sequence', () => {
    assert.match(page, /Setup family evidence · not a required stage sequence/)
    assert.match(page, /COORDINATED/)
    assert.match(timeline, /id: 'actions'/)
    assert.doesNotMatch(page, /EASY-REG|EASY-SET/i)
  })

  it('shows action evidence for every evaluated physical stop and retains a defensive unavailable fallback', () => {
    assert.match(page, /if \(!analysis\.eligible\)/)
    assert.match(page, /Changeover actions and raw evidence by confidence and stop phase/)
    assert.match(timeline, /detail\.changeoverActions\.actions/)
    assert.match(types, /'DETECTED' \| 'INFERRED' \| 'UNKNOWN'/)
    assert.match(page, /this does not mean it did not happen/)
  })

  it('keeps detailed action evidence expandable, exact, and bounded in the DOM', () => {
    for (const field of ['signalId', 'canonicalId', 'rawIdentity', 'deckNumber', 'oldValue', 'newValue', 'originalQuality', 'normalizedQuality']) assert.match(page, new RegExp(`evidence\\.${field}`))
    assert.match(page, /action\.evidence\.slice\(0, 12\)/)
    assert.match(page, /detector grouped the complete burst/)
    assert.match(page, /action\.evidenceLimited/)
    assert.match(page, /action\.comparison\.interpretation/)
  })

  it('keeps unmapped branded and cutting stages available as explicitly unconfirmed action codes', () => {
    assert.match(page, /Not directly confirmed/)
    for (const code of ['VISTAPORT_ACTIVITY', 'CHOPOVER', 'KNIFE_CUTTING_ACTIVITY', 'MASTER_IMAGE_RUN']) assert.match(types, new RegExp(code))
  })

  it('has explicit loading, empty, fleet error, and selected-detail error states', () => {
    assert.match(page, /Loading \{activePress\.replace\('press', 'Press '\)\} stop context/)
    assert.match(page, /resolvedScopeKey !== scopeKey/)
    assert.match(page, /const currentReport = resolvedScopeKey === scopeKey/)
    assert.doesNotMatch(page, /The selected Stop Intelligence press is unavailable/)
    assert.match(page, /No Stop Intelligence data was returned for this press and time window/)
    assert.match(page, /No physical stops were detected/)
    assert.match(page, /Stop evidence unavailable/)
    assert.match(page, /Selected stop unavailable/)
    assert.match(page, /Loading bounded evidence for the selected physical stop/)
  })
})

describe('visual-first synchronized investigation model', () => {
  it('keeps the activity breakdown out of the fleet timeline and collapsed by default in Visual Investigation', () => {
    const report = press()
    assert.equal(report.episodes.every(({ changeoverActivityWindows }) => changeoverActivityWindows.length === 0), true)
    assert.doesNotMatch(fleetTimelineSource, /predictedChangeoverStages|stageTrack|Predicted changeover stages/)
    assert.match(timeline, /detail\.changeoverActivityWindows\?\.length/)
    assert.match(timeline, /showStageBreakdown.*useState\(false\)/)
    assert.match(timeline, /Stage breakdown/)
    assert.match(timeline, /includeStageBreakdown/)
    assert.match(timeline, /id: `changeover-stage-/)
    assert.doesNotMatch(fleetTimelineSource, /Changeover stages · selected stop|detailLoading|detail\.stopId/)
    assert.doesNotMatch(fleetTimelineSource, /fleet-changeover-stages/)
  })

  it('keeps Visual Investigation capable of distinguishing fallback stage evidence', () => {
    assert.match(timeline, /stage\.source === 'RADIUS_FALLBACK'/)
    assert.match(timeline, /is-radius-fallback/)
    assert.match(styles, /si-changeover-stage\.is-radius-fallback/)
  })

  it('uses one ordered axis and separate aligned rows for overlapping changeover activity windows', () => {
    const model = buildStopTimelineModel(visualDetail())
    const stageRows = [...new Set(visualDetail().changeoverActivityWindows.map(({ kind }) => `changeover-stage-${kind}`))]
    assert.deepEqual(model.trackOrder, [...Array.from({ length: 10 }, (_, index) => `interval:deck-status-${index + 1}`), 'numeric:actual-speed', 'interval:physical', 'interval:radius', ...stageRows.map((id) => `interval:${id}`), 'interval:identity', 'interval:actions'])
    assert.deepEqual(model.intervalTracks.map(({ id }) => id), [...Array.from({ length: 10 }, (_, index) => `deck-status-${index + 1}`), 'physical', 'radius', ...stageRows, 'identity', 'actions'])
    assert.equal(model.intervalTracks.filter(({ className }) => className === 'si-changeover-stage-row').every(({ intervals }) => intervals.length >= 1), true)
    assert.match(styles, /si-changeover-stage-row \{ min-height: \.9rem/)
    assert.match(styles, /si-changeover-stage-row \.synchronized-timeline__track \{ min-height: \.72rem; height: \.72rem/)
    assert.match(styles, /si-changeover-stage-row \.synchronized-timeline__interval > span \{ display: none/)
    assert.equal(buildStopTimelineModel(visualDetail(), [], undefined, false).intervalTracks.some(({ id }) => id.startsWith('changeover-stage-')), false)
    assert.deepEqual(model.numericTracks.map(({ id }) => id), ['actual-speed'])
    assert.deepEqual([model.numericTracks[0]?.connectObservedGaps, model.numericTracks[0]?.interpolation, model.numericTracks[0]?.holdLastObservation], [true, 'step', true])
    assert.equal(model.eventTracks.length, 0)
    assert.equal(model.intervalTracks.find(({ id }) => id === 'radius')?.intervals[0]?.startUtc, '2026-08-25T19:45:00.000Z')
    assert.ok(model.intervalTracks.find(({ id }) => id === 'physical')?.intervals.some(({ label, className }) => label === 'Testing #1' && className === 'si-physical-testing'))
    assert.equal(model.intervalTracks.some(({ id }) => id === 'availability'), false)
    const radius = model.intervalTracks.find(({ id }) => id === 'radius')?.intervals[0]
    assert.deepEqual([radius?.label, radius?.compactLabel], ['Run Production', 'RUN100'])
    assert.deepEqual(model.intervalTracks.filter(({ id }) => id.startsWith('changeover-stage-')).flatMap(({ intervals }) => intervals.map(({ label }) => label)), ['Job Out', 'Washing of Ink', 'Registration Setup', 'Impression Setup', 'Color Check'])
    assert.equal(model.intervalTracks.filter(({ id }) => id.startsWith('changeover-stage-')).flatMap(({ intervals }) => intervals).every(({ startUtc, endUtc }) => Date.parse(startUtc) >= Date.parse(visualDetail().speedContext.fromUtc) && Date.parse(endUtc) <= Date.parse(visualDetail().speedContext.toUtc)), true)
    assert.match(timeline, /hoveredStage\.evidenceDetails\.map/)
    assert.deepEqual(model.intervalTracks.find(({ id }) => id === 'identity')?.intervals.map(({ style }) => style?.background), [identityValueStyle('production.order', 0)?.background, identityValueStyle('production.order', 1)?.background])
    assert.notEqual(investigationRadiusCodeStyle('M', '47')?.background, investigationRadiusCodeStyle('M', '48')?.background)
  })

  it('plots raw/canonical signal tracks automatically and keeps them bounded to the selected action', () => {
    const detail = visualDetail(); const action = detail.changeoverActions.actions[0]!
    const hidden = buildStopTimelineModel(detail)
    const visible = buildStopTimelineModel(detail, action)
    const selected = buildSelectedSignalTracks(action, detail.actionSignalContext, detail.speedContext.fromUtc, detail.speedContext.toUtc)
    assert.equal(hidden.numericTracks.length, 1)
    assert.equal(hidden.eventTracks.length, 0)
    assert.equal(selected.numeric.length, 1)
    assert.equal(selected.intervals.length, 1)
    assert.equal(selected.events.length, 0)
    assert.equal(visible.numericTracks.length, 2)
    assert.equal(visible.eventTracks.length, 0)
    assert.ok(visible.intervalTracks.some(({ id }) => id.startsWith('selected-signal:')))
    assert.equal(selected.numeric[0]?.samples[0]?.observedAtUtc, detail.speedContext.fromUtc)
    assert.equal(selected.numeric[0]?.holdLastObservation, true)
    assert.deepEqual(selected.numeric[0]?.highlightedRanges?.map(({ fromUtc, toUtc }) => [fromUtc, toUtc]), [[action.startAt, action.endAt]])
    assert.ok(selected.numeric[0]?.markers?.some(({ atUtc }) => atUtc === '2026-08-25T20:03:10.000Z'))
    const snapshots = selectedSignalSnapshots(detail, [action], '2026-08-25T20:04:00.000Z')
    assert.deepEqual(snapshots.map(({ observation }) => observation?.value), ['setup', 2])
    assert.deepEqual(snapshots.flatMap(({ changes }) => changes).map(({ signalId }) => signalId), [11, 10, 10])
    const hoveredTrackSnapshots = selectedSignalSnapshots(detail, [action], '2026-08-25T20:04:00.000Z', selected.numeric[0]!.id)
    assert.equal(hoveredTrackSnapshots.length, 1)
    assert.equal(hoveredTrackSnapshots[0]?.label, selected.numeric[0]?.label)
    assert.doesNotMatch(selected.numeric[0]?.label ?? '', /Deck 2/)
    assert.match(timeline, /At cursor/)
    assert.match(timeline, /change\.oldValue/)
    assert.match(timeline, /change\.newValue/)
  })

  it('uses deck-specific track identity so a hovered selected signal reports only that deck', () => {
    const detail = visualDetail(); const action = detail.changeoverActions.actions[0]!
    const deckTwo = { ...detail.actionSignalContext[0]!, signalId: 10, rawIdentity: 'Deck 2 Position', component: 'Deck 2', deckNumber: 2, observations: [{ atUtc: detail.speedContext.fromUtc, value: 0, qualityState: 'GOOD' }, { atUtc: '2026-08-25T20:03:15.000Z', value: 4, qualityState: 'GOOD' }] }
    detail.actionSignalContext[2] = deckTwo
    action.evidence.push({ ...action.evidence[0]!, rawIdentity: 'Deck 2 Position', deckNumber: 2, atUtc: '2026-08-25T20:03:15.000Z', oldValue: 0, newValue: 4 })
    const contexts = selectedActionSignalContext(detail.actionSignalContext, action)
    const deckTracks = contexts.filter(({ canonicalId }) => canonicalId === 'deck.position')
    assert.equal(deckTracks.length, 2)
    assert.notEqual(actionSignalTrackKey(deckTracks[0]!), actionSignalTrackKey(deckTracks[1]!))
    const hovered = selectedSignalSnapshots(detail, [action], '2026-08-25T20:04:00.000Z', `signal:${actionSignalTrackKey(deckTracks[0]!)}`, contexts.map(actionSignalTrackKey))
    assert.equal(hovered.length, 1)
    assert.equal(hovered[0]?.changes.every(({ deckNumber }) => deckNumber === deckTracks[0]?.deckNumber), true)
  })

  it('wires per-signal eye visibility and pins into the plotted signal-key set', () => {
    const detail = visualDetail(); const action = detail.changeoverActions.actions[0]!
    const keys = selectedActionSignalContext(detail.actionSignalContext, action).map(actionSignalTrackKey)
    const oneVisible = buildStopTimelineModel(detail, action, [keys[0]!])
    const plottedSignalRows = oneVisible.numericTracks.filter(({ id }) => id.startsWith('signal:')).length + oneVisible.intervalTracks.filter(({ id }) => id.startsWith('selected-signal:')).length
    assert.equal(plottedSignalRows, 1)
    const allHidden = buildStopTimelineModel(detail, action, [])
    assert.equal(allHidden.numericTracks.filter(({ id }) => id.startsWith('signal:')).length + allHidden.intervalTracks.filter(({ id }) => id.startsWith('selected-signal:')).length, 0)
    assert.match(page, /Selected action signal visibility and pins/)
    assert.match(page, /hiddenSignalKeys/)
    assert.match(page, /pinnedSignalKeys/)
    assert.match(page, /visibleSignalKeys=\{visibleSignalKeys\}/)
    assert.match(page, /hiddenSignalKeys=\{hiddenSignalKeys\}/)
    assert.match(page, /onToggleHiddenSignal=\{toggleHiddenSignal\}/)
    assert.match(timeline, /renderTrackLabelControls/)
    assert.match(timeline, /si-signal-row-controls/)
    assert.match(page, /Hide.*trend/)
    assert.match(page, /Pin.*trend/)
    assert.match(styles, /si-selected-signal-controls/)
    assert.match(styles, /si-signal-pin\[aria-pressed="true"\]/)
  })

  it('separates action changes before, during, after recovery run mode, and unknown timing', () => {
    const segment = visualDetail().stop.physicalSegment
    const base = visualDetail().changeoverActions.actions[0]!
    assert.equal(actionTimingPhase({ ...base, startAt: '2026-08-25T19:50:00.000Z', endAt: '2026-08-25T19:59:00.000Z' }, segment), 'BEFORE_STOP')
    assert.equal(actionTimingPhase(base, segment), 'DURING_STOP')
    assert.equal(actionTimingPhase({ ...base, startAt: '2026-08-25T20:11:00.000Z', endAt: '2026-08-25T20:12:00.000Z' }, segment), 'AFTER_STOP_RUN')
    assert.equal(actionTimingPhase({ ...base, startAt: null, endAt: null }, segment), 'TIMING_UNKNOWN')
    assert.match(page, /si-action-matrix__row/)
    assert.match(page, /si-action-matrix__cell/)
    assert.match(styles, /max-height: 34rem/)
    assert.match(page, /useState<string\[\]>\(\[\]\)/)
    for (const label of ['Before stop', 'During physical stop', 'After stop · run mode']) assert.match(page, new RegExp(label))
    assert.doesNotMatch(page, /Timing not established/)
    const rows = evidenceChronologyRows(visualDetail())
    assert.equal(rows.some(({ physical }) => physical === 'running'), true)
    assert.equal(rows.some(({ physical }) => physical === 'stopped'), true)
    assert.equal(rows.some(({ physical }) => physical === 'testing'), true)
    assert.equal(rows.flatMap(({ mapped }) => mapped).some(({ action }) => action.displayName === 'Deck movement'), true)
    const markers = evidenceChronologyMarkers(visualDetail())
    assert.equal(markers.mapped.some(({ action }) => action.displayName === 'Deck movement'), true)
    assert.match(chronology, /Mapped actions above · raw \/ unmapped below/)
    assert.match(chronology, /si-evidence-horizontal__rail/)
    assert.match(chronology, /si-evidence-horizontal__lane--mapped/)
    assert.match(chronology, /si-evidence-horizontal__lane--raw/)
  })

  it('uses one replaceable action selection and toggles the same action or group off', () => {
    assert.deepEqual(toggledActionSelection([], ['pump-1']), ['pump-1'])
    assert.deepEqual(toggledActionSelection(['pump-1'], ['pump-1']), [])
    assert.deepEqual(toggledActionSelection(['pump-1'], ['wash-1']), ['wash-1'])
    assert.deepEqual(toggledActionSelection(['raw-1', 'raw-2'], ['raw-1', 'raw-2']), [])
    assert.deepEqual(toggledActionSelection(['pump-1'], ['raw-1', 'raw-2']), ['raw-1', 'raw-2'])
    assert.match(page, /setSelectedActionKeys\(\(current\) => toggledActionSelection\(current, keys\)\)/)
    assert.match(page, /Select it again to clear the plotted signals/)
  })

  it('groups repeated detected actions into numbered instances and supports plotting all instances', () => {
    const detail = visualDetail(); const first = detail.changeoverActions.actions[0]!
    detail.changeoverActions.actions.push({ ...first, startAt: '2026-08-25T20:08:00.000Z', endAt: '2026-08-25T20:08:30.000Z', evidence: first.evidence.map((evidence) => ({ ...evidence, atUtc: '2026-08-25T20:08:10.000Z' })) })
    const groups = groupChangeoverActions(detail.changeoverActions.actions)
    assert.equal(groups.length, 1)
    assert.deepEqual(groups[0]?.instances.map(({ number }) => number), [1, 2])
    const model = buildStopTimelineModel(detail, groups[0]!.instances.map(({ action }) => action))
    assert.ok(model.numericTracks.some(({ id }) => id.startsWith('signal:')))
  })

  it('forces an actual-speed trace break across explicit UNKNOWN evidence', () => {
    const samples = [{ observedAtUtc: '2026-08-25T20:00:00.000Z', receivedAtUtc: '2026-08-25T20:00:00.000Z', sourceTimestampUtc: null, qualityState: 'GOOD', valueKind: 'numeric' as const, value: 0 }, { observedAtUtc: '2026-08-25T20:01:00.000Z', receivedAtUtc: '2026-08-25T20:01:00.000Z', sourceTimestampUtc: null, qualityState: 'GOOD', valueKind: 'numeric' as const, value: 700 }]
    const geometry = numericPaths(samples, Date.parse('2026-08-25T20:00:00.000Z'), 60_000, 1_000, 88, true, 'linear', false, [], [{ fromUtc: '2026-08-25T20:00:20.000Z', toUtc: '2026-08-25T20:00:40.000Z' }])
    assert.equal(geometry.paths.length, 2)
  })

  it('puts overlapping detected actions in aligned lanes and retains them for downtime review', () => {
    const detail = visualDetail()
    detail.changeoverActions.actions.push({ ...detail.changeoverActions.actions[0]!, actionCode: 'WASH_ACTIVITY', displayName: 'Wash activity', startAt: '2026-08-25T20:03:30.000Z', endAt: '2026-08-25T20:04:30.000Z' })
    const overlapTracks = buildStopTimelineModel(detail).intervalTracks.filter(({ id }) => id.startsWith('actions'))
    assert.deepEqual(overlapTracks.map(({ id }) => id), ['actions', 'actions-2'])
    const actionIntervals = overlapTracks.flatMap(({ intervals }) => intervals)
    assert.equal(new Set(actionIntervals.map(({ style }) => style?.background)).size, 2)
    assert.equal(actionIntervals[0]?.details, 'Deck movement')
    assert.notEqual(actionBandColor('DECK_MOVEMENT'), actionBandColor('WASH_ACTIVITY'))
    detail.stop.classification = 'DOWNTIME'; detail.changeoverActions.eligible = true; detail.changeoverActions.reason = 'Derived action discovery runs for every selected physical stop.'
    const downtimeActions = buildStopTimelineModel(detail).intervalTracks.find(({ id }) => id === 'actions')!
    assert.ok(downtimeActions.intervals.length > 0)
    assert.equal(downtimeActions.unavailableLabel, undefined)
  })

  it('keeps raw/unmapped tags out of action bands and presents them as the final evidence-matrix category', () => {
    const detail = visualDetail(); const raw = { ...detail.changeoverActions.actions[0]!, actionCode: 'UNCANONICALIZED_RAW_ACTIVITY' as const, displayName: 'P15.Unmapped.WashValve', startAt: '2026-08-25T20:05:00.000Z', endAt: '2026-08-25T20:05:10.000Z', evidence: [{ ...detail.changeoverActions.actions[0]!.evidence[0]!, signalId: null, canonicalId: null, rawIdentity: 'P15.Unmapped.WashValve', component: 'P15.Unmapped.WashValve' }] }
    detail.changeoverActions.actions.push(raw)
    const model = buildStopTimelineModel(detail)
    assert.equal(model.intervalTracks.filter(({ id }) => id.startsWith('actions')).flatMap(({ intervals }) => intervals).some(({ id }) => id.includes('UNCANONICALIZED_RAW_ACTIVITY')), false)
    const rawGroup = groupChangeoverActions(detail.changeoverActions.actions).find(({ actionCode }) => actionCode === 'UNCANONICALIZED_RAW_ACTIVITY')
    assert.equal(rawGroup?.displayName, 'P15.Unmapped.WashValve')
    assert.match(page, /These observations are evidence, not named actions/)
    assert.match(page, /rawEvidenceRow.*confidenceRow\('UNKNOWN'/s)
    const rows = evidenceChronologyRows(detail)
    assert.equal(rows.flatMap(({ raw }) => raw).some(({ action }) => action.displayName === 'P15.Unmapped.WashValve'), true)
    assert.equal(rows.flatMap(({ mapped }) => mapped).some(({ action }) => action.displayName === 'P15.Unmapped.WashValve'), false)
    assert.match(chronology, /Raw \/ unmapped/)
  })

  it('matches an exact changed deck when multiple decks share one raw array identity', () => {
    const detail = visualDetail(); const action = detail.changeoverActions.actions[0]!
    const shared = 'Press 14.deck.position'
    detail.actionSignalContext = [
      { ...detail.actionSignalContext[0]!, rawIdentity: shared, signalId: 10, deckNumber: 1 },
      { ...detail.actionSignalContext[2]!, rawIdentity: shared, signalId: 10, deckNumber: 2 },
    ]
    action.evidence = [{ ...action.evidence[0]!, rawIdentity: shared, signalId: 10, canonicalId: 'deck.position', deckNumber: 1 }]
    assert.deepEqual(selectedActionSignalContext(detail.actionSignalContext, action).map(({ deckNumber }) => deckNumber), [1])
  })

  it('integrates compact Decks 1-10 tracks immediately above Actual Speed', () => {
    const detail = visualDetail()
    assert.deepEqual(detail.deckStatusContext.decks.map(({ deckNumber }) => deckNumber), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    assert.equal(deckStatusIntervalLabel(detail.deckStatusContext.decks[0]!.intervals[0]!.state), 'Printing')
    const tracks = buildDeckStatusTimelineTracks(detail)
    assert.deepEqual(tracks.map(({ id }) => id), Array.from({ length: 10 }, (_, index) => `deck-status-${index + 1}`))
    assert.equal(tracks[0]?.className, 'si-deck-timeline-row')
    assert.match(deckStatus, /deckNumber >= 1 && deckNumber <= 10/)
    assert.match(timeline, /buildDeckStatusTimelineTracks\(detail\)/)
    assert.doesNotMatch(timeline, /<StopDeckStatusGantt/)
    for (const state of ['state-printing', 'state-out', 'state-ready']) assert.match(styles, new RegExp(state))
  })

  it('resolves all tooltip rows from one inspection timestamp without converting UNKNOWN to zero', () => {
    const detail = visualDetail()
    const failed = stopInspectionSnapshot(detail, '2026-08-25T20:03:35.000Z')
    assert.equal(failed.physical, 'Testing #1')
    assert.equal(failed.radius?.statusDescription, 'Run Production')
    assert.equal(failed.identityValue, 'R-100')
    assert.deepEqual(failed.actions.map(({ displayName }) => displayName), ['Deck movement'])
    assert.doesNotMatch(timeline, /<dt>Actions<\/dt>/)
    const unknown = stopInspectionSnapshot(detail, '2026-08-25T20:06:30.000Z')
    assert.equal(unknown.availability, 'SOURCE_TELEMETRY_UNAVAILABLE')
    assert.equal(unknown.identityValue, 'R-200')
  })

  it('wires the shared crosshair, action selection, compact evidence, and collapsed drilldown', () => {
    assert.match(timeline, /<SynchronizedTimeline/)
    assert.match(timeline, /renderInspectionTooltip/)
    assert.match(timeline, /selectedId={selectedActionKey}/)
    assert.match(timeline, /track\.id\.startsWith\('actions'\)/)
    assert.match(synchronizedTimeline, /<b>{track\.label}<\/b><time>/)
    assert.match(synchronizedTimeline, /numericTrackLabel: hoveredNumericTrack\?\.label/)
    assert.match(synchronizedTimeline, /intervalItem: hovered/)
    assert.match(synchronizedTimeline, /focusInterval\(item, track\.id\)/)
    assert.match(synchronizedTimeline, /pointerX - canvasBounds\.left - \(canvasRef\.current\?\.clientLeft \?\? 0\)/)
    assert.match(synchronizedTimeline, /left: crosshairLeft === undefined \? undefined/)
    assert.match(timeline, /numericTrackLabel \?\? 'Timeline context'/)
    assert.match(timeline, /hoveredAction\.displayName/)
    assert.match(timeline, /ActionSignalTooltipRows signals={actionSignals}/)
    assert.match(styles, /\.si-investigation-timeline \.si-action-band \{ cursor: pointer/)
    assert.doesNotMatch(page, /Show signals/)
    assert.match(page, /signals plotted automatically/)
    assert.match(page, />All</)
    assert.match(page, /si-decision-evidence-chips/)
    assert.match(page, /Changeover requirement checks/)
    assert.match(page, /Every condition must pass before the prediction can be Changeover/)
    assert.match(styles, /\.si-changeover-requirements \.is-met/)
    assert.match(styles, /\.si-changeover-requirements \.is-missing/)
    assert.match(page, /<details className="panel si-technical-details"/)
    assert.match(styles, /@media \(max-width: 1000px\)[^{]*\{[^}]*\.si-action-summary/)
  })
})

describe('accepted plant regression presentation shapes', () => {
  const decision = (classification: 'CHANGEOVER' | 'DOWNTIME' | 'UNCERTAIN', field?: 'recipe' | 'order', radiusProduction = false) => ({ stop: { classification, confidence: classification === 'DOWNTIME' ? 'LOW' : 'HIGH', identities: field ? [{ field, usefulness: 'STRONG', changed: true, available: true, canonicalId: `production.${field}`, beforeValue: 'A', afterValue: 'B', settled: true, firstChangeAtUtc: null, lastChangeAtUtc: null, settledAtUtc: null, associationOffsetSeconds: 0, intermediateValues: [], reason: 'fixture' }] : [], radiusAlignment: radiusProduction ? 'CONTRADICTORY' : 'RADIUS_LATE', radius: { states: radiusProduction ? [{ isProduction: true }] : [] } } } as unknown as StopIntelligenceDetail)

  it('keeps P14 E072-like long maintenance/pump stops visually classified as downtime', () => {
    assert.deepEqual(stopDecisionSummary(decision('DOWNTIME')), { classification: 'DOWNTIME', confidence: 'LOW', identity: undefined, radiusProductionConflict: false })
  })

  it('uses the backend-selected press identity for P14 E038-like Recipe and P15 E148-like Order cases', () => {
    assert.equal(stopDecisionSummary(decision('CHANGEOVER', 'recipe')).identity?.field, 'recipe')
    assert.equal(stopDecisionSummary(decision('CHANGEOVER', 'order')).identity?.field, 'order')
  })

  it('makes P15 E155-like telemetry changeover versus Radius Run Production contradictory', () => {
    assert.deepEqual(stopDecisionSummary(decision('CHANGEOVER', undefined, true)), { classification: 'CHANGEOVER', confidence: 'HIGH', identity: undefined, radiusProductionConflict: true })
  })

  it('retains a collection-gap case as uncertain with UNKNOWN chart treatment', () => {
    assert.equal(stopDecisionSummary(decision('UNCERTAIN')).classification, 'UNCERTAIN')
    assert.match(timeline, /breakIntervals: detail\.speedContext\.unknownIntervals/)
    assert.match(timeline, /availability: unavailable\?\.state \?\? 'AVAILABLE'/)
  })

  it('shows each mandatory changeover condition as passed or missing independently of the prediction', () => {
    const detail = visualDetail()
    const evidence = (code: string) => ({ code, category: 'SETUP_FAMILY' as const, strength: 'STRONG' as const, explanation: code, canonicalIds: [], fromUtc: null, toUtc: null })
    detail.stop.supportingEvidence = [evidence('WASH_ACTIVITY_DURING_STOP'), evidence('SPEED_TEST_RETURNED_TO_ZERO')]
    detail.stop.conflictingEvidence = [evidence('CHANGEOVER_REQUIRES_PUMP_INK_ACTIVITY'), evidence('CHANGEOVER_REQUIRES_IMPRESSION_ADJUSTMENT')]
    assert.deepEqual(changeoverRequirementChecks(detail).map(({ label, met }) => [label, met]), [
      ['Wash activity', true],
      ['Pump / ink activity', false],
      ['Impression adjustment', false],
      ['Speed test returned to zero', true],
    ])
  })
})
