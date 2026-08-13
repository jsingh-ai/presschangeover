import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { EngineeringClueAnalysisService, type EngineeringSignalClue } from '../server/src/telemetry/engineering-clue-analysis.js'
import type { ActivityAnalysis, ActivityCatalogItem, ActivityOccurrence, ActivitySelection } from '../client/src/types/api.js'
import type { RadiusPressKey } from '../server/src/radius/models.js'
import type { PressEvidenceCapabilities, PressMotionEvidence, PressSemanticHistoryEvidence, TelemetrySemanticHistoryRequest } from '../server/src/telemetry/telemetry-contracts.js'
import type { TelemetryFoundationService } from '../server/src/telemetry/telemetry-foundation-service.js'

const baseUrl = process.env.PROCESS_INTELLIGENCE_URL ?? 'http://10.8.10.97:8088'
const outputPath = resolve(process.argv[2] ?? 'review-artifacts/engineering-clues/phase-1.1-real-occurrence-audit.json')
const toUtc = new Date(Date.now() - 20 * 60_000).toISOString()
const fromUtc = new Date(Date.parse(toUtc) - 30 * 24 * 60 * 60_000).toISOString()
const presses = ['press5', 'press8', 'press12', 'press13', 'press14', 'press15'] as const
const targets = [
  ['Run Production entry', /run production|production/i],
  ['Make Ready', /make ready/i],
  ['Cleaning / Wash', /clean|wash/i],
  ['Impression / Register / Print Quality', /impression|register|print quality|quality/i],
  ['Anilox-related', /anilox/i],
  ['Roll / Material', /roll|material/i],
  ['Mechanical issue', /mechanical|mech\b/i],
  ['Electrical issue', /electrical|electric/i],
  ['Maintenance', /maintenance/i],
  ['Waiting / Hold / Idle', /waiting|wait|hold|idle/i],
] as const

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, init)
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${path}`)
  return response.json() as Promise<T>
}

function activityPath(pressKey: RadiusPressKey, selection?: ActivitySelection): string {
  const query = new URLSearchParams({ fromUtc, toUtc, pressKey, evidenceLimit: '100' })
  if (selection) { query.set('level', selection.level); query.set('key', selection.key); if (selection.operationalGroupKey) query.set('operationalGroupKey', selection.operationalGroupKey) }
  return `/api/radius/activity-analysis?${query}`
}

const liveTelemetry = {
  capabilities: { get: (pressKey: RadiusPressKey, _requestId?: string, signal?: AbortSignal) => json<PressEvidenceCapabilities>(`/api/telemetry/presses/${pressKey}/capabilities`, { signal }) },
  semanticHistory: (pressKey: RadiusPressKey, query: TelemetrySemanticHistoryRequest, _requestId?: string, signal?: AbortSignal) => json<PressSemanticHistoryEvidence>(`/api/telemetry/presses/${pressKey}/semantic-history`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(query), signal }),
  motion: (pressKey: RadiusPressKey, rangeFromUtc: string, rangeToUtc: string, _requestId?: string, signal?: AbortSignal) => json<PressMotionEvidence>(`/api/telemetry/presses/${pressKey}/motion?${new URLSearchParams({ fromUtc: rangeFromUtc, toUtc: rangeToUtc })}`, { signal }),
} as unknown as TelemetryFoundationService

function catalogText(item: ActivityCatalogItem): string { return [item.label, item.description, item.statusDescription, item.operationalGroupName, item.processFamilyName].filter(Boolean).join(' ') }
function exactCatalogText(item: ActivityCatalogItem): string { return [item.label, item.description, item.statusDescription].filter(Boolean).join(' ') }
function selectionOf(item: ActivityCatalogItem): ActivitySelection { return { level: item.level, key: item.key, label: item.label, ...(item.operationalGroupKey ? { operationalGroupKey: item.operationalGroupKey } : {}) } }
function completedOccurrences(analysis: ActivityAnalysis): ActivityOccurrence[] { return analysis.occurrences.filter(({ endUtc }) => Date.parse(endUtc) < Date.parse(toUtc) - 15 * 60_000) }

async function traceDescription(pressKey: RadiusPressKey, clue: EngineeringSignalClue, window: { fromUtc: string; toUtc: string }) {
  if (clue.canonicalId === 'physical.motion_state') {
    const motion = await liveTelemetry.motion(pressKey, window.fromUtc, window.toUtc)
    return { representation: 'intervals', observationCount: motion.segments.length, description: motion.segments.length ? `${motion.segments.length} derived motion intervals; observed sequence ${motion.segments.slice(0, 8).map(({ state }) => state).join(' → ')}` : 'No motion intervals returned', firstObservedAtUtc: motion.segments[0]?.fromUtc ?? null, lastObservedAtUtc: motion.segments.at(-1)?.toUtc ?? null }
  }
  const representation = clue.signalType === 'continuous' ? 'samples' : 'changes'
  const history = await liveTelemetry.semanticHistory(pressKey, { fromUtc: window.fromUtc, toUtc: window.toUtc, includeSeed: true, signals: [{ canonicalId: clue.canonicalId, ...(clue.deckNumber === null ? {} : { deckNumber: clue.deckNumber }), representation }] })
  const signal = history.signals[0]
  if (!signal) return { representation, observationCount: 0, description: 'Selected signal was not returned', firstObservedAtUtc: null, lastObservedAtUtc: null }
  if (representation === 'changes') return { representation, observationCount: signal.changes.length, description: signal.changes.length ? `${signal.changes.length} raw transitions; first ${String(signal.changes[0]!.previousValue)} → ${String(signal.changes[0]!.value)}` : 'No raw transitions returned', firstObservedAtUtc: signal.changes[0]?.observedAtUtc ?? null, lastObservedAtUtc: signal.changes.at(-1)?.observedAtUtc ?? null }
  const numeric = signal.samples.filter(({ value }) => typeof value === 'number' && Number.isFinite(value))
  const values = numeric.map(({ value }) => value as number)
  return { representation, observationCount: numeric.length, description: numeric.length ? `${numeric.length} numeric observations; raw observed range ${Math.min(...values)} to ${Math.max(...values)}; first ${values[0]}; last ${values.at(-1)}` : 'No numeric observations returned', firstObservedAtUtc: numeric[0]?.observedAtUtc ?? null, lastObservedAtUtc: numeric.at(-1)?.observedAtUtc ?? null }
}

type QaClass = 'USEFUL' | 'PLAUSIBLE BUT WEAK' | 'MISLEADING' | 'INSUFFICIENT EVIDENCE'
function qaClassification(clue: EngineeringSignalClue, trace: Awaited<ReturnType<typeof traceDescription>>): { classification: QaClass; reason: string } {
  if (!trace.observationCount) return { classification: 'INSUFFICIENT EVIDENCE', reason: 'The detailed trace returned no usable observation during validation.' }
  if (clue.signalType === 'state_event' || clue.signalType === 'step_reference') {
    if (!clue.transitionCount) return { classification: 'MISLEADING', reason: 'The clue was ranked without an explicit raw transition.' }
    if (trace.representation === 'changes' && trace.observationCount < clue.transitionCount) return { classification: 'MISLEADING', reason: 'The detailed raw trace did not reproduce the transition count in the clue summary.' }
    return { classification: 'USEFUL', reason: 'The detailed trace reproduces an explicit raw transition at an observed timestamp.' }
  }
  if (!clue.before || !clue.during || clue.before.count < 3 || clue.during.count < 3) return { classification: 'INSUFFICIENT EVIDENCE', reason: 'The before/during comparison lacks the deterministic minimum of three numeric observations in each compared period.' }
  const strongerSupport = clue.before.count >= 3 && clue.during.count >= 3
  const medianShift = Math.abs((clue.during.median ?? 0) - (clue.before.median ?? 0))
  const referenceSpread = Math.max(clue.before.iqr ?? 0, Math.abs(clue.before.median ?? 0) * .02, 1e-9)
  const variabilityRatio = (clue.during.iqr ?? 0) / Math.max(clue.before.iqr ?? 0, 1e-9)
  if (strongerSupport && (medianShift / referenceSpread >= 3 || variabilityRatio >= 3)) return { classification: 'USEFUL', reason: 'The raw trace supports a clear within-signal distribution or variability change with at least three observations in both compared periods.' }
  return { classification: 'PLAUSIBLE BUT WEAK', reason: strongerSupport ? 'The trace supports the deterministic threshold, but the observed separation is modest.' : 'The clue meets the deterministic minimum, but only two observations support at least one compared period.' }
}

async function main() {
  const catalogByPress = new Map<RadiusPressKey, ActivityAnalysis>()
  for (const pressKey of presses) {
    try { catalogByPress.set(pressKey, await json<ActivityAnalysis>(activityPath(pressKey))) } catch {}
  }

  const selected: Array<{ target: string; selection: ActivitySelection; occurrence: ActivityOccurrence }> = []
  const selectedIds = new Set<string>()
  let pressRotation = 0
  for (const [target, pattern] of targets) {
    const candidates = presses.flatMap((pressKey, index) => (catalogByPress.get(pressKey)?.catalog ?? []).filter((item) => (item.durationSeconds ?? 0) > 0 && pattern.test(catalogText(item))).map((item) => ({ pressKey, item, exactSourceMatch: pattern.test(exactCatalogText(item)), order: (index - pressRotation + presses.length) % presses.length }))).sort((left, right) => Number(right.exactSourceMatch) - Number(left.exactSourceMatch) || Number(right.item.level === 'exact_status') - Number(left.item.level === 'exact_status') || left.order - right.order || (right.item.durationSeconds ?? 0) - (left.item.durationSeconds ?? 0))
    const usedPresses = new Set<RadiusPressKey>()
    for (const candidate of candidates) {
      if (usedPresses.has(candidate.pressKey) || usedPresses.size >= 2) continue
      try {
        const analysis = await json<ActivityAnalysis>(activityPath(candidate.pressKey, selectionOf(candidate.item)))
        const occurrence = completedOccurrences(analysis).find(({ occurrenceId }) => !selectedIds.has(occurrenceId))
        if (!occurrence) continue
        selected.push({ target, selection: selectionOf(candidate.item), occurrence }); selectedIds.add(occurrence.occurrenceId); usedPresses.add(candidate.pressKey)
      } catch {}
    }
    pressRotation = (pressRotation + 1) % presses.length
  }

  for (const pressKey of presses) {
    if (selected.some(({ occurrence }) => occurrence.pressKey === pressKey)) continue
    for (const item of (catalogByPress.get(pressKey)?.catalog ?? []).filter((entry) => entry.level === 'exact_status' && (entry.durationSeconds ?? 0) > 0).sort((left, right) => (right.durationSeconds ?? 0) - (left.durationSeconds ?? 0))) {
      try {
        const analysis = await json<ActivityAnalysis>(activityPath(pressKey, selectionOf(item)))
        const occurrence = completedOccurrences(analysis).find(({ occurrenceId }) => !selectedIds.has(occurrenceId))
        if (!occurrence) continue
        selected.push({ target: 'Press coverage supplement', selection: selectionOf(item), occurrence }); selectedIds.add(occurrence.occurrenceId); break
      } catch {}
    }
  }

  const service = new EngineeringClueAnalysisService(liveTelemetry)
  const reviews = []
  const qaCounts: Record<QaClass, number> = { USEFUL: 0, 'PLAUSIBLE BUT WEAK': 0, MISLEADING: 0, 'INSUFFICIENT EVIDENCE': 0 }
  for (const [index, item] of selected.slice(0, 24).entries()) {
    const occurrence = item.occurrence
    let clueResult
    try { clueResult = await service.analyze({ occurrenceId: occurrence.occurrenceId, pressKey: occurrence.pressKey, displayName: occurrence.displayName, startUtc: occurrence.startUtc, endUtc: occurrence.endUtc, durationSeconds: occurrence.durationSeconds, exactIdentities: occurrence.exactIdentities.map(({ eventType, statusCode, statusDescription }) => ({ eventType, statusCode, statusDescription })) }, `qa-${index}`) } catch (error) {
      reviews.push({ target: item.target, press: { pressKey: occurrence.pressKey, displayName: occurrence.displayName }, exactRadiusIdentity: occurrence.exactIdentities.map(({ eventType, statusCode, statusDescription }) => ({ eventType, statusCode, statusDescription })), operationalGroup: occurrence.operationalGroupName, processFamily: occurrence.processFamilyName, occurrence: { startUtc: occurrence.startUtc, endUtc: occurrence.endUtc, durationSeconds: occurrence.durationSeconds }, analysisUnavailable: error instanceof Error ? error.message : String(error), coverage: null, whereToLook: [], topClues: [], firstObservedChanges: [], categorySummary: [], performance: null })
      continue
    }
    const topClues = []
    for (const clue of clueResult.signalClues.filter(({ isClue }) => isClue).slice(0, 3)) {
      let trace
      try { trace = await traceDescription(occurrence.pressKey, clue, clueResult.evidenceWindow) } catch { trace = { representation: clue.signalType, observationCount: 0, description: 'Detailed trace request was temporarily unavailable', firstObservedAtUtc: null, lastObservedAtUtc: null } }
      const qa = qaClassification(clue, trace)
      qaCounts[qa.classification] += 1
      topClues.push({ clue: { canonicalId: clue.canonicalId, deckNumber: clue.deckNumber, friendlyName: clue.friendlyName, signalType: clue.signalType, category: clue.category, description: clue.description, before: clue.before, during: clue.during, after: clue.after, enteringValue: clue.enteringValue, transitionCount: clue.transitionCount, firstRelevantAtUtc: clue.firstRelevantAtUtc, firstRelevantOffsetMs: clue.firstRelevantOffsetMs, observationState: clue.observationState, unitLabel: clue.unitLabel }, trace, qa })
    }
    reviews.push({ target: item.target, press: { pressKey: occurrence.pressKey, displayName: occurrence.displayName }, exactRadiusIdentity: occurrence.exactIdentities.map(({ eventType, statusCode, statusDescription }) => ({ eventType, statusCode, statusDescription })), operationalGroup: occurrence.operationalGroupName, processFamily: occurrence.processFamilyName, occurrence: { startUtc: occurrence.startUtc, endUtc: occurrence.endUtc, durationSeconds: occurrence.durationSeconds }, evidenceWindow: clueResult.evidenceWindow, coverage: clueResult.coverage, whereToLook: clueResult.whereToLook, topClues, firstObservedChanges: clueResult.firstChanges.slice(0, 12), categorySummary: clueResult.categoryCells.filter(({ status }) => status !== 'unsupported').map(({ scopeLabel, category, status, supportedSignals, observedSignals, clueSignals }) => ({ scopeLabel, category, status, supportedSignals, observedSignals, clueSignals })), performance: clueResult.performance })
  }
  const reviewedClues = Object.values(qaCounts).reduce((sum, count) => sum + count, 0)
  const audit = { generatedAtUtc: new Date().toISOString(), source: baseUrl, range: { fromUtc, toUtc }, requestedPresses: presses, targetTypes: targets.map(([label]) => label), occurrenceCount: reviews.length, qa: { counts: qaCounts, reviewedClues, usefulPercentage: reviewedClues ? qaCounts.USEFUL / reviewedClues * 100 : 0, plausibleButWeakPercentage: reviewedClues ? qaCounts['PLAUSIBLE BUT WEAK'] / reviewedClues * 100 : 0, misleadingReasons: reviews.flatMap((review) => review.topClues.filter(({ qa }) => qa.classification === 'MISLEADING').map(({ clue, qa }) => ({ pressKey: review.press.pressKey, startUtc: review.occurrence.startUtc, canonicalId: clue.canonicalId, deckNumber: clue.deckNumber, reason: qa.reason }))) }, reviews }
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, JSON.stringify(audit, null, 2))
  console.log(JSON.stringify({ outputPath, occurrenceCount: reviews.length, presses: [...new Set(reviews.map(({ press }) => press.pressKey))], targets: [...new Set(reviews.map(({ target }) => target))], qa: audit.qa, performance: reviews.map(({ press, performance }) => performance ? ({ pressKey: press.pressKey, ...performance }) : ({ pressKey: press.pressKey, unavailable: true })) }, null, 2))
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
