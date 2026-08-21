import { randomUUID } from 'node:crypto'
import type { RadiusPressKey } from '../radius/models.js'
import type { ProductionRun } from './contracts.js'
import { JOB_INTELLIGENCE_ALGORITHM_VERSION, materializedRun, type JobHistoryCheckpoint, type JobHistoryRepository, type MaterializedProductionRun } from './history-repository.js'

const MAX_BACKFILL_CHUNK_MS = 7 * 24 * 60 * 60_000
const SETTLING_OVERLAP_MS = 5 * 60_000
export const JOB_HISTORY_LEASE_MS = 15 * 60_000

function identityKey(run: ProductionRun) { return ['order', 'recipe', 'customer', 'material'].map((field) => `${field}=${run.identities[field as keyof ProductionRun['identities']] ?? ''}`).join('\u0000') }
function episodeKey(episode: ProductionRun['radiusEpisodes'][number]) { return `${episode.startUtc}\u0000${episode.endUtc}\u0000${episode.eventType}\u0000${episode.statusCode ?? ''}\u0000${episode.statusDescription}` }
const round = (value: number) => Math.round(value * 10) / 10

export function mergeContinuousProductionRuns(left: ProductionRun, right: ProductionRun): ProductionRun | null {
  if (left.pressKey !== right.pressKey || identityKey(left) !== identityKey(right) || left.dataInterrupted || right.dataInterrupted || Date.parse(right.startUtc) > Date.parse(left.endUtc) + SETTLING_OVERLAP_MS) return null
  const episodes = [...new Map([...left.radiusEpisodes, ...right.radiusEpisodes].map((episode) => [episodeKey(episode), episode])).values()].sort((a, b) => Date.parse(a.startUtc) - Date.parse(b.startUtc))
  const totals = episodes.reduce((sum, episode) => { if (episode.eventType === 'G') sum.good += episode.durationSeconds; else if (episode.eventType === 'M') sum.makeReady += episode.durationSeconds; else if (episode.eventType === 'B') sum.bad += episode.durationSeconds; else sum.other += episode.durationSeconds; return sum }, { good: 0, makeReady: 0, bad: 0, other: 0 })
  let previousProduction = false; let interruptions = 0
  for (const episode of episodes) { const production = episode.eventType === 'G' && episode.statusDescription === 'Run Production'; if (previousProduction && !production) interruptions += 1; previousProduction = production }
  const startUtc = Date.parse(left.startUtc) <= Date.parse(right.startUtc) ? left.startUtc : right.startUtc; const endUtc = Date.parse(left.endUtc) >= Date.parse(right.endUtc) ? left.endUtc : right.endUtc; const durationSeconds = (Date.parse(endUtc) - Date.parse(startUtc)) / 1_000; const observed = totals.good + totals.makeReady + totals.bad + totals.other
  const stableStart = left.runningPerformance?.stableProductionStartUtc ?? right.runningPerformance?.stableProductionStartUtc ?? null; const stableMs = stableStart ? Date.parse(stableStart) : Infinity; const runningEpisodes = episodes.filter((episode) => Date.parse(episode.endUtc) > stableMs).map((episode) => ({ ...episode, durationSeconds: (Date.parse(episode.endUtc) - Math.max(stableMs, Date.parse(episode.startUtc))) / 1_000 })).filter((episode) => episode.durationSeconds > 0); const runningGoodEpisodes = runningEpisodes.filter((episode) => episode.eventType === 'G' && episode.statusDescription === 'Run Production'); const runningGood = runningGoodEpisodes.reduce((sum, episode) => sum + episode.durationSeconds, 0); const runningBad = runningEpisodes.filter((episode) => episode.eventType === 'B').reduce((sum, episode) => sum + episode.durationSeconds, 0)
  let runningPrior = false; let runningInterruptions = 0; for (const episode of runningEpisodes) { const production = episode.eventType === 'G' && episode.statusDescription === 'Run Production'; if (runningPrior && !production) runningInterruptions += 1; runningPrior = production }
  const goodDurations = runningGoodEpisodes.map((episode) => episode.durationSeconds).sort((a, b) => a - b); const middle = Math.floor(goodDurations.length / 2); const medianGood = goodDurations.length ? goodDurations.length % 2 ? goodDurations[middle]! : (goodDurations[middle - 1]! + goodDurations[middle]!) / 2 : null
  const runningPerformance = left.runningPerformance || right.runningPerformance ? { stableProductionStartUtc: stableStart, observedSeconds: round(runningEpisodes.reduce((sum, episode) => sum + episode.durationSeconds, 0)), goodSeconds: round(runningGood), badSeconds: round(runningBad), interruptions: runningInterruptions, interruptionsPerProductionHour: runningGood ? round(runningInterruptions / (runningGood / 3600)) : null, medianUninterruptedGoodSeconds: medianGood, restartCount: Math.max(0, runningGoodEpisodes.length - 1), speed: null } : undefined
  const unavailableSeconds = Math.max(0, durationSeconds - observed); const stateSeconds = totals.good + totals.makeReady + totals.bad
  return { ...left, startUtc, endUtc, durationSeconds: round(durationSeconds), nextRunId: right.nextRunId, nextIdentities: right.nextIdentities, goodSeconds: round(totals.good), makeReadySeconds: round(totals.makeReady), badSeconds: round(totals.bad), otherRadiusSeconds: round(totals.other), unavailableSeconds: round(unavailableSeconds), productionStateEfficiency: stateSeconds ? round(totals.good / stateSeconds * 100) : null, coveragePercent: durationSeconds ? round(observed / durationSeconds * 100) : 0, productionInterruptionCount: interruptions, interruptionsPerProductionHour: totals.good ? round(interruptions / (totals.good / 3600)) : null, radiusEpisodes: episodes, ...(runningPerformance ? { runningPerformance } : {}) }
}

export function mergeHistoricalAndLiveRuns(historical: MaterializedProductionRun[], live: ProductionRun[], sourceFromUtc: string, sourceToUtc: string): MaterializedProductionRun[] {
  const merged = new Map(historical.map((item) => [item.run.runId, structuredClone(item)]))
  for (const run of live) {
    const exact = merged.get(run.runId)
    if (exact) { if (!exact.isClosed) merged.set(run.runId, materializedRun(run, sourceFromUtc, sourceToUtc)); continue }
    const continuation = [...merged.values()].filter((item) => !item.isClosed).sort((a, b) => Date.parse(b.run.endUtc) - Date.parse(a.run.endUtc)).find((item) => mergeContinuousProductionRuns(item.run, run))
    if (continuation) { const combined = mergeContinuousProductionRuns(continuation.run, run)!; merged.set(continuation.run.runId, materializedRun({ ...combined, runId: continuation.run.runId }, continuation.sourceFromUtc, sourceToUtc)); continue }
    merged.set(run.runId, materializedRun(run, sourceFromUtc, sourceToUtc))
  }
  return [...merged.values()].sort((a, b) => Date.parse(a.run.startUtc) - Date.parse(b.run.startUtc) || a.run.runId.localeCompare(b.run.runId))
}

export interface JobHistoryBackfillResult { pressKey: RadiusPressKey; fromUtc: string; toUtc: string; chunksCompleted: number; runsWritten: number; resumedFromUtc: string; watermarkUtc: string }

type FailureStage = 'claim' | 'source_acquisition' | 'history_read' | 'derivation' | 'persistence'
function cancelledError() { const error = new Error('job_history_cancelled'); error.name = 'AbortError'; return error }
function errorCode(error: unknown, stage: FailureStage, aborted: boolean) {
  const value = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
  const message = error instanceof Error ? error.message : String(error)
  if (aborted || (error instanceof Error && error.name === 'AbortError')) return 'cancelled'
  if (stage === 'source_acquisition' && (value === '53300' || /^08/.test(value) || /too many connections|connection/i.test(message))) return value ? `radius_connection:${value}` : 'radius_connection'
  if (/timeout|timed out/i.test(message)) return `${stage}:timeout`
  return stage
}
function boundedErrorMessage(error: unknown) { const raw = error instanceof Error ? error.message : String(error); return raw.replace(/\b(password|pwd|secret|token)=\S+/gi, '$1=[redacted]').replace(/:\/\/([^:@/\s]+):([^@/\s]+)@/g, '://$1:[redacted]@').replace(/\s+/g, ' ').trim().slice(0, 500) || 'unknown materialization failure' }

export class JobHistoryMaterializer {
  constructor(private readonly repository: JobHistoryRepository, private readonly buildRuns: (pressKey: RadiusPressKey, fromUtc: string, toUtc: string, requestId?: string, signal?: AbortSignal) => Promise<ProductionRun[]>, private readonly now: () => Date = () => new Date(), private readonly leaseMs = JOB_HISTORY_LEASE_MS) { if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000) throw new Error('invalid_job_history_lease') }

  async backfillPress(input: { pressKey: RadiusPressKey; fromUtc: string; toUtc: string; requestId?: string; signal?: AbortSignal; resume?: boolean }): Promise<JobHistoryBackfillResult> {
    const fromMs = Date.parse(input.fromUtc); const toMs = Date.parse(input.toUtc)
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) throw new Error('invalid_job_history_range')
    if (input.signal?.aborted) throw cancelledError()
    const leaseId = randomUUID(); const startedAtUtc = this.now().toISOString(); const leaseExpiresAtUtc = new Date(Date.parse(startedAtUtc) + this.leaseMs).toISOString()
    let stage: FailureStage = 'claim'
    let claimed: JobHistoryCheckpoint | null
    try { claimed = await this.repository.tryClaimCheckpoint({ pressKey: input.pressKey, algorithmVersion: JOB_INTELLIGENCE_ALGORITHM_VERSION, initialWatermarkUtc: input.fromUtc, sourceFromUtc: input.fromUtc, sourceToUtc: input.toUtc, leaseId, startedAtUtc, leaseExpiresAtUtc }) }
    catch (error) {
      const finishedAtUtc = this.now().toISOString(); const failedCheckpoint: JobHistoryCheckpoint = { pressKey: input.pressKey, algorithmVersion: JOB_INTELLIGENCE_ALGORITHM_VERSION, watermarkUtc: input.fromUtc, sourceFromUtc: input.fromUtc, sourceToUtc: input.fromUtc, state: 'failed', updatedAtUtc: finishedAtUtc, startedAtUtc, finishedAtUtc, lastSuccessAtUtc: null, leaseId: null, leaseExpiresAtUtc: null, lastErrorCode: errorCode(error, 'persistence', Boolean(input.signal?.aborted)).slice(0, 120), lastErrorMessage: boundedErrorMessage(error) }
      try { await this.repository.failCheckpoint(leaseId, failedCheckpoint) } catch (cleanupError) { if (error instanceof Error) Object.defineProperty(error, 'checkpointCleanupError', { value: cleanupError, enumerable: false }) }
      throw error
    }
    if (!claimed) throw new Error('job_history_materialization_already_running')
    let checkpoint: JobHistoryCheckpoint = claimed
    const checkpointCoversRequestedStart = Date.parse(checkpoint.sourceFromUtc) <= fromMs
    let cursor = input.resume !== false && checkpointCoversRequestedStart && Date.parse(checkpoint.watermarkUtc) > fromMs && Date.parse(checkpoint.watermarkUtc) < toMs ? Date.parse(checkpoint.watermarkUtc) : fromMs
    const resumedFromUtc = new Date(cursor).toISOString(); let chunksCompleted = 0; let runsWritten = 0
    try {
      while (cursor < toMs) {
        if (input.signal?.aborted) throw cancelledError()
        const chunkEnd = Math.min(toMs, cursor + MAX_BACKFILL_CHUNK_MS); const sourceStart = Math.max(fromMs, cursor - SETTLING_OVERLAP_MS); const sourceFromUtc = new Date(sourceStart).toISOString(); const sourceToUtc = new Date(chunkEnd).toISOString(); const calculatedAtUtc = this.now().toISOString()
        stage = 'source_acquisition'
        const live = await this.buildRuns(input.pressKey, sourceFromUtc, sourceToUtc, input.requestId, input.signal)
        if (input.signal?.aborted) throw cancelledError()
        stage = 'history_read'
        const prior = await this.repository.listRuns({ fromUtc: new Date(Math.max(fromMs, sourceStart - SETTLING_OVERLAP_MS)).toISOString(), toUtc: sourceToUtc, pressKeys: [input.pressKey] })
        stage = 'derivation'
        const reconciled = mergeHistoricalAndLiveRuns(prior, live, sourceFromUtc, sourceToUtc).filter((item) => Date.parse(item.run.endUtc) > cursor || prior.some((existing) => existing.run.runId === item.run.runId && existing.sourceFingerprint !== item.sourceFingerprint))
        const finalChunk = chunkEnd >= toMs
        const boundaryRuns = reconciled.filter((item) => Date.parse(item.run.endUtc) >= chunkEnd)
        const nextCursor = boundaryRuns.length ? Math.min(...boundaryRuns.map((item) => Date.parse(item.run.startUtc))) : chunkEnd
        if (!finalChunk && nextCursor <= cursor) throw new Error('job_history_run_exceeds_bounded_chunk')
        const persistable = reconciled.filter((item) => Date.parse(item.run.endUtc) < chunkEnd)
        const values = persistable.map((item) => materializedRun(item.run, item.sourceFromUtc, sourceToUtc, { calculatedAtUtc, isClosed: Date.parse(item.run.endUtc) < chunkEnd }))
        const committedAtUtc = this.now().toISOString(); const state = finalChunk ? 'complete' as const : 'running' as const
        const nextCheckpoint: JobHistoryCheckpoint = { ...checkpoint, watermarkUtc: new Date(nextCursor).toISOString(), sourceFromUtc: new Date(Math.min(Date.parse(checkpoint.sourceFromUtc), fromMs)).toISOString(), sourceToUtc: new Date(nextCursor).toISOString(), state, updatedAtUtc: committedAtUtc, finishedAtUtc: finalChunk ? committedAtUtc : null, lastSuccessAtUtc: committedAtUtc, leaseId: finalChunk ? null : leaseId, leaseExpiresAtUtc: finalChunk ? null : new Date(Date.parse(committedAtUtc) + this.leaseMs).toISOString(), lastErrorCode: null, lastErrorMessage: null }
        stage = 'persistence'; await this.repository.commitChunk(values, nextCheckpoint, leaseId)
        checkpoint = nextCheckpoint; runsWritten += values.length; chunksCompleted += 1; cursor = nextCursor
        if (finalChunk) break
      }
    } catch (error) {
      const finishedAtUtc = this.now().toISOString(); const failedCheckpoint = { ...checkpoint, state: 'failed' as const, updatedAtUtc: finishedAtUtc, finishedAtUtc, leaseId: null, leaseExpiresAtUtc: null, lastErrorCode: errorCode(error, stage, Boolean(input.signal?.aborted)).slice(0, 120), lastErrorMessage: boundedErrorMessage(error) }
      try { await this.repository.failCheckpoint(leaseId, failedCheckpoint) } catch (cleanupError) { if (error instanceof Error) Object.defineProperty(error, 'checkpointCleanupError', { value: cleanupError, enumerable: false }) }
      throw error
    }
    return { pressKey: input.pressKey, fromUtc: input.fromUtc, toUtc: input.toUtc, chunksCompleted, runsWritten, resumedFromUtc, watermarkUtc: new Date(cursor).toISOString() }
  }
}
