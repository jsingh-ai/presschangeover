import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { ENGINEERING_SIGNAL_CATALOG, capabilityFor, signalKey } from '../src/engineering-signal-catalog'
import { appendEngineeringPin, engineeringEvidenceWindow, engineeringSignalReadout, safeEngineeringSourceUnit } from '../src/components/EngineeringTelemetryInspector'
import type { SemanticSignalEvidence, SignalCapability } from '../src/types/evidence'

const startUtc = '2026-08-13T12:00:00.000Z'
const endUtc = '2026-08-13T12:30:00.000Z'
const inspectorSource = readFileSync(new URL('../src/components/EngineeringTelemetryInspector.tsx', import.meta.url), 'utf8')
const cluesSource = readFileSync(new URL('../src/components/TelemetryCluesPanel.tsx', import.meta.url), 'utf8')
const timelineSource = readFileSync(new URL('../src/components/SynchronizedTimeline.tsx', import.meta.url), 'utf8')

function signal(partial: Partial<SemanticSignalEvidence> = {}): SemanticSignalEvidence {
  return { canonicalId: 'machine.speed.actual', deckNumber: null, capabilityState: 'SUPPORTED', observationState: 'SUPPORTED_WITH_OBSERVATIONS', mappingStatus: 'MAPPED', sourceUnit: null, canonicalUnitStatus: 'unverified', representation: 'samples', seed: null, samples: [], changes: [], ...partial }
}

describe('Engineering Telemetry Phase 2', () => {
  it('builds exact short-occurrence presets and rejects custom windows over two hours', () => {
    assert.deepEqual(engineeringEvidenceWindow({ startUtc, endUtc }, 'padding15'), { fromUtc: '2026-08-13T11:45:00.000Z', toUtc: '2026-08-13T12:45:00.000Z', mode: 'padding15' })
    assert.deepEqual(engineeringEvidenceWindow({ startUtc, endUtc }, 'occurrence'), { fromUtc: startUtc, toUtc: endUtc, mode: 'occurrence' })
    assert.throws(() => engineeringEvidenceWindow({ startUtc, endUtc }, 'custom', { fromUtc: startUtc, toUtc: '2026-08-13T14:00:00.001Z' }), /two hours or less/)
  })

  it('uses explicit entry, middle, and exit windows for long occurrences', () => {
    const occurrence = { startUtc, endUtc: '2026-08-13T18:00:00.000Z' }
    assert.deepEqual(engineeringEvidenceWindow(occurrence, 'entry'), { fromUtc: startUtc, toUtc: '2026-08-13T14:00:00.000Z', mode: 'entry' })
    assert.deepEqual(engineeringEvidenceWindow(occurrence, 'middle'), { fromUtc: '2026-08-13T14:00:00.000Z', toUtc: '2026-08-13T16:00:00.000Z', mode: 'middle' })
    assert.deepEqual(engineeringEvidenceWindow(occurrence, 'exit'), { fromUtc: '2026-08-13T16:00:00.000Z', toUtc: '2026-08-13T18:00:00.000Z', mode: 'exit' })
  })

  it('reports the nearest continuous observation without fabricating interpolation', () => {
    const history = signal({ samples: [
      { observedAtUtc: '2026-08-13T12:00:01.000Z', receivedAtUtc: '2026-08-13T12:00:01.000Z', sourceTimestampUtc: '2026-08-13T12:00:01.000Z', qualityState: 'GOOD', valueKind: 'numeric', value: 10 },
      { observedAtUtc: '2026-08-13T12:00:09.000Z', receivedAtUtc: '2026-08-13T12:00:09.000Z', sourceTimestampUtc: '2026-08-13T12:00:09.000Z', qualityState: 'GOOD', valueKind: 'numeric', value: 30 },
    ] })
    assert.deepEqual(engineeringSignalReadout({ canonicalId: 'machine.speed.actual' }, history, '2026-08-13T12:00:06.000Z'), { value: '30', observedAtUtc: '2026-08-13T12:00:09.000Z', differenceMs: 3_000 })
  })

  it('uses the last observed step/state value and exposes its real timestamp', () => {
    const history = signal({ canonicalId: 'ink.pump.status', deckNumber: 4, representation: 'changes', seed: { observedAtUtc: '2026-08-13T11:59:00.000Z', receivedAtUtc: '2026-08-13T11:59:00.000Z', sourceTimestampUtc: '2026-08-13T11:59:00.000Z', qualityState: 'GOOD', valueKind: 'integer', value: 1 }, changes: [{ observedAtUtc: '2026-08-13T12:00:05.000Z', receivedAtUtc: '2026-08-13T12:00:05.000Z', sourceTimestampUtc: '2026-08-13T12:00:05.000Z', qualityState: 'GOOD', valueKind: 'integer', value: 11, previousObservedAtUtc: '2026-08-13T11:59:00.000Z', previousReceivedAtUtc: '2026-08-13T11:59:00.000Z', previousSourceTimestampUtc: '2026-08-13T11:59:00.000Z', previousQualityState: 'GOOD', previousValueKind: 'integer', previousValue: 1 }] })
    assert.deepEqual(engineeringSignalReadout({ canonicalId: 'ink.pump.status', deckNumber: 4 }, history, '2026-08-13T12:00:07.000Z'), { value: 'raw code 11', observedAtUtc: '2026-08-13T12:00:05.000Z', differenceMs: 2_000 })
  })

  it('suppresses B&R array-index artifacts while retaining explicit source units as unverified', () => {
    assert.equal(safeEngineeringSourceUnit(signal({ sourceUnit: '3' })), null)
    assert.equal(safeEngineeringSourceUnit(signal({ sourceUnit: 'ft/min' })), 'ft/min')
    assert.match(inspectorSource, /Source unit:.*— unverified/)
    assert.doesNotMatch(inspectorSource, /normal range|operating limit/i)
  })

  it('contains the full mapped machine/deck catalog and keeps ambiguous concepts explicit', () => {
    for (const canonicalId of ['machine.speed.actual', 'web_tension.chill_draw.actual', 'dryer.tunnel.temperature.actual', 'ink.viscosity.actual', 'ink.temperature.actual', 'ink.pump.frequency.supply', 'register.long.actual_or_correction', 'impression.anilox.drive_side.rated_or_setpoint', 'anilox.drive.torque.actual', 'plate_cylinder.drive.torque.actual', 'doctor_blade.pressure', 'repeat_length.correction', 'deck.active']) assert.ok(ENGINEERING_SIGNAL_CATALOG.some((item) => item.canonicalId === canonicalId), canonicalId)
    assert.equal(ENGINEERING_SIGNAL_CATALOG.find(({ canonicalId }) => canonicalId === 'register.long.actual_or_correction')?.ambiguous, true)
    assert.doesNotMatch(ENGINEERING_SIGNAL_CATALOG.map(({ canonicalId }) => canonicalId).join(' '), /deck\.11|deck\.12/i)
  })

  it('revalidates deck pins against each press capability without deleting identity', () => {
    const capability: SignalCapability = { canonicalId: 'anilox.drive.torque.actual', state: 'SUPPORTED', deckNumbers: [1, 2, 3, 4, 5, 6, 7, 8, 9], historyQueryable: true, evidenceKind: 'semantic_history' }
    const pin = { canonicalId: capability.canonicalId, deckNumber: 10 }
    assert.equal(capabilityFor([capability], pin)?.state, 'UNSUPPORTED')
    assert.equal(signalKey(pin), 'anilox.drive.torque.actual:10')
    assert.match(inspectorSource, /Not available on this press/)
  })

  it('integrates clue and matrix actions with browser targets and exact pin identities', () => {
    assert.match(cluesSource, /View in Engineering Telemetry/)
    assert.match(cluesSource, /onOpen\(scopeKey, category\)/)
    assert.match(cluesSource, /matchingClue\?\.canonicalId/)
    assert.match(cluesSource, /pinState\.pin\(\{ canonicalId: clue\.canonicalId/)
  })

  it('limits and persists pins in session storage and retains unsupported pins', () => {
    const twelve = Array.from({ length: 12 }, (_, index) => ({ canonicalId: `signal.${index}` }))
    assert.deepEqual(appendEngineeringPin(twelve, { canonicalId: 'signal.12' }), { pins: twelve, message: 'Up to 12 signals can be pinned at once.' })
    assert.deepEqual(appendEngineeringPin(twelve, { canonicalId: 'signal.1' }), { pins: twelve, message: 'That signal is already pinned.' })
    assert.match(inspectorSource, /MAX_PINS = 12/)
    assert.match(inspectorSource, /sessionStorage\.setItem/)
    assert.match(inspectorSource, /Do not|Not available on this press/)
    assert.match(inspectorSource, /signals can be pinned at once/)
    assert.match(inspectorSource, /pins remain for Previous\/Next occurrence/)
  })

  it('loads only pins and the open category, batches at 50, and guards stale requests', () => {
    assert.match(inspectorSource, /\.\.\.pins\.map/)
    assert.match(inspectorSource, /\.\.\.browserSignals/)
    assert.match(inspectorSource, /chunk\(normal, 50\)/)
    assert.match(inspectorSource, /version !== requestVersion\.current/)
    assert.match(inspectorSource, /controller\.signal\.aborted/)
    assert.match(inspectorSource, /cache\.current\.size > 160/)
  })

  it('uses one stacked timeline, occurrence highlighting, and keyboard crosshair movement', () => {
    assert.match(inspectorSource, /Pinned engineering signals synchronized/)
    assert.match(inspectorSource, /highlightedRange=/)
    assert.match(inspectorSource, /observedAtUtc/)
    assert.match(timelineSource, /ArrowLeft/)
    assert.match(timelineSource, /ArrowRight/)
    assert.match(timelineSource, /onInspectionTimeChange/)
    assert.match(timelineSource, /synchronized-timeline__highlight/)
  })

  it('keeps the language investigative and non-causal', () => {
    const source = `${inspectorSource}\n${cluesSource}`
    assert.doesNotMatch(source, /root cause|health score|operator score|efficiency score|normal range|abnormal|failure detected|caused by/i)
    assert.doesNotMatch(source, /S\s*\/\s*400[\s\S]{0,60}Safety/i)
  })
})
