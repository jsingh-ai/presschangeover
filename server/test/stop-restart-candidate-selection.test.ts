import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { CapabilityAssessment, PressSemanticSignalEvidence, TelemetrySample } from '../src/telemetry/telemetry-contracts.js'
import { PRE_STOP_CANDIDATE_POLICY, currentScreenCandidates, selectHistoricalCandidates, type CandidateIdentity } from '../src/telemetry/stop-restart-candidate-selection.js'

const sample = (observedAtUtc: string, value: number): TelemetrySample => ({ observedAtUtc, receivedAtUtc: observedAtUtc, sourceTimestampUtc: observedAtUtc, qualityState: 'GOOD', valueKind: 'numeric', value })
const supported = (canonicalId: string, deckNumbers: number[] = []): CapabilityAssessment => ({ canonicalId, state: 'SUPPORTED', deckNumbers, historyQueryable: true, evidenceKind: 'semantic_history' })
const signal = (canonicalId: string, deckNumber: number | null, values: number[]): PressSemanticSignalEvidence => ({ canonicalId, deckNumber, capabilityState: 'SUPPORTED', observationState: 'SUPPORTED_WITH_OBSERVATIONS', mappingStatus: 'MAPPED', sourceUnit: null, canonicalUnitStatus: 'UNVERIFIED', representation: 'samples', seed: null, samples: values.map((value, index) => sample(new Date(Date.parse('2026-08-13T11:50:00.000Z') + index * 60_000).toISOString(), value)), changes: [] })
const stable = { supported: true, fromUtc: '2026-08-13T11:50:00.000Z', toUtc: '2026-08-13T11:53:00.000Z', durationSeconds: 180, bucket: 'RUNNING' as const, stats: null, changing: false, timeSincePreviousStoppedSeconds: null, observationCount: 4, maximumGapSeconds: 60, boundaryGapSeconds: null, supportReason: 'SUPPORTED' as const }

describe('two-stage stop precursor candidate selection', () => {
  it('can consider a persistently elevated automatic deck signal without any local clue', () => {
    const capabilities = [supported('anilox.drive.torque.actual', [4])]
    const screen = currentScreenCandidates(capabilities)
    assert.deepEqual(screen.map(({ canonicalId, deckNumber }) => [canonicalId, deckNumber]), [['anilox.drive.torque.actual', 4]])
    const result = selectHistoricalCandidates({ requested: [], screen, currentSignals: [signal('anilox.drive.torque.actual', 4, [22, 22, 22, 22])], stableRunningBefore: stable, operationalGroupName: 'Maintenance Intervention', processFamilyName: 'Mechanical / Electrical' })
    assert.equal(result.selected.some(({ canonicalId, deckNumber }) => canonicalId === 'anilox.drive.torque.actual' && deckNumber === 4), true)
    assert.equal(result.counts.clue, 0)
    assert.ok(result.counts.activity + result.counts.reserved + result.counts.condition > 0)
  })

  it('prioritizes a persistently offset deck by comparing only like-for-like deck identities', () => {
    const capabilities = [supported('anilox.drive.torque.actual', [1, 2, 3, 4, 5])]
    const screen = currentScreenCandidates(capabilities)
    const currentSignals = [1, 2, 3, 4, 5].map((deckNumber) => signal('anilox.drive.torque.actual', deckNumber, deckNumber === 4 ? [22, 22, 22, 22] : [13, 13, 13, 13]))
    const result = selectHistoricalCandidates({ requested: [], screen, currentSignals, stableRunningBefore: stable, operationalGroupName: 'Routine Process', processFamilyName: 'Unknown' })
    assert.equal(result.selected[0]?.deckNumber, 4)
    assert.equal(result.selected[0]?.source, 'reserved')
  })

  it('reserves non-clue slots, remains capped, and retains unrelated generic coverage', () => {
    const capabilities = [supported('anilox.drive.torque.actual', [1, 2, 3, 4, 5]), supported('ink.viscosity.actual', [1, 2, 3, 4, 5]), supported('unwind.tension.actual'), supported('dryer.tunnel.temperature.actual')]
    const screen = currentScreenCandidates(capabilities)
    const currentSignals = screen.map(({ canonicalId, deckNumber }) => signal(canonicalId, deckNumber ?? null, [10, 10, 10, 10]))
    const clues: CandidateIdentity[] = Array.from({ length: 12 }, (_, index) => ({ canonicalId: index % 2 ? 'ink.viscosity.actual' : 'anilox.drive.torque.actual', deckNumber: index % 5 + 1, source: 'clue' }))
    const result = selectHistoricalCandidates({ requested: clues, screen, currentSignals, stableRunningBefore: stable, operationalGroupName: 'Routine Process', processFamilyName: 'Cleaning / Wash' })
    assert.ok(result.selected.length <= PRE_STOP_CANDIDATE_POLICY.maximumHistoricalCandidates)
    assert.ok(result.counts.clue <= PRE_STOP_CANDIDATE_POLICY.maximumLocalClues)
    assert.ok(result.selected.some(({ category }) => category === 'torque'), 'cleaning priority must not exclude unrelated torque coverage')
  })

  it('keeps the broader current screen bounded and category-balanced', () => {
    const capabilities = [supported('anilox.drive.torque.actual', Array.from({ length: 10 }, (_, index) => index + 1)), supported('ink.viscosity.actual', Array.from({ length: 10 }, (_, index) => index + 1)), supported('ink.temperature.actual', Array.from({ length: 10 }, (_, index) => index + 1)), supported('doctor_blade.pressure', Array.from({ length: 10 }, (_, index) => index + 1)), supported('unwind.tension.actual'), supported('rewind.tension.actual')]
    const screen = currentScreenCandidates(capabilities)
    assert.ok(screen.length <= PRE_STOP_CANDIDATE_POLICY.maximumCurrentScreenSelectors)
    assert.ok(new Set(screen.map(({ category }) => category)).size >= 5)
  })
})
