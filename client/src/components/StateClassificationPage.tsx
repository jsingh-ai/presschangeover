import { useEffect, useMemo, useState } from 'react'
import {
  createClassificationDraft,
  discardClassificationDraft,
  getClassificationWorkspace,
  publishClassificationDraft,
  updateClassificationGroup,
  updateClassifications,
  validateClassificationDraft,
} from '../api/process-intelligence-api'
import { formatPlantDateTime } from '../time-ranges'
import type { ClassificationValidation, ClassificationWorkspace, MappingConfidence, OperationalGroup, OperationalGroupKey, ProcessFamilyKey, RadiusStateClassification } from '../types/api'

type EffectiveClassification = ClassificationWorkspace['effectiveClassifications'][number]

const icons = ['production', 'changeover', 'process', 'quality', 'waiting', 'fault', 'maintenance', 'unknown']

function rawIdentity(item: Pick<RadiusStateClassification, 'eventType' | 'statusCode' | 'statusDescription'>) {
  return `${item.eventType || '—'} / ${item.statusCode ?? '—'} / ${item.statusDescription || '(empty description)'}`
}

function dateLabel(value: string | null) { return value ? `${formatPlantDateTime(value)} CT` : 'Never observed in current catalog' }

export function StateClassificationPage() {
  const [workspace, setWorkspace] = useState<ClassificationWorkspace>()
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [validation, setValidation] = useState<ClassificationValidation>()
  const [search, setSearch] = useState('')
  const [eventType, setEventType] = useState('ALL')
  const [family, setFamily] = useState('ALL')
  const [mappingFilter, setMappingFilter] = useState('ALL')
  const [reviewFilter, setReviewFilter] = useState('ALL')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [inspected, setInspected] = useState<string>()
  const [bulkGroup, setBulkGroup] = useState<OperationalGroupKey>('ADMIN_UNKNOWN')
  const [editedGroup, setEditedGroup] = useState<OperationalGroup>()

  async function refresh(quiet = false) {
    if (!quiet) setLoading(true)
    try { setWorkspace(await getClassificationWorkspace()); setError(undefined) }
    catch { setError('State classifications could not be loaded. The Radius data source or application classification store may be unavailable.') }
    finally { if (!quiet) setLoading(false) }
  }

  useEffect(() => { void refresh() }, [])

  async function mutate(action: () => Promise<unknown>, success: string) {
    setBusy(true); setError(undefined); setNotice(undefined)
    try { await action(); await refresh(true); setNotice(success) }
    catch (caught) {
      const status = typeof caught === 'object' && caught && 'status' in caught ? Number((caught as { status: number }).status) : 0
      setError(status === 409 ? 'This draft changed in another session. The latest version has been reloaded; review it before trying again.' : status === 403 ? 'Editing is disabled for this session. Classification changes require an authenticated administrator.' : 'The classification change could not be saved. Existing published mappings remain active.')
      await refresh(true)
    } finally { setBusy(false) }
  }

  const filtered = useMemo(() => {
    if (!workspace) return []
    const term = search.trim().toLowerCase()
    return workspace.effectiveClassifications.filter((item) => {
      if (term && !`${item.eventType} ${item.statusCode ?? ''} ${item.statusDescription} ${item.displayLabel ?? ''}`.toLowerCase().includes(term)) return false
      if (eventType !== 'ALL' && item.eventType !== eventType) return false
      if (family !== 'ALL' && item.processFamilyKey !== family) return false
      if (mappingFilter === 'UNMAPPED' && !item.isFallback) return false
      if (mappingFilter === 'MAPPED' && item.isFallback) return false
      if (reviewFilter === 'REVIEW' && !item.needsReview) return false
      if (reviewFilter === 'CLEAR' && item.needsReview) return false
      return true
    })
  }, [workspace, search, eventType, family, mappingFilter, reviewFilter])

  const grouped = useMemo(() => new Map((workspace?.effectiveGroups ?? []).map((group) => [group.key, filtered.filter((item) => item.operationalGroupKey === group.key)])), [workspace, filtered])
  const inspector = workspace?.effectiveClassifications.find(({ identity }) => identity === inspected)
  const eventTypes = [...new Set((workspace?.effectiveClassifications ?? []).map(({ eventType: value }) => value))].sort()

  async function move(identities: EffectiveClassification[], groupKey: OperationalGroupKey) {
    if (!workspace || !identities.length) return
    await mutate(() => updateClassifications(workspace.draft?.revision ?? null, identities.map(({ eventType: type, statusCode, statusDescription }) => ({ eventType: type, statusCode, statusDescription })), { operationalGroupKey: groupKey, needsReview: false }), `Moved ${identities.length} exact Radius ${identities.length === 1 ? 'identity' : 'identities'} to the draft.`)
    setSelected(new Set())
  }

  async function saveInspector(form: HTMLFormElement) {
    if (!workspace || !inspector) return
    const data = new FormData(form)
    await mutate(() => updateClassifications(workspace.draft?.revision ?? null, [{ eventType: inspector.eventType, statusCode: inspector.statusCode, statusDescription: inspector.statusDescription }], {
      operationalGroupKey: String(data.get('group')) as OperationalGroupKey,
      processFamilyKey: String(data.get('family')) as ProcessFamilyKey,
      displayLabel: String(data.get('displayLabel') ?? ''), explanation: String(data.get('explanation') ?? ''),
      confidence: String(data.get('confidence')) as MappingConfidence, needsReview: data.get('needsReview') === 'on',
      defaultTimelineVisibility: data.get('defaultTimelineVisibility') === 'on', obsolete: data.get('obsolete') === 'on',
    }), 'Classification metadata saved to the draft.')
  }

  if (loading) return <section className="classification-page" aria-busy="true"><header className="classification-hero classification-skeleton"><span /><span /><span /></header><div className="classification-skeleton-grid">{Array.from({ length: 8 }, (_, index) => <span key={index} />)}</div></section>
  if (!workspace) return <section className="panel unavailable-panel"><h1>State Classification unavailable</h1><p>{error}</p><button type="button" onClick={() => void refresh()}>Try again</button></section>

  return <div className="classification-page">
    <header className="classification-hero">
      <div><p className="eyebrow">Administration · Radius semantics</p><h1>State Classification</h1><p>Manage how exact operator-entered Radius identities are presented as stable operational groups. Raw Radius evidence always remains available.</p></div>
      <div className="classification-actions">
        <button type="button" disabled={!workspace.canEdit || busy} onClick={() => void mutate(() => createClassificationDraft(workspace.published.version), 'Draft ready for editing.')}>Save Draft</button>
        <button type="button" className="secondary-button" disabled={!workspace.canEdit || !workspace.draft || busy} onClick={() => workspace.draft && window.confirm('Discard every unpublished classification change?') && void mutate(() => discardClassificationDraft(workspace.draft!.revision), 'Draft discarded; published classifications are unchanged.')}>Discard</button>
        <button type="button" className="primary-action" disabled={!workspace.canEdit || !workspace.draft || busy} onClick={() => workspace.draft && window.confirm(`Publish classification version ${workspace.published.version + 1}?`) && void mutate(() => publishClassificationDraft(workspace.draft!.revision), 'Classification draft published atomically.')}>Publish</button>
      </div>
      <dl className="classification-summary">
        <div><dt>Published version</dt><dd>v{workspace.published.version}</dd></div>
        <div><dt>Last publication</dt><dd>{workspace.published.publishedAtUtc ? dateLabel(workspace.published.publishedAtUtc) : 'Seed baseline'}<small>{workspace.published.publishedBy ?? 'System seed'}</small></dd></div>
        <div><dt>Review needed</dt><dd>{workspace.reviewRequiredCount}<small>{workspace.unmappedCount} unmapped fallback</small></dd></div>
        <div><dt>Draft</dt><dd>{workspace.draft ? `Revision ${workspace.draft.revision}` : 'No active draft'}<small>{workspace.draft ? `Based on v${workspace.draft.baseVersion}` : `${workspace.persistence} store`}</small></dd></div>
      </dl>
    </header>

    {!workspace.canEdit && <div className="classification-permission" role="status"><strong>Read-only administration view</strong><span>Publishing requires an authenticated administrator supplied by the trusted application proxy. Backend authorization remains enforced.</span></div>}
    {error && <div className="scope-progress scope-progress--error" role="alert">{error}</div>}
    {notice && <div className="scope-progress scope-progress--success" role="status">{notice}</div>}

    <section className="panel group-manager" aria-labelledby="group-manager-title">
      <div className="section-heading"><div><p className="eyebrow">Presentation controls</p><h2 id="group-manager-title">Operational groups</h2><p className="section-description">Stable keys never change. Names, descriptions, accessible colors, icons, and display order are versioned presentation settings.</p></div></div>
      <div className="group-manager-layout">
        <div className="group-selector" role="list">{workspace.effectiveGroups.map((group) => <button key={group.key} type="button" role="listitem" className={editedGroup?.key === group.key ? 'selected' : ''} onClick={() => setEditedGroup({ ...group })}><i style={{ '--group-light': group.lightColor, '--group-dark': group.darkColor } as React.CSSProperties} /><span><strong>{group.displayName}</strong><small>{group.key}</small></span></button>)}</div>
        {editedGroup ? <form className="group-editor" onSubmit={(event) => { event.preventDefault(); if (!workspace.canEdit) return; void mutate(() => updateClassificationGroup(editedGroup.key, workspace.draft?.revision ?? null, editedGroup), `${editedGroup.displayName} presentation saved to the draft.`) }}>
          <label>Stable key<input value={editedGroup.key} readOnly /></label><label>Display name<input value={editedGroup.displayName} onChange={(event) => setEditedGroup({ ...editedGroup, displayName: event.target.value })} /></label>
          <label className="group-description">Description<textarea value={editedGroup.description} onChange={(event) => setEditedGroup({ ...editedGroup, description: event.target.value })} /></label>
          <label>Light color<span className="color-control"><input type="color" value={editedGroup.lightColor} onChange={(event) => setEditedGroup({ ...editedGroup, lightColor: event.target.value })} /><code>{editedGroup.lightColor}</code></span></label>
          <label>Dark color<span className="color-control"><input type="color" value={editedGroup.darkColor} onChange={(event) => setEditedGroup({ ...editedGroup, darkColor: event.target.value })} /><code>{editedGroup.darkColor}</code></span></label>
          <label>Icon<select value={editedGroup.icon} onChange={(event) => setEditedGroup({ ...editedGroup, icon: event.target.value })}>{icons.map((icon) => <option key={icon}>{icon}</option>)}</select></label>
          <label>Order<input type="number" value={editedGroup.sortOrder} onChange={(event) => setEditedGroup({ ...editedGroup, sortOrder: Number(event.target.value) })} /></label>
          <div className="group-editor-actions"><button type="submit" disabled={!workspace.canEdit || busy}>Save presentation</button><button type="button" className="text-button" disabled={!workspace.canEdit || busy} onClick={() => void mutate(() => updateClassificationGroup(editedGroup.key, workspace.draft?.revision ?? null, { restoreDefault: true }), 'Seeded presentation defaults restored in the draft.')}>Restore defaults</button></div>
        </form> : <p className="empty-state">Select an operational group to edit its presentation.</p>}
      </div>
    </section>

    <section className="classification-board" aria-labelledby="classification-board-title">
      <div className="classification-board-header"><div><p className="eyebrow">Exact identity mapping</p><h2 id="classification-board-title">Classification board</h2><p>{filtered.length} of {workspace.effectiveClassifications.length} exact Radius identities shown</p></div>
        <div className="classification-filters"><label>Search<input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Status, code, or label" /></label><label>Event type<select value={eventType} onChange={(event) => setEventType(event.target.value)}><option value="ALL">All types</option>{eventTypes.map((type) => <option key={type} value={type}>{type || 'Empty'}</option>)}</select></label><label>Process family<select value={family} onChange={(event) => setFamily(event.target.value)}><option value="ALL">All families</option>{workspace.families.map((item) => <option key={item.key} value={item.key}>{item.displayName}</option>)}</select></label><label>Mapping<select value={mappingFilter} onChange={(event) => setMappingFilter(event.target.value)}><option value="ALL">Mapped & unmapped</option><option value="MAPPED">Mapped</option><option value="UNMAPPED">Unmapped fallback</option></select></label><label>Review<select value={reviewFilter} onChange={(event) => setReviewFilter(event.target.value)}><option value="ALL">Any review state</option><option value="REVIEW">Needs review</option><option value="CLEAR">Reviewed</option></select></label></div>
      </div>
      <div className="classification-bulk" aria-live="polite"><strong>{selected.size} selected</strong><select aria-label="Bulk destination group" value={bulkGroup} onChange={(event) => setBulkGroup(event.target.value as OperationalGroupKey)}>{workspace.effectiveGroups.map((group) => <option key={group.key} value={group.key}>{group.displayName}</option>)}</select><button type="button" disabled={!workspace.canEdit || selected.size === 0 || busy} onClick={() => void move(workspace.effectiveClassifications.filter(({ identity }) => selected.has(identity)), bulkGroup)}>Move selected</button><button type="button" className="text-button" disabled={selected.size === 0} onClick={() => setSelected(new Set())}>Clear selection</button></div>
      <div className="classification-columns">{workspace.effectiveGroups.map((group) => <section key={group.key} className="classification-column" style={{ '--group-light': group.lightColor, '--group-dark': group.darkColor } as React.CSSProperties} onDragOver={(event) => workspace.canEdit && event.preventDefault()} onDrop={(event) => { event.preventDefault(); const identity = event.dataTransfer.getData('text/plain'); const candidates = selected.has(identity) ? workspace.effectiveClassifications.filter((item) => selected.has(item.identity)) : workspace.effectiveClassifications.filter((item) => item.identity === identity); void move(candidates, group.key) }}>
        <header><i aria-hidden="true" /><div><h3>{group.displayName}</h3><small>{grouped.get(group.key)?.length ?? 0} shown</small></div></header>
        <div className="classification-card-list">{(grouped.get(group.key) ?? []).map((item) => <article key={item.identity} className={`classification-card ${item.needsReview || item.isFallback ? 'needs-review' : ''} ${selected.has(item.identity) ? 'selected' : ''}`} draggable={workspace.canEdit} onDragStart={(event) => event.dataTransfer.setData('text/plain', item.identity)}>
          <label className="classification-select"><input type="checkbox" checked={selected.has(item.identity)} onChange={() => setSelected((current) => { const next = new Set(current); if (next.has(item.identity)) next.delete(item.identity); else next.add(item.identity); return next })} /><span className="sr-only">Select {rawIdentity(item)}</span></label>
          <button type="button" className="classification-card-main" onClick={() => setInspected(item.identity)}><span className="identity-code"><b>{item.eventType || '—'}</b><b>{item.statusCode ?? '—'}</b></span><strong>{item.displayLabel || item.statusDescription || '(empty description)'}</strong><small>{item.processFamilyKey.replaceAll('_', ' ')}</small><span className="classification-card-meta"><em>{item.eventCount.toLocaleString()} events</em><em>{item.lastSeenUtc ? dateLabel(item.lastSeenUtc) : 'Not recently observed'}</em></span>{(item.needsReview || item.isFallback) && <span className="review-flag">{item.isFallback ? 'Unmapped fallback' : 'Needs review'}</span>}</button>
          <label className="card-move">Move to group<select value={item.operationalGroupKey} disabled={!workspace.canEdit || busy} onChange={(event) => void move([item], event.target.value as OperationalGroupKey)}>{workspace.effectiveGroups.map((candidate) => <option key={candidate.key} value={candidate.key}>{candidate.displayName}</option>)}</select></label>
        </article>)}{(grouped.get(group.key)?.length ?? 0) === 0 && <p className="classification-empty">No matching identities</p>}</div>
      </section>)}</div>
    </section>

    {inspector && <div className="drawer-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setInspected(undefined)}><aside className="investigation-side-panel classification-inspector" role="dialog" aria-modal="true" aria-labelledby="classification-inspector-title"><header className="drawer-header"><div><p className="eyebrow">Exact Radius evidence</p><h2 id="classification-inspector-title">Classification inspector</h2></div><button type="button" className="drawer-close" onClick={() => setInspected(undefined)} aria-label="Close classification inspector">×</button></header>
      <form onSubmit={(event) => { event.preventDefault(); void saveInspector(event.currentTarget) }}>
        <section className="drawer-section"><h3>Read-only source identity</h3><dl className="compact-facts"><div><dt>Event type</dt><dd>{inspector.eventType || '—'}</dd></div><div><dt>Status code</dt><dd>{inspector.statusCode ?? '—'}</dd></div><div><dt>Exact description</dt><dd>{inspector.statusDescription || '(empty)'}</dd></div><div><dt>Observed records</dt><dd>{inspector.eventCount.toLocaleString()}</dd></div><div><dt>Last seen</dt><dd>{dateLabel(inspector.lastSeenUtc)}</dd></div></dl></section>
        <section className="drawer-section inspector-fields"><h3>Draft classification</h3><label>Operational group<select name="group" defaultValue={inspector.operationalGroupKey}>{workspace.effectiveGroups.map((group) => <option key={group.key} value={group.key}>{group.displayName}</option>)}</select></label><label>Process family<select name="family" defaultValue={inspector.processFamilyKey}>{workspace.families.map((item) => <option key={item.key} value={item.key}>{item.displayName}</option>)}</select></label><label>Display label<input name="displayLabel" defaultValue={inspector.displayLabel ?? ''} /></label><label>Internal explanation<textarea name="explanation" defaultValue={inspector.explanation} /></label><label>Mapping confidence<select name="confidence" defaultValue={inspector.confidence}><option>HIGH</option><option>MEDIUM</option><option>LOW</option></select></label><label className="check-field"><input name="needsReview" type="checkbox" defaultChecked={inspector.needsReview} />Needs review</label><label className="check-field"><input name="defaultTimelineVisibility" type="checkbox" defaultChecked={inspector.defaultTimelineVisibility} />Visible on timeline by default</label><label className="check-field"><input name="obsolete" type="checkbox" defaultChecked={inspector.obsolete} />Obsolete source state</label></section>
        <footer className="drawer-actions"><button type="submit" disabled={!workspace.canEdit || busy}>Save to draft</button><button type="button" className="secondary-button" onClick={() => setInspected(undefined)}>Close</button></footer>
      </form>
    </aside></div>}

    <section className="panel classification-publish-review"><div className="section-heading"><div><p className="eyebrow">Version control</p><h2>Validate and publish</h2></div><button type="button" disabled={!workspace.draft || busy} onClick={() => void (async () => { setBusy(true); try { setValidation(await validateClassificationDraft()) } catch { setError('Draft validation could not be completed.') } finally { setBusy(false) } })()}>Validate draft</button></div>{validation && <div className={`validation-summary ${validation.valid ? 'valid' : 'invalid'}`}><strong>{validation.valid ? 'Draft is structurally valid' : 'Draft requires correction'}</strong><span>{validation.mappedCount} observed identities mapped · {validation.fallbackCount} fallback · {validation.reviewRequiredCount} review needed</span>{[...validation.errors, ...validation.warnings].map((message) => <p key={message}>{message}</p>)}</div>}<div className="classification-history"><div><h3>Recent versions</h3>{workspace.versions.length ? <ul>{workspace.versions.slice(0, 5).map((version) => <li key={version.version}><strong>v{version.version}</strong><span>{dateLabel(version.publishedAtUtc)}</span><small>{version.publishedBy} · {version.changeCount} changes</small></li>)}</ul> : <p>No administrator publications yet.</p>}</div><div><h3>Recent audit activity</h3>{workspace.audit.length ? <ul>{workspace.audit.slice(0, 6).map((entry) => <li key={entry.id}><strong>{entry.summary}</strong><span>{entry.actor}</span><small>{dateLabel(entry.atUtc)}</small></li>)}</ul> : <p>No draft activity yet.</p>}</div></div></section>
  </div>
}
