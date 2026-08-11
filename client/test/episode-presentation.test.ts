import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { completionLabel, episodeVisualizationDurationSeconds, formatDuration, phaseClass, phaseGeometry, signedDurationDifference } from '../src/episode-presentation'
import type { OperationalEpisode, RadiusStateSegment } from '../src/types/api'

const segment: RadiusStateSegment = {
  kind: 'radius',
  machineId: 7,
  pressKey: 'press7',
  displayName: 'Press 7',
  startUtc: '2026-08-10T12:00:00.000Z',
  endUtc: '2026-08-10T12:10:00.000Z',
  durationSeconds: 600,
  isOpen: false,
  sourceGeneration: 'compact',
  eventType: 'M',
  statusCode: null,
  statusDescription: 'Make Ready',
  isProduction: false,
}

describe('episode presentation', () => {
  it('formats durations and signed comparisons without episode numbering', () => {
    assert.equal(formatDuration(3722), '1h 2m')
    assert.equal(signedDurationDifference(120), '+2m')
    assert.equal(signedDurationDifference(-30), '−30s')
  })

  it('uses the established Radius color categories', () => {
    assert.equal(phaseClass(segment), 'make-ready')
    assert.equal(phaseClass({ ...segment, eventType: 'B' }), 'bad')
    assert.equal(phaseClass({ ...segment, isProduction: true }), 'production')
  })

  it('distinguishes confirmed, interrupted, and open outcomes', () => {
    const base = { completionStatus: 'CONFIRMED_PRODUCTION' } as OperationalEpisode
    assert.equal(completionLabel(base), 'Production confirmed')
    assert.equal(completionLabel({ ...base, completionStatus: 'DATA_INTERRUPTED' }), 'Data interrupted')
    assert.equal(completionLabel({ ...base, completionStatus: 'OPEN' }), 'Open')
  })

  it('uses genuine confirmation and failed-attempt durations on the shared scale', () => {
    const confirmation = {
      ...segment,
      startUtc: '2026-08-10T09:25:00.000Z',
      endUtc: '2026-08-10T09:30:00.000Z',
      durationSeconds: 300,
      isProduction: true,
      returnToProduction: 'confirmed' as const,
    }
    const value = {
      startUtc: '2026-08-10T09:00:00.000Z',
      endUtc: '2026-08-10T09:25:00.000Z',
      durationSeconds: 1500,
      statusSegments: [{ ...segment, startUtc: '2026-08-10T09:00:00.000Z', endUtc: '2026-08-10T09:25:00.000Z', durationSeconds: 1500 }, confirmation],
    } as OperationalEpisode
    assert.equal(episodeVisualizationDurationSeconds(value), 1800)
    assert.deepEqual(phaseGeometry(value, confirmation, 1800), { leftPercent: 83.33333333333334, widthPercent: 16.666666666666664 })
    const failed = { ...confirmation, startUtc: '2026-08-10T10:35:00.000Z', endUtc: '2026-08-10T10:37:00.000Z', durationSeconds: 120, returnToProduction: 'failed' as const }
    const failedEpisode = { ...value, startUtc: '2026-08-10T10:00:00.000Z' }
    assert.equal(phaseGeometry(failedEpisode, failed, 3600).widthPercent, 120 / 3600 * 100)
  })
})
