#Requires -Version 5.1
[CmdletBinding()]
param(
    [ValidateRange(1, 3650)]
    [int]$OlderThanDays = 7,

    [switch]$Apply
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
        throw "Unsafe path outside transient root: $fullPath"
    }
}

function Assert-SafeCleanupCandidate {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Root
    )

    Assert-PathWithin -Path $Path -Root $Root
    $fullPath = Get-NormalizedPath $Path
    $fullRoot = Get-NormalizedPath $Root
    $parentPath = Get-NormalizedPath (Split-Path -Parent $fullPath)
    if (!$parentPath.Equals($fullRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Cleanup accepts only immediate children of its transient roots: $fullPath"
    }

    $item = Get-Item -LiteralPath $fullPath -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Cleanup refuses reparse points: $fullPath"
    }
    if ($item.PSIsContainer) {
        $nestedReparsePoint = Get-ChildItem -LiteralPath $fullPath -Recurse -Force |
            Where-Object { ($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 } |
            Select-Object -First 1
        if ($null -ne $nestedReparsePoint) {
            throw "Cleanup refuses a directory containing a reparse point: $($nestedReparsePoint.FullName)"
        }
    }
}

$scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Get-NormalizedPath (Join-Path $scriptDirectory '..')
$expectedRoot = Get-NormalizedPath 'C:\ProcessIntelligence'
if (!$projectRoot.Equals($expectedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Transient cleanup is allowed only in $expectedRoot"
}

$transientRoots = @(
    (Join-Path $projectRoot 'staging'),
    (Join-Path $projectRoot 'artifacts\validation')
)
$cutoffUtc = [DateTime]::UtcNow.AddDays(-$OlderThanDays)
$candidates = @()

foreach ($transientRoot in $transientRoots) {
    if (!(Test-Path -LiteralPath $transientRoot -PathType Container)) {
        continue
    }

    foreach ($item in Get-ChildItem -LiteralPath $transientRoot -Force) {
        if ($item.Name -eq '.gitkeep' -or $item.LastWriteTimeUtc -ge $cutoffUtc) {
            continue
        }

        $isStagingRoot = (Get-NormalizedPath $transientRoot).Equals(
            (Get-NormalizedPath (Join-Path $projectRoot 'staging')),
            [System.StringComparison]::OrdinalIgnoreCase
        )
        if ($isStagingRoot -and (!$item.PSIsContainer -or $item.Name -notmatch '^(\d{8}-\d{6}|(?:deployment|rollback)-\d{8}-\d{6}-[0-9a-f]{32})$')) {
            continue
        }

        Assert-SafeCleanupCandidate -Path $item.FullName -Root $transientRoot

        $bytes = if ($item.PSIsContainer) {
            [long](Get-ChildItem -LiteralPath $item.FullName -Recurse -Force -File | Measure-Object -Property Length -Sum).Sum
        }
        else {
            [long]$item.Length
        }

        $candidates += [pscustomobject]@{
            Root = $transientRoot
            Path = $item.FullName
            LastWriteTimeUtc = $item.LastWriteTimeUtc
            Bytes = $bytes
        }
    }
}

if ($candidates.Count -eq 0) {
    Write-Host "No transient artifacts older than $OlderThanDays day(s) were found."
    return
}

$candidates | Sort-Object Path | Select-Object Path, LastWriteTimeUtc, Bytes | Format-Table -AutoSize
$totalBytes = [long]($candidates | Measure-Object -Property Bytes -Sum).Sum
Write-Host "Candidates: $($candidates.Count); bytes: $totalBytes"

if (!$Apply) {
    Write-Host 'Preview only. Re-run with -Apply to remove exactly these transient artifacts.'
    return
}

foreach ($candidate in $candidates) {
    Assert-SafeCleanupCandidate -Path $candidate.Path -Root $candidate.Root
    Remove-Item -LiteralPath $candidate.Path -Recurse -Force
}

Write-Host "Removed $($candidates.Count) transient artifact(s), totaling $totalBytes bytes."
