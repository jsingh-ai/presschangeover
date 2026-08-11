import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { EpisodeAttentionItem, RadiusPressKey, RadiusPressOverview } from '../src/types/api'
import {
  attentionItemsForPress,
  closeInvestigationState,
  investigationFromSearch,
  isDrawerHistoryState,
  nextPressSelection,
  openInvestigationState,
  pressFilterLabel,
  visibleFleetPresses,
  workspaceUrl,
} from '../src/workspace-state'

const keys: RadiusPressKey[] = ['press3', 'press5', 'press6', 'press7', 'press8', 'press9', 'press10', 'press11', 'press12', 'press13', 'press14', 'press15']

function press(pressKey: RadiusPressKey): RadiusPressOverview {
  return {
    pressKey,
    displayName: `Press ${pressKey.slice(5)}`,
    radiusMachineId: Number(pressKey.slice(5)),
    availability: 'online',
    lastRadiusStatus: null,
    lastObservationUtc: null,
    offlineSinceUtc: null,
    currentStatusDescription: 'Run Production',
    currentEventType: 'G',
    currentStatusAtUtc: null,
    isCurrentlyProduction: true,
    runProductionSeconds: 1,
    nonProductionSeconds: 0,
    offlineSeconds: 0,
    observedSeconds: 1,
    rangeSeconds: 1,
    dataCoveragePercent: 100,
    episodeCount: 0,
    openEpisodeCount: 0,
    longestEpisodeSeconds: 0,
    timelineSegments: [],
  }
}

const range = {
  preset: 'last24' as const,
  fromUtc: '2026-08-10T12:00:00.000Z',
  toUtc: '2026-08-11T12:00:00.000Z',
}

describe('workspace press filtering', () => {
  const presses = keys.map(press)

  it('starts with all 12 rows and reduces the primary Gantt to Press 7', () => {
    assert.equal(visibleFleetPresses(presses, undefined).length, 12)
    const visible = visibleFleetPresses(presses, 'press7')
    assert.deepEqual(visible.map(({ displayName }) => displayName), ['Press 7'])
    assert.equal(pressFilterLabel('Press 7'), 'Press 7 selected')
  })

  it('clicking Press 7 again or clearing the chip restores all rows without changing range', () => {
    assert.equal(nextPressSelection(undefined, 'press7'), 'press7')
    assert.equal(nextPressSelection('press7', 'press7'), undefined)
    assert.equal(visibleFleetPresses(presses, nextPressSelection('press7', 'press7')).length, 12)
    assert.deepEqual(range, { preset: 'last24', fromUtc: '2026-08-10T12:00:00.000Z', toUtc: '2026-08-11T12:00:00.000Z' })
  })

  it('switches directly to another press without a reload state', () => {
    assert.equal(nextPressSelection('press7', 'press13'), 'press13')
    assert.deepEqual(visibleFleetPresses(presses, 'press13').map(({ pressKey }) => pressKey), ['press13'])
  })

  it('defensively scopes explained exceptions to the active press', () => {
    const items = [
      { episodeId: '7', pressKey: 'press7', startUtc: range.fromUtc, descriptor: 'Make Ready', reasons: ['P90'] },
      { episodeId: '5', pressKey: 'press5', startUtc: range.fromUtc, descriptor: 'Web Break', reasons: ['P90'] },
    ] as EpisodeAttentionItem[]
    assert.deepEqual(attentionItemsForPress(items, 'press7').map(({ episodeId }) => episodeId), ['7'])
  })
})

describe('workspace investigation state', () => {
  it('opens each drawer mode while preserving selected press and closes only the drawer', () => {
    const base = { selectedPress: 'press7' as const }
    for (const investigation of [
      { mode: 'segment' as const, startUtc: range.fromUtc, endUtc: range.toUtc },
      { mode: 'episode' as const, episodeId: 'episode-7' },
      { mode: 'attention' as const, findingId: 'episode-7' },
      { mode: 'status' as const, statusIdentity: 'M\u001f12\u001fMake Ready' },
      { mode: 'anomaly' as const, anomalyId: 'anomaly-7' },
    ]) {
      const opened = openInvestigationState(base, 'press7', investigation)
      assert.equal(opened.selectedPress, 'press7')
      assert.deepEqual(opened.investigation, investigation)
      assert.deepEqual(closeInvestigationState(opened), { selectedPress: 'press7', investigation: undefined })
    }
  })

  it('round-trips deep links without discarding range or press context', () => {
    const episodeUrl = workspaceUrl(range, 'press7', { mode: 'episode', episodeId: 'abc' })
    assert.match(episodeUrl, /^\/overview\?/)
    assert.equal(new URL(episodeUrl, 'http://local').searchParams.get('press'), 'press7')
    assert.deepEqual(investigationFromSearch(new URL(episodeUrl, 'http://local').search), { mode: 'episode', episodeId: 'abc' })
    const segmentUrl = workspaceUrl(range, 'press7', { mode: 'segment', startUtc: range.fromUtc, endUtc: range.toUtc })
    assert.deepEqual(investigationFromSearch(new URL(segmentUrl, 'http://local').search), { mode: 'segment', startUtc: range.fromUtc, endUtc: range.toUtc })
    const fleetSegmentUrl = workspaceUrl(range, undefined, { mode: 'segment', pressKey: 'press7', startUtc: range.fromUtc, endUtc: range.toUtc })
    const fleetSegmentQuery = new URL(fleetSegmentUrl, 'http://local').searchParams
    assert.equal(fleetSegmentQuery.get('press'), null)
    assert.equal(fleetSegmentQuery.get('segmentPress'), 'press7')
    assert.deepEqual(investigationFromSearch(fleetSegmentQuery.toString()), { mode: 'segment', pressKey: 'press7', startUtc: range.fromUtc, endUtc: range.toUtc })
    const findingUrl = workspaceUrl(range, 'press7', { mode: 'attention', findingId: 'finding-7' })
    assert.deepEqual(investigationFromSearch(new URL(findingUrl, 'http://local').search), { mode: 'attention', findingId: 'finding-7' })
    const statusUrl = workspaceUrl(range, undefined, { mode: 'status', statusIdentity: 'M\u001f12\u001fMake Ready' })
    assert.deepEqual(investigationFromSearch(new URL(statusUrl, 'http://local').search), { mode: 'status', statusIdentity: 'M\u001f12\u001fMake Ready' })
    const anomalyUrl = workspaceUrl(range, 'press7', { mode: 'anomaly', anomalyId: 'anomaly-7' })
    assert.deepEqual(investigationFromSearch(new URL(anomalyUrl, 'http://local').search), { mode: 'anomaly', anomalyId: 'anomaly-7' })
    const analysisUrl = workspaceUrl(range, 'press7', undefined, 'operational-analysis', 'drivers')
    assert.match(analysisUrl, /^\/operational-analysis\?/)
    assert.equal(new URL(analysisUrl, 'http://local').searchParams.get('section'), 'drivers')
    assert.equal(new URL(analysisUrl, 'http://local').searchParams.get('press'), 'press7')
  })

  it('uses browser Back only for an in-app drawer history entry', () => {
    assert.equal(isDrawerHistoryState({ processIntelligenceDrawer: true }), true)
    assert.equal(isDrawerHistoryState(null), false)
    assert.equal(isDrawerHistoryState({}), false)
  })
})
