# Process Intelligence project context

Keep this file short, current, and focused on rules that must survive every change.

## Hard safety boundaries

- Keep every filesystem operation inside `C:\ProcessIntelligence`.
- Radius and Telemetry are external source systems and must remain read-only to Process Intelligence.
- Radius access must use its dedicated SELECT-only connection. Refuse operation if that role has write, schema-creation, role-management, or superuser privileges.
- Telemetry data must be queried through TelemetryQueryApi. Do not add a direct telemetry-database connection or call a mutation endpoint.
- HTTP `POST` may be used for a read-only query payload; it must not cause source-system state changes.
- Application writes are allowed only in the separate `processintelligence_db` through the restricted `processintelligence_app` role. Migrations must refuse any other database.
- Never modify deployed `app/`, external `config/`, Windows services, releases, or backups unless the user explicitly requests that lifecycle stage.
- Preserve unrelated user changes and never stage or commit them with task work.

## Architecture

- Keep one modular application: React in `client/`, Node/Express in `server/`, application-owned migrations in `server/migrations/`, and lifecycle tooling in `scripts/`.
- Do not rename or duplicate this layout without a dedicated, validated migration.
- The browser calls relative `/api` routes only. All database and upstream access stays in the backend.
- Authentication establishes identity; backend authorization controls protected actions and data. Hiding a frontend tab is not authorization.
- Do not introduce microservices or additional infrastructure without a demonstrated need.

## Git and checkpoints

- `main` is the permanent reviewed source branch. Never commit directly to it.
- Use short-lived `feature/`, `fix/`, or `chore/` branches and merge them into `main` through pull requests.
- Use judgment to create a focused commit when a coherent, meaningful unit is complete and validated, before unrelated or risky work accumulates. Do not commit every edit or knowingly incomplete work.
- Before committing, inspect status and diffs, stage only exact task paths, and use a concise `feat:`, `fix:`, `chore:`, `docs:`, or `test:` message.
- Never commit secrets, runtime configuration, logs, dependencies, build output, validation evidence, release packages, or backups.
- A commit does not authorize a push, merge, package, deployment, service change, database change, or cleanup. Each is a separate action.
- If Git metadata writes are unavailable, provide the exact narrowly scoped PowerShell commit command for the user.

## Validation and release

- Run `scripts\validate-change.ps1` at the smallest scope that covers the change; use `Full` for shared, dependency, migration, configuration-template, release-tooling, or cross-stack work.
- Source validation does not require packaging. Build a release only when deployment is requested.
- Deploy only an immutable package tied to an exact Git commit and checksum. Use temporary staging only to prepare it, preserve a rollback copy, verify health, and remove the temporary files afterward.
- Cleanup must be previewable, fail closed, use bounded retention, refuse reparse points, and never operate outside `C:\ProcessIntelligence`.
