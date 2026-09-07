param(
    [string]$BridgeVersion = '0.0.10'
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimeRoot = Join-Path $projectRoot 'updater-runtime'
$legacyRoot = Join-Path $projectRoot 'legacy-electron'

Push-Location $projectRoot
try {
    & (Join-Path $PSScriptRoot 'prepare-updater-assets.ps1')
    if (-not $?) {
        throw 'Unable to prepare updater assets for the legacy bridge.'
    }
    foreach ($registrationName in @('rebornbroadcaster.app.json', 'rebornbroadcaster.testing.app.json')) {
        $path = Join-Path $runtimeRoot $registrationName
        $registration = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
        $registration.currentVersion = $BridgeVersion
        $registration | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $path -Encoding utf8NoBOM
    }
    & npx electron-builder "--config.extraMetadata.version=$BridgeVersion"
    if ($LASTEXITCODE -ne 0) {
        throw 'The Electron recovery bridge build failed.'
    }
    New-Item -ItemType Directory -Path $legacyRoot -Force | Out-Null
    $installer = "RebornBroadcaster-Setup-$BridgeVersion.exe"
    Copy-Item -LiteralPath (Join-Path $projectRoot "dist\$installer") -Destination (Join-Path $legacyRoot $installer) -Force
    Copy-Item -LiteralPath (Join-Path $projectRoot "dist\$installer.blockmap") -Destination (Join-Path $legacyRoot "$installer.blockmap") -Force
    Copy-Item -LiteralPath (Join-Path $projectRoot 'dist\latest.yml') -Destination (Join-Path $legacyRoot 'latest.yml') -Force
    Write-Host "Legacy Electron recovery bridge ready: $legacyRoot"
} finally {
    Pop-Location
}
