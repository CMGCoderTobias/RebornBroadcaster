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
mkdir -p "$package/updater"
"$venv/bin/python" -c 'import json, pathlib, sys; source, destination, version = sys.argv[1:]; data = json.loads(pathlib.Path(source).read_text(encoding="utf-8")); data["currentVersion"] = version; pathlib.Path(destination).write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")' \
  "$project_root/updater/rebornbroadcaster.linux.app.json" "$package/updater/app-config.json" "$version"
cp "$project_root/updater/agent-bootstrap.json" "$package/updater/agent-bootstrap.json"
chmod +x "$package/RebornBroadcaster"
command -v ffmpeg >/dev/null || { echo "FFmpeg is required" >&2; exit 5; }
echo "Linux package staged at $package"
