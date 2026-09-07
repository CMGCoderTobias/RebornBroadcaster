$ErrorActionPreference = 'Stop'
$nativeRoot = Split-Path -Parent $PSScriptRoot
$venvRoot = Join-Path $nativeRoot '.venv'
$venvPython = Join-Path $venvRoot 'Scripts\python.exe'

if (-not (Test-Path -LiteralPath $venvPython -PathType Leaf)) {
    $python = Get-Command python -ErrorAction SilentlyContinue
    if (-not $python) {
        throw 'Python 3.11 or newer is required. Install Python, then run npm run native again.'
    }

    $versionText = & $python.Source -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"
    $version = [version]$versionText
    if ($version -lt [version]'3.11') {
        throw "Python 3.11 or newer is required; found $versionText."
    }

    Write-Host "Creating native Python environment on D: at $venvRoot"
    & $python.Source -m venv $venvRoot
}

$env:PIP_NO_CACHE_DIR = '1'
Write-Host 'Installing RebornBroadcaster native dependencies...'
& $venvPython -m pip install --disable-pip-version-check --no-cache-dir -e $nativeRoot
if ($LASTEXITCODE -ne 0) {
    throw 'Native dependency installation failed.'
}

Write-Host 'Native environment is ready.'
