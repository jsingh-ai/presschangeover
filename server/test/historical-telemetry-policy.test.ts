import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assessDetailedHistory,
  assessRawHistory,
  corroborateSharedCollectionOutages,
  isGoodTelemetryQuality,
  reconstructHistoricalPhysicalState,
  reconstructPiecewiseConstant,
  sourceTelemetryUnavailableGaps,
} from '../src/telemetry/historical-telemetry-policy.js'
import type { PressSemanticSignalEvidence, TelemetrySample } from '../src/telemetry/telemetry-contracts.js'

const start = '2026-08-17T00:00:00.000Z'
const at = (minute: number) => new Date(Date.parse(start) + minute * 60_000).toISOString()
const sample = (minute: number, value: number, qualityState = 'good', sourceTimestampUtc: string | null = at(minute)): TelemetrySample => ({ observedAtUtc: at(minute), receivedAtUtc: at(minute), sourceTimestampUtc, qualityState, valueKind: 'numeric', value })
const signal = (minutes: number[]): PressSemanticSignalEvidence => ({ canonicalId: 'machine.speed.actual', deckNumber: null, capabilityState: 'SUPPORTED', observationState: minutes.length ? 'SUPPORTED_WITH_OBSERVATIONS' : 'SUPPORTED_WITH_NO_SAMPLES_IN_RANGE', mappingStatus: 'MAPPED', sourceUnit: 'ft/min', canonicalUnitStatus: 'unverified', representation: 'samples', seed: null, samples: minutes.map((minute) => sample(minute, 0)), changes: [] })

test('historical quality accepts only true/good and keeps nullable source timestamps valid', () => {
  assert.equal(isGoodTelemetryQuality('true'), true)
  assert.equal(isGoodTelemetryQuality('GOOD'), true)
  assert.equal(isGoodTelemetryQuality('false'), false)
  assert.equal(isGoodTelemetryQuality('bad'), false)
  assert.equal(sample(0, 0, 'good', null).sourceTimestampUtc, null)
})

test('piecewise reconstruction holds five-minute heartbeat values without a 30-second UNKNOWN gap', () => {
  const intervals = reconstructPiecewiseConstant([sample(0, 0), sample(5, 0), sample(10, 0)], at(0), at(15))
  assert.equal(intervals.reduce((sum, item) => sum + item.durationMs, 0), 15 * 60_000)
  assert.ok(intervals.every(({ quality, value }) => quality === 'GOOD' && value === 0))
  const motion = reconstructHistoricalPhysicalState({ sourceId: 15, sourceKey: 'press15', displayName: 'Press 15', fromUtc: at(0), toUtc: at(15), samples: [sample(0, 0), sample(5, 0), sample(10, 0)], unavailable: [] })
  assert.deepEqual(motion.segments.map(({ state }) => state), ['STOPPED'])
  assert.equal(motion.summary.durationsMs.STOPPED, 15 * 60_000)
})

test('BAD or false speed becomes UNKNOWN rather than physical zero evidence', () => {
  const motion = reconstructHistoricalPhysicalState({ sourceId: 15, sourceKey: 'press15', displayName: 'Press 15', fromUtc: at(0), toUtc: at(15), samples: [sample(0, 0, 'good'), sample(5, 0, 'false'), sample(10, 700, 'true')], unavailable: [] })
  assert.deepEqual(motion.segments.map(({ state }) => state), ['STOPPED', 'UNKNOWN', 'RUNNING'])
  assert.deepEqual(motion.segments.map(({ durationMs }) => durationMs), [5 * 60_000, 5 * 60_000, 5 * 60_000])
})

test('one press silence is source-specific and requires another independent source before becoming shared outage', () => {
  const press15Gaps = sourceTelemetryUnavailableGaps([signal([0, 5, 10, 35, 40]), { ...signal([0, 5, 10, 35, 40]), canonicalId: 'machine.speed.setpoint' }], { start, end: at(45) })
  assert.deepEqual(press15Gaps, [{ startUtc: at(10), endUtc: at(35), durationMs: 25 * 60_000, witnessCount: 2 }])
  const p15 = press15Gaps.map((gap) => ({ fromUtc: gap.startUtc, toUtc: gap.endUtc, state: 'SOURCE_TELEMETRY_UNAVAILABLE' as const, witnessCount: gap.witnessCount }))
  assert.deepEqual(corroborateSharedCollectionOutages([{ pressKey: 'press15', intervals: p15 }, { pressKey: 'press14', intervals: [] }]), [])
  assert.deepEqual(corroborateSharedCollectionOutages([{ pressKey: 'press15', intervals: p15 }, { pressKey: 'press14', intervals: p15 }]), [{ fromUtc: at(10), toUtc: at(35), state: 'SHARED_COLLECTION_OUTAGE', witnessCount: 2 }])
})

test('source silence follows one missed five-minute heartbeat plus jitter instead of a fifteen-minute floor', () => {
  const gapsFor = (silenceMinutes: number) => sourceTelemetryUnavailableGaps([
    signal([0, 5, 10, 10 + silenceMinutes, 15 + silenceMinutes]),
    { ...signal([0, 5, 10, 10 + silenceMinutes, 15 + silenceMinutes]), canonicalId: 'machine.speed.setpoint' },
  ], { start, end: at(20 + silenceMinutes) })

  assert.deepEqual(gapsFor(5.5), [])
  for (const silenceMinutes of [6, 8, 12, 20]) {
    assert.deepEqual(gapsFor(silenceMinutes), [{ startUtc: at(10), endUtc: at(10 + silenceMinutes), durationMs: silenceMinutes * 60_000, witnessCount: 2 }])
  }
})

test('matching short source silences become shared only after independent press corroboration', () => {
  for (const silenceMinutes of [6, 8, 12, 20]) {
    const sourceGaps = sourceTelemetryUnavailableGaps([
      signal([0, 5, 10, 10 + silenceMinutes, 15 + silenceMinutes]),
      { ...signal([0, 5, 10, 10 + silenceMinutes, 15 + silenceMinutes]), canonicalId: 'machine.speed.setpoint' },
    ], { start, end: at(20 + silenceMinutes) })
    const intervals = sourceGaps.map((gap) => ({ fromUtc: gap.startUtc, toUtc: gap.endUtc, state: 'SOURCE_TELEMETRY_UNAVAILABLE' as const, witnessCount: gap.witnessCount }))
    assert.deepEqual(corroborateSharedCollectionOutages([{ pressKey: 'press15', intervals }, { pressKey: 'press14', intervals: [] }]), [])
    assert.deepEqual(corroborateSharedCollectionOutages([{ pressKey: 'press15', intervals }, { pressKey: 'press14', intervals }]), [{ fromUtc: at(10), toUtc: at(10 + silenceMinutes), state: 'SHARED_COLLECTION_OUTAGE', witnessCount: 2 }])
  }
})

test('trailing machine silence begins after the last trustworthy evidence and does not fabricate speed zero', () => {
  const gaps = sourceTelemetryUnavailableGaps([signal([0, 5, 10, 15]), { ...signal([0, 5, 10, 15]), canonicalId: 'machine.speed.setpoint' }], { start, end: at(40) })
  assert.deepEqual(gaps, [{ startUtc: at(15), endUtc: at(40), durationMs: 25 * 60_000, witnessCount: 2 }])
  const unavailable = gaps.map((gap) => ({ fromUtc: gap.startUtc, toUtc: gap.endUtc, state: 'SOURCE_TELEMETRY_UNAVAILABLE' as const, witnessCount: gap.witnessCount }))
  const motion = reconstructHistoricalPhysicalState({ sourceId: 15, sourceKey: 'press15', displayName: 'Press 15', fromUtc: at(0), toUtc: at(40), samples: [sample(0, 1_200), sample(5, 1_200), sample(10, 1_200), sample(15, 1_200)], unavailable })
  assert.deepEqual(motion.segments.map(({ state }) => state), ['RUNNING', 'UNKNOWN'])
  assert.equal(motion.segments[1]?.reason, 'The selected machine/source telemetry is unavailable.')
})

test('no supported detailed observations is insufficient history, while raw expiration remains a separate limitation', () => {
  assert.equal(assessDetailedHistory([signal([])]).state, 'INSUFFICIENT_DETAILED_TELEMETRY')
  assert.deepEqual(assessRawHistory({ framesRead: 0, historianReadCount: 0 }), { state: 'RAW_HISTORY_EXPIRED', detailedTelemetryMayRemainAvailable: true, reason: 'Raw snapshot history is unavailable for this period; mapped detailed telemetry may still be available.' })
  assert.equal(assessRawHistory({ framesRead: 0, historianReadCount: 5 }).state, 'RAW_HISTORY_EXPIRED')
  assert.equal(assessRawHistory({ historianReadCount: 1, observations: [] }).state, 'RAW_HISTORY_EXPIRED')
  assert.equal(assessRawHistory({ framesRead: 10, historianReadCount: 5 }).state, 'RAW_AVAILABLE')
})
