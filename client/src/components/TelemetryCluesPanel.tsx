import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { getEngineeringClues, getPressMotion, getPressSemanticHistory } from '../api/process-intelligence-api'
import { formatDuration } from '../episode-presentation'
import { formatPlantDateTime } from '../time-ranges'
import type { ActivityOccurrence } from '../types/api'
import type { EngineeringCategory, EngineeringClueResponse, EngineeringSignalClue, PressMotionEvidence, PressSemanticHistoryEvidence, TimedNumericSample } from '../types/evidence'
import { SynchronizedTimeline, type TimelineEventTrack, type TimelineIntervalTrack, type TimelineNumericTrack } from './SynchronizedTimeline'

const CATEGORY_LABELS: Record<EngineeringCategory, string> = {
  speed: 'Speed', web_tension: 'Web / Tension', dryer: 'Dryer', ink: 'Ink', viscosity: 'Viscosity', temperature: 'Temperature', pump: 'Pump', wash: 'Wash', register: 'Register', impression: 'Impression', torque: 'Torque', drive_temperature: 'Drive Temperature', doctor_blade: 'Doctor Blade', repeat_other: 'Repeat / Other', motion: 'Motion',
}

function occurrenceInput(occurrence: ActivityOccurrence) {
  return { occurrenceId: occurrence.occurrenceId, displayName: occurrence.displayName, startUtc: occurrence.startUtc, endUtc: occurrence.endUtc, exactIdentities: occurrence.exactIdentities.map(({ eventType, statusCode, statusDescription }) => ({ eventType, statusCode, statusDescription })) }
}

function offsetLabel(offsetMs: number | null): string {
  if (offsetMs === null) return 'No qualifying change timestamp'
  if (Math.abs(offsetMs) < 1_000) return 'At Radius entry'
  const value = formatDuration(Math.round(Math.abs(offsetMs) / 1_000))
  return `${offsetMs < 0 ? '−' : '+'}${value}`
}

function phase(offsetMs: number | null): 'Before Radius entry' | 'At / near Radius entry' | 'After Radius entry' {
  if (offsetMs === null || Math.abs(offsetMs) <= 30_000) return 'At / near Radius entry'
  return offsetMs < 0 ? 'Before Radius entry' : 'After Radius entry'
}

function number(value: number | null): string { return value === null ? '—' : Number(value.toFixed(3)).toLocaleString() }

function summary(label: string, value: EngineeringSignalClue['before']) {
  if (!value) return null
  return <div><dt>{label}</dt><dd>{value.count ? `median ${number(value.median)} · range ${number(value.minimum)}–${number(value.maximum)} · IQR ${number(value.iqr)} · n=${value.count}` : 'No observations'}</dd></div>
}

function confidenceLabel(clue: EngineeringSignalClue): string {
  if (clue.observationConfidence === 'OBSERVED') return 'Observed in comparison windows'
  if (clue.observationConfidence === 'LIMITED_OBSERVATION') return 'Limited observation; comparison not supported'
  if (clue.observationConfidence === 'NO_USABLE_OBSERVATION') return 'No usable observations in this window'
  if (clue.observationConfidence === 'TEMPORARILY_UNAVAILABLE') return 'Temporarily unavailable'
  return 'Unsupported on this press'
}

function firstEvidenceLabel(item: EngineeringClueResponse['firstChanges'][number]): string {
  if (item.signalType === 'continuous') return `First observed evidence of this distribution shift · ${formatPlantDateTime(item.firstRelevantAtUtc!)} CT`
  return `Raw transition observed · ${formatPlantDateTime(item.firstRelevantAtUtc!)} CT · ${String(item.firstRelevantPreviousValue)} → ${String(item.firstRelevantValue)}`
}

function mapCellText(status: EngineeringClueResponse['categoryCells'][number]['status'] | undefined, clueSignals = 0): string {
  if (status === 'multiple_clues') return String(clueSignals)
  if (status === 'one_clue') return '1'
  if (status === 'observed_no_shift') return 'No shift'
  if (status === 'insufficient') return 'Limited'
  if (status === 'temporarily_unavailable') return 'Unavailable'
  if (status === 'unknown') return 'Unknown'
  return '—'
}

function TelemetryChangeMap({ data }: { data: EngineeringClueResponse }) {
  const scopeOrder = ['machine', ...Array.from({ length: 10 }, (_, index) => `deck-${index + 1}`)]
  const rows = scopeOrder.filter((scopeKey) => data.categoryCells.some((cell) => cell.scopeKey === scopeKey))
  const preferred = data.categoryCells.find(({ clueSignals }) => clueSignals > 0) ?? data.categoryCells[0]
  const preferredKey = preferred ? `${preferred.scopeKey}:${preferred.category}` : ''
  const [activeKey, setActiveKey] = useState(preferredKey)
  const cellRefs = useRef(new Map<string, HTMLButtonElement>())

  useEffect(() => { setActiveKey(preferredKey) }, [preferredKey])

  function move(event: KeyboardEvent<HTMLButtonElement>, rowIndex: number, columnIndex: number) {
    let nextRow = rowIndex
    let nextColumn = columnIndex
    if (event.key === 'ArrowUp') nextRow = Math.max(0, rowIndex - 1)
    else if (event.key === 'ArrowDown') nextRow = Math.min(rows.length - 1, rowIndex + 1)
    else if (event.key === 'ArrowLeft') nextColumn = Math.max(0, columnIndex - 1)
    else if (event.key === 'ArrowRight') nextColumn = Math.min(data.categoryColumns.length - 1, columnIndex + 1)
    else if (event.key === 'Home') nextColumn = 0
    else if (event.key === 'End') nextColumn = data.categoryColumns.length - 1
    else return
    event.preventDefault()
    const nextKey = `${rows[nextRow]}:${data.categoryColumns[nextColumn]}`
    setActiveKey(nextKey)
    cellRefs.current.get(nextKey)?.focus()
  }

  return <section className="telemetry-clue-section">
    <h3>Deck × Category Change Map</h3>
    <p id="telemetry-map-instructions" className="quiet-copy">One cell is in the normal Tab order. Use arrow keys to inspect every scope and category. States distinguish clues, observed with no supported shift, limited observation, unavailable, unknown, and unsupported.</p>
    <div className="telemetry-map-scroll"><table className="telemetry-change-map" aria-describedby="telemetry-map-instructions"><thead><tr><th>Scope</th>{data.categoryColumns.map((category) => <th key={category} scope="col">{CATEGORY_LABELS[category]}</th>)}</tr></thead><tbody>{rows.map((scopeKey, rowIndex) => {
      const values = data.categoryCells.filter((cell) => cell.scopeKey === scopeKey)
      return <tr key={scopeKey}><th scope="row">{values[0]?.scopeLabel}</th>{data.categoryColumns.map((category, columnIndex) => {
        const cell = values.find((candidate) => candidate.category === category)
        const key = `${scopeKey}:${category}`
        const detail = cell ? `${cell.supportedSignals} supported; ${cell.observedSignals} observed; ${cell.clueSignals} clues. ${cell.details.join('. ')}` : 'Not applicable'
        return <td key={category}><button ref={(node) => { if (node) cellRefs.current.set(key, node); else cellRefs.current.delete(key) }} type="button" className={`telemetry-map-cell telemetry-map-cell--${cell?.status ?? 'unsupported'}`} tabIndex={key === activeKey ? 0 : -1} aria-label={`${values[0]?.scopeLabel ?? scopeKey}, ${CATEGORY_LABELS[category]}: ${detail}`} title={detail} onFocus={() => setActiveKey(key)} onKeyDown={(event) => move(event, rowIndex, columnIndex)}>{mapCellText(cell?.status, cell?.clueSignals)}</button></td>
      })}</tr>
    })}</tbody></table></div>
  </section>
}

function TraceViewer({ clue, occurrence, window, onClose }: { clue: EngineeringSignalClue; occurrence: ActivityOccurrence; window: EngineeringClueResponse['evidenceWindow']; onClose(): void }) {
  const [history, setHistory] = useState<PressSemanticHistoryEvidence>()
  const [motion, setMotion] = useState<PressMotionEvidence>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError(false); setHistory(undefined); setMotion(undefined)
    const representation = clue.signalType === 'continuous' ? 'samples' : 'changes'
    const request = clue.canonicalId === 'physical.motion_state'
      ? getPressMotion(occurrence.pressKey, window.fromUtc, window.toUtc, controller.signal).then((value) => { if (!controller.signal.aborted) setMotion(value) })
      : getPressSemanticHistory(occurrence.pressKey, { fromUtc: window.fromUtc, toUtc: window.toUtc, includeSeed: true, signals: [{ canonicalId: clue.canonicalId, ...(clue.deckNumber === null ? {} : { deckNumber: clue.deckNumber }), representation }] }, controller.signal).then((value) => { if (!controller.signal.aborted) setHistory(value) })
    void request.catch(() => { if (!controller.signal.aborted) setError(true) }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [clue.canonicalId, clue.deckNumber, clue.signalType, occurrence.pressKey, window.fromUtc, window.toUtc])
  const signal = history?.signals[0]
  const numericSamples = (signal?.samples ?? []).filter((sample): sample is TimedNumericSample => typeof sample.value === 'number' && Number.isFinite(sample.value))
  const numericTracks: TimelineNumericTrack[] = clue.signalType === 'continuous' ? [{ id: `trace:${clue.canonicalId}:${clue.deckNumber ?? ''}`, label: `${clue.deckNumber === null ? 'Machine' : `Deck ${clue.deckNumber}`} · ${clue.friendlyName}`, samples: numericSamples, unit: clue.sourceUnit, unavailableLabel: 'Supported, but no numeric observations were returned in this window' }] : []
  const stepPoints = clue.signalType === 'step_reference' && signal ? [
    ...(signal.seed ? [{ atUtc: window.fromUtc, value: signal.seed.value }] : signal.changes[0] ? [{ atUtc: window.fromUtc, value: signal.changes[0].previousValue }] : []),
    ...signal.changes.map((change) => ({ atUtc: change.observedAtUtc, value: change.value })),
  ] : []
  const stepTrack: TimelineIntervalTrack | undefined = clue.signalType === 'step_reference' ? { id: 'selected-step-signal', label: clue.friendlyName, unavailableLabel: 'No raw reference value was observed in this window', intervals: stepPoints.map((point, index) => ({ id: `step:${point.atUtc}:${index}`, startUtc: point.atUtc, endUtc: stepPoints[index + 1]?.atUtc ?? window.toUtc, label: String(point.value), details: `${clue.canonicalId}; raw observed value ${String(point.value)}` })).filter(({ startUtc, endUtc }) => Date.parse(endUtc) > Date.parse(startUtc)) } : undefined
  const intervalTracks: TimelineIntervalTrack[] = motion ? [{ id: 'selected-motion', label: 'Physical Motion', intervals: motion.segments.map((segment, index) => ({ id: `motion:${segment.fromUtc}:${index}`, startUtc: segment.fromUtc, endUtc: segment.toUtc, label: segment.state, details: `Raw derived motion state · ${segment.state}` })) }] : stepTrack ? [stepTrack] : []
  const referenceEvents: TimelineEventTrack = { id: 'occurrence-reference', label: 'Occurrence reference', events: [
    { id: 'evidence-window-start', atUtc: window.fromUtc, label: 'Evidence window starts', category: 'window-boundary', detail: 'Start of the bounded telemetry evidence window' },
    { id: 'occurrence-start', atUtc: occurrence.startUtc, label: 'Radius entry', category: 'occurrence-start', detail: 'Focused occurrence start' },
    { id: 'occurrence-end', atUtc: occurrence.endUtc, label: 'Occurrence end', category: 'occurrence-end', detail: 'Focused occurrence end' },
    { id: 'evidence-window-end', atUtc: window.toUtc, label: 'Evidence window ends', category: 'window-boundary', detail: 'End of the bounded telemetry evidence window' },
  ] }
  const signalEvents: TimelineEventTrack | undefined = clue.signalType !== 'continuous' && clue.canonicalId !== 'physical.motion_state' ? { id: 'selected-signal-events', label: `${clue.friendlyName} raw transitions`, unavailableLabel: 'No raw transitions observed in this window', events: (signal?.changes ?? []).map((change, index) => ({ id: `signal:${change.observedAtUtc}:${index}`, atUtc: change.observedAtUtc, label: `${String(change.previousValue)} → ${String(change.value)}`, category: 'engineering-signal', detail: `${clue.canonicalId}; raw transition at ${formatPlantDateTime(change.observedAtUtc)} CT` })) } : undefined
  return <section className="telemetry-trace-viewer" aria-labelledby="telemetry-trace-title"><div className="section-heading"><div><p className="eyebrow">Selected clue evidence</p><h3 id="telemetry-trace-title">View Trace · {clue.friendlyName}</h3><p>{clue.canonicalId}{clue.deckNumber === null ? ' · Machine' : ` · Deck ${clue.deckNumber}`} · {clue.unitLabel}</p></div><button type="button" className="secondary-action" onClick={onClose}>Close trace</button></div>{loading && <div className="scope-progress" role="status"><i />Loading selected signal trace…</div>}{error && <p className="message message--warning">The selected trace is temporarily unavailable. Telemetry clues and operational evidence remain usable.</p>}{!loading && !error && <SynchronizedTimeline fromUtc={window.fromUtc} toUtc={window.toUtc} ariaLabel={`${clue.friendlyName} synchronized with focused occurrence`} intervalTracks={intervalTracks} numericTracks={numericTracks} eventTracks={[referenceEvents, ...(signalEvents ? [signalEvents] : [])]} />}</section>
}

export function TelemetryCluesPanel({ occurrence, previous, next, onFocus }: { occurrence?: ActivityOccurrence; previous?: ActivityOccurrence; next?: ActivityOccurrence; onFocus(occurrence: ActivityOccurrence): void }) {
  const [data, setData] = useState<EngineeringClueResponse>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const [trace, setTrace] = useState<EngineeringSignalClue>()
  useEffect(() => {
    if (!occurrence) { setData(undefined); setLoading(false); setError(false); return }
    const controller = new AbortController()
    const identity = occurrence.occurrenceId
    setData(undefined); setLoading(true); setError(false); setTrace(undefined)
    void getEngineeringClues(occurrence.pressKey, occurrenceInput(occurrence), controller.signal).then((value) => { if (!controller.signal.aborted && value.occurrence.occurrenceId === identity) setData(value) }).catch(() => { if (!controller.signal.aborted) setError(true) }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [occurrence?.occurrenceId, occurrence?.pressKey, occurrence?.startUtc, occurrence?.endUtc])
  const firstGroups = useMemo(() => data ? (['Before Radius entry', 'At / near Radius entry', 'After Radius entry'] as const).map((label) => ({ label, values: data.firstChanges.filter(({ firstRelevantOffsetMs }) => phase(firstRelevantOffsetMs) === label) })).filter(({ values }) => values.length) : [], [data])
  if (!occurrence) return <section className="panel telemetry-clues"><p className="empty-state">Select an exact occurrence to calculate bounded telemetry clues.</p></section>
  return <section className="panel telemetry-clues" aria-labelledby="telemetry-clues-title" data-focused-occurrence-id={occurrence.occurrenceId} data-clue-occurrence-id={data?.occurrence.occurrenceId}>
    <div className="section-heading telemetry-clues__heading"><div><p className="eyebrow">Focused occurrence</p><h2 id="telemetry-clues-title">Telemetry Clues · Where to Look</h2><p>Timing-aligned, capability-filtered observations around Radius entry. Use these clues to choose signals for closer inspection.</p></div><div className="occurrence-navigation"><button type="button" disabled={!previous} onClick={() => previous && onFocus(previous)}>Previous occurrence</button><button type="button" disabled={!next} onClick={() => next && onFocus(next)}>Next occurrence</button></div></div>
    <dl className="focused-occurrence-facts"><div><dt>Press</dt><dd>{occurrence.displayName}</dd></div><div><dt>Radius recorded</dt><dd>{occurrence.exactIdentities.map(({ eventType, statusCode, statusDescription }) => `${eventType} / ${statusCode ?? '—'} / ${statusDescription}`).join(' · ')}</dd></div><div><dt>Start</dt><dd>{formatPlantDateTime(occurrence.startUtc)} CT</dd></div><div><dt>End</dt><dd>{formatPlantDateTime(occurrence.endUtc)} CT</dd></div><div><dt>Duration</dt><dd>{formatDuration(Math.round(occurrence.durationSeconds))}</dd></div></dl>
    {loading && <div className="scope-progress" role="status"><i />Calculating bounded telemetry clues…</div>}
    {error && <p className="message message--warning">Telemetry clues are temporarily unavailable. Existing activity summaries, full-range signature, and exact evidence remain usable.</p>}
    {data && <>
      <p className="telemetry-clue-window"><strong>Evidence window:</strong> {formatPlantDateTime(data.evidenceWindow.fromUtc)} – {formatPlantDateTime(data.evidenceWindow.toUtc)} CT. {data.evidenceWindow.message}</p>
      <div className="telemetry-clue-coverage"><span>Supported selectors <b>{data.coverage.supportedSelectors}</b></span><span>Observed comparisons <b>{data.coverage.observedSelectors}</b></span><span>Limited observation <b>{data.coverage.limitedObservationSelectors}</b></span><span>No usable observations <b>{data.coverage.noObservationSelectors}</b></span><span>Unavailable/unknown <b>{data.coverage.unavailableSelectors}</b></span></div>
      <section className="telemetry-clue-section"><h3>Where to Look First</h3>{data.whereToLook.length ? <div className="where-to-look-grid">{data.whereToLook.map((item) => <article key={`${item.scopeKey}:${item.category}`}><span>{item.scopeLabel}</span><strong>{CATEGORY_LABELS[item.category]}</strong><p>{item.summary}</p></article>)}</div> : <p className="empty-state">No notable distribution shift or raw transition was observed with sufficient support in this bounded window.</p>}</section>
      <TelemetryChangeMap data={data} />
      <section className="telemetry-clue-section"><h3>First Observed Evidence Around Radius Entry</h3><p className="quiet-copy">Continuous signals show the first observation contributing to a distribution shift. State and step signals show exact raw transitions.</p>{firstGroups.length ? <div className="first-change-groups">{firstGroups.map((group) => <article key={group.label}><h4>{group.label}</h4><ol>{group.values.slice(0, 10).map((item) => <li key={`${item.canonicalId}:${item.deckNumber ?? ''}`}><time>{offsetLabel(item.firstRelevantOffsetMs)}</time><span><strong>{item.deckNumber === null ? 'Machine' : `Deck ${item.deckNumber}`} · {item.friendlyName}</strong><small>{firstEvidenceLabel(item)}</small></span></li>)}</ol></article>)}</div> : <p className="empty-state">No qualifying distribution-shift evidence or raw transition was observed with sufficient support.</p>}</section>
      <section className="telemetry-clue-section"><h3>Top Signal Clues</h3><div className="signal-clue-grid">{data.signalClues.filter(({ isClue }) => isClue).slice(0, 12).map((clue) => <article key={`${clue.canonicalId}:${clue.deckNumber ?? ''}`}><header><span>{clue.deckNumber === null ? 'Machine' : `Deck ${clue.deckNumber}`} · {CATEGORY_LABELS[clue.category]}</span><h4>{clue.friendlyName}</h4><code>{clue.canonicalId}</code></header><p>{clue.description}</p>{clue.before && <dl className="clue-window-summaries">{summary('Before', clue.before)}{summary('During', clue.during)}{summary('After', clue.after)}</dl>} {!clue.before && <dl className="clue-window-summaries"><div><dt>Entering value</dt><dd>{String(clue.enteringValue ?? 'Not observed')}</dd></div><div><dt>Transitions</dt><dd>{clue.transitionCount}</dd></div>{clue.largestRawStep !== null && <div><dt>Largest raw step</dt><dd>{number(clue.largestRawStep)}</dd></div>}</dl>}<footer><span>{confidenceLabel(clue)} · {clue.unitLabel}</span><span>{clue.signalType === 'continuous' ? `Evidence timing ${offsetLabel(clue.firstRelevantOffsetMs)}` : `Raw transition ${offsetLabel(clue.firstRelevantOffsetMs)}`}</span><button type="button" className="secondary-action" onClick={() => setTrace(clue)}>View Trace</button></footer></article>)}</div>{!data.signalClues.some(({ isClue }) => isClue) && <p className="empty-state">No notable signal clue was observed in this bounded window.</p>}</section>
      {trace && <TraceViewer clue={trace} occurrence={occurrence} window={data.evidenceWindow} onClose={() => setTrace(undefined)} />}
    </>}
  </section>
}
