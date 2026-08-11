#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ReleasePath,

    [string]$ServiceName,

    [switch]$SkipServiceControl,

    [switch]$ConfirmDeployment
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
        [Parameter(Mandatory = $true)][string]$Root,
        [switch]$AllowRoot
    )

    $fullPath = Get-NormalizedPath $Path
    $fullRoot = Get-NormalizedPath $Root
    if ($AllowRoot -and $fullPath.Equals($fullRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        return
    }
    if (!$fullPath.StartsWith($fullRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Unsafe path outside expected root: $fullPath"
    }
}

function Write-Utf8NoBom {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Content
    )

    [System.IO.File]::WriteAllText(
        $Path,
        $Content,
        [System.Text.UTF8Encoding]::new($false)
    )
}

if ($env:COMPUTERNAME -ne 'FORMPRODSVR02') {
    throw 'Deployment is allowed only on FORMPRODSVR02'
}

$scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Get-NormalizedPath (Join-Path $scriptDirectory '..')
$expectedRoot = Get-NormalizedPath 'C:\ProcessIntelligence'
if (!$projectRoot.Equals($expectedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Deployment root must be $expectedRoot"
}

$appRoot = Join-Path $projectRoot 'app'
$configRoot = Join-Path $projectRoot 'config'
$iisClientConfigPath = Join-Path $configRoot 'iis\ProcessIntelligence.web.config'
$logsRoot = Join-Path $projectRoot 'logs'
$stagingRoot = Join-Path $projectRoot 'staging'
$packagesRoot = Join-Path $projectRoot 'backups\packages'
$deploymentBackupsRoot = Join-Path $projectRoot 'backups\deployments'

foreach ($requiredDirectory in @($appRoot, $configRoot, $logsRoot, $stagingRoot)) {
    if (!(Test-Path -LiteralPath $requiredDirectory -PathType Container)) {
        throw "Expected production directory is missing: $requiredDirectory"
    }
    Assert-PathWithin -Path $requiredDirectory -Root $projectRoot
}

if (!(Test-Path -LiteralPath $iisClientConfigPath -PathType Leaf)) {
    throw "IIS client configuration is missing: $iisClientConfigPath"
}
Assert-PathWithin -Path $iisClientConfigPath -Root $configRoot

if ($ReleasePath -match '(?i)opc-radius') {
    throw 'Release paths associated with another application are rejected'
}

$normalizedReleasePath = Get-NormalizedPath $ReleasePath
$releaseIsStagedDirectory = Test-Path -LiteralPath $normalizedReleasePath -PathType Container
$releaseIsPackage = Test-Path -LiteralPath $normalizedReleasePath -PathType Leaf

if ($releaseIsStagedDirectory) {
    Assert-PathWithin -Path $normalizedReleasePath -Root $stagingRoot
}
elseif ($releaseIsPackage -and [System.IO.Path]::GetExtension($normalizedReleasePath) -eq '.zip') {
    Assert-PathWithin -Path $normalizedReleasePath -Root $packagesRoot
}
else {
    throw 'ReleasePath must be an existing staging directory or ZIP under backups\packages'
}

if (!$ConfirmDeployment) {
    throw 'Deployment is disabled until -ConfirmDeployment is explicitly supplied after review'
}

$service = $null
$serviceWasRunning = $false
if ($SkipServiceControl) {
    if (![string]::IsNullOrWhiteSpace($ServiceName)) {
        throw 'ServiceName cannot be combined with SkipServiceControl'
    }
}
else {
    if ([string]::IsNullOrWhiteSpace($ServiceName)) {
        throw 'Service operations are disabled until the dedicated service name is explicitly configured'
    }
    if ($ServiceName -ne 'ProcessIntelligence.Node') {
        throw 'Only the dedicated ProcessIntelligence.Node service is permitted'
    }

    $service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($null -eq $service) {
        throw 'The dedicated ProcessIntelligence Node service does not exist; deployment is refused'
    }
    $serviceWasRunning = $service.Status -eq 'Running'
}

$operationId = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')
$workingRoot = Join-Path $stagingRoot "deployment-$operationId-$([Guid]::NewGuid().ToString('N'))"
$releaseRoot = $normalizedReleasePath
$preparedApp = Join-Path $workingRoot 'app'
$backupRoot = Join-Path $deploymentBackupsRoot $operationId
$backupApp = Join-Path $backupRoot 'app'
$currentAppMoved = $false
$newAppActivated = $false

Assert-PathWithin -Path $workingRoot -Root $stagingRoot
Assert-PathWithin -Path $preparedApp -Root $workingRoot
Assert-PathWithin -Path $backupRoot -Root $deploymentBackupsRoot
Assert-PathWithin -Path $backupApp -Root $backupRoot

try {
    New-Item -ItemType Directory -Path $workingRoot -Force | Out-Null

    if ($releaseIsPackage) {
        $expandedRoot = Join-Path $workingRoot 'release'
        New-Item -ItemType Directory -Path $expandedRoot -Force | Out-Null
        Expand-Archive -LiteralPath $normalizedReleasePath -DestinationPath $expandedRoot
        $releaseRoot = $expandedRoot
    }

    foreach ($requiredReleasePath in @(
        (Join-Path $releaseRoot 'client\index.html'),
        (Join-Path $releaseRoot 'server\dist\index.js'),
        (Join-Path $releaseRoot 'server\package.json'),
        (Join-Path $releaseRoot 'server\node_modules'),
        (Join-Path $releaseRoot 'release-manifest.json')
    )) {
        if (!(Test-Path -LiteralPath $requiredReleasePath)) {
            throw "Release structure is invalid: missing $requiredReleasePath"
        }
    }

    $environmentFiles = @(Get-ChildItem -LiteralPath $releaseRoot -Recurse -Force -File |
        Where-Object { $_.Name -like '.env*' -or $_.Name -eq 'processintelligence.env' })
    if ($environmentFiles.Count -gt 0) {
        throw 'Release contains an environment file; deployment is refused'
    }

    New-Item -ItemType Directory -Path $preparedApp -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $releaseRoot 'client') -Destination $preparedApp -Recurse
    Copy-Item -LiteralPath (Join-Path $releaseRoot 'server') -Destination $preparedApp -Recurse
    Copy-Item -LiteralPath (Join-Path $releaseRoot 'release-manifest.json') -Destination $preparedApp
    Copy-Item -LiteralPath $iisClientConfigPath -Destination (Join-Path $preparedApp 'client\web.config') -Force

    New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
    $rollbackMetadata = [ordered]@{
        createdUtc = [DateTime]::UtcNow.ToString('o')
        serviceName = $ServiceName
        sourceRelease = $normalizedReleasePath
        previousAppPath = $backupApp
        preservedConfigPath = $configRoot
        preservedLogsPath = $logsRoot
    }
    Write-Utf8NoBom -Path (Join-Path $backupRoot 'rollback-metadata.json') -Content ($rollbackMetadata | ConvertTo-Json -Depth 5)

    if ($serviceWasRunning) {
        Stop-Service -Name $ServiceName -ErrorAction Stop
        (Get-Service -Name $ServiceName).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
    }

    Move-Item -LiteralPath $appRoot -Destination $backupApp
    $currentAppMoved = $true
    Move-Item -LiteralPath $preparedApp -Destination $appRoot
    $newAppActivated = $true

    if ($serviceWasRunning) {
        Start-Service -Name $ServiceName -ErrorAction Stop
        (Get-Service -Name $ServiceName).WaitForStatus('Running', [TimeSpan]::FromSeconds(30))
    }

    Write-Host "Deployment completed. Rollback backup: $backupRoot"
}
catch {
    if ($currentAppMoved -and (Test-Path -LiteralPath $backupApp)) {
        if ($newAppActivated -and (Test-Path -LiteralPath $appRoot)) {
            $failedApp = Join-Path $workingRoot 'failed-app'
            Move-Item -LiteralPath $appRoot -Destination $failedApp
        }
        if (!(Test-Path -LiteralPath $appRoot)) {
            Move-Item -LiteralPath $backupApp -Destination $appRoot
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
