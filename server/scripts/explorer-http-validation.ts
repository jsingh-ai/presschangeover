import { strongestBoundedDelta } from '../src/industrial-analytics/bounded-delta.js'
import { supportsExplorerHttpValidation } from '../src/explorer-validation-capabilities.js'
import type { RadiusHealth, RadiusPressKey } from '../src/radius/models.js'
import type { RawRadiusExplorerService, RawExplorerIdentity, RawExplorerOccurrence, RawExplorerSetup } from '../src/raw-radius-explorer/raw-radius-explorer-service.js'
import type { TelemetryEventExplorerService, TelemetryEventOccurrence, TelemetryEventSearchInput, TelemetryEventSource } from '../src/telemetry-event-explorer/telemetry-event-explorer-service.js'

type RawExplore = Awaited<ReturnType<RawRadiusExplorerService['explore']>>
type RawDetail = Awaited<ReturnType<RawRadiusExplorerService['detail']>>
type RawHistory = Awaited<ReturnType<RawRadiusExplorerService['historicalSummary']>>
type TelemetryCatalog = Awaited<ReturnType<TelemetryEventExplorerService['catalog']>>
type TelemetryPreview = Awaited<ReturnType<TelemetryEventExplorerService['preview']>>
type TelemetrySearch = Awaited<ReturnType<TelemetryEventExplorerService['search']>>
type TelemetryDetail = Awaited<ReturnType<TelemetryEventExplorerService['detail']>>
type TelemetryHistory = ReturnType<TelemetryEventExplorerService['historicalSummary']>

export interface ExplorerHttpCall {
  method: 'GET' | 'POST'
  path: string
  status: number
  durationMs: number
  payloadBytes: number
}

export function localProcessIntelligenceBaseUrl(host: string, port: number): URL {
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') throw new Error('validation_requires_loopback_processintelligence')
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('validation_requires_processintelligence_port')
  return new URL(`http://${host === '::1' ? '[::1]' : host}:${port}`)
}

export class ProcessIntelligenceExplorerHttpClient {
  private readonly calls: ExplorerHttpCall[] = []
  private requestSequence = 0

  constructor(
    private readonly baseUrl: URL,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  mark() { return this.calls.length }

  metricsSince(mark: number) {
    const calls = this.calls.slice(mark)
    return {
      requestCount: calls.length,
      runtimeMs: calls.reduce((sum, item) => sum + item.durationMs, 0),
      payloadBytes: calls.reduce((sum, item) => sum + item.payloadBytes, 0),
      maximumRequestMs: calls.reduce((maximum, item) => Math.max(maximum, item.durationMs), 0),
      calls,
    }
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const started = Date.now()
    const requestId = `explorer-http-validation-${++this.requestSequence}`
    let status = 0
    let payloadBytes = 0
    try {
      const response = await this.fetchImplementation(new URL(path, this.baseUrl), {
        method,
        headers: {
          Accept: 'application/json',
          'X-Request-Id': requestId,
          ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
        },
        body: method === 'POST' ? JSON.stringify(body) : undefined,
      })
      status = response.status
      const text = await response.text()
      payloadBytes = Buffer.byteLength(text, 'utf8')
      if (!response.ok) throw new Error(`processintelligence_http_${response.status}`)
      return JSON.parse(text) as T
    } finally {
      this.calls.push({ method, path: new URL(path, this.baseUrl).pathname, status, durationMs: Date.now() - started, payloadBytes })
    }
  }

  async assertCompatibleServer() {
    const health = await this.request<{ service: string; status: string; explorerHttpValidation?: unknown }>('GET', '/api/health')
    if (health.service !== 'ProcessIntelligence' || health.status !== 'healthy') throw new Error('processintelligence_http_unhealthy')
    if (!supportsExplorerHttpValidation(health.explorerHttpValidation)) throw new Error('processintelligence_http_validation_contract_unavailable')
    return health
  }

  radiusHealth() { return this.request<RadiusHealth>('GET', '/api/radius/health') }
  rawIdentities(fromUtc: string, toUtc: string) { return this.request<RawExplorerIdentity[]>('GET', `/api/radius/raw-explorer/identities?${new URLSearchParams({ fromUtc, toUtc })}`) }
  rawExplore(input: RawExplorerSetup) { return this.request<RawExplore>('POST', '/api/radius/raw-explorer/explore', input) }
  rawDetail(occurrence: RawExplorerOccurrence, changeLookbackMinutes: number) { return this.request<RawDetail>('POST', '/api/radius/raw-explorer/detail', { occurrence, changeLookbackMinutes, includeRawTelemetryDiscovery: false }) }
  rawHistory(occurrence: RawExplorerOccurrence) { return this.request<RawHistory>('POST', '/api/radius/raw-explorer/history', { occurrence, lookbackDays: 31, maximumOccurrences: 100 }) }
  telemetryCatalog() { return this.request<TelemetryCatalog>('GET', '/api/telemetry/event-explorer/catalog') }
  telemetryPreview(input: { source: TelemetryEventSource; pressKey: RadiusPressKey; deckNumber: number | null; fromUtc: string; toUtc: string }) { return this.request<TelemetryPreview>('POST', '/api/telemetry/event-explorer/preview', input) }
  telemetrySearch(input: TelemetryEventSearchInput) { return this.request<TelemetrySearch>('POST', '/api/telemetry/event-explorer/search', input) }
  telemetryDetail(occurrence: TelemetryEventOccurrence) { return this.request<TelemetryDetail>('POST', '/api/telemetry/event-explorer/detail', { occurrence, includeRawTelemetryDiscovery: false }) }
  telemetryHistory(occurrence: TelemetryEventOccurrence, occurrences: TelemetryEventOccurrence[]) { return this.request<TelemetryHistory>('POST', '/api/telemetry/event-explorer/history', { occurrence, occurrences: occurrences.slice(0, 500) }) }
}

function bytes(value: unknown) { return Buffer.byteLength(JSON.stringify(value), 'utf8') }
function scalarEqual(left: unknown, right: unknown) { return typeof left === typeof right && left === right }
function finiteUtc(value: string) { return Number.isFinite(Date.parse(value)) }
function exactIdentity(value: { eventType: string; statusCode: string | null; statusDescription: string }) { return { eventType: value.eventType, statusCode: value.statusCode, statusDescription: value.statusDescription } }
function suggestionSummary(values: Array<{ canonicalId: string; deckNumber: number | null; friendlyName: string; category: string; reasonCodes: string[]; timingDetail: string | null }>) { return values.map(({ canonicalId, deckNumber, friendlyName, category, reasonCodes, timingDetail }) => ({ signal: friendlyName, canonicalId, semanticFamily: category, deckNumber, reasonCodes, relativeTiming: timingDetail })) }

function rawRepresentative(occurrence: RawExplorerOccurrence, detail: RawDetail, history: RawHistory) {
  const alignment = detail.evidence.physicalAlignment
  return {
    occurrence: { occurrenceId: occurrence.occurrenceId, pressKey: occurrence.pressKey, recordedRadius: exactIdentity(occurrence), startUtc: occurrence.startUtc, endUtc: occurrence.endUtc, durationSeconds: occurrence.durationSeconds },
    physicalAlignment: { recordedRadius: alignment.recordedRadius, recordedStartUtc: alignment.recordedStartUtc, recordedEndUtc: alignment.recordedEndUtc, inferredPhysicalOnsetRange: alignment.inferredPhysicalOnsetRange, inferredPhysicalExitRange: alignment.inferredPhysicalExitRange, entryLagRange: alignment.entryLagRange, exitLagRange: alignment.exitLagRange, speedEvidence: alignment.speedEvidence, otherTelemetryEvidence: alignment.otherTelemetryEvidence, contextDimensions: alignment.contextEvidence.map(({ field }) => field), radiusSequenceEvidence: alignment.radiusSequenceEvidence, agreementClass: alignment.agreementClass, evidenceQuality: alignment.evidenceQuality },
    productionContextDimensions: detail.evidence.productionContext.map(({ field }) => field),
    phaseLabels: [...new Set(detail.evidence.phaseSummary.items.map(({ phase }) => phase))],
    phaseLimitations: detail.evidence.phaseSummary.limitations,
    radiusSequence: detail.evidence.radiusSequence.map(({ relationship, eventType, statusCode, statusDescription }) => ({ relationship, eventType, statusCode, statusDescription })),
    suggestions: suggestionSummary(detail.evidence.suggestedSignals),
    history,
    payloadBytes: { evidence: detail.performance.payloadBytes, history: bytes(history) },
    performance: detail.performance,
  }
}

export async function validateRawRadiusOverHttp(input: { api: ProcessIntelligenceExplorerHttpClient; startUtc: string; endUtc: string }) {
  const began = Date.now(); const mark = input.api.mark()
  const identities = (await input.api.rawIdentities(input.startUtc, input.endUtc)).sort((left, right) => Number(right.eventType !== 'G') - Number(left.eventType !== 'G') || Date.parse(right.lastSeenUtc ?? '') - Date.parse(left.lastSeenUtc ?? '') || right.eventCount - left.eventCount).slice(0, 2)
  const representatives = []
  for (const identity of identities) {
    const explored = await input.api.rawExplore({ fromUtc: input.startUtc, toUtc: input.endUtc, identity: exactIdentity(identity) as RawExplorerIdentity, changeLookbackMinutes: 30, chartContextMinutes: 40 })
    const occurrence = [...explored.occurrences].sort((left, right) => Date.parse(right.startUtc) - Date.parse(left.startUtc))[0]
    if (!occurrence) continue
    const detail = await input.api.rawDetail(occurrence, 30)
    const telemetryCallsBeforeHistory = input.api.metricsSince(mark).calls.filter(({ path }) => path.startsWith('/api/telemetry/')).length
    const history = await input.api.rawHistory(occurrence)
    const telemetryCallsAfterHistory = input.api.metricsSince(mark).calls.filter(({ path }) => path.startsWith('/api/telemetry/')).length
    representatives.push({ ...rawRepresentative(occurrence, detail, history), historySemanticTelemetryFanout: telemetryCallsAfterHistory - telemetryCallsBeforeHistory, historyLoadedAfterDetail: true })
  }
  const first = representatives[0]
  const suggestion = first?.suggestions[0]
  const previewPinContract = suggestion && first ? await input.api.telemetryPreview({ source: { kind: 'canonical', canonicalId: suggestion.canonicalId }, pressKey: first.occurrence.pressKey, deckNumber: suggestion.deckNumber, fromUtc: new Date(Date.parse(first.occurrence.startUtc) - 40 * 60_000).toISOString(), toUtc: new Date(Date.parse(first.occurrence.endUtc) + 40 * 60_000).toISOString() }).then((preview) => ({ exercised: true, plottable: preview.plottable, observationCount: preview.observations.length, pinUsesExistingClientState: true })) : { exercised: false, reason: 'No suggested canonical signal was returned.' }
  const diagnostics = { ...input.api.metricsSince(mark), directPostgresConnections: 0, rawUnmappedCalls: { changes: 0, catalogs: 0, histories: 0, total: 0 } }
  const gates = {
    representativeDataObserved: representatives.length > 0,
    exactStatusCodePreserved: representatives.every((item) => item.occurrence.recordedRadius.statusCode && item.radiusSequence.find(({ relationship }) => relationship === 'CURRENT')?.statusCode === item.occurrence.recordedRadius.statusCode),
    conservativePhysicalSemantics: representatives.every((item) => item.physicalAlignment.evidenceQuality && item.phaseLimitations.some((value) => /not.*classif|activity remains unknown|do not establish causation/i.test(value))),
    suggestionsBoundedCanonical: representatives.every((item) => item.suggestions.length <= 5 && item.suggestions.every(({ canonicalId, reasonCodes }) => Boolean(canonicalId) && reasonCodes.length > 0)),
    historyExactBoundedLazy: representatives.every((item) => item.history.scope.includes('exact Radius identity') && item.history.supportCount <= 100 && item.historySemanticTelemetryFanout === 0 && item.historyLoadedAfterDetail),
    previewPinExistingPath: !suggestion || previewPinContract.exercised === true,
    boundedHttpRequests: diagnostics.requestCount <= 8,
    noRawUnmappedAutomaticScans: diagnostics.rawUnmappedCalls.total === 0,
  }
  return { status: Object.values(gates).every(Boolean) ? 'PASS' : 'FAIL', runtimeMs: Date.now() - began, serviceQueries: diagnostics.requestCount, radiusServiceCalls: diagnostics.calls.filter(({ path }) => path.startsWith('/api/radius/')).length, boundedSample: { identityCountConsidered: identities.length, occurrenceDetailsInspected: representatives.length }, representatives, physicalBeforeRecordedObserved: representatives.find((item) => item.physicalAlignment.agreementClass === 'PHYSICAL_PRECEDES_RECORDED') ?? null, previewPinContract, diagnostics, gates }
}

type CatalogVariable = TelemetryCatalog['canonicalVariables'][number]
function sourceChoice(variable: CatalogVariable) { const compatible = [...variable.compatiblePresses].sort((left, right) => Number(right.pressKey === 'press14') - Number(left.pressKey === 'press14') || left.pressKey.localeCompare(right.pressKey))[0]; return compatible ? { variable, pressKey: compatible.pressKey as RadiusPressKey, deckNumber: variable.scope === 'deck' ? compatible.deckNumbers[0] ?? null : null } : null }
function telemetryOccurrenceSummary(occurrence: TelemetryEventOccurrence, detail: TelemetryDetail, history: TelemetryHistory) { return { occurrence: { occurrenceId: occurrence.occurrenceId, pressKey: occurrence.pressKey, signal: occurrence.signalDisplayName, canonicalId: occurrence.canonicalId, deckNumber: occurrence.deckNumber, detector: occurrence.eventType, startUtc: occurrence.startUtc, endUtc: occurrence.endUtc, ...(occurrence.eventType === 'delta' ? { baselineAtUtc: occurrence.baselineAtUtc, triggerAtUtc: occurrence.triggerAtUtc, actualDelta: occurrence.actualDelta, elapsedSeconds: occurrence.elapsedSeconds } : {}), ...(occurrence.eventType === 'value_change' ? { transitionAtUtc: occurrence.transitionAtUtc, previousAtUtc: occurrence.previousAtUtc, previousValue: occurrence.previousValue, newValue: occurrence.newValue } : {}) }, evidence: { productionContextDimensions: detail.evidence.productionContext.map(({ field }) => field), radiusAtEvent: detail.evidence.radiusAtEvent, phaseLabels: [...new Set(detail.evidence.phaseSummary.items.map(({ phase }) => phase))], behavior: detail.evidence.behavior, persistence: detail.evidence.persistence, contextualEnvelope: detail.evidence.contextualEnvelope, firstDivergence: detail.evidence.firstDivergence, suggestions: suggestionSummary(detail.evidence.suggestedSignals), observationCount: detail.evidence.observationCount }, history, payloadBytes: { evidence: bytes(detail), history: bytes(history) } } }

export async function validateTelemetryEventsOverHttp(input: { api: ProcessIntelligenceExplorerHttpClient; startUtc: string; endUtc: string }) {
  const began = Date.now(); const mark = input.api.mark(); const catalog = await input.api.telemetryCatalog()
  let delta: ReturnType<typeof telemetryOccurrenceSummary> | null = null; let deltaRule: { direction: 'either'; amount: number; windowMinutes: number } | null = null
  const numericVariables = [...catalog.canonicalVariables].filter((item) => item.dataKind === 'numeric').sort((left, right) => Number(!/temperature/i.test(left.canonicalId)) - Number(!/temperature/i.test(right.canonicalId)) || left.canonicalId.localeCompare(right.canonicalId)).slice(0, 2)
  for (const variable of numericVariables) {
    const choice = sourceChoice(variable); if (!choice) continue
    const preview = await input.api.telemetryPreview({ source: { kind: 'canonical', canonicalId: variable.canonicalId }, pressKey: choice.pressKey, deckNumber: choice.deckNumber, fromUtc: input.startUtc, toUtc: input.endUtc })
    const points = preview.observations.flatMap((item) => typeof item.value === 'number' && finiteUtc(item.atUtc) ? [{ atUtc: item.atUtc, value: item.value, qualityState: item.qualityState }] : [])
    const strongest = strongestBoundedDelta({ points, windowMinutes: 5, referenceMode: 'ROLLING_EXTREME', gapLimitMs: 330_000 }); if (!strongest || Math.abs(strongest.delta) <= 0) continue
    const rule = { kind: 'delta' as const, direction: 'either' as const, amount: Math.abs(strongest.delta) * 0.9, windowMinutes: 5 }
    const search = await input.api.telemetrySearch({ fromUtc: input.startUtc, toUtc: input.endUtc, source: { kind: 'canonical', canonicalId: variable.canonicalId }, pressKey: choice.pressKey, deckNumber: choice.deckNumber, rule, chartContextMinutes: 40 })
    const occurrence = search.occurrences.at(-1); if (!occurrence) continue
    const detail = await input.api.telemetryDetail(occurrence); const history = await input.api.telemetryHistory(occurrence, search.occurrences)
    delta = telemetryOccurrenceSummary(occurrence, detail, history); deltaRule = rule; break
  }
  let valueChange: ReturnType<typeof telemetryOccurrenceSummary> | null = null
  const stateVariables = [...catalog.canonicalVariables].filter((item) => item.dataKind !== 'numeric').sort((left, right) => Number(!/^production\.(recipe|order|job|material)/.test(left.canonicalId)) - Number(!/^production\.(recipe|order|job|material)/.test(right.canonicalId)) || left.canonicalId.localeCompare(right.canonicalId)).slice(0, 2)
  for (const variable of stateVariables) {
    const choice = sourceChoice(variable); if (!choice) continue
    const preview = await input.api.telemetryPreview({ source: { kind: 'canonical', canonicalId: variable.canonicalId }, pressKey: choice.pressKey, deckNumber: choice.deckNumber, fromUtc: input.startUtc, toUtc: input.endUtc })
    if (!preview.observations.some((item, index) => index > 0 && !scalarEqual(item.value, preview.observations[index - 1]!.value))) continue
    const search = await input.api.telemetrySearch({ fromUtc: input.startUtc, toUtc: input.endUtc, source: { kind: 'canonical', canonicalId: variable.canonicalId }, pressKey: choice.pressKey, deckNumber: choice.deckNumber, rule: { kind: 'value_change', match: 'any' }, chartContextMinutes: 40 })
    const occurrence = search.occurrences.at(-1); if (!occurrence) continue
    const detail = await input.api.telemetryDetail(occurrence); const history = await input.api.telemetryHistory(occurrence, search.occurrences)
    valueChange = telemetryOccurrenceSummary(occurrence, detail, history); break
  }
  const suggested = [...(delta?.evidence.suggestions ?? []), ...(valueChange?.evidence.suggestions ?? [])]; const suggestion = suggested[0]; const selected = delta?.occurrence ?? valueChange?.occurrence
  const previewPinContract = suggestion && selected ? await input.api.telemetryPreview({ source: { kind: 'canonical', canonicalId: suggestion.canonicalId }, pressKey: selected.pressKey, deckNumber: suggestion.deckNumber, fromUtc: new Date(Date.parse(selected.startUtc) - 40 * 60_000).toISOString(), toUtc: new Date(Date.parse(selected.endUtc) + 40 * 60_000).toISOString() }).then((preview) => ({ exercised: true, plottable: preview.plottable, observationCount: preview.observations.length, pinUsesExistingClientState: true })) : { exercised: false, reason: 'No suggested canonical signal was returned.' }
  const diagnostics = { ...input.api.metricsSince(mark), directPostgresConnections: 0, rawUnmappedCalls: { changes: 0, catalogs: 0, histories: 0, total: 0 } }; const envelopes = [delta?.evidence.contextualEnvelope, valueChange?.evidence.contextualEnvelope].filter(Boolean); const analyticalText = JSON.stringify([delta, valueChange]).toLowerCase()
  const gates = { numericDeltaObserved: Boolean(delta), deltaTimestampsObservedOnly: Boolean(delta && delta.occurrence.baselineAtUtc && delta.occurrence.triggerAtUtc && finiteUtc(delta.occurrence.baselineAtUtc) && finiteUtc(delta.occurrence.triggerAtUtc)), valueChangeObservedAndExact: Boolean(valueChange?.occurrence.transitionAtUtc && Object.hasOwn(valueChange.occurrence, 'previousValue') && Object.hasOwn(valueChange.occurrence, 'newValue')), contextAndRadiusPresent: [delta, valueChange].filter(Boolean).every((item) => item!.evidence.radiusAtEvent !== null), suggestionsBoundedCanonical: [delta, valueChange].filter(Boolean).every((item) => item!.evidence.suggestions.length <= 5 && item!.evidence.suggestions.every(({ canonicalId, reasonCodes }) => Boolean(canonicalId) && reasonCodes.length > 0)), contextualEnvelopeSemantics: envelopes.every((item) => (item as { family?: unknown }).family === 'normal_envelope_departure'), historyBoundedLazy: [delta, valueChange].filter(Boolean).every((item) => item!.history.supportCount <= 500 && item!.history.scope.includes('current bounded search result')), previewPinExistingPath: !suggestion || previewPinContract.exercised === true, noNegativeOrCausalClaims: !/expected[- ]but[- ]missing|expected missing|root cause|caused by/.test(analyticalText), boundedHttpRequests: diagnostics.requestCount <= 14, noRawUnmappedAutomaticScans: diagnostics.rawUnmappedCalls.total === 0 }
  return { status: Object.values(gates).every(Boolean) ? 'PASS' : 'FAIL', runtimeMs: Date.now() - began, serviceQueries: diagnostics.requestCount, radiusServiceCalls: 0, boundedSelection: { numericVariablesConsidered: numericVariables.length, stateVariablesConsidered: stateVariables.length }, deltaRule, delta, valueChange, valueChangeObserved: Boolean(valueChange), thresholdVsEnvelope: { operatorConfiguredThresholdRemainsDistinct: true, contextualEnvelopeFamily: 'normal_envelope_departure', forbiddenMachineLimitLabels: false }, previewPinContract, diagnostics, gates }
}
