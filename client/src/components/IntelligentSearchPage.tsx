import { useState, type FormEvent } from 'react'
import { searchClassifications } from '../api/process-intelligence-api'
import type { ClassificationSearchResponse, ClassificationSearchResult } from '../types/api'

function resultTypeLabel(result: ClassificationSearchResult): string {
  if (result.needsClassification) return 'Needs classification'
  if (result.type === 'exact_status') return 'Exact Radius status'
  if (result.type === 'family') return 'Process family'
  return 'Classification group'
}

export function IntelligentSearchResults({
  response,
  loading = false,
  error,
}: {
  response?: ClassificationSearchResponse
  loading?: boolean
  error?: string
}) {
  if (loading) return <section className="search-state" role="status"><i aria-hidden="true" /><strong>Searching the published classification</strong><span>Matching exact statuses, process families, and operating groups.</span></section>
  if (error) return <section className="search-state search-state--error" role="alert"><strong>Search unavailable</strong><span>{error}</span></section>
  if (!response) return <section className="search-state search-state--ready"><strong>Search the published operating language</strong><span>Try an exact status such as “Make Ready,” a process family, or a broader operating concept.</span></section>
  return <section className="intelligent-search-results" aria-live="polite">
    <header>
      <div><span>Results</span><strong>{response.results.length} match{response.results.length === 1 ? '' : 'es'}</strong></div>
      <div className="search-version">Published classification v{response.publishedVersion}</div>
    </header>
    {response.observedIdentityStatus === 'unavailable' && <p className="search-coverage-note">Published taxonomy results are available. Live observed-identity enrichment is temporarily unavailable.</p>}
    {response.observedIdentityStatus === 'cached' && <p className="search-coverage-note">Results include the last successful observed-identity snapshot.</p>}
    {response.results.length === 0
      ? <div className="search-no-results"><strong>No classification matches</strong><span>Try fewer words, an exact Radius description, event type, or status code.</span></div>
      : <ol className="search-result-list">{response.results.map((result) => <li key={result.id}>
          <article className={`search-result-card search-result-card--${result.type}`} tabIndex={0}>
            <div className="search-result-heading"><div><span>{resultTypeLabel(result)}</span><h2>{result.title}</h2></div><small>{result.matchReason}</small></div>
            {result.description && !result.needsClassification && <p>{result.description}</p>}
            {result.type === 'exact_status' && <dl className="search-result-evidence">
              <div><dt>Event / code</dt><dd>{result.eventType || 'Empty'} / {result.statusCode || 'No code'}</dd></div>
              {result.groups[0] && <div><dt>Group</dt><dd>{result.groups[0].displayName}</dd></div>}
              {result.family && <div><dt>Family</dt><dd>{result.family.displayName}</dd></div>}
              <div><dt>Classification</dt><dd>{result.needsClassification ? 'Needs classification' : `Published v${response.publishedVersion}`}</dd></div>
            </dl>}
            {result.type === 'family' && <dl className="search-result-evidence"><div><dt>Used across groups</dt><dd>{result.groups.length ? result.groups.map(({ displayName }) => displayName).join(', ') : 'No published mapping relationship'}</dd></div></dl>}
            {result.type === 'group' && <dl className="search-result-evidence"><div><dt>Stable key</dt><dd>{result.groups[0]?.key}</dd></div></dl>}
          </article>
        </li>)}</ol>}
  </section>
}

export function IntelligentSearchPage() {
  const [query, setQuery] = useState('')
  const [response, setResponse] = useState<ClassificationSearchResponse>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()

  async function submit(event: FormEvent) {
    event.preventDefault()
    const normalized = query.trim()
    if (!normalized) return
    setLoading(true)
    setError(undefined)
    try { setResponse(await searchClassifications(normalized)) }
    catch { setError('The published classification could not be searched. Please try again.') }
    finally { setLoading(false) }
  }

  return <div className="intelligent-search-page">
    <section className="intelligent-search-hero">
      <div><span className="eyebrow">Deterministic retrieval</span><h1>Intelligent Search</h1><p>Find exact Radius statuses, process families, and the published operating taxonomy. Search retrieves evidence; it never changes a classification.</p></div>
      <form className="intelligent-search-form" role="search" onSubmit={submit}>
        <label htmlFor="classification-search">Search statuses, process families, or operating concepts</label>
        <div><input id="classification-search" type="search" value={query} maxLength={128} autoComplete="off" onChange={(event) => setQuery(event.target.value)} placeholder="Make Ready, Plates: Wash, press problem…" /><button type="submit" disabled={loading || !query.trim()}>Search</button></div>
      </form>
    </section>
    <IntelligentSearchResults response={response} loading={loading} error={error} />
  </div>
}
