import type { EngineeringCategory, EngineeringSignalType, SignalCapability } from './types/evidence'

export type EngineeringScope = 'machine' | 'deck'
export type EngineeringBrowserCategory = 'speed_command' | 'web_tension' | 'dryer' | 'production_process' | 'ink_viscosity' | 'ink_temperature' | 'pump_wash' | 'register' | 'impression' | 'anilox_drive' | 'plate_drive' | 'doctor_blade' | 'repeat_other' | 'deck_state' | 'motion'

export interface EngineeringSignalDefinition {
  canonicalId: string
  friendlyName: string
  signalType: EngineeringSignalType
  clueCategory: EngineeringCategory
  browserCategory: EngineeringBrowserCategory
  scope: EngineeringScope
  ambiguous?: boolean
}

export const ENGINEERING_CATEGORY_LABELS: Record<EngineeringBrowserCategory, string> = {
  speed_command: 'Speed / Command', web_tension: 'Web / Tension', dryer: 'Dryer', production_process: 'Production / Process',
  ink_viscosity: 'Ink / Viscosity', ink_temperature: 'Ink Temperature', pump_wash: 'Pump / Wash', register: 'Register', impression: 'Impression',
  anilox_drive: 'Anilox Drive', plate_drive: 'Plate-Cylinder Drive', doctor_blade: 'Doctor Blade', repeat_other: 'Repeat / Other', deck_state: 'Deck State', motion: 'Motion',
}

const machine = (canonicalId: string, friendlyName: string, signalType: EngineeringSignalType, clueCategory: EngineeringCategory, browserCategory: EngineeringBrowserCategory, ambiguous = false): EngineeringSignalDefinition => ({ canonicalId, friendlyName, signalType, clueCategory, browserCategory, scope: 'machine', ambiguous })
const deck = (canonicalId: string, friendlyName: string, signalType: EngineeringSignalType, clueCategory: EngineeringCategory, browserCategory: EngineeringBrowserCategory, ambiguous = false): EngineeringSignalDefinition => ({ canonicalId, friendlyName, signalType, clueCategory, browserCategory, scope: 'deck', ambiguous })

export const ENGINEERING_SIGNAL_CATALOG: readonly EngineeringSignalDefinition[] = [
  machine('machine.speed.actual', 'Actual Speed', 'continuous', 'speed', 'speed_command'),
  machine('machine.speed.setpoint', 'Speed Setpoint', 'step_reference', 'speed', 'speed_command'),
  machine('web_tension.chill_draw.actual', 'Chill Draw Tension', 'continuous', 'web_tension', 'web_tension'),
  machine('web_tension.chill_draw.setpoint', 'Chill Draw Tension Setpoint', 'step_reference', 'web_tension', 'web_tension'),
  machine('unwind.tension.actual', 'Unwind Tension', 'continuous', 'web_tension', 'web_tension'),
  machine('rewind.tension.actual', 'Rewind Tension', 'continuous', 'web_tension', 'web_tension'),
  machine('dryer.tunnel.temperature.actual', 'Dryer Tunnel Temperature', 'continuous', 'dryer', 'dryer'),
  machine('dryer.tunnel.temperature.setpoint', 'Dryer Tunnel Temperature Setpoint', 'step_reference', 'dryer', 'dryer'),
  machine('production.order.length.actual', 'Order Length', 'continuous', 'repeat_other', 'production_process'),
  machine('physical.motion_state', 'Physical Motion', 'state_event', 'motion', 'motion'),
  deck('ink.viscosity.actual', 'Viscosity Actual', 'continuous', 'viscosity', 'ink_viscosity'),
  deck('ink.viscosity.setpoint', 'Viscosity Setpoint', 'step_reference', 'viscosity', 'ink_viscosity'),
  deck('ink.viscosity.mode', 'Viscosity-mode Code', 'state_event', 'viscosity', 'ink_viscosity'),
  deck('ink.viscosity.status', 'Viscosity-status Code', 'state_event', 'viscosity', 'ink_viscosity'),
  deck('ink.temperature.actual', 'Ink Temperature Actual', 'continuous', 'temperature', 'ink_temperature'),
  deck('ink.temperature.setpoint', 'Ink Temperature Setpoint', 'step_reference', 'temperature', 'ink_temperature'),
  deck('ink.pump.frequency.supply', 'Ink Pump Supply Frequency', 'continuous', 'pump', 'pump_wash'),
  deck('ink.pump.frequency.return', 'Ink Pump Return Frequency', 'continuous', 'pump', 'pump_wash'),
  deck('ink.pump.status', 'Pump-state Code', 'state_event', 'pump', 'pump_wash'),
  deck('ink.pump.sequence', 'Pump-sequence Code', 'state_event', 'pump', 'pump_wash'),
  deck('ink.washup.state', 'Wash-state Code', 'state_event', 'wash', 'pump_wash'),
  deck('register.long.actual_or_correction', 'Long Register Actual or Correction', 'step_reference', 'register', 'register', true),
  deck('register.long.preset', 'Long Register Preset', 'step_reference', 'register', 'register'),
  deck('register.long.rated_or_setpoint', 'Long Register Rated or Setpoint', 'step_reference', 'register', 'register', true),
  deck('register.side.actual_or_correction', 'Side Register Actual or Correction', 'step_reference', 'register', 'register', true),
  deck('register.side.preset', 'Side Register Preset', 'step_reference', 'register', 'register'),
  deck('register.side.rated_or_setpoint', 'Side Register Rated or Setpoint', 'step_reference', 'register', 'register', true),
  deck('impression.anilox.drive_side', 'Anilox Impression Drive Side', 'step_reference', 'impression', 'impression'),
  deck('impression.anilox.operator_side', 'Anilox Impression Operator Side', 'step_reference', 'impression', 'impression'),
  deck('impression.anilox.drive_side.rated_or_setpoint', 'Anilox Impression Drive Side Rated or Setpoint', 'step_reference', 'impression', 'impression', true),
  deck('impression.anilox.operator_side.rated_or_setpoint', 'Anilox Impression Operator Side Rated or Setpoint', 'step_reference', 'impression', 'impression', true),
  deck('impression.plate_cylinder.drive_side', 'Plate Impression Drive Side', 'step_reference', 'impression', 'impression'),
  deck('impression.plate_cylinder.operator_side', 'Plate Impression Operator Side', 'step_reference', 'impression', 'impression'),
  deck('impression.plate_cylinder.drive_side.rated_or_setpoint', 'Plate Impression Drive Side Rated or Setpoint', 'step_reference', 'impression', 'impression', true),
  deck('impression.plate_cylinder.operator_side.rated_or_setpoint', 'Plate Impression Operator Side Rated or Setpoint', 'step_reference', 'impression', 'impression', true),
  deck('anilox.drive.torque.actual', 'Anilox Drive Torque', 'continuous', 'torque', 'anilox_drive'),
  deck('anilox.drive.temperature.actual', 'Anilox Drive Temperature', 'continuous', 'drive_temperature', 'anilox_drive'),
  deck('plate_cylinder.drive.torque.actual', 'Plate Cylinder Drive Torque', 'continuous', 'torque', 'plate_drive'),
  deck('plate_cylinder.drive.temperature.actual', 'Plate Cylinder Drive Temperature', 'continuous', 'drive_temperature', 'plate_drive'),
  deck('doctor_blade.pressure', 'Doctor Blade Pressure', 'continuous', 'doctor_blade', 'doctor_blade'),
  deck('repeat_length.correction', 'Repeat Length Correction', 'step_reference', 'repeat_other', 'repeat_other'),
  deck('deck.active', 'Deck Active Signal', 'state_event', 'ink', 'deck_state'),
  deck('deck.print_on', 'Print-on Signal', 'state_event', 'ink', 'deck_state'),
  deck('deck.print_off', 'Print-off Signal', 'state_event', 'ink', 'deck_state'),
] as const

export interface EngineeringSignalIdentity { canonicalId: string; deckNumber?: number }

export function signalKey(signal: EngineeringSignalIdentity): string { return `${signal.canonicalId}:${signal.deckNumber ?? ''}` }
export function signalDefinition(canonicalId: string): EngineeringSignalDefinition | undefined { return ENGINEERING_SIGNAL_CATALOG.find((item) => item.canonicalId === canonicalId) }
export function capabilityFor(capabilities: SignalCapability[], signal: EngineeringSignalIdentity): SignalCapability | undefined {
  const capability = capabilities.find(({ canonicalId }) => canonicalId === signal.canonicalId)
  if (!capability || signal.deckNumber === undefined || capability.state !== 'SUPPORTED') return capability
  return capability.deckNumbers.includes(signal.deckNumber) ? capability : { ...capability, state: 'UNSUPPORTED' }
}
export function browserCategoryForClue(category: EngineeringCategory, canonicalId?: string): EngineeringBrowserCategory {
  return (canonicalId ? signalDefinition(canonicalId)?.browserCategory : undefined) ?? ({ speed: 'speed_command', web_tension: 'web_tension', dryer: 'dryer', ink: 'deck_state', viscosity: 'ink_viscosity', temperature: 'ink_temperature', pump: 'pump_wash', wash: 'pump_wash', register: 'register', impression: 'impression', torque: 'anilox_drive', drive_temperature: 'anilox_drive', doctor_blade: 'doctor_blade', repeat_other: 'repeat_other', motion: 'motion' } as const)[category]
}

