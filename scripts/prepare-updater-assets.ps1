param([string]$AgentRepository = '')

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not $AgentRepository) {
    $codingRoot = Split-Path -Parent (Split-Path -Parent $projectRoot)
    $AgentRepository = Join-Path $codingRoot 'RebornUpdateAgent'
}
$agentRepository = [IO.Path]::GetFullPath($AgentRepository)
$destination = Join-Path $projectRoot 'updater-runtime'
$source = Join-Path $projectRoot 'updater'
$version = [string](Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json).version
if (Test-Path -LiteralPath $destination) { Remove-Item -LiteralPath $destination -Recurse -Force }
& (Join-Path $agentRepository 'scripts\New-AppIntegrationBundle.ps1') `
    -Runtime win-x64 `
    -AppConfig (Join-Path $source 'rebornbroadcaster.app.json') `
    -BootstrapConfig (Join-Path $source 'agent-bootstrap.json') `
    -LauncherConfig (Join-Path $source 'reborn-launch.json') `
    -AppVersion $version `
    -OutputDirectory $destination
if ($LASTEXITCODE -ne 0) { throw 'Universal Reborn updater integration bundle failed.' }
Copy-Item -LiteralPath (Join-Path $destination 'app-config.json') -Destination (Join-Path $destination 'rebornbroadcaster.app.json')
$testing = Get-Content -LiteralPath (Join-Path $source 'rebornbroadcaster.testing.app.json') -Raw | ConvertFrom-Json
$testing.currentVersion = $version
$testing | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath (Join-Path $destination 'rebornbroadcaster.testing.app.json') -Encoding utf8NoBOM
Copy-Item -LiteralPath (Join-Path $source 'agent-bootstrap.testing.json') -Destination $destination
Write-Host "Universal updater integration prepared for RebornBroadcaster $version."
