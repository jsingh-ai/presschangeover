import { buildCategoricalTemporalEvidenceProgram, buildNumericTemporalEvidenceProgram } from '../src/industrial-analytics/temporal-evidence.js'
import { profileAiToolPayload, type AiToolResult } from '../src/ai-investigator/read-only-tools.js'

const range = { start: '2026-08-16T12:00:00.000Z', end: '2026-08-17T12:00:00.000Z' }
const eventRange = { start: '2026-08-17T01:40:00.000Z', end: '2026-08-17T02:40:00.000Z' }
const event = { start: '2026-08-17T02:00:00.000Z', end: '2026-08-17T02:20:00.000Z' }
const pressKey = 'press14' as const

function timestamp(index: number, stepMinutes = 5) { return new Date(Date.parse(eventRange.start) + index * stepMinutes * 60_000).toISOString() }

export function buildWorstReasonableFleetToolResult(): AiToolResult {
  const numericPrograms = ['machine.speed.actual', 'web.tension.actual', 'ink.temperature.actual', 'drive.load.actual'].flatMap((canonicalId, signalIndex) => {
    const program = buildNumericTemporalEvidenceProgram({
      candidateId: pressKey, pressKey, eventId: 'press14.offline.maximum.event', canonicalId, unit: signalIndex === 0 ? 'impressions_per_hour' : 'engineering_unit',
      range: eventRange, event,
      samples: Array.from({ length: 61 }, (_item, index) => ({ atUtc: timestamp(index, 1), value: Math.round((signalIndex * 20 + Math.sin(index / 3) * 12 + index / 5) * 100) / 100 })),
      gaps: [{ canonicalId, deckNumber: null, startUtc: timestamp(18, 1), endUtc: timestamp(21, 1), durationMs: 3 * 60_000 }],
      selectedBecause: ['strongest supported bounded numeric Delta', 'context-derived envelope departure', 'persistent or recurring departure'],
    })
    return program ? [program] : []
  })
  const radiusProgram = buildCategoricalTemporalEvidenceProgram({
    candidateId: pressKey, pressKey, eventId: 'press14.offline.maximum.event', canonicalId: 'radius.sequence', datatype: 'radius', range: eventRange, event,
    samples: Array.from({ length: 10 }, (_item, index) => ({ atUtc: timestamp(index, 6), value: index % 3 === 0 ? 'Run Production' : index % 3 === 1 ? 'Sheet feed interruption / operator recovery' : 'Make Ready / return attempt' })),
    selectedBecause: ['candidate Radius sequence and recovery context'],
  })
  const contextProgram = buildCategoricalTemporalEvidenceProgram({
    candidateId: pressKey, pressKey, eventId: 'press14.offline.maximum.event', canonicalId: 'production.context.identity', datatype: 'production_context', range: eventRange, event,
    samples: Array.from({ length: 8 }, (_item, index) => ({ atUtc: timestamp(index, 8), value: `Job JOB-${1400 + index} + Order ORDER-${9000 + index} + Recipe RECIPE-${index + 1} + Material MATERIAL-${index + 1} + Customer CUSTOMER-${index + 1}` })),
    selectedBecause: ['strongest usable per-press production context'],
  })
  const temporalEvidencePrograms = [...(radiusProgram ? [radiusProgram] : []), ...(contextProgram ? [contextProgram] : []), ...numericPrograms].slice(0, 4)
  const contextEpisodes = Array.from({ length: 8 }, (_item, index) => ({
    episodeId: `press14.context.offline-${index + 1}`, startUtc: timestamp(index, 7), endUtc: timestamp(index + 1, 7), durationMinutes: 7,
    identity: { identityId: `identity-${index + 1}`, summary: `Job JOB-${1400 + index} + Order ORDER-${9000 + index} + Recipe RECIPE-${index + 1} + Material MATERIAL-${index + 1} + Customer CUSTOMER-${index + 1}`, dimensionNames: ['job', 'order', 'recipe', 'material', 'customer'], dimensions: { job: `JOB-${1400 + index}`, order: `ORDER-${9000 + index}`, recipe: `RECIPE-${index + 1}`, material: `MATERIAL-${index + 1}`, customer: `CUSTOMER-${index + 1}` } },
    radius: { interruptionCount: 3, totalInterruptionMinutes: 5.5, returnAttemptCount: 2, drivers: ['Sheet feed interruption', 'Operator recovery'], repeatedStates: ['Run Production'], loops: ['Run Production -> Interruption -> Run Production'] },
  }))
  const observations = Array.from({ length: 3 }, (_item, index) => ({
    observationId: `press14.observation.offline-${index + 1}`, pressKey, eventId: 'press14.offline.maximum.event',
    family: ['first_divergence', 'contextual_telemetry_baseline', 'contextual_baseline', 'deviation_persistence', 'normal_envelope_departure', 'speed_recovery', 'radius_telemetry_alignment', 'numeric_relationship'][index],
    variableIds: [`signal.${index + 1}.actual`, `signal.${index + 1}.reference`], material: true,
    metrics: { currentValue: 120.25 + index, baselineMedian: 91.5 - index, difference: 28.75 + index, windowMinutes: [2, 5, 10, 20][index % 4], coveragePercent: 96.5, qualification: 'QUALIFIED', basis: index % 2 ? 'DIFFERENCE' : 'LEVEL', bestLagMinutes: index % 3 },
    support: { adequate: true, sampleCount: 61, comparisonSampleCount: 8, coveragePercent: 96.5, provenance: 'offline worst-reasonable bounded canonical fixture' },
    magnitudeInputs: { absoluteDifference: 28.75 + index, normalizedMagnitude: 3.2 + index / 10 },
    factIds: [`press14.offline.fact.${index + 1}.current`, `press14.offline.fact.${index + 1}.baseline`, `press14.offline.fact.${index + 1}.delta`],
    limitations: ['Deterministic association is not proof of causation.'],
  }))
  const facts = Array.from({ length: 30 }, (_item, index) => ({
    factId: `press14.offline.fact.${index + 1}.${index % 3 === 0 ? 'current' : index % 3 === 1 ? 'baseline' : 'delta'}`,
    pressKey, press: 'Press 14', source: index % 7 === 0 ? 'production_context' : index % 5 === 0 ? 'comparison' : 'telemetry',
    metric: `boundedMetric${index + 1}`, value: index % 4 === 0 ? `STATE-${index + 1}` : Math.round((index * 3.14159) * 100) / 100,
    unit: index % 4 === 0 ? null : 'engineering_unit', role: index % 3 === 0 ? 'current' : index % 3 === 1 ? 'baseline' : 'delta', usable: true,
    label: `Authoritative bounded offline fact ${index + 1}`, range, timestamp: timestamp(index % 12, 5),
  }))
  const events = Array.from({ length: 3 }, (_item, eventIndex) => ({
    eventId: `press14.offline.event-${eventIndex + 1}`, startUtc: timestamp(eventIndex * 3, 5), endUtc: timestamp(eventIndex * 3 + 2, 5), durationMinutes: 10,
    statusSegments: Array.from({ length: 8 }, (_segment, segmentIndex) => ({ startUtc: timestamp(segmentIndex, 2), endUtc: timestamp(segmentIndex + 1, 2), status: segmentIndex % 2 ? 'Run Production' : 'Production Interruption', description: `Bounded Radius status description ${segmentIndex + 1}` })),
    repeats: 3, loops: 2, returnAttempts: 2, dwellDifferenceMinutes: 14.5,
  }))
  return {
    press: 'Press 14', pressKey, range, coveragePercent: 98.2, productionInterruptions: 12, longestInterruptionMinutes: 184.5,
    events,
    topRadiusDrivers: Array.from({ length: 5 }, (_item, index) => ({ description: `Radius driver ${index + 1} / bounded operational explanation`, durationMinutes: 120 - index * 11, count: 4 + index })),
    productionContext: {
      capabilities: ['job', 'order', 'recipe', 'material', 'customer'].map((field) => ({ field, capabilityAvailability: 'CAPABILITY_AVAILABLE', valueAvailability: 'VALUE_USABLE', usable: true, recentCoveragePercent: 97.5, sentinelBehavior: null })),
      identities: contextEpisodes.map((episode) => episode.identity), episodes: contextEpisodes,
    },
    temporalEvidencePrograms,
    eventAnalytics: { eventWindowsAnalyzed: 3, telemetrySeriesScanned: 12, telemetrySeriesSelected: 4, telemetrySeriesQueried: 36, tracesCreated: temporalEvidencePrograms.length },
    industrialAnalytics: { calculatedCount: 96, retainedCount: observations.length, excludedCount: 88, observations },
    queryCount: 48,
    facts,
    limitations: [
      'The bounded offline fixture preserves maximum normal fleet cardinalities without raw historian arrays.',
      'Deterministic observations identify investigation priorities and do not establish root cause.',
      'Only trusted canonical semantic telemetry is represented.',
    ],
    validationDiagnostics: { excludedFromGuardBoundary: true, syntheticDiagnosticPadding: 'diagnostics are intentionally outside the application tool-result guard' },
  }
}

export function profileWorstReasonableFleetToolResult() { return profileAiToolPayload(buildWorstReasonableFleetToolResult()) }
