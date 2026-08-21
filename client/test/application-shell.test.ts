import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import React, { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ApplicationShell } from '../src/components/ApplicationShell'
import { readFileSync } from 'node:fs'

Object.assign(globalThis, { React })
const shellSource = readFileSync(new URL('../src/components/ApplicationShell.tsx', import.meta.url), 'utf8')
const stylesSource = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')

describe('application shell', () => {
  it('renders analytics, explorers, AI Investigator, search, and administration destinations', () => {
    const html = renderToStaticMarkup(createElement(ApplicationShell, {
      area: 'operational-analysis', theme: 'light', onNavigate() {}, onToggleTheme() {},
      context: createElement('span', null, 'Context'), children: createElement('h1', null, 'Operational Analysis'), footer: createElement('span', null, 'Health'),
    }))
    assert.equal((html.match(/class="primary-nav-link/g) ?? []).length, 10)
    assert.match(html, /Overview/)
    assert.match(html, /Operational Analysis/)
    assert.match(html, /Job Intelligence/)
    assert.match(html, /Changeover Intelligence/)
    assert.match(html, /Raw Radius Explorer/)
    assert.match(html, /Telemetry Event Explorer/)
    assert.match(html, /Patterns &amp; Episodes/)
    assert.match(html, /Intelligent Search/)
    assert.match(html, /AI Investigator/)
    assert.match(html, /State Classification/)
    assert.match(html, /aria-current="page"/)
    assert.match(html, /Switch to dark mode/)
    assert.match(html, /Hide main navigation/)
    assert.match(html, /aria-expanded="true"/)
  })

  it('exposes a persisted dark-mode state without removing navigation labels', () => {
    const html = renderToStaticMarkup(createElement(ApplicationShell, {
      area: 'patterns-episodes', theme: 'dark', onNavigate() {}, onToggleTheme() {},
      context: null, children: null, footer: null,
    }))
    assert.match(html, /aria-pressed="true"/)
    assert.match(html, /Switch to light mode/)
    assert.match(html, /Patterns &amp; Episodes/)
  })

  it('persists a compact desktop navigation state and keeps the control available in the sidebar', () => {
    assert.match(shellSource, /process-intelligence-sidebar-collapsed/)
    assert.match(shellSource, /localStorage\.setItem/)
    assert.match(shellSource, /is-main-sidebar-collapsed/)
    assert.match(shellSource, /Show main navigation/)
    assert.match(stylesSource, /grid-template-columns: 4\.6rem minmax\(0, 1fr\)/)
    assert.match(stylesSource, /@media \(min-width: 1181px\)/)
    assert.match(stylesSource, /\.sidebar-collapse-toggle \{ display: none; \}/)
  })
})
