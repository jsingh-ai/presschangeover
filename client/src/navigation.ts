export type AnalyticsArea =
  | 'overview'
  | 'operational-analysis'
  | 'raw-radius-explorer'
  | 'telemetry-event-explorer'
  | 'patterns-episodes'
  | 'intelligent-search'
  | 'state-classification'

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
  if (area === 'state-classification') return '/administration/state-classification'
  return area === 'overview' ? '/overview' : `/${area}`
}
