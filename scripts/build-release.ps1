#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$ArtifactRoot = 'C:\ProcessIntelligence',

    [switch]$KeepStaging
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

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$FilePath failed with exit code $LASTEXITCODE"
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

$scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Get-NormalizedPath (Join-Path $scriptDirectory '..')
$expectedRoot = Get-NormalizedPath 'C:\ProcessIntelligence'
$normalizedArtifactRoot = Get-NormalizedPath $ArtifactRoot
$worktreeRoot = Get-NormalizedPath (Join-Path $expectedRoot 'worktrees')

if (!$projectRoot.Equals($expectedRoot, [System.StringComparison]::OrdinalIgnoreCase) -and !$projectRoot.StartsWith($worktreeRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "This release script must run from the ProcessIntelligence repository or an isolated worktree under $worktreeRoot"
}
if (!$normalizedArtifactRoot.Equals($expectedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Release artifacts must remain under the established ProcessIntelligence root at $expectedRoot"
}

$clientSource = Join-Path $projectRoot 'client'
$serverSource = Join-Path $projectRoot 'server'
$stagingRoot = Join-Path $normalizedArtifactRoot 'staging'
$packageRoot = Join-Path $normalizedArtifactRoot 'releases'

foreach ($requiredPath in @(
    $clientSource,
    $serverSource,
    (Join-Path $clientSource 'package.json'),
    (Join-Path $serverSource 'package.json'),
    (Join-Path $projectRoot 'package.json'),
    (Join-Path $projectRoot 'package-lock.json')
)) {
    if (!(Test-Path -LiteralPath $requiredPath)) {
        throw "Required project path is missing: $requiredPath"
    }
}

Assert-PathWithin -Path $stagingRoot -Root $normalizedArtifactRoot
Assert-PathWithin -Path $packageRoot -Root $normalizedArtifactRoot

$gitStatus = @(& git -C $projectRoot status --porcelain --untracked-files=all)
if ($LASTEXITCODE -ne 0) {
    throw 'Unable to verify the release source Git status'
}
if ($gitStatus.Count -gt 0) {
    throw 'Release packaging requires a clean Git worktree'
}

$gitCommit = (& git -C $projectRoot rev-parse --verify HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $gitCommit -notmatch '^[0-9a-fA-F]{40}$') {
    throw 'Unable to resolve the release source commit'
}
$gitBranch = (& git -C $projectRoot branch --show-current).Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($gitBranch)) {
    throw 'Release packaging requires an attached Git branch'
}

$npmCommand = (Get-Command npm.cmd -ErrorAction Stop).Source

Push-Location $projectRoot
try {
    Write-Host 'Validating source...'
    Invoke-Checked -FilePath $npmCommand -Arguments @('run', 'typecheck')
    Invoke-Checked -FilePath $npmCommand -Arguments @('test')
    try {
        Invoke-Checked -FilePath $npmCommand -Arguments @('run', 'build')
    }
    catch {
        Write-Host 'Initial production build failed; retrying once after completed test workers release build artifacts.'
        Start-Sleep -Seconds 3
        Invoke-Checked -FilePath $npmCommand -Arguments @('run', 'build')
    }
}
finally {
    Pop-Location
}

$releaseId = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')
$releasePath = Join-Path $stagingRoot $releaseId
$zipPath = Join-Path $packageRoot "ProcessIntelligence-$releaseId.zip"
$hashPath = "$zipPath.sha256"

Assert-PathWithin -Path $releasePath -Root $stagingRoot
Assert-PathWithin -Path $zipPath -Root $packageRoot
Assert-PathWithin -Path $hashPath -Root $packageRoot

if (Test-Path -LiteralPath $releasePath) {
    throw "Release staging path already exists: $releasePath"
}
if (Test-Path -LiteralPath $zipPath) {
    throw "Release package already exists: $zipPath"
}

$clientStage = Join-Path $releasePath 'client'
$serverStage = Join-Path $releasePath 'server'
$installRoot = Join-Path $releasePath '.runtime-install'

try {
    New-Item -ItemType Directory -Path $clientStage, $serverStage, $packageRoot -Force | Out-Null

    $clientDist = Join-Path $clientSource 'dist'
    $serverDist = Join-Path $serverSource 'dist'
    if (!(Test-Path -LiteralPath (Join-Path $clientDist 'index.html'))) {
        throw 'Client build output is missing index.html'
    }
    if (!(Test-Path -LiteralPath (Join-Path $serverDist 'index.js'))) {
        throw 'Server build output is missing index.js'
    }

    Copy-Item -Path (Join-Path $clientDist '*') -Destination $clientStage -Recurse -Force

    Get-ChildItem -LiteralPath $serverDist -Recurse -File |
        Where-Object { $_.Extension -eq '.js' } |
        ForEach-Object {
            $relativePath = $_.FullName.Substring($serverDist.Length).TrimStart('\')
            $destination = Join-Path (Join-Path $serverStage 'dist') $relativePath
            $destinationDirectory = Split-Path -Parent $destination
            New-Item -ItemType Directory -Path $destinationDirectory -Force | Out-Null
            Copy-Item -LiteralPath $_.FullName -Destination $destination -Force
        }

    $sourceServerPackage = Get-Content -LiteralPath (Join-Path $serverSource 'package.json') -Raw | ConvertFrom-Json
    $runtimePackage = [ordered]@{
        name = $sourceServerPackage.name
        version = $sourceServerPackage.version
        private = $true
        type = 'module'
        main = 'dist/index.js'
        scripts = [ordered]@{ start = 'node dist/index.js' }
        dependencies = $sourceServerPackage.dependencies
    }
    Write-Utf8NoBom -Path (Join-Path $serverStage 'package.json') -Content ($runtimePackage | ConvertTo-Json -Depth 10)

    New-Item -ItemType Directory -Path (Join-Path $installRoot 'client'), (Join-Path $installRoot 'server') -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $projectRoot 'package.json') -Destination $installRoot
    Copy-Item -LiteralPath (Join-Path $projectRoot 'package-lock.json') -Destination $installRoot
    Copy-Item -LiteralPath (Join-Path $clientSource 'package.json') -Destination (Join-Path $installRoot 'client')
    Copy-Item -LiteralPath (Join-Path $serverSource 'package.json') -Destination (Join-Path $installRoot 'server')

    Write-Host 'Installing staged production dependencies...'
    Invoke-Checked -FilePath $npmCommand -Arguments @(
        'ci',
        '--omit=dev',
        '--workspace',
        'server',
        '--include-workspace-root=false',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--prefix',
        $installRoot
    )

    $installedModules = Join-Path $installRoot 'node_modules'
    if (!(Test-Path -LiteralPath (Join-Path $installedModules 'express'))) {
        throw 'Fresh production dependency installation did not contain Express'
    }

    $workspaceLink = Join-Path $installedModules 'process-intelligence-server'
    if (Test-Path -LiteralPath $workspaceLink) {
        $linkItem = Get-Item -LiteralPath $workspaceLink -Force
        if (($linkItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0) {
            throw 'Unexpected non-link workspace package in fresh production dependencies'
        }
        [System.IO.Directory]::Delete($workspaceLink, $false)
    }

    Move-Item -LiteralPath $installedModules -Destination (Join-Path $serverStage 'node_modules')
    Remove-Item -LiteralPath $installRoot -Recurse -Force

    Invoke-Checked -FilePath $npmCommand -Arguments @(
        'prune',
        '--omit=dev',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--prefix',
        $serverStage
    )

    foreach ($developmentPackage in @('typescript', 'tsx', 'vite', 'react')) {
        if (Test-Path -LiteralPath (Join-Path (Join-Path $serverStage 'node_modules') $developmentPackage)) {
            throw "Development dependency was included in the staged server: $developmentPackage"
        }
    }
    $typesScope = Join-Path (Join-Path $serverStage 'node_modules') '@types'
    if (Test-Path -LiteralPath $typesScope) {
        $installedTypePackages = @(Get-ChildItem -LiteralPath $typesScope -Force)
        if ($installedTypePackages.Count -gt 0) {
            throw 'Development type packages were included in the staged server'
        }
        Remove-Item -LiteralPath $typesScope -Force
    }

    $manifest = [ordered]@{
        schemaVersion = 1
        releaseId = $releaseId
        buildUtc = [DateTime]::UtcNow.ToString('o')
        sourceBranch = $gitBranch
        gitCommit = $gitCommit
        nodeVersion = (& node --version).Trim()
        npmVersion = (& $npmCommand --version).Trim()
        clientBuildStatus = 'passed'
        serverBuildStatus = 'passed'
        testStatus = 'passed'
    }
    Write-Utf8NoBom -Path (Join-Path $releasePath 'release-manifest.json') -Content ($manifest | ConvertTo-Json -Depth 5)

    $forbiddenProjectArtifacts = @(
        (Join-Path $releasePath '.git'),
        (Join-Path $releasePath '.env'),
        (Join-Path $serverStage '.env'),
        (Join-Path $serverStage 'test')
    )
    foreach ($forbiddenPath in $forbiddenProjectArtifacts) {
        if (Test-Path -LiteralPath $forbiddenPath) {
            throw "Forbidden artifact found in release: $forbiddenPath"
        }
    }

    $ownSourceFiles = @(Get-ChildItem -LiteralPath (Join-Path $serverStage 'dist') -Recurse -File |
        Where-Object { $_.Extension -in @('.ts', '.map') })
    if ($ownSourceFiles.Count -gt 0) {
        throw 'Server source or source maps were included in the staged runtime'
    }

    $clientBundleMatches = @(Get-ChildItem -LiteralPath $clientStage -Recurse -File |
        Select-String -SimpleMatch -Pattern '10.0.1.157', '5080', '5432', 'pressstop', 'telemetryqueryapi_readonly', '127.0.0.1:3100' -ErrorAction SilentlyContinue)
    if ($clientBundleMatches.Count -gt 0) {
        throw 'Production client output contains a forbidden backend or database reference'
    }

    Compress-Archive -Path (Join-Path $releasePath '*') -DestinationPath $zipPath -CompressionLevel Optimal
    $hash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash
    Write-Utf8NoBom -Path $hashPath -Content "$hash  $([System.IO.Path]::GetFileName($zipPath))"
    $packageSize = (Get-Item -LiteralPath $zipPath).Length

    if (!$KeepStaging) {
        Assert-PathWithin -Path $releasePath -Root $stagingRoot
        Remove-Item -LiteralPath $releasePath -Recurse -Force
    }

    Write-Host ''
    Write-Host 'ProcessIntelligence release package created successfully.'
    Write-Host "Release ID: $releaseId"
    if ($KeepStaging) {
        Write-Host "Retained staging path: $releasePath"
    }
    else {
        Write-Host 'Temporary staging content: removed'
    }
    Write-Host "ZIP path: $zipPath"
    Write-Host "SHA-256: $hash"
    Write-Host "Package bytes: $packageSize"
}
catch {
    if (Test-Path -LiteralPath $releasePath) {
        Assert-PathWithin -Path $releasePath -Root $stagingRoot
        Remove-Item -LiteralPath $releasePath -Recurse -Force
    }
    if (Test-Path -LiteralPath $zipPath) {
        Assert-PathWithin -Path $zipPath -Root $packageRoot
        Remove-Item -LiteralPath $zipPath -Force
    }
    if (Test-Path -LiteralPath $hashPath) {
        Assert-PathWithin -Path $hashPath -Root $packageRoot
        Remove-Item -LiteralPath $hashPath -Force
    }
    throw
}
