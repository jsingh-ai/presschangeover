import type { RadiusPressKey } from '../radius/models.js'

export type IndustrialAnalysisFamily =
  | 'baseline_deviation'
  | 'robust_numeric_change'
  | 'event_aligned_change'
  | 'value_state_transition'
  | 'radius_sequence_deviation'
  | 'numeric_relationship'
  | 'cross_press_comparison'

export type IndustrialMetricValue = string | number | boolean | null

export interface IndustrialObservationSupport {
  sampleCount: number
  comparisonSampleCount: number | null
  coveragePercent: number | null
  comparisonCoveragePercent: number | null
  adequate: boolean
  minimumRequired: number
  reason: string | null
}

export interface IndustrialAnalyticalObservation {
  observationId: string
  family: IndustrialAnalysisFamily
  pressKey: RadiusPressKey
  deckNumber: number | null
  range: { start: string; end: string }
  comparisonRange: { start: string; end: string } | null
  eventId: string | null
  variableIds: string[]
  factIds: string[]
  metrics: Record<string, IndustrialMetricValue>
  support: IndustrialObservationSupport
  evidenceSource: 'radius' | 'telemetry' | 'production_context' | 'comparison'
  magnitudeInputs: Record<string, number | null>
  material: boolean
  limitations: string[]
  explorer: { href: string; label: string } | null
}

export interface IndustrialNumericSample {
  atUtc: string
  value: number
  qualityState?: string
}

export interface IndustrialStateSample {
  atUtc: string
  value: string | number | boolean
  qualityState?: string
}

export interface IndustrialNumericStats {
  count: number
  minimum: number
  maximum: number
  median: number
  mean: number
  range: number
  standardDeviation: number
  mad: number | null
  startEndDelta: number
  largestDelta: number
  slopePerMinute: number
  volatility: number
}

export interface IndustrialBaselineMetricInput {
  metricId: string
  label: string
  unit: string | null
  current: number | null
  baseline: number | null
  materialDelta: number
  currentFactId: string
  baselineFactId: string
  deltaFactId: string
  sampleCount?: number
  comparisonSampleCount?: number
}

export interface IndustrialSequenceEpisode {
  episodeId: string
  startUtc: string
  endUtc: string
  orderedStates: Array<{ state: string; durationSeconds: number }>
  returnAttempts: number
}

export interface IndustrialRelationshipResult {
  pearson: number
  spearman: number
  bestLagMinutes: number
  bestLagCorrelation: number
  sampleCount: number
  coveragePercent: number
}
