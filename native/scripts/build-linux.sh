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
rm -rf "$deployment" "$package"
mkdir -p "$(dirname "$package")"
"$venv/bin/python" -m nuitka "$native_root/launcher.py" --standalone --enable-plugin=pyside6 --output-dir="$deployment" --output-filename=RebornBroadcaster --assume-yes-for-downloads --noinclude-qt-translations --include-data-files="$native_root/qml/Main.qml=qml/Main.qml" --include-qt-plugins=platforminputcontexts,qml,qmllint,qmltooling,vectorimageformats --noinclude-dlls=Qt6Charts* --noinclude-dlls=Qt6Sensors* --noinclude-dlls=Qt6WebEngine*
generated="$(find "$deployment" -maxdepth 1 -type d \( -name 'launcher.dist' -o -name 'RebornBroadcaster.dist' \) -print -quit)"
[[ -n "$generated" ]] || { echo "Nuitka output was not found" >&2; exit 4; }
mv "$generated" "$package"
chmod +x "$package/RebornBroadcaster"
command -v ffmpeg >/dev/null || { echo "FFmpeg is required" >&2; exit 5; }
echo "Linux package staged at $package"
