import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import React, { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ApplicationShell } from '../src/components/ApplicationShell'

Object.assign(globalThis, { React })

describe('application shell', () => {
  it('renders analytics, Intelligent Search, and State Classification destinations', () => {
    const html = renderToStaticMarkup(createElement(ApplicationShell, {
      area: 'operational-analysis', theme: 'light', onNavigate() {}, onToggleTheme() {},
      context: createElement('span', null, 'Context'), children: createElement('h1', null, 'Operational Analysis'), footer: createElement('span', null, 'Health'),
    }))
    assert.equal((html.match(/class="primary-nav-link/g) ?? []).length, 5)
    assert.match(html, /Overview/)
    assert.match(html, /Operational Analysis/)
    assert.match(html, /Patterns &amp; Episodes/)
    assert.match(html, /Intelligent Search/)
    assert.match(html, /State Classification/)
    assert.match(html, /aria-current="page"/)
    assert.match(html, /Switch to dark mode/)
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
})
