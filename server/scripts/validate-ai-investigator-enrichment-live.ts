import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { loadServerConfig } from '../src/config.js'
import { PRODUCTION_CONTEXT_IDENTITY_FIELDS, resolveProductionContextCapabilities } from '../src/industrial-analytics/production-context.js'
import { RADIUS_PRESS_KEYS, type RadiusPressKey } from '../src/radius/models.js'
import { createRadiusService } from '../src/radius/create-radius-service.js'
import { TelemetryApiClient } from '../src/telemetry/telemetry-api-client.js'
import { TelemetryFoundationService } from '../src/telemetry/telemetry-foundation-service.js'
import { PRODUCTION_CONTEXT_CANONICAL_IDS } from '../src/telemetry/telemetry-contracts.js'
import { AiInvestigatorReadOnlyToolRegistry, AiToolPayloadTooLargeError, MAX_TOOL_PAYLOAD_BYTES, profileAiToolPayload, type AiToolResult } from '../src/ai-investigator/read-only-tools.js'
import { buildDiscoveryPreflight, DISCOVERY_INSTRUCTIONS, DISCOVERY_OUTPUT_TOKENS, DISCOVERY_PROMPT_CACHE_KEY, type DiscoveryPreflight } from '../src/ai-investigator/discovery.js'
import { aiInvestigatorDiscoveryTextFormat } from '../src/ai-investigator/contracts.js'
import { buildAiResponsesRequestPayload } from '../src/ai-investigator/orchestrator.js'
import { profileAiResponsesRequest } from '../src/ai-investigator/offline-profiler.js'
import { writeValidationCheckpoint } from './validation-checkpoint.js'
import { ExplorerReadTracker, validateRawRadius, validateTelemetryEvents } from './morning-explorer-validation.js'

const argument = (name: string) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined }
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const end = argument('--end') ?? new Date().toISOString()
const start = argument('--start') ?? new Date(Date.parse(end) - 24 * 60 * 60_000).toISOString()
const artifactPath = resolve(argument('--artifact') ?? 'staging/processintelligence-morning-validation.json')
const regressionArtifactPath = resolve(argument('--regression-artifact') ?? 'staging/ai-investigator-local-regression.json')
let config: ReturnType<typeof loadServerConfig>
const signal = new AbortController().signal
const representatives: RadiusPressKey[] = ['press14', 'press10', 'press13', 'press6']
let ancillaryReadOnlyQueryCount = 0
let activePhase = 'startup_safety_checks'
let checkpointWriteMs = 0

type ValidationStatus = 'RUNNING' | 'READY' | 'NOT_READY'
const artifact: {
  validation: string
  status: ValidationStatus
  generatedAtUtc: string
  updatedAtUtc: string
  range: { start: string; end: string }
  completedPhases: string[]
  safety: Record<string, unknown>
  localRegression: unknown
  capabilityMatrix: unknown
  selectedPress: unknown
  fleet: unknown
  rawRadius: unknown
  telemetryEvent: unknown
  gates: unknown
  failure: unknown
} = {
  validation: 'processintelligence-first-morning-read-only-production-validation',
  status: 'RUNNING',
  generatedAtUtc: new Date().toISOString(),
  updatedAtUtc: new Date().toISOString(),
  range: { start, end },
  completedPhases: [],
  safety: { openAiApiRequests: 0, databaseWrites: 0, schemaChanges: 0, rawUnmappedTelemetryScans: 0, productionValidationInvocations: 1, automaticRetries: 0, maximumDatabaseConnections: 1, maximumSemanticConcurrency: 3 },
  localRegression: null,
  capabilityMatrix: null,
  selectedPress: null,
  fleet: null,
  rawRadius: null,
  telemetryEvent: null,
  gates: null,
  failure: null,
}

async function checkpoint(phase?: string) {
  if (phase && !artifact.completedPhases.includes(phase)) artifact.completedPhases.push(phase)
  artifact.updatedAtUtc = new Date().toISOString()
  const began = Date.now()
  await writeValidationCheckpoint(artifactPath, artifact)
  checkpointWriteMs += Date.now() - began
}

function profile(modelInput: Record<string, unknown>, candidateCount: number) {
  const format = aiInvestigatorDiscoveryTextFormat(candidateCount)
  return profileAiResponsesRequest(buildAiResponsesRequestPayload(config.aiInvestigator.model, [{ role: 'user', content: JSON.stringify(modelInput) }], DISCOVERY_INSTRUCTIONS, [], 'none', { structuredOutputSchema: format.schema as Record<string, unknown>, structuredOutputFormat: format, structuredOutputName: 'process_intelligence_discovery', maxOutputTokens: DISCOVERY_OUTPUT_TOKENS, promptCacheKey: DISCOVERY_PROMPT_CACHE_KEY }))
}

type Observation = { family: string; metrics: Record<string, unknown>; support: Record<string, unknown>; variableIds?: unknown[]; limitations?: unknown[] }
function summarizeWindows(rawWindows: unknown[]) {
  return rawWindows.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return []
    const window = raw as Record<string, unknown>
    const series = Array.isArray(window.telemetrySeries) ? window.telemetrySeries as Array<Record<string, unknown>> : []
    return [{
      eventId: window.eventId, requestedRange: window.requestedRange, queryRuntimeMs: window.queryRuntimeMs, speedFetchMs: window.speedFetchMs, semanticFetchMs: window.semanticFetchMs, localAnalyticsMs: window.localAnalyticsMs, temporalProgramConstructionMs: window.temporalProgramConstructionMs,
      telemetrySeries: series.map(({ canonicalId, deckNumber, friendlyName, dataType, representation, returnedPointCount, usablePointCount, coveragePercent, detectorsApplied }) => ({ canonicalId, deckNumber, friendlyName, dataType, representation, returnedPointCount, usablePointCount, coveragePercent, detectorsApplied })),
      detectorRawOccurrenceCount: window.detectorRawOccurrenceCount, detectorRetainedOccurrenceCount: window.detectorRetainedOccurrenceCount,
      modelVisiblePayloadBytes: window.modelVisiblePayloadBytes, approximateTokenContribution: window.approximateTokenContribution,
    }]
  })
}

function summarizeRepresentative(result: AiToolResult) {
  const productionContext = result.productionContext as { capabilities?: Array<{ field: string; capabilityAvailability: string; valueAvailability: string; recentCoveragePercent?: number; usable: boolean; sentinelBehavior: string | null }>; identities?: Array<{ summary: string; dimensions: Record<string, unknown> }>; episodes?: unknown[] } | undefined
  const industrial = result.industrialAnalytics as { calculatedCount?: number; retainedCount?: number; observations?: Observation[] } | undefined
  const eventAnalytics = result.eventAnalytics as { eventWindowsAnalyzed?: number; telemetrySeriesScanned?: number; telemetrySeriesSelected?: number; telemetrySeriesQueried?: number; tracesCreated?: number } | undefined
  const diagnostics = result.validationDiagnostics && typeof result.validationDiagnostics === 'object' ? result.validationDiagnostics as Record<string, unknown> : {}
  const observations = industrial?.observations ?? []
  const first = (...families: string[]) => observations.find((item) => families.includes(item.family)) ?? null
  const compactObservation = (item: Observation | null) => item ? { family: item.family, variables: item.variableIds ?? [], metrics: item.metrics, support: item.support, limitations: item.limitations ?? [] } : null
  const relationships = Array.isArray(diagnostics.relationships) ? diagnostics.relationships as Array<Record<string, unknown>> : []
  return {
    contextCapabilities: (productionContext?.capabilities ?? []).map(({ field, capabilityAvailability, valueAvailability, recentCoveragePercent, usable, sentinelBehavior }) => ({ field, capabilityAvailability, valueAvailability, recentCoveragePercent: recentCoveragePercent ?? null, usable, sentinelBehavior })),
    productionContextIdentityUsed: productionContext?.identities?.map(({ summary, dimensions }) => ({ summary, dimensions })) ?? [],
    contextEpisodeCount: productionContext?.episodes?.length ?? 0,
    contextualBaseline: compactObservation(first('contextual_baseline')),
    contextualTelemetryBaseline: compactObservation(first('contextual_telemetry_baseline')),
    radiusSequence: compactObservation(first('radius_sequence_deviation')),
    strongestNumericDelta: compactObservation(first('robust_numeric_change', 'event_aligned_change')),
    configuredThreshold: null,
    valueChange: compactObservation(first('value_state_transition')),
    strongestEnvelopeDeparture: compactObservation(first('normal_envelope_departure')),
    persistence: compactObservation(first('deviation_persistence')),
    firstDivergence: compactObservation(first('first_divergence')),
    radiusTelemetryAlignment: compactObservation(first('radius_telemetry_alignment')),
    speedRecovery: compactObservation(first('speed_recovery')),
    modelVisibleRelationship: compactObservation(first('numeric_relationship')),
    relationshipDiagnostics: { modelVisible: relationships.filter((item) => item.modelVisible === true), diagnosticOnly: relationships.filter((item) => item.modelVisible !== true) },
    contextualBaselineSearches: Array.isArray(diagnostics.baselines) ? (diagnostics.baselines as Array<Record<string, unknown>>).map(({ eventId, matchingLevel, matchingDimensions, finalN, minimumRequired, result: baselineResult }) => ({ eventId, matchingLevel, matchingDimensions, finalN, minimumRequired, result: baselineResult })) : [],
    telemetryWindows: summarizeWindows(Array.isArray(diagnostics.windows) ? diagnostics.windows : []),
    observationsCalculated: industrial?.calculatedCount ?? 0, observationsRetained: industrial?.retainedCount ?? 0,
    temporalEvidencePrograms: Array.isArray(result.temporalEvidencePrograms) ? (result.temporalEvidencePrograms as Array<Record<string, unknown>>).map((program) => ({
      traceId: program.traceId, canonicalId: program.canonicalId, datatype: program.datatype, usable: program.usable,
      coveragePercent: program.coveragePercent, selectedBecause: program.selectedBecause,
      landmarkCount: Array.isArray(program.landmarks) ? program.landmarks.length : 0,
      segmentCount: Array.isArray(program.segments) ? program.segments.length : 0,
      intervalCount: Array.isArray(program.intervals) ? program.intervals.length : 0,
      transitionCount: Array.isArray(program.transitions) ? program.transitions.length : 0,
      gapCount: Array.isArray(program.gaps) ? program.gaps.length : 0,
    })) : [],
    eventWindowsAnalyzed: eventAnalytics?.eventWindowsAnalyzed ?? 0, telemetrySeriesScanned: eventAnalytics?.telemetrySeriesScanned ?? 0, telemetrySeriesSelected: eventAnalytics?.telemetrySeriesSelected ?? 0,
    telemetrySeriesQueried: eventAnalytics?.telemetrySeriesQueried ?? 0, readOnlyServiceQueryCount: Number(result.queryCount ?? 0),
    tracesCreated: eventAnalytics?.tracesCreated ?? 0,
    rawUnmappedTelemetryScans: Number(diagnostics.rawTelemetryScans ?? 0), limitations: result.limitations ?? [],
  }
}

function eventResult(preflight: DiscoveryPreflight, pressKey: RadiusPressKey): AiToolResult | null {
  return preflight.evidence.find((item) => item.name === 'get_press_event_summary' && (item.arguments as { press?: unknown })?.press === pressKey)?.result ?? null
}

function compactionSummary(preflight: DiscoveryPreflight) {
  const materialMetrics = new Set(['productionPercentagePointDelta', 'interruptionDelta', 'longestInterruptionDeltaMinutes'])
  return preflight.candidates.map((candidate) => ({ pressKey: candidate.pressKey, detailedAnalyticalObservations: candidate.observations.length, observationFamilies: candidate.observations.map((item) => item.family), materialComparisons: candidate.facts.filter((fact) => fact.role === 'delta' && materialMetrics.has(fact.metric)).length, traces: candidate.traces?.length ?? 0, traceSignals: candidate.traces?.map((trace) => trace.canonicalId) ?? [] }))
}

function relationshipSummary(preflight: DiscoveryPreflight) {
  const values = preflight.instrumentation.relationshipQualifications.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
  return { modelVisible: values.filter((item) => item.modelVisible === true), diagnosticOnly: values.filter((item) => item.modelVisible !== true) }
}

function payloadProfiles(preflight: DiscoveryPreflight) {
  return preflight.evidence.map((item) => {
    const args = item.arguments as Record<string, unknown>
    return {
      tool: item.name,
      pressKey: typeof args.press === 'string' ? args.press : args.press === null ? 'all' : null,
      detailMode: typeof args.detailLevel === 'string' ? args.detailLevel : null,
      ...profileAiToolPayload(item.result),
    }
  })
}

function largestPayload(profiles: ReturnType<typeof payloadProfiles>) {
  return profiles.reduce<(typeof profiles)[number] | null>((largest, item) => !largest || item.serializedBytes > largest.serializedBytes ? item : largest, null)
}

function traceComposition(preflight: DiscoveryPreflight) {
  return preflight.candidates.map((candidate) => ({
    pressKey: candidate.pressKey,
    total: candidate.traces?.length ?? 0,
    telemetry: candidate.traces?.filter((trace) => trace.datatype === 'numeric' || trace.datatype === 'categorical').length ?? 0,
    radius: candidate.traces?.filter((trace) => trace.datatype === 'radius').length ?? 0,
    productionContext: candidate.traces?.filter((trace) => trace.datatype === 'production_context').length ?? 0,
    traceIds: candidate.traces?.map((trace) => trace.traceId) ?? [],
    canonicalIds: candidate.traces?.map((trace) => trace.canonicalId) ?? [],
  }))
}

function modelTraceComposition(preflight: DiscoveryPreflight) {
  const candidates = Array.isArray(preflight.modelInput.candidates) ? preflight.modelInput.candidates as Array<{ id?: unknown; traces?: unknown[][] }> : []
  return candidates.map((candidate) => ({ pressKey: candidate.id, total: candidate.traces?.length ?? 0, telemetry: candidate.traces?.filter((trace) => trace[1] === 'N' || trace[1] === 'S').length ?? 0, radius: candidate.traces?.filter((trace) => trace[1] === 'R').length ?? 0, productionContext: candidate.traces?.filter((trace) => trace[1] === 'C').length ?? 0, traceIds: candidate.traces?.map((trace) => trace[0]) ?? [] }))
}

async function run() {
  const began = Date.now()
  await checkpoint()

  config = loadServerConfig()
  if (!config.radius.enabled || config.radius.user !== 'processintelligence_readonly') throw new Error('readonly_radius_configuration_required')
  if (config.aiInvestigator.enabled || config.aiInvestigator.apiKey) throw new Error('openai_must_be_disabled_for_validation')
  if (Date.parse(end) - Date.parse(start) <= 0 || Date.parse(end) - Date.parse(start) > 24 * 60 * 60_000) throw new Error('validation_range_must_be_at_most_24_hours')
  const localRegression = JSON.parse(await readFile(regressionArtifactPath, 'utf8')) as Record<string, unknown>
  if (localRegression.status !== 'PASS') throw new Error('local_regression_must_pass_before_production_validation')
  artifact.localRegression = localRegression
  artifact.safety = { ...artifact.safety, radiusRole: config.radius.user, aiInvestigatorEnabled: false, openAiKeyPresent: false, configuredTotalTimeoutMs: config.aiInvestigator.totalTimeoutMs, configuredToolTimeoutMs: config.aiInvestigator.toolTimeoutMs, configuredOpenAiTimeoutMs: config.aiInvestigator.openAiTimeoutMs, requiredRuntimeHeadroomMs: config.aiInvestigator.openAiTimeoutMs + 2_000, commits: 0, deployments: 0, serviceRestarts: 0 }
  const telemetry = new TelemetryFoundationService(new TelemetryApiClient(config.telemetryApi))
  const radius = createRadiusService(config.radius, config.plantTimeZone, { maximumConnections: 1 })
  const registry = new AiInvestigatorReadOnlyToolRegistry(radius, telemetry)
  const explorerTracker = new ExplorerReadTracker(telemetry)
  await checkpoint('startup_safety')

  activePhase = 'capability_matrix'
  const capabilityMatrix = []
  const contextSelectors = PRODUCTION_CONTEXT_IDENTITY_FIELDS.map((field) => ({ canonicalId: PRODUCTION_CONTEXT_CANONICAL_IDS[field], representation: 'changes' as const }))
  const capabilityEvidenceStart = new Date(Math.max(Date.parse(start), Date.parse(end) - 2 * 60 * 60_000)).toISOString()
  for (const pressKey of RADIUS_PRESS_KEYS) {
    const history = await telemetry.semanticHistoryWithIdentity(pressKey, { fromUtc: capabilityEvidenceStart, toUtc: end, includeSeed: true, signals: contextSelectors }, `final-revalidation-capabilities-${pressKey}`, signal)
    ancillaryReadOnlyQueryCount += history.readDiagnostics?.telemetryRequests ?? 1
    const capabilities = resolveProductionContextCapabilities({ range: { start: capabilityEvidenceStart, end }, signals: history.signals })
    const cells = Object.fromEntries(capabilities.map((item) => [item.field, item.capabilityAvailability === 'CAPABILITY_UNAVAILABLE' ? 'CAPABILITY_UNAVAILABLE' : `${item.capabilityAvailability} + ${item.valueAvailability}`]))
    capabilityMatrix.push({ pressKey, ...cells })
  }
  artifact.capabilityMatrix = capabilityMatrix
  await checkpoint('capability_matrix')

  activePhase = 'press14_selected_profile'
  const press14Began = Date.now()
  const press14 = await buildDiscoveryPreflight(registry, { scope: { pressKey: 'press14' }, range: { startUtc: start, endUtc: end }, analysis: 'discover_unusual_behavior' }, signal, { candidateLimit: 3, requestId: 'final-revalidation-profile-press14', maxParallelTools: 1, includeDiagnostics: true })
  const press14PreflightRuntimeMs = Date.now() - press14Began
  const press14ProfileBegan = Date.now()
  const press14Profile = profile(press14.modelInput, press14.candidates.length)
  const press14SerializationAndProfileMs = Date.now() - press14ProfileBegan
  const press14RuntimeMs = Date.now() - press14Began
  const press14Result = eventResult(press14, 'press14')
  if (!press14Result) throw new Error('press14_representative_evidence_missing')
  const selectedCompaction = compactionSummary(press14)
  const selectedRelationship = relationshipSummary(press14)
  const selectedPayloadProfiles = payloadProfiles(press14)
  const selectedLargestPayload = largestPayload(selectedPayloadProfiles)
  const selectedEarlyGates = {
    tokenGate: press14Profile.estimatedInputTokens <= 3_000,
    runtimeFitsConfiguredArchitecture: press14PreflightRuntimeMs + config.aiInvestigator.openAiTimeoutMs + 2_000 <= config.aiInvestigator.totalTimeoutMs,
    toolPayloadGate: selectedPayloadProfiles.every((item) => item.serializedBytes < MAX_TOOL_PAYLOAD_BYTES),
    evidenceGraphClean: press14.evidenceGraph.unresolvedReferences === 0 && press14.evidenceGraph.unresolvedTraceReferences === 0 && press14.evidenceGraph.crossPressViolations === 0 && press14.evidenceGraph.unusableAdvertisedFacts === 0 && press14.evidenceGraph.unusableAdvertisedTraces === 0,
    noRawUnmappedTelemetryScans: press14.instrumentation.rawTelemetryScans === 0,
  }
  artifact.selectedPress = {
    pressKey: 'press14', runtimeMs: press14RuntimeMs, preflightRuntimeMs: press14PreflightRuntimeMs, serializationAndProfileMs: press14SerializationAndProfileMs, readOnlyServiceQueryCount: press14.performance.dataServiceQueries,
    exactToolResultMaximumBytes: selectedLargestPayload?.serializedBytes ?? 0, toolResultHeadroomBytes: selectedLargestPayload?.headroomBytes ?? MAX_TOOL_PAYLOAD_BYTES,
    toolResultHardLimitBytes: MAX_TOOL_PAYLOAD_BYTES, toolPayloads: selectedPayloadProfiles,
    compactModelInputBytes: Buffer.byteLength(JSON.stringify(press14.modelInput), 'utf8'), exactModelRequestBytes: press14Profile.exactRequestBytes,
    estimatedModelInputTokens: press14Profile.estimatedInputTokens, modelTokenEstimateMethod: press14Profile.estimateMethod,
    registeredFacts: press14.evidenceGraph.registeredFacts, observationsCalculated: press14.analytics.calculated, observationsRetained: press14.analytics.retained,
    groupedCandidates: press14.analytics.grouped, modelVisibleCandidates: press14.analytics.modelCandidates, candidateCount: press14.candidates.length,
    modelVisibleDetailedObservations: selectedCompaction.reduce((sum, item) => sum + item.detailedAnalyticalObservations, 0),
    signalsScanned: press14.instrumentation.signalsScanned, signalsSelected: press14.instrumentation.signalsSelected, tracesCreated: press14.instrumentation.tracesCreated,
    authoritativeTraceComposition: traceComposition(press14), modelTraceComposition: modelTraceComposition(press14), boundedTelemetry: press14.instrumentation.boundedTelemetry, runtimeBreakdowns: press14.instrumentation.runtimeBreakdowns, evaluation: press14.instrumentation.evaluation,
    sectionTokenAttribution: press14.instrumentation.sectionTokenContributions, telemetryWindows: summarizeWindows(press14.instrumentation.detailedWindows),
    contextualBaselineSearches: press14.instrumentation.baselineSearches, relationships: selectedRelationship, compaction: selectedCompaction,
    evidenceGraph: press14.evidenceGraph, supportedEvidence: summarizeRepresentative(press14Result), earlyGates: selectedEarlyGates,
  }
  await checkpoint('ai_investigator_press14')
  if (!Object.values(selectedEarlyGates).every(Boolean)) throw new Error('press14_release_gate_failed')

  activePhase = 'all_presses_profile'
  const allBegan = Date.now()
  const allPresses = await buildDiscoveryPreflight(registry, { scope: { pressKey: null }, range: { startUtc: start, endUtc: end }, analysis: 'discover_unusual_behavior' }, signal, { candidateLimit: 5, requestId: 'final-revalidation-profile-all', maxParallelTools: 1, includeDiagnostics: true })
  const allPreflightRuntimeMs = Date.now() - allBegan
  const allProfileBegan = Date.now()
  const allProfile = profile(allPresses.modelInput, allPresses.candidates.length)
  const allSerializationAndProfileMs = Date.now() - allProfileBegan
  const allRuntimeMs = Date.now() - allBegan
  const fleetCompaction = compactionSummary(allPresses)
  const fleetRelationship = relationshipSummary(allPresses)
  const fleetPayloadProfiles = payloadProfiles(allPresses)
  const fleetLargestPayload = largestPayload(fleetPayloadProfiles)
  const allWindows = summarizeWindows(allPresses.instrumentation.detailedWindows)
  const representativeResults: Record<string, unknown> = {}
  for (const pressKey of representatives.filter((item) => item !== 'press14')) {
    const existing = eventResult(allPresses, pressKey)
    representativeResults[pressKey] = existing ? summarizeRepresentative(existing) : { available: false, reason: 'Press was not selected as a fleet candidate; no separate production query was permitted.' }
  }
  const fleetEventPayloads = fleetPayloadProfiles.filter((item) => item.tool === 'get_press_event_summary')
  artifact.fleet = {
    runtimeMs: allRuntimeMs, preflightRuntimeMs: allPreflightRuntimeMs, serializationAndProfileMs: allSerializationAndProfileMs, readOnlyServiceQueryCount: allPresses.performance.dataServiceQueries,
    ancillaryCapabilityServiceQueryCount: ancillaryReadOnlyQueryCount,
    totalAccountedReadOnlyServiceQueries: ancillaryReadOnlyQueryCount + press14.performance.dataServiceQueries + allPresses.performance.dataServiceQueries,
    pressesConsidered: new Set([...allPresses.eligiblePresses, ...allPresses.excludedPresses]).size,
    candidatePressesSelected: allPresses.candidates.map((item) => item.pressKey), candidateCount: allPresses.candidates.length,
    detailedCandidateCount: fleetEventPayloads.filter((item) => item.detailMode === 'fleet').length,
    summaryCandidateCount: fleetEventPayloads.filter((item) => item.detailMode === 'fleet_summary').length,
    detailedEventWindows: allPresses.instrumentation.detailedWindows.length, registeredFacts: allPresses.evidenceGraph.registeredFacts,
    observationsCalculated: allPresses.analytics.calculated, observationsRetained: allPresses.analytics.retained, groupedCandidates: allPresses.analytics.grouped,
    modelVisibleCandidates: allPresses.analytics.modelCandidates, modelVisibleDetailedObservations: fleetCompaction.reduce((sum, item) => sum + item.detailedAnalyticalObservations, 0),
    materialComparisons: fleetCompaction.reduce((sum, item) => sum + item.materialComparisons, 0),
    canonicalTelemetrySeriesQueried: [...new Set(allWindows.flatMap((window) => window.telemetrySeries.map((item) => `${String(item.canonicalId)}:${String(item.deckNumber ?? '')}`)))],
    exactToolResultMaximumBytes: fleetLargestPayload?.serializedBytes ?? 0, toolResultHeadroomBytes: fleetLargestPayload?.headroomBytes ?? MAX_TOOL_PAYLOAD_BYTES,
    largestToolResult: fleetLargestPayload, toolResultHardLimitBytes: MAX_TOOL_PAYLOAD_BYTES, toolPayloads: fleetPayloadProfiles,
    compactModelInputBytes: Buffer.byteLength(JSON.stringify(allPresses.modelInput), 'utf8'), exactModelRequestBytes: allProfile.exactRequestBytes,
    estimatedModelInputTokens: allProfile.estimatedInputTokens, modelTokenEstimateMethod: allProfile.estimateMethod,
    signalsScanned: allPresses.instrumentation.signalsScanned, signalsSelected: allPresses.instrumentation.signalsSelected, tracesCreated: allPresses.instrumentation.tracesCreated,
    authoritativeTraceComposition: traceComposition(allPresses), modelTraceComposition: modelTraceComposition(allPresses), boundedTelemetry: allPresses.instrumentation.boundedTelemetry, runtimeBreakdowns: allPresses.instrumentation.runtimeBreakdowns, evaluation: allPresses.instrumentation.evaluation,
    sectionTokenAttribution: allPresses.instrumentation.sectionTokenContributions, telemetryWindows: allWindows,
    contextualBaselineSearches: allPresses.instrumentation.baselineSearches, relationships: fleetRelationship, compaction: fleetCompaction,
    evidenceGraph: allPresses.evidenceGraph, representativeEvidence: representativeResults,
  }
  const fleetEarlyGates = {
    tokenGate: allProfile.estimatedInputTokens <= 6_000,
    toolPayloadGate: fleetPayloadProfiles.every((item) => item.serializedBytes < MAX_TOOL_PAYLOAD_BYTES),
    evidenceGraphClean: allPresses.evidenceGraph.unresolvedReferences === 0 && allPresses.evidenceGraph.unresolvedTraceReferences === 0 && allPresses.evidenceGraph.crossPressViolations === 0 && allPresses.evidenceGraph.unusableAdvertisedFacts === 0 && allPresses.evidenceGraph.unusableAdvertisedTraces === 0,
    noRawUnmappedTelemetryScans: allPresses.instrumentation.rawTelemetryScans === 0,
  }
  ;(artifact.fleet as Record<string, unknown>).earlyGates = fleetEarlyGates
  await checkpoint('ai_investigator_all_presses')
  if (!Object.values(fleetEarlyGates).every(Boolean)) throw new Error('all_presses_release_gate_failed')

  activePhase = 'raw_radius_representative_validation'
  const rawRadius = await validateRawRadius({ radius, telemetry, tracker: explorerTracker, startUtc: start, endUtc: end, signal })
  artifact.rawRadius = rawRadius
  await checkpoint('raw_radius_representative_validation')
  if (rawRadius.diagnostics.rawUnmappedCalls.total !== 0) throw new Error('raw_unmapped_automatic_scan_detected')

  activePhase = 'telemetry_event_representative_validation'
  const telemetryEvent = await validateTelemetryEvents({ radius, telemetry, tracker: explorerTracker, startUtc: start, endUtc: end, signal })
  artifact.telemetryEvent = telemetryEvent
  await checkpoint('telemetry_event_representative_validation')
  if (telemetryEvent.diagnostics.rawUnmappedCalls.total !== 0) throw new Error('raw_unmapped_automatic_scan_detected')

  activePhase = 'final_gate_evaluation'
  const selectedContextSupportValid = press14.candidates.flatMap((candidate) => candidate.observations).filter((item) => ['contextual_baseline', 'contextual_telemetry_baseline'].includes(item.family)).every((item) => (item.support.comparisonSampleCount ?? item.support.sampleCount) >= 3)
  const fleetContextSupportValid = allPresses.candidates.flatMap((candidate) => candidate.observations).filter((item) => ['contextual_baseline', 'contextual_telemetry_baseline'].includes(item.family)).every((item) => (item.support.comparisonSampleCount ?? item.support.sampleCount) >= 3)
  const relationshipVisibleValid = [...selectedRelationship.modelVisible, ...fleetRelationship.modelVisible].every((item) => item.qualification === 'QUALIFIED')
  const referenceTotals = { unresolvedReferences: press14.evidenceGraph.unresolvedReferences + allPresses.evidenceGraph.unresolvedReferences, unresolvedTraceReferences: press14.evidenceGraph.unresolvedTraceReferences + allPresses.evidenceGraph.unresolvedTraceReferences, crossPressViolations: press14.evidenceGraph.crossPressViolations + allPresses.evidenceGraph.crossPressViolations, unusableAdvertisedFacts: press14.evidenceGraph.unusableAdvertisedFacts + allPresses.evidenceGraph.unusableAdvertisedFacts, unusableAdvertisedTraces: press14.evidenceGraph.unusableAdvertisedTraces + allPresses.evidenceGraph.unusableAdvertisedTraces }
  const explorerRawCalls = explorerTracker.snapshot('morning-').rawUnmappedCalls.total
  const rawUnmappedTelemetryScans = press14.instrumentation.rawTelemetryScans + allPresses.instrumentation.rawTelemetryScans + explorerRawCalls
  const offlinePayload = isRecord(localRegression.offlineToolPayload) ? localRegression.offlineToolPayload : {}
  const offlineModelProfiles = isRecord(localRegression.offlineModelProfiles) ? localRegression.offlineModelProfiles : {}
  const offlineSelectedProfile = isRecord(offlineModelProfiles.selectedPress) ? offlineModelProfiles.selectedPress : {}
  const selectedModelComposition = modelTraceComposition(press14)
  const gates = {
    localRegressionPassed: localRegression.status === 'PASS',
    offlineToolPayloadEngineeringTarget: typeof offlinePayload.serializedBytes === 'number' && offlinePayload.serializedBytes <= 48 * 1024,
    offlineSelectedTokenGate: typeof offlineSelectedProfile.estimatedInputTokens === 'number' && offlineSelectedProfile.estimatedInputTokens <= 2_500,
    capabilityMatrixComplete: capabilityMatrix.length === RADIUS_PRESS_KEYS.length,
    selectedPressTokenGate: press14Profile.estimatedInputTokens <= 3_000,
    selectedRuntimeFitsConfiguredArchitecture: press14PreflightRuntimeMs + config.aiInvestigator.openAiTimeoutMs + 2_000 <= config.aiInvestigator.totalTimeoutMs,
    allPressesTokenGate: allProfile.estimatedInputTokens <= 6_000,
    selectedToolPayloadGate: selectedPayloadProfiles.every((item) => item.serializedBytes < MAX_TOOL_PAYLOAD_BYTES),
    allPressesToolPayloadGate: fleetPayloadProfiles.every((item) => item.serializedBytes < MAX_TOOL_PAYLOAD_BYTES),
    evidenceReferencesValid: Object.values(referenceTotals).every((value) => value === 0),
    noRawUnmappedTelemetryScans: rawUnmappedTelemetryScans === 0,
    readOnlyGuaranteesHeld: config.radius.user === 'processintelligence_readonly' && artifact.safety.databaseWrites === 0 && artifact.safety.schemaChanges === 0,
    selectedContextualBaselineSupportValid: selectedContextSupportValid,
    fleetContextualBaselineSupportValid: fleetContextSupportValid,
    relationshipQualificationValid: relationshipVisibleValid,
    fleetCompactionInvariant: fleetCompaction.every((item) => item.detailedAnalyticalObservations <= 1 && item.materialComparisons <= 1),
    selectedTraceLimit: press14.candidates.every((candidate) => (candidate.traces?.length ?? 0) <= 6),
    selectedModelTraceLimit: selectedModelComposition.every((candidate) => candidate.total <= 5 && candidate.telemetry <= 3 && candidate.radius <= 1 && candidate.productionContext <= 1),
    fleetTraceLimit: allPresses.candidates.filter((candidate) => (candidate.traces?.length ?? 0) > 0).length <= 2 && allPresses.candidates.every((candidate) => (candidate.traces?.length ?? 0) <= 6),
    rawRadiusRepresentativeValidationPassed: rawRadius.status === 'PASS',
    telemetryEventRepresentativeValidationPassed: telemetryEvent.status === 'PASS',
    openAiRequestsZero: artifact.safety.openAiApiRequests === 0,
  }
  artifact.safety = { ...artifact.safety, rawUnmappedTelemetryScans, checkpointWriteMs, totalRuntimeMs: Date.now() - began }
  artifact.gates = { ...gates, referenceTotals }
  artifact.status = Object.values(gates).every(Boolean) ? 'READY' : 'NOT_READY'
  if (artifact.status === 'NOT_READY') artifact.failure = { phase: activePhase, code: 'final_production_revalidation_gate_failed', failedGates: Object.entries(gates).filter(([, passed]) => !passed).map(([gate]) => gate) }
  await checkpoint('final_readiness')

  console.log(`Validation artifact: ${artifactPath}`)
  console.log(`Press 14: ${press14RuntimeMs} ms, ${press14.performance.dataServiceQueries} queries, ${selectedLargestPayload?.serializedBytes ?? 0} tool bytes, ${press14Profile.estimatedInputTokens} tokens`)
  console.log(`All Presses: ${allRuntimeMs} ms, ${allPresses.performance.dataServiceQueries} queries, ${fleetLargestPayload?.serializedBytes ?? 0} max tool bytes, ${allProfile.estimatedInputTokens} tokens, ${allPresses.candidates.length} candidates`)
  console.log('OpenAI API requests: 0')
  if (artifact.status !== 'READY') throw new Error('final_production_revalidation_gate_failed')
}

await run().catch(async (error: unknown) => {
  artifact.status = 'NOT_READY'
  if (!artifact.failure) artifact.failure = error instanceof AiToolPayloadTooLargeError
    ? { phase: activePhase, code: error.code, context: error.context, ...error.profile }
    : { phase: activePhase, code: error instanceof Error && /^[a-z0-9_:.-]+$/i.test(error.message) ? error.message.slice(0, 240) : 'validation_phase_failed' }
  try { await checkpoint() } catch { /* Preserve the original bounded validation failure. */ }
  console.error(`Validation stopped in ${activePhase}: ${error instanceof Error ? error.message : 'validation_phase_failed'}`)
  console.error('OpenAI API requests: 0')
  process.exitCode = 1
})
