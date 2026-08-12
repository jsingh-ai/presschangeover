import type { TimelineCoordinateMode, TimelineEventTrack, TimelineIntervalItem, TimelineIntervalTrack } from './SynchronizedTimeline'
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
  radiusEventTrack?: TimelineEventTrack
  telemetry?: PressTelemetryEvidenceState
  selectedId?: string
  onSelect?(item: TimelineIntervalItem, track: TimelineIntervalTrack): void
}

export function UnifiedProcessTimeline({ fromUtc, toUtc, coordinateMode = 'absolute', elapsedOriginUtc, ariaLabel, radiusTrack, groupTrack, familyTrack, radiusEventTrack, telemetry, selectedId, onSelect }: UnifiedProcessTimelineProps) {
  const motionCapability = telemetry?.capabilities?.capabilities.find(({ canonicalId }) => canonicalId === 'physical.motion_state')
  const motion = motionIntervalTrack(telemetry?.motion, motionCapability)
  const speedCapability = telemetry?.capabilities?.capabilities.find(({ canonicalId }) => canonicalId === 'machine.speed.actual')
  const speed = actualSpeedTrack(telemetry?.speed, speedCapability)
  const contextEvents = contextEventTrack(telemetry?.context)
  const physicalEvents = physicalEventTrack(telemetry?.physical)
  const contextTracks = contextIntervalTracks(telemetry?.context)
  const intervalTracks = [...contextTracks, radiusTrack, groupTrack, familyTrack, ...(motion ? [motion] : [])]
  const eventTracks = [contextEvents, radiusEventTrack, physicalEvents].filter((track): track is NonNullable<typeof track> => Boolean(track))
  const trackOrder = [
    ...contextTracks.map(({ id }) => `interval:${id}`),
    ...(contextEvents ? [`event:${contextEvents.id}`] : []),
    `interval:${radiusTrack.id}`,
    ...(radiusEventTrack ? [`event:${radiusEventTrack.id}`] : []),
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
