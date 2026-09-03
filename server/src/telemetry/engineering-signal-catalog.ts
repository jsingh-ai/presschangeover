export type EngineeringSignalType = 'continuous' | 'step_reference' | 'state_event'
export type EngineeringCategory = 'speed' | 'web_tension' | 'dryer' | 'ink' | 'viscosity' | 'temperature' | 'pump' | 'wash' | 'register' | 'impression' | 'torque' | 'drive_temperature' | 'doctor_blade' | 'repeat_other' | 'motion'

export interface EngineeringSignalCatalogItem {
  canonicalId: string
  friendlyName: string
  signalType: EngineeringSignalType
  category: EngineeringCategory
  scope: 'machine' | 'deck'
}

const machine = (canonicalId: string, friendlyName: string, signalType: EngineeringSignalType, category: EngineeringCategory): EngineeringSignalCatalogItem => ({ canonicalId, friendlyName, signalType, category, scope: 'machine' })
const deck = (canonicalId: string, friendlyName: string, signalType: EngineeringSignalType, category: EngineeringCategory): EngineeringSignalCatalogItem => ({ canonicalId, friendlyName, signalType, category, scope: 'deck' })

export const ENGINEERING_SIGNAL_CATALOG: readonly EngineeringSignalCatalogItem[] = [
  machine('machine.speed.actual', 'Actual Speed', 'continuous', 'speed'),
  machine('machine.speed.setpoint', 'Speed Setpoint', 'step_reference', 'speed'),
  machine('web_tension.chill_draw.actual', 'Chill Draw Tension', 'continuous', 'web_tension'),
  machine('web_tension.chill_draw.setpoint', 'Chill Draw Tension Setpoint', 'step_reference', 'web_tension'),
  machine('unwind.tension.actual', 'Unwind Tension', 'continuous', 'web_tension'),
  machine('rewind.tension.actual', 'Rewind Tension', 'continuous', 'web_tension'),
  machine('dryer.tunnel.temperature.actual', 'Dryer Tunnel Temperature', 'continuous', 'dryer'),
  machine('dryer.tunnel.temperature.setpoint', 'Dryer Tunnel Temperature Setpoint', 'step_reference', 'dryer'),
  machine('production.order.length.actual', 'Order Length', 'continuous', 'repeat_other'),
  deck('ink.viscosity.actual', 'Viscosity Actual', 'continuous', 'viscosity'),
  deck('ink.viscosity.setpoint', 'Viscosity Setpoint', 'step_reference', 'viscosity'),
  deck('ink.temperature.actual', 'Ink Temperature Actual', 'continuous', 'temperature'),
  deck('ink.temperature.setpoint', 'Ink Temperature Setpoint', 'step_reference', 'temperature'),
  deck('ink.pump.frequency.supply', 'Ink Pump Supply Frequency', 'continuous', 'pump'),
  deck('ink.pump.frequency.return', 'Ink Pump Return Frequency', 'continuous', 'pump'),
  deck('register.long.actual_or_correction', 'Long Register Actual or Correction', 'step_reference', 'register'),
  deck('register.long.preset', 'Long Register Preset', 'step_reference', 'register'),
  deck('register.long.rated_or_setpoint', 'Long Register Rated or Setpoint', 'step_reference', 'register'),
  deck('register.side.actual_or_correction', 'Side Register Actual or Correction', 'step_reference', 'register'),
  deck('register.side.preset', 'Side Register Preset', 'step_reference', 'register'),
  deck('register.side.rated_or_setpoint', 'Side Register Rated or Setpoint', 'step_reference', 'register'),
  deck('impression.anilox.drive_side', 'Anilox Impression Drive Side', 'step_reference', 'impression'),
  deck('impression.anilox.operator_side', 'Anilox Impression Operator Side', 'step_reference', 'impression'),
  deck('impression.plate_cylinder.drive_side', 'Plate Impression Drive Side', 'step_reference', 'impression'),
  deck('impression.plate_cylinder.operator_side', 'Plate Impression Operator Side', 'step_reference', 'impression'),
  deck('anilox.drive.torque.actual', 'Anilox Drive Torque', 'continuous', 'torque'),
  deck('anilox.drive.temperature.actual', 'Anilox Drive Temperature', 'continuous', 'drive_temperature'),
  deck('plate_cylinder.drive.torque.actual', 'Plate Cylinder Drive Torque', 'continuous', 'torque'),
  deck('plate_cylinder.drive.temperature.actual', 'Plate Cylinder Drive Temperature', 'continuous', 'drive_temperature'),
  deck('doctor_blade.pressure', 'Doctor Blade Pressure', 'continuous', 'doctor_blade'),
  deck('repeat_length.correction', 'Repeat Length Correction', 'step_reference', 'repeat_other'),
  machine('physical.motion_state', 'Physical Motion', 'state_event', 'motion'),
  deck('deck.active', 'Deck Active Signal', 'state_event', 'ink'),
  deck('deck.print_on', 'Print-on Signal', 'state_event', 'ink'),
  deck('deck.print_off', 'Print-off Signal', 'state_event', 'ink'),
  deck('ink.pump.status', 'Pump-state Code', 'state_event', 'pump'),
  deck('ink.pump.sequence', 'Pump-sequence Code', 'state_event', 'pump'),
  deck('ink.washup.state', 'Wash-state Code', 'state_event', 'wash'),
  deck('ink.viscosity.mode', 'Viscosity-mode Code', 'state_event', 'viscosity'),
  deck('ink.viscosity.status', 'Viscosity-status Code', 'state_event', 'viscosity'),
] as const
