import type {
  OverviewDecisionSupport,
  OverviewFamilyAllocation,
  OverviewGroupAllocation,
  OverviewPressAllocation,
  OverviewRadiusStateAllocation,
  OverviewTimelineInterval,
  RadiusOverview,
  RadiusStateSegment,
  RadiusStatusSegment,
} from './models.js'

export const OVERVIEW_MINIMUM_COVERAGE_PERCENT = 80 as const
export const OVERVIEW_MINIMUM_OBSERVED_SECONDS: 1800 = 1800
const NEEDS_CLASSIFICATION_KEY = 'NEEDS_CLASSIFICATION'
const NEEDS_CLASSIFICATION_COLOR = { light: '#68727d', dark: '#9ca8b5' }
const EVENT_ORDER = new Map([['G', 0], ['M', 1], ['B', 2], ['S', 3]])

interface MutableFamily {
  key: string
  name: string
  durationSeconds: number
  nonProductionSeconds: number
  identities: Set<string>
  needsClassification: boolean
  pressContributions: Map<string, MutablePressContribution>
}

interface MutablePressContribution {
  pressKey: RadiusStateSegment['pressKey']
  displayName: string
  durationSeconds: number
}

interface MutableGroup {
  key: string
  name: string
  description: string
  lightColor: string
  darkColor: string
  durationSeconds: number
  nonProductionSeconds: number
  families: Map<string, MutableFamily>
  needsClassification: boolean
  pressContributions: Map<string, MutablePressContribution>
}

interface MutableRadiusState {
  eventType: string
  displayLabel: string
  durationSeconds: number
  canonicalProductionSeconds: number
  groups: Map<string, MutableGroup>
}

interface SegmentAggregate {
  states: Map<string, MutableRadiusState>
  observedSeconds: number
  productionSeconds: number
  needsClassificationSeconds: number
}

export function radiusStateLabel(eventType: string): string {
  if (eventType === 'G') return 'Run Production'
  if (eventType === 'M') return 'Make Ready'
  if (eventType === 'B') return 'Bad'
  if (eventType === 'S') return 'Safety'
  return eventType ? `Other Radius state (${eventType})` : 'Unknown Radius state'
}

export function isCanonicalOverviewProduction(segment: Pick<RadiusStateSegment, 'eventType' | 'statusDescription'>): boolean {
  return segment.eventType === 'G'
}

function percent(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator * 100 : null
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null
  const ordered = [...values].sort((left, right) => left - right)
  const middle = Math.floor(ordered.length / 2)
  return ordered.length % 2 === 1
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2
}

function classificationFor(segment: RadiusStateSegment) {
  const classification = segment.classification
  if (!classification || classification.isFallback) {
    return {
      groupKey: NEEDS_CLASSIFICATION_KEY,
      groupName: 'Needs Classification',
      groupDescription: 'Observed Radius evidence without a published exact mapping.',
      groupLightColor: NEEDS_CLASSIFICATION_COLOR.light,
      groupDarkColor: NEEDS_CLASSIFICATION_COLOR.dark,
      familyKey: NEEDS_CLASSIFICATION_KEY,
      familyName: 'Needs Classification',
      needsClassification: true,
    }
  }
  return {
    groupKey: classification.operationalGroupKey,
    groupName: classification.operationalGroupName,
    groupDescription: classification.operationalGroupDescription,
    groupLightColor: classification.operationalGroupLightColor,
    groupDarkColor: classification.operationalGroupDarkColor,
    familyKey: classification.processFamilyKey,
    familyName: classification.processFamilyName,
    needsClassification: false,
  }
}

function sourceIdentity(segment: RadiusStateSegment): string {
  return `${segment.eventType}\u001f${segment.statusCode ?? ''}\u001f${segment.statusDescription}`
}

function addPressContribution(contributions: Map<string, MutablePressContribution>, segment: RadiusStateSegment, durationSeconds: number) {
  const current = contributions.get(segment.pressKey)
  if (current) current.durationSeconds += durationSeconds
  else contributions.set(segment.pressKey, { pressKey: segment.pressKey, displayName: segment.displayName, durationSeconds })
}

function pressContributions(contributions: Map<string, MutablePressContribution>, categorySeconds: number) {
  return [...contributions.values()]
    .map((contribution) => ({
      ...contribution,
      shareOfCategoryPercent: percent(contribution.durationSeconds, categorySeconds) ?? 0,
    }))
    .sort((left, right) => right.durationSeconds - left.durationSeconds || left.displayName.localeCompare(right.displayName, undefined, { numeric: true }))
}

function aggregateSegments(segments: RadiusStateSegment[]): SegmentAggregate {
  const states = new Map<string, MutableRadiusState>()
  let productionSeconds = 0
  let observedSeconds = 0
  let needsClassificationSeconds = 0

  for (const segment of segments) {
    const durationSeconds = Math.max(0, segment.durationSeconds)
    if (durationSeconds === 0) continue
    const canonicalProduction = isCanonicalOverviewProduction(segment)
    const classification = classificationFor(segment)
    observedSeconds += durationSeconds
    if (canonicalProduction) productionSeconds += durationSeconds
    if (classification.needsClassification) needsClassificationSeconds += durationSeconds

    let state = states.get(segment.eventType)
    if (!state) {
      state = {
        eventType: segment.eventType,
        displayLabel: radiusStateLabel(segment.eventType),
        durationSeconds: 0,
        canonicalProductionSeconds: 0,
        groups: new Map(),
      }
      states.set(segment.eventType, state)
    }
    state.durationSeconds += durationSeconds
    if (canonicalProduction) state.canonicalProductionSeconds += durationSeconds

    let group = state.groups.get(classification.groupKey)
    if (!group) {
      group = {
        key: classification.groupKey,
        name: classification.groupName,
        description: classification.groupDescription,
        lightColor: classification.groupLightColor,
        darkColor: classification.groupDarkColor,
        durationSeconds: 0,
        nonProductionSeconds: 0,
        families: new Map(),
        needsClassification: classification.needsClassification,
        pressContributions: new Map(),
      }
      state.groups.set(group.key, group)
    }
    group.durationSeconds += durationSeconds
    if (!canonicalProduction) group.nonProductionSeconds += durationSeconds
    addPressContribution(group.pressContributions, segment, durationSeconds)

    let family = group.families.get(classification.familyKey)
    if (!family) {
      family = {
        key: classification.familyKey,
        name: classification.familyName,
        durationSeconds: 0,
        nonProductionSeconds: 0,
        identities: new Set(),
        needsClassification: classification.needsClassification,
        pressContributions: new Map(),
      }
      group.families.set(family.key, family)
    }
    family.durationSeconds += durationSeconds
    if (!canonicalProduction) family.nonProductionSeconds += durationSeconds
    family.identities.add(sourceIdentity(segment))
    addPressContribution(family.pressContributions, segment, durationSeconds)
  }
  return { states, observedSeconds, productionSeconds, needsClassificationSeconds }
}

function familyAllocation(family: MutableFamily, groupSeconds: number, stateSeconds: number, observedSeconds: number): OverviewFamilyAllocation {
  return {
    key: family.key,
    name: family.name,
    durationSeconds: family.durationSeconds,
    nonProductionSeconds: family.nonProductionSeconds,
    shareOfGroupPercent: percent(family.durationSeconds, groupSeconds) ?? 0,
    shareOfRadiusStatePercent: percent(family.durationSeconds, stateSeconds) ?? 0,
    shareOfObservedPercent: percent(family.durationSeconds, observedSeconds) ?? 0,
    sourceIdentityCount: family.identities.size,
    needsClassification: family.needsClassification,
    pressContributions: pressContributions(family.pressContributions, family.durationSeconds),
  }
}

function groupAllocation(group: MutableGroup, stateSeconds: number, observedSeconds: number): OverviewGroupAllocation {
  return {
    key: group.key,
    name: group.name,
    description: group.description,
    lightColor: group.lightColor,
    darkColor: group.darkColor,
    durationSeconds: group.durationSeconds,
    shareOfRadiusStatePercent: percent(group.durationSeconds, stateSeconds) ?? 0,
    shareOfObservedPercent: percent(group.durationSeconds, observedSeconds) ?? 0,
    nonProductionSeconds: group.nonProductionSeconds,
    families: [...group.families.values()]
      .map((family) => familyAllocation(family, group.durationSeconds, stateSeconds, observedSeconds))
      .sort((left, right) => right.durationSeconds - left.durationSeconds || left.name.localeCompare(right.name)),
    needsClassification: group.needsClassification,
    pressContributions: pressContributions(group.pressContributions, group.durationSeconds),
  }
}

function radiusStateAllocation(state: MutableRadiusState, observedSeconds: number): OverviewRadiusStateAllocation {
  const operationalGroups = [...state.groups.values()]
    .map((group) => groupAllocation(group, state.durationSeconds, observedSeconds))
    .sort((left, right) => right.durationSeconds - left.durationSeconds || left.name.localeCompare(right.name))
  const largestNonProductionGroup = [...operationalGroups]
    .filter(({ nonProductionSeconds }) => nonProductionSeconds > 0)
    .sort((left, right) => right.nonProductionSeconds - left.nonProductionSeconds || left.name.localeCompare(right.name))[0] ?? null
  const largestNonProductionFamily = largestNonProductionGroup
    ? [...largestNonProductionGroup.families]
      .filter(({ nonProductionSeconds }) => nonProductionSeconds > 0)
      .sort((left, right) => right.nonProductionSeconds - left.nonProductionSeconds || left.name.localeCompare(right.name))[0] ?? null
    : null
  const nonProductionSeconds = Math.max(0, state.durationSeconds - state.canonicalProductionSeconds)
  return {
    eventType: state.eventType,
    displayLabel: state.displayLabel,
    durationSeconds: state.durationSeconds,
    shareOfObservedPercent: percent(state.durationSeconds, observedSeconds) ?? 0,
    canonicalProductionSeconds: state.canonicalProductionSeconds,
    nonProductionSeconds,
    nonProductionShareOfObservedPercent: percent(nonProductionSeconds, observedSeconds) ?? 0,
    operationalGroups,
    largestNonProductionGroupKey: largestNonProductionGroup?.key ?? null,
    largestNonProductionFamilyKey: largestNonProductionFamily?.key ?? null,
  }
}

function stateBreakdown(aggregate: SegmentAggregate): OverviewRadiusStateAllocation[] {
  for (const eventType of ['G', 'M', 'B', 'S']) {
    if (!aggregate.states.has(eventType)) aggregate.states.set(eventType, {
      eventType,
      displayLabel: radiusStateLabel(eventType),
      durationSeconds: 0,
      canonicalProductionSeconds: 0,
      groups: new Map(),
    })
  }
  return [...aggregate.states.values()]
    .map((state) => radiusStateAllocation(state, aggregate.observedSeconds))
    .sort((left, right) => (EVENT_ORDER.get(left.eventType) ?? 99) - (EVENT_ORDER.get(right.eventType) ?? 99) || left.displayLabel.localeCompare(right.displayLabel))
}

function timelineInterval(segment: RadiusStatusSegment, index: number): OverviewTimelineInterval {
  if (segment.kind === 'offline') {
    return {
      intervalId: `${segment.pressKey}-${index}-${segment.startUtc}`,
      startUtc: segment.startUtc,
      endUtc: segment.endUtc,
      durationSeconds: segment.durationSeconds,
      isUnavailable: true,
      eventType: null,
      radiusStateLabel: 'Data unavailable',
      operationalGroupKey: null,
      operationalGroupLabel: 'Data unavailable',
      operationalGroupLightColor: null,
      operationalGroupDarkColor: null,
      processFamilyKey: null,
      processFamilyLabel: null,
      classificationStatus: 'unavailable',
    }
  }
  const classification = classificationFor(segment)
  return {
    intervalId: `${segment.pressKey}-${index}-${segment.startUtc}`,
    startUtc: segment.startUtc,
    endUtc: segment.endUtc,
    durationSeconds: segment.durationSeconds,
    isUnavailable: false,
    eventType: segment.eventType,
    radiusStateLabel: radiusStateLabel(segment.eventType),
    operationalGroupKey: classification.groupKey,
    operationalGroupLabel: classification.groupName,
    operationalGroupLightColor: classification.groupLightColor,
    operationalGroupDarkColor: classification.groupDarkColor,
    processFamilyKey: classification.familyKey,
    processFamilyLabel: classification.familyName,
    classificationStatus: classification.needsClassification ? 'needs_classification' : 'mapped',
  }
}

function largestNonProductionState(states: OverviewRadiusStateAllocation[]): OverviewRadiusStateAllocation | null {
  return [...states]
    .filter(({ nonProductionSeconds }) => nonProductionSeconds > 0)
    .sort((left, right) => right.nonProductionSeconds - left.nonProductionSeconds || left.displayLabel.localeCompare(right.displayLabel))[0] ?? null
}

function initialPressAllocation(press: RadiusOverview['presses'][number]): OverviewPressAllocation {
  const radiusSegments = press.timelineSegments.filter((segment): segment is RadiusStateSegment => segment.kind === 'radius')
  const aggregate = aggregateSegments(radiusSegments)
  const wallClockSeconds = Math.max(0, press.rangeSeconds)
  const observedSeconds = Math.min(wallClockSeconds, aggregate.observedSeconds)
  const unavailableSeconds = Math.max(0, wallClockSeconds - observedSeconds)
  const coveragePercent = percent(observedSeconds, wallClockSeconds) ?? 0
  const rankingExclusionReason = coveragePercent < OVERVIEW_MINIMUM_COVERAGE_PERCENT
    ? 'coverage_below_80_percent'
    : observedSeconds < OVERVIEW_MINIMUM_OBSERVED_SECONDS
      ? 'observed_time_below_30_minutes'
      : null
  const radiusStates = stateBreakdown(aggregate)
  const largestState = largestNonProductionState(radiusStates)
  return {
    pressKey: press.pressKey,
    displayName: press.displayName,
    wallClockSeconds,
    observedSeconds,
    unavailableSeconds,
    coveragePercent,
    productionSeconds: aggregate.productionSeconds,
    productionSharePercent: percent(aggregate.productionSeconds, observedSeconds),
    nonProductionSeconds: Math.max(0, observedSeconds - aggregate.productionSeconds),
    nonProductionSharePercent: percent(Math.max(0, observedSeconds - aggregate.productionSeconds), observedSeconds),
    fleetProductionRank: null,
    productionDeltaVsFleetMedianPoints: null,
    rankingEligible: rankingExclusionReason === null,
    rankingExclusionReason,
    classificationCoveragePercent: percent(observedSeconds - aggregate.needsClassificationSeconds, observedSeconds) ?? 0,
    needsClassificationSeconds: aggregate.needsClassificationSeconds,
    largestNonProductionRadiusStateEventType: largestState?.eventType ?? null,
    radiusStateBreakdown: radiusStates,
    timelineIntervals: press.timelineSegments.map(timelineInterval),
  }
}

function durationLabel(seconds: number): string {
  const hours = Math.floor(seconds / 3_600)
  const minutes = Math.round((seconds % 3_600) / 60)
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`
}

function points(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)} pp`
}

function selectedState(press: OverviewPressAllocation): OverviewRadiusStateAllocation | null {
  return press.radiusStateBreakdown.find(({ eventType }) => eventType === press.largestNonProductionRadiusStateEventType) ?? null
}

function selectedGroup(state: OverviewRadiusStateAllocation | null): OverviewGroupAllocation | null {
  return state?.operationalGroups.find(({ key }) => key === state.largestNonProductionGroupKey) ?? null
}

function selectedFamily(state: OverviewRadiusStateAllocation | null, group: OverviewGroupAllocation | null): OverviewFamilyAllocation | null {
  return group?.families.find(({ key }) => key === state?.largestNonProductionFamilyKey) ?? null
}

export function buildOverviewDecisionSupport(overview: RadiusOverview): OverviewDecisionSupport {
  const pressAllocations = overview.presses.map(initialPressAllocation)
  const eligible = pressAllocations
    .filter(({ rankingEligible, productionSharePercent }) => rankingEligible && productionSharePercent !== null)
    .sort((left, right) => (right.productionSharePercent ?? 0) - (left.productionSharePercent ?? 0) || left.displayName.localeCompare(right.displayName, undefined, { numeric: true }))
  const productionMedian = median(eligible.map(({ productionSharePercent }) => productionSharePercent ?? 0))
  eligible.forEach((press, index) => {
    press.fleetProductionRank = index + 1
    press.productionDeltaVsFleetMedianPoints = productionMedian === null || press.productionSharePercent === null ? null : press.productionSharePercent - productionMedian
  })

  const fleetSegments = overview.presses.flatMap(({ timelineSegments }) => timelineSegments.filter((segment): segment is RadiusStateSegment => segment.kind === 'radius'))
  const fleetAggregate = aggregateSegments(fleetSegments)
  const fleetRadiusStateBreakdown = stateBreakdown(fleetAggregate)
  const fleetObservedSeconds = pressAllocations.reduce((sum, press) => sum + press.observedSeconds, 0)
  const fleetWallClockSeconds = pressAllocations.reduce((sum, press) => sum + press.wallClockSeconds, 0)
  const fleetUnavailableSeconds = Math.max(0, fleetWallClockSeconds - fleetObservedSeconds)
  const fleetLargestState = largestNonProductionState(fleetRadiusStateBreakdown)
  const topRunning = eligible.slice(0, 3)
  const needsAttention = eligible.length <= 1
    ? []
    : [...eligible].sort((left, right) => (left.productionSharePercent ?? 0) - (right.productionSharePercent ?? 0) || left.displayName.localeCompare(right.displayName, undefined, { numeric: true })).slice(0, 3)
  const excluded = pressAllocations.filter(({ rankingEligible }) => !rankingEligible)
  const focusItems: string[] = []
  const top = topRunning[0]
  if (top && top.productionSharePercent !== null && top.productionDeltaVsFleetMedianPoints !== null) {
    focusItems.push(`${top.displayName} has the highest observed Run Production share at ${top.productionSharePercent.toFixed(1)}%, ${points(top.productionDeltaVsFleetMedianPoints)} versus the fleet median.`)
  }
  const bottom = needsAttention[0]
  if (bottom && bottom.productionSharePercent !== null) {
    const state = selectedState(bottom)
    const group = selectedGroup(state)
    focusItems.push(`${bottom.displayName} has the lowest eligible Run Production share at ${bottom.productionSharePercent.toFixed(1)}%.${state ? ` ${state.displayLabel} accounts for the largest share of its remaining observed time${group ? `, with ${group.name} representing the largest semantic portion of that state` : ''}.` : ''}`)
  }
  if (fleetLargestState) {
    const group = selectedGroup(fleetLargestState)
    const family = selectedFamily(fleetLargestState, group)
    focusItems.push(`${fleetLargestState.displayLabel} is the fleet's largest non-production Radius state at ${fleetLargestState.nonProductionShareOfObservedPercent.toFixed(1)}% of observed fleet time.${group ? ` ${group.name} represents the largest semantic portion of ${fleetLargestState.displayLabel} time.` : ''}`)
    if (group && family) focusItems.push(`Within ${group.name}, ${family.name} is the largest process family for the selected ${fleetLargestState.displayLabel} state (${durationLabel(family.durationSeconds)} observed).`)
  }
  const firstExcluded = excluded[0]
  if (firstExcluded) focusItems.push(`${firstExcluded.displayName} is not ranked because ${firstExcluded.rankingExclusionReason === 'coverage_below_80_percent' ? `Radius coverage is ${firstExcluded.coveragePercent.toFixed(1)}%` : `observed time is ${durationLabel(firstExcluded.observedSeconds)}`}.`)
  if (fleetAggregate.needsClassificationSeconds > 0 && focusItems.length < 5) focusItems.push(`${(percent(fleetAggregate.needsClassificationSeconds, fleetObservedSeconds) ?? 0).toFixed(1)}% of observed fleet time needs a published semantic classification; its broad Radius state remains known.`)

  return {
    minimumCoveragePercent: OVERVIEW_MINIMUM_COVERAGE_PERCENT,
    minimumObservedSeconds: OVERVIEW_MINIMUM_OBSERVED_SECONDS,
    classificationVersion: overview.classificationVersion ?? 0,
    fleetSummary: {
      wallClockSeconds: fleetWallClockSeconds,
      observedSeconds: fleetObservedSeconds,
      unavailableSeconds: fleetUnavailableSeconds,
      coveragePercent: percent(fleetObservedSeconds, fleetWallClockSeconds) ?? 0,
      productionSeconds: fleetAggregate.productionSeconds,
      productionSharePercent: percent(fleetAggregate.productionSeconds, fleetObservedSeconds),
      nonProductionSeconds: Math.max(0, fleetObservedSeconds - fleetAggregate.productionSeconds),
      nonProductionSharePercent: percent(Math.max(0, fleetObservedSeconds - fleetAggregate.productionSeconds), fleetObservedSeconds),
      rankablePressCount: eligible.length,
      pressCount: pressAllocations.length,
      productionMedianPercent: productionMedian,
      classificationCoveragePercent: percent(fleetObservedSeconds - fleetAggregate.needsClassificationSeconds, fleetObservedSeconds) ?? 0,
      needsClassificationSeconds: fleetAggregate.needsClassificationSeconds,
      largestNonProductionRadiusStateEventType: fleetLargestState?.eventType ?? null,
    },
    pressAllocations,
    rankingPressKeys: eligible.map(({ pressKey }) => pressKey),
    topRunningPressKeys: topRunning.map(({ pressKey }) => pressKey),
    needsAttentionPressKeys: needsAttention.map(({ pressKey }) => pressKey),
    fleetRadiusStateBreakdown,
    focusItems: focusItems.slice(0, 5),
    excludedPressKeys: excluded.map(({ pressKey }) => pressKey),
  }
}
