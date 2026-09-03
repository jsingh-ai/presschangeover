# Machine Intelligence

Machine Intelligence is a read-only fleet comparison page. It shows Process Intelligence time, Radius time, comparable non-good time, and roll outcomes for all supported presses.

## Evidence model

- Process Intelligence remains telemetry-led, with the latest operator review overriding prediction.
- Radius G/M/B remains separate recorded operational context and does not move physical stop boundaries.
- Routine and predicted Uncertain time count as Downtime. Bad or unavailable evidence remains Missing Data.

## Optimized overview

The browser makes one request to `GET /api/machine-intelligence/overview` for the selected range. The server reads each press with bounded concurrency and returns only the totals consumed by the four overview charts.

The former per-press endpoints and their job, recipe, occurrence, timeline, daily grouping, and nested roll evidence payloads have been removed. Machine Intelligence no longer creates those structures, sends dozens of browser requests, or renders sticky expandable press rows.

The overview defaults to 24 hours and supports 72 hours, 14 days, and custom ranges up to 31 days. Each press is processed as one logical read so the telemetry foundation can batch its bounded upstream reads and preserve roll transitions across the entire selected range. Machine Intelligence explicitly bypasses the retained Stop Intelligence analysis cache; this optimization comes from doing less work and transferring less data, not from caching the result.

All telemetry access remains server-side through the configured TelemetryQueryApi client. Machine Intelligence has no telemetry write path and does not connect directly to the historian.
