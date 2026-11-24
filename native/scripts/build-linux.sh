#!/usr/bin/env bash
set -euo pipefail
version="${1:?usage: build-linux.sh VERSION}"
runtime="${2:-linux-x64}"
[[ "$runtime" == "linux-x64" ]] || { echo "Only linux-x64 is currently supported" >&2; exit 2; }
native_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
project_root="$(cd "$native_root/.." && pwd)"
venv="$native_root/.build-venv-linux"
deployment="$native_root/deployment-linux"
package="$project_root/release-staging/$runtime/RebornBroadcaster"
update_agent_root="${REBORN_UPDATE_AGENT_ROOT:-}"
if [[ -z "$update_agent_root" ]]; then
  for candidate in "$project_root/../RebornUpdateAgent" "$project_root/../../RebornUpdateAgent"; do
    if [[ -f "$candidate/scripts/New-AppIntegrationBundle.ps1" ]]; then
      update_agent_root="$candidate"
      break
    fi
  done
fi
python3 -m venv "$venv"
"$venv/bin/python" -m pip install --disable-pip-version-check --no-cache-dir -e "$native_root[build]"
actual="$("$venv/bin/python" -c 'from reborn_broadcaster import __version__; print(__version__)')"
[[ "$actual" == "$version" ]] || { echo "Native version $actual does not match $version" >&2; exit 3; }
qml_root="$("$venv/bin/python" -c 'import pathlib, PySide6; print(pathlib.Path(PySide6.__file__).parent / "Qt" / "qml")')"
qt_lib_root="$("$venv/bin/python" -c 'import pathlib, PySide6; print(pathlib.Path(PySide6.__file__).parent / "Qt" / "lib")')"
[[ -d "$qml_root" ]] || { echo "PySide6 QML modules were not installed" >&2; exit 4; }
rm -rf "$deployment" "$package"
mkdir -p "$(dirname "$package")"
"$venv/bin/python" -m nuitka "$native_root/launcher.py" --standalone --enable-plugin=pyside6 --output-dir="$deployment" --output-filename=RebornBroadcaster --assume-yes-for-downloads --noinclude-qt-translations --include-data-files="$native_root/qml/Main.qml=qml/Main.qml" --include-qt-plugins=platforminputcontexts,qmltooling,vectorimageformats --noinclude-dlls=Qt6Charts* --noinclude-dlls=Qt6Sensors* --noinclude-dlls=Qt6WebEngine*
generated="$(find "$deployment" -maxdepth 1 -type d \( -name 'launcher.dist' -o -name 'RebornBroadcaster.dist' \) -print -quit)"
[[ -n "$generated" ]] || { echo "Nuitka output was not found" >&2; exit 4; }
mv "$generated" "$package"
mkdir -p "$package/PySide6/Qt/lib"
cp -a "$qml_root" "$package/PySide6/Qt/qml"
cp "$qt_lib_root"/libQt6QuickControls2*.so.6 \
  "$qt_lib_root"/libQt6QuickTemplates2.so.6 \
  "$qt_lib_root"/libQt6QuickDialogs2*.so.6 \
  "$qt_lib_root"/libQt6QuickLayouts.so.6 \
  "$package/PySide6/Qt/lib/"
mkdir -p "$package/assets"
cp "$project_root/assets/KRBroadcasterIcon.png" "$package/assets/KRBroadcasterIcon.png"
cp -R "$project_root/docs" "$package/docs"
[[ -f "$update_agent_root/scripts/New-AppIntegrationBundle.ps1" ]] || { echo "RebornUpdateAgent source was not found at $update_agent_root" >&2; exit 5; }
app_config="$project_root/updater/rebornbroadcaster.linux.app.json"
bootstrap_config="$project_root/updater/agent-bootstrap.json"
launcher_config="$package/../reborn-launch-$runtime.json"
python3 - "$app_config" "$launcher_config" <<'PY'
import json
import sys
from pathlib import Path

app_config, launcher_config = map(Path, sys.argv[1:])
app = json.loads(app_config.read_text(encoding="utf-8"))
launcher_config.write_text(json.dumps({
    "schema": 1,
    "appId": app["appId"],
    "displayName": app["displayName"],
    "fallbackExecutable": app["executable"],
}) + "\n", encoding="utf-8")
PY
if command -v pwsh >/dev/null; then
  pwsh -NoLogo -NoProfile -File "$update_agent_root/scripts/New-AppIntegrationBundle.ps1" \
    -Runtime "$runtime" \
    -AppConfig "$app_config" \
    -BootstrapConfig "$bootstrap_config" \
    -LauncherConfig "$launcher_config" \
    -AppVersion "$version" \
    -OutputDirectory "$package/updater"
else
  integration_core="$update_agent_root/artifacts/$runtime/integration-core"
  python3 - "$integration_core" "$package/updater" "$app_config" "$bootstrap_config" "$launcher_config" "$version" "$runtime" <<'PY'
import hashlib
import json
import shutil
import sys
from pathlib import Path

core, destination, app_config, bootstrap_config, launcher_config, version, runtime = map(Path, sys.argv[1:])
destination.mkdir(parents=True, exist_ok=False)
metadata_path = core / "reborn-integration-core.json"
metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
if metadata.get("schema") != 1 or metadata.get("runtime") != str(runtime) or not metadata.get("integrationVersion"):
    raise SystemExit("The Linux integration-core metadata is invalid")
app = json.loads(app_config.read_text(encoding="utf-8"))
for field in ("appId", "displayName", "currentVersion", "executable"):
    if not str(app.get(field, "")).strip():
        raise SystemExit(f"App configuration is missing {field}")
app["currentVersion"] = str(version)
for name in ("RebornUpdateBootstrap", "RebornAppLauncher"):
    source = core / name
    if not source.is_file():
        raise SystemExit(f"Integration core is missing {name}")
    expected = str(metadata.get("files", {}).get(name, "")).lower()
    actual = hashlib.sha256(source.read_bytes()).hexdigest()
    if actual != expected:
        raise SystemExit(f"Integration core hash mismatch: {name}")
    shutil.copy2(source, destination / name)
    (destination / name).chmod((destination / name).stat().st_mode | 0o111)
(destination / "app-config.json").write_text(json.dumps(app, indent=2) + "\n", encoding="utf-8")
shutil.copy2(bootstrap_config, destination / "agent-bootstrap.json")
shutil.copy2(launcher_config, destination / "reborn-launch.json")
integration = {
    "schema": 1,
    "integrationVersion": metadata["integrationVersion"],
    "appVersion": str(version),
    "runtime": str(runtime),
    "appId": app["appId"],
    "sharedCore": True,
    "files": ["RebornUpdateBootstrap", "RebornAppLauncher", "app-config.json", "agent-bootstrap.json", "reborn-launch.json"],
}
(destination / "reborn-integration.json").write_text(json.dumps(integration, indent=2) + "\n", encoding="utf-8")
PY
fi
chmod +x "$package/RebornBroadcaster"
command -v ffmpeg >/dev/null || { echo "FFmpeg is required" >&2; exit 5; }
echo "Linux package staged at $package"
