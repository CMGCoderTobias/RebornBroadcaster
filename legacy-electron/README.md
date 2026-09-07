# Legacy Electron bridge

Future stable GitHub releases must include `latest.yml`, `RebornBroadcaster-Setup-0.0.10.exe`, and its Electron blockmap. The `0.0.10` recovery bridge upgrades installations already stopped at `0.0.9`, adopts them into the shared update agent, and stages the current native release.

The installer, blockmap, and `latest.yml` are generated artifacts and are not committed. `scripts\prepare-legacy-bridge.ps1` verifies the installer against `latest.yml` and stages the exact files from `dist`, or downloads them from the first native release that carries the bridge.
