import type { RadiusPressKey } from '../radius/models.js'
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

const configuration: Partial<Record<RadiusPressKey, CanonicalSpeedConfiguration>> = {
  press14: {
    pressKey: 'press14',
    sourceId: 1,
    canonicalSpeedSignalId: 204,
    canonicalId: 'machine.speed.actual',
    stopThreshold: STOP_SPEED_THRESHOLD_DEFAULT,
    recoveryThreshold: STOP_RECOVERY_THRESHOLD_DEFAULT,
    recoveryConfirmationSeconds: STOP_RECOVERY_CONFIRMATION_SECONDS_DEFAULT,
  },
  press15: {
    pressKey: 'press15',
    sourceId: 34,
    canonicalSpeedSignalId: 222,
    canonicalId: 'machine.speed.actual',
    stopThreshold: STOP_SPEED_THRESHOLD_DEFAULT,
    recoveryThreshold: STOP_RECOVERY_THRESHOLD_DEFAULT,
    recoveryConfirmationSeconds: STOP_RECOVERY_CONFIRMATION_SECONDS_DEFAULT,
  },
}

export function canonicalSpeedConfiguration(pressKey: RadiusPressKey): CanonicalSpeedConfiguration | undefined {
  return configuration[pressKey]
}

export function stopIdentityAssociationConfiguration(pressKey: RadiusPressKey): StopIdentityAssociationConfiguration | undefined {
  if (!configuration[pressKey]) return undefined
  return { pressKey, identityContextBeforeSeconds: STOP_IDENTITY_CONTEXT_BEFORE_SECONDS_DEFAULT, identityContextAfterSeconds: STOP_IDENTITY_CONTEXT_AFTER_SECONDS_DEFAULT, identitySettlingSeconds: STOP_IDENTITY_SETTLING_SECONDS }
}
