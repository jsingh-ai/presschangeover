import { createHash } from 'node:crypto'
import { percentile } from './episode-analysis.js'
import type {
  AnalyticsEvidenceInterval,
  AnalyticsStatusRef,
  MakeReadyPatternSummary,
  OperationalAnalytics,
  OperationalEpisode,
  OperationalPathSummary,
  OperationalPatternAnomaly,
  OperationalPatternSummary,
  OperationalRelationshipGroup,
  OperationalRelationshipOutcome,
  OperationalStatusDriver,
  RadiusPressKey,
  RadiusStateSegment,
  RadiusStatusSegment,
} from './models.js'
import { exactRadiusIdentity } from './radius-identity.js'

const EVIDENCE_LIMIT = 8
const LOW_SUPPORT_THRESHOLD = 10
const PERCENTILE_SAMPLE = 5
const DISCLAIMER = 'Radius reflects operator-entered operational annotations. It supports deterministic comparison but does not by itself prove physical machine behavior or root cause.'

export interface OperationalAnalyticsPressInput {
  pressKey: RadiusPressKey
  displayName: string
  segments: RadiusStatusSegment[]
  episodes: OperationalEpisode[]
}

interface NormalizedPress {
  pressKey: RadiusPressKey
  displayName: string
  segments: RadiusStatusSegment[]
  episodes: OperationalEpisode[]
}

interface Occurrence {
  segment: RadiusStateSegment
  status: AnalyticsStatusRef
  pressKey: RadiusPressKey
  displayName: string
  startUtc: string
  endUtc: string
  durationSeconds: number
  leftCensored: boolean
  rightCensored: boolean
  previousStatus: AnalyticsStatusRef | null
  nextStatus: AnalyticsStatusRef | null
}

function round(value: number): number {
  return Math.round(value * 10) / 10
}

function percentage(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : round((numerator / denominator) * 100)
}

function category(eventType: string): string {
  if (eventType === 'G') return 'Good'
  if (eventType === 'M') return 'Make Ready'
  if (eventType === 'B') return 'Bad'
  if (eventType === 'S') return 'Radius S state'
  return `Other (${eventType || 'Unclassified'})`
}

function statusRef(segment: RadiusStateSegment): AnalyticsStatusRef {
  return {
    identity: exactRadiusIdentity(segment),
    eventType: segment.eventType,
    category: category(segment.eventType),
    statusCode: segment.statusCode,
    statusDescription: segment.statusDescription,
  }
}

function sameSegmentState(left: RadiusStatusSegment, right: RadiusStatusSegment): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === 'offline' || right.kind === 'offline') return left.kind === right.kind
  return statusRef(left).identity === statusRef(right).identity && left.isProduction === right.isProduction
}

function normalizePress(input: OperationalAnalyticsPressInput): NormalizedPress {
  const ordered = [...input.segments].sort((left, right) => Date.parse(left.startUtc) - Date.parse(right.startUtc))
  const segments: RadiusStatusSegment[] = []
  for (const segment of ordered) {
    const previous = segments.at(-1)
    if (previous && previous.endUtc === segment.startUtc && sameSegmentState(previous, segment)) {
      previous.endUtc = segment.endUtc
      previous.durationSeconds = Math.max(0, (Date.parse(previous.endUtc) - Date.parse(previous.startUtc)) / 1_000)
      previous.isOpen = segment.isOpen
      if (previous.sourceGeneration !== segment.sourceGeneration) previous.sourceGeneration = 'hybrid'
    } else {
      segments.push({ ...segment })
    }
  }
  return { ...input, segments }
}

function radiusNeighbor(segments: RadiusStatusSegment[], index: number, direction: -1 | 1): RadiusStateSegment | undefined {
  const candidate = segments[index + direction]
  return candidate?.kind === 'radius' ? candidate : undefined
}

function occurrencesForPress(press: NormalizedPress, fromUtc: string, toUtc: string): Occurrence[] {
  const fromMs = Date.parse(fromUtc)
  const toMs = Date.parse(toUtc)
  let accountedUntil = fromMs
  return press.segments.flatMap((segment, index) => {
    if (segment.kind !== 'radius') return []
    const originalStart = Date.parse(segment.startUtc)
    const originalEnd = Date.parse(segment.endUtc)
    const startMs = Math.max(fromMs, originalStart, accountedUntil)
    const endMs = Math.min(toMs, originalEnd)
    if (endMs <= startMs) return []
    accountedUntil = endMs
    return [{
      segment,
      status: statusRef(segment),
      pressKey: press.pressKey,
      displayName: press.displayName,
      startUtc: new Date(startMs).toISOString(),
      endUtc: new Date(endMs).toISOString(),
      durationSeconds: (endMs - startMs) / 1_000,
      leftCensored: originalStart < fromMs,
      rightCensored: originalEnd > toMs || segment.isOpen,
      previousStatus: radiusNeighbor(press.segments, index, -1) ? statusRef(radiusNeighbor(press.segments, index, -1)!) : null,
      nextStatus: radiusNeighbor(press.segments, index, 1) ? statusRef(radiusNeighbor(press.segments, index, 1)!) : null,
    }]
  })
}

function evidence(occurrence: Occurrence): AnalyticsEvidenceInterval {
  return {
    pressKey: occurrence.pressKey,
    displayName: occurrence.displayName,
    startUtc: occurrence.startUtc,
    endUtc: occurrence.endUtc,
    durationSeconds: occurrence.durationSeconds,
    leftCensored: occurrence.leftCensored,
    rightCensored: occurrence.rightCensored,
    previousStatus: occurrence.previousStatus,
    nextStatus: occurrence.nextStatus,
  }
}

function relationshipGroups(presses: NormalizedPress[], fromUtc: string, toUtc: string): OperationalRelationshipGroup[] {
  const fromMs = Date.parse(fromUtc)
  const toMs = Date.parse(toUtc)
  const groups = new Map<string, {
    anchor: AnalyticsStatusRef
    direction: 'after' | 'before'
    maxTransitions: 1 | 2 | 3
    denominator: number
    censoredCount: number
    outcomes: Map<string, { target: AnalyticsStatusRef; count: number; lags: number[]; presses: Set<RadiusPressKey>; evidence: AnalyticsEvidenceInterval[] }>
  }>()

  for (const press of presses) {
    for (let index = 0; index < press.segments.length; index += 1) {
      const segment = press.segments[index]
      if (segment.kind !== 'radius') continue
      const startMs = Date.parse(segment.startUtc)
      if (startMs < fromMs || startMs >= toMs) continue
      const anchor = statusRef(segment)
      for (const direction of ['after', 'before'] as const) {
        const step = direction === 'after' ? 1 : -1
        for (const maxTransitions of [1, 2, 3] as const) {
          const key = `${anchor.identity}\u001e${direction}\u001e${maxTransitions}`
          const group = groups.get(key) ?? { anchor, direction, maxTransitions, denominator: 0, censoredCount: 0, outcomes: new Map() }
          const candidates: RadiusStateSegment[] = []
          for (let distance = 1; distance <= maxTransitions; distance += 1) {
            const candidate = press.segments[index + step * distance]
            if (!candidate || candidate.kind === 'offline') break
            const candidateStart = Date.parse(candidate.startUtc)
            if (candidateStart < fromMs || candidateStart >= toMs) break
            candidates.push(candidate)
          }
          if (candidates.length === 0) {
            group.censoredCount += 1
          } else {
            group.denominator += 1
            const seen = new Set<string>()
            for (const candidate of candidates) {
              const target = statusRef(candidate)
              if (seen.has(target.identity)) continue
              seen.add(target.identity)
              const value = group.outcomes.get(target.identity) ?? { target, count: 0, lags: [], presses: new Set(), evidence: [] }
              value.count += 1
              value.presses.add(press.pressKey)
              value.lags.push(direction === 'after'
                ? Math.max(0, (Date.parse(candidate.startUtc) - Date.parse(segment.endUtc)) / 1_000)
                : Math.max(0, (Date.parse(segment.startUtc) - Date.parse(candidate.endUtc)) / 1_000))
              if (value.evidence.length < EVIDENCE_LIMIT) {
                value.evidence.push({
                  pressKey: press.pressKey,
                  displayName: press.displayName,
                  startUtc: segment.startUtc,
                  endUtc: segment.endUtc,
                  durationSeconds: segment.durationSeconds,
                  leftCensored: false,
                  rightCensored: false,
                  previousStatus: direction === 'before' ? target : radiusNeighbor(press.segments, index, -1) ? statusRef(radiusNeighbor(press.segments, index, -1)!) : null,
                  nextStatus: direction === 'after' ? target : radiusNeighbor(press.segments, index, 1) ? statusRef(radiusNeighbor(press.segments, index, 1)!) : null,
                })
              }
              group.outcomes.set(target.identity, value)
            }
          }
          groups.set(key, group)
        }
      }
    }
  }

  return [...groups.values()].map((group) => ({
    anchor: group.anchor,
    direction: group.direction,
    maxTransitions: group.maxTransitions,
    denominator: group.denominator,
    censoredCount: group.censoredCount,
    outcomes: [...group.outcomes.values()].map((outcome) => ({
      target: outcome.target,
      numerator: outcome.count,
      denominator: group.denominator,
      percentage: percentage(outcome.count, group.denominator),
      pressCount: outcome.presses.size,
      medianLagSeconds: percentile(outcome.lags, 0.5) ?? 0,
      p90LagSeconds: outcome.lags.length >= PERCENTILE_SAMPLE ? percentile(outcome.lags, 0.9) : null,
      lowSupport: group.denominator < LOW_SUPPORT_THRESHOLD,
      evidence: outcome.evidence,
    })).sort((left, right) => right.numerator - left.numerator || left.target.statusDescription.localeCompare(right.target.statusDescription)),
  })).sort((left, right) => left.anchor.statusDescription.localeCompare(right.anchor.statusDescription) || left.direction.localeCompare(right.direction) || left.maxTransitions - right.maxTransitions)
}

function outcomeSummaries(
  entries: Array<{ target: AnalyticsStatusRef; lag: number; pressKey: RadiusPressKey; evidence: AnalyticsEvidenceInterval }>,
  denominator: number,
): OperationalRelationshipOutcome[] {
  const groups = new Map<string, typeof entries>()
  for (const entry of entries) groups.set(entry.target.identity, [...(groups.get(entry.target.identity) ?? []), entry])
  return [...groups.values()].map((group) => ({
    target: group[0].target,
    numerator: group.length,
    denominator,
    percentage: percentage(group.length, denominator),
    pressCount: new Set(group.map(({ pressKey }) => pressKey)).size,
    medianLagSeconds: percentile(group.map(({ lag }) => lag), 0.5) ?? 0,
    p90LagSeconds: group.length >= PERCENTILE_SAMPLE ? percentile(group.map(({ lag }) => lag), 0.9) : null,
    lowSupport: denominator < LOW_SUPPORT_THRESHOLD,
    evidence: group.slice(0, EVIDENCE_LIMIT).map((entry) => entry.evidence),
  })).sort((left, right) => right.numerator - left.numerator || left.target.statusDescription.localeCompare(right.target.statusDescription))
}

function pathSummaries(entries: Array<{ states: AnalyticsStatusRef[]; elapsed: number; pressKey: RadiusPressKey }>, denominator: number): OperationalPathSummary[] {
  const groups = new Map<string, typeof entries>()
  for (const entry of entries) {
    const key = entry.states.map(({ identity }) => identity).join('\u001e')
    groups.set(key, [...(groups.get(key) ?? []), entry])
  }
  return [...groups.values()].map((group) => ({
    states: group[0].states,
    count: group.length,
    denominator,
    percentage: percentage(group.length, denominator),
    pressCount: new Set(group.map(({ pressKey }) => pressKey)).size,
    medianElapsedSeconds: percentile(group.map(({ elapsed }) => elapsed), 0.5) ?? 0,
    p90ElapsedSeconds: group.length >= PERCENTILE_SAMPLE ? percentile(group.map(({ elapsed }) => elapsed), 0.9) : null,
    lowSupport: denominator < LOW_SUPPORT_THRESHOLD,
  })).sort((left, right) => right.count - left.count).slice(0, 8)
}

function productionStopPatterns(presses: NormalizedPress[], fromUtc: string, toUtc: string): OperationalPatternSummary {
  const fromMs = Date.parse(fromUtc)
  const toMs = Date.parse(toUtc)
  let anchorCount = 0
  let censoredCount = 0
  const outcomes: Parameters<typeof outcomeSummaries>[0] = []
  const paths: Parameters<typeof pathSummaries>[0] = []
  for (const press of presses) {
    for (let index = 0; index < press.segments.length; index += 1) {
      const source = press.segments[index]
      if (source.kind !== 'radius' || !source.isProduction) continue
      const stopMs = Date.parse(source.endUtc)
      if (stopMs < fromMs || stopMs >= toMs) continue
      anchorCount += 1
      const next = press.segments[index + 1]
      if (!next || next.kind === 'offline' || next.isProduction || Date.parse(next.startUtc) >= toMs) {
        censoredCount += 1
        continue
      }
      const nextStatus = statusRef(next)
      outcomes.push({ target: nextStatus, lag: Math.max(0, (Date.parse(next.startUtc) - stopMs) / 1_000), pressKey: press.pressKey, evidence: {
        pressKey: press.pressKey, displayName: press.displayName, startUtc: next.startUtc, endUtc: next.endUtc,
        durationSeconds: next.durationSeconds, leftCensored: false, rightCensored: false,
        previousStatus: statusRef(source), nextStatus: radiusNeighbor(press.segments, index + 1, 1) ? statusRef(radiusNeighbor(press.segments, index + 1, 1)!) : null,
      } })
      const path: AnalyticsStatusRef[] = []
      let pathEnd = Date.parse(next.startUtc)
      for (let cursor = index + 1; cursor < press.segments.length && path.length < 3; cursor += 1) {
        const segment = press.segments[cursor]
        if (segment.kind === 'offline' || Date.parse(segment.startUtc) >= toMs) break
        path.push(statusRef(segment))
        pathEnd = Date.parse(segment.startUtc)
        if (segment.isProduction) break
      }
      paths.push({ states: path, elapsed: Math.max(0, (pathEnd - stopMs) / 1_000), pressKey: press.pressKey })
    }
  }
  return { anchorCount, resolvedCount: outcomes.length, censoredCount, outcomes: outcomeSummaries(outcomes, outcomes.length), paths: pathSummaries(paths, paths.length) }
}

function beforeSuccessfulPatterns(presses: NormalizedPress[], fromUtc: string, toUtc: string): OperationalPatternSummary {
  const fromMs = Date.parse(fromUtc)
  const toMs = Date.parse(toUtc)
  let anchorCount = 0
  let censoredCount = 0
  const outcomes: Parameters<typeof outcomeSummaries>[0] = []
  const paths: Parameters<typeof pathSummaries>[0] = []
  for (const press of presses) {
    for (const episode of press.episodes) {
      if (episode.completionStatus !== 'CONFIRMED_PRODUCTION' || !episode.confirmedProductionStartUtc) continue
      const confirmationMs = Date.parse(episode.confirmedProductionStartUtc)
      if (confirmationMs < fromMs || confirmationMs >= toMs) continue
      anchorCount += 1
      const nonProduction = episode.statusSegments.filter(({ isProduction }) => !isProduction)
      const previous = nonProduction.at(-1)
      if (!previous) {
        censoredCount += 1
        continue
      }
      const target = statusRef(previous)
      outcomes.push({ target, lag: previous.durationSeconds, pressKey: press.pressKey, evidence: {
        pressKey: press.pressKey, displayName: press.displayName, startUtc: previous.startUtc, endUtc: previous.endUtc,
        durationSeconds: previous.durationSeconds, leftCensored: episode.startedBeforeRange, rightCensored: false,
        previousStatus: nonProduction.at(-2) ? statusRef(nonProduction.at(-2)!) : null,
        nextStatus: episode.statusSegments.at(-1) ? statusRef(episode.statusSegments.at(-1)!) : null,
      } })
      const states = nonProduction.slice(-3).map(statusRef)
      if (episode.statusSegments.at(-1)) states.push(statusRef(episode.statusSegments.at(-1)!))
      paths.push({ states, elapsed: previous.durationSeconds, pressKey: press.pressKey })
    }
  }
  return { anchorCount, resolvedCount: outcomes.length, censoredCount, outcomes: outcomeSummaries(outcomes, outcomes.length), paths: pathSummaries(paths, paths.length) }
}

function makeReadyPatterns(presses: NormalizedPress[], fromUtc: string, toUtc: string): MakeReadyPatternSummary {
  const fromMs = Date.parse(fromUtc)
  const toMs = Date.parse(toUtc)
  let anchorCount = 0
  let censoredCount = 0
  let confirmedProductionCount = 0
  let returnedToMakeReadyCount = 0
  let enteredBadCount = 0
  let enteredSafetyCount = 0
  let failedToReachConfirmedProductionCount = 0
  let unresolvedCount = 0
  const confirmedLags: number[] = []
  const outcomes: Parameters<typeof outcomeSummaries>[0] = []
  const paths: Parameters<typeof pathSummaries>[0] = []
  for (const press of presses) {
    const confirmedStarts = new Set(press.episodes.filter(({ completionStatus }) => completionStatus === 'CONFIRMED_PRODUCTION').map(({ confirmedProductionStartUtc }) => confirmedProductionStartUtc).filter(Boolean))
    for (let index = 0; index < press.segments.length; index += 1) {
      const source = press.segments[index]
      if (source.kind !== 'radius' || source.eventType !== 'M') continue
      const exitMs = Date.parse(source.endUtc)
      if (exitMs < fromMs || exitMs >= toMs) continue
      anchorCount += 1
      const next = press.segments[index + 1]
      if (!next || next.kind === 'offline' || Date.parse(next.startUtc) >= toMs) {
        censoredCount += 1
        unresolvedCount += 1
        continue
      }
      outcomes.push({ target: statusRef(next), lag: Math.max(0, (Date.parse(next.startUtc) - exitMs) / 1_000), pressKey: press.pressKey, evidence: {
        pressKey: press.pressKey, displayName: press.displayName, startUtc: source.startUtc, endUtc: source.endUtc,
        durationSeconds: source.durationSeconds, leftCensored: false, rightCensored: false,
        previousStatus: radiusNeighbor(press.segments, index, -1) ? statusRef(radiusNeighbor(press.segments, index, -1)!) : null,
        nextStatus: statusRef(next),
      } })
      const states: AnalyticsStatusRef[] = []
      let resolved = false
      let hitBoundary = false
      let enteredBad = false
      let enteredSafety = false
      let lastKnownStartMs = exitMs
      for (let cursor = index + 1; cursor < press.segments.length; cursor += 1) {
        const segment = press.segments[cursor]
        if (segment.kind === 'offline' || Date.parse(segment.startUtc) >= toMs) { hitBoundary = true; break }
        lastKnownStartMs = Date.parse(segment.startUtc)
        if (states.length < 6) states.push(statusRef(segment))
        if (segment.eventType === 'B') enteredBad = true
        if (segment.eventType === 'S') enteredSafety = true
        if (segment.isProduction && confirmedStarts.has(segment.startUtc)) {
          confirmedProductionCount += 1
          const lag = Math.max(0, (Date.parse(segment.startUtc) - exitMs) / 1_000)
          confirmedLags.push(lag)
          paths.push({ states, elapsed: lag, pressKey: press.pressKey })
          resolved = true
          break
        }
        if (segment.eventType === 'M') { returnedToMakeReadyCount += 1; break }
      }
      if (enteredBad) enteredBadCount += 1
      if (enteredSafety) enteredSafetyCount += 1
      if (!resolved) {
        if (hitBoundary) unresolvedCount += 1
        else failedToReachConfirmedProductionCount += 1
        paths.push({ states, elapsed: Math.max(0, (lastKnownStartMs - exitMs) / 1_000), pressKey: press.pressKey })
      }
    }
  }
  const resolvedCount = outcomes.length
  return {
    anchorCount, resolvedCount, censoredCount,
    outcomes: outcomeSummaries(outcomes, resolvedCount), paths: pathSummaries(paths, paths.length),
    confirmedProductionCount, returnedToMakeReadyCount, enteredBadCount, enteredSafetyCount,
    failedToReachConfirmedProductionCount, unresolvedCount,
    medianSecondsToConfirmedProduction: percentile(confirmedLags, 0.5),
    p90SecondsToConfirmedProduction: confirmedLags.length >= PERCENTILE_SAMPLE ? percentile(confirmedLags, 0.9) : null,
  }
}

function relationshipAnomalies(groups: OperationalRelationshipGroup[]): OperationalPatternAnomaly[] {
  const anomalies: OperationalPatternAnomaly[] = []
  for (const group of groups.filter(({ direction, maxTransitions, denominator }) => direction === 'after' && maxTransitions === 1 && denominator >= 5)) {
    const dominant = group.outcomes[0]
    if (!dominant || dominant.percentage < 60 || dominant.numerator === group.denominator) continue
    for (const alternative of group.outcomes.slice(1)) {
      for (const item of alternative.evidence) {
        anomalies.push({
          anomalyId: createHash('sha256').update(`${group.anchor.identity}|${alternative.target.identity}|${item.pressKey}|${item.startUtc}`).digest('hex').slice(0, 20),
          pressKey: item.pressKey, displayName: item.displayName, observedAtUtc: item.startUtc,
          actualSequence: [group.anchor, alternative.target], expectedSequence: [group.anchor, dominant.target],
          normalNumerator: dominant.numerator, normalDenominator: group.denominator,
          observedCount: alternative.numerator, durationDifferenceSeconds: null,
          reason: `${group.anchor.statusDescription} most commonly moved to ${dominant.target.statusDescription}, but this occurrence moved to ${alternative.target.statusDescription}.`,
          lowSupport: group.denominator < LOW_SUPPORT_THRESHOLD,
        })
        if (anomalies.length >= 30) return anomalies
      }
    }
  }
  return anomalies
}

export function analyzeOperationalHistory(
  inputs: OperationalAnalyticsPressInput[],
  fromUtc: string,
  toUtc: string,
): OperationalAnalytics {
  const presses = inputs.map(normalizePress)
  const occurrences = presses.flatMap((press) => occurrencesForPress(press, fromUtc, toUtc))
  const possibleSeconds = Math.max(0, (Date.parse(toUtc) - Date.parse(fromUtc)) / 1_000) * presses.length
  const observedSeconds = occurrences.reduce((sum, item) => sum + item.durationSeconds, 0)
  const unknownSeconds = Math.max(0, possibleSeconds - observedSeconds)
  const categoryGroups = new Map<string, Occurrence[]>()
  const statusGroups = new Map<string, Occurrence[]>()
  for (const occurrence of occurrences) {
    categoryGroups.set(occurrence.status.eventType, [...(categoryGroups.get(occurrence.status.eventType) ?? []), occurrence])
    statusGroups.set(occurrence.status.identity, [...(statusGroups.get(occurrence.status.identity) ?? []), occurrence])
  }
  const categoryDurations = new Map([...categoryGroups].map(([eventType, values]) => [eventType, values.reduce((sum, item) => sum + item.durationSeconds, 0)]))
  const categories = [...categoryGroups.entries()].map(([eventType, values]) => {
    const durationSeconds = categoryDurations.get(eventType) ?? 0
    return {
      eventType, category: category(eventType), durationSeconds,
      percentageOfObserved: percentage(durationSeconds, observedSeconds),
      percentageOfPossible: percentage(durationSeconds, possibleSeconds),
      occurrenceCount: values.length,
      productionSeconds: values.filter(({ segment }) => segment.isProduction).reduce((sum, item) => sum + item.durationSeconds, 0),
    }
  }).sort((left, right) => right.durationSeconds - left.durationSeconds)
  const statusDrivers: OperationalStatusDriver[] = [...statusGroups.values()].map((values) => {
    const first = values[0]
    const durationSeconds = values.reduce((sum, item) => sum + item.durationSeconds, 0)
    const durations = values.map(({ durationSeconds: value }) => value)
    return {
      ...first.status, durationSeconds,
      percentageOfObserved: percentage(durationSeconds, observedSeconds),
      percentageWithinCategory: percentage(durationSeconds, categoryDurations.get(first.status.eventType) ?? 0),
      occurrenceCount: values.length,
      medianOccurrenceSeconds: percentile(durations, 0.5) ?? 0,
      p90OccurrenceSeconds: durations.length >= PERCENTILE_SAMPLE ? percentile(durations, 0.9) : null,
      pressCount: new Set(values.map(({ pressKey }) => pressKey)).size,
      scopePressCount: presses.length,
      clippedOccurrenceCount: values.filter(({ leftCensored, rightCensored }) => leftCensored || rightCensored).length,
      evidence: values.slice(0, EVIDENCE_LIMIT).map(evidence),
    }
  }).sort((left, right) => right.durationSeconds - left.durationSeconds)
  const relationships = relationshipGroups(presses, fromUtc, toUtc)
  return {
    fromUtc, toUtc,
    scopePressKeys: presses.map(({ pressKey }) => pressKey), scopePressCount: presses.length,
    annotationDisclaimer: DISCLAIMER,
    coverage: { possibleSeconds, observedSeconds, unknownSeconds, coveragePercentage: percentage(observedSeconds, possibleSeconds) },
    categories, statusDrivers,
    productionStops: productionStopPatterns(presses, fromUtc, toUtc),
    beforeSuccessfulProduction: beforeSuccessfulPatterns(presses, fromUtc, toUtc),
    afterMakeReady: makeReadyPatterns(presses, fromUtc, toUtc),
    relationshipGroups: relationships,
    anomalies: relationshipAnomalies(relationships),
  }
}
