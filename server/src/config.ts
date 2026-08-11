import {
  RADIUS_PRESS_KEYS,
  type RadiusPressKey,
  type RadiusPressMapping,
} from './radius/models.js'

const DEFAULT_TELEMETRY_API_TIMEOUT_MS = 5_000
const MIN_TELEMETRY_API_TIMEOUT_MS = 100
const MAX_TELEMETRY_API_TIMEOUT_MS = 60_000
const DEFAULT_PLANT_TIME_ZONE = 'America/Chicago'
export const DEFAULT_RADIUS_STALE_SECONDS = 180
export const RADIUS_EFFECTIVE_CUTOVER_UTC = '2026-08-10T14:29:00.415Z'
export const RADIUS_EXPECTED_MACHINE_COUNT = 12
const MIN_RADIUS_STALE_SECONDS = 1
const MAX_RADIUS_STALE_SECONDS = 86_400

export interface TelemetryApiConfig {
  baseUrl: string
  timeoutMs: number
}

export interface ServerConfig {
  host: string
  port: number
  plantTimeZone: string
  telemetryApi: TelemetryApiConfig
  radius: RadiusConfig
  classificationDatabase: AppDatabaseConfig
  classificationAuthorization: ClassificationAuthorizationConfig
}

export type AppDatabaseConfig =
  | { enabled: false }
  | { enabled: true; host: '127.0.0.1' | 'localhost'; port: number; database: 'processintelligence_db'; user: 'processintelligence_app'; password: string; schema: 'process_intelligence' }

export interface ClassificationAuthorizationConfig {
  trustedProxy: boolean
  adminActors: string[]
}

export type RadiusTimestampMode = 'timestamptz' | 'plant_local_timestamp'

export interface DisabledRadiusConfig {
  enabled: false
  staleSeconds: number
}

export interface EnabledRadiusConfig {
  enabled: true
  host: '127.0.0.1' | 'localhost'
  port: number
  database: 'press_radius_db'
  user: string
  password: string
  schema: string
  table: string
  currentTable: 'machine_status_current'
  eventsTable: 'machine_status_events'
  pollRunsTable: 'machine_status_poll_runs'
  timestampMode: RadiusTimestampMode
  effectiveCutoverUtc: string
  expectedMachineCount: number
  productionEventType: 'G'
  productionStatusDescription: string
  staleSeconds: number
  mappings: RadiusPressMapping[]
}

export type RadiusConfig = DisabledRadiusConfig | EnabledRadiusConfig

function parseBaseUrl(value: string): string {
  let parsed: URL

  try {
    parsed = new URL(value)
  } catch {
    throw new Error('TELEMETRY_API_BASE_URL must be a valid URL')
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('TELEMETRY_API_BASE_URL must use http or https')
  }

  if (!parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('TELEMETRY_API_BASE_URL must be an HTTP origin or base path without credentials, query, or fragment')
  }

  return parsed.toString().replace(/\/$/, '')
}

function requireBaseUrl(value: string | undefined): string {
  if (value === undefined || value.trim() === '') {
    throw new Error('TELEMETRY_API_BASE_URL is required')
  }
  return parseBaseUrl(value)
}

function parseTimeout(value: string | undefined): number {
  if (value === undefined || value.trim() === '') {
    return DEFAULT_TELEMETRY_API_TIMEOUT_MS
  }

  const timeoutMs = Number(value)
  if (
    !Number.isFinite(timeoutMs) ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < MIN_TELEMETRY_API_TIMEOUT_MS ||
    timeoutMs > MAX_TELEMETRY_API_TIMEOUT_MS
  ) {
    throw new Error(
      `TELEMETRY_API_TIMEOUT_MS must be an integer between ${MIN_TELEMETRY_API_TIMEOUT_MS} and ${MAX_TELEMETRY_API_TIMEOUT_MS}`,
    )
  }

  return timeoutMs
}

function parsePort(value: string | undefined): number {
  const port = value === undefined || value.trim() === '' ? 3001 : Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be an integer between 1 and 65535')
  }

  return port
}

function parseHost(value: string | undefined): string {
  const host = value === undefined || value.trim() === '' ? 'localhost' : value.trim()
  if (
    host.length > 253 ||
    !/^[A-Za-z0-9.:-]+$/.test(host) ||
    host.includes('..')
  ) {
    throw new Error('HOST must be a valid hostname or IP address')
  }

  return host
}

function parseTimeZone(value: string | undefined): string {
  const timeZone = value?.trim() || DEFAULT_PLANT_TIME_ZONE
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format()
  } catch {
    throw new Error('PLANT_TIME_ZONE must be a valid IANA timezone')
  }
  return timeZone
}

function requireRadiusValue(
  environment: NodeJS.ProcessEnv,
  name: string,
): string {
  const value = environment[name]?.trim()
  if (!value) throw new Error(`${name} is required when Radius is configured`)
  return value
}

function parseRadiusIdentifier(value: string, name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`${name} must be a simple PostgreSQL identifier`)
  }
  return value
}

function pressDisplayName(pressKey: RadiusPressKey): string {
  return `Press ${pressKey.slice('press'.length)}`
}

function parseRadiusMappings(value: string): RadiusPressMapping[] {
  const mappings = value.split(',').map((entry) => {
    const match = /^(press\d+):(\d+)$/.exec(entry.trim())
    if (!match || !RADIUS_PRESS_KEYS.includes(match[1] as RadiusPressKey)) {
      throw new Error(
        'RADIUS_PRESS_MAPPINGS must contain verified pressKey:machineId pairs',
      )
    }
    const pressKey = match[1] as RadiusPressKey
    const machineId = Number(match[2])
    if (!Number.isSafeInteger(machineId) || machineId <= 0) {
      throw new Error('RADIUS_PRESS_MAPPINGS machine IDs must be positive integers')
    }
    return { pressKey, displayName: pressDisplayName(pressKey), machineId }
  })

  const pressKeys = new Set(mappings.map(({ pressKey }) => pressKey))
  const machineIds = new Set(mappings.map(({ machineId }) => machineId))
  if (pressKeys.size !== mappings.length || machineIds.size !== mappings.length) {
    throw new Error('RADIUS_PRESS_MAPPINGS must not contain duplicate presses or machine IDs')
  }
  const sortedMappings = mappings.sort(
    (left, right) =>
      Number(left.pressKey.slice(5)) - Number(right.pressKey.slice(5)),
  )
  const verifiedMappings = new Map<RadiusPressKey, number>([
    ['press3', 203], ['press5', 205], ['press6', 206],
    ['press7', 207], ['press8', 208], ['press9', 209],
    ['press10', 210], ['press11', 211], ['press12', 212],
    ['press13', 213], ['press14', 214], ['press15', 215],
  ])
  if (
    sortedMappings.length !== verifiedMappings.size ||
    sortedMappings.some(
      ({ pressKey, machineId }) => verifiedMappings.get(pressKey) !== machineId,
    )
  ) {
    throw new Error(
      'RADIUS_PRESS_MAPPINGS must exactly match the verified Radius machine mapping',
    )
  }
  return sortedMappings
}

function parseRadiusStaleSeconds(value: string | undefined): number {
  if (value === undefined || value.trim() === '') {
    return DEFAULT_RADIUS_STALE_SECONDS
  }
  const staleSeconds = Number(value)
  if (
    !Number.isInteger(staleSeconds) ||
    staleSeconds < MIN_RADIUS_STALE_SECONDS ||
    staleSeconds > MAX_RADIUS_STALE_SECONDS
  ) {
    throw new Error(
      `RADIUS_STALE_SECONDS must be an integer between ${MIN_RADIUS_STALE_SECONDS} and ${MAX_RADIUS_STALE_SECONDS}`,
    )
  }
  return staleSeconds
}

function parseRadiusConfig(environment: NodeJS.ProcessEnv): RadiusConfig {
  const staleSeconds = parseRadiusStaleSeconds(
    environment.RADIUS_STALE_SECONDS,
  )
  const radiusNames = [
    'RADIUS_DB_HOST',
    'RADIUS_DB_PORT',
    'RADIUS_DB_NAME',
    'RADIUS_DB_USER',
    'RADIUS_DB_PASSWORD',
    'RADIUS_DB_SCHEMA',
    'RADIUS_DB_TABLE',
    'RADIUS_DB_TIMESTAMP_MODE',
    'RADIUS_RUN_PRODUCTION_STATUS',
    'RADIUS_PRESS_MAPPINGS',
  ]
  const configuredNames = radiusNames.filter(
    (name) => environment[name] !== undefined && environment[name]?.trim() !== '',
  )
  if (configuredNames.length === 0) return { enabled: false, staleSeconds }
  if (configuredNames.length !== radiusNames.length) {
    throw new Error('Radius configuration must be complete or entirely absent')
  }

  const host = requireRadiusValue(environment, 'RADIUS_DB_HOST')
  if (host !== '127.0.0.1' && host !== 'localhost') {
    throw new Error('RADIUS_DB_HOST must remain local to FORMPRODSVR02')
  }
  const port = Number(requireRadiusValue(environment, 'RADIUS_DB_PORT'))
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('RADIUS_DB_PORT must be an integer between 1 and 65535')
  }
  const database = requireRadiusValue(environment, 'RADIUS_DB_NAME')
  if (database !== 'press_radius_db') {
    throw new Error('RADIUS_DB_NAME must be press_radius_db')
  }
  const timestampMode = requireRadiusValue(
    environment,
    'RADIUS_DB_TIMESTAMP_MODE',
  )
  if (timestampMode !== 'timestamptz') {
    throw new Error('RADIUS_DB_TIMESTAMP_MODE must be timestamptz')
  }
  const schema = parseRadiusIdentifier(
    requireRadiusValue(environment, 'RADIUS_DB_SCHEMA'),
    'RADIUS_DB_SCHEMA',
  )
  if (schema !== 'public') throw new Error('RADIUS_DB_SCHEMA must be public')
  const table = parseRadiusIdentifier(
    requireRadiusValue(environment, 'RADIUS_DB_TABLE'),
    'RADIUS_DB_TABLE',
  )
  if (table !== 'machine_status_history') {
    throw new Error('RADIUS_DB_TABLE must be machine_status_history')
  }
  const productionStatusDescription = requireRadiusValue(
    environment,
    'RADIUS_RUN_PRODUCTION_STATUS',
  )
  if (productionStatusDescription !== 'Run Production') {
    throw new Error(
      'RADIUS_RUN_PRODUCTION_STATUS must be the verified Run Production value',
    )
  }

  return {
    enabled: true,
    host,
    port,
    database,
    user: requireRadiusValue(environment, 'RADIUS_DB_USER'),
    password: requireRadiusValue(environment, 'RADIUS_DB_PASSWORD'),
    schema,
    table,
    currentTable: 'machine_status_current',
    eventsTable: 'machine_status_events',
    pollRunsTable: 'machine_status_poll_runs',
    timestampMode,
    effectiveCutoverUtc: RADIUS_EFFECTIVE_CUTOVER_UTC,
    expectedMachineCount: RADIUS_EXPECTED_MACHINE_COUNT,
    productionEventType: 'G',
    productionStatusDescription,
    staleSeconds,
    mappings: parseRadiusMappings(
      requireRadiusValue(environment, 'RADIUS_PRESS_MAPPINGS'),
    ),
  }
}

function parseClassificationDatabase(environment: NodeJS.ProcessEnv): AppDatabaseConfig {
  const names = ['APP_DB_HOST', 'APP_DB_PORT', 'APP_DB_NAME', 'APP_DB_USER', 'APP_DB_PASSWORD', 'APP_DB_SCHEMA']
  const configured = names.filter((name) => environment[name]?.trim())
  if (configured.length === 0) return { enabled: false }
  if (configured.length !== names.length) throw new Error('APP_DB_* configuration must be complete or entirely absent')
  const host = environment.APP_DB_HOST!.trim()
  if (host !== '127.0.0.1' && host !== 'localhost') throw new Error('APP_DB_HOST must remain local to FORMPRODSVR02')
  const port = Number(environment.APP_DB_PORT)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('APP_DB_PORT must be a valid port')
  if (environment.APP_DB_NAME!.trim() !== 'processintelligence_db') throw new Error('APP_DB_NAME must be processintelligence_db and must not reference a source database')
  if (environment.APP_DB_USER!.trim() !== 'processintelligence_app') throw new Error('APP_DB_USER must be the restricted processintelligence_app runtime role')
  if (environment.APP_DB_SCHEMA!.trim() !== 'process_intelligence') throw new Error('APP_DB_SCHEMA must be process_intelligence')
  return { enabled: true, host, port, database: 'processintelligence_db', user: 'processintelligence_app', password: environment.APP_DB_PASSWORD!.trim(), schema: 'process_intelligence' }
}

function parseClassificationAuthorization(environment: NodeJS.ProcessEnv): ClassificationAuthorizationConfig {
  return {
    trustedProxy: environment.PROCESS_INTELLIGENCE_TRUST_AUTH_PROXY?.trim().toLowerCase() === 'true',
    adminActors: [...new Set((environment.PROCESS_INTELLIGENCE_CLASSIFICATION_ADMINS ?? '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean))],
  }
}

export function loadServerConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ServerConfig {
  return {
    host: parseHost(environment.HOST),
    port: parsePort(environment.PORT),
    plantTimeZone: parseTimeZone(environment.PLANT_TIME_ZONE),
    telemetryApi: {
      baseUrl: requireBaseUrl(environment.TELEMETRY_API_BASE_URL),
      timeoutMs: parseTimeout(environment.TELEMETRY_API_TIMEOUT_MS),
    },
    radius: parseRadiusConfig(environment),
    classificationDatabase: parseClassificationDatabase(environment),
    classificationAuthorization: parseClassificationAuthorization(environment),
  }
}
