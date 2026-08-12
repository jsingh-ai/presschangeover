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

export class ApiRequestError extends Error {
  constructor(public readonly status: number) {
    super('The requested service is unavailable.')
    this.name = 'ApiRequestError'
  }
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, {
    headers: { Accept: 'application/json' },
  })

  if (!response.ok) {
    throw new ApiRequestError(response.status)
  }

  return (await response.json()) as T
}

async function sendJson<T>(path: string, method: 'POST' | 'PATCH' | 'DELETE', body?: unknown): Promise<T> {
  const response = await fetch(path, { method, headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  if (!response.ok) throw new ApiRequestError(response.status)
  return response.status === 204 ? undefined as T : await response.json() as T
}

export function getProcessIntelligenceHealth() {
  return getJson<ProcessIntelligenceHealth>('/api/health')
}

export function getTelemetryHealth() {
  return getJson<TelemetryHealth>('/api/telemetry/health')
}

export function getTelemetrySources() {
  return getJson<TelemetrySource[]>('/api/telemetry/sources')
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

export function getRadiusHealth() {
  return getJson<RadiusHealth>('/api/radius/health')
}

export function getRadiusOverview(fromUtc: string, toUtc: string, decisionOnly = false) {
  return getJson<RadiusOverview>(
    `/api/radius/overview?${rangeQuery(fromUtc, toUtc)}${decisionOnly ? '&view=decision' : ''}`,
  )
}

export function getActivityAnalysis(fromUtc: string, toUtc: string, selection?: ActivitySelection, pressKey?: RadiusPressKey) {
  const parameters = new URLSearchParams({ fromUtc, toUtc })
  if (selection) { parameters.set('level', selection.level); parameters.set('key', selection.key) }
  if (pressKey) parameters.set('pressKey', pressKey)
  return getJson<ActivityAnalysis>(`/api/radius/activity-analysis?${parameters.toString()}`)
}

export function getPatternAnalysis(fromUtc: string, toUtc: string, input: { selectedPatternKey?: string; conditions?: ActivitySelection[]; matchMode?: PatternMatchMode; pressKey?: RadiusPressKey } = {}) {
  const parameters = new URLSearchParams({ fromUtc, toUtc })
  if (input.selectedPatternKey) parameters.set('patternKey', input.selectedPatternKey)
  if (input.conditions?.length) parameters.set('conditions', JSON.stringify(input.conditions.map(({ level, key }) => ({ level, key }))))
  if (input.matchMode) parameters.set('matchMode', input.matchMode)
  if (input.pressKey) parameters.set('pressKey', input.pressKey)
  return getJson<PatternAnalysis>(`/api/radius/pattern-analysis?${parameters.toString()}`)
}

export function getRadiusPressEpisodes(
  pressKey: RadiusPressKey,
  fromUtc: string,
  toUtc: string,
) {
  return getJson<RadiusPressEpisodes>(
    `/api/radius/presses/${pressKey}/episodes?${rangeQuery(fromUtc, toUtc)}`,
  )
}

export function getRadiusEpisode(
  pressKey: RadiusPressKey,
  episodeId: string,
) {
  return getJson<OperationalEpisode>(
    `/api/radius/presses/${pressKey}/episodes/${encodeURIComponent(episodeId)}`,
  )
}

export function getClassificationWorkspace() { return getJson<ClassificationWorkspace>('/api/classification/workspace') }
export function searchClassifications(query: string, limit = 10) {
  const parameters = new URLSearchParams({ q: query, limit: String(limit) })
  return getJson<ClassificationSearchResponse>(`/api/classification/search?${parameters.toString()}`)
}
export function createClassificationDraft(expectedVersion: number) { return sendJson<ClassificationDraft>('/api/classification/draft', 'POST', { expectedVersion }) }
export function updateClassificationGroup(groupKey: OperationalGroupKey, expectedRevision: number | null, changes: object) { return sendJson<ClassificationDraft>(`/api/classification/draft/groups/${groupKey}`, 'PATCH', { ...changes, expectedRevision }) }
export function updateClassifications(expectedRevision: number | null, identities: Array<{ eventType: string; statusCode: string | null; statusDescription: string }>, changes: { operationalGroupKey?: OperationalGroupKey; processFamilyKey?: ProcessFamilyKey; displayLabel?: string | null; explanation?: string; confidence?: MappingConfidence; needsReview?: boolean; defaultTimelineVisibility?: boolean; obsolete?: boolean }) { return sendJson<ClassificationDraft>('/api/classification/draft/classifications', 'PATCH', { identities, expectedRevision, ...changes }) }
export function validateClassificationDraft() { return sendJson<ClassificationValidation>('/api/classification/draft/validate', 'POST', {}) }
export function publishClassificationDraft(expectedRevision: number) { return sendJson<unknown>('/api/classification/draft/publish', 'POST', { expectedRevision }) }
export function discardClassificationDraft(expectedRevision: number) { return sendJson<void>('/api/classification/draft', 'DELETE', { expectedRevision }) }
