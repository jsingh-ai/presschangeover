import React, { useEffect, useMemo, useRef, useState } from 'react'
import { analyzeWithAiInvestigator, getAiInvestigatorStatus } from '../api/process-intelligence-api'
import type { AiInvestigatorResult, AiInvestigatorServerStatus, AiTemporalEvidenceProgram, RadiusPressKey } from '../types/api'

type TimeChoice = 'last24' | 'last8' | 'custom'
const PROGRESS_MESSAGES = ['Preparing operational summary…', 'Comparing recent behavior…', 'Investigating candidate presses…', 'Building findings…']

function localInput(date: Date): string {
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 16)
}

function currentRange(choice: TimeChoice, customFrom: string, customTo: string) {
  if (choice === 'custom') return { startUtc: new Date(customFrom).toISOString(), endUtc: new Date(customTo).toISOString() }
  const end = new Date(); const hours = choice === 'last8' ? 8 : 24
  return { startUtc: new Date(end.getTime() - hours * 60 * 60_000).toISOString(), endUtc: end.toISOString() }
}

function formatElapsed(milliseconds: number) { return milliseconds < 1_000 ? `${milliseconds} ms` : `${(milliseconds / 1_000).toFixed(1)} sec` }
function formatEvidenceTime(value: string) { return new Date(value).toLocaleString() }
function relativeTime(value: number) { return `${value > 0 ? '+' : ''}${value.toFixed(Math.abs(value) < 10 ? 1 : 0)}m` }

function InvestigatorEvidenceTrace({ traces }: { traces: AiTemporalEvidenceProgram[] }) {
  if (!traces.length) return null
  return <section className="ai-temporal-trace" aria-label="Synchronized deterministic evidence trace"><div className="ai-temporal-trace__heading"><div><h4>Grounded temporal trace</h4><p>Qualitative interpretation is grounded to these deterministic programs; it is not a root-cause conclusion.</p></div><span>{traces.length} trace{traces.length === 1 ? '' : 's'}</span></div><div className="ai-temporal-trace__rows">{traces.map((trace) => <div className="ai-temporal-trace__row" key={trace.traceId}><div><strong>{trace.canonicalId}</strong><small>{trace.coveragePercent}% coverage · {trace.gapState.toLowerCase().replaceAll('_', ' ')}</small></div><div className="ai-temporal-trace__program">{trace.segments?.map((segment, index) => <span key={`${trace.traceId}-segment-${index}`} title={`${relativeTime(segment.startRelativeMinutes)} to ${relativeTime(segment.endRelativeMinutes)}: ${segment.startValue} to ${segment.endValue}`}><b>{segment.trend.toLowerCase()}</b> {relativeTime(segment.startRelativeMinutes)}…{relativeTime(segment.endRelativeMinutes)}</span>)}{trace.intervals?.map((interval, index) => <span key={`${trace.traceId}-interval-${index}`} title={`${relativeTime(interval.startRelativeMinutes)} to ${relativeTime(interval.endRelativeMinutes)}`}><b>{String(interval.value)}</b> {relativeTime(interval.startRelativeMinutes)}…{relativeTime(interval.endRelativeMinutes)}</span>)}</div><a href={trace.explorer.href}>{trace.explorer.label}</a></div>)}</div></section>
}

export function LegacyAiInvestigatorPage() {
  const [status, setStatus] = useState<AiInvestigatorServerStatus>()
  const [statusError, setStatusError] = useState(false)
  const [pressKey, setPressKey] = useState<RadiusPressKey | 'all'>('all')
  const [timeChoice, setTimeChoice] = useState<TimeChoice>('last24')
  const [customFrom, setCustomFrom] = useState(() => localInput(new Date(Date.now() - 24 * 60 * 60_000)))
  const [customTo, setCustomTo] = useState(() => localInput(new Date()))
  const [result, setResult] = useState<AiInvestigatorResult>()
  const [running, setRunning] = useState(false)
  const [progressIndex, setProgressIndex] = useState(0)
  const [error, setError] = useState<string>()
  const activeRequest = useRef<AbortController | undefined>(undefined)

  useEffect(() => {
    const controller = new AbortController()
    void getAiInvestigatorStatus(controller.signal).then(setStatus).catch(() => setStatusError(true))
    return () => controller.abort()
  }, [])

  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(() => setProgressIndex((current) => Math.min(PROGRESS_MESSAGES.length - 1, current + 1)), 7_000)
    return () => window.clearInterval(timer)
  }, [running])

  const customRangeValid = useMemo(() => {
    if (!customFrom || !customTo) return false
    const duration = Date.parse(customTo) - Date.parse(customFrom)
    return duration > 0 && duration <= 7 * 24 * 60 * 60_000
  }, [customFrom, customTo])

  async function analyze() {
    if (!status?.configured || running || timeChoice === 'custom' && !customRangeValid) return
    const controller = new AbortController(); activeRequest.current = controller
    const timeout = window.setTimeout(() => controller.abort(), status.maximumAnalysisMs + 5_000)
    setRunning(true); setProgressIndex(0); setError(undefined); setResult(undefined)
    try {
      const range = currentRange(timeChoice, customFrom, customTo)
      setResult(await analyzeWithAiInvestigator({ scope: { pressKey: pressKey === 'all' ? null : pressKey }, range, analysis: 'discover_unusual_behavior' }, controller.signal))
    } catch (requestError) {
      if (controller.signal.aborted) setError('The investigation was cancelled or reached the browser time limit. No background analysis is continuing.')
      else setError('The AI service could not complete this investigation. Radius and telemetry pages remain available; retry when ready.')
    } finally {
      window.clearTimeout(timeout); if (activeRequest.current === controller) activeRequest.current = undefined; setRunning(false)
    }
  }

  function cancel() { activeRequest.current?.abort() }

  const maxSeconds = Math.round((status?.maximumAnalysisMs ?? 45_000) / 1_000)
  return <div className="ai-investigator-page">
    <section className="ai-investigator-hero">
      <div><span className="eyebrow">AI INVESTIGATOR</span><h1>AI Investigator</h1><p>Use Radius, telemetry, jobs, recipes, and historical behavior to surface unusual press activity and evidence worth investigating.</p></div>
      <div className="ai-readonly-badge"><strong>Advisory and read-only</strong><span>Evidence comes from approved ProcessIntelligence analysis services.</span></div>
    </section>

    <section className="panel ai-investigator-controls" aria-labelledby="ai-investigator-setup-title">
      <div className="panel-heading"><div><span className="eyebrow">Investigation setup</span><h2 id="ai-investigator-setup-title">Choose a bounded question</h2></div><span className="ai-time-budget">Maximum analysis time: {maxSeconds} seconds</span></div>
      <div className="ai-control-grid">
        <label>Scope<select value={pressKey} onChange={(event) => setPressKey(event.target.value as RadiusPressKey | 'all')} disabled={running}><option value="all">All Presses</option>{status?.presses.map((press) => <option key={press.pressKey} value={press.pressKey}>{press.displayName}</option>)}</select></label>
        <label>Time<select value={timeChoice} onChange={(event) => setTimeChoice(event.target.value as TimeChoice)} disabled={running}><option value="last24">Last 24 Hours</option><option value="last8">Last 8 Hours</option><option value="custom">Custom</option></select></label>
        <label>Analysis<select value="discover_unusual_behavior" disabled><option value="discover_unusual_behavior">Discover unusual behavior</option></select></label>
        <div className="ai-action-group"><button type="button" className="primary-action" onClick={analyze} disabled={!status?.configured || running || timeChoice === 'custom' && !customRangeValid}>Analyze</button>{running && <button type="button" className="secondary-action" onClick={cancel}>Cancel</button>}</div>
      </div>
      {timeChoice === 'custom' && <div className="ai-custom-range"><label>Start<input type="datetime-local" value={customFrom} onChange={(event) => setCustomFrom(event.target.value)} disabled={running} /></label><label>End<input type="datetime-local" value={customTo} onChange={(event) => setCustomTo(event.target.value)} disabled={running} /></label>{!customRangeValid && <span role="alert">Choose a positive range no longer than 7 days.</span>}</div>}
      {!status && !statusError && <p className="ai-configuration-state" role="status">Checking AI Investigator configuration…</p>}
      {statusError && <p className="ai-configuration-state ai-configuration-state--error" role="alert">AI Investigator status could not be loaded.</p>}
      {status && !status.configured && <p className="ai-configuration-state ai-configuration-state--notice" role="status">AI Investigator is not configured on this server.</p>}
    </section>

    <section className={`panel ai-analysis-status${running ? ' is-running' : ''}`} aria-live="polite" aria-busy={running}>
      <div><span className="eyebrow">Analysis status</span><h2>{running ? PROGRESS_MESSAGES[progressIndex] : result ? result.status === 'complete' ? 'Analysis complete' : result.status === 'timeout' ? 'Time budget reached' : result.status === 'partial' ? 'Partial analysis available' : 'Analysis could not complete' : 'Ready to investigate'}</h2></div>
      {running && <div className="ai-status-pulse" aria-hidden="true"><i /><i /><i /></div>}
      {!running && !result && <p>Run one focused investigation. The server stops automatically at its configured deadline.</p>}
      {error && <div className="ai-inline-error" role="alert"><p>{error}</p><button type="button" onClick={analyze} disabled={!status?.configured}>Retry</button></div>}
      {result?.status === 'timeout' && <p>Analysis reached its {maxSeconds}-second time budget. Partial evidence is shown below.</p>}
    </section>

    {result && <>
      <section className="ai-findings-section" aria-labelledby="ai-findings-title"><div className="section-heading"><div><span className="eyebrow">Ranked findings</span><h2 id="ai-findings-title">Evidence worth investigating</h2></div><p>{result.summary}</p></div>
        {!result.findings.length && <div className="panel ai-empty-findings">No model-ranked finding was completed. Review the deterministic evidence and limitations below.</div>}
        <div className="ai-findings-list">{result.findings.map((finding) => <article className="panel ai-finding-card" key={`${finding.rank}-${finding.press}-${finding.title}`}>
          <div className="ai-finding-heading"><span className="ai-finding-rank">#{finding.rank}</span><div><span>{finding.press}</span><h3>{finding.title}</h3></div><div className="ai-finding-badges"><span className={`importance-${finding.importance}`}>{finding.importance} interest</span><span>{finding.confidence} confidence</span></div></div>
          <div className="ai-finding-grid"><section><h4>What changed</h4><div className="ai-fact-table">{finding.facts.map((fact) => <div key={`${fact.label}-${fact.value}`}><strong>{fact.label}</strong><span>{fact.value}</span><small>{fact.comparison}</small></div>)}</div>{finding.baselines.length > 0 && <div className="ai-grounded-times"><h4>Baseline</h4><ul>{finding.baselines.map((item) => <li key={item}>{item}</li>)}</ul></div>}{finding.timestamps.length > 0 && <div className="ai-grounded-times"><h4>Evidence time</h4><ul>{finding.timestamps.map((item) => <li key={`${item.label}-${item.start}`}><strong>{item.label}</strong>: {formatEvidenceTime(item.start)}{item.end ? ` – ${formatEvidenceTime(item.end)}` : ''}</li>)}</ul></div>}</section><section><h4>Interpretation</h4><p>{finding.whyItMatters}</p>{Object.entries(finding.productionContext).some(([, value]) => Boolean(value)) && <><h4>Production context</h4><dl>{Object.entries(finding.productionContext).filter(([, value]) => Boolean(value)).map(([field, value]) => <div key={field}><dt>{field[0]!.toUpperCase() + field.slice(1)}</dt><dd>{value}</dd></div>)}</dl></>}</section></div>
          {(finding.radiusEvidence.length > 0 || finding.telemetryEvidence.length > 0) && <div className="ai-evidence-lists"><section><h4>Radius evidence</h4><ul>{finding.radiusEvidence.map((item) => <li key={item}>{item}</li>)}</ul></section><section><h4>Telemetry evidence</h4><ul>{finding.telemetryEvidence.map((item) => <li key={item}>{item}</li>)}</ul></section></div>}
          <InvestigatorEvidenceTrace traces={finding.traceEvidence ?? []} />
          <div className="ai-next-check"><div><strong>Suggested next check</strong><p>{finding.recommendedInvestigation}</p></div><div>{finding.links.map((link) => <a key={link.href} href={link.href}>{link.label}</a>)}</div></div>
        </article>)}</div>
      </section>

      {result.tables.length > 0 && <section className="ai-evidence-tables"><div className="section-heading"><div><span className="eyebrow">Deterministic evidence</span><h2>Summary tables</h2></div></div>{result.tables.map((table) => <div className="panel ai-table-card" key={table.title}><h3>{table.title}</h3><div className="ai-table-scroll"><table><thead><tr>{table.columns.map((column) => <th key={column}>{column}</th>)}</tr></thead><tbody>{table.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((value, cellIndex) => <td key={`${rowIndex}-${cellIndex}`}>{value}</td>)}</tr>)}</tbody></table></div></div>)}</section>}

      <section className="panel ai-analysis-metadata"><div><span className="eyebrow">Analysis metadata</span><h2>Bounded execution record</h2></div><dl><div><dt>Status</dt><dd>{result.status}</dd></div><div><dt>Elapsed</dt><dd>{formatElapsed(result.elapsedMs)}</dd></div><div><dt>Read-only data calls</dt><dd>{result.toolCallsUsed}</dd></div><div><dt>Grounded findings</dt><dd>{result.grounding.acceptedUnchanged + result.grounding.corrected}</dd></div><div><dt>Grounding corrections</dt><dd>{result.grounding.corrected}</dd></div><div><dt>Omitted findings</dt><dd>{result.grounding.omitted}</dd></div><div><dt>Analysis ID</dt><dd>{result.analysisId}</dd></div><div><dt>Started</dt><dd>{new Date(result.startedAt).toLocaleString()}</dd></div><div><dt>Completed</dt><dd>{new Date(result.completedAt).toLocaleString()}</dd></div></dl>{result.limitations.length > 0 && <div className="ai-limitations"><h3>Limitations</h3><ul>{result.limitations.map((item) => <li key={item}>{item}</li>)}</ul></div>}</section>
    </>}
  </div>
}

export { AiInvestigatorVisualPage as AiInvestigatorPage } from './AiInvestigatorVisualPage'
