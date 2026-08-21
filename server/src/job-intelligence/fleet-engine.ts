import type { RadiusPressKey } from '../radius/models.js'
import { buildPressAffinity, evidenceSupport, matchesJobGroup, summarizeRadiusLosses, summarizeTransitions } from './engine.js'
import type { EvidenceSupport, FleetJobIntelligenceReport, FleetPressResult, FleetRadiusLossComparison, FleetTransitionMatrixCell, HistoricalRunSort, HistoricalRunSummary, JobAnalysisDimension, JobDecisionCard, JobGroupDefinition, JobMetricDistribution, JobRefinement, ProductionRun } from './contracts.js'

const round = (value: number, digits = 1) => { const factor = 10 ** digits; return Math.round(value * factor) / factor }
const percentile = (values: number[], fraction: number): number | null => { if (!values.length) return null; const ordered = [...values].sort((a, b) => a - b); const position = (ordered.length - 1) * fraction; const low = Math.floor(position); const high = Math.ceil(position); return low === high ? ordered[low]! : ordered[low]! + (ordered[high]! - ordered[low]!) * (position - low) }

export function metricDistribution(values: number[]): JobMetricDistribution { return { n: values.length, median: values.length ? round(percentile(values, .5)!) : null, p25: values.length ? round(percentile(values, .25)!) : null, p75: values.length ? round(percentile(values, .75)!) : null, p90: values.length ? round(percentile(values, .9)!) : null } }

export function matchesFleetSelection(run: ProductionRun, dimension: JobAnalysisDimension, group: JobGroupDefinition, refinements: JobRefinement[]) {
  const value = run.identities[dimension]
  if (!value || !matchesJobGroup(value, group)) return false
  return refinements.every((refinement) => { const candidate = refinement.previousIdentity ? run.previousIdentities?.[refinement.dimension] : run.identities[refinement.dimension]; return Boolean(candidate && matchesJobGroup(candidate, refinement.group)) })
}

function transitionPhaseSeconds(run: ProductionRun, eventType: 'M' | 'B'): number | null {
  const persisted = eventType === 'M' ? run.transitionMakeReadySeconds : run.transitionBadSeconds
  if (persisted !== undefined) return persisted
  const stableAt = run.transitionTiming.incomingStableRadiusProductionStartUtc
  if (!stableAt) return null
  const transitionStart = Date.parse(run.startUtc); const transitionEnd = Date.parse(stableAt)
  if (!Number.isFinite(transitionStart) || !Number.isFinite(transitionEnd) || transitionEnd <= transitionStart) return 0
  return run.radiusEpisodes.filter((episode) => episode.eventType === eventType).reduce((sum, episode) => {
    const overlap = Math.max(0, Math.min(Date.parse(episode.endUtc), transitionEnd) - Math.max(Date.parse(episode.startUtc), transitionStart))
    return sum + overlap / 1_000
  }, 0)
}

function percentages(runs: ProductionRun[]) {
  const good = runs.reduce((sum, run) => sum + run.goodSeconds, 0); const makeReady = runs.reduce((sum, run) => sum + run.makeReadySeconds, 0); const bad = runs.reduce((sum, run) => sum + run.badSeconds, 0); const other = runs.reduce((sum, run) => sum + run.otherRadiusSeconds, 0); const possible = runs.reduce((sum, run) => sum + run.durationSeconds, 0); const states = good + makeReady + bad
  return { observed: good + makeReady + bad + other, goodPercent: states ? round(good / states * 100) : 0, makeReadyPercent: states ? round(makeReady / states * 100) : 0, badPercent: states ? round(bad / states * 100) : 0, unavailablePercent: possible ? round(Math.max(0, possible - good - makeReady - bad - other) / possible * 100) : 0 }
}

function pressResult(pressKey: RadiusPressKey, runs: ProductionRun[], affinity: ReturnType<typeof buildPressAffinity>[number] | undefined, dimension: JobAnalysisDimension): FleetPressResult {
  const state = percentages(runs); const transitions = runs.filter((run) => run.previousIdentities?.[dimension] && run.previousIdentities?.[dimension] !== run.identities[dimension]); const transitionDurations = transitions.flatMap((run) => run.transitionToStableProductionSeconds === null ? [] : [run.transitionToStableProductionSeconds]); const transitionMakeReady = transitions.flatMap((run) => { const seconds = transitionPhaseSeconds(run, 'M'); return seconds === null ? [] : [seconds] }); const transitionBad = transitions.flatMap((run) => { const seconds = transitionPhaseSeconds(run, 'B'); return seconds === null ? [] : [seconds] }); const running = runs.flatMap((run) => run.runningPerformance ? [run.runningPerformance] : []); const runningGood = running.reduce((sum, item) => sum + item.goodSeconds, 0); const runningBad = running.reduce((sum, item) => sum + item.badSeconds, 0); const runningObserved = runningGood + runningBad; const speedRuns = running.filter((item) => item.speed && item.observedSeconds > 0); const speeds = speedRuns.map((item) => item.speed!); const support = affinity?.support ?? evidenceSupport(runs)
  return {
    pressKey, displayName: pressKey.replace('press', 'Press '), runCount: runs.length, observedSeconds: state.observed, goodPercent: state.goodPercent, makeReadyPercent: state.makeReadyPercent, badPercent: state.badPercent, unavailablePercent: state.unavailablePercent,
    medianTransitionSeconds: metricDistribution(transitionDurations).median, variabilityPoints: support.variabilityPoints, actualVersusComparableGoodPoints: affinity?.actualVersusComparableGoodPoints ?? null, comparableRunCount: affinity?.comparableRunCount ?? 0, comparisonDescription: affinity?.comparisonDescription ?? 'No sufficiently similar cross-press cohort.', recoverableOpportunitySeconds: affinity?.recoverableOpportunitySeconds ?? null, recoverableBaseline: affinity?.recoverableBaseline ?? null, support,
    changeover: { transitionCount: transitions.length, durationSeconds: metricDistribution(transitionDurations), makeReadySecondsPerTransition: transitionMakeReady.length ? round(transitionMakeReady.reduce((sum, seconds) => sum + seconds, 0) / transitionMakeReady.length) : null, badSecondsPerTransition: transitionBad.length ? round(transitionBad.reduce((sum, seconds) => sum + seconds, 0) / transitionBad.length) : null, changedDecks: runs.some((run) => run.deckConfiguration) ? metricDistribution(runs.flatMap((run) => run.deckConfiguration ? [run.deckConfiguration.changedDeckCount] : [])) : null },
    running: { runCount: running.length, goodPercent: runningObserved ? round(runningGood / runningObserved * 100) : 0, badPercent: runningObserved ? round(runningBad / runningObserved * 100) : 0, interruptionCount: running.reduce((sum, item) => sum + item.interruptions, 0), interruptionsPerProductionHour: runningGood ? round(running.reduce((sum, item) => sum + item.interruptions, 0) / (runningGood / 3600), 2) : null, uninterruptedGoodSeconds: metricDistribution(running.flatMap((item) => item.medianUninterruptedGoodSeconds === null ? [] : [item.medianUninterruptedGoodSeconds])), restartCount: running.reduce((sum, item) => sum + item.restartCount, 0), speed: speeds.length ? { sourceUnit: speeds.find((item) => item.sourceUnit)?.sourceUnit ?? null, canonicalUnitStatus: speeds.find((item) => item.canonicalUnitStatus)?.canonicalUnitStatus ?? null, distribution: metricDistribution(speeds.map((item) => item.median)), timeWeightedMean: round(speedRuns.reduce((sum, item) => sum + (item.speed!.timeWeightedMean ?? item.speed!.median) * item.observedSeconds, 0) / speedRuns.reduce((sum, item) => sum + item.observedSeconds, 0)) } : null },
    radiusLosses: summarizeRadiusLosses(runs, pressKey, runs[0]?.startUtc ?? new Date(0).toISOString(), runs.at(-1)?.endUtc ?? new Date(0).toISOString()), transitions: summarizeTransitions(runs, dimension), deckEvidence: runs.some((run) => run.deckConfiguration !== null) ? 'available' : 'unavailable',
  }
}

function lossComparison(presses: FleetPressResult[], runs: ProductionRun[]): FleetRadiusLossComparison[] {
  const grouped = new Map<string, FleetRadiusLossComparison>()
  for (const press of presses) for (const loss of press.radiusLosses) {
    const key = `${loss.eventType}\u0000${loss.statusCode ?? ''}\u0000${loss.statusDescription}`; const value = grouped.get(key) ?? { eventType: loss.eventType, statusCode: loss.statusCode, statusDescription: loss.statusDescription, presses: [] }
    const pressRuns = runs.filter((run) => run.pressKey === press.pressKey)
    const evidenceRuns = pressRuns.flatMap((run) => { const exact = run.radiusEpisodes.filter((episode) => episode.eventType === loss.eventType && episode.statusCode === loss.statusCode && episode.statusDescription === loss.statusDescription); const aggregate = run.radiusLossAggregates?.find((item) => item.eventType === loss.eventType && item.statusCode === loss.statusCode && item.statusDescription === loss.statusDescription); const totalSeconds = exact.reduce((sum, episode) => sum + episode.durationSeconds, 0) || aggregate?.totalSeconds || 0; const occurrenceCount = exact.length || aggregate?.occurrenceCount || 0; return occurrenceCount ? [{ runId: run.runId, startUtc: run.startUtc, totalSeconds, occurrenceCount }] : [] }).sort((a, b) => Date.parse(b.startUtc) - Date.parse(a.startUtc)).slice(0, 25)
    value.presses.push({ pressKey: press.pressKey, totalSeconds: loss.totalSeconds, secondsPerRun: loss.secondsPerRun, occurrenceCount: loss.occurrenceCount, occurrencesPerRun: loss.occurrencesPerRun, medianEpisodeSeconds: loss.medianEpisodeSeconds, evidenceRuns }); grouped.set(key, value)
  }
  return [...grouped.values()].sort((a, b) => Math.max(...b.presses.map((item) => item.secondsPerRun)) - Math.max(...a.presses.map((item) => item.secondsPerRun)) || a.statusDescription.localeCompare(b.statusDescription))
}

function transitionMatrix(runs: ProductionRun[], dimension: JobAnalysisDimension): FleetTransitionMatrixCell[] {
  const grouped = new Map<string, ProductionRun[]>()
  for (const run of runs) { const previous = run.previousIdentities?.[dimension]; const current = run.identities[dimension]; if (!previous || !current || previous === current || run.dataInterrupted) continue; const key = `${previous}\u0000${current}`; grouped.set(key, [...(grouped.get(key) ?? []), run]) }
  return [...grouped].map(([key, items]) => {
    const [previousValue, currentValue] = key.split('\u0000') as [string, string]
    return {
      previousValue, currentValue, transitionCount: items.length,
      durationSeconds: metricDistribution(items.flatMap((run) => run.transitionToStableProductionSeconds === null ? [] : [run.transitionToStableProductionSeconds])),
      makeReadySeconds: metricDistribution(items.flatMap((run) => { const seconds = transitionPhaseSeconds(run, 'M'); return seconds === null ? [] : [seconds] })),
      badSeconds: metricDistribution(items.flatMap((run) => { const seconds = transitionPhaseSeconds(run, 'B'); return seconds === null ? [] : [seconds] })),
      support: evidenceSupport(items), pressKeys: [...new Set(items.map((run) => run.pressKey))].sort(),
    }
  }).sort((a, b) => b.transitionCount - a.transitionCount || a.previousValue.localeCompare(b.previousValue))
}

function decisionCards(presses: FleetPressResult[], matrix: FleetTransitionMatrixCell[]): JobDecisionCard[] {
  const cards: JobDecisionCard[] = []; const supported = presses.filter((press) => press.support.level === 'strong' || press.support.level === 'moderate')
  const affinity = [...supported].filter((press) => press.actualVersusComparableGoodPoints !== null).sort((a, b) => b.actualVersusComparableGoodPoints! - a.actualVersusComparableGoodPoints!)[0]
  if (affinity) cards.push({ kind: 'preferred_press', label: 'Best supported running performance', headline: affinity.displayName, value: `${affinity.actualVersusComparableGoodPoints! >= 0 ? '+' : ''}${affinity.actualVersusComparableGoodPoints} pts`, detail: `versus comparable expectation · ${affinity.runCount} runs`, evidenceLevel: affinity.support.level, inspectUrl: '#all-press-performance' })
  const fastest = [...supported].filter((press) => press.changeover.durationSeconds.median !== null).sort((a, b) => a.changeover.durationSeconds.median! - b.changeover.durationSeconds.median!)[0]
  if (fastest) cards.push({ kind: 'stability', label: 'Fastest supported changeover', headline: fastest.displayName, value: `${Math.round(fastest.changeover.durationSeconds.median! / 60)} min`, detail: `median to Radius stable production · N=${fastest.changeover.transitionCount}`, evidenceLevel: fastest.support.level, inspectUrl: '#changeover-running' })
  const opportunity = [...supported].filter((press) => (press.recoverableOpportunitySeconds ?? 0) > 0).sort((a, b) => b.recoverableOpportunitySeconds! - a.recoverableOpportunitySeconds!)[0]
  if (opportunity) cards.push({ kind: 'largest_loss', label: 'Recoverable opportunity', headline: opportunity.displayName, value: `~${Math.round(opportunity.recoverableOpportunitySeconds! / 60)} min`, detail: 'historical excess versus supported fleet baseline', evidenceLevel: opportunity.support.level, inspectUrl: '#why-presses-differ' })
  const consistent = [...supported].filter((press) => press.variabilityPoints !== null).sort((a, b) => a.variabilityPoints! - b.variabilityPoints!)[0]
  if (consistent) cards.push({ kind: 'stability', label: 'Most consistent supported press', headline: consistent.displayName, value: `${consistent.variabilityPoints} pts`, detail: `middle-50% spread in run Good share · ${consistent.runCount} runs`, evidenceLevel: consistent.support.level, inspectUrl: '#changeover-running' })
  const sequence = matrix.find((cell) => (cell.support.level === 'strong' || cell.support.level === 'moderate') && cell.durationSeconds.median !== null)
  if (sequence) cards.push({ kind: 'sequence_risk', label: 'Sequence effect', headline: `${sequence.previousValue} → ${sequence.currentValue}`, value: `${Math.round(sequence.durationSeconds.median! / 60)} min`, detail: `${sequence.transitionCount} historical transitions`, evidenceLevel: sequence.support.level, inspectUrl: '#previous-job-effect' })
  if (!cards.length) cards.push({ kind: 'insufficient_evidence', label: 'Recommendation', headline: 'Insufficient evidence', value: `${presses.reduce((sum, press) => sum + press.runCount, 0)} runs`, detail: 'No fleet recommendation is declared from sparse support.', evidenceLevel: 'insufficient', inspectUrl: '#all-press-performance' })
  return cards.slice(0, 5)
}

function historicalSummary(run: ProductionRun): HistoricalRunSummary { const state = percentages([run]); return { runId: run.runId, pressKey: run.pressKey, startUtc: run.startUtc, endUtc: run.endUtc, identities: run.identities, previousIdentities: run.previousIdentities, transitionSeconds: run.transitionToStableProductionSeconds, goodPercent: state.goodPercent, makeReadyPercent: state.makeReadyPercent, badPercent: state.badPercent, unavailablePercent: state.unavailablePercent, interruptions: run.runningPerformance?.interruptions ?? run.productionInterruptionCount, medianSpeed: run.runningPerformance?.speed?.median ?? null, changedDeckCount: run.deckConfiguration?.changedDeckCount ?? null, confidence: run.identityConfidence, dataInterrupted: run.dataInterrupted } }

function sortedRuns(runs: ProductionRun[], sort: HistoricalRunSort) {
  const descending = (value: (run: ProductionRun) => number | null) => (left: ProductionRun, right: ProductionRun) => (value(right) ?? -Infinity) - (value(left) ?? -Infinity) || Date.parse(right.startUtc) - Date.parse(left.startUtc)
  const ascending = (value: (run: ProductionRun) => number | null) => (left: ProductionRun, right: ProductionRun) => (value(left) ?? Infinity) - (value(right) ?? Infinity) || Date.parse(right.startUtc) - Date.parse(left.startUtc)
  const comparator: Record<HistoricalRunSort, (left: ProductionRun, right: ProductionRun) => number> = {
    newest: (left, right) => Date.parse(right.startUtc) - Date.parse(left.startUtc),
    worst_good: ascending((run) => percentages([run]).goodPercent), longest_make_ready: descending((run) => run.makeReadySeconds), most_bad: descending((run) => run.badSeconds), longest_transition: descending((run) => run.transitionToStableProductionSeconds), most_interruptions: descending((run) => run.runningPerformance?.interruptions ?? run.productionInterruptionCount), highest_speed: descending((run) => run.runningPerformance?.speed?.median ?? null), lowest_speed: ascending((run) => run.runningPerformance?.speed?.median ?? null),
  }
  return [...runs].sort(comparator[sort])
}

export function buildFleetReport(input: { runs: ProductionRun[]; dimension: JobAnalysisDimension; group: JobGroupDefinition; refinements: JobRefinement[]; focusPressKey: RadiusPressKey | null; fromUtc: string; toUtc: string; algorithmVersion: string; historicalRunIds: Set<string>; liveRunIds: Set<string>; offset: number; limit: number; historicalRunSort?: HistoricalRunSort; coverage: FleetJobIntelligenceReport['coverage']; limitations?: string[] }): FleetJobIntelligenceReport {
  const selected = input.runs.filter((run) => matchesFleetSelection(run, input.dimension, input.group, input.refinements)); const affinity = buildPressAffinity(selected, input.dimension, input.group); const byPress = new Map<RadiusPressKey, ProductionRun[]>(); for (const run of selected) byPress.set(run.pressKey, [...(byPress.get(run.pressKey) ?? []), run]); const presses = [...byPress].map(([pressKey, runs]) => pressResult(pressKey, runs, affinity.find((row) => row.pressKey === pressKey), input.dimension)).sort((a, b) => (b.actualVersusComparableGoodPoints ?? -Infinity) - (a.actualVersusComparableGoodPoints ?? -Infinity) || b.goodPercent - a.goodPercent); const state = percentages(selected); const matrix = transitionMatrix(selected, input.dimension); const sort = input.historicalRunSort ?? 'newest'; const ordered = sortedRuns(selected, sort); const chronological = [...selected].sort((a, b) => Date.parse(b.startUtc) - Date.parse(a.startUtc)); const page = ordered.slice(input.offset, input.offset + input.limit); const observedHours = round(state.observed / 3600)
  const predecessorRanking = summarizeTransitions(selected, input.dimension).map((transition) => ({ ...transition, evidenceUrl: '#historical-runs', fingerprint: { ...transition.fingerprint, telemetryEvidenceUrl: '#run-inspector' }, radiusCauses: transition.radiusCauses.map((cause) => ({ ...cause, evidenceUrl: '#why-presses-differ' })) }))
  return { version: 'job-intelligence-fleet-v2', generatedAtUtc: new Date().toISOString(), algorithmVersion: input.algorithmVersion, fromUtc: input.fromUtc, toUtc: input.toUtc, analyzeBy: input.dimension, group: input.group, refinements: input.refinements, focusPressKey: input.focusPressKey, selection: { includedValues: [...new Set(selected.flatMap((run) => run.identities[input.dimension] ? [run.identities[input.dimension]!] : []))].sort(), matchingPresses: [...byPress.keys()].sort(), runCount: selected.length, observedHours, historyFromUtc: selected.length ? [...selected].sort((a, b) => Date.parse(a.startUtc) - Date.parse(b.startUtc))[0]!.startUtc : null, historyToUtc: selected.length ? chronological[0]!.endUtc : null, historicalRunCount: selected.filter((run) => input.historicalRunIds.has(run.runId)).length, liveTailRunCount: selected.filter((run) => input.liveRunIds.has(run.runId)).length }, fleetSummary: { matchingPressCount: byPress.size, runCount: selected.length, observedSeconds: state.observed, goodPercent: state.goodPercent, makeReadyPercent: state.makeReadyPercent, badPercent: state.badPercent, unavailablePercent: state.unavailablePercent, support: evidenceSupport(selected) }, decisions: decisionCards(presses, matrix), presses, radiusLossComparison: lossComparison(presses, selected), predecessorRanking, transitionMatrix: matrix, historicalRuns: { items: page.map(historicalSummary), total: selected.length, offset: input.offset, limit: input.limit, hasMore: input.offset + page.length < selected.length, sort }, coverage: input.coverage, limitations: input.limitations ?? [] }
}
