# Repository working agreement

## Scope and safety

- Keep every filesystem operation inside `C:\ProcessIntelligence`.
- Never modify deployed `app/`, external `config/`, services, releases, or backups unless the user explicitly requests that lifecycle stage.
- Preserve unrelated user changes. Never stage or commit them with task work.

## Commit discipline

- Work on a task-specific branch, not the protected production or archive branches.
- After a coherent unit of work is complete and proportionally validated, create a focused Git commit before starting a different unit.
- Inspect status and diff first, stage only the exact task paths, and verify the staged diff before committing.
- Use a concise conventional message such as `fix:`, `feat:`, `chore:`, `docs:`, or `test:` that describes the completed outcome.
- Do not commit secrets, runtime configuration, logs, generated validation artifacts, dependency directories, build output, release ZIPs, or recovery backups.
- A commit does not authorize a push, release build, deployment, service change, merge, or cleanup of recovery material. Treat each as a separate explicit action.
- If repository permissions prevent Git metadata writes, provide an exact PowerShell command that performs the same narrowly scoped commit under the user's account.

## Validation

- Use `scripts\validate-change.ps1` with the smallest scope that covers the change.
- Use full validation for shared, dependency, configuration-template, release-tooling, or cross-stack changes.
- Record important validation results in the handoff; keep disposable output under `artifacts\validation`.
