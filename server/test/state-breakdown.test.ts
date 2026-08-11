import assert from 'node:assert/strict'
import test from 'node:test'
import { clipSegmentsToRange } from '../src/episodes/episode-engine.js'
import type { RadiusStatusSegment } from '../src/radius/models.js'
import {
  qualifyStateBreakdownRuns,
  STATE_BREAKDOWN_RUN_CONFIRMATION_SECONDS,
} from '../src/radius/state-breakdown.js'

const day = '2026-08-10T'

function state(
  start: string,
  end: string,
  statusDescription: string,
  eventType = statusDescription === 'Run Production' ? 'G' : 'M',
  statusCode: string | null = null,
): RadiusStatusSegment {
  return {
    kind: 'radius',
    machineId: 205,
    pressKey: 'press5',
    displayName: 'Press 5',
    eventType,
    statusCode,
    statusDescription,
    startUtc: `${day}${start}.000Z`,
    endUtc: `${day}${end}.000Z`,
    durationSeconds: (Date.parse(`${day}${end}.000Z`) - Date.parse(`${day}${start}.000Z`)) / 1_000,
    isProduction: eventType === 'G' && statusDescription === 'Run Production',
    isOpen: false,
    sourceGeneration: 'compact',
  }
}

function unavailable(start: string, end: string): RadiusStatusSegment {
  return {
    ...state(start, end, 'Unavailable', '', null),
    kind: 'offline',
    eventType: null,
    statusCode: null,
    statusDescription: null,
    isProduction: false,
    sourceGeneration: 'offline_inference',
  }
}

test('State Breakdown confirms a sustained return at the original Run start', () => {
  const run = qualifyStateBreakdownRuns([
    state('08:00:00', '09:00:00', 'Run Production'),
    state('09:00:00', '09:20:00', 'Make Ready'),
    state('09:20:00', '09:30:00', 'Run Production'),
  ])[2]

  assert.equal(STATE_BREAKDOWN_RUN_CONFIRMATION_SECONDS, 120)
  assert.equal(run.kind, 'radius')
  if (run.kind !== 'radius') return
  assert.equal(run.stateBreakdownRunQualification?.state, 'sustained')
  assert.equal(run.stateBreakdownRunQualification?.returnUtc, `${day}09:20:00.000Z`)
  assert.equal(run.stateBreakdownRunQualification?.confirmationSatisfiedUtc, `${day}09:22:00.000Z`)
})

test('State Breakdown preserves a short Run attempt and confirms the later return', () => {
  const result = qualifyStateBreakdownRuns([
    state('09:00:00', '09:20:00', 'Make Ready'),
    state('09:20:00', '09:21:00', 'Run Production'),
    state('09:21:00', '09:30:00', 'Make Ready'),
    state('09:30:00', '10:00:00', 'Run Production'),
  ])

  const shortRun = result[1]
  const sustainedRun = result[3]
  assert.equal(shortRun.kind, 'radius')
  assert.equal(sustainedRun.kind, 'radius')
  if (shortRun.kind !== 'radius' || sustainedRun.kind !== 'radius') return
  assert.equal(shortRun.statusDescription, 'Run Production')
  assert.equal(shortRun.durationSeconds, 60)
  assert.equal(shortRun.stateBreakdownRunQualification?.state, 'short')
  assert.equal(sustainedRun.stateBreakdownRunQualification?.state, 'sustained')
  assert.equal(sustainedRun.stateBreakdownRunQualification?.returnUtc, `${day}09:30:00.000Z`)
})

test('State Breakdown uses greater-than-or-equal semantics at exactly 120 seconds', () => {
  const run = qualifyStateBreakdownRuns([
    state('09:00:00', '09:20:00', 'Make Ready'),
    state('09:20:00', '09:22:00', 'Run Production'),
  ])[1]
  assert.equal(run.kind, 'radius')
  if (run.kind !== 'radius') return
  assert.equal(run.stateBreakdownRunQualification?.state, 'sustained')
})

test('selected-range clipping preserves the active state at the range boundary', () => {
  const original = state('07:52:00', '08:37:00', 'Run Production')
  const [visible] = clipSegmentsToRange(
    qualifyStateBreakdownRuns([original]),
    `${day}08:00:00.000Z`,
    `${day}12:00:00.000Z`,
  )
  assert.equal(visible.startUtc, `${day}08:00:00.000Z`)
  assert.equal(visible.endUtc, original.endUtc)
  assert.equal(visible.statusDescription, 'Run Production')
})

test('an unavailable interval remains explicit and cannot confirm a short Run', () => {
  const result = qualifyStateBreakdownRuns([
    state('09:00:00', '09:20:00', 'Make Ready'),
    state('09:20:00', '09:21:00', 'Run Production'),
    unavailable('09:21:00', '09:30:00'),
  ])
  assert.equal(result[1].kind, 'radius')
  if (result[1].kind !== 'radius') return
  assert.equal(result[1].stateBreakdownRunQualification?.state, 'pending')
  assert.equal(result[2].kind, 'offline')
})

test('confirmation qualification never trims the qualifying Run span', () => {
  const original = state('09:20:00', '09:30:00', 'Run Production')
  const run = qualifyStateBreakdownRuns([
    state('09:00:00', '09:20:00', 'Make Ready'),
    original,
  ])[1]
  assert.equal(run.startUtc, original.startUtc)
  assert.equal(run.endUtc, original.endUtc)
  assert.equal(run.durationSeconds, original.durationSeconds)
})
