import type { RadiusPressKey } from '../radius/models.js'
import type { AiGroundingFact, AiInvestigatorDiscoveryDraftContent, AiInvestigatorDraftContent, AiInvestigatorRequest } from './contracts.js'
import type { AiInvestigatorToolExecutor, AiToolResult } from './read-only-tools.js'

export const DISCOVERY_CANDIDATE_LIMIT = 5
export const DISCOVERY_EVENT_LIMIT = 3
export const DISCOVERY_OUTPUT_TOKENS = 1_400
export const DISCOVERY_PROMPT_CACHE_KEY = 'processintelligence-discovery-v1'
export const DISCOVERY_INSTRUCTIONS = `You are the advisory ProcessIntelligence AI Investigator. Rank only supplied deterministic candidates. Supplied fact ids and values are authoritative; never invent, recalculate, or contradict them. For material comparisons select the current, baseline, and delta ids together. Treat unusable facts and low coverage as limitations. Radius states are drivers to investigate, not proven causes. Return at most five findings, one per press, using concise operational language. Do not claim control, database, historian, filesystem, network, configuration, acknowledgement, or root-cause access. No HTML.`

interface FleetRow {
  pressKey: RadiusPressKey
  press: string
  coveragePercent: number | null
  productionPercent: number | null
  productionInterruptions: number
  longestInterruptionMinutes: number | null
}

export interface DiscoveryCandidate {
  pressKey: RadiusPressKey
  press: string
  signalCount: number
  productionDelta: number | null
  interruptionDelta: number
  longestDelta: number | null
  facts: AiGroundingFact[]
}

export interface DiscoveryPreflight {
  evidence: Array<{ name: string; arguments: unknown; result: AiToolResult; durationMs: number }>
  facts: AiGroundingFact[]
  candidates: DiscoveryCandidate[]
  eligiblePresses: RadiusPressKey[]
  excludedPresses: RadiusPressKey[]
  limitations: string[]
  modelInput: Record<string, unknown>
}

function round(value: number): number { return Math.round(value * 10) / 10 }
function numberOrNull(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) ? value : null }
function rows(result: AiToolResult): FleetRow[] {
  if (!Array.isArray(result.presses)) return []
  return result.presses.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return []
    const row = raw as Record<string, unknown>
    if (typeof row.pressKey !== 'string' || typeof row.press !== 'string' || typeof row.productionInterruptions !== 'number') return []
    return [{ pressKey: row.pressKey as RadiusPressKey, press: row.press, coveragePercent: numberOrNull(row.coveragePercent), productionPercent: numberOrNull(row.productionPercent), productionInterruptions: row.productionInterruptions, longestInterruptionMinutes: numberOrNull(row.longestInterruptionMinutes) }]
  })
}

function facts(result: AiToolResult): AiGroundingFact[] {
  return Array.isArray(result.facts) ? result.facts.filter((item): item is AiGroundingFact => Boolean(item) && typeof item === 'object' && typeof (item as AiGroundingFact).factId === 'string') : []
}

function baselineFact(fact: AiGroundingFact, range: { start: string; end: string }): AiGroundingFact {
  return { ...fact, factId: fact.factId.replace(/\.current$/, '.baseline'), role: 'baseline', range }
}

function deltaFact(current: FleetRow, metric: 'production' | 'interruptions' | 'longest', value: number | null, range: { start: string; end: string }): AiGroundingFact {
  const attributes = metric === 'production'
    ? ['productionPercentagePointDelta', 'percentage_points', 'Production time change', 'production_percent.delta']
    : metric === 'interruptions'
      ? ['interruptionDelta', 'count', 'Interruption change', 'interruptions.delta']
      : ['longestInterruptionDeltaMinutes', 'minutes', 'Longest interruption change', 'longest_interruption_minutes.delta']
  return { factId: `${current.pressKey}.${attributes[3]}`, pressKey: current.pressKey, press: current.press, source: 'comparison', metric: attributes[0], value, unit: attributes[1], role: 'delta', usable: value !== null, label: attributes[2], range }
}

function uniqueFacts(input: AiGroundingFact[]): AiGroundingFact[] {
  const found = new Map<string, AiGroundingFact>()
  for (const fact of input) if (!found.has(fact.factId)) found.set(fact.factId, fact)
  return [...found.values()]
}

function selectFacts(pressKey: RadiusPressKey, all: AiGroundingFact[]): AiGroundingFact[] {
  const matching = all.filter((fact) => fact.pressKey === pressKey && fact.usable)
  const core = matching.filter((fact) => ['coveragePercent', 'productionPercent', 'productionPercentagePointDelta', 'interruptions', 'interruptionDelta', 'longestInterruptionMinutes', 'longestInterruptionDeltaMinutes'].includes(fact.metric))
  const drivers = (role: AiGroundingFact['role']) => matching.filter((fact) => fact.metric === 'radiusDriverDurationMinutes' && fact.role === role).slice(0, 3)
  const eventPairs = matching.filter((fact) => ['eventTimestamp', 'eventDurationMinutes'].includes(fact.metric)).slice(0, DISCOVERY_EVENT_LIMIT * 2)
  const context = ['job', 'order', 'recipe'].flatMap((metric) => matching.filter((fact) => fact.source === 'production_context' && fact.metric === metric).slice(0, 1))
  return uniqueFacts([...core, ...drivers('current'), ...drivers('baseline'), ...eventPairs, ...context])
}

function compactModelInput(request: AiInvestigatorRequest, current: { start: string; end: string }, baseline: { start: string; end: string }, candidates: DiscoveryCandidate[], eligible: RadiusPressKey[], excluded: RadiusPressKey[], limit: number, limitations: string[]) {
  const units: Array<string | null> = [null]; const roles: AiGroundingFact['role'][] = ['current', 'baseline', 'delta', 'event']; const sources = ['radius', 'telemetry', 'production_context', 'comparison', 'coverage']
  const unitIndex = (unit: string | null) => { const found = units.indexOf(unit); if (found >= 0) return found; units.push(unit); return units.length - 1 }
  return {
    version: 1,
    task: 'rank_supplied_candidates',
    scope: request.scope.pressKey ?? 'all',
    ranges: { current: [current.start, current.end], baseline: [baseline.start, baseline.end] },
    selection: { eligible, excluded, selected: candidates.map((candidate) => candidate.pressKey), limit, rule: 'coverage>=80 both periods; rank by material signal count, |production pp delta|, |interruption delta|, |longest delta|, press number' },
    factColumns: ['id', 'metric', 'value', 'unitIndex', 'roleIndex', 'sourceIndex', 'timestamp', 'label'],
    dictionary: { units, roles, sources },
    candidates: candidates.map((candidate) => ({ press: candidate.pressKey, score: [candidate.signalCount, candidate.productionDelta, candidate.interruptionDelta, candidate.longestDelta], facts: candidate.facts.map((fact) => [fact.factId, fact.metric, fact.value, unitIndex(fact.unit), roles.indexOf(fact.role), sources.indexOf(fact.source), fact.timestamp ?? null, fact.label]) })),
    limitations,
  }
}

export async function buildDiscoveryPreflight(executor: AiInvestigatorToolExecutor, request: AiInvestigatorRequest, signal: AbortSignal, options: { candidateLimit?: number; requestId?: string; maxParallelTools?: number; toolTimeoutMs?: number } = {}): Promise<DiscoveryPreflight> {
  const duration = Date.parse(request.range.endUtc) - Date.parse(request.range.startUtc)
  const current = { start: request.range.startUtc, end: request.range.endUtc }
  const baseline = { start: new Date(Date.parse(current.start) - duration).toISOString(), end: current.start }
  const scope = request.scope.pressKey
  const evidence: DiscoveryPreflight['evidence'] = []
  const execute = async (name: string, args: unknown) => {
    const began = Date.now(); const controller = new AbortController(); const toolSignal = AbortSignal.any([signal, controller.signal])
    const timer = options.toolTimeoutMs ? setTimeout(() => controller.abort(new Error('ai_tool_timeout')), options.toolTimeoutMs) : undefined
    try {
      const operation = executor.execute(name, args, { requestId: options.requestId ?? 'offline-discovery', signal: toolSignal })
      const result = await Promise.race([operation, new Promise<never>((_resolve, reject) => toolSignal.addEventListener('abort', () => reject(toolSignal.reason ?? new Error('ai_tool_timeout')), { once: true }))])
      return { name, arguments: args, result, durationMs: Date.now() - began }
    } finally { if (timer) clearTimeout(timer) }
  }
  const [currentEvidence, baselineEvidence] = await Promise.all([
    execute('get_fleet_operational_summary', { start: current.start, end: current.end, press: scope }),
    execute('get_fleet_operational_summary', { start: baseline.start, end: baseline.end, press: scope }),
  ])
  evidence.push(currentEvidence, baselineEvidence)
  const currentResult = currentEvidence.result; const baselineResult = baselineEvidence.result
  const currentRows = rows(currentResult); const baselineRows = new Map(rows(baselineResult).map((row) => [row.pressKey, row]))
  const candidateRows = currentRows.flatMap((row) => {
    const previous = baselineRows.get(row.pressKey); if (!previous) return []
    const productionDelta = row.productionPercent === null || previous.productionPercent === null ? null : round(row.productionPercent - previous.productionPercent)
    const interruptionDelta = row.productionInterruptions - previous.productionInterruptions
    const longestDelta = row.longestInterruptionMinutes === null || previous.longestInterruptionMinutes === null ? null : round(row.longestInterruptionMinutes - previous.longestInterruptionMinutes)
    const signalCount = Number(productionDelta !== null && Math.abs(productionDelta) >= 5) + Number(Math.abs(interruptionDelta) >= 3) + Number(longestDelta !== null && Math.abs(longestDelta) >= 60)
    return [{ row, previous, productionDelta, interruptionDelta, longestDelta, signalCount }]
  })
  const eligible = candidateRows.filter(({ row, previous }) => scope !== null || (row.coveragePercent ?? 0) >= 80 && (previous.coveragePercent ?? 0) >= 80)
  eligible.sort((left, right) => right.signalCount - left.signalCount || Math.abs(right.productionDelta ?? 0) - Math.abs(left.productionDelta ?? 0) || Math.abs(right.interruptionDelta) - Math.abs(left.interruptionDelta) || Math.abs(right.longestDelta ?? 0) - Math.abs(left.longestDelta ?? 0) || Number(left.row.pressKey.slice(5)) - Number(right.row.pressKey.slice(5)))
  const limit = Math.max(0, Math.min(12, options.candidateLimit ?? (scope ? 1 : DISCOVERY_CANDIDATE_LIMIT)))
  const selected = eligible.slice(0, limit)
  const eventEvidence: DiscoveryPreflight['evidence'] = []; const parallel = Math.max(1, options.maxParallelTools ?? 3)
  for (let offset = 0; offset < selected.length; offset += parallel) eventEvidence.push(...await Promise.all(selected.slice(offset, offset + parallel).map(({ row }) => execute('get_press_event_summary', { press: row.pressKey, start: current.start, end: current.end, topN: DISCOVERY_EVENT_LIMIT }))))
  evidence.push(...eventEvidence)
  const eventResults = eventEvidence.map((item) => item.result)
  const baseFacts = [
    ...facts(currentResult),
    ...facts(baselineResult).map((fact) => baselineFact(fact, baseline)),
    ...selected.flatMap(({ row, productionDelta, interruptionDelta, longestDelta }) => [deltaFact(row, 'production', productionDelta, current), deltaFact(row, 'interruptions', interruptionDelta, current), deltaFact(row, 'longest', longestDelta, current)]),
    ...eventResults.flatMap(facts),
  ]
  const allFacts = uniqueFacts(baseFacts)
  const candidates: DiscoveryCandidate[] = selected.map(({ row, productionDelta, interruptionDelta, longestDelta, signalCount }) => ({ pressKey: row.pressKey, press: row.press, signalCount, productionDelta, interruptionDelta, longestDelta, facts: selectFacts(row.pressKey, allFacts) }))
  const eligiblePresses = eligible.map(({ row }) => row.pressKey); const excludedPresses = candidateRows.filter((item) => !eligible.includes(item)).map(({ row }) => row.pressKey)
  const limitations = uniqueStrings([
    ...extractLimitations(currentResult), ...extractLimitations(baselineResult), ...eventResults.flatMap(extractLimitations),
    ...(excludedPresses.length ? [`Excluded for less than 80% coverage in current or baseline: ${excludedPresses.join(', ')}.`] : []),
    ...(scope && eligible.some(({ row, previous }) => (row.coveragePercent ?? 0) < 80 || (previous.coveragePercent ?? 0) < 80) ? ['The selected press has less than 80% coverage in the current or baseline period.'] : []),
    ...(eligible.length > selected.length ? [`Detailed evidence was bounded to the top ${selected.length} of ${eligible.length} eligible presses.`] : []),
  ])
  const selectedFacts = uniqueFacts(candidates.flatMap((candidate) => candidate.facts))
  return { evidence, facts: selectedFacts, candidates, eligiblePresses, excludedPresses, limitations, modelInput: compactModelInput(request, current, baseline, candidates, eligiblePresses, excludedPresses, limit, limitations) }
}

function extractLimitations(result: AiToolResult): string[] { return Array.isArray(result.limitations) ? result.limitations.filter((item): item is string => typeof item === 'string') : [] }
function uniqueStrings(values: string[]): string[] { return [...new Set(values)] }

function groupKey(fact: AiGroundingFact): string {
  return fact.factId.replace(/\.(?:current|baseline|delta)$/, '').replace(/\.(?:timestamp|duration_minutes)$/, '')
}

export function expandDiscoveryDraft(draft: AiInvestigatorDiscoveryDraftContent, availableFacts: AiGroundingFact[]): AiInvestigatorDraftContent {
  const factMap = new Map(availableFacts.map((fact) => [fact.factId, fact]))
  return {
    summary: draft.summary,
    findings: draft.findings.map((finding) => {
      const requested = uniqueStrings(finding.factIds).flatMap((id) => factMap.get(id) ? [factMap.get(id)!] : [])
      const unknownIds = uniqueStrings(finding.factIds).filter((id) => !factMap.has(id))
      const comparisonGroups = new Set(requested.filter((fact) => fact.role === 'delta').map(groupKey))
      const selected = uniqueFacts([...requested, ...availableFacts.filter((fact) => fact.pressKey === finding.pressKey && comparisonGroups.has(groupKey(fact)) && ['current', 'baseline', 'delta'].includes(fact.role))])
      const grouped = new Map<string, AiGroundingFact[]>()
      for (const fact of selected) { const key = groupKey(fact); grouped.set(key, [...(grouped.get(key) ?? []), fact]) }
      const contextId = (metric: string) => selected.find((fact) => fact.source === 'production_context' && fact.metric === metric && fact.usable)?.factId ?? null
      return {
        rank: finding.rank, pressKey: finding.pressKey, title: finding.title, importance: finding.importance, confidence: finding.confidence,
        whyItMatters: finding.interpretation,
        facts: [...grouped.values()].slice(0, 8).map((group) => ({ label: group[0].label, factIds: group.map((fact) => fact.factId).slice(0, 4) })).concat(unknownIds.length ? [{ label: 'Selected evidence', factIds: unknownIds.slice(0, 4) }] : []).slice(0, 8),
        timestampFactIds: selected.filter((fact) => fact.timestamp).map((fact) => fact.factId).slice(0, 8),
        evidenceFactIds: selected.filter((fact) => ['radius', 'telemetry'].includes(fact.source) && fact.usable).map((fact) => fact.factId).slice(0, 12),
        productionContextFactIds: { job: contextId('job'), order: contextId('order'), recipe: contextId('recipe') },
        recommendedInvestigation: finding.recommendedInvestigation,
        links: [{ label: 'Inspect Radius evidence', href: `/raw-radius-explorer?press=${finding.pressKey}` }, { label: 'Open press overview', href: `/overview?press=${finding.pressKey}` }],
      }
    }),
    limitations: uniqueStrings(draft.limitations),
  }
}
