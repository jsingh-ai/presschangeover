import React from 'react'
import type { EventLearningReport as EventLearningReportContract, EventSignalPattern } from '../types/api'

function localTime(value: string | null | undefined) { return value ? new Date(value).toLocaleString() : 'Unavailable' }
function relativeTime(value: number) { return value === 0 ? 'at T0' : `${Math.abs(value).toFixed(1)} min ${value < 0 ? 'before' : 'after'} T0` }
function displayValue(value: string | number | boolean | null) { return value === null ? 'Unavailable' : typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value) }
function signalKey(value: Pick<EventSignalPattern, 'canonicalId' | 'deckNumber'>) { return `${value.canonicalId}:${value.deckNumber ?? ''}` }

export function EventLearningReport({ report, onPreview, onPin, isPinned, canInspect, onOpenOccurrence }: {
  report: EventLearningReportContract
  onPreview?: (finding: EventSignalPattern) => void
  onPin?: (finding: EventSignalPattern) => void
  isPinned?: (finding: EventSignalPattern) => boolean
  canInspect?: (finding: EventSignalPattern) => boolean
  onOpenOccurrence?: (occurrenceId: string) => void
}) {
  const timing = report.physicalTiming as { agreementClass?: string; inferredPhysicalOnsetRange?: { startUtc: string; endUtc: string } | null; entryLagRange?: { minimumSeconds: number; maximumSeconds: number } | null }
  const matrixFindings = report.historicalFingerprint.findings.slice(0, 8)
  const matrixOccurrences = report.occurrenceMatrix.slice(-12)
  return <section className="event-learning-report" aria-label="Event report">
    <header className="event-report-header">
      <div><span className="eyebrow">Deterministic analytics</span><h2>Event report</h2><p>{report.title}. Use the findings to choose evidence, then verify it in the chart above.</p></div>
      <div className="event-report-performance"><strong>{report.performance.cohortOccurrences}</strong><span>bounded occurrences</span><strong>{report.performance.totalMs.toLocaleString()} ms</strong><span>report runtime</span></div>
    </header>

    <div className="event-report-grid">
      <article className="event-report-card event-report-card-wide"><h3>1. What happened</h3><div className="event-report-facts">
        {Object.entries(report.target).map(([label, value]) => <div key={label}><span>{label.replace(/([A-Z])/g, ' $1')}</span><strong>{displayValue(value)}</strong></div>)}
        <div><span>Recorded start</span><strong>{localTime(report.recordedTime.startUtc)}</strong></div><div><span>Recorded end</span><strong>{localTime(report.recordedTime.endUtc)}</strong></div>
      </div></article>

      <article className="event-report-card"><h3>2. Physical / event timeline</h3>
        <p><strong>Recorded event time:</strong> {localTime(report.recordedTime.startUtc)}</p>
        <p><strong>Telemetry-inferred physical time:</strong> {timing.inferredPhysicalOnsetRange ? `${localTime(timing.inferredPhysicalOnsetRange.startUtc)} – ${localTime(timing.inferredPhysicalOnsetRange.endUtc)}` : 'Not resolved from supported telemetry'}</p>
        <p><strong>Alignment:</strong> {timing.agreementClass?.replaceAll('_', ' ') ?? 'Unavailable'}</p>
        {timing.entryLagRange && <p><strong>Observed timing range:</strong> {Math.round(timing.entryLagRange.minimumSeconds / 60)}–{Math.round(timing.entryLagRange.maximumSeconds / 60)} min</p>}
        <p className="report-caveat">Timing order is association evidence; speed alone does not classify a Radius state.</p>
      </article>

      <article className="event-report-card"><h3>9. Radius / production context</h3>
        {report.radiusContext.length ? <ul>{report.radiusContext.map((item, index) => <li key={`${item.relationship}:${index}`}><strong>{item.relationship.replaceAll('_', ' ')}:</strong> {item.eventType} / {item.statusCode ?? '—'} / {item.statusDescription}</li>)}</ul> : <p>Radius context unavailable for this event.</p>}
        {report.productionContext.length ? <dl>{report.productionContext.map((item) => <div key={item.field}><dt>{item.field}</dt><dd>{displayValue(item.value)}</dd></div>)}</dl> : <p>Production context unavailable for this bounded window.</p>}
      </article>
    </div>

    <article className="event-report-card event-report-card-wide"><h3>3. Most relevant changes</h3>
      {report.selectedFindings.length ? <div className="event-finding-list">{report.selectedFindings.map((finding) => { const inspectable = canInspect?.(finding) ?? true; return <div className="event-finding" key={`${signalKey(finding)}:${finding.atUtc}:${finding.description}`}>
        <div><strong>{finding.friendlyName}{finding.deckNumber ? ` · Deck ${finding.deckNumber}` : ''}</strong><span>{finding.category} · {relativeTime(finding.relativeMinutes)}</span></div>
        <p>{finding.description}{finding.persistenceMinutes !== null ? `; persisted ${finding.persistenceMinutes} min in the observed window` : ''}.</p>
        <small>{finding.reason}. {finding.coverageObservations} usable observation{finding.coverageObservations === 1 ? '' : 's'}.{finding.provenance === 'INFERRED_LOW_CARDINALITY' ? ' Discrete interpretation inferred from low-cardinality integer behavior.' : ''}</small>
        <div className="event-report-actions">{inspectable && onPreview && <button type="button" className="button secondary" onClick={() => onPreview(finding)}>Preview</button>}{inspectable && onPin && <button type="button" className="button secondary" onClick={() => onPin(finding)}>{isPinned?.(finding) ? 'Unpin' : 'Pin'}</button>}{!inspectable && <span>Already shown in the primary chart</span>}</div>
      </div> })}</div> : <p>No material canonical change met the bounded evidence rules. The manual signal browser remains available above.</p>}
    </article>

    <article className="event-report-card event-report-card-wide"><h3>4. Before / event / recovery</h3>
      {report.phaseComparison.length ? <div className="table-scroll"><table><thead><tr><th>Signal</th><th>Before</th><th>Event</th><th>Recovery</th></tr></thead><tbody>{report.phaseComparison.map((item) => <tr key={`${item.canonicalId}:${item.deckNumber ?? ''}`}><th>{item.friendlyName}{item.deckNumber ? ` · D${item.deckNumber}` : ''}</th><td>{item.before}</td><td>{item.event}</td><td>{item.recovery}</td></tr>)}</tbody></table></div> : <p>Insufficient good-quality before/event/recovery coverage.</p>}
    </article>

    <article className="event-report-card event-report-card-wide"><h3>5. Historical fingerprint</h3>
      <div className="event-report-coverage"><span><strong>{report.historicalFingerprint.qualifiedOccurrences}</strong> telemetry-qualified</span><span><strong>{report.historicalFingerprint.excludedOccurrences}</strong> excluded/partial</span><span>Telemetry: {report.historicalFingerprint.telemetryCoverage ? `${localTime(report.historicalFingerprint.telemetryCoverage.startUtc)} – ${localTime(report.historicalFingerprint.telemetryCoverage.endUtc)}` : 'unavailable'}</span>{report.historicalFingerprint.radiusCoverage && <span>Radius: {localTime(report.historicalFingerprint.radiusCoverage.startUtc)} – {localTime(report.historicalFingerprint.radiusCoverage.endUtc)}</span>}</div>
      {report.historicalFingerprint.findings.length ? <div className="frequency-chart">{report.historicalFingerprint.findings.slice(0, 10).map((finding) => <div className="frequency-row" key={`${signalKey(finding)}:${finding.description}`}><span>{finding.friendlyName}{finding.deckNumber ? ` D${finding.deckNumber}` : ''}<small>{finding.description}</small></span><div><i style={{ width: `${Math.round(finding.occurrenceRate * 100)}%` }} /></div><strong>{finding.observedOccurrenceCount}/{finding.validOccurrenceCount} · {Math.round(finding.occurrenceRate * 100)}%</strong></div>)}</div> : <p>Insufficient repeated telemetry evidence for a historical fingerprint.</p>}
      {matrixFindings.length > 0 && matrixOccurrences.length > 0 && <div className="occurrence-matrix" aria-label="Occurrence matrix"><div className="matrix-row matrix-head"><span>Observed change</span>{matrixOccurrences.map((item) => <i key={item.occurrenceId} title={localTime(item.startUtc)} />)}</div>{matrixFindings.map((finding) => <div className="matrix-row" key={`matrix:${signalKey(finding)}:${finding.description}`}><span>{finding.friendlyName}</span>{matrixOccurrences.map((item) => <i key={item.occurrenceId} className={item.patterns.includes(signalKey(finding)) ? 'present' : ''} title={localTime(item.startUtc)} />)}</div>)}</div>}
    </article>

    <div className="event-report-grid">
      <article className="event-report-card"><h3>6. Typical sequence</h3>{report.typicalSequence.length ? <ol className="event-sequence">{report.typicalSequence.map((step) => <li key={`${step.canonicalId}:${step.deckNumber ?? ''}:${step.label}`}><strong>{step.label}</strong><span>{relativeTime(step.medianRelativeMinutes)} · {step.supportCount}/{step.validOccurrenceCount} valid</span></li>)}</ol> : <p>Insufficient recurring support to infer a common sequence.</p>}</article>
      <article className="event-report-card"><h3>7. Relationships</h3>{report.relationshipAnalysis?.status === 'UNAVAILABLE' ? <p>Relationship analysis unavailable ({report.relationshipAnalysis.reason}). The remaining report evidence is still valid.</p> : report.relationships.length ? <ul className="relationship-list">{report.relationships.map((item, index) => <li key={`${item.signal}:${item.mode}:${index}`}><strong>{item.signal} · {item.mode}</strong><span>{item.interpretation}</span></li>)}</ul> : <p>No relationship met bounded aligned-pair or transition support rules.</p>}</article>
    </div>

    <article className="event-report-card event-report-card-wide"><h3>8. This occurrence vs typical</h3><div className="event-report-grid compact"><div><h4>Common / typical</h4>{report.occurrenceComparison.common.length ? <ul>{report.occurrenceComparison.common.map((item) => <li key={item}>{item}</li>)}</ul> : <p>No supported recurring match yet.</p>}</div><div><h4>Observed exceptions</h4>{report.occurrenceComparison.exceptions.length ? <ul>{report.occurrenceComparison.exceptions.map((item) => <li key={item}>{item}</li>)}</ul> : <p>No valid-coverage exception was established.</p>}</div></div>
      {onOpenOccurrence && matrixOccurrences.length > 1 && <div className="historical-occurrences"><span>Open bounded historical occurrence:</span>{matrixOccurrences.filter((item) => item.occurrenceId !== report.selectedOccurrence.occurrenceId).slice(-5).map((item) => <button type="button" className="button secondary" key={item.occurrenceId} onClick={() => onOpenOccurrence(item.occurrenceId)}>{localTime(item.startUtc)}</button>)}</div>}
    </article>

    <article className="event-report-card event-report-card-wide"><h3>10. Evidence coverage / limitations</h3><p><strong>Automatic candidate signals:</strong> {report.coverage.candidateSignals}. <strong>Automatic raw/unmapped scans:</strong> {report.coverage.automaticRawSignalScans}.</p><p><strong>Event-vs-normal controls:</strong> {report.controls.status}. {report.controls.reason}</p><ul>{report.coverage.limitations.map((item) => <li key={item}>{item}</li>)}</ul></article>
  </section>
}
