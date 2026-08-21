import type { IndustrialAnalyticalObservation } from '../industrial-analytics/contracts.js'
import { aggregateEventFingerprints, buildOccurrenceFingerprint, compareSelectedToTypical, type EventLearningOccurrence, type EventLearningSignal } from '../industrial-analytics/event-learning.js'
import type { TemporalEvidenceProgram } from '../industrial-analytics/temporal-evidence.js'
import type { AiDeterministicDiscovery, AiDiscoveryFindingCategory, AiDiscoveryVisualFinding, AiGroundingFact, AiInvestigatorRequest } from './contracts.js'
import type { DiscoveryCandidate, DiscoveryPreflight } from './discovery.js'

const MAXIMUM_FINDINGS = 8
const FAMILY_PRIORITY: Record<string, number> = { first_divergence: 10, contextual_baseline: 9, deviation_persistence: 8, normal_envelope_departure: 7, radius_telemetry_alignment: 7, speed_recovery: 7, radius_sequence_deviation: 6, value_state_transition: 6, robust_numeric_change: 5, event_aligned_change: 5, numeric_relationship: 4, baseline_deviation: 4, cross_press_comparison: 3 }

function round(value: number, digits = 1) { const scale = 10 ** digits; return Math.round(value * scale) / scale }
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) }
function displaySignal(canonicalId: string) { return canonicalId.split('.').map((part) => part === 'actual' ? 'Actual' : part.length <= 3 ? part.toUpperCase() : `${part[0]!.toUpperCase()}${part.slice(1)}`).join(' ') }
function formatValue(value: number, unit: string | null) { return `${value > 0 ? '+' : ''}${round(value)}${unit ? ` ${unit}` : ''}` }
function encode(params: Record<string, string | number | null | undefined>) { const result = new URLSearchParams(); for (const [key, value] of Object.entries(params)) if (value !== null && value !== undefined && value !== '') result.set(key, String(value)); return result.toString() }
function magnitude(observation?: IndustrialAnalyticalObservation) { return observation ? Math.max(0, ...Object.values(observation.magnitudeInputs).filter(finite).map(Math.abs)) : 0 }
function factNumber(facts: AiGroundingFact[], metric: string, role: AiGroundingFact['role']) { const fact = facts.find((item) => item.metric === metric && item.role === role && finite(item.value)); return fact?.value as number | undefined }

function category(trace: TemporalEvidenceProgram | undefined, observation?: IndustrialAnalyticalObservation): AiDiscoveryFindingCategory {
  const variables = [...(observation?.variableIds ?? []), ...(trace ? [trace.canonicalId] : [])].join(' ').toLowerCase()
  if (trace?.datatype === 'radius' || observation?.family.startsWith('radius_')) return 'radius'
  if (variables.includes('speed')) return 'speed'
  if (trace?.datatype === 'production_context' || observation?.evidenceSource === 'production_context' || observation?.family === 'contextual_baseline') return 'context'
  if (trace?.datatype === 'categorical' || observation?.family === 'value_state_transition') return 'state'
  return 'telemetry'
}

function telemetryLink(trace: TemporalEvidenceProgram) {
  const params: Record<string, string | number | null> = { preset: 'custom', fromUtc: trace.range.start, toUtc: trace.range.end, canonicalId: trace.canonicalId, press: trace.pressKey, context: 30, autorun: 1, occurrenceStart: trace.event.start }
  if (trace.datatype === 'numeric') { const delta = trace.summary.strongestDelta; params.eventType = 'delta'; params.direction = delta && delta.delta < 0 ? 'decrease' : 'increase'; params.amount = Math.max(.01, round(Math.abs(delta?.delta ?? trace.summary.overallDelta), 3)); params.windowMinutes = delta?.windowMinutes ?? 10 }
  else { params.eventType = 'value_change'; params.match = trace.transitions.length ? 'from_to' : 'any'; params.fromValue = trace.transitions[0]?.from === undefined ? null : String(trace.transitions[0].from); params.toValue = trace.transitions[0]?.to === undefined ? null : String(trace.transitions[0].to) }
  return `/telemetry-event-explorer?${encode(params)}`
}

function radiusLink(trace: TemporalEvidenceProgram, preflight: DiscoveryPreflight) {
  const event = preflight.evidence.flatMap((item) => Array.isArray(item.result.events) ? item.result.events : []).find((item) => item && typeof item === 'object' && (item as Record<string, unknown>).episodeId === trace.eventId) as Record<string, unknown> | undefined
  const identity = event?.primaryRadiusIdentity && typeof event.primaryRadiusIdentity === 'object' ? event.primaryRadiusIdentity as Record<string, unknown> : undefined
  return `/raw-radius-explorer?${encode({ preset: 'custom', fromUtc: trace.range.start, toUtc: trace.range.end, press: trace.pressKey, eventType: typeof identity?.eventType === 'string' ? identity.eventType : null, statusCode: typeof identity?.statusCode === 'string' ? identity.statusCode : null, statusDescription: typeof identity?.statusDescription === 'string' ? identity.statusDescription : trace.datatype === 'radius' ? String(trace.enteringState) : null, context: 30, occurrenceStart: trace.event.start })}`
}

function eventLearning(candidate: DiscoveryCandidate) {
  const traces = (candidate.traces ?? []).filter((trace) => trace.usable)
  const occurrences = [...new Map(traces.map((trace) => [trace.eventId, { occurrenceId: trace.eventId, startUtc: trace.event.start, endUtc: trace.event.end, label: trace.eventId } satisfies EventLearningOccurrence])).values()].slice(0, 3)
  const signalMap = new Map<string, EventLearningSignal>()
  for (const trace of traces) {
    const signal: EventLearningSignal = trace.datatype === 'numeric' ? {
      canonicalId: trace.canonicalId, deckNumber: null, friendlyName: displaySignal(trace.canonicalId), category: 'canonical telemetry', signalType: 'numeric', sourceUnit: trace.unit, valueKind: 'numeric',
      samples: trace.landmarks.map((item) => ({ observedAtUtc: item.atUtc, value: item.value })), changes: [],
    } : {
      canonicalId: trace.canonicalId, deckNumber: null, friendlyName: displaySignal(trace.canonicalId), category: trace.datatype, signalType: 'state_event', sourceUnit: null, valueKind: typeof trace.enteringState === 'boolean' ? 'boolean' : typeof trace.enteringState === 'number' ? 'integer' : 'string',
      samples: trace.intervals.map((item) => ({ observedAtUtc: item.startUtc, value: item.value })), changes: trace.transitions.map((item) => ({ observedAtUtc: item.atUtc, previousValue: item.from, value: item.to })),
    }
    const key = `${trace.canonicalId}:`; const existing = signalMap.get(key)
    signalMap.set(key, existing ? { ...existing, samples: [...existing.samples, ...signal.samples], changes: [...existing.changes, ...signal.changes] } : signal)
  }
  const signals = [...signalMap.values()]
  if (!occurrences.length || !signals.length) return null
  const fingerprints = occurrences.map((occurrence) => buildOccurrenceFingerprint(occurrence, signals))
  const aggregate = aggregateEventFingerprints(fingerprints, signals)
  return { fingerprints, findings: aggregate.findings, sequence: aggregate.typicalSequence }
}

interface RankedFinding { score: number; finding: Omit<AiDiscoveryVisualFinding, 'rank'> }

function traceFinding(candidate: DiscoveryCandidate, trace: TemporalEvidenceProgram, observation: IndustrialAnalyticalObservation | undefined, preflight: DiscoveryPreflight, learning: ReturnType<typeof eventLearning>): RankedFinding {
  const findingCategory = category(trace, observation); const coverage = round(trace.coveragePercent)
  const related = learning?.findings.filter((item) => item.canonicalId === trace.canonicalId).slice(0, 3) ?? []
  const selected = learning?.fingerprints.find((item) => item.occurrenceId === trace.eventId)
  const comparison = selected && learning ? compareSelectedToTypical(selected, learning.findings) : { common: [], exceptions: [] }
  const fingerprint = learning && related.length ? { qualifiedOccurrences: learning.fingerprints.length, bars: related.map((item) => ({ label: `${item.friendlyName} ${item.description}`, ratePercent: round(item.occurrenceRate * 100), observedOccurrences: item.observedOccurrenceCount, validOccurrences: item.validOccurrenceCount })), sequence: learning.sequence.map((item) => ({ label: item.label, relativeMinutes: item.medianRelativeMinutes })), common: comparison.common, exceptions: comparison.exceptions } : null
  const variables = observation?.variableIds ?? [trace.canonicalId]; const family = observation?.family ?? null
  let metric: string; let visual: AiDiscoveryVisualFinding['visualization']; let comparisonLabel: string
  if (trace.datatype === 'numeric') {
    const delta = trace.summary.strongestDelta?.delta ?? trace.summary.overallDelta
    metric = formatValue(delta, trace.unit); comparisonLabel = trace.summary.strongestDelta ? `in ${trace.summary.strongestDelta.windowMinutes} min near the event` : 'across the bounded event window'
    visual = { kind: 'sparkline', points: trace.landmarks.map((item) => ({ atUtc: item.atUtc, value: item.value })), current: trace.summary.eventMedian, baseline: trace.summary.beforeMedian, sequence: [] }
  } else {
    metric = trace.transitions.length ? `${String(trace.transitions[0]!.from)} -> ${String(trace.transitions[0]!.to)}` : `${String(trace.enteringState)} state`
    comparisonLabel = trace.repeatedToggleCount ? `${trace.repeatedToggleCount} repeated toggle${trace.repeatedToggleCount === 1 ? '' : 's'}` : `${trace.transitionCount} transition${trace.transitionCount === 1 ? '' : 's'}`
    visual = { kind: trace.datatype === 'radius' ? 'sequence' : 'state', points: [], current: trace.transitionCount, baseline: null, sequence: trace.intervals.map((item) => String(item.value)).slice(0, 6) }
  }
  const importance = magnitude(observation); const recurrence = trace.datatype === 'numeric' ? trace.summary.recurrenceCount ?? 0 : trace.repeatedToggleCount
  const whyShown = [observation ? `${observation.family.replaceAll('_', ' ')} passed deterministic materiality checks` : trace.selectedBecause[0] ?? 'Selected by bounded deterministic screening', ...(recurrence ? [`${recurrence} repeated occurrence${recurrence === 1 ? '' : 's'}`] : []), ...(fingerprint?.exceptions.length ? ['Selected occurrence differs from its recurring fingerprint'] : [])].slice(0, 3)
  const href = trace.datatype === 'radius' ? radiusLink(trace, preflight) : telemetryLink(trace)
  return { score: (FAMILY_PRIORITY[family ?? ''] ?? 2) * 100 + Math.min(99, importance) + Math.min(50, recurrence * 5) + coverage / 10 + (fingerprint ? 12 : 0), finding: { id: trace.traceId, press: candidate.press, category: findingCategory, title: displaySignal(trace.canonicalId), metric, comparison: comparisonLabel, occurredAt: trace.event.start, range: trace.event, whyShown, evidenceChips: [family?.replaceAll('_', ' ') ?? trace.datatype, `${coverage}% coverage`, trace.gapState.replaceAll('_', ' ').toLowerCase(), ...(fingerprint ? [`fingerprint N=${fingerprint.qualifiedOccurrences}`] : [])].slice(0, 4), coveragePercent: coverage, rankingFactors: [{ label: 'Materiality', value: observation?.material ? 'passed' : 'trace selected' }, { label: 'Magnitude', value: importance ? round(importance).toString() : 'event-aligned' }, { label: 'Coverage', value: `${coverage}%` }, ...(recurrence ? [{ label: 'Recurrence', value: String(recurrence) }] : [])], visualization: visual, fingerprint, links: [{ label: 'Verify', href }], details: { observationFamily: family, variables, factIds: observation?.factIds ?? [], traceIds: [trace.traceId], limitations: [...(observation?.limitations ?? []), ...trace.gaps.slice(0, 3).map((gap) => `Telemetry gap ${round(gap.durationMs / 60_000)} minutes (${gap.startUtc} to ${gap.endUtc}).`)] } } }
}

function recurrenceFinding(candidate: DiscoveryCandidate, request: AiInvestigatorRequest): RankedFinding | null {
  const current = factNumber(candidate.facts, 'productionInterruptions', 'current') ?? factNumber(candidate.facts, 'interruptions', 'current'); const baseline = factNumber(candidate.facts, 'productionInterruptions', 'baseline') ?? factNumber(candidate.facts, 'interruptions', 'baseline'); const delta = factNumber(candidate.facts, 'interruptionDelta', 'delta') ?? candidate.interruptionDelta
  if (current === undefined || baseline === undefined || delta === 0) return null
  const percent = baseline ? round(delta / baseline * 100) : null
  return { score: 950 + Math.abs(delta) * 10, finding: { id: `${candidate.pressKey}.recurrence.interruptions`, press: candidate.press, category: 'radius', title: 'Production interruption recurrence', metric: `${current} in selected period`, comparison: `${delta > 0 ? '+' : ''}${delta} vs previous period${percent === null ? '' : ` (${percent > 0 ? '+' : ''}${percent}%)`}`, occurredAt: request.range.startUtc, range: { start: request.range.startUtc, end: request.range.endUtc }, whyShown: [`Interruption recurrence changed by ${Math.abs(delta)} vs the adjacent comparison period`, 'Period baseline comparison passed deterministic screening'], evidenceChips: ['recurrence', 'Radius episodes', 'period baseline'], coveragePercent: null, rankingFactors: [{ label: 'Recurrence change', value: `${delta > 0 ? '+' : ''}${delta}` }, { label: 'Baseline support', value: 'adjacent period' }], visualization: { kind: 'recurrence', points: [], current, baseline, sequence: [] }, fingerprint: null, links: [{ label: 'Verify', href: `/raw-radius-explorer?${encode({ preset: 'custom', fromUtc: request.range.startUtc, toUtc: request.range.endUtc, press: candidate.pressKey })}` }], details: { observationFamily: 'baseline_deviation', variables: ['productionInterruptions'], factIds: candidate.facts.filter((fact) => ['productionInterruptions', 'interruptions', 'interruptionDelta'].includes(fact.metric)).map((fact) => fact.factId), traceIds: [], limitations: [] } } }
}

export function buildDeterministicDiscovery(preflight: DiscoveryPreflight, request: AiInvestigatorRequest): AiDeterministicDiscovery {
  const presentationStarted = Date.now()
  const ranked: RankedFinding[] = []
  for (const candidate of preflight.candidates) {
    const recurrence = recurrenceFinding(candidate, request); if (recurrence) ranked.push(recurrence)
    const learning = eventLearning(candidate); const used = new Set<string>()
    for (const observation of candidate.observations) {
      const trace = (candidate.traces ?? []).find((item) => !used.has(item.traceId) && (observation.eventId === null || item.eventId === observation.eventId) && observation.variableIds.includes(item.canonicalId)) ?? (candidate.traces ?? []).find((item) => !used.has(item.traceId) && (observation.eventId === null || item.eventId === observation.eventId))
      if (trace) { used.add(trace.traceId); ranked.push(traceFinding(candidate, trace, observation, preflight, learning)) }
    }
    for (const trace of (candidate.traces ?? []).filter((item) => !used.has(item.traceId))) ranked.push(traceFinding(candidate, trace, undefined, preflight, learning))
  }
  const findings = ranked.sort((left, right) => right.score - left.score || Date.parse(left.finding.occurredAt) - Date.parse(right.finding.occurredAt)).slice(0, MAXIMUM_FINDINGS).map((item, index) => ({ ...item.finding, rank: index + 1 }))
  const categories = findings.reduce<AiDeterministicDiscovery['summary']['categories']>((all, finding) => ({ ...all, [finding.category]: (all[finding.category] ?? 0) + 1 }), {})
  const coverageValues = findings.flatMap((finding) => finding.coveragePercent === null ? [] : [finding.coveragePercent])
  const result: AiDeterministicDiscovery = { version: 1, summary: { candidateCount: preflight.candidates.length, screenedObservations: preflight.analytics.calculated, findingCount: findings.length, categories, coveragePercent: coverageValues.length ? round(coverageValues.reduce((sum, value) => sum + value, 0) / coverageValues.length) : null }, findings, bounds: { maximumFindings: 8, automaticRawSignalScans: 0, signalsScanned: preflight.instrumentation.signalsScanned, signalsSelected: preflight.instrumentation.signalsSelected, tracesCreated: preflight.instrumentation.tracesCreated }, eventLearning: { reusedSharedEngine: true, enrichedFindings: findings.filter((item) => item.fingerprint).length, qualifiedOccurrences: Math.max(0, ...findings.map((item) => item.fingerprint?.qualifiedOccurrences ?? 0)) }, performance: { preflightMs: preflight.performance.preflightMs, presentationMs: Date.now() - presentationStarted, dataServiceQueries: preflight.performance.dataServiceQueries, payloadBytes: 0 }, evidenceGraph: { registeredFacts: preflight.evidenceGraph.registeredFacts, unresolvedReferences: preflight.evidenceGraph.unresolvedReferences, crossPressViolations: preflight.evidenceGraph.crossPressViolations } }
  result.performance.payloadBytes = Buffer.byteLength(JSON.stringify(result), 'utf8'); result.performance.payloadBytes = Buffer.byteLength(JSON.stringify(result), 'utf8')
  return result
}
