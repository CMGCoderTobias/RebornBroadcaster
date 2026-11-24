param(
    [Parameter(Mandatory = $true)][string]$Version,
    [string]$AgentVersion = '',
    [string]$Runtime = 'win-x64'
)

$ErrorActionPreference = 'Stop'
if ($Runtime -ne 'win-x64') { throw "This installer script builds only win-x64; requested $Runtime." }

$projectRoot = Split-Path -Parent $PSScriptRoot
$codingRoot = Split-Path -Parent (Split-Path -Parent $projectRoot)
$agentRoot = Join-Path $codingRoot 'RebornUpdateAgent'
if ([string]::IsNullOrWhiteSpace($AgentVersion)) {
    $AgentVersion = (Get-Content -LiteralPath (Join-Path $agentRoot 'VERSION') -Raw).Trim()
}

$appOutput = Join-Path $projectRoot "release-output\$Version"
$agentOutput = Join-Path $agentRoot "release-output\rebornupdateagent\$AgentVersion"
$appManifest = Join-Path $appOutput 'reborn-update-manifest.json'
$appPackage = Join-Path $appOutput "rebornbroadcaster-$Version-$Runtime.zip"
$agentManifest = Join-Path $agentOutput 'reborn-update-manifest.json'
$agentPackage = Join-Path $agentOutput "rebornupdateagent-$AgentVersion-$Runtime.zip"
$installer = Join-Path $agentRoot 'scripts\New-RebornAppInstaller.ps1'
$output = Join-Path $projectRoot "release-installers\RebornBroadcaster-Setup-$Version.exe"

foreach ($path in @($appManifest, $appPackage, $agentManifest, $agentPackage, $installer)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Required offline release input was not found: $path" }
}

& $installer `
    -AppId 'rebornbroadcaster' `
    -DisplayName 'RebornBroadcaster' `
    -AppVersion $Version `
    -InstallDirectoryName 'rebornbroadcaster' `
    -AppConfig (Join-Path $projectRoot 'updater\rebornbroadcaster.app.json') `
    -BootstrapConfig (Join-Path $projectRoot 'updater\agent-bootstrap.json') `
    -LauncherConfig (Join-Path $projectRoot 'updater\reborn-launch.json') `
    -InstalledLauncherName 'RebornAppLauncher.exe' `
    -OutputPath $output `
    -Runtime $Runtime `
    -ArtifactRoot (Join-Path $agentRoot "artifacts\$Runtime") `
    -AppManifest $appManifest `
    -AppPackage $appPackage `
    -AgentManifest $agentManifest `
    -AgentPackage $agentPackage
if ($LASTEXITCODE -ne 0) { throw 'Offline Windows installer creation failed.' }

Write-Host "Offline Windows installer ready: $output"
