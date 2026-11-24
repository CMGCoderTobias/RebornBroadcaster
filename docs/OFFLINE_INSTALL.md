# Offline installation

The offline installers install RebornBroadcaster and the Reborn Update Agent together. They do not require Reborn Apps to be installed first. After installation, the app launches through the shared agent and future updates use the normal signed Reborn updater flow.

## Windows

After the release publisher has created the signed app and agent assets, run:

```powershell
.\scripts\New-RebornBroadcasterOfflineInstaller.ps1 -Version 0.2.5 -AgentVersion 1.1.7
```

The generated `release-installers\RebornBroadcaster-Setup-<version>.exe` embeds the app package, app manifest, agent package, and agent manifest. It can be copied to the broadcaster download page and run without network access.

## Linux

Build the Linux package and signed manifests first, then run the installer creator on Linux:

```bash
./scripts/new-rebornbroadcaster-linux-installer.sh \
  0.2.5 \
  release-output/0.2.5/reborn-update-manifest.json \
  release-output/0.2.5/rebornbroadcaster-0.2.5-linux-x64.zip \
  ../RebornUpdateAgent/release-output/rebornupdateagent/1.1.7/reborn-update-manifest.json \
  ../RebornUpdateAgent/release-output/rebornupdateagent/1.1.7/rebornupdateagent-1.1.7-linux-x64.zip \
  ../RebornUpdateAgent/artifacts/linux-x64/bootstrap/RebornUpdateBootstrap \
  updater/agent-bootstrap.json \
  updater/rebornbroadcaster.linux.app.json \
  release-installers/RebornBroadcaster-Setup-0.2.5.run
```

Run the resulting `.run` file on the target Linux computer. It defaults to `~/.local/share/Reborn Entertainment/Apps/rebornbroadcaster`; use `--install-root` for another dedicated directory. The installer verifies both signed manifests through the bootstrap/agent path, creates a desktop entry, and launches the app through `RebornAppLauncher`.

The Linux installer must be rebuilt whenever the app or agent version changes. Do not reuse an app package or manifest from another version.
