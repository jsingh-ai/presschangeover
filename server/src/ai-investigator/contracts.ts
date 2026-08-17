import { RADIUS_PRESS_KEYS, type RadiusPressKey } from '../radius/models.js'

export const AI_INVESTIGATOR_MAX_RANGE_MS = 7 * 24 * 60 * 60_000
export const AI_INVESTIGATOR_ANALYSES = ['discover_unusual_behavior'] as const
export type AiInvestigatorAnalysis = (typeof AI_INVESTIGATOR_ANALYSES)[number]
export type AiInvestigatorStatus = 'complete' | 'partial' | 'timeout' | 'error'

export interface AiInvestigatorRequest {
  scope: { pressKey: RadiusPressKey | null }
  range: { startUtc: string; endUtc: string }
  analysis: AiInvestigatorAnalysis
}

export interface AiInvestigatorLink {
  label: string
  href: string
}

export interface AiInvestigatorFinding {
  rank: number
  press: string
  title: string
  importance: 'high' | 'medium' | 'low'
  confidence: 'high' | 'medium' | 'low'
  whyItMatters: string
  facts: Array<{ label: string; value: string; comparison: string }>
  timestamps: string[]
  radiusEvidence: string[]
  telemetryEvidence: string[]
  productionContext: { job: string; order: string; recipe: string }
  recommendedInvestigation: string
  links: AiInvestigatorLink[]
}

export interface AiInvestigatorTable {
  title: string
  columns: string[]
  rows: string[][]
}

export interface AiInvestigatorContent {
  summary: string
  findings: AiInvestigatorFinding[]
  tables: AiInvestigatorTable[]
  limitations: string[]
}

export interface AiInvestigatorResult extends AiInvestigatorContent {
  analysisId: string
  status: AiInvestigatorStatus
  scope: AiInvestigatorRequest['scope'] & AiInvestigatorRequest['range'] & { analysis: AiInvestigatorAnalysis }
  startedAt: string
  completedAt: string
  elapsedMs: number
  toolCallsUsed: number
}

export interface AiInvestigatorServerStatus {
  configured: boolean
  enabled: boolean
  model: string
  maximumAnalysisMs: number
  maximumToolMs: number
  maximumToolCalls: number
  maximumToolRounds: number
  maximumParallelTools: number
  presses: Array<{ pressKey: RadiusPressKey; displayName: string }>
  allowedTools: string[]
}

export const AI_INVESTIGATOR_CONTENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'findings', 'tables', 'limitations'],
  properties: {
    summary: { type: 'string', maxLength: 1200 },
    findings: {
      type: 'array', maxItems: 5,
      items: {
        type: 'object', additionalProperties: false,
        required: ['rank', 'press', 'title', 'importance', 'confidence', 'whyItMatters', 'facts', 'timestamps', 'radiusEvidence', 'telemetryEvidence', 'productionContext', 'recommendedInvestigation', 'links'],
        properties: {
          rank: { type: 'integer', minimum: 1, maximum: 5 },
          press: { type: 'string', maxLength: 40 },
          title: { type: 'string', maxLength: 160 },
          importance: { type: 'string', enum: ['high', 'medium', 'low'] },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          whyItMatters: { type: 'string', maxLength: 700 },
          facts: { type: 'array', maxItems: 8, items: { type: 'object', additionalProperties: false, required: ['label', 'value', 'comparison'], properties: { label: { type: 'string', maxLength: 100 }, value: { type: 'string', maxLength: 200 }, comparison: { type: 'string', maxLength: 300 } } } },
          timestamps: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 40 } },
          radiusEvidence: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 300 } },
          telemetryEvidence: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 300 } },
          productionContext: { type: 'object', additionalProperties: false, required: ['job', 'order', 'recipe'], properties: { job: { type: 'string', maxLength: 160 }, order: { type: 'string', maxLength: 160 }, recipe: { type: 'string', maxLength: 160 } } },
          recommendedInvestigation: { type: 'string', maxLength: 600 },
          links: { type: 'array', maxItems: 4, items: { type: 'object', additionalProperties: false, required: ['label', 'href'], properties: { label: { type: 'string', maxLength: 80 }, href: { type: 'string', maxLength: 600 } } } },
        },
      },
    },
    tables: { type: 'array', maxItems: 4, items: { type: 'object', additionalProperties: false, required: ['title', 'columns', 'rows'], properties: { title: { type: 'string', maxLength: 160 }, columns: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string', maxLength: 80 } }, rows: { type: 'array', maxItems: 20, items: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 300 } } } } } },
    limitations: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 500 } },
  },
} as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value).sort(); const sortedExpected = [...expected].sort()
  return keys.length === sortedExpected.length && keys.every((key, index) => key === sortedExpected[index])
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length <= maximum
}

function stringArray(value: unknown, maximumItems: number, maximumLength: number): value is string[] {
  return Array.isArray(value) && value.length <= maximumItems && value.every((item) => boundedString(item, maximumLength))
}

function safeInvestigatorHref(value: string): boolean {
  return /^\/(?:raw-radius-explorer|telemetry-event-explorer|overview|operational-analysis)(?:\?[A-Za-z0-9%&=._:+-]*)?$/.test(value)
}

export function validateAiInvestigatorContent(value: unknown): AiInvestigatorContent {
  if (!isRecord(value) || !exactKeys(value, ['summary', 'findings', 'tables', 'limitations']) || !boundedString(value.summary, 1200) || !Array.isArray(value.findings) || value.findings.length > 5 || !Array.isArray(value.tables) || value.tables.length > 4 || !stringArray(value.limitations, 10, 500)) throw new Error('invalid_investigator_response')
  const findings = value.findings.map((candidate): AiInvestigatorFinding => {
    if (!isRecord(candidate) || !exactKeys(candidate, ['rank', 'press', 'title', 'importance', 'confidence', 'whyItMatters', 'facts', 'timestamps', 'radiusEvidence', 'telemetryEvidence', 'productionContext', 'recommendedInvestigation', 'links']) || !Number.isInteger(candidate.rank) || Number(candidate.rank) < 1 || Number(candidate.rank) > 5 || !boundedString(candidate.press, 40) || !boundedString(candidate.title, 160) || !['high', 'medium', 'low'].includes(String(candidate.importance)) || !['high', 'medium', 'low'].includes(String(candidate.confidence)) || !boundedString(candidate.whyItMatters, 700) || !boundedString(candidate.recommendedInvestigation, 600)) throw new Error('invalid_investigator_response')
    if (!Array.isArray(candidate.facts) || candidate.facts.length > 8 || !candidate.facts.every((fact) => isRecord(fact) && exactKeys(fact, ['label', 'value', 'comparison']) && boundedString(fact.label, 100) && boundedString(fact.value, 200) && boundedString(fact.comparison, 300))) throw new Error('invalid_investigator_response')
    if (!stringArray(candidate.timestamps, 8, 40) || !stringArray(candidate.radiusEvidence, 8, 300) || !stringArray(candidate.telemetryEvidence, 8, 300)) throw new Error('invalid_investigator_response')
    if (!isRecord(candidate.productionContext) || !exactKeys(candidate.productionContext, ['job', 'order', 'recipe']) || !boundedString(candidate.productionContext.job, 160) || !boundedString(candidate.productionContext.order, 160) || !boundedString(candidate.productionContext.recipe, 160)) throw new Error('invalid_investigator_response')
    if (!Array.isArray(candidate.links) || candidate.links.length > 4 || !candidate.links.every((link) => isRecord(link) && exactKeys(link, ['label', 'href']) && boundedString(link.label, 80) && boundedString(link.href, 600) && safeInvestigatorHref(link.href))) throw new Error('invalid_investigator_response')
    return candidate as unknown as AiInvestigatorFinding
  })
  const tables = value.tables.map((candidate): AiInvestigatorTable => {
    if (!isRecord(candidate) || !exactKeys(candidate, ['title', 'columns', 'rows']) || !boundedString(candidate.title, 160) || !stringArray(candidate.columns, 8, 80) || candidate.columns.length < 1 || !Array.isArray(candidate.rows) || candidate.rows.length > 20) throw new Error('invalid_investigator_response')
    const columnCount = candidate.columns.length
    if (!candidate.rows.every((row) => stringArray(row, 8, 300) && row.length === columnCount)) throw new Error('invalid_investigator_response')
    return candidate as unknown as AiInvestigatorTable
  })
  return { summary: value.summary, findings, tables, limitations: value.limitations }
}

export function parseAiInvestigatorRequest(value: unknown): AiInvestigatorRequest {
  if (!isRecord(value) || !isRecord(value.scope) || !isRecord(value.range) || value.analysis !== 'discover_unusual_behavior') throw new Error('invalid_ai_investigator_request')
  const pressKey = value.scope.pressKey
  if (pressKey !== null && (typeof pressKey !== 'string' || !RADIUS_PRESS_KEYS.includes(pressKey as RadiusPressKey))) throw new Error('invalid_ai_investigator_press')
  const startUtc = value.range.startUtc
  const endUtc = value.range.endUtc
  if (typeof startUtc !== 'string' || typeof endUtc !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(startUtc) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(endUtc)) throw new Error('invalid_ai_investigator_range')
  const rangeMs = Date.parse(endUtc) - Date.parse(startUtc)
  if (!Number.isFinite(rangeMs) || rangeMs <= 0 || rangeMs > AI_INVESTIGATOR_MAX_RANGE_MS) throw new Error('invalid_ai_investigator_range')
  return { scope: { pressKey: pressKey as RadiusPressKey | null }, range: { startUtc, endUtc }, analysis: value.analysis }
}
