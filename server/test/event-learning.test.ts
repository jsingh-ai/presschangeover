import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { aggregateEventFingerprints, buildOccurrenceFingerprint, compareSelectedToTypical, type EventLearningOccurrence, type EventLearningSignal } from '../src/industrial-analytics/event-learning.js'

const origin = Date.parse('2026-08-18T12:00:00.000Z')
const at = (minutes: number) => new Date(origin + minutes * 60_000).toISOString()
const occurrences: EventLearningOccurrence[] = [0, 60, 120].map((minute, index) => ({ occurrenceId: `event-${index + 1}`, startUtc: at(minute), endUtc: at(minute + 5), label: 'Exact target' }))

describe('shared deterministic event learning', () => {
  it('preserves exact boolean transitions, valid-coverage denominators, timing, and recurring sequence support', () => {
    const state: EventLearningSignal = {
      canonicalId: 'web.enabled', deckNumber: null, friendlyName: 'Web Enable', category: 'state', signalType: 'state_event', sourceUnit: null, valueKind: 'boolean', samples: [],
      changes: [
        { observedAtUtc: at(-3), previousValue: true, value: false, qualityState: 'GOOD', previousQualityState: 'GOOD' },
        { observedAtUtc: at(58), previousValue: true, value: false, qualityState: 'GOOD', previousQualityState: 'GOOD' },
      ],
    }
    const numeric: EventLearningSignal = {
      canonicalId: 'machine.speed.actual', deckNumber: null, friendlyName: 'Actual Speed', category: 'speed', signalType: 'continuous', sourceUnit: 'fpm', valueKind: 'numeric', changes: [],
      samples: [0, 60, 120].flatMap((minute) => [-10, -5, 1, 4].map((offset) => ({ observedAtUtc: at(minute + offset), value: offset < 0 ? 100 : 60, qualityState: 'GOOD' }))),
    }
    const fingerprints = occurrences.map((occurrence) => buildOccurrenceFingerprint(occurrence, [state, numeric]))
    assert.equal(fingerprints[0]!.patterns.find(({ canonicalId }) => canonicalId === 'web.enabled')?.description, 'TRUE → FALSE')
    const aggregated = aggregateEventFingerprints(fingerprints, [state, numeric])
    const toggle = aggregated.findings.find(({ canonicalId }) => canonicalId === 'web.enabled')!
    assert.equal(toggle.observedOccurrenceCount, 2)
    assert.equal(toggle.validOccurrenceCount, 2)
    assert.equal(toggle.occurrenceRate, 1)
    assert.equal(toggle.provenance, 'AUTHORITATIVE')
    assert.ok(aggregated.typicalSequence.some(({ canonicalId }) => canonicalId === 'web.enabled'))
    assert.ok(compareSelectedToTypical(fingerprints[0]!, aggregated.findings).common.some((value) => value.includes('Web Enable')))
  })

  it('marks only clearly low-cardinality integer behavior as inferred discrete and keeps continuous numbers numeric', () => {
    const inferred: EventLearningSignal = { canonicalId: 'state.code', deckNumber: 2, friendlyName: 'State Code', category: 'state', signalType: 'step_reference', sourceUnit: null, valueKind: 'integer', changes: [], samples: [-5, -2, 1, 4].map((minute, index) => ({ observedAtUtc: at(minute), value: index < 2 ? 1 : 2, qualityState: 'GOOD' })) }
    const continuous: EventLearningSignal = { canonicalId: 'deck.torque', deckNumber: 2, friendlyName: 'Torque', category: 'torque', signalType: 'continuous', sourceUnit: 'Nm', valueKind: 'numeric', changes: [], samples: [-5, -2, 1, 4].map((minute, index) => ({ observedAtUtc: at(minute), value: index < 2 ? 10.25 : 15.75, qualityState: 'GOOD' })) }
    const fingerprint = buildOccurrenceFingerprint(occurrences[0]!, [inferred, continuous])
    assert.equal(fingerprint.patterns.find(({ canonicalId }) => canonicalId === 'state.code')?.provenance, 'INFERRED_LOW_CARDINALITY')
    assert.equal(fingerprint.patterns.find(({ canonicalId }) => canonicalId === 'state.code')?.description, '1 → 2')
    assert.equal(fingerprint.patterns.find(({ canonicalId }) => canonicalId === 'deck.torque')?.kind, 'numeric')
  })

  it('does not invent a sequence from a single supported occurrence', () => {
    const one: EventLearningSignal = { canonicalId: 'mode', deckNumber: null, friendlyName: 'Mode', category: 'state', signalType: 'state_event', sourceUnit: null, valueKind: 'string', samples: [], changes: [{ observedAtUtc: at(-1), previousValue: 'AUTO', value: 'MANUAL', qualityState: 'GOOD', previousQualityState: 'GOOD' }] }
    const fingerprint = buildOccurrenceFingerprint(occurrences[0]!, [one])
    assert.deepEqual(aggregateEventFingerprints([fingerprint], [one]).typicalSequence, [])
  })
})
