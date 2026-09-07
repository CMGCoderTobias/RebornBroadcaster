# RebornBroadcaster Native

This directory is the framework-neutral replacement path for the Electron process. It keeps the existing application intact while the native build is tested.

## Processes

- `reborn-broadcaster-core` owns Icecast, recording, OBS control, settings, recovery, and the compatible TCP API on `127.0.0.1:8010`.
- `reborn-broadcaster` is a PySide6/QML control surface. It starts the core when necessary but does not own media processes.
- FFmpeg audio and recording are separate subprocesses. OBS is an optional external video production engine controlled through obs-websocket 5.

Only one controller and tray run per signed-in user. Launching RebornBroadcaster again reopens the existing dashboard instead of creating another tray. Closing the dashboard always hides it to the tray; **Stop core** ends every output and the headless core while leaving the controller available, and **Stop core and exit RebornBroadcaster** closes both. `go-live` starts enabled outputs independently, so OBS failure does not stop Icecast audio.

For a core left behind by a version older than this lifecycle, run `scripts\Stop-RebornBroadcasterCore.ps1` from the repository or `tools\Stop-RebornBroadcasterCore.ps1` from a packaged build. It tries the current and legacy shutdown protocols first, then force-stops only a verified packaged or Python development RebornBroadcaster process that owns port `8010`. The core does not have a separate tray icon; the single RebornBroadcaster tray controls it.

## Icecast Metadata

- Station name, genre, description, website, and directory-advertisement preference are sent as Icecast protocol options when the source connects.
- The station website is the public homepage for the station, show, or podcast. It is not the mount listen URL or an admin address.
- Directory advertisement requests an Icecast YP listing with `Ice-Public`. The Icecast server configuration can override it; it does not control whether a mount is hidden, authenticated, or shown on status pages.
- Now-playing text can be sent while live with `update-now-playing`, or synchronized from the first non-empty line of a UTF-8 text file every two seconds. Mount-scoped updates authenticate with the configured source credentials, not server administrator credentials.
- Listener counts come from the public `status-json.xsl` endpoint. A server-hidden mount reports the count as unavailable instead of incorrectly displaying zero.

## Secure Reverse Proxy

For a path-based TLS proxy such as `https://kosradio.com/radiostation/zachsbar`, configure:

- Icecast host: `kosradio.com`
- Icecast port: `443`
- Secure connection: enabled
- Reverse-proxy path: `radiostation`
- Mountpoint: `zachsbar`
- Icecast SOURCE compatibility: enabled for IIS ARR

The proxy must internally rewrite `/radiostation/<path>` to `http://127.0.0.1:8005/<path>` without returning a browser redirect. It must preserve the HTTP method, authorization header, query string, and streaming request body. The prefix is also applied to metadata and listener-status requests.
Existing settings with a reverse-proxy path automatically enable the compatible `SOURCE` method. Direct connections continue using modern `PUT`, and the setting can be changed explicitly for other Icecast providers.

## Development

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
python -m pip install -e .
python -m reborn_broadcaster.app
```

Run only the headless service with:

```powershell
python -m reborn_broadcaster.core_main
```

The native settings store reuses the existing Electron `settings.json` when found. The migration is additive and does not delete the Electron application or its configuration.

## OBS Policy

OBS is optional. A local OBS output cannot be enabled until OBS Studio is detected. If OBS is installed but offline, the core reports video as unavailable unless `obsAutoLaunch` is enabled. Audio-only broadcasting and recording remain available.

## Packaging

Use `npm run build:native` to create the Nuitka standalone payload at `release-staging\win-x64\RebornBroadcaster`. The build includes the QML, application icon, modern TLS-capable FFmpeg, and FFmpeg notices. RebornUpdateAgent packages and signs that runnable directory using `reborn-release.json`; the shared agent itself is not copied into normal app updates.
