import {
  STOP_INTELLIGENCE_CLASSIFICATION_VERSION,
  type CanonicalSpeedObservation,
  type ClassifiedStop,
  type PhysicalStopSegment,
  type StopClassificationEvidence,
  type StopEvidenceItem,
  type StopFamilyEvidence,
  type StopIdentityEvidence,
  type StopRadiusOverlay,
} from './contracts.js'
import { isGoodTelemetryQuality } from '../telemetry/historical-telemetry-policy.js'

export interface StopClassificationInput {
  segment: PhysicalStopSegment
  identities: StopIdentityEvidence[]
  families: StopFamilyEvidence[]
  identityCoverageAdequate: boolean
  familyCoverageAdequate: boolean
  evidenceIntegrity: 'VALID' | 'LIMITED' | 'INVALID'
  radius: StopRadiusOverlay
  requiredChangeoverEvidence: RequiredChangeoverEvidence
}

export interface RequiredChangeoverEvidence {
  washActivity: boolean
  pumpInkActivity: boolean
  impressionAdjustment: boolean
  speedTestReturnedToZero: boolean
}

/** A test requires positive speed followed by an observed return to zero before physical recovery. */
export function hasInStopSpeedTest(segment: PhysicalStopSegment, observations: CanonicalSpeedObservation[]): boolean {
  const start = Date.parse(segment.startAt)
  const end = Date.parse(segment.endAt ?? '9999-12-31T23:59:59.999Z')
  let sawPositiveSpeed = false
  for (const observation of [...observations].sort((left, right) => Date.parse(left.atUtc) - Date.parse(right.atUtc))) {
    const at = Date.parse(observation.atUtc)
    if (at < start || at >= end || typeof observation.speed !== 'number' || !Number.isFinite(observation.speed) || !isGoodTelemetryQuality(observation.qualityState)) continue
    if (observation.speed > 0) sawPositiveSpeed = true
    else if (sawPositiveSpeed && observation.speed === 0) return true
  }
  return false
}

const item = (code: string, category: StopEvidenceItem['category'], strength: StopEvidenceItem['strength'], explanation: string, canonicalIds: string[] = [], fromUtc: string | null = null, toUtc: string | null = null): StopEvidenceItem => ({ code, category, strength, explanation, canonicalIds, fromUtc, toUtc })

export function classifyStop(input: StopClassificationInput): ClassifiedStop {
  const supporting: StopEvidenceItem[] = []
  const conflicting: StopEvidenceItem[] = []
  const missing: string[] = []
  const strongIdentity = input.identities.filter((value) => value.changed && value.settled && value.usefulness === 'STRONG')
  const mediumIdentity = input.identities.filter((value) => value.changed && value.settled && value.usefulness === 'MEDIUM')
  const weakIdentity = input.identities.filter((value) => value.changed && value.settled && value.usefulness === 'WEAK')
  const unsettledIdentity = input.identities.filter((value) => value.changed && !value.settled && (value.usefulness === 'STRONG' || value.usefulness === 'MEDIUM'))
  const activeFamilies = input.families.filter((value) => value.observed)
  const requiredEvidence = input.requiredChangeoverEvidence
  const requiredConditions = [
    { present: requiredEvidence.washActivity, code: 'WASH_ACTIVITY_DURING_STOP', missingCode: 'CHANGEOVER_REQUIRES_WASH_ACTIVITY', explanation: 'Canonical wash activity changed during the physical stop.' },
    { present: requiredEvidence.pumpInkActivity, code: 'PUMP_INK_ACTIVITY_DURING_STOP', missingCode: 'CHANGEOVER_REQUIRES_PUMP_INK_ACTIVITY', explanation: 'Canonical pump or ink activity changed during the physical stop.' },
    { present: requiredEvidence.impressionAdjustment, code: 'IMPRESSION_ADJUSTMENT_DURING_STOP', missingCode: 'CHANGEOVER_REQUIRES_IMPRESSION_ADJUSTMENT', explanation: 'Canonical impression telemetry changed during the physical stop.' },
    { present: requiredEvidence.speedTestReturnedToZero, code: 'SPEED_TEST_RETURNED_TO_ZERO', missingCode: 'CHANGEOVER_REQUIRES_SPEED_TEST', explanation: 'Actual Speed rose above zero and returned to zero during the physical stop.' },
  ]

  if (!input.segment.leftCensored && !input.segment.rightCensored) supporting.push(item('PHYSICAL_STOP_COMPLETE', 'PHYSICAL', 'STRONG', 'The physical stop has observed speed boundaries on both sides.', ['machine.speed.actual'], input.segment.startAt, input.segment.endAt))
  else conflicting.push(item('PHYSICAL_STOP_CENSORED', 'PHYSICAL', 'STRONG', 'At least one physical boundary is censored, so a complete event cannot be asserted.', ['machine.speed.actual'], input.segment.startAt, input.segment.endAt))
  if (input.segment.physicalDurationSeconds >= 30 * 60) supporting.push(item('LONG_DURATION_CONTEXT', 'PHYSICAL', 'SUPPORTING', 'The stop is long, but duration is context only and never determines the class.', ['machine.speed.actual'], input.segment.startAt, input.segment.endAt))
  if (input.segment.failedRecoveryCount) supporting.push(item('RESTART_ATTEMPTS_CONTEXT', 'PHYSICAL', 'SUPPORTING', 'Failed recovery attempts are retained as context only.', ['machine.speed.actual'], input.segment.startAt, input.segment.endAt))

  for (const identity of strongIdentity) supporting.push(item(`${identity.field.toUpperCase()}_CHANGED`, 'IDENTITY', 'STRONG', `${identity.field} changed from a usable before value to a settled after value.`, identity.canonicalId ? [identity.canonicalId] : [], identity.firstChangeAtUtc, identity.settledAtUtc))
  for (const identity of mediumIdentity) supporting.push(item(`${identity.field.toUpperCase()}_CHANGED`, 'IDENTITY', 'MEDIUM', `${identity.field} supplied a settled secondary identity transition.`, identity.canonicalId ? [identity.canonicalId] : [], identity.firstChangeAtUtc, identity.settledAtUtc))
  for (const identity of weakIdentity) supporting.push(item(`${identity.field.toUpperCase()}_CHANGED`, 'IDENTITY', 'WEAK', `${identity.field} changed but is supporting context only on this press.`, identity.canonicalId ? [identity.canonicalId] : [], identity.firstChangeAtUtc, identity.settledAtUtc))
  for (const identity of unsettledIdentity) conflicting.push(item('UNSETTLED_IDENTITY_TRANSITION', 'IDENTITY', 'STRONG', `${identity.field} changed but did not settle inside the bounded evidence window.`, identity.canonicalId ? [identity.canonicalId] : [], identity.firstChangeAtUtc, identity.lastChangeAtUtc))
  for (const family of activeFamilies) supporting.push(item(family.family === 'DECK' && family.coordinated ? 'COORDINATED_DECK_MOVEMENT' : `${family.family}_ACTIVITY`, 'SETUP_FAMILY', family.coordinated ? 'STRONG' : 'MEDIUM', family.reason, family.canonicalIds, family.firstObservedAtUtc, family.lastObservedAtUtc))
  if (input.radius.alignment === 'CONTRADICTORY') conflicting.push(item('RADIUS_RUN_PRODUCTION', 'RADIUS', 'WEAK', input.radius.reason, [], input.segment.startAt, input.segment.endAt))
  for (const condition of requiredConditions) {
    if (condition.present) supporting.push(item(condition.code, condition.code === 'SPEED_TEST_RETURNED_TO_ZERO' ? 'PHYSICAL' : 'SETUP_FAMILY', 'STRONG', condition.explanation, condition.code === 'SPEED_TEST_RETURNED_TO_ZERO' ? ['machine.speed.actual'] : [], input.segment.startAt, input.segment.endAt))
    else conflicting.push(item(condition.missingCode, condition.missingCode === 'CHANGEOVER_REQUIRES_SPEED_TEST' ? 'PHYSICAL' : 'SETUP_FAMILY', 'STRONG', `${condition.explanation.replace(/\.$/, '')} is required before Stop Intelligence can predict CHANGEOVER.`, [], input.segment.startAt, input.segment.endAt))
  }

  if (!input.identityCoverageAdequate) missing.push('RELEVANT_IDENTITY_COVERAGE')
  if (!input.familyCoverageAdequate) missing.push('SETUP_FAMILY_COVERAGE')
  for (const identity of input.identities) if (!identity.available && identity.usefulness !== 'UNUSABLE') missing.push(`${identity.field.toUpperCase()}_UNAVAILABLE`)
  for (const family of input.families) if (!family.available) missing.push(`${family.family}_UNAVAILABLE`)
  if (input.radius.alignment === 'RADIUS_UNAVAILABLE') missing.push('RADIUS_UNAVAILABLE')

  const evidence: StopClassificationEvidence = { supporting, conflicting, missing }
  const result = (classification: ClassifiedStop['classification'], confidence: ClassifiedStop['confidence']): ClassifiedStop => ({ physicalSegment: input.segment, classification, confidence, classificationVersion: STOP_INTELLIGENCE_CLASSIFICATION_VERSION, identities: input.identities, identityBefore: Object.fromEntries(input.identities.map((value) => [value.field, value.beforeValue])), identityAfter: Object.fromEntries(input.identities.map((value) => [value.field, value.afterValue])), families: input.families, supportingEvidence: evidence.supporting, conflictingEvidence: evidence.conflicting, missingEvidence: evidence.missing, radiusAlignment: input.radius.alignment, radius: input.radius })

  if (input.evidenceIntegrity === 'INVALID') {
    conflicting.push(item('INVALID_SPEED_EVIDENCE', 'AVAILABILITY', 'STRONG', 'Bad or structurally invalid speed evidence cannot support a physical behavior claim.', ['machine.speed.actual']))
    return result('IGNORE_BAD_DATA', 'HIGH')
  }
  if (input.evidenceIntegrity === 'LIMITED' || input.segment.leftCensored || input.segment.rightCensored) return result('UNCERTAIN', 'LOW')
  if (requiredConditions.some(({ present }) => !present)) return result('DOWNTIME', 'HIGH')
  return result('CHANGEOVER', 'HIGH')
}
