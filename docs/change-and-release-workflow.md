# Change and release workflow

This workflow keeps source changes, validation output, deployable releases, runtime state, and recovery material separate. Nothing in validation or packaging changes the deployed application.

## Directory contract

| Path | Purpose | Retention |
| --- | --- | --- |
| `client/`, `server/`, `scripts/`, `docs/` | Reviewed source and operational tooling | Git history |
| `worktrees/` | Isolated Git worktrees used for concurrent or release validation | Remove through Git when finished; ignored by Git |
| `artifacts/validation/` | Disposable screenshots, reports, and other local validation output | Delete after review; ignored by Git |
| `staging/` | Temporary assembly and deployment workspaces | Automatically cleaned where possible; ignored by Git |
| `releases/` | Immutable deployable ZIPs and adjacent SHA-256 files | Retain according to the release policy; ignored by Git |
| `app/` | Currently deployed application | Changed only by the deployment or rollback script; ignored by Git |
| `config/` | External environment and stable host configuration | Preserve independently; secrets are ignored by Git |
| `logs/` | Runtime logs | Operational retention; ignored by Git |
| `backups/deployments/` | Rollback copies created during deployment | Recovery retention; ignored by Git |
| `backups/` | Exceptional recovery archives, including off-machine backup sources | Recovery retention; ignored by Git |

Historical release ZIPs under `backups/packages/` are legacy recovery material. New release packages go to `releases/`, and the deployment script accepts only packages from that directory.

## Proportional validation

Install exact locked dependencies once after a clean checkout or dependency cleanup:

```powershell
npm ci
```

Then choose the smallest validation scope that fully covers the change:

```powershell
# Styles, markup, or other presentation-only client work
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\validate-change.ps1 -Scope Css

# React/client behavior
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\validate-change.ps1 -Scope Client

# API/server behavior
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\validate-change.ps1 -Scope Server

# Shared, dependency, configuration-template, release-tooling, or cross-stack work
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\validate-change.ps1 -Scope Full
```

These commands validate source only. They do not create a release, write to `app/`, control a service, or deploy anything. A small CSS or logic change therefore does not need a package until it is intentionally promoted for deployment.

Browser screenshots and machine-generated reports belong under a timestamped directory in `artifacts/validation/`. The browser smoke scripts reject screenshot paths outside that boundary. Only conclusions and durable technical documentation should be committed.

## Branch and promotion flow

1. Start a short-lived `fix/`, `feature/`, or `chore/` branch from the verified production source branch. Never develop directly in `app/`.
2. Make the source change and run proportional validation.
3. Commit and review the source. Stop here when no deployment is requested.
4. When deployment is approved, run full release packaging from a clean committed worktree:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-release.ps1
   ```

5. Review the generated `releases\ProcessIntelligence-<release-id>.zip`, its adjacent `.sha256`, and the source commit. Packaging removes its temporary staging directory by default. Use `-KeepStaging` only for a specific investigation, then remove that staging content. Verify a package without deploying it:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy-release.ps1 `
       -ReleasePath C:\ProcessIntelligence\releases\ProcessIntelligence-<release-id>.zip `
       -ValidateOnly
   ```

6. Deploy only the reviewed ZIP. Deployment verifies its adjacent checksum, validates its manifest and source commit, creates a rollback copy, and requires explicit confirmation:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy-release.ps1 `
       -ReleasePath C:\ProcessIntelligence\releases\ProcessIntelligence-<release-id>.zip `
       -ServiceName ProcessIntelligence.Node `
       -ConfirmDeployment
   ```

7. Perform post-deployment health and browser validation. Roll back only from a reviewed directory under `backups/deployments/`.

Creating a branch preserves intent and review history; creating a release is a separate promotion decision. There is no need to manufacture a release package for every local edit or commit.

## Cleanup policy

Preview disposable staging and validation output older than seven days:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\cleanup-transient-artifacts.ps1
```

After reviewing the exact paths, apply that same bounded cleanup:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\cleanup-transient-artifacts.ps1 -Apply
```

The cleanup script is hard-limited to immediate entries beneath `C:\ProcessIntelligence\staging` and `C:\ProcessIntelligence\artifacts\validation`. Under `staging`, it considers only generated release, deployment, and rollback directory names; historical top-level reports are not selected. It refuses reparse points and never touches source, `app`, `config`, releases, backups, logs, Git metadata, worktrees, or anything outside `C:\ProcessIntelligence`.

Release and rollback-backup retention is intentionally manual because those files are recovery assets. Confirm an off-machine copy and a known-good newer recovery point before deleting either category.
