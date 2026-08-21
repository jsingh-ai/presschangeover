import { isDeepStrictEqual } from 'node:util'
import { canonicalJobFingerprint, canonicalJobRun } from './canonical-run.js'
import type { ProductionRun } from './contracts.js'
import { materializedRun, type MaterializedProductionRun } from './history-repository.js'

function valueType(value: unknown) {
  if (Object.is(value, -0)) return 'number:-0'
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function differences(expected: unknown, actual: unknown, path = ''): Array<{ field: string; expected: unknown; actual: unknown; expectedType: string; actualType: string }> {
  if (isDeepStrictEqual(expected, actual)) return []
  if (Array.isArray(expected) && Array.isArray(actual)) return Array.from({ length: Math.max(expected.length, actual.length) }, (_, index) => differences(expected[index], actual[index], `${path}[${index}]`)).flat()
  if (expected && actual && typeof expected === 'object' && typeof actual === 'object') return [...new Set([...Object.keys(expected), ...Object.keys(actual)])].flatMap((key) => differences((expected as Record<string, unknown>)[key], (actual as Record<string, unknown>)[key], path ? `${path}.${key}` : key))
  return [{ field: path || 'value', expected, actual, expectedType: valueType(expected), actualType: valueType(actual) }]
}

function parityView(run: ProductionRun) {
  run = canonicalJobRun(run)
  return {
    identity: { pressKey: run.pressKey, startUtc: run.startUtc, endUtc: run.endUtc, identities: run.identities, previousIdentities: run.previousIdentities },
    state: { goodSeconds: run.goodSeconds, makeReadySeconds: run.makeReadySeconds, badSeconds: run.badSeconds, unavailableSeconds: run.unavailableSeconds ?? Math.max(0, run.durationSeconds - run.goodSeconds - run.makeReadySeconds - run.badSeconds - run.otherRadiusSeconds) },
    transition: { identityTransition: run.identityTransition, transitionSeconds: run.transitionToStableProductionSeconds, transitionMakeReadySeconds: run.transitionMakeReadySeconds, transitionBadSeconds: run.transitionBadSeconds, transitionValid: run.transitionValid, dataInterrupted: run.dataInterrupted },
    running: run.runningPerformance ? { stableProductionStartUtc: run.runningPerformance.stableProductionStartUtc, interruptions: run.runningPerformance.interruptions, restartCount: run.runningPerformance.restartCount, medianUninterruptedGoodSeconds: run.runningPerformance.medianUninterruptedGoodSeconds, speed: run.runningPerformance.speed } : null,
    decks: run.deckConfiguration,
    losses: run.radiusLossAggregates ?? [],
  }
}

export function assertRepresentativeParity(liveRuns: ProductionRun[], stored: MaterializedProductionRun[], fromUtc: string, toUtc: string) {
  const closedLive = liveRuns.filter((run) => Date.parse(run.endUtc) < Date.parse(toUtc)).map((run) => materializedRun(run, fromUtc, toUtc, { isClosed: true }))
  const storedById = new Map(stored.map((item) => [item.run.runId, item]))
  const results = closedLive.map((expected) => {
    const actual = storedById.get(expected.run.runId)
    const expectedView = parityView(expected.run)
    const actualView = actual ? parityView(actual.run) : null
    const categoryDifferences = actualView ? Object.fromEntries(Object.entries(expectedView).map(([name, value]) => [name, differences(value, actualView[name as keyof ReturnType<typeof parityView>])]).filter(([, value]) => (value as unknown[]).length)) : {}
    const categories = actualView ? Object.fromEntries(Object.keys(expectedView).map((name) => [name, !(name in categoryDifferences)])) : {}
    const recomputed = actual ? canonicalJobFingerprint(actual.algorithmVersion, actual.run) : null
    const fingerprint = actual?.sourceFingerprint === expected.sourceFingerprint && actual.sourceFingerprint === recomputed
    return { runId: expected.run.runId, present: Boolean(actual), fingerprint, fingerprints: { expected: expected.sourceFingerprint, stored: actual?.sourceFingerprint ?? null, recomputed }, categories, differences: categoryDifferences }
  })
  if (closedLive.length !== stored.length || results.some((result) => !result.present || !result.fingerprint || Object.values(result.categories).some((value) => !value))) throw new Error(`job_history_parity_failed:${JSON.stringify(results)}`)
  return results
}
