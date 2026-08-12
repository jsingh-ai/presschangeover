import { useEffect, useMemo, useState, type KeyboardEvent } from 'react'
import { getPatternAnalysis } from '../api/process-intelligence-api'
import { formatDuration } from '../episode-presentation'
import { formatPlantDateTime } from '../time-ranges'
import type { ActivityCatalogItem, ActivitySelection, PatternAnalysis, PatternMatchMode, RadiusPressKey, RunPatternEvidence } from '../types/api'
import { ActivityPicker } from './OperationalActivityExplorer'

function compact(value: number | null) { return value === null ? 'Not available' : formatDuration(Math.round(value)) }
function width(value: number, maximum: number) { return maximum > 0 ? `${Math.max(value > 0 ? 1 : 0, value / maximum * 100)}%` : '0%' }
function PatternSequence({ labels }: { labels: string[] }) { return <div className="pattern-sequence">{labels.map((label, index) => <span key={`${index}:${label}`}><b>{label}</b>{index < labels.length - 1 && <i aria-hidden="true">→</i>}</span>)}</div> }

function updatePatternUrl(changes: Record<string, string | undefined>, mode: 'push' | 'replace' = 'push') {
  if (typeof window === 'undefined') return
  const url = new URL(window.location.href)
  Object.entries(changes).forEach(([key, value]) => value === undefined ? url.searchParams.delete(key) : url.searchParams.set(key, value))
  window.history[mode === 'push' ? 'pushState' : 'replaceState']({}, '', `${url.pathname}?${url.searchParams}`)
}

function initialConditions(): ActivitySelection[] {
  if (typeof window === 'undefined') return []
  const encoded = new URLSearchParams(window.location.search).get('patternConditions')
  if (!encoded) return []
  try {
    const parsed = JSON.parse(encoded) as unknown
    return Array.isArray(parsed) ? parsed.filter((item): item is ActivitySelection => Boolean(item && typeof item === 'object' && typeof (item as ActivitySelection).level === 'string' && typeof (item as ActivitySelection).key === 'string')).slice(0, 6) : []
  } catch { return [] }
}

function PatternEvidence({ rows, onSelectRun }: { rows: RunPatternEvidence[]; onSelectRun?(run: RunPatternEvidence): void }) {
  const activate = (event: KeyboardEvent<HTMLTableRowElement>, run: RunPatternEvidence) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelectRun?.(run) }
  }
  return <div className="analysis-table-scroll"><table><thead><tr><th>Press</th><th>Run start</th><th>Run end</th><th>Pattern</th><th>Time to production</th><th>Production</th><th>Selected activity</th><th>Short attempts</th><th>Transitions</th><th>Data quality</th></tr></thead><tbody>{rows.map((run) => <tr key={run.runId} className={onSelectRun ? 'clickable-row' : ''} tabIndex={onSelectRun ? 0 : undefined} role={onSelectRun ? 'button' : undefined} onClick={() => onSelectRun?.(run)} onKeyDown={(event) => activate(event, run)} aria-label={onSelectRun ? `Open evidence for ${run.displayName} Run at ${formatPlantDateTime(run.startUtc)}` : undefined}><th>{run.displayName}</th><td>{formatPlantDateTime(run.startUtc)} CT</td><td>{formatPlantDateTime(run.endUtc)} CT</td><td><span className="table-sequence">{run.groupSequence.join(' → ')}</span></td><td>{compact(run.timeToProductionSeconds)}</td><td>{compact(run.productionDurationSeconds)}</td><td>{run.selectedActivitySeconds ? compact(run.selectedActivitySeconds) : '—'}</td><td>{run.shortRunAttemptCount}</td><td>{run.transitionCount}</td><td>{run.dataInterrupted ? 'Interrupted' : run.isPartial ? 'Partial / open' : 'Completed'}</td></tr>)}</tbody></table></div>
}

export function DiscoveredPatterns({ data, onPattern, onPressFocus, onSelectRun }: { data: PatternAnalysis; onPattern(key: string): void; onPressFocus(key: RadiusPressKey | undefined): void; onSelectRun?(run: RunPatternEvidence): void }) {
  const selected = data.selectedPattern
  const maxRuns = Math.max(0, ...data.patterns.map(({ runCount }) => runCount)
  )
  const [focusedPress, setFocusedPress] = useState<RadiusPressKey>()
  const evidence = focusedPress ? data.matchedRuns.filter(({ pressKey }) => pressKey === focusedPress) : data.matchedRuns
  const pressStats = useMemo(() => selected ? [...selected.pressStats].sort((a, b) => b.matchRatePercent - a.matchRatePercent || b.matchedRuns - a.matchedRuns || b.eligibleRuns - a.eligibleRuns) : [], [selected])
  return <>
    <dl className="pattern-summary"><div><dt>Eligible Runs</dt><dd>{data.eligibleRuns}</dd></div><div><dt>Unique patterns</dt><dd>{data.uniquePatternCount}</dd></div><div><dt>Most common pattern</dt><dd>{data.patterns[0]?.orderedGroupLabels.join(' → ') ?? 'No eligible patterns'}</dd></div><div><dt>Prevalence</dt><dd>{data.patterns[0]?.runSharePercent.toFixed(1) ?? '0.0'}%</dd></div><div><dt>Runs with short return attempts</dt><dd>{data.shortAttemptRuns}</dd></div></dl>
    <section className="panel"><div className="section-heading"><div><p className="eyebrow">Discovered patterns</p><h2>Pattern prevalence</h2><p>The ordered Operational Group sequence is the fingerprint. Only contiguous duplicates collapse; re-entry and cycling remain visible.</p></div></div>{data.patterns.length ? <div className="pattern-prevalence">{data.patterns.slice(0, 20).map((pattern) => <button type="button" key={pattern.patternKey} className={selected?.patternKey === pattern.patternKey ? 'active' : ''} onClick={() => onPattern(pattern.patternKey)}><span>{pattern.orderedGroupLabels.join(' → ')}</span><i><b style={{ width: width(pattern.runCount, maxRuns) }} /></i><strong>{pattern.runCount} / {data.eligibleRuns} · {pattern.runSharePercent.toFixed(1)}%</strong></button>)}</div> : <p className="empty-state">No eligible completed Runs are available for pattern discovery in this scope.</p>}</section>
    {selected && <><section className="panel selected-pattern"><div className="section-heading"><div><p className="eyebrow">Selected pattern</p><h2>{selected.orderedGroupLabels.join(' → ')}</h2></div></div><PatternSequence labels={selected.orderedGroupLabels} /><dl className="activity-metrics"><div><dt>Run count</dt><dd>{selected.runCount} / {data.eligibleRuns}</dd></div><div><dt>Eligible share</dt><dd>{selected.runSharePercent.toFixed(1)}%</dd></div><div><dt>Presses</dt><dd>{selected.pressesObserved}</dd></div><div><dt>Median to sustained production</dt><dd>{compact(selected.medianTimeToProductionSeconds)}</dd></div><div><dt>Runs with short return attempts</dt><dd>{selected.shortAttemptRunCount}</dd></div><div><dt>Re-entry preserved</dt><dd>{selected.containsReentry ? 'Yes' : 'No'}</dd></div></dl></section>
      <div className="activity-two-column"><section className="panel"><div className="section-heading"><div><p className="eyebrow">Within-press support</p><h2>Match rate by press</h2></div></div><div className="analysis-bars">{pressStats.map((item) => <button type="button" key={item.pressKey} onClick={() => { const next = focusedPress === item.pressKey ? undefined : item.pressKey; setFocusedPress(next); onPressFocus(next) }}><span>{item.displayName}</span><i><b style={{ width: `${item.matchRatePercent}%` }} /></i><strong>{item.matchedRuns} / {item.eligibleRuns} · {item.matchRatePercent.toFixed(1)}%</strong></button>)}</div></section><section className="panel"><div className="section-heading"><div><p className="eyebrow">Operational Group pattern explained</p><h2>Process Family variations</h2></div></div><div className="family-variations">{selected.familyVariations.slice(0, 10).map((item) => <article key={item.orderedFamilyKeys.join('>')}><span>{item.orderedFamilyLabels.join(' → ')}</span><strong>{item.runCount} Runs · {item.runShareWithinPatternPercent.toFixed(1)}%</strong></article>)}</div></section></div>
      <section className="panel"><div className="section-heading"><div><p className="eyebrow">Supporting canonical Runs</p><h2>Matched Run evidence</h2><p>Select a Run to open the shared Evidence Drawer. The global press filter is not changed.</p></div>{focusedPress && <button type="button" className="clear-focus" onClick={() => { setFocusedPress(undefined); onPressFocus(undefined) }}>Clear local press focus</button>}</div><PatternEvidence rows={evidence} onSelectRun={onSelectRun} /></section></>}
    <p className="pattern-exclusions">Total reconstructed Runs: <b>{data.totalRuns}</b> · Eligible: <b>{data.eligibleRuns}</b> · Excluded interrupted: <b>{data.excludedInterruptedRuns}</b> · Excluded partial/open: <b>{data.excludedPartialRuns}</b>. Exclusions do not enter prevalence denominators.</p>
  </>
}

export function Builder({ data, conditions, mode, onConditions, onMode, onRefresh, onSelectRun }: { data: PatternAnalysis; conditions: ActivityCatalogItem[]; mode: PatternMatchMode; onConditions(items: ActivityCatalogItem[]): void; onMode(mode: PatternMatchMode): void; onRefresh(): void; onSelectRun?(run: RunPatternEvidence): void }) {
  const builder = data.builder
  const [focusedPress, setFocusedPress] = useState<RadiusPressKey>()
  const evidence = focusedPress ? data.matchedRuns.filter(({ pressKey }) => pressKey === focusedPress) : data.matchedRuns
  return <>
    <section className="pattern-builder-panel"><div className="builder-chips">{conditions.map((item, index) => <span key={`${item.level}:${item.key}`}><small>{item.level.replaceAll('_', ' ')}</small>{item.label}<button type="button" aria-label={`Remove ${item.label}`} onClick={() => onConditions(conditions.filter((_, candidate) => candidate !== index))}>×</button></span>)}{conditions.length < 6 && <ActivityPicker catalog={data.catalog} prompt="Add an activity condition" onSelect={(item) => !conditions.some(({ level, key }) => level === item.level && key === item.key) && onConditions([...conditions, item])} />}</div><div className="builder-mode"><span>Match</span><button type="button" className={mode === 'contains_all' ? 'active' : ''} onClick={() => onMode('contains_all')}>Contains All</button><button type="button" className={mode === 'in_order' ? 'active' : ''} onClick={() => onMode('in_order')}>In This Order</button><button type="button" onClick={onRefresh} disabled={!conditions.length}>Analyze Runs</button></div><p>{mode === 'contains_all' ? 'Every selected activity must occur somewhere in the same eligible Run. Order does not matter.' : 'Each selected activity must occur at a later chronological position in the chosen order.'}</p></section>
    {!builder ? <section className="panel empty-state"><h2>Build a Run question</h2><p>Add one or more conditions using Radius State, Operational Group, Process Family, or Exact Radius Identity.</p></section> : <>{builder.redundantConditionMessage && <p className="message message--warning">{builder.redundantConditionMessage}</p>}<section className="panel"><div className="section-heading"><div><p className="eyebrow">Builder results</p><h2>{builder.matchMode === 'contains_all' ? 'Contains All' : 'In This Order'}</h2></div></div><dl className="activity-metrics"><div><dt>Matched Runs</dt><dd>{builder.matchedRuns} / {data.eligibleRuns}</dd></div><div><dt>Match share</dt><dd>{builder.matchSharePercent.toFixed(1)}%</dd></div><div><dt>Presses</dt><dd>{builder.pressesObserved}</dd></div><div><dt>Median to production</dt><dd>{compact(builder.medianTimeToProductionSeconds)}</dd></div><div><dt>Median selected time</dt><dd>{compact(builder.medianSelectedActivitySeconds)}</dd></div><div><dt>Total selected time</dt><dd>{compact(builder.totalSelectedActivitySeconds)}</dd></div></dl><div className="builder-donut-row"><div className="matched-donut" style={{ background: `conic-gradient(var(--primary) 0 ${builder.matchSharePercent}%, var(--surface-strong) ${builder.matchSharePercent}% 100%)` }} role="img" aria-label={`${builder.matchSharePercent.toFixed(1)} percent of eligible Runs matched`}><span>{builder.matchSharePercent.toFixed(1)}%<small>matched</small></span></div><p><b>{builder.matchedRuns}</b> matched Runs<br /><b>{Math.max(0, data.eligibleRuns - builder.matchedRuns)}</b> other eligible Runs</p></div></section>
      <div className="activity-two-column"><section className="panel"><div className="section-heading"><div><p className="eyebrow">Within-press denominator</p><h2>Match rate by press</h2></div></div><div className="analysis-bars">{[...builder.pressStats].sort((a, b) => b.matchRatePercent - a.matchRatePercent || b.matchedRuns - a.matchedRuns).map((item) => <button type="button" key={item.pressKey} onClick={() => setFocusedPress(focusedPress === item.pressKey ? undefined : item.pressKey)}><span>{item.displayName}</span><i><b style={{ width: `${item.matchRatePercent}%` }} /></i><strong>{item.matchedRuns} / {item.eligibleRuns} · {item.matchRatePercent.toFixed(1)}%</strong></button>)}</div></section><section className="panel"><div className="section-heading"><div><p className="eyebrow">Full sequences among matches</p><h2>Most common matched patterns</h2></div></div><div className="semantic-bars">{builder.topPatterns.map((item) => <div key={item.patternKey}><span>{item.labels.join(' → ')}</span><i><b style={{ width: `${item.percentageOfMatches}%` }} /></i><strong>{item.runCount} · {item.percentageOfMatches.toFixed(1)}%</strong></div>)}</div></section></div>
      <section className="panel"><div className="section-heading"><div><p className="eyebrow">Actual matching canonical Runs</p><h2>Matched Run evidence</h2><p>Selected-activity time uses the union of matching intervals, preventing hierarchical double counting.</p></div>{focusedPress && <button type="button" className="clear-focus" onClick={() => setFocusedPress(undefined)}>Clear local press focus</button>}</div><PatternEvidence rows={evidence} onSelectRun={onSelectRun} /></section></>}
  </>
}

export function PatternExplorer({ fromUtc, toUtc, pressKey, onSelectRun, onRestoreRun }: { fromUtc: string; toUtc: string; pressKey?: RadiusPressKey; onSelectRun?(run: RunPatternEvidence): void; onRestoreRun?(run: RunPatternEvidence): void }) {
  const query = new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search)
  const initialBuilder = initialConditions()
  const [tab, setTab] = useState<'discovered' | 'builder'>(() => query.get('patternTab') === 'builder' || initialBuilder.length ? 'builder' : 'discovered')
  const [data, setData] = useState<PatternAnalysis>()
  const [selectedPatternKey, setSelectedPatternKey] = useState<string | undefined>(() => query.get('patternKey') ?? undefined)
  const [conditions, setConditions] = useState<ActivityCatalogItem[]>([])
  const [submittedConditions, setSubmittedConditions] = useState<ActivitySelection[]>(initialBuilder)
  const [mode, setMode] = useState<PatternMatchMode>(() => query.get('patternMode') === 'in_order' ? 'in_order' : 'contains_all')
  const [submittedMode, setSubmittedMode] = useState<PatternMatchMode>(mode)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError(false)
    void getPatternAnalysis(fromUtc, toUtc, { selectedPatternKey, conditions: submittedConditions, matchMode: submittedMode, pressKey }, controller.signal).then((value) => {
      if (controller.signal.aborted) return
      setData(value)
      if (!conditions.length && submittedConditions.length) setConditions(submittedConditions.map((condition) => value.catalog.find((item) => item.level === condition.level && item.key === condition.key) ?? { ...condition, description: null, eventType: null, statusCode: null, statusDescription: null, operationalGroupKey: null, operationalGroupName: null, processFamilyKey: null, processFamilyName: null, needsClassification: false }))
      const evidenceRunId = new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search).get('runId')
      const restored = evidenceRunId ? value.matchedRuns.find(({ runId }) => runId === evidenceRunId) : undefined
      if (restored) onRestoreRun?.(restored)
    }).catch(() => { if (!controller.signal.aborted) setError(true) }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [fromUtc, toUtc, pressKey, selectedPatternKey, submittedConditions, submittedMode])

  useEffect(() => {
    const restore = () => {
      const restoredQuery = new URLSearchParams(window.location.search)
      const restoredConditions = initialConditions()
      const restoredMode: PatternMatchMode = restoredQuery.get('patternMode') === 'in_order' ? 'in_order' : 'contains_all'
      setTab(restoredQuery.get('patternTab') === 'builder' || restoredConditions.length ? 'builder' : 'discovered')
      setSelectedPatternKey(restoredQuery.get('patternKey') ?? undefined)
      setMode(restoredMode)
      setSubmittedMode(restoredMode)
      setSubmittedConditions(restoredConditions)
      setConditions(data ? restoredConditions.map((condition) => data.catalog.find((item) => item.level === condition.level && item.key === condition.key) ?? { ...condition, description: null, eventType: null, statusCode: null, statusDescription: null, operationalGroupKey: null, operationalGroupName: null, processFamilyKey: null, processFamilyName: null, needsClassification: false }) : [])
    }
    window.addEventListener('popstate', restore)
    return () => window.removeEventListener('popstate', restore)
  }, [data])

  const selectTab = (next: 'discovered' | 'builder') => { setTab(next); updatePatternUrl({ patternTab: next }) }
  const selectPattern = (key: string) => { setSelectedPatternKey(key); updatePatternUrl({ patternTab: 'discovered', patternKey: key }) }
  const refreshBuilder = () => {
    const submitted = conditions.map(({ level, key, label }) => ({ level, key, label }))
    setSubmittedMode(mode)
    setSubmittedConditions(submitted)
    updatePatternUrl({ patternTab: 'builder', patternKey: undefined, patternMode: mode, patternConditions: JSON.stringify(submitted.map(({ level, key, label }) => ({ level, key, label }))) })
  }
  return <div className="pattern-explorer"><div className="analysis-tabs" role="tablist"><button type="button" role="tab" aria-selected={tab === 'discovered'} className={tab === 'discovered' ? 'active' : ''} onClick={() => selectTab('discovered')}>Discovered Patterns</button><button type="button" role="tab" aria-selected={tab === 'builder'} className={tab === 'builder' ? 'active' : ''} onClick={() => selectTab('builder')}>Pattern Builder</button></div>{loading && <div className="scope-progress" role="status"><i />Updating canonical Run patterns…</div>}{error && <p className="message message--warning">Pattern evidence could not be updated. Previously loaded evidence remains visible.</p>}{data && tab === 'discovered' && <DiscoveredPatterns data={data} onPattern={selectPattern} onPressFocus={() => {}} onSelectRun={onSelectRun} />}{data && tab === 'builder' && <Builder data={data} conditions={conditions} mode={mode} onConditions={setConditions} onMode={setMode} onRefresh={refreshBuilder} onSelectRun={onSelectRun} />}</div>
}
