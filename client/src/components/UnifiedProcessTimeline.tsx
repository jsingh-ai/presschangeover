import type { TimelineCoordinateMode, TimelineIntervalItem, TimelineIntervalTrack } from './SynchronizedTimeline'
import { SynchronizedTimeline } from './SynchronizedTimeline'
import { actualSpeedTrack, contextEventTrack, contextIntervalTracks, motionIntervalTrack, physicalEventTrack, type PressTelemetryEvidenceState } from './TelemetryEvidenceTimeline'

interface UnifiedProcessTimelineProps {
  fromUtc: string
  toUtc: string
  coordinateMode?: TimelineCoordinateMode
  elapsedOriginUtc?: string
  ariaLabel: string
  radiusTrack: TimelineIntervalTrack
  groupTrack: TimelineIntervalTrack
  familyTrack: TimelineIntervalTrack
  telemetry?: PressTelemetryEvidenceState
  selectedId?: string
  onSelect?(item: TimelineIntervalItem, track: TimelineIntervalTrack): void
}

export function UnifiedProcessTimeline({ fromUtc, toUtc, coordinateMode = 'absolute', elapsedOriginUtc, ariaLabel, radiusTrack, groupTrack, familyTrack, telemetry, selectedId, onSelect }: UnifiedProcessTimelineProps) {
  const motion = motionIntervalTrack(telemetry?.motion)
  const speedCapability = telemetry?.capabilities?.capabilities.find(({ canonicalId }) => canonicalId === 'machine.speed.actual')
  const speed = actualSpeedTrack(telemetry?.speed, speedCapability)
  const contextEvents = contextEventTrack(telemetry?.context)
  const physicalEvents = physicalEventTrack(telemetry?.physical)
  const contextTracks = contextIntervalTracks(telemetry?.context)
  const intervalTracks = [...contextTracks, radiusTrack, groupTrack, familyTrack, ...(motion ? [motion] : [])]
  const eventTracks = [contextEvents, physicalEvents].filter((track): track is NonNullable<typeof track> => Boolean(track))
  const trackOrder = [
    ...contextTracks.map(({ id }) => `interval:${id}`),
    ...(contextEvents ? [`event:${contextEvents.id}`] : []),
    `interval:${radiusTrack.id}`,
    `interval:${groupTrack.id}`,
    `interval:${familyTrack.id}`,
    ...(motion ? [`interval:${motion.id}`] : []),
    ...(speed ? [`numeric:${speed.id}`] : []),
    ...(physicalEvents ? [`event:${physicalEvents.id}`] : []),
  ]
  return <SynchronizedTimeline
    fromUtc={fromUtc}
    toUtc={toUtc}
    coordinateMode={coordinateMode}
    elapsedOriginUtc={elapsedOriginUtc}
    ariaLabel={ariaLabel}
    selectedId={selectedId}
    intervalTracks={intervalTracks}
    numericTracks={speed ? [speed] : []}
    eventTracks={eventTracks}
    trackOrder={trackOrder}
    onSelect={onSelect}
  />
}
