import type { PhysicalStateResponse } from '../../src/telemetry/models.js'
import type { TelemetryCapabilitiesResponse, TelemetryMachineSpeedHistory, TelemetrySemanticHistoryResponse } from '../../src/telemetry/telemetry-contracts.js'

export const sourcesFixture = [
  { id: 41, sourceKey: 'press5', displayName: 'Press 5', enabled: true },
  { id: 42, sourceKey: 'press12', displayName: 'Press 12', enabled: true },
  { id: 43, sourceKey: 'press14', displayName: 'Press 14', enabled: true },
  { id: 44, sourceKey: 'press15', displayName: 'Press 15', enabled: false },
]

const context = ['production.job', 'production.order', 'production.recipe', 'production.customer', 'production.material', 'production.roll']
const capability = (canonicalId: string, supported = true, deckNumbers: number[] = []) => ({ canonicalId, supported, deckNumbers: supported ? deckNumbers : [], historyQueryable: supported, evidenceKind: 'semantic_history' as const })

export const press5CapabilitiesFixture: TelemetryCapabilitiesResponse = {
  sourceId: 41, sourceKey: 'press5', displayName: 'Press 5',
  capabilities: [...context.map((id) => capability(id)), capability('machine.speed.actual'), capability('machine.speed.setpoint'), { ...capability('physical.motion_state'), evidenceKind: 'derived' }, ...['deck.active', 'deck.print_on', 'deck.print_off', 'ink.temperature.actual'].map((id) => capability(id, true, [1, 2, 3]))],
}

export const press12CapabilitiesFixture: TelemetryCapabilitiesResponse = {
  sourceId: 42, sourceKey: 'press12', displayName: 'Press 12',
  capabilities: [...context.map((id) => capability(id)), ...['deck.active', 'deck.print_on', 'deck.print_off'].map((id) => capability(id, false)), capability('register.long.actual_or_correction', true, [1, 2, 3]), capability('impression.anilox.drive_side', true, [1, 2, 3]), capability('ink.washup.state', true, [1, 2, 3]), capability('ink.pump.status', true, [1, 2, 3])],
}

export const press14CapabilitiesFixture: TelemetryCapabilitiesResponse = {
  sourceId: 43, sourceKey: 'press14', displayName: 'Press 14',
  capabilities: [...context.map((id) => capability(id, !['production.job', 'production.material'].includes(id))), ...['deck.active', 'deck.print_on', 'deck.print_off'].map((id) => capability(id, false)), capability('machine.speed.actual'), capability('machine.speed.setpoint'), { ...capability('physical.motion_state'), evidenceKind: 'derived' }],
}

const sample = (valueKind: 'numeric' | 'integer' | 'boolean' | 'string', value: number | boolean | string, observedAtUtc = '2026-08-12T03:29:25.000Z') => ({ observedAtUtc, receivedAtUtc: observedAtUtc, sourceTimestampUtc: '2026-08-12T03:29:20.000Z', qualityState: 'true', valueKind, value })
const unsupported = (canonicalId: string) => ({ canonicalId, deckNumber: null, supported: false, mappingStatus: 'UNAVAILABLE' as const, historianSignalId: null, rawSignalId: null, sourceUnit: null, canonicalUnitStatus: null, valueKind: null, sourceSelector: null, selectedVariant: null, representation: 'changes' as const, seedSample: null, samples: [], changes: [] })

export const mixedHistoryFixture: TelemetrySemanticHistoryResponse = {
  sourceId: 41, sourceKey: 'press5', displayName: 'Press 5', fromUtc: '2026-08-12T03:30:00.000Z', toUtc: '2026-08-12T03:35:00.000Z', includeSeed: true,
  signals: [
    { canonicalId: 'production.order', deckNumber: null, supported: true, mappingStatus: 'MAPPED', historianSignalId: 1, rawSignalId: 'sanitized.order', sourceUnit: null, canonicalUnitStatus: 'unverified', valueKind: 'string', sourceSelector: null, selectedVariant: 'primary', representation: 'changes', seedSample: sample('string', 'ORDER-REDACTED'), samples: [], changes: [{ ...sample('string', 'ORDER-REDACTED-2', '2026-08-12T03:32:00.000Z'), previousObservedAtUtc: '2026-08-12T03:29:25.000Z', previousReceivedAtUtc: '2026-08-12T03:29:25.000Z', previousSourceTimestampUtc: '2026-08-12T03:29:20.000Z', previousQualityState: 'true', previousValueKind: 'string', previousValue: 'ORDER-REDACTED' }] },
    { canonicalId: 'deck.active', deckNumber: 2, supported: true, mappingStatus: 'MAPPED', historianSignalId: 2, rawSignalId: 'sanitized.deck.active', sourceUnit: null, canonicalUnitStatus: 'unverified', valueKind: 'integer', sourceSelector: '[2]', selectedVariant: 'primary', representation: 'changes', seedSample: sample('integer', 0), samples: [], changes: [] },
    { canonicalId: 'ink.temperature.actual', deckNumber: 3, supported: true, mappingStatus: 'MAPPED', historianSignalId: 3, rawSignalId: 'sanitized.ink.temperature', sourceUnit: null, canonicalUnitStatus: 'unverified', valueKind: 'numeric', sourceSelector: '[3]', selectedVariant: 'primary', representation: 'samples', seedSample: sample('numeric', 21.5), samples: [sample('numeric', 22.25, '2026-08-12T03:31:00.000Z')], changes: [] },
    { canonicalId: 'test.boolean', deckNumber: null, supported: true, mappingStatus: 'MAPPED', historianSignalId: 4, rawSignalId: 'sanitized.boolean', sourceUnit: null, canonicalUnitStatus: 'unverified', valueKind: 'boolean', sourceSelector: null, selectedVariant: 'primary', representation: 'samples', seedSample: sample('boolean', false), samples: [], changes: [] },
    unsupported('production.job'),
  ],
}

export const press14SpeedFixture: TelemetryMachineSpeedHistory = {
  sourceId: 43, sourceKey: 'press14', displayName: 'Press 14', fromUtc: '2026-08-12T03:30:00.000Z', toUtc: '2026-08-12T03:35:00.000Z',
  actual: { canonicalId: 'machine.speed.actual', historianSignalId: 10, rawSignalId: 'sanitized.speed.actual', sourceUnit: 'ft/min', canonicalUnitStatus: 'unverified', samples: [sample('integer', 0), sample('numeric', 25.5, '2026-08-12T03:31:00.000Z')] },
  setpoint: { canonicalId: 'machine.speed.setpoint', historianSignalId: 11, rawSignalId: 'sanitized.speed.setpoint', sourceUnit: 'ft/min', canonicalUnitStatus: 'unverified', samples: [sample('integer', 100)] },
}

export const press5SpeedFixture: TelemetryMachineSpeedHistory = {
  ...press14SpeedFixture,
  sourceId: 41,
  sourceKey: 'press5',
  displayName: 'Press 5',
  actual: { ...press14SpeedFixture.actual, sourceUnit: null },
  setpoint: press14SpeedFixture.setpoint ? { ...press14SpeedFixture.setpoint, sourceUnit: null } : null,
}

const contextSignal = (canonicalId: string, value: string) => ({ ...mixedHistoryFixture.signals[0]!, canonicalId, seedSample: sample('string', value), changes: [] })
const integerChange = (previousValue: number, value: number) => ({ ...sample('integer', value, '2026-08-12T03:32:00.000Z'), previousObservedAtUtc: '2026-08-12T03:29:25.000Z', previousReceivedAtUtc: '2026-08-12T03:29:25.000Z', previousSourceTimestampUtc: '2026-08-12T03:29:20.000Z', previousQualityState: 'true', previousValueKind: 'integer' as const, previousValue })

export const press12EvidenceFixture: TelemetrySemanticHistoryResponse = {
  ...mixedHistoryFixture,
  sourceId: 42,
  sourceKey: 'press12',
  displayName: 'Press 12',
  signals: [
    ...context.map((id) => contextSignal(id, `${id.toUpperCase()}-REDACTED`)),
    { ...unsupported('deck.active'), deckNumber: 2 },
    { ...mixedHistoryFixture.signals[2]!, canonicalId: 'register.long.actual_or_correction', deckNumber: 3, seedSample: sample('integer', 0), samples: [sample('numeric', 0.25, '2026-08-12T03:31:00.000Z')] },
    { ...mixedHistoryFixture.signals[1]!, canonicalId: 'impression.anilox.drive_side', deckNumber: 3, changes: [integerChange(0, 20)] },
    { ...mixedHistoryFixture.signals[1]!, canonicalId: 'ink.washup.state', deckNumber: 3, changes: [integerChange(0, 512)] },
    { ...mixedHistoryFixture.signals[1]!, canonicalId: 'ink.pump.status', deckNumber: 3, seedSample: sample('integer', 1), changes: [integerChange(1, 11)] },
  ],
}

export const press14ContextFixture: TelemetrySemanticHistoryResponse = {
  ...mixedHistoryFixture,
  sourceId: 43,
  sourceKey: 'press14',
  displayName: 'Press 14',
  signals: [
    unsupported('production.job'),
    contextSignal('production.order', 'ORDER-REDACTED'),
    contextSignal('production.recipe', 'RECIPE-REDACTED'),
    contextSignal('production.customer', 'CUSTOMER-REDACTED'),
    unsupported('production.material'),
    contextSignal('production.roll', 'ROLL-REDACTED'),
    { ...unsupported('deck.active'), deckNumber: 2 },
  ],
}

export const motionFixture: PhysicalStateResponse = {
  sourceId: 41, sourceKey: 'press5', displayName: 'Press 5', fromUtc: '2026-08-12T03:30:00.000Z', toUtc: '2026-08-12T03:35:00.000Z',
  policy: { stopSpeedAbsoluteMax: 2, runningSpeedAbsoluteMin: 25, stateDebounceSeconds: 15, telemetryStaleSeconds: 30, unitStatus: 'unverified' },
  summary: { durationsMs: { RUNNING: 120000, STOPPED: 120000, TRANSITION: 30000, UNKNOWN: 30000 }, durationsSeconds: { RUNNING: 120, STOPPED: 120, TRANSITION: 30, UNKNOWN: 30 }, segmentCount: 4 },
  segments: [
    { state: 'RUNNING', fromUtc: '2026-08-12T03:30:00.000Z', toUtc: '2026-08-12T03:32:00.000Z', durationMs: 120000, actualSpeedAtStart: 30, targetCommanded: true },
    { state: 'STOPPED', fromUtc: '2026-08-12T03:32:00.000Z', toUtc: '2026-08-12T03:34:00.000Z', durationMs: 120000, actualSpeedAtStart: 0, targetCommanded: false },
    { state: 'TRANSITION', fromUtc: '2026-08-12T03:34:00.000Z', toUtc: '2026-08-12T03:34:30.000Z', durationMs: 30000 },
    { state: 'UNKNOWN', fromUtc: '2026-08-12T03:34:30.000Z', toUtc: '2026-08-12T03:35:00.000Z', durationMs: 30000 },
  ],
}
