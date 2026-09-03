import type { RadiusPressKey } from './types/api'
import type { MachineIntelligenceCategoryTotals, MachineIntelligenceJobOccurrence, MachineIntelligencePressReport, MachineIntelligenceRadiusCategory, MachineIntelligenceRoll, MachineIntelligenceSegment } from './types/machine-intelligence'

export const MACHINE_INTELLIGENCE_PRESS_KEYS: RadiusPressKey[] = ['press3', 'press5', 'press6', 'press7', 'press8', 'press9', 'press10', 'press11', 'press12', 'press13', 'press14', 'press15']
export const MACHINE_INTELLIGENCE_MAX_RANGE_MS = 31 * 24 * 60 * 60_000
export const MACHINE_INTELLIGENCE_CHUNK_MS = 72 * 60 * 60_000

const emptyTotals = (): MachineIntelligenceCategoryTotals => ({ CHANGEOVER: 0, GOOD_RUN: 0, DOWNTIME: 0, MISSING_DATA: 0 })
const sameIdentity = (left: Pick<MachineIntelligenceJobOccurrence, 'order' | 'recipe'>, right: Pick<MachineIntelligenceJobOccurrence, 'order' | 'recipe'>) => left.order === right.order && left.recipe === right.recipe
const identityKey = (value: Pick<MachineIntelligenceJobOccurrence, 'order' | 'recipe'>) => `${value.order ?? ''}\u0000${value.recipe ?? ''}`

export function recipeFamily(recipe: string | null): string | null {
  if (!recipe) return null
  return recipe.replace(/-E[0-9A-Z]+$/i, '') || recipe
}

export function machineIntelligenceChunks(fromUtc: string, toUtc: string) {
  const from = Date.parse(fromUtc); const to = Date.parse(toUtc); const chunks: Array<{ fromUtc: string; toUtc: string }> = []
  for (let cursor = from; cursor < to; cursor += MACHINE_INTELLIGENCE_CHUNK_MS) chunks.push({ fromUtc: new Date(cursor).toISOString(), toUtc: new Date(Math.min(to, cursor + MACHINE_INTELLIGENCE_CHUNK_MS)).toISOString() })
  return chunks
}

function combineTotals(segments: MachineIntelligenceSegment[]) {
  return segments.reduce((result, segment) => { result[segment.category] += segment.durationSeconds; return result }, emptyTotals())
}

function combineRolls(rolls: MachineIntelligenceRoll[]) {
  const unique = [...new Map(rolls.map((roll) => [roll.rollId, roll])).values()]
  return unique.reduce((summary, roll) => {
    summary.total += 1
    if (roll.category === 'CHANGEOVER') { summary.changeover += 1; summary.changeoverLength += roll.length }
    else { summary.good += 1; summary.goodLength += roll.length }
    return summary
  }, { total: 0, good: 0, changeover: 0, goodLength: 0, changeoverLength: 0 })
}

function mergeOccurrences(reports: MachineIntelligencePressReport[]): MachineIntelligenceJobOccurrence[] {
  const ordered = reports.flatMap((report) => report.jobGroups.flatMap((group) => group.occurrences)).sort((left, right) => Date.parse(left.startUtc) - Date.parse(right.startUtc))
  const merged: MachineIntelligenceJobOccurrence[] = []
  for (const occurrence of ordered) {
    const previous = merged.at(-1)
    if (previous && previous.endUtc === occurrence.startUtc && sameIdentity(previous, occurrence)) {
      const segments = [...previous.segments, ...occurrence.segments]
      const rolls = [...new Map([...previous.rolls, ...occurrence.rolls].map((roll) => [roll.rollId, roll])).values()]
      previous.endUtc = occurrence.endUtc
      previous.durationSeconds += occurrence.durationSeconds
      previous.boundaryFields = [...new Set([...previous.boundaryFields, ...occurrence.boundaryFields])]
      previous.segments = segments
      previous.totals = combineTotals(segments)
      previous.rolls = rolls
      previous.rollSummary = combineRolls(rolls)
      continue
    }
    merged.push({ ...occurrence, segments: [...occurrence.segments], rolls: [...occurrence.rolls], boundaryFields: [...occurrence.boundaryFields] })
  }
  const occurrenceCount = new Map<string, number>()
  return merged.map((occurrence) => {
    const key = identityKey(occurrence); const next = (occurrenceCount.get(key) ?? 0) + 1; occurrenceCount.set(key, next)
    return { ...occurrence, occurrenceNumber: next }
  })
}

function mergeAdjacent<T extends { startUtc: string; endUtc: string; durationSeconds: number }>(values: T[], matches: (left: T, right: T) => boolean): T[] {
  const result: T[] = []
  for (const source of [...values].sort((left, right) => Date.parse(left.startUtc) - Date.parse(right.startUtc))) {
    const value = { ...source }; const previous = result.at(-1)
    if (previous && previous.endUtc === value.startUtc && matches(previous, value)) {
      previous.endUtc = value.endUtc; previous.durationSeconds += value.durationSeconds
    } else result.push(value)
  }
  return result
}

export function mergeMachineIntelligenceReports(reports: MachineIntelligencePressReport[]): MachineIntelligencePressReport {
  if (!reports.length) throw new Error('machine_intelligence_report_missing')
  const ordered = [...reports].sort((left, right) => Date.parse(left.fromUtc) - Date.parse(right.fromUtc)); const first = ordered[0]!; const last = ordered.at(-1)!
  const occurrences = mergeOccurrences(ordered)
  const grouped = new Map<string, MachineIntelligenceJobOccurrence[]>()
  for (const occurrence of occurrences) grouped.set(identityKey(occurrence), [...(grouped.get(identityKey(occurrence)) ?? []), occurrence])
  const jobGroups = [...grouped].map(([key, items]) => {
    const segments = items.flatMap((item) => item.segments); const rolls = items.flatMap((item) => item.rolls)
    return { groupId: `machine-intelligence.group.${first.pressKey}.${encodeURIComponent(key)}`, order: items[0]!.order, recipe: items[0]!.recipe, identityComplete: items[0]!.identityComplete, occurrenceCount: items.length, firstStartUtc: items[0]!.startUtc, lastEndUtc: items.at(-1)!.endUtc, totals: combineTotals(segments), rollSummary: combineRolls(rolls), rolls, occurrences: items }
  }).sort((left, right) => Date.parse(left.firstStartUtc) - Date.parse(right.firstStartUtc))
  const classificationTimeline = mergeAdjacent(ordered.flatMap((report) => report.classificationTimeline), (left, right) => left.category === right.category && left.source === right.source && left.underlyingState === right.underlyingState)
  const identityTimeline = mergeAdjacent(ordered.flatMap((report) => report.identityTimeline), (left, right) => left.order === right.order && left.recipe === right.recipe && left.missingFields.join() === right.missingFields.join())
  const radiusTimeline = mergeAdjacent(ordered.flatMap((report) => report.radiusTimeline), (left, right) => left.category === right.category && left.eventType === right.eventType && left.statusCode === right.statusCode && left.statusDescription === right.statusDescription)
  const radiusTotals = radiusTimeline.reduce<Record<MachineIntelligenceRadiusCategory, number>>((result, segment) => { result[segment.category] += segment.durationSeconds; return result }, { G: 0, B: 0, M: 0, MISSING_DATA: 0 })
  const allRolls = jobGroups.flatMap((group) => group.rolls); const totals = combineTotals(classificationTimeline); const rangeSeconds = (Date.parse(last.toUtc) - Date.parse(first.fromUtc)) / 1000
  const availability = totals.MISSING_DATA >= rangeSeconds - .1 ? 'UNAVAILABLE' : totals.MISSING_DATA > 0 ? 'PARTIAL' : 'AVAILABLE'
  const speed = [...new Map(ordered.flatMap((report) => report.speedTrend.observations).map((item) => [`${item.atUtc}\u0000${item.value}`, item])).values()].sort((left, right) => Date.parse(left.atUtc) - Date.parse(right.atUtc))
  return { ...first, generatedAtUtc: last.generatedAtUtc, fromUtc: first.fromUtc, toUtc: last.toUtc, availability, reason: availability === 'UNAVAILABLE' ? 'No trustworthy Process Intelligence evidence was available in this range.' : availability === 'PARTIAL' ? 'Missing Data is excluded from production and loss comparisons.' : null, totals, classificationTimeline, speedTrend: { unit: ordered.find((report) => report.speedTrend.unit)?.speedTrend.unit ?? null, observations: speed }, identityTimeline, radiusTimeline, radiusTotals, rollSummary: combineRolls(allRolls), jobGroups }
}

export function machineOpportunitySeconds(report: MachineIntelligencePressReport) {
  return report.totals.CHANGEOVER + report.totals.DOWNTIME
}
