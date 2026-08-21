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
  return [...new Set(values.map(canonicalJobNumber))].sort((left, right) => left - right)
}

function lossKey(value: JobRunLossAggregate): string {
  return [value.eventType, value.statusCode ?? '', value.statusDescription, value.category].join('\u0000')
}

function losses(values: JobRunLossAggregate[] | undefined): JobRunLossAggregate[] {
  return (values ?? []).map((value) => ({
    eventType: value.eventType,
    statusCode: value.statusCode === '' || value.statusCode === undefined ? null : value.statusCode,
    statusDescription: value.statusDescription,
    category: value.category,
    totalSeconds: canonicalJobNumber(value.totalSeconds),
    occurrenceCount: canonicalJobNumber(value.occurrenceCount),
    medianEpisodeSeconds: canonicalJobNumber(value.medianEpisodeSeconds),
  })).sort((left, right) => lossKey(left) < lossKey(right) ? -1 : lossKey(left) > lossKey(right) ? 1 : 0)
}

/**
 * The one semantic representation supported by the compact PostgreSQL Job store.
 * It deliberately mirrors persisted precision and fields: timestamps are UTC
 * milliseconds, -0 is the same persisted number as 0, deck arrays are sets, loss
 * rows are unordered aggregates, and non-persisted live-tail relationships are null.
 */
export function canonicalJobRun(run: ProductionRun): ProductionRun {
  const current = identities(run.identities)
  const previous = nullableIdentities(run.identityTransition.previousResolvedIdentity) ?? nullableIdentities(run.previousIdentities)
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
    previousRunId: run.previousRunId ?? null,
    nextRunId: null,
    pressKey: run.pressKey,
    startUtc: canonicalJobTimestamp(run.startUtc)!,
    endUtc: canonicalJobTimestamp(run.endUtc)!,
    durationSeconds: canonicalJobNumber(run.durationSeconds),
    identities: current,
    previousIdentities: previous,
    nextIdentities: null,
    boundaryFields: JOB_ANALYSIS_DIMENSIONS.filter((field) => previous?.[field] !== undefined && previous[field] !== current[field]),
    contextSettlingSeconds: firstSeen && settled ? canonicalJobNumber(Math.max(0, (Date.parse(settled) - Date.parse(firstSeen)) / 1_000)) : 0,
    identityTransition: {
      identityChangeFirstSeenAtUtc: firstSeen,
      identityLastChangeAtUtc: lastChange,
      identitySettledAtUtc: settled,
      settleState: run.identityTransition.settleState,
      previousResolvedIdentity: previous,
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
    productionInterruptionCount: interruptions,
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
      changedDeckCount: canonicalJobNumber(deck.changedDeckCount),
      evidenceCanonicalId: 'deck.active',
    } : null,
    runningPerformance: {
      stableProductionStartUtc: stable,
      observedSeconds: canonicalJobNumber(runningGood + runningBad),
      goodSeconds: runningGood,
      badSeconds: runningBad,
      interruptions,
      interruptionsPerProductionHour: interruptionsPerHour,
      medianUninterruptedGoodSeconds: nullableNumber(run.runningPerformance?.medianUninterruptedGoodSeconds),
      restartCount: canonicalJobNumber(run.runningPerformance?.restartCount ?? 0),
      speed: speed ? {
        canonicalId: 'machine.speed.actual',
        sourceUnit: speed.sourceUnit ?? null,
        canonicalUnitStatus: speed.canonicalUnitStatus ?? null,
        sampleCount: canonicalJobNumber(speed.sampleCount),
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
