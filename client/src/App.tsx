import { useEffect, useState } from 'react'
import { getProcessIntelligenceHealth, getRadiusHealth, getRadiusOverview, getTelemetryHealth } from './api/process-intelligence-api'
import { ApplicationShell } from './components/ApplicationShell'
import { OverviewPage } from './components/AnalyticsPages'
import { PressFilterBar } from './components/PressFilterBar'
import { RangeControls } from './components/RangeControls'
import { SystemStatus } from './components/SystemStatus'
import { StateClassificationPage } from './components/StateClassificationPage'
import { RawRadiusExplorerPage } from './components/RawRadiusExplorerPage'
import { TelemetryEventExplorerPage } from './components/TelemetryEventExplorerPage'
import { MachineIntelligencePage } from './components/MachineIntelligencePage'
import { StopIntelligencePage } from './components/StopIntelligencePage'
import { areaFromPathname, areaPath, pressFromLocation, type AnalyticsArea } from './navigation'
import { createPresetRange, restoreSelectedRange, type SelectedRange } from './time-ranges'
import { oppositeTheme, resolveTheme, THEME_STORAGE_KEY, type Theme } from './theme'
import type { RadiusOverview as RadiusOverviewModel, RadiusPressKey, ServiceStatus } from './types/api'

function routeRange(): SelectedRange | undefined {
  const query = new URLSearchParams(window.location.search)
  return restoreSelectedRange(query.get('fromUtc'), query.get('toUtc'), query.get('preset'))
}

function initialTheme(): Theme {
  const applied = document.documentElement.dataset.theme
  if (applied === 'light' || applied === 'dark') return applied
  return resolveTheme(null, window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false)
}

function routeUrl(area: AnalyticsArea, range: SelectedRange, pressKey?: RadiusPressKey): string {
  const query = new URLSearchParams({ fromUtc: range.fromUtc, toUtc: range.toUtc, preset: range.preset })
  if (pressKey) query.set('press', pressKey)
  return `${areaPath(area)}?${query}`
}

function App() {
  const [area, setArea] = useState<AnalyticsArea>(() => areaFromPathname(window.location.pathname))
  const [theme, setTheme] = useState<Theme>(initialTheme)
  const [range, setRange] = useState<SelectedRange>(() => routeRange() ?? createPresetRange('today'))
  const [selectedPress, setSelectedPress] = useState<RadiusPressKey | undefined>(() => pressFromLocation(window.location.pathname, window.location.search))
  const [apiStatus, setApiStatus] = useState<ServiceStatus>('loading')
  const [telemetryStatus, setTelemetryStatus] = useState<ServiceStatus>('loading')
  const [historianStatus, setHistorianStatus] = useState<ServiceStatus>('loading')
  const [radiusStatus, setRadiusStatus] = useState<ServiceStatus>('loading')
  const [radiusReason, setRadiusReason] = useState<string>()
  const [overview, setOverview] = useState<RadiusOverviewModel>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const radiusDataArea = area === 'overview' || area === 'machine-intelligence' || area === 'stop-intelligence' || area === 'raw-radius-explorer' || area === 'telemetry-event-explorer'

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
      setSelectedPress(pressFromLocation(window.location.pathname, window.location.search))
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
    if (area !== 'overview') return
    let active = true
    const controller = new AbortController()
    setLoading(true)
    setError(undefined)
    void getRadiusOverview(range.fromUtc, range.toUtc, true, controller.signal).then((result) => { if (active) setOverview(result) }).catch(() => {
      if (!active) return
      setError(radiusReason === 'not_configured'
        ? 'Radius data is unavailable until a dedicated SELECT-only database login and verified live mappings are configured.'
        : 'Radius operational data could not be loaded for this range.')
    }).finally(() => active && setLoading(false))
    return () => { active = false; controller.abort() }
  }, [area, range, radiusReason])

  function navigateArea(nextArea: AnalyticsArea) {
    window.history.pushState({}, '', routeUrl(nextArea, range, selectedPress))
    setArea(nextArea)
    window.scrollTo({ top: 0 })
  }

  function selectPressScope(pressKey: RadiusPressKey | undefined) {
    window.history.pushState({}, '', routeUrl(area, range, pressKey))
    setSelectedPress(pressKey)
  }

  function changeRange(nextRange: SelectedRange) {
    window.history.replaceState({}, '', routeUrl(area, nextRange, selectedPress))
    setRange(nextRange)
  }

  const selectedScopeLabel = selectedPress ? selectedPress.replace('press', 'Press ') : `All ${overview?.presses.length ?? 0} presses`
  const dataStatus = radiusStatus === 'healthy' ? 'healthy' : radiusStatus === 'loading' ? 'loading' : 'unavailable'
  const context = <>
    <div className="context-summary"><div><span>Operational intelligence</span><strong>Process Intelligence</strong><small>{selectedScopeLabel}</small></div><span className={`data-health data-health--${dataStatus}`} role="status"><i aria-hidden="true" />{dataStatus === 'healthy' ? 'Radius data healthy' : dataStatus === 'loading' ? 'Checking Radius data' : 'Radius data unavailable'}</span></div>
    <div className="filter-groups">
      <section className="filter-group filter-group--time" aria-labelledby="time-filter-title"><div className="filter-group-heading"><span id="time-filter-title">Time range</span><small>Choose the period to analyze</small></div><RangeControls range={range} onChange={changeRange} /></section>
      {overview && <section className="filter-group filter-group--press" aria-labelledby="press-filter-title"><div className="filter-group-heading"><span id="press-filter-title">Press selection</span><small>Compare the fleet or focus on one press</small></div><PressFilterBar presses={overview.presses} selectedPress={selectedPress} onSelect={selectPressScope} onClear={() => selectPressScope(undefined)} /></section>}
    </div>
  </>

  const administrationContext = <div className="context-summary administration-context"><div><span>Administration</span><strong>Radius semantics</strong><small>Published mappings govern Operations views; Raw Radius evidence remains unchanged.</small></div><span className="data-health data-health--healthy" role="status"><i aria-hidden="true" />Versioned configuration</span></div>
  const rawExplorerContext = <div className="context-summary search-context"><div><span>Engineering evidence</span><strong>Raw Radius Code Explorer</strong><small>Exact recorded Radius states and synchronized telemetry.</small></div><span className={`data-health data-health--${dataStatus}`} role="status"><i aria-hidden="true" />{dataStatus === 'healthy' ? 'Evidence services healthy' : dataStatus === 'loading' ? 'Checking evidence services' : 'Evidence services unavailable'}</span></div>
  const telemetryEventContext = <div className="context-summary search-context"><div><span>Find telemetry behavior</span><strong>Telemetry Event Explorer</strong><small>Threshold and change occurrences with synchronized Radius context.</small></div><span className={`data-health data-health--${dataStatus}`} role="status"><i aria-hidden="true" />{dataStatus === 'healthy' ? 'Evidence services healthy' : dataStatus === 'loading' ? 'Checking evidence services' : 'Evidence services unavailable'}</span></div>
  const machineIntelligenceContext = <div className="context-summary search-context"><div><span>Unified fleet evidence</span><strong>Machine Intelligence</strong><small>Telemetry-led performance with operator review, recipe history, rolls, and Radius context.</small></div><span className={`data-health data-health--${dataStatus}`} role="status"><i aria-hidden="true" />{dataStatus === 'healthy' ? 'Read-only evidence healthy' : dataStatus === 'loading' ? 'Checking evidence services' : 'Evidence services unavailable'}</span></div>
  const stopIntelligenceContext = <div className="context-summary search-context"><div><span>Read-only stop investigation</span><strong>Stop Intelligence</strong><small>Physical behavior · classification evidence · Radius alignment.</small></div><span className={`data-health data-health--${dataStatus}`} role="status"><i aria-hidden="true" />{dataStatus === 'healthy' ? 'Read-only evidence healthy' : dataStatus === 'loading' ? 'Checking evidence services' : 'Evidence services unavailable'}</span></div>
  const footer = <details className="system-status-drawer"><summary>System and dependency health</summary><SystemStatus items={[
    { label: 'ProcessIntelligence API', status: apiStatus },
    { label: 'Radius database', status: radiusStatus, detail: radiusReason },
    { label: 'TelemetryQueryApi', status: telemetryStatus },
    { label: 'Telemetry historian', status: historianStatus },
  ]} /></details>

  return <ApplicationShell area={area} theme={theme} onNavigate={navigateArea} onToggleTheme={toggleTheme} context={area === 'state-classification' ? administrationContext : area === 'raw-radius-explorer' ? rawExplorerContext : area === 'telemetry-event-explorer' ? telemetryEventContext : area === 'machine-intelligence' ? machineIntelligenceContext : area === 'stop-intelligence' ? stopIntelligenceContext : context} footer={footer}>
    {area === 'overview' && loading && !overview && <section className="panel loading-panel" role="status">Loading Radius operations…</section>}
    {area === 'overview' && loading && overview && <span className="background-refresh-status" role="status">Updating the selected time range; current results remain visible.</span>}
    {area === 'overview' && error && !overview && <section className="panel unavailable-panel"><h1>Radius data unavailable</h1><p>{error}</p><p>Dependency health remains available below.</p></section>}
    {area === 'overview' && error && overview && <div className="scope-progress scope-progress--error" role="alert">{error} Previous results remain visible.</div>}
    {overview && area === 'overview' && <OverviewPage overview={overview} selectedPress={selectedPress} />}
    {area === 'raw-radius-explorer' && <RawRadiusExplorerPage />}
    {area === 'telemetry-event-explorer' && <TelemetryEventExplorerPage />}
    {area === 'machine-intelligence' && <MachineIntelligencePage />}
    {area === 'stop-intelligence' && <StopIntelligencePage range={range} selectedPress={selectedPress} onRangeChange={changeRange} onPressChange={selectPressScope} />}
    {area === 'state-classification' && <StateClassificationPage />}
  </ApplicationShell>
}

export default App
