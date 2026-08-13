import { EngineeringClueAnalysisService } from '../server/src/telemetry/engineering-clue-analysis.js'
import type { ActivityAnalysis, ActivityOccurrence, ActivitySelection } from '../client/src/types/api.js'
import type { RadiusPressKey } from '../server/src/radius/models.js'
import type { PressEvidenceCapabilities, PressMotionEvidence, PressSemanticHistoryEvidence, TelemetrySemanticHistoryRequest } from '../server/src/telemetry/telemetry-contracts.js'
import type { TelemetryFoundationService } from '../server/src/telemetry/telemetry-foundation-service.js'

const baseUrl = process.env.PROCESS_INTELLIGENCE_URL ?? 'http://10.8.10.97:8088'
const toUtc = new Date(Date.now() - 20 * 60_000).toISOString()
const fromUtc = new Date(Date.parse(toUtc) - 30 * 24 * 60 * 60_000).toISOString()
const validatedFallbacks: Partial<Record<RadiusPressKey, { startUtc: string; endUtc: string; statusCode: string; statusDescription: string }>> = {
  press5: { startUtc: '2026-08-11T19:35:53.851Z', endUtc: '2026-08-11T19:40:04.928Z', statusCode: '41-2', statusDescription: 'Maintenance - Electrical' },
  press12: { startUtc: '2026-08-12T20:14:28.526Z', endUtc: '2026-08-12T20:22:40.916Z', statusCode: '29', statusDescription: 'Electrical: Press Other' },
  press14: { startUtc: '2026-08-03T11:37:38.694Z', endUtc: '2026-08-03T11:58:43.349Z', statusCode: '41-2', statusDescription: 'Maintenance - Electrical' },
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, init)
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${path}`)
  return response.json() as Promise<T>
}

function activityPath(pressKey: RadiusPressKey, selection?: ActivitySelection): string {
  const query = new URLSearchParams({ fromUtc, toUtc, pressKey, evidenceLimit: '100' })
  if (selection) {
    query.set('level', selection.level)
    query.set('key', selection.key)
    if (selection.operationalGroupKey) query.set('operationalGroupKey', selection.operationalGroupKey)
  }
  return `/api/radius/activity-analysis?${query}`
}

async function representativeOccurrence(pressKey: RadiusPressKey): Promise<{ occurrence: ActivityOccurrence; selection: ActivitySelection }> {
  const fallback = () => {
    const known = validatedFallbacks[pressKey]
    if (!known) return undefined
    const durationSeconds = (Date.parse(known.endUtc) - Date.parse(known.startUtc)) / 1_000
    return { occurrence: { occurrenceId: `${pressKey}:${known.startUtc}:validated`, pressKey, displayName: `Press ${pressKey.slice(5)}`, startUtc: known.startUtc, endUtc: known.endUtc, durationSeconds, eventType: 'B', radiusStateLabel: 'Bad', operationalGroupKey: 'MAINTENANCE_INTERVENTION', operationalGroupName: 'Maintenance Intervention', processFamilyKey: 'MAINTENANCE', processFamilyName: 'Maintenance', segments: [], exactIdentities: [{ identity: `B\u001f${known.statusCode}\u001f${known.statusDescription}`, eventType: 'B', statusCode: known.statusCode, statusDescription: known.statusDescription, durationSeconds, needsClassification: false }] }, selection: { level: 'operational_group', key: 'MAINTENANCE_INTERVENTION', label: 'Maintenance Intervention' } as ActivitySelection }
  }
  let initial: ActivityAnalysis
  try { initial = await json<ActivityAnalysis>(activityPath(pressKey)) } catch { const known = fallback(); if (known) return known; throw new Error(`Activity lookup unavailable for ${pressKey}`) }
  const options = [initial.selection, ...initial.catalog.filter(({ occurrenceCount }) => occurrenceCount > 0).sort((left, right) => right.durationSeconds - left.durationSeconds)]
  const seen = new Set<string>()
  for (const option of options) {
    const key = `${option.level}:${option.key}:${option.operationalGroupKey ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    let analysis: ActivityAnalysis
    try {
      analysis = key === `${initial.selection.level}:${initial.selection.key}:${initial.selection.operationalGroupKey ?? ''}` ? initial : await json<ActivityAnalysis>(activityPath(pressKey, option))
    } catch {
      continue
    }
    const candidates = analysis.occurrences.filter(({ startUtc, endUtc }) => Date.parse(startUtc) >= Date.parse(fromUtc) && Date.parse(endUtc) <= Date.parse(toUtc) - 60_000)
    const occurrence = [...candidates].sort((left, right) => {
      const leftPreferred = left.durationSeconds >= 120 && left.durationSeconds <= 60 * 60 ? 1 : 0
      const rightPreferred = right.durationSeconds >= 120 && right.durationSeconds <= 60 * 60 ? 1 : 0
      return rightPreferred - leftPreferred || Date.parse(right.startUtc) - Date.parse(left.startUtc)
    })[0]
    if (occurrence) return { occurrence, selection: analysis.selection }
  }
  const known = fallback()
  if (known) return known
  throw new Error(`No completed representative occurrence found for ${pressKey}`)
}

const liveTelemetry = {
  capabilities: {
    get: (pressKey: RadiusPressKey, _requestId?: string, signal?: AbortSignal) => json<PressEvidenceCapabilities>(`/api/telemetry/presses/${pressKey}/capabilities`, { signal }),
  },
  semanticHistory: (pressKey: RadiusPressKey, query: TelemetrySemanticHistoryRequest, _requestId?: string, signal?: AbortSignal) => json<PressSemanticHistoryEvidence>(`/api/telemetry/presses/${pressKey}/semantic-history`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(query), signal }),
  motion: (pressKey: RadiusPressKey, rangeFromUtc: string, rangeToUtc: string, _requestId?: string, signal?: AbortSignal) => json<PressMotionEvidence>(`/api/telemetry/presses/${pressKey}/motion?${new URLSearchParams({ fromUtc: rangeFromUtc, toUtc: rangeToUtc })}`, { signal }),
} as unknown as TelemetryFoundationService

async function main() {
  const service = new EngineeringClueAnalysisService(liveTelemetry)
  const results = []
  for (const pressKey of ['press5', 'press12', 'press14'] as const) {
    try {
      const { occurrence, selection } = await representativeOccurrence(pressKey)
      const clue = await service.analyze({
    occurrenceId: occurrence.occurrenceId,
    pressKey,
    displayName: occurrence.displayName,
    startUtc: occurrence.startUtc,
    endUtc: occurrence.endUtc,
    durationSeconds: occurrence.durationSeconds,
    exactIdentities: occurrence.exactIdentities.map(({ eventType, statusCode, statusDescription }) => ({ eventType, statusCode, statusDescription })),
  }, `live-validation-${pressKey}`)
      results.push({
    pressKey,
    selection: { level: selection.level, key: selection.key, label: selection.label },
    occurrence: { id: occurrence.occurrenceId, startUtc: occurrence.startUtc, endUtc: occurrence.endUtc, durationSeconds: occurrence.durationSeconds, exactIdentities: occurrence.exactIdentities.map(({ eventType, statusCode, statusDescription }) => ({ eventType, statusCode, statusDescription })) },
    evidenceWindow: clue.evidenceWindow,
    coverage: clue.coverage,
    whereToLook: clue.whereToLook,
    firstChanges: clue.firstChanges.slice(0, 10),
    topClues: clue.signalClues.filter(({ isClue }) => isClue).slice(0, 10).map(({ canonicalId, deckNumber, friendlyName, description, firstRelevantOffsetMs }) => ({ canonicalId, deckNumber, friendlyName, description, firstRelevantOffsetMs })),
    performance: clue.performance,
      })
    } catch (error) {
      const availability = await json<ActivityAnalysis>(activityPath(pressKey))
      results.push({ pressKey, unavailable: error instanceof Error ? error.message : String(error), selection: availability.selection, catalogWithOccurrences: availability.catalog.filter(({ occurrenceCount }) => occurrenceCount > 0).map(({ level, key, label, occurrenceCount }) => ({ level, key, label, occurrenceCount })) })
    }
  }

  const output = process.env.CLUE_VALIDATION_COMPACT === '1'
    ? { baseUrl, validationRange: { fromUtc, toUtc }, results: results.map((result) => 'unavailable' in result ? result : ({ pressKey: result.pressKey, occurrence: result.occurrence, coverage: result.coverage, whereToLook: result.whereToLook, performance: result.performance })) }
    : { baseUrl, validationRange: { fromUtc, toUtc }, results }
  console.log(JSON.stringify(output, null, 2))
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
