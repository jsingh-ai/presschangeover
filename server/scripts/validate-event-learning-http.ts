import { strongestBoundedDelta } from '../src/industrial-analytics/bounded-delta.js'
import { localProcessIntelligenceBaseUrl, ProcessIntelligenceExplorerHttpClient } from './explorer-http-validation.js'

function argument(name: string) { const prefix = `${name}=`; return process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length) }
const host = argument('--host') ?? '127.0.0.1'; const port = Number(argument('--port') ?? 3100)
const api = new ProcessIntelligenceExplorerHttpClient(localProcessIntelligenceBaseUrl(host, port))
const toUtc = new Date().toISOString(); const fromUtc = new Date(Date.parse(toUtc) - 24 * 60 * 60_000).toISOString()

await api.assertCompatibleServer()

const identities = (await api.rawIdentities(fromUtc, toUtc)).sort((left, right) => Date.parse(right.lastSeenUtc ?? '') - Date.parse(left.lastSeenUtc ?? '') || right.eventCount - left.eventCount).slice(0, 2)
let raw: Awaited<ReturnType<typeof api.rawReport>> | undefined
for (const identity of identities) {
  const explored = await api.rawExplore({ fromUtc, toUtc, identity, changeLookbackMinutes: 20, chartContextMinutes: 30 })
  const occurrence = [...explored.occurrences].sort((left, right) => Date.parse(right.startUtc) - Date.parse(left.startUtc))[0]
  if (!occurrence) continue
  raw = await api.rawReport(occurrence); break
}
if (!raw) throw new Error('event_learning_raw_occurrence_unavailable')

const catalog = await api.telemetryCatalog(); const variables = catalog.canonicalVariables.filter((item) => item.dataKind === 'numeric').sort((left, right) => Number(!/temperature|speed/i.test(left.canonicalId)) - Number(!/temperature|speed/i.test(right.canonicalId))).slice(0, 3)
let telemetry: Awaited<ReturnType<typeof api.telemetryReport>> | undefined
let telemetryDetector: string | undefined
for (const variable of variables) {
  const compatible = variable.compatiblePresses.find(({ pressKey }) => pressKey === 'press14') ?? variable.compatiblePresses[0]; if (!compatible) continue
  const deckNumber = variable.scope === 'deck' ? compatible.deckNumbers[0] ?? null : null
  const preview = await api.telemetryPreview({ source: { kind: 'canonical', canonicalId: variable.canonicalId }, pressKey: compatible.pressKey, deckNumber, fromUtc, toUtc })
  const points = preview.observations.flatMap((item) => typeof item.value === 'number' ? [{ atUtc: item.atUtc, value: item.value, qualityState: item.qualityState }] : [])
  const strongest = strongestBoundedDelta({ points, windowMinutes: 5, referenceMode: 'ROLLING_EXTREME', gapLimitMs: 330_000 }); if (!strongest || Math.abs(strongest.delta) <= 0) continue
  const search = await api.telemetrySearch({ fromUtc, toUtc, source: { kind: 'canonical', canonicalId: variable.canonicalId }, pressKey: compatible.pressKey, deckNumber, rule: { kind: 'delta', direction: 'either', amount: Math.abs(strongest.delta) * .9, windowMinutes: 5 }, chartContextMinutes: 30 })
  const occurrence = search.occurrences.at(-1); if (!occurrence) continue
  telemetry = await api.telemetryReport(occurrence, search.occurrences); telemetryDetector = `${variable.canonicalId}:delta`; break
}
if (!telemetry) throw new Error('event_learning_telemetry_occurrence_unavailable')

const safeSummary = (report: typeof raw) => ({ reportKind: report.reportKind, target: report.target, selectedFindingCount: report.selectedFindings.length, numericFindingCount: report.selectedFindings.filter(({ kind }) => kind === 'numeric').length, stateFindingCount: report.selectedFindings.filter(({ kind }) => kind === 'state').length, historicalFindingCount: report.historicalFingerprint.findings.length, qualifiedOccurrences: report.historicalFingerprint.qualifiedOccurrences, typicalSequenceSteps: report.typicalSequence.length, relationshipCount: report.relationships.length, controls: report.controls.status, candidateSignals: report.coverage.candidateSignals, automaticRawSignalScans: report.coverage.automaticRawSignalScans, semanticHistoryRequests: report.performance.semanticHistoryRequests, runtimeMs: report.performance.totalMs, payloadBytes: report.performance.payloadBytes })
const result = { status: raw.reportKind === 'raw_radius' && telemetry.reportKind === 'telemetry_event' && raw.coverage.automaticRawSignalScans === 0 && telemetry.coverage.automaticRawSignalScans === 0 ? 'PASS' : 'FAIL', range: { fromUtc, toUtc }, directValidationPostgresConnections: 0, raw: safeSummary(raw), telemetryDetector, telemetry: safeSummary(telemetry), http: api.metricsSince(0) }
console.log(JSON.stringify(result, null, 2))
if (result.status !== 'PASS') throw new Error('event_learning_http_validation_failed')
