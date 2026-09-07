param(
    [string]$AgentRepository = ''
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not $AgentRepository) {
    $codingRoot = Split-Path -Parent (Split-Path -Parent $projectRoot)
    $AgentRepository = Join-Path $codingRoot 'RebornUpdateAgent'
}
$agentRepository = [System.IO.Path]::GetFullPath($AgentRepository)
$sourceRoot = Join-Path $AgentRepository 'artifacts\win-x64'
$destination = Join-Path $projectRoot 'updater-runtime'
$bootstrap = Join-Path $sourceRoot 'bootstrap\RebornUpdateBootstrap.exe'
$launcher = Join-Path $sourceRoot 'launcher\RebornAppLauncher.exe'

foreach ($required in @($bootstrap, $launcher)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "Missing updater artifact: $required. Build RebornUpdateAgent win-x64 first."
    }
}

if (Test-Path -LiteralPath $destination) {
    Remove-Item -LiteralPath $destination -Recurse -Force
}
New-Item -ItemType Directory -Path $destination -Force | Out-Null
Copy-Item -LiteralPath $bootstrap -Destination $destination
Copy-Item -LiteralPath $launcher -Destination $destination
Get-ChildItem -LiteralPath (Join-Path $projectRoot 'updater') -File | Copy-Item -Destination $destination

Write-Host "Updater migration assets ready: $destination"
