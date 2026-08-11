#Requires -Version 5.1
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($env:COMPUTERNAME -ne 'FORMPRODSVR02') {
    throw 'ProcessIntelligence may be launched only on FORMPRODSVR02'
}

$scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $scriptDirectory '..')).TrimEnd('\')
$expectedRoot = [System.IO.Path]::GetFullPath('C:\ProcessIntelligence').TrimEnd('\')
if (!$projectRoot.Equals($expectedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "ProcessIntelligence root must be $expectedRoot"
}

$environmentPath = Join-Path $projectRoot 'config\processintelligence.env'
$serverDirectory = Join-Path $projectRoot 'app\server'
$entryPoint = Join-Path $serverDirectory 'dist\index.js'

if (!(Test-Path -LiteralPath $environmentPath -PathType Leaf)) {
    throw "Production environment file is missing: $environmentPath"
}
if (!(Test-Path -LiteralPath $entryPoint -PathType Leaf)) {
    throw "Deployed server entry point is missing: $entryPoint"
}
if (!(Test-Path -LiteralPath (Join-Path $serverDirectory 'node_modules\express') -PathType Container)) {
    throw 'Deployed production dependencies are missing'
}

$environmentValues = @{}
$lineNumber = 0
foreach ($line in Get-Content -LiteralPath $environmentPath) {
    $lineNumber += 1
    $trimmedLine = $line.Trim()
    if ($trimmedLine.Length -eq 0 -or $trimmedLine.StartsWith('#')) {
        continue
    }
    if ($trimmedLine -notmatch '^([A-Za-z_][A-Za-z0-9_]*)=(.*)$') {
        throw "Invalid environment entry at line $lineNumber"
    }

    $name = $Matches[1]
    $value = $Matches[2]
    if ($environmentValues.ContainsKey($name)) {
        throw "Duplicate environment variable at line $lineNumber"
    }
    $environmentValues[$name] = $value
}

foreach ($requiredName in @(
    'NODE_ENV',
    'HOST',
    'PORT',
    'TELEMETRY_API_BASE_URL',
    'TELEMETRY_API_TIMEOUT_MS'
)) {
    if (!$environmentValues.ContainsKey($requiredName) -or
        [string]::IsNullOrWhiteSpace($environmentValues[$requiredName])) {
        throw "Required production environment variable is missing: $requiredName"
    }
}

$nodeCommand = Get-Command node.exe -ErrorAction Stop | Select-Object -First 1
foreach ($entry in $environmentValues.GetEnumerator()) {
    [System.Environment]::SetEnvironmentVariable(
        $entry.Key,
        $entry.Value,
        [System.EnvironmentVariableTarget]::Process
    )
}

$nodeExitCode = 1
Push-Location $serverDirectory
try {
    Write-Host 'ProcessIntelligence Node starting'
    & $nodeCommand.Source $entryPoint
    $nodeExitCode = $LASTEXITCODE
}
finally {
    Pop-Location
}

exit $nodeExitCode
