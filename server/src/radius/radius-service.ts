import {
  clipSegmentsToRange,
  deriveOperationalEpisodes,
  PRODUCTION_CONFIRMATION_MS,
} from '../episodes/episode-engine.js'
import {
  buildRadiusAvailabilityTimeline,
  deriveCurrentRadiusAvailability,
  deriveRadiusFeedStatus,
  deriveRadiusFeedStatusFromPoll,
  summarizeAvailabilityMetrics,
} from './availability-engine.js'
import type { EnabledRadiusConfig } from '../config.js'
import type {
  OperationalEpisode,
  RadiusHealth,
  RadiusObservation,
  RadiusCurrentState,
  RadiusOverview,
  RadiusPressKey,
  RadiusPressMapping,
  RadiusPollRun,
  RadiusStatusSegment,
  RawRadiusTimeline,
} from './models.js'
import { RADIUS_PRESS_KEYS } from './models.js'
import { RadiusRepository, type RadiusExactIdentity, type RadiusIdentityHistoryResult } from './radius-repository.js'
import {
  qualifyStateBreakdownRuns,
  STATE_BREAKDOWN_RUN_CONFIRMATION_SECONDS,
} from './state-breakdown.js'
import type { ObservedRadiusIdentity } from '../classification/models.js'

const EPISODE_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1_000
const CURRENT_RANGE_TOLERANCE_MS = 10_000

export class RadiusUnavailableError extends Error {
  constructor() {
    super('Radius is unavailable')
    this.name = 'RadiusUnavailableError'
  }
}

export class RadiusNotFoundError extends Error {
  constructor() {
    super('Radius resource was not found')
    this.name = 'RadiusNotFoundError'
  }
}

export interface RadiusService {
  getHealth(): Promise<RadiusHealth>
  getOverview(fromUtc: string, toUtc: string): Promise<RadiusOverview>
  getObservedIdentities?(): Promise<ObservedRadiusIdentity[]>
  getRawTimeline?(pressKey: RadiusPressKey, fromUtc: string, toUtc: string): Promise<RawRadiusTimeline>
  getExactIdentityHistory?(input: { pressKey: RadiusPressKey; fromUtc: string; toUtc: string; identity: RadiusExactIdentity; maximumOccurrences: number }): Promise<RadiusIdentityHistoryResult>
}

export class UnavailableRadiusService implements RadiusService {
  async getHealth(): Promise<RadiusHealth> {
    return { status: 'unavailable', configured: false, reason: 'not_configured' }
  }

  async getOverview(): Promise<RadiusOverview> {
    throw new RadiusUnavailableError()
  }

  async getObservedIdentities(): Promise<ObservedRadiusIdentity[]> {
    throw new RadiusUnavailableError()
  }

  async getRawTimeline(): Promise<RawRadiusTimeline> {
    throw new RadiusUnavailableError()
  }

  async getExactIdentityHistory(): Promise<RadiusIdentityHistoryResult> {
    throw new RadiusUnavailableError()
  }
}

interface PressData {
  mapping: RadiusPressMapping
  segments: RadiusStatusSegment[]
  visibleSegments: RadiusStatusSegment[]
  episodes: OperationalEpisode[]
  availability: 'online' | 'offline'
  lastRadiusStatus: {
    eventType: string
    statusCode: string | null
    statusDescription: string
    observedAtUtc: string
  } | null
  lastObservationUtc: string | null
  offlineSinceUtc: string | null
  currentStatusDescription: string | null
  currentEventType: string | null
  currentStatusAtUtc: string | null
  isCurrentlyProduction: boolean | null
  rangeEndIsLive: boolean
  latestPollRun: RadiusPollRun | undefined
}

function episodeSummary(episodes: OperationalEpisode[]) {
  const total = episodes.reduce(
    (sum, episode) => sum + episode.durationSeconds,
    0,
  )
  return {
    episodeCount: episodes.length,
    openEpisodeCount: episodes.filter(({ isOpen }) => isOpen).length,
    averageEpisodeSeconds: episodes.length === 0 ? 0 : total / episodes.length,
    longestEpisodeSeconds: Math.max(
      0,
      ...episodes.map(({ durationSeconds }) => durationSeconds),
    ),
  }
}

export class DatabaseRadiusService implements RadiusService {
  private readonly mappings = new Map<RadiusPressKey, RadiusPressMapping>()

  constructor(
    private readonly repository: RadiusRepository,
    private readonly config: EnabledRadiusConfig,
    private readonly plantTimeZone: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    for (const mapping of config.mappings) {
      this.mappings.set(mapping.pressKey, mapping)
    }
  }

  private async assertSafeAccess() {
    const access = await this.repository.assessAccess()
    if (!access.databaseMatches || !access.schemaMatches) {
      throw new RadiusUnavailableError()
    }
    if (
      !access.canConnect ||
      !access.canUseSchema ||
      !access.canSelect ||
      access.hasWritePrivilege ||
      access.hasCreatePrivilege ||
      access.elevatedRole
    ) {
      throw new RadiusUnavailableError()
    }
  }

  async getHealth(): Promise<RadiusHealth> {
    try {
      const access = await this.repository.assessAccess()
      if (!access.schemaMatches || !access.databaseMatches) {
        return {
          status: 'unavailable',
          configured: true,
          database: this.config.database,
          schema: this.config.schema,
          table: this.config.table,
          tables: [this.config.table, this.config.eventsTable, this.config.pollRunsTable, this.config.currentTable],
          reason: 'schema_mismatch',
        }
      }
      if (
        !access.canConnect ||
        !access.canUseSchema ||
        !access.canSelect ||
        access.hasWritePrivilege ||
        access.hasCreatePrivilege ||
        access.elevatedRole
      ) {
        return {
          status: 'unavailable',
          configured: true,
          database: this.config.database,
          schema: this.config.schema,
          table: this.config.table,
          tables: [this.config.table, this.config.eventsTable, this.config.pollRunsTable, this.config.currentTable],
          reason: 'unsafe_privileges',
        }
      }
      return {
        status: 'healthy',
        configured: true,
        database: this.config.database,
        schema: this.config.schema,
        table: this.config.table,
        tables: [this.config.table, this.config.eventsTable, this.config.pollRunsTable, this.config.currentTable],
      }
    } catch {
      return {
        status: 'unavailable',
        configured: true,
        database: this.config.database,
        schema: this.config.schema,
        table: this.config.table,
        tables: [this.config.table, this.config.eventsTable, this.config.pollRunsTable, this.config.currentTable],
        reason: 'connection_failed',
      }
    }
  }

  async getObservedIdentities(): Promise<ObservedRadiusIdentity[]> {
    await this.assertSafeAccess()
    return this.repository.getObservedIdentities()
  }

  async getRawTimeline(pressKey: RadiusPressKey, fromUtc: string, toUtc: string): Promise<RawRadiusTimeline> {
    await this.assertSafeAccess()
    const mapping = this.requireMapping(pressKey)
    const data = await this.loadPressData(mapping, fromUtc, toUtc)
    return { pressKey, displayName: mapping.displayName, fromUtc, toUtc, segments: data.visibleSegments }
  }

  async getExactIdentityHistory(input: { pressKey: RadiusPressKey; fromUtc: string; toUtc: string; identity: RadiusExactIdentity; maximumOccurrences: number }): Promise<RadiusIdentityHistoryResult> {
    await this.assertSafeAccess()
    const mapping = this.requireMapping(input.pressKey)
    const result = await this.repository.getExactIdentityHistory({
      machineId: mapping.machineId,
      fromUtc: input.fromUtc,
      toUtc: input.toUtc,
      identity: input.identity,
      maximumOccurrences: input.maximumOccurrences,
    })
    return { ...result, queryCount: result.queryCount + 2 }
  }

  private requireMapping(pressKey: RadiusPressKey): RadiusPressMapping {
    const mapping = this.mappings.get(pressKey)
    if (!mapping) throw new RadiusNotFoundError()
    return mapping
  }

  private contextBounds(fromUtc: string, toUtc: string) {
    const fromMs = Date.parse(fromUtc)
    const toMs = Date.parse(toUtc)
    const nowMs = this.now().getTime()
    return {
      fromMs,
      toMs,
      nowMs,
      contextFromUtc: new Date(fromMs - EPISODE_LOOKBACK_MS).toISOString(),
      seedLookbackFromUtc: new Date(
        fromMs - 2 * EPISODE_LOOKBACK_MS,
      ).toISOString(),
      contextToUtc: new Date(
        toMs < nowMs - CURRENT_RANGE_TOLERANCE_MS
          ? toMs + PRODUCTION_CONFIRMATION_MS + 1
          : toMs,
      ).toISOString(),
    }
  }

  private async loadPressData(
    mapping: RadiusPressMapping,
    fromUtc: string,
    toUtc: string,
    sharedPollRuns?: RadiusPollRun[],
    sharedCurrentState?: RadiusCurrentState | null,
    sharedObservations?: RadiusObservation[],
  ): Promise<PressData> {
    const {
      toMs,
      nowMs,
      contextFromUtc,
      contextToUtc,
      seedLookbackFromUtc,
    } = this.contextBounds(fromUtc, toUtc)
    const [observations, pollRuns, queriedCurrentStates] = await Promise.all([
      sharedObservations
        ? Promise.resolve(sharedObservations)
        : this.repository.getObservations(
            mapping.machineId,
            contextFromUtc,
            contextToUtc,
            seedLookbackFromUtc,
          ),
      sharedPollRuns
        ? Promise.resolve(sharedPollRuns)
        : this.repository.getPollRuns(contextFromUtc, contextToUtc),
      sharedCurrentState !== undefined
        ? Promise.resolve([] as RadiusCurrentState[])
        : this.repository.getCurrentStates([mapping.machineId]),
    ])
    const currentState =
      sharedCurrentState === undefined
        ? queriedCurrentStates[0] ?? null
        : sharedCurrentState
    const legacyHeartbeats = observations
      .filter(
        ({ fetchedAtUtc }) =>
          Date.parse(fetchedAtUtc) < Date.parse(this.config.effectiveCutoverUtc),
      )
      .map(({ fetchedAtUtc }) => ({ fetchedAtUtc }))
    const heartbeats = [...legacyHeartbeats, ...pollRuns].sort(
      (left, right) =>
        Date.parse(left.fetchedAtUtc) - Date.parse(right.fetchedAtUtc),
    )
    const segments = buildRadiusAvailabilityTimeline(
      observations,
      mapping,
      this.config.productionStatusDescription,
      contextFromUtc,
      contextToUtc,
      this.config.staleSeconds,
      heartbeats,
      toMs >= nowMs - CURRENT_RANGE_TOLERANCE_MS,
      this.config.productionEventType,
    )
    const visibleSegments = clipSegmentsToRange(
      qualifyStateBreakdownRuns(segments),
      fromUtc,
      toUtc,
    )
    const episodes = deriveOperationalEpisodes(
      segments,
      mapping,
      fromUtc,
      toUtc,
    )
    const latestPollRun = [...pollRuns]
      .filter((pollRun) => Date.parse(pollRun.fetchedAtUtc) <= toMs)
      .sort(
        (left, right) =>
          Date.parse(right.fetchedAtUtc) - Date.parse(left.fetchedAtUtc),
      )[0]
    const latestHeartbeatUtc = [...heartbeats]
      .filter((heartbeat) => Date.parse(heartbeat.fetchedAtUtc) <= toMs)
      .at(-1)?.fetchedAtUtc ?? null
    const useCurrentState = toMs >= nowMs - CURRENT_RANGE_TOLERANCE_MS
    const current = deriveCurrentRadiusAvailability(
      observations,
      toUtc,
      fromUtc,
      this.config.staleSeconds,
      this.config.productionStatusDescription,
      latestHeartbeatUtc,
      useCurrentState ? currentState : null,
      useCurrentState ? currentState?.isPresent === true : true,
      this.config.productionEventType,
    )
    return {
      mapping,
      segments,
      visibleSegments,
      episodes,
      ...current,
      rangeEndIsLive: useCurrentState,
      latestPollRun,
    }
  }

  private async loadMappedPressData(
    mappings: RadiusPressMapping[],
    fromUtc: string,
    toUtc: string,
    sharedPollRuns: RadiusPollRun[],
    currentByMachine: Map<number, RadiusCurrentState>,
    observationsByMachine?: Map<number, RadiusObservation[]>,
  ): Promise<PressData[]> {
    return Promise.all(mappings.map((mapping) => this.loadPressData(
        mapping,
        fromUtc,
        toUtc,
        sharedPollRuns,
        currentByMachine.get(mapping.machineId) ?? null,
        observationsByMachine?.get(mapping.machineId),
      )))
  }

  async getOverview(fromUtc: string, toUtc: string): Promise<RadiusOverview> {
    const { contextFromUtc, contextToUtc } = this.contextBounds(fromUtc, toUtc)
    return this.getOverviewWithinContext(fromUtc, toUtc, contextFromUtc, contextToUtc)
  }

  private async getOverviewWithinContext(
    fromUtc: string,
    toUtc: string,
    contextFromUtc: string,
    contextToUtc: string,
  ): Promise<RadiusOverview> {
    await this.assertSafeAccess()
    const mappings = [...this.mappings.values()]
    const [sharedPollRuns, currentStates, observationsByMachine] = await Promise.all([
      this.repository.getPollRuns(contextFromUtc, contextToUtc),
      this.repository.getCurrentStates(
        mappings.map(({ machineId }) => machineId),
      ),
      this.repository.getObservationsForMachines(
        mappings.map(({ machineId }) => machineId),
        contextFromUtc,
        contextToUtc,
      ),
    ])
    const currentByMachine = new Map(
      currentStates.map((state) => [state.machineId, state]),
    )
    const pressData = await this.loadMappedPressData(mappings, fromUtc, toUtc, sharedPollRuns, currentByMachine, observationsByMachine)
    const rangeSeconds = (Date.parse(toUtc) - Date.parse(fromUtc)) / 1_000
    const presses = pressData.map(
      ({
        mapping,
        visibleSegments,
        episodes,
        availability,
        lastRadiusStatus,
        lastObservationUtc,
        offlineSinceUtc,
        currentStatusDescription,
        currentEventType,
        currentStatusAtUtc,
        isCurrentlyProduction,
      }) => ({
        pressKey: mapping.pressKey,
        displayName: mapping.displayName,
        radiusMachineId: mapping.machineId,
        availability,
        lastRadiusStatus,
        lastObservationUtc,
        offlineSinceUtc,
        currentStatusDescription,
        currentEventType,
        currentStatusAtUtc,
        isCurrentlyProduction,
        ...summarizeAvailabilityMetrics(visibleSegments, rangeSeconds),
        episodeCount: episodes.length,
        openEpisodeCount: episodes.filter(({ isOpen }) => isOpen).length,
        longestEpisodeSeconds: Math.max(
          0,
          ...episodes.map(({ durationSeconds }) => durationSeconds),
        ),
        timelineSegments: visibleSegments,
      }),
    )
    const onlinePressCount = presses.filter(
      ({ availability }) => availability === 'online',
    ).length
    const offlinePressCount = presses.length - onlinePressCount
    const lastObservationUtc = presses
      .map((press) => press.lastObservationUtc)
      .filter((value): value is string => value !== null)
      .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null

    return {
      fromUtc,
      toUtc,
      plantTimeZone: this.plantTimeZone,
      productionStatusDescription: this.config.productionStatusDescription,
      stateBreakdownRunConfirmationSeconds: STATE_BREAKDOWN_RUN_CONFIRMATION_SECONDS,
      rangeEndIsLive: pressData[0]?.rangeEndIsLive ?? false,
      feedStatus:
        Date.parse(toUtc) < Date.parse(this.config.effectiveCutoverUtc)
          ? deriveRadiusFeedStatus(
              presses.map(({ availability }) => availability),
            )
          : deriveRadiusFeedStatusFromPoll(
              pressData[0]?.latestPollRun,
              toUtc,
              this.config.staleSeconds,
              this.config.expectedMachineCount,
            ),
      lastObservationUtc,
      offlinePressCount,
      onlinePressCount,
      summary: {
        pressesMonitored: presses.length,
        currentlyRunProduction: presses.filter(
          ({ isCurrentlyProduction }) => isCurrentlyProduction === true,
        ).length,
        currentlyNonProduction: presses.filter(
          ({ isCurrentlyProduction }) => isCurrentlyProduction === false,
        ).length,
        openEpisodes: presses.reduce(
          (total, press) => total + press.openEpisodeCount,
          0,
        ),
        totalNonProductionSeconds: presses.reduce(
          (total, press) => total + press.nonProductionSeconds,
          0,
        ),
      },
      unmappedPressKeys: RADIUS_PRESS_KEYS.filter(
        (pressKey) => !this.mappings.has(pressKey),
      ),
      presses,
    }
  }

}
