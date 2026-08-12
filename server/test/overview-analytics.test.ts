import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { exactRadiusIdentity } from '../src/radius/radius-identity.js'
import {
  buildOverviewDecisionSupport,
  isCanonicalOverviewProduction,
  median,
} from '../src/radius/overview-analytics.js'
import type { RadiusOverview, RadiusPressKey, RadiusStateSegment, RadiusStatusSegment } from '../src/radius/models.js'
import { SEEDED_OPERATIONAL_GROUPS, SEEDED_PROCESS_FAMILIES } from '../src/classification/seeds.js'
import type { OperationalGroupKey, ProcessFamilyKey, ResolvedRadiusClassification } from '../src/classification/models.js'

interface StateInput {
  duration: number
  eventType?: string
  code?: string | null
  description?: string
  group?: OperationalGroupKey
  family?: ProcessFamilyKey
  offline?: boolean
  fallback?: boolean
}

function classification(input: StateInput): ResolvedRadiusClassification {
  const group = SEEDED_OPERATIONAL_GROUPS.find(({ key }) => key === (input.group ?? 'CHANGEOVER_SETUP'))!
  const family = SEEDED_PROCESS_FAMILIES.find(({ key }) => key === (input.family ?? 'MAKE_READY'))!
  const identity = exactRadiusIdentity({ eventType: input.eventType ?? 'M', statusCode: input.code ?? '16', statusDescription: input.description ?? 'Make Ready' })
  return {
    identity, eventType: input.eventType ?? 'M', statusCode: input.code ?? '16', statusDescription: input.description ?? 'Make Ready',
    operationalGroupId: group.id, operationalGroupKey: group.key, operationalGroupName: group.displayName,
    operationalGroupDescription: group.description, operationalGroupLightColor: group.lightColor,
    operationalGroupDarkColor: group.darkColor, operationalGroupIcon: group.icon,
    processFamilyId: family.id, processFamilyKey: family.key, processFamilyName: family.displayName,
    displayLabel: null, explanation: '', confidence: input.fallback ? 'LOW' : 'HIGH', needsReview: Boolean(input.fallback),
    defaultTimelineVisibility: true, obsolete: false, mappingVersion: 4, isFallback: Boolean(input.fallback),
  }
}

function press(pressKey: RadiusPressKey, states: StateInput[], wallClockSeconds = 3_600) {
  let cursor = Date.parse('2026-08-11T12:00:00.000Z')
  const timelineSegments: RadiusStatusSegment[] = states.map((input) => {
    const startUtc = new Date(cursor).toISOString()
    cursor += input.duration * 1_000
    const common = { machineId: Number(pressKey.slice(5)), pressKey, displayName: `Press ${pressKey.slice(5)}`, startUtc, endUtc: new Date(cursor).toISOString(), durationSeconds: input.duration, isOpen: false }
    if (input.offline) return { ...common, kind: 'offline' as const, eventType: null, statusCode: null, statusDescription: null, isProduction: false, sourceGeneration: 'offline_inference' as const }
    const segment = {
      ...common, kind: 'radius' as const, eventType: input.eventType ?? 'M', statusCode: input.code ?? '16',
      statusDescription: input.description ?? 'Make Ready', isProduction: false, sourceGeneration: 'compact' as const,
      classification: classification(input),
    }
    return segment
  })
  return {
    pressKey, displayName: `Press ${pressKey.slice(5)}`, radiusMachineId: Number(pressKey.slice(5)), availability: 'online' as const,
    lastRadiusStatus: null, lastObservationUtc: null, offlineSinceUtc: null, currentStatusDescription: null, currentEventType: null,
    currentStatusAtUtc: null, isCurrentlyProduction: null, runProductionSeconds: 0, nonProductionSeconds: 0,
    offlineSeconds: 0, observedSeconds: 0, rangeSeconds: wallClockSeconds, dataCoveragePercent: 0,
    episodeCount: 0, openEpisodeCount: 0, longestEpisodeSeconds: 0, timelineSegments,
  }
}

function overview(presses: ReturnType<typeof press>[]): RadiusOverview {
  return {
    fromUtc: '2026-08-11T12:00:00.000Z', toUtc: '2026-08-11T13:00:00.000Z', plantTimeZone: 'America/Chicago',
    productionStatusDescription: 'Run Production', stateBreakdownRunConfirmationSeconds: 120, rangeEndIsLive: false,
    feedStatus: 'ONLINE', lastObservationUtc: null, offlinePressCount: 0, onlinePressCount: presses.length,
    summary: { pressesMonitored: presses.length, currentlyRunProduction: 0, currentlyNonProduction: 0, openEpisodes: 0, totalNonProductionSeconds: 0 },
    unmappedPressKeys: [], presses, episodeAnalysis: { sequenceFamilies: [] }, operationalAnalytics: {} as RadiusOverview['operationalAnalytics'],
    classificationVersion: 4, operationalGroups: SEEDED_OPERATIONAL_GROUPS,
  }
}

const production = (duration: number, code = '150'): StateInput => ({ duration, eventType: 'G', code, description: 'Run Production', group: 'PRODUCTION', family: 'PRODUCTION' })
const setup = (duration: number): StateInput => ({ duration, eventType: 'M', code: '16', description: 'Make Ready', group: 'CHANGEOVER_SETUP', family: 'MAKE_READY' })

describe('Overview decision-support accounting', () => {
  it('uses the Good event type as the single Run Production identity on Overview', () => {
    assert.equal(isCanonicalOverviewProduction({ eventType: 'G', statusDescription: 'Run Production' }), true)
    assert.equal(isCanonicalOverviewProduction({ eventType: 'B', statusDescription: 'Run Production' }), false)
    assert.equal(isCanonicalOverviewProduction({ eventType: 'G', statusDescription: 'Run' }), true)
    assert.equal(buildOverviewDecisionSupport(overview([press('press3', [production(3_600, 'unexpected-code')])])).pressAllocations[0].productionSeconds, 3_600)
  })

  it('uses observed Radius time, not wall clock, for production share', () => {
    const result = buildOverviewDecisionSupport(overview([press('press3', [production(1_800), setup(900), { duration: 900, offline: true }])]))
    assert.equal(result.pressAllocations[0].productionSharePercent, 66.66666666666666)
  })

  it('excludes unavailable time from every Radius-state percentage while retaining it in coverage', () => {
    const allocation = buildOverviewDecisionSupport(overview([press('press3', [production(1_800), { duration: 1_800, offline: true }])])).pressAllocations[0]
    assert.equal(allocation.productionSharePercent, 100)
    assert.equal(allocation.radiusStateBreakdown.find(({ eventType }) => eventType === 'G')?.shareOfObservedPercent, 100)
    assert.equal(allocation.unavailableSeconds, 1_800)
    assert.equal(allocation.coveragePercent, 50)
  })

  it('derives Run Production, Make Ready, Bad, and Safety only from event type', () => {
    const result = buildOverviewDecisionSupport(overview([press('press3', [
      production(900), setup(900),
      { duration: 900, eventType: 'B', code: '95', description: 'Press Problem / Impression', group: 'ADJUSTMENT_QUALITY', family: 'IMPRESSION_REGISTER_PRINT_QUALITY' },
      { duration: 900, eventType: 'S', code: '1', description: 'Safety', group: 'WAITING_IDLE_HOLD', family: 'UNKNOWN' },
    ])])).pressAllocations[0]
    assert.deepEqual(result.radiusStateBreakdown.map(({ eventType, displayLabel }) => [eventType, displayLabel]), [['G', 'Run Production'], ['M', 'Make Ready'], ['B', 'Bad'], ['S', 'Safety']])
    assert.deepEqual(result.radiusStateBreakdown.map(({ durationSeconds }) => durationSeconds), [900, 900, 900, 900])
  })

  it('equates every Good identity with Run Production for Overview accounting', () => {
    const otherGood: StateInput = { duration: 1_800, eventType: 'G', code: '20', description: 'Run', group: 'PRODUCTION', family: 'PRODUCTION' }
    const allocation = buildOverviewDecisionSupport(overview([press('press3', [production(1_800), otherGood])])).pressAllocations[0]
    const good = allocation.radiusStateBreakdown[0]
    assert.equal(good.durationSeconds, 3_600)
    assert.equal(good.canonicalProductionSeconds, 3_600)
    assert.equal(allocation.productionSharePercent, 100)
    assert.equal(allocation.radiusStateBreakdown.find(({ eventType }) => eventType === 'S')?.durationSeconds, 0)
  })

  it('calculates coverage as observed divided by selected wall-clock opportunity', () => {
    const allocation = buildOverviewDecisionSupport(overview([press('press3', [setup(2_880), { duration: 720, offline: true }])])).pressAllocations[0]
    assert.equal(allocation.coveragePercent, 80)
    assert.equal(allocation.rankingEligible, true)
  })

  it('excludes a press below 80 percent coverage from ranking', () => {
    const result = buildOverviewDecisionSupport(overview([press('press3', [production(2_879), { duration: 721, offline: true }])]))
    assert.equal(result.rankingPressKeys.length, 0)
    assert.equal(result.excludedPressKeys[0], 'press3')
  })

  it('excludes a press with less than 30 minutes observed time', () => {
    const result = buildOverviewDecisionSupport(overview([press('press3', [production(1_799)], 1_799)]))
    assert.equal(result.pressAllocations[0].rankingExclusionReason, 'observed_time_below_30_minutes')
  })

  it('ranks the top three and bottom three once using production share', () => {
    const shares = [90, 80, 70, 60, 50, 40]
    const keys: RadiusPressKey[] = ['press3', 'press5', 'press6', 'press7', 'press8', 'press9']
    const result = buildOverviewDecisionSupport(overview(keys.map((key, index) => press(key, [production(shares[index] * 36), setup((100 - shares[index]) * 36)]))))
    assert.deepEqual(result.topRunningPressKeys, ['press3', 'press5', 'press6'])
    assert.deepEqual(result.needsAttentionPressKeys, ['press9', 'press8', 'press7'])
  })

  it('uses the median of eligible per-press production shares', () => {
    assert.equal(median([10, 90, 40, 60]), 50)
    const result = buildOverviewDecisionSupport(overview([
      press('press3', [production(3_240), setup(360)]),
      press('press5', [production(1_800), setup(1_800)]),
      press('press6', [production(360), setup(3_240)]),
    ]))
    assert.equal(result.fleetSummary.productionMedianPercent, 50)
  })

  it('finds the largest non-production Radius state, group, and family without changing ranking', () => {
    const adjustment: StateInput = { duration: 1_200, eventType: 'B', code: '95', description: 'Press Problem / Impression', group: 'ADJUSTMENT_QUALITY', family: 'IMPRESSION_REGISTER_PRINT_QUALITY' }
    const result = buildOverviewDecisionSupport(overview([
      press('press3', [production(1_800), setup(1_800)]),
      press('press5', [production(1_800), setup(600), adjustment]),
      press('press6', [production(1_800), adjustment, setup(600)]),
    ]))
    const state = result.pressAllocations[0].radiusStateBreakdown.find(({ eventType }) => eventType === 'M')
    assert.equal(result.pressAllocations[0].largestNonProductionRadiusStateEventType, 'M')
    assert.equal(state?.largestNonProductionGroupKey, 'CHANGEOVER_SETUP')
    assert.equal(state?.largestNonProductionFamilyKey, 'MAKE_READY')
  })

  it('generates deterministic, evidence-limited focus explanations', () => {
    const result = buildOverviewDecisionSupport(overview([
      press('press3', [production(3_000), setup(600)]),
      press('press5', [production(1_800), setup(1_800)]),
    ]))
    assert.match(result.focusItems[0], /^Press 3 has the highest observed Run Production share/)
    assert.match(result.focusItems[1], /^Press 5 has the lowest eligible Run Production share/)
    assert.match(result.focusItems.join(' '), /Make Ready.*semantic portion/)
    assert.doesNotMatch(result.focusItems.join(' '), /caused|root cause|bad machine/i)
  })

  it('places unknown exact mappings in Needs Classification without inventing group or family', () => {
    const unknown: StateInput = { duration: 900, eventType: 'B', code: '999', description: 'New Code', fallback: true }
    const allocation = buildOverviewDecisionSupport(overview([press('press3', [production(2_700), unknown])])).pressAllocations[0]
    const bad = allocation.radiusStateBreakdown.find(({ eventType }) => eventType === 'B')
    const group = bad?.operationalGroups.find(({ needsClassification }) => needsClassification)
    assert.equal(group?.name, 'Needs Classification')
    assert.equal(group?.families[0].name, 'Needs Classification')
    assert.equal(allocation.classificationCoveragePercent, 75)
  })

  it('reconciles broad Radius states, groups, and families exactly without double counting', () => {
    const allocation = buildOverviewDecisionSupport(overview([press('press3', [production(1_500), setup(1_200), { duration: 300, eventType: 'B', code: '999', description: 'New Code', fallback: true }, { duration: 600, offline: true }])])).pressAllocations[0]
    assert.equal(allocation.radiusStateBreakdown.reduce((sum, item) => sum + item.durationSeconds, 0), allocation.observedSeconds)
    for (const state of allocation.radiusStateBreakdown) {
      assert.equal(state.operationalGroups.reduce((sum, group) => sum + group.durationSeconds, 0), state.durationSeconds)
      for (const group of state.operationalGroups) assert.equal(group.families.reduce((sum, family) => sum + family.durationSeconds, 0), group.durationSeconds)
    }
    assert.equal(allocation.productionSeconds + allocation.nonProductionSeconds, allocation.observedSeconds)
  })

  it('ranks fleet press contributions for every operational group and process family', () => {
    const result = buildOverviewDecisionSupport(overview([
      press('press3', [setup(600)]),
      press('press5', [setup(1_800)]),
      press('press7', [setup(900)]),
    ]))
    const makeReady = result.fleetRadiusStateBreakdown.find(({ eventType }) => eventType === 'M')!
    const group = makeReady.operationalGroups.find(({ key }) => key === 'CHANGEOVER_SETUP')!
    assert.deepEqual(group.pressContributions.map(({ pressKey, durationSeconds }) => [pressKey, durationSeconds]), [['press5', 1_800], ['press7', 900], ['press3', 600]])
    assert.deepEqual(group.pressContributions.map(({ shareOfCategoryPercent }) => Number(shareOfCategoryPercent.toFixed(1))), [54.5, 27.3, 18.2])
    assert.deepEqual(group.families[0].pressContributions, group.pressContributions)
  })

  it('counts distinct source identities as supporting metadata without exposing a raw hierarchy level', () => {
    const result = buildOverviewDecisionSupport(overview([press('press3', [
      { ...setup(600), code: '16', description: 'Make Ready' },
      { ...setup(600), code: '17', description: 'Make Ready' },
      { ...setup(600), eventType: 'B', code: '16', description: 'Make Ready' },
    ], 1_800)]))
    const makeReadyStates = result.fleetRadiusStateBreakdown.filter(({ eventType }) => eventType === 'M' || eventType === 'B')
    assert.equal(makeReadyStates.reduce((sum, state) => sum + (state.operationalGroups[0]?.families[0]?.sourceIdentityCount ?? 0), 0), 3)
  })

  it('aggregates the fleet hierarchy from the same press evidence', () => {
    const result = buildOverviewDecisionSupport(overview([
      press('press3', [production(1_800), setup(1_800)]),
      press('press5', [production(900), setup(2_700)]),
    ]))
    assert.equal(result.fleetRadiusStateBreakdown.reduce((sum, state) => sum + state.durationSeconds, 0), 7_200)
    assert.equal(result.fleetRadiusStateBreakdown.find(({ eventType }) => eventType === 'G')?.durationSeconds, 2_700)
    assert.equal(result.fleetRadiusStateBreakdown.find(({ eventType }) => eventType === 'M')?.durationSeconds, 4_500)
  })

  it('emits one aligned canonical interval collection for both timeline tracks', () => {
    const allocation = buildOverviewDecisionSupport(overview([press('press3', [production(900), setup(900), { duration: 900, offline: true }, setup(900)])])).pressAllocations[0]
    assert.equal(allocation.timelineIntervals.length, 4)
    assert.equal(allocation.timelineIntervals.reduce((sum, interval) => sum + interval.durationSeconds, 0), allocation.wallClockSeconds)
    assert.deepEqual(allocation.timelineIntervals.map(({ startUtc, endUtc }) => [startUtc, endUtc]), [
      ['2026-08-11T12:00:00.000Z', '2026-08-11T12:15:00.000Z'],
      ['2026-08-11T12:15:00.000Z', '2026-08-11T12:30:00.000Z'],
      ['2026-08-11T12:30:00.000Z', '2026-08-11T12:45:00.000Z'],
      ['2026-08-11T12:45:00.000Z', '2026-08-11T13:00:00.000Z'],
    ])
    assert.equal(allocation.timelineIntervals[1].radiusStateLabel, 'Make Ready')
    assert.equal(allocation.timelineIntervals[1].operationalGroupLabel, 'Changeover & Setup')
    assert.equal(allocation.timelineIntervals[2].classificationStatus, 'unavailable')
  })

  it('preserves adjacent source durations for presentation-only visual merging', () => {
    const allocation = buildOverviewDecisionSupport(overview([press('press3', [setup(600), setup(600), production(2_400)])])).pressAllocations[0]
    assert.equal(allocation.timelineIntervals.length, 3)
    assert.equal(allocation.timelineIntervals[0].endUtc, allocation.timelineIntervals[1].startUtc)
    assert.equal(allocation.timelineIntervals[0].operationalGroupKey, allocation.timelineIntervals[1].operationalGroupKey)
    assert.equal(allocation.timelineIntervals.reduce((sum, item) => sum + item.durationSeconds, 0), 3_600)
  })

  it('never forward-fills an observed state through a data-unavailable interval', () => {
    const allocation = buildOverviewDecisionSupport(overview([press('press3', [production(900), { duration: 1_800, offline: true }, setup(900)])])).pressAllocations[0]
    assert.equal(allocation.observedSeconds, 1_800)
    assert.equal(allocation.unavailableSeconds, 1_800)
    assert.equal(allocation.productionSharePercent, 50)
  })

  it('handles fully unavailable, fully production, and zero-production presses without fabricated values', () => {
    const result = buildOverviewDecisionSupport(overview([
      press('press3', [{ duration: 3_600, offline: true }]),
      press('press5', [production(3_600)]),
      press('press6', [setup(3_600)]),
    ]))
    assert.equal(result.pressAllocations[0].productionSharePercent, null)
    assert.equal(result.pressAllocations[1].productionSharePercent, 100)
    assert.equal(result.pressAllocations[2].productionSharePercent, 0)
    assert.ok(Number.isFinite(result.fleetSummary.coveragePercent))
  })

  it('handles one eligible press and no eligible presses without contradictory attention ranks', () => {
    const one = buildOverviewDecisionSupport(overview([press('press3', [production(3_600)])]))
    assert.equal(one.topRunningPressKeys.length, 1)
    assert.equal(one.needsAttentionPressKeys.length, 0)
    const none = buildOverviewDecisionSupport(overview([press('press3', [{ duration: 3_600, offline: true }])]))
    assert.equal(none.topRunningPressKeys.length, 0)
    assert.equal(none.needsAttentionPressKeys.length, 0)
    assert.equal(none.fleetSummary.productionMedianPercent, null)
  })

  it('keeps the Overview implementation free of database write statements', () => {
    const source = readFileSync(new URL('../src/radius/overview-analytics.ts', import.meta.url), 'utf8')
    assert.doesNotMatch(source, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|ALTER|CREATE\s+(?:TABLE|INDEX|TRIGGER))\b/i)
  })
})
