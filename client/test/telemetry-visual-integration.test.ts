import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import React, { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { runLayerIntervals } from '../src/components/RunEvidenceDrawer'
import { clusterTimelineEvents, SynchronizedTimeline } from '../src/components/SynchronizedTimeline'
import { contextEventTrack, contextIntervalTracks, curatedCategoriesForCapabilities, physicalChangeLabel, physicalEventTrack, type PressTelemetryEvidenceState } from '../src/components/TelemetryEvidenceTimeline'
import { UnifiedProcessTimeline } from '../src/components/UnifiedProcessTimeline'
import type { OperationalRun } from '../src/types/api'
import type { CuratedPhysicalEvidence, ProductionContextEvidence, SemanticSignalEvidence, SignalCapability, TelemetryChange } from '../src/types/evidence'

Object.assign(globalThis, { React })

const fromUtc = '2026-08-11T12:00:00.000Z'
const toUtc = '2026-08-11T12:10:00.000Z'

const value = (observedAtUtc: string, entry: string | number) => ({ observedAtUtc, receivedAtUtc: observedAtUtc, sourceTimestampUtc: observedAtUtc, qualityState: 'GOOD', valueKind: typeof entry === 'number' ? 'integer' as const : 'string' as const, value: entry })
const change = (observedAtUtc: string, previousValue: string | number, nextValue: string | number): TelemetryChange => ({ ...value(observedAtUtc, nextValue), previousObservedAtUtc: fromUtc, previousReceivedAtUtc: fromUtc, previousSourceTimestampUtc: fromUtc, previousQualityState: 'GOOD', previousValueKind: typeof previousValue === 'number' ? 'integer' : 'string', previousValue })

function contextFixture(): ProductionContextEvidence {
  const unsupported = (field: keyof ProductionContextEvidence['fields']) => ({ field, canonicalId: `production.${field}`, capabilityState: 'UNSUPPORTED' as const, observationState: 'UNSUPPORTED' as const, seed: null, changes: [] })
  const orderChange = change('2026-08-11T12:05:00.000Z', 'Order A', 'Order B')
  return {
    pressKey: 'press5', displayName: 'Press 5', sourceKey: 'source', fromUtc, toUtc,
    fields: {
      job: unsupported('job'), recipe: unsupported('recipe'), customer: unsupported('customer'), material: unsupported('material'), roll: unsupported('roll'),
      order: { field: 'order', canonicalId: 'production.order', capabilityState: 'SUPPORTED', observationState: 'SUPPORTED_WITH_OBSERVATIONS', seed: value(fromUtc, 'Order A'), changes: [orderChange] },
    },
    changes: [{ atUtc: orderChange.observedAtUtc, field: 'order', canonicalId: 'production.order', previousValueKind: orderChange.previousValueKind, previousValue: orderChange.previousValue, valueKind: orderChange.valueKind, value: orderChange.value, qualityState: 'GOOD' }],
  }
}

const deckSignal = (canonicalId: string, deckNumber: number | null, previousValue: number, nextValue: number): SemanticSignalEvidence => ({ canonicalId, deckNumber, capabilityState: 'SUPPORTED', observationState: 'SUPPORTED_WITH_OBSERVATIONS', mappingStatus: 'MAPPED', sourceUnit: null, canonicalUnitStatus: null, representation: 'changes', seed: null, samples: [], changes: [change('2026-08-11T12:05:10.000Z', previousValue, nextValue)] })

describe('primary telemetry visual integration', () => {
  it('positions accessible discrete events at the exact shared-axis timestamp and groups dense events without losing detail', () => {
    const events = [
      { id: 'one', atUtc: '2026-08-11T12:05:00.000Z', label: 'Order changed', category: 'context', detail: 'Order A → Order B' },
      { id: 'two', atUtc: '2026-08-11T12:05:01.000Z', label: 'Recipe changed', category: 'context', detail: 'Recipe X → Recipe Y' },
    ]
    const clusters = clusterTimelineEvents(events, fromUtc, toUtc)
    assert.equal(clusters.length, 1)
    assert.equal(clusters[0]?.positionPercent, 50)
    assert.deepEqual(clusters[0]?.events.map(({ id }) => id), ['one', 'two'])
    const html = renderToStaticMarkup(createElement(SynchronizedTimeline, { fromUtc, toUtc, ariaLabel: 'Events', intervalTracks: [], eventTracks: [{ id: 'context', label: 'Context changes', events }] }))
    assert.match(html, /left:50%/)
    assert.match(html, /Order changed/)
    assert.match(html, /Recipe changed/)
    assert.match(html, />2<\/b>/)
    const source = readFileSync(new URL('../src/components/SynchronizedTimeline.tsx', import.meta.url), 'utf8')
    assert.match(source, /setHoveredEventUtc/)
    assert.match(source, /setCrosshair\(cluster\.positionPercent\)/)
  })

  it('creates context intervals and explicit markers from actual observed timestamps', () => {
    const context = contextFixture()
    assert.equal(contextIntervalTracks(context)[0]?.label, 'Order')
    assert.equal(contextIntervalTracks(context)[0]?.intervals[1]?.startUtc, '2026-08-11T12:05:00.000Z')
    const marker = contextEventTrack(context)?.events[0]
    assert.equal(marker?.atUtc, '2026-08-11T12:05:00.000Z')
    assert.equal(marker?.label, 'Order changed')
    assert.doesNotMatch(marker?.label ?? '', /started/i)
  })

  it('renders Context, Radius, Group, Family, Motion, Speed, and Events in one shared timeline', () => {
    const physical: CuratedPhysicalEvidence = { pressKey: 'press5', displayName: 'Press 5', sourceKey: 'source', fromUtc, toUtc, requestedCategories: ['deck_states'], capabilities: [], signals: [deckSignal('deck.print_on', 2, 0, 1)] }
    const evidence: PressTelemetryEvidenceState = {
      range: { fromUtc, toUtc, focused: false }, loading: false, error: false, context: contextFixture(), physical,
      capabilities: { pressKey: 'press5', displayName: 'Press 5', sourceKey: 'source', metadataStatus: 'FRESH', capabilities: [{ canonicalId: 'machine.speed.actual', state: 'SUPPORTED', deckNumbers: [], historyQueryable: true, evidenceKind: 'derived' }] },
      speed: { pressKey: 'press5', displayName: 'Press 5', sourceKey: 'source', fromUtc, toUtc, actual: { canonicalId: 'machine.speed.actual', observationState: 'SUPPORTED_WITH_OBSERVATIONS', sourceUnit: null, canonicalUnitStatus: 'UNVERIFIED', samples: [{ ...value('2026-08-11T12:05:00.000Z', 0), valueKind: 'numeric', value: 0 }] }, setpoint: null },
      motion: { pressKey: 'press5', displayName: 'Press 5', sourceKey: 'source', fromUtc, toUtc, policy: {}, summary: { durationsMs: { RUNNING: 600_000, STOPPED: 0, TRANSITION: 0, UNKNOWN: 0 }, segmentCount: 1 }, segments: [{ state: 'RUNNING', fromUtc, toUtc, durationMs: 600_000 }] },
    }
    const track = (id: string, label: string) => ({ id, label, intervals: [{ id: `${id}-1`, startUtc: fromUtc, endUtc: toUtc, label }] })
    const html = renderToStaticMarkup(createElement(UnifiedProcessTimeline, { fromUtc, toUtc, ariaLabel: 'Unified evidence', radiusTrack: track('radius', 'Radius recorded'), groupTrack: track('operational-group', 'Operational Group'), familyTrack: track('process-family', 'Process Family'), telemetry: evidence }))
    for (const label of ['Order', 'Context changes', 'Radius recorded', 'Operational Group', 'Process Family', 'Physical Motion', 'Actual Speed', 'Physical Events']) assert.match(html, new RegExp(label))
    assert.equal((html.match(/synchronized-timeline__scroll/g) ?? []).length, 1)
    assert.match(html, /1 observed samples from 0 to 0/)
  })

  it('requests only capability-supported curated event categories', () => {
    const capability = (canonicalId: string, state: SignalCapability['state'] = 'SUPPORTED'): SignalCapability => ({ canonicalId, state, deckNumbers: [], historyQueryable: true, evidenceKind: 'semantic_history' })
    assert.deepEqual(curatedCategoriesForCapabilities([capability('deck.active'), capability('ink.washup.state'), capability('register.long.actual_or_correction', 'UNSUPPORTED'), capability('ink.viscosity.actual')]), ['deck_states', 'wash'])
  })

  it('keeps deck signals and wash/pump codes raw in event labels', () => {
    const deck = deckSignal('deck.print_on', 2, 0, 1)
    const wash = deckSignal('ink.washup.state', null, 0, 512)
    const pump = deckSignal('ink.pump.status', null, 1, 11)
    assert.equal(physicalChangeLabel(deck, deck.changes[0]!), 'Deck 2 print-on signal 0 → 1')
    assert.equal(physicalChangeLabel(wash, wash.changes[0]!), 'Wash-state code 0 → 512')
    assert.equal(physicalChangeLabel(pump, pump.changes[0]!), 'Pump-state code 1 → 11')
    const track = physicalEventTrack({ pressKey: 'press5', displayName: 'Press 5', sourceKey: 'source', fromUtc, toUtc, requestedCategories: ['deck_states', 'wash', 'pump'], capabilities: [], signals: [deck, wash, pump] })
    assert.equal(track?.events.length, 3)
    assert.doesNotMatch(track?.events.map(({ label }) => label).join(' '), /enabled|began printing|pump failed/i)
  })

  it('merges contiguous Run family intervals but never bridges an unavailable gap', () => {
    const segment = (segmentId: string, startUtc: string, endUtc: string, unavailable = false) => ({ segmentId, exactIdentity: unavailable ? null : 'B\u001f1\u001fState', eventType: unavailable ? null : 'B', statusCode: unavailable ? null : '1', statusDescription: unavailable ? null : 'State', startUtc, endUtc, durationSeconds: 60, phase: 'pre-production' as const, isUnavailable: unavailable, isShortRunAttempt: false, operationalGroupKey: unavailable ? null : 'ROUTINE_PROCESS', operationalGroupName: unavailable ? null : 'Routine Process', processFamilyKey: unavailable ? null : 'CLEANING_WASH', processFamilyName: unavailable ? null : 'Cleaning / Wash' })
    const run = { startUtc: fromUtc, endUtc: '2026-08-11T12:04:00.000Z', segments: [segment('1', fromUtc, '2026-08-11T12:01:00.000Z'), segment('2', '2026-08-11T12:01:00.000Z', '2026-08-11T12:02:00.000Z'), segment('3', '2026-08-11T12:02:00.000Z', '2026-08-11T12:03:00.000Z', true), segment('4', '2026-08-11T12:03:00.000Z', '2026-08-11T12:04:00.000Z')] } as OperationalRun
    const intervals = runLayerIntervals(run, 'family')
    assert.equal(intervals.length, 3)
    assert.equal(intervals[0]?.endUtc, '2026-08-11T12:02:00.000Z')
    assert.equal(intervals[1]?.unavailable, true)
  })

  it('keeps one unified normal-Run timeline and an explicit long-Run exception', () => {
    const runSource = readFileSync(new URL('../src/components/RunEvidenceDrawer.tsx', import.meta.url), 'utf8')
    assert.match(runSource, /Unified synchronized Run evidence/)
    assert.match(runSource, /Context, Radius, Operational Group, Process Family, Physical Motion, Actual Speed/)
    assert.match(runSource, /This Run exceeds two hours/)
    assert.match(runSource, /Focused two-hour telemetry window/)
    assert.match(runSource, /showTimeline=\{false\}/)
  })

  it('automatically focuses Operational evidence and keeps telemetry failure independent of Radius/PI tracks', () => {
    const source = readFileSync(new URL('../src/components/OperationalActivityExplorer.tsx', import.meta.url), 'utf8')
    assert.match(source, /sort\(\(left, right\) => Date\.parse\(left\.startUtc\) - Date\.parse\(right\.startUtc\)/)
    assert.match(source, /setFocusedOccurrenceId\(item\.occurrenceId\)/)
    assert.match(source, /Focused occurrence/)
    assert.match(source, /complete occurrence chronology/)
    assert.match(source, /Focused two-hour telemetry window/)
    const emptyEvidence: PressTelemetryEvidenceState = { range: { fromUtc, toUtc, focused: false }, loading: false, error: true }
    const track = (id: string, label: string) => ({ id, label, intervals: [{ id, startUtc: fromUtc, endUtc: toUtc, label }] })
    const html = renderToStaticMarkup(createElement(UnifiedProcessTimeline, { fromUtc, toUtc, ariaLabel: 'Degraded', radiusTrack: track('radius', 'Radius recorded'), groupTrack: track('group', 'Operational Group'), familyTrack: track('family', 'Process Family'), telemetry: emptyEvidence }))
    assert.match(html, /Radius recorded/)
    assert.match(html, /Operational Group/)
    assert.match(html, /Process Family/)
  })

  it('contains no S\/400\/Sort Safety assumption in production visualization source', () => {
    for (const component of ['TelemetryEvidenceTimeline.tsx', 'UnifiedProcessTimeline.tsx', 'RunEvidenceDrawer.tsx', 'OperationalActivityExplorer.tsx', 'RadiusOverview.tsx']) {
      const source = readFileSync(new URL(`../src/components/${component}`, import.meta.url), 'utf8')
      assert.doesNotMatch(source, /S\s*\/\s*400[\s\S]{0,60}Safety/i)
    }
  })
})
