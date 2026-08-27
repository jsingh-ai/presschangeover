import React, { useState, type ReactNode } from 'react'
import type { AnalyticsArea } from '../navigation'
import type { Theme } from '../theme'

interface Props {
  area: AnalyticsArea
  theme: Theme
  onNavigate(area: AnalyticsArea): void
  onToggleTheme(): void
  context: ReactNode
  children: ReactNode
  footer: ReactNode
}

const navigation: Array<{ area: AnalyticsArea; label: string; description: string; icon: ReactNode }> = [
  { area: 'overview', label: 'Overview', description: 'Signals and priorities', icon: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 13h6V4H4v9Zm0 7h6v-4H4v4Zm10 0h6v-9h-6v9Zm0-16v4h6V4h-6Z" /></svg> },
  { area: 'job-intelligence', label: 'Job Intelligence', description: 'Products, presses, and changeovers', icon: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v4H4V5Zm0 6h10v4H4v-4Zm0 6h7v3H4v-3Zm13-5 3 3-3 3m-3-3h6" /></svg> },
  { area: 'stop-intelligence', label: 'Stop Intelligence', description: 'Physical stop foundation', icon: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h11m-3-3 3 3-3 3m8 7H9m3-3-3 3 3 3M4 12h16" /></svg> },
  { area: 'operational-analysis', label: 'Operational Analysis', description: 'Time and drivers', icon: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3v18M5 17h15M8 14l3-4 3 2 5-7" /></svg> },
  { area: 'raw-radius-explorer', label: 'Raw Radius Explorer', description: 'Codes and telemetry', icon: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h7M4 18h16M15 9l3 3-3 3" /></svg> },
  { area: 'telemetry-event-explorer', label: 'Telemetry Event Explorer', description: 'Thresholds and changes', icon: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 17h3l2-9 3 12 3-15 2 12h5M4 4v16h16" /></svg> },
  { area: 'patterns-episodes', label: 'Patterns & Episodes', description: 'Behavior and evidence', icon: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h5l2 3h9M4 17h5l2-3h9M17 7l3 3-3 3" /></svg> },
  { area: 'intelligent-search', label: 'Intelligent Search', description: 'Find work, codes, and patterns', icon: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15.5 15.5 4 4M10.5 17a6.5 6.5 0 1 1 0-13 6.5 6.5 0 0 1 0 13Zm-3-6.5h6M10.5 7.5v6" /></svg> },
  { area: 'state-classification', label: 'State Classification', description: 'Administration', icon: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h10M4 12h16M4 19h12M17 3v4M8 10v4M18 17v4" /></svg> },
]

const MAIN_SIDEBAR_STORAGE_KEY = 'process-intelligence-sidebar-collapsed'

export function ApplicationShell({ area, theme, onNavigate, onToggleTheme, context, children, footer }: Props) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    if (typeof window === 'undefined') return false
    try { return window.localStorage.getItem(MAIN_SIDEBAR_STORAGE_KEY) === 'true' } catch { return false }
  })

  function toggleSidebar() {
    setSidebarCollapsed((current) => {
      const next = !current
      try { window.localStorage.setItem(MAIN_SIDEBAR_STORAGE_KEY, String(next)) } catch {}
      return next
    })
  }

  return <div className={`application-shell${sidebarCollapsed ? ' is-main-sidebar-collapsed' : ''}`}>
    <aside className="app-sidebar" aria-label="Primary navigation">
      <div className="sidebar-brand"><span className="brand-mark" aria-hidden="true">PI</span><div><strong>Process Intelligence</strong><small>Radius operations</small></div><button type="button" className="sidebar-collapse-toggle" onClick={toggleSidebar} aria-label={sidebarCollapsed ? 'Show main navigation' : 'Hide main navigation'} aria-expanded={!sidebarCollapsed} title={sidebarCollapsed ? 'Show navigation' : 'Hide navigation'}><svg viewBox="0 0 24 24" aria-hidden="true">{sidebarCollapsed ? <path d="M4 4v16m6-14 6 6-6 6" /> : <path d="M20 4v16M14 6l-6 6 6 6" />}</svg></button></div>
      <nav className="primary-navigation">{navigation.map((item) => <a
        key={item.area}
        href={item.area === 'overview' ? '/overview' : item.area === 'state-classification' ? '/administration/state-classification' : `/${item.area}`}
        className={area === item.area ? 'primary-nav-link active' : 'primary-nav-link'}
        aria-current={area === item.area ? 'page' : undefined}
        title={sidebarCollapsed ? item.label : undefined}
        onClick={(event) => { event.preventDefault(); onNavigate(item.area) }}
      ><span className="nav-icon">{item.icon}</span><span><strong>{item.label}</strong><small>{item.description}</small></span></a>)}</nav>
      <div className="sidebar-footer">
        <button type="button" className="theme-toggle" onClick={onToggleTheme} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`} aria-pressed={theme === 'dark'}>
          <span aria-hidden="true">{theme === 'dark' ? '☀' : '☾'}</span><span>{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>
        </button>
        <span className="environment-badge"><i aria-hidden="true" />Production</span>
      </div>
    </aside>
    <div className="app-workspace">
      <header className="context-header">{context}</header>
      <main className="workspace-content" id="main-content">{children}</main>
      <footer className="workspace-footer">{footer}</footer>
    </div>
  </div>
}
