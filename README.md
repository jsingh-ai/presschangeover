# Process Intelligence

Process Intelligence is an isolated React and Node production application for operational press analysis. IIS serves the React client and proxies `/api` to a localhost-only Node service. Telemetry remains behind TelemetryQueryApi; Radius history is accessed only through an optional, dedicated SELECT-only PostgreSQL boundary.

The runtime paths are:

    React browser -> IIS -> Process Intelligence Express API -> TelemetryQueryApi
                                                        -> Radius PostgreSQL (optional SELECT-only)

State Classification has a separate, optional writable boundary:

    Process Intelligence Express API -> processintelligence_db (optional application data only)

This database is not Radius and is not the telemetry historian. Until `processintelligence_db`, the restricted `processintelligence_app` role, and the reviewed migration are explicitly provisioned, semantic seed mappings are available read-only and administration mutations fail closed. See [docs/state-classification-storage.md](docs/state-classification-storage.md).

The browser uses only relative Process Intelligence /api URLs. It never contacts MARKUSPRODSVR, the telemetry historian, or PostgreSQL directly. See [docs/architecture.md](docs/architecture.md) for the complete boundary and future capability direction.

## Project layout

- client/ — React, Vite, and TypeScript source
- server/ — Express and TypeScript source
- docs/ — architecture and technical documentation
- app/ — currently deployed production output
- config/ — external production configuration and stable IIS template
- logs/, staging/, backups/ — runtime logs, release staging, and packages/deployment backups

Source remains in client/ and server/. Reviewed releases publish into app/; production does not run from the source directories.

## Development environment

Observed on FORMPRODSVR02:

- Node.js v24.18.0
- npm 11.16.0

Install dependencies from the repository root:

    npm install

Start the API and client in separate terminals:

    npm run dev:server
    npm run dev:client

Vite proxies development /api requests to `VITE_DEV_API_TARGET` when supplied, or to http://localhost:3001 by default.

## Server configuration

The server reads:

- TELEMETRY_API_BASE_URL — required at runtime; the Windows development command supplies the approved development target
- TELEMETRY_API_TIMEOUT_MS — defaults to 5000
- PORT — defaults to 3001
- HOST defaults to localhost; production must explicitly use 127.0.0.1.
- PLANT_TIME_ZONE — defaults to and is configured as America/Chicago
- RADIUS_STALE_SECONDS — defaults to 180; accepts an integer from 1 through 86400 seconds
- RADIUS_DB_* / RADIUS_RUN_PRODUCTION_STATUS / RADIUS_PRESS_MAPPINGS — optional as a complete verified set; any partial set is rejected
- APP_DB_* — optional as a complete set and accepted only for the separate `processintelligence_db`, `processintelligence_app` role, and `process_intelligence` schema. When absent, classification administration is read-only.

Use [server/.env.example](server/.env.example) and [config/processintelligence.env.example](config/processintelligence.env.example) as documentation. Real environment files and database credentials are ignored by Git. Only a dedicated SELECT-only Radius password may be supplied externally.

## Commands

    npm run typecheck
    npm run test
    npm run build
    npm run build:client
    npm run build:server

Create a validated, non-deployed release package:

    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-release.ps1

Production deployment uses the dedicated `ProcessIntelligence.Node` service and restores the stable IIS web.config template. Deployment must explicitly name only that service and create a rollback backup.

## Current API

- GET /api/health — local Process Intelligence health
- GET /api/telemetry/health — sanitized TelemetryQueryApi and historian status
- GET /api/telemetry/sources — projected telemetry source list
- GET /api/telemetry/sources/:sourceId/physical-state?fromUtc=...&toUtc=... — validated physical-state request with a maximum two-hour range
- GET /api/radius/health — sanitized Radius configuration/connectivity state
- GET /api/radius/overview?fromUtc=...&toUtc=... — compressed per-press Radius timelines and fleet summary, maximum 31 days
- GET /api/radius/presses/:pressKey/episodes?fromUtc=...&toUtc=... — derived operational episodes for one mapped press
- GET /api/radius/presses/:pressKey/episodes/:episodeId — detailed status sequence for one deterministic episode
- GET /api/classification/workspace — published groups, observed exact identities, draft status, versions, and audit history
- GET /api/classification/groups, /process-families, /identities, /classifications, /review-required, /draft, /versions, /audit — focused classification resources
- POST/PATCH/DELETE /api/classification/draft/... — authorized optimistic-concurrency draft, validation, publish, and discard operations

## Client information architecture

The React client has three primary analytics workspaces plus one administration destination:

- **Overview** (`/overview`) — fleet signal summary, state magnitude, prioritized existing findings, and the supporting press-activity timeline.
- **Operational Analysis** (`/operational-analysis`) — State Breakdown, Status Drivers, and Stops & Recovery together in one continuous workspace.
- **Patterns & Episodes** (`/patterns-episodes`) — relationship evidence, supported deviations, recurring press behavior, and selected-press episode investigation.
- **Administration → State Classification** (`/administration/state-classification`) — versioned operational groups and exact Radius identity mappings. It is read-only until the separate application store and trusted administrator identity boundary are configured.

The selected time range and press scope remain global while moving between workspaces. Evidence opens in an accessible side drawer without replacing the underlying workspace; meaningful URL state supports browser Back/Forward and shareable investigation links. The interface supports persistent light and dark themes, using the operating-system preference until the user chooses one.

These workspaces reorganize the existing Radius analytics and do not alter analytics semantics or API contracts. Telemetry graphs remain intentionally deferred to a separate feature layer.

## Operational analytics contract

Analytics are calculated once from each request's canonical, normalized Radius timelines; widgets do not independently reconstruct state. Adjacent exact identities are merged across the legacy/compact cutover, intervals are clipped to the UTC range, offline/gap boundaries stop sequence traversal, and transitions never cross presses. Unknown time is `possible press-seconds - observed Radius seconds` and is never assigned to an event category.

- Immediately after A: denominator is A occurrences with a known next meaningful state in range; numerator is the subset whose next state is B.
- Immediately before B: denominator is B occurrences with a known previous meaningful state in range; numerator is the subset whose previous state is A.
- Within two/three transitions: each anchor contributes at most once to a given target; anchors with no known candidate remain censored.
- Production stop: transition from verified `G / Run Production` to the first known non-production state.
- Successful return: an existing episode return satisfying five continuously observed production minutes; confirmation time remains evidence and is not added to downtime.
- Make Ready: an exact `M` interval exit followed until confirmed production, another Make Ready, a data/range boundary, or exhaustion of the bounded known sequence.

Every percentage is paired with `numerator/denominator`. P90 is shown only with at least five observations. Relationship support below 10 resolved anchors is flagged low. Descriptive thresholds are deterministic: consistent in range = exactly 100% with at least 10 resolved anchors; dominant = at least 60%; common = at least 40%; occasional = at least 15%; otherwise rare. A relationship exception becomes an anomaly only when the immediate-after cohort has at least five resolved anchors, its dominant outcome is at least 60%, and another outcome actually occurred. These labels describe operator-entered Radius annotations, not physical causation or root cause.

Radius data availability is derived without writing to Radius. Legacy snapshots and compact `machine_status_events` reconstruct operational state, while `machine_status_poll_runs` supplies compact-era heartbeat evidence and `machine_status_current` supplies current state. A heartbeat remains trusted while its age is less than or equal to `RADIUS_STALE_SECONDS`; an `OFFLINE` timeline span begins only when the age is strictly greater, at `lastHeartbeat + threshold`. See [docs/radius-storage-model.md](docs/radius-storage-model.md) for the verified production model and exact cutover.

Radius is disabled unless every external Radius setting is present and verified. The server rejects partial configuration, non-local database hosts, unexpected schema/timestamp settings, writer/elevated roles, schema-creation capability, and role memberships. See `docs/radius-readonly-discovery.sql` and `docs/create-processintelligence-readonly.sql` for the administrator workflow; neither script contains a password.
