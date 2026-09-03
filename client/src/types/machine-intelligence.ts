import type { RadiusPressKey } from './api'

export type MachineIntelligenceRadiusCategory = 'G' | 'B' | 'M' | 'MISSING_DATA'
export interface MachineIntelligenceCategoryTotals { CHANGEOVER: number; GOOD_RUN: number; DOWNTIME: number; MISSING_DATA: number }
export interface MachineIntelligenceRollSummary { total: number; good: number; changeover: number; goodLength: number; changeoverLength: number }
export interface MachineIntelligencePressOverview { pressKey: RadiusPressKey; displayName: string; availability: 'AVAILABLE' | 'PARTIAL' | 'UNAVAILABLE'; reason: string | null; totals: MachineIntelligenceCategoryTotals; radiusTotals: Record<MachineIntelligenceRadiusCategory, number>; rollSummary: MachineIntelligenceRollSummary }
export interface MachineIntelligenceFleetOverview { version: 'machine-intelligence-v2.0.0'; generatedAtUtc: string; fromUtc: string; toUtc: string; presses: MachineIntelligencePressOverview[]; unavailablePresses: Array<{ pressKey: RadiusPressKey; displayName: string; reason: string }> }
