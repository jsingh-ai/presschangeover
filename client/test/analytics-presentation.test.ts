import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { categoryClass, relationshipStrength, statusLabel, supportText } from '../src/analytics-presentation'

describe('analytics presentation contract', () => {
  it('never hides the numerator or denominator behind a percentage', () => {
    assert.equal(supportText(9, 10), '9/10 · 90.0%')
    assert.equal(supportText(0, 0), '0/0 · 0.0%')
  })

  it('qualifies small 100% samples without calling them always', () => {
    assert.equal(relationshipStrength({ numerator: 5, denominator: 5, percentage: 100 }), 'Dominant')
    assert.equal(relationshipStrength({ numerator: 10, denominator: 10, percentage: 100 }), 'Consistent in range')
  })

  it('preserves exact status labels and Radius category colors', () => {
    assert.equal(statusLabel({ statusCode: '42', statusDescription: 'Web Break' }), 'Web Break · 42')
    assert.equal(categoryClass('M'), 'make-ready')
    assert.equal(categoryClass('X'), 'other')
  })
})
