import {
  STOP_INTELLIGENCE_CLASSIFICATION_VERSION,
  type ClassifiedStop,
  type PhysicalStopSegment,
  type StopClassificationEvidence,
  type StopEvidenceItem,
  type StopFamilyEvidence,
  type StopIdentityEvidence,
  type StopRadiusOverlay,
} from './contracts.js'

export interface StopClassificationInput {
  segment: PhysicalStopSegment
  identities: StopIdentityEvidence[]
  families: StopFamilyEvidence[]
  identityCoverageAdequate: boolean
  familyCoverageAdequate: boolean
  evidenceIntegrity: 'VALID' | 'LIMITED' | 'INVALID'
  radius: StopRadiusOverlay
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
  const coordinatedDeck = activeFamilies.some((value) => value.family === 'DECK' && value.coordinated)
  const setupAnchor = activeFamilies.some((value) => ['DECK', 'IMPRESSION', 'REGISTRATION', 'WINDER_CORE_WIDTH', 'WEB_TENSION_SETPOINT'].includes(value.family))

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
  if (unsettledIdentity.length) return result('UNCERTAIN', 'LOW')
  if (strongIdentity.length) return result('CHANGEOVER', 'HIGH')
  if ((coordinatedDeck && activeFamilies.length >= 2) || (setupAnchor && activeFamilies.length >= 3)) return result('CHANGEOVER', 'HIGH')
  if ((setupAnchor && activeFamilies.length >= 2) || (mediumIdentity.length && setupAnchor)) return result('CHANGEOVER', 'MEDIUM')
  if (!input.identityCoverageAdequate || !input.familyCoverageAdequate) return result('UNCERTAIN', 'LOW')
  if (activeFamilies.length === 1 && setupAnchor) return result('UNCERTAIN', 'LOW')

  supporting.push(item('NO_COORDINATED_SETUP_PATTERN', 'SETUP_FAMILY', 'MEDIUM', 'Adequate telemetry shows no coordinated multi-family setup pattern.'))
  return result('DOWNTIME', activeFamilies.length || mediumIdentity.length ? 'LOW' : 'MEDIUM')
}
