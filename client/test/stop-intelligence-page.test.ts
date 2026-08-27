import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { buildFleetBandSegments, buildFleetSpeedTrack, buildSelectedSignalTracks, buildStopSpeedChartModel, buildStopTimelineModel, filterStopEpisodes, fleetHoverSnapshot, STOP_CLASSIFICATION_FILTERS, stopDecisionSummary, stopFleetTotals, stopInspectionSnapshot } from '../src/components/StopIntelligencePage'
import { numericPaths } from '../src/components/SynchronizedTimeline'
import { areaFromPathname, areaPath } from '../src/navigation'
import type { StopFleetEpisode, StopFleetPressSummary, StopIntelligenceDetail } from '../src/types/stop-intelligence'

const page = readFileSync(new URL('../src/components/StopIntelligencePage.tsx', import.meta.url), 'utf8')
const timeline = readFileSync(new URL('../src/components/StopIntelligenceTimeline.tsx', import.meta.url), 'utf8')
const api = readFileSync(new URL('../src/api/process-intelligence-api.ts', import.meta.url), 'utf8')
const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const types = readFileSync(new URL('../src/types/stop-intelligence.ts', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')

const episode = (classification: StopFleetEpisode['classification'], stopId: string): StopFleetEpisode => ({ stopId, pressKey: 'press14', startAt: '2026-08-25T20:00:00.000Z', endAt: '2026-08-25T20:10:00.000Z', physicalDurationSeconds: 600, classification, confidence: 'HIGH', movementAttemptCount: 2, failedRecoveryCount: 1, radiusAlignment: 'CONTRADICTORY', radiusStatusDescription: 'Run Production', primaryReasonCodes: ['RECIPE_CHANGED'], leftCensored: false, rightCensored: false, affectedByCollectionGap: false, affectedBySpeedQuality: false })
const press = (overrides: Partial<StopFleetPressSummary> = {}): StopFleetPressSummary => ({ pressKey: 'press14', displayName: 'Press 14', telemetryEvidenceState: 'AVAILABLE', stopCount: 4, totalPhysicalStopSeconds: 2_400, changeoverCount: 1, downtimeCount: 1, uncertainCount: 1, badDataCount: 1, changeoverPhysicalStopSeconds: 600, longestPhysicalStopSeconds: 900, dataAvailabilityWarning: false, warningReason: null, episodes: [episode('CHANGEOVER', 'c'), episode('DOWNTIME', 'd'), episode('UNCERTAIN', 'u'), episode('IGNORE_BAD_DATA', 'b')], speedContext: { fromUtc: '2026-08-25T19:45:00.000Z', toUtc: '2026-08-25T20:25:00.000Z', unit: 'ft/min', stopThreshold: 1, recoveryThreshold: 595, observations: [{ atUtc: '2026-08-25T19:50:00.000Z', speed: 800, qualityState: 'GOOD' }, { atUtc: '2026-08-25T20:00:00.000Z', speed: 0, qualityState: 'GOOD' }, { atUtc: '2026-08-25T20:10:00.000Z', speed: 700, qualityState: 'GOOD' }], unknownIntervals: [] }, ...overrides })

const visualDetail = (): StopIntelligenceDetail => ({
  stopId: 'visual-stop', displayName: 'Press 14', rangeFromUtc: '2026-08-25T19:45:00.000Z', rangeToUtc: '2026-08-25T20:25:00.000Z', telemetryEvidenceState: 'UNKNOWN_COLLECTION',
  identityAssociationConfiguration: { pressKey: 'press14', identityContextBeforeSeconds: 900, identityContextAfterSeconds: 900, identitySettlingSeconds: 120 },
  speedContext: { fromUtc: '2026-08-25T19:45:00.000Z', toUtc: '2026-08-25T20:25:00.000Z', unit: 'ft/min', stopThreshold: 1, recoveryThreshold: 595, observations: [{ atUtc: '2026-08-25T19:50:00.000Z', speed: 800, qualityState: 'GOOD' }, { atUtc: '2026-08-25T20:00:00.000Z', speed: 0, qualityState: 'GOOD' }, { atUtc: '2026-08-25T20:04:00.000Z', speed: 90, qualityState: 'GOOD' }, { atUtc: '2026-08-25T20:06:00.000Z', speed: null, qualityState: 'BAD' }, { atUtc: '2026-08-25T20:10:00.000Z', speed: 700, qualityState: 'GOOD' }], unknownIntervals: [{ fromUtc: '2026-08-25T20:06:00.000Z', toUtc: '2026-08-25T20:07:00.000Z', state: 'UNKNOWN_COLLECTION' }] },
  stop: {
    physicalSegment: { pressKey: 'press14', sourceId: 1, speedSignalId: 2, startAt: '2026-08-25T20:00:00.000Z', endAt: '2026-08-25T20:10:00.000Z', leftCensored: false, rightCensored: false, leftCensorReason: null, rightCensorReason: null, physicalDurationSeconds: 600, zeroSpeedSeconds: 500, lowMovementSeconds: 100, movementAttempts: [{ startAt: '2026-08-25T20:03:00.000Z', endAt: '2026-08-25T20:04:00.000Z', durationSeconds: 60, averageSpeed: 45, peakSpeed: 90, reachedRecoveryThreshold: false, failedRecoveryCount: 1, sequenceNumber: 1 }], failedRecoveryCount: 1, failedRecoveryStreaks: [{ startAt: '2026-08-25T20:03:30.000Z', endAt: '2026-08-25T20:03:45.000Z', durationSeconds: 15, reason: 'DROPPED_BELOW_RECOVERY', movementAttemptSequenceNumber: 1 }], algorithmVersion: 'physical-v1', configVersion: 'config-v1' },
    classification: 'CHANGEOVER', confidence: 'HIGH', classificationVersion: 'classification-v1',
    identities: [{ field: 'recipe', usefulness: 'STRONG', available: true, canonicalId: 'production.recipe', beforeValue: 'R-100', afterValue: 'R-200', changed: true, settled: true, firstChangeAtUtc: '2026-08-25T20:05:00.000Z', lastChangeAtUtc: '2026-08-25T20:05:00.000Z', settledAtUtc: '2026-08-25T20:05:30.000Z', associationOffsetSeconds: 300, intermediateValues: [], reason: 'Recipe changed once and settled.' }], identityBefore: { recipe: 'R-100' }, identityAfter: { recipe: 'R-200' }, families: [], supportingEvidence: [], conflictingEvidence: [], missingEvidence: [], radiusAlignment: 'CONTRADICTORY',
    radius: { alignment: 'CONTRADICTORY', firstNonProductionAtUtc: null, firstProductionReturnAtUtc: null, physicalStartOffsetSeconds: null, physicalEndOffsetSeconds: null, coveredSeconds: 600, physicalSeconds: 600, coveragePercent: 100, states: [{ kind: 'radius', startUtc: '2026-08-25T19:45:00.000Z', endUtc: '2026-08-25T20:25:00.000Z', eventType: 'RUN', statusCode: '100', statusDescription: 'Run Production', isProduction: true }], reason: 'Radius remained in production.' },
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
    assert.match(api, /\/api\/stop-intelligence\/fleet/)
    assert.match(api, /\/stops\/\$\{encodeURIComponent\(input\.stopId\)\}/)
    assert.match(page, /onSelect={setSelectedEpisode}/)
    assert.match(page, /id="stop-investigation"/)
    assert.match(page, /Close investigation/)
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
    speedContext: { ...press().speedContext, unknownIntervals: [{ fromUtc: '2026-08-25T20:02:00.000Z', toUtc: '2026-08-25T20:03:00.000Z', state: 'UNKNOWN_COLLECTION' }] },
  })

  it('builds continuous running, downtime, changeover, uncertain, and data-quality bands', () => {
    const segments = buildFleetBandSegments(navigationPress(), range, 'ALL')
    assert.equal(segments[0]?.startUtc, range.fromUtc)
    assert.equal(segments.at(-1)?.endUtc, range.toUtc)
    assert.ok(segments.some(({ kind, className }) => kind === 'running' && className?.includes('si-fleet-state--running')))
    for (const classification of ['downtime', 'changeover', 'uncertain', 'ignore_bad_data']) assert.ok(segments.some(({ className }) => className?.includes(`si-fleet-state--${classification}`)))
    assert.ok(segments.some(({ kind }) => kind === 'unknown'))
  })

  it('keeps every stop present under filters and only de-emphasizes nonmatches', () => {
    const segments = buildFleetBandSegments(navigationPress(), range, 'CHANGEOVER')
    assert.deepEqual(segments.filter(({ episode }) => episode).map(({ episode }) => episode!.stopId), ['down', 'change', 'uncertain', 'bad'])
    assert.equal(segments.find(({ episode }) => episode?.stopId === 'change')?.className?.includes('is-filter-muted'), false)
    assert.equal(segments.find(({ episode }) => episode?.stopId === 'down')?.className?.includes('is-filter-muted'), true)
  })

  it('aligns the speed trace to the same range and breaks it across UNKNOWN', () => {
    const track = buildFleetSpeedTrack(navigationPress())
    assert.equal(track.id, 'fleet-speed:press14')
    assert.equal(track.samples.length, 3)
    assert.equal(track.breakIntervals?.length, 1)
    assert.deepEqual(track.referenceLines?.map(({ value }) => value), [1, 595])
  })

  it('provides compact stop and running hover snapshots without technical codes', () => {
    const value = navigationPress(); const segments = buildFleetBandSegments(value, range, 'ALL')
    const stop = fleetHoverSnapshot(value, segments, '2026-08-25T20:06:00.000Z')
    assert.equal(stop.segment?.episode?.stopId, 'change')
    assert.equal(stop.segment?.episode?.radiusStatusDescription, 'Run Production')
    const running = fleetHoverSnapshot(value, segments, '2026-08-25T19:50:00.000Z')
    assert.equal(running.segment?.kind, 'running')
    assert.equal(running.nearestSpeed?.speed, 800)
    const censoredValue = navigationPress(); censoredValue.episodes = [{ ...censoredValue.episodes[0]!, leftCensored: true, physicalDurationSeconds: 600 }]
    const censored = buildFleetBandSegments(censoredValue, range, 'ALL').find(({ episode }) => episode)
    assert.match(censored?.details ?? '', /Start before available evidence/)
    assert.match(censored?.details ?? '', /At least 10m 0s/)
    assert.doesNotMatch(timeline, /primaryReasonCodes/)
  })

  it('uses the shared crosshair and direct block selection with persistent highlighting', () => {
    assert.match(page, /continuous stop-state and actual-speed timeline/)
    assert.match(page, /renderInspectionTooltip/)
    assert.match(page, /selectedId === episode\.stopId \? 'is-selected'/)
    assert.match(page, /if \(episode\) onSelect\(episode\)/)
    assert.match(styles, /si-fleet-state--running[^}]*#31825d/)
    assert.match(styles, /si-fleet-state--downtime[^}]*#b64743/)
    assert.match(styles, /si-fleet-state--changeover[^}]*#2c72a8/)
  })
})

describe('selected physical-stop investigation', () => {
  it('shows classification, confidence, physical duration, restart count, and structured evidence groups', () => {
    for (const value of ['Classification', 'Confidence', 'Physical stop', 'Restarts', 'Why this classification?', 'Supporting', 'Conflicting', 'Missing / unavailable']) assert.match(page, new RegExp(value.replace(/[?]/g, '\\?'), 'i'))
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
    assert.match(types, /UNKNOWN_COLLECTION/)
    assert.match(types, /UNKNOWN_SPEED_QUALITY/)
    assert.match(page, /leftCensored/)
    assert.match(page, /rightCensored/)
  })

  it('draws exact stop and recovery thresholds and breaks the speed trace across unknown evidence', () => {
    const detail = { speedContext: { fromUtc: '2026-08-25T19:45:00.000Z', toUtc: '2026-08-25T20:25:00.000Z', stopThreshold: 1, recoveryThreshold: 595, unit: 'ft/min', observations: [{ atUtc: '2026-08-25T19:50:00.000Z', speed: 800, qualityState: 'GOOD' }, { atUtc: '2026-08-25T20:00:00.000Z', speed: 0, qualityState: 'GOOD' }, { atUtc: '2026-08-25T20:05:00.000Z', speed: null, qualityState: 'BAD' }, { atUtc: '2026-08-25T20:10:00.000Z', speed: 700, qualityState: 'GOOD' }], unknownIntervals: [{ fromUtc: '2026-08-25T20:05:00.000Z', toUtc: '2026-08-25T20:10:00.000Z', state: 'UNKNOWN_COLLECTION' }] } } as StopIntelligenceDetail
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

  it('shows the action timeline only for eligible changeovers and exposes confidence semantics', () => {
    assert.match(page, /if \(!analysis\.eligible\)/)
    assert.match(page, /Changeover action confidence summary/)
    assert.match(timeline, /detail\.changeoverActions\.actions/)
    assert.match(types, /'DETECTED' \| 'INFERRED' \| 'UNKNOWN'/)
    assert.match(page, /UNKNOWN does not mean the action did not happen/)
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
    assert.match(page, /Loading sequential fleet stop summaries/)
    assert.match(page, /No physical stops were detected/)
    assert.match(page, /Stop evidence unavailable/)
    assert.match(page, /Selected stop unavailable/)
    assert.match(page, /Loading bounded evidence for the selected physical stop/)
  })
})

describe('visual-first synchronized investigation model', () => {
  it('uses one ordered axis for speed, physical behavior, Radius, identity, actions, and availability', () => {
    const model = buildStopTimelineModel(visualDetail())
    assert.deepEqual(model.trackOrder.slice(0, 6), ['numeric:actual-speed', 'interval:physical', 'interval:radius', 'interval:identity', 'interval:actions', 'interval:availability'])
    assert.deepEqual(model.intervalTracks.map(({ id }) => id), ['physical', 'radius', 'identity', 'actions', 'availability'])
    assert.deepEqual(model.numericTracks.map(({ id }) => id), ['actual-speed'])
    assert.equal(model.eventTracks.length, 0)
    assert.ok(model.intervalTracks.find(({ id }) => id === 'physical')?.intervals.some(({ label }) => label === 'Failed recovery'))
    assert.ok(model.intervalTracks.find(({ id }) => id === 'availability')?.intervals.some(({ unavailable }) => unavailable))
  })

  it('keeps raw/canonical signal tracks opt-in and bounded to the selected action', () => {
    const detail = visualDetail(); const action = detail.changeoverActions.actions[0]!
    const hidden = buildStopTimelineModel(detail, action, false)
    const visible = buildStopTimelineModel(detail, action, true)
    const selected = buildSelectedSignalTracks(action)
    assert.equal(hidden.numericTracks.length, 1)
    assert.equal(hidden.eventTracks.length, 0)
    assert.equal(selected.numeric.length, 1)
    assert.equal(selected.events.length, 1)
    assert.equal(visible.numericTracks.length, 2)
    assert.equal(visible.eventTracks.length, 1)
  })

  it('forces an actual-speed trace break across explicit UNKNOWN evidence', () => {
    const samples = [{ observedAtUtc: '2026-08-25T20:00:00.000Z', receivedAtUtc: '2026-08-25T20:00:00.000Z', sourceTimestampUtc: null, qualityState: 'GOOD', valueKind: 'numeric' as const, value: 0 }, { observedAtUtc: '2026-08-25T20:01:00.000Z', receivedAtUtc: '2026-08-25T20:01:00.000Z', sourceTimestampUtc: null, qualityState: 'GOOD', valueKind: 'numeric' as const, value: 700 }]
    const geometry = numericPaths(samples, Date.parse('2026-08-25T20:00:00.000Z'), 60_000, 1_000, 88, true, 'linear', false, [], [{ fromUtc: '2026-08-25T20:00:20.000Z', toUtc: '2026-08-25T20:00:40.000Z' }])
    assert.equal(geometry.paths.length, 2)
  })

  it('puts overlapping detected actions in aligned lanes and omits action clutter for downtime', () => {
    const detail = visualDetail()
    detail.changeoverActions.actions.push({ ...detail.changeoverActions.actions[0]!, actionCode: 'WASH_ACTIVITY', displayName: 'Wash activity', startAt: '2026-08-25T20:03:30.000Z', endAt: '2026-08-25T20:04:30.000Z' })
    const overlapTracks = buildStopTimelineModel(detail).intervalTracks.filter(({ id }) => id.startsWith('actions'))
    assert.deepEqual(overlapTracks.map(({ id }) => id), ['actions', 'actions-2'])
    detail.stop.classification = 'DOWNTIME'; detail.changeoverActions.eligible = false; detail.changeoverActions.reason = 'Only changeovers receive action analysis.'; detail.changeoverActions.actions = []
    const downtimeActions = buildStopTimelineModel(detail).intervalTracks.find(({ id }) => id === 'actions')!
    assert.equal(downtimeActions.intervals.length, 0)
    assert.equal(downtimeActions.unavailableLabel, 'Only changeovers receive action analysis.')
  })

  it('resolves all tooltip rows from one inspection timestamp without converting UNKNOWN to zero', () => {
    const detail = visualDetail()
    const failed = stopInspectionSnapshot(detail, '2026-08-25T20:03:35.000Z')
    assert.equal(failed.physical, 'Failed recovery')
    assert.equal(failed.radius?.statusDescription, 'Run Production')
    assert.equal(failed.identityValue, 'R-100')
    assert.deepEqual(failed.actions.map(({ displayName }) => displayName), ['Deck movement'])
    const unknown = stopInspectionSnapshot(detail, '2026-08-25T20:06:30.000Z')
    assert.equal(unknown.availability, 'UNKNOWN_COLLECTION')
    assert.equal(unknown.identityValue, 'R-200')
  })

  it('wires the shared crosshair, action selection, compact evidence, and collapsed drilldown', () => {
    assert.match(timeline, /<SynchronizedTimeline/)
    assert.match(timeline, /renderInspectionTooltip/)
    assert.match(timeline, /selectedId={selectedActionKey}/)
    assert.match(timeline, /track\.id\.startsWith\('actions'\)/)
    assert.match(page, /Show signals/)
    assert.match(page, /si-decision-evidence-chips/)
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
    assert.match(timeline, /si-availability-unknown/)
    assert.match(timeline, /not treated as zero speed/)
  })
})
