import type { RadiusPressKey } from '../../src/radius/models.js'
import type { AiGroundingFact } from '../../src/ai-investigator/contracts.js'
import { AI_INVESTIGATOR_TOOL_DEFINITIONS, type AiInvestigatorToolExecutor, type AiToolExecutionContext, type AiToolResult } from '../../src/ai-investigator/read-only-tools.js'
import { buildCategoricalTemporalEvidenceProgram, buildNumericTemporalEvidenceProgram } from '../../src/industrial-analytics/temporal-evidence.js'

export const fixtureCurrent = { startUtc: '2026-08-16T12:00:00.000Z', endUtc: '2026-08-17T12:00:00.000Z' }
export const fixtureBaseline = { startUtc: '2026-08-15T12:00:00.000Z', endUtc: fixtureCurrent.startUtc }

interface FixtureRow { pressKey: RadiusPressKey; current: [number, number, number, number]; baseline: [number, number, number, number]; drivers: string[] }
export const discoveryRows: FixtureRow[] = [
  { pressKey: 'press3', current: [96, 72, 4, 44], baseline: [96, 74, 4, 42], drivers: ['Setup', 'Material wait'] },
  { pressKey: 'press5', current: [95, 68, 5, 70], baseline: [95, 71, 4, 66], drivers: ['Make ready', 'Cleaning'] },
  { pressKey: 'press6', current: [97, 61, 14, 110], baseline: [97, 65, 9, 80], drivers: ['Feeder fault', 'Sheet detector'] },
  { pressKey: 'press7', current: [94, 77, 3, 38], baseline: [94, 76, 3, 41], drivers: ['Make ready', 'Operator stop'] },
  { pressKey: 'press8', current: [93, 70, 6, 75], baseline: [94, 73, 5, 70], drivers: ['Delivery stop', 'Make ready'] },
  { pressKey: 'press9', current: [96, 80, 2, 31], baseline: [96, 79, 2, 29], drivers: ['Wash up', 'Setup'] },
  { pressKey: 'press10', current: [98, 45, 10, 300], baseline: [98, 65, 8, 180], drivers: ['Feeder / F12 / Sheet feed', 'Delivery / D7 / Pile change', 'Make ready'] },
  { pressKey: 'press11', current: [96, 74, 5, 60], baseline: [96, 73, 4, 55], drivers: ['Make ready', 'Cleaning'] },
  { pressKey: 'press12', current: [95, 59, 8, 145], baseline: [95, 66, 6, 82], drivers: ['Blanket wash', 'Registration'] },
  { pressKey: 'press13', current: [97, 52, 15, 170], baseline: [97, 63, 7, 90], drivers: ['Radius R42 / delivery jam', 'Radius R18 / feeder trip', 'Make ready'] },
  { pressKey: 'press14', current: [99, 40.7, 8, 384.7], baseline: [99, 63.8, 4, 549.8], drivers: ['Radius R31 / web break', 'Radius R22 / tension', 'Make ready'] },
  { pressKey: 'press15', current: [92, 67, 2, 40], baseline: [91, 69, 3, 48], drivers: ['Setup'] },
]

function fact(row: FixtureRow, metric: string, value: string | number | null, unit: string | null, suffix: string, label: string, range: { start: string; end: string }, timestamp?: string): AiGroundingFact {
  return { factId: `${row.pressKey}.${suffix}`, pressKey: row.pressKey, press: row.pressKey.replace('press', 'Press '), source: metric === 'coveragePercent' ? 'coverage' : 'radius', metric, value, unit, role: timestamp ? 'event' : 'current', usable: value !== null, label, range, ...(timestamp ? { timestamp } : {}) }
}

function fleetResult(period: 'current' | 'baseline', selected: RadiusPressKey | null): AiToolResult {
  const index = period === 'current' ? 0 : 1; const range = period === 'current' ? { start: fixtureCurrent.startUtc, end: fixtureCurrent.endUtc } : { start: fixtureBaseline.startUtc, end: fixtureBaseline.endUtc }
  const selectedRows = discoveryRows.filter((row) => !selected || row.pressKey === selected)
  const presses = selectedRows.map((row) => {
    const values = index === 0 ? row.current : row.baseline
    return { press: row.pressKey.replace('press', 'Press '), pressKey: row.pressKey, coveragePercent: values[0], productionPercent: values[1], productionInterruptions: values[2], longestInterruptionMinutes: values[3] }
  })
  const facts = selectedRows.flatMap((row) => {
    const values = index === 0 ? row.current : row.baseline
    return [
      fact(row, 'coveragePercent', values[0], 'percent', 'coverage_percent.current', 'Data coverage', range),
      fact(row, 'productionPercent', values[1], 'percent', 'production_percent.current', 'Production time', range),
      fact(row, 'interruptions', values[2], 'count', 'interruptions.current', 'Production interruptions', range),
      fact(row, 'longestInterruptionMinutes', values[3], 'minutes', 'longest_interruption_minutes.current', 'Longest interruption', range),
      ...row.drivers.slice(0, 3).map((driver, driverIndex) => fact(row, 'radiusDriverDurationMinutes', Math.max(20, values[3] - driverIndex * 37), 'minutes', `radius_driver.driver${driverIndex + 1}.duration_minutes.current`, driver, range)),
    ]
  })
  return { range, scope: selected ?? 'all', presses, facts, limitations: ['Unavailable time is separate from operational state.'] }
}

function eventResult(row: FixtureRow, includeTraces = false): AiToolResult {
  const range = { start: fixtureCurrent.startUtc, end: fixtureCurrent.endUtc }
  const facts: AiGroundingFact[] = []
  for (let index = 0; index < 3; index += 1) {
    const timestamp = `2026-08-17T0${index + 2}:00:00.000Z`; const key = `event${index + 1}`
    facts.push(fact(row, 'eventTimestamp', timestamp, 'iso8601', `event.${key}.timestamp`, `Interruption ${index + 1}`, range, timestamp))
    facts.push(fact(row, 'eventDurationMinutes', round(row.current[3] / (index + 1)), 'minutes', `event.${key}.duration_minutes`, `Interruption ${index + 1} duration`, range))
  }
  row.drivers.slice(0, 3).forEach((driver, index) => facts.push(fact(row, 'radiusDriverDurationMinutes', round(row.current[3] / (index + 1)), 'minutes', `radius_driver.event${index + 1}.duration_minutes.event`, driver, range)))
  ;(['job', 'order', 'recipe'] as const).forEach((field, index) => {
    facts.push({ ...fact(row, field, `${field.toUpperCase()}-${row.pressKey.slice(5)}-${index + 1}`, null, `context.${field}.event${index + 1}.event`, field[0].toUpperCase() + field.slice(1), range, `2026-08-17T02:0${index}:00.000Z`), source: 'production_context' })
  })
  const event = { start: '2026-08-17T02:00:00.000Z', end: '2026-08-17T02:10:00.000Z' }; const traceRange = { start: '2026-08-17T01:40:00.000Z', end: '2026-08-17T02:30:00.000Z' }
  const numericTraces = includeTraces ? ['machine.speed.actual', 'ink.temperature.actual', 'web.tension.actual', 'drive.load.actual'].flatMap((canonicalId, signalIndex) => { const trace = buildNumericTemporalEvidenceProgram({ candidateId: row.pressKey, pressKey: row.pressKey, eventId: `${row.pressKey}-event`, canonicalId, unit: null, range: traceRange, event, samples: Array.from({ length: 26 }, (_item, index) => ({ atUtc: new Date(Date.parse(traceRange.start) + index * 2 * 60_000).toISOString(), value: signalIndex * 20 + (index < 10 ? index : index < 18 ? 20 - index : index - 8) })), selectedBecause: ['material bounded Delta', 'temporal proximity'] }); return trace ? [trace] : [] }) : []
  const stateTrace = includeTraces ? buildCategoricalTemporalEvidenceProgram({ candidateId: row.pressKey, pressKey: row.pressKey, eventId: `${row.pressKey}-event`, canonicalId: 'radius.sequence', datatype: 'radius', range: traceRange, event, samples: [{ atUtc: traceRange.start, value: 'Run Production' }, { atUtc: event.start, value: 'Make Ready' }, { atUtc: event.end, value: 'Run Production' }], selectedBecause: ['candidate Radius sequence'] }) : null
  const contextTrace = includeTraces ? buildCategoricalTemporalEvidenceProgram({ candidateId: row.pressKey, pressKey: row.pressKey, eventId: `${row.pressKey}-event`, canonicalId: 'production.context.identity', datatype: 'production_context', range: traceRange, event, samples: [{ atUtc: traceRange.start, value: `JOB-${row.pressKey.slice(5)} / RECIPE-1` }, { atUtc: event.start, value: `JOB-${row.pressKey.slice(5)} / RECIPE-2` }, { atUtc: event.end, value: `JOB-${row.pressKey.slice(5)} / RECIPE-2` }], selectedBecause: ['trusted production context'] }) : null
  return { press: row.pressKey.replace('press', 'Press '), pressKey: row.pressKey, range, facts, temporalEvidencePrograms: [...numericTraces, ...(stateTrace ? [stateTrace] : []), ...(contextTrace ? [contextTrace] : [])], limitations: ['Broad telemetry scanning is deferred.'] }
}

function round(value: number): number { return Math.round(value * 10) / 10 }

export class DiscoveryFixtureExecutor implements AiInvestigatorToolExecutor {
  readonly definitions = AI_INVESTIGATOR_TOOL_DEFINITIONS
  readonly calls: Array<{ name: string; arguments: unknown }> = []
  constructor(private readonly includeTraces = false) {}
  async execute(name: string, rawArguments: unknown, _context: AiToolExecutionContext): Promise<AiToolResult> {
    this.calls.push({ name, arguments: rawArguments }); const args = rawArguments as Record<string, unknown>
    if (name === 'get_fleet_operational_summary') return fleetResult(args.start === fixtureCurrent.startUtc ? 'current' : 'baseline', args.press as RadiusPressKey | null)
    if (name === 'get_press_event_summary') return eventResult(discoveryRows.find((row) => row.pressKey === args.press)!, this.includeTraces)
    throw new Error(`fixture_tool_not_implemented:${name}`)
  }
}
