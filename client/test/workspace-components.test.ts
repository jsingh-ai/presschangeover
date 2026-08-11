import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import React, { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { PressFilterBar } from '../src/components/PressFilterBar'
import { OperatingRunSnapshot } from '../src/components/SelectedPressWorkspace'
import { RadiusOverview } from '../src/components/RadiusOverview'
import { NeedsAttention } from '../src/components/NeedsAttention'
import { InvestigationDrawer } from '../src/components/InvestigationDrawer'
import type { OperationalEpisode, RadiusOverview as RadiusOverviewModel, RadiusPressEpisodes, RadiusPressKey, RadiusPressOverview, RadiusStateSegment } from '../src/types/api'

Object.assign(globalThis, { React })

const keys: RadiusPressKey[] = ['press3', 'press5', 'press6', 'press7', 'press8', 'press9', 'press10', 'press11', 'press12', 'press13', 'press14', 'press15']

function press(pressKey: RadiusPressKey): RadiusPressOverview {
  return {
    pressKey, displayName: `Press ${pressKey.slice(5)}`, radiusMachineId: 1, availability: 'online',
    lastRadiusStatus: null, lastObservationUtc: null, offlineSinceUtc: null,
    currentStatusDescription: 'Run Production', currentEventType: 'G', currentStatusAtUtc: null,
    isCurrentlyProduction: true, runProductionSeconds: 1, nonProductionSeconds: 0,
    offlineSeconds: 0, observedSeconds: 1, rangeSeconds: 1, dataCoveragePercent: 100,
    episodeCount: 0, openEpisodeCount: 0, longestEpisodeSeconds: 0, timelineSegments: [],
  }
}

const presses = keys.map(press)
const overview: RadiusOverviewModel = {
  fromUtc: '2026-08-10T12:00:00.000Z', toUtc: '2026-08-11T12:00:00.000Z',
  plantTimeZone: 'America/Chicago', productionStatusDescription: 'Run Production', stateBreakdownRunConfirmationSeconds: 120, rangeEndIsLive: true,
  feedStatus: 'ONLINE', lastObservationUtc: null, offlinePressCount: 0, onlinePressCount: 12,
  summary: { pressesMonitored: 12, currentlyRunProduction: 12, currentlyNonProduction: 0, openEpisodes: 0, totalNonProductionSeconds: 0 },
  unmappedPressKeys: [], presses, episodeAnalysis: { sequenceFamilies: [] },
}

describe('workspace components', () => {
  it('adds compact Run context to the Overview focused-press investigation without individual Run rows', () => {
    const result = { runComparison: { runs: [
      { productionStartUtc: '2026-08-10T12:10:00.000Z', shortRunAttemptCount: 2, isPartial: false, dataInterrupted: false, totalDurationSeconds: 7_200, timeToProductionSeconds: 600, productionDurationSeconds: 6_600 },
      { productionStartUtc: null, shortRunAttemptCount: 1, isPartial: true, dataInterrupted: true, totalDurationSeconds: 900, timeToProductionSeconds: null, productionDurationSeconds: 0 },
    ] } } as unknown as RadiusPressEpisodes
    const html = renderToStaticMarkup(createElement(OperatingRunSnapshot, { result }))
    assert.match(html, /Run snapshot/)
    assert.match(html, /Runs in period<\/dt><dd>2/)
    assert.match(html, /Sustained returns<\/dt><dd>1/)
    assert.match(html, /Short Run attempts<\/dt><dd>3/)
    assert.match(html, /Partial \/ interrupted<\/dt><dd>1/)
    assert.match(html, /Latest production duration<\/dt><dd>1h 50m/)
    assert.doesNotMatch(html, /run-row/)
  })

  it('renders all fleet rows initially and only the active row when filtered', () => {
    const all = renderToStaticMarkup(createElement(RadiusOverview, { overview, onSelectPress() {} }))
    const filtered = renderToStaticMarkup(createElement(RadiusOverview, { overview, selectedPress: 'press7', onSelectPress() {} }))
    assert.equal((all.match(/class="timeline-row/g) ?? []).length, 12)
    assert.equal((filtered.match(/class="timeline-row/g) ?? []).length, 1)
    assert.match(filtered, /Press 7/)
    assert.doesNotMatch(filtered, /Press 13/)
    assert.match(all, /Timeline zoom controls/)
    assert.match(all, /100%/)
    assert.match(all, /Scrollable press timeline/)
    assert.match(filtered, /Focus analytics on Press 7/)
  })

  it('renders fleet and every press as accessible scope buttons', () => {
    const html = renderToStaticMarkup(createElement(PressFilterBar, { presses, selectedPress: 'press7', onSelect() {}, onClear() {} }))
    assert.match(html, /All presses/)
    assert.match(html, /Press 7 selected/)
    assert.equal((html.match(/<button[^>]+class="press-scope-button/g) ?? []).length, 13)
    assert.match(html, /data-press-key="press15"/)
  })

  it('renders only Press 7 findings inside a Press 7 workspace', () => {
    const result = {
      press: { pressKey: 'press7', displayName: 'Press 7' },
      episodes: [{ episodeId: 'p7' }],
      analysis: { attentionItems: [
        { episodeId: 'p7', pressKey: 'press7', startUtc: overview.fromUtc, descriptor: 'Make Ready', reasons: ['Press 7 P90'] },
        { episodeId: 'p5', pressKey: 'press5', startUtc: overview.fromUtc, descriptor: 'Web Break', reasons: ['Press 5 P90'] },
      ] },
    } as unknown as RadiusPressEpisodes
    const html = renderToStaticMarkup(createElement(NeedsAttention, { result, onSelectFinding() {} }))
    assert.match(html, /Press 7 P90/)
    assert.doesNotMatch(html, /Press 5 P90/)
  })

  it('uses one drawer shell for segment, episode, and attention modes', () => {
    const phase: RadiusStateSegment = {
      kind: 'radius', machineId: 7, pressKey: 'press7', displayName: 'Press 7',
      startUtc: overview.fromUtc, endUtc: '2026-08-10T12:10:00.000Z', durationSeconds: 600,
      isOpen: false, sourceGeneration: 'compact', eventType: 'M', statusCode: 'MR',
      statusDescription: 'Make Ready', isProduction: false,
    }
    const episode = {
      episodeId: 'p7', pressKey: 'press7', displayName: 'Press 7', radiusMachineId: 7,
      startUtc: phase.startUtc, endUtc: phase.endUtc, durationSeconds: 600, isOpen: false,
      completionStatus: 'CONFIRMED_PRODUCTION', dataInterrupted: false, startedAfterDataGap: false,
      startedBeforeRange: false, startStatus: 'Make Ready', statusSegments: [phase],
      returnToProductionAttemptCount: 1, failedReturnToProductionAttempts: 0,
      confirmedProductionStartUtc: phase.endUtc, confirmationSatisfiedUtc: '2026-08-10T12:15:00.000Z',
      confirmationDurationSeconds: 300, timeByEventType: { M: 600 },
      timeByStatusDescription: { 'Make Ready': 600 }, primaryStatusDescription: 'Make Ready',
    } as OperationalEpisode
    const finding = { episodeId: 'p7', pressKey: 'press7', startUtc: phase.startUtc, descriptor: 'Make Ready', reasons: ['Duration above Press 7 P90'] }
    const result = {
      press: { pressKey: 'press7', displayName: 'Press 7' }, episodes: [episode], timelineSegments: [phase],
      analysis: {
        medianDurationSeconds: 300, episodeProfiles: [{ episodeId: 'p7', descriptor: 'Make Ready', sequenceKey: 'mr', sequenceStates: ['Make Ready'] }],
        phaseBenchmarks: [{ eventType: 'M', statusDescription: 'Make Ready', sampleCount: 5, medianDurationSeconds: 300, p90DurationSeconds: 500 }],
        attentionItems: [finding],
      },
    } as unknown as RadiusPressEpisodes
    const segmentHtml = renderToStaticMarkup(createElement(InvestigationDrawer, { route: { mode: 'segment', startUtc: phase.startUtc, endUtc: phase.endUtc }, result, segment: phase, onClose() {} }))
    const previous = { ...phase, startUtc: '2026-08-10T11:50:00.000Z', endUtc: phase.startUtc, statusDescription: 'Run Production', isProduction: true, eventType: 'G' }
    const next = { ...phase, startUtc: phase.endUtc, endUtc: '2026-08-10T12:20:00.000Z', statusDescription: 'Substrate - Other', isProduction: false, eventType: 'B' }
    const adjacentHtml = renderToStaticMarkup(createElement(InvestigationDrawer, { route: { mode: 'segment', pressKey: 'press7', startUtc: phase.startUtc, endUtc: phase.endUtc }, result, segment: phase, contextSegments: [previous, phase, next], onClose() {}, onSelectSegment() {} }))
    const episodeHtml = renderToStaticMarkup(createElement(InvestigationDrawer, { route: { mode: 'episode', episodeId: 'p7' }, result, episode, onClose() {} }))
    const findingHtml = renderToStaticMarkup(createElement(InvestigationDrawer, { route: { mode: 'attention', findingId: 'p7' }, result, episode, finding, onClose() {} }))
    for (const html of [segmentHtml, episodeHtml, findingHtml]) {
      assert.match(html, /role="dialog"/)
      assert.match(html, /Close investigation/)
      assert.match(html, /Press 7/)
    }
    assert.match(segmentHtml, /Exact Radius phase/)
    assert.match(segmentHtml, /Start/)
    assert.match(segmentHtml, /End/)
    assert.match(segmentHtml, /Plant time/)
    assert.match(adjacentHtml, /Previous state/)
    assert.match(adjacentHtml, /Next state/)
    assert.doesNotMatch(adjacentHtml, /Previous state[^]*disabled/)
    assert.match(episodeHtml, /Operational episode/)
    assert.match(findingHtml, /Why this needs attention/)
  })
})
