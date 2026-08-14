import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { CapabilityAssessment, PressSemanticSignalEvidence, TelemetrySample, TelemetrySemanticHistoryQuery } from '../src/telemetry/telemetry-contracts.js'
import type { TelemetryFoundationService } from '../src/telemetry/telemetry-foundation-service.js'
import { PRE_STOP_REFERENCE_POLICY } from '../src/telemetry/stop-restart-analysis.js'
import { StopRestartAnalysisService, type StopRestartAnalysisInput } from '../src/telemetry/stop-restart-analysis-service.js'

const occurrenceStart = '2026-08-13T12:00:00.000Z'
const analysisFrom = '2026-08-13T11:30:00.000Z'
const sample = (observedAtUtc: string, value: number): TelemetrySample => ({ observedAtUtc, receivedAtUtc: observedAtUtc, sourceTimestampUtc: observedAtUtc, qualityState: 'GOOD', valueKind: 'numeric', value })
const numericSignal = (canonicalId: string, deckNumber: number | null, samples: TelemetrySample[]): PressSemanticSignalEvidence => ({ canonicalId, deckNumber, capabilityState: 'SUPPORTED', observationState: samples.length ? 'SUPPORTED_WITH_OBSERVATIONS' : 'SUPPORTED_WITH_NO_SAMPLES_IN_RANGE', mappingStatus: 'MAPPED', sourceUnit: null, canonicalUnitStatus: 'UNVERIFIED', representation: 'samples', seed: null, samples, changes: [] })
const supported = (canonicalId: string, deckNumbers: number[] = []): CapabilityAssessment => ({ canonicalId, state: 'SUPPORTED', deckNumbers, historyQueryable: true, evidenceKind: 'semantic_history' })

const input: StopRestartAnalysisInput = {
  occurrence: {
    occurrenceId: 'occ-1', pressKey: 'press5', displayName: 'Press 5', startUtc: occurrenceStart, endUtc: '2026-08-13T12:10:00.000Z',
    operationalGroupKey: 'downtime', operationalGroupName: 'Downtime', processFamilyKey: 'mechanical', processFamilyName: 'Mechanical',
    exactIdentities: [{ eventType: 'B', statusCode: '64', statusDescription: 'Mech - Press Other' }],
  },
  candidates: [{ canonicalId: 'anilox.drive.torque.actual', deckNumber: 4, friendlyName: 'Anilox torque', category: 'torque', signalType: 'continuous', source: 'clue' }],
}

function fixture(currentValues: number[], referenceValue = 100) {
  let semanticCalls = 0
  const capabilities = [supported('machine.speed.actual'), supported('anilox.drive.torque.actual', [4])]
  const fake = {
    capabilities: { get: async () => ({ pressKey: 'press5', sourceId: 5, sourceKey: 'press5', displayName: 'Press 5', metadataStatus: 'FRESH', capabilities }) },
    semanticHistory: async (_pressKey: string, query: TelemetrySemanticHistoryQuery) => {
      semanticCalls += 1
      const isCurrent = query.fromUtc === analysisFrom
      const base = Date.parse(query.fromUtc)
      const speed = isCurrent
        ? [
            sample('2026-08-13T11:50:00.000Z', 800), sample('2026-08-13T11:52:00.000Z', 805), sample('2026-08-13T11:54:00.000Z', 810), sample('2026-08-13T11:56:00.000Z', 800),
            sample('2026-08-13T11:57:00.000Z', 300), sample('2026-08-13T11:58:00.000Z', 0), sample('2026-08-13T12:01:00.000Z', 650), sample('2026-08-13T12:03:00.000Z', 700), sample('2026-08-13T12:05:00.000Z', 710),
          ]
        : [sample(new Date(base + 10_000).toISOString(), 800), sample(new Date(base + 70_000).toISOString(), 805)]
      const torque = isCurrent
        ? [
            ...currentValues.map((value, index) => sample(new Date(Date.parse('2026-08-13T11:50:00.000Z') + index * 120_000).toISOString(), value)),
            sample('2026-08-13T11:59:00.000Z', 0),
            sample('2026-08-13T12:01:00.000Z', 101), sample('2026-08-13T12:03:00.000Z', 100), sample('2026-08-13T12:05:00.000Z', 99),
          ]
        : [sample(new Date(base + 20_000).toISOString(), referenceValue), sample(new Date(base + 80_000).toISOString(), referenceValue + 1)]
      return {
        pressKey: 'press5', sourceKey: 'press5', displayName: 'Press 5', fromUtc: query.fromUtc, toUtc: query.toUtc, includeSeed: query.includeSeed,
        signals: query.signals.map(({ canonicalId, deckNumber, representation }) => canonicalId === 'machine.speed.actual' ? numericSignal(canonicalId, null, speed) : representation === 'samples' ? numericSignal(canonicalId, deckNumber ?? null, torque) : ({ ...numericSignal(canonicalId, deckNumber ?? null, []), representation: 'changes' as const })),
      }
    },
    motion: async () => ({ pressKey: 'press5', sourceKey: 'press5', displayName: 'Press 5', fromUtc: analysisFrom, toUtc: '2026-08-13T13:30:00.000Z', policy: {}, summary: { durationsMs: {}, segmentCount: 0 }, segments: [] }),
  } as unknown as TelemetryFoundationService
  return { service: new StopRestartAnalysisService(fake), calls: () => semanticCalls }
}

describe('stop/restart service policy', () => {
  it('preserves exact Radius identity, neutral lag, bounded references, recovery, and compact summaries', async () => {
    const { service, calls } = fixture([130, 132, 131, 130])
    const result = await service.analyze(input)
    assert.equal(result.physicalStopMatch.status, 'MATCHED')
    assert.deepEqual(result.occurrence.exactIdentities, input.occurrence.exactIdentities)
    assert.equal(result.radiusTiming.offsetSeconds, 120)
    assert.match(result.radiusTiming.wording, /Radius was recorded 120 seconds after/)
    assert.equal(result.phases?.deceleration.fromUtc, '2026-08-13T11:57:00.000Z')
    assert.equal(result.phases?.restartAttempts[0]?.sustainedRunning, true)
    assert.equal(result.preStopFlags.length, 1)
    assert.equal(result.preStopFlags[0]?.recovery, 'RETURNED_TOWARD_REFERENCE')
    assert.equal(result.preStopFlags[0]?.speedBucket, 'RUNNING')
    assert.doesNotMatch(JSON.stringify(result), /historicalSamples|rawBaseline|cause|root cause/i)
    assert.equal(result.referenceMetadata.requestCount, 12)
    assert.equal(result.referenceMetadata.candidateCount, 1)
    assert.equal(result.referenceMetadata.flagLimit, 5)
    assert.equal(result.performance.referenceSelectors, 2)
    assert.equal(result.performance.responsePayloadBytes, Buffer.byteLength(JSON.stringify({ ...result, performance: { ...result.performance, responsePayloadBytes: 0 } }), 'utf8'))
    assert.equal(calls(), 13)

    const cached = await service.analyze(input)
    assert.equal(cached.referenceMetadata.cache, 'hit')
    assert.equal(cached.referenceMetadata.requestCount, 0)
    assert.equal(calls(), 14, 'only the current two-hour history is repeated; compact reference is reused')
  })

  it('does not turn a stable non-zero signal or a post-stop drop into a pre-stop flag', async () => {
    const stable = await fixture([100, 100, 100, 100]).service.analyze(input)
    assert.equal(stable.preStopFlags.length, 0)
    assert.equal(stable.noFlagMessage, 'No strong pre-stop deviation was identified against the available comparable-speed reference.')

    const afterOnly = await fixture([]).service.analyze(input)
    assert.equal(afterOnly.preStopFlags.length, 0)
    assert.equal(afterOnly.stopRestartContext.some(({ label }) => /cause|failure caused/i.test(label)), false)
  })

  it('documents the bounded request policy used to avoid unbounded historical queries', () => {
    assert.equal(PRE_STOP_REFERENCE_POLICY.referenceHours, 24)
    assert.equal(PRE_STOP_REFERENCE_POLICY.chunkHours, 2)
    assert.equal(PRE_STOP_REFERENCE_POLICY.maximumAutomaticCandidates, 12)
    assert.equal(PRE_STOP_REFERENCE_POLICY.maximumFlags, 5)
  })
})
