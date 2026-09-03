import type { RadiusPressKey } from './types/api'
import type { MachineIntelligencePressOverview } from './types/machine-intelligence'

export const MACHINE_INTELLIGENCE_PRESS_KEYS: RadiusPressKey[] = ['press3', 'press5', 'press6', 'press7', 'press8', 'press9', 'press10', 'press11', 'press12', 'press13', 'press14', 'press15']
export const MACHINE_INTELLIGENCE_MAX_RANGE_MS = 31 * 24 * 60 * 60_000

export function machineOpportunitySeconds(report: MachineIntelligencePressOverview) {
  return report.totals.CHANGEOVER + report.totals.DOWNTIME
}
