import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import React, { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { EpisodeComparisonBoard, episodeDisplaySegments, episodeHover, episodeSequenceLabels } from '../src/components/EpisodeComparisonBoard'
import type { OperationalEpisode, RadiusOfflineSegment, RadiusPressEpisodes, RadiusStateSegment } from '../src/types/api'

Object.assign(globalThis, { React })

const state = (startUtc: string, endUtc: string, statusDescription: string, eventType = 'M', isProduction = false): RadiusStateSegment => ({
  kind: 'radius', machineId: 13, pressKey: 'press13', displayName: 'Press 13', startUtc, endUtc,
  durationSeconds: (Date.parse(endUtc) - Date.parse(startUtc)) / 1_000, isOpen: false,
  sourceGeneration: 'compact', eventType, statusCode: eventType === 'G' ? '150' : '47', statusDescription, isProduction,
})

const unavailable: RadiusOfflineSegment = {
  kind: 'offline', machineId: 13, pressKey: 'press13', displayName: 'Press 13',
  startUtc: '2026-08-10T00:30:00.000Z', endUtc: '2026-08-10T02:00:00.000Z', durationSeconds: 5_400,
  isOpen: false, sourceGeneration: 'offline_inference', eventType: null, statusCode: null, statusDescription: null, isProduction: false,
}

const preGap = state('2026-08-10T00:00:00.000Z', unavailable.startUtc, 'Non Productive')
const postGap = state(unavailable.endUtc, '2026-08-10T02:10:00.000Z', 'Make Ready')
const production = state('2026-08-10T02:10:00.000Z', '2026-08-10T03:00:00.000Z', 'Run Production', 'G', true)
const confirmation = { ...production, endUtc: '2026-08-10T02:15:00.000Z', durationSeconds: 300, returnToProduction: 'confirmed' as const }

const interrupted = {
  episodeId: 'interrupted', pressKey: 'press13', displayName: 'Press 13', radiusMachineId: 13,
  startUtc: preGap.startUtc, endUtc: unavailable.startUtc, durationSeconds: 1_800, isOpen: false,
  completionStatus: 'DATA_INTERRUPTED', dataInterrupted: true, startedAfterDataGap: false, startedBeforeRange: false,
  startStatus: preGap.statusDescription, statusSegments: [preGap], displaySegments: [preGap, unavailable],
  displayEndUtc: unavailable.endUtc, wallClockDurationSeconds: 7_200, observedDurationSeconds: 1_800, unavailableDurationSeconds: 5_400,
  returnToProductionAttemptCount: 0, failedReturnToProductionAttempts: 0, confirmedProductionStartUtc: null,
  confirmationSatisfiedUtc: null, confirmationDurationSeconds: 0, timeByEventType: { M: 1_800 },
  timeByStatusDescription: { 'Non Productive': 1_800 }, primaryStatusDescription: 'Non Productive',
} as OperationalEpisode

const recovered = {
  ...interrupted, episodeId: 'recovered', startUtc: postGap.startUtc, endUtc: production.startUtc,
  durationSeconds: 600, completionStatus: 'CONFIRMED_PRODUCTION', dataInterrupted: false, startedAfterDataGap: true,
  startStatus: postGap.statusDescription, statusSegments: [postGap, confirmation], displaySegments: [postGap, confirmation],
  displayEndUtc: production.startUtc, wallClockDurationSeconds: 600, observedDurationSeconds: 600, unavailableDurationSeconds: 0,
  returnToProductionAttemptCount: 1, confirmedProductionStartUtc: production.startUtc,
  confirmationSatisfiedUtc: confirmation.endUtc, confirmationDurationSeconds: 300,
} as OperationalEpisode

const result = {
  fromUtc: preGap.startUtc, toUtc: production.endUtc, press: { pressKey: 'press13', displayName: 'Press 13', machineId: 13 },
  timelineSegments: [preGap, unavailable, postGap, production], episodes: [interrupted, recovered],
  analysis: { medianDurationSeconds: 600, phaseBenchmarks: [], episodeCount: 2, episodeProfiles: [] },
} as unknown as RadiusPressEpisodes

describe('Episode Comparison display contract', () => {
  it('attaches canonical offline to the interrupted pre-gap row and preserves post-gap activity', () => {
    assert.deepEqual(episodeDisplaySegments(interrupted, result).map(({ kind }) => kind), ['radius', 'offline'])
    assert.deepEqual(episodeDisplaySegments(recovered, result).map(({ kind }) => kind), ['radius', 'radius'])
    assert.equal(episodeDisplaySegments(interrupted, result).at(-1)?.durationSeconds, 5_400)
    assert.equal(episodeDisplaySegments(recovered, result).some(({ kind }) => kind === 'offline'), false)
  })

  it('renders offline in the Gantt with exact evidence and a sequence ending at Data unavailable', () => {
    const html = renderToStaticMarkup(createElement(EpisodeComparisonBoard, { result, onSelectEpisode() {}, onSelectSegment() {} }))
    assert.match(html, /comparison-phase--offline/)
    assert.match(html, /DATA UNAVAILABLE/)
    assert.match(html, /Duration: 1h 30m/)
    assert.match(html, /Machine state is unknown/)
    assert.match(html, /Non Productive[^]*→[^]*Data unavailable/)
    assert.match(html, /Make Ready[^]*Run Production/)
  })

  it('keeps the Episode column timing-only and exposes interrupted coverage in its tooltip', () => {
    const html = renderToStaticMarkup(createElement(EpisodeComparisonBoard, { result, onSelectEpisode() {}, onSelectSegment() {} }))
    const timingBlock = html.match(/<button class="comparison-row-label"[^]*?<\/button>/)?.[0] ?? ''
    assert.match(timingBlock, /→/)
    assert.match(timingBlock, /2h 0m wall time/)
    assert.match(timingBlock, /Interrupted/)
    assert.doesNotMatch(timingBlock, /Non Productive|Make Ready/)
    const tooltip = episodeHover(interrupted, episodeDisplaySegments(interrupted, result))
    assert.match(tooltip, /Wall-clock duration: 2h 0m/)
    assert.match(tooltip, /Observed Radius time: 30m/)
    assert.match(tooltip, /Data unavailable: 1h 30m/)
  })

  it('preserves repeated phases and annotates short Run Production attempts', () => {
    const makeReadyAgain = { ...postGap, startUtc: '2026-08-10T02:11:00.000Z', endUtc: '2026-08-10T02:12:00.000Z' }
    const short = { ...production, startUtc: '2026-08-10T02:10:00.000Z', endUtc: '2026-08-10T02:11:00.000Z', durationSeconds: 60, returnToProduction: 'failed' as const }
    assert.deepEqual(episodeSequenceLabels([postGap, short, makeReadyAgain, confirmation]), ['Make Ready', 'Run Production (short)', 'Make Ready', 'Run Production'])
  })

  it('renders open Episodes as Ongoing with observed duration', () => {
    const open = { ...interrupted, episodeId: 'open', startUtc: '2026-08-10T04:00:00.000Z', endUtc: null, displayEndUtc: null, durationSeconds: 3_600, observedDurationSeconds: 3_600, wallClockDurationSeconds: 3_600, unavailableDurationSeconds: 0, isOpen: true, completionStatus: 'OPEN', dataInterrupted: false, statusSegments: [postGap], displaySegments: [postGap] } as OperationalEpisode
    const openResult = { ...result, episodes: [open] } as RadiusPressEpisodes
    const html = renderToStaticMarkup(createElement(EpisodeComparisonBoard, { result: openResult, onSelectEpisode() {}, onSelectSegment() {} }))
    assert.match(html, /Ongoing/)
    assert.match(html, /1h 0m observed/)
    assert.match(html, />Open</)
  })

  it('adds date context when an Episode crosses plant midnight', () => {
    const crossMidnight = { ...recovered, episodeId: 'cross', startUtc: '2026-08-10T04:30:00.000Z', endUtc: '2026-08-10T07:00:00.000Z', displayEndUtc: '2026-08-10T07:00:00.000Z', durationSeconds: 9_000, observedDurationSeconds: 9_000, wallClockDurationSeconds: 9_000 } as OperationalEpisode
    const crossResult = { ...result, episodes: [crossMidnight] } as RadiusPressEpisodes
    const html = renderToStaticMarkup(createElement(EpisodeComparisonBoard, { result: crossResult, onSelectEpisode() {}, onSelectSegment() {} }))
    assert.match(html, /Aug 9, 11:30 PM/)
    assert.match(html, /Aug 10, 2:00 AM/)
    assert.match(episodeHover(crossMidnight, crossMidnight.displaySegments), /Duration: 2h 30m/)
  })
})
