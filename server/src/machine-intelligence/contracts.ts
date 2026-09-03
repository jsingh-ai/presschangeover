import type { RadiusPressKey } from '../radius/models.js'

export const MACHINE_INTELLIGENCE_VERSION = 'machine-intelligence-v2.0.0' as const
export const MACHINE_INTELLIGENCE_MAX_RANGE_MS = 31 * 24 * 60 * 60_000

export type MachineIntelligenceRadiusCategory = 'G' | 'B' | 'M' | 'MISSING_DATA'

export interface MachineIntelligenceCategoryTotals {
  CHANGEOVER: number
  GOOD_RUN: number
  DOWNTIME: number
  MISSING_DATA: number
}

export interface MachineIntelligenceRollSummary {
  total: number
  good: number
  changeover: number
  goodLength: number
  changeoverLength: number
}

/** The intentionally small contract used by the fleet comparison charts. */
export interface MachineIntelligencePressOverview {
  pressKey: RadiusPressKey
  displayName: string
  availability: 'AVAILABLE' | 'PARTIAL' | 'UNAVAILABLE'
  reason: string | null
  totals: MachineIntelligenceCategoryTotals
  radiusTotals: Record<MachineIntelligenceRadiusCategory, number>
  rollSummary: MachineIntelligenceRollSummary
}

export interface MachineIntelligenceFleetOverview {
  version: typeof MACHINE_INTELLIGENCE_VERSION
  generatedAtUtc: string
  fromUtc: string
  toUtc: string
  presses: MachineIntelligencePressOverview[]
  unavailablePresses: Array<{ pressKey: RadiusPressKey; displayName: string; reason: string }>
}
