# State Classification storage and security boundary

State Classification introduces writable ProcessIntelligence application data, but neither existing source is an application store:

- `press_radius_db` remains accessible only through the dedicated SELECT-only Radius role.
- Telemetry remains read-only behind TelemetryQueryApi. ProcessIntelligence never connects to the telemetry historian.
- Classifications, drafts, versions, and audits belong only in a separately provisioned `processintelligence_db` database.

## Required provisioning before writes can be enabled

An administrator must explicitly provision:

1. A PostgreSQL database named exactly `processintelligence_db`.
2. A distinct login role named exactly `processintelligence_app`. It must not inherit the Radius role, a telemetry role, a database-owner role, or elevated PostgreSQL capabilities.
3. A separate migration owner used only to apply reviewed migrations.
4. The schema migration in `server/migrations/001_radius_semantic_classification.sql`, connected to `processintelligence_db` as the migration owner.
5. The six `APP_DB_*` runtime settings documented in the environment examples.

The migration checks `current_database()` and refuses to run anywhere except `processintelligence_db`. It also refuses to continue unless `processintelligence_app` already exists. It grants the runtime role only schema usage, table DML, and sequence usage—not schema creation or ownership.

Do not apply the migration to `press_radius_db` or the telemetry historian. Do not reuse either source credential.

## Fail-closed runtime behavior

When `APP_DB_*` is absent, the application uses the reviewed seed catalog for read-only semantic presentation. The administration page remains visible but cannot create, modify, discard, or publish drafts. No in-memory administrator edit is accepted in the normal runtime.

`APP_DB_*` is all-or-nothing. Configuration is rejected unless:

- `APP_DB_NAME=processintelligence_db`
- `APP_DB_USER=processintelligence_app`
- `APP_DB_SCHEMA=process_intelligence`
- the host is localhost on FORMPRODSVR02

When configured, startup expects the migration to have been applied and fails rather than creating source-side tables or silently falling back.

## Administrator identity

The repository currently has no application authentication/session system. Classification mutations therefore remain denied unless a trusted authentication proxy is explicitly configured. The proxy must remove any client-supplied `X-ProcessIntelligence-Authenticated-User` header, authenticate the request, and set the header itself. The normalized identity must also appear in `PROCESS_INTELLIGENCE_CLASSIFICATION_ADMINS`.

Do not enable `PROCESS_INTELLIGENCE_TRUST_AUTH_PROXY` until that proxy enforcement has been reviewed. Backend authorization is applied independently of UI visibility.

## Data model

The application schema contains stable operational groups, process families, exact null-safe Radius identity mappings, one optimistic-concurrency draft, immutable published snapshot versions, and append-only audit entries. Publishing locks the current draft/version, verifies the base version and revision, updates effective mappings, records the immutable version and audit entries, and removes the draft in one transaction.

Radius tables are only queried for the observed identity catalog. Those catalog queries contain no DDL or DML and do not modify Radius records.
