import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildRadiusAvailabilityTimeline,
  deriveCurrentRadiusAvailability,
  deriveRadiusFeedStatus,
  summarizeAvailabilityMetrics,
} from '../src/radius/availability-engine.js'
import {
  clipSegmentsToRange,
  deriveOperationalEpisodes,
} from '../src/episodes/episode-engine.js'
import type {
  RadiusObservation,
  RadiusPressMapping,
  RadiusStatusSegment,
} from '../src/radius/models.js'

const mapping: RadiusPressMapping = {
  pressKey: 'press6',
  displayName: 'Press 6',
  machineId: 9006,
}
const production = 'Run Production'
const start = '2026-08-10T00:00:00.000Z'

function plus(seconds: number): string {
  return new Date(Date.parse(start) + seconds * 1_000).toISOString()
}

function observation(
  seconds: number,
  statusDescription = production,
  eventType = statusDescription === production ? 'G' : 'M',
  machineId = mapping.machineId,
): RadiusObservation {
  return {
    machineId,
    eventType,
    statusCode: statusDescription === production ? '150' : null,
    statusDescription,
    fetchedAtUtc: plus(seconds),
    sourceGeneration: 'legacy',
  }
}

function timeline(
  observations: RadiusObservation[],
  endSeconds: number,
  fromSeconds = 0,
): RadiusStatusSegment[] {
  return buildRadiusAvailabilityTimeline(
    observations,
    mapping,
    production,
    plus(fromSeconds),
    plus(endSeconds),
    180,
  )
}

test('60-second polling remains online', () => {
  assert.equal(timeline([observation(0), observation(60)], 120).some(({ kind }) => kind === 'offline'), false)
})

test('120-second gap remains online with a 180-second threshold', () => {
  assert.equal(timeline([observation(0), observation(120)], 150).some(({ kind }) => kind === 'offline'), false)
})

test('179.999-second gap remains online', () => {
  assert.equal(timeline([observation(0), observation(179.999)], 180).some(({ kind }) => kind === 'offline'), false)
})

test('exactly 180 seconds remains online because stale age must be strictly greater', () => {
  assert.equal(timeline([observation(0), observation(180)], 180).some(({ kind }) => kind === 'offline'), false)
})

test('freshness-aware current status is online at exactly the threshold', () => {
  const current = deriveCurrentRadiusAvailability(
    [observation(0)],
    plus(180),
    start,
    180,
    production,
  )
  assert.equal(current.availability, 'online')
  assert.equal(current.currentStatusDescription, production)
  assert.equal(current.offlineSinceUtc, null)
})

test('stale current status is hidden while preserving the last known Radius status', () => {
  const current = deriveCurrentRadiusAvailability(
    [observation(0)],
    plus(181),
    start,
    180,
    production,
  )
  assert.equal(current.availability, 'offline')
  assert.equal(current.currentStatusDescription, null)
  assert.equal(current.lastRadiusStatus?.statusDescription, production)
  assert.equal(current.offlineSinceUtc, plus(180))
})

test('181-second gap creates an OFFLINE segment', () => {
  const segments = timeline([observation(0), observation(181)], 182)
  assert.equal(segments.filter(({ kind }) => kind === 'offline').length, 1)
})

test('OFFLINE begins at last observation plus the threshold', () => {
  const offline = timeline([observation(0), observation(181)], 182).find(({ kind }) => kind === 'offline')
  assert.equal(offline?.startUtc, plus(180))
})

test('OFFLINE ends at the next observation', () => {
  const offline = timeline([observation(0), observation(181)], 182).find(({ kind }) => kind === 'offline')
  assert.equal(offline?.endUtc, plus(181))
  assert.equal(offline?.isOpen, false)
})

test('a currently stale source creates an open OFFLINE segment', () => {
  const offline = timeline([observation(0)], 600).at(-1)
  assert.equal(offline?.kind, 'offline')
  assert.equal(offline?.isOpen, true)
  assert.equal(offline?.endUtc, plus(600))
})

test('Run Production before an outage is not extended through the outage', () => {
  const segments = timeline([observation(0)], 600)
  assert.equal(segments[0].kind, 'radius')
  assert.equal(segments[0].endUtc, plus(180))
  assert.equal(segments[1].kind, 'offline')
})

test('a non-production episode interrupted by an outage is DATA_INTERRUPTED', () => {
  const segments = timeline([observation(0, 'Make Ready')], 600)
  const [episode] = deriveOperationalEpisodes(segments, mapping, start, plus(600))
  assert.equal(episode.completionStatus, 'DATA_INTERRUPTED')
  assert.equal(episode.dataInterrupted, true)
  assert.equal(episode.endUtc, plus(180))
  assert.equal(episode.durationSeconds, 180)
  assert.deepEqual(episode.displaySegments.map(({ kind }) => kind), ['radius', 'offline'])
  assert.equal(episode.displaySegments.at(-1)?.startUtc, plus(180))
  assert.equal(episode.displaySegments.at(-1)?.endUtc, plus(600))
  assert.equal(episode.displaySegments.at(-1)?.durationSeconds, 420)
  assert.equal(episode.displayEndUtc, plus(600))
  assert.equal(episode.observedDurationSeconds, 180)
  assert.equal(episode.unavailableDurationSeconds, 420)
  assert.equal(episode.wallClockDurationSeconds, 600)
  assert.deepEqual(episode.timeByStatusDescription, { 'Make Ready': 180 })
})

test('OFFLINE seconds are excluded from non-production seconds', () => {
  const segments = timeline([observation(0, 'Make Ready')], 600)
  const metrics = summarizeAvailabilityMetrics(segments, 600)
  assert.equal(metrics.nonProductionSeconds, 180)
  assert.equal(metrics.offlineSeconds, 420)
})

test('OFFLINE seconds are excluded from production seconds', () => {
  const segments = timeline([observation(0)], 600)
  const metrics = summarizeAvailabilityMetrics(segments, 600)
  assert.equal(metrics.runProductionSeconds, 180)
  assert.equal(metrics.offlineSeconds, 420)
})

test('an OFFLINE period cannot satisfy production confirmation', () => {
  const segments = timeline([
    observation(0, 'Make Ready'),
    observation(60, production),
    observation(600, production),
  ], 960)
  const episodes = deriveOperationalEpisodes(segments, mapping, start, plus(960))
  assert.equal(episodes[0].completionStatus, 'DATA_INTERRUPTED')
  assert.equal(episodes[0].confirmedProductionStartUtc, null)
})

test('recovery to non-production creates a new uncertain post-gap episode', () => {
  const segments = timeline([
    observation(0, 'Make Ready'),
    observation(600, 'Bad', 'B'),
  ], 700)
  const episodes = deriveOperationalEpisodes(segments, mapping, start, plus(700))
  assert.equal(episodes.length, 2)
  assert.equal(episodes[0].completionStatus, 'DATA_INTERRUPTED')
  assert.equal(episodes[0].displaySegments.at(-1)?.kind, 'offline')
  assert.equal(episodes[0].displayEndUtc, plus(600))
  assert.equal(episodes[1].startedAfterDataGap, true)
  assert.equal(episodes[1].startUtc, plus(600))
  assert.equal(episodes[1].displaySegments.some(({ kind }) => kind === 'offline'), false)
})

test('multiple gaps attach each unavailable span only to its pre-gap episode', () => {
  const segments = timeline([
    observation(0, 'Make Ready'),
    observation(600, 'Bad', 'B'),
    observation(1_200, 'Make Ready'),
  ], 1_300)
  const episodes = deriveOperationalEpisodes(segments, mapping, start, plus(1_300))
  assert.equal(episodes.length, 3)
  assert.deepEqual(episodes.slice(0, 2).map((episode) => episode.displaySegments.at(-1)?.kind), ['offline', 'offline'])
  assert.deepEqual(episodes.slice(0, 2).map(({ displayEndUtc }) => displayEndUtc), [plus(600), plus(1_200)])
  assert.equal(episodes[2].startedAfterDataGap, true)
  assert.equal(episodes[2].displaySegments.some(({ kind }) => kind === 'offline'), false)
})

test('recovery to Run Production starts fresh and does not close the pre-gap episode normally', () => {
  const segments = timeline([
    observation(0, 'Make Ready'),
    observation(600, production),
    observation(780, production),
    observation(900, production),
  ], 901)
  const episodes = deriveOperationalEpisodes(segments, mapping, start, plus(901))
  assert.equal(episodes.length, 1)
  assert.equal(episodes[0].completionStatus, 'DATA_INTERRUPTED')
})

test('all mapped presses stale produces fleet OFFLINE', () => {
  assert.equal(deriveRadiusFeedStatus(Array(12).fill('offline')), 'OFFLINE')
})

test('one stale press out of twelve produces fleet DEGRADED', () => {
  assert.equal(deriveRadiusFeedStatus(['offline', ...Array(11).fill('online')]), 'DEGRADED')
})

test('all expected mapped presses fresh produces fleet ONLINE', () => {
  assert.equal(deriveRadiusFeedStatus(Array(12).fill('online')), 'ONLINE')
})

test('feed OFFLINE is a derived state distinct from database health', () => {
  const databaseHealth = 'healthy'
  const feedStatus = deriveRadiusFeedStatus(['offline'])
  assert.equal(databaseHealth, 'healthy')
  assert.equal(feedStatus, 'OFFLINE')
})

test('a selected range entirely inside an historical outage renders OFFLINE coverage', () => {
  const segments = timeline([observation(0)], 600)
  const visible = clipSegmentsToRange(segments, plus(300), plus(480))
  assert.equal(visible.length, 1)
  assert.equal(visible[0].kind, 'offline')
  assert.equal(visible[0].durationSeconds, 180)
  assert.equal(summarizeAvailabilityMetrics(visible, 180).dataCoveragePercent, 0)
})

test('the deterministic twelve-machine incident fixture is fully OFFLINE at the evaluation time', () => {
  const mappings: RadiusPressMapping[] = [3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].map(
    (press, index) => ({
      pressKey: `press${press}` as RadiusPressMapping['pressKey'],
      displayName: `Press ${press}`,
      machineId: 9_000 + index,
    }),
  )
  const lastObservationUtc = '2026-08-10T14:27:52.383Z'
  const evaluationUtc = '2026-08-11T02:19:42.000Z'
  const expectedOfflineStart = '2026-08-10T14:30:52.383Z'
  const availabilities = mappings.map((press) => {
    const segments = buildRadiusAvailabilityTimeline(
      [{
        machineId: press.machineId,
        eventType: 'G',
        statusCode: null,
        statusDescription: production,
        fetchedAtUtc: lastObservationUtc,
        sourceGeneration: 'legacy',
      }],
      press,
      production,
      lastObservationUtc,
      evaluationUtc,
      180,
    )
    const offline = segments.at(-1)
    assert.equal(offline?.kind, 'offline')
    assert.equal(offline?.startUtc, expectedOfflineStart)
    assert.equal(offline?.isOpen, true)
    return offline?.kind === 'offline' ? 'offline' as const : 'online' as const
  })
  assert.equal(availabilities.length, 12)
  assert.equal(deriveRadiusFeedStatus(availabilities), 'OFFLINE')
})
