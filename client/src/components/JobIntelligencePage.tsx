import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { getJobIntelligenceReport } from '../api/process-intelligence-api'
import { RangeControls } from './RangeControls'
import type { SelectedRange } from '../time-ranges'
import type { JobAnalysisDimension, JobEvidenceLevel, JobGroupDefinition, JobGroupOperator, JobIntelligenceReport, RadiusPressKey } from '../types/api'

const presses: RadiusPressKey[] = ['press3', 'press5', 'press6', 'press7', 'press8', 'press9', 'press10', 'press11', 'press12', 'press13', 'press14', 'press15']
const dimensions: Array<{ value: JobAnalysisDimension; label: string }> = [{ value: 'order', label: 'Order' }, { value: 'recipe', label: 'Recipe' }, { value: 'customer', label: 'Customer' }, { value: 'material', label: 'Material' }]
const operatorLabels: Record<JobGroupOperator, string> = { exact: 'Exact match', contains: 'Contains', starts_with: 'Starts with', ends_with: 'Ends with', position_range: 'Position / range', segment_equals: 'Segment equals' }

interface Props { range: SelectedRange; selectedPress?: RadiusPressKey; onRangeChange(range: SelectedRange): void; onPressChange(pressKey: RadiusPressKey): void }

const formatDuration = (seconds: number | null) => seconds === null ? '—' : seconds >= 3600 ? `${Math.round(seconds / 360) / 10} h` : `${Math.round(seconds / 60)} min`
const formatHours = (seconds: number) => `${Math.round(seconds / 360) / 10} h`
const supportLabel = (level: JobEvidenceLevel) => level[0]!.toUpperCase() + level.slice(1)

function groupFromLocation(): JobGroupDefinition | undefined {
  const query = new URLSearchParams(window.location.search); const operator = query.get('operator') as JobGroupOperator | null; const value = query.get('query')
  if (!operator || !value || !(operator in operatorLabels)) return undefined
  const number = (name: string) => { const parsed = Number(query.get(name)); return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined }
  return { operator, query: value, positionStart: number('positionStart'), positionEnd: number('positionEnd'), segmentIndex: number('segmentIndex'), delimiter: query.get('delimiter') ?? undefined }
}

function StateBar({ good, makeReady, bad }: { good: number; makeReady: number; bad: number }) {
  return <div className="ji-state-bar" aria-label={`${good}% Good, ${makeReady}% Make Ready, ${bad}% Bad`}><span className="ji-state-good" style={{ width: `${good}%` }} /><span className="ji-state-make-ready" style={{ width: `${makeReady}%` }} /><span className="ji-state-bad" style={{ width: `${bad}%` }} /></div>
}

export function JobIntelligencePage({ range, selectedPress, onRangeChange, onPressChange }: Props) {
  const pressKey = selectedPress ?? 'press5'
  const [analyzeBy, setAnalyzeBy] = useState<JobAnalysisDimension>(() => { const value = new URLSearchParams(window.location.search).get('analyzeBy'); return dimensions.some((item) => item.value === value) ? value as JobAnalysisDimension : 'recipe' })
  const initialGroup = useMemo(groupFromLocation, [])
  const [operator, setOperator] = useState<JobGroupOperator>(initialGroup?.operator ?? 'exact')
  const [query, setQuery] = useState(initialGroup?.query ?? '')
  const [positionStart, setPositionStart] = useState(initialGroup?.positionStart ?? 1)
  const [positionEnd, setPositionEnd] = useState(initialGroup?.positionEnd ?? 1)
  const [segmentIndex, setSegmentIndex] = useState(initialGroup?.segmentIndex ?? 3)
  const [delimiter, setDelimiter] = useState(initialGroup?.delimiter ?? '-')
  const [appliedGroup, setAppliedGroup] = useState<JobGroupDefinition | undefined>(initialGroup)
  const [report, setReport] = useState<JobIntelligenceReport>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const rangeTooLarge = Date.parse(range.toUtc) - Date.parse(range.fromUtc) > 7 * 24 * 60 * 60_000

  useEffect(() => {
    if (rangeTooLarge) { setLoading(false); setError('Job Intelligence supports a maximum seven-day range to keep historian reads bounded.'); return }
    let active = true; const controller = new AbortController(); setLoading(true); setError(undefined)
    void getJobIntelligenceReport({ pressKey, fromUtc: range.fromUtc, toUtc: range.toUtc, analyzeBy, group: appliedGroup }, controller.signal).then((value) => { if (active) setReport(value) }).catch(() => { if (active) setError('Job Intelligence evidence could not be loaded for this selection.') }).finally(() => active && setLoading(false))
    return () => { active = false; controller.abort() }
  }, [pressKey, range.fromUtc, range.toUtc, analyzeBy, appliedGroup, rangeTooLarge])

  function persistSelection(group?: JobGroupDefinition, nextDimension = analyzeBy) {
    const url = new URL(window.location.href); url.searchParams.set('analyzeBy', nextDimension)
    for (const key of ['operator', 'query', 'positionStart', 'positionEnd', 'segmentIndex', 'delimiter']) url.searchParams.delete(key)
    if (group) { url.searchParams.set('operator', group.operator); url.searchParams.set('query', group.query); if (group.positionStart) url.searchParams.set('positionStart', String(group.positionStart)); if (group.positionEnd) url.searchParams.set('positionEnd', String(group.positionEnd)); if (group.segmentIndex) url.searchParams.set('segmentIndex', String(group.segmentIndex)); if (group.delimiter) url.searchParams.set('delimiter', group.delimiter) }
    window.history.replaceState({}, '', `${url.pathname}?${url.searchParams}`)
  }

  function applyGroup(group?: JobGroupDefinition) { setAppliedGroup(group); persistSelection(group) }
  function applyDraft() {
    const trimmed = query.trim(); if (!trimmed) return
    applyGroup({ operator, query: trimmed, ...(operator === 'position_range' ? { positionStart, positionEnd } : {}), ...(operator === 'segment_equals' ? { segmentIndex, delimiter } : {}) })
  }
  function selectExact(value: string) { setOperator('exact'); setQuery(value); applyGroup({ operator: 'exact', query: value }) }
  function changeDimension(value: JobAnalysisDimension) { setAnalyzeBy(value); setAppliedGroup(undefined); setQuery(''); persistSelection(undefined, value) }

  return <div className="ji-page">
    <section className="ji-controls" aria-label="Job Intelligence controls">
      <label><span>Press</span><select value={pressKey} onChange={(event) => onPressChange(event.target.value as RadiusPressKey)}>{presses.map((press) => <option key={press} value={press}>{press.replace('press', 'Press ')}</option>)}</select></label>
      <label><span>Analyze by</span><select value={analyzeBy} onChange={(event) => changeDimension(event.target.value as JobAnalysisDimension)}>{dimensions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
      <div className="ji-range"><span>Time range</span><RangeControls range={range} onChange={onRangeChange} /></div>
    </section>

    <section className="ji-group-builder panel" aria-labelledby="ji-group-title">
      <div><span className="eyebrow">Pattern builder</span><h1 id="ji-group-title">Job Intelligence</h1></div>
      <div className="ji-group-fields">
        <select aria-label="Group match method" value={operator} onChange={(event) => setOperator(event.target.value as JobGroupOperator)}>{Object.entries(operatorLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
        {operator === 'position_range' && <><input aria-label="Start position" type="number" min="1" max="240" value={positionStart} onChange={(event) => setPositionStart(Number(event.target.value))} /><input aria-label="End position" type="number" min="1" max="240" value={positionEnd} onChange={(event) => setPositionEnd(Number(event.target.value))} /></>}
        {operator === 'segment_equals' && <><input aria-label="Segment number" type="number" min="1" max="20" value={segmentIndex} onChange={(event) => setSegmentIndex(Number(event.target.value))} /><input aria-label="Delimiter" className="ji-delimiter" maxLength={3} value={delimiter} onChange={(event) => setDelimiter(event.target.value)} /></>}
        <input aria-label="Group value" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Find a ${analyzeBy} or family`} />
        <button type="button" onClick={applyDraft} disabled={!query.trim()}>Analyze group</button>
        {appliedGroup && <button type="button" className="ji-clear" onClick={() => applyGroup(undefined)}>Clear group</button>}
      </div>
    </section>

    {loading && <div className="scope-progress" role="status"><i aria-hidden="true" />{appliedGroup ? 'Building like-for-like fleet evidence…' : 'Deriving production runs…'}</div>}
    {error && <section className="panel unavailable-panel" role="alert"><h2>Evidence unavailable</h2><p>{error}</p></section>}
    {report && <>
      <div className="ji-coverage-strip" aria-label="Identity coverage">{report.coverage.map((item) => <span key={item.field} className={`ji-coverage ji-coverage--${item.confidence}`} title={item.limitation ?? undefined}><b>{item.field}</b>{item.capability === 'available' ? `${item.valueCoveragePercent}%` : 'Unavailable'}</span>)}</div>

      <section className="ji-decision-grid" aria-label="Decisions">{report.decisions.map((card) => <article key={`${card.kind}-${card.headline}`} className={`ji-decision ji-support--${card.evidenceLevel}`}><span>{card.label}</span><h2>{card.headline}</h2><strong>{card.value}</strong><small>{card.detail}</small><a href={card.inspectUrl}>Inspect evidence</a></article>)}</section>

      <section className="panel ji-performance" aria-labelledby="ji-performance-title">
        <div className="section-heading"><div><span className="eyebrow">Raw performance · {report.metricName} · {report.displayName}</span><h2 id="ji-performance-title">{dimensions.find((item) => item.value === analyzeBy)?.label} ranking</h2></div><div className="ji-state-key"><span className="good">Good</span><span className="make-ready">Make Ready</span><span className="bad">Bad</span></div></div>
        {!report.ranking.length && <div className="empty-state">No usable {analyzeBy} identities were observed.</div>}
        <div className="ji-ranking-list">{report.ranking.map((item, index) => <button type="button" key={item.value} className={report.selectedGroup?.includedValues.includes(item.value) ? 'ji-ranking-row selected' : 'ji-ranking-row'} onClick={() => selectExact(item.value)}>
          <span className="ji-rank">{index + 1}</span><span className="ji-identity"><strong>{item.value}</strong>{item.segments.length > 1 && <small>{item.segments.join(' · ')}</small>}</span><div><StateBar good={item.goodPercent} makeReady={item.makeReadyPercent} bad={item.badPercent} /><small>{item.goodPercent}% Good · {item.makeReadyPercent}% MR · {item.badPercent}% Bad</small></div><span className="ji-run-count"><strong>{item.runCount}</strong><small>runs</small></span><span className="ji-run-count"><strong>{formatDuration(item.medianTransitionSeconds)}</strong><small>stable proxy</small></span><span className={`ji-support-badge ji-support--${item.support.level}`}>{supportLabel(item.support.level)}</span>
        </button>)}</div>
      </section>

      {report.selectedGroup && <section className="panel ji-selected-group"><div className="section-heading"><div><span className="eyebrow">Included values</span><h2>{report.selectedGroup.definition.operator.replaceAll('_', ' ')} “{report.selectedGroup.definition.query}”</h2></div><strong>{report.selectedGroup.runCount} selected runs</strong></div><div className="ji-value-chips">{report.selectedGroup.includedValues.map((value) => <span key={value}>{value}</span>)}</div></section>}

      {report.selectedGroup && <section className="panel" aria-labelledby="ji-affinity-title"><div className="section-heading"><div><span className="eyebrow">Comparable / adjusted performance</span><h2 id="ji-affinity-title">Cross-press affinity</h2></div><span className="section-note">Same identity and similar duration; Recipe, Material, and predecessor retained when support permits.</span></div>
        {!report.crossPress.length && <div className="empty-state">No cross-press evidence exists for this group.</div>}
        <div className="ji-affinity-list">{report.crossPress.map((row) => <article key={row.pressKey} className={row.pressKey === pressKey ? 'selected' : ''}><div><strong>{row.displayName}</strong><small>{row.runCount} runs · N={row.comparableRunCount} comparable</small></div><StateBar good={row.goodPercent} makeReady={row.makeReadyPercent} bad={row.badPercent} /><div className="ji-affinity-delta"><strong>{row.actualVersusComparableGoodPoints === null ? '—' : `${row.actualVersusComparableGoodPoints >= 0 ? '+' : ''}${row.actualVersusComparableGoodPoints} pts`}</strong><small>vs comparable</small></div><div><strong>{formatDuration(row.medianTransitionSeconds)}</strong><small>median transition</small></div><span className={`ji-support-badge ji-support--${row.support.level}`}>{supportLabel(row.support.level)}</span>{row.recoverableOpportunitySeconds !== null && row.recoverableOpportunitySeconds > 0 && <div className="ji-opportunity"><strong>{formatHours(row.recoverableOpportunitySeconds)}</strong><small>historical recoverable opportunity</small></div>}</article>)}</div>
      </section>}

      <div className="ji-lower-grid">
        <section className="panel" aria-labelledby="ji-transition-title"><div className="section-heading"><div><span className="eyebrow">Previous → current</span><h2 id="ji-transition-title">Transition evidence</h2></div></div>{!report.transitions.length && <div className="empty-state">No resolved predecessor transitions for this selection.</div>}<div className="ji-transition-list">{report.transitions.slice(0, 12).map((row) => <a href={row.evidenceUrl} key={row.transitionKey}><div><strong>{row.previousValue}</strong><i>→</i><strong>{row.currentValue}</strong></div><span style={{ '--heat': `${Math.min(1, (row.medianTransitionSeconds ?? 0) / 7200)}` } as CSSProperties}><b>{formatDuration(row.medianTransitionSeconds)}</b><small>{row.transitionCount} transitions · {supportLabel(row.support.level)} · identity fields changed over {formatDuration(row.fingerprint.medianIdentitySettlingSeconds)}{row.fingerprint.deckChangeEvidence ? ` · ${row.fingerprint.deckChangeEvidence.medianChangedDecks} decks changed` : ''}</small></span></a>)}</div></section>
        <section className="panel" aria-labelledby="ji-loss-title"><div className="section-heading"><div><span className="eyebrow">Exact Radius reasons</span><h2 id="ji-loss-title">Make Ready & Bad loss</h2></div><a href={report.evidenceLinks.rawRadius}>Raw Radius Explorer</a></div>{!report.radiusLosses.length && <div className="empty-state">No Make Ready or Bad episodes in the selected runs.</div>}<div className="ji-loss-list">{report.radiusLosses.slice(0, 12).map((loss) => <a href={loss.evidenceUrl} key={`${loss.eventType}-${loss.statusCode}-${loss.statusDescription}`}><span className={`ji-radius-code ji-radius-code--${loss.eventType.toLowerCase()}`}>{loss.eventType}</span><div><strong>{loss.statusDescription}</strong><small>Status {loss.statusCode ?? '—'} · {loss.occurrenceCount} episodes · median {formatDuration(loss.medianEpisodeSeconds)}</small></div><strong>{formatHours(loss.totalSeconds)}</strong></a>)}</div></section>
      </div>

      <details className="panel ji-method"><summary>Method, timing uncertainty, and limitations</summary><div><strong>Run boundary</strong><p>{report.boundaryPolicy.description}</p><strong>Evidence limits</strong><ul>{report.limitations.map((item) => <li key={item}>{item}</li>)}</ul><div className="ji-evidence-actions"><a href={report.evidenceLinks.rawRadius}>Inspect Radius evidence</a><a href={report.evidenceLinks.telemetryEvents}>Inspect telemetry events</a></div></div></details>
    </>}
  </div>
}
