import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { detectDeltaEvents, detectThresholdEvents, detectValueChangeEvents, type NumericEventObservation, type ThresholdOperator, type ValueEventObservation } from '../src/telemetry-event-explorer/telemetry-event-engine.js'

const at = (minute: number) => `2026-08-17T10:${String(minute).padStart(2, '0')}:00.000Z`
const values = (...input: Array<[number, number]>): NumericEventObservation[] => input.map(([minute, value]) => ({ atUtc: at(minute), value, qualityState: 'GOOD' }))

describe('Telemetry Event Explorer mathematics', () => {
  it('keeps one continuous threshold excursion and separates true recrossings', () => {
    const one = detectThresholdEvents({ observations: values([0, 198], [1, 201], [2, 204], [3, 203], [4, 199]), fromUtc: at(0), toUtc: at(5), rule: { operator: '>', threshold: 200 } })
    assert.equal(one.length, 1)
    assert.deepEqual({ start: one[0]?.startUtc, end: one[0]?.endUtc, entry: one[0]?.entryValue, extreme: one[0]?.extremeValue, return: one[0]?.returnValue }, { start: at(1), end: at(4), entry: 201, extreme: 204, return: 199 })
    const two = detectThresholdEvents({ observations: values([0, 198], [1, 202], [2, 199], [3, 203], [4, 201], [5, 198]), fromUtc: at(0), toUtc: at(6), rule: { operator: '>', threshold: 200 } })
    assert.equal(two.length, 2)
  })

  it('honors every threshold operator and exact equality', () => {
    const input = values([0, 199], [1, 200], [2, 201])
    const count = (operator: ThresholdOperator) => detectThresholdEvents({ observations: input, fromUtc: at(0), toUtc: at(3), rule: { operator, threshold: 200 } }).length
    assert.equal(count('>'), 1); assert.equal(count('>='), 1); assert.equal(count('<'), 1); assert.equal(count('<='), 1)
    assert.equal(detectThresholdEvents({ observations: input, fromUtc: at(0), toUtc: at(3), rule: { operator: '>', threshold: 200 } })[0]?.startUtc, at(2))
    assert.equal(detectThresholdEvents({ observations: input, fromUtc: at(0), toUtc: at(3), rule: { operator: '>=', threshold: 200 } })[0]?.startUtc, at(1))
  })

  it('marks query-edge clipping and does not bridge a significant telemetry gap', () => {
    const activeAtStart = detectThresholdEvents({ observations: values([0, 205], [1, 206], [2, 199]), seed: { atUtc: '2026-08-17T09:59:00.000Z', value: 204 }, fromUtc: at(0), toUtc: at(3), rule: { operator: '>', threshold: 200 } })
    assert.equal(activeAtStart[0]?.clippedStart, true)
    assert.equal(activeAtStart[0]?.startUtc, at(0))
    const gap = detectThresholdEvents({ observations: [{ atUtc: at(0), value: 205 }, { atUtc: at(1), value: 206 }, { atUtc: '2026-08-17T10:20:00.000Z', value: 207 }], fromUtc: at(0), toUtc: '2026-08-17T10:21:00.000Z', rule: { operator: '>', threshold: 200 } })
    assert.equal(gap.length, 1)
    assert.equal(gap[0]?.dataGap, true)
    const seededGap = detectThresholdEvents({ observations: [{ atUtc: '2026-08-17T10:20:00.123456Z', value: 207 }], seed: { atUtc: '2026-08-17T09:50:00.999999Z', value: 205 }, fromUtc: at(0), toUtc: '2026-08-17T10:21:00.000Z', rule: { operator: '>', threshold: 200 } })
    assert.equal(seededGap.length, 0)
    const afterRecovery = detectThresholdEvents({ observations: [{ atUtc: at(0), value: 205 }, { atUtc: at(20), value: 207 }, { atUtc: at(21), value: 199 }, { atUtc: at(22), value: 208 }, { atUtc: at(23), value: 198 }], fromUtc: at(0), toUtc: at(24), rule: { operator: '>', threshold: 200 } })
    assert.deepEqual(afterRecovery.map(({ startUtc }) => startUtc), [at(0), at(22)])
  })

  it('finds the first qualifying rolling increase without requiring an exact window endpoint', () => {
    const result = detectDeltaEvents({ observations: values([0, 180], [3, 182], [7, 186]), fromUtc: at(0), toUtc: at(8), rule: { direction: 'increase', amount: 5, windowMinutes: 10 } })
    assert.equal(result.length, 1)
    assert.deepEqual({ baseline: result[0]?.baselineAtUtc, baselineValue: result[0]?.baselineValue, trigger: result[0]?.triggerAtUtc, triggerValue: result[0]?.triggerValue, delta: result[0]?.actualDelta, elapsed: result[0]?.elapsedSeconds }, { baseline: at(0), baselineValue: 180, trigger: at(7), triggerValue: 186, delta: 6, elapsed: 420 })
  })

  it('supports decrease/either, exact amount, rejects outside-window changes, and collapses overlap', () => {
    const decrease = detectDeltaEvents({ observations: values([0, 20], [2, 17], [4, 15], [5, 14], [6, 20]), fromUtc: at(0), toUtc: at(7), rule: { direction: 'decrease', amount: 5, windowMinutes: 10 } })
    assert.equal(decrease.length, 1); assert.equal(decrease[0]?.actualDelta, -5); assert.equal(decrease[0]?.maximumExcursion, -6)
    const either = detectDeltaEvents({ observations: values([0, 10], [2, 15]), fromUtc: at(0), toUtc: at(3), rule: { direction: 'either', amount: 5, windowMinutes: 10 } })
    assert.equal(either[0]?.direction, 'increase')
    const outside = detectDeltaEvents({ observations: values([0, 10], [20, 20]), fromUtc: at(0), toUtc: '2026-08-17T10:21:00.000Z', rule: { direction: 'increase', amount: 5, windowMinutes: 10 } })
    assert.equal(outside.length, 0)
  })

  it('keeps separate excursions separate, handles irregular cadence, duplicate timestamps, and gaps', () => {
    const input: NumericEventObservation[] = [...values([0, 10], [2, 16], [3, 10], [6, 17]), { atUtc: at(6), value: 18 }, { atUtc: '2026-08-17T10:30:00.000Z', value: 25 }]
    const result = detectDeltaEvents({ observations: input, fromUtc: at(0), toUtc: '2026-08-17T10:31:00.000Z', rule: { direction: 'increase', amount: 5, windowMinutes: 10 } })
    assert.equal(result.length, 2)
    assert.equal(result[1]?.triggerValue, 18)
    assert.equal(result[1]?.dataGap, true)
  })

  it('creates one string occurrence per actual transition and ignores repeats', () => {
    const observations: ValueEventObservation[] = [
      { atUtc: at(0), value: 'ABC' }, { atUtc: at(1), value: 'ABC' },
      { atUtc: at(2), value: 'XYZ' }, { atUtc: at(3), value: 'XYZ' },
      { atUtc: at(4), value: 'DEF' },
    ]
    const result = detectValueChangeEvents({ observations, fromUtc: at(0), toUtc: at(5), rule: { match: 'any' } })
    assert.deepEqual(result.map(({ previousValue, newValue, transitionAtUtc, durationSeconds }) => ({ previousValue, newValue, transitionAtUtc, durationSeconds })), [
      { previousValue: 'ABC', newValue: 'XYZ', transitionAtUtc: at(2), durationSeconds: 0 },
      { previousValue: 'XYZ', newValue: 'DEF', transitionAtUtc: at(4), durationSeconds: 0 },
    ])
    assert.equal(detectValueChangeEvents({ observations: observations.slice(0, 2), fromUtc: at(0), toUtc: at(5), rule: { match: 'any' } }).length, 0)
  })

  it('supports Becomes and exact From-to string rules without coercion', () => {
    const observations: ValueEventObservation[] = [{ atUtc: at(0), value: '001' }, { atUtc: at(1), value: '1' }, { atUtc: at(2), value: '002' }]
    const becomes = detectValueChangeEvents({ observations, fromUtc: at(0), toUtc: at(3), rule: { match: 'becomes', becomesValue: '002' } })
    assert.deepEqual(becomes.map(({ previousValue, newValue }) => [previousValue, newValue]), [['1', '002']])
    const fromTo = detectValueChangeEvents({ observations, fromUtc: at(0), toUtc: at(3), rule: { match: 'from_to', fromValue: '001', toValue: '1' } })
    assert.equal(fromTo.length, 1)
    assert.equal(detectValueChangeEvents({ observations, fromUtc: at(0), toUtc: at(3), rule: { match: 'becomes', becomesValue: 1 } }).length, 0)
  })

  it('preserves boolean transitions and filters either direction exactly', () => {
    const observations: ValueEventObservation[] = [{ atUtc: at(0), value: false }, { atUtc: at(1), value: false }, { atUtc: at(2), value: true }, { atUtc: at(3), value: true }, { atUtc: at(4), value: false }]
    const any = detectValueChangeEvents({ observations, fromUtc: at(0), toUtc: at(5), rule: { match: 'any' } })
    assert.deepEqual(any.map(({ previousValue, newValue }) => [previousValue, newValue]), [[false, true], [true, false]])
    assert.deepEqual(detectValueChangeEvents({ observations, fromUtc: at(0), toUtc: at(5), rule: { match: 'from_to', fromValue: false, toValue: true } }).map(({ previousValue, newValue }) => [previousValue, newValue]), [[false, true]])
  })

  it('uses a seed for a query that starts mid-state and marks clipping and telemetry gaps', () => {
    const result = detectValueChangeEvents({ observations: [{ atUtc: at(1), value: 'XYZ' }, { atUtc: at(30), value: 'DEF' }], seed: { atUtc: '2026-08-17T09:59:00.000Z', value: 'ABC' }, fromUtc: at(0), toUtc: at(31), rule: { match: 'any' } })
    assert.equal(result[0]?.previousValue, 'ABC'); assert.equal(result[0]?.clippedStart, true)
    assert.equal(result.length, 1)
  })

  it('never turns an outage or reconnect into a value-change occurrence', () => {
    const result = detectValueChangeEvents({ observations: [{ atUtc: at(0), value: 'ORDER-A' }, { atUtc: at(20), value: 'ORDER-B' }, { atUtc: at(21), value: 'ORDER-C' }], fromUtc: at(0), toUtc: at(22), rule: { match: 'any' } })
    assert.deepEqual(result.map(({ previousValue, newValue, transitionAtUtc }) => ({ previousValue, newValue, transitionAtUtc })), [{ previousValue: 'ORDER-B', newValue: 'ORDER-C', transitionAtUtc: at(21) }])
  })

  it('drops invalid/missing values and resolves duplicate timestamps deterministically', () => {
    const observations = [{ atUtc: at(0), value: 'ABC' }, { atUtc: at(1), value: null }, { atUtc: at(2), value: 'OLD' }, { atUtc: at(2), value: 'XYZ' }, { atUtc: at(3), value: 'DEF', qualityState: 'BAD' }] as unknown as ValueEventObservation[]
    const result = detectValueChangeEvents({ observations, fromUtc: at(0), toUtc: at(4), rule: { match: 'any' } })
    assert.deepEqual(result.map(({ previousValue, newValue }) => [previousValue, newValue]), [['ABC', 'XYZ']])
  })
})
