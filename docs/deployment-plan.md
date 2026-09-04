# Process Intelligence production deployment

Status: the Windows service and local IIS hosting/proxy layers are implemented and validated on FORMPRODSVR02 as of 2026-08-11.

Current application release: `20260811-020548`. Deployment rollback backup: `C:\ProcessIntelligence\backups\deployments\20260811-020629`.

## Current topology

```text
Browser
  -> http://10.8.10.97:8088
    -> ProcessIntelligence IIS site
      -> static React client from C:\ProcessIntelligence\app\client
      -> /api/* through URL Rewrite and ARR
        -> http://127.0.0.1:3100/api/*
          -> ProcessIntelligence.Node
            -> TelemetryQueryApi
```

The browser uses same-origin relative `/api` requests. Node remains bound only to IPv4 localhost and is not directly reachable through `10.8.10.97:3100`.

## IIS objects

- Site: `ProcessIntelligence`
- State: Started
- Site ID: 3
- Physical path: `C:\ProcessIntelligence\app\client`
- Binding: `http/10.8.10.97:8088:` with no hostname
- Application pool: `ProcessIntelligence.AppPool`
- Pool identity: `ApplicationPoolIdentity`
- Managed runtime: No Managed Code
- Pipeline: Integrated
- Start mode: AlwaysRunning
- Idle timeout: `00:00:00`
- IIS log directory: `C:\inetpub\logs\LogFiles\W3SVC3`

The application-pool virtual identity has Read & Execute permission on the client directory and descendants. It has not been granted access to the external environment file, server runtime, backups, staging, or service logs.

## ARR and URL Rewrite

- Microsoft Application Request Routing 3.0: installed version 3.0.05311
- IIS URL Rewrite Module 2: installed version 7.2.1993
- ARR global proxy: already enabled before this deployment and left enabled
- Server-level global rewrite rules: none
- API rule: `^api(?:/(.*))?$` rewrites to `http://127.0.0.1:3100/api/{R:1}`, preserves the query string, and stops processing
- SPA fallback: non-API requests that are not files or directories rewrite internally to `/index.html`
- Site configuration: `C:\ProcessIntelligence\app\client\web.config`
- Stable deployment template: `C:\ProcessIntelligence\config\iis\ProcessIntelligence.web.config`

The deployment script copies the stable template into each prepared release at `client\web.config` before the new `app` directory is activated. The rewrite destination is fixed to localhost and cannot proxy arbitrary hosts.

## Release lifecycle controls

New deployable ZIPs and their adjacent SHA-256 files are created under `C:\ProcessIntelligence\releases`. `staging` is temporary workspace only, while `backups\deployments` contains rollback copies of previously deployed application content. Historical ZIPs under `backups\packages` remain legacy recovery material rather than the input to new deployments.

The deployment script accepts only a ZIP under `releases`, verifies its adjacent SHA-256 before extraction, validates its manifest and source commit, and still requires `-ConfirmDeployment`. It does not accept a mutable staging directory. `-ValidateOnly` performs those package checks and cleans its temporary workspace without inspecting services or changing `app`. See `docs/change-and-release-workflow.md` for the full promotion and proportional-validation workflow.

## Backend service

- Service: `ProcessIntelligence.Node`
- State after IIS validation: Running
- Service identity: `NT AUTHORITY\LocalService`
- Runtime: `C:\ProcessIntelligence\app\server\dist\index.js`
- Binding: `127.0.0.1:3100`
- External configuration: `C:\ProcessIntelligence\config\processintelligence.env`

## Validation completed

- React index through IIS: HTTP 200 and byte-for-byte match with the deployed `index.html`
- Generated JavaScript and CSS through IIS: HTTP 200 with correct content types
- `/api/health` through IIS: HTTP 200
- `/api/telemetry/health` through IIS: HTTP 200
- `/api/telemetry/sources` through IIS: HTTP 200 with 12 sources
- Recent physical-state request through IIS: HTTP 200
- SPA route `/process-explorer`: HTTP 200 with React index
- `/api/nonexistent`: backend HTTP 404 and not the React index
- Direct `10.8.10.97:3100` request: unreachable
- Browser bundle scan: no TelemetryQueryApi address/port, PostgreSQL port/database name, database role, or localhost Node endpoint
- Radius operational overview/episode feature is deployed fail-closed. `/api/radius/health` returns sanitized HTTP 503 `not_configured` until live discovery and a dedicated SELECT-only role are completed; existing telemetry remains healthy.

## Isolation and remaining layers

The existing `Press Radius OPC Dashboard` site, application pool, `10.8.10.97:5005` binding, physical path, and rewrite rule were not changed. The Default Web Site was also unchanged.

No Windows Firewall rule, DNS record, TLS certificate, HTTPS binding, port 80/443 binding, Radius database integration, PostgreSQL change, or MARKUSPRODSVR change is part of the current deployment. Remote client/network access is not yet validated and requires a separate approved phase.
