# Project context

Copy this file to a new repository as `AGENTS.md`, replace every placeholder, and delete rules that do not apply. Do not create directories or infrastructure merely because they appear here.

## Project profile

- Name and purpose: `[SET]`
- Allowed filesystem root: `[SET]`
- Frontend/backend: `[SET or none]`
- Application-owned database: `[SET or none]`
- Protected external systems: `[SET or none]`
- Production branch: `main`

## Hard boundaries

- Keep filesystem operations inside the allowed project root.
- State exactly which external systems are read-only and never add mutation access to them.
- Keep application-owned writes on a separate connection and refuse migrations against any other database.
- Keep secrets and environment-specific configuration outside Git; commit safe examples only.
- Do not change runtime files, services, production data, releases, or backups during source work.
- Preserve unrelated changes.

## Architecture

- Prefer one modular application with `frontend/`, `backend/`, application-owned `database/migrations/`, `deploy/`, and `docs/`; create only the directories the project actually uses.
- Keep unit tests near their code and reserve root `tests/` for cross-application tests.
- The frontend calls relative backend routes and never receives database credentials.
- Authentication establishes identity; backend authorization protects actions and data.
- Avoid new services or infrastructure until a concrete requirement justifies them.

## Git and validation

- Work on short-lived `feature/`, `fix/`, or `chore/` branches and merge through pull requests.
- Create focused commits at coherent, validated checkpoints, not after every edit.
- Inspect and stage exact paths; never commit secrets, runtime data, dependencies, generated output, releases, or backups.
- Install: `[SET exact locked-dependency command]`
- Validate a small change: `[SET]`
- Validate the full application: `[SET]`
- A commit does not authorize a push, merge, package, deployment, service change, database change, or cleanup.

## Release and operations

- Build only when deployment is requested, and tie every immutable release to an exact commit and checksum.
- Use temporary deployment space, retain a bounded number of rollback copies, verify health, and clean temporary files afterward.
- Define log rotation and retention before production use.
- Cleanup must preview first, fail closed, refuse links/reparse points, and stay inside the allowed project root.
- Required approval boundaries: `[SET]`
