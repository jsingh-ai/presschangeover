# Process Intelligence Node service

Status: implemented and validated on FORMPRODSVR02 on 2026-08-11.

## Implemented service

- Service name: `ProcessIntelligence.Node`
- Display name: `Process Intelligence Node API`
- Service manager: NSSM 2.24-101-g897c7ad (64-bit)
- NSSM service binary: `C:\ProcessIntelligence\tools\nssm.exe`
- Service account: `NT AUTHORITY\LocalService`
- Startup: Automatic (Delayed Start)
- PowerShell executable: `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`
- PowerShell arguments: `-NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\ProcessIntelligence\scripts\start-processintelligence.ps1`
- NSSM working directory: `C:\ProcessIntelligence`
- Node executable: `C:\Program Files\nodejs\node.exe`
- Node working directory: `C:\ProcessIntelligence\app\server`
- Runtime entrypoint: `C:\ProcessIntelligence\app\server\dist\index.js`
- External configuration: `C:\ProcessIntelligence\config\processintelligence.env`
- Binding: `127.0.0.1:3100`

The launcher loads the external configuration without printing its values, starts the deployed Node entrypoint synchronously, waits for Node to exit, and propagates the Node exit code to NSSM. The service does not depend on an interactive PowerShell profile or desktop session.

## Permissions

`NT AUTHORITY\LOCAL SERVICE` has the following explicit minimum permissions:

- `C:\ProcessIntelligence\app`: Read & Execute, inherited by deployed files
- `C:\ProcessIntelligence\config`: Read & Execute for directory traversal
- `C:\ProcessIntelligence\config\processintelligence.env`: Read
- `C:\ProcessIntelligence\scripts\start-processintelligence.ps1`: Read & Execute
- `C:\ProcessIntelligence\tools`: Read & Execute
- `C:\ProcessIntelligence\logs`: Modify, inherited by service log files

LocalService has no explicit write grant on the application, configuration, scripts, backups, or staging directories.

## Logging and recovery

- Standard output: `C:\ProcessIntelligence\logs\service-stdout.log`
- Standard error: `C:\ProcessIntelligence\logs\service-stderr.log`
- NSSM online log rotation: enabled
- Rotation size threshold: 10 MiB
- NSSM application restart delay: 5 seconds
- NSSM default application exit action: Restart
- Windows service recovery: restart after 5 seconds on the first, second, and subsequent failures
- Recovery failure-count reset period: 86,400 seconds
- NSSM process-tree termination: enabled

## Common operations

Run these commands from an elevated PowerShell session:

```powershell
Get-Service -Name 'ProcessIntelligence.Node'
Start-Service -Name 'ProcessIntelligence.Node'
Stop-Service -Name 'ProcessIntelligence.Node'
Restart-Service -Name 'ProcessIntelligence.Node'
```

Local backend health can be checked without involving IIS:

```powershell
Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:3100/api/health'
Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:3100/api/telemetry/health'
```

## Validation status

- Service start and localhost-only TCP listener validated
- Local health, telemetry health, source discovery, and recent physical-state request validated
- Controlled stop/start validated with no orphan ProcessIntelligence Node process
- Intentional Node-child termination validated; NSSM created a new Node process and restored health
- Automatic/delayed startup and recovery configuration inspected for reboot readiness
- No VM reboot was performed
- IIS, ARR, URL Rewrite, firewall, DNS, TLS, Radius/opc-radius, PostgreSQL, and MARKUSPRODSVR were not changed during this service phase
