#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$EndUtc = '',
    [string]$StartUtc = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$environmentPath = Join-Path $projectRoot 'config\processintelligence.env'
if (!(Test-Path -LiteralPath $environmentPath -PathType Leaf)) { throw 'Production environment file is missing.' }
foreach ($line in Get-Content -LiteralPath $environmentPath) {
    $trimmed = $line.Trim()
    if (!$trimmed -or $trimmed.StartsWith('#')) { continue }
    if ($trimmed -notmatch '^([A-Za-z_][A-Za-z0-9_]*)=(.*)$') { throw 'Invalid production environment entry.' }
    [System.Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], [System.EnvironmentVariableTarget]::Process)
}
if ($env:RADIUS_DB_USER -ne 'processintelligence_readonly') { throw 'Validation requires processintelligence_readonly.' }
$arguments = @('server\scripts\validate-explorers-live.ts')
if ($StartUtc) { $arguments += @('--start', $StartUtc) }
if ($EndUtc) { $arguments += @('--end', $EndUtc) }
Push-Location $projectRoot
try {
    & (Join-Path $projectRoot 'node_modules\.bin\tsx.cmd') @arguments
    if ($LASTEXITCODE -ne 0) { throw "Read-only explorer validation failed with exit code $LASTEXITCODE." }
}
finally { Pop-Location }
