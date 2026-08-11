import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import React, { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { RunComparison } from '../src/components/RunComparison'
import type { OperationalRunComparison, RunBenchmarkStats } from '../src/types/api'

Object.assign(globalThis, { React })

const stats = (overrides: Partial<RunBenchmarkStats> = {}): RunBenchmarkStats => ({ sampleRuns: 8, samplePresses: 1, sufficientSupport: true, average: 700, median: 600, delta: 300, percentDelta: 50, percentile: 88, ...overrides })
const comparison: OperationalRunComparison = {
  pressKey: 'press5', displayName: 'Press 5', fromUtc: '2026-08-10T00:00:00.000Z', toUtc: '2026-08-11T00:00:00.000Z', confirmationSeconds: 120, samePressMinimumRuns: 5, fleetMinimumPresses: 3, fleetMinimumRuns: 10, similarRelativeTolerance: .1, similarAbsoluteSeconds: 60,
  runs: [{
    runId: 'press5:run1', sequenceNumber: 12, pressKey: 'press5', displayName: 'Press 5', startUtc: '2026-08-10T09:00:00.000Z', endUtc: '2026-08-10T11:30:00.000Z', productionStartUtc: '2026-08-10T09:15:00.000Z', timeToProductionSeconds: 900, productionDurationSeconds: 8_100, totalDurationSeconds: 9_000, transitionCount: 4, distinctStatusCount: 3, shortRunAttemptCount: 1, shortRunAttemptDurationSeconds: 60, isPartial: false, dataInterrupted: false, eligibleForBenchmark: true,
    segments: [
      { segmentId: 'mr', exactIdentity: 'M\u001f47\u001fMake Ready', eventType: 'M', statusCode: '47', statusDescription: 'Make Ready', startUtc: '2026-08-10T09:00:00.000Z', endUtc: '2026-08-10T09:08:00.000Z', durationSeconds: 480, phase: 'pre-production', isUnavailable: false, isShortRunAttempt: false },
      { segmentId: 'clean', exactIdentity: 'B\u001f123\u001fClean Impression', eventType: 'B', statusCode: '123', statusDescription: 'Clean Impression', startUtc: '2026-08-10T09:08:00.000Z', endUtc: '2026-08-10T09:14:00.000Z', durationSeconds: 360, phase: 'pre-production', isUnavailable: false, isShortRunAttempt: false },
      { segmentId: 'attempt', exactIdentity: 'G\u001f150\u001fRun Production', eventType: 'G', statusCode: '150', statusDescription: 'Run Production', startUtc: '2026-08-10T09:14:00.000Z', endUtc: '2026-08-10T09:15:00.000Z', durationSeconds: 60, phase: 'pre-production', isUnavailable: false, isShortRunAttempt: true },
      { segmentId: 'production', exactIdentity: 'G\u001f150\u001fRun Production', eventType: 'G', statusCode: '150', statusDescription: 'Run Production', startUtc: '2026-08-10T09:15:00.000Z', endUtc: '2026-08-10T11:30:00.000Z', durationSeconds: 8_100, phase: 'production', isUnavailable: false, isShortRunAttempt: false },
    ],
    timeToProductionBenchmark: { direction: 'slower', samePress: stats(), fleet: stats({ sampleRuns: 30, samplePresses: 6 }) },
    productionDurationBenchmark: { direction: 'longer', samePress: stats({ delta: 1_200 }) }, transitionBenchmark: stats({ delta: 2 }), shortAttemptCountBenchmark: stats({ median: 0, delta: 1 }), shortAttemptDurationBenchmark: stats({ median: 0, delta: 60 }),
    statusSummaries: [{ exactIdentity: 'B\u001f123\u001fClean Impression', eventType: 'B', statusCode: '123', statusDescription: 'Clean Impression', totalDurationSeconds: 360, preProductionDurationSeconds: 360, occurrenceCount: 1, preProductionContributionPercent: 40, samePress: { ...stats({ median: 180, delta: 180, percentDelta: 100, percentile: 92 }), eligibleRuns: 8, containingRuns: 6, occurrenceFrequencyPercent: 75, typicalOccurrenceCount: 1, occurrenceDelta: 0, direction: 'longer' }, fleet: stats({ sampleRuns: 30, samplePresses: 6, median: 240, delta: 120 }) }],
    contributors: [{ exactIdentity: 'B\u001f123\u001fClean Impression', statusDescription: 'Clean Impression', excessSeconds: 180, segmentIds: ['clean'] }],
    sequenceComparison: { commonSequence: ['M\u001f47\u001fMake Ready', 'B\u001f123\u001fClean Impression', 'G\u001f150\u001fRun Production'], runSequence: ['M\u001f47\u001fMake Ready', 'B\u001f123\u001fClean Impression', 'G\u001f150\u001fRun Production', 'G\u001f150\u001fRun Production'], variation: true, sufficientSupport: true },
    flags: ['Slower to production', '1 short Run attempt', 'Sequence variation'], rank: { timeToProduction: 2, productionDuration: 3, comparableRuns: 9 },
  }],
}

describe('Run Comparison decision support', () => {
  it('uses the global press selection and adds no competing selector', () => {
    const html = renderToStaticMarkup(createElement(RunComparison, { selectedPress: 'press5', comparison, onInspectSegment() {} }))
    assert.match(html, /Press 5 · elapsed-time comparison/)
    assert.doesNotMatch(html, /<select/)
  })

  it('shows an instruction state for All Presses without mixed Run rows', () => {
    const html = renderToStaticMarkup(createElement(RunComparison, { onInspectSegment() {} }))
    assert.match(html, /Select a press to compare individual operating Runs/)
    assert.doesNotMatch(html, /run-row selected/)
    assert.doesNotMatch(html, /<select/)
  })

  it('renders the complete Run with sustained production as a proportional Gantt segment', () => {
    const html = renderToStaticMarkup(createElement(RunComparison, { selectedPress: 'press5', comparison, onInspectSegment() {} }))
    assert.equal((html.match(/<article/g) ?? []).length, 1)
    assert.match(html, /run-relative-scale/)
    assert.match(html, /run-relative-segment--production/)
    assert.match(html, /style="width:90%"/)
    assert.match(html, /Production duration<\/span><strong>2h 15m/)
    assert.doesNotMatch(html, /overflow-x/)
  })

  it('renders Run start, end, server total duration, and complete tooltip content', () => {
    const html = renderToStaticMarkup(createElement(RunComparison, { selectedPress: 'press5', comparison, onInspectSegment() {} }))
    assert.match(html, /Aug 10, 4:00:00 AM CT → Aug 10, 6:30:00 AM CT/)
    assert.match(html, /2h 30m total/)
    assert.match(html, /Start Aug 10, 4:00:00 AM CT\. End Aug 10, 6:30:00 AM CT\. Total duration 2h 30m\. Time to sustained production 15m\. Sustained production duration 2h 15m\. Short Run attempts 1\. State transitions 4\./)
  })

  it('exposes exact segment timing and sustained-production interpretation to hover and focus', () => {
    const html = renderToStaticMarkup(createElement(RunComparison, { selectedPress: 'press5', comparison, onInspectSegment() {} }))
    assert.match(html, /Run Production\. G \/ 150\. Start Aug 10, 4:15:00 AM CT\. End Aug 10, 6:30:00 AM CT\. Duration 2h 15m\. Confirmed sustained production\./)
    assert.match(html, /Clean Impression\. B \/ 123\. Start Aug 10, 4:08:00 AM CT\. End Aug 10, 4:14:00 AM CT\. Duration 6m\./)
  })

  it('uses one common visible scale instead of stretching every Run to full width', () => {
    const original = comparison.runs[0]!
    const shorter = { ...original, runId: 'press5:run2', sequenceNumber: 13, endUtc: '2026-08-10T10:15:00.000Z', totalDurationSeconds: 4_500, productionDurationSeconds: 3_600, segments: [original.segments[0]!, { ...original.segments[3]!, segmentId: 'production-2', startUtc: '2026-08-10T09:15:00.000Z', endUtc: '2026-08-10T10:15:00.000Z', durationSeconds: 3_600 }] }
    const html = renderToStaticMarkup(createElement(RunComparison, { selectedPress: 'press5', comparison: { ...comparison, runs: [original, shorter] }, onInspectSegment() {} }))
    assert.match(html, /data-run-width-percent="100\.00"/)
    assert.match(html, /data-run-width-percent="50\.00"/)
  })

  it('renders primary slower/faster decision language and compact flags', () => {
    const html = renderToStaticMarkup(createElement(RunComparison, { selectedPress: 'press5', comparison, onInspectSegment() {} }))
    assert.match(html, /Slower to production/)
    assert.match(html, /1 short Run attempt/)
    assert.match(html, /Sequence variation/)
  })

  it('renders selected Run contributors, sequence, ranking, and exact status totals on-page', () => {
    const html = renderToStaticMarkup(createElement(RunComparison, { selectedPress: 'press5', comparison, onInspectSegment() {} }))
    assert.match(html, /What made this Run different\?/)
    assert.match(html, /Clean Impression/)
    assert.match(html, /Common Press 5 sequence/)
    assert.match(html, /#2 slowest of 9/)
    assert.match(html, /Exact status breakdown/)
  })

  it('keeps short Run Production evidence exact and clickable', () => {
    const html = renderToStaticMarkup(createElement(RunComparison, { selectedPress: 'press5', comparison, onInspectSegment() {} }))
    assert.match(html, /Run Production\. G \/ 150\..*Duration 1m\. Short Run attempt/)
    assert.match(html, /run-relative-segment--short/)
    assert.match(html, /did not satisfy the 2m sustained-production threshold/)
  })

  it('preserves partial and data-unavailable semantics in full Run bars', () => {
    const original = comparison.runs[0]!
    const unavailable = { segmentId: 'gap', exactIdentity: null, eventType: null, statusCode: null, statusDescription: null, startUtc: comparison.fromUtc, endUtc: '2026-08-10T00:05:00.000Z', durationSeconds: 300, phase: 'pre-production' as const, isUnavailable: true, isShortRunAttempt: false }
    const partial = { ...original, startUtc: comparison.fromUtc, isPartial: true, dataInterrupted: true, segments: [unavailable, ...original.segments] }
    const html = renderToStaticMarkup(createElement(RunComparison, { selectedPress: 'press5', comparison: { ...comparison, runs: [partial] }, onInspectSegment() {} }))
    assert.match(html, /Before selected period/)
    assert.match(html, /run-relative-segment--unavailable/)
    assert.match(html, /Radius observations unavailable; prior state not carried forward/)
  })
})
