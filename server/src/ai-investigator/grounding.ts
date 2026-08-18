import type { RadiusPressKey } from '../radius/models.js'
import type { AiGroundingFact, AiInvestigatorContent, AiInvestigatorDraftContent, AiInvestigatorDraftFinding, AiInvestigatorFinding, AiInvestigatorRequest } from './contracts.js'

export interface GroundingIssue { findingRank: number; code: string; detail: string }
export interface GroundingResult { content: AiInvestigatorContent; issues: GroundingIssue[]; acceptedRanks: number[]; omitted: number }

const COMPLETE_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/
const FLAT_LANGUAGE = /\b(?:flat|unchanged|stable|no (?:meaningful|material|significant) change|essentially (?:flat|unchanged|stable))\b/i
const NUMERIC_CLAIM = /[-+]?\d+(?:\.\d+)?/g

function displayPress(pressKey: RadiusPressKey): string { return pressKey.replace('press', 'Press ') }
function validUtc(value: string): boolean { return COMPLETE_UTC.test(value) && Number.isFinite(Date.parse(value)) }
function signed(value: number): string { return `${value > 0 ? '+' : ''}${value}` }

function formatValue(fact: AiGroundingFact): string {
  if (!fact.usable || fact.value === null) return 'Unavailable'
  if (typeof fact.value === 'boolean') return fact.value ? 'Yes' : 'No'
  if (typeof fact.value === 'string') return fact.value
  if (fact.unit === 'percent') return `${fact.value}%`
  if (fact.unit === 'percentage_points') return `${signed(fact.value)} percentage points`
  if (fact.unit === 'minutes') return `${fact.role === 'delta' ? signed(fact.value) : fact.value} min`
  if (fact.unit === 'count') return fact.role === 'delta' ? signed(fact.value) : String(fact.value)
  return fact.unit ? `${fact.value} ${fact.unit}` : String(fact.value)
}

function comparisonText(facts: AiGroundingFact[]): string {
  const current = facts.find((fact) => fact.role === 'current')
  const baseline = facts.find((fact) => fact.role === 'baseline')
  const delta = facts.find((fact) => fact.role === 'delta')
  if (current && baseline && delta) return `Current ${formatValue(current)}; baseline ${formatValue(baseline)}; change ${formatValue(delta)}`
  if (baseline && current) return `Current ${formatValue(current)}; baseline ${formatValue(baseline)}`
  if (delta) return `Change ${formatValue(delta)}`
  return ''
}

function materiallyChanged(facts: AiGroundingFact[]): boolean {
  return facts.some((fact) => {
    if (fact.role !== 'delta' || typeof fact.value !== 'number') return false
    const value = Math.abs(fact.value)
    return fact.metric === 'productionPercentagePointDelta' ? value >= 5
      : fact.metric === 'interruptionDelta' ? value >= 3
        : fact.metric === 'longestInterruptionDeltaMinutes' ? value >= 60
          : false
  })
}

function numericClaimsGrounded(text: string, facts: AiGroundingFact[]): boolean {
  const claims = [...text.matchAll(NUMERIC_CLAIM)].map((match) => Number(match[0]))
  const evidenceValues = facts.flatMap((fact) => typeof fact.value === 'number' ? [fact.value] : [])
  return claims.every((claim) => evidenceValues.some((value) => Math.abs(value - claim) <= 0.05))
}

function comparisonGroupValid(facts: AiGroundingFact[]): boolean {
  const current = facts.find((fact) => fact.role === 'current')
  const baseline = facts.find((fact) => fact.role === 'baseline')
  const delta = facts.find((fact) => fact.role === 'delta')
  if (current && baseline && current.metric !== baseline.metric) return false
  if (!delta || !current) return true
  const expectedDelta: Record<string, string> = {
    productionPercent: 'productionPercentagePointDelta',
    interruptions: 'interruptionDelta',
    longestInterruptionMinutes: 'longestInterruptionDeltaMinutes',
    radiusDriverDurationMinutes: 'radiusDriverDurationDeltaMinutes',
    radiusDriverOccurrences: 'radiusDriverOccurrenceDelta',
  }
  return expectedDelta[current.metric] === delta.metric
}

function withinEvidenceTime(fact: AiGroundingFact, request: AiInvestigatorRequest): boolean {
  const timestamps = [fact.timestamp, fact.range?.start, fact.range?.end].filter((value): value is string => Boolean(value))
  if (!timestamps.length || timestamps.some((value) => !validUtc(value))) return false
  if (fact.range && Date.parse(fact.range.end) < Date.parse(fact.range.start)) return false
  if (!fact.timestamp) return true
  const point = Date.parse(fact.timestamp)
  const inRequest = point >= Date.parse(request.range.startUtc) && point <= Date.parse(request.range.endUtc)
  const inContext = fact.range ? point >= Date.parse(fact.range.start) && point <= Date.parse(fact.range.end) : false
  return inRequest || inContext
}

function resolveFinding(candidate: AiInvestigatorDraftFinding, factMap: Map<string, AiGroundingFact>, request: AiInvestigatorRequest): { finding?: AiInvestigatorFinding; issues: GroundingIssue[] } {
  const issues: GroundingIssue[] = []
  const usedIds = new Set<string>()
  for (const group of candidate.facts) group.factIds.forEach((id) => usedIds.add(id))
  candidate.timestampFactIds.forEach((id) => usedIds.add(id))
  candidate.evidenceFactIds.forEach((id) => usedIds.add(id))
  Object.values(candidate.productionContextFactIds).forEach((id) => { if (id) usedIds.add(id) })

  for (const id of usedIds) {
    const fact = factMap.get(id)
    if (!fact) issues.push({ findingRank: candidate.rank, code: 'unknown_fact_id', detail: id })
    else if (fact.pressKey !== candidate.pressKey) issues.push({ findingRank: candidate.rank, code: 'cross_press_fact', detail: id })
    else if (!fact.usable) issues.push({ findingRank: candidate.rank, code: 'unusable_fact', detail: id })
  }
  if (issues.length) return { issues }

  const selected = [...usedIds].map((id) => factMap.get(id)!)
  for (const group of candidate.facts) {
    const grouped = group.factIds.map((id) => factMap.get(id)!)
    if (!comparisonGroupValid(grouped)) issues.push({ findingRank: candidate.rank, code: 'invalid_comparison_group', detail: group.label })
  }
  if (!numericClaimsGrounded(`${candidate.title} ${candidate.whyItMatters}`, selected)) issues.push({ findingRank: candidate.rank, code: 'unsupported_numeric_claim', detail: 'Numeric prose did not match a selected deterministic fact.' })
  if (FLAT_LANGUAGE.test(`${candidate.title} ${candidate.whyItMatters}`) && materiallyChanged(selected)) issues.push({ findingRank: candidate.rank, code: 'interpretation_contradiction', detail: 'Flat/stable language contradicts a material selected comparison.' })

  const timestamps = candidate.timestampFactIds.flatMap((id) => {
    const fact = factMap.get(id)!
    if (!withinEvidenceTime(fact, request)) { issues.push({ findingRank: candidate.rank, code: 'invalid_grounded_timestamp', detail: id }); return [] }
    const start = fact.timestamp ?? fact.range!.start
    const end = fact.timestamp ? null : fact.range!.end
    return [{ label: fact.label, start, end }]
  })

  const context: Record<'job' | 'order' | 'recipe', string> = { job: '', order: '', recipe: '' }
  for (const field of ['job', 'order', 'recipe'] as const) {
    const id = candidate.productionContextFactIds[field]
    if (!id) continue
    const fact = factMap.get(id)!
    if (fact.source !== 'production_context' || fact.metric !== field) issues.push({ findingRank: candidate.rank, code: 'invalid_context_source', detail: id })
    else context[field] = formatValue(fact)
  }

  if (issues.length) return { issues }
  const facts = candidate.facts.map((group) => {
    const grounded = group.factIds.map((id) => factMap.get(id)!)
    const primary = grounded.find((fact) => fact.role === 'current') ?? grounded.find((fact) => fact.role !== 'delta') ?? grounded[0]
    return { label: group.label, value: formatValue(primary), comparison: comparisonText(grounded) }
  })
  const radiusEvidence: string[] = []
  const telemetryEvidence: string[] = []
  for (const id of candidate.evidenceFactIds) {
    const fact = factMap.get(id)!
    const rendered = `${fact.label}: ${formatValue(fact)}`
    if (fact.source === 'radius') radiusEvidence.push(rendered)
    else if (fact.source === 'telemetry') telemetryEvidence.push(rendered)
  }
  return { issues: [], finding: { rank: candidate.rank, press: displayPress(candidate.pressKey), title: candidate.title, importance: candidate.importance, confidence: candidate.confidence, whyItMatters: candidate.whyItMatters, facts, timestamps, radiusEvidence: [...new Set(radiusEvidence)], telemetryEvidence: [...new Set(telemetryEvidence)], productionContext: context, recommendedInvestigation: candidate.recommendedInvestigation, links: candidate.links } }
}

export function groundAiInvestigatorDraft(draft: AiInvestigatorDraftContent, facts: AiGroundingFact[], request: AiInvestigatorRequest, tables: AiInvestigatorContent['tables'] = []): GroundingResult {
  const factMap = new Map(facts.map((fact) => [fact.factId, fact]))
  const findings: AiInvestigatorFinding[] = []; const issues: GroundingIssue[] = []; const acceptedRanks: number[] = []
  for (const candidate of draft.findings) {
    const grounded = resolveFinding(candidate, factMap, request)
    issues.push(...grounded.issues)
    if (grounded.finding) { findings.push(grounded.finding); acceptedRanks.push(candidate.rank) }
  }
  const summary = NUMERIC_CLAIM.test(draft.summary) ? 'Grounded findings were reconstructed from deterministic ProcessIntelligence evidence.' : draft.summary
  NUMERIC_CLAIM.lastIndex = 0
  return { content: { summary, findings, tables, limitations: draft.limitations }, issues, acceptedRanks, omitted: draft.findings.length - findings.length }
}
