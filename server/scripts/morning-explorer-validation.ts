import type { RadiusService } from '../src/radius/radius-service.js'
import type { RadiusPressKey } from '../src/radius/models.js'
import { strongestBoundedDelta } from '../src/industrial-analytics/bounded-delta.js'
import { RawRadiusExplorerService, type RawExplorerOccurrence } from '../src/raw-radius-explorer/raw-radius-explorer-service.js'
import { TelemetryEventExplorerService, type TelemetryEventOccurrence } from '../src/telemetry-event-explorer/telemetry-event-explorer-service.js'
import type { BoundedTelemetryReadDiagnostics } from '../src/telemetry/telemetry-contracts.js'
import { TelemetryFoundationService } from '../src/telemetry/telemetry-foundation-service.js'

type ReadRecord = { requestId: string | null; diagnostics: BoundedTelemetryReadDiagnostics }

function bytes(value: unknown) { return Buffer.byteLength(JSON.stringify(value), 'utf8') }
function scalarEqual(left: unknown, right: unknown) { return typeof left === typeof right && left === right }
function finiteUtc(value: string) { return Number.isFinite(Date.parse(value)) }

export class ExplorerReadTracker {
  private readonly reads: ReadRecord[] = []
  private rawChanges = 0
  private rawCatalogs = 0
  private rawHistories = 0

  constructor(private readonly telemetry: TelemetryFoundationService) {
    const semanticHistory = telemetry.semanticHistory.bind(telemetry)
    telemetry.semanticHistory = async (pressKey, query, requestId, signal) => {
      const result = await semanticHistory(pressKey, query, requestId, signal)
      if (result.readDiagnostics) this.reads.push({ requestId: requestId ?? null, diagnostics: result.readDiagnostics })
      return result
    }
    const semanticHistoryWithIdentity = telemetry.semanticHistoryWithIdentity.bind(telemetry)
    telemetry.semanticHistoryWithIdentity = async (pressKey, query, requestId, signal) => {
      const result = await semanticHistoryWithIdentity(pressKey, query, requestId, signal)
      if (result.readDiagnostics) this.reads.push({ requestId: requestId ?? null, diagnostics: result.readDiagnostics })
      return result
    }
    const rawChanges = telemetry.rawChanges.bind(telemetry)
    telemetry.rawChanges = async (...args) => { this.rawChanges += 1; return rawChanges(...args) }
    const rawCatalog = telemetry.rawCatalog.bind(telemetry)
    telemetry.rawCatalog = async (...args) => { this.rawCatalogs += 1; return rawCatalog(...args) }
    const rawHistory = telemetry.rawHistory.bind(telemetry)
    telemetry.rawHistory = async (...args) => { this.rawHistories += 1; return rawHistory(...args) }
  }

  snapshot(requestPrefix: string) {
    const values = this.reads.filter(({ requestId }) => requestId?.startsWith(requestPrefix))
    const requests = values.flatMap(({ diagnostics }) => diagnostics.requests ?? [])
    const requestKeys = requests.map((item) => JSON.stringify([item.pressKey, item.selectors, item.range.start, item.range.end]))
    return {
      requestIds: [...new Set(values.flatMap(({ requestId }) => requestId ?? []))],
      semanticServiceRequests: values.length,
      telemetryRequests: values.reduce((sum, item) => sum + item.diagnostics.telemetryRequests, 0),
      telemetryChunkCount: values.reduce((sum, item) => sum + item.diagnostics.chunkCount, 0),
      cacheHits: values.reduce((sum, item) => sum + item.diagnostics.cacheHits, 0),
      cacheHitsByType: {
        exact: values.reduce((sum, item) => sum + (item.diagnostics.exactCacheHits ?? 0), 0),
        selectorSubset: values.reduce((sum, item) => sum + (item.diagnostics.selectorSubsetCacheHits ?? 0), 0),
        containedRange: values.reduce((sum, item) => sum + (item.diagnostics.containedRangeCacheHits ?? 0), 0),
        containedRangeSelectorSubset: values.reduce((sum, item) => sum + (item.diagnostics.containedRangeSelectorSubsetCacheHits ?? 0), 0),
      },
      pointsReturned: values.reduce((sum, item) => sum + item.diagnostics.pointsReturned, 0),
      pointsRetained: values.reduce((sum, item) => sum + item.diagnostics.pointsRetained, 0),
      maximumChunkMs: requests.reduce((maximum, item) => Math.max(maximum, Date.parse(item.range.end) - Date.parse(item.range.start)), 0),
      duplicateUpstreamReads: requestKeys.length - new Set(requestKeys).size,
      rawUnmappedCalls: { changes: this.rawChanges, catalogs: this.rawCatalogs, histories: this.rawHistories, total: this.rawChanges + this.rawCatalogs + this.rawHistories },
    }
  }
}

function exactIdentity(value: { eventType: string; statusCode: string | null; statusDescription: string }) {
  return { eventType: value.eventType, statusCode: value.statusCode, statusDescription: value.statusDescription }
}

function suggestionSummary(values: Array<{ canonicalId: string; deckNumber: number | null; friendlyName: string; category: string; reasonCodes: string[]; timingDetail: string | null }>) {
  return values.map(({ canonicalId, deckNumber, friendlyName, category, reasonCodes, timingDetail }) => ({ signal: friendlyName, canonicalId, semanticFamily: category, deckNumber, reasonCodes, relativeTiming: timingDetail }))
}

function rawRepresentative(occurrence: RawExplorerOccurrence, detail: Awaited<ReturnType<RawRadiusExplorerService['detail']>>, history: Awaited<ReturnType<RawRadiusExplorerService['historicalSummary']>>) {
  const alignment = detail.evidence.physicalAlignment
  return {
    occurrence: { occurrenceId: occurrence.occurrenceId, pressKey: occurrence.pressKey, recordedRadius: exactIdentity(occurrence), startUtc: occurrence.startUtc, endUtc: occurrence.endUtc, durationSeconds: occurrence.durationSeconds },
    physicalAlignment: {
      recordedRadius: alignment.recordedRadius,
      recordedStartUtc: alignment.recordedStartUtc,
      recordedEndUtc: alignment.recordedEndUtc,
      inferredPhysicalOnsetRange: alignment.inferredPhysicalOnsetRange,
      inferredPhysicalExitRange: alignment.inferredPhysicalExitRange,
      entryLagRange: alignment.entryLagRange,
      exitLagRange: alignment.exitLagRange,
      speedEvidence: alignment.speedEvidence,
      otherTelemetryEvidence: alignment.otherTelemetryEvidence,
      contextDimensions: alignment.contextEvidence.map(({ field }) => field),
      radiusSequenceEvidence: alignment.radiusSequenceEvidence,
      agreementClass: alignment.agreementClass,
      evidenceQuality: alignment.evidenceQuality,
    },
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

export async function validateRawRadius(input: {
  radius: RadiusService
  telemetry: TelemetryFoundationService
  tracker: ExplorerReadTracker
  startUtc: string
  endUtc: string
  signal: AbortSignal
}) {
  const validationBegan = Date.now()
  const explorer = new RawRadiusExplorerService(input.radius, input.telemetry)
  const requestPrefix = 'morning-raw-radius-'
  const identities = (await explorer.identities(input.startUtc, input.endUtc))
    .sort((left, right) => Number(right.eventType !== 'G') - Number(left.eventType !== 'G') || Date.parse(right.lastSeenUtc ?? '') - Date.parse(left.lastSeenUtc ?? '') || right.eventCount - left.eventCount)
    .slice(0, 2)
  const representatives = []
  for (const [index, identity] of identities.entries()) {
    const explored = await explorer.explore({ fromUtc: input.startUtc, toUtc: input.endUtc, identity: exactIdentity(identity) as typeof identity, changeLookbackMinutes: 30, chartContextMinutes: 40 })
    const occurrence = [...explored.occurrences].sort((left, right) => Date.parse(right.startUtc) - Date.parse(left.startUtc))[0]
    if (!occurrence) continue
    const requestId = `${requestPrefix}${index + 1}`
    const detail = await explorer.detail({ occurrence, changeLookbackMinutes: 30 }, requestId, input.signal, { includeRawTelemetryDiscovery: false })
    const beforeHistory = input.tracker.snapshot(requestPrefix).semanticServiceRequests
    const history = await explorer.historicalSummary({ occurrence, lookbackDays: 31, maximumOccurrences: 100 })
    const afterHistory = input.tracker.snapshot(requestPrefix).semanticServiceRequests
    representatives.push({ ...rawRepresentative(occurrence, detail, history), historySemanticTelemetryFanout: afterHistory - beforeHistory })
  }
  const diagnostics = input.tracker.snapshot(requestPrefix)
  const allSuggestions = representatives.flatMap((item) => item.suggestions)
  const gates = {
    representativeDataObserved: representatives.length > 0,
    exactStatusCodePreserved: representatives.every((item) => item.occurrence.recordedRadius.statusCode && item.radiusSequence.find(({ relationship }) => relationship === 'CURRENT')?.statusCode === item.occurrence.recordedRadius.statusCode),
    conservativePhysicalSemantics: representatives.every((item) => item.physicalAlignment.evidenceQuality && item.phaseLimitations.some((value) => /not.*classif|activity remains unknown|do not establish causation/i.test(value))),
    contextDimensionsBounded: representatives.every((item) => new Set(item.productionContextDimensions).size === item.productionContextDimensions.length),
    suggestionsBoundedCanonical: representatives.every((item) => item.suggestions.length <= 5 && item.suggestions.every(({ canonicalId, reasonCodes }) => Boolean(canonicalId) && reasonCodes.length > 0)),
    historyExactBounded: representatives.every((item) => item.history.scope.includes('exact Radius identity') && item.history.supportCount <= 100 && item.historySemanticTelemetryFanout === 0),
    chunksAtMostTwoHours: diagnostics.maximumChunkMs <= 2 * 60 * 60_000,
    noDuplicateUpstreamReads: diagnostics.duplicateUpstreamReads === 0,
    noRawUnmappedAutomaticScans: diagnostics.rawUnmappedCalls.total === 0,
  }
  const radiusServiceCalls = 1 + representatives.length * 3
  return { status: Object.values(gates).every(Boolean) ? 'PASS' : 'FAIL', runtimeMs: Date.now() - validationBegan, serviceQueries: radiusServiceCalls + diagnostics.semanticServiceRequests, radiusServiceCalls, boundedSample: { identityCountConsidered: identities.length, occurrenceDetailsInspected: representatives.length }, representatives, physicalBeforeRecordedObserved: representatives.find((item) => item.physicalAlignment.agreementClass === 'PHYSICAL_PRECEDES_RECORDED') ?? null, diagnostics, gates }
}

type Catalog = Awaited<ReturnType<TelemetryEventExplorerService['catalog']>>
type CatalogVariable = Catalog['canonicalVariables'][number]

function sourceChoice(variable: CatalogVariable) {
  const compatible = [...variable.compatiblePresses].sort((left, right) => Number(right.pressKey === 'press14') - Number(left.pressKey === 'press14') || left.pressKey.localeCompare(right.pressKey))[0]
  if (!compatible) return null
  return { variable, pressKey: compatible.pressKey as RadiusPressKey, deckNumber: variable.scope === 'deck' ? compatible.deckNumbers[0] ?? null : null }
}

function telemetryOccurrenceSummary(occurrence: TelemetryEventOccurrence, detail: Awaited<ReturnType<TelemetryEventExplorerService['detail']>>, history: ReturnType<TelemetryEventExplorerService['historicalSummary']>) {
  return {
    occurrence: {
      occurrenceId: occurrence.occurrenceId, pressKey: occurrence.pressKey, signal: occurrence.signalDisplayName, canonicalId: occurrence.canonicalId, deckNumber: occurrence.deckNumber,
      detector: occurrence.eventType, startUtc: occurrence.startUtc, endUtc: occurrence.endUtc,
      ...(occurrence.eventType === 'delta' ? { baselineAtUtc: occurrence.baselineAtUtc, triggerAtUtc: occurrence.triggerAtUtc, actualDelta: occurrence.actualDelta, elapsedSeconds: occurrence.elapsedSeconds } : {}),
      ...(occurrence.eventType === 'value_change' ? { transitionAtUtc: occurrence.transitionAtUtc, previousAtUtc: occurrence.previousAtUtc, previousValue: occurrence.previousValue, newValue: occurrence.newValue } : {}),
    },
    evidence: {
      productionContextDimensions: detail.evidence.productionContext.map(({ field }) => field), radiusAtEvent: detail.evidence.radiusAtEvent,
      phaseLabels: [...new Set(detail.evidence.phaseSummary.items.map(({ phase }) => phase))], behavior: detail.evidence.behavior,
      persistence: detail.evidence.persistence, contextualEnvelope: detail.evidence.contextualEnvelope, firstDivergence: detail.evidence.firstDivergence,
      suggestions: suggestionSummary(detail.evidence.suggestedSignals), observationCount: detail.evidence.observationCount,
    },
    history,
    payloadBytes: { evidence: bytes(detail), history: bytes(history) },
  }
}

export async function validateTelemetryEvents(input: {
  radius: RadiusService
  telemetry: TelemetryFoundationService
  tracker: ExplorerReadTracker
  startUtc: string
  endUtc: string
  signal: AbortSignal
}) {
  const validationBegan = Date.now()
  const rawExplorer = new RawRadiusExplorerService(input.radius, input.telemetry)
  const explorer = new TelemetryEventExplorerService(input.telemetry, input.radius, rawExplorer)
  const requestPrefix = 'morning-telemetry-'
  const catalog = await explorer.catalog(undefined, undefined, undefined, `${requestPrefix}catalog`, input.signal)

  let delta: ReturnType<typeof telemetryOccurrenceSummary> | null = null
  let deltaRule: { direction: 'either'; amount: number; windowMinutes: number } | null = null
  const numericVariables = [...catalog.canonicalVariables].filter((item) => item.dataKind === 'numeric')
    .sort((left, right) => Number(!/temperature/i.test(left.canonicalId)) - Number(!/temperature/i.test(right.canonicalId)) || left.canonicalId.localeCompare(right.canonicalId)).slice(0, 2)
  for (const [index, variable] of numericVariables.entries()) {
    const choice = sourceChoice(variable); if (!choice) continue
    const requestId = `${requestPrefix}delta-${index + 1}`
    const preview = await explorer.preview({ source: { kind: 'canonical', canonicalId: variable.canonicalId }, pressKey: choice.pressKey, deckNumber: choice.deckNumber, fromUtc: input.startUtc, toUtc: input.endUtc }, requestId, input.signal)
    const points = preview.observations.flatMap((item) => typeof item.value === 'number' && finiteUtc(item.atUtc) ? [{ atUtc: item.atUtc, value: item.value, qualityState: item.qualityState }] : [])
    const strongest = strongestBoundedDelta({ points, windowMinutes: 5, referenceMode: 'ROLLING_EXTREME', gapLimitMs: 330_000 })
    if (!strongest || Math.abs(strongest.delta) <= 0) continue
    const rule = { kind: 'delta' as const, direction: 'either' as const, amount: Math.abs(strongest.delta) * 0.9, windowMinutes: 5 }
    const search = await explorer.search({ fromUtc: input.startUtc, toUtc: input.endUtc, source: { kind: 'canonical', canonicalId: variable.canonicalId }, pressKey: choice.pressKey, deckNumber: choice.deckNumber, rule, chartContextMinutes: 40 }, requestId, input.signal)
    const occurrence = search.occurrences.at(-1); if (!occurrence) continue
    const detail = await explorer.detail(occurrence, requestId, input.signal, { includeRawTelemetryDiscovery: false })
    const history = explorer.historicalSummary({ occurrence, occurrences: search.occurrences })
    delta = telemetryOccurrenceSummary(occurrence, detail, history); deltaRule = rule
    break
  }

  let valueChange: ReturnType<typeof telemetryOccurrenceSummary> | null = null
  const stateVariables = [...catalog.canonicalVariables].filter((item) => item.dataKind !== 'numeric')
    .sort((left, right) => Number(!/^production\.(recipe|order|job|material)/.test(left.canonicalId)) - Number(!/^production\.(recipe|order|job|material)/.test(right.canonicalId)) || left.canonicalId.localeCompare(right.canonicalId)).slice(0, 2)
  for (const [index, variable] of stateVariables.entries()) {
    const choice = sourceChoice(variable); if (!choice) continue
    const requestId = `${requestPrefix}value-${index + 1}`
    const preview = await explorer.preview({ source: { kind: 'canonical', canonicalId: variable.canonicalId }, pressKey: choice.pressKey, deckNumber: choice.deckNumber, fromUtc: input.startUtc, toUtc: input.endUtc }, requestId, input.signal)
    if (!preview.observations.some((item, itemIndex) => itemIndex > 0 && !scalarEqual(item.value, preview.observations[itemIndex - 1]!.value))) continue
    const search = await explorer.search({ fromUtc: input.startUtc, toUtc: input.endUtc, source: { kind: 'canonical', canonicalId: variable.canonicalId }, pressKey: choice.pressKey, deckNumber: choice.deckNumber, rule: { kind: 'value_change', match: 'any' }, chartContextMinutes: 40 }, requestId, input.signal)
    const occurrence = search.occurrences.at(-1); if (!occurrence) continue
    const detail = await explorer.detail(occurrence, requestId, input.signal, { includeRawTelemetryDiscovery: false })
    const history = explorer.historicalSummary({ occurrence, occurrences: search.occurrences })
    valueChange = telemetryOccurrenceSummary(occurrence, detail, history)
    break
  }

  const suggested = [...(delta?.evidence.suggestions ?? []), ...(valueChange?.evidence.suggestions ?? [])]
  let previewPinContract: Record<string, unknown> = { exercised: false, reason: 'No suggested canonical signal was returned.' }
  const suggestion = suggested[0]
  const selectedOccurrence = delta?.occurrence ?? valueChange?.occurrence
  if (suggestion && selectedOccurrence) {
    const result = await explorer.preview({ source: { kind: 'canonical', canonicalId: suggestion.canonicalId }, pressKey: selectedOccurrence.pressKey, deckNumber: suggestion.deckNumber, fromUtc: new Date(Date.parse(selectedOccurrence.startUtc) - 40 * 60_000).toISOString(), toUtc: new Date(Date.parse(selectedOccurrence.endUtc) + 40 * 60_000).toISOString() }, `${requestPrefix}suggestion-preview`, input.signal)
    previewPinContract = { exercised: true, canonicalId: suggestion.canonicalId, deckNumber: suggestion.deckNumber, plottable: result.plottable, observationCount: result.observations.length, pinUsesExistingClientState: true }
  }
  const diagnostics = input.tracker.snapshot(requestPrefix)
  const envelopes = [delta?.evidence.contextualEnvelope, valueChange?.evidence.contextualEnvelope].filter(Boolean)
  const analyticalText = JSON.stringify([delta, valueChange]).toLowerCase()
  const gates = {
    numericDeltaObserved: Boolean(delta),
    deltaTimestampsObservedOnly: Boolean(delta && delta.occurrence.baselineAtUtc && delta.occurrence.triggerAtUtc && finiteUtc(delta.occurrence.baselineAtUtc) && finiteUtc(delta.occurrence.triggerAtUtc)),
    valueChangeObservedAndExact: Boolean(valueChange?.occurrence.transitionAtUtc && Object.hasOwn(valueChange.occurrence, 'previousValue') && Object.hasOwn(valueChange.occurrence, 'newValue')),
    contextAndRadiusPresent: [delta, valueChange].filter(Boolean).every((item) => item!.evidence.radiusAtEvent !== null),
    suggestionsBoundedCanonical: [delta, valueChange].filter(Boolean).every((item) => item!.evidence.suggestions.length <= 5 && item!.evidence.suggestions.every(({ canonicalId, reasonCodes }) => Boolean(canonicalId) && reasonCodes.length > 0)),
    contextualEnvelopeSemantics: envelopes.every((item) => (item as { family?: unknown }).family === 'normal_envelope_departure'),
    historyBoundedNoHistorianFanout: [delta, valueChange].filter(Boolean).every((item) => item!.history.supportCount <= 500 && item!.history.scope.includes('current bounded search result')),
    previewPinExistingPath: !suggestion || previewPinContract.exercised === true,
    noNegativeOrCausalClaims: !/expected[- ]but[- ]missing|expected missing|root cause|caused by/.test(analyticalText),
    chunksAtMostTwoHours: diagnostics.maximumChunkMs <= 2 * 60 * 60_000,
    noDuplicateUpstreamReads: diagnostics.duplicateUpstreamReads === 0,
    noRawUnmappedAutomaticScans: diagnostics.rawUnmappedCalls.total === 0,
  }
  const radiusServiceCalls = Number(Boolean(delta)) + Number(Boolean(valueChange))
  return { status: Object.values(gates).every(Boolean) ? 'PASS' : 'FAIL', runtimeMs: Date.now() - validationBegan, serviceQueries: radiusServiceCalls + diagnostics.semanticServiceRequests, radiusServiceCalls, boundedSelection: { numericVariablesConsidered: numericVariables.length, stateVariablesConsidered: stateVariables.length }, deltaRule, delta, valueChange, valueChangeObserved: Boolean(valueChange), thresholdVsEnvelope: { operatorConfiguredThresholdRemainsDistinct: true, contextualEnvelopeFamily: 'normal_envelope_departure', forbiddenMachineLimitLabels: false }, previewPinContract, diagnostics, gates }
}
