import type { RadiusPressKey } from '../radius/models.js'
import { ENGINEERING_CLUE_CATALOG, type EngineeringClueCatalogItem } from '../telemetry/engineering-clue-analysis.js'
import type { CapabilityAssessment, TelemetrySample, TelemetrySemanticSelector } from '../telemetry/telemetry-contracts.js'
import { isGoodTelemetryQuality } from '../telemetry/historical-telemetry-policy.js'
import type { IndustrialAnalyticalObservation, IndustrialNumericSample } from './contracts.js'

export const AI_EVENT_TELEMETRY_SERIES_LIMIT = 12
const CATEGORY_PRIORITY = ['temperature', 'drive_temperature', 'doctor_blade', 'torque', 'web_tension', 'dryer', 'wash', 'pump', 'viscosity', 'ink', 'motion', 'register', 'impression', 'repeat_other', 'speed'] as const

export interface SelectedEventTelemetrySeries {
  canonicalId: string
  deckNumber?: number
  friendlyName: string
  signalType: EngineeringClueCatalogItem['signalType']
  category: EngineeringClueCatalogItem['category']
  representation: 'samples' | 'changes'
}

function key(item: { canonicalId: string; deckNumber?: number | null }) { return `${item.canonicalId}:${item.deckNumber ?? ''}` }

export function selectBoundedEventTelemetry(capabilities: CapabilityAssessment[], maximum = AI_EVENT_TELEMETRY_SERIES_LIMIT): SelectedEventTelemetrySeries[] {
  const byCanonical = new Map(capabilities.map((item) => [item.canonicalId, item]))
  const supported = ENGINEERING_CLUE_CATALOG.flatMap((definition) => {
    if (definition.canonicalId === 'machine.speed.actual' || definition.canonicalId === 'machine.speed.setpoint') return []
    const capability = byCanonical.get(definition.canonicalId)
    if (capability?.state !== 'SUPPORTED' || !capability.historyQueryable || capability.evidenceKind !== 'semantic_history') return []
    const values: Array<{ deckNumber?: number }> = definition.scope === 'machine' ? [{}] : capability.deckNumbers.slice().sort((left, right) => left - right).map((deckNumber) => ({ deckNumber }))
    return values.map(({ deckNumber }) => ({ canonicalId: definition.canonicalId, ...(deckNumber === undefined ? {} : { deckNumber }), friendlyName: definition.friendlyName, signalType: definition.signalType, category: definition.category, representation: definition.signalType === 'continuous' ? 'samples' as const : 'changes' as const }))
  })
  const queues = new Map(CATEGORY_PRIORITY.map((category) => [category, supported.filter((item) => item.category === category).sort((left, right) => left.canonicalId.localeCompare(right.canonicalId) || (left.deckNumber ?? 0) - (right.deckNumber ?? 0))]))
  const selected: SelectedEventTelemetrySeries[] = []
  while (selected.length < Math.max(0, maximum) && [...queues.values()].some((queue) => queue.length)) {
    for (const category of CATEGORY_PRIORITY) {
      const item = queues.get(category)?.shift()
      if (item && !selected.some((candidate) => key(candidate) === key(item))) selected.push(item)
      if (selected.length >= maximum) break
    }
  }
  return selected
}

export function eventTelemetrySelectors(values: SelectedEventTelemetrySeries[]): TelemetrySemanticSelector[] {
  return values.map(({ canonicalId, deckNumber, representation }) => ({ canonicalId, ...(deckNumber === undefined ? {} : { deckNumber }), representation }))
}

function numeric(samples: TelemetrySample[]): IndustrialNumericSample[] {
  return samples.flatMap((sample) => typeof sample.value === 'number' && Number.isFinite(sample.value) && isGoodTelemetryQuality(sample.qualityState) ? [{ atUtc: sample.observedAtUtc, value: sample.value, qualityState: sample.qualityState }] : [])
}

function round(value: number, digits = 1): number { const factor = 10 ** digits; return Math.round(value * factor) / factor }

export function speedRecoveryObservation(input: { pressKey: RadiusPressKey; event: { id: string; start: string; end: string }; range: { start: string; end: string }; samples: TelemetrySample[]; unit: string | null }): IndustrialAnalyticalObservation | null {
  const samples = numeric(input.samples).filter((sample) => Date.parse(sample.atUtc) >= Date.parse(input.range.start) && Date.parse(sample.atUtc) <= Date.parse(input.range.end)).sort((left, right) => Date.parse(left.atUtc) - Date.parse(right.atUtc))
  if (samples.length < 5) return null
  const eventStart = Date.parse(input.event.start); const eventEnd = Date.parse(input.event.end)
  const before = samples.filter((sample) => Date.parse(sample.atUtc) < eventStart); const during = samples.filter((sample) => Date.parse(sample.atUtc) >= eventStart && Date.parse(sample.atUtc) <= eventEnd); const after = samples.filter((sample) => Date.parse(sample.atUtc) > eventEnd)
  if (!before.length || !during.length || !after.length) return null
  const beforeSpeed = before.at(-1)!.value; const minimumSample = samples.reduce((best, item) => item.value < best.value ? item : best, samples[0]!); const threshold = Math.max(1, beforeSpeed * .8)
  const restart = after.find((sample) => sample.value > Math.max(1, minimumSample.value + Math.max(5, beforeSpeed * .1)))
  const sustained = after.find((sample, index) => sample.value >= threshold && after.slice(index, index + 3).length === 3 && after.slice(index, index + 3).every((item) => item.value >= threshold))
  let accelerationAttempts = 0; let failedAccelerations = 0; let rising = false; let peak = minimumSample.value
  for (const [index, sample] of after.entries()) {
    const prior = index === 0 ? during.at(-1)! : after[index - 1]!
    if (sample.value > prior.value + 1 && !rising) { accelerationAttempts += 1; rising = true; peak = sample.value }
    else if (rising) {
      peak = Math.max(peak, sample.value)
      if (sample.value < prior.value - 1) { if (peak < threshold) failedAccelerations += 1; rising = false }
    }
  }
  const timeToZero = minimumSample.value <= Math.max(1, beforeSpeed * .02) ? (Date.parse(minimumSample.atUtc) - eventStart) / 60_000 : null
  const afterMean = after.reduce((sum, item) => sum + item.value, 0) / after.length; const afterVariability = Math.sqrt(after.reduce((sum, item) => sum + (item.value - afterMean) ** 2, 0) / after.length); const recoveryMinutes = Math.max(1 / 60, (Date.parse(after.at(-1)!.atUtc) - Date.parse(after[0]!.atUtc)) / 60_000); const recoverySlope = (after.at(-1)!.value - after[0]!.value) / recoveryMinutes
  const coveragePercent = round(Math.min(100, Math.max(0, (Date.parse(samples.at(-1)!.atUtc) - Date.parse(samples[0]!.atUtc)) / (Date.parse(input.range.end) - Date.parse(input.range.start)) * 100)))
  return { observationId: `speed-recovery.${input.event.id.replace(/[^A-Za-z0-9_.-]/g, '_')}`, family: 'speed_recovery', pressKey: input.pressKey, deckNumber: null, range: input.range, comparisonRange: null, eventId: input.event.id, variableIds: ['machine.speed.actual'], factIds: [], metrics: { unit: input.unit, speedBefore: round(beforeSpeed), minimumSpeed: round(minimumSample.value), minimumSpeedAtUtc: minimumSample.atUtc, speedAtReturn: restart ? round(restart.value) : null, restartAtUtc: restart?.atUtc ?? null, timeToZeroMinutes: timeToZero === null ? null : round(timeToZero), timeToRestartMinutes: restart ? round((Date.parse(restart.atUtc) - eventEnd) / 60_000) : null, accelerationAttempts, failedAccelerations, maximumRecoveredSpeed: round(Math.max(...after.map((item) => item.value))), sustainedAtUtc: sustained?.atUtc ?? null, timeToSustainedSpeedMinutes: sustained ? round((Date.parse(sustained.atUtc) - eventEnd) / 60_000) : null, recoverySlopePerMinute: round(recoverySlope), recoveryVariability: round(afterVariability) }, support: { sampleCount: samples.length, comparisonSampleCount: before.length, coveragePercent, comparisonCoveragePercent: null, adequate: true, minimumRequired: 5, reason: null }, evidenceSource: 'telemetry', magnitudeInputs: { accelerationAttempts, failedAccelerations, recoveryGap: round(Math.max(0, beforeSpeed - Math.max(...after.map((item) => item.value)))) }, material: accelerationAttempts > 1 || failedAccelerations > 0 || !sustained, limitations: [], explorer: { href: `/telemetry-event-explorer?press=${input.pressKey}`, label: 'Open speed recovery evidence' } }
}
