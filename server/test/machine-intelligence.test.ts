import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { buildMachineIntelligenceOverview } from '../src/machine-intelligence/engine.js'
import { MachineIntelligenceService } from '../src/machine-intelligence/service.js'
import type { RadiusPressKey } from '../src/radius/models.js'
import type { StopIntelligenceFleetReport, StopFleetPressSummary } from '../src/stop-intelligence/contracts.js'
import type { StopIntelligenceService } from '../src/stop-intelligence/service.js'

const at = (minute: number) => new Date(Date.UTC(2026, 7, 28, 0, minute)).toISOString()

function fleet(input: {
  pressKey?: RadiusPressKey
  identityContext?: StopFleetPressSummary['identityContext']
  episodes?: StopFleetPressSummary['episodes']
  unknownIntervals?: StopFleetPressSummary['speedContext']['unknownIntervals']
  corrections?: StopIntelligenceFleetReport['operatorCorrections']
  observations?: StopFleetPressSummary['speedContext']['observations']
  radiusStates?: StopFleetPressSummary['radiusContext']['states']
  rollLengthContext?: StopFleetPressSummary['rollLengthContext']
} = {}): StopIntelligenceFleetReport {
  const pressKey = input.pressKey ?? 'press15'; const episodes = input.episodes ?? []
  return {
    fromUtc: at(0), toUtc: at(60), algorithmVersion: 'test', classificationVersion: 'stop-intelligence-classification-v4.0.0', correctionPersistence: 'memory', operatorCorrections: input.corrections ?? [],
    presses: [{
      pressKey, displayName: pressKey.replace('press', 'Press '), telemetryEvidenceState: 'AVAILABLE', stopCount: episodes.length, totalPhysicalStopSeconds: 0, changeoverCount: 0, downtimeCount: 0, uncertainCount: 0, badDataCount: 0, changeoverPhysicalStopSeconds: 0, longestPhysicalStopSeconds: 0, dataAvailabilityWarning: false, warningReason: null, episodes,
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

test('returns only fleet comparison totals while honoring review and missing-data intervals', () => {
  const overview = buildMachineIntelligenceOverview(fleet({
    episodes: [episode(5, 15, 'CHANGEOVER'), episode(20, 25, 'UNCERTAIN'), episode(30, 35, 'DOWNTIME')],
    unknownIntervals: [{ fromUtc: at(50), toUtc: at(55), state: 'SOURCE_TELEMETRY_UNAVAILABLE' }],
    corrections: [{ correctionId: 'review', pressKey: 'press15', segmentKey: 'review', fromUtc: at(10), toUtc: at(12), predictedState: 'CHANGEOVER', correctedState: 'GOOD_PRODUCTION', comment: null, createdAtUtc: at(13) }],
  }))
  assert.deepEqual(overview.totals, { CHANGEOVER: 480, GOOD_RUN: 2_220, DOWNTIME: 600, MISSING_DATA: 300 })
  assert.equal(overview.availability, 'PARTIAL')
  assert.deepEqual(Object.keys(overview).sort(), ['availability', 'displayName', 'pressKey', 'radiusTotals', 'reason', 'rollSummary', 'totals'])
})

test('summarizes Radius states and completed rolls without retaining timelines or job groups', () => {
  const overview = buildMachineIntelligenceOverview(fleet({
    episodes: [episode(5, 15, 'CHANGEOVER')],
    radiusStates: [
      { kind: 'radius', startUtc: at(0), endUtc: at(10), eventType: 'G', statusCode: '150', statusDescription: 'Run', isProduction: true },
      { kind: 'radius', startUtc: at(10), endUtc: at(20), eventType: 'M', statusCode: '210', statusDescription: 'Make Ready', isProduction: false },
      { kind: 'radius', startUtc: at(20), endUtc: at(60), eventType: 'B', statusCode: '310', statusDescription: 'Bad', isProduction: false },
    ],
    rollLengthContext: { signalId: 3, canonicalId: 'production.roll.length.actual', rawIdentity: 'roll.length', unit: 'ft', observations: [
      { atUtc: at(0), value: 0, qualityState: 'GOOD' }, { atUtc: at(8), value: 200, qualityState: 'GOOD' }, { atUtc: at(12), value: 0, qualityState: 'GOOD' },
      { atUtc: at(20), value: 100, qualityState: 'GOOD' }, { atUtc: at(30), value: 300, qualityState: 'GOOD' }, { atUtc: at(35), value: 0, qualityState: 'GOOD' },
    ] },
  }))
  assert.deepEqual(overview.radiusTotals, { G: 600, B: 2_400, M: 600, MISSING_DATA: 0 })
  assert.deepEqual(overview.rollSummary, { total: 2, good: 1, changeover: 1, goodLength: 300, changeoverLength: 200 })
  assert.equal('jobGroups' in overview, false)
  assert.equal('classificationTimeline' in overview, false)
})

test('loads every press through one overview call without retaining Stop Intelligence analysis results', async () => {
  const calls: Array<{ pressKey: RadiusPressKey; cache: string | undefined }> = []
  const stopIntelligence = {
    fleet: async (input: { pressKey: RadiusPressKey }, _requestId?: string, _signal?: AbortSignal, options?: { cache?: string }) => {
      calls.push({ pressKey: input.pressKey, cache: options?.cache })
      return fleet({ pressKey: input.pressKey })
    },
  } as unknown as StopIntelligenceService
  const result = await new MachineIntelligenceService(stopIntelligence, () => Date.parse(at(60))).overview({ fromUtc: at(0), toUtc: at(60) }, 'request')
  assert.equal(result.version, 'machine-intelligence-v2.0.0')
  assert.equal(result.presses.length, 12)
  assert.deepEqual(result.unavailablePresses, [])
  assert.equal(new Set(calls.map(({ pressKey }) => pressKey)).size, 12)
  assert.equal(calls.every(({ cache }) => cache === 'bypass'), true)
})

test('Machine Intelligence exposes one read-only fleet overview route and bypasses retained analysis cache', () => {
  const service = readFileSync(new URL('../src/machine-intelligence/service.ts', import.meta.url), 'utf8')
  const engine = readFileSync(new URL('../src/machine-intelligence/engine.ts', import.meta.url), 'utf8')
  const app = readFileSync(new URL('../src/app.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(`${service}\n${engine}`, /\b(?:insert\s+into|update\s+\w+\s+set|delete\s+from|create\s+table|drop\s+table)\b/i)
  assert.match(service, /cache: 'bypass'/)
  assert.match(app, /\/api\/machine-intelligence\/overview[\s\S]*?machineIntelligence\.overview/)
  assert.doesNotMatch(app, /\/api\/machine-intelligence\/presses\/:pressKey/)
})
