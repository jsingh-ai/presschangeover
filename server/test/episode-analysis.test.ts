import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  analyzeFleetEpisodes,
  analyzePressEpisodes,
  compressedEpisodeSegments,
  episodeDescriptor,
  percentile,
} from '../src/radius/episode-analysis.js'
import type { OperationalEpisode, RadiusPressKey, ReturnToProductionState } from '../src/radius/models.js'

type State = [description: string, seconds: number, production?: boolean, returnState?: ReturnToProductionState]

function episode(
  id: string,
  states: State[],
  options: Partial<OperationalEpisode> & { pressKey?: RadiusPressKey } = {},
): OperationalEpisode {
  const pressKey = options.pressKey ?? 'press7'
  const startMs = Date.parse(options.startUtc ?? '2025-01-10T14:00:00.000Z')
  let cursor = startMs
  const statusSegments = states.map(([statusDescription, durationSeconds, isProduction = false, returnToProduction]) => {
    const startUtc = new Date(cursor).toISOString()
    cursor += durationSeconds * 1_000
    return {
      kind: 'radius' as const,
      machineId: 7,
      pressKey,
      displayName: `Press ${pressKey.slice(5)}`,
      startUtc,
      endUtc: new Date(cursor).toISOString(),
      durationSeconds,
      isOpen: false,
      sourceGeneration: 'compact' as const,
      eventType: isProduction ? 'G' : statusDescription.includes('Make Ready') ? 'M' : 'B',
      statusCode: null,
      statusDescription,
      isProduction,
      returnToProduction,
    }
  })
  const failed = states.filter(([, , , value]) => value === 'failed').length
  const confirmed = states.some(([, , , value]) => value === 'confirmed')
  return {
    episodeId: id,
    pressKey,
    displayName: `Press ${pressKey.slice(5)}`,
    radiusMachineId: 7,
    startUtc: new Date(startMs).toISOString(),
    endUtc: new Date(cursor).toISOString(),
    durationSeconds: (cursor - startMs) / 1_000,
    isOpen: !confirmed,
    completionStatus: confirmed ? 'CONFIRMED_PRODUCTION' : 'OPEN',
    dataInterrupted: false,
    startedAfterDataGap: false,
    startedBeforeRange: false,
    startStatus: states[0][0],
    statusSegments,
    returnToProductionAttemptCount: failed + (confirmed ? 1 : 0),
    failedReturnToProductionAttempts: failed,
    confirmedProductionStartUtc: confirmed ? statusSegments.at(-1)?.startUtc ?? null : null,
    confirmationSatisfiedUtc: confirmed ? statusSegments.at(-1)?.endUtc ?? null : null,
    confirmationDurationSeconds: confirmed ? statusSegments.at(-1)?.durationSeconds ?? 0 : 0,
    timeByEventType: {},
    timeByStatusDescription: {},
    primaryStatusDescription: states[0][0],
    ...options,
    displaySegments: options.displaySegments ?? statusSegments,
    displayEndUtc: options.displayEndUtc ?? new Date(cursor).toISOString(),
    wallClockDurationSeconds: options.wallClockDurationSeconds ?? (cursor - startMs) / 1_000,
    observedDurationSeconds: options.observedDurationSeconds ?? (cursor - startMs) / 1_000,
    unavailableDurationSeconds: options.unavailableDurationSeconds ?? 0,
  }
}

const commonStates: State[] = [
  ['Make Ready', 600],
  ['Make Ready Sleeves', 300],
  ['Run Production', 300, true, 'confirmed'],
]

describe('episode analysis', () => {
  it('compresses adjacent identical states and derives a human descriptor', () => {
    const value = episode('one', [
      ['Make Ready', 60],
      ['Make Ready', 90],
      ['Impression', 120],
      ['Run Production', 300, true, 'confirmed'],
    ])
    assert.deepEqual(compressedEpisodeSegments(value).map(({ statusDescription, durationSeconds }) => [statusDescription, durationSeconds]), [
      ['Make Ready', 150], ['Impression', 120], ['Run Production', 300],
    ])
    assert.equal(episodeDescriptor(value), 'Make Ready → Impression')
  })

  it('calculates first and final states, sequence families, medians, and transitions', () => {
    const analysis = analyzePressEpisodes([
      episode('a', commonStates),
      episode('b', commonStates),
      episode('c', [['Web Break', 900], ['Make Ready', 300], ['Run Production', 300, true, 'confirmed']]),
    ])
    assert.deepEqual(analysis.firstStates.map(({ statusDescription, count }) => [statusDescription, count]), [['Make Ready', 2], ['Web Break', 1]])
    assert.equal(analysis.finalStatesBeforeSuccess[0].statusDescription, 'Make Ready Sleeves')
    assert.equal(analysis.sequenceFamilies[0].count, 2)
    assert.equal(analysis.medianDurationSeconds, 1200)
    assert.equal(analysis.transitionSummaries.find(({ fromStatusDescription }) => fromStatusDescription === 'Make Ready')?.outcomes[0].statusDescription, 'Make Ready Sleeves')
  })

  it('summarizes first-return outcomes using confirmed episodes only', () => {
    const analysis = analyzePressEpisodes([
      episode('first', commonStates),
      episode('one-fail', [['Make Ready', 200], ['Run Production', 100, true, 'failed'], ['Make Ready', 100], ['Run Production', 300, true, 'confirmed']]),
      episode('two-fail', [['Make Ready', 100], ['Run Production', 50, true, 'failed'], ['Web Break', 60], ['Run Production', 50, true, 'failed'], ['Make Ready', 100], ['Run Production', 300, true, 'confirmed']]),
      episode('open', [['Make Ready', 100]]),
    ])
    assert.deepEqual(analysis.failedReturns, {
      completedEpisodeCount: 3,
      successfulFirstReturnCount: 1,
      oneFailedReturnCount: 1,
      multipleFailedReturnCount: 1,
      firstReturnSuccessRate: 33.3,
    })
  })

  it('requires minimum samples for percentiles and flags explainable outliers', () => {
    const small = analyzePressEpisodes([1, 2, 3, 4].map((value) => episode(`${value}`, [['Make Ready', value * 10]])))
    assert.equal(small.p90DurationSeconds, null)
    const values = [10, 10, 10, 10, 100].map((seconds, index) => episode(`${index}`, [['Make Ready', seconds]], {
      failedReturnToProductionAttempts: index === 4 ? 2 : 0,
    }))
    const analysis = analyzePressEpisodes(values)
    assert.equal(analysis.p90DurationSeconds, 64)
    assert.equal(analysis.attentionItems.length, 1)
    assert.match(analysis.attentionItems[0].reasons.join(' '), /P90/)
    assert.match(analysis.attentionItems[0].reasons.join(' '), /failed Run Production/)
    assert.match(analysis.attentionItems[0].reasons.join(' '), /sequence-family median/)
  })

  it('groups the same sequence across presses and avoids tiny-cohort comparisons', () => {
    const comparable = analyzeFleetEpisodes([
      episode('7a', commonStates), episode('7b', commonStates),
      episode('8a', commonStates, { pressKey: 'press8' }), episode('8b', commonStates, { pressKey: 'press8' }),
    ]).sequenceFamilies[0]
    assert.equal(comparable.comparable, true)
    assert.equal(comparable.presses.length, 2)
    const insufficient = analyzeFleetEpisodes([
      episode('7', commonStates), episode('8', commonStates, { pressKey: 'press8' }),
    ]).sequenceFamilies[0]
    assert.equal(insufficient.comparable, false)
    assert.match(insufficient.insufficientSampleReason ?? '', /two episodes each/)
  })

  it('keeps historical inputs deterministic and explains interrupted data', () => {
    const interrupted = episode('old', [['Make Ready', 300]], {
      startUtc: '2020-01-01T00:00:00.000Z',
      completionStatus: 'DATA_INTERRUPTED',
      dataInterrupted: true,
      isOpen: false,
    })
    const analysis = analyzePressEpisodes([interrupted])
    assert.equal(analysis.medianDurationSeconds, 300)
    assert.match(analysis.attentionItems[0].reasons[0], /interrupted/)
    assert.equal(percentile([], 0.5), null)
  })
})
