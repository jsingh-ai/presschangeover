import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import React, { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { EvidenceDrawerShell } from '../src/components/EvidenceDrawerShell'
import { boundedEvidenceRange, capabilityLabel } from '../src/components/PhysicalEvidencePanel'
import { SynchronizedTimeline } from '../src/components/SynchronizedTimeline'
import type { SignalCapability } from '../src/types/evidence'

Object.assign(globalThis, { React })

function capability(state: SignalCapability['state'], lastKnownState?: SignalCapability['lastKnownState']): SignalCapability {
  return { canonicalId: 'machine.speed.actual', state, lastKnownState, deckNumbers: [], historyQueryable: true, evidenceKind: 'derived' }
}

describe('shared evidence foundations', () => {
  it('bounds physical evidence to two hours without falsely truncating an in-range interval', () => {
    const short = boundedEvidenceRange('2026-08-11T12:00:00.000Z', '2026-08-11T12:10:00.000Z')
    assert.deepEqual(short, { fromUtc: '2026-08-11T11:50:00.000Z', toUtc: '2026-08-11T12:20:00.000Z', focused: false })
    const exact = boundedEvidenceRange('2026-08-11T12:00:00.000Z', '2026-08-11T14:00:00.000Z')
    assert.deepEqual(exact, { fromUtc: '2026-08-11T12:00:00.000Z', toUtc: '2026-08-11T14:00:00.000Z', focused: false })
    const long = boundedEvidenceRange('2026-08-11T10:00:00.000Z', '2026-08-11T16:00:00.000Z')
    assert.deepEqual(long, { fromUtc: '2026-08-11T12:00:00.000Z', toUtc: '2026-08-11T14:00:00.000Z', focused: true })
  })

  it('keeps support states distinct from values such as zero', () => {
    assert.equal(capabilityLabel(capability('SUPPORTED')), 'Supported')
    assert.equal(capabilityLabel(capability('UNSUPPORTED')), 'Unsupported')
    assert.equal(capabilityLabel(capability('UNKNOWN')), 'Unknown capability')
    assert.equal(capabilityLabel(capability('TEMPORARILY_UNAVAILABLE', 'SUPPORTED')), 'Temporarily unavailable · last known supported')
    const html = renderToStaticMarkup(createElement(SynchronizedTimeline, {
      fromUtc: '2026-08-11T12:00:00.000Z', toUtc: '2026-08-11T12:01:00.000Z', ariaLabel: 'Zero-value evidence', intervalTracks: [],
      numericTracks: [{ id: 'speed', label: 'Actual Speed', samples: [{ observedAtUtc: '2026-08-11T12:00:00.000Z', value: 0 }] }],
    }))
    assert.match(html, /1 observed samples from 0 to 0/)
    assert.doesNotMatch(html, /No samples in this range/)
  })

  it('uses one accessible viewport, linked interval buttons, and explicit numeric gaps', () => {
    const html = renderToStaticMarkup(createElement(SynchronizedTimeline, {
      fromUtc: '2026-08-11T12:00:00.000Z', toUtc: '2026-08-11T12:01:00.000Z', ariaLabel: 'Shared evidence timeline', selectedId: 'radius-1',
      intervalTracks: [
        { id: 'radius', label: 'Radius recorded', intervals: [{ id: 'radius-1', startUtc: '2026-08-11T12:00:00.000Z', endUtc: '2026-08-11T12:00:30.000Z', label: 'Run Production' }] },
        { id: 'semantic', label: 'ProcessIntelligence', intervals: [{ id: 'semantic-1', startUtc: '2026-08-11T12:00:00.000Z', endUtc: '2026-08-11T12:00:30.000Z', label: 'Production' }] },
      ],
      numericTracks: [{ id: 'speed', label: 'Actual Speed', samples: [
        { observedAtUtc: '2026-08-11T12:00:00.000Z', value: 0 }, { observedAtUtc: '2026-08-11T12:00:01.000Z', value: 1 },
        { observedAtUtc: '2026-08-11T12:00:02.000Z', value: 2 }, { observedAtUtc: '2026-08-11T12:01:00.000Z', value: 3 },
      ] }],
    }))
    assert.equal((html.match(/synchronized-timeline__scroll/g) ?? []).length, 1)
    assert.equal((html.match(/<button/g) ?? []).length, 2)
    assert.equal((html.match(/<path/g) ?? []).length, 2)
    assert.match(html, /is-selected/)
  })

  it('renders the shared modal semantics and implements focus containment and restoration', () => {
    const html = renderToStaticMarkup(createElement(EvidenceDrawerShell, { eyebrow: 'Evidence', title: 'Press 11 interval', context: 'Radius and telemetry', onClose() {} }, createElement('button', null, 'Evidence action')))
    assert.match(html, /role="dialog"/)
    assert.match(html, /aria-modal="true"/)
    assert.match(html, /Close investigation evidence/)
    const source = readFileSync(new URL('../src/components/EvidenceDrawerShell.tsx', import.meta.url), 'utf8')
    assert.match(source, /event\.key === 'Escape'/)
    assert.match(source, /event\.key !== 'Tab'/)
    assert.match(source, /closeButton\.current\?\.focus\(\)/)
    assert.match(source, /returnFocus\.current\?\.focus\(\)/)
  })

  it('gates telemetry detail calls from capability metadata and degrades requests independently', () => {
    const source = readFileSync(new URL('../src/components/TelemetryEvidenceTimeline.tsx', import.meta.url), 'utf8')
    const panelSource = readFileSync(new URL('../src/components/PhysicalEvidencePanel.tsx', import.meta.url), 'utf8')
    assert.match(source, /item\.state === 'SUPPORTED'/)
    assert.match(source, /if \(supported\('machine\.speed\.actual'\)\)/)
    assert.match(source, /if \(supported\('physical\.motion_state'\)\)/)
    assert.match(source, /Promise\.allSettled\(requests\)/)
    assert.match(panelSource, /Some telemetry evidence could not be loaded/)
  })

  it('restores activity, pattern, and search state through browser navigation', () => {
    for (const component of ['OperationalActivityExplorer.tsx', 'PatternExplorer.tsx', 'IntelligentSearchPage.tsx']) {
      const source = readFileSync(new URL(`../src/components/${component}`, import.meta.url), 'utf8')
      assert.match(source, /addEventListener\('popstate'/)
      assert.match(source, /removeEventListener\('popstate'/)
      assert.match(source, /URLSearchParams\(window\.location\.search\)/)
    }
  })
})
