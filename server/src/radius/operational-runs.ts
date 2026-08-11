import type {
  OperationalRun,
  OperationalRunComparison,
  OperationalRunContributor,
  OperationalRunSegment,
  OperationalRunStatusSummary,
  RadiusPressKey,
  RadiusStateSegment,
  RadiusStatusSegment,
  RunBenchmarkStats,
} from './models.js'
import { exactRadiusIdentity } from './radius-identity.js'
import {
  qualifyStateBreakdownRuns,
  STATE_BREAKDOWN_RUN_CONFIRMATION_SECONDS,
} from './state-breakdown.js'

export const RUN_BENCHMARK_MIN_SAME_PRESS_RUNS = 5
export const RUN_BENCHMARK_MIN_FLEET_PRESSES = 3
export const RUN_BENCHMARK_MIN_FLEET_RUNS = 10
export const RUN_BENCHMARK_SIMILAR_RELATIVE_TOLERANCE = 0.1
export const RUN_BENCHMARK_SIMILAR_ABSOLUTE_SECONDS = 60
export const RUN_BENCHMARK_UNCOMMON_FREQUENCY_PERCENT = 20

export interface OperationalRunInput {
  pressKey: RadiusPressKey
  displayName: string
  segments: RadiusStatusSegment[]
}

interface RawRun {
  pressKey: RadiusPressKey
  displayName: string
  startUtc: string
  endUtc: string
  productionStartUtc: string | null
  segments: OperationalRunSegment[]
  isPartial: boolean
  dataInterrupted: boolean
}

interface RunFacts {
  run: OperationalRun
  statusMap: Map<string, {
    segment: OperationalRunSegment
    totalDurationSeconds: number
    preProductionDurationSeconds: number
    occurrenceCount: number
    segmentIds: string[]
  }>
}

function average(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
}

function median(values: number[]): number | null {
  if (!values.length) return null
  const ordered = [...values].sort((left, right) => left - right)
  const middle = Math.floor(ordered.length / 2)
  return ordered.length % 2 ? ordered[middle]! : (ordered[middle - 1]! + ordered[middle]!) / 2
}

function percentDelta(value: number, baseline: number | null): number | null {
  return baseline && baseline !== 0 ? ((value - baseline) / baseline) * 100 : null
}

function percentile(value: number, values: number[]): number | null {
  if (!values.length) return null
  return Math.round((values.filter((candidate) => candidate <= value).length / values.length) * 100)
}

function benchmarkStats(
  value: number,
  values: number[],
  minimumRuns: number,
  samplePresses = values.length ? 1 : 0,
  minimumPresses = 1,
): RunBenchmarkStats {
  const typical = median(values)
  const sufficientSupport = values.length >= minimumRuns && samplePresses >= minimumPresses
  return {
    sampleRuns: values.length,
    samplePresses,
    sufficientSupport,
    average: average(values),
    median: typical,
    delta: typical === null ? null : value - typical,
    percentDelta: percentDelta(value, typical),
    percentile: sufficientSupport ? percentile(value, values) : null,
  }
}

function direction(
  value: number,
  stats: RunBenchmarkStats,
  positive: 'slower' | 'longer',
  negative: 'faster' | 'shorter',
): 'faster' | 'slower' | 'typical' | 'longer' | 'shorter' | 'low_support' {
  if (!stats.sufficientSupport || stats.median === null) return 'low_support'
  const tolerance = Math.max(
    RUN_BENCHMARK_SIMILAR_ABSOLUTE_SECONDS,
    Math.abs(stats.median) * RUN_BENCHMARK_SIMILAR_RELATIVE_TOLERANCE,
  )
  if (Math.abs(value - stats.median) <= tolerance) return 'typical'
  return value > stats.median ? positive : negative
}

function segmentId(segment: RadiusStatusSegment, index: number): string {
  return `${segment.pressKey}:${segment.startUtc}:${segment.endUtc}:${index}`
}

function toRunSegment(segment: RadiusStatusSegment, index: number, phase: 'pre-production' | 'production'): OperationalRunSegment {
  const state = segment.kind === 'radius' ? segment : undefined
  return {
    segmentId: segmentId(segment, index),
    exactIdentity: state ? exactRadiusIdentity(state) : null,
    eventType: state?.eventType ?? null,
    statusCode: state?.statusCode ?? null,
    statusDescription: state?.statusDescription ?? null,
    startUtc: segment.startUtc,
    endUtc: segment.endUtc,
    durationSeconds: segment.durationSeconds,
    phase,
    isUnavailable: segment.kind === 'offline',
    isShortRunAttempt: state?.stateBreakdownRunQualification?.state === 'short',
  }
}

function buildRawRuns(input: OperationalRunInput): RawRun[] {
  const segments = qualifyStateBreakdownRuns(input.segments)
  const runs: RawRun[] = []
  let current: RawRun | undefined
  let hasObservedSustainedProduction = false

  const finish = () => {
    if (current) runs.push(current)
    current = undefined
  }

  segments.forEach((segment, index) => {
    if (segment.kind === 'offline') {
      if (current) {
        current.segments.push(toRunSegment(segment, index, 'pre-production'))
        current.endUtc = segment.endUtc
        current.isPartial = true
        current.dataInterrupted = true
        finish()
      }
      hasObservedSustainedProduction = false
      return
    }

    const qualification = segment.stateBreakdownRunQualification?.state
    if (segment.isProduction) {
      if (current) {
        const sustained = qualification === 'sustained'
        current.segments.push(toRunSegment(segment, index, sustained ? 'production' : 'pre-production'))
        current.endUtc = segment.endUtc
        if (sustained) {
          current.productionStartUtc = segment.startUtc
          current.isPartial ||= segment.isOpen
          finish()
          hasObservedSustainedProduction = true
        }
      } else if (qualification === 'sustained' || segment.durationSeconds >= STATE_BREAKDOWN_RUN_CONFIRMATION_SECONDS) {
        hasObservedSustainedProduction = true
      }
      return
    }

    if (!current) {
      current = {
        pressKey: input.pressKey,
        displayName: input.displayName,
        startUtc: segment.startUtc,
        endUtc: segment.endUtc,
        productionStartUtc: null,
        segments: [],
        isPartial: !hasObservedSustainedProduction,
        dataInterrupted: false,
      }
    }
    current.segments.push(toRunSegment(segment, index, 'pre-production'))
    current.endUtc = segment.endUtc
    hasObservedSustainedProduction = false
  })

  if (current) {
    current.isPartial = true
    finish()
  }
  return runs
}

function clipRawRun(run: RawRun, fromUtc: string, toUtc: string): RawRun | null {
  const fromMs = Date.parse(fromUtc)
  const toMs = Date.parse(toUtc)
  const runStart = Date.parse(run.startUtc)
  const runEnd = Date.parse(run.endUtc)
  if (runEnd <= fromMs || runStart >= toMs) return null
  const segments = run.segments.flatMap((segment) => {
    const startMs = Math.max(fromMs, Date.parse(segment.startUtc))
    const endMs = Math.min(toMs, Date.parse(segment.endUtc))
    return endMs > startMs ? [{
      ...segment,
      startUtc: new Date(startMs).toISOString(),
      endUtc: new Date(endMs).toISOString(),
      durationSeconds: (endMs - startMs) / 1_000,
    }] : []
  })
  if (!segments.length) return null
  return {
    ...run,
    startUtc: segments[0]!.startUtc,
    endUtc: segments.at(-1)!.endUtc,
    segments,
    isPartial: run.isPartial || runStart < fromMs || runEnd > toMs,
  }
}

function runSequence(segments: OperationalRunSegment[]): string[] {
  return segments.flatMap((segment) => segment.exactIdentity ? [segment.exactIdentity] : [])
}

function runStatusMap(segments: OperationalRunSegment[]): RunFacts['statusMap'] {
  const result: RunFacts['statusMap'] = new Map()
  for (const segment of segments) {
    if (!segment.exactIdentity || !segment.statusDescription || !segment.eventType) continue
    const current = result.get(segment.exactIdentity)
    if (current) {
      current.totalDurationSeconds += segment.durationSeconds
      current.preProductionDurationSeconds += segment.phase === 'pre-production' ? segment.durationSeconds : 0
      current.occurrenceCount += 1
      current.segmentIds.push(segment.segmentId)
    } else {
      result.set(segment.exactIdentity, {
        segment,
        totalDurationSeconds: segment.durationSeconds,
        preProductionDurationSeconds: segment.phase === 'pre-production' ? segment.durationSeconds : 0,
        occurrenceCount: 1,
        segmentIds: [segment.segmentId],
      })
    }
  }
  return result
}

function emptyStats(value: number): RunBenchmarkStats {
  return benchmarkStats(value, [], RUN_BENCHMARK_MIN_SAME_PRESS_RUNS)
}

function baseRun(run: RawRun, sequenceNumber: number): RunFacts {
  const preProductionSeconds = run.segments
    .filter(({ phase }) => phase === 'pre-production')
    .reduce((sum, { durationSeconds }) => sum + durationSeconds, 0)
  const productionDurationSeconds = run.segments
    .filter(({ phase }) => phase === 'production')
    .reduce((sum, { durationSeconds }) => sum + durationSeconds, 0)
  const shortSegments = run.segments.filter(({ isShortRunAttempt }) => isShortRunAttempt)
  const statusMap = runStatusMap(run.segments)
  const timeToProductionSeconds = run.productionStartUtc
    ? Math.max(0, (Date.parse(run.productionStartUtc) - Date.parse(run.startUtc)) / 1_000)
    : null
  const eligibleForBenchmark = timeToProductionSeconds !== null && !run.isPartial && !run.dataInterrupted
  const result: OperationalRun = {
    runId: `${run.pressKey}:${run.startUtc}`,
    sequenceNumber,
    pressKey: run.pressKey,
    displayName: run.displayName,
    startUtc: run.startUtc,
    endUtc: run.endUtc,
    productionStartUtc: run.productionStartUtc,
    timeToProductionSeconds,
    productionDurationSeconds,
    totalDurationSeconds: run.segments.reduce((sum, { durationSeconds }) => sum + durationSeconds, 0),
    transitionCount: Math.max(0, run.segments.length - 1),
    distinctStatusCount: statusMap.size,
    shortRunAttemptCount: shortSegments.length,
    shortRunAttemptDurationSeconds: shortSegments.reduce((sum, { durationSeconds }) => sum + durationSeconds, 0),
    isPartial: run.isPartial,
    dataInterrupted: run.dataInterrupted,
    eligibleForBenchmark,
    segments: run.segments,
    timeToProductionBenchmark: { direction: 'low_support', samePress: emptyStats(timeToProductionSeconds ?? 0), fleet: emptyStats(timeToProductionSeconds ?? 0) },
    productionDurationBenchmark: { direction: 'low_support', samePress: emptyStats(productionDurationSeconds) },
    transitionBenchmark: emptyStats(Math.max(0, run.segments.length - 1)),
    shortAttemptCountBenchmark: emptyStats(shortSegments.length),
    shortAttemptDurationBenchmark: emptyStats(shortSegments.reduce((sum, { durationSeconds }) => sum + durationSeconds, 0)),
    statusSummaries: [],
    contributors: [],
    sequenceComparison: { commonSequence: [], runSequence: runSequence(run.segments), variation: false, sufficientSupport: false },
    flags: [],
    rank: { timeToProduction: null, productionDuration: null, comparableRuns: 0 },
  }
  void preProductionSeconds
  return { run: result, statusMap }
}

export function buildOperationalRuns(input: OperationalRunInput, fromUtc: string, toUtc: string): RunFacts[] {
  const clipped = buildRawRuns(input)
    .flatMap((run) => {
      const visible = clipRawRun(run, fromUtc, toUtc)
      return visible ? [visible] : []
    })
  return clipped.map((run, index) => baseRun(run, index + 1))
}

function fleetMetric(
  selectedPress: RadiusPressKey,
  allRuns: Map<RadiusPressKey, RunFacts[]>,
  value: number,
  metric: (facts: RunFacts) => number | null,
): RunBenchmarkStats {
  const perPress = [...allRuns.entries()].flatMap(([pressKey, runs]) => {
    if (pressKey === selectedPress) return []
    const values = runs.filter(({ run }) => run.eligibleForBenchmark).flatMap((facts) => {
      const candidate = metric(facts)
      return candidate === null ? [] : [candidate]
    })
    return values.length ? [{ values, average: average(values)!, median: median(values)! }] : []
  })
  const totalRuns = perPress.reduce((sum, press) => sum + press.values.length, 0)
  const fleetMedian = median(perPress.map((press) => press.median))
  const sufficientSupport = perPress.length >= RUN_BENCHMARK_MIN_FLEET_PRESSES && totalRuns >= RUN_BENCHMARK_MIN_FLEET_RUNS
  return {
    sampleRuns: totalRuns,
    samplePresses: perPress.length,
    sufficientSupport,
    average: average(perPress.map((press) => press.average)),
    median: fleetMedian,
    delta: fleetMedian === null ? null : value - fleetMedian,
    percentDelta: percentDelta(value, fleetMedian),
    percentile: null,
  }
}

function modalSequence(cohort: RunFacts[]): string[] {
  const counts = new Map<string, { count: number; sequence: string[] }>()
  for (const { run } of cohort) {
    const key = run.sequenceComparison.runSequence.join('>')
    const current = counts.get(key)
    counts.set(key, { count: (current?.count ?? 0) + 1, sequence: run.sequenceComparison.runSequence })
  }
  return [...counts.entries()]
    .sort(([leftKey, left], [rightKey, right]) => right.count - left.count || leftKey.localeCompare(rightKey))[0]?.[1].sequence ?? []
}

function statusFleetStats(
  selectedPress: RadiusPressKey,
  allRuns: Map<RadiusPressKey, RunFacts[]>,
  identity: string,
  value: number,
): RunBenchmarkStats {
  return fleetMetric(selectedPress, allRuns, value, ({ statusMap }) => statusMap.get(identity)?.totalDurationSeconds ?? null)
}

function buildStatusSummaries(
  facts: RunFacts,
  samePressCohort: RunFacts[],
  allRuns: Map<RadiusPressKey, RunFacts[]>,
): { summaries: OperationalRunStatusSummary[]; contributors: OperationalRunContributor[] } {
  const preProductionSeconds = facts.run.segments.filter(({ phase }) => phase === 'pre-production').reduce((sum, segment) => sum + segment.durationSeconds, 0)
  const contributors: OperationalRunContributor[] = []
  const summaries = [...facts.statusMap.entries()].map(([identity, current]) => {
    const containing = samePressCohort.filter(({ statusMap }) => statusMap.has(identity))
    const durationValues = containing.map(({ statusMap }) => statusMap.get(identity)!.totalDurationSeconds)
    const sameStats = benchmarkStats(current.totalDurationSeconds, durationValues, RUN_BENCHMARK_MIN_SAME_PRESS_RUNS)
    const occurrenceValues = samePressCohort.map(({ statusMap }) => statusMap.get(identity)?.occurrenceCount ?? 0)
    const typicalOccurrenceCount = median(occurrenceValues)
    const preProductionValues = samePressCohort.flatMap(({ statusMap }) => {
      const duration = statusMap.get(identity)?.preProductionDurationSeconds ?? 0
      return duration > 0 ? [duration] : []
    })
    const typicalPreProduction = median(preProductionValues)
    if (current.preProductionDurationSeconds > 0 && preProductionValues.length >= RUN_BENCHMARK_MIN_SAME_PRESS_RUNS && typicalPreProduction !== null) {
      contributors.push({
        exactIdentity: identity,
        statusDescription: current.segment.statusDescription!,
        excessSeconds: current.preProductionDurationSeconds - typicalPreProduction,
        segmentIds: current.segmentIds.filter((id) => facts.run.segments.some((segment) => segment.segmentId === id && segment.phase === 'pre-production')),
      })
    }
    return {
      exactIdentity: identity,
      eventType: current.segment.eventType!,
      statusCode: current.segment.statusCode,
      statusDescription: current.segment.statusDescription!,
      totalDurationSeconds: current.totalDurationSeconds,
      preProductionDurationSeconds: current.preProductionDurationSeconds,
      occurrenceCount: current.occurrenceCount,
      preProductionContributionPercent: preProductionSeconds > 0 ? (current.preProductionDurationSeconds / preProductionSeconds) * 100 : null,
      samePress: {
        ...sameStats,
        eligibleRuns: samePressCohort.length,
        containingRuns: containing.length,
        occurrenceFrequencyPercent: samePressCohort.length ? (containing.length / samePressCohort.length) * 100 : null,
        typicalOccurrenceCount,
        occurrenceDelta: typicalOccurrenceCount === null ? null : current.occurrenceCount - typicalOccurrenceCount,
        direction: direction(current.totalDurationSeconds, sameStats, 'longer', 'shorter') as 'longer' | 'shorter' | 'typical' | 'low_support',
      },
      fleet: statusFleetStats(facts.run.pressKey, allRuns, identity, current.totalDurationSeconds),
    }
  }).sort((left, right) => right.totalDurationSeconds - left.totalDurationSeconds)
  contributors.sort((left, right) => right.excessSeconds - left.excessSeconds)
  return { summaries, contributors }
}

function rankRuns(runs: RunFacts[]) {
  const eligible = runs.filter(({ run }) => run.eligibleForBenchmark)
  const timeOrdered = [...eligible].sort((left, right) => (right.run.timeToProductionSeconds ?? 0) - (left.run.timeToProductionSeconds ?? 0))
  const productionOrdered = [...eligible].sort((left, right) => right.run.productionDurationSeconds - left.run.productionDurationSeconds)
  for (const facts of runs) {
    facts.run.rank = {
      timeToProduction: facts.run.eligibleForBenchmark ? timeOrdered.findIndex(({ run }) => run.runId === facts.run.runId) + 1 : null,
      productionDuration: facts.run.eligibleForBenchmark ? productionOrdered.findIndex(({ run }) => run.runId === facts.run.runId) + 1 : null,
      comparableRuns: eligible.length,
    }
  }
}

export function buildOperationalRunComparison(
  inputs: OperationalRunInput[],
  selectedPress: RadiusPressKey,
  fromUtc: string,
  toUtc: string,
): OperationalRunComparison {
  const allRuns = new Map(inputs.map((input) => [input.pressKey, buildOperationalRuns(input, fromUtc, toUtc)]))
  const selectedInput = inputs.find(({ pressKey }) => pressKey === selectedPress)
  const selectedRuns = allRuns.get(selectedPress) ?? []
  rankRuns(selectedRuns)

  for (const facts of selectedRuns) {
    const cohort = selectedRuns.filter((candidate) => candidate.run.runId !== facts.run.runId && candidate.run.eligibleForBenchmark)
    const timeValue = facts.run.timeToProductionSeconds ?? 0
    const timeStats = benchmarkStats(timeValue, cohort.flatMap(({ run }) => run.timeToProductionSeconds === null ? [] : [run.timeToProductionSeconds]), RUN_BENCHMARK_MIN_SAME_PRESS_RUNS)
    const productionStats = benchmarkStats(facts.run.productionDurationSeconds, cohort.map(({ run }) => run.productionDurationSeconds), RUN_BENCHMARK_MIN_SAME_PRESS_RUNS)
    facts.run.timeToProductionBenchmark = {
      direction: direction(timeValue, timeStats, 'slower', 'faster') as 'faster' | 'slower' | 'typical' | 'low_support',
      samePress: timeStats,
      fleet: fleetMetric(selectedPress, allRuns, timeValue, ({ run }) => run.timeToProductionSeconds),
    }
    facts.run.productionDurationBenchmark = {
      direction: direction(facts.run.productionDurationSeconds, productionStats, 'longer', 'shorter') as 'longer' | 'shorter' | 'typical' | 'low_support',
      samePress: productionStats,
    }
    facts.run.transitionBenchmark = benchmarkStats(facts.run.transitionCount, cohort.map(({ run }) => run.transitionCount), RUN_BENCHMARK_MIN_SAME_PRESS_RUNS)
    facts.run.shortAttemptCountBenchmark = benchmarkStats(facts.run.shortRunAttemptCount, cohort.map(({ run }) => run.shortRunAttemptCount), RUN_BENCHMARK_MIN_SAME_PRESS_RUNS)
    facts.run.shortAttemptDurationBenchmark = benchmarkStats(facts.run.shortRunAttemptDurationSeconds, cohort.map(({ run }) => run.shortRunAttemptDurationSeconds), RUN_BENCHMARK_MIN_SAME_PRESS_RUNS)
    const status = buildStatusSummaries(facts, cohort, allRuns)
    facts.run.statusSummaries = status.summaries
    facts.run.contributors = status.contributors
    const commonSequence = modalSequence(cohort)
    const sequenceSupport = cohort.length >= RUN_BENCHMARK_MIN_SAME_PRESS_RUNS
    facts.run.sequenceComparison = {
      commonSequence,
      runSequence: facts.run.sequenceComparison.runSequence,
      variation: sequenceSupport && commonSequence.join('>') !== facts.run.sequenceComparison.runSequence.join('>'),
      sufficientSupport: sequenceSupport,
    }

    const flags: string[] = []
    if (facts.run.isPartial) flags.push('Partial Run')
    if (facts.run.dataInterrupted) flags.push('Data gap')
    if (facts.run.timeToProductionBenchmark.direction === 'slower') flags.push('Slower to production')
    if (facts.run.timeToProductionBenchmark.direction === 'faster') flags.push('Faster to production')
    const repeated = facts.run.statusSummaries.find(({ eventType, occurrenceCount, samePress }) => eventType !== 'G' && samePress.sufficientSupport && occurrenceCount >= 2 && samePress.typicalOccurrenceCount !== null && occurrenceCount > samePress.typicalOccurrenceCount)
    if (repeated) flags.push(`Repeated ${repeated.statusDescription}`)
    if (facts.run.shortRunAttemptCount > 0) flags.push(`${facts.run.shortRunAttemptCount} short Run attempt${facts.run.shortRunAttemptCount === 1 ? '' : 's'}`)
    if (facts.run.sequenceComparison.variation) flags.push('Sequence variation')
    if (facts.run.transitionBenchmark.sufficientSupport && facts.run.transitionBenchmark.median !== null && facts.run.transitionCount > facts.run.transitionBenchmark.median + 1) flags.push('High transition count')
    if (facts.run.statusSummaries.some(({ samePress }) => samePress.direction === 'longer')) flags.push('Long-duration step')
    if (facts.run.statusSummaries.some(({ samePress }) => samePress.sufficientSupport && samePress.occurrenceFrequencyPercent !== null && samePress.occurrenceFrequencyPercent < RUN_BENCHMARK_UNCOMMON_FREQUENCY_PERCENT)) flags.push('Uncommon step')
    facts.run.flags = flags
  }

  return {
    pressKey: selectedPress,
    displayName: selectedInput?.displayName ?? selectedPress,
    fromUtc,
    toUtc,
    confirmationSeconds: STATE_BREAKDOWN_RUN_CONFIRMATION_SECONDS,
    samePressMinimumRuns: RUN_BENCHMARK_MIN_SAME_PRESS_RUNS,
    fleetMinimumPresses: RUN_BENCHMARK_MIN_FLEET_PRESSES,
    fleetMinimumRuns: RUN_BENCHMARK_MIN_FLEET_RUNS,
    similarRelativeTolerance: RUN_BENCHMARK_SIMILAR_RELATIVE_TOLERANCE,
    similarAbsoluteSeconds: RUN_BENCHMARK_SIMILAR_ABSOLUTE_SECONDS,
    runs: selectedRuns.map(({ run }) => run).sort((left, right) => Date.parse(right.startUtc) - Date.parse(left.startUtc)),
  }
}
