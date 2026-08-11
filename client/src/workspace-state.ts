import type { SelectedRange } from './time-ranges'
import type { EpisodeAttentionItem, RadiusPressKey, RadiusPressOverview } from './types/api'
import { areaPath, type AnalyticsArea, type OperationalSection } from './navigation'

export type InvestigationRoute =
  | { mode: 'episode'; episodeId: string }
  | { mode: 'segment'; pressKey?: RadiusPressKey; startUtc: string; endUtc: string }
  | { mode: 'attention'; findingId: string }
  | { mode: 'status'; statusIdentity: string }
  | { mode: 'anomaly'; anomalyId: string }

export interface WorkspaceSelectionState {
  selectedPress?: RadiusPressKey
  investigation?: InvestigationRoute
}

export function openInvestigationState(
  state: WorkspaceSelectionState,
  pressKey: RadiusPressKey,
  investigation: InvestigationRoute,
): WorkspaceSelectionState {
  return { ...state, selectedPress: pressKey, investigation }
}

export function closeInvestigationState(state: WorkspaceSelectionState): WorkspaceSelectionState {
  return { ...state, investigation: undefined }
}

export function isDrawerHistoryState(state: unknown): boolean {
  return typeof state === 'object' && state !== null &&
    (state as { processIntelligenceDrawer?: unknown }).processIntelligenceDrawer === true
}

export function nextPressSelection(
  selectedPress: RadiusPressKey | undefined,
  clickedPress: RadiusPressKey,
): RadiusPressKey | undefined {
  return selectedPress === clickedPress ? undefined : clickedPress
}

export function visibleFleetPresses(
  presses: RadiusPressOverview[],
  selectedPress: RadiusPressKey | undefined,
): RadiusPressOverview[] {
  return selectedPress ? presses.filter(({ pressKey }) => pressKey === selectedPress) : presses
}

export function pressFilterLabel(displayName: string): string {
  return `${displayName} selected`
}

export function attentionItemsForPress(
  items: EpisodeAttentionItem[],
  selectedPress: RadiusPressKey,
): EpisodeAttentionItem[] {
  return items.filter(({ pressKey }) => pressKey === selectedPress)
}

export function investigationFromSearch(search: string): InvestigationRoute | undefined {
  const query = new URLSearchParams(search)
  const episodeId = query.get('episode')
  if (episodeId) return { mode: 'episode', episodeId }
  const findingId = query.get('finding')
  if (findingId) return { mode: 'attention', findingId }
  const statusIdentity = query.get('status')
  if (statusIdentity) return { mode: 'status', statusIdentity }
  const anomalyId = query.get('anomaly')
  if (anomalyId) return { mode: 'anomaly', anomalyId }
  const startUtc = query.get('segmentStart')
  const endUtc = query.get('segmentEnd')
  if (startUtc && endUtc && Number.isFinite(Date.parse(startUtc)) && Number.isFinite(Date.parse(endUtc))) {
    const segmentPress = query.get('segmentPress')
    return { mode: 'segment', ...(segmentPress ? { pressKey: segmentPress as RadiusPressKey } : {}), startUtc, endUtc }
  }
  return undefined
}

export function workspaceUrl(
  range: SelectedRange,
  pressKey?: RadiusPressKey,
  investigation?: InvestigationRoute,
  area: AnalyticsArea = 'overview',
  operationalSection?: OperationalSection,
): string {
  const query = new URLSearchParams({
    fromUtc: range.fromUtc,
    toUtc: range.toUtc,
    preset: range.preset,
  })
  if (pressKey) query.set('press', pressKey)
  if (area === 'operational-analysis' && operationalSection && operationalSection !== 'state') query.set('section', operationalSection)
  if (investigation?.mode === 'episode') query.set('episode', investigation.episodeId)
  if (investigation?.mode === 'attention') query.set('finding', investigation.findingId)
  if (investigation?.mode === 'status') query.set('status', investigation.statusIdentity)
  if (investigation?.mode === 'anomaly') query.set('anomaly', investigation.anomalyId)
  if (investigation?.mode === 'segment') {
    if (investigation.pressKey) query.set('segmentPress', investigation.pressKey)
    query.set('segmentStart', investigation.startUtc)
    query.set('segmentEnd', investigation.endUtc)
  }
  return `${areaPath(area)}?${query}`
}
