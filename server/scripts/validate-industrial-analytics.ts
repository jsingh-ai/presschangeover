import type { RadiusPressEpisodes, RadiusPressKey } from '../src/radius/models.js'
import type { PressSpeedEvidence, ProductionContextEvidence, TelemetrySample } from '../src/telemetry/telemetry-contracts.js'
import { IndustrialAnalyticsService } from '../src/industrial-analytics/industrial-analytics-service.js'
import type { IndustrialAnalyticalObservation, IndustrialNumericSample, IndustrialStateSample } from '../src/industrial-analytics/contracts.js'

const analytics = new IndustrialAnalyticsService()
const presses: RadiusPressKey[] = ['press14', 'press10', 'press13', 'press6']
const argument = (name: string) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined }
const baseUrl = (argument('--base-url') ?? 'http://127.0.0.1:3100').replace(/\/$/, '')
const end = argument('--end') ?? new Date().toISOString()
const start = argument('--start') ?? new Date(Date.parse(end) - 24 * 60 * 60_000).toISOString()
if (!Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end)) || Date.parse(end) <= Date.parse(start) || Date.parse(end) - Date.parse(start) > 24 * 60 * 60_000) throw new Error('Validation range must be a valid UTC interval of at most 24 hours.')

let queryCount = 0
async function readJson<T>(path: string, init?: RequestInit): Promise<T> {
  queryCount += 1
  const response = await fetch(`${baseUrl}${path}`, init)
  if (!response.ok) throw new Error(`read_failed:${response.status}:${path.split('?')[0]}`)
  return await response.json() as T
}
function numeric(samples: TelemetrySample[]): IndustrialNumericSample[] { return samples.flatMap((sample) => typeof sample.value === 'number' && Number.isFinite(sample.value) ? [{ atUtc: sample.observedAtUtc, value: sample.value, qualityState: sample.qualityState }] : []) }
function query(path: string, fromUtc: string, toUtc: string) { return `${path}?fromUtc=${encodeURIComponent(fromUtc)}&toUtc=${encodeURIComponent(toUtc)}` }
function publicMetrics(observation: IndustrialAnalyticalObservation) {
  if (observation.family !== 'value_state_transition') return observation.metrics
  const { stateBefore: _stateBefore, stateAfter: _stateAfter, ...safe } = observation.metrics
  return safe
}

const began = Date.now()
const perPress = await Promise.all(presses.map(async (pressKey) => {
  const episodes = await readJson<RadiusPressEpisodes>(query(`/api/radius/presses/${pressKey}/episodes`, start, end))
  const observations: IndustrialAnalyticalObservation[] = []
  const failures: string[] = []
  const focus = episodes.episodes.slice().sort((left, right) => right.durationSeconds - left.durationSeconds)[0]
  if (focus) {
    const eventEndMs = Math.min(Date.parse(focus.endUtc ?? end), Date.parse(focus.startUtc) + 20 * 60_000)
    const event = { id: focus.episodeId, start: focus.startUtc, end: new Date(eventEndMs).toISOString() }
    const window = { start: new Date(Math.max(Date.parse(start), Date.parse(event.start) - 20 * 60_000)).toISOString(), end: new Date(Math.min(Date.parse(end), eventEndMs + 20 * 60_000)).toISOString() }
    const [speedResult, contextResult] = await Promise.allSettled([
      readJson<PressSpeedEvidence>(query(`/api/telemetry/presses/${pressKey}/speed`, window.start, window.end)),
      readJson<ProductionContextEvidence>(`/api/telemetry/presses/${pressKey}/context`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fromUtc: window.start, toUtc: window.end }) }),
    ])
    if (speedResult.status === 'fulfilled') {
      const speed = speedResult.value; const actual = numeric(speed.actual.samples)
      const robust = analytics.robustNumericChange({ pressKey, variableId: speed.actual.canonicalId, unit: speed.actual.sourceUnit, range: window, samples: actual, eventId: focus.episodeId })
      const aligned = analytics.eventAlignedNumeric({ pressKey, variableId: speed.actual.canonicalId, unit: speed.actual.sourceUnit, range: window, samples: actual, event })
      if (robust) observations.push(robust)
      if (aligned) observations.push(aligned)
      if (speed.setpoint) { const relationship = analytics.relationshipObservation({ pressKey, leftVariableId: speed.setpoint.canonicalId, rightVariableId: speed.actual.canonicalId, range: window, left: numeric(speed.setpoint.samples), right: actual, context: `Radius episode ${focus.episodeId}` }); if (relationship) observations.push(relationship) }
    } else failures.push('speed unavailable')
    if (contextResult.status === 'fulfilled') {
      for (const field of ['job', 'order', 'recipe'] as const) {
        const changes = contextResult.value.changes.filter((change) => change.field === field)
        if (!changes.length) continue
        const samples: IndustrialStateSample[] = []
        const first = changes[0]!; if (first.previousValue !== null) samples.push({ atUtc: window.start, value: first.previousValue })
        samples.push(...changes.flatMap((change) => change.value === null ? [] : [{ atUtc: change.atUtc, value: change.value }]))
        observations.push(analytics.valueTransitions({ pressKey, variableId: `production.${field}`, range: window, samples, event }))
      }
    } else failures.push('production context unavailable')
    observations.push(analytics.sequenceDeviation({ pressKey, range: { start, end }, occurrence: { episodeId: focus.episodeId, startUtc: focus.startUtc, endUtc: focus.endUtc ?? end, orderedStates: focus.statusSegments.map((segment) => ({ state: segment.statusDescription, durationSeconds: segment.durationSeconds })), returnAttempts: focus.returnToProductionAttemptCount }, comparable: episodes.episodes.map((episode) => ({ episodeId: episode.episodeId, startUtc: episode.startUtc, endUtc: episode.endUtc ?? end, orderedStates: episode.statusSegments.map((segment) => ({ state: segment.statusDescription, durationSeconds: segment.durationSeconds })), returnAttempts: episode.returnToProductionAttemptCount })) }))
  }
  const productionPercent = episodes.summary.observedSeconds > 0 ? Math.round(episodes.summary.runProductionSeconds / episodes.summary.observedSeconds * 1_000) / 10 : null
  return { pressKey, episodes, productionPercent, observations, failures }
}))

const crossPress = analytics.crossPressSummaryComparison({ canonicalId: 'radius.productionPercent', unit: 'percent', range: { start, end }, values: perPress.map((item) => ({ pressKey: item.pressKey, value: item.productionPercent, supportCount: 1, coveragePercent: item.episodes.summary.dataCoveragePercent, factId: `${item.pressKey}.production_percent.current` })) })
for (const observation of crossPress) perPress.find(({ pressKey }) => pressKey === observation.pressKey)!.observations.push(observation)

const report = {
  generatedReadOnly: true,
  range: { start, end },
  presses,
  queryCount,
  runtimeMs: Date.now() - began,
  results: perPress.map((item) => {
    const retained = item.observations.filter((observation) => observation.support.adequate && observation.material)
    return {
      pressKey: item.pressKey,
      coveragePercent: Math.round(item.episodes.summary.dataCoveragePercent * 10) / 10,
      episodeCount: item.episodes.summary.episodeCount,
      calculatedCount: item.observations.length,
      retainedCount: retained.length,
      excludedCount: item.observations.length - retained.length,
      retained: retained.map((observation) => ({ observationId: observation.observationId, family: observation.family, eventId: observation.eventId, variableIds: observation.variableIds, metrics: publicMetrics(observation), support: observation.support, magnitudeInputs: observation.magnitudeInputs, limitations: observation.limitations })),
      excludedFamilies: item.observations.filter((observation) => !observation.support.adequate || !observation.material).map(({ family }) => family),
      failures: item.failures,
    }
  }),
}
console.log(JSON.stringify(report, null, 2))
