import { useCallback, useEffect, useState } from 'react'
import {
  getProcessIntelligenceHealth,
  getRadiusEpisode,
  getRadiusHealth,
  getRadiusOverview,
  getRadiusPressEpisodes,
  getTelemetryHealth,
} from './api/process-intelligence-api'
import { AnalyticsEvidenceDrawer } from './components/AnalyticsEvidenceDrawer'
import { ApplicationShell } from './components/ApplicationShell'
import { InvestigationDrawer } from './components/InvestigationDrawer'
import { OperationalAnalysisPage, OverviewPage, PatternsEpisodesPage } from './components/AnalyticsPages'
import { PressFilterBar } from './components/PressFilterBar'
import { RangeControls } from './components/RangeControls'
import { SelectedPressWorkspace } from './components/SelectedPressWorkspace'
import { SystemStatus } from './components/SystemStatus'
import { StateClassificationPage } from './components/StateClassificationPage'
import { areaFromPathname, operationalSectionFromSearch, pressFromLocation, type AnalyticsArea, type OperationalSection } from './navigation'
import { findRadiusSegment } from './segment-selection'
import { createPresetRange, restoreSelectedRange, type SelectedRange } from './time-ranges'
import { oppositeTheme, resolveTheme, THEME_STORAGE_KEY, type Theme } from './theme'
import type {
  EpisodeAttentionItem,
  OperationalEpisode,
  RadiusOverview as RadiusOverviewModel,
  RadiusPressEpisodes,
  RadiusPressKey,
  RadiusStatusSegment,
  ServiceStatus,
} from './types/api'
import { investigationFromSearch, isDrawerHistoryState, workspaceUrl, type InvestigationRoute } from './workspace-state'

function routeRange(): SelectedRange | undefined {
  const query = new URLSearchParams(window.location.search)
  return restoreSelectedRange(query.get('fromUtc'), query.get('toUtc'), query.get('preset'))
}

function initialTheme(): Theme {
  const applied = document.documentElement.dataset.theme
  if (applied === 'light' || applied === 'dark') return applied
  return resolveTheme(null, window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false)
}

function initialInvestigationFromLocation(): InvestigationRoute | undefined {
  const navigation = window.performance?.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
  return navigation?.type === 'reload' ? undefined : investigationFromSearch(window.location.search)
}

function App() {
  const [area, setArea] = useState<AnalyticsArea>(() => areaFromPathname(window.location.pathname))
  const [analysisSection, setAnalysisSection] = useState<OperationalSection>(() => operationalSectionFromSearch(window.location.search))
  const [theme, setTheme] = useState<Theme>(initialTheme)
  const [range, setRange] = useState<SelectedRange>(() => routeRange() ?? createPresetRange('today'))
  const [selectedPress, setSelectedPress] = useState<RadiusPressKey | undefined>(() => pressFromLocation(window.location.pathname, window.location.search))
  const [investigation, setInvestigation] = useState<InvestigationRoute | undefined>(initialInvestigationFromLocation)
  const [apiStatus, setApiStatus] = useState<ServiceStatus>('loading')
  const [telemetryStatus, setTelemetryStatus] = useState<ServiceStatus>('loading')
  const [historianStatus, setHistorianStatus] = useState<ServiceStatus>('loading')
  const [radiusStatus, setRadiusStatus] = useState<ServiceStatus>('loading')
  const [radiusReason, setRadiusReason] = useState<string>()
  const [overview, setOverview] = useState<RadiusOverviewModel>()
  const [pressDetail, setPressDetail] = useState<RadiusPressEpisodes>()
  const [drawerPress, setDrawerPress] = useState<RadiusPressKey | undefined>(() => {
    const initialInvestigation = initialInvestigationFromLocation()
    return initialInvestigation?.mode === 'segment' ? initialInvestigation.pressKey : undefined
  })
  const [drawerPressDetail, setDrawerPressDetail] = useState<RadiusPressEpisodes>()
  const [drawerContextSegments, setDrawerContextSegments] = useState<RadiusStatusSegment[]>()
  const [drawerSegment, setDrawerSegment] = useState<RadiusStatusSegment>()
  const [drawerPressLoading, setDrawerPressLoading] = useState(false)
  const [timelineFocusPress, setTimelineFocusPress] = useState<RadiusPressKey>()
  const [timelineFocusDetail, setTimelineFocusDetail] = useState<RadiusPressEpisodes>()
  const [episodeDetail, setEpisodeDetail] = useState<OperationalEpisode>()
  const [loading, setLoading] = useState(true)
  const [pressLoading, setPressLoading] = useState(false)
  const [timelineFocusLoading, setTimelineFocusLoading] = useState(false)
  const [drawerLoading, setDrawerLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [pressError, setPressError] = useState<string>()
  const [timelineFocusError, setTimelineFocusError] = useState<string>()

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    document.documentElement.style.colorScheme = theme
  }, [theme])

  function toggleTheme() {
    setTheme((currentTheme) => {
      const nextTheme = oppositeTheme(currentTheme)
      try { localStorage.setItem(THEME_STORAGE_KEY, nextTheme) } catch {}
      return nextTheme
    })
  }

  useEffect(() => {
    const onPopState = () => {
      setArea(areaFromPathname(window.location.pathname))
      setAnalysisSection(operationalSectionFromSearch(window.location.search))
      setSelectedPress(pressFromLocation(window.location.pathname, window.location.search))
      const restoredInvestigation = investigationFromSearch(window.location.search)
      setInvestigation(restoredInvestigation)
      setDrawerPress(restoredInvestigation?.mode === 'segment' ? restoredInvestigation.pressKey : undefined)
      setDrawerContextSegments(undefined)
      setDrawerSegment(undefined)
      const restoredRange = routeRange()
      if (restoredRange) setRange((current) => current.fromUtc === restoredRange.fromUtc && current.toUtc === restoredRange.toUtc && current.preset === restoredRange.preset ? current : restoredRange)
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  useEffect(() => {
    let active = true
    void getProcessIntelligenceHealth().then(() => active && setApiStatus('healthy')).catch(() => active && setApiStatus('unavailable'))
    void getTelemetryHealth().then((health) => {
      if (!active) return
      setTelemetryStatus(health.telemetryApi.status === 'healthy' ? 'healthy' : 'unavailable')
      setHistorianStatus(health.historian.status === 'healthy' ? 'healthy' : 'unavailable')
    }).catch(() => { if (active) { setTelemetryStatus('unavailable'); setHistorianStatus('unavailable') } })
    void getRadiusHealth().then((health) => {
      if (!active) return
      setRadiusStatus(health.status === 'healthy' ? 'healthy' : 'unavailable')
      setRadiusReason(health.reason)
    }).catch(() => { if (active) { setRadiusStatus('unavailable'); setRadiusReason('not_configured') } })
    return () => { active = false }
  }, [])

  useEffect(() => {
    let active = true
    setLoading(true)
    setError(undefined)
    void getRadiusOverview(range.fromUtc, range.toUtc).then((result) => { if (active) setOverview(result) }).catch(() => {
      if (!active) return
      setError(radiusReason === 'not_configured'
        ? 'Radius data is unavailable until a dedicated SELECT-only database login and verified live mappings are configured.'
        : 'Radius operational data could not be loaded for this range.')
    }).finally(() => active && setLoading(false))
    return () => { active = false }
  }, [range, radiusReason])

  useEffect(() => {
    if (!selectedPress) { setPressDetail(undefined); setPressError(undefined); return }
    let active = true
    setPressLoading(true)
    setPressError(undefined)
    setEpisodeDetail(undefined)
    void getRadiusPressEpisodes(selectedPress, range.fromUtc, range.toUtc)
      .then((result) => active && setPressDetail(result))
      .catch(() => active && setPressError('The selected press could not be analyzed for this range.'))
      .finally(() => active && setPressLoading(false))
    return () => { active = false }
  }, [range, selectedPress])

  useEffect(() => {
    if (!timelineFocusPress) { setTimelineFocusDetail(undefined); setTimelineFocusError(undefined); setTimelineFocusLoading(false); return }
    let active = true
    setTimelineFocusLoading(true)
    setTimelineFocusError(undefined)
    void getRadiusPressEpisodes(timelineFocusPress, range.fromUtc, range.toUtc)
      .then((result) => active && setTimelineFocusDetail(result))
      .catch(() => active && setTimelineFocusError('The focused press could not be analyzed for this range.'))
      .finally(() => active && setTimelineFocusLoading(false))
    return () => { active = false }
  }, [range, timelineFocusPress])

  useEffect(() => {
    if (investigation?.mode === 'segment' && drawerSegment) {
      setDrawerPressDetail(undefined)
      setDrawerPressLoading(false)
      return
    }
    if (!drawerPress || (drawerPress === selectedPress && pressDetail?.press.pressKey === drawerPress)) {
      setDrawerPressDetail(undefined)
      setDrawerPressLoading(false)
      return
    }
    let active = true
    setDrawerPressLoading(true)
    void getRadiusPressEpisodes(drawerPress, range.fromUtc, range.toUtc)
      .then((result) => active && setDrawerPressDetail(result))
      .catch(() => active && setDrawerPressDetail(undefined))
      .finally(() => active && setDrawerPressLoading(false))
    return () => { active = false }
  }, [range, drawerPress, selectedPress, pressDetail, investigation, drawerSegment])

  useEffect(() => {
    const episodeId = investigation?.mode === 'episode' ? investigation.episodeId : investigation?.mode === 'attention' ? investigation.findingId : undefined
    if (!selectedPress || !episodeId || !pressDetail) return
    const inRangeEpisode = pressDetail.episodes.find((episode) => episode.episodeId === episodeId)
    if (inRangeEpisode) { setEpisodeDetail(inRangeEpisode); setDrawerLoading(false); return }
    let active = true
    setDrawerLoading(true)
    void getRadiusEpisode(selectedPress, episodeId).then((episode) => active && setEpisodeDetail(episode)).catch(() => active && setEpisodeDetail(undefined)).finally(() => active && setDrawerLoading(false))
    return () => { active = false }
  }, [selectedPress, investigation, pressDetail])

  function navigateArea(nextArea: AnalyticsArea, section?: OperationalSection) {
    const nextSection = section ?? analysisSection
    window.history.pushState({}, '', workspaceUrl(range, selectedPress, undefined, nextArea, nextSection))
    setArea(nextArea)
    setAnalysisSection(nextSection)
    setInvestigation(undefined)
    setDrawerPress(undefined)
    setDrawerPressDetail(undefined)
    setDrawerContextSegments(undefined)
    setDrawerSegment(undefined)
    setEpisodeDetail(undefined)
    window.scrollTo({ top: 0 })
  }

  function selectAnalysisSection(nextSection: OperationalSection) {
    window.history.pushState({}, '', workspaceUrl(range, selectedPress, undefined, 'operational-analysis', nextSection))
    setAnalysisSection(nextSection)
    setInvestigation(undefined)
  }

  function selectPressScope(pressKey: RadiusPressKey | undefined) {
    window.history.pushState({}, '', workspaceUrl(range, pressKey, undefined, area, analysisSection))
    setSelectedPress(pressKey)
    setInvestigation(undefined)
    setDrawerPress(undefined)
    setDrawerPressDetail(undefined)
    setDrawerContextSegments(undefined)
    setDrawerSegment(undefined)
    setEpisodeDetail(undefined)
  }

  function focusTimelinePress(pressKey: RadiusPressKey) {
    setTimelineFocusPress(pressKey)
    setTimelineFocusError(undefined)
    setEpisodeDetail(undefined)
  }

  function clearTimelineFocus() {
    setTimelineFocusPress(undefined)
    setTimelineFocusDetail(undefined)
    setTimelineFocusError(undefined)
    setEpisodeDetail(undefined)
    window.requestAnimationFrame(() => document.querySelector('.overview-page')?.scrollIntoView({ block: 'start' }))
  }

  function cycleTimelineFocus(direction: -1 | 1) {
    if (!timelineFocusPress || !overview) return
    const index = overview.presses.findIndex(({ pressKey }) => pressKey === timelineFocusPress)
    const next = overview.presses[index + direction]
    if (next) focusTimelinePress(next.pressKey)
  }

  function navigateSegment(pressKey: RadiusPressKey, segment: RadiusStatusSegment) {
    const route: InvestigationRoute = { mode: 'segment', pressKey, startUtc: segment.startUtc, endUtc: segment.endUtc }
    window.history.pushState({ processIntelligenceDrawer: true }, '', workspaceUrl(range, selectedPress, route, area, analysisSection))
    setDrawerPress(pressKey)
    setDrawerContextSegments(overview?.presses.find(({ pressKey: candidateKey }) => candidateKey === pressKey)?.timelineSegments)
    setDrawerSegment(segment)
    const cachedDetail = selectedPress === pressKey && pressDetail?.press.pressKey === pressKey ? pressDetail : undefined
    setDrawerPressDetail(cachedDetail)
    setDrawerPressLoading(false)
    setInvestigation(route)
    setEpisodeDetail(undefined)
  }

  function selectEpisode(episode: OperationalEpisode) {
    if (!selectedPress) return
    const route: InvestigationRoute = { mode: 'episode', episodeId: episode.episodeId }
    window.history.pushState({ processIntelligenceDrawer: true }, '', workspaceUrl(range, selectedPress, route, area, analysisSection))
    setEpisodeDetail(episode)
    setInvestigation(route)
  }

  function selectFinding(item: EpisodeAttentionItem, episode: OperationalEpisode) {
    if (!selectedPress) return
    const route: InvestigationRoute = { mode: 'attention', findingId: item.episodeId }
    window.history.pushState({ processIntelligenceDrawer: true }, '', workspaceUrl(range, selectedPress, route, area, analysisSection))
    setEpisodeDetail(episode)
    setInvestigation(route)
  }

  function selectTimelineFocusEpisode(episode: OperationalEpisode) {
    if (!timelineFocusPress || !timelineFocusDetail) return
    const route: InvestigationRoute = { mode: 'episode', episodeId: episode.episodeId }
    window.history.replaceState({}, '', workspaceUrl(range, timelineFocusPress, undefined, area, analysisSection))
    window.history.pushState({ processIntelligenceDrawer: true }, '', workspaceUrl(range, timelineFocusPress, route, area, analysisSection))
    setSelectedPress(timelineFocusPress)
    setPressDetail(timelineFocusDetail)
    setEpisodeDetail(episode)
    setInvestigation(route)
  }

  function selectTimelineFocusSegment(segment: RadiusStatusSegment) {
    if (!timelineFocusPress || !timelineFocusDetail) return
    const route: InvestigationRoute = { mode: 'segment', startUtc: segment.startUtc, endUtc: segment.endUtc }
    window.history.replaceState({}, '', workspaceUrl(range, timelineFocusPress, undefined, area, analysisSection))
    window.history.pushState({ processIntelligenceDrawer: true }, '', workspaceUrl(range, timelineFocusPress, route, area, analysisSection))
    setSelectedPress(timelineFocusPress)
    setPressDetail(timelineFocusDetail)
    setEpisodeDetail(undefined)
    setInvestigation(route)
  }

  function selectTimelineFocusFinding(item: EpisodeAttentionItem, episode: OperationalEpisode) {
    if (!timelineFocusPress || !timelineFocusDetail) return
    const route: InvestigationRoute = { mode: 'attention', findingId: item.episodeId }
    window.history.replaceState({}, '', workspaceUrl(range, timelineFocusPress, undefined, area, analysisSection))
    window.history.pushState({ processIntelligenceDrawer: true }, '', workspaceUrl(range, timelineFocusPress, route, area, analysisSection))
    setSelectedPress(timelineFocusPress)
    setPressDetail(timelineFocusDetail)
    setEpisodeDetail(episode)
    setInvestigation(route)
  }

  function investigateStatus(statusIdentity: string) {
    const route: InvestigationRoute = { mode: 'status', statusIdentity }
    window.history.pushState({ processIntelligenceDrawer: true }, '', workspaceUrl(range, selectedPress, route, area, analysisSection))
    setInvestigation(route)
  }

  function investigateAnomaly(anomalyId: string) {
    const route: InvestigationRoute = { mode: 'anomaly', anomalyId }
    window.history.pushState({ processIntelligenceDrawer: true }, '', workspaceUrl(range, selectedPress, route, area, analysisSection))
    setInvestigation(route)
  }

  const closeInvestigation = useCallback(() => {
    const drawerHistory = isDrawerHistoryState(window.history.state)
    setInvestigation(undefined)
    setDrawerPress(undefined)
    setDrawerPressDetail(undefined)
    setDrawerContextSegments(undefined)
    setDrawerSegment(undefined)
    setEpisodeDetail(undefined)
    if (drawerHistory) { window.history.back(); return }
    window.history.replaceState({}, '', workspaceUrl(range, selectedPress, undefined, area, analysisSection))
  }, [range, selectedPress, area, analysisSection])

  function changeRange(nextRange: SelectedRange) {
    window.history.replaceState({}, '', workspaceUrl(nextRange, selectedPress, undefined, area, analysisSection))
    setRange(nextRange)
    setInvestigation(undefined)
    setDrawerPress(undefined)
    setDrawerPressDetail(undefined)
    setDrawerContextSegments(undefined)
    setDrawerSegment(undefined)
    setEpisodeDetail(undefined)
  }

  const drawerResult = drawerPress ? (drawerPress === selectedPress ? pressDetail : drawerPressDetail) : pressDetail
  const drawerResultPress = drawerPress ?? selectedPress
  const selectedSegmentDetail = drawerSegment ?? findRadiusSegment([
    ...(drawerResult?.timelineSegments ?? []),
    ...(drawerResult?.episodes.flatMap(({ statusSegments }) => statusSegments) ?? []),
  ], investigation?.mode === 'segment' && drawerResultPress ? { pressKey: drawerResultPress, startUtc: investigation.startUtc, endUtc: investigation.endUtc } : undefined)
  const selectedFinding = investigation?.mode === 'attention' ? drawerResult?.analysis.attentionItems.find(({ episodeId }) => episodeId === investigation.findingId) : undefined
  const pressAnalyticsReady = Boolean(selectedPress && pressDetail?.press.pressKey === selectedPress && !pressLoading)
  const activeAnalytics = pressAnalyticsReady ? pressDetail?.operationalAnalytics : overview?.operationalAnalytics
  const selectedScopeLabel = selectedPress ? pressDetail?.press.displayName ?? selectedPress.replace('press', 'Press ') : `All ${overview?.operationalAnalytics.scopePressCount ?? 0} presses`
  const analyticsScopeLabel = pressAnalyticsReady ? selectedScopeLabel : `All ${overview?.operationalAnalytics.scopePressCount ?? 0} presses`
  const dataStatus = radiusStatus === 'healthy' ? 'healthy' : radiusStatus === 'loading' ? 'loading' : 'unavailable'
  const episodeWorkspace = !pressLoading && !pressError && selectedPress && pressDetail && overview
    ? <SelectedPressWorkspace result={pressDetail} fleetAnalysis={overview.episodeAnalysis} onClear={() => selectPressScope(undefined)} onSelectEpisode={selectEpisode} onSelectSegment={(segment) => navigateSegment(selectedPress, segment)} onSelectFinding={selectFinding} />
    : undefined
  const timelineFocusIndex = timelineFocusPress ? overview?.presses.findIndex(({ pressKey }) => pressKey === timelineFocusPress) ?? -1 : -1
  const timelineFocusName = timelineFocusPress ? overview?.presses.find(({ pressKey }) => pressKey === timelineFocusPress)?.displayName ?? timelineFocusPress.replace('press', 'Press ') : undefined
  const timelineFocusUpdating = Boolean(timelineFocusPress && (timelineFocusLoading || timelineFocusDetail?.press.pressKey !== timelineFocusPress))
  const timelineFocusWorkspace = timelineFocusPress && overview
    ? timelineFocusDetail
      ? <div className="timeline-focus-shell" aria-busy={timelineFocusUpdating}>
          {timelineFocusUpdating && !timelineFocusError && <section className="timeline-focus-loading timeline-focus-loading--overlay" aria-live="polite"><i aria-hidden="true" /><strong>Updating to {timelineFocusName}</strong><span>Keeping this investigation in place while its data changes.</span></section>}
          {timelineFocusError && <section className="timeline-focus-loading timeline-focus-loading--error timeline-focus-loading--overlay" role="alert">{timelineFocusError}</section>}
          <SelectedPressWorkspace result={timelineFocusDetail} fleetAnalysis={overview.episodeAnalysis} onClear={clearTimelineFocus} onPrevious={() => cycleTimelineFocus(-1)} onNext={() => cycleTimelineFocus(1)} hasPrevious={timelineFocusIndex > 0} hasNext={timelineFocusIndex >= 0 && timelineFocusIndex < overview.presses.length - 1} onBackToOverview={clearTimelineFocus} inline onSelectEpisode={selectTimelineFocusEpisode} onSelectSegment={selectTimelineFocusSegment} onSelectFinding={selectTimelineFocusFinding} />
        </div>
      : timelineFocusError
        ? <section className="timeline-focus-loading timeline-focus-loading--error" role="alert">{timelineFocusError}</section>
        : <section className="timeline-focus-loading" aria-live="polite"><i aria-hidden="true" /><strong>Preparing {timelineFocusName} investigation</strong><span>The fleet overview remains available while this press is updated.</span></section>
    : undefined

  const context = <>
    <div className="context-summary">
      <div><span>Operational intelligence</span><strong>Process Intelligence</strong><small>{selectedScopeLabel}</small></div>
      <span className={`data-health data-health--${dataStatus}`} role="status"><i aria-hidden="true" />{dataStatus === 'healthy' ? 'Radius data healthy' : dataStatus === 'loading' ? 'Checking Radius data' : 'Radius data unavailable'}</span>
    </div>
    <div className="filter-groups">
      <section className="filter-group filter-group--time" aria-labelledby="time-filter-title">
        <div className="filter-group-heading"><span id="time-filter-title">Time range</span><small>Choose the period to analyze</small></div>
        <RangeControls range={range} onChange={changeRange} />
      </section>
      {overview && <section className="filter-group filter-group--press" aria-labelledby="press-filter-title">
        <div className="filter-group-heading"><span id="press-filter-title">Press selection</span><small>Compare the fleet or focus on one press</small></div>
        <PressFilterBar presses={overview.presses} selectedPress={selectedPress} onSelect={selectPressScope} onClear={() => selectPressScope(undefined)} />
      </section>}
    </div>
  </>

  const administrationContext = <div className="context-summary administration-context"><div><span>Administration</span><strong>Radius semantics</strong><small>Published mappings govern Operations views; Raw Radius evidence remains unchanged.</small></div><span className="data-health data-health--healthy" role="status"><i aria-hidden="true" />Versioned configuration</span></div>

  const footer = <details className="system-status-drawer"><summary>System and dependency health</summary><SystemStatus items={[
    { label: 'ProcessIntelligence API', status: apiStatus },
    { label: 'Radius database', status: radiusStatus, detail: radiusReason },
    { label: 'TelemetryQueryApi', status: telemetryStatus },
    { label: 'Telemetry historian', status: historianStatus },
  ]} /></details>

  return <ApplicationShell area={area} theme={theme} onNavigate={navigateArea} onToggleTheme={toggleTheme} context={area === 'state-classification' ? administrationContext : context} footer={footer}>
    {area !== 'state-classification' && loading && !overview && <section className="panel loading-panel" role="status">Loading Radius operations…</section>}
    {area !== 'state-classification' && loading && overview && <div className="scope-progress" role="status"><i aria-hidden="true" />Updating the selected time range; current results remain visible.</div>}
    {area !== 'state-classification' && error && !overview && <section className="panel unavailable-panel"><h1>Radius data unavailable</h1><p>{error}</p><p>Dependency health remains available below.</p></section>}
    {area !== 'state-classification' && error && overview && <div className="scope-progress scope-progress--error" role="alert">{error} Previous results remain visible.</div>}
    {area !== 'state-classification' && overview && selectedPress && pressLoading && <div className="scope-progress" role="status"><i aria-hidden="true" />Applying {selectedScopeLabel}; the current timeline remains available.</div>}
    {area !== 'state-classification' && selectedPress && pressError && !pressLoading && <div className="scope-progress scope-progress--error" role="alert">{pressError}</div>}
    {overview && activeAnalytics && area === 'overview' && <OverviewPage analytics={activeAnalytics} scopeLabel={analyticsScopeLabel} overview={overview} selectedPress={selectedPress} focusedPress={timelineFocusPress} focusWorkspace={timelineFocusWorkspace} onSelectPress={focusTimelinePress} onClearFocus={clearTimelineFocus} onNavigate={navigateArea} onInvestigateStatus={investigateStatus} onInvestigateAnomaly={investigateAnomaly} />}
    {overview && activeAnalytics && area === 'operational-analysis' && <OperationalAnalysisPage analytics={activeAnalytics} scopeLabel={analyticsScopeLabel} overview={overview} selectedPress={selectedPress} runComparison={selectedPress && pressDetail?.press.pressKey === selectedPress ? pressDetail.runComparison : undefined} section={analysisSection} onSelectSection={selectAnalysisSection} onSelectPress={selectPressScope} onInspectSegment={navigateSegment} onInvestigateStatus={investigateStatus} />}
    {overview && activeAnalytics && area === 'patterns-episodes' && <PatternsEpisodesPage analytics={activeAnalytics} scopeLabel={analyticsScopeLabel} onInvestigateAnomaly={investigateAnomaly} episodeWorkspace={episodeWorkspace} />}
    {area === 'state-classification' && <StateClassificationPage />}

    {investigation && investigation.mode !== 'status' && investigation.mode !== 'anomaly' && drawerResultPress && (drawerResult || drawerPressLoading || (investigation.mode === 'segment' && drawerSegment)) && <InvestigationDrawer route={investigation} result={drawerResult} episode={episodeDetail} segment={selectedSegmentDetail} finding={selectedFinding} loading={investigation.mode === 'segment' ? false : drawerPressLoading || drawerLoading} onClose={closeInvestigation} onSelectSegment={(nextSegment) => navigateSegment(nextSegment.pressKey, nextSegment)} contextSegments={drawerContextSegments} />}
    {investigation && (investigation.mode === 'status' || investigation.mode === 'anomaly') && activeAnalytics && <AnalyticsEvidenceDrawer route={investigation} analytics={activeAnalytics} scopeLabel={analyticsScopeLabel} onClose={closeInvestigation} />}
  </ApplicationShell>
}

export default App
