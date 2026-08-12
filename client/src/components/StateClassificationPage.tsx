import { useCallback, useEffect, useMemo, useState } from 'react'
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
import type {
  ClassificationValidation,
  ClassificationWorkspace,
  MappingConfidence,
  OperationalGroup,
  OperationalGroupKey,
  ProcessFamilyKey,
  RadiusStateClassification,
} from '../types/api'
import { EvidenceDrawerShell } from './EvidenceDrawerShell'

type EffectiveClassification = ClassificationWorkspace['effectiveClassifications'][number]

const icons = ['production', 'changeover', 'process', 'quality', 'waiting', 'fault', 'maintenance', 'unknown']

function rawIdentity(item: Pick<RadiusStateClassification, 'eventType' | 'statusCode' | 'statusDescription'>) {
  return `${item.eventType || '—'} / ${item.statusCode ?? '—'} / ${item.statusDescription || '(empty description)'}`
}

function dateLabel(value: string | null) {
  return value ? `${formatPlantDateTime(value)} CT` : 'Not observed in the current catalog'
}

function actorLabel(workspace: ClassificationWorkspace) {
  if (workspace.canEdit) return 'Application editor'
  return 'Writable store unavailable'
}

export function ClassificationWorkflow({
  workspace,
  busy,
  validation,
  validatedRevision,
  onStartDraft,
  onDiscard,
  onValidate,
  onPublish,
}: {
  workspace: ClassificationWorkspace
  busy: boolean
  validation?: ClassificationValidation
  validatedRevision?: number
  onStartDraft(): void
  onDiscard(): void
  onValidate(): void
  onPublish(): void
}) {
  const draft = workspace.draft
  const validationIsCurrent = Boolean(validation?.valid && draft && validatedRevision === draft.revision)
  const nextVersion = workspace.published.version + 1

  return <section className="classification-workflow" aria-labelledby="classification-workflow-title">
    <div className="classification-section-heading">
      <div>
        <p className="eyebrow">Controlled publication</p>
        <h2 id="classification-workflow-title">Draft → validate → publish</h2>
        <p>Edits save to one private draft. Only a validated publication becomes active across ProcessIntelligence.</p>
      </div>
      <span className="classification-live-version"><i aria-hidden="true" />Published v{workspace.published.version} is live</span>
    </div>

    <div className="classification-workflow-steps">
      <article className="classification-workflow-step is-complete">
        <span className="classification-step-number">1</span>
        <div><small>Active configuration</small><strong>Published v{workspace.published.version}</strong><p>{workspace.published.publishedAtUtc ? dateLabel(workspace.published.publishedAtUtc) : 'Seed baseline'} · {workspace.published.publishedBy ?? 'System seed'}</p></div>
      </article>
      <article className={`classification-workflow-step ${draft ? 'is-current' : ''}`}>
        <span className="classification-step-number">2</span>
        <div><small>Working copy</small><strong>{draft ? `Draft revision ${draft.revision}` : 'No active draft'}</strong><p>{draft ? `${draft.changes.length} recorded change${draft.changes.length === 1 ? '' : 's'} · not live` : 'Moving a state can start the draft automatically.'}</p></div>
        <div className="classification-step-actions">
          {!draft && <button type="button" disabled={!workspace.canEdit || busy} onClick={onStartDraft}>Start draft</button>}
          {draft && <button type="button" className="secondary-button" disabled={!workspace.canEdit || busy} onClick={onDiscard}>Discard draft</button>}
        </div>
      </article>
      <article className={`classification-workflow-step ${draft && !validationIsCurrent ? 'is-next' : validationIsCurrent ? 'is-complete' : ''}`}>
        <span className="classification-step-number">3</span>
        <div><small>Verification</small><strong>{validationIsCurrent ? 'Current draft validated' : 'Validate draft'}</strong><p>{validationIsCurrent ? `${validation!.mappedCount} observed identities mapped · ${validation!.fallbackCount} fallback` : 'Validation must match the latest draft revision.'}</p></div>
        <div className="classification-step-actions"><button type="button" disabled={!workspace.canEdit || !draft || busy} onClick={onValidate}>{validationIsCurrent ? 'Validate again' : 'Validate draft'}</button></div>
      </article>
      <article className={`classification-workflow-step ${validationIsCurrent ? 'is-next' : ''}`}>
        <span className="classification-step-number">4</span>
        <div><small>New live version</small><strong>Publish v{nextVersion}</strong><p>Publication is atomic. Published v{workspace.published.version} stays live until this succeeds.</p></div>
        <div className="classification-step-actions"><button type="button" className="primary-action" disabled={!workspace.canEdit || !draft || !validationIsCurrent || busy} onClick={onPublish}>Publish v{nextVersion}</button></div>
      </article>
    </div>

    {validation && <div className={`classification-validation ${validation.valid ? 'is-valid' : 'is-invalid'}`} role="status">
      <strong>{validation.valid ? 'Draft is structurally valid' : 'Draft requires correction'}</strong>
      <span>{validation.mappedCount} mapped · {validation.fallbackCount} fallback · {validation.reviewRequiredCount} review needed</span>
      {[...validation.errors, ...validation.warnings].map((message) => <p key={message}>{message}</p>)}
    </div>}
  </section>
}

export function ClassificationStateCard({
  item,
  groups,
  canEdit,
  busy,
  selected,
  onToggle,
  onInspect,
  onMove,
}: {
  item: EffectiveClassification
  groups: OperationalGroup[]
  canEdit: boolean
  busy: boolean
  selected: boolean
  onToggle(): void
  onInspect(): void
  onMove(groupKey: OperationalGroupKey): void
}) {
  return <article className={`classification-card classification-admin-card ${item.needsReview || item.isFallback ? 'needs-review' : ''} ${selected ? 'selected' : ''}`}>
    <label className="classification-admin-select">
      <input type="checkbox" checked={selected} onChange={onToggle} />
      <span className="sr-only">Select {rawIdentity(item)}</span>
    </label>
    <button type="button" className="classification-admin-card-main" onClick={onInspect}>
      <span className="classification-admin-identity"><b>{item.eventType || '—'}</b><b>{item.statusCode ?? '—'}</b></span>
      <span className="classification-admin-card-copy">
        <strong>{item.displayLabel || item.statusDescription || '(empty description)'}</strong>
        <small>{rawIdentity(item)}</small>
      </span>
      <span className="classification-admin-card-facts">
        <em>{item.processFamilyKey.replaceAll('_', ' ')}</em>
        <em>{item.eventCount.toLocaleString()} events</em>
        {(item.needsReview || item.isFallback) && <em className="review-flag">{item.isFallback ? 'Needs classification' : 'Needs review'}</em>}
      </span>
    </button>
    <label className="classification-admin-move">
      <span>{canEdit ? 'Move to category' : 'Category locked'}</span>
      <select
        aria-label={`Move ${rawIdentity(item)} to category`}
        value={item.operationalGroupKey}
        disabled={!canEdit || busy}
        onChange={(event) => onMove(event.target.value as OperationalGroupKey)}
      >
        {groups.map((group) => <option key={group.key} value={group.key}>{group.displayName}</option>)}
      </select>
      {!canEdit && <small>Writable application store required</small>}
    </label>
  </article>
}

export function StateClassificationPage() {
  const [workspace, setWorkspace] = useState<ClassificationWorkspace>()
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [validation, setValidation] = useState<ClassificationValidation>()
  const [validatedRevision, setValidatedRevision] = useState<number>()
  const [search, setSearch] = useState('')
  const [eventType, setEventType] = useState('ALL')
  const [family, setFamily] = useState('ALL')
  const [mappingFilter, setMappingFilter] = useState('ALL')
  const [reviewFilter, setReviewFilter] = useState('ALL')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [inspected, setInspected] = useState<string | undefined>(() => new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search).get('identity') ?? undefined)
  const [pendingConfirmation, setPendingConfirmation] = useState<'publish' | 'discard'>()
  const [bulkGroup, setBulkGroup] = useState<OperationalGroupKey>('ADMIN_UNKNOWN')
  const [activeGroupKey, setActiveGroupKey] = useState<OperationalGroupKey>()
  const [editedGroup, setEditedGroup] = useState<OperationalGroup>()

  async function refresh(quiet = false, signal?: AbortSignal) {
    if (!quiet) setLoading(true)
    try {
      const next = await getClassificationWorkspace(signal)
      setWorkspace(next)
      const query = new URLSearchParams(window.location.search)
      const requestedGroup = query.get('group') as OperationalGroupKey | null
      const requestedFamily = query.get('family')
      const requestedIdentity = query.get('identity')
      const identity = requestedIdentity ? next.effectiveClassifications.find((item) => item.identity === requestedIdentity) : undefined
      setActiveGroupKey((current) => identity?.operationalGroupKey ?? (requestedGroup && next.effectiveGroups.some(({ key }) => key === requestedGroup) ? requestedGroup : current && next.effectiveGroups.some(({ key }) => key === current) ? current : next.effectiveGroups[0]?.key))
      if (requestedFamily && next.families.some(({ key }) => key === requestedFamily)) setFamily(requestedFamily)
      if (requestedIdentity) setInspected(requestedIdentity)
      setError(undefined)
    } catch {
      setError('State classifications could not be loaded. The Radius data source or application classification store may be unavailable.')
    } finally {
      if (!quiet) setLoading(false)
    }
  }

  useEffect(() => {
    const controller = new AbortController()
    void refresh(false, controller.signal)
    const restore = () => setInspected(new URLSearchParams(window.location.search).get('identity') ?? undefined)
    window.addEventListener('popstate', restore)
    return () => { controller.abort(); window.removeEventListener('popstate', restore) }
  }, [])

  useEffect(() => {
    if (!workspace?.draft) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [Boolean(workspace?.draft)])

  async function mutate(action: () => Promise<unknown>, success: string) {
    setBusy(true)
    setError(undefined)
    setNotice(undefined)
    setValidation(undefined)
    setValidatedRevision(undefined)
    try {
      await action()
      await refresh(true)
      setNotice(success)
      return true
    } catch (caught) {
      const status = typeof caught === 'object' && caught && 'status' in caught ? Number((caught as { status: number }).status) : 0
      setError(status === 409
        ? 'This draft changed in another session. The latest revision has been reloaded; review it before trying again.'
        : status === 403
          ? 'Editing is unavailable because the writable application store is not configured.'
          : 'The classification change could not be saved. The active published version remains unchanged.')
      await refresh(true)
      return false
    } finally {
      setBusy(false)
    }
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

  const activeGroup = workspace?.effectiveGroups.find(({ key }) => key === activeGroupKey) ?? workspace?.effectiveGroups[0]
  const visibleItems = activeGroup ? filtered.filter(({ operationalGroupKey }) => operationalGroupKey === activeGroup.key) : []
  const inspector = workspace?.effectiveClassifications.find(({ identity }) => identity === inspected)
  const eventTypes = [...new Set((workspace?.effectiveClassifications ?? []).map(({ eventType: value }) => value))].sort()
  const filtersActive = Boolean(search || eventType !== 'ALL' || family !== 'ALL' || mappingFilter !== 'ALL' || reviewFilter !== 'ALL')

  function toggleSelected(identity: string) {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(identity)) next.delete(identity)
      else next.add(identity)
      return next
    })
  }

  function clearFilters() {
    setSearch('')
    setEventType('ALL')
    setFamily('ALL')
    setMappingFilter('ALL')
    setReviewFilter('ALL')
  }

  async function move(identities: EffectiveClassification[], groupKey: OperationalGroupKey) {
    if (!workspace || !workspace.canEdit || !identities.length) return
    const moved = await mutate(
      () => updateClassifications(
        workspace.draft?.revision ?? null,
        identities.map(({ eventType: type, statusCode, statusDescription }) => ({ eventType: type, statusCode, statusDescription })),
        { operationalGroupKey: groupKey, needsReview: false },
      ),
      `Saved ${identities.length} ${identities.length === 1 ? 'state' : 'states'} to the ${workspace.effectiveGroups.find(({ key }) => key === groupKey)?.displayName ?? groupKey} draft category. Validate and publish to make it live.`,
    )
    if (moved) {
      setSelected(new Set())
      setActiveGroupKey(groupKey)
    }
  }

  async function saveInspector(form: HTMLFormElement) {
    if (!workspace || !workspace.canEdit || !inspector) return
    const data = new FormData(form)
    const saved = await mutate(() => updateClassifications(workspace.draft?.revision ?? null, [{ eventType: inspector.eventType, statusCode: inspector.statusCode, statusDescription: inspector.statusDescription }], {
      operationalGroupKey: String(data.get('group')) as OperationalGroupKey,
      processFamilyKey: String(data.get('family')) as ProcessFamilyKey,
      displayLabel: String(data.get('displayLabel') ?? ''),
      explanation: String(data.get('explanation') ?? ''),
      confidence: String(data.get('confidence')) as MappingConfidence,
      needsReview: data.get('needsReview') === 'on',
      defaultTimelineVisibility: data.get('defaultTimelineVisibility') === 'on',
      obsolete: data.get('obsolete') === 'on',
    }), 'Classification details saved to the draft. Validate and publish to make them live.')
    if (saved) closeInspector()
  }

  async function validateDraft() {
    if (!workspace?.canEdit || !workspace.draft) return
    setBusy(true)
    setError(undefined)
    setNotice(undefined)
    try {
      const result = await validateClassificationDraft()
      setValidation(result)
      setValidatedRevision(workspace.draft.revision)
      setNotice(result.valid ? `Draft revision ${workspace.draft.revision} passed validation and is ready to publish.` : 'Draft validation found issues that must be corrected.')
    } catch {
      setError('Draft validation could not be completed. The published version remains active.')
    } finally {
      setBusy(false)
    }
  }

  async function publishDraft() {
    if (!workspace?.canEdit || !workspace.draft || !validation?.valid || validatedRevision !== workspace.draft.revision) return
    await mutate(
      () => publishClassificationDraft(workspace.draft!.revision),
      `Published v${workspace.published.version + 1}. It is now the active classification across ProcessIntelligence.`,
    )
    setPendingConfirmation(undefined)
  }

  const openInspector = (identity: string) => {
    const url = new URL(window.location.href)
    url.searchParams.set('identity', identity)
    window.history.pushState({ processIntelligenceEvidenceDrawer: true }, '', `${url.pathname}?${url.searchParams}`)
    setInspected(identity)
  }
  const closeInspector = useCallback(() => {
    setInspected(undefined)
    if ((window.history.state as { processIntelligenceEvidenceDrawer?: boolean } | null)?.processIntelligenceEvidenceDrawer) { window.history.back(); return }
    const url = new URL(window.location.href)
    url.searchParams.delete('identity')
    window.history.replaceState({}, '', `${url.pathname}?${url.searchParams}`)
  }, [])

  if (loading) return <section className="classification-page" aria-busy="true"><header className="classification-admin-hero classification-skeleton"><span /><span /><span /></header><div className="classification-skeleton-grid">{Array.from({ length: 8 }, (_, index) => <span key={index} />)}</div></section>
  if (!workspace) return <section className="panel unavailable-panel"><h1>State Classification unavailable</h1><p>{error}</p><button type="button" onClick={() => void refresh()}>Try again</button></section>

  return <div className="classification-page classification-admin-page">
    <header className="classification-admin-hero">
      <div className="classification-admin-hero-copy">
        <p className="eyebrow">Administration · Radius semantics</p>
        <h1>State Classification</h1>
        <p>Assign exact operator-entered Radius states to stable operational categories and process families. Source evidence is never rewritten.</p>
      </div>
      <div className={`classification-access-card ${workspace.canEdit ? 'is-editor' : 'is-locked'}`}>
        <span>{workspace.canEdit ? 'Editor access' : 'Read-only access'}</span>
        <strong>{actorLabel(workspace)}</strong>
        <small>{workspace.canEdit ? 'Changes can be saved to a draft.' : 'The application database must be configured for durable edits.'}</small>
      </div>
      <dl className="classification-admin-summary">
        <div><dt>Active version</dt><dd>v{workspace.published.version}<small>Currently used by analytics</small></dd></div>
        <div><dt>Exact states</dt><dd>{workspace.effectiveClassifications.length}<small>{workspace.effectiveGroups.length} operational categories</small></dd></div>
        <div><dt>Review queue</dt><dd>{workspace.reviewRequiredCount}<small>{workspace.unmappedCount} need classification</small></dd></div>
        <div><dt>Working draft</dt><dd>{workspace.draft ? `r${workspace.draft.revision}` : 'None'}<small>{workspace.draft ? `Targets v${workspace.draft.baseVersion + 1}` : 'Published version unchanged'}</small></dd></div>
      </dl>
    </header>

    {!workspace.canEdit && <div className="classification-auth-lock" role="status">
      <span aria-hidden="true">🔒</span>
      <div><strong>Category editing is unavailable</strong><p>The dropdowns require the separate writable ProcessIntelligence application store. Radius and telemetry remain read-only.</p></div>
    </div>}
    {busy && <div className="classification-save-progress" role="status"><i />Saving classification workflow…</div>}
    {error && <div className="scope-progress scope-progress--error" role="alert">{error}</div>}
    {notice && <div className="scope-progress scope-progress--success" role="status">{notice}</div>}

    <ClassificationWorkflow
      workspace={workspace}
      busy={busy}
      validation={validation}
      validatedRevision={validatedRevision}
      onStartDraft={() => void mutate(() => createClassificationDraft(workspace.published.version), `Draft for v${workspace.published.version + 1} is ready.`)}
      onDiscard={() => setPendingConfirmation('discard')}
      onValidate={() => void validateDraft()}
      onPublish={() => setPendingConfirmation('publish')}
    />
    {pendingConfirmation && <section className="classification-confirmation" role="alertdialog" aria-modal="false" aria-labelledby="classification-confirmation-title"><div><p className="eyebrow">Confirm classification workflow</p><h2 id="classification-confirmation-title">{pendingConfirmation === 'publish' ? `Publish v${workspace.published.version + 1}?` : 'Discard unpublished draft?'}</h2><p>{pendingConfirmation === 'publish' ? 'The validated draft will become active across ProcessIntelligence. Raw Radius evidence is unchanged.' : 'All unpublished classification changes will be removed. The active published version remains unchanged.'}</p></div><div><button type="button" className={pendingConfirmation === 'publish' ? 'primary-action' : 'danger-button'} onClick={() => pendingConfirmation === 'publish' ? void publishDraft() : workspace.draft && void mutate(() => discardClassificationDraft(workspace.draft!.revision), 'Draft discarded. The published classification remains active.').then(() => setPendingConfirmation(undefined))}>{pendingConfirmation === 'publish' ? 'Publish validated draft' : 'Discard draft'}</button><button type="button" className="secondary-button" onClick={() => setPendingConfirmation(undefined)}>Cancel</button></div></section>}

    <section className="classification-admin-board" aria-labelledby="classification-board-title">
      <div className="classification-section-heading classification-board-heading">
        <div><p className="eyebrow">Exact identity mapping</p><h2 id="classification-board-title">Move states between categories</h2><p>Choose a category, then use a state’s dropdown. The move saves immediately to the draft and opens the destination category.</p></div>
        <span>{filtered.length} of {workspace.effectiveClassifications.length} states match</span>
      </div>

      <div className="classification-admin-filters">
        <label className="classification-search-filter">Search states<input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Status, code, or label" /></label>
        <label>Event type<select value={eventType} onChange={(event) => setEventType(event.target.value)}><option value="ALL">All types</option>{eventTypes.map((type) => <option key={type} value={type}>{type || 'Empty'}</option>)}</select></label>
        <label>Process family<select value={family} onChange={(event) => setFamily(event.target.value)}><option value="ALL">All families</option>{workspace.families.map((item) => <option key={item.key} value={item.key}>{item.displayName}</option>)}</select></label>
        <label>Mapping<select value={mappingFilter} onChange={(event) => setMappingFilter(event.target.value)}><option value="ALL">Mapped &amp; unmapped</option><option value="MAPPED">Mapped</option><option value="UNMAPPED">Needs classification</option></select></label>
        <label>Review<select value={reviewFilter} onChange={(event) => setReviewFilter(event.target.value)}><option value="ALL">Any review state</option><option value="REVIEW">Needs review</option><option value="CLEAR">Reviewed</option></select></label>
        <button type="button" className="text-button" disabled={!filtersActive} onClick={clearFilters}>Clear filters</button>
      </div>

      <div className="classification-admin-workspace">
        <nav className="classification-category-nav" aria-label="Operational categories">
          <div><span>Categories</span><small>Select one to manage its states</small></div>
          {workspace.effectiveGroups.map((group) => {
            const total = workspace.effectiveClassifications.filter(({ operationalGroupKey }) => operationalGroupKey === group.key).length
            const shown = filtered.filter(({ operationalGroupKey }) => operationalGroupKey === group.key).length
            return <button
              key={group.key}
              type="button"
              className={activeGroup?.key === group.key ? 'is-active' : ''}
              style={{ '--group-light': group.lightColor, '--group-dark': group.darkColor } as React.CSSProperties}
              onClick={() => { setActiveGroupKey(group.key); setSelected(new Set()) }}
            >
              <i aria-hidden="true" />
              <span><strong>{group.displayName}</strong><small>{group.description}</small></span>
              <b>{filtersActive ? `${shown}/${total}` : total}</b>
            </button>
          })}
        </nav>

        <div className="classification-state-pane">
          <header className="classification-state-pane-header" style={{ '--group-light': activeGroup?.lightColor, '--group-dark': activeGroup?.darkColor } as React.CSSProperties}>
            <div><p className="eyebrow">Selected category</p><h3>{activeGroup?.displayName}</h3><p>{activeGroup?.description}</p></div>
            <div><strong>{visibleItems.length}</strong><span>states shown</span></div>
          </header>

          <div className="classification-bulk classification-admin-bulk" aria-live="polite">
            <strong>{selected.size} selected</strong>
            <label><span className="sr-only">Bulk destination category</span><select aria-label="Bulk destination category" value={bulkGroup} disabled={!workspace.canEdit || busy} onChange={(event) => setBulkGroup(event.target.value as OperationalGroupKey)}>{workspace.effectiveGroups.map((group) => <option key={group.key} value={group.key}>{group.displayName}</option>)}</select></label>
            <button type="button" disabled={!workspace.canEdit || selected.size === 0 || busy} onClick={() => void move(workspace.effectiveClassifications.filter(({ identity }) => selected.has(identity)), bulkGroup)}>Move selected</button>
            <button type="button" className="text-button" disabled={selected.size === 0} onClick={() => setSelected(new Set())}>Clear</button>
          </div>

          <div className="classification-admin-card-list">
            {visibleItems.map((item) => <ClassificationStateCard
              key={item.identity}
              item={item}
              groups={workspace.effectiveGroups}
              canEdit={workspace.canEdit}
              busy={busy}
              selected={selected.has(item.identity)}
              onToggle={() => toggleSelected(item.identity)}
              onInspect={() => openInspector(item.identity)}
              onMove={(groupKey) => void move([item], groupKey)}
            />)}
            {visibleItems.length === 0 && <div className="classification-admin-empty"><span aria-hidden="true">⌕</span><strong>No states match in this category</strong><p>Clear filters or choose another operational category.</p></div>}
          </div>
        </div>
      </div>
    </section>

    <section className="classification-group-settings" aria-labelledby="group-manager-title">
      <div className="classification-section-heading"><div><p className="eyebrow">Category presentation</p><h2 id="group-manager-title">Names, colors, and descriptions</h2><p>Stable keys never change. Presentation edits remain draft-only until publication.</p></div></div>
      <div className="classification-group-settings-layout">
        <div className="classification-group-selector">{workspace.effectiveGroups.map((group) => <button key={group.key} type="button" className={editedGroup?.key === group.key ? 'is-active' : ''} onClick={() => setEditedGroup({ ...group })} style={{ '--group-light': group.lightColor } as React.CSSProperties}><i /><span><strong>{group.displayName}</strong><small>{group.key}</small></span></button>)}</div>
        {editedGroup ? <form className="classification-group-editor" onSubmit={(event) => { event.preventDefault(); if (!workspace.canEdit) return; void mutate(() => updateClassificationGroup(editedGroup.key, workspace.draft?.revision ?? null, editedGroup), `${editedGroup.displayName} presentation saved to the draft.`) }}>
          <label>Stable key<input value={editedGroup.key} readOnly /></label>
          <label>Display name<input value={editedGroup.displayName} disabled={!workspace.canEdit} onChange={(event) => setEditedGroup({ ...editedGroup, displayName: event.target.value })} /></label>
          <label className="classification-group-description">Description<textarea value={editedGroup.description} disabled={!workspace.canEdit} onChange={(event) => setEditedGroup({ ...editedGroup, description: event.target.value })} /></label>
          <label>Light color<span className="color-control"><input type="color" value={editedGroup.lightColor} disabled={!workspace.canEdit} onChange={(event) => setEditedGroup({ ...editedGroup, lightColor: event.target.value })} /><code>{editedGroup.lightColor}</code></span></label>
          <label>Dark color<span className="color-control"><input type="color" value={editedGroup.darkColor} disabled={!workspace.canEdit} onChange={(event) => setEditedGroup({ ...editedGroup, darkColor: event.target.value })} /><code>{editedGroup.darkColor}</code></span></label>
          <label>Icon<select value={editedGroup.icon} disabled={!workspace.canEdit} onChange={(event) => setEditedGroup({ ...editedGroup, icon: event.target.value })}>{icons.map((icon) => <option key={icon}>{icon}</option>)}</select></label>
          <label>Order<input type="number" value={editedGroup.sortOrder} disabled={!workspace.canEdit} onChange={(event) => setEditedGroup({ ...editedGroup, sortOrder: Number(event.target.value) })} /></label>
          <div className="classification-group-actions"><button type="submit" disabled={!workspace.canEdit || busy}>Save to draft</button><button type="button" className="text-button" disabled={!workspace.canEdit || busy} onClick={() => void mutate(() => updateClassificationGroup(editedGroup.key, workspace.draft?.revision ?? null, { restoreDefault: true }), 'Seeded presentation defaults restored in the draft.')}>Restore defaults</button></div>
        </form> : <div className="classification-admin-empty"><strong>Select a category</strong><p>Its presentation settings will appear here.</p></div>}
      </div>
    </section>

    {inspector && <EvidenceDrawerShell eyebrow="Evidence · exact Radius identity" title="Classification inspector" context="Source identity is read-only; authorized edits remain draft-only" onClose={closeInspector} className="classification-inspector classification-admin-inspector">
      <form onSubmit={(event) => { event.preventDefault(); void saveInspector(event.currentTarget) }}>
        <section className="drawer-section"><h3>Read-only source identity</h3><dl className="compact-facts"><div><dt>Event type</dt><dd>{inspector.eventType || '—'}</dd></div><div><dt>Status code</dt><dd>{inspector.statusCode ?? '—'}</dd></div><div><dt>Exact description</dt><dd>{inspector.statusDescription || '(empty)'}</dd></div><div><dt>Observed records</dt><dd>{inspector.eventCount.toLocaleString()}</dd></div><div><dt>Last seen</dt><dd>{dateLabel(inspector.lastSeenUtc)}</dd></div></dl></section>
        <section className="drawer-section inspector-fields"><h3>Draft classification</h3><label>Operational category<select name="group" defaultValue={inspector.operationalGroupKey} disabled={!workspace.canEdit}>{workspace.effectiveGroups.map((group) => <option key={group.key} value={group.key}>{group.displayName}</option>)}</select></label><label>Process family<select name="family" defaultValue={inspector.processFamilyKey} disabled={!workspace.canEdit}>{workspace.families.map((item) => <option key={item.key} value={item.key}>{item.displayName}</option>)}</select></label><label>Display label<input name="displayLabel" defaultValue={inspector.displayLabel ?? ''} disabled={!workspace.canEdit} /></label><label>Internal explanation<textarea name="explanation" defaultValue={inspector.explanation} disabled={!workspace.canEdit} /></label><label>Mapping confidence<select name="confidence" defaultValue={inspector.confidence} disabled={!workspace.canEdit}><option>HIGH</option><option>MEDIUM</option><option>LOW</option></select></label><label className="check-field"><input name="needsReview" type="checkbox" defaultChecked={inspector.needsReview} disabled={!workspace.canEdit} />Needs review</label><label className="check-field"><input name="defaultTimelineVisibility" type="checkbox" defaultChecked={inspector.defaultTimelineVisibility} disabled={!workspace.canEdit} />Visible on timeline by default</label><label className="check-field"><input name="obsolete" type="checkbox" defaultChecked={inspector.obsolete} disabled={!workspace.canEdit} />Obsolete source state</label></section>
        <footer className="drawer-actions"><button type="submit" disabled={!workspace.canEdit || busy}>Save to draft</button><button type="button" className="secondary-button" onClick={closeInspector}>Close</button></footer>
      </form>
    </EvidenceDrawerShell>}

    <section className="classification-version-history">
      <div className="classification-section-heading"><div><p className="eyebrow">Version record</p><h2>Published history and audit</h2><p>The highest published version is the configuration currently used by the application.</p></div></div>
      <div className="classification-history-grid">
        <div><h3>Published versions</h3>{workspace.versions.length ? <ul>{workspace.versions.slice(0, 8).map((version, index) => <li key={version.version} className={index === 0 ? 'is-live' : ''}><span><strong>v{version.version}</strong>{index === 0 && <em>Live</em>}</span><p>{dateLabel(version.publishedAtUtc)}</p><small>{version.publishedBy} · {version.changeCount} changes</small></li>)}</ul> : <p>No administrator publications yet.</p>}</div>
        <div><h3>Recent audit activity</h3>{workspace.audit.length ? <ul>{workspace.audit.slice(0, 10).map((entry) => <li key={entry.id}><strong>{entry.summary}</strong><p>{entry.actor}</p><small>{dateLabel(entry.atUtc)}</small></li>)}</ul> : <p>No draft activity yet.</p>}</div>
      </div>
    </section>
  </div>
}
