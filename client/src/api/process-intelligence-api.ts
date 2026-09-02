import type {
  PhysicalStateResponse,
  ProcessIntelligenceHealth,
  OperationalEpisode,
  RadiusHealth,
  RadiusOverview,
  RadiusPressEpisodes,
  RadiusPressKey,
  TelemetryHealth,
  TelemetrySource,
  ClassificationWorkspace,
  ClassificationDraft,
  ClassificationValidation,
  OperationalGroupKey,
  ProcessFamilyKey,
  MappingConfidence,
  ClassificationSearchResponse,
  OperationalGroup,
  ProcessFamily,
  ActivityAnalysis,
  ActivitySelection,
  PatternAnalysis,
  PatternMatchMode,
  RawExplorerDetail,
  RawExplorerIdentity,
  RawExplorerOccurrence,
  RawExplorerPlotResult,
  RawExplorerResult,
  RawExplorerSetup,
  RawExplorerSignalIdentity,
  RawTelemetryReview,
  RawTelemetryReviewStatus,
  RawUnmappedPlotResult,
  TelemetryEventCatalog,
  TelemetryEventPreview,
  TelemetryEventRawCatalogResult,
  TelemetryEventDetail,
  TelemetryEventOccurrence,
  TelemetryEventRule,
  TelemetryEventSearchInput,
  TelemetryEventSearchResult,
  TelemetryEventSource,
  BasicHistoricalSummary,
  EventLearningReport,
  JobAnalysisDimension,
  JobGroupDefinition,
  JobIntelligenceReport,
} from '../types/api'
import type {
  CuratedPhysicalEvidence,
  EngineeringClueResponse,
  EngineeringSignalType,
  PhysicalEvidenceCategory,
  PressMotionEvidence,
  PressSpeedEvidence,
  PressTelemetryCapabilities,
  PressTelemetrySource,
  PressSemanticHistoryEvidence,
  ProductionContextEvidence,
  StopRestartResponse,
  RadiusTimingAnalysisResponse,
  FleetSpeedContextResponse,
  TelemetryRepresentation,
} from '../types/evidence'
import type { ChangeoverInspector, ChangeoverReport, ChangeoverRequest } from '../types/changeover'
import type { StopIntelligenceCorrection, StopIntelligenceDetail, StopIntelligenceFleetReport, StopOperatorState, StopPredictedState } from '../types/stop-intelligence'
import type { PressDowntimePressReport } from '../types/press-downtime'

export class ApiRequestError extends Error {
  constructor(public readonly status: number) {
    super('The requested service is unavailable.')
    this.name = 'ApiRequestError'
  }
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    headers: { Accept: 'application/json' },
    signal,
  })

  if (!response.ok) {
    throw new ApiRequestError(response.status)
  }

  return (await response.json()) as T
}

async function sendJson<T>(path: string, method: 'POST' | 'PATCH' | 'DELETE', body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { method, headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal })
  if (!response.ok) throw new ApiRequestError(response.status)
  return response.status === 204 ? undefined as T : await response.json() as T
}

export function getProcessIntelligenceHealth(signal?: AbortSignal) {
  return getJson<ProcessIntelligenceHealth>('/api/health', signal)
}

export function getTelemetryHealth(signal?: AbortSignal) {
  return getJson<TelemetryHealth>('/api/telemetry/health', signal)
}

export function getTelemetrySources() {
  return getJson<TelemetrySource[]>('/api/telemetry/sources')
}

export function getPressTelemetrySources(signal?: AbortSignal) {
  return getJson<PressTelemetrySource[]>('/api/telemetry/presses', signal)
}

export function getPressTelemetryCapabilities(pressKey: RadiusPressKey, signal?: AbortSignal) {
  return getJson<PressTelemetryCapabilities>(`/api/telemetry/presses/${pressKey}/capabilities`, signal)
}

export function getPressSpeed(pressKey: RadiusPressKey, fromUtc: string, toUtc: string, signal?: AbortSignal) {
  return getJson<PressSpeedEvidence>(`/api/telemetry/presses/${pressKey}/speed?${rangeQuery(fromUtc, toUtc)}`, signal)
}

export function getPressMotion(pressKey: RadiusPressKey, fromUtc: string, toUtc: string, signal?: AbortSignal) {
  return getJson<PressMotionEvidence>(`/api/telemetry/presses/${pressKey}/motion?${rangeQuery(fromUtc, toUtc)}`, signal)
}

export function getProductionContext(pressKey: RadiusPressKey, fromUtc: string, toUtc: string, signal?: AbortSignal) {
  return sendJson<ProductionContextEvidence>(`/api/telemetry/presses/${pressKey}/context`, 'POST', { fromUtc, toUtc }, signal)
}

export function getCuratedPhysicalEvidence(pressKey: RadiusPressKey, input: { fromUtc: string; toUtc: string; includeSeed?: boolean; categories: PhysicalEvidenceCategory[]; deckNumbers?: number[]; representation?: TelemetryRepresentation }, signal?: AbortSignal) {
  return sendJson<CuratedPhysicalEvidence>(`/api/telemetry/presses/${pressKey}/evidence`, 'POST', { ...input, includeSeed: input.includeSeed ?? true, representation: input.representation ?? 'changes' }, signal)
}

export function getEngineeringClues(pressKey: RadiusPressKey, occurrence: { occurrenceId: string; displayName: string; startUtc: string; endUtc: string; exactIdentities: Array<{ eventType: string; statusCode: string | null; statusDescription: string }> }, signal?: AbortSignal) {
  return sendJson<EngineeringClueResponse>(`/api/telemetry/presses/${pressKey}/clues`, 'POST', occurrence, signal)
}

export function getStopRestartAnalysis(pressKey: RadiusPressKey, occurrence: ActivityAnalysis['occurrences'][number], candidates: Array<{ canonicalId: string; deckNumber?: number; friendlyName?: string; signalType?: EngineeringSignalType; category?: string; source: 'clue' | 'pin' | 'priority' }>, signal?: AbortSignal) {
  return sendJson<StopRestartResponse>(`/api/telemetry/presses/${pressKey}/stop-restart-analysis`, 'POST', { occurrence: { occurrenceId: occurrence.occurrenceId, displayName: occurrence.displayName, startUtc: occurrence.startUtc, endUtc: occurrence.endUtc, operationalGroupKey: occurrence.operationalGroupKey, operationalGroupName: occurrence.operationalGroupName, processFamilyKey: occurrence.processFamilyKey, processFamilyName: occurrence.processFamilyName, exactIdentities: occurrence.exactIdentities.map(({ eventType, statusCode, statusDescription }) => ({ eventType, statusCode, statusDescription })) }, candidates }, signal)
}

export function getRadiusTimingAnalysis(exactIdentity: { eventType: string; statusCode: string | null; statusDescription: string }, occurrences: ActivityAnalysis['occurrences'], signal?: AbortSignal) {
  return sendJson<RadiusTimingAnalysisResponse>('/api/telemetry/radius-timing-analysis', 'POST', { exactIdentity, occurrences: occurrences.slice(0, 30).map(({ occurrenceId, pressKey, displayName, startUtc }) => ({ occurrenceId, pressKey, displayName, startUtc })) }, signal)
}

export function getFleetSpeedContext(fromUtc: string, toUtc: string, pressKeys: RadiusPressKey[], signal?: AbortSignal) {
  return sendJson<FleetSpeedContextResponse>('/api/telemetry/fleet-speed-context', 'POST', { fromUtc, toUtc, pressKeys: pressKeys.slice(0, 6) }, signal)
}

export function getPressSemanticHistory(pressKey: RadiusPressKey, input: { fromUtc: string; toUtc: string; includeSeed: boolean; signals: Array<{ canonicalId: string; deckNumber?: number; representation: TelemetryRepresentation; signalType?: EngineeringSignalType }> }, signal?: AbortSignal) {
  const signals = input.signals.map(({ canonicalId, deckNumber, representation }) => ({ canonicalId, ...(deckNumber === undefined ? {} : { deckNumber }), representation }))
  return sendJson<PressSemanticHistoryEvidence>(`/api/telemetry/presses/${pressKey}/semantic-history`, 'POST', { ...input, signals }, signal)
}

export function getRecentPhysicalState(sourceId: number) {
  const toUtc = new Date()
  const fromUtc = new Date(toUtc.getTime() - 30 * 60 * 1_000)
  const query = new URLSearchParams({
    fromUtc: fromUtc.toISOString(),
    toUtc: toUtc.toISOString(),
  })

  return getJson<PhysicalStateResponse>(
    `/api/telemetry/sources/${sourceId}/physical-state?${query.toString()}`,
  )
}

function rangeQuery(fromUtc: string, toUtc: string): string {
  return new URLSearchParams({ fromUtc, toUtc }).toString()
}

export function getRadiusHealth(signal?: AbortSignal) {
  return getJson<RadiusHealth>('/api/radius/health', signal)
}

export function getJobIntelligenceReport(input: { pressKey: RadiusPressKey; fromUtc: string; toUtc: string; analyzeBy: JobAnalysisDimension; group?: JobGroupDefinition }, signal?: AbortSignal) {
  const parameters = new URLSearchParams({ pressKey: input.pressKey, fromUtc: input.fromUtc, toUtc: input.toUtc, analyzeBy: input.analyzeBy })
  if (input.group) {
    parameters.set('operator', input.group.operator); parameters.set('query', input.group.query)
    if (input.group.positionStart !== undefined) parameters.set('positionStart', String(input.group.positionStart))
    if (input.group.positionEnd !== undefined) parameters.set('positionEnd', String(input.group.positionEnd))
    if (input.group.segmentIndex !== undefined) parameters.set('segmentIndex', String(input.group.segmentIndex))
    if (input.group.delimiter !== undefined) parameters.set('delimiter', input.group.delimiter)
  }
  return getJson<JobIntelligenceReport>(`/api/job-intelligence/report?${parameters}`, signal)
}

export function getStopIntelligenceFleet(pressKey: RadiusPressKey, fromUtc: string, toUtc: string, signal?: AbortSignal) {
  return getJson<StopIntelligenceFleetReport>(`/api/stop-intelligence/fleet?pressKey=${encodeURIComponent(pressKey)}&${rangeQuery(fromUtc, toUtc)}`, signal)
}

export function getPressDowntimePress(pressKey: RadiusPressKey, fromUtc: string, toUtc: string, signal?: AbortSignal) {
  return getJson<PressDowntimePressReport>(`/api/press-downtime/presses/${encodeURIComponent(pressKey)}?${rangeQuery(fromUtc, toUtc)}`, signal)
}

export function getStopIntelligenceDetail(input: { pressKey: RadiusPressKey; stopId: string; fromUtc: string; toUtc: string; includeRaw?: boolean }, signal?: AbortSignal) {
  const parameters = new URLSearchParams({ fromUtc: input.fromUtc, toUtc: input.toUtc })
  if (input.includeRaw) parameters.set('includeRaw', 'true')
  return getJson<StopIntelligenceDetail>(`/api/stop-intelligence/presses/${input.pressKey}/stops/${encodeURIComponent(input.stopId)}?${parameters}`, signal)
}

export function recordStopIntelligenceCorrection(input: { pressKey: RadiusPressKey; segmentKey: string; fromUtc: string; toUtc: string; predictedState: StopPredictedState; correctedState: StopOperatorState; comment?: string | null }, signal?: AbortSignal) {
  return sendJson<StopIntelligenceCorrection>('/api/stop-intelligence/corrections', 'POST', input, signal)
}

function changeoverParameters(input: ChangeoverRequest): URLSearchParams {
  const parameters = new URLSearchParams({ fromUtc: input.fromUtc, toUtc: input.toUtc, mode: input.mode, stopSpeed: String(input.stopSpeed), recoverySpeed: String(input.recoverySpeed), recoveryConfirmationSeconds: String(input.recoveryConfirmationSeconds) })
  if (input.focusPressKey) parameters.set('focusPressKey', input.focusPressKey)
  return parameters
}

export function getChangeoverIntelligenceReport(input: ChangeoverRequest, signal?: AbortSignal) {
  return getJson<ChangeoverReport>(`/api/changeover-intelligence/report?${changeoverParameters(input)}`, signal)
}

export function getChangeoverInspector(input: ChangeoverRequest & { changeoverId: string; pressKey: RadiusPressKey; physicalStartUtc: string; physicalRecoveryUtc: string }, signal?: AbortSignal) {
  const parameters = changeoverParameters(input)
  parameters.set('pressKey', input.pressKey); parameters.set('physicalStartUtc', input.physicalStartUtc); parameters.set('physicalRecoveryUtc', input.physicalRecoveryUtc)
  return getJson<ChangeoverInspector>(`/api/changeover-intelligence/changeovers/${encodeURIComponent(input.changeoverId)}?${parameters}`, signal)
}

export function getRadiusOverview(fromUtc: string, toUtc: string, decisionOnly = false, signal?: AbortSignal) {
  return getJson<RadiusOverview>(
    `/api/radius/overview?${rangeQuery(fromUtc, toUtc)}${decisionOnly ? '&view=decision' : ''}`,
    signal,
  )
}

export function getRawRadiusIdentities(fromUtc: string, toUtc: string, signal?: AbortSignal) {
  return getJson<RawExplorerIdentity[]>(`/api/radius/raw-explorer/identities?${rangeQuery(fromUtc, toUtc)}`, signal)
}

export function exploreRawRadius(setup: RawExplorerSetup, signal?: AbortSignal) {
  return sendJson<RawExplorerResult>('/api/radius/raw-explorer/explore', 'POST', setup, signal)
}

export function getRawRadiusOccurrenceDetail(occurrence: RawExplorerOccurrence, changeLookbackMinutes: number, signal?: AbortSignal) {
  return sendJson<RawExplorerDetail>('/api/radius/raw-explorer/detail', 'POST', { occurrence, changeLookbackMinutes }, signal)
}

export function getRawRadiusHistoricalSummary(occurrence: RawExplorerOccurrence, signal?: AbortSignal) {
  return sendJson<BasicHistoricalSummary>('/api/radius/raw-explorer/history', 'POST', { occurrence, lookbackDays: 31, maximumOccurrences: 100 }, signal)
}

export function getRawRadiusEventLearningReport(occurrence: RawExplorerOccurrence, signal?: AbortSignal) {
  return sendJson<EventLearningReport>('/api/radius/raw-explorer/report', 'POST', { occurrence }, signal)
}

export function plotRawRadiusSignal(occurrence: RawExplorerOccurrence, plottedSignal: RawExplorerSignalIdentity, signal?: AbortSignal) {
  return sendJson<RawExplorerPlotResult>('/api/radius/raw-explorer/plot', 'POST', { occurrence, signal: plottedSignal }, signal)
}

export function plotRawUnmappedSignal(occurrence: RawExplorerOccurrence, rawIdentity: string, signal?: AbortSignal) {
  return sendJson<RawUnmappedPlotResult>('/api/radius/raw-explorer/raw-plot', 'POST', { occurrence, rawIdentity }, signal)
}

export function setRawTelemetryReview(pressKey: RadiusPressKey, rawIdentity: string, reviewStatus: RawTelemetryReviewStatus, signal?: AbortSignal) {
  return sendJson<RawTelemetryReview>('/api/radius/raw-explorer/raw-review', 'PATCH', { pressKey, rawIdentity, reviewStatus }, signal)
}

export function getTelemetryEventCatalog(signal?: AbortSignal) {
  return getJson<TelemetryEventCatalog>('/api/telemetry/event-explorer/catalog', signal)
}

export function searchTelemetryEventRawCatalog(pressKey: RadiusPressKey, query: string, offset = 0, limit = 50, signal?: AbortSignal) {
  const parameters = new URLSearchParams({ pressKey, q: query, offset: String(offset), limit: String(limit) })
  return getJson<TelemetryEventRawCatalogResult>(`/api/telemetry/event-explorer/raw-catalog?${parameters}`, signal)
}

export function previewTelemetryEventVariable(input: { source: TelemetryEventSource; pressKey: RadiusPressKey; deckNumber: number | null; fromUtc: string; toUtc: string }, signal?: AbortSignal) {
  return sendJson<TelemetryEventPreview>('/api/telemetry/event-explorer/preview', 'POST', input, signal)
}

export function searchTelemetryEvents(input: TelemetryEventSearchInput, signal?: AbortSignal) {
  return sendJson<TelemetryEventSearchResult>('/api/telemetry/event-explorer/search', 'POST', input, signal)
}

export function getTelemetryEventDetail(occurrence: TelemetryEventOccurrence, signal?: AbortSignal) {
  return sendJson<TelemetryEventDetail>('/api/telemetry/event-explorer/detail', 'POST', { occurrence }, signal)
}

export function getTelemetryEventHistoricalSummary(occurrence: TelemetryEventOccurrence, occurrences: TelemetryEventOccurrence[], signal?: AbortSignal) {
  return sendJson<BasicHistoricalSummary>('/api/telemetry/event-explorer/history', 'POST', { occurrence, occurrences: occurrences.slice(0, 500) }, signal)
}

export function boundedTelemetryEventReportOccurrences(selected: TelemetryEventOccurrence, occurrences: TelemetryEventOccurrence[]) {
  const floor = Date.parse(selected.startUtc) - 24 * 60 * 60_000
  const sameDefinition = (item: TelemetryEventOccurrence) => item.pressKey === selected.pressKey && item.sourceKind === selected.sourceKind && item.rawIdentity === selected.rawIdentity && item.deckNumber === selected.deckNumber && item.eventType === selected.eventType && (selected.eventType !== 'value_change' || item.previousValue === selected.previousValue && item.newValue === selected.newValue)
  const comparable = occurrences.filter((item) => item.occurrenceId !== selected.occurrenceId && sameDefinition(item) && Date.parse(item.startUtc) >= floor && Date.parse(item.startUtc) <= Date.parse(selected.startUtc)).sort((left, right) => Date.parse(left.startUtc) - Date.parse(right.startUtc)).slice(-29)
  return [...comparable, selected]
}

export function getTelemetryEventLearningReport(occurrence: TelemetryEventOccurrence, occurrences: TelemetryEventOccurrence[], rule: TelemetryEventRule, signal?: AbortSignal) {
  const detector: Record<string, string | number | boolean | null> = rule.kind === 'threshold' ? { operator: rule.operator, threshold: rule.threshold } : rule.kind === 'delta' ? { configuredDirection: rule.direction, configuredDelta: rule.amount, deltaWindowMinutes: rule.windowMinutes } : { match: rule.match }
  return sendJson<EventLearningReport>('/api/telemetry/event-explorer/report', 'POST', { occurrence, rule, occurrences: boundedTelemetryEventReportOccurrences(occurrence, occurrences) }, signal).then((report) => ({ ...report, target: { ...report.target, ...detector } }))
}

export function plotTelemetryEventSignal(occurrence: TelemetryEventOccurrence, plottedSignal: RawExplorerSignalIdentity, signal?: AbortSignal) {
  return sendJson<RawExplorerPlotResult>('/api/telemetry/event-explorer/plot', 'POST', { occurrence, signal: plottedSignal }, signal)
}

export function plotTelemetryEventRawSignal(occurrence: TelemetryEventOccurrence, rawIdentity: string, signal?: AbortSignal) {
  return sendJson<RawUnmappedPlotResult>('/api/telemetry/event-explorer/raw-plot', 'POST', { occurrence, rawIdentity }, signal)
}

export function getActivityAnalysis(fromUtc: string, toUtc: string, selection?: ActivitySelection, pressKey?: RadiusPressKey, signal?: AbortSignal, evidenceOffset = 0) {
  const parameters = new URLSearchParams({ fromUtc, toUtc })
  if (selection) {
    parameters.set('level', selection.level)
    parameters.set('key', selection.key)
    if (selection.operationalGroupKey) parameters.set('operationalGroupKey', selection.operationalGroupKey)
  }
  if (pressKey) parameters.set('pressKey', pressKey)
  parameters.set('evidenceOffset', String(evidenceOffset))
  return getJson<ActivityAnalysis>(`/api/radius/activity-analysis?${parameters.toString()}`, signal)
}

export function getPatternAnalysis(fromUtc: string, toUtc: string, input: { selectedPatternKey?: string; conditions?: ActivitySelection[]; matchMode?: PatternMatchMode; pressKey?: RadiusPressKey } = {}, signal?: AbortSignal) {
  const parameters = new URLSearchParams({ fromUtc, toUtc })
  if (input.selectedPatternKey) parameters.set('patternKey', input.selectedPatternKey)
  if (input.conditions?.length) parameters.set('conditions', JSON.stringify(input.conditions.map(({ level, key, operationalGroupKey }) => ({ level, key, ...(operationalGroupKey ? { operationalGroupKey } : {}) }))))
  if (input.matchMode) parameters.set('matchMode', input.matchMode)
  if (input.pressKey) parameters.set('pressKey', input.pressKey)
  return getJson<PatternAnalysis>(`/api/radius/pattern-analysis?${parameters.toString()}`, signal)
}

export function getRadiusPressEpisodes(
  pressKey: RadiusPressKey,
  fromUtc: string,
  toUtc: string,
  signal?: AbortSignal,
) {
  return getJson<RadiusPressEpisodes>(
    `/api/radius/presses/${pressKey}/episodes?${rangeQuery(fromUtc, toUtc)}`,
    signal,
  )
}

export function getRadiusEpisode(
  pressKey: RadiusPressKey,
  episodeId: string,
  signal?: AbortSignal,
) {
  return getJson<OperationalEpisode>(
    `/api/radius/presses/${pressKey}/episodes/${encodeURIComponent(episodeId)}`,
    signal,
  )
}

export function getClassificationWorkspace(signal?: AbortSignal) { return getJson<ClassificationWorkspace>('/api/classification/workspace', signal) }
export function getClassificationGroups(signal?: AbortSignal) { return getJson<OperationalGroup[]>('/api/classification/groups', signal) }
export function getClassificationFamilies(signal?: AbortSignal) { return getJson<ProcessFamily[]>('/api/classification/process-families', signal) }
export function getClassificationIdentities(signal?: AbortSignal) { return getJson<ClassificationWorkspace['observedIdentities']>('/api/classification/identities', signal) }
export function searchClassifications(query: string, limit = 10, signal?: AbortSignal) {
  const parameters = new URLSearchParams({ q: query, limit: String(limit) })
  return getJson<ClassificationSearchResponse>(`/api/classification/search?${parameters.toString()}`, signal)
}
export function createClassificationDraft(expectedVersion: number) { return sendJson<ClassificationDraft>('/api/classification/draft', 'POST', { expectedVersion }) }
export function updateClassificationGroup(groupKey: OperationalGroupKey, expectedRevision: number | null, changes: object) { return sendJson<ClassificationDraft>(`/api/classification/draft/groups/${groupKey}`, 'PATCH', { ...changes, expectedRevision }) }
export function updateClassifications(expectedRevision: number | null, identities: Array<{ eventType: string; statusCode: string | null; statusDescription: string }>, changes: { operationalGroupKey?: OperationalGroupKey; processFamilyKey?: ProcessFamilyKey; displayLabel?: string | null; explanation?: string; confidence?: MappingConfidence; needsReview?: boolean; defaultTimelineVisibility?: boolean; obsolete?: boolean }) { return sendJson<ClassificationDraft>('/api/classification/draft/classifications', 'PATCH', { identities, expectedRevision, ...changes }) }
export function validateClassificationDraft() { return sendJson<ClassificationValidation>('/api/classification/draft/validate', 'POST', {}) }
export function publishClassificationDraft(expectedRevision: number) { return sendJson<unknown>('/api/classification/draft/publish', 'POST', { expectedRevision }) }
export function discardClassificationDraft(expectedRevision: number) { return sendJson<void>('/api/classification/draft', 'DELETE', { expectedRevision }) }
