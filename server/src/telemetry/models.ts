export const PHYSICAL_STATES = [
  'RUNNING',
  'STOPPED',
  'TRANSITION',
  'UNKNOWN',
] as const

export type PhysicalState = (typeof PHYSICAL_STATES)[number]

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

export interface TelemetryHealth {
  service: string
  status: string
}

export interface TelemetryDatabaseHealth {
  service: string
  database: string
  status: string
  user?: string
}

export interface TelemetrySource {
  id: number
  sourceKey: string
  displayName: string
  enabled: boolean
}

export interface PhysicalStateSegment {
  state: PhysicalState
  fromUtc: string
  toUtc: string
  durationMs: number
  durationSeconds?: number
  actualSpeedAtStart?: number | null
  targetSpeedAtStart?: number | null
  targetCommanded?: boolean | null
  reason?: string
}

export interface PhysicalStateSummary {
  durationsMs: Record<PhysicalState, number>
  durationsSeconds?: Record<PhysicalState, number>
  segmentCount: number
}

export interface PhysicalStateResponse {
  sourceId: number
  sourceKey: string
  displayName: string
  fromUtc: string
  toUtc: string
  policy: { [key: string]: JsonValue }
  summary: PhysicalStateSummary
  segments: PhysicalStateSegment[]
}
