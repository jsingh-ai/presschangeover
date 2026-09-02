import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { buildPressDowntimeReport } from '../src/press-downtime/engine.js'
import type { StopIntelligenceFleetReport, StopFleetPressSummary } from '../src/stop-intelligence/contracts.js'

const at = (minute: number) => new Date(Date.UTC(2026, 7, 28, 0, minute)).toISOString()

function fleet(input: {
  identityContext?: StopFleetPressSummary['identityContext']
  episodes?: StopFleetPressSummary['episodes']
  unknownIntervals?: StopFleetPressSummary['speedContext']['unknownIntervals']
  corrections?: StopIntelligenceFleetReport['operatorCorrections']
  telemetryEvidenceState?: StopFleetPressSummary['telemetryEvidenceState']
  observations?: StopFleetPressSummary['speedContext']['observations']
  radiusStates?: StopFleetPressSummary['radiusContext']['states']
  rollLengthContext?: StopFleetPressSummary['rollLengthContext']
} = {}): StopIntelligenceFleetReport {
  const episodes = input.episodes ?? []
  return {
    fromUtc: at(0), toUtc: at(60), algorithmVersion: 'test', classificationVersion: 'stop-intelligence-classification-v4.0.0', correctionPersistence: 'postgresql', operatorCorrections: input.corrections ?? [],
    presses: [{
      pressKey: 'press15', displayName: 'Press 15', telemetryEvidenceState: input.telemetryEvidenceState ?? 'AVAILABLE', stopCount: episodes.length, totalPhysicalStopSeconds: episodes.reduce((sum, item) => sum + item.physicalDurationSeconds, 0), changeoverCount: 0, downtimeCount: 0, uncertainCount: 0, badDataCount: 0, changeoverPhysicalStopSeconds: 0, longestPhysicalStopSeconds: 0, dataAvailabilityWarning: false, warningReason: null, episodes,
      speedContext: { fromUtc: at(0), toUtc: at(60), unit: 'ft/min', stopThreshold: 1, recoveryThreshold: 595, observations: input.observations ?? [{ atUtc: at(0), speed: 1_000, qualityState: 'GOOD' }], unknownIntervals: input.unknownIntervals ?? [] },
      radiusContext: { states: input.radiusStates ?? [], reason: 'test' }, identityContext: input.identityContext ?? [
        { signalId: 1, canonicalId: 'production.order', rawIdentity: 'order', observations: [{ atUtc: at(0), value: 'A', qualityState: 'GOOD' }] },
        { signalId: 2, canonicalId: 'production.recipe', rawIdentity: 'recipe', observations: [{ atUtc: at(0), value: 'R', qualityState: 'GOOD' }] },
      ], rollLengthContext: input.rollLengthContext ?? null, productionAttributeContext: [],
    }],
  }
}

function episode(start: number, end: number, classification: StopFleetPressSummary['episodes'][number]['classification']): StopFleetPressSummary['episodes'][number] {
  return { stopId: `press15-${start}`, pressKey: 'press15', startAt: at(start), endAt: at(end), physicalDurationSeconds: (end - start) * 60, classification, confidence: 'HIGH', movementAttemptCount: 0, failedRecoveryCount: 0, radiusAlignment: 'RADIUS_UNAVAILABLE', radiusStatusDescription: null, primaryReasonCodes: [], leftCensored: false, rightCensored: false, affectedByCollectionGap: false, affectedBySpeedQuality: false, changeoverActivityWindows: [] }
}

test('creates a new occurrence at every Order or Recipe change and groups repeated identity pairs', () => {
  const report = buildPressDowntimeReport(fleet({ identityContext: [
    { signalId: 1, canonicalId: 'production.order', rawIdentity: 'order', observations: [{ atUtc: at(0), value: 'A', qualityState: 'GOOD' }, { atUtc: at(20), value: 'B', qualityState: 'GOOD' }, { atUtc: at(40), value: 'A', qualityState: 'GOOD' }] },
    { signalId: 2, canonicalId: 'production.recipe', rawIdentity: 'recipe', observations: [{ atUtc: at(0), value: 'R', qualityState: 'GOOD' }] },
  ] }))
  assert.equal(report.jobGroups.length, 2)
  const repeated = report.jobGroups.find((item) => item.order === 'A' && item.recipe === 'R')!
  assert.equal(repeated.occurrenceCount, 2)
  assert.deepEqual(repeated.occurrences.map(({ occurrenceNumber, startUtc, endUtc, boundaryFields }) => ({ occurrenceNumber, startUtc, endUtc, boundaryFields })), [
    { occurrenceNumber: 1, startUtc: at(0), endUtc: at(20), boundaryFields: [] },
    { occurrenceNumber: 2, startUtc: at(40), endUtc: at(60), boundaryFields: ['order'] },
  ])
  assert.equal(repeated.totals.GOOD_RUN, 2_400)
  assert.equal(report.jobGroups.find((item) => item.order === 'B')?.occurrences[0]?.boundaryFields[0], 'order')
})

test('keeps one job instance across a temporary identity gap while accounting for the gap as missing time', () => {
  const report = buildPressDowntimeReport(fleet({ identityContext: [
    { signalId: 1, canonicalId: 'production.order', rawIdentity: 'order', observations: [{ atUtc: at(0), value: 'A', qualityState: 'GOOD' }, { atUtc: at(20), value: 'Unavailable', qualityState: 'GOOD' }, { atUtc: at(30), value: 'A', qualityState: 'GOOD' }] },
    { signalId: 2, canonicalId: 'production.recipe', rawIdentity: 'recipe', observations: [{ atUtc: at(0), value: 'R', qualityState: 'GOOD' }] },
  ] }))
  assert.equal(report.jobGroups.length, 1)
  assert.equal(report.jobGroups[0]?.occurrenceCount, 1)
  assert.equal(report.jobGroups[0]?.occurrences[0]?.startUtc, at(0))
  assert.equal(report.jobGroups[0]?.occurrences[0]?.endUtc, at(60))
  assert.deepEqual(report.totals, { CHANGEOVER: 0, GOOD_RUN: 3_000, DOWNTIME: 0, MISSING_DATA: 600 })
  assert.deepEqual(report.identityTimeline.map(({ order, recipe, missingFields }) => ({ order, recipe, missingFields })), [
    { order: 'A', recipe: 'R', missingFields: [] },
    { order: null, recipe: 'R', missingFields: ['order'] },
    { order: 'A', recipe: 'R', missingFields: [] },
  ])
  assert.equal(report.classificationTimeline.find(({ category }) => category === 'MISSING_DATA')?.underlyingState, 'IDENTITY_UNAVAILABLE')
})

test('uses latest operator review over prediction and accounts for every category exactly', () => {
  const corrections: StopIntelligenceFleetReport['operatorCorrections'] = [
    { correctionId: 'good', pressKey: 'press15', segmentKey: 'good', fromUtc: at(10), toUtc: at(12), predictedState: 'CHANGEOVER', correctedState: 'GOOD_PRODUCTION', comment: null, createdAtUtc: at(13) },
    { correctionId: 'routine', pressKey: 'press15', segmentKey: 'routine', fromUtc: at(25), toUtc: at(28), predictedState: 'OBSERVABLE_NON_STOP', correctedState: 'ROUTINE', comment: null, createdAtUtc: at(29) },
    { correctionId: 'old-uncertain', pressKey: 'press15', segmentKey: 'uncertain', fromUtc: at(55), toUtc: at(57), predictedState: 'OBSERVABLE_NON_STOP', correctedState: 'UNCERTAIN', comment: null, createdAtUtc: at(58) },
    { correctionId: 'override-missing', pressKey: 'press15', segmentKey: 'missing', fromUtc: at(50), toUtc: at(52), predictedState: 'UNKNOWN', correctedState: 'CHANGEOVER', comment: null, createdAtUtc: at(59) },
  ]
  const report = buildPressDowntimeReport(fleet({
    episodes: [episode(5, 15, 'CHANGEOVER'), episode(20, 25, 'UNCERTAIN'), episode(30, 35, 'DOWNTIME'), episode(40, 45, 'IGNORE_BAD_DATA')],
    unknownIntervals: [{ fromUtc: at(50), toUtc: at(55), state: 'SOURCE_TELEMETRY_UNAVAILABLE' }], corrections,
  }))
  assert.deepEqual(report.totals, { CHANGEOVER: 600, GOOD_RUN: 1_620, DOWNTIME: 900, MISSING_DATA: 480 })
  assert.equal(Object.values(report.totals).reduce((sum, value) => sum + value, 0), 3_600)
  assert.equal(report.jobGroups[0]?.occurrences[0]?.segments.find((item) => item.startUtc === at(50))?.source, 'OPERATOR_REVIEW')
  assert.equal(report.availability, 'PARTIAL')
})

test('marks the full range missing when trustworthy speed evidence is unavailable', () => {
  const report = buildPressDowntimeReport(fleet({ telemetryEvidenceState: 'INSUFFICIENT_DETAILED_TELEMETRY', observations: [] }))
  assert.deepEqual(report.totals, { CHANGEOVER: 0, GOOD_RUN: 0, DOWNTIME: 0, MISSING_DATA: 3_600 })
  assert.equal(report.availability, 'UNAVAILABLE')

  const unexpectedlyEmptyAvailableFeed = buildPressDowntimeReport(fleet({ telemetryEvidenceState: 'AVAILABLE', observations: [] }))
  assert.deepEqual(unexpectedlyEmptyAvailableFeed.totals, { CHANGEOVER: 0, GOOD_RUN: 0, DOWNTIME: 0, MISSING_DATA: 3_600 })
})

test('aligns raw Radius G B M against our states and assigns completed roll resets to jobs', () => {
  const report = buildPressDowntimeReport(fleet({
    observations: [{ atUtc: at(0), speed: 800, qualityState: 'GOOD' }, { atUtc: at(10), speed: 0, qualityState: 'GOOD' }, { atUtc: at(20), speed: null, qualityState: 'BAD' }],
    episodes: [episode(5, 15, 'CHANGEOVER'), episode(40, 45, 'UNCERTAIN')],
    radiusStates: [
      { kind: 'radius', startUtc: at(0), endUtc: at(10), eventType: 'G', statusCode: '150', statusDescription: 'Run Production', isProduction: true },
      { kind: 'radius', startUtc: at(10), endUtc: at(20), eventType: 'M', statusCode: '210', statusDescription: 'Make Ready', isProduction: false },
      { kind: 'radius', startUtc: at(20), endUtc: at(60), eventType: 'B', statusCode: '310', statusDescription: 'Bad / downtime', isProduction: false },
    ],
    rollLengthContext: { signalId: 3, canonicalId: 'production.roll.length.actual', rawIdentity: 'roll.length', unit: 'ft', observations: [
      { atUtc: at(0), value: 0, qualityState: 'GOOD' }, { atUtc: at(4), value: 100, qualityState: 'GOOD' }, { atUtc: at(8), value: 200, qualityState: 'GOOD' }, { atUtc: at(12), value: 0, qualityState: 'GOOD' },
      { atUtc: at(20), value: 100, qualityState: 'GOOD' }, { atUtc: at(30), value: 300, qualityState: 'GOOD' }, { atUtc: at(35), value: 0, qualityState: 'GOOD' },
    ] },
  }))
  assert.deepEqual(report.radiusTotals, { G: 600, B: 2_400, M: 600, MISSING_DATA: 0 })
  assert.deepEqual(report.radiusTimeline.map(({ category, eventType, statusCode }) => [category, eventType, statusCode]), [['G', 'G', '150'], ['M', 'M', '210'], ['B', 'B', '310']])
  assert.deepEqual(report.speedTrend, { unit: 'ft/min', observations: [{ atUtc: at(0), value: 800, qualityState: 'GOOD' }, { atUtc: at(10), value: 0, qualityState: 'GOOD' }] })
  assert.equal(report.classificationTimeline.find(({ underlyingState }) => underlyingState === 'UNCERTAIN')?.category, 'DOWNTIME')
  assert.deepEqual(report.rollSummary, { total: 2, good: 1, changeover: 1, goodLength: 300, changeoverLength: 200 })
  assert.deepEqual(report.jobGroups[0]?.rolls.map(({ category, length }) => [category, length]), [['CHANGEOVER', 200], ['GOOD', 300]])
})

test('Press Downtime reads shared telemetry and corrections without adding a database write path', () => {
  const service = readFileSync(new URL('../src/press-downtime/service.ts', import.meta.url), 'utf8')
  const engine = readFileSync(new URL('../src/press-downtime/engine.ts', import.meta.url), 'utf8')
  const app = readFileSync(new URL('../src/app.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(`${service}\n${engine}`, /\b(?:insert\s+into|update\s+\w+\s+set|delete\s+from|create\s+table|drop\s+table)\b/i)
  assert.match(service, /stopIntelligence\.fleet/)
  assert.match(app, /\/api\/press-downtime\/presses\/:pressKey[\s\S]*?parseStopIntelligenceQuery/)
})
