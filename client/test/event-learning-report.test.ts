import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { EventLearningReport } from '../src/components/EventLearningReport'
import type { EventLearningReport as Contract } from '../src/types/api'

const report: Contract = {
  version: 1, reportKind: 'telemetry_event', title: 'Telemetry event learning report', target: { signal: 'Web Enable', detector: 'value_change', oldValue: true, newValue: false },
  selectedOccurrence: { occurrenceId: 'selected', startUtc: '2026-08-18T12:00:00.000Z', endUtc: '2026-08-18T12:01:00.000Z', label: 'Web Enable value change' }, recordedTime: { startUtc: '2026-08-18T12:00:00.000Z', endUtc: '2026-08-18T12:01:00.000Z' },
  physicalTiming: { agreementClass: 'PHYSICAL_PRECEDES_RECORDED', inferredPhysicalOnsetRange: { startUtc: '2026-08-18T11:56:00.000Z', endUtc: '2026-08-18T11:58:00.000Z' } }, productionContext: [{ field: 'material', value: 'PP' }], radiusContext: [{ relationship: 'AT_EVENT', eventType: 'B', statusCode: '400', statusDescription: 'Quality Hold' }],
  selectedFindings: [{ canonicalId: 'web.enabled', deckNumber: null, friendlyName: 'Web Enable', category: 'state', sourceUnit: null, kind: 'state', provenance: 'AUTHORITATIVE', description: 'TRUE → FALSE', direction: 'transition', magnitude: null, oldValue: true, newValue: false, atUtc: '2026-08-18T11:58:00.000Z', relativeMinutes: -2, persistenceMinutes: 8, reason: 'Authoritative value/state transition near the target', coverageObservations: 2, phase: { before: 'TRUE', event: 'TRUE → FALSE', recovery: 'TRUE' } }],
  phaseComparison: [{ canonicalId: 'web.enabled', deckNumber: null, friendlyName: 'Web Enable', before: 'TRUE', event: 'TRUE → FALSE', recovery: 'TRUE' }],
  historicalFingerprint: { requestedOccurrences: 4, qualifiedOccurrences: 3, excludedOccurrences: 1, radiusCoverage: null, telemetryCoverage: { startUtc: '2026-08-18T10:00:00.000Z', endUtc: '2026-08-18T12:05:00.000Z' }, findings: [{ canonicalId: 'web.enabled', deckNumber: null, friendlyName: 'Web Enable', category: 'state', sourceUnit: null, kind: 'state', provenance: 'AUTHORITATIVE', description: 'TRUE → FALSE', direction: 'transition', magnitude: null, oldValue: true, newValue: false, atUtc: '2026-08-18T11:58:00.000Z', relativeMinutes: -2, persistenceMinutes: 8, reason: 'state transition', coverageObservations: 2, phase: { before: 'TRUE', event: 'TRUE → FALSE', recovery: 'TRUE' }, validOccurrenceCount: 3, observedOccurrenceCount: 2, occurrenceRate: .667, medianRelativeMinutes: -2.5, relativeMinutesIqr: { lower: -3, upper: -2 }, medianMagnitude: null, occurrenceIds: ['selected', 'older'] }] },
  typicalSequence: [{ label: 'Web Enable: TRUE → FALSE', canonicalId: 'web.enabled', deckNumber: null, supportCount: 2, validOccurrenceCount: 3, medianRelativeMinutes: -2.5, relativeMinutesIqr: { lower: -3, upper: -2 } }], relationships: [{ signal: 'Web Enable', mode: 'TRANSITION_COOCCURRENCE', interpretation: 'Repeatedly associated with the target.', metrics: { occurrenceRate: .667 } }], occurrenceComparison: { common: ['Web Enable matches the recurring pattern.'], exceptions: [] }, controls: { status: 'UNAVAILABLE', reason: 'No safe controls.', comparisons: [] }, occurrenceMatrix: [{ occurrenceId: 'older', startUtc: '2026-08-18T10:00:00.000Z', patterns: ['web.enabled:'] }, { occurrenceId: 'selected', startUtc: '2026-08-18T12:00:00.000Z', patterns: ['web.enabled:'] }], coverage: { candidateSignals: 4, automaticRawSignalScans: 0, limitations: ['No causal inference.'] }, performance: { semanticHistoryRequests: 2, cohortOccurrences: 3, totalMs: 40, payloadBytes: 1200 },
}

describe('event learning report presentation', () => {
  it('renders the report below the debugger with state evidence, bounded coverage, and debugger actions', () => {
    const html = renderToStaticMarkup(createElement(EventLearningReport, { report, onPreview: () => undefined, onPin: () => undefined, onOpenOccurrence: () => undefined }))
    for (const label of ['Event report', 'What happened', 'Physical / event timeline', 'Most relevant changes', 'Before / event / recovery', 'Historical fingerprint', 'Typical sequence', 'Relationships', 'This occurrence vs typical', 'Radius / production context', 'Evidence coverage / limitations']) assert.match(html, new RegExp(label))
    assert.match(html, /TRUE → FALSE/); assert.match(html, /2\/3/); assert.match(html, /Preview/); assert.match(html, /Pin/); assert.match(html, /Open bounded historical occurrence/)
    assert.match(html, /Automatic raw\/unmapped scans:<\/strong> 0/)
  })
})
