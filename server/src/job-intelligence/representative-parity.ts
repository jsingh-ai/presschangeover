import { isDeepStrictEqual } from 'node:util'
import type { ProductionRun } from './contracts.js'
import { materializedRun, type MaterializedProductionRun } from './history-repository.js'

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

export function canonicalizePersistenceValue(value: unknown): unknown {
  if (typeof value === 'string' && ISO_TIMESTAMP.test(value)) return new Date(value).toISOString()
  if (Array.isArray(value)) return value.map(canonicalizePersistenceValue)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, canonicalizePersistenceValue(item)]))
  return value
}

function differences(expected: unknown, actual: unknown, path = ''): Array<{ field: string; expected: unknown; actual: unknown }> {
  if (isDeepStrictEqual(expected, actual)) return []
  if (Array.isArray(expected) && Array.isArray(actual)) return Array.from({ length: Math.max(expected.length, actual.length) }, (_, index) => differences(expected[index], actual[index], `${path}[${index}]`)).flat()
  if (expected && actual && typeof expected === 'object' && typeof actual === 'object') return [...new Set([...Object.keys(expected), ...Object.keys(actual)])].flatMap((key) => differences((expected as Record<string, unknown>)[key], (actual as Record<string, unknown>)[key], path ? `${path}.${key}` : key))
  return [{ field: path || 'value', expected, actual }]
}

function parityView(run: ProductionRun) {
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
    const expectedView = canonicalizePersistenceValue(parityView(expected.run)) as ReturnType<typeof parityView>
    const actualView = actual ? canonicalizePersistenceValue(parityView(actual.run)) as ReturnType<typeof parityView> : null
    const categoryDifferences = actualView ? Object.fromEntries(Object.entries(expectedView).map(([name, value]) => [name, differences(value, actualView[name as keyof ReturnType<typeof parityView>])]).filter(([, value]) => (value as unknown[]).length)) : {}
    const categories = actualView ? Object.fromEntries(Object.keys(expectedView).map((name) => [name, !(name in categoryDifferences)])) : {}
    const fingerprint = actual?.sourceFingerprint === expected.sourceFingerprint
    return { runId: expected.run.runId, present: Boolean(actual), fingerprint, fingerprints: { expected: expected.sourceFingerprint, actual: actual?.sourceFingerprint ?? null }, categories, differences: categoryDifferences }
  })
  if (closedLive.length !== stored.length || results.some((result) => !result.present || !result.fingerprint || Object.values(result.categories).some((value) => !value))) throw new Error(`job_history_parity_failed:${JSON.stringify(results)}`)
  return results
}
