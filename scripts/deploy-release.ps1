#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ReleasePath,

    [string]$ServiceName,

    [switch]$SkipServiceControl,

    [switch]$ConfirmDeployment,

    [switch]$ValidateOnly
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

if (!$ValidateOnly -and $env:COMPUTERNAME -ne 'FORMPRODSVR02') {
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
$releasesRoot = Join-Path $projectRoot 'releases'
$deploymentBackupsRoot = Join-Path $projectRoot 'backups\deployments'

foreach ($requiredDirectory in @($appRoot, $configRoot, $logsRoot, $stagingRoot, $releasesRoot)) {
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
$releaseIsPackage = Test-Path -LiteralPath $normalizedReleasePath -PathType Leaf
if (!$releaseIsPackage -or [System.IO.Path]::GetExtension($normalizedReleasePath) -ne '.zip') {
    throw 'ReleasePath must be an existing ZIP under releases; mutable staging directories cannot be deployed'
}
Assert-PathWithin -Path $normalizedReleasePath -Root $releasesRoot

$hashPath = "$normalizedReleasePath.sha256"
if (!(Test-Path -LiteralPath $hashPath -PathType Leaf)) {
    throw "Release checksum is missing: $hashPath"
}
Assert-PathWithin -Path $hashPath -Root $releasesRoot

$hashRecord = (Get-Content -LiteralPath $hashPath -Raw).Trim()
if ($hashRecord -notmatch '^([0-9a-fA-F]{64})\s+(.+)$') {
    throw "Release checksum file is malformed: $hashPath"
}
$expectedHash = $Matches[1].ToUpperInvariant()
$recordedFileName = $Matches[2].Trim()
$releaseFileName = [System.IO.Path]::GetFileName($normalizedReleasePath)
if ($recordedFileName -ne $releaseFileName) {
    throw "Release checksum names a different package: $recordedFileName"
}
$actualHash = (Get-FileHash -LiteralPath $normalizedReleasePath -Algorithm SHA256).Hash
if ($actualHash -ne $expectedHash) {
    throw 'Release package SHA-256 does not match its checksum file'
}

if ($ValidateOnly -and ($ConfirmDeployment -or $SkipServiceControl -or ![string]::IsNullOrWhiteSpace($ServiceName))) {
    throw 'ValidateOnly cannot be combined with deployment confirmation or service options'
}
if (!$ValidateOnly -and !$ConfirmDeployment) {
    throw 'Deployment is disabled until -ConfirmDeployment is explicitly supplied after review'
}

$service = $null
$serviceWasRunning = $false
if ($ValidateOnly) {
    # Package validation does not inspect or control services.
}
elseif ($SkipServiceControl) {
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
$releaseRoot = Join-Path $workingRoot 'release'
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
    New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null
    Expand-Archive -LiteralPath $normalizedReleasePath -DestinationPath $releaseRoot

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

    $manifestPath = Join-Path $releaseRoot 'release-manifest.json'
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    foreach ($requiredManifestProperty in @('schemaVersion', 'releaseId', 'sourceBranch', 'gitCommit', 'testStatus')) {
        if ($requiredManifestProperty -notin $manifest.PSObject.Properties.Name) {
            throw "Release manifest is missing $requiredManifestProperty"
        }
    }
    if ($manifest.schemaVersion -ne 1) {
        throw "Unsupported release manifest schema: $($manifest.schemaVersion)"
    }
    if ($manifest.gitCommit -notmatch '^[0-9a-fA-F]{40}$') {
        throw 'Release manifest does not contain a full Git commit SHA'
    }
    if ($manifest.testStatus -ne 'passed') {
        throw 'Release manifest does not record passed validation'
    }
    if ($releaseFileName -ne "ProcessIntelligence-$($manifest.releaseId).zip") {
        throw 'Release filename does not match the manifest release ID'
    }
    $commitType = (& git -C $projectRoot cat-file -t $manifest.gitCommit 2>$null | Select-Object -First 1)
    if ($LASTEXITCODE -ne 0 -or $commitType -ne 'commit') {
        throw "Release source commit is not available locally: $($manifest.gitCommit)"
    }

    if ($ValidateOnly) {
        Write-Host 'Release package validation passed.'
        Write-Host "Release ID: $($manifest.releaseId)"
        Write-Host "Git commit: $($manifest.gitCommit)"
        Write-Host "SHA-256: $actualHash"
        return
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
        sourceReleaseSha256 = $actualHash
        releaseId = $manifest.releaseId
        gitCommit = $manifest.gitCommit
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
