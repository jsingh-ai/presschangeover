import { useEffect, useState } from 'react'
import { ApplicationShell } from './components/ApplicationShell'
import { areaFromPathname, areaPath, type AnalyticsArea } from './navigation'
import { oppositeTheme, resolveTheme, THEME_STORAGE_KEY, type Theme } from './theme'

function initialTheme(): Theme {
  const applied = document.documentElement.dataset.theme
  if (applied === 'light' || applied === 'dark') return applied
  return resolveTheme(null, window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false)
}

function App() {
  const [area, setArea] = useState<AnalyticsArea>(() => areaFromPathname(window.location.pathname))
  const [theme, setTheme] = useState<Theme>(initialTheme)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    document.documentElement.style.colorScheme = theme
  }, [theme])

  useEffect(() => {
    const onPopState = () => setArea(areaFromPathname(window.location.pathname))
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  function navigateArea(nextArea: AnalyticsArea) {
    window.history.pushState({}, '', areaPath(nextArea))
    setArea(nextArea)
  }

  function toggleTheme() {
    setTheme((currentTheme) => {
      const nextTheme = oppositeTheme(currentTheme)
      try { localStorage.setItem(THEME_STORAGE_KEY, nextTheme) } catch {}
      return nextTheme
    })
  }

  return <ApplicationShell area={area} theme={theme} onNavigate={navigateArea} onToggleTheme={toggleTheme} />
}

export default App
