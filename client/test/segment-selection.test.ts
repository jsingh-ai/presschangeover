import assert from 'node:assert/strict'
import test from 'node:test'
import {
  findRadiusSegment,
  selectRadiusSegment,
} from '../src/segment-selection.js'
import type { RadiusStatusSegment } from '../src/types/api.js'

const segment: RadiusStatusSegment = {
  kind: 'radius',
  machineId: 213,
  pressKey: 'press13',
  displayName: 'Press 13',
  eventType: 'M',
  statusCode: 'MR',
  statusDescription: 'Make Ready',
  startUtc: '2026-08-10T15:00:00.000Z',
  endUtc: '2026-08-10T15:20:00.000Z',
  durationSeconds: 1_200,
  isProduction: false,
  isOpen: false,
  sourceGeneration: 'compact',
}

test('historical segment selection preserves a telemetry-ready exact interval', () => {
  const selection = selectRadiusSegment(segment)
  assert.deepEqual(selection, {
    pressKey: 'press13',
    startUtc: '2026-08-10T15:00:00.000Z',
    endUtc: '2026-08-10T15:20:00.000Z',
  })
  assert.equal(findRadiusSegment([segment], selection), segment)
})

test('segment lookup does not substitute another interval for stale URL state', () => {
  assert.equal(findRadiusSegment([segment], {
    pressKey: 'press13',
    startUtc: segment.startUtc,
    endUtc: '2026-08-10T15:21:00.000Z',
  }), undefined)
})
