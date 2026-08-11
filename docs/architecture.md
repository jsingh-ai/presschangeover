# Process Intelligence architecture

## Runtime boundaries

Process Intelligence spans two virtual machines while preserving strict ownership boundaries:

- **MARKUSPRODSVR (10.0.1.157)** owns the telemetry historian and the separately deployed TelemetryQueryApi. The historian remains localhost-only on that VM.
- **FORMPRODSVR02 (10.8.10.97)** owns the isolated Process Intelligence source workspace and will host its future deployed application.
- The **React browser client** calls only relative Process Intelligence endpoints under /api.
- The **Process Intelligence Node/Express backend** validates browser requests and calls explicit TelemetryQueryApi HTTP/JSON operations at the configured TELEMETRY_API_BASE_URL.
- **TelemetryQueryApi** is authoritative for telemetry semantics, including Physical State Engine v1. Process Intelligence does not independently classify physical state.

The allowed telemetry flow is:

    React browser
      -> Process Intelligence Node backend
        -> TelemetryQueryApi
          -> localhost-only telemetry PostgreSQL historian

The browser never calls MARKUSPRODSVR or TelemetryQueryApi directly. Process Intelligence never connects to telemetry PostgreSQL, and no telemetry database driver or credential belongs in this application.

## Writable application-data boundary

Radius and telemetry are never writable application stores. State classifications, drafts, published versions, and audits use only the optional future `processintelligence_db` boundary with a distinct restricted `processintelligence_app` role and `APP_DB_*` configuration. The application refuses source database names and remains read-only when that boundary is absent. Migration provisioning is documented in `docs/state-classification-storage.md`.

The existing Radius/opc-radius production application on FORMPRODSVR02 remains isolated and untouched. Process Intelligence now contains an optional Radius boundary in the Node backend. It remains disabled until live schema, timestamp semantics, exact production status, machine mappings, and a dedicated SELECT-only role are verified and configured externally. React never connects to PostgreSQL.

## Source and deployment convention

- client/ — React/Vite/TypeScript source
- server/ — Node/Express/TypeScript source
- docs/ — project architecture and technical documentation
- app/ — future published production application
- config/ — future external production configuration
- logs/ — future production logs
- staging/ — future deployment staging
- backups/ — future rollback packages

Production runs from reviewed release content under app/, not from client/ or server/. The Windows service runs the deployed Node entrypoint and IIS serves the deployed client while preserving a stable site-specific web.config template outside app/.

## Operational episode model

The architecture leaves room for three major capability areas without implementing them yet:

1. **Overview machine timeline/Gantt** for a high-level operational view.
2. **Process Explorer** for detailed investigation of operational context.
3. **Per-press Episode Comparison / Run Fingerprint** for deterministic comparison of bounded operational episodes.

The implemented first-stage episode engine uses the exact verified Radius `Run Production` description as its production authority. A production-to-non-production transition starts an episode. Production must remain continuous for five minutes to close it, but the end timestamp is the beginning of that qualifying production streak. Shorter returns stay inside the same episode and are marked failed. Bounded lookback preserves carry-in episodes and historical lookahead confirms returns near a visible range boundary.

The current UI exposes Radius-only overview, press, and episode views. The next feature layer may overlay Telemetry physical state and speed on these derived episodes; that overlay is not implemented here.
