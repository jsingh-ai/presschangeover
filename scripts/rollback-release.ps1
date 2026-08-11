#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$BackupPath,

    [string]$ServiceName,

    [switch]$ConfirmRollback
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-NormalizedPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    return [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
}

function Assert-PathWithin {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Root
    )

    $fullPath = Get-NormalizedPath $Path
    $fullRoot = Get-NormalizedPath $Root
    if (!$fullPath.StartsWith($fullRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Unsafe path outside expected root: $fullPath"
    }
}

if ($env:COMPUTERNAME -ne 'FORMPRODSVR02') {
    throw 'Rollback is allowed only on FORMPRODSVR02'
}

$scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Get-NormalizedPath (Join-Path $scriptDirectory '..')
$expectedRoot = Get-NormalizedPath 'C:\ProcessIntelligence'
if (!$projectRoot.Equals($expectedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Rollback root must be $expectedRoot"
}

$appRoot = Join-Path $projectRoot 'app'
$configRoot = Join-Path $projectRoot 'config'
$logsRoot = Join-Path $projectRoot 'logs'
$stagingRoot = Join-Path $projectRoot 'staging'
$deploymentBackupsRoot = Join-Path $projectRoot 'backups\deployments'

foreach ($preservedDirectory in @($configRoot, $logsRoot)) {
    if (!(Test-Path -LiteralPath $preservedDirectory -PathType Container)) {
        throw "Preserved production directory is missing: $preservedDirectory"
    }
    Assert-PathWithin -Path $preservedDirectory -Root $projectRoot
}

$normalizedBackupPath = Get-NormalizedPath $BackupPath
Assert-PathWithin -Path $normalizedBackupPath -Root $deploymentBackupsRoot
if (!(Test-Path -LiteralPath $normalizedBackupPath -PathType Container)) {
    throw "Backup directory does not exist: $normalizedBackupPath"
}

$backupApp = Join-Path $normalizedBackupPath 'app'
foreach ($requiredBackupPath in @(
    $backupApp,
    (Join-Path $normalizedBackupPath 'rollback-metadata.json')
)) {
    if (!(Test-Path -LiteralPath $requiredBackupPath)) {
        throw "Backup structure is invalid: missing $requiredBackupPath"
    }
}

if (!$ConfirmRollback) {
    throw 'Rollback is disabled until -ConfirmRollback is explicitly supplied after review'
}
if ([string]::IsNullOrWhiteSpace($ServiceName)) {
    throw 'Service operations are disabled until the dedicated service name is explicitly configured'
}
if ($ServiceName -ne 'ProcessIntelligence.Node') {
    throw 'Only the dedicated ProcessIntelligence.Node service is permitted'
}

$service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($null -eq $service) {
    throw 'The dedicated ProcessIntelligence Node service does not exist; rollback is refused'
}

$operationId = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')
$workingRoot = Join-Path $stagingRoot "rollback-$operationId-$([Guid]::NewGuid().ToString('N'))"
$preparedApp = Join-Path $workingRoot 'app'
$replacedAppRoot = Join-Path $deploymentBackupsRoot "rollback-replaced-$operationId"
$replacedApp = Join-Path $replacedAppRoot 'app'
$serviceWasRunning = $service.Status -eq 'Running'
$currentAppMoved = $false
$restoredAppActivated = $false

Assert-PathWithin -Path $workingRoot -Root $stagingRoot
Assert-PathWithin -Path $preparedApp -Root $workingRoot
Assert-PathWithin -Path $replacedAppRoot -Root $deploymentBackupsRoot

try {
    New-Item -ItemType Directory -Path $workingRoot, $replacedAppRoot -Force | Out-Null
    Copy-Item -LiteralPath $backupApp -Destination $workingRoot -Recurse

    if ($serviceWasRunning) {
        Stop-Service -Name $ServiceName -ErrorAction Stop
        (Get-Service -Name $ServiceName).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
    }

    if (Test-Path -LiteralPath $appRoot) {
        Move-Item -LiteralPath $appRoot -Destination $replacedApp
        $currentAppMoved = $true
    }
    Move-Item -LiteralPath $preparedApp -Destination $appRoot
    $restoredAppActivated = $true

    if ($serviceWasRunning) {
        Start-Service -Name $ServiceName -ErrorAction Stop
        (Get-Service -Name $ServiceName).WaitForStatus('Running', [TimeSpan]::FromSeconds(30))
    }

    Write-Host "Rollback completed from: $normalizedBackupPath"
    Write-Host "Replaced application retained at: $replacedAppRoot"
}
catch {
    if ($currentAppMoved -and (Test-Path -LiteralPath $replacedApp)) {
        if ($restoredAppActivated -and (Test-Path -LiteralPath $appRoot)) {
            $failedRestore = Join-Path $workingRoot 'failed-restore'
            Move-Item -LiteralPath $appRoot -Destination $failedRestore
        }
        if (!(Test-Path -LiteralPath $appRoot)) {
            Move-Item -LiteralPath $replacedApp -Destination $appRoot
        }
    }
    if ($serviceWasRunning) {
        $currentService = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
        if ($null -ne $currentService -and $currentService.Status -ne 'Running') {
            Start-Service -Name $ServiceName -ErrorAction SilentlyContinue
        }
    }
    throw
}
finally {
    if (Test-Path -LiteralPath $workingRoot) {
        Assert-PathWithin -Path $workingRoot -Root $stagingRoot
        Remove-Item -LiteralPath $workingRoot -Recurse -Force
    }
}
