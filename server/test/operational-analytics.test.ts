import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { deriveOperationalEpisodes } from '../src/episodes/episode-engine.js'
import { analyzeOperationalHistory } from '../src/radius/operational-analytics.js'
import type { RadiusPressMapping, RadiusStatusSegment } from '../src/radius/models.js'

const fromUtc = '2026-08-10T00:00:00.000Z'
const toUtc = '2026-08-10T01:00:00.000Z'
const mapping: RadiusPressMapping = { pressKey: 'press7', displayName: 'Press 7', machineId: 7 }

function at(minutes: number): string {
  return new Date(Date.parse(fromUtc) + minutes * 60_000).toISOString()
}

function state(
  description: string,
  start: number,
  end: number,
  eventType: string,
  statusCode: string | null = description,
  sourceGeneration: 'legacy' | 'compact' = 'compact',
  press = mapping,
): RadiusStatusSegment {
  return {
    kind: 'radius', machineId: press.machineId, pressKey: press.pressKey, displayName: press.displayName,
    startUtc: at(start), endUtc: at(end), durationSeconds: (end - start) * 60, isOpen: false,
    sourceGeneration, eventType, statusCode, statusDescription: description,
    isProduction: eventType === 'G' && description === 'Run Production',
  }
}

function offline(start: number, end: number, press = mapping): RadiusStatusSegment {
  return {
    kind: 'offline', machineId: press.machineId, pressKey: press.pressKey, displayName: press.displayName,
    startUtc: at(start), endUtc: at(end), durationSeconds: (end - start) * 60, isOpen: false,
    sourceGeneration: 'offline_inference', eventType: null, statusCode: null, statusDescription: null, isProduction: false,
  }
}

function input(segments: RadiusStatusSegment[], press = mapping) {
  return {
    pressKey: press.pressKey,
    displayName: press.displayName,
    segments,
    episodes: deriveOperationalEpisodes(segments, press, fromUtc, toUtc),
  }
}

const representative = [
  state('Run Production', 0, 10, 'G', 'RP'),
  state('Make Ready', 10, 20, 'M', 'MR'),
  state('Press Problem', 20, 25, 'B', 'PP'),
  state('Make Ready', 25, 30, 'M', 'MR'),
  state('Run Production', 30, 40, 'G', 'RP'),
  offline(40, 45),
  state('Safety Check', 45, 50, 'S', 'SC'),
  state('Run Production', 50, 60, 'G', 'RP'),
]

describe('operational analytics', () => {
  it('calculates category duration, observed percentages, production, and unknown time exactly', () => {
    const result = analyzeOperationalHistory([input(representative)], fromUtc, toUtc)
    assert.deepEqual(result.coverage, {
      possibleSeconds: 3600,
      observedSeconds: 3300,
      unknownSeconds: 300,
      coveragePercentage: 91.7,
    })
    assert.deepEqual(result.categories.map(({ category, durationSeconds, occurrenceCount, productionSeconds }) => ({ category, durationSeconds, occurrenceCount, productionSeconds })), [
      { category: 'Good', durationSeconds: 1800, occurrenceCount: 3, productionSeconds: 1800 },
      { category: 'Make Ready', durationSeconds: 900, occurrenceCount: 2, productionSeconds: 0 },
      { category: 'Bad', durationSeconds: 300, occurrenceCount: 1, productionSeconds: 0 },
      { category: 'Radius S state', durationSeconds: 300, occurrenceCount: 1, productionSeconds: 0 },
    ])
  })

  it('groups exact status identities under their category with support and clipping evidence', () => {
    const result = analyzeOperationalHistory([input(representative)], fromUtc, toUtc)
    const makeReady = result.statusDrivers.find(({ statusCode }) => statusCode === 'MR')!
    assert.equal(makeReady.category, 'Make Ready')
    assert.equal(makeReady.durationSeconds, 900)
    assert.equal(makeReady.occurrenceCount, 2)
    assert.equal(makeReady.medianOccurrenceSeconds, 450)
    assert.equal(makeReady.p90OccurrenceSeconds, null)
    assert.equal(makeReady.pressCount, 1)
    assert.equal(makeReady.percentageOfObserved, 27.3)
    assert.equal(makeReady.percentageWithinCategory, 100)
  })

  it('uses exact immediate transition numerators/denominators and previous-state direction', () => {
    const result = analyzeOperationalHistory([input(representative)], fromUtc, toUtc)
    const after = result.relationshipGroups.find(({ anchor, direction, maxTransitions }) => anchor.statusCode === 'MR' && direction === 'after' && maxTransitions === 1)!
    assert.equal(after.denominator, 2)
    assert.deepEqual(after.outcomes.map(({ target, numerator, denominator, percentage }) => [target.statusCode, numerator, denominator, percentage]), [
      ['PP', 1, 2, 50], ['RP', 1, 2, 50],
    ])
    const before = result.relationshipGroups.find(({ anchor, direction, maxTransitions }) => anchor.statusCode === 'RP' && direction === 'before' && maxTransitions === 1)!
    assert.ok(before.outcomes.some(({ target, numerator, denominator }) => target.statusCode === 'MR' && numerator === 1 && denominator === before.denominator))
  })

  it('derives production-stop, successful-return, and Make Ready paths from canonical semantics', () => {
    const result = analyzeOperationalHistory([input(representative)], fromUtc, toUtc)
    assert.equal(result.productionStops.anchorCount, 2)
    assert.equal(result.productionStops.resolvedCount, 1)
    assert.equal(result.productionStops.outcomes[0].target.statusCode, 'MR')
    assert.equal(result.productionStops.outcomes[0].numerator, 1)
    assert.equal(result.productionStops.outcomes[0].denominator, 1)
    assert.equal(result.beforeSuccessfulProduction.anchorCount, 2)
    assert.ok(result.beforeSuccessfulProduction.outcomes.some(({ target }) => target.statusCode === 'MR'))
    assert.equal(result.afterMakeReady.anchorCount, 2)
    assert.equal(result.afterMakeReady.resolvedCount, 2)
    assert.equal(result.afterMakeReady.confirmedProductionCount, 1)
    assert.equal(result.afterMakeReady.returnedToMakeReadyCount, 1)
    assert.equal(result.afterMakeReady.enteredBadCount, 1)
    assert.equal(result.afterMakeReady.failedToReachConfirmedProductionCount, 1)
    assert.ok(result.productionStops.paths[0].states.length >= 1)
  })

  it('follows Make Ready to confirmation beyond six path states and counts category outcomes once per anchor', () => {
    const segments = [
      state('Run Production', 0, 5, 'G', 'RP'),
      state('Make Ready', 5, 7, 'M', 'MR'),
      state('Bad 1', 7, 9, 'B', 'B1'),
      state('Good setup 1', 9, 11, 'G', 'G1'),
      state('Bad 2', 11, 13, 'B', 'B2'),
      state('Good setup 2', 13, 15, 'G', 'G2'),
      state('Bad 3', 15, 17, 'B', 'B3'),
      state('Good setup 3', 17, 19, 'G', 'G3'),
      state('Safety check', 19, 21, 'S', 'S1'),
      state('Run Production', 21, 30, 'G', 'RP'),
    ]
    const pattern = analyzeOperationalHistory([input(segments)], fromUtc, toUtc).afterMakeReady
    assert.equal(pattern.anchorCount, 1)
    assert.equal(pattern.confirmedProductionCount, 1)
    assert.equal(pattern.failedToReachConfirmedProductionCount, 0)
    assert.equal(pattern.enteredBadCount, 1)
    assert.equal(pattern.enteredSStateCount, 1)
    assert.equal(pattern.paths[0].states.length, 6)
  })

  it('marks range-edge occurrences as censored and never crosses an offline boundary', () => {
    const segments = [
      state('Carry In', -5, 5, 'B', 'CI'),
      offline(5, 10),
      state('After Gap', 10, 20, 'M', 'AG'),
      state('Right Edge', 55, 65, 'S', 'RE'),
    ]
    const result = analyzeOperationalHistory([input(segments)], fromUtc, toUtc)
    assert.equal(result.statusDrivers.find(({ statusCode }) => statusCode === 'CI')?.clippedOccurrenceCount, 1)
    assert.equal(result.statusDrivers.find(({ statusCode }) => statusCode === 'RE')?.clippedOccurrenceCount, 1)
    const carryAfter = result.relationshipGroups.find(({ anchor, direction, maxTransitions }) => anchor.statusCode === 'CI' && direction === 'after' && maxTransitions === 1)
    assert.equal(carryAfter, undefined)
    assert.equal(result.coverage.unknownSeconds, 2400)
  })

  it('merges identical hybrid-cutover states without overlap or duplicate occurrences', () => {
    const segments = [
      state('Make Ready', 0, 15, 'M', 'MR', 'legacy'),
      state('Make Ready', 15, 30, 'M', 'MR', 'compact'),
      state('Run Production', 30, 60, 'G', 'RP', 'compact'),
    ]
    const result = analyzeOperationalHistory([input(segments)], fromUtc, toUtc)
    const makeReady = result.statusDrivers.find(({ statusCode }) => statusCode === 'MR')!
    assert.equal(makeReady.occurrenceCount, 1)
    assert.equal(makeReady.durationSeconds, 1800)
    assert.equal(result.coverage.observedSeconds, 3600)
  })

  it('aggregates press coverage without creating cross-press transitions', () => {
    const press8: RadiusPressMapping = { pressKey: 'press8', displayName: 'Press 8', machineId: 8 }
    const press7Segments = [state('Shared', 0, 60, 'B', 'SH')]
    const press8Segments = [state('Shared', 0, 30, 'B', 'SH', 'compact', press8), state('Different', 30, 60, 'M', 'DF', 'compact', press8)]
    const result = analyzeOperationalHistory([input(press7Segments), input(press8Segments, press8)], fromUtc, toUtc)
    assert.equal(result.statusDrivers.find(({ statusCode }) => statusCode === 'SH')?.pressCount, 2)
    const sharedAfter = result.relationshipGroups.find(({ anchor, direction, maxTransitions }) => anchor.statusCode === 'SH' && direction === 'after' && maxTransitions === 1)!
    assert.equal(sharedAfter.denominator, 1)
    assert.equal(sharedAfter.outcomes[0].target.statusCode, 'DF')
  })

  it('flags deterministic exceptions only when a dominant relationship has support', () => {
    const segments: RadiusStatusSegment[] = []
    for (let index = 0; index < 6; index += 1) {
      const start = index * 10
      segments.push(state('Anchor', start, start + 5, 'M', 'A'))
      segments.push(state(index === 5 ? 'Exception' : 'Expected', start + 5, start + 10, index === 5 ? 'S' : 'G', index === 5 ? 'X' : 'E'))
    }
    const result = analyzeOperationalHistory([input(segments)], fromUtc, toUtc)
    assert.equal(result.anomalies.length, 1)
    assert.deepEqual(result.anomalies[0].expectedSequence.map(({ statusCode }) => statusCode), ['A', 'E'])
    assert.deepEqual(result.anomalies[0].actualSequence.map(({ statusCode }) => statusCode), ['A', 'X'])
    assert.equal(result.anomalies[0].normalNumerator, 5)
    assert.equal(result.anomalies[0].normalDenominator, 6)
    assert.equal(result.anomalies[0].lowSupport, true)
  })
})
