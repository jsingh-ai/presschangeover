export const EXPLORER_HTTP_VALIDATION_CAPABILITIES = {
  version: 1,
  transport: 'processintelligence_http',
  directPostgresValidationConnections: 0,
  radiusAccess: 'read_only',
  boundedExplorerRoutes: true,
  rawDetailSuppressesRawDiscovery: true,
  telemetryDetailSuppressesRawDiscovery: true,
  rawHistoryRoute: true,
  telemetryHistoryRoute: true,
} as const

export function supportsExplorerHttpValidation(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  return candidate.version === EXPLORER_HTTP_VALIDATION_CAPABILITIES.version
    && candidate.transport === EXPLORER_HTTP_VALIDATION_CAPABILITIES.transport
    && candidate.directPostgresValidationConnections === 0
    && candidate.radiusAccess === EXPLORER_HTTP_VALIDATION_CAPABILITIES.radiusAccess
    && candidate.boundedExplorerRoutes === true
    && candidate.rawDetailSuppressesRawDiscovery === true
    && candidate.telemetryDetailSuppressesRawDiscovery === true
    && candidate.rawHistoryRoute === true
    && candidate.telemetryHistoryRoute === true
}
