import type { RadiusStatusSegment } from '../radius/models.js'
import type { PhysicalStopSegment, StopRadiusOverlay } from './contracts.js'

const ALIGNMENT_TOLERANCE_MS = 60_000
const round = (value: number) => Math.round(value * 10) / 10
const unavailable = (reason: string, physicalSeconds = 0): StopRadiusOverlay => ({ alignment: 'RADIUS_UNAVAILABLE', firstNonProductionAtUtc: null, firstProductionReturnAtUtc: null, physicalStartOffsetSeconds: null, physicalEndOffsetSeconds: null, coveredSeconds: 0, physicalSeconds, coveragePercent: 0, states: [], reason })

export function overlayRadius(segment: PhysicalStopSegment, rangeEndUtc: string, radiusSegments?: RadiusStatusSegment[]): StopRadiusOverlay {
  const start = Date.parse(segment.startAt); const end = Date.parse(segment.endAt ?? rangeEndUtc)
  const physicalSeconds = Number.isFinite(start) && Number.isFinite(end) && end > start ? round((end - start) / 1_000) : 0
  if (!radiusSegments?.length || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return unavailable('Radius timeline evidence was unavailable for this physical stop.', physicalSeconds)
  const ordered = [...radiusSegments].sort((left, right) => Date.parse(left.startUtc) - Date.parse(right.startUtc))
  const overlapping = ordered.filter((value) => Date.parse(value.endUtc) > start && Date.parse(value.startUtc) < end)
  if (!overlapping.length) return unavailable('No Radius interval covered the physical stop.', physicalSeconds)
  const states = overlapping.map((value) => ({ kind: value.kind, startUtc: new Date(Math.max(start, Date.parse(value.startUtc))).toISOString(), endUtc: new Date(Math.min(end, Date.parse(value.endUtc))).toISOString(), eventType: value.kind === 'radius' ? value.eventType : null, statusCode: value.kind === 'radius' ? value.statusCode : null, statusDescription: value.kind === 'radius' ? value.statusDescription : null, isProduction: value.kind === 'radius' && value.isProduction }))
  const coveredMs = states.reduce((sum, value) => sum + Math.max(0, Date.parse(value.endUtc) - Date.parse(value.startUtc)), 0)
  const productionMs = states.filter((value) => value.isProduction).reduce((sum, value) => sum + Date.parse(value.endUtc) - Date.parse(value.startUtc), 0)
  const physicalMs = end - start
  const firstNonProduction = overlapping.find((value) => value.kind === 'radius' && !value.isProduction)
  const firstProductionReturn = firstNonProduction ? ordered.find((value) => value.kind === 'radius' && value.isProduction && Date.parse(value.startUtc) >= Date.parse(firstNonProduction.startUtc)) : undefined
  const startOffset = firstNonProduction ? Date.parse(firstNonProduction.startUtc) - start : null
  const endOffset = firstProductionReturn ? Date.parse(firstProductionReturn.startUtc) - end : null
  const partial = coveredMs < physicalMs * .8 || overlapping.some((value) => value.kind === 'offline')
  let alignment: StopRadiusOverlay['alignment']; let reason: string
  if (productionMs > physicalMs * .5) { alignment = 'CONTRADICTORY'; reason = 'Radius recorded production for most of the telemetry-derived physical stop.' }
  else if (partial || !firstNonProduction) { alignment = 'PARTIAL'; reason = 'Radius covered only part of the physical stop or did not expose a non-production interval.' }
  else if ((startOffset !== null && endOffset !== null && startOffset > ALIGNMENT_TOLERANCE_MS && endOffset < -ALIGNMENT_TOLERANCE_MS) || (startOffset !== null && endOffset !== null && startOffset < -ALIGNMENT_TOLERANCE_MS && endOffset > ALIGNMENT_TOLERANCE_MS)) { alignment = 'PARTIAL'; reason = 'Radius start and end annotations disagree in opposite directions.' }
  else if ((startOffset !== null && startOffset > ALIGNMENT_TOLERANCE_MS) || (endOffset !== null && endOffset > ALIGNMENT_TOLERANCE_MS)) { alignment = 'RADIUS_LATE'; reason = 'Radius entered or left its non-production annotation after the physical boundary.' }
  else if ((startOffset !== null && startOffset < -ALIGNMENT_TOLERANCE_MS) || (endOffset !== null && endOffset < -ALIGNMENT_TOLERANCE_MS)) { alignment = 'RADIUS_EARLY'; reason = 'Radius entered or left its non-production annotation before the physical boundary.' }
  else { alignment = 'AGREES'; reason = 'Radius non-production timing agrees with the telemetry-derived physical boundaries within one minute.' }
  return { alignment, firstNonProductionAtUtc: firstNonProduction?.startUtc ?? null, firstProductionReturnAtUtc: firstProductionReturn?.startUtc ?? null, physicalStartOffsetSeconds: startOffset === null ? null : round(startOffset / 1_000), physicalEndOffsetSeconds: endOffset === null ? null : round(endOffset / 1_000), coveredSeconds: round(coveredMs / 1_000), physicalSeconds: round(physicalMs / 1_000), coveragePercent: round(Math.min(100, coveredMs / physicalMs * 100)), states, reason }
}
