import { RADIUS_PRESS_KEYS, type RadiusPressKey } from '../radius/models.js'
import { RadiusUnavailableError, type RadiusService } from '../radius/radius-service.js'
import type { TelemetryFoundationService } from '../telemetry/telemetry-foundation-service.js'
import { PRODUCTION_CONTEXT_CANONICAL_IDS, PRODUCTION_CONTEXT_FIELDS, type PressEvidenceCapabilities, type PressSemanticHistoryEvidence, type ProductionContextEvidence, type ProductionContextField, type ProductionContextFieldEvidence } from '../telemetry/telemetry-contracts.js'
import { JOB_ANALYSIS_DIMENSIONS, type JobAnalysisDimension, type JobDecisionCard, type JobGroupDefinition, type JobIntelligenceFinding, type JobIntelligenceReport, type ProductionRun } from './contracts.js'
import { buildPressAffinity, deriveProductionRuns, matchesJobGroup, productionContextCoverage, summarizeIdentities, summarizeRadiusLosses, summarizeTransitions, type DeckActiveEvidence } from './engine.js'

export const JOB_INTELLIGENCE_MAX_RANGE_MS = 7 * 24 * 60 * 60_000
const FLEET_READ_CONCURRENCY = 3

interface PressRunResult { pressKey: RadiusPressKey; displayName: string; runs: ProductionRun[]; coverage: JobIntelligenceReport['coverage']; deckSupported: boolean }

function reportUrl(input: { pressKey: RadiusPressKey; fromUtc: string; toUtc: string; analyzeBy: JobAnalysisDimension; group?: JobGroupDefinition }): string {
  const query = new URLSearchParams({ press: input.pressKey, fromUtc: input.fromUtc, toUtc: input.toUtc, preset: 'custom', analyzeBy: input.analyzeBy })
  if (input.group) { query.set('operator', input.group.operator); query.set('query', input.group.query); if (input.group.positionStart) query.set('positionStart', String(input.group.positionStart)); if (input.group.positionEnd) query.set('positionEnd', String(input.group.positionEnd)); if (input.group.segmentIndex) query.set('segmentIndex', String(input.group.segmentIndex)); if (input.group.delimiter) query.set('delimiter', input.group.delimiter) }
  return `/job-intelligence?${query}`
}

function explorerUrl(path: string, pressKey: RadiusPressKey, fromUtc: string, toUtc: string): string {
  return `${path}?${new URLSearchParams({ press: pressKey, fromUtc, toUtc, preset: 'custom' })}`
}

function decisions(input: { press: PressRunResult; groupRuns: ProductionRun[]; crossPress: JobIntelligenceReport['crossPress']; transitions: JobIntelligenceReport['transitions']; losses: JobIntelligenceReport['radiusLosses']; reportUrl: string }): JobDecisionCard[] {
  const cards: JobDecisionCard[] = []
  const preferred = input.crossPress.find((row) => (row.support.level === 'strong' || row.support.level === 'moderate') && row.actualVersusComparableGoodPoints !== null)
  if (preferred) cards.push({ kind: 'preferred_press', label: 'Preferred press', headline: preferred.displayName, value: `${preferred.actualVersusComparableGoodPoints! >= 0 ? '+' : ''}${preferred.actualVersusComparableGoodPoints} pts`, detail: `versus comparable expectation · ${preferred.runCount} runs`, evidenceLevel: preferred.support.level, inspectUrl: input.reportUrl })
  const risk = input.transitions.find((row) => (row.support.level === 'strong' || row.support.level === 'moderate') && row.medianTransitionSeconds !== null)
  if (risk) cards.push({ kind: 'sequence_risk', label: 'Sequence risk', headline: `${risk.previousValue} → ${risk.currentValue}`, value: `${Math.round(risk.medianTransitionSeconds! / 60)} min`, detail: `median stable-production proxy on ${risk.pressKey.replace('press', 'Press ')}`, evidenceLevel: risk.support.level, inspectUrl: risk.evidenceUrl })
  const loss = input.losses[0]
  if (loss) cards.push({ kind: 'largest_loss', label: 'Largest loss', headline: loss.statusDescription, value: `${Math.round(loss.totalSeconds / 360) / 10} h`, detail: `${loss.eventType} · ${loss.occurrenceCount} exact Radius episodes`, evidenceLevel: input.groupRuns.length >= 5 ? 'moderate' : input.groupRuns.length >= 3 ? 'limited' : 'insufficient', inspectUrl: loss.evidenceUrl })
  const goodSeconds = input.groupRuns.reduce((sum, run) => sum + run.goodSeconds, 0); const interruptions = input.groupRuns.reduce((sum, run) => sum + run.productionInterruptionCount, 0); const rate = goodSeconds ? interruptions / (goodSeconds / 3600) : null
  if (rate !== null) cards.push({ kind: 'stability', label: 'Stability', headline: input.press.displayName, value: `${Math.round(rate * 10) / 10}/h`, detail: 'production interruptions per Good-time hour', evidenceLevel: input.groupRuns.length >= 5 ? 'moderate' : input.groupRuns.length >= 3 ? 'limited' : 'insufficient', inspectUrl: input.reportUrl })
  if (!cards.some((card) => card.evidenceLevel === 'strong' || card.evidenceLevel === 'moderate')) cards.unshift({ kind: 'insufficient_evidence', label: 'Recommendation', headline: 'Insufficient evidence', value: `${input.groupRuns.length} runs`, detail: 'No preferred press or sequence is declared from sparse support.', evidenceLevel: 'insufficient', inspectUrl: input.reportUrl })
  return cards.slice(0, 4)
}

function findings(cards: JobDecisionCard[], pressKey: RadiusPressKey): JobIntelligenceFinding[] {
  const category: Record<JobDecisionCard['kind'], JobIntelligenceFinding['category']> = { preferred_press: 'press_affinity_anomaly', sequence_risk: 'transition_anomaly', largest_loss: 'radius_loss_anomaly', stability: 'repeat_interruption_anomaly', insufficient_evidence: 'job_performance_anomaly' }
  return cards.filter((card) => card.kind !== 'insufficient_evidence').map((card, index) => ({ findingId: `job-intelligence.${pressKey}.${index}.${card.kind}`, category: category[card.kind], title: `${card.label}: ${card.headline}`, evidenceLevel: card.evidenceLevel, evidenceUrl: card.inspectUrl, deterministicInputs: [card.value, card.detail] }))
}

async function boundedMap<T, R>(values: T[], worker: (value: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const result: PromiseSettledResult<R>[] = new Array(values.length); let cursor = 0
  await Promise.all(Array.from({ length: Math.min(FLEET_READ_CONCURRENCY, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++
      try { result[index] = { status: 'fulfilled', value: await worker(values[index]!) } }
      catch (reason) { result[index] = { status: 'rejected', reason } }
    }
  }))
  return result
}

export async function readJobProductionContext(telemetry: TelemetryFoundationService, pressKey: RadiusPressKey, fromUtc: string, toUtc: string, capabilities: PressEvidenceCapabilities, requestId?: string, signal?: AbortSignal): Promise<ProductionContextEvidence> {
  try { return await telemetry.context(pressKey, fromUtc, toUtc, requestId, signal) }
  catch (error) {
    if (signal?.aborted) throw error
    const fields = {} as Record<ProductionContextField, ProductionContextFieldEvidence>
    for (const field of PRODUCTION_CONTEXT_FIELDS) {
      const canonicalId = PRODUCTION_CONTEXT_CANONICAL_IDS[field]
      const capability = capabilities.capabilities.find((item) => item.canonicalId === canonicalId)
      if (capability?.state === 'UNSUPPORTED') { fields[field] = { field, canonicalId, capabilityState: 'UNSUPPORTED', observationState: 'UNSUPPORTED', seed: null, changes: [] }; continue }
      try {
        const history = await telemetry.semanticHistory(pressKey, { fromUtc, toUtc, includeSeed: true, signals: [{ canonicalId, representation: 'changes' }] }, requestId, signal)
        const item = history.signals.find((candidate) => candidate.canonicalId === canonicalId)
        fields[field] = item ? { field, canonicalId, capabilityState: item.capabilityState, observationState: item.observationState, seed: item.seed, changes: item.changes } : { field, canonicalId, capabilityState: 'TEMPORARILY_UNAVAILABLE', observationState: 'UNSUPPORTED', seed: null, changes: [] }
      } catch (fieldError) {
        if (signal?.aborted) throw fieldError
        fields[field] = { field, canonicalId, capabilityState: 'TEMPORARILY_UNAVAILABLE', observationState: 'UNSUPPORTED', seed: null, changes: [] }
      }
    }
    const changes = JOB_ANALYSIS_DIMENSIONS.flatMap((field) => fields[field].changes.map((change) => ({ atUtc: change.observedAtUtc, field, canonicalId: fields[field].canonicalId, previousValueKind: change.previousValueKind, previousValue: change.previousValue, valueKind: change.valueKind, value: change.value, qualityState: change.qualityState }))).sort((left, right) => Date.parse(left.atUtc) - Date.parse(right.atUtc) || left.field.localeCompare(right.field))
    return { pressKey, sourceKey: capabilities.sourceKey, displayName: capabilities.displayName, fromUtc, toUtc, fields, changes }
  }
}

function productionContextFromHistory(history: PressSemanticHistoryEvidence): ProductionContextEvidence {
  const entries = PRODUCTION_CONTEXT_FIELDS.map((field): [ProductionContextField, ProductionContextFieldEvidence] => {
    const canonicalId = PRODUCTION_CONTEXT_CANONICAL_IDS[field]
    const item = history.signals.find((candidate) => candidate.canonicalId === canonicalId && candidate.deckNumber === null)
    if (!item) throw new Error(`Missing ${canonicalId} from combined Job Intelligence history`)
    return [field, { field, canonicalId, capabilityState: item.capabilityState, observationState: item.observationState, seed: item.seed, changes: item.changes }]
  })
  const fields = Object.fromEntries(entries) as Record<ProductionContextField, ProductionContextFieldEvidence>
  const changes = JOB_ANALYSIS_DIMENSIONS.flatMap((field) => fields[field].changes.map((change) => ({ atUtc: change.observedAtUtc, field, canonicalId: fields[field].canonicalId, previousValueKind: change.previousValueKind, previousValue: change.previousValue, valueKind: change.valueKind, value: change.value, qualityState: change.qualityState }))).sort((left, right) => Date.parse(left.atUtc) - Date.parse(right.atUtc) || left.field.localeCompare(right.field))
  return { pressKey: history.pressKey, sourceKey: history.sourceKey, displayName: history.displayName, fromUtc: history.fromUtc, toUtc: history.toUtc, fields, changes }
}

export class JobIntelligenceService {
  constructor(private readonly radius: RadiusService, private readonly telemetry: TelemetryFoundationService) {}

  private async pressRuns(pressKey: RadiusPressKey, fromUtc: string, toUtc: string, requestId?: string, signal?: AbortSignal, includeDecks = false, knownCapabilities?: PressEvidenceCapabilities): Promise<PressRunResult> {
    if (!this.radius.getRawTimeline) throw new RadiusUnavailableError()
    const capabilities = knownCapabilities ?? await this.telemetry.capabilities.get(pressKey, requestId, signal)
    const timelinePromise = this.radius.getRawTimeline(pressKey, fromUtc, toUtc)
    const deckCapability = capabilities.capabilities.find((item) => item.canonicalId === 'deck.active')
    const deckNumbers = includeDecks && deckCapability?.state === 'SUPPORTED' ? deckCapability.deckNumbers : []
    let context: ProductionContextEvidence
    let deckActive: DeckActiveEvidence[] = []
    if (deckNumbers.length) {
      try {
        const history = await this.telemetry.semanticHistory(pressKey, { fromUtc, toUtc, includeSeed: true, signals: [...PRODUCTION_CONTEXT_FIELDS.map((field) => ({ canonicalId: PRODUCTION_CONTEXT_CANONICAL_IDS[field], representation: 'changes' as const })), ...deckNumbers.map((deckNumber) => ({ canonicalId: 'deck.active', deckNumber, representation: 'changes' as const }))] }, requestId, signal)
        context = productionContextFromHistory(history)
        deckActive = history.signals.filter((item) => item.canonicalId === 'deck.active' && item.deckNumber !== null).map((item) => ({ deckNumber: item.deckNumber!, seed: item.seed, changes: item.changes }))
      } catch (error) {
        if (signal?.aborted) throw error
        const [fallbackContext, deckHistory] = await Promise.all([
          readJobProductionContext(this.telemetry, pressKey, fromUtc, toUtc, capabilities, requestId, signal),
          this.telemetry.semanticHistory(pressKey, { fromUtc, toUtc, includeSeed: true, signals: deckNumbers.map((deckNumber) => ({ canonicalId: 'deck.active', deckNumber, representation: 'changes' })) }, requestId, signal),
        ])
        context = fallbackContext
        deckActive = deckHistory.signals.map((item) => ({ deckNumber: item.deckNumber!, seed: item.seed, changes: item.changes }))
      }
    } else {
      context = await readJobProductionContext(this.telemetry, pressKey, fromUtc, toUtc, capabilities, requestId, signal)
    }
    const timeline = await timelinePromise
    const runs = deriveProductionRuns({ pressKey, fromUtc, toUtc, context, radiusSegments: timeline.segments, deckActive })
    return { pressKey, displayName: timeline.displayName, runs, coverage: productionContextCoverage(context, runs), deckSupported: deckCapability?.state === 'SUPPORTED' }
  }

  async report(input: { pressKey: RadiusPressKey; fromUtc: string; toUtc: string; analyzeBy: JobAnalysisDimension; group?: JobGroupDefinition }, requestId?: string, signal?: AbortSignal): Promise<JobIntelligenceReport> {
    let selected: PressRunResult
    const partialPresses: RadiusPressKey[] = []
    let fleetRuns: ProductionRun[]
    if (input.group) {
      const capabilityResults = await boundedMap([...RADIUS_PRESS_KEYS], (pressKey) => this.telemetry.capabilities.get(pressKey, requestId, signal))
      const selectedIndex = RADIUS_PRESS_KEYS.indexOf(input.pressKey)
      const selectedCapabilities = capabilityResults[selectedIndex]
      if (!selectedCapabilities || selectedCapabilities.status === 'rejected') throw selectedCapabilities?.reason ?? new Error('Selected press capabilities unavailable')
      const targetCanonicalId = PRODUCTION_CONTEXT_CANONICAL_IDS[input.analyzeBy]
      const eligible = RADIUS_PRESS_KEYS.flatMap((pressKey, index) => {
        const result = capabilityResults[index]
        if (!result || result.status === 'rejected') { partialPresses.push(pressKey); return [] }
        const target = result.value.capabilities.find((item) => item.canonicalId === targetCanonicalId)
        return pressKey === input.pressKey || target?.state !== 'UNSUPPORTED' ? [{ pressKey, capabilities: result.value }] : []
      })
      const runResults = await boundedMap(eligible, ({ pressKey, capabilities }) => this.pressRuns(pressKey, input.fromUtc, input.toUtc, requestId, signal, pressKey === input.pressKey, capabilities))
      const selectedResult = runResults[eligible.findIndex((item) => item.pressKey === input.pressKey)]
      if (!selectedResult || selectedResult.status === 'rejected') throw selectedResult?.reason ?? new Error('Selected press evidence unavailable')
      selected = selectedResult.value
      fleetRuns = runResults.flatMap((result, index) => {
        if (result.status === 'fulfilled') return result.value.runs
        partialPresses.push(eligible[index]!.pressKey)
        return []
      })
    } else {
      selected = await this.pressRuns(input.pressKey, input.fromUtc, input.toUtc, requestId, signal, true)
      fleetRuns = selected.runs
    }
    const groupRuns = input.group ? selected.runs.filter((run) => { const value = run.identities[input.analyzeBy]; return value ? matchesJobGroup(value, input.group!) : false }) : selected.runs
    const crossPress = input.group ? buildPressAffinity(fleetRuns, input.analyzeBy, input.group) : []
    const transitions = summarizeTransitions(selected.runs, input.analyzeBy, input.group)
    const losses = summarizeRadiusLosses(groupRuns, input.pressKey, input.fromUtc, input.toUtc)
    const currentReportUrl = reportUrl(input)
    const decisionCards = decisions({ press: selected, groupRuns, crossPress, transitions, losses, reportUrl: currentReportUrl })
    const includedValues = [...new Set(groupRuns.flatMap((run) => run.identities[input.analyzeBy] ? [run.identities[input.analyzeBy]!] : []))].sort()
    return {
      version: 'job-intelligence-v1', generatedAtUtc: new Date().toISOString(), fromUtc: input.fromUtc, toUtc: input.toUtc, pressKey: input.pressKey, displayName: selected.displayName, analyzeBy: input.analyzeBy, metricName: 'Production State Efficiency',
      boundaryPolicy: { settlingWindowSeconds: 300, stableProductionConfirmationSeconds: 300, description: 'Consecutive usable identity changes separated by no more than five minutes form one settling cluster. Run segmentation may begin at the first indication, while first-seen, last-change, settled, Radius stable-production, and telemetry physical timestamps remain distinct evidence.' },
      coverage: selected.coverage, ranking: summarizeIdentities(selected.runs, input.analyzeBy), selectedGroup: input.group ? { definition: input.group, includedValues, runCount: groupRuns.length } : null, decisions: decisionCards, crossPress, transitions, radiusLosses: losses, findings: findings(decisionCards, input.pressKey),
      evidenceLinks: { rawRadius: explorerUrl('/raw-radius-explorer', input.pressKey, input.fromUtc, input.toUtc), telemetryEvents: explorerUrl('/telemetry-event-explorer', input.pressKey, input.fromUtc, input.toUtc) },
      limitations: ['Radius Good status is an operator-entered production state, not finished-product quality.', 'Transition-to-stable-production is a conservative Radius stable-production proxy unless separate telemetry physical timing is attached; metadata first-seen is never treated as unquestioned process onset.', 'Comparable performance is deterministic matching, not a causal estimate.', ...(selected.deckSupported ? ['Deck continuity uses only canonical deck.active 0/1 evidence with complete per-deck state at the run boundary.'] : ['Deterministic active-deck telemetry is unavailable on the selected press.']), ...(partialPresses.length ? [`Fleet evidence unavailable for ${partialPresses.map((item) => item.replace('press', 'Press ')).join(', ')}.`] : [])],
    }
  }
}
