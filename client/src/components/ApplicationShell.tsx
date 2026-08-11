import React, { type ReactNode } from 'react'
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
  { area: 'operational-analysis', label: 'Operational Analysis', description: 'Time and drivers', icon: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3v18M5 17h15M8 14l3-4 3 2 5-7" /></svg> },
  { area: 'patterns-episodes', label: 'Patterns & Episodes', description: 'Behavior and evidence', icon: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h5l2 3h9M4 17h5l2-3h9M17 7l3 3-3 3" /></svg> },
  { area: 'state-classification', label: 'State Classification', description: 'Administration', icon: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h10M4 12h16M4 19h12M17 3v4M8 10v4M18 17v4" /></svg> },
]

export function ApplicationShell({ area, theme, onNavigate, onToggleTheme, context, children, footer }: Props) {
  return <div className="application-shell">
    <aside className="app-sidebar" aria-label="Primary navigation">
      <div className="sidebar-brand"><span className="brand-mark" aria-hidden="true">PI</span><div><strong>Process Intelligence</strong><small>Radius operations</small></div></div>
      <nav className="primary-navigation">{navigation.map((item) => <a
        key={item.area}
        href={item.area === 'overview' ? '/overview' : item.area === 'state-classification' ? '/administration/state-classification' : `/${item.area}`}
        className={area === item.area ? 'primary-nav-link active' : 'primary-nav-link'}
        aria-current={area === item.area ? 'page' : undefined}
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
