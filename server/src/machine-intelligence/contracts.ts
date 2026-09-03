import type { RadiusPressKey } from '../radius/models.js'

export const MACHINE_INTELLIGENCE_VERSION = 'machine-intelligence-v1.0.0' as const
export const MACHINE_INTELLIGENCE_MAX_RANGE_MS = 72 * 60 * 60_000

export const MACHINE_INTELLIGENCE_CATEGORIES = ['CHANGEOVER', 'GOOD_RUN', 'DOWNTIME', 'MISSING_DATA'] as const
export type MachineIntelligenceCategory = (typeof MACHINE_INTELLIGENCE_CATEGORIES)[number]
export type MachineIntelligenceSegmentSource = 'PREDICTION' | 'OPERATOR_REVIEW' | 'DATA_AVAILABILITY'
export type MachineIntelligenceRadiusCategory = 'G' | 'B' | 'M' | 'MISSING_DATA'
export type MachineIntelligenceRollCategory = 'GOOD' | 'CHANGEOVER'

export interface MachineIntelligenceCategoryTotals {
  CHANGEOVER: number
  GOOD_RUN: number
  DOWNTIME: number
  MISSING_DATA: number
}

export interface MachineIntelligenceSegment {
  segmentId: string
  occurrenceId: string
  category: MachineIntelligenceCategory
  startUtc: string
  endUtc: string
  durationSeconds: number
  source: MachineIntelligenceSegmentSource
  underlyingState: string
  stopId: string | null
}

export interface MachineIntelligenceRadiusSegment {
  segmentId: string
  category: MachineIntelligenceRadiusCategory
  startUtc: string
  endUtc: string
  durationSeconds: number
  eventType: string | null
  statusCode: string | null
  statusDescription: string | null
}

export interface MachineIntelligenceSpeedTrend {
  unit: string | null
  observations: Array<{ atUtc: string; value: number; qualityState: string }>
}

export interface MachineIntelligenceIdentitySegment {
  segmentId: string
  startUtc: string
  endUtc: string
  durationSeconds: number
  order: string | null
  recipe: string | null
  missingFields: Array<'order' | 'recipe'>
}

export interface MachineIntelligenceRoll {
  rollId: string
  occurrenceId: string
  category: MachineIntelligenceRollCategory
  startUtc: string
  endUtc: string
  length: number
  unit: string | null
}

export interface MachineIntelligenceRollSummary {
  total: number
  good: number
  changeover: number
  goodLength: number
  changeoverLength: number
}

export interface MachineIntelligenceJobOccurrence {
  occurrenceId: string
  occurrenceNumber: number
  startUtc: string
  endUtc: string
  durationSeconds: number
  order: string | null
  recipe: string | null
  identityComplete: boolean
  boundaryFields: Array<'order' | 'recipe'>
  totals: MachineIntelligenceCategoryTotals
  segments: MachineIntelligenceSegment[]
  rollSummary: MachineIntelligenceRollSummary
  rolls: MachineIntelligenceRoll[]
}

export interface MachineIntelligenceJobGroup {
  groupId: string
  order: string | null
  recipe: string | null
  identityComplete: boolean
  occurrenceCount: number
  firstStartUtc: string
  lastEndUtc: string
  totals: MachineIntelligenceCategoryTotals
  rollSummary: MachineIntelligenceRollSummary
  rolls: MachineIntelligenceRoll[]
  occurrences: MachineIntelligenceJobOccurrence[]
}

export interface MachineIntelligencePressReport {
  version: typeof MACHINE_INTELLIGENCE_VERSION
  generatedAtUtc: string
  fromUtc: string
  toUtc: string
  pressKey: RadiusPressKey
  displayName: string
  availability: 'AVAILABLE' | 'PARTIAL' | 'UNAVAILABLE'
  reason: string | null
  totals: MachineIntelligenceCategoryTotals
  classificationTimeline: MachineIntelligenceSegment[]
  speedTrend: MachineIntelligenceSpeedTrend
  identityTimeline: MachineIntelligenceIdentitySegment[]
  radiusTimeline: MachineIntelligenceRadiusSegment[]
  radiusTotals: Record<MachineIntelligenceRadiusCategory, number>
  rollSummary: MachineIntelligenceRollSummary
  jobGroups: MachineIntelligenceJobGroup[]
  correctionPersistence: 'postgresql' | 'memory'
  policy: {
    identityBoundary: 'ANY_OBSERVED_ORDER_OR_RECIPE_CHANGE'
    temporaryIdentityGaps: 'MISSING_TIME_WITHOUT_NEW_OCCURRENCE'
    repeatedIdentity: 'GROUPED_OCCURRENCES'
    operatorReview: 'LATEST_REVIEW_OVERRIDES_PREDICTION'
    routineAndUncertain: 'DOWNTIME'
    badOrUnavailableEvidence: 'MISSING_DATA'
  }
}
