import { createHash } from 'node:crypto'
import {
  CHANGEOVER_STABILIZATION_COMPLETION_WINDOW_SECONDS_DEFAULT,
  CHANGEOVER_STABILIZATION_MINIMUM_ROLL_LENGTH_DEFAULT,
  CHANGEOVER_STABILIZATION_REQUIRED_ROLLS_DEFAULT,
  type ChangeoverStabilizationPhase,
  type ChangeoverStabilizationRoll,
  type StopFleetEpisode,
} from './contracts.js'

interface ValueObservation { atUtc: string; value: string | number | boolean; qualityState: string }
interface NumericObservation { atUtc: string; value: number; qualityState: string }

export interface ChangeoverStabilizationInput {
  fromUtc: string
  toUtc: string
  episodes: StopFleetEpisode[]
  rollIdentityObservations: ValueObservation[]
  rollLengthObservations: NumericObservation[]
  orderObservations?: ValueObservation[]
  recipeObservations?: ValueObservation[]
  rollLengthUnit?: string | null
  minimumRollLength?: number
  requiredConsecutiveRolls?: number
  completionWindowSeconds?: number
}

const validTime = (value: string) => Number.isFinite(Date.parse(value))
const good = (value: string) => ['good', 'true'].includes(value.trim().toLowerCase())
function orderedValues(observations: ValueObservation[]) {
  const byTime = new Map<string, ValueObservation>()
  for (const observation of observations) if (validTime(observation.atUtc) && good(observation.qualityState)) byTime.set(observation.atUtc, observation)
  return [...byTime.values()].sort((left, right) => Date.parse(left.atUtc) - Date.parse(right.atUtc))
}

function valueAt(observations: ValueObservation[], at: number): string | null {
  const observation = observations.filter((item) => Date.parse(item.atUtc) <= at).at(-1)
  return observation ? String(observation.value) : null
}

function identityAt(order: ValueObservation[], recipe: ValueObservation[], at: number) {
  return `${valueAt(order, at) ?? '?'}\u0000${valueAt(recipe, at) ?? '?'}`
}

interface CompletedRoll extends ChangeoverStabilizationRoll { identity: string }

function identityCompletedRolls(input: ChangeoverStabilizationInput): CompletedRoll[] {
  const rolls = orderedValues(input.rollIdentityObservations)
  const lengths = input.rollLengthObservations.filter((item) => validTime(item.atUtc) && good(item.qualityState) && Number.isFinite(item.value)).sort((left, right) => Date.parse(left.atUtc) - Date.parse(right.atUtc))
  const order = orderedValues(input.orderObservations ?? [])
  const recipe = orderedValues(input.recipeObservations ?? [])
  const completed: CompletedRoll[] = []
  for (let index = 0; index < rolls.length - 1; index += 1) {
    const current = rolls[index]!; const next = rolls[index + 1]!
    if (String(current.value) === String(next.value)) continue
    const start = Date.parse(current.atUtc); const end = Date.parse(next.atUtc)
    if (end <= start) continue
    const observedLengths = lengths.filter((item) => { const at = Date.parse(item.atUtc); return at >= start && at < end })
    if (!observedLengths.length) continue
    const completedLength = Math.max(...observedLengths.map(({ value }) => value))
    completed.push({ rollId: String(current.value), startAt: current.atUtc, productionStartAt: current.atUtc, completedAt: next.atUtc, completedLength, unit: input.rollLengthUnit ?? null, identity: identityAt(order, recipe, end - 1) })
  }
  return completed
}

function lengthResetCompletedRolls(input: ChangeoverStabilizationInput): CompletedRoll[] {
  const lengths = input.rollLengthObservations
    .filter((item) => validTime(item.atUtc) && good(item.qualityState) && Number.isFinite(item.value) && item.value >= 0)
    .sort((left, right) => Date.parse(left.atUtc) - Date.parse(right.atUtc))
  const rollIdentity = orderedValues(input.rollIdentityObservations)
  const order = orderedValues(input.orderObservations ?? [])
  const recipe = orderedValues(input.recipeObservations ?? [])
  if (lengths.length < 2) return []
  const completed: CompletedRoll[] = []
  let segmentStart = lengths[0]!.atUtc
  let peak = lengths[0]!.value
  let prior = lengths[0]!.value
  for (const observation of lengths.slice(1)) {
    const reset = prior > observation.value && peak - observation.value >= 1_000 && observation.value <= Math.max(500, peak * 0.2)
    if (reset) {
      const completedAt = observation.atUtc
      const end = Date.parse(completedAt)
      completed.push({
        rollId: valueAt(rollIdentity, end - 1) ?? `length-reset-${completed.length + 1}-${segmentStart}`,
        startAt: segmentStart,
        productionStartAt: segmentStart,
        completedAt,
        completedLength: peak,
        unit: input.rollLengthUnit ?? null,
        identity: identityAt(order, recipe, end - 1),
      })
      segmentStart = completedAt
      peak = observation.value
    } else peak = Math.max(peak, observation.value)
    prior = observation.value
  }
  return completed
}

function completedRolls(input: ChangeoverStabilizationInput): CompletedRoll[] {
  const resetRolls = lengthResetCompletedRolls(input)
  const identityRolls = identityCompletedRolls(input)
  if (!resetRolls.length) return identityRolls
  const completionMatchMs = 2 * 60 * 1_000
  const matchedIdentityIndexes = new Set<number>()
  const combined = resetRolls.map((resetRoll) => {
    let bestIndex = -1; let bestDistance = Number.POSITIVE_INFINITY
    identityRolls.forEach((identityRoll, index) => {
      const distance = Math.abs(Date.parse(identityRoll.completedAt) - Date.parse(resetRoll.completedAt))
      if (!matchedIdentityIndexes.has(index) && distance <= completionMatchMs && distance < bestDistance) { bestIndex = index; bestDistance = distance }
    })
    if (bestIndex < 0) return resetRoll
    matchedIdentityIndexes.add(bestIndex)
    const identityRoll = identityRolls[bestIndex]!
    return { ...resetRoll, rollId: identityRoll.rollId, startAt: identityRoll.startAt, productionStartAt: identityRoll.startAt, identity: identityRoll.identity }
  })
  return combined.sort((left, right) => Date.parse(left.completedAt) - Date.parse(right.completedAt))
}

function firstProductionStart(rollStart: number, rollEnd: number, triggerEnd: number, episodes: StopFleetEpisode[]) {
  let productionStart = Math.max(rollStart, triggerEnd > rollStart && triggerEnd < rollEnd ? triggerEnd : rollStart)
  while (true) {
    const coveringStop = episodes
      .filter((episode) => episode.endAt && Date.parse(episode.startAt) <= productionStart && Date.parse(episode.endAt) > productionStart)
      .sort((left, right) => Date.parse(left.endAt!) - Date.parse(right.endAt!))
      .at(-1)
    if (!coveringStop) return productionStart
    productionStart = Date.parse(coveringStop.endAt!)
  }
}

/**
 * Keeps a classified changeover operationally open until production proves itself.
 * The proof is retrospective: after two consecutive long rolls, good production
 * begins at the first roll's actual post-stop production start.
 */
export function buildChangeoverStabilizationPhases(input: ChangeoverStabilizationInput): ChangeoverStabilizationPhase[] {
  const from = Date.parse(input.fromUtc); const to = Date.parse(input.toUtc)
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return []
  const minimumRollLength = input.minimumRollLength ?? CHANGEOVER_STABILIZATION_MINIMUM_ROLL_LENGTH_DEFAULT
  const requiredConsecutiveRolls = input.requiredConsecutiveRolls ?? CHANGEOVER_STABILIZATION_REQUIRED_ROLLS_DEFAULT
  const completionWindowSeconds = input.completionWindowSeconds ?? CHANGEOVER_STABILIZATION_COMPLETION_WINDOW_SECONDS_DEFAULT
  const completionWindowMs = completionWindowSeconds * 1_000
  const episodes = [...input.episodes].filter((episode) => validTime(episode.startAt) && validTime(episode.endAt ?? input.toUtc)).sort((left, right) => Date.parse(left.startAt) - Date.parse(right.startAt))
  const rolls = completedRolls(input)
  // Do not extend a classification when the press cannot prove roll completion.
  // Roll-length resets are authoritative completion evidence even when the optional
  // roll-identity tag is sparse or unchanged on a press.
  if (!input.rollLengthObservations.length) return []
  const phases: ChangeoverStabilizationPhase[] = []
  let ignoreTriggersBefore = from

  for (const trigger of episodes.filter((episode) => episode.classification === 'CHANGEOVER')) {
    const triggerStart = Date.parse(trigger.startAt); const triggerEnd = Date.parse(trigger.endAt ?? input.toUtc)
    if (triggerStart < ignoreTriggersBefore) continue
    let streak: CompletedRoll[] = []
    let stabilizedAt: number | null = null
    let goodProductionStart: number | null = null

    for (const roll of rolls.filter((item) => Date.parse(item.startAt) >= triggerStart && Date.parse(item.completedAt) > triggerEnd)) {
      const rollStart = Date.parse(roll.startAt); const rollEnd = Date.parse(roll.completedAt)
      const productionStart = firstProductionStart(rollStart, rollEnd, triggerEnd, episodes)
      const qualifying = roll.completedLength > minimumRollLength && productionStart < rollEnd
      if (!qualifying) continue

      streak.push({ ...roll, productionStartAt: new Date(productionStart).toISOString() })
      while (streak.length > 1 && productionStart - Date.parse(streak[0]!.completedAt) > completionWindowMs) streak.shift()
      if (streak.length < requiredConsecutiveRolls) continue
      const proof = streak.slice(-requiredConsecutiveRolls)
      stabilizedAt = rollEnd
      goodProductionStart = Date.parse(proof[0]!.productionStartAt)
      streak = proof
      break
    }

    const operationalEnd = stabilizedAt === null ? to : goodProductionStart!
    const clippedStart = Math.max(from, triggerStart); const clippedEnd = Math.min(to, operationalEnd)
    if (clippedEnd <= clippedStart) { ignoreTriggersBefore = Math.max(ignoreTriggersBefore, stabilizedAt ?? operationalEnd); continue }
    const stabilizationId = `stabilization-${createHash('sha256').update(`${trigger.stopId}\u0000${minimumRollLength}\u0000${requiredConsecutiveRolls}\u0000${completionWindowSeconds}\u0000strict`).digest('hex').slice(0, 16)}`
    const continuationStopIds = episodes.filter((episode) => episode.stopId !== trigger.stopId && Date.parse(episode.startAt) < operationalEnd && Date.parse(episode.endAt ?? input.toUtc) > triggerStart).map(({ stopId }) => stopId)
    phases.push({
      stabilizationId,
      triggerStopId: trigger.stopId,
      startAt: new Date(clippedStart).toISOString(),
      endAt: new Date(clippedEnd).toISOString(),
      status: stabilizedAt === null ? 'STABILIZING' : 'STABILIZED',
      stabilizedAt: stabilizedAt === null ? null : new Date(stabilizedAt).toISOString(),
      goodProductionStartAt: goodProductionStart === null ? null : new Date(goodProductionStart).toISOString(),
      minimumRollLength,
      requiredConsecutiveRolls,
      completionWindowSeconds,
      qualifyingRolls: streak.map(({ identity: _identity, ...roll }) => roll),
      continuationStopIds,
      reason: stabilizedAt === null
        ? `Changeover remains open until ${requiredConsecutiveRolls} rolls each complete above ${minimumRollLength.toLocaleString('en-US')} ft and the next qualifying roll starts production within ${completionWindowSeconds / 60} minutes of the prior qualifying roll's completion.`
        : `Production stabilized after ${requiredConsecutiveRolls} rolls each completed above ${minimumRollLength.toLocaleString('en-US')} ft and the next qualifying roll started within ${completionWindowSeconds / 60} minutes of the prior qualifying roll's completion; good production is applied retrospectively from the first qualifying roll's production start.`,
    })
    ignoreTriggersBefore = stabilizedAt ?? to
  }
  return phases
}
