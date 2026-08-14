import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { ENGINEERING_CLUE_CATALOG } from '../server/src/telemetry/engineering-clue-analysis.js'
import { currentScreenCandidates, selectHistoricalCandidates, type CandidateIdentity } from '../server/src/telemetry/stop-restart-candidate-selection.js'
import { PHYSICAL_SPEED_POLICY, PRE_STOP_REFERENCE_POLICY, alignSignalToSpeed, buildStopPhases, descriptiveStats, matchPhysicalStop, numericObservations, referenceDeviation, type NumericObservation, type RunningWindow } from '../server/src/telemetry/stop-restart-analysis.js'
import type { CapabilityAssessment, PressSemanticSignalEvidence } from '../server/src/telemetry/telemetry-contracts.js'

const productionBase = process.env.PROCESS_INTELLIGENCE_URL ?? 'http://10.8.10.97:8088'
const candidateBase = process.env.PHASE3_CANDIDATE_URL ?? 'http://127.0.0.1:8091'
const fromUtc = process.env.PHASE3_FROM_UTC ?? '2026-08-06T17:00:00.000Z'
const toUtc = process.env.PHASE3_TO_UTC ?? '2026-08-13T17:00:00.000Z'
const target = 10
const presses = ['press5', 'press8', 'press12', 'press13', 'press14', 'press15'] as const
const directory = new URL('../review-artifacts/phase3-stop-restart/', import.meta.url)
const HIGH_VALUE_MACHINE = ['web_tension.chill_draw.actual', 'unwind.tension.actual', 'rewind.tension.actual', 'dryer.tunnel.temperature.actual']
const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))
const key = ({ canonicalId, deckNumber }: { canonicalId: string; deckNumber?: number | null }) => `${canonicalId}:${deckNumber ?? ''}`

let requests = 0; let bytes = 0; let requestMs = 0; let retries = 0
async function json<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  const started = performance.now()
  for (let attempt = 0; attempt < 3; attempt += 1) {
    requests += 1
    const response = await fetch(`${base}${path}`, init); const body = await response.text(); bytes += Buffer.byteLength(body)
    if (response.ok) { requestMs += performance.now() - started; retries += attempt; return JSON.parse(body) as T }
    if (response.status !== 503 || attempt === 2) throw new Error(`${path}: ${response.status} ${body.slice(0, 180)}`)
    await wait(500 * (attempt + 1))
  }
  throw new Error('unreachable')
}

type Occurrence = { occurrenceId: string; pressKey: string; displayName: string; startUtc: string; endUtc: string; durationSeconds: number; operationalGroupKey: string; operationalGroupName: string; processFamilyKey: string; processFamilyName: string; exactIdentities: Array<{ eventType: string; statusCode: string | null; statusDescription: string }> }
type Clues = { signalClues: Array<{ canonicalId: string; deckNumber: number | null; friendlyName: string; signalType: string; category: CandidateIdentity['category']; isClue: boolean; clueQuality: number }> }
type Capabilities = { capabilities: CapabilityAssessment[] }
type History = { signals: PressSemanticSignalEvidence[] }

const post = (pressKey: string, body: unknown) => json<History>(candidateBase, `/api/telemetry/presses/${pressKey}/semantic-history`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const batches = <T>(items: T[], size: number) => Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size))

async function allOccurrences(): Promise<Occurrence[]> {
  const output: Occurrence[] = []
  for (const pressKey of presses) {
    const query = new URLSearchParams({ fromUtc, toUtc, pressKey, level: 'radius_state', key: 'B', evidenceLimit: '100' })
    output.push(...(await json<{ occurrences: Occurrence[] }>(productionBase, `/api/radius/activity-analysis?${query}`)).occurrences)
  }
  return output.sort((left, right) => Date.parse(right.startUtc) - Date.parse(left.startUtc))
}

async function speedPhases(occurrence: Occurrence) {
  const window = { fromUtc: new Date(Date.parse(occurrence.startUtc) - PHYSICAL_SPEED_POLICY.detailedWindowBeforeMs).toISOString(), toUtc: new Date(Date.parse(occurrence.startUtc) + PHYSICAL_SPEED_POLICY.detailedWindowAfterMs).toISOString() }
  const history = await post(occurrence.pressKey, { ...window, includeSeed: true, signals: [{ canonicalId: 'machine.speed.actual', representation: 'samples' }] })
  const speed = numericObservations(history.signals[0]?.samples ?? [])
  const match = matchPhysicalStop(speed, occurrence.startUtc)
  const phases = match.status === 'MATCHED' && match.selected ? buildStopPhases(speed, match.selected) : null
  return { window, match, phases }
}

function broadIdentities(capabilities: CapabilityAssessment[]): CandidateIdentity[] {
  const byId = new Map(capabilities.map((item) => [item.canonicalId, item]))
  return ENGINEERING_CLUE_CATALOG.flatMap((item): CandidateIdentity[] => {
    const capability = byId.get(item.canonicalId)
    if (item.signalType !== 'continuous' || item.canonicalId === 'machine.speed.actual' || capability?.state !== 'SUPPORTED' || !capability.historyQueryable || capability.evidenceKind !== 'semantic_history') return []
    return item.scope === 'machine' ? [{ canonicalId: item.canonicalId, friendlyName: item.friendlyName, signalType: item.signalType, category: item.category, source: 'condition' }] : capability.deckNumbers.map((deckNumber) => ({ canonicalId: item.canonicalId, deckNumber, friendlyName: item.friendlyName, signalType: item.signalType, category: item.category, source: 'condition' }))
  })
}

async function histories(pressKey: string, from: string, to: string, identities: CandidateIdentity[], includeSpeed: boolean): Promise<{ speed: NumericObservation[]; signals: Map<string, PressSemanticSignalEvidence> }> {
  const output = new Map<string, PressSemanticSignalEvidence>(); const speed: NumericObservation[] = []
  const size = includeSpeed ? 49 : 50
  for (const batch of batches(identities, size)) {
    const selectors = [...(includeSpeed ? [{ canonicalId: 'machine.speed.actual', representation: 'samples' as const }] : []), ...batch.map(({ canonicalId, deckNumber }) => ({ canonicalId, ...(deckNumber === undefined ? {} : { deckNumber }), representation: 'samples' as const }))]
    const value = await post(pressKey, { fromUtc: from, toUtc: to, includeSeed: false, signals: selectors })
    for (const item of value.signals) {
      if (item.canonicalId === 'machine.speed.actual') speed.push(...numericObservations(item.samples))
      else output.set(key(item), item)
    }
  }
  return { speed, signals: output }
}

async function clues(occurrence: Occurrence): Promise<CandidateIdentity[]> {
  const body = { occurrenceId: occurrence.occurrenceId, displayName: occurrence.displayName, startUtc: occurrence.startUtc, endUtc: occurrence.endUtc, exactIdentities: occurrence.exactIdentities }
  const value = await json<Clues>(candidateBase, `/api/telemetry/presses/${occurrence.pressKey}/clues`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return value.signalClues.filter(({ isClue, signalType }) => isClue && signalType === 'continuous').sort((left, right) => right.clueQuality - left.clueQuality).slice(0, 12).map(({ canonicalId, deckNumber, friendlyName, signalType, category }) => ({ canonicalId, ...(deckNumber === null ? {} : { deckNumber }), friendlyName, signalType: signalType as 'continuous', category, source: 'clue' }))
}

async function main() {
  const started = performance.now(); const pool = await allOccurrences(); const selected: Array<{ occurrence: Occurrence; window: { fromUtc: string; toUtc: string }; stable: RunningWindow }> = []
  const perPress = new Map<string, number>()
  for (const occurrence of pool) {
    if (selected.length >= target) break
    if ((perPress.get(occurrence.pressKey) ?? 0) >= 3) continue
    const result = await speedPhases(occurrence)
    if (!result.phases?.stableRunningBefore.supported) continue
    selected.push({ occurrence, window: result.window, stable: result.phases.stableRunningBefore }); perPress.set(occurrence.pressKey, (perPress.get(occurrence.pressKey) ?? 0) + 1)
  }
  const reviewed = []
  for (const item of selected) {
    const capabilitySet = await json<Capabilities>(candidateBase, `/api/telemetry/presses/${item.occurrence.pressKey}/capabilities`)
    const identities = broadIdentities(capabilitySet.capabilities)
    const current = await histories(item.occurrence.pressKey, item.window.fromUtc, item.window.toUtc, identities, false)
    const referenceFrom = new Date(Date.parse(item.window.fromUtc) - PRE_STOP_REFERENCE_POLICY.referenceHours * 3_600_000).toISOString()
    const referenceSignals = new Map<string, NumericObservation[]>(); const referenceSpeed: NumericObservation[] = []
    for (let cursor = Date.parse(referenceFrom); cursor < Date.parse(item.window.fromUtc); cursor += PRE_STOP_REFERENCE_POLICY.chunkHours * 3_600_000) {
      const chunkFrom = new Date(cursor).toISOString(); const chunkTo = new Date(Math.min(Date.parse(item.window.fromUtc), cursor + PRE_STOP_REFERENCE_POLICY.chunkHours * 3_600_000)).toISOString()
      const history = await histories(item.occurrence.pressKey, chunkFrom, chunkTo, identities, true)
      referenceSpeed.push(...history.speed)
      for (const [identity, signal] of history.signals) referenceSignals.set(identity, [...referenceSignals.get(identity) ?? [], ...numericObservations(signal.samples)])
    }
    const requested = await clues(item.occurrence)
    const original = [...requested, ...HIGH_VALUE_MACHINE.map((canonicalId) => ({ canonicalId, source: 'priority' as const }))].filter((candidate, index, all) => all.findIndex((other) => key(other) === key(candidate)) === index).slice(0, 12)
    const screen = [...requested, ...currentScreenCandidates(capabilitySet.capabilities)].filter((candidate, index, all) => all.findIndex((other) => key(other) === key(candidate)) === index).slice(0, 96)
    const improved = selectHistoricalCandidates({ requested, screen, currentSignals: [...current.signals.values()], stableRunningBefore: item.stable, operationalGroupName: item.occurrence.operationalGroupName, processFamilyName: item.occurrence.processFamilyName }).selected
    const strong = []; let currentSupported = 0; let comparableSupported = 0
    for (const identity of identities) {
      const currentPoints = numericObservations(current.signals.get(key(identity))?.samples ?? []).filter(({ atUtc }) => Date.parse(atUtc) >= Date.parse(item.stable.fromUtc!) && Date.parse(atUtc) <= Date.parse(item.stable.toUtc!))
      const currentStats = descriptiveStats(currentPoints.map(({ value }) => value)); if (currentStats && currentStats.count >= PRE_STOP_REFERENCE_POLICY.minimumCurrentObservations) currentSupported += 1
      const aligned = alignSignalToSpeed(referenceSignals.get(key(identity)) ?? [], referenceSpeed)
      const referenceStats = descriptiveStats(aligned.values[item.stable.bucket!]); if (currentStats && currentStats.count >= PRE_STOP_REFERENCE_POLICY.minimumCurrentObservations && referenceStats && referenceStats.count >= PRE_STOP_REFERENCE_POLICY.minimumReferenceObservations) comparableSupported += 1
      if (!currentStats || currentStats.count < PRE_STOP_REFERENCE_POLICY.minimumCurrentObservations || !referenceStats || referenceStats.count < PRE_STOP_REFERENCE_POLICY.minimumReferenceObservations) continue
      const deviation = referenceDeviation(currentStats, referenceStats); if (!deviation.qualifies) continue
      strong.push({ canonicalId: identity.canonicalId, deckNumber: identity.deckNumber ?? null, friendlyName: identity.friendlyName, category: identity.category, current: currentStats, reference: referenceStats, robustDeviation: deviation.robustDeviation, direction: deviation.direction, currentTrace: currentPoints, includedByOriginalSelector: original.some((candidate) => key(candidate) === key(identity)), includedByImprovedSelector: improved.some((candidate) => key(candidate) === key(identity)), missReason: original.some((candidate) => key(candidate) === key(identity)) ? null : requested.some((candidate) => key(candidate) === key(identity)) ? 'displaced by original 12-slot ordering' : 'no local clue and not one of four machine priorities' })
    }
    reviewed.push({ pressKey: item.occurrence.pressKey, occurrenceId: item.occurrence.occurrenceId, startUtc: item.occurrence.startUtc, operationalGroupName: item.occurrence.operationalGroupName, processFamilyName: item.occurrence.processFamilyName, exactIdentities: item.occurrence.exactIdentities, stableRunningBefore: item.stable, broadSignalCount: identities.length, currentSupportedSignalCount: currentSupported, comparableSignalCount: comparableSupported, originalSelectorCount: original.length, improvedSelectorCount: improved.length, improvedSelector: improved.map(({ canonicalId, deckNumber, source }) => ({ canonicalId, deckNumber: deckNumber ?? null, source })), strongDeviations: strong })
  }
  const strong = reviewed.flatMap((item) => item.strongDeviations.map((deviation) => ({ pressKey: item.pressKey, occurrenceId: item.occurrenceId, ...deviation })))
  const result = { generatedAtUtc: new Date().toISOString(), sourceProduction: productionBase, candidateServer: candidateBase, policy: { target, selected: selected.length, strictThresholdsUnchanged: true, referenceHours: 24, chunkHours: 2, broadSet: 'all capability-supported continuous identities in the curated Engineering Clue catalog' }, counts: { events: reviewed.length, broadSignalEventPairs: reviewed.reduce((sum, item) => sum + item.broadSignalCount, 0), currentSupportedSignalEventPairs: reviewed.reduce((sum, item) => sum + item.currentSupportedSignalCount, 0), comparableSignalEventPairs: reviewed.reduce((sum, item) => sum + item.comparableSignalCount, 0), strongDeviations: strong.length, missedByOriginalSelector: strong.filter((item) => !item.includedByOriginalSelector).length, missedByImprovedSelector: strong.filter((item) => !item.includedByImprovedSelector).length }, performance: { requests, retries, responseBytes: bytes, aggregateRequestMs: Math.round(requestMs), wallMs: Math.round(performance.now() - started) }, reviewed }
  await mkdir(directory, { recursive: true }); await writeFile(new URL('phase31-broad-audit.json', directory), `${JSON.stringify(result, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify({ counts: result.counts, performance: result.performance })}\n`)
}

void main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`); process.exitCode = 1 })
