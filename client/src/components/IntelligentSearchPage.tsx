import { useEffect, useRef, useState, type FormEvent } from 'react'
import { searchClassifications } from '../api/process-intelligence-api'
import { pressFromLocation } from '../navigation'
import type { ActivityLevel, ClassificationSearchResponse, ClassificationSearchResult, RadiusPressKey } from '../types/api'

const SEARCH_PRESSES: Array<{ key: RadiusPressKey; label: string }> = [3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].map((number) => ({ key: `press${number}` as RadiusPressKey, label: `Press ${number}` }))
const SEARCH_EXAMPLES = [
  { title: 'Type of work', copy: 'Start broad when you want to understand where time went.', values: ['Production', 'Changeover & Setup', 'Adjustment & Quality', 'Fault & Recovery'] },
  { title: 'Specific work', copy: 'Use a Process Family when you know the kind of work involved.', values: ['Cleaning / Wash', 'Impression / Register / Print Quality', 'Make Ready'] },
  { title: 'Radius wording or code', copy: 'Use the exact operator wording or a raw status code when you have it.', values: ['Plates: Wash', 'Run Production', '150'] },
]

function resultTypeLabel(result: ClassificationSearchResult): string {
  if (result.needsClassification) return 'Needs Classification'
  if (result.type === 'exact_status') return 'Exact Radius status'
  if (result.type === 'family') return 'Process Family'
  return 'Operational Group'
}

function identityKey(result: ClassificationSearchResult): string { return result.id.replace(/^[^:]+:/, '') }

function launchUrl(pathname: string, parameters: Record<string, string | undefined>, preservePress = true): string {
  const current = typeof window === 'undefined' ? new URL('http://process-intelligence.local/intelligent-search') : new URL(window.location.href)
  const next = new URLSearchParams()
  for (const key of ['fromUtc', 'toUtc', 'preset', 'press']) {
    if (key === 'press' && !preservePress) continue
    const value = current.searchParams.get(key)
    if (value) next.set(key, value)
  }
  Object.entries(parameters).forEach(([key, value]) => { if (value !== undefined) next.set(key, value) })
  return `${pathname}?${next}`
}

function activityTarget(result: ClassificationSearchResult): { level: ActivityLevel; key: string } | undefined {
  if (result.type === 'group' && result.groups[0]) return { level: 'operational_group', key: result.groups[0].key }
  if (result.type === 'family' && result.family) return { level: 'process_family', key: result.family.key }
  if (result.type === 'exact_status') return { level: 'exact_status', key: identityKey(result) }
  return undefined
}

function pressLabel(pressKey?: RadiusPressKey) { return SEARCH_PRESSES.find(({ key }) => key === pressKey)?.label }

function ResultActions({ result, pressKey }: { result: ClassificationSearchResult; pressKey?: RadiusPressKey }) {
  const target = activityTarget(result)
  if (!target) return null
  const patternConditions = JSON.stringify([{ level: target.level, key: target.key, label: result.title }])
  const admin = launchUrl('/administration/state-classification', { identity: result.type === 'exact_status' ? identityKey(result) : undefined, group: result.type === 'group' ? result.groups[0]?.key : undefined, family: result.type === 'family' ? result.family?.key : undefined }, false)
  if (result.needsClassification) return <div className="search-result-actions"><a href={admin}>Open exact identity in Classification Admin</a></div>
  return <div className="search-result-actions">
    <a href={launchUrl('/operational-analysis', { press: pressKey, activityLevel: target.level, activityKey: target.key, operationalGroupKey: result.type === 'family' && result.groups.length === 1 ? result.groups[0]?.key : undefined })}>Analyze{pressKey ? ` on ${pressLabel(pressKey)}` : ' this activity'}</a>
    <a href={launchUrl('/patterns-episodes', { press: pressKey, patternTab: 'builder', patternMode: 'in_order', patternConditions })}>Start a pattern with this step</a>
    <a href={admin}>{result.type === 'family' ? 'See related mappings' : 'See how it is classified'}</a>
  </div>
}

export function IntelligentSearchResults({ response, loading = false, error, pressKey }: { response?: ClassificationSearchResponse; loading?: boolean; error?: string; pressKey?: RadiusPressKey }) {
  if (loading) return <section className="search-state" role="status"><i aria-hidden="true" /><strong>Searching the operating language</strong><span>Looking across work types, specific work, and exact Radius statuses.</span></section>
  if (error) return <section className="search-state search-state--error" role="alert"><strong>Search unavailable</strong><span>{error}</span></section>
  if (!response) return <section className="search-state search-state--ready"><strong>Ready when you are</strong><span>Choose an example above or search using any work name, Radius wording, or status code you know.</span></section>
  return <section className="intelligent-search-results" aria-live="polite">
    <header><div><span>Results for “{response.query}”</span><strong>{response.results.length} match{response.results.length === 1 ? '' : 'es'}</strong></div><div className="search-result-scope"><b>{pressKey ? pressLabel(pressKey) : 'All Presses'}</b><small>{pressKey ? 'Actions will open with this press selected' : 'Choose a press above to focus the next page'}</small></div></header>
    {response.observedIdentityStatus === 'unavailable' && <p className="search-coverage-note">Published taxonomy results are available. Live observed-identity enrichment is temporarily unavailable.</p>}
    {response.observedIdentityStatus === 'cached' && <p className="search-coverage-note">Results include the last successful observed-identity snapshot.</p>}
    {response.results.length === 0 ? <div className="search-no-results"><strong>No classification matches</strong><span>Try fewer words, an exact Radius description, event type, or status code.</span></div> : <ol className="search-result-list">{response.results.map((result) => <li key={result.id}><article className={`search-result-card search-result-card--${result.type}`} tabIndex={0}>
      <div className="search-result-heading"><div><span>{resultTypeLabel(result)}</span><h2>{result.title}</h2></div><small>{result.matchReason}</small></div>
      {result.description && !result.needsClassification && <p>{result.description}</p>}
      {result.type === 'exact_status' && <dl className="search-result-evidence"><div><dt>Radius recorded</dt><dd>{result.eventType || 'Empty'} / {result.statusCode || 'No code'} / {result.statusDescription || '(empty)'}</dd></div>{result.groups[0] && <div><dt>Classified as Group</dt><dd>{result.groups[0].displayName}</dd></div>}{result.family && <div><dt>Process Family</dt><dd>{result.family.displayName}</dd></div>}<div><dt>Classification</dt><dd>{result.needsClassification ? 'Needs Classification' : `Published v${response.publishedVersion}`}</dd></div></dl>}
      {result.type === 'family' && <dl className="search-result-evidence"><div><dt>Used across groups</dt><dd>{result.groups.length ? result.groups.map(({ displayName }) => displayName).join(', ') : 'No published mapping relationship'}</dd></div></dl>}
      {result.type === 'group' && <dl className="search-result-evidence"><div><dt>Stable key</dt><dd>{result.groups[0]?.key}</dd></div></dl>}
      <ResultActions result={result} pressKey={pressKey} />
    </article></li>)}</ol>}
    <footer>Results come from Published Classification v{response.publishedVersion}. Choosing a press focuses the page you open next; it does not hide shared classification matches.</footer>
  </section>
}

function SearchGuide({ onExample, pressKey }: { onExample(value: string): void; pressKey?: RadiusPressKey }) {
  return <section className="intelligent-search-guide" aria-labelledby="search-guide-title">
    <header><div><span className="eyebrow">Start here</span><h2 id="search-guide-title">What are you trying to find?</h2><p>Search helps you find a work term first, then opens the right page with that term already selected.</p></div><a href={launchUrl('/patterns-episodes', { press: pressKey, patternTab: 'discovered' })}>Browse repeated patterns</a></header>
    <div className="search-guide-paths"><article><span>1</span><div><strong>Find the name</strong><p>Search a type of work, specific Process Family, Radius description, or code.</p></div></article><article><span>2</span><div><strong>Choose the investigation</strong><p>Analyze its time, start a three-step pattern, or review how it is classified.</p></div></article><article><span>3</span><div><strong>Keep the press focus</strong><p>{pressKey ? `${pressLabel(pressKey)} will stay selected when you open evidence.` : 'Choose a press below when the question is about one machine.'}</p></div></article></div>
    <details open><summary>Browse search examples <small>click any example to search</small></summary><div className="search-example-groups">{SEARCH_EXAMPLES.map((group) => <article key={group.title}><h3>{group.title}</h3><p>{group.copy}</p><div>{group.values.map((value) => <button type="button" key={value} onClick={() => onExample(value)}>{value}</button>)}</div></article>)}</div></details>
    <details><summary>Which page should I open after searching?</summary><div className="search-destination-guide"><article><strong>Operational Analysis</strong><span>Use this to see when one activity happened and how much time it used.</span></article><article><strong>Patterns &amp; Episodes</strong><span>Use this to add the result as one step in a journey of at least three steps.</span></article><article><strong>Classification</strong><span>Use this to understand why an exact Radius status has its current Group and Family.</span></article></div></details>
  </section>
}

export function IntelligentSearchPage() {
  const initialLocation = typeof window === 'undefined' ? undefined : window.location
  const initialQuery = initialLocation ? new URLSearchParams(initialLocation.search).get('q') ?? '' : ''
  const [query, setQuery] = useState(initialQuery)
  const [pressKey, setPressKey] = useState<RadiusPressKey | undefined>(() => initialLocation ? pressFromLocation(initialLocation.pathname, initialLocation.search) : undefined)
  const [response, setResponse] = useState<ClassificationSearchResponse>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const activeRequest = useRef<AbortController | undefined>(undefined)

  async function runSearch(value: string, updateUrl: boolean) {
    const normalized = value.trim()
    if (!normalized) return
    activeRequest.current?.abort()
    const controller = new AbortController()
    activeRequest.current = controller
    setLoading(true)
    setError(undefined)
    if (updateUrl) {
      const url = new URL(window.location.href)
      url.searchParams.set('q', normalized)
      window.history.pushState({}, '', `${url.pathname}?${url.searchParams}`)
    }
    try { setResponse(await searchClassifications(normalized, 20, controller.signal)) }
    catch { if (!controller.signal.aborted) setError('The published classification could not be searched. Please try again.') }
    finally { if (!controller.signal.aborted) setLoading(false) }
  }

  useEffect(() => {
    if (initialQuery) void runSearch(initialQuery, false)
    const restore = () => {
      const restored = new URLSearchParams(window.location.search).get('q') ?? ''
      setQuery(restored)
      setPressKey(pressFromLocation(window.location.pathname, window.location.search))
      if (restored) void runSearch(restored, false)
      else { activeRequest.current?.abort(); setResponse(undefined); setError(undefined); setLoading(false) }
    }
    window.addEventListener('popstate', restore)
    return () => { activeRequest.current?.abort(); window.removeEventListener('popstate', restore) }
  }, [])

  function submit(event: FormEvent) { event.preventDefault(); void runSearch(query, true) }

  function selectPress(next?: RadiusPressKey) {
    const url = new URL(window.location.href)
    if (next) url.searchParams.set('press', next)
    else url.searchParams.delete('press')
    window.history.pushState({}, '', `${url.pathname}?${url.searchParams}`)
    setPressKey(next)
  }

  function searchExample(value: string) { setQuery(value); void runSearch(value, true) }

  return <div className="intelligent-search-page">
    <section className="intelligent-search-hero"><div><span className="eyebrow">Find a term, then investigate it</span><h1>Intelligent Search</h1><p>Use the words you already know. Search will connect a work type, Process Family, or exact Radius status to the page where you can understand its time, patterns, and classification.</p></div><form className="intelligent-search-form" role="search" onSubmit={submit}><label htmlFor="classification-search">What work, Radius wording, or code are you looking for?</label><div><input id="classification-search" type="search" value={query} maxLength={128} autoComplete="off" onChange={(event) => setQuery(event.target.value)} placeholder="Try Make Ready, Cleaning, Register, or 150…" /><button type="submit" disabled={loading || !query.trim()}>Search</button></div></form></section>
    <SearchGuide onExample={searchExample} pressKey={pressKey} />
    <section className="search-press-scope" aria-labelledby="search-press-title"><div><span className="eyebrow">Optional press focus</span><h2 id="search-press-title">Where do you want to investigate the result?</h2><p>The operating names are shared across presses. This choice keeps one press selected when you open Operational Analysis or start a pattern.</p></div><div role="group" aria-label="Press focus"><button type="button" className={!pressKey ? 'active' : ''} aria-pressed={!pressKey} onClick={() => selectPress(undefined)}>All Presses</button>{SEARCH_PRESSES.map((press) => <button type="button" key={press.key} className={pressKey === press.key ? 'active' : ''} aria-pressed={pressKey === press.key} onClick={() => selectPress(press.key)}>{press.label}</button>)}</div></section>
    <IntelligentSearchResults response={response} loading={loading} error={error} pressKey={pressKey} />
  </div>
}
