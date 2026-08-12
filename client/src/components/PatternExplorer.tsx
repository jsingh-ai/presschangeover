import { useEffect, useMemo, useState, type KeyboardEvent } from 'react'
import { getPatternAnalysis } from '../api/process-intelligence-api'
import { formatDuration } from '../episode-presentation'
import { formatPlantDateTime } from '../time-ranges'
import type { ActivityCatalogItem, ActivityLevel, ActivitySelection, PatternAnalysis, PatternMatchMode, RadiusPressKey, RunPatternEvidence } from '../types/api'

const MINIMUM_PATTERN_STEPS = 3

function compact(value: number | null) { return value === null ? 'Not available' : formatDuration(Math.round(value)) }
function width(value: number, maximum: number) { return maximum > 0 ? `${Math.max(value > 0 ? 1 : 0, value / maximum * 100)}%` : '0%' }
function sameActivity(left: ActivitySelection, right: ActivitySelection) { return left.level === right.level && left.key === right.key && (left.level !== 'process_family' || !right.operationalGroupKey || left.operationalGroupKey === right.operationalGroupKey) }
function activityIdentity(item: ActivitySelection) { return `${item.level}:${item.level === 'process_family' ? `${item.operationalGroupKey ?? ''}:` : ''}${item.key}` }
function levelLabel(level: ActivityLevel) { return level === 'radius_state' ? 'Broad Radius phase' : level === 'operational_group' ? 'Type of work' : level === 'process_family' ? 'Specific work' : 'Exact Radius code' }
function conditionSentence(items: ActivitySelection[], mode: PatternMatchMode) { return items.map(({ label }) => label).join(mode === 'in_order' ? ' → ' : ' + ') }

function PatternSequence({ labels, numbered = false }: { labels: string[]; numbered?: boolean }) {
  return <div className="pattern-sequence" aria-label={`Journey: ${labels.join(', then ')}`}>{labels.map((label, index) => <span key={`${index}:${label}`}>{numbered && <small>{index + 1}</small>}<b>{label}</b>{index < labels.length - 1 && <i aria-hidden="true">→</i>}</span>)}</div>
}

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

function PatternEvidence({ rows, onSelectRun, showSelectedTime = false }: { rows: RunPatternEvidence[]; onSelectRun?(run: RunPatternEvidence): void; showSelectedTime?: boolean }) {
  const activate = (event: KeyboardEvent<HTMLTableRowElement>, run: RunPatternEvidence) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelectRun?.(run) }
  }
  return <div className="analysis-table-scroll pattern-evidence-table"><table><thead><tr><th>Press</th><th>Started</th><th>Journey</th><th>Before production</th><th>Production time</th>{showSelectedTime && <th>Time in chosen steps</th>}<th>What stood out</th><th>Evidence</th></tr></thead><tbody>{rows.map((run) => <tr key={run.runId} className={onSelectRun ? 'clickable-row' : ''} tabIndex={onSelectRun ? 0 : undefined} aria-label={onSelectRun ? `Open evidence for ${run.displayName} Run at ${formatPlantDateTime(run.startUtc)}` : undefined} onClick={() => onSelectRun?.(run)} onKeyDown={(event) => activate(event, run)}><th>{run.displayName}</th><td>{formatPlantDateTime(run.startUtc)} CT</td><td><span className="table-sequence">{run.groupSequence.join(' → ')}</span></td><td>{compact(run.timeToProductionSeconds)}</td><td>{compact(run.productionDurationSeconds)}</td>{showSelectedTime && <td>{run.selectedActivitySeconds ? compact(run.selectedActivitySeconds) : '—'}</td>}<td>{run.shortRunAttemptCount ? `${run.shortRunAttemptCount} short production ${run.shortRunAttemptCount === 1 ? 'attempt' : 'attempts'}` : run.transitionCount > 4 ? `${run.transitionCount} changes before completion` : 'No unusual return attempt'}</td><td><button type="button" className="secondary-action" onClick={(event) => { event.stopPropagation(); onSelectRun?.(run) }}>Open evidence</button></td></tr>)}</tbody></table></div>
}

function PatternPurpose() {
  return <section className="pattern-purpose" aria-label="How to use Patterns and Episodes"><article><span>1</span><div><strong>Discover repeated journeys</strong><p>See which three-or-more-step paths happened in at least two Runs.</p></div></article><article><span>2</span><div><strong>Ask your own question</strong><p>Choose three or more steps, decide whether order matters, and find the Runs that match.</p></div></article><article><span>3</span><div><strong>Browse Run episodes</strong><p>Review every completed Run, including longer journeys that happened only once.</p></div></article></section>
}

export function DiscoveredPatterns({ data, onPattern, onPressFocus, onSelectRun }: { data: PatternAnalysis; onPattern(key: string): void; onPressFocus(key: RadiusPressKey | undefined): void; onSelectRun?(run: RunPatternEvidence): void }) {
  const selected = data.selectedPattern
  const maxRuns = Math.max(0, ...data.patterns.map(({ runCount }) => runCount))
  const [focusedPress, setFocusedPress] = useState<RadiusPressKey>()
  const evidence = focusedPress ? data.matchedRuns.filter(({ pressKey }) => pressKey === focusedPress) : data.matchedRuns
  const pressStats = useMemo(() => selected ? [...selected.pressStats].sort((a, b) => a.displayName.localeCompare(b.displayName, undefined, { numeric: true })) : [], [selected])
  return <>
    <PatternPurpose />
    <section className="pattern-definition"><div><p className="eyebrow">What counts as a pattern here</p><h2>A repeated journey, not a single transition</h2><p>A path must have at least <b>{data.patternCriteria.minimumSteps} chronological steps</b> and appear in at least <b>{data.patternCriteria.minimumRuns} completed Runs</b>. Short two-step paths and one-time journeys are counted honestly below, but are not labeled patterns.</p></div><dl><div><dt>Meaningful patterns</dt><dd>{data.uniquePatternCount}</dd></div><div><dt>Runs represented</dt><dd>{data.patternedRuns} / {data.eligibleRuns}</dd></div><div><dt>Coverage of completed Runs</dt><dd>{data.patternedRunSharePercent.toFixed(1)}%</dd></div></dl></section>
    <dl className="pattern-summary"><div><dt>Completed Runs reviewed</dt><dd>{data.eligibleRuns}</dd></div><div><dt>Repeated pattern Runs</dt><dd>{data.patternedRuns}</dd></div><div><dt>Two-step journeys</dt><dd>{data.simpleJourneyRuns}</dd></div><div><dt>Longer one-time journeys</dt><dd>{data.oneOffJourneyRuns}</dd></div><div><dt>Runs with short production attempts</dt><dd>{data.shortAttemptRuns}</dd></div></dl>
    <section className="panel pattern-library"><div className="section-heading"><div><p className="eyebrow">Repeated journeys found</p><h2>Choose a pattern to understand it</h2><p>These are full Operational Group journeys from the selected time range. The percentage always uses all completed Runs as its denominator.</p></div></div>{data.patterns.length ? <div className="pattern-card-list">{data.patterns.map((pattern, index) => <button type="button" key={pattern.patternKey} className={selected?.patternKey === pattern.patternKey ? 'active' : ''} onClick={() => onPattern(pattern.patternKey)}><header><span>Pattern {index + 1}</span><strong>{pattern.runCount} of {data.eligibleRuns} Runs · {pattern.runSharePercent.toFixed(1)}%</strong></header><PatternSequence labels={pattern.orderedGroupLabels} /><footer><span>{pattern.orderedGroupLabels.length} steps</span><span>{pattern.pressesObserved} {pattern.pressesObserved === 1 ? 'press' : 'presses'}</span><span>Typical production start: {compact(pattern.medianTimeToProductionSeconds)}</span>{pattern.containsReentry && <em>Includes a return to an earlier step</em>}</footer><i aria-hidden="true"><b style={{ width: width(pattern.runCount, maxRuns) }} /></i></button>)}</div> : <div className="empty-state pattern-empty"><h3>No repeated three-step pattern in this range</h3><p>The page reviewed {data.eligibleRuns} completed Runs. It found {data.simpleJourneyRuns} short two-step journeys and {data.oneOffJourneyRuns} longer journeys that occurred only once. Try a longer time range or use Build a Journey to ask a specific question.</p></div>}</section>
    {selected && <><section className="panel selected-pattern"><div className="section-heading"><div><p className="eyebrow">Selected repeated journey</p><h2>{selected.orderedGroupLabels.join(' → ')}</h2><p>This is descriptive: it shows what repeatedly happened, not why it happened or whether it was efficient.</p></div></div><PatternSequence labels={selected.orderedGroupLabels} numbered /><div className="pattern-plain-summary"><article><span>How often</span><strong>{selected.runCount} of {data.eligibleRuns} completed Runs</strong><p>{selected.runSharePercent.toFixed(1)}% of the comparable Run set across {selected.pressesObserved} {selected.pressesObserved === 1 ? 'press' : 'presses'}.</p></article><article><span>Typical timing</span><strong>{compact(selected.medianTimeToProductionSeconds)} before stable production</strong><p>Typical production time after that was {compact(selected.medianProductionSeconds)}.</p></article><article><span>How steady</span><strong>{selected.shortAttemptRunCount ? `${selected.shortAttemptRunCount} Runs had a short production attempt` : 'No short production attempts in these Runs'}</strong><p>{selected.containsReentry ? 'Some Runs returned to a step already visited.' : 'The journey did not return to an earlier Operational Group.'}</p></article></div></section>
      <div className="pattern-detail-grid"><section className="panel"><div className="section-heading"><div><p className="eyebrow">Where it happened</p><h2>Pattern rate by press</h2><p>Presses are listed in numeric order. Each fraction is matched Runs divided by completed Runs on that press.</p></div></div><div className="analysis-bars">{pressStats.map((item) => <button type="button" key={item.pressKey} className={focusedPress === item.pressKey ? 'active' : ''} onClick={() => { const next = focusedPress === item.pressKey ? undefined : item.pressKey; setFocusedPress(next); onPressFocus(next) }}><span>{item.displayName}</span><i><b style={{ width: `${item.matchRatePercent}%` }} /></i><strong>{item.matchedRuns} / {item.eligibleRuns} · {item.matchRatePercent.toFixed(1)}%</strong></button>)}</div></section><section className="panel"><div className="section-heading"><div><p className="eyebrow">What differed inside the same journey</p><h2>More specific work used</h2><p>The broad journey matched, but the Process Families inside it were not always identical.</p></div></div><div className="family-variations">{selected.familyVariations.slice(0, 10).map((item) => <article key={item.orderedFamilyKeys.join('>')}><span>{item.orderedFamilyLabels.join(' → ')}</span><strong>{item.runCount} Runs · {item.runShareWithinPatternPercent.toFixed(1)}%</strong></article>)}</div></section></div>
      <section className="panel"><div className="section-heading"><div><p className="eyebrow">The Runs behind this pattern</p><h2>Open any Run to see exactly when it happened</h2><p>The evidence drawer shows the full synchronized timeline. Selecting a press here only narrows this evidence list.</p></div>{focusedPress && <button type="button" className="clear-focus" onClick={() => { setFocusedPress(undefined); onPressFocus(undefined) }}>Show all matching presses</button>}</div><PatternEvidence rows={evidence} onSelectRun={onSelectRun} /></section></>}
    <p className="pattern-exclusions">The selected range reconstructed <b>{data.totalRuns}</b> Runs. <b>{data.eligibleRuns}</b> were complete enough for comparison; <b>{data.excludedInterruptedRuns}</b> crossed unavailable data and <b>{data.excludedPartialRuns}</b> were partial or still open. Excluded Runs never enter the percentages above.</p>
  </>
}

function PatternStepPicker({ catalog, conditions, onSelect }: { catalog: ActivityCatalogItem[]; conditions: ActivityCatalogItem[]; onSelect(item: ActivityCatalogItem): void }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const normalized = query.trim().toLowerCase()
  const available = useMemo(() => catalog.filter((item) => !conditions.some((condition) => sameActivity(condition, item)) && (item.durationSeconds ?? 0) > 0 && (!normalized || `${item.label} ${item.operationalGroupName ?? ''} ${item.statusDescription ?? ''}`.toLowerCase().includes(normalized))), [catalog, conditions, normalized])
  const choices = (level: ActivityLevel, limit = 24) => available.filter((item) => item.level === level).sort((a, b) => (b.durationSeconds ?? 0) - (a.durationSeconds ?? 0) || a.label.localeCompare(b.label)).slice(0, limit)
  const option = (item: ActivityCatalogItem) => <button type="button" key={activityIdentity(item)} onClick={() => { onSelect(item); setOpen(false); setQuery('') }}><strong>{item.label}</strong>{item.operationalGroupName && item.level === 'process_family' && <small>Within {item.operationalGroupName}</small>}{item.percentageOfObservedTime !== undefined && <em>{item.percentageOfObservedTime.toFixed(1)}% of observed time</em>}</button>
  return <div className="pattern-step-picker"><button type="button" className="pattern-add-step" onClick={() => setOpen((value) => !value)} disabled={conditions.length >= 6}>{conditions.length >= 6 ? 'Maximum 6 steps' : `+ Add step ${conditions.length + 1}`}</button>{open && <div className="pattern-step-picker__menu"><header><div><strong>What happened at this point?</strong><span>Start with a type of work. Use a more specific choice only when it matters.</span></div><button type="button" aria-label="Close step choices" onClick={() => setOpen(false)}>×</button></header><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search cleaning, adjustment, waiting…" autoFocus /><section><h3>Type of work <small>recommended</small></h3><div>{choices('operational_group').map(option)}</div></section><details><summary>Choose more specific work</summary><div>{choices('process_family').map(option)}</div></details><details><summary>Choose a broad Radius phase</summary><div>{choices('radius_state').map(option)}</div></details><details><summary>Choose an exact Radius code <small>advanced</small></summary><div>{normalized ? choices('exact_status', 40).map(option) : <p>Search above to narrow the exact Radius codes.</p>}</div></details></div>}</div>
}

export function RunEpisodes({ data, onSelectRun }: { data: PatternAnalysis; onSelectRun?(run: RunPatternEvidence): void }) {
  const [press, setPress] = useState<RadiusPressKey>()
  const [journey, setJourney] = useState<'all' | 'three_plus' | 'two_step' | 'short_attempt'>('all')
  const presses = useMemo(() => [...new Map(data.recentRuns.map((run) => [run.pressKey, run.displayName])).entries()].sort((a, b) => a[1].localeCompare(b[1], undefined, { numeric: true })), [data.recentRuns])
  const visible = data.recentRuns.filter((run) => (!press || run.pressKey === press) && (journey === 'all' || journey === 'three_plus' && run.groupSequence.length >= 3 || journey === 'two_step' && run.groupSequence.length < 3 || journey === 'short_attempt' && run.shortRunAttemptCount > 0))
  return <>
    <PatternPurpose />
    <section className="panel episode-browser-intro"><div className="section-heading"><div><p className="eyebrow">Individual completed Runs</p><h2>Browse the journeys behind the patterns</h2><p>This view includes repeated patterns, simple two-step paths, and longer one-time journeys. Open a Run to see its exact synchronized evidence.</p></div></div><dl className="activity-metrics"><div><dt>Completed Runs</dt><dd>{data.eligibleRuns}</dd></div><div><dt>Runs in repeated patterns</dt><dd>{data.patternedRuns}</dd></div><div><dt>Simple two-step Runs</dt><dd>{data.simpleJourneyRuns}</dd></div><div><dt>Longer one-time Runs</dt><dd>{data.oneOffJourneyRuns}</dd></div><div><dt>Short production attempts</dt><dd>{data.shortAttemptRuns}</dd></div></dl></section>
    <section className="episode-browser-controls" aria-label="Filter Run episodes"><div><span>Show journeys</span>{([['all', 'All completed Runs'], ['three_plus', '3+ steps'], ['two_step', 'Two-step'], ['short_attempt', 'Short production attempt']] as const).map(([key, label]) => <button type="button" key={key} className={journey === key ? 'active' : ''} aria-pressed={journey === key} onClick={() => setJourney(key)}>{label}</button>)}</div><div><span>Press</span><button type="button" className={!press ? 'active' : ''} aria-pressed={!press} onClick={() => setPress(undefined)}>All presses</button>{presses.map(([key, label]) => <button type="button" key={key} className={press === key ? 'active' : ''} aria-pressed={press === key} onClick={() => setPress(key)}>{label}</button>)}</div></section>
    <section className="panel"><div className="section-heading"><div><p className="eyebrow">{visible.length} Runs shown</p><h2>Completed Run episodes</h2><p>Runs are listed newest first. “Before production” ends when stable production begins.</p></div></div>{visible.length ? <PatternEvidence rows={visible} onSelectRun={onSelectRun} /> : <p className="empty-state">No completed Runs match these local filters.</p>}</section>
    <p className="pattern-exclusions"><b>{data.excludedInterruptedRuns}</b> interrupted and <b>{data.excludedPartialRuns}</b> partial/open Runs are excluded from this browser because their full journey is not comparable.</p>
  </>
}

export function Builder({ data, conditions, mode, onConditions, onMode, onRefresh, onSelectRun }: { data: PatternAnalysis; conditions: ActivityCatalogItem[]; mode: PatternMatchMode; onConditions(items: ActivityCatalogItem[]): void; onMode(mode: PatternMatchMode): void; onRefresh(): void; onSelectRun?(run: RunPatternEvidence): void }) {
  const builder = data.builder
  const [focusedPress, setFocusedPress] = useState<RadiusPressKey>()
  const evidence = focusedPress ? data.matchedRuns.filter(({ pressKey }) => pressKey === focusedPress) : data.matchedRuns
  const submittedIdentity = builder?.conditions.map(activityIdentity).join('|') ?? ''
  const currentIdentity = conditions.map(activityIdentity).join('|')
  const pending = Boolean(builder && (submittedIdentity !== currentIdentity || builder.matchMode !== mode))
  const readyToAnalyze = conditions.length >= MINIMUM_PATTERN_STEPS
  const move = (index: number, direction: -1 | 1) => { const next = [...conditions]; const target = index + direction; if (!next[target]) return; [next[index], next[target]] = [next[target]!, next[index]!]; onConditions(next) }
  const sortedPresses = builder ? [...builder.pressStats].sort((a, b) => a.displayName.localeCompare(b.displayName, undefined, { numeric: true })) : []
  return <>
    <PatternPurpose />
    <section className="pattern-builder-panel"><div className="pattern-builder-heading"><div><p className="eyebrow">Build a journey</p><h2>Choose at least three steps</h2><p>Build the path in the order a person would describe it: what happened first, what happened next, and what happened after that.</p></div><strong className={readyToAnalyze ? 'is-ready' : ''}>{conditions.length} / {MINIMUM_PATTERN_STEPS} minimum steps</strong></div><div className="builder-steps">{conditions.map((item, index) => <article key={activityIdentity(item)}><span>{index + 1}</span><div><small>{levelLabel(item.level)}{item.level === 'process_family' && item.operationalGroupName ? ` · ${item.operationalGroupName}` : ''}</small><strong>{item.label}</strong></div><div><button type="button" aria-label={`Move ${item.label} earlier`} disabled={index === 0} onClick={() => move(index, -1)}>↑</button><button type="button" aria-label={`Move ${item.label} later`} disabled={index === conditions.length - 1} onClick={() => move(index, 1)}>↓</button><button type="button" aria-label={`Remove ${item.label}`} onClick={() => onConditions(conditions.filter((_, candidate) => candidate !== index))}>×</button></div></article>)}<PatternStepPicker catalog={data.catalog} conditions={conditions} onSelect={(item) => onConditions([...conditions, item])} /></div><fieldset className="builder-question-mode"><legend>How should the Runs match?</legend><label className={mode === 'in_order' ? 'active' : ''}><input type="radio" name="pattern-match-mode" checked={mode === 'in_order'} onChange={() => onMode('in_order')} /><span><strong>Follow this order</strong><small>Step 1 must happen before Step 2, then Step 3. Other activity may occur between them.</small></span></label><label className={mode === 'contains_all' ? 'active' : ''}><input type="radio" name="pattern-match-mode" checked={mode === 'contains_all'} onChange={() => onMode('contains_all')} /><span><strong>Same Run, any order</strong><small>All chosen steps must happen in the same Run, but their order does not matter.</small></span></label></fieldset>{conditions.length > 0 && <div className="builder-question-preview"><span>Your question</span><strong>{mode === 'in_order' ? 'Find Runs that followed:' : 'Find Runs containing:'}</strong><PatternSequence labels={conditions.map(({ label }) => label)} numbered={mode === 'in_order'} /></div>}<div className="builder-submit"><p>{readyToAnalyze ? 'Your journey is ready to check.' : `Add ${MINIMUM_PATTERN_STEPS - conditions.length} more ${MINIMUM_PATTERN_STEPS - conditions.length === 1 ? 'step' : 'steps'} to make this a meaningful pattern question.`}</p><button type="button" onClick={onRefresh} disabled={!readyToAnalyze}>Find matching Runs</button></div></section>
    {pending && <p className="message message--warning">Your journey has changed. Select <b>Find matching Runs</b> to refresh the results below.</p>}
    {!builder || !builder.ready ? <section className="panel empty-state builder-empty"><h2>Build a three-step journey</h2><p>Your results will appear here after you choose at least three effective steps and select Find matching Runs.</p></section> : <>{builder.redundantConditionMessage && <p className="message message--warning">{builder.redundantConditionMessage}</p>}<section className={`panel builder-answer ${pending ? 'is-stale' : ''}`}><div className="section-heading"><div><p className="eyebrow">Answer</p><h2>{builder.matchedRuns ? `${builder.matchedRuns} completed Runs matched` : 'No completed Runs matched'}</h2><p>{builder.matchMode === 'in_order' ? 'The chosen steps appeared in the requested order. Other activity may have happened between them.' : 'Every chosen step appeared within the same Run; order was ignored.'}</p></div></div><div className="builder-answer-grid"><article><span>How common</span><strong>{builder.matchedRuns} of {data.eligibleRuns} Runs</strong><p>{builder.matchSharePercent.toFixed(1)}% of the completed Run set.</p></article><article><span>Where</span><strong>{builder.pressesObserved} {builder.pressesObserved === 1 ? 'press' : 'presses'}</strong><p>Use the press list below to see whether the result is broad or concentrated.</p></article><article><span>Typical timing</span><strong>{compact(builder.medianTimeToProductionSeconds)}</strong><p>Median time before stable production in matching Runs.</p></article><article><span>Time in chosen steps</span><strong>{compact(builder.medianSelectedActivitySeconds)}</strong><p>Typical combined time in the selected activities, without double counting.</p></article></div></section>
      <div className="pattern-detail-grid"><section className="panel"><div className="section-heading"><div><p className="eyebrow">Where the answer came from</p><h2>Match rate by press</h2><p>Presses are in numeric order. Each fraction is matching Runs divided by completed Runs.</p></div></div><div className="analysis-bars">{sortedPresses.map((item) => <button type="button" key={item.pressKey} className={focusedPress === item.pressKey ? 'active' : ''} onClick={() => setFocusedPress(focusedPress === item.pressKey ? undefined : item.pressKey)}><span>{item.displayName}</span><i><b style={{ width: `${item.matchRatePercent}%` }} /></i><strong>{item.matchedRuns} / {item.eligibleRuns} · {item.matchRatePercent.toFixed(1)}%</strong></button>)}</div></section><section className="panel"><div className="section-heading"><div><p className="eyebrow">Repeated full journeys among the matches</p><h2>What the matching Runs usually looked like</h2><p>Only full journeys with at least three steps and at least two matching Runs appear here.</p></div></div>{builder.topPatterns.length ? <div className="builder-matched-journeys">{builder.topPatterns.map((item) => <article key={item.patternKey}><PatternSequence labels={item.labels} /><strong>{item.runCount} Runs · {item.percentageOfMatches.toFixed(1)}% of matches</strong></article>)}</div> : <p className="empty-state">The question matched Runs, but no single full three-step journey repeated at least twice within those matches.</p>}</section></div>
      <section className="panel"><div className="section-heading"><div><p className="eyebrow">Runs that answered your question</p><h2>Open the exact evidence</h2><p>Time in chosen steps is the combined time without counting overlapping broad and specific choices twice.</p></div>{focusedPress && <button type="button" className="clear-focus" onClick={() => setFocusedPress(undefined)}>Show all matching presses</button>}</div>{evidence.length ? <PatternEvidence rows={evidence} onSelectRun={onSelectRun} showSelectedTime /> : <p className="empty-state">No completed Run matched this journey in the selected time range.</p>}</section></>}
  </>
}

export function PatternExplorer({ fromUtc, toUtc, pressKey, onSelectRun, onRestoreRun }: { fromUtc: string; toUtc: string; pressKey?: RadiusPressKey; onSelectRun?(run: RunPatternEvidence): void; onRestoreRun?(run: RunPatternEvidence): void }) {
  const query = new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search)
  const initialBuilder = initialConditions()
  const [tab, setTab] = useState<'discovered' | 'builder' | 'episodes'>(() => query.get('patternTab') === 'builder' || initialBuilder.length ? 'builder' : query.get('patternTab') === 'episodes' ? 'episodes' : 'discovered')
  const [data, setData] = useState<PatternAnalysis>()
  const [selectedPatternKey, setSelectedPatternKey] = useState<string | undefined>(() => query.get('patternKey') ?? undefined)
  const [conditions, setConditions] = useState<ActivityCatalogItem[]>([])
  const [submittedConditions, setSubmittedConditions] = useState<ActivitySelection[]>(initialBuilder)
  const [mode, setMode] = useState<PatternMatchMode>(() => query.get('patternMode') === 'contains_all' ? 'contains_all' : 'in_order')
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
      if (!conditions.length && submittedConditions.length) setConditions(submittedConditions.map((condition) => value.catalog.find((item) => sameActivity(item, condition)) ?? { ...condition, operationalGroupKey: condition.operationalGroupKey ?? null, description: null, eventType: null, statusCode: null, statusDescription: null, operationalGroupName: null, processFamilyKey: null, processFamilyName: null, needsClassification: false }))
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
      const restoredMode: PatternMatchMode = restoredQuery.get('patternMode') === 'contains_all' ? 'contains_all' : 'in_order'
      setTab(restoredQuery.get('patternTab') === 'builder' || restoredConditions.length ? 'builder' : restoredQuery.get('patternTab') === 'episodes' ? 'episodes' : 'discovered')
      setSelectedPatternKey(restoredQuery.get('patternKey') ?? undefined)
      setMode(restoredMode)
      setSubmittedMode(restoredMode)
      setSubmittedConditions(restoredConditions)
      setConditions(data ? restoredConditions.map((condition) => data.catalog.find((item) => sameActivity(item, condition)) ?? { ...condition, operationalGroupKey: condition.operationalGroupKey ?? null, description: null, eventType: null, statusCode: null, statusDescription: null, operationalGroupName: null, processFamilyKey: null, processFamilyName: null, needsClassification: false }) : [])
    }
    window.addEventListener('popstate', restore)
    return () => window.removeEventListener('popstate', restore)
  }, [data])

  const selectTab = (next: 'discovered' | 'builder' | 'episodes') => { setTab(next); updatePatternUrl({ patternTab: next }) }
  const selectPattern = (key: string) => { setSelectedPatternKey(key); updatePatternUrl({ patternTab: 'discovered', patternKey: key }) }
  const refreshBuilder = () => {
    if (conditions.length < MINIMUM_PATTERN_STEPS) return
    const submitted = conditions.map(({ level, key, label, operationalGroupKey }) => ({ level, key, label, operationalGroupKey }))
    setSubmittedMode(mode)
    setSubmittedConditions(submitted)
    updatePatternUrl({ patternTab: 'builder', patternKey: undefined, patternMode: mode, patternConditions: JSON.stringify(submitted.map(({ level, key, label, operationalGroupKey }) => ({ level, key, label, ...(operationalGroupKey ? { operationalGroupKey } : {}) }))) })
  }
  return <div className="pattern-explorer"><div className="analysis-tabs pattern-tabs" role="tablist"><button type="button" role="tab" aria-selected={tab === 'discovered'} className={tab === 'discovered' ? 'active' : ''} onClick={() => selectTab('discovered')}><strong>Discover Patterns</strong><small>Repeated journeys found in the data</small></button><button type="button" role="tab" aria-selected={tab === 'builder'} className={tab === 'builder' ? 'active' : ''} onClick={() => selectTab('builder')}><strong>Build a Journey</strong><small>Ask whether chosen steps happened</small></button><button type="button" role="tab" aria-selected={tab === 'episodes'} className={tab === 'episodes' ? 'active' : ''} onClick={() => selectTab('episodes')}><strong>Browse Run Episodes</strong><small>Open individual completed Runs</small></button></div>{loading && <div className="scope-progress" role="status"><i />Reviewing completed Run journeys…</div>}{error && <p className="message message--warning">Pattern evidence could not be updated. Previously loaded evidence remains visible.</p>}{data && tab === 'discovered' && <DiscoveredPatterns data={data} onPattern={selectPattern} onPressFocus={() => {}} onSelectRun={onSelectRun} />}{data && tab === 'builder' && <Builder data={data} conditions={conditions} mode={mode} onConditions={setConditions} onMode={setMode} onRefresh={refreshBuilder} onSelectRun={onSelectRun} />}{data && tab === 'episodes' && <RunEpisodes data={data} onSelectRun={onSelectRun} />}</div>
}
