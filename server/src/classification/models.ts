export const OPERATIONAL_GROUP_KEYS = [
  'PRODUCTION',
  'CHANGEOVER_SETUP',
  'ROUTINE_PROCESS',
  'ADJUSTMENT_QUALITY',
  'WAITING_IDLE_HOLD',
  'FAULT_RECOVERY',
  'MAINTENANCE_INTERVENTION',
  'ADMIN_UNKNOWN',
] as const

export type OperationalGroupKey = (typeof OPERATIONAL_GROUP_KEYS)[number]

export const PROCESS_FAMILY_KEYS = [
  'PRODUCTION', 'MAKE_READY', 'CLEANING_WASH', 'ROLL_MATERIAL',
  'SLEEVES_PLATES', 'ANILOX', 'DOCTOR_BLADE_CHAMBER', 'INK_COLOR',
  'IMPRESSION_REGISTER_PRINT_QUALITY', 'SUBSTRATE', 'WEB_HANDLING_WEB_BREAK',
  'QUALITY_APPROVAL', 'MECHANICAL_ELECTRICAL', 'MAINTENANCE',
  'TRIAL_ADMINISTRATIVE', 'UNKNOWN',
] as const

export type ProcessFamilyKey = (typeof PROCESS_FAMILY_KEYS)[number]
export type MappingConfidence = 'HIGH' | 'MEDIUM' | 'LOW'

export interface OperationalGroup {
  id: string
  key: OperationalGroupKey
  displayName: string
  description: string
  lightColor: string
  darkColor: string
  icon: string
  sortOrder: number
}

export interface ProcessFamily {
  id: string
  key: ProcessFamilyKey
  displayName: string
  description: string
  sortOrder: number
}

export interface RadiusIdentity {
  identity: string
  eventType: string
  statusCode: string | null
  statusDescription: string
}

export interface RadiusStateClassification extends RadiusIdentity {
  operationalGroupId: string
  operationalGroupKey: OperationalGroupKey
  processFamilyId: string
  processFamilyKey: ProcessFamilyKey
  displayLabel: string | null
  explanation: string
  confidence: MappingConfidence
  needsReview: boolean
  defaultTimelineVisibility: boolean
  obsolete: boolean
}

export interface ResolvedRadiusClassification extends RadiusStateClassification {
  operationalGroupName: string
  operationalGroupDescription: string
  operationalGroupLightColor: string
  operationalGroupDarkColor: string
  operationalGroupIcon: string
  processFamilyName: string
  mappingVersion: number
  isFallback: boolean
}

export interface ObservedRadiusIdentity extends RadiusIdentity {
  eventCount: number
  lastSeenUtc: string | null
}

export interface ClassificationDraft {
  baseVersion: number
  revision: number
  updatedAtUtc: string
  updatedBy: string
  groups: OperationalGroup[]
  classifications: RadiusStateClassification[]
  changes: ClassificationAuditChange[]
}

export interface ClassificationSnapshot {
  version: number
  publishedAtUtc: string | null
  publishedBy: string | null
  groups: OperationalGroup[]
  families: ProcessFamily[]
  classifications: RadiusStateClassification[]
}

export interface ClassificationAuditChange {
  action: 'GROUP_PRESENTATION_EDITED' | 'STATE_MAPPING_EDITED' | 'STATE_MOVED' | 'DRAFT_CREATED' | 'DRAFT_DISCARDED' | 'PUBLISHED'
  target: string
  summary: string
  atUtc: string
  actor: string
}

export interface ClassificationVersionSummary {
  version: number
  publishedAtUtc: string
  publishedBy: string
  changeCount: number
}

export interface ClassificationAuditEntry extends ClassificationAuditChange {
  id: string
  version: number | null
}

export interface ClassificationWorkspace {
  published: ClassificationSnapshot
  draft: ClassificationDraft | null
  effectiveGroups: OperationalGroup[]
  effectiveClassifications: Array<RadiusStateClassification & { eventCount: number; lastSeenUtc: string | null; isFallback: boolean }>
  observedIdentities: ObservedRadiusIdentity[]
  families: ProcessFamily[]
  versions: ClassificationVersionSummary[]
  audit: ClassificationAuditEntry[]
  unmappedCount: number
  reviewRequiredCount: number
  canEdit: boolean
  actor: string | null
  persistence: 'postgresql' | 'memory'
}

export interface ClassificationValidation {
  valid: boolean
  errors: string[]
  warnings: string[]
  mappedCount: number
  fallbackCount: number
  reviewRequiredCount: number
}

export interface ClassificationActor {
  id: string
  canEdit: boolean
}
