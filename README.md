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
- APP_DB_* — optional as a complete set and accepted only for the separate `processintelligence_db` and `processintelligence_app` runtime login. Classification documents always use `public.classification_documents`. When absent, classification administration is read-only.

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
- GET/POST /api/telemetry/... — validated, server-side read-only telemetry evidence
- GET /api/radius/health — sanitized Radius configuration/connectivity state
- GET /api/radius/overview?fromUtc=...&toUtc=... — per-press Radius timelines and fleet summary, maximum 31 days
- GET /api/machine-intelligence/presses/:pressKey — telemetry-led job and recipe evidence, maximum 72 hours per request
- GET /api/stop-intelligence/... — fleet stop summaries and detailed read-only stop evidence
- GET/POST /api/radius/raw-explorer/... — exact Radius code exploration
- GET/POST /api/telemetry/event-explorer/... — telemetry event exploration
- GET /api/classification/workspace — published groups, observed exact identities, draft status, versions, and audit history
- GET /api/classification/groups, /process-families, /identities, /classifications, /review-required, /draft, /versions, /audit — focused classification resources
- POST/PATCH/DELETE /api/classification/draft/... — authorized optimistic-concurrency draft, validation, publish, and discard operations

## Client information architecture

The React client exposes the current operational workspaces:

- **Overview** (`/overview`) — fleet signal summary and supporting press timelines.
- **Machine Intelligence** (`/machine-intelligence`) — fleet, recipe, job occurrence, roll, telemetry, and Radius evidence.
- **Stop Intelligence** (`/stop-intelligence`) — physical-stop classification and investigation.
- **Raw Radius Explorer** (`/raw-radius-explorer`) — exact recorded Radius codes with synchronized evidence.
- **Telemetry Event Explorer** (`/telemetry-event-explorer`) — threshold, delta, and value-transition evidence.
- **Administration → State Classification** (`/administration/state-classification`) — versioned operational groups and exact Radius identity mappings.

The interface supports persistent light and dark themes. All telemetry and Radius access remains server-side and read-only.