import type { RadiusPressKey } from './api'

export type PressDowntimeCategory = 'CHANGEOVER' | 'GOOD_RUN' | 'DOWNTIME' | 'MISSING_DATA'
export type PressDowntimeRadiusCategory = 'G' | 'B' | 'M' | 'MISSING_DATA'
export type PressDowntimeRollCategory = 'GOOD' | 'CHANGEOVER'
export interface PressDowntimeCategoryTotals { CHANGEOVER: number; GOOD_RUN: number; DOWNTIME: number; MISSING_DATA: number }
export interface PressDowntimeSegment { segmentId: string; occurrenceId: string; category: PressDowntimeCategory; startUtc: string; endUtc: string; durationSeconds: number; source: 'PREDICTION' | 'OPERATOR_REVIEW' | 'DATA_AVAILABILITY'; underlyingState: string; stopId: string | null }
export interface PressDowntimeRadiusSegment { segmentId: string; category: PressDowntimeRadiusCategory; startUtc: string; endUtc: string; durationSeconds: number; eventType: string | null; statusCode: string | null; statusDescription: string | null }
export interface PressDowntimeSpeedTrend { unit: string | null; observations: Array<{ atUtc: string; value: number; qualityState: string }> }
export interface PressDowntimeIdentitySegment { segmentId: string; startUtc: string; endUtc: string; durationSeconds: number; order: string | null; recipe: string | null; missingFields: Array<'order' | 'recipe'> }
export interface PressDowntimeRoll { rollId: string; occurrenceId: string; category: PressDowntimeRollCategory; startUtc: string; endUtc: string; length: number; unit: string | null }
export interface PressDowntimeRollSummary { total: number; good: number; changeover: number; goodLength: number; changeoverLength: number }
export interface PressDowntimeJobOccurrence { occurrenceId: string; occurrenceNumber: number; startUtc: string; endUtc: string; durationSeconds: number; order: string | null; recipe: string | null; identityComplete: boolean; boundaryFields: Array<'order' | 'recipe'>; totals: PressDowntimeCategoryTotals; segments: PressDowntimeSegment[]; rollSummary: PressDowntimeRollSummary; rolls: PressDowntimeRoll[] }
export interface PressDowntimeJobGroup { groupId: string; order: string | null; recipe: string | null; identityComplete: boolean; occurrenceCount: number; firstStartUtc: string; lastEndUtc: string; totals: PressDowntimeCategoryTotals; rollSummary: PressDowntimeRollSummary; rolls: PressDowntimeRoll[]; occurrences: PressDowntimeJobOccurrence[] }
export interface PressDowntimePressReport {
  version: 'press-downtime-v1.3.0'; generatedAtUtc: string; fromUtc: string; toUtc: string; pressKey: RadiusPressKey; displayName: string; availability: 'AVAILABLE' | 'PARTIAL' | 'UNAVAILABLE'; reason: string | null; totals: PressDowntimeCategoryTotals; classificationTimeline: PressDowntimeSegment[]; speedTrend: PressDowntimeSpeedTrend; identityTimeline: PressDowntimeIdentitySegment[]; radiusTimeline: PressDowntimeRadiusSegment[]; radiusTotals: Record<PressDowntimeRadiusCategory, number>; rollSummary: PressDowntimeRollSummary; jobGroups: PressDowntimeJobGroup[]; correctionPersistence: 'postgresql' | 'memory'
  policy: { identityBoundary: 'ANY_OBSERVED_ORDER_OR_RECIPE_CHANGE'; temporaryIdentityGaps: 'MISSING_TIME_WITHOUT_NEW_OCCURRENCE'; repeatedIdentity: 'GROUPED_OCCURRENCES'; operatorReview: 'LATEST_REVIEW_OVERRIDES_PREDICTION'; routineAndUncertain: 'DOWNTIME'; badOrUnavailableEvidence: 'MISSING_DATA' }
}
