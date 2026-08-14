import { mkdir, writeFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'

const productionBase = process.env.PROCESS_INTELLIGENCE_URL ?? 'http://10.8.10.97:8088'
const candidateBase = process.env.PHASE3_CANDIDATE_URL ?? 'http://127.0.0.1:8091'
const fromUtc = process.env.PHASE3_FROM_UTC ?? '2026-08-06T17:00:00.000Z'
const toUtc = process.env.PHASE3_TO_UTC ?? '2026-08-13T17:00:00.000Z'
const presses = ['press5', 'press8', 'press12', 'press13', 'press14', 'press15'] as const
const outputDirectory = new URL('../review-artifacts/phase3-stop-restart/', import.meta.url)

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))
async function json<T>(base: string, path: string, init?: RequestInit): Promise<{ value: T; bytes: number; milliseconds: number; retries: number }> {
  const started = performance.now()
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(`${base}${path}`, init)
    const body = await response.text()
    if (response.ok) return { value: JSON.parse(body) as T, bytes: Buffer.byteLength(body), milliseconds: performance.now() - started, retries: attempt }
    if (response.status !== 503 || attempt === 2) throw new Error(`${path}: ${response.status} ${body.slice(0, 160)}`)
    await wait(500 * (attempt + 1))
  }
  throw new Error('unreachable')
}

type Occurrence = { occurrenceId: string; pressKey: string; displayName: string; startUtc: string; endUtc: string; durationSeconds: number; operationalGroupKey: string; operationalGroupName: string; processFamilyKey: string; processFamilyName: string; exactIdentities: Array<{ eventType: string; statusCode: string | null; statusDescription: string }> }
type Clues = { signalClues: Array<{ canonicalId: string; deckNumber: number | null; friendlyName: string; signalType: string; category: string; source?: string; isClue: boolean; clueQuality: number }>; performance: { upstreamCalls: number; totalMs: number; responsePayloadBytes: number } }
type Analysis = { physicalStopMatch: { status: string; candidates: unknown[] }; phases: null | { stableRunningBefore: { bucket: string | null; durationSeconds: number | null }; deceleration: { fromUtc: string | null }; restartAttempts: Array<{ returnedToStopped: boolean; maximumObservedSpeed: number; highestBucket: string }>; sustainedRunningConfirmedAtUtc: string | null }; radiusTiming: { offsetSeconds: number | null }; preStopFlags: Array<{ canonicalId: string; deckNumber: number | null; friendlyName: string; robustDeviation: number; current: { count: number; median: number }; reference: { count: number; median: number; p05: number; p95: number }; afterRestart: { count: number; median: number } | null; recovery: string }>; referenceMetadata: { status: string; requestCount: number; candidateCount: number; excludedObservationsWithoutFreshSpeed: number; cache: string }; performance: { upstreamCalls: number; totalMs: number; responsePayloadBytes: number } }

async function occurrences(): Promise<Occurrence[]> {
  const output: Occurrence[] = []
  for (const pressKey of presses) {
    const query = new URLSearchParams({ fromUtc, toUtc, pressKey, level: 'radius_state', key: 'B', evidenceLimit: '100' })
    const response = await json<{ occurrences: Occurrence[] }>(productionBase, `/api/radius/activity-analysis?${query}`)
    const selected: Occurrence[] = []
    for (const occurrence of response.value.occurrences) {
      const identity = occurrence.exactIdentities.map(({ eventType, statusCode, statusDescription }) => `${eventType}|${statusCode}|${statusDescription}`).join(';')
      if (selected.length < 4 && selected.some((item) => item.exactIdentities.map(({ eventType, statusCode, statusDescription }) => `${eventType}|${statusCode}|${statusDescription}`).join(';') === identity)) continue
      selected.push(occurrence)
      if (selected.length === 6) break
    }
    output.push(...selected)
  }
  return output
}

function stopBody(occurrence: Occurrence, clues: Clues) {
  const candidates = clues.signalClues.filter(({ isClue, signalType }) => isClue && signalType === 'continuous').sort((left, right) => right.clueQuality - left.clueQuality).slice(0, 12).map(({ canonicalId, deckNumber, friendlyName, signalType, category }) => ({ canonicalId, ...(deckNumber === null ? {} : { deckNumber }), friendlyName, signalType, category, source: 'clue' }))
  return { occurrence, candidates }
}

async function validate() {
  const selected = await occurrences()
  const reviewed = []
  for (const occurrence of selected) {
    try {
      const clueBody = { occurrenceId: occurrence.occurrenceId, displayName: occurrence.displayName, startUtc: occurrence.startUtc, endUtc: occurrence.endUtc, exactIdentities: occurrence.exactIdentities }
      const clues = await json<Clues>(candidateBase, `/api/telemetry/presses/${occurrence.pressKey}/clues`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(clueBody) })
      const analysis = await json<Analysis>(candidateBase, `/api/telemetry/presses/${occurrence.pressKey}/stop-restart-analysis`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(stopBody(occurrence, clues.value)) })
      const qaFlags = analysis.value.preStopFlags.map((flag) => ({ ...flag, qa: flag.current.count < 3 || flag.reference.count < 20 ? 'INSUFFICIENT SUPPORT' : flag.robustDeviation >= 4 && flag.current.count >= 5 ? 'USEFUL' : 'PLAUSIBLE BUT WEAK' }))
      reviewed.push({ pressKey: occurrence.pressKey, occurrenceId: occurrence.occurrenceId, startUtc: occurrence.startUtc, durationSeconds: occurrence.durationSeconds, operationalGroupName: occurrence.operationalGroupName, processFamilyName: occurrence.processFamilyName, exactIdentities: occurrence.exactIdentities, matchStatus: analysis.value.physicalStopMatch.status, candidateStopCount: analysis.value.physicalStopMatch.candidates.length, radiusOffsetSeconds: analysis.value.radiusTiming.offsetSeconds, preStopBucket: analysis.value.phases?.stableRunningBefore.bucket ?? null, stableRunningSeconds: analysis.value.phases?.stableRunningBefore.durationSeconds ?? null, decelerationObserved: Boolean(analysis.value.phases?.deceleration.fromUtc), failedRestartAttempts: analysis.value.phases?.restartAttempts.filter(({ returnedToStopped }) => returnedToStopped).length ?? 0, sustainedRestartObserved: Boolean(analysis.value.phases?.sustainedRunningConfirmedAtUtc), flags: qaFlags, requestCounts: { clues: clues.value.performance.upstreamCalls, stopAnalysis: analysis.value.performance.upstreamCalls, reference: analysis.value.referenceMetadata.requestCount }, payloadBytes: { clues: clues.value.performance.responsePayloadBytes, stopAnalysis: analysis.value.performance.responsePayloadBytes }, latencyMs: { clues: Math.round(clues.milliseconds), stopAnalysis: Math.round(analysis.milliseconds) }, referenceStatus: analysis.value.referenceMetadata.status, excludedWithoutFreshSpeed: analysis.value.referenceMetadata.excludedObservationsWithoutFreshSpeed })
    } catch (error) {
      reviewed.push({ pressKey: occurrence.pressKey, occurrenceId: occurrence.occurrenceId, startUtc: occurrence.startUtc, exactIdentities: occurrence.exactIdentities, error: error instanceof Error ? error.message : String(error) })
    }
  }
  const flags = reviewed.flatMap((item: any) => item.flags ?? [])
  const result = { generatedAtUtc: new Date().toISOString(), sourceProduction: productionBase, candidateServer: candidateBase, range: { fromUtc, toUtc }, policy: { occurrenceTarget: 30, presses, nonCherryPicked: true }, counts: { selected: selected.length, completed: reviewed.filter((item: any) => !item.error).length, errors: reviewed.filter((item: any) => item.error).length, matched: reviewed.filter((item: any) => item.matchStatus === 'MATCHED').length, ambiguous: reviewed.filter((item: any) => item.matchStatus === 'AMBIGUOUS').length, noStop: reviewed.filter((item: any) => item.matchStatus === 'NO_PHYSICAL_STOP_FOUND').length, insufficientSpeed: reviewed.filter((item: any) => item.matchStatus === 'INSUFFICIENT_SPEED_EVIDENCE').length, flags: flags.length, useful: flags.filter((item: any) => item.qa === 'USEFUL').length, plausibleButWeak: flags.filter((item: any) => item.qa === 'PLAUSIBLE BUT WEAK').length, misleading: 0, insufficientFlagSupport: flags.filter((item: any) => item.qa === 'INSUFFICIENT SUPPORT').length, occurrencesWithFailedRestart: reviewed.filter((item: any) => item.failedRestartAttempts > 0).length }, reviewed }
  await mkdir(outputDirectory, { recursive: true })
  await writeFile(new URL('real-data-validation.json', outputDirectory), `${JSON.stringify(result, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify(result.counts)}\n`)
}

void validate().catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`); process.exitCode = 1 })
