import assert from 'node:assert/strict'
import test from 'node:test'
import { buildChangeoverStabilizationPhases } from '../src/stop-intelligence/changeover-stabilization-engine.js'
import { mergeChangeoverStabilizationEpisodes } from '../src/stop-intelligence/service.js'
import type { StopFleetEpisode } from '../src/stop-intelligence/contracts.js'

const at = (minute: number) => new Date(Date.UTC(2026, 7, 30, 16, minute)).toISOString()
const observed = <T extends string | number>(minute: number, value: T): { atUtc: string; value: T; qualityState: string } => ({ atUtc: at(minute), value, qualityState: 'GOOD' })
const episode = (stopId: string, start: number, end: number, classification: StopFleetEpisode['classification']): StopFleetEpisode => ({
  stopId, pressKey: 'press15', startAt: at(start), endAt: at(end), physicalDurationSeconds: (end - start) * 60,
  classification, operationalClassification: classification, changeoverStabilizationId: null, confidence: 'HIGH', movementAttemptCount: 0,
  failedRecoveryCount: 0, radiusAlignment: 'RADIUS_UNAVAILABLE', radiusStatusDescription: null, primaryReasonCodes: [], leftCensored: false,
  rightCensored: false, affectedByCollectionGap: false, affectedBySpeedQuality: false, changeoverActivityWindows: [],
})

test('one over-9k roll followed by a long stop remains inside the changeover stabilization phase', () => {
  const phases = buildChangeoverStabilizationPhases({
    fromUtc: at(0), toUtc: at(240), episodes: [episode('changeover', 0, 100, 'CHANGEOVER'), episode('long-stop', 112, 190, 'DOWNTIME')],
    rollIdentityObservations: [observed(80, 'ROLL-A'), observed(112, 'ROLL-B')],
    rollLengthObservations: [observed(80, 0), observed(111, 17_135), observed(112, 19)],
    orderObservations: [observed(0, 'ORDER-1')], recipeObservations: [observed(0, 'RECIPE-1')], rollLengthUnit: 'ft',
  })
  assert.equal(phases.length, 1)
  assert.deepEqual([phases[0]!.status, phases[0]!.startAt, phases[0]!.endAt], ['STABILIZING', at(0), at(240)])
  assert.deepEqual(phases[0]!.qualifyingRolls.map(({ completedLength, productionStartAt }) => [completedLength, productionStartAt]), [[17_135, at(100)]])
  assert.deepEqual(phases[0]!.continuationStopIds, ['long-stop'])
})

test('two rolls over 9k with the second starting within one hour move good production back to the first roll', () => {
  const phases = buildChangeoverStabilizationPhases({
    fromUtc: at(0), toUtc: at(120), episodes: [episode('changeover', 0, 30, 'CHANGEOVER')],
    rollIdentityObservations: [observed(20, 'ROLL-A'), observed(50, 'ROLL-B'), observed(80, 'ROLL-C')],
    rollLengthObservations: [observed(20, 0), observed(49, 11_000), observed(50, 0), observed(79, 12_000), observed(80, 0)],
    orderObservations: [observed(0, 'ORDER-1')], recipeObservations: [observed(0, 'RECIPE-1')], rollLengthUnit: 'ft',
  })
  assert.equal(phases.length, 1)
  assert.deepEqual([phases[0]!.status, phases[0]!.endAt, phases[0]!.goodProductionStartAt, phases[0]!.stabilizedAt], ['STABILIZED', at(30), at(30), at(80)])
  assert.deepEqual([phases[0]!.minimumRollLength, phases[0]!.completionWindowSeconds], [9_000, 3_600])
  assert.deepEqual(phases[0]!.qualifyingRolls.map(({ rollId, completedLength }) => [rollId, completedLength]), [['ROLL-A', 11_000], ['ROLL-B', 12_000]])
})

test('exactly 9k does not qualify because both completed rolls must be above 9k', () => {
  const phases = buildChangeoverStabilizationPhases({
    fromUtc: at(0), toUtc: at(120), episodes: [episode('changeover', 0, 20, 'CHANGEOVER')],
    rollIdentityObservations: [],
    rollLengthObservations: [observed(20, 0), observed(39, 9_000), observed(40, 0), observed(59, 9_500), observed(60, 0), observed(79, 9_600), observed(80, 0)],
    orderObservations: [observed(0, 'ORDER-1')], recipeObservations: [observed(0, 'RECIPE-1')],
  })
  assert.deepEqual([phases[0]!.status, phases[0]!.endAt, phases[0]!.stabilizedAt], ['STABILIZED', at(40), at(80)])
  assert.deepEqual(phases[0]!.qualifyingRolls.map(({ completedLength }) => completedLength), [9_500, 9_600])
})

test('a second qualifying roll starting more than one hour after the first completion does not close the changeover', () => {
  const phases = buildChangeoverStabilizationPhases({
    fromUtc: at(0), toUtc: at(180), episodes: [episode('changeover', 0, 20, 'CHANGEOVER')],
    rollIdentityObservations: [],
    rollLengthObservations: [observed(20, 0), observed(39, 9_500), observed(40, 0), observed(109, 2_000), observed(110, 0), observed(129, 9_600), observed(130, 0)],
    orderObservations: [observed(0, 'ORDER-1')], recipeObservations: [observed(0, 'RECIPE-1')],
  })
  assert.deepEqual([phases[0]!.status, phases[0]!.endAt, phases[0]!.stabilizedAt], ['STABILIZING', at(180), null])
  assert.deepEqual(phases[0]!.qualifyingRolls.map(({ completedLength }) => completedLength), [9_600])
})

test('a long second roll qualifies when it starts within one hour even if it completes later', () => {
  const phases = buildChangeoverStabilizationPhases({
    fromUtc: at(0), toUtc: at(160), episodes: [episode('changeover', 0, 20, 'CHANGEOVER')],
    rollIdentityObservations: [],
    rollLengthObservations: [observed(20, 0), observed(39, 12_000), observed(40, 0), observed(129, 49_000), observed(130, 0)],
    orderObservations: [observed(0, 'ORDER-1')], recipeObservations: [observed(0, 'RECIPE-1')],
  })
  assert.deepEqual([phases[0]!.status, phases[0]!.endAt, phases[0]!.goodProductionStartAt, phases[0]!.stabilizedAt], ['STABILIZED', at(20), at(20), at(130)])
  assert.deepEqual(phases[0]!.qualifyingRolls.map(({ completedLength }) => completedLength), [12_000, 49_000])
})

test('P13-shaped length resets count two over-9k rolls within an hour despite an intervening short test roll', () => {
  const phases = buildChangeoverStabilizationPhases({
    fromUtc: at(0), toUtc: at(120), episodes: [episode('changeover', 0, 20, 'CHANGEOVER')],
    rollIdentityObservations: [observed(20, 'ROLL-CONSTANT'), observed(30, 'ROLL-CONSTANT'), observed(45, 'ROLL-CONSTANT'), observed(60, 'ROLL-CONSTANT')],
    rollLengthObservations: [observed(20, 0), observed(44, 9_769), observed(45, 3), observed(50, 2_085), observed(51, 39), observed(59, 29_966), observed(60, 0)],
    orderObservations: [observed(0, 'ORDER-1'), observed(25, 'ORDER-1'), observed(35, 'ORDER-1'), observed(50, 'ORDER-1')],
    recipeObservations: [observed(0, 'RECIPE-1'), observed(32, 'RECIPE-1'), observed(52, 'RECIPE-1')],
  })
  assert.deepEqual([phases[0]!.status, phases[0]!.endAt, phases[0]!.goodProductionStartAt, phases[0]!.stabilizedAt], ['STABILIZED', at(20), at(20), at(60)])
  assert.deepEqual(phases[0]!.qualifyingRolls.map(({ completedLength }) => completedLength), [9_769, 29_966])
})

test('a stop does not override two over-9k roll completions inside the one-hour proof window', () => {
  const phases = buildChangeoverStabilizationPhases({
    fromUtc: at(0), toUtc: at(200), episodes: [episode('changeover', 0, 30, 'CHANGEOVER'), episode('failed-run-stop', 52, 80, 'DOWNTIME')],
    rollIdentityObservations: [observed(20, 'ROLL-A'), observed(50, 'ROLL-B'), observed(100, 'ROLL-C'), observed(130, 'ROLL-D'), observed(160, 'ROLL-E')],
    rollLengthObservations: [observed(49, 11_000), observed(50, 0), observed(99, 14_000), observed(100, 0), observed(129, 12_000), observed(130, 0), observed(159, 13_000)],
    orderObservations: [observed(0, 'ORDER-1')], recipeObservations: [observed(0, 'RECIPE-1')],
  })
  assert.deepEqual([phases[0]!.status, phases[0]!.endAt, phases[0]!.stabilizedAt], ['STABILIZED', at(30), at(100)])
  assert.deepEqual(phases[0]!.qualifyingRolls.map(({ rollId }) => rollId), ['ROLL-A', 'ROLL-B'])
})

test('does not extend changeover without roll-length evidence', () => {
  assert.deepEqual(buildChangeoverStabilizationPhases({ fromUtc: at(0), toUtc: at(60), episodes: [episode('changeover', 0, 30, 'CHANGEOVER')], rollIdentityObservations: [observed(20, 'ROLL-A'), observed(40, 'ROLL-B')], rollLengthObservations: [] }), [])
})

test('publishes one merged changeover event while retaining stopped and trial-running totals', () => {
  const base = [episode('changeover', 0, 100, 'CHANGEOVER'), episode('continuation', 112, 190, 'DOWNTIME')]
  const phase = buildChangeoverStabilizationPhases({
    fromUtc: at(0), toUtc: at(240), episodes: base,
    rollIdentityObservations: [observed(80, 'ROLL-A'), observed(112, 'ROLL-B')],
    rollLengthObservations: [observed(80, 0), observed(111, 17_135), observed(112, 19)],
    orderObservations: [observed(0, 'ORDER-1')], recipeObservations: [observed(0, 'RECIPE-1')],
  })[0]!
  const merged = mergeChangeoverStabilizationEpisodes(base, [phase], at(240))
  assert.equal(merged.length, 1)
  assert.deepEqual([merged[0]!.classification, merged[0]!.startAt, merged[0]!.endAt], ['CHANGEOVER', at(0), at(240)])
  assert.deepEqual([merged[0]!.eventDurationSeconds, merged[0]!.physicalDurationSeconds, merged[0]!.trialRunSeconds], [14_400, 10_680, 3_720])
  assert.deepEqual(merged[0]!.constituentStopIds, ['changeover', 'continuation'])
})
