import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import React, { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { EvidenceDrawerShell } from '../src/components/EvidenceDrawerShell'
import { SynchronizedTimeline } from '../src/components/SynchronizedTimeline'

Object.assign(globalThis, { React })

describe('shared evidence foundations', () => {
  it('keeps zero-valued observations distinct from missing samples', () => {
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
    assert.match(html, /is-selected/)
  })

  it('renders shared modal semantics with focus containment and restoration', () => {
    const html = renderToStaticMarkup(createElement(EvidenceDrawerShell, { eyebrow: 'Evidence', title: 'Press 11 interval', context: 'Radius and telemetry', onClose() {} }, createElement('button', null, 'Evidence action')))
    assert.match(html, /role="dialog"/)
    assert.match(html, /aria-modal="true"/)
    const source = readFileSync(new URL('../src/components/EvidenceDrawerShell.tsx', import.meta.url), 'utf8')
    assert.match(source, /event\.key === 'Escape'/)
    assert.match(source, /event\.key !== 'Tab'/)
    assert.match(source, /returnFocus\.current\?\.focus\(\)/)
  })
})
