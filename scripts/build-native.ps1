param(
    [string]$Runtime = 'win-x64'
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$package = Get-Content (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json
& (Join-Path $projectRoot 'native\scripts\build.ps1') -Version ([string]$package.version) -Runtime $Runtime
if (-not $?) {
    throw 'The native release build failed.'
}
