import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { boundedTelemetryEventReportOccurrences } from '../src/api/process-intelligence-api'
import { ApiRequestError } from '../src/api/process-intelligence-api'
import { telemetryEventReportFailureMessage } from '../src/components/TelemetryEventExplorerPage'
import type { TelemetryEventOccurrence } from '../src/types/api'

const selected: TelemetryEventOccurrence = {
  occurrenceId: 'selected', sourceKind: 'canonical', pressKey: 'press14', displayName: 'Press 14', deckNumber: 1,
  canonicalId: 'anilox.drive.temperature.actual', rawIdentity: 'Press14.Deck1.AniloxTemperature', signalDisplayName: 'Anilox temperature',
  sourceUnit: 'degC', canonicalUnitStatus: 'VERIFIED', valueKind: 'numeric', dataKind: 'numeric', pressOccurrenceIndex: 500,
  pressOccurrenceCount: 500, startUtc: '2026-08-20T12:00:00.000Z', endUtc: '2026-08-20T12:01:00.000Z',
  durationSeconds: 60, chartFromUtc: '2026-08-20T11:30:00.000Z', chartToUtc: '2026-08-20T12:31:00.000Z',
  eventType: 'delta', clippedEnd: false, dataGap: false, baselineValue: 100, triggerValue: 110, actualDelta: 10, direction: 'increase',
}

describe('Telemetry Event Learning reliability boundary', () => {
  it('sends only the same-detector 24-hour cohort the report can analyze', () => {
    const occurrences = Array.from({ length: 500 }, (_item, index) => {
      const start = new Date(Date.parse(selected.startUtc) - (499 - index) * 60_000).toISOString()
      return { ...selected, occurrenceId: `event-${index}`, startUtc: start, endUtc: new Date(Date.parse(start) + 60_000).toISOString() }
    })
    occurrences.push({ ...selected, occurrenceId: 'wrong-signal', rawIdentity: 'other' })
    const bounded = boundedTelemetryEventReportOccurrences(selected, occurrences)
    assert.equal(bounded.length, 30)
    assert.equal(bounded.at(-1), selected)
    assert.ok(bounded.every((item) => item.rawIdentity === selected.rawIdentity))
    const requestBytes = Buffer.byteLength(JSON.stringify({ occurrence: selected, rule: { kind: 'delta', direction: 'either', amount: 10, windowMinutes: 5 }, occurrences: bounded }))
    assert.ok(requestBytes < 256 * 1024)
  })

  it('preserves exact detector fields and distinguishes unavailable from technical failure text', () => {
    const apiSource = readFileSync(new URL('../src/api/process-intelligence-api.ts', import.meta.url), 'utf8')
    assert.match(apiSource, /configuredDirection: rule\.direction/)
    assert.match(apiSource, /configuredDelta: rule\.amount/)
    assert.match(apiSource, /deltaWindowMinutes: rule\.windowMinutes/)
    assert.match(apiSource, /operator: rule\.operator, threshold: rule\.threshold/)
    const reportSource = readFileSync(new URL('../src/components/EventLearningReport.tsx', import.meta.url), 'utf8')
    assert.match(reportSource, /Relationship analysis unavailable/)
    assert.match(reportSource, /RELATIONSHIP_ANALYSIS_FAILED|relationshipAnalysis\.reason/)
    assert.match(telemetryEventReportFailureMessage(new ApiRequestError(503)), /temporarily unavailable/)
    assert.match(telemetryEventReportFailureMessage(new ApiRequestError(500)), /could not be generated/)
  })
})
