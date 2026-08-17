import type { RadiusPressKey } from './types/api'

export type AnalyticsArea = 'overview' | 'operational-analysis' | 'raw-radius-explorer' | 'telemetry-event-explorer' | 'patterns-episodes' | 'intelligent-search' | 'state-classification'
export type OperationalSection = 'state' | 'drivers' | 'recovery'

const pressKeys = new Set<RadiusPressKey>([
  'press3', 'press5', 'press6', 'press7', 'press8', 'press9',
  'press10', 'press11', 'press12', 'press13', 'press14', 'press15',
])

export function areaFromPathname(pathname: string): AnalyticsArea {
  if (/^\/operational-analysis\/?$/.test(pathname)) return 'operational-analysis'
  if (/^\/raw-radius-explorer\/?$/.test(pathname)) return 'raw-radius-explorer'
  if (/^\/telemetry-event-explorer\/?$/.test(pathname)) return 'telemetry-event-explorer'
  if (/^\/patterns-episodes\/?$/.test(pathname)) return 'patterns-episodes'
  if (/^\/intelligent-search\/?$/.test(pathname)) return 'intelligent-search'
  if (/^\/administration\/state-classification\/?$/.test(pathname)) return 'state-classification'
  return 'overview'
}

export function areaPath(area: AnalyticsArea): string {
  if (area === 'operational-analysis') return '/operational-analysis'
  if (area === 'raw-radius-explorer') return '/raw-radius-explorer'
  if (area === 'telemetry-event-explorer') return '/telemetry-event-explorer'
  if (area === 'patterns-episodes') return '/patterns-episodes'
  if (area === 'intelligent-search') return '/intelligent-search'
  if (area === 'state-classification') return '/administration/state-classification'
  return '/overview'
}

export function pressFromLocation(pathname: string, search: string): RadiusPressKey | undefined {
  const queryPress = new URLSearchParams(search).get('press') as RadiusPressKey | null
  if (queryPress && pressKeys.has(queryPress)) return queryPress
  const legacyMatch = /^\/press\/(press(?:3|5|6|7|8|9|10|11|12|13|14|15))\/?$/.exec(pathname)
  return legacyMatch?.[1] as RadiusPressKey | undefined
}

export function operationalSectionFromSearch(search: string): OperationalSection {
  const value = new URLSearchParams(search).get('section')
  return value === 'drivers' || value === 'recovery' ? value : 'state'
}
