param()

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$bridgeRoot = Join-Path $projectRoot 'legacy-electron'
$bridgeVersion = '0.0.10'
$installerName = "RebornBroadcaster-Setup-$bridgeVersion.exe"
$blockmapName = "$installerName.blockmap"
$metadataName = 'latest.yml'
$installer = Join-Path $bridgeRoot $installerName
$blockmap = Join-Path $bridgeRoot $blockmapName
$metadata = Join-Path $bridgeRoot $metadataName
$localInstaller = Join-Path $projectRoot "dist\$installerName"
$localBlockmap = Join-Path $projectRoot "dist\$blockmapName"
$localMetadata = Join-Path $projectRoot "dist\$metadataName"
$releaseBaseUrl = 'https://github.com/CMGCoderTobias/RebornBroadcaster/releases/download/v0.1.4'

New-Item -ItemType Directory -Path $bridgeRoot -Force | Out-Null

function Stage-BridgeFile {
    param(
        [Parameter(Mandatory = $true)][string]$Destination,
        [Parameter(Mandatory = $true)][string]$LocalSource,
        [Parameter(Mandatory = $true)][string]$DownloadUrl
    )
    if (Test-Path -LiteralPath $Destination -PathType Leaf) {
        return
    }
    if (Test-Path -LiteralPath $LocalSource -PathType Leaf) {
        Copy-Item -LiteralPath $LocalSource -Destination $Destination
        return
    }
    Write-Host "Downloading permanent Electron bridge asset: $DownloadUrl"
    Invoke-WebRequest -Uri $DownloadUrl -OutFile $Destination
}

Stage-BridgeFile -Destination $installer -LocalSource $localInstaller -DownloadUrl "$releaseBaseUrl/$installerName"
Stage-BridgeFile -Destination $blockmap -LocalSource $localBlockmap -DownloadUrl "$releaseBaseUrl/$blockmapName"
Stage-BridgeFile -Destination $metadata -LocalSource $localMetadata -DownloadUrl "$releaseBaseUrl/$metadataName"

$metadataText = Get-Content -LiteralPath $metadata -Raw
$metadataVersion = [regex]::Match($metadataText, '(?m)^version:\s*([^\r\n]+)').Groups[1].Value.Trim()
$expectedSizeText = [regex]::Match($metadataText, '(?m)^\s*size:\s*(\d+)').Groups[1].Value
$expectedSha512 = [regex]::Match($metadataText, '(?m)^sha512:\s*([^\r\n]+)').Groups[1].Value.Trim()
if ($metadataVersion -ne $bridgeVersion -or -not $expectedSizeText -or -not $expectedSha512) {
    throw "Legacy bridge metadata is invalid or is not version $bridgeVersion."
}
$expectedSize = [long]$expectedSizeText
$installerInfo = Get-Item -LiteralPath $installer
if ($installerInfo.Length -ne $expectedSize) {
    throw "Legacy bridge installer size '$($installerInfo.Length)' does not match expected size '$expectedSize'."
}
$stream = [System.IO.File]::OpenRead($installer)
try {
    $algorithm = [System.Security.Cryptography.SHA512]::Create()
    try {
        $actualSha512 = [Convert]::ToBase64String($algorithm.ComputeHash($stream))
    } finally {
        $algorithm.Dispose()
    }
} finally {
    $stream.Dispose()
}
if ($actualSha512 -ne $expectedSha512) {
    throw 'Legacy bridge installer checksum does not match the signed 0.0.9 update metadata.'
}

Write-Host "Verified permanent Electron bridge assets: $bridgeRoot"
