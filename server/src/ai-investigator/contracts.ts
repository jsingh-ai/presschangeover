import { RADIUS_PRESS_KEYS, type RadiusPressKey } from '../radius/models.js'

export const AI_INVESTIGATOR_MAX_RANGE_MS = 7 * 24 * 60 * 60_000
export const AI_INVESTIGATOR_ANALYSES = ['discover_unusual_behavior'] as const
export type AiInvestigatorAnalysis = (typeof AI_INVESTIGATOR_ANALYSES)[number]
export type AiInvestigatorStatus = 'complete' | 'partial' | 'timeout' | 'error'
export type AiEvidenceSource = 'radius' | 'telemetry' | 'production_context' | 'comparison' | 'coverage'

export interface AiGroundingFact {
  factId: string
  pressKey: RadiusPressKey
  press: string
  source: AiEvidenceSource
  metric: string
  value: string | number | boolean | null
  unit: string | null
  role: 'current' | 'baseline' | 'delta' | 'event'
  usable: boolean
  label: string
  timestamp?: string
  range?: { start: string; end: string }
}

export interface AiInvestigatorRequest {
  scope: { pressKey: RadiusPressKey | null }
  range: { startUtc: string; endUtc: string }
  analysis: AiInvestigatorAnalysis
}

export interface AiInvestigatorLink { label: string; href: string }
export interface AiInvestigatorTimestamp { label: string; start: string; end: string | null }

export interface AiInvestigatorFinding {
  rank: number
  press: string
  title: string
  importance: 'high' | 'medium' | 'low'
  confidence: 'high' | 'medium' | 'low'
  whyItMatters: string
  facts: Array<{ label: string; value: string; comparison: string }>
  timestamps: AiInvestigatorTimestamp[]
  radiusEvidence: string[]
  telemetryEvidence: string[]
  productionContext: { job: string; order: string; recipe: string }
  recommendedInvestigation: string
  links: AiInvestigatorLink[]
}

export interface AiInvestigatorTable { title: string; columns: string[]; rows: string[][] }
export interface AiInvestigatorContent { summary: string; findings: AiInvestigatorFinding[]; tables: AiInvestigatorTable[]; limitations: string[] }

export interface AiInvestigatorGroundingSummary {
  acceptedUnchanged: number
  corrected: number
  omitted: number
  correctionAttempted: boolean
}

export interface AiInvestigatorResult extends AiInvestigatorContent {
  analysisId: string
  status: AiInvestigatorStatus
  scope: AiInvestigatorRequest['scope'] & AiInvestigatorRequest['range'] & { analysis: AiInvestigatorAnalysis }
  startedAt: string
  completedAt: string
  elapsedMs: number
  toolCallsUsed: number
  grounding: AiInvestigatorGroundingSummary
}

export interface AiInvestigatorServerStatus {
  configured: boolean; enabled: boolean; model: string; maximumAnalysisMs: number; maximumToolMs: number
  maximumToolCalls: number; maximumToolRounds: number; maximumParallelTools: number
  presses: Array<{ pressKey: RadiusPressKey; displayName: string }>; allowedTools: string[]
}

export interface AiInvestigatorDraftFinding {
  rank: number
  pressKey: RadiusPressKey
  title: string
  importance: 'high' | 'medium' | 'low'
  confidence: 'high' | 'medium' | 'low'
  whyItMatters: string
  facts: Array<{ label: string; factIds: string[] }>
  timestampFactIds: string[]
  evidenceFactIds: string[]
  productionContextFactIds: { job: string | null; order: string | null; recipe: string | null }
  recommendedInvestigation: string
  links: AiInvestigatorLink[]
}

export interface AiInvestigatorDraftContent {
  summary: string
  findings: AiInvestigatorDraftFinding[]
  limitations: string[]
}

export interface AiInvestigatorDiscoveryDraftFinding {
  rank: number
  pressKey: RadiusPressKey
  title: string
  importance: 'high' | 'medium' | 'low'
  confidence: 'high' | 'medium' | 'low'
  interpretation: string
  factIds: string[]
  recommendedInvestigation: string
}

export interface AiInvestigatorDiscoveryDraftContent {
  summary: string
  findings: AiInvestigatorDiscoveryDraftFinding[]
  limitations: string[]
}

const FACT_ID = { type: 'string', pattern: '^press(?:3|5|6|7|8|9|10|11|12|13|14|15)\\.[a-z0-9_.-]{3,160}$', maxLength: 180 }
const LINK = { type: 'object', additionalProperties: false, required: ['label', 'href'], properties: { label: { type: 'string', maxLength: 80 }, href: { type: 'string', maxLength: 600 } } }

export const AI_INVESTIGATOR_CONTENT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['summary', 'findings', 'limitations'],
  properties: {
    summary: { type: 'string', maxLength: 1200 },
    findings: { type: 'array', maxItems: 5, items: {
      type: 'object', additionalProperties: false,
      required: ['rank', 'pressKey', 'title', 'importance', 'confidence', 'whyItMatters', 'facts', 'timestampFactIds', 'evidenceFactIds', 'productionContextFactIds', 'recommendedInvestigation', 'links'],
      properties: {
        rank: { type: 'integer', minimum: 1, maximum: 5 }, pressKey: { type: 'string', enum: RADIUS_PRESS_KEYS },
        title: { type: 'string', maxLength: 160 }, importance: { type: 'string', enum: ['high', 'medium', 'low'] }, confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        whyItMatters: { type: 'string', maxLength: 700 },
        facts: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'object', additionalProperties: false, required: ['label', 'factIds'], properties: { label: { type: 'string', maxLength: 100 }, factIds: { type: 'array', minItems: 1, maxItems: 4, items: FACT_ID } } } },
        timestampFactIds: { type: 'array', maxItems: 8, items: FACT_ID }, evidenceFactIds: { type: 'array', maxItems: 12, items: FACT_ID },
        productionContextFactIds: { type: 'object', additionalProperties: false, required: ['job', 'order', 'recipe'], properties: { job: { anyOf: [FACT_ID, { type: 'null' }] }, order: { anyOf: [FACT_ID, { type: 'null' }] }, recipe: { anyOf: [FACT_ID, { type: 'null' }] } } },
        recommendedInvestigation: { type: 'string', maxLength: 600 }, links: { type: 'array', maxItems: 4, items: LINK },
      },
    } },
    limitations: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 500 } },
  },
} as const

export const AI_INVESTIGATOR_DISCOVERY_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['summary', 'findings', 'limitations'],
  properties: {
    summary: { type: 'string', maxLength: 900 },
    findings: { type: 'array', maxItems: 5, items: {
      type: 'object', additionalProperties: false,
      required: ['rank', 'pressKey', 'title', 'importance', 'confidence', 'interpretation', 'factIds', 'recommendedInvestigation'],
      properties: {
        rank: { type: 'integer', minimum: 1, maximum: 5 }, pressKey: { type: 'string', enum: RADIUS_PRESS_KEYS },
        title: { type: 'string', maxLength: 140 }, importance: { type: 'string', enum: ['high', 'medium', 'low'] }, confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        interpretation: { type: 'string', maxLength: 500 },
        factIds: { type: 'array', minItems: 1, maxItems: 18, items: FACT_ID },
        recommendedInvestigation: { type: 'string', maxLength: 400 },
      },
    } },
    limitations: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 350 } },
  },
} as const

function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) }
function exactKeys(value: Record<string, unknown>, expected: string[]): boolean { const keys = Object.keys(value).sort(); const sorted = [...expected].sort(); return keys.length === sorted.length && keys.every((key, index) => key === sorted[index]) }
function boundedString(value: unknown, maximum: number): value is string { return typeof value === 'string' && value.length <= maximum }
function stringArray(value: unknown, maximumItems: number, maximumLength: number): value is string[] { return Array.isArray(value) && value.length <= maximumItems && value.every((item) => boundedString(item, maximumLength)) }
function factId(value: unknown): value is string { return boundedString(value, 180) && /^press(?:3|5|6|7|8|9|10|11|12|13|14|15)\.[a-z0-9_.-]{3,160}$/.test(value) }
function safeInvestigatorHref(value: string): boolean { return /^\/(?:raw-radius-explorer|telemetry-event-explorer|overview|operational-analysis)(?:\?[A-Za-z0-9%&=._:+-]*)?$/.test(value) }

export function validateAiInvestigatorDraft(value: unknown): AiInvestigatorDraftContent {
  if (!isRecord(value) || !exactKeys(value, ['summary', 'findings', 'limitations']) || !boundedString(value.summary, 1200) || !Array.isArray(value.findings) || value.findings.length > 5 || !stringArray(value.limitations, 10, 500)) throw new Error('invalid_investigator_response')
  const findings = value.findings.map((candidate): AiInvestigatorDraftFinding => {
    if (!isRecord(candidate) || !exactKeys(candidate, ['rank', 'pressKey', 'title', 'importance', 'confidence', 'whyItMatters', 'facts', 'timestampFactIds', 'evidenceFactIds', 'productionContextFactIds', 'recommendedInvestigation', 'links'])) throw new Error('invalid_investigator_response')
    if (!Number.isInteger(candidate.rank) || Number(candidate.rank) < 1 || Number(candidate.rank) > 5 || typeof candidate.pressKey !== 'string' || !RADIUS_PRESS_KEYS.includes(candidate.pressKey as RadiusPressKey) || !boundedString(candidate.title, 160) || !['high', 'medium', 'low'].includes(String(candidate.importance)) || !['high', 'medium', 'low'].includes(String(candidate.confidence)) || !boundedString(candidate.whyItMatters, 700) || !boundedString(candidate.recommendedInvestigation, 600)) throw new Error('invalid_investigator_response')
    if (!Array.isArray(candidate.facts) || candidate.facts.length < 1 || candidate.facts.length > 8 || !candidate.facts.every((item) => isRecord(item) && exactKeys(item, ['label', 'factIds']) && boundedString(item.label, 100) && Array.isArray(item.factIds) && item.factIds.length > 0 && item.factIds.length <= 4 && item.factIds.every(factId))) throw new Error('invalid_investigator_response')
    if (!Array.isArray(candidate.timestampFactIds) || candidate.timestampFactIds.length > 8 || !candidate.timestampFactIds.every(factId) || !Array.isArray(candidate.evidenceFactIds) || candidate.evidenceFactIds.length > 12 || !candidate.evidenceFactIds.every(factId)) throw new Error('invalid_investigator_response')
    if (!isRecord(candidate.productionContextFactIds) || !exactKeys(candidate.productionContextFactIds, ['job', 'order', 'recipe']) || !Object.values(candidate.productionContextFactIds).every((item) => item === null || factId(item))) throw new Error('invalid_investigator_response')
    if (!Array.isArray(candidate.links) || candidate.links.length > 4 || !candidate.links.every((link) => isRecord(link) && exactKeys(link, ['label', 'href']) && boundedString(link.label, 80) && boundedString(link.href, 600) && safeInvestigatorHref(link.href))) throw new Error('invalid_investigator_response')
    return candidate as unknown as AiInvestigatorDraftFinding
  })
  return { summary: value.summary, findings, limitations: value.limitations }
}

export function validateAiInvestigatorDiscoveryDraft(value: unknown): AiInvestigatorDiscoveryDraftContent {
  if (!isRecord(value) || !exactKeys(value, ['summary', 'findings', 'limitations']) || !boundedString(value.summary, 900) || !Array.isArray(value.findings) || value.findings.length > 5 || !stringArray(value.limitations, 8, 350)) throw new Error('invalid_investigator_response')
  const findings = value.findings.map((candidate): AiInvestigatorDiscoveryDraftFinding => {
    if (!isRecord(candidate) || !exactKeys(candidate, ['rank', 'pressKey', 'title', 'importance', 'confidence', 'interpretation', 'factIds', 'recommendedInvestigation'])) throw new Error('invalid_investigator_response')
    if (!Number.isInteger(candidate.rank) || Number(candidate.rank) < 1 || Number(candidate.rank) > 5 || typeof candidate.pressKey !== 'string' || !RADIUS_PRESS_KEYS.includes(candidate.pressKey as RadiusPressKey) || !boundedString(candidate.title, 140) || !['high', 'medium', 'low'].includes(String(candidate.importance)) || !['high', 'medium', 'low'].includes(String(candidate.confidence)) || !boundedString(candidate.interpretation, 500) || !boundedString(candidate.recommendedInvestigation, 400)) throw new Error('invalid_investigator_response')
    if (!Array.isArray(candidate.factIds) || candidate.factIds.length < 1 || candidate.factIds.length > 18 || !candidate.factIds.every(factId)) throw new Error('invalid_investigator_response')
    return candidate as unknown as AiInvestigatorDiscoveryDraftFinding
  })
  return { summary: value.summary, findings, limitations: value.limitations }
}

export function parseAiInvestigatorRequest(value: unknown): AiInvestigatorRequest {
  if (!isRecord(value) || !isRecord(value.scope) || !isRecord(value.range) || value.analysis !== 'discover_unusual_behavior') throw new Error('invalid_ai_investigator_request')
  const pressKey = value.scope.pressKey
  if (pressKey !== null && (typeof pressKey !== 'string' || !RADIUS_PRESS_KEYS.includes(pressKey as RadiusPressKey))) throw new Error('invalid_ai_investigator_press')
  const startUtc = value.range.startUtc; const endUtc = value.range.endUtc
  if (typeof startUtc !== 'string' || typeof endUtc !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(startUtc) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(endUtc)) throw new Error('invalid_ai_investigator_range')
  const rangeMs = Date.parse(endUtc) - Date.parse(startUtc)
  if (!Number.isFinite(rangeMs) || rangeMs <= 0 || rangeMs > AI_INVESTIGATOR_MAX_RANGE_MS) throw new Error('invalid_ai_investigator_range')
  return { scope: { pressKey: pressKey as RadiusPressKey | null }, range: { startUtc, endUtc }, analysis: value.analysis }
}
