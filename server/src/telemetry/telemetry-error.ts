export type TelemetryApiErrorKind =
  | 'timeout'
  | 'cancelled'
  | 'unavailable'
  | 'not_found'
  | 'unsupported_source'
  | 'upstream_http'
  | 'request_invalid'
  | 'payload_too_large'
  | 'invalid_response'

export class TelemetryApiError extends Error {
  constructor(
    public readonly kind: TelemetryApiErrorKind,
    public readonly upstreamStatus?: number,
  ) {
    super(`Telemetry dependency failure: ${kind}`)
    this.name = 'TelemetryApiError'
  }
}
