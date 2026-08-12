import { useEffect, useRef, useState, type FormEvent } from 'react'
import { searchClassifications } from '../api/process-intelligence-api'
import type { ActivityLevel, ClassificationSearchResponse, ClassificationSearchResult } from '../types/api'

function resultTypeLabel(result: ClassificationSearchResult): string {
  if (result.needsClassification) return 'Needs Classification'
  if (result.type === 'exact_status') return 'Exact Radius status'
  if (result.type === 'family') return 'Process Family'
  return 'Operational Group'
}

function identityKey(result: ClassificationSearchResult): string { return result.id.replace(/^[^:]+:/, '') }

function launchUrl(pathname: string, parameters: Record<string, string | undefined>): string {
  const current = typeof window === 'undefined' ? new URL('http://process-intelligence.local/intelligent-search') : new URL(window.location.href)
  const next = new URLSearchParams()
  for (const key of ['fromUtc', 'toUtc', 'preset', 'press']) {
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

function ResultActions({ result }: { result: ClassificationSearchResult }) {
  const target = activityTarget(result)
  if (!target) return null
  const patternConditions = JSON.stringify([{ level: target.level, key: target.key, label: result.title }])
  const admin = launchUrl('/administration/state-classification', { identity: result.type === 'exact_status' ? identityKey(result) : undefined, group: result.type === 'group' ? result.groups[0]?.key : undefined, family: result.type === 'family' ? result.family?.key : undefined })
  if (result.needsClassification) return <div className="search-result-actions"><a href={admin}>Open exact identity in Classification Admin</a></div>
  return <div className="search-result-actions">
    <a href={launchUrl('/operational-analysis', { activityLevel: target.level, activityKey: target.key })}>Analyze Activity</a>
    <a href={launchUrl('/patterns-episodes', { patternTab: 'builder', patternMode: 'contains_all', patternConditions })}>{result.type === 'exact_status' ? 'Find Runs' : 'Find Runs Containing This'}</a>
    <a href={admin}>{result.type === 'family' ? 'View related mappings' : result.type === 'group' ? 'View Classification' : 'View Mapping'}</a>
  </div>
}

export function IntelligentSearchResults({ response, loading = false, error }: { response?: ClassificationSearchResponse; loading?: boolean; error?: string }) {
  if (loading) return <section className="search-state" role="status"><i aria-hidden="true" /><strong>Searching the published classification</strong><span>Matching exact statuses, Process Families, and Operational Groups.</span></section>
  if (error) return <section className="search-state search-state--error" role="alert"><strong>Search unavailable</strong><span>{error}</span></section>
  if (!response) return <section className="search-state search-state--ready"><strong>Search the published operating language</strong><span>Try an exact status such as “Make Ready,” a Process Family, or an Operational Group.</span></section>
  return <section className="intelligent-search-results" aria-live="polite">
    <header><div><span>Results</span><strong>{response.results.length} match{response.results.length === 1 ? '' : 'es'}</strong></div><div className="search-version">Published Classification v{response.publishedVersion}</div></header>
    {response.observedIdentityStatus === 'unavailable' && <p className="search-coverage-note">Published taxonomy results are available. Live observed-identity enrichment is temporarily unavailable.</p>}
    {response.observedIdentityStatus === 'cached' && <p className="search-coverage-note">Results include the last successful observed-identity snapshot.</p>}
    {response.results.length === 0 ? <div className="search-no-results"><strong>No classification matches</strong><span>Try fewer words, an exact Radius description, event type, or status code.</span></div> : <ol className="search-result-list">{response.results.map((result) => <li key={result.id}><article className={`search-result-card search-result-card--${result.type}`} tabIndex={0}>
      <div className="search-result-heading"><div><span>{resultTypeLabel(result)}</span><h2>{result.title}</h2></div><small>{result.matchReason}</small></div>
      {result.description && !result.needsClassification && <p>{result.description}</p>}
      {result.type === 'exact_status' && <dl className="search-result-evidence"><div><dt>Radius recorded</dt><dd>{result.eventType || 'Empty'} / {result.statusCode || 'No code'} / {result.statusDescription || '(empty)'}</dd></div>{result.groups[0] && <div><dt>Classified as Group</dt><dd>{result.groups[0].displayName}</dd></div>}{result.family && <div><dt>Process Family</dt><dd>{result.family.displayName}</dd></div>}<div><dt>Classification</dt><dd>{result.needsClassification ? 'Needs Classification' : `Published v${response.publishedVersion}`}</dd></div></dl>}
      {result.type === 'family' && <dl className="search-result-evidence"><div><dt>Used across groups</dt><dd>{result.groups.length ? result.groups.map(({ displayName }) => displayName).join(', ') : 'No published mapping relationship'}</dd></div></dl>}
      {result.type === 'group' && <dl className="search-result-evidence"><div><dt>Stable key</dt><dd>{result.groups[0]?.key}</dd></div></dl>}
      <ResultActions result={result} />
    </article></li>)}</ol>}
  </section>
}

export function IntelligentSearchPage() {
  const initialQuery = typeof window === 'undefined' ? '' : new URLSearchParams(window.location.search).get('q') ?? ''
  const [query, setQuery] = useState(initialQuery)
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
    return () => activeRequest.current?.abort()
  }, [])

  function submit(event: FormEvent) { event.preventDefault(); void runSearch(query, true) }

  return <div className="intelligent-search-page"><section className="intelligent-search-hero"><div><span className="eyebrow">Deterministic retrieval and launch</span><h1>Intelligent Search</h1><p>Find exact Radius identities and published semantic mappings, then launch the same evidence in Operational Analysis, Patterns, or Classification Admin. Search never changes a classification.</p></div><form className="intelligent-search-form" role="search" onSubmit={submit}><label htmlFor="classification-search">Search statuses, Process Families, or Operational Groups</label><div><input id="classification-search" type="search" value={query} maxLength={128} autoComplete="off" onChange={(event) => setQuery(event.target.value)} placeholder="Make Ready, Plates: Wash, press problem…" /><button type="submit" disabled={loading || !query.trim()}>Search</button></div></form></section><IntelligentSearchResults response={response} loading={loading} error={error} /></div>
}
