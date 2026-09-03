import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { areaFromPathname, areaPath, pressFromLocation } from '../src/navigation'
import { oppositeTheme, resolveTheme } from '../src/theme'

describe('analytics and administration navigation context', () => {
  it('recognizes current intelligence, explorer, and administration routes', () => {
    assert.equal(areaFromPathname('/overview'), 'overview')
    assert.equal(areaFromPathname('/machine-intelligence'), 'machine-intelligence')
    assert.equal(areaFromPathname('/job-intelligence'), 'machine-intelligence')
    assert.equal(areaPath('machine-intelligence'), '/machine-intelligence')
    assert.equal(areaFromPathname('/stop-intelligence'), 'stop-intelligence')
    assert.equal(areaPath('stop-intelligence'), '/stop-intelligence')
    assert.equal(areaFromPathname('/raw-radius-explorer'), 'raw-radius-explorer')
    assert.equal(areaPath('raw-radius-explorer'), '/raw-radius-explorer')
    assert.equal(areaFromPathname('/telemetry-event-explorer'), 'telemetry-event-explorer')
    assert.equal(areaFromPathname('/administration/state-classification'), 'state-classification')
    assert.equal(areaPath('state-classification'), '/administration/state-classification')
    assert.equal(areaFromPathname('/press/press7'), 'overview')
  })

  it('preserves query press scope and accepts legacy press deep links', () => {
    assert.equal(pressFromLocation('/overview', '?press=press14'), 'press14')
    assert.equal(pressFromLocation('/press/press7', ''), 'press7')
    assert.equal(pressFromLocation('/overview', '?press=invalid'), undefined)
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
