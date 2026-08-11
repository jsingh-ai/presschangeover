import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import React, { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { groupedPhaseSequence, semanticLabel } from '../src/classification-presentation'
import { PressStateTimeline } from '../src/components/PressStateTimeline'
import type { OperationalGroup, RadiusOverview, RadiusStateSegment, RadiusOfflineSegment, ResolvedRadiusClassification } from '../src/types/api'

Object.assign(globalThis, { React })

const groups: OperationalGroup[] = [
  { id: 'routine', key: 'ROUTINE_PROCESS', displayName: 'Routine Support', description: 'Routine support', lightColor: '#0f827b', darkColor: '#35c7bd', icon: 'process', sortOrder: 30 },
  { id: 'admin', key: 'ADMIN_UNKNOWN', displayName: 'Administrative & Unknown', description: 'Fallback', lightColor: '#68727d', darkColor: '#9ca8b5', icon: 'unknown', sortOrder: 80 },
]

function classification(identity: string, statusDescription: string): ResolvedRadiusClassification {
  return { identity, eventType: 'B', statusCode: identity, statusDescription, operationalGroupId: 'routine', operationalGroupKey: 'ROUTINE_PROCESS', operationalGroupName: 'Routine Support', operationalGroupDescription: 'Routine support', operationalGroupLightColor: '#0f827b', operationalGroupDarkColor: '#35c7bd', operationalGroupIcon: 'process', processFamilyId: 'clean', processFamilyKey: 'CLEANING_WASH', processFamilyName: 'Cleaning / Wash', displayLabel: null, explanation: 'Seed', confidence: 'HIGH', needsReview: false, defaultTimelineVisibility: true, obsolete: false, mappingVersion: 3, isFallback: false }
}

const first: RadiusStateSegment = { kind: 'radius', machineId: 203, pressKey: 'press3', displayName: 'Press 3', startUtc: '2026-08-10T10:00:00.000Z', endUtc: '2026-08-10T10:10:00.000Z', durationSeconds: 600, isOpen: false, sourceGeneration: 'legacy', eventType: 'B', statusCode: '83', statusDescription: 'Drum Clean', isProduction: false, classification: classification('83', 'Drum Clean') }
const second: RadiusStateSegment = { ...first, startUtc: first.endUtc, endUtc: '2026-08-10T10:20:00.000Z', statusCode: '99', statusDescription: 'Plates: Wash', classification: classification('99', 'Plates: Wash') }
const offline: RadiusOfflineSegment = { kind: 'offline', machineId: 203, pressKey: 'press3', displayName: 'Press 3', startUtc: second.endUtc, endUtc: '2026-08-10T10:30:00.000Z', durationSeconds: 600, isOpen: false, sourceGeneration: 'offline_inference', eventType: null, statusCode: null, statusDescription: null, isProduction: false }

describe('semantic timeline presentation', () => {
  it('groups adjacent operational meaning while preserving exact raw boundaries', () => {
    assert.deepEqual(groupedPhaseSequence([first, second, offline]), [
      { label: 'Routine Support', durationSeconds: 1_200, offline: false },
      { label: 'Data unavailable', durationSeconds: 600, offline: true },
    ])
    assert.equal(semanticLabel(first), 'Routine Support')
    assert.equal(semanticLabel(offline), 'Data unavailable')
  })

  it('keeps Operations and Raw Radius views, exact identities, internal buttons, and offline distinct', () => {
    const overview = { fromUtc: first.startUtc, toUtc: offline.endUtc, stateBreakdownRunConfirmationSeconds: 300, operationalGroups: groups, presses: [{ pressKey: 'press3', displayName: 'Press 3', timelineSegments: [first, second, offline] }] } as unknown as RadiusOverview
    const html = renderToStaticMarkup(createElement(PressStateTimeline, { overview, selectedPress: 'press3' }))
    assert.match(html, />Operations</)
    assert.match(html, />Raw Radius</)
    assert.match(html, /Routine Support/)
    assert.match(html, /B \/ 83 \/ Drum Clean/)
    assert.match(html, /B \/ 99 \/ Plates: Wash/)
    assert.equal((html.match(/class="press-state-segment /g) ?? []).length, 3)
    assert.match(html, /press-state-segment--offline/)
    assert.match(html, /Data unavailable/)
    assert.doesNotMatch(html, /Data unavailable[^<]*Routine Support/)
  })
})
