#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 VERSION APP_MANIFEST APP_PACKAGE AGENT_MANIFEST AGENT_PACKAGE AGENT_BOOTSTRAP AGENT_CONFIG APP_CONFIG OUTPUT" >&2
  exit 2
}

[[ $# -eq 9 ]] || usage
version="$1"
app_manifest="$2"
app_package="$3"
agent_manifest="$4"
agent_package="$5"
agent_bootstrap="$6"
agent_config="$7"
app_config="$8"
output="$9"

for input in "$app_manifest" "$app_package" "$agent_manifest" "$agent_package" "$agent_bootstrap" "$agent_config" "$app_config"; do
  [[ -f "$input" ]] || { echo "Missing offline installer input: $input" >&2; exit 3; }
done

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
cp "$app_manifest" "$stage/app-manifest.json"
cp "$app_package" "$stage/app-package.zip"
cp "$agent_manifest" "$stage/agent-manifest.json"
cp "$agent_package" "$stage/agent-package.zip"
cp "$agent_bootstrap" "$stage/RebornUpdateBootstrap"
cp "$agent_config" "$stage/agent-bootstrap.json"
cp "$app_config" "$stage/app-config.json"
chmod +x "$stage/RebornUpdateBootstrap"
mkdir -p "$(dirname "$output")"

cat > "$output" <<'INSTALLER'
#!/usr/bin/env bash
set -euo pipefail

install_root="${REBORN_APP_INSTALL_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/Reborn Entertainment/Apps/rebornbroadcaster}"
launch=true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --install-root) [[ $# -ge 2 ]] || { echo "--install-root requires a path" >&2; exit 2; }; install_root="$2"; shift 2 ;;
    --no-launch) launch=false; shift ;;
    --help|-h) echo "Usage: $0 [--install-root PATH] [--no-launch]"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

install_root="$(realpath -m "$install_root")"
home_root="$(realpath "$HOME")"
case "$install_root" in
  /|"$home_root"|"$home_root/"*) echo "Choose a dedicated application install directory." >&2; exit 3 ;;
esac
if [[ -e "$install_root" && ! -d "$install_root" ]]; then
  echo "Install path is not a directory: $install_root" >&2
  exit 3
fi
if [[ -d "$install_root" && ! -e "$install_root/.reborn" ]] && find "$install_root" -mindepth 1 -maxdepth 1 -print -quit | grep -q .; then
  echo "Refusing to install into a non-empty unregistered directory: $install_root" >&2
  exit 3
fi

temp_root="$(mktemp -d)"
cleanup() { rm -rf "$temp_root"; }
trap cleanup EXIT
payload_line="$(awk '/^__REBORN_PAYLOAD_BELOW__$/ { print NR + 1; exit }' "$0")"
[[ -n "$payload_line" ]] || { echo "Installer payload marker is missing." >&2; exit 4; }
tail -n +"$payload_line" "$0" | tar -xzf - -C "$temp_root"

agent_root="${REBORN_UPDATE_AGENT_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/Reborn Entertainment/UpdateAgent}"
"$temp_root/RebornUpdateBootstrap" \
  --config "$temp_root/agent-bootstrap.json" \
  --offline-manifest "$temp_root/agent-manifest.json" \
  --offline-package "$temp_root/agent-package.zip" \
  --no-tray

agent="$(python3 - "$agent_root/agent-active.json" <<'PY'
import json
import sys
from pathlib import Path

active = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
path = Path(active["directory"]) / active["executable"]
if not path.is_file():
    raise SystemExit("Installed Reborn Update Agent executable is missing")
print(path)
PY
)"

mkdir -p "$install_root"
"$agent" register --config "$temp_root/app-config.json" --install-root "$install_root"
"$agent" install-offline --app rebornbroadcaster \
  --manifest "$temp_root/app-manifest.json" \
  --package "$temp_root/app-package.zip"

if [[ -f "$install_root/updater/RebornAppLauncher" ]]; then
  cp "$install_root/updater/RebornAppLauncher" "$install_root/RebornAppLauncher"
  chmod +x "$install_root/RebornAppLauncher"
  cp "$install_root/updater/reborn-launch.json" "$install_root/reborn-launch.json"
fi

applications_dir="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
mkdir -p "$applications_dir"
cat > "$applications_dir/RebornBroadcaster.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=RebornBroadcaster
Comment=Launch RebornBroadcaster through Reborn Update Agent
Exec="$install_root/RebornAppLauncher" --config "$install_root/reborn-launch.json"
Terminal=false
Categories=AudioVideo;Audio;Recorder;
DESKTOP

if [[ "$launch" == true ]]; then
  exec "$install_root/RebornAppLauncher" --config "$install_root/reborn-launch.json"
fi
echo "RebornBroadcaster installed at $install_root"
exit 0

__REBORN_PAYLOAD_BELOW__
INSTALLER

tar -C "$stage" -czf - . >> "$output"
chmod +x "$output"
echo "Offline Linux installer ready: $output"
