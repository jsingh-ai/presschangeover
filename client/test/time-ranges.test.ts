import assert from 'node:assert/strict'
import test from 'node:test'
import { DateTime } from 'luxon'
import {
  createCustomRange,
  createPresetRange,
  RangeValidationError,
  restoreSelectedRange,
} from '../src/time-ranges.js'

test('Today starts at plant-local midnight across spring DST', () => {
  const range = createPresetRange(
    'today',
    DateTime.fromISO('2026-03-08T12:00:00.000Z'),
  )
  assert.equal(range.fromUtc, '2026-03-08T06:00:00.000Z')
  assert.equal(range.toUtc, '2026-03-08T12:00:00.000Z')
})

test('Last 24 Hours is exactly 24 elapsed hours', () => {
  const range = createPresetRange(
    'last24',
    DateTime.fromISO('2026-11-01T12:00:00.000Z'),
  )
  assert.equal(Date.parse(range.toUtc) - Date.parse(range.fromUtc), 24 * 60 * 60 * 1_000)
})

test('valid custom plant-local values convert to UTC', () => {
  const range = createCustomRange('2026-08-10T08:00', '2026-08-10T16:00')
  assert.equal(range.fromUtc, '2026-08-10T13:00:00.000Z')
  assert.equal(range.toUtc, '2026-08-10T21:00:00.000Z')
})

test('custom ranges over 31 days are rejected without truncation', () => {
  assert.throws(
    () => createCustomRange('2026-01-01T00:00', '2026-02-02T00:00'),
    RangeValidationError,
  )
})

test('nonexistent spring-forward plant time is rejected', () => {
  assert.throws(
    () => createCustomRange('2026-03-08T02:30', '2026-03-08T04:00'),
    /not a valid plant-local date and time/,
  )
})

test('ambiguous fall-back plant time is rejected explicitly', () => {
  assert.throws(
    () => createCustomRange('2026-11-01T01:30', '2026-11-01T03:00'),
    /ambiguous during the daylight-saving transition/,
  )
})

test('a URL-restored historical range preserves its exact UTC interval', () => {
  const range = restoreSelectedRange(
    '2026-08-08T05:00:00.000Z',
    '2026-08-09T04:59:00.000Z',
    'custom',
  )
  assert.equal(range?.fromUtc, '2026-08-08T05:00:00.000Z')
  assert.equal(range?.toUtc, '2026-08-09T04:59:00.000Z')
  assert.equal(range?.customFromLocal, '2026-08-08T00:00')
  assert.equal(range?.customToLocal, '2026-08-08T23:59')
})

test('an invalid or over-limit URL range is rejected', () => {
  assert.equal(restoreSelectedRange(
    '2026-07-01T00:00:00.000Z',
    '2026-08-02T00:00:00.000Z',
    'custom',
  ), undefined)
})
