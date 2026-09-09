# RebornBroadcaster Update Integration

RebornBroadcaster uses the current RebornUpdateAgent build as its framework-neutral updater. The authoritative reusable protocol is `D:\Reborn Entertainment\Reborn\Coding\RebornUpdateAgent\APP_INTEGRATION_GUIDE.md`; this file records only this application's implementation.

## Identity

- App ID: `rebornbroadcaster`
- Current app version: `0.1.8`
- Production manifest: `https://kosradio.com/security/v1/updates/rebornbroadcaster/manifest`
- Windows runtime: `win-x64`
- Package entry point: `RebornBroadcaster.exe`

The signed production and testing registrations are in `updater`. Testing still requires a valid signed `testing-access.json`; changing `IS_TESTING` cannot bypass that permission.

## Required version bridge

The last released app is Electron `0.0.8`. Migration therefore uses two distinct newer versions:

1. Publish `0.0.9` as the Electron migration release, including its normal `latest.yml`, installer, and Electron blockmap. Existing `0.0.8` installations can consume this through their updater.
2. Confirm that installed `0.0.9` bootstraps the agent, passes `doctor`, and launches through the stable shortcut.
3. The first Qt agent package is `0.1.0`. Include the permanent `0.0.9` Electron bridge assets in that release.

Do not publish Electron and Qt payloads under the same `0.0.9` version. An updater correctly treats equal versions as already current.

## Electron migration release

`npm run build` remains the migration build while Electron is the installed fallback. It:

1. Copies `RebornUpdateBootstrap.exe` and `RebornAppLauncher.exe` from the sibling RebornUpdateAgent build.
2. Packages those files and the public registration under `resources\updater`.
3. Starts RebornBroadcaster immediately on first launch.
4. Runs bootstrap/adoption and `doctor` in the background.
5. Installs the stable app launcher and retargets existing RebornBroadcaster desktop/Start Menu shortcuts only after `doctor` passes.
6. Leaves `electron-updater` dormant when the agent path succeeds and uses it only when bootstrap, doctor, or launcher setup fails.

The launcher always retains `RebornBroadcaster.exe` as its local fallback. Do not remove `electron-updater` or its release assets until an installed `0.0.9` copy has staged, activated, launched, reported healthy, and rolled back a later dual-published test release.

Publish the bridge with `reborn-migration-release.json`. This config is locked to `0.0.9`, builds the Electron application, signs an agent-compatible package, and includes the NSIS installer, blockmap, and `latest.yml` required by installed `0.0.8` copies. Keep the stable channel so the existing production updater can see it.

## Native update package

Build the clean Qt/Python payload with:

```powershell
npm run build:native
```

The runnable directory is `release-staging\win-x64\RebornBroadcaster`. It contains the standalone Nuitka/PySide6 Essentials application and FFmpeg, but not the shared update agent, publisher, or private signing key.

Open `reborn-release.json` in the publisher UI or run a local signed package test:

```powershell
& "D:\Reborn Entertainment\Reborn\Coding\RebornUpdateAgent\developer-tools\Reborn.ReleasePublisher\Publish-Release.ps1" `
  -Config ".\reborn-release.json" -Channel testing -PackageOnly
```

`reborn-release.json` refuses to build a native release below `0.0.10`. It builds only the current native payload and verifies/stages the permanent `0.0.9` Electron bridge; it does not rebuild Electron with the current native version. This ensures an old installation reaches `0.0.9`, adopts the agent, and can then install `0.1.0` instead of becoming stranded on an equal-version Electron build.

The public GitHub provider in the released Electron client always resolves update files under the newest release tag. It cannot follow metadata back to an asset attached only to an older release. Consequently, every stable GitHub release must include the three bridge assets from `legacy-electron`: the `0.0.9` installer, its blockmap, and `latest.yml`. The preparation script downloads them from `v0.0.9` when they are not available locally and rejects an installer whose size or SHA-512 differs from the pinned bridge metadata.

## Publisher configs

- `reborn-migration-release.json`: one-time stable `0.0.9` bridge for Electron `0.0.8` installations.
- `reborn-release.json`: native Qt releases beginning with `0.1.0`; defaults to the testing channel and includes the verified permanent Electron bridge assets.

Open either file directly in Reborn Release Publisher. The signing-key path is resolved relative to the config and points to the private key held by the sibling RebornUpdateAgent checkout. The key is never copied into this repository or either application payload. Do not remove the legacy bridge assets from stable releases until support for every pre-agent Electron installation has intentionally ended.

The native UI reports health only after its QML window exists and the isolated core is connected, then uses `request-check --app rebornbroadcaster` for a detached, coalesced background check. The Electron fallback reports health after its window and TCP service initialize. Both validate that the agent executable is inside the expected per-user agent directory before invoking it.

## Update safety

The registration calls `prepare-update` on `127.0.0.1:8010`. If the core is running, activation is blocked while Icecast, OBS streaming, audio recording, or OBS recording is active. If the core is not running, activation is allowed because no media process is active.

Never embed a GitHub token, private signing key, arbitrary package URL, or writable install path in application code.
