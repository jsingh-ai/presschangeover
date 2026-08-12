import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { areaFromPathname, areaPath, operationalSectionFromSearch, pressFromLocation } from '../src/navigation'
import { oppositeTheme, resolveTheme } from '../src/theme'

describe('analytics and administration navigation context', () => {
  it('recognizes analytics, Intelligent Search, and State Classification routes', () => {
    assert.equal(areaFromPathname('/overview'), 'overview')
    assert.equal(areaFromPathname('/operational-analysis'), 'operational-analysis')
    assert.equal(areaFromPathname('/patterns-episodes'), 'patterns-episodes')
    assert.equal(areaPath('patterns-episodes'), '/patterns-episodes')
    assert.equal(areaFromPathname('/intelligent-search'), 'intelligent-search')
    assert.equal(areaPath('intelligent-search'), '/intelligent-search')
    assert.equal(areaFromPathname('/administration/state-classification'), 'state-classification')
    assert.equal(areaPath('state-classification'), '/administration/state-classification')
    assert.equal(areaFromPathname('/press/press7'), 'overview')
  })

  it('preserves query press scope and accepts legacy press deep links', () => {
    assert.equal(pressFromLocation('/operational-analysis', '?press=press14'), 'press14')
    assert.equal(pressFromLocation('/press/press7', ''), 'press7')
    assert.equal(pressFromLocation('/overview', '?press=invalid'), undefined)
  })

  it('recognizes legacy operational-analysis section links safely', () => {
    assert.equal(operationalSectionFromSearch('?section=drivers'), 'drivers')
    assert.equal(operationalSectionFromSearch('?section=recovery'), 'recovery')
    assert.equal(operationalSectionFromSearch('?section=unknown'), 'state')
  })
})

describe('theme preference', () => {
  it('honors an explicit persisted preference over the OS preference', () => {
    assert.equal(resolveTheme('light', true), 'light')
    assert.equal(resolveTheme('dark', false), 'dark')
  })

  it('uses the OS preference only when no valid choice is stored', () => {
    assert.equal(resolveTheme(null, true), 'dark')
    assert.equal(resolveTheme('invalid', false), 'light')
    assert.equal(oppositeTheme('light'), 'dark')
    assert.equal(oppositeTheme('dark'), 'light')
  })
})
