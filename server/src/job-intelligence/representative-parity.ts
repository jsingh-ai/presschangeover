import { isDeepStrictEqual } from 'node:util'
import type { ProductionRun } from './contracts.js'
import { materializedRun, type MaterializedProductionRun } from './history-repository.js'

function timestamp(value: string | null) {
  return value === null ? null : new Date(value).toISOString()
}

function identityTransition(run: ProductionRun) {
  return {
    ...run.identityTransition,
    identityChangeFirstSeenAtUtc: timestamp(run.identityTransition.identityChangeFirstSeenAtUtc),
    identityLastChangeAtUtc: timestamp(run.identityTransition.identityLastChangeAtUtc),
    identitySettledAtUtc: timestamp(run.identityTransition.identitySettledAtUtc),
  }
}

function parityView(run: ProductionRun) {
  return {
    identity: { pressKey: run.pressKey, startUtc: timestamp(run.startUtc), endUtc: timestamp(run.endUtc), identities: run.identities, previousIdentities: run.previousIdentities },
    state: { goodSeconds: run.goodSeconds, makeReadySeconds: run.makeReadySeconds, badSeconds: run.badSeconds, unavailableSeconds: run.unavailableSeconds ?? Math.max(0, run.durationSeconds - run.goodSeconds - run.makeReadySeconds - run.badSeconds - run.otherRadiusSeconds) },
    transition: { identityTransition: identityTransition(run), transitionSeconds: run.transitionToStableProductionSeconds, transitionMakeReadySeconds: run.transitionMakeReadySeconds, transitionBadSeconds: run.transitionBadSeconds, transitionValid: run.transitionValid, dataInterrupted: run.dataInterrupted },
    running: run.runningPerformance ? { stableProductionStartUtc: timestamp(run.runningPerformance.stableProductionStartUtc), interruptions: run.runningPerformance.interruptions, restartCount: run.runningPerformance.restartCount, medianUninterruptedGoodSeconds: run.runningPerformance.medianUninterruptedGoodSeconds, speed: run.runningPerformance.speed } : null,
    decks: run.deckConfiguration,
    losses: run.radiusLossAggregates ?? [],
  }
}

export function assertRepresentativeParity(liveRuns: ProductionRun[], stored: MaterializedProductionRun[], fromUtc: string, toUtc: string) {
  const closedLive = liveRuns.filter((run) => Date.parse(run.endUtc) < Date.parse(toUtc)).map((run) => materializedRun(run, fromUtc, toUtc, { isClosed: true }))
  const storedById = new Map(stored.map((item) => [item.run.runId, item]))
  const results = closedLive.map((expected) => {
    const actual = storedById.get(expected.run.runId)
    const categories = actual ? Object.fromEntries(Object.entries(parityView(expected.run)).map(([name, value]) => [name, isDeepStrictEqual(value, parityView(actual.run)[name as keyof ReturnType<typeof parityView>])])) : {}
    const fingerprint = actual?.sourceFingerprint === expected.sourceFingerprint
    return { runId: expected.run.runId, present: Boolean(actual), fingerprint, categories }
  })
  if (closedLive.length !== stored.length || results.some((result) => !result.present || !result.fingerprint || Object.values(result.categories).some((value) => !value))) throw new Error(`job_history_parity_failed:${JSON.stringify(results)}`)
  return results
}
