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
import { IntelligentSearchPage } from './components/IntelligentSearchPage'
import { OperationalAnalysisPage, OverviewPage, PatternsEpisodesPage } from './components/AnalyticsPages'
import { PressFilterBar } from './components/PressFilterBar'
import { RangeControls } from './components/RangeControls'
import { SystemStatus } from './components/SystemStatus'
import { StateClassificationPage } from './components/StateClassificationPage'
import { RawRadiusExplorerPage } from './components/RawRadiusExplorerPage'
import { TelemetryEventExplorerPage } from './components/TelemetryEventExplorerPage'
import { areaFromPathname, areaPath, operationalSectionFromSearch, pressFromLocation, type AnalyticsArea, type OperationalSection } from './navigation'
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
  const [episodeDetail, setEpisodeDetail] = useState<OperationalEpisode>()
  const [loading, setLoading] = useState(true)
  const [pressLoading, setPressLoading] = useState(false)
  const [drawerLoading, setDrawerLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [pressError, setPressError] = useState<string>()
  const operationsArea = area === 'overview' || area === 'operational-analysis' || area === 'patterns-episodes'
  const radiusDataArea = operationsArea || area === 'raw-radius-explorer' || area === 'telemetry-event-explorer'

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    document.documentElement.style.colorScheme = theme
  }, [theme])

  useEffect(() => {
    if (range.preset === 'custom') return
    const refreshLiveRange = () => setRange((current) => current.preset === 'custom' ? current : createPresetRange(current.preset))
    const timer = window.setInterval(refreshLiveRange, 60_000)
    const refreshWhenVisible = () => { if (document.visibilityState === 'visible') refreshLiveRange() }
    document.addEventListener('visibilitychange', refreshWhenVisible)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
    }
  }, [range.preset])

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
    if (!radiusDataArea) { setLoading(false); setError(undefined); return }
    let active = true
    const controller = new AbortController()
    void getProcessIntelligenceHealth(controller.signal).then(() => active && setApiStatus('healthy')).catch(() => active && setApiStatus('unavailable'))
    void getTelemetryHealth(controller.signal).then((health) => {
      if (!active) return
      setTelemetryStatus(health.telemetryApi.status === 'healthy' ? 'healthy' : 'unavailable')
      setHistorianStatus(health.historian.status === 'healthy' ? 'healthy' : 'unavailable')
    }).catch(() => { if (active) { setTelemetryStatus('unavailable'); setHistorianStatus('unavailable') } })
    void getRadiusHealth(controller.signal).then((health) => {
      if (!active) return
      setRadiusStatus(health.status === 'healthy' ? 'healthy' : 'unavailable')
      setRadiusReason(health.reason)
    }).catch(() => { if (active) { setRadiusStatus('unavailable'); setRadiusReason('not_configured') } })
    return () => { active = false; controller.abort() }
  }, [radiusDataArea])

  useEffect(() => {
    if (!operationsArea) return
    let active = true
    const controller = new AbortController()
    setLoading(true)
    setError(undefined)
    void getRadiusOverview(range.fromUtc, range.toUtc, area === 'overview', controller.signal).then((result) => { if (active) setOverview(result) }).catch(() => {
      if (!active) return
      setError(radiusReason === 'not_configured'
        ? 'Radius data is unavailable until a dedicated SELECT-only database login and verified live mappings are configured.'
        : 'Radius operational data could not be loaded for this range.')
    }).finally(() => active && setLoading(false))
    return () => { active = false; controller.abort() }
  }, [operationsArea, area, range, radiusReason])

  useEffect(() => {
    if (!operationsArea || !selectedPress || area === 'overview') { setPressDetail(undefined); setPressError(undefined); return }
    let active = true
    const controller = new AbortController()
    setPressLoading(true)
    setPressError(undefined)
    setEpisodeDetail(undefined)
    void getRadiusPressEpisodes(selectedPress, range.fromUtc, range.toUtc, controller.signal)
      .then((result) => active && setPressDetail(result))
      .catch(() => active && setPressError('The selected press could not be analyzed for this range.'))
      .finally(() => active && setPressLoading(false))
    return () => { active = false; controller.abort() }
  }, [operationsArea, area, range, selectedPress])

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
    const controller = new AbortController()
    setDrawerPressLoading(true)
    void getRadiusPressEpisodes(drawerPress, range.fromUtc, range.toUtc, controller.signal)
      .then((result) => active && setDrawerPressDetail(result))
      .catch(() => active && setDrawerPressDetail(undefined))
      .finally(() => active && setDrawerPressLoading(false))
    return () => { active = false; controller.abort() }
  }, [range, drawerPress, selectedPress, pressDetail, investigation, drawerSegment])

  useEffect(() => {
    const episodeId = investigation?.mode === 'episode' ? investigation.episodeId : investigation?.mode === 'attention' ? investigation.findingId : undefined
    if (!selectedPress || !episodeId || !pressDetail) return
    const inRangeEpisode = pressDetail.episodes.find((episode) => episode.episodeId === episodeId)
    if (inRangeEpisode) { setEpisodeDetail(inRangeEpisode); setDrawerLoading(false); return }
    let active = true
    const controller = new AbortController()
    setDrawerLoading(true)
    void getRadiusEpisode(selectedPress, episodeId, controller.signal).then((episode) => active && setEpisodeDetail(episode)).catch(() => active && setEpisodeDetail(undefined)).finally(() => active && setDrawerLoading(false))
    return () => { active = false; controller.abort() }
  }, [selectedPress, investigation, pressDetail])

  function navigateArea(nextArea: AnalyticsArea, section?: OperationalSection) {
    const nextSection = section ?? analysisSection
    window.history.pushState({}, '', nextArea === 'raw-radius-explorer' || nextArea === 'telemetry-event-explorer' ? areaPath(nextArea) : workspaceUrl(range, selectedPress, undefined, nextArea, nextSection))
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
  const pressAnalyticsReady = Boolean(selectedPress && pressDetail?.press.pressKey === selectedPress)
  const activeAnalytics = pressAnalyticsReady ? pressDetail?.operationalAnalytics : overview?.operationalAnalytics
  const selectedScopeLabel = selectedPress ? pressDetail?.press.displayName ?? selectedPress.replace('press', 'Press ') : `All ${overview?.operationalAnalytics?.scopePressCount ?? overview?.presses.length ?? 0} presses`
  const analyticsScopeLabel = pressAnalyticsReady ? selectedScopeLabel : `All ${overview?.operationalAnalytics?.scopePressCount ?? overview?.presses.length ?? 0} presses`
  const dataStatus = radiusStatus === 'healthy' ? 'healthy' : radiusStatus === 'loading' ? 'loading' : 'unavailable'
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
  const searchContext = <div className="context-summary search-context"><div><span>Find and investigate</span><strong>Intelligent Search</strong><small>Search a work name or Radius code, then open it in the right analysis.</small></div><span className="data-health data-health--healthy" role="status"><i aria-hidden="true" />Search ready</span></div>
  const rawExplorerContext = <div className="context-summary search-context"><div><span>Engineering evidence</span><strong>Raw Radius Code Explorer</strong><small>Exact recorded Radius states and synchronized telemetry.</small></div><span className={`data-health data-health--${dataStatus}`} role="status"><i aria-hidden="true" />{dataStatus === 'healthy' ? 'Evidence services healthy' : dataStatus === 'loading' ? 'Checking evidence services' : 'Evidence services unavailable'}</span></div>
  const telemetryEventContext = <div className="context-summary search-context"><div><span>Find telemetry behavior</span><strong>Telemetry Event Explorer</strong><small>Threshold and change occurrences with synchronized Radius context.</small></div><span className={`data-health data-health--${dataStatus}`} role="status"><i aria-hidden="true" />{dataStatus === 'healthy' ? 'Evidence services healthy' : dataStatus === 'loading' ? 'Checking evidence services' : 'Evidence services unavailable'}</span></div>
  const footer = <details className="system-status-drawer"><summary>System and dependency health</summary><SystemStatus items={[
    { label: 'ProcessIntelligence API', status: apiStatus },
    { label: 'Radius database', status: radiusStatus, detail: radiusReason },
    { label: 'TelemetryQueryApi', status: telemetryStatus },
    { label: 'Telemetry historian', status: historianStatus },
  ]} /></details>

  return <ApplicationShell area={area} theme={theme} onNavigate={navigateArea} onToggleTheme={toggleTheme} context={area === 'state-classification' ? administrationContext : area === 'intelligent-search' ? searchContext : area === 'raw-radius-explorer' ? rawExplorerContext : area === 'telemetry-event-explorer' ? telemetryEventContext : context} footer={footer}>
    {operationsArea && loading && !overview && <section className="panel loading-panel" role="status">Loading Radius operations…</section>}
    {operationsArea && loading && overview && <span className="background-refresh-status" role="status">Updating the selected time range; current results remain visible.</span>}
    {operationsArea && error && !overview && <section className="panel unavailable-panel"><h1>Radius data unavailable</h1><p>{error}</p><p>Dependency health remains available below.</p></section>}
    {operationsArea && error && overview && <div className="scope-progress scope-progress--error" role="alert">{error} Previous results remain visible.</div>}
    {operationsArea && area !== 'overview' && overview && selectedPress && pressLoading && !pressAnalyticsReady && <div className="scope-progress" role="status"><i aria-hidden="true" />Applying {selectedScopeLabel}; the current timeline remains available.</div>}
    {operationsArea && area !== 'overview' && overview && selectedPress && pressLoading && pressAnalyticsReady && <span className="background-refresh-status" role="status">Updating {selectedScopeLabel}; current press results remain visible.</span>}
    {operationsArea && area !== 'overview' && selectedPress && pressError && !pressLoading && <div className="scope-progress scope-progress--error" role="alert">{pressError}</div>}
    {overview && area === 'overview' && <OverviewPage overview={overview} selectedPress={selectedPress} />}
    {overview && activeAnalytics && area === 'operational-analysis' && <OperationalAnalysisPage analytics={activeAnalytics} scopeLabel={analyticsScopeLabel} overview={overview} selectedPress={selectedPress} />}
    {overview && activeAnalytics && area === 'patterns-episodes' && <PatternsEpisodesPage analytics={activeAnalytics} scopeLabel={analyticsScopeLabel} overview={overview} selectedPress={selectedPress} />}
    {area === 'intelligent-search' && <IntelligentSearchPage />}
    {area === 'raw-radius-explorer' && <RawRadiusExplorerPage />}
    {area === 'telemetry-event-explorer' && <TelemetryEventExplorerPage />}
    {area === 'state-classification' && <StateClassificationPage />}

    {investigation && !(area === 'overview' && investigation.mode === 'segment') && investigation.mode !== 'status' && investigation.mode !== 'anomaly' && drawerResultPress && (drawerResult || drawerPressLoading || (investigation.mode === 'segment' && drawerSegment)) && <InvestigationDrawer route={investigation} result={drawerResult} episode={episodeDetail} segment={selectedSegmentDetail} finding={selectedFinding} loading={investigation.mode === 'segment' ? false : drawerPressLoading || drawerLoading} onClose={closeInvestigation} onSelectSegment={(nextSegment) => navigateSegment(nextSegment.pressKey, nextSegment)} contextSegments={drawerContextSegments} />}
    {investigation && (investigation.mode === 'status' || investigation.mode === 'anomaly') && activeAnalytics && <AnalyticsEvidenceDrawer route={investigation} analytics={activeAnalytics} scopeLabel={analyticsScopeLabel} onClose={closeInvestigation} />}
  </ApplicationShell>
}

export default App
