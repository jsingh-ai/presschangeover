import { createHash } from 'node:crypto'
import type { ClassificationSnapshot } from '../classification/models.js'
import { buildActivityCatalog } from './activity-analysis.js'
import { buildOperationalRuns } from './operational-runs.js'
import type {
  ActivityCatalogItem,
  ActivitySelection,
  OperationalRun,
  OperationalRunSegment,
  PatternAnalysis,
  PatternMatchMode,
  PatternSummary,
  RadiusOverview,
  RunPatternEvidence,
} from './models.js'

export const PATTERN_EVIDENCE_LIMIT = 200
export const PATTERN_DISPLAY_LIMIT = 20
const SHORT_KEY = 'SHORT_RUN_PRODUCTION'
const SHORT_LABEL = 'Run Production (short attempt)'

function median(values: number[]): number | null {
  if (!values.length) return null
  const ordered = [...values].sort((a, b) => a - b)
  const middle = Math.floor(ordered.length / 2)
  return ordered.length % 2 ? ordered[middle]! : (ordered[middle - 1]! + ordered[middle]!) / 2
}

function percent(value: number, total: number): number { return total > 0 ? value / total * 100 : 0 }

function token(segment: OperationalRunSegment, family = false): { key: string; label: string } | null {
  if (segment.isUnavailable) return null
  if (segment.isShortRunAttempt) return { key: SHORT_KEY, label: SHORT_LABEL }
  if (family) return { key: segment.processFamilyKey ?? 'NEEDS_CLASSIFICATION', label: segment.processFamilyName ?? 'Needs Classification' }
  return { key: segment.operationalGroupKey ?? 'NEEDS_CLASSIFICATION', label: segment.operationalGroupName ?? 'Needs Classification' }
}

function normalizedSequence(run: OperationalRun, family = false) {
  const result: Array<{ key: string; label: string }> = []
  for (const segment of run.segments) {
    const next = token(segment, family)
    if (!next || result.at(-1)?.key === next.key) continue
    result.push(next)
  }
  return result
}

function stablePatternKey(classificationVersion: number, keys: string[]) {
  return `v${classificationVersion}-${createHash('sha256').update(`${classificationVersion}\u001f${keys.join('\u001e')}`).digest('hex').slice(0, 16)}`
}

function hasReentry(keys: string[]) {
  return keys.some((key, index) => keys.indexOf(key) < index - 1)
}

function runEvidence(run: OperationalRun, conditionDurations: Array<{ conditionKey: string; durationSeconds: number }> = [], selectedActivitySeconds = 0): RunPatternEvidence {
  const groups = normalizedSequence(run)
  const families = normalizedSequence(run, true)
  return {
    runId: run.runId, pressKey: run.pressKey, displayName: run.displayName, startUtc: run.startUtc, endUtc: run.endUtc,
    totalDurationSeconds: run.totalDurationSeconds, timeToProductionSeconds: run.timeToProductionSeconds,
    productionDurationSeconds: run.productionDurationSeconds, shortRunAttemptCount: run.shortRunAttemptCount,
    transitionCount: run.transitionCount, isPartial: run.isPartial, dataInterrupted: run.dataInterrupted,
    eligible: run.eligibleForBenchmark, groupSequence: groups.map(({ label }) => label), familySequence: families.map(({ label }) => label),
    selectedActivitySeconds, conditionDurations,
  }
}

function matchSegment(segment: OperationalRunSegment, condition: ActivitySelection) {
  if (segment.isUnavailable) return false
  if (condition.level === 'radius_state') return segment.eventType === condition.key
  if (condition.level === 'operational_group') return segment.operationalGroupKey === condition.key
  if (condition.level === 'process_family') return segment.processFamilyKey === condition.key && (!condition.operationalGroupKey || segment.operationalGroupKey === condition.operationalGroupKey)
  return segment.exactIdentity === condition.key
}

function sameSelection(left: ActivitySelection, right: ActivitySelection) {
  return left.level === right.level && left.key === right.key
    && (left.level !== 'process_family' || !right.operationalGroupKey || left.operationalGroupKey === right.operationalGroupKey)
}

function conditionKey(condition: ActivitySelection) {
  return `${condition.level}:${condition.level === 'process_family' ? `${condition.operationalGroupKey ?? ''}:` : ''}${condition.key}`
}

function dedupeRedundant(conditions: ActivityCatalogItem[], mode: PatternMatchMode) {
  if (mode !== 'contains_all') return { effective: conditions, message: null }
  const redundantGroups = new Set<string>()
  for (const family of conditions.filter(({ level }) => level === 'process_family')) {
    if (family.operationalGroupKey && conditions.some(({ level, key }) => level === 'operational_group' && key === family.operationalGroupKey)) redundantGroups.add(family.operationalGroupKey)
  }
  if (!redundantGroups.size) return { effective: conditions, message: null }
  const labels = conditions.filter(({ level, key }) => level === 'operational_group' && redundantGroups.has(key)).map(({ label }) => label)
  return { effective: conditions.filter(({ level, key }) => level !== 'operational_group' || !redundantGroups.has(key)), message: `${labels.join(', ')} is already implied by the selected child process family and was not counted as a separate constraint.` }
}

function matchesConditions(run: OperationalRun, conditions: ActivityCatalogItem[], mode: PatternMatchMode) {
  if (!conditions.length) return false
  if (mode === 'contains_all') return conditions.every((condition) => run.segments.some((segment) => matchSegment(segment, condition)))
  let position = -1
  for (const condition of conditions) {
    position = run.segments.findIndex((segment, index) => index > position && matchSegment(segment, condition))
    if (position < 0) return false
  }
  return true
}

function durationsFor(run: OperationalRun, conditions: ActivityCatalogItem[]) {
  const conditionDurations = conditions.map((condition) => ({ conditionKey: conditionKey(condition), durationSeconds: run.segments.filter((segment) => matchSegment(segment, condition)).reduce((sum, segment) => sum + segment.durationSeconds, 0) }))
  const selectedActivitySeconds = run.segments.filter((segment) => conditions.some((condition) => matchSegment(segment, condition))).reduce((sum, segment) => sum + segment.durationSeconds, 0)
  return { conditionDurations, selectedActivitySeconds }
}

function summarizePatterns(runs: OperationalRun[], eligibleRuns: OperationalRun[], classificationVersion: number): PatternSummary[] {
  const eligibleByPress = new Map<string, number>()
  for (const run of eligibleRuns) eligibleByPress.set(run.pressKey, (eligibleByPress.get(run.pressKey) ?? 0) + 1)
  const groups = new Map<string, { keys: string[]; labels: string[]; runs: OperationalRun[] }>()
  for (const run of eligibleRuns) {
    const sequence = normalizedSequence(run)
    const keys = sequence.map(({ key }) => key)
    const key = stablePatternKey(classificationVersion, keys)
    const value = groups.get(key) ?? { keys, labels: sequence.map(({ label }) => label), runs: [] }
    value.runs.push(run); groups.set(key, value)
  }
  return [...groups.entries()].map(([patternKey, value]) => {
    const byPress = new Map<string, OperationalRun[]>()
    for (const run of value.runs) { const list = byPress.get(run.pressKey) ?? []; list.push(run); byPress.set(run.pressKey, list) }
    const variations = new Map<string, { keys: string[]; labels: string[]; count: number }>()
    for (const run of value.runs) {
      const sequence = normalizedSequence(run, true); const key = sequence.map(({ key }) => key).join('\u001e')
      const variation = variations.get(key) ?? { keys: sequence.map(({ key }) => key), labels: sequence.map(({ label }) => label), count: 0 }
      variation.count += 1; variations.set(key, variation)
    }
    return {
      patternKey, classificationVersion, orderedGroupKeys: value.keys, orderedGroupLabels: value.labels,
      runCount: value.runs.length, runSharePercent: percent(value.runs.length, eligibleRuns.length),
      pressesObserved: byPress.size, medianTimeToProductionSeconds: median(value.runs.flatMap(({ timeToProductionSeconds }) => timeToProductionSeconds === null ? [] : [timeToProductionSeconds])),
      medianPreProductionSeconds: median(value.runs.flatMap(({ timeToProductionSeconds }) => timeToProductionSeconds === null ? [] : [timeToProductionSeconds])),
      medianProductionSeconds: median(value.runs.map(({ productionDurationSeconds }) => productionDurationSeconds)),
      shortAttemptRunCount: value.runs.filter(({ shortRunAttemptCount }) => shortRunAttemptCount > 0).length,
      matchedRunIds: value.runs.map(({ runId }) => runId), containsReentry: hasReentry(value.keys),
      pressStats: [...byPress.entries()].map(([pressKey, pressRuns]) => ({ pressKey: pressKey as OperationalRun['pressKey'], displayName: pressRuns[0]!.displayName, matchedRuns: pressRuns.length, eligibleRuns: eligibleByPress.get(pressKey) ?? 0, matchRatePercent: percent(pressRuns.length, eligibleByPress.get(pressKey) ?? 0), medianTimeToProductionSeconds: median(pressRuns.flatMap(({ timeToProductionSeconds }) => timeToProductionSeconds === null ? [] : [timeToProductionSeconds])) })).sort((a, b) => b.matchRatePercent - a.matchRatePercent || b.matchedRuns - a.matchedRuns || a.displayName.localeCompare(b.displayName, undefined, { numeric: true })),
      familyVariations: [...variations.values()].map((variation) => ({ orderedFamilyKeys: variation.keys, orderedFamilyLabels: variation.labels, runCount: variation.count, runShareWithinPatternPercent: percent(variation.count, value.runs.length) })).sort((a, b) => b.runCount - a.runCount || a.orderedFamilyLabels.join('>').localeCompare(b.orderedFamilyLabels.join('>'))),
    }
  }).sort((a, b) => b.runCount - a.runCount || a.patternKey.localeCompare(b.patternKey))
}

export function analyzeRunPatterns(overview: RadiusOverview, snapshot: ClassificationSnapshot, input?: { selectedPatternKey?: string; conditions?: ActivitySelection[]; matchMode?: PatternMatchMode }): PatternAnalysis {
  const catalog = buildActivityCatalog(overview, snapshot)
  const runs = overview.presses.flatMap((press) => buildOperationalRuns({ pressKey: press.pressKey, displayName: press.displayName, segments: press.timelineSegments }, overview.fromUtc, overview.toUtc).map(({ run }) => run))
  const eligible = runs.filter(({ eligibleForBenchmark }) => eligibleForBenchmark)
  const allPatterns = summarizePatterns(runs, eligible, snapshot.version)
  const selectedPattern = allPatterns.find(({ patternKey }) => patternKey === input?.selectedPatternKey) ?? allPatterns[0] ?? null
  const selectedRuns = selectedPattern ? runs.filter(({ runId }) => selectedPattern.matchedRunIds.includes(runId)) : []
  const requestedConditions = (input?.conditions ?? []).flatMap((condition) => {
    const item = catalog.find((candidate) => sameSelection(candidate, condition))
    return item ? [item] : []
  })
  const matchMode = input?.matchMode ?? 'contains_all'
  const redundancy = dedupeRedundant(requestedConditions, matchMode)
  const builderRuns = redundancy.effective.length ? eligible.filter((run) => matchesConditions(run, redundancy.effective, matchMode)) : []
  const builderEvidence = builderRuns.map((run) => ({ run, ...durationsFor(run, requestedConditions) }))
  const eligibleByPress = new Map<string, number>()
  for (const run of eligible) eligibleByPress.set(run.pressKey, (eligibleByPress.get(run.pressKey) ?? 0) + 1)
  const builderByPress = new Map<string, typeof builderEvidence>()
  for (const item of builderEvidence) { const list = builderByPress.get(item.run.pressKey) ?? []; list.push(item); builderByPress.set(item.run.pressKey, list) }
  const topBuilderPatterns = new Map<string, { patternKey: string; labels: string[]; count: number }>()
  for (const item of builderEvidence) { const pattern = allPatterns.find(({ matchedRunIds }) => matchedRunIds.includes(item.run.runId)); if (!pattern) continue; const current = topBuilderPatterns.get(pattern.patternKey) ?? { patternKey: pattern.patternKey, labels: pattern.orderedGroupLabels, count: 0 }; current.count += 1; topBuilderPatterns.set(pattern.patternKey, current) }
  const builder = requestedConditions.length ? {
    conditions: requestedConditions, matchMode, redundantConditionMessage: redundancy.message,
    matchedRuns: builderRuns.length, matchSharePercent: percent(builderRuns.length, eligible.length), pressesObserved: builderByPress.size,
    medianTimeToProductionSeconds: median(builderRuns.flatMap(({ timeToProductionSeconds }) => timeToProductionSeconds === null ? [] : [timeToProductionSeconds])),
    medianSelectedActivitySeconds: median(builderEvidence.map(({ selectedActivitySeconds }) => selectedActivitySeconds)),
    totalSelectedActivitySeconds: builderEvidence.reduce((sum, { selectedActivitySeconds }) => sum + selectedActivitySeconds, 0),
    pressStats: [...builderByPress.entries()].map(([pressKey, values]) => ({ pressKey: pressKey as OperationalRun['pressKey'], displayName: values[0]!.run.displayName, matchedRuns: values.length, eligibleRuns: eligibleByPress.get(pressKey) ?? 0, matchRatePercent: percent(values.length, eligibleByPress.get(pressKey) ?? 0), selectedActivitySeconds: values.reduce((sum, { selectedActivitySeconds }) => sum + selectedActivitySeconds, 0), medianTimeToProductionSeconds: median(values.flatMap(({ run }) => run.timeToProductionSeconds === null ? [] : [run.timeToProductionSeconds])) })).sort((a, b) => b.matchRatePercent - a.matchRatePercent || b.matchedRuns - a.matchedRuns),
    topPatterns: [...topBuilderPatterns.values()].map((value) => ({ patternKey: value.patternKey, labels: value.labels, runCount: value.count, percentageOfMatches: percent(value.count, builderRuns.length) })).sort((a, b) => b.runCount - a.runCount || a.patternKey.localeCompare(b.patternKey)).slice(0, 10),
  } : null
  const evidenceSource = builder ? builderEvidence.map(({ run, conditionDurations, selectedActivitySeconds }) => runEvidence(run, conditionDurations, selectedActivitySeconds)) : selectedRuns.map((run) => runEvidence(run))
  return {
    fromUtc: overview.fromUtc, toUtc: overview.toUtc, classificationVersion: snapshot.version, catalog,
    totalRuns: runs.length, eligibleRuns: eligible.length,
    excludedPartialRuns: runs.filter(({ isPartial, dataInterrupted }) => isPartial && !dataInterrupted).length,
    excludedInterruptedRuns: runs.filter(({ dataInterrupted }) => dataInterrupted).length,
    excludedOpenRuns: runs.filter(({ productionStartUtc, dataInterrupted }) => productionStartUtc === null && !dataInterrupted).length,
    uniquePatternCount: allPatterns.length, shortAttemptRuns: eligible.filter(({ shortRunAttemptCount }) => shortRunAttemptCount > 0).length,
    patterns: allPatterns.slice(0, PATTERN_DISPLAY_LIMIT), selectedPattern,
    matchedRuns: evidenceSource.slice(0, PATTERN_EVIDENCE_LIMIT), evidenceLimit: PATTERN_EVIDENCE_LIMIT, builder,
  }
}
