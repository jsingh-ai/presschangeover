import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildOperationalRunComparison, buildOperationalRuns } from '../src/radius/operational-runs.js'
import type { RadiusPressKey, RadiusStatusSegment } from '../src/radius/models.js'

const base = Date.parse('2026-08-01T00:00:00.000Z')

interface RunSpec {
  preProductionSeconds: number
  productionSeconds?: number
  repeatedClean?: boolean
  shortAttempt?: boolean
}

function pressInput(pressKey: RadiusPressKey, displayName: string, specs: RunSpec[]) {
  let cursor = base
  const machineId = Number(pressKey.replace('press', ''))
  const segments: RadiusStatusSegment[] = []
  const add = (eventType: string, statusCode: string, statusDescription: string, seconds: number, isProduction = false, isOpen = false) => {
    const startUtc = new Date(cursor).toISOString()
    cursor += seconds * 1_000
    segments.push({ kind: 'radius', machineId, pressKey, displayName, eventType, statusCode, statusDescription, startUtc, endUtc: new Date(cursor).toISOString(), durationSeconds: seconds, isProduction, isOpen, sourceGeneration: 'compact' })
  }
  add('G', '150', 'Run Production', 600, true)
  for (const spec of specs) {
    const productionSeconds = spec.productionSeconds ?? 900
    if (spec.repeatedClean && spec.shortAttempt) {
      const remaining = spec.preProductionSeconds - 660
      add('M', '47', 'Make Ready', Math.max(1, remaining))
      add('B', '123', 'Clean Impression', 300)
      add('G', '150', 'Run Production', 60, true)
      add('M', '47', 'Make Ready', 60)
      add('B', '123', 'Clean Impression', 240)
    } else {
      const clean = Math.min(300, Math.floor(spec.preProductionSeconds / 3))
      add('M', '47', 'Make Ready', spec.preProductionSeconds - clean)
      add('B', '123', 'Clean Impression', clean)
    }
    add('G', '150', 'Run Production', productionSeconds, true)
  }
  return { pressKey, displayName, segments, toUtc: new Date(cursor + 1_000).toISOString() }
}

const selected = pressInput('press5', 'Press 5', [
  { preProductionSeconds: 600, productionSeconds: 600 },
  { preProductionSeconds: 720, productionSeconds: 700 },
  { preProductionSeconds: 840, productionSeconds: 800 },
  { preProductionSeconds: 960, productionSeconds: 900 },
  { preProductionSeconds: 1_080, productionSeconds: 1_000 },
  { preProductionSeconds: 1_200, productionSeconds: 1_100 },
  { preProductionSeconds: 1_500, productionSeconds: 1_200, repeatedClean: true, shortAttempt: true },
])
const fleetA = pressInput('press6', 'Press 6', Array.from({ length: 5 }, () => ({ preProductionSeconds: 300 })))
const fleetB = pressInput('press7', 'Press 7', Array.from({ length: 5 }, () => ({ preProductionSeconds: 600 })))
const fleetC = pressInput('press8', 'Press 8', Array.from({ length: 5 }, () => ({ preProductionSeconds: 1_800 })))
const fromUtc = new Date(base).toISOString()
const toUtc = [selected, fleetA, fleetB, fleetC].map(({ toUtc }) => toUtc).sort().at(-1)!
const comparison = buildOperationalRunComparison([selected, fleetA, fleetB, fleetC], 'press5', fromUtc, toUtc)
const selectedRun = comparison.runs.find(({ timeToProductionSeconds }) => timeToProductionSeconds === 1_500)!
const clean = selectedRun.statusSummaries.find(({ statusCode }) => statusCode === '123')!

describe('operational Run comparison', () => {
  it('builds one completed Run per non-production-to-sustained-production cycle', () => {
    assert.equal(comparison.runs.length, 7)
    assert.ok(comparison.runs.every(({ productionStartUtc }) => productionStartUtc))
  })

  it('uses the original sustained production start for time to production', () => {
    assert.equal(selectedRun.timeToProductionSeconds, 1_500)
    assert.equal(Date.parse(selectedRun.productionStartUtc!) - Date.parse(selectedRun.startUtc), 1_500_000)
  })

  it('excludes the selected Run from its same-press cohort', () => {
    assert.equal(selectedRun.timeToProductionBenchmark.samePress.sampleRuns, 6)
    assert.equal(selectedRun.timeToProductionBenchmark.samePress.median, 900)
  })

  it('calculates the same-press average', () => {
    assert.equal(selectedRun.timeToProductionBenchmark.samePress.average, 900)
  })

  it('calculates absolute and percent delta from the median', () => {
    assert.equal(selectedRun.timeToProductionBenchmark.samePress.delta, 600)
    assert.ok(Math.abs(selectedRun.timeToProductionBenchmark.samePress.percentDelta! - 66.6667) < 0.01)
  })

  it('calculates a supported same-press percentile', () => {
    assert.equal(selectedRun.timeToProductionBenchmark.samePress.percentile, 100)
  })

  it('labels a materially longer time to production as slower', () => {
    assert.equal(selectedRun.timeToProductionBenchmark.direction, 'slower')
  })

  it('uses the deterministic similar tolerance band', () => {
    const typicalRun = comparison.runs.find(({ timeToProductionSeconds }) => timeToProductionSeconds === 960)!
    assert.equal(typicalRun.timeToProductionBenchmark.direction, 'typical')
  })

  it('does not over-flag when same-press support is low', () => {
    const low = pressInput('press9', 'Press 9', [{ preProductionSeconds: 600 }, { preProductionSeconds: 1_500 }])
    const result = buildOperationalRunComparison([low], 'press9', fromUtc, low.toUtc)
    assert.equal(result.runs[0]!.timeToProductionBenchmark.direction, 'low_support')
    assert.equal(result.runs[0]!.timeToProductionBenchmark.samePress.sufficientSupport, false)
  })

  it('excludes the selected press from fleet support', () => {
    assert.equal(selectedRun.timeToProductionBenchmark.fleet.samplePresses, 3)
    assert.equal(selectedRun.timeToProductionBenchmark.fleet.sampleRuns, 15)
  })

  it('uses a press-balanced median of per-press medians', () => {
    assert.equal(selectedRun.timeToProductionBenchmark.fleet.median, 600)
  })

  it('uses an equal-press average rather than a pooled average', () => {
    assert.equal(selectedRun.timeToProductionBenchmark.fleet.average, 900)
  })

  it('requires both fleet press and Run support', () => {
    assert.equal(selectedRun.timeToProductionBenchmark.fleet.sufficientSupport, true)
    const twoPress = buildOperationalRunComparison([selected, fleetA, fleetB], 'press5', fromUtc, toUtc)
    assert.equal(twoPress.runs[0]!.timeToProductionBenchmark.fleet.sufficientSupport, false)
  })

  it('preserves exact event type, status code, and description identity', () => {
    assert.equal(clean.exactIdentity, 'B\u001f123\u001fClean Impression')
  })

  it('aggregates repeated exact-status spans at Run level', () => {
    assert.equal(clean.occurrenceCount, 2)
    assert.equal(clean.totalDurationSeconds, 540)
  })

  it('calculates exact-status frequency over all eligible cohort Runs', () => {
    assert.equal(clean.samePress.eligibleRuns, 6)
    assert.equal(clean.samePress.containingRuns, 6)
    assert.equal(clean.samePress.occurrenceFrequencyPercent, 100)
  })

  it('benchmarks occurrence counts including zero for absent statuses', () => {
    assert.equal(clean.samePress.typicalOccurrenceCount, 1)
    assert.equal(clean.samePress.occurrenceDelta, 1)
  })

  it('calculates pre-production contribution', () => {
    assert.equal(clean.preProductionDurationSeconds, 540)
    assert.equal(clean.preProductionContributionPercent, 36)
  })

  it('calculates supported excess-time contributors from pre-production totals', () => {
    const contributor = selectedRun.contributors.find(({ exactIdentity }) => exactIdentity === clean.exactIdentity)!
    assert.equal(contributor.excessSeconds, 250)
  })

  it('does not double-count short attempts as a second contributor', () => {
    assert.equal(selectedRun.shortRunAttemptCount, 1)
    assert.equal(selectedRun.shortRunAttemptDurationSeconds, 60)
    assert.equal(selectedRun.contributors.filter(({ statusDescription }) => statusDescription === 'Short Run attempts').length, 0)
  })

  it('preserves short Run attempts as exact G / Run Production segments', () => {
    const attempt = selectedRun.segments.find(({ isShortRunAttempt }) => isShortRunAttempt)!
    assert.equal(attempt.exactIdentity, 'G\u001f150\u001fRun Production')
    assert.equal(attempt.durationSeconds, 60)
  })

  it('calculates transition and distinct-status counts', () => {
    assert.equal(selectedRun.transitionCount, selectedRun.segments.length - 1)
    assert.equal(selectedRun.distinctStatusCount, 3)
  })

  it('detects sequence variation only with sufficient support', () => {
    assert.equal(selectedRun.sequenceComparison.sufficientSupport, true)
    assert.equal(selectedRun.sequenceComparison.variation, true)
    assert.ok(selectedRun.flags.includes('Sequence variation'))
  })

  it('marks repeated exact states without inferring a cause', () => {
    assert.ok(selectedRun.flags.includes('Repeated Make Ready'))
  })

  it('ranks Runs within the selected period', () => {
    assert.equal(selectedRun.rank.timeToProduction, 1)
    assert.equal(selectedRun.rank.comparableRuns, 7)
  })

  it('excludes a partial boundary Run from comparison cohorts', () => {
    const partialTo = new Date(Date.parse(selectedRun.productionStartUtc!) + 60_000).toISOString()
    const runs = buildOperationalRuns(selected, fromUtc, partialTo)
    const partial = runs.find(({ run }) => run.startUtc === selectedRun.startUtc)!.run
    assert.equal(partial.isPartial, true)
    assert.equal(partial.eligibleForBenchmark, false)
  })

  it('keeps Data Unavailable explicit and excludes the interrupted Run', () => {
    const input = pressInput('press10', 'Press 10', [{ preProductionSeconds: 600 }])
    const nonProductionIndex = input.segments.findIndex(({ isProduction }) => !isProduction)
    const state = input.segments[nonProductionIndex]!
    input.segments.splice(nonProductionIndex + 1, 0, { kind: 'offline', machineId: 10, pressKey: 'press10', displayName: 'Press 10', eventType: null, statusCode: null, statusDescription: null, startUtc: state.endUtc, endUtc: new Date(Date.parse(state.endUtc) + 180_000).toISOString(), durationSeconds: 180, isProduction: false, isOpen: false, sourceGeneration: 'offline_inference' })
    const result = buildOperationalRunComparison([input], 'press10', fromUtc, input.toUtc)
    const interrupted = result.runs.find(({ dataInterrupted }) => dataInterrupted)!
    assert.equal(interrupted.eligibleForBenchmark, false)
    assert.ok(interrupted.segments.some(({ isUnavailable }) => isUnavailable))
  })
})
