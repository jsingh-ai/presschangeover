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

export interface RepresentativeDifference { field: string; expected: unknown; actual: unknown; expectedType: string; actualType: string }
function differences(expected: unknown, actual: unknown, path = ''): RepresentativeDifference[] {
  if (isDeepStrictEqual(expected, actual)) return []
  if (Array.isArray(expected) && Array.isArray(actual)) return Array.from({ length: Math.max(expected.length, actual.length) }, (_, index) => differences(expected[index], actual[index], `${path}[${index}]`)).flat()
  if (expected && actual && typeof expected === 'object' && typeof actual === 'object') return [...new Set([...Object.keys(expected), ...Object.keys(actual)])].flatMap((key) => differences((expected as Record<string, unknown>)[key], (actual as Record<string, unknown>)[key], path ? `${path}.${key}` : key))
  return [{ field: path || 'value', expected, actual, expectedType: valueType(expected), actualType: valueType(actual) }]
}

function parityView(run: ProductionRun) {
  run = canonicalJobRun(run)
  return {
    identity: { pressKey: run.pressKey, startUtc: run.startUtc, endUtc: run.endUtc, durationSeconds: run.durationSeconds, identities: run.identities, previousIdentities: run.previousIdentities, boundaryCompleteness: run.boundaryCompleteness, persistenceEligible: run.persistenceEligible },
    state: { goodSeconds: run.goodSeconds, makeReadySeconds: run.makeReadySeconds, badSeconds: run.badSeconds, unavailableSeconds: run.unavailableSeconds ?? Math.max(0, run.durationSeconds - run.goodSeconds - run.makeReadySeconds - run.badSeconds - run.otherRadiusSeconds) },
    transition: { identityTransition: run.identityTransition, transitionSeconds: run.transitionToStableProductionSeconds, transitionMakeReadySeconds: run.transitionMakeReadySeconds, transitionBadSeconds: run.transitionBadSeconds, transitionValid: run.transitionValid, dataInterrupted: run.dataInterrupted },
    running: run.runningPerformance ? { stableProductionStartUtc: run.runningPerformance.stableProductionStartUtc, interruptions: run.runningPerformance.interruptions, restartCount: run.runningPerformance.restartCount, medianUninterruptedGoodSeconds: run.runningPerformance.medianUninterruptedGoodSeconds, speed: run.runningPerformance.speed } : null,
    decks: run.deckConfiguration,
    losses: run.radiusLossAggregates ?? [],
  }
}

export interface RepresentativeParityEntry {
  runId: string
  classifications: Array<'expected_and_stored' | 'missing_from_store' | 'extra_in_store' | 'fingerprint_mismatch' | 'field_mismatch' | 'loss_mismatch'>
  present: boolean
  fingerprint: boolean
  fingerprints: { expected: string | null; stored: string | null; recomputed: string | null }
  categories: Record<string, boolean>
  differences: Record<string, RepresentativeDifference[]>
  storedInterval: { startUtc: string; endUtc: string; previousRunId: string | null; fingerprint: string; reason: string } | null
}

export interface RepresentativeParityReport { ok: boolean; requestedRange: { fromUtc: string; toUtc: string }; expectedCount: number; storedCount: number; unionCount: number; entries: RepresentativeParityEntry[] }

export function representativeParityReport(liveRuns: ProductionRun[], stored: MaterializedProductionRun[], fromUtc: string, toUtc: string): RepresentativeParityReport {
  const from = Date.parse(fromUtc); const to = Date.parse(toUtc)
  const expected = liveRuns.filter((run) => run.persistenceEligible && run.boundaryCompleteness === 'natural' && Date.parse(run.endUtc) > from && Date.parse(run.startUtc) < to).map((run) => materializedRun(run, new Date(Math.min(from, Date.parse(run.startUtc))).toISOString(), new Date(Math.max(to, Date.parse(run.endUtc))).toISOString(), { isClosed: true }))
  const expectedById = new Map(expected.map((item) => [item.run.runId, item])); const storedById = new Map(stored.map((item) => [item.run.runId, item]))
  const runIds = [...new Set([...expectedById.keys(), ...storedById.keys()])].sort()
  const entries = runIds.map((runId): RepresentativeParityEntry => {
    const expectedItem = expectedById.get(runId); const actual = storedById.get(runId)
    if (!expectedItem && actual) return { runId, classifications: ['extra_in_store'], present: true, fingerprint: actual.sourceFingerprint === canonicalJobFingerprint(actual.algorithmVersion, actual.run), fingerprints: { expected: null, stored: actual.sourceFingerprint, recomputed: canonicalJobFingerprint(actual.algorithmVersion, actual.run) }, categories: {}, differences: {}, storedInterval: { startUtc: actual.run.startUtc, endUtc: actual.run.endUtc, previousRunId: actual.run.previousRunId ?? null, fingerprint: actual.sourceFingerprint, reason: `stored interval intersects requested range because ${actual.run.startUtc} < ${toUtc} and ${actual.run.endUtc} > ${fromUtc}` } }
    if (expectedItem && !actual) return { runId, classifications: ['missing_from_store'], present: false, fingerprint: false, fingerprints: { expected: expectedItem.sourceFingerprint, stored: null, recomputed: null }, categories: {}, differences: {}, storedInterval: null }
    const expectedView = parityView(expectedItem!.run); const actualView = parityView(actual!.run)
    const categoryDifferences = Object.fromEntries(Object.entries(expectedView).map(([name, value]) => [name, differences(value, actualView[name as keyof typeof actualView])]).filter(([, value]) => (value as unknown[]).length)) as Record<string, RepresentativeDifference[]>
    const categories = Object.fromEntries(Object.keys(expectedView).map((name) => [name, !(name in categoryDifferences)]))
    const recomputed = canonicalJobFingerprint(actual!.algorithmVersion, actual!.run); const fingerprint = actual!.sourceFingerprint === expectedItem!.sourceFingerprint && actual!.sourceFingerprint === recomputed
    const classifications: RepresentativeParityEntry['classifications'] = []
    if (fingerprint && !Object.keys(categoryDifferences).length) classifications.push('expected_and_stored')
    if (!fingerprint) classifications.push('fingerprint_mismatch')
    if (Object.keys(categoryDifferences).some((name) => name !== 'losses')) classifications.push('field_mismatch')
    if (categoryDifferences.losses) classifications.push('loss_mismatch')
    return { runId, classifications, present: true, fingerprint, fingerprints: { expected: expectedItem!.sourceFingerprint, stored: actual!.sourceFingerprint, recomputed }, categories, differences: categoryDifferences, storedInterval: null }
  })
  return { ok: entries.every((entry) => entry.classifications.length === 1 && entry.classifications[0] === 'expected_and_stored'), requestedRange: { fromUtc, toUtc }, expectedCount: expected.length, storedCount: stored.length, unionCount: entries.length, entries }
}

export function assertRepresentativeParity(liveRuns: ProductionRun[], stored: MaterializedProductionRun[], fromUtc: string, toUtc: string) {
  const report = representativeParityReport(liveRuns, stored, fromUtc, toUtc)
  if (!report.ok) throw new Error(`job_history_parity_failed:${JSON.stringify(report)}`)
  return report.entries
}
