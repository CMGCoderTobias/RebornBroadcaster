param(
    [Parameter(Mandatory = $true)]
    [string]$Version
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$package = Get-Content (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json
if ([string]$package.version -ne $Version) {
    throw "package.json version '$($package.version)' does not match publisher version '$Version'."
}
if ($Version -ne '0.0.9') {
    throw 'The Electron migration config is reserved for the 0.0.9 bridge release.'
}
foreach ($registrationName in @('rebornbroadcaster.app.json', 'rebornbroadcaster.testing.app.json')) {
    $registration = Get-Content (Join-Path $projectRoot "updater\$registrationName") -Raw | ConvertFrom-Json
    if ([string]$registration.currentVersion -ne $Version) {
        throw "$registrationName currentVersion '$($registration.currentVersion)' does not match publisher version '$Version'."
    }
}

Push-Location $projectRoot
try {
    & npm run build:migration
    if ($LASTEXITCODE -ne 0) {
        throw 'The Electron migration build failed.'
    }
} finally {
    Pop-Location
}
