param(
    [switch]$Core,
    [switch]$Smoke
)

$ErrorActionPreference = 'Stop'
$nativeRoot = Split-Path -Parent $PSScriptRoot
$setupScript = Join-Path $PSScriptRoot 'setup.ps1'
$venvPython = Join-Path $nativeRoot '.venv\Scripts\python.exe'

$dependenciesReady = $false
if (Test-Path -LiteralPath $venvPython -PathType Leaf) {
    & $venvPython -c "import PySide6, websockets" 2>$null
    $dependenciesReady = $LASTEXITCODE -eq 0
}

if (-not $dependenciesReady) {
    & $setupScript
}

Push-Location $nativeRoot
try {
    if ($Core) {
        & $venvPython -m reborn_broadcaster.core_main
    } elseif ($Smoke) {
        $env:QT_QPA_PLATFORM = 'offscreen'
        & $venvPython -m reborn_broadcaster.app --smoke-test
    } else {
        & $venvPython -m reborn_broadcaster.app
    }
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
