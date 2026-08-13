import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { ENGINEERING_SIGNAL_CATALOG, browserCategoryForClue, signalKey, type EngineeringSignalIdentity } from '../client/src/engineering-signal-catalog.js'

const baseUrl = process.argv[2] ?? 'http://10.8.10.97:8088'
const outputPath = resolve(process.argv[3] ?? 'review-artifacts/engineering-telemetry-phase2/real-data-performance.json')
const phaseOnePath = resolve('review-artifacts/engineering-clues/phase-1.1-real-occurrence-audit.json')

async function timedJson(path: string, init?: RequestInit) {
  const started = performance.now()
  const response = await fetch(new URL(path, baseUrl), init)
  const text = await response.text()
  const elapsedMs = performance.now() - started
  if (!response.ok) throw new Error(`${path}: ${response.status} ${text.slice(0, 200)}`)
  return { value: JSON.parse(text), elapsedMs, bytes: Buffer.byteLength(text) }
}

async function main() {
const phaseOne = JSON.parse(await readFile(phaseOnePath, 'utf8')) as { reviews: Array<any> }
const clueCases = ['press5', 'press12', 'press14'].map((pressKey) => phaseOne.reviews.find((review) => review.press.pressKey === pressKey && review.whereToLook.length > 0))
const noClueCase = phaseOne.reviews.find((review) => review.press.pressKey === 'press14' && review.whereToLook.length === 0)
if (clueCases.some((item) => !item) || !noClueCase) throw new Error('Required Phase 1 audit cases are unavailable')

const occurrenceInput = (review: any) => ({ occurrenceId: `${review.press.pressKey}:${review.occurrence.startUtc}:phase2-audit`, displayName: review.press.displayName, startUtc: review.occurrence.startUtc, endUtc: review.occurrence.endUtc, exactIdentities: review.exactRadiusIdentity })
const evidenceWindow = (review: any, paddingMinutes: number) => {
  const start = Date.parse(review.occurrence.startUtc); const end = Date.parse(review.occurrence.endUtc); const maximum = 2 * 60 * 60_000; const requested = paddingMinutes * 60_000
  const available = Math.max(0, maximum - (end - start)); const before = Math.min(requested, available / 2); const after = Math.min(requested, available - before)
  return { fromUtc: new Date(start - before).toISOString(), toUtc: new Date(end + after).toISOString() }
}

function selectors(capabilities: any[], clues: any[], limit: number): Array<EngineeringSignalIdentity & { representation: 'samples' | 'changes' }> {
  const byId = new Map(capabilities.map((item) => [item.canonicalId, item]))
  const preferred: EngineeringSignalIdentity[] = [{ canonicalId: 'machine.speed.actual' }, ...clues.filter((clue) => clue.isClue).map((clue) => ({ canonicalId: clue.canonicalId, ...(clue.deckNumber === null ? {} : { deckNumber: clue.deckNumber }) }))]
  for (const definition of ENGINEERING_SIGNAL_CATALOG) {
    const capability = byId.get(definition.canonicalId)
    if (capability?.state !== 'SUPPORTED' || !capability.historyQueryable || definition.canonicalId === 'physical.motion_state') continue
    if (definition.scope === 'machine') preferred.push({ canonicalId: definition.canonicalId })
    else for (const deckNumber of capability.deckNumbers) preferred.push({ canonicalId: definition.canonicalId, deckNumber })
  }
  return preferred.filter((item, index, all) => all.findIndex((candidate) => signalKey(candidate) === signalKey(item)) === index).slice(0, limit).map((item) => ({ ...item, representation: ENGINEERING_SIGNAL_CATALOG.find(({ canonicalId }) => canonicalId === item.canonicalId)?.signalType === 'continuous' ? 'samples' : 'changes' }))
}

const report: any = { generatedAtUtc: new Date().toISOString(), source: baseUrl, presses: {}, workflow: {}, noClue: {}, summary: {} }
for (const review of clueCases) {
  const pressKey = review.press.pressKey
  const capabilityResult = await timedJson(`/api/telemetry/presses/${pressKey}/capabilities`)
  const clueResult = await timedJson(`/api/telemetry/presses/${pressKey}/clues`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(occurrenceInput(review)) })
  const five = selectors(capabilityResult.value.capabilities, clueResult.value.signalClues, 5)
  const twelve = selectors(capabilityResult.value.capabilities, clueResult.value.signalClues, 12)
  const windows: Record<string, any> = {}
  for (const padding of [5, 15, 30]) {
    const range = evidenceWindow(review, padding)
    const result = await timedJson(`/api/telemetry/presses/${pressKey}/semantic-history`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...range, includeSeed: true, signals: five }) })
    windows[`plusMinus${padding}`] = { ...range, requestCount: 1, selectors: five.length, responseBytes: result.bytes, latencyMs: Number(result.elapsedMs.toFixed(1)), observations: result.value.signals.reduce((sum: number, signal: any) => sum + signal.samples.length + signal.changes.length + Number(Boolean(signal.seed)), 0) }
  }
  const range = evidenceWindow(review, 15)
  const twelveResult = await timedJson(`/api/telemetry/presses/${pressKey}/semantic-history`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...range, includeSeed: true, signals: twelve }) })
  const firstClue = clueResult.value.signalClues.find((clue: any) => clue.isClue)
  report.presses[pressKey] = {
    occurrence: occurrenceInput(review), capabilityCount: capabilityResult.value.capabilities.length, capabilityLatencyMs: Number(capabilityResult.elapsedMs.toFixed(1)),
    clueCount: clueResult.value.signalClues.filter((clue: any) => clue.isClue).length, clueLatencyMs: Number(clueResult.elapsedMs.toFixed(1)),
    clueTarget: firstClue ? { scope: firstClue.deckNumber === null ? 'machine' : `deck-${firstClue.deckNumber}`, browserCategory: browserCategoryForClue(firstClue.category, firstClue.canonicalId), canonicalId: firstClue.canonicalId } : null,
    fivePins: { selectors: five, windows },
    twelvePins: { selectors: twelve, requestCount: 1, selectorCount: twelve.length, responseBytes: twelveResult.bytes, latencyMs: Number(twelveResult.elapsedMs.toFixed(1)), signalsReturned: twelveResult.value.signals.length, observations: twelveResult.value.signals.reduce((sum: number, signal: any) => sum + signal.samples.length + signal.changes.length + Number(Boolean(signal.seed)), 0) },
  }
}

const noClueCapabilities = await timedJson(`/api/telemetry/presses/${noClueCase.press.pressKey}/capabilities`)
const noClueResult = await timedJson(`/api/telemetry/presses/${noClueCase.press.pressKey}/clues`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(occurrenceInput(noClueCase)) })
const manualSelectors = selectors(noClueCapabilities.value.capabilities, [], 5)
const manualRange = evidenceWindow(noClueCase, 15)
const manualResult = await timedJson(`/api/telemetry/presses/${noClueCase.press.pressKey}/semantic-history`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...manualRange, includeSeed: true, signals: manualSelectors }) })
report.noClue = { occurrence: occurrenceInput(noClueCase), whereToLook: noClueResult.value.whereToLook.length, clueSignals: noClueResult.value.signalClues.filter((clue: any) => clue.isClue).length, manualSelectors, manualSignalsReturned: manualResult.value.signals.length, manualObservations: manualResult.value.signals.reduce((sum: number, signal: any) => sum + signal.samples.length + signal.changes.length + Number(Boolean(signal.seed)), 0), latencyMs: Number(manualResult.elapsedMs.toFixed(1)) }

const pressFive = report.presses.press5
const pressTwelveCapabilities = (await timedJson('/api/telemetry/presses/press12/capabilities')).value.capabilities
report.workflow = {
  clueToInspector: pressFive.clueTarget,
  pinnedAtStart: pressFive.fivePins.selectors,
  nextOccurrence: report.presses.press12.occurrence,
  pinsAfterNext: pressFive.fivePins.selectors.map((pin: EngineeringSignalIdentity) => ({ ...pin, supportOnNextPress: (() => { const capability = pressTwelveCapabilities.find((item: any) => item.canonicalId === pin.canonicalId); return capability?.state === 'SUPPORTED' && (pin.deckNumber === undefined || capability.deckNumbers.includes(pin.deckNumber)) ? 'supported' : 'not_available' })() })),
}
const samples = Object.values(report.presses).flatMap((item: any) => [...Object.values(item.fivePins.windows), item.twelvePins]) as any[]
report.summary = { maximumSelectorsInRequest: Math.max(...samples.map((item) => item.selectorCount ?? item.selectors)), maximumResponseBytes: Math.max(...samples.map((item) => item.responseBytes)), maximumLatencyMs: Math.max(...samples.map((item) => item.latencyMs)), allRequestsWithin50Selectors: samples.every((item) => (item.selectorCount ?? item.selectors) <= 50), allRequestsWithinTwoHours: samples.every((item) => !item.fromUtc || Date.parse(item.toUtc) - Date.parse(item.fromUtc) <= 2 * 60 * 60_000) }

await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, JSON.stringify(report, null, 2))
console.log(JSON.stringify(report.summary))
}

void main().catch((error) => { console.error(error); process.exitCode = 1 })
