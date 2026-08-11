import assert from 'node:assert/strict'
import test from 'node:test'
import {
  compressRadiusObservations,
  decodeEpisodeId,
  deriveOperationalEpisodes,
} from '../src/episodes/episode-engine.js'
import type {
  RadiusPressMapping,
  RadiusStatusSegment,
} from '../src/radius/models.js'

const mapping: RadiusPressMapping = {
  pressKey: 'press6',
  displayName: 'Press 6',
  machineId: 9006,
}
const production = 'Run Production'

function at(time: string): string {
  return `2026-08-10T${time}Z`
}

function segment(
  statusDescription: string,
  start: string,
  end: string,
  eventType = statusDescription === production ? 'G' : 'M',
): RadiusStatusSegment {
  return {
    kind: 'radius',
    machineId: mapping.machineId,
    pressKey: mapping.pressKey,
    displayName: mapping.displayName,
    eventType,
    statusCode: null,
    statusDescription,
    startUtc: at(start),
    endUtc: at(end),
    durationSeconds: (Date.parse(at(end)) - Date.parse(at(start))) / 1_000,
    isProduction: statusDescription === production,
    isOpen: false,
    sourceGeneration: 'legacy',
  }
}

const visibleFrom = at('00:00:00.000')
const visibleTo = at('23:59:59.999')

test('stable ten-minute production closes at the production transition', () => {
  const episodes = deriveOperationalEpisodes(
    [
      segment(production, '08:30:00.000', '08:42:00.000'),
      segment('Make Ready', '08:42:00.000', '08:55:00.000'),
      segment(production, '08:55:00.000', '09:05:00.000'),
    ],
    mapping,
    visibleFrom,
    visibleTo,
  )

  assert.equal(episodes.length, 1)
  assert.equal(episodes[0].endUtc, at('08:55:00.000'))
  assert.equal(episodes[0].durationSeconds, 13 * 60)
  assert.equal(episodes[0].isOpen, false)
})

test('a two-minute return followed by another stop remains one episode', () => {
  const episodes = deriveOperationalEpisodes(
    [
      segment('Make Ready', '08:42:00.000', '08:55:00.000'),
      segment(production, '08:55:00.000', '08:57:00.000'),
      segment('Make Ready', '08:57:00.000', '09:25:00.000'),
      segment(production, '09:25:00.000', '09:35:00.000'),
    ],
    mapping,
    visibleFrom,
    visibleTo,
  )

  assert.equal(episodes.length, 1)
  assert.equal(episodes[0].failedReturnToProductionAttempts, 1)
  assert.equal(episodes[0].returnToProductionAttemptCount, 2)
  assert.equal(episodes[0].endUtc, at('09:25:00.000'))
  const failedAttempt = episodes[0].statusSegments.find(({ returnToProduction }) => returnToProduction === 'failed')
  assert.equal(failedAttempt?.startUtc, at('08:55:00.000'))
  assert.equal(failedAttempt?.endUtc, at('08:57:00.000'))
  assert.equal(failedAttempt?.durationSeconds, 120)
})

test('four minutes fifty-nine seconds does not close before a later stable return', () => {
  const episodes = deriveOperationalEpisodes(
    [
      segment('Bad', '10:00:00.000', '10:10:00.000', 'B'),
      segment(production, '10:10:00.000', '10:14:59.000'),
      segment('Bad', '10:14:59.000', '10:20:00.000', 'B'),
      segment(production, '10:20:00.000', '10:26:00.000'),
    ],
    mapping,
    visibleFrom,
    visibleTo,
  )

  assert.equal(episodes.length, 1)
  assert.equal(episodes[0].failedReturnToProductionAttempts, 1)
  assert.equal(episodes[0].endUtc, at('10:20:00.000'))
})

test('exactly five minutes production closes the episode', () => {
  const [episode] = deriveOperationalEpisodes(
    [
      segment('Safety', '11:00:00.000', '11:10:00.000', 'S'),
      segment(production, '11:10:00.000', '11:15:00.000'),
    ],
    mapping,
    visibleFrom,
    visibleTo,
  )
  assert.equal(episode.isOpen, false)
  assert.equal(episode.endUtc, at('11:10:00.000'))
  assert.equal(episode.confirmedProductionStartUtc, at('11:10:00.000'))
  assert.equal(episode.confirmationSatisfiedUtc, at('11:15:00.000'))
  assert.equal(episode.confirmationDurationSeconds, 300)
  assert.deepEqual(
    episode.statusSegments.at(-1) && {
      startUtc: episode.statusSegments.at(-1)?.startUtc,
      endUtc: episode.statusSegments.at(-1)?.endUtc,
      durationSeconds: episode.statusSegments.at(-1)?.durationSeconds,
      returnToProduction: episode.statusSegments.at(-1)?.returnToProduction,
    },
    {
      startUtc: at('11:10:00.000'),
      endUtc: at('11:15:00.000'),
      durationSeconds: 300,
      returnToProduction: 'confirmed',
    },
  )
})

test('confirmation evidence spans five real minutes without extending episode duration', () => {
  const [episode] = deriveOperationalEpisodes(
    [
      segment('Make Ready', '09:00:00.000', '09:25:00.000'),
      segment(production, '09:25:00.000', '09:36:00.000'),
    ],
    mapping,
    visibleFrom,
    visibleTo,
  )
  const confirmed = episode.statusSegments.at(-1)
  assert.equal(episode.endUtc, at('09:25:00.000'))
  assert.equal(episode.durationSeconds, 25 * 60)
  assert.equal(episode.confirmedProductionStartUtc, at('09:25:00.000'))
  assert.equal(episode.confirmationSatisfiedUtc, at('09:30:00.000'))
  assert.equal(episode.confirmationDurationSeconds, 300)
  assert.equal(confirmed?.startUtc, at('09:25:00.000'))
  assert.equal(confirmed?.endUtc, at('09:30:00.000'))
  assert.equal(confirmed?.durationSeconds, 300)
})

test('four minutes 59.999 seconds production remains open', () => {
  const [episode] = deriveOperationalEpisodes(
    [
      segment('Bad', '12:00:00.000', '12:10:00.000', 'B'),
      segment(production, '12:10:00.000', '12:14:59.999'),
    ],
    mapping,
    visibleFrom,
    visibleTo,
  )
  assert.equal(episode.isOpen, true)
  assert.equal(episode.endUtc, null)
})

test('non-production at the current range end remains open', () => {
  const [episode] = deriveOperationalEpisodes(
    [segment('Maintenance', '13:00:00.000', '13:30:00.000')],
    mapping,
    visibleFrom,
    at('13:30:00.000'),
  )
  assert.equal(episode.isOpen, true)
  assert.equal(episode.durationSeconds, 30 * 60)
})

test('an episode carried across local midnight retains its actual start', () => {
  const [episode] = deriveOperationalEpisodes(
    [segment('Make Ready', '23:50:00.000', '23:59:00.000')].map((value) => ({
      ...value,
      startUtc: '2026-08-09T23:50:00.000Z',
      endUtc: '2026-08-10T00:20:00.000Z',
      durationSeconds: 30 * 60,
    })),
    mapping,
    '2026-08-10T00:00:00.000Z',
    '2026-08-10T12:00:00.000Z',
  )
  assert.equal(episode.startUtc, '2026-08-09T23:50:00.000Z')
  assert.equal(episode.startedBeforeRange, true)
})

test('stable production separates multiple independent episodes', () => {
  const episodes = deriveOperationalEpisodes(
    [
      segment('Bad', '14:00:00.000', '14:10:00.000', 'B'),
      segment(production, '14:10:00.000', '14:20:00.000'),
      segment('Safety', '14:20:00.000', '14:30:00.000', 'S'),
      segment(production, '14:30:00.000', '14:40:00.000'),
    ],
    mapping,
    visibleFrom,
    visibleTo,
  )
  assert.equal(episodes.length, 2)
})

test('repeated identical polling rows compress into state spans', () => {
  const segments = compressRadiusObservations(
    [
      { machineId: 9006, eventType: 'M', statusCode: null, fetchedAtUtc: at('15:00:00.000'), statusDescription: 'Make Ready', sourceGeneration: 'legacy' },
      { machineId: 9006, eventType: 'M', statusCode: null, fetchedAtUtc: at('15:00:05.000'), statusDescription: 'Make Ready', sourceGeneration: 'legacy' },
      { machineId: 9006, eventType: 'M', statusCode: null, fetchedAtUtc: at('15:00:10.000'), statusDescription: 'Make Ready', sourceGeneration: 'legacy' },
      { machineId: 9006, eventType: 'G', statusCode: null, fetchedAtUtc: at('15:00:15.000'), statusDescription: production, sourceGeneration: 'legacy' },
      { machineId: 9006, eventType: 'G', statusCode: null, fetchedAtUtc: at('15:05:15.000'), statusDescription: production, sourceGeneration: 'legacy' },
    ],
    mapping,
    production,
  )
  assert.equal(segments.length, 2)
  assert.equal(segments[0].durationSeconds, 15)
  assert.equal(segments[1].durationSeconds, 300)
})

test('status-code changes preserve exact chronological Radius transitions', () => {
  const segments = compressRadiusObservations(
    [
      { machineId: 9006, eventType: 'M', statusCode: 'RC', fetchedAtUtc: at('15:30:00.000'), statusDescription: 'Make Ready', sourceGeneration: 'legacy' },
      { machineId: 9006, eventType: 'M', statusCode: 'MR', fetchedAtUtc: at('15:31:00.000'), statusDescription: 'Make Ready', sourceGeneration: 'legacy' },
      { machineId: 9006, eventType: 'G', statusCode: 'RP', fetchedAtUtc: at('15:32:00.000'), statusDescription: production, sourceGeneration: 'legacy' },
    ],
    mapping,
    production,
  )
  assert.equal(segments.length, 3)
  assert.equal(segments[0].statusCode, 'RC')
  assert.equal(segments[1].statusCode, 'MR')
})

test('brief production and stop oscillation resets the timer', () => {
  const [episode] = deriveOperationalEpisodes(
    [
      segment('Make Ready', '16:00:00.000', '16:05:00.000'),
      segment(production, '16:05:00.000', '16:06:00.000'),
      segment('Bad', '16:06:00.000', '16:07:00.000', 'B'),
      segment(production, '16:07:00.000', '16:08:00.000'),
      segment('Make Ready', '16:08:00.000', '16:09:00.000'),
      segment(production, '16:09:00.000', '16:15:00.000'),
    ],
    mapping,
    visibleFrom,
    visibleTo,
  )
  assert.equal(episode.failedReturnToProductionAttempts, 2)
  assert.equal(episode.returnToProductionAttemptCount, 3)
  assert.equal(episode.endUtc, at('16:09:00.000'))
})

test('historical lookahead closes at the production start inside the visible range', () => {
  const [episode] = deriveOperationalEpisodes(
    [
      segment('Make Ready', '17:00:00.000', '17:25:00.000'),
      segment(production, '17:25:00.000', '17:31:00.000'),
    ],
    mapping,
    visibleFrom,
    at('17:27:00.000'),
  )
  assert.equal(episode.isOpen, false)
  assert.equal(episode.endUtc, at('17:25:00.000'))
})

test('a current range with only two minutes production remains open', () => {
  const [episode] = deriveOperationalEpisodes(
    [
      segment('Make Ready', '18:00:00.000', '18:25:00.000'),
      segment(production, '18:25:00.000', '18:27:00.000'),
    ],
    mapping,
    visibleFrom,
    at('18:27:00.000'),
  )
  assert.equal(episode.isOpen, true)
  assert.equal(episode.confirmedProductionStartUtc, null)
  assert.equal(episode.confirmationSatisfiedUtc, null)
  assert.equal(episode.confirmationDurationSeconds, 0)
  assert.deepEqual(decodeEpisodeId(episode.episodeId), {
    pressKey: 'press6',
    startUtc: at('18:00:00.000'),
  })
})
