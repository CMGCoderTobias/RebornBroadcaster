param(
    [Parameter(Mandatory = $true)]
    [string]$Version,
    [string]$Runtime = 'win-x64'
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$package = Get-Content (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json
if ([string]$package.version -ne $Version) {
    throw "package.json version '$($package.version)' does not match publisher version '$Version'."
}
if ([version]$Version -lt [version]'0.0.10') {
    throw 'The first native/agent release must be 0.0.10 or newer. Publish 0.0.9 with reborn-migration-release.json.'
}
foreach ($registrationName in @('rebornbroadcaster.app.json', 'rebornbroadcaster.testing.app.json')) {
    $registration = Get-Content (Join-Path $projectRoot "updater\$registrationName") -Raw | ConvertFrom-Json
    if ([string]$registration.currentVersion -ne $Version) {
        throw "$registrationName currentVersion '$($registration.currentVersion)' does not match publisher version '$Version'."
    }
}

Push-Location $projectRoot
try {
    & (Join-Path $projectRoot 'scripts\prepare-legacy-bridge.ps1')
    if (-not $?) {
        throw 'The legacy Electron bridge preparation failed.'
    }
    & (Join-Path $projectRoot 'native\scripts\build.ps1') -Version $Version -Runtime $Runtime
    if (-not $?) {
        throw 'The native release build failed.'
    }
} finally {
    Pop-Location
}
