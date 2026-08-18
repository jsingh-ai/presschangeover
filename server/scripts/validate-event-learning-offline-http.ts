import { aggregateEventFingerprints, buildOccurrenceFingerprint, compareSelectedToTypical, type EventLearningOccurrence, type EventLearningSignal } from '../src/industrial-analytics/event-learning.js'
import { strongestBoundedDelta } from '../src/industrial-analytics/bounded-delta.js'
import { localProcessIntelligenceBaseUrl, ProcessIntelligenceExplorerHttpClient } from './explorer-http-validation.js'

function argument(name: string) { const prefix = `${name}=`; return process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length) }
const host = argument('--host') ?? '127.0.0.1'; const port = Number(argument('--port') ?? 3100); const api = new ProcessIntelligenceExplorerHttpClient(localProcessIntelligenceBaseUrl(host, port))
const toUtc = new Date().toISOString(); const fromUtc = new Date(Date.parse(toUtc) - 24 * 60 * 60_000).toISOString()
await api.assertCompatibleServer()

function fromPlot(signal: Awaited<ReturnType<typeof api.rawPlot>>['signal']): EventLearningSignal {
  return { canonicalId: signal.canonicalId, deckNumber: signal.deckNumber, friendlyName: signal.friendlyName, category: signal.category, signalType: signal.signalType, sourceUnit: signal.sourceUnit, valueKind: signal.seed?.valueKind ?? signal.samples[0]?.valueKind ?? signal.changes[0]?.valueKind ?? null, samples: [...(signal.seed ? [signal.seed] : []), ...signal.samples], changes: signal.changes }
}

const identities = (await api.rawIdentities(fromUtc, toUtc)).sort((left, right) => Date.parse(right.lastSeenUtc ?? '') - Date.parse(left.lastSeenUtc ?? '') || right.eventCount - left.eventCount).slice(0, 2)
let rawResult: Record<string, unknown> | undefined
for (const identity of identities) {
  const explored = await api.rawExplore({ fromUtc, toUtc, identity, changeLookbackMinutes: 20, chartContextMinutes: 30 }); const occurrence = [...explored.occurrences].sort((left, right) => Date.parse(right.startUtc) - Date.parse(left.startUtc))[0]; if (!occurrence) continue
  const detail = await api.rawDetail(occurrence, 20); const history = await api.rawHistory(occurrence)
  const candidates = [detail.changedSignals.find(({ summary }) => summary.kind === 'state'), detail.changedSignals.find(({ summary }) => summary.kind === 'numeric')].filter((value): value is NonNullable<typeof value> => Boolean(value)).slice(0, 2)
  const signals = await Promise.all(candidates.map((candidate) => api.rawPlot(occurrence, candidate).then(({ signal }) => fromPlot(signal))))
  signals.unshift({ canonicalId: 'machine.speed.actual', deckNumber: null, friendlyName: 'Actual Speed', category: 'speed', signalType: 'continuous', sourceUnit: detail.speed.sourceUnit, valueKind: 'numeric', samples: detail.speed.samples, changes: [] })
  const event: EventLearningOccurrence = { occurrenceId: occurrence.occurrenceId, startUtc: occurrence.startUtc, endUtc: occurrence.endUtc, label: `${occurrence.eventType} / ${occurrence.statusCode ?? '—'} / ${occurrence.statusDescription}` }; const fingerprint = buildOccurrenceFingerprint(event, signals); const aggregate = aggregateEventFingerprints([fingerprint], signals)
  rawResult = { exactIdentity: { eventType: occurrence.eventType, statusCode: occurrence.statusCode, statusDescription: occurrence.statusDescription }, physicalAlignment: detail.evidence.physicalAlignment.agreementClass, productionContextDimensions: detail.evidence.productionContext.map(({ field }) => field), selectedFindings: fingerprint.patterns.length, numericFindings: fingerprint.patterns.filter(({ kind }) => kind === 'numeric').length, stateFindings: fingerprint.patterns.filter(({ kind }) => kind === 'state').length, radiusHistorySupport: history.supportCount, telemetryQualifiedOccurrences: fingerprint.coveredSignalKeys.length ? 1 : 0, historicalFindings: aggregate.findings.length, typicalSequence: aggregate.typicalSequence.length ? aggregate.typicalSequence : 'INSUFFICIENT_EVIDENCE', previewPinTargets: candidates.map(({ canonicalId, deckNumber }) => ({ canonicalId, deckNumber })), automaticRawSignalScans: 0 }; break
}
if (!rawResult) throw new Error('offline_event_learning_raw_unavailable')

const catalog = await api.telemetryCatalog(); const numericVariables = catalog.canonicalVariables.filter(({ dataKind }) => dataKind === 'numeric').sort((left, right) => Number(!/temperature|speed/i.test(left.canonicalId)) - Number(!/temperature|speed/i.test(right.canonicalId))).slice(0, 3)
let telemetryResult: Record<string, unknown> | undefined
for (const variable of numericVariables) {
  const compatible = variable.compatiblePresses.find(({ pressKey }) => pressKey === 'press14') ?? variable.compatiblePresses[0]; if (!compatible) continue
  const deckNumber = variable.scope === 'deck' ? compatible.deckNumbers[0] ?? null : null; const preview = await api.telemetryPreview({ source: { kind: 'canonical', canonicalId: variable.canonicalId }, pressKey: compatible.pressKey, deckNumber, fromUtc, toUtc })
  const points = preview.observations.flatMap((item) => typeof item.value === 'number' ? [{ atUtc: item.atUtc, value: item.value, qualityState: item.qualityState }] : []); const strongest = strongestBoundedDelta({ points, windowMinutes: 5, referenceMode: 'ROLLING_EXTREME', gapLimitMs: 330_000 }); if (!strongest || Math.abs(strongest.delta) <= 0) continue
  const search = await api.telemetrySearch({ fromUtc, toUtc, source: { kind: 'canonical', canonicalId: variable.canonicalId }, pressKey: compatible.pressKey, deckNumber, rule: { kind: 'delta', direction: 'either', amount: Math.abs(strongest.delta) * .9, windowMinutes: 5 }, chartContextMinutes: 30 }); const occurrence = search.occurrences.at(-1); if (!occurrence) continue
  const detail = await api.telemetryDetail(occurrence); const candidates = [detail.context.changedSignals.find(({ summary }) => summary.kind === 'state'), detail.context.changedSignals.find(({ summary }) => summary.kind === 'numeric')].filter((value): value is NonNullable<typeof value> => Boolean(value)).slice(0, 2)
  const signals = await Promise.all(candidates.map((candidate) => api.telemetryPlot(occurrence, candidate).then(({ signal }) => fromPlot(signal))))
  signals.unshift({ canonicalId: 'machine.speed.actual', deckNumber: null, friendlyName: 'Actual Speed', category: 'speed', signalType: 'continuous', sourceUnit: detail.context.speed.sourceUnit, valueKind: 'numeric', samples: detail.context.speed.samples, changes: [] })
  const event: EventLearningOccurrence = { occurrenceId: occurrence.occurrenceId, startUtc: occurrence.startUtc, endUtc: occurrence.endUtc, label: `${occurrence.signalDisplayName} delta` }; const fingerprint = buildOccurrenceFingerprint(event, signals); const aggregate = aggregateEventFingerprints([fingerprint], signals); const comparison = compareSelectedToTypical(fingerprint, aggregate.findings)
  telemetryResult = { detector: { canonicalId: occurrence.canonicalId, deckNumber: occurrence.deckNumber, eventType: occurrence.eventType, actualDelta: occurrence.actualDelta, baselineAtUtc: occurrence.baselineAtUtc, triggerAtUtc: occurrence.triggerAtUtc }, radiusAtEvent: detail.evidence.radiusAtEvent, productionContextDimensions: detail.evidence.productionContext.map(({ field }) => field), selectedFindings: fingerprint.patterns.length, numericFindings: fingerprint.patterns.filter(({ kind }) => kind === 'numeric').length, stateFindings: fingerprint.patterns.filter(({ kind }) => kind === 'state').length, targetOccurrencesAvailable: search.occurrences.length, telemetryQualifiedOccurrences: fingerprint.coveredSignalKeys.length ? 1 : 0, historicalFindings: aggregate.findings.length, typicalSequence: aggregate.typicalSequence.length ? aggregate.typicalSequence : 'INSUFFICIENT_EVIDENCE', occurrenceComparison: comparison, relationshipSummary: 'INSUFFICIENT_ALIGNED_COHORT', previewPinTargets: candidates.map(({ canonicalId, deckNumber }) => ({ canonicalId, deckNumber })), automaticRawSignalScans: 0 }; break
}
if (!telemetryResult) throw new Error('offline_event_learning_telemetry_unavailable')

const result = { status: 'PASS', mode: 'existing_resident_http_plus_offline_shared_engine', range: { fromUtc, toUtc }, raw: rawResult, telemetry: telemetryResult, directValidationPostgresConnections: 0, openAiRequests: 0, http: api.metricsSince(0) }
console.log(JSON.stringify(result, null, 2))
