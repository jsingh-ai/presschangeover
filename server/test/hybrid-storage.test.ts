import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildRadiusAvailabilityTimeline,
  deriveCurrentRadiusAvailability,
  deriveRadiusFeedStatusFromPoll,
} from '../src/radius/availability-engine.js'
import { deriveOperationalEpisodes } from '../src/episodes/episode-engine.js'
import type {
  RadiusObservation,
  RadiusPollRun,
  RadiusPressMapping,
} from '../src/radius/models.js'

const mapping: RadiusPressMapping = {
  pressKey: 'press13',
  displayName: 'Press 13',
  machineId: 213,
}
const production = 'Run Production'

function state(
  fetchedAtUtc: string,
  statusDescription = production,
  eventType = statusDescription === production ? 'G' : 'M',
): RadiusObservation {
  return {
    machineId: 213,
    fetchedAtUtc,
    statusDescription,
    eventType,
    statusCode: statusDescription === production ? '150' : null,
    sourceGeneration: Date.parse(fetchedAtUtc) < Date.parse('2026-08-10T14:29:00.415Z')
      ? 'legacy'
      : 'compact',
  }
}

function heartbeat(fetchedAtUtc: string, machineCount = 12): RadiusPollRun {
  return {
    fetchedAtUtc,
    machineCount,
    changedMachineCount: 0,
    staleMachineCount: machineCount < 12 ? 12 - machineCount : 0,
  }
}

function minuteHeartbeats(startUtc: string, minutes: number): RadiusPollRun[] {
  const startMs = Date.parse(startUtc)
  return Array.from({ length: minutes + 1 }, (_, index) =>
    heartbeat(new Date(startMs + index * 60_000).toISOString()),
  )
}

test('legacy-only range reconstructs snapshot state without compact events', () => {
  const startUtc = '2026-08-10T13:00:00.000Z'
  const observations = [state(startUtc), state('2026-08-10T13:01:00.000Z')]
  const segments = buildRadiusAvailabilityTimeline(
    observations, mapping, production, startUtc,
    '2026-08-10T13:02:00.000Z', 180,
  )
  assert.equal(segments.length, 1)
  assert.equal(segments[0].kind, 'radius')
})

test('events-only range uses sparse transitions while poll runs prove continuity', () => {
  const startUtc = '2026-08-10T15:00:00.000Z'
  const segments = buildRadiusAvailabilityTimeline(
    [state(startUtc), state('2026-08-10T16:00:00.000Z', 'Make Ready')],
    mapping, production, startUtc, '2026-08-10T17:00:00.000Z', 180,
    minuteHeartbeats(startUtc, 120),
  )
  assert.equal(segments.some(({ kind }) => kind === 'offline'), false)
  assert.equal(segments.length, 2)
  assert.equal(
    segments.every(({ sourceGeneration }) => sourceGeneration === 'compact'),
    true,
  )
})

test('range crossing the exact cutover has no artificial OFFLINE span', () => {
  const legacyLast = '2026-08-10T14:27:52.383Z'
  const cutover = '2026-08-10T14:29:00.415Z'
  const segments = buildRadiusAvailabilityTimeline(
    [state(legacyLast), state(cutover)], mapping, production,
    legacyLast, '2026-08-10T14:31:00.415Z', 180,
    [heartbeat(legacyLast), heartbeat(cutover), heartbeat('2026-08-10T14:30:00.700Z')],
  )
  assert.equal(segments.some(({ kind }) => kind === 'offline'), false)
  assert.equal(
    segments.some(({ sourceGeneration }) => sourceGeneration === 'hybrid'),
    true,
  )
})

test('legacy final state carries into compact time until the first real event', () => {
  const startUtc = '2026-08-10T14:27:52.383Z'
  const segments = buildRadiusAvailabilityTimeline(
    [state(startUtc, 'Make Ready'), state('2026-08-10T16:00:00.000Z', production)],
    mapping, production, startUtc, '2026-08-10T16:01:00.000Z', 180,
    [heartbeat(startUtc), ...minuteHeartbeats('2026-08-10T14:29:00.000Z', 92)],
  )
  const first = segments[0]
  assert.equal(first.kind, 'radius')
  assert.equal(first.statusDescription, 'Make Ready')
  assert.equal(first.endUtc, '2026-08-10T16:00:00.000Z')
})

test('two hours without an event remains online when poll runs are healthy', () => {
  const startUtc = '2026-08-10T15:00:00.000Z'
  const segments = buildRadiusAvailabilityTimeline(
    [state(startUtc)], mapping, production, startUtc,
    '2026-08-10T17:00:00.000Z', 180,
    minuteHeartbeats(startUtc, 120),
  )
  assert.equal(segments.length, 1)
  assert.equal(segments[0].kind, 'radius')
  assert.equal(segments[0].durationSeconds, 7_200)
})

test('legacy table stopping does not make the compact feed offline', () => {
  const legacyLast = '2026-08-10T14:27:52.383Z'
  const compactFirst = '2026-08-10T14:29:00.415Z'
  const segments = buildRadiusAvailabilityTimeline(
    [state(legacyLast), state(compactFirst)], mapping, production,
    legacyLast, '2026-08-10T15:29:00.415Z', 180,
    [heartbeat(legacyLast), ...minuteHeartbeats(compactFirst, 60)],
  )
  assert.equal(segments.some(({ kind }) => kind === 'offline'), false)
})

test('actual August 10 collector outage is OFFLINE only after the stale boundary', () => {
  const lastPoll = '2026-08-10T22:07:37.728Z'
  const recovery = '2026-08-11T02:36:11.056Z'
  const segments = buildRadiusAvailabilityTimeline(
    [state('2026-08-10T22:00:00.000Z')], mapping, production,
    lastPoll, '2026-08-11T02:37:11.056Z', 180,
    [heartbeat(lastPoll), heartbeat(recovery)],
  )
  const offline = segments.find(({ kind }) => kind === 'offline')
  assert.equal(offline?.startUtc, '2026-08-10T22:10:37.728Z')
  assert.equal(offline?.endUtc, recovery)
  assert.equal(offline?.sourceGeneration, 'offline_inference')
  assert.equal(offline?.durationSeconds, 15_933.328)
})

test('current status comes from machine_status_current while poll freshness drives availability', () => {
  const currentState = state('2026-08-10T20:00:00.000Z', 'Make Ready')
  const current = deriveCurrentRadiusAvailability(
    [], '2026-08-10T22:02:00.000Z', '2026-08-10T00:00:00.000Z',
    180, production, '2026-08-10T22:01:00.000Z', currentState, true,
  )
  assert.equal(current.availability, 'online')
  assert.equal(current.currentStatusDescription, 'Make Ready')
  assert.equal(current.lastObservationUtc, '2026-08-10T22:01:00.000Z')
})

test('poll-run coverage and age determine fleet feed status', () => {
  const evaluation = '2026-08-10T22:02:00.000Z'
  assert.equal(deriveRadiusFeedStatusFromPoll(heartbeat('2026-08-10T22:01:00.000Z'), evaluation, 180, 12), 'ONLINE')
  assert.equal(deriveRadiusFeedStatusFromPoll(heartbeat('2026-08-10T22:01:00.000Z', 11), evaluation, 180, 12), 'DEGRADED')
  assert.equal(deriveRadiusFeedStatusFromPoll(heartbeat('2026-08-10T21:00:00.000Z'), evaluation, 180, 12), 'OFFLINE')
})

test('a machine absent from a fresh partial poll is offline from that poll', () => {
  const current = deriveCurrentRadiusAvailability(
    [state('2026-08-10T21:00:00.000Z', 'Make Ready')],
    '2026-08-10T22:02:00.000Z', '2026-08-10T00:00:00.000Z', 180,
    production, '2026-08-10T22:01:00.000Z', null, false,
  )
  assert.equal(current.availability, 'offline')
  assert.equal(current.offlineSinceUtc, '2026-08-10T22:01:00.000Z')
  assert.equal(current.lastRadiusStatus?.statusDescription, 'Make Ready')
})

test('five-minute episode confirmation works across compact event spans', () => {
  const fromUtc = '2026-08-10T15:00:00.000Z'
  const segments = buildRadiusAvailabilityTimeline(
    [state(fromUtc, 'Make Ready'), state('2026-08-10T15:10:00.000Z')],
    mapping, production, fromUtc, '2026-08-10T15:16:00.000Z', 180,
    minuteHeartbeats(fromUtc, 16),
  )
  const [episode] = deriveOperationalEpisodes(segments, mapping, fromUtc, '2026-08-10T15:16:00.000Z')
  assert.equal(episode.completionStatus, 'CONFIRMED_PRODUCTION')
  assert.equal(episode.endUtc, '2026-08-10T15:10:00.000Z')
})

test('a genuine poll outage interrupts a compact operational episode', () => {
  const fromUtc = '2026-08-10T17:00:00.000Z'
  const segments = buildRadiusAvailabilityTimeline(
    [state(fromUtc, 'Make Ready')], mapping, production, fromUtc,
    '2026-08-10T17:20:00.000Z', 180,
    [heartbeat(fromUtc), heartbeat('2026-08-10T17:01:00.000Z')],
  )
  const [episode] = deriveOperationalEpisodes(segments, mapping, fromUtc, '2026-08-10T17:20:00.000Z')
  assert.equal(episode.completionStatus, 'DATA_INTERRUPTED')
  assert.equal(episode.endUtc, '2026-08-10T17:04:00.000Z')
})

test('matching legacy and seed event states do not duplicate the cutover segment', () => {
  const legacyLast = '2026-08-10T14:27:52.383Z'
  const cutover = '2026-08-10T14:29:00.415Z'
  const segments = buildRadiusAvailabilityTimeline(
    [state(legacyLast), state(cutover)], mapping, production,
    legacyLast, '2026-08-10T14:31:00.415Z', 180,
    [heartbeat(legacyLast), heartbeat(cutover), heartbeat('2026-08-10T14:30:00.415Z')],
  )
  assert.equal(segments.length, 1)
  assert.equal(segments[0].kind, 'radius')
})

test('production requires the verified G / 150 / Run Production identity', () => {
  const startUtc = '2026-08-10T15:00:00.000Z'
  const wrongType = buildRadiusAvailabilityTimeline(
    [state(startUtc, production, 'M')], mapping, production, startUtc,
    '2026-08-10T15:01:00.000Z', 180, [heartbeat(startUtc)],
  )[0]
  assert.equal(wrongType.kind === 'radius' && wrongType.isProduction, false)
  const wrongCode = buildRadiusAvailabilityTimeline(
    [{ ...state(startUtc), statusCode: '20' }], mapping, production, startUtc,
    '2026-08-10T15:01:00.000Z', 180, [heartbeat(startUtc)],
  )[0]
  assert.equal(wrongCode.kind === 'radius' && wrongCode.isProduction, false)
})
