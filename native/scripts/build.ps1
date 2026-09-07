param(
    [Parameter(Mandatory = $true)]
    [string]$Version,
    [string]$Runtime = 'win-x64'
)

$ErrorActionPreference = 'Stop'
if ($Runtime -ne 'win-x64') {
    throw "This machine currently builds only win-x64; requested $Runtime."
}

$nativeRoot = Split-Path -Parent $PSScriptRoot
$projectRoot = Split-Path -Parent $nativeRoot
$runtimePython = Join-Path $nativeRoot '.venv\Scripts\python.exe'
$buildVenv = Join-Path $nativeRoot '.build-venv'
$venvPython = Join-Path $buildVenv 'Scripts\python.exe'
$setupScript = Join-Path $PSScriptRoot 'setup.ps1'
$outputRoot = Join-Path $projectRoot "release-staging\$Runtime"
$packageRoot = Join-Path $outputRoot 'RebornBroadcaster'
$deploymentRoot = Join-Path $nativeRoot 'deployment'
$iconFile = Join-Path $nativeRoot 'build\KRBroadcasterIcon.ico'
$ffmpegPackage = Join-Path $projectRoot 'node_modules\ffmpeg-static'
$ffmpeg = Join-Path $ffmpegPackage 'ffmpeg.exe'

if (-not (Test-Path -LiteralPath $runtimePython -PathType Leaf)) {
    & $setupScript
}
if (-not (Test-Path -LiteralPath $venvPython -PathType Leaf)) {
    & $runtimePython -m venv $buildVenv
    if ($LASTEXITCODE -ne 0) {
        throw 'Unable to create the isolated native build environment.'
    }
}
if (-not (Test-Path -LiteralPath $ffmpeg -PathType Leaf)) {
    throw "Bundled FFmpeg was not found at $ffmpeg. Run npm install first."
}

$env:PIP_NO_CACHE_DIR = '1'
& $venvPython -m pip install --disable-pip-version-check --no-cache-dir -e "$nativeRoot[build]"
if ($LASTEXITCODE -ne 0) {
    throw 'Unable to install native build dependencies.'
}

$actualVersion = & $venvPython -c "from reborn_broadcaster import __version__; print(__version__)"
if ($LASTEXITCODE -ne 0 -or $actualVersion.Trim() -ne $Version) {
    throw "Native version '$actualVersion' does not match requested version '$Version'."
}

if (Test-Path -LiteralPath $packageRoot) {
    Remove-Item -LiteralPath $packageRoot -Recurse -Force
}
if (Test-Path -LiteralPath $deploymentRoot) {
    Remove-Item -LiteralPath $deploymentRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
New-Item -ItemType Directory -Path (Split-Path -Parent $iconFile) -Force | Out-Null
& $venvPython -c "from PySide6.QtGui import QImage; import sys; image=QImage(sys.argv[1]); raise SystemExit(0 if not image.isNull() and image.save(sys.argv[2], 'ICO') else 1)" (Join-Path $projectRoot 'assets\KRBroadcasterIcon.png') $iconFile
if ($LASTEXITCODE -ne 0) {
    throw 'Unable to prepare the Windows application icon.'
}

& $venvPython -m nuitka `
    (Join-Path $nativeRoot 'launcher.py') `
    --standalone `
    --follow-imports `
    --enable-plugin=pyside6 `
    --output-dir=$deploymentRoot `
    --output-filename=RebornBroadcaster.exe `
    --windows-console-mode=disable `
    --assume-yes-for-downloads `
    --windows-icon-from-ico=$iconFile `
    --noinclude-qt-translations `
    --include-data-files="$(Join-Path $nativeRoot 'qml\Main.qml')=qml/Main.qml" `
    --include-qt-plugins=platforminputcontexts,qml,qmllint,qmltooling,vectorimageformats `
    --noinclude-dlls=Qt6Charts* `
    --noinclude-dlls=Qt6Sensors* `
    --noinclude-dlls=Qt6WebEngine*
if ($LASTEXITCODE -ne 0) {
    throw 'The native Nuitka deployment failed to create the update payload.'
}

$generatedRoot = @(
    (Join-Path $deploymentRoot 'RebornBroadcaster.dist'),
    (Join-Path $deploymentRoot 'launcher.dist')
) | Where-Object { Test-Path -LiteralPath $_ -PathType Container } | Select-Object -First 1
if (-not $generatedRoot) {
    throw 'The PySide deployment output directory was not found.'
}
if ($generatedRoot -ne $packageRoot) {
    Move-Item -LiteralPath $generatedRoot -Destination $packageRoot
}
$generatedExecutable = Join-Path $packageRoot 'launcher.exe'
if (Test-Path -LiteralPath $generatedExecutable -PathType Leaf) {
    Move-Item -LiteralPath $generatedExecutable -Destination (Join-Path $packageRoot 'RebornBroadcaster.exe') -Force
}
Copy-Item -LiteralPath $ffmpeg -Destination (Join-Path $packageRoot 'ffmpeg.exe') -Force
Copy-Item -LiteralPath (Join-Path $ffmpegPackage 'ffmpeg.exe.LICENSE') -Destination (Join-Path $packageRoot 'FFMPEG-LICENSE.txt') -Force
Copy-Item -LiteralPath (Join-Path $ffmpegPackage 'ffmpeg.exe.README') -Destination (Join-Path $packageRoot 'FFMPEG-README.txt') -Force
Copy-Item -LiteralPath (Join-Path $projectRoot 'THIRD_PARTY_NOTICES.txt') -Destination (Join-Path $packageRoot 'THIRD_PARTY_NOTICES.txt') -Force
Copy-Item -LiteralPath (Join-Path $projectRoot 'assets') -Destination (Join-Path $packageRoot 'assets') -Recurse -Force
New-Item -ItemType Directory -Path (Join-Path $packageRoot 'tools') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $projectRoot 'scripts\Stop-RebornBroadcasterCore.ps1') -Destination (Join-Path $packageRoot 'tools\Stop-RebornBroadcasterCore.ps1') -Force
if (-not (Test-Path -LiteralPath (Join-Path $packageRoot 'RebornBroadcaster.exe') -PathType Leaf)) {
    throw 'The native update payload is missing RebornBroadcaster.exe.'
}

Write-Host "Native update payload ready: $packageRoot"
