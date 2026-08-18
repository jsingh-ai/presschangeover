import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildRadiusPhysicalAlignment, rankRelatedSignals } from '../src/industrial-analytics/explorer-evidence.js'

const origin = Date.parse('2026-08-17T10:00:00.000Z')
const at = (minutes: number) => new Date(origin + minutes * 60_000).toISOString()
const speed = (changeAt: number | null) => Array.from({ length: 21 }, (_item, index) => { const minute = index - 10; return { atUtc: at(minute), value: changeAt !== null && minute >= changeAt ? 40 : 100 } })
const alignment = (changeAt: number | null) => buildRadiusPhysicalAlignment({ pressKey: 'press14', occurrenceId: 'selected', recordedRadius: { eventType: 'M', statusCode: '20', statusDescription: 'Make Ready' }, recordedStartUtc: at(0), recordedEndUtc: at(5), speedSamples: speed(changeAt), sourceUnit: 'fpm' })

describe('shared explorer evidence', () => {
  it('classifies physical-before, recorded-before, aligned, cadence-ambiguous, and unsupported timing conservatively', () => {
    assert.equal(alignment(-3).agreementClass, 'PHYSICAL_PRECEDES_RECORDED')
    assert.equal(alignment(3).agreementClass, 'RECORDED_PRECEDES_PHYSICAL')
    assert.equal(alignment(0).agreementClass, 'ALIGNED_WITHIN_CADENCE')
    const ambiguous = buildRadiusPhysicalAlignment({ pressKey: 'press14', occurrenceId: 'ambiguous', recordedRadius: { eventType: 'M', statusCode: '20', statusDescription: 'Make Ready' }, recordedStartUtc: at(0), recordedEndUtc: at(5), speedSamples: [...Array.from({ length: 6 }, (_item, index) => ({ atUtc: at(-10 + index * 2), value: 100 })), { atUtc: at(1), value: 40 }, { atUtc: at(3), value: 40 }], sourceUnit: 'fpm' })
    assert.equal(ambiguous.agreementClass, 'INDETERMINATE_WITHIN_CADENCE')
    assert.equal(alignment(null).agreementClass, 'NO_SUPPORTED_PHYSICAL_EVIDENCE')
    assert.match(alignment(null).evidenceQuality.excludedReason ?? '', /No material speed departure/)
  })

  it('ranks deterministically with Actual Speed and category diversity without hiding reasons', () => {
    const suggestions = rankRelatedSignals([
      { canonicalId: 'deck.temp.1', deckNumber: 4, friendlyName: 'Temperature 1', signalType: 'continuous', category: 'temperature', scope: 'deck', reasonCodes: ['DELTA_NEAR_EVENT'], timingDetail: null },
      { canonicalId: 'deck.temp.2', deckNumber: 4, friendlyName: 'Temperature 2', signalType: 'continuous', category: 'temperature', scope: 'deck', reasonCodes: ['DELTA_NEAR_EVENT'], timingDetail: null },
      { canonicalId: 'deck.torque', deckNumber: 4, friendlyName: 'Torque', signalType: 'continuous', category: 'torque', scope: 'deck', reasonCodes: ['FIRST_DIVERGENCE'], timingDetail: null },
      { canonicalId: 'machine.speed.actual', deckNumber: null, friendlyName: 'Actual Speed', signalType: 'continuous', category: 'speed', scope: 'machine', reasonCodes: [], timingDetail: null },
    ], 4, 3)
    assert.deepEqual(suggestions.map((item) => item.canonicalId), ['machine.speed.actual', 'deck.torque', 'deck.temp.1'])
    assert.ok(suggestions.every((item) => item.reasonCodes.length > 0 && item.reason.length > 0))
  })
})
