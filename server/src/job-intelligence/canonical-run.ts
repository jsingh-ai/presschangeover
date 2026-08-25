import { createHash } from 'node:crypto'
import { JOB_ANALYSIS_DIMENSIONS, type JobAnalysisDimension, type JobRunLossAggregate, type ProductionRun } from './contracts.js'

type Identities = Partial<Record<JobAnalysisDimension, string>>

export function canonicalJobTimestamp(value: string | Date | null): string | null {
  if (value === null) return null
  return (value instanceof Date ? value : new Date(value)).toISOString()
}

export function canonicalJobNumber(value: number): number {
  if (!Number.isFinite(value)) throw new Error('invalid_job_persistence_number')
  return Object.is(value, -0) ? 0 : value
}

export function canonicalJobInteger(value: number, minimum = -2_147_483_648, maximum = 2_147_483_647): number {
  const number = canonicalJobNumber(value)
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) throw new Error('invalid_job_persistence_integer')
  return number
}

function nullableNumber(value: number | null | undefined): number | null {
  return value === null || value === undefined ? null : canonicalJobNumber(value)
}

function identities(value: Identities | null | undefined): Identities {
  return Object.fromEntries(JOB_ANALYSIS_DIMENSIONS.flatMap((field) => value?.[field] === null || value?.[field] === undefined ? [] : [[field, value[field]!]]))
}

function nullableIdentities(value: Identities | null | undefined): Identities | null {
  const result = identities(value)
  return Object.keys(result).length ? result : null
}

function numericSet(values: number[]): number[] {
  return [...new Set(values.map((value) => canonicalJobInteger(value, -32_768, 32_767)))].sort((left, right) => left - right)
}

function lossKey(value: JobRunLossAggregate): string {
  return JSON.stringify([value.eventType, value.statusCode ?? '', value.statusDescription])
}

function losses(values: JobRunLossAggregate[] | undefined): JobRunLossAggregate[] {
  const seen = new Set<string>()
  const result = (values ?? []).map((value) => {
    const category = value.eventType === 'M' ? 'make_ready' : value.eventType === 'B' ? 'bad' : 'other'
    if (value.category !== category) throw new Error('invalid_job_loss_category')
    const normalized = {
      eventType: value.eventType,
      statusCode: value.statusCode === '' || value.statusCode === undefined ? null : value.statusCode,
      statusDescription: value.statusDescription,
      category,
      totalSeconds: canonicalJobNumber(value.totalSeconds),
      occurrenceCount: canonicalJobInteger(value.occurrenceCount, 1),
      medianEpisodeSeconds: canonicalJobNumber(value.medianEpisodeSeconds),
    } satisfies JobRunLossAggregate
    const key = lossKey(normalized)
    if (seen.has(key)) throw new Error('duplicate_job_loss_key')
    seen.add(key)
    return normalized
  })
  return result.sort((left, right) => lossKey(left) < lossKey(right) ? -1 : lossKey(left) > lossKey(right) ? 1 : 0)
}

/**
 * The one semantic representation supported by the compact PostgreSQL Job store.
 * It deliberately mirrors persisted precision and fields: timestamps are UTC
 * milliseconds, -0 is the same persisted number as 0, deck arrays are sets, loss
 * rows are unordered aggregates, and non-persisted live-tail relationships are null.
 */
export function canonicalJobRun(run: ProductionRun): ProductionRun {
  const current = identities(run.identities)
  const previous = nullableIdentities(run.previousIdentities)
  const transitionPrevious = nullableIdentities(run.identityTransition.previousResolvedIdentity)
  const startUtc = canonicalJobTimestamp(run.startUtc)!
  const endUtc = canonicalJobTimestamp(run.endUtc)!
  const durationSeconds = canonicalJobNumber(run.durationSeconds)
  const expectedDurationSeconds = Math.round((Date.parse(endUtc) - Date.parse(startUtc)) / 100) / 10
  if (durationSeconds !== expectedDurationSeconds) throw new Error('invalid_job_duration_boundary')
  const firstSeen = canonicalJobTimestamp(run.identityTransition.identityChangeFirstSeenAtUtc)
  const lastChange = canonicalJobTimestamp(run.identityTransition.identityLastChangeAtUtc)
  const settled = canonicalJobTimestamp(run.identityTransition.identitySettledAtUtc)
  const stable = canonicalJobTimestamp(run.transitionTiming.incomingStableRadiusProductionStartUtc)
  const runningGood = canonicalJobNumber(run.runningPerformance?.goodSeconds ?? 0)
  const runningBad = canonicalJobNumber(run.runningPerformance?.badSeconds ?? 0)
  const interruptions = canonicalJobNumber(run.runningPerformance?.interruptions ?? run.productionInterruptionCount)
  const interruptionsPerHour = nullableNumber(run.runningPerformance?.interruptionsPerProductionHour ?? run.interruptionsPerProductionHour)
  const transitionSeconds = nullableNumber(run.transitionToStableProductionSeconds)
  const transitionValid = run.transitionValid ?? (!run.dataInterrupted && transitionSeconds !== null)
  const unavailableSeconds = canonicalJobNumber(run.unavailableSeconds ?? Math.max(0, run.durationSeconds - run.goodSeconds - run.makeReadySeconds - run.badSeconds - run.otherRadiusSeconds))
  const deck = run.deckConfiguration
  const speed = run.runningPerformance?.speed

  return {
    runId: run.runId,
    // Adjacency IDs depend on what neighbouring evidence is loaded. Persist
    // the independently observed previous identity and reconstruct IDs at read
    // time instead of fingerprinting a range-dependent relationship.
    previousRunId: null,
    nextRunId: null,
    pressKey: run.pressKey,
    startUtc,
    endUtc,
    durationSeconds,
    boundaryCompleteness: run.boundaryCompleteness,
    persistenceEligible: run.persistenceEligible,
    identities: current,
    previousIdentities: previous,
    nextIdentities: null,
    boundaryFields: JOB_ANALYSIS_DIMENSIONS.filter((field) => transitionPrevious?.[field] !== undefined && transitionPrevious[field] !== current[field]),
    contextSettlingSeconds: firstSeen && settled ? canonicalJobNumber(Math.max(0, (Date.parse(settled) - Date.parse(firstSeen)) / 1_000)) : 0,
    identityTransition: {
      identityChangeFirstSeenAtUtc: firstSeen,
      identityLastChangeAtUtc: lastChange,
      identitySettledAtUtc: settled,
      settleState: run.identityTransition.settleState,
      previousResolvedIdentity: transitionPrevious,
      finalResolvedIdentity: current,
      inferredBoundary: run.identityTransition.inferredBoundary,
    },
    dataInterrupted: run.dataInterrupted,
    identityAvailability: Object.fromEntries(JOB_ANALYSIS_DIMENSIONS.flatMap((field) => run.identityAvailability?.[field] === undefined ? [] : [[field, run.identityAvailability[field]!]])),
    coveragePercent: canonicalJobNumber(run.coveragePercent),
    identityConfidence: run.identityConfidence,
    goodSeconds: canonicalJobNumber(run.goodSeconds),
    makeReadySeconds: canonicalJobNumber(run.makeReadySeconds),
    badSeconds: canonicalJobNumber(run.badSeconds),
    otherRadiusSeconds: canonicalJobNumber(run.otherRadiusSeconds),
    unavailableSeconds,
    productionStateEfficiency: nullableNumber(run.productionStateEfficiency),
    productionInterruptionCount: canonicalJobInteger(interruptions, 0),
    interruptionsPerProductionHour: interruptionsPerHour,
    transitionToStableProductionSeconds: transitionSeconds,
    transitionMakeReadySeconds: nullableNumber(run.transitionMakeReadySeconds),
    transitionBadSeconds: nullableNumber(run.transitionBadSeconds),
    transitionValid,
    transitionMetric: transitionValid ? 'radius_stable_production_proxy' : 'unavailable',
    transitionTiming: {
      outgoingStableRadiusProductionEndUtc: null,
      incomingStableRadiusProductionStartUtc: stable,
      radiusStableProductionProxySeconds: transitionSeconds,
      metadataFirstSeenToStableSeconds: firstSeen && stable ? canonicalJobNumber((Date.parse(stable) - Date.parse(firstSeen)) / 1_000) : null,
      metadataSettledToStableSeconds: settled && stable ? canonicalJobNumber((Date.parse(stable) - Date.parse(settled)) / 1_000) : null,
      telemetryPhysicalProductionAtUtc: null,
      timingUncertaintySeconds: nullableNumber(run.transitionTiming.timingUncertaintySeconds),
    },
    radiusEpisodes: [],
    radiusLossAggregates: losses(run.radiusLossAggregates),
    deckConfiguration: deck ? {
      activeDecks: numericSet(deck.activeDecks),
      reusedDecks: numericSet(deck.reusedDecks),
      addedDecks: numericSet(deck.addedDecks),
      removedDecks: numericSet(deck.removedDecks),
      changedDeckCount: canonicalJobInteger(deck.changedDeckCount, 0, 32_767),
      evidenceCanonicalId: 'deck.active',
    } : null,
    runningPerformance: {
      stableProductionStartUtc: stable,
      observedSeconds: canonicalJobNumber(runningGood + runningBad),
      goodSeconds: runningGood,
      badSeconds: runningBad,
      interruptions: canonicalJobInteger(interruptions, 0),
      interruptionsPerProductionHour: interruptionsPerHour,
      medianUninterruptedGoodSeconds: nullableNumber(run.runningPerformance?.medianUninterruptedGoodSeconds),
      restartCount: canonicalJobInteger(run.runningPerformance?.restartCount ?? 0, 0),
      speed: speed ? {
        canonicalId: 'machine.speed.actual',
        sourceUnit: speed.sourceUnit ?? null,
        canonicalUnitStatus: speed.canonicalUnitStatus ?? null,
        sampleCount: canonicalJobInteger(speed.sampleCount, 0),
        median: canonicalJobNumber(speed.median),
        p25: canonicalJobNumber(speed.p25),
        p75: canonicalJobNumber(speed.p75),
        p90: canonicalJobNumber(speed.p90),
        timeWeightedMean: nullableNumber(speed.timeWeightedMean),
      } : null,
    },
  }
}

export function canonicalJobFingerprint(algorithmVersion: string, run: ProductionRun): string {
  return createHash('sha256').update(JSON.stringify({ algorithmVersion, run: canonicalJobRun(run) })).digest('hex')
}

export function canonicalMaterializedJobFacts(value: { algorithmVersion: string; isClosed: boolean; run: ProductionRun }) {
  const run = canonicalJobRun(value.run)
  return { algorithmVersion: value.algorithmVersion, isClosed: value.isClosed, sourceFingerprint: canonicalJobFingerprint(value.algorithmVersion, run), run }
}
