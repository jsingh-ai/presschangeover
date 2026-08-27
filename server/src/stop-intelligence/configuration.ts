import { RADIUS_PRESS_KEYS, type RadiusPressKey } from '../radius/models.js'
import {
  STOP_INTELLIGENCE_CONFIG_VERSION,
  STOP_RECOVERY_CONFIRMATION_SECONDS_DEFAULT,
  STOP_RECOVERY_THRESHOLD_DEFAULT,
  STOP_SPEED_THRESHOLD_DEFAULT,
  STOP_IDENTITY_CONTEXT_AFTER_SECONDS_DEFAULT,
  STOP_IDENTITY_CONTEXT_BEFORE_SECONDS_DEFAULT,
  STOP_IDENTITY_SETTLING_SECONDS,
  type CanonicalSpeedConfiguration,
  type StopIdentityAssociationConfiguration,
} from './contracts.js'

export { STOP_INTELLIGENCE_CONFIG_VERSION }

type CanonicalSpeedIdentity = Pick<CanonicalSpeedConfiguration, 'sourceId' | 'canonicalSpeedSignalId'>

/** Press 14/15 were plant-validated before the capability-driven fleet rollout. */
const validatedIdentities: Partial<Record<RadiusPressKey, CanonicalSpeedIdentity>> = {
  press14: {
    sourceId: 1,
    canonicalSpeedSignalId: 204,
  },
  press15: {
    sourceId: 34,
    canonicalSpeedSignalId: 222,
  },
}

export function hasStopIntelligenceCanonicalPolicy(pressKey: RadiusPressKey): boolean {
  return RADIUS_PRESS_KEYS.includes(pressKey)
}

export function canonicalSpeedConfiguration(pressKey: RadiusPressKey, resolvedIdentity?: CanonicalSpeedIdentity): CanonicalSpeedConfiguration | undefined {
  if (!hasStopIntelligenceCanonicalPolicy(pressKey)) return undefined
  const validated = validatedIdentities[pressKey]
  if (validated && resolvedIdentity && (validated.sourceId !== resolvedIdentity.sourceId || validated.canonicalSpeedSignalId !== resolvedIdentity.canonicalSpeedSignalId)) return undefined
  const identity = resolvedIdentity ?? validated
  if (!identity) return undefined
  return {
    pressKey,
    ...identity,
    canonicalId: 'machine.speed.actual',
    stopThreshold: STOP_SPEED_THRESHOLD_DEFAULT,
    recoveryThreshold: STOP_RECOVERY_THRESHOLD_DEFAULT,
    recoveryConfirmationSeconds: STOP_RECOVERY_CONFIRMATION_SECONDS_DEFAULT,
  }
}

export function stopIdentityAssociationConfiguration(pressKey: RadiusPressKey): StopIdentityAssociationConfiguration | undefined {
  if (!hasStopIntelligenceCanonicalPolicy(pressKey)) return undefined
  return { pressKey, identityContextBeforeSeconds: STOP_IDENTITY_CONTEXT_BEFORE_SECONDS_DEFAULT, identityContextAfterSeconds: STOP_IDENTITY_CONTEXT_AFTER_SECONDS_DEFAULT, identitySettlingSeconds: STOP_IDENTITY_SETTLING_SECONDS }
}
