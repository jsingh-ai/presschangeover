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
  ActivityAnalysis,
  ActivitySelection,
  PatternAnalysis,
  PatternMatchMode,
} from '../types/api'
import type {
  CuratedPhysicalEvidence,
  PhysicalEvidenceCategory,
  PressMotionEvidence,
  PressSpeedEvidence,
  PressTelemetryCapabilities,
  PressTelemetrySource,
  ProductionContextEvidence,
  TelemetryRepresentation,
} from '../types/evidence'

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

export function getRadiusOverview(fromUtc: string, toUtc: string, decisionOnly = false, signal?: AbortSignal) {
  return getJson<RadiusOverview>(
    `/api/radius/overview?${rangeQuery(fromUtc, toUtc)}${decisionOnly ? '&view=decision' : ''}`,
    signal,
  )
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
