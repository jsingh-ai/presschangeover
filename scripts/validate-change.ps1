#Requires -Version 5.1
[CmdletBinding()]
param(
    [ValidateSet('Css', 'Client', 'Server', 'Full')]
    [string]$Scope = 'Full'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-NormalizedPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    return [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
}

$scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Get-NormalizedPath (Join-Path $scriptDirectory '..')
$expectedRoot = Get-NormalizedPath 'C:\ProcessIntelligence'
$worktreeRoot = Get-NormalizedPath (Join-Path $expectedRoot 'worktrees')

if (!$projectRoot.Equals($expectedRoot, [System.StringComparison]::OrdinalIgnoreCase) -and !$projectRoot.StartsWith($worktreeRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Validation must run from the ProcessIntelligence repository or an isolated worktree under $worktreeRoot"
}

foreach ($requiredPath in @(
    (Join-Path $projectRoot 'package.json'),
    (Join-Path $projectRoot 'package-lock.json'),
    (Join-Path $projectRoot 'client\package.json'),
    (Join-Path $projectRoot 'server\package.json')
)) {
    if (!(Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
        throw "Required project file is missing: $requiredPath"
    }
}

if (!(Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules') -PathType Container)) {
    throw 'Dependencies are not installed. Run npm ci from the repository root first.'
}

$npmCommand = (Get-Command npm.cmd -ErrorAction Stop).Source
$scriptName = "validate:$($Scope.ToLowerInvariant())"

Write-Host "Running $Scope validation only; no release package or deployment will be created."
Push-Location $projectRoot
try {
    & $npmCommand run $scriptName
    if ($LASTEXITCODE -ne 0) {
        throw "$scriptName failed with exit code $LASTEXITCODE"
    }
}
finally {
    Pop-Location
}

Write-Host "$Scope validation passed."
