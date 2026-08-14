import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  PHYSICAL_SPEED_POLICY,
  PRE_STOP_REFERENCE_POLICY,
  RESTART_EXCURSION_POLICY,
  alignSignalToSpeed,
  buildStopPhases,
  descriptiveStats,
  matchPhysicalStop,
  physicalSpeedBucket,
  referenceDeviation,
  speedBucketReferences,
  summarizeRadiusTiming,
  type NumericObservation,
} from '../src/telemetry/stop-restart-analysis.js'

const BASE = Date.parse('2026-08-13T12:00:00.000Z')
const at = (seconds: number) => new Date(BASE + seconds * 1_000).toISOString()
const points = (rows: Array<[number, number]>): NumericObservation[] => rows.map(([seconds, value]) => ({ atUtc: at(seconds), value }))

describe('physical stop and restart analysis', () => {
  it('uses the documented absolute-speed buckets at every exact boundary', () => {
    assert.equal(physicalSpeedBucket(0), 'STOPPED')
    assert.equal(physicalSpeedBucket(-0.999), 'STOPPED')
    assert.equal(physicalSpeedBucket(0.999), 'STOPPED')
    assert.equal(physicalSpeedBucket(1), 'LOW_TRANSITION')
    assert.equal(physicalSpeedBucket(599.999), 'LOW_TRANSITION')
    assert.equal(physicalSpeedBucket(600), 'RUNNING')
    assert.equal(physicalSpeedBucket(1000), 'RUNNING')
    assert.equal(physicalSpeedBucket(1000.001), 'HIGH_SPEED_RUNNING')
    assert.equal(physicalSpeedBucket(-1000.001), 'HIGH_SPEED_RUNNING')
  })

  it('matches a physical stop before Radius and preserves signed observed evidence', () => {
    const result = matchPhysicalStop(points([[-300, 800], [-120, 700], [-90, -0.5], [0, 0], [60, 0]]), at(0))
    assert.equal(result.status, 'MATCHED')
    assert.equal(result.selected?.atUtc, at(-90))
    assert.equal(result.selected?.observedSpeed, -0.5)
    assert.equal(result.selected?.radiusOffsetSeconds, -90)
  })

  it('can associate a stop after Radius without assuming the annotation is wrong', () => {
    const result = matchPhysicalStop(points([[-60, 800], [0, 750], [30, 200], [45, 0], [120, 0]]), at(0))
    assert.equal(result.status, 'MATCHED')
    assert.equal(result.selected?.radiusOffsetSeconds, 45)
  })

  it('shows multiple similarly reasonable stop candidates as ambiguous', () => {
    const result = matchPhysicalStop(points([[-240, 800], [-120, 0], [-60, 700], [-30, 0], [0, 0], [60, 0]]), at(0))
    assert.equal(result.status, 'AMBIGUOUS')
    assert.equal(result.selected, null)
    assert.equal(result.candidates.length, 2)
  })

  it('does not manufacture candidates and distinguishes sparse evidence', () => {
    assert.equal(matchPhysicalStop(points([[-60, 700], [0, 650], [60, 610]]), at(0)).status, 'NO_PHYSICAL_STOP_FOUND')
    assert.equal(matchPhysicalStop(points([[-60, 700], [0, 0]]), at(0)).status, 'INSUFFICIENT_SPEED_EVIDENCE')
  })

  it('clusters near-zero jitter until actual speed returns to a running bucket', () => {
    const result = matchPhysicalStop(points([[-300, 800], [-240, 0], [-180, 2], [-170, 0], [-60, 500], [-50, 0], [0, 0], [60, 0]]), at(0))
    assert.equal(result.status, 'MATCHED')
    assert.equal(result.candidates.length, 1)
    assert.equal(result.selected?.atUtc, at(-240))
  })

  it('separates a direct run-to-stop boundary from stable running', () => {
    const input = points([[-240, 810], [-180, 805], [-120, 800], [-60, 795], [0, 0], [60, 0]])
    const match = matchPhysicalStop([...input, { atUtc: at(120), value: 0 }], at(30))
    const phases = buildStopPhases(input, match.candidates[0]!)
    assert.equal(phases.stableRunningBefore.supported, true)
    assert.equal(phases.stableRunningBefore.bucket, 'RUNNING')
    assert.equal(phases.deceleration.fromUtc, at(0))
    assert.equal(phases.deceleration.toUtc, at(0))
  })

  it('separates run-to-low-to-stop deceleration and preserves high-speed prior running', () => {
    const input = points([[-300, 1050], [-240, 1040], [-180, 1030], [-120, 500], [-60, 300], [-30, 100], [0, 0], [60, 0]])
    const phases = buildStopPhases(input, { atUtc: at(0), observedSpeed: 0, previousObservedSpeed: 100, radiusOffsetSeconds: -30 })
    assert.equal(phases.stableRunningBefore.bucket, 'HIGH_SPEED_RUNNING')
    assert.equal(phases.deceleration.fromUtc, at(-120))
    assert.equal(phases.deceleration.toUtc, at(0))
  })

  it('preserves multiple failed restart attempts and confirms only observed sustained running', () => {
    const input = points([
      [-240, 800], [-180, 800], [-120, 800], [-60, 300], [0, 0],
      [60, 180], [90, 420], [120, 0],
      [180, 250], [210, 510], [240, 0],
      [300, 200], [330, 650], [390, 820], [450, 810],
    ])
    const phases = buildStopPhases(input, { atUtc: at(0), observedSpeed: 0, previousObservedSpeed: 300, radiusOffsetSeconds: -30 })
    assert.equal(phases.restartAttempts.length, 3)
    assert.deepEqual(phases.restartAttempts.slice(0, 2).map(({ returnedToStopped, sustainedRunning, maximumObservedSpeed }) => ({ returnedToStopped, sustainedRunning, maximumObservedSpeed })), [
      { returnedToStopped: true, sustainedRunning: false, maximumObservedSpeed: 420 },
      { returnedToStopped: true, sustainedRunning: false, maximumObservedSpeed: 510 },
    ])
    assert.equal(phases.restartAttempts[2]?.sustainedRunning, true)
    assert.deepEqual(phases.restartAttempts.map(({ classification }) => classification), ['RESTART_EXCURSION', 'RESTART_EXCURSION', 'SUSTAINED_PHYSICAL_RUNNING_RESUMED'])
    assert.equal(phases.sustainedRunningReachedAtUtc, at(330))
    assert.equal(phases.sustainedRunningConfirmedAtUtc, at(450))
  })

  it('retains near-zero jitter as raw evidence without inflating failed-running attempts', () => {
    const phases = buildStopPhases(points([[-240, 800], [-120, 800], [0, 0], [10, 2], [15, 0], [60, 300], [100, 0], [180, 600], [250, 0]]), { atUtc: at(0), observedSpeed: 0, previousObservedSpeed: 800, radiusOffsetSeconds: 0 })
    assert.equal(RESTART_EXCURSION_POLICY.briefLowSpeedMaximumExclusive, 10)
    assert.deepEqual(phases.restartAttempts.map(({ classification }) => classification), ['BRIEF_LOW_SPEED_EXCURSION', 'RESTART_EXCURSION', 'FAILED_RUNNING_ATTEMPT'])
    assert.equal(phases.restartAttempts[0]?.failedRunningAttempt, false)
    assert.equal(phases.restartAttempts[2]?.failedRunningAttempt, true)
    assert.equal(phases.restartAttempts.length, 3, 'all observed physical excursions remain available')
  })

  it('does not call an unconfirmed restart sustained physical running', () => {
    const input = points([[-240, 800], [-180, 800], [-120, 800], [0, 0], [60, 650], [120, 700]])
    const phases = buildStopPhases(input, { atUtc: at(0), observedSpeed: 0, previousObservedSpeed: 800, radiusOffsetSeconds: 0 })
    assert.equal(phases.sustainedRunningConfirmedAtUtc, null)
    assert.equal(phases.restartAttempts[0]?.sustainedRunning, false)
    assert.equal(phases.sustainedRunningAgain.supported, false)
  })

  it('supports bounded five-minute historian heartbeats but never forward-fills beyond 330 seconds', () => {
    const supported = buildStopPhases(points([[-900, 800], [-600, 800], [-300, 800], [0, 0]]), { atUtc: at(0), observedSpeed: 0, previousObservedSpeed: 800, radiusOffsetSeconds: 0 })
    assert.equal(supported.stableRunningBefore.supported, true)
    assert.equal(supported.stableRunningBefore.maximumGapSeconds, 300)
    const bounded = buildStopPhases(points([[-931, 800], [-600, 800], [-300, 800], [0, 0]]), { atUtc: at(0), observedSpeed: 0, previousObservedSpeed: 800, radiusOffsetSeconds: 0 })
    assert.equal(bounded.stableRunningBefore.fromUtc, at(-600))
    assert.equal(bounded.stableRunningBefore.boundaryGapSeconds, 331)
    assert.equal(PHYSICAL_SPEED_POLICY.speedContinuityMaximumGapMs, 330_000)
    assert.equal(PHYSICAL_SPEED_POLICY.speedAlignmentMaximumAgeMs, 180_000)
  })

  it('aligns signal samples only to fresh earlier observed speed and keeps buckets separate', () => {
    const result = alignSignalToSpeed(points([[10, 11], [200, 22], [500, 33], [610, 44]]), points([[0, 0], [190, 500], [600, 800]]))
    assert.deepEqual(result.values.STOPPED, [11])
    assert.deepEqual(result.values.LOW_TRANSITION, [22])
    assert.deepEqual(result.values.RUNNING, [44])
    assert.deepEqual(result.values.HIGH_SPEED_RUNNING, [])
    assert.equal(result.excludedWithoutFreshSpeed, 1)
    assert.equal(PHYSICAL_SPEED_POLICY.speedAlignmentMaximumAgeMs, 180_000)
  })

  it('reports speed bucket support without calling high speed bad or unsafe', () => {
    const references = speedBucketReferences(points([[0, 0], [60, 0], [120, 300], [180, 800], [240, 1100], [300, 1100]]), at(0), at(360))
    assert.deepEqual(references.map(({ bucket }) => bucket), ['STOPPED', 'LOW_TRANSITION', 'RUNNING', 'HIGH_SPEED_RUNNING'])
    assert.ok(references.every(({ sharePercent }) => sharePercent >= 0))
    assert.equal(references.find(({ bucket }) => bucket === 'HIGH_SPEED_RUNNING')?.observationCount, 2)
  })

  it('requires distribution, robust-deviation, and material-shift support for a flag', () => {
    const reference = descriptiveStats(Array.from({ length: 20 }, (_, index) => 99 + index % 3))!
    assert.equal(referenceDeviation(descriptiveStats([100, 100, 100])!, reference).qualifies, false, 'stable non-zero signal')
    assert.equal(referenceDeviation(descriptiveStats([130, 131, 132])!, reference).qualifies, true, 'same-speed P95 excursion')
    assert.equal(referenceDeviation(descriptiveStats([104, 104, 104])!, reference).qualifies, false, 'small material shift')
    assert.equal(PRE_STOP_REFERENCE_POLICY.minimumReferenceObservations, 20)
    assert.equal(PRE_STOP_REFERENCE_POLICY.maximumFlags, 5)
    assert.equal(PRE_STOP_REFERENCE_POLICY.maximumAutomaticCandidates, 12)
  })

  it('summarizes Radius timing with explicit N/D and suppresses weak per-press medians', () => {
    const summary = summarizeRadiusTiming([
      { occurrenceId: '1', pressKey: 'press5', displayName: 'Press 5', matchStatus: 'MATCHED', offsetSeconds: 90 },
      { occurrenceId: '2', pressKey: 'press5', displayName: 'Press 5', matchStatus: 'MATCHED', offsetSeconds: 0 },
      { occurrenceId: '3', pressKey: 'press5', displayName: 'Press 5', matchStatus: 'MATCHED', offsetSeconds: -60 },
      { occurrenceId: '4', pressKey: 'press12', displayName: 'Press 12', matchStatus: 'NO_PHYSICAL_STOP_FOUND', offsetSeconds: null },
      { occurrenceId: '5', pressKey: 'press12', displayName: 'Press 12', matchStatus: 'MATCHED', offsetSeconds: 120 },
    ])
    assert.equal(summary.matchedCount, 4)
    assert.equal(summary.occurrenceCount, 5)
    assert.deepEqual([summary.beforeCount, summary.nearCount, summary.afterCount], [1, 1, 2])
    assert.equal(summary.byPress.find(({ pressKey }) => pressKey === 'press5')?.medianOffsetSeconds, 0)
    assert.equal(summary.byPress.find(({ pressKey }) => pressKey === 'press12')?.medianSupport, 'INSUFFICIENT')
    assert.equal(summary.byPress.find(({ pressKey }) => pressKey === 'press12')?.medianOffsetSeconds, null)
  })
})
