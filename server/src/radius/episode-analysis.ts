import type {
  CrossPressSequenceFamily,
  EpisodeAttentionItem,
  EpisodeSequenceFamily,
  EpisodeStateSummary,
  EpisodeTransitionSummary,
  FleetEpisodeAnalysis,
  OperationalEpisode,
  PressEpisodeAnalysis,
  RadiusStateSegment,
} from './models.js'

const MIN_PERCENTILE_SAMPLE = 5
const MIN_CROSS_PRESS_COHORT = 2

function round(value: number): number {
  return Math.round(value * 10) / 10
}

export function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const index = (sorted.length - 1) * fraction
  const lower = Math.floor(index)
  const upper = Math.ceil(index)
  const value = sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower)
  return round(value)
}

export function compressedEpisodeSegments(episode: OperationalEpisode): RadiusStateSegment[] {
  const compressed: RadiusStateSegment[] = []
  for (const segment of episode.statusSegments) {
    const previous = compressed.at(-1)
    if (
      previous &&
      previous.eventType === segment.eventType &&
      previous.statusDescription === segment.statusDescription &&
      previous.returnToProduction === segment.returnToProduction
    ) {
      compressed[compressed.length - 1] = {
        ...previous,
        endUtc: segment.endUtc,
        durationSeconds: previous.durationSeconds + segment.durationSeconds,
        isOpen: segment.isOpen,
      }
    } else {
      compressed.push({ ...segment })
    }
  }
  return compressed
}

export function episodeDescriptor(episode: OperationalEpisode): string {
  const states = compressedEpisodeSegments(episode)
    .filter(({ isProduction }) => !isProduction)
    .map(({ statusDescription }) => statusDescription)
  if (states.length === 0) return episode.primaryStatusDescription
  return states.length === 1 ? states[0] : `${states[0]} → ${states.at(-1)}`
}

function sequence(episode: OperationalEpisode): { key: string; states: string[] } {
  const states = compressedEpisodeSegments(episode).map(({ statusDescription, returnToProduction }) =>
    returnToProduction === 'failed' ? `${statusDescription} (failed return)` : statusDescription,
  )
  return { key: states.join('\u001f'), states }
}

function stateSummaries(
  items: Array<{ eventType: string; statusDescription: string; durationSeconds: number }>,
  denominator = items.length,
): EpisodeStateSummary[] {
  const grouped = new Map<string, typeof items>()
  for (const item of items) {
    const key = `${item.eventType}\u001f${item.statusDescription}`
    grouped.set(key, [...(grouped.get(key) ?? []), item])
  }
  return [...grouped.values()]
    .map((group) => ({
      eventType: group[0].eventType,
      statusDescription: group[0].statusDescription,
      count: group.length,
      percentage: denominator === 0 ? 0 : round((group.length / denominator) * 100),
      medianDwellSeconds: percentile(group.map(({ durationSeconds }) => durationSeconds), 0.5) ?? 0,
    }))
    .sort((left, right) => right.count - left.count || left.statusDescription.localeCompare(right.statusDescription))
}

function sequenceFamilies(episodes: OperationalEpisode[]): EpisodeSequenceFamily[] {
  const groups = new Map<string, { states: string[]; episodes: OperationalEpisode[] }>()
  for (const episode of episodes) {
    const value = sequence(episode)
    const group = groups.get(value.key) ?? { states: value.states, episodes: [] }
    group.episodes.push(episode)
    groups.set(value.key, group)
  }
  return [...groups.entries()]
    .map(([sequenceKey, group]) => ({
      sequenceKey,
      states: group.states,
      count: group.episodes.length,
      percentage: episodes.length === 0 ? 0 : round((group.episodes.length / episodes.length) * 100),
      medianDurationSeconds: percentile(group.episodes.map(({ durationSeconds }) => durationSeconds), 0.5) ?? 0,
    }))
    .sort((left, right) => right.count - left.count || left.sequenceKey.localeCompare(right.sequenceKey))
}

function transitionSummaries(episodes: OperationalEpisode[]): EpisodeTransitionSummary[] {
  const transitions = new Map<string, Array<{ eventType: string; statusDescription: string; durationSeconds: number }>>()
  for (const episode of episodes) {
    const segments = compressedEpisodeSegments(episode)
    for (let index = 0; index < segments.length - 1; index += 1) {
      const from = segments[index].statusDescription
      const next = segments[index + 1]
      transitions.set(from, [...(transitions.get(from) ?? []), next])
    }
  }
  return [...transitions.entries()]
    .map(([fromStatusDescription, outcomes]) => ({
      fromStatusDescription,
      outcomes: stateSummaries(outcomes, outcomes.length),
    }))
    .sort((left, right) => left.fromStatusDescription.localeCompare(right.fromStatusDescription))
}

function attentionItems(episodes: OperationalEpisode[]): EpisodeAttentionItem[] {
  const durationMedian = percentile(episodes.map(({ durationSeconds }) => durationSeconds), 0.5)
  const durationP90 = episodes.length >= MIN_PERCENTILE_SAMPLE
    ? percentile(episodes.map(({ durationSeconds }) => durationSeconds), 0.9)
    : null
  const transitionP90 = episodes.length >= MIN_PERCENTILE_SAMPLE
    ? percentile(episodes.map((episode) => compressedEpisodeSegments(episode).length), 0.9)
    : null
  const families = sequenceFamilies(episodes)
  const familyCounts = new Map(families.map((family) => [family.sequenceKey, family.count]))
  const familyPhases = new Map<string, number[]>()
  for (const episode of episodes) {
    const familyKey = sequence(episode).key
    for (const phase of compressedEpisodeSegments(episode).filter(({ isProduction }) => !isProduction)) {
      const key = `${familyKey}\u001e${phase.eventType}\u001f${phase.statusDescription}`
      familyPhases.set(key, [...(familyPhases.get(key) ?? []), phase.durationSeconds])
    }
  }
  return episodes.flatMap((episode) => {
    const reasons: string[] = []
    if (durationP90 !== null && episode.durationSeconds > durationP90) {
      const difference = durationMedian === null ? 0 : episode.durationSeconds - durationMedian
      reasons.push(`Duration is ${Math.round(difference)}s above this press's median and exceeds P90 (${Math.round(durationP90)}s)`)
    }
    if (episode.failedReturnToProductionAttempts > 1) {
      reasons.push(`${episode.failedReturnToProductionAttempts} failed Run Production attempts`)
    }
    if (episode.dataInterrupted) reasons.push('Radius data was interrupted before the outcome was known')
    const episodeSequence = sequence(episode)
    for (const phase of compressedEpisodeSegments(episode).filter(({ isProduction }) => !isProduction)) {
      const key = `${episodeSequence.key}\u001e${phase.eventType}\u001f${phase.statusDescription}`
      const comparable = familyPhases.get(key) ?? []
      const phaseP90 = comparable.length >= MIN_PERCENTILE_SAMPLE ? percentile(comparable, 0.9) : null
      if (phaseP90 !== null && phase.durationSeconds > phaseP90) {
        const phaseMedian = percentile(comparable, 0.5) ?? 0
        reasons.push(`${phase.statusDescription} dwell is ${Math.round(phase.durationSeconds - phaseMedian)}s above the sequence-family median and exceeds P90 (${Math.round(phaseP90)}s)`)
      }
    }
    if (episodes.length >= 10 && familyCounts.get(episodeSequence.key) === 1) {
      reasons.push('Sequence occurred only once in this range')
    }
    const transitions = compressedEpisodeSegments(episode).length
    if (transitionP90 !== null && transitions > Math.max(8, transitionP90)) {
      reasons.push(`${transitions} phase transitions exceeds the press-specific threshold`)
    }
    return reasons.length === 0 ? [] : [{
      episodeId: episode.episodeId,
      pressKey: episode.pressKey,
      startUtc: episode.startUtc,
      descriptor: episodeDescriptor(episode),
      reasons,
    }]
  })
}

export function analyzePressEpisodes(episodes: OperationalEpisode[]): PressEpisodeAnalysis {
  const completed = episodes.filter(({ completionStatus }) => completionStatus === 'CONFIRMED_PRODUCTION')
  const first = episodes.flatMap((episode) => compressedEpisodeSegments(episode).find(({ isProduction }) => !isProduction) ?? [])
  const final = completed.flatMap((episode) => {
    const segments = compressedEpisodeSegments(episode)
    const confirmedIndex = segments.findIndex(({ returnToProduction }) => returnToProduction === 'confirmed')
    return confirmedIndex > 0 ? [segments[confirmedIndex - 1]] : []
  })
  const allPhases = episodes.flatMap(compressedEpisodeSegments).filter(({ isProduction }) => !isProduction)
  const phaseSummaries = stateSummaries(allPhases, allPhases.length)
  const durations = episodes.map(({ durationSeconds }) => durationSeconds)
  const successfulFirstReturnCount = completed.filter(({ failedReturnToProductionAttempts }) => failedReturnToProductionAttempts === 0).length
  return {
    episodeCount: episodes.length,
    episodeProfiles: episodes.map((episode) => {
      const value = sequence(episode)
      return {
        episodeId: episode.episodeId,
        descriptor: episodeDescriptor(episode),
        sequenceKey: value.key,
        sequenceStates: value.states,
      }
    }),
    medianDurationSeconds: percentile(durations, 0.5),
    p75DurationSeconds: episodes.length >= MIN_PERCENTILE_SAMPLE ? percentile(durations, 0.75) : null,
    p90DurationSeconds: episodes.length >= MIN_PERCENTILE_SAMPLE ? percentile(durations, 0.9) : null,
    firstStates: stateSummaries(first, episodes.length),
    finalStatesBeforeSuccess: stateSummaries(final, completed.length),
    sequenceFamilies: sequenceFamilies(episodes),
    transitionSummaries: transitionSummaries(episodes),
    phaseBenchmarks: phaseSummaries.map((summary) => ({
      eventType: summary.eventType,
      statusDescription: summary.statusDescription,
      sampleCount: summary.count,
      medianDurationSeconds: summary.medianDwellSeconds,
      p90DurationSeconds: summary.count >= MIN_PERCENTILE_SAMPLE
        ? percentile(allPhases.filter((phase) => phase.eventType === summary.eventType && phase.statusDescription === summary.statusDescription).map(({ durationSeconds }) => durationSeconds), 0.9)
        : null,
    })),
    mostTimeConsumingPhase: phaseSummaries.sort((left, right) =>
      allPhases.filter((phase) => phase.statusDescription === right.statusDescription).reduce((sum, phase) => sum + phase.durationSeconds, 0) -
      allPhases.filter((phase) => phase.statusDescription === left.statusDescription).reduce((sum, phase) => sum + phase.durationSeconds, 0),
    )[0] ?? null,
    failedReturns: {
      completedEpisodeCount: completed.length,
      successfulFirstReturnCount,
      oneFailedReturnCount: completed.filter(({ failedReturnToProductionAttempts }) => failedReturnToProductionAttempts === 1).length,
      multipleFailedReturnCount: completed.filter(({ failedReturnToProductionAttempts }) => failedReturnToProductionAttempts > 1).length,
      firstReturnSuccessRate: completed.length === 0 ? null : round((successfulFirstReturnCount / completed.length) * 100),
    },
    attentionItems: attentionItems(episodes),
  }
}

export function analyzeFleetEpisodes(episodes: OperationalEpisode[]): FleetEpisodeAnalysis {
  const groups = new Map<string, { states: string[]; episodes: OperationalEpisode[] }>()
  for (const episode of episodes) {
    const value = sequence(episode)
    const group = groups.get(value.key) ?? { states: value.states, episodes: [] }
    group.episodes.push(episode)
    groups.set(value.key, group)
  }
  const sequenceFamilies: CrossPressSequenceFamily[] = [...groups.entries()].map(([sequenceKey, family]) => {
    const byPress = new Map<string, OperationalEpisode[]>()
    for (const episode of family.episodes) byPress.set(episode.pressKey, [...(byPress.get(episode.pressKey) ?? []), episode])
    const presses = [...byPress.values()].map((pressEpisodes) => ({
      pressKey: pressEpisodes[0].pressKey,
      displayName: pressEpisodes[0].displayName,
      episodeCount: pressEpisodes.length,
      medianDurationSeconds: percentile(pressEpisodes.map(({ durationSeconds }) => durationSeconds), 0.5) ?? 0,
      medianPhaseDurationSeconds: percentile(pressEpisodes.flatMap(compressedEpisodeSegments).filter(({ isProduction }) => !isProduction).map(({ durationSeconds }) => durationSeconds), 0.5) ?? 0,
      failedReturnRate: round((pressEpisodes.filter(({ failedReturnToProductionAttempts }) => failedReturnToProductionAttempts > 0).length / pressEpisodes.length) * 100),
    })).sort((left, right) => left.displayName.localeCompare(right.displayName))
    const comparablePresses = presses.filter(({ episodeCount }) => episodeCount >= MIN_CROSS_PRESS_COHORT)
    const comparable = comparablePresses.length >= 2
    return {
      sequenceKey,
      states: family.states,
      totalCount: family.episodes.length,
      comparable,
      insufficientSampleReason: comparable ? null : 'At least two presses need two episodes each in this exact sequence family.',
      presses,
    }
  })
  return { sequenceFamilies: sequenceFamilies.sort((left, right) => right.totalCount - left.totalCount || left.sequenceKey.localeCompare(right.sequenceKey)) }
}
