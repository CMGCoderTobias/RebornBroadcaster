# RebornBroadcaster User Guide

RebornBroadcaster is the streaming and recording engine. It can run by itself or receive commands and audio from K-OS Broadcaster. Its background core keeps active work running when the dashboard closes, while the tray icon provides status and core controls.

## First setup

1. Open **Settings > Audio** and choose the source that contains the complete program mix.
2. Open **Settings > Stream** and enter the Icecast destination.
3. Open **Settings > Recording** and choose the recording folder, encoding, and bitrate.
4. Save settings and return to the console.
5. Confirm the core is connected and compatible before starting an output.

Audio recording and radio streaming are independent. They may run together or separately. Video streaming and video recording are also independent and require OBS.

## Audio source and K-OS routing

When RebornBroadcaster is used with K-OS, select the final K-OS stream mix rather than the microphone alone.

### Windows

K-OS uses VoiceMeeter. Its recommended stream route is B2. In RebornBroadcaster, select the VoiceMeeter recording/output device that represents the B2 program bus. Device names vary between VoiceMeeter editions, so verify the source with RebornBroadcaster's source list and the K-OS Stream Out meter.

The normal K-OS plan is microphone plus meeting return plus playback/media on B2. Do not select the meeting-send B1 device unless that is intentionally your complete program mix.

### Linux

K-OS uses PipeWire and creates `KOS_Stream_Mix_B2`. Select the monitor/source corresponding to **KOS_Stream_Mix_B2** in RebornBroadcaster. K-OS must be connected to PipeWire before that temporary source appears.

For meetings, the meeting application normally uses:

- Microphone: `KOS_Meeting_Send_B1`
- Speaker/output: `KOS_Meeting_Return`
- RebornBroadcaster source: the monitor/source for `KOS_Stream_Mix_B2`

Do not select the physical microphone in RebornBroadcaster when K-OS is expected to mix guests, macros, and optional application audio.

## Icecast streaming

The stream settings identify where RebornBroadcaster sends encoded audio:

- **Host** is the Icecast hostname or IP address.
- **Port** is the source connection port. Direct Icecast commonly uses its configured port; an HTTPS reverse proxy normally uses 443.
- **TLS** must be enabled for an `https`/port 443 source connection.
- **Proxy path** is the reverse-proxy prefix before the mountpoint, when one exists.
- **Mountpoint** identifies the station feed and is entered without relying on the public directory page.
- **Username** is commonly `source`, unless the server uses another source account.
- **Source password** authenticates the broadcaster.
- **Station website** is public metadata shown to listeners or directories; it is not the source connection address.
- **Directory listing** requests public Icecast directory publication. The server and directory still decide whether the listing is accepted.

Use the exact source URL configuration supplied by the station host. A public listening URL and an Icecast source connection can pass through different proxy rules.

During a short network interruption, RebornBroadcaster enters **recovering** or **backing off** and reconnects without blocking local recording. Listener players determine whether playback resumes automatically after the server source reconnects.

## Metadata and now playing

Set the station name, description, genre, and website in Stream settings. Use the dashboard's now-playing control for manual updates, or configure a watched text file for automation. When another application writes a new title to that file, RebornBroadcaster sends the title to the active Icecast source.

Artwork is normally presented by the station website or player using metadata integration. Icecast audio source metadata does not embed a continuously changing cover image in the audio connection.

## Recording

Recording uses the selected audio source and is separate from Icecast connectivity. The file extension and encoder are derived from the selected recording format. Do not rename an MKV or WAV file to MP3; use the built-in converter when an existing file needs another format.

After stopping, verify that the dashboard reports a completed path and nonzero file size. Very short recordings may contain little audio, but a zero-byte result is treated as a failure rather than a successful recording.

The converter requires streams and recordings to be stopped so it does not compete with live encoding resources.

## OBS video integration

OBS is optional and only controls video streaming and video recording.

1. Install OBS Studio.
2. In OBS, open **Tools > WebSocket Server Settings**.
3. Enable the WebSocket server and authentication.
4. Enter the matching host, port, and password in RebornBroadcaster.
5. Select **Test OBS Connection**, then save.

Configure the service, stream key, scenes, audio, and recording profile inside OBS. RebornBroadcaster starts and stops the OBS outputs; it does not replace the OBS production configuration.

## Core, dashboard, and tray

- The **dashboard** is the visible control surface.
- The **core** owns audio streaming and recording work.
- The **tray icon** represents the running application/core and can reopen the dashboard.
- Closing only the dashboard does not interrupt active work.
- **Stop Core** stops outputs and exits the background core.

At startup, the dashboard waits for the core to become ready. A brief connection refusal during that grace period is treated as startup timing, not as a final failure. If confirmation times out, use **Start Core** or **Reconnect / start core**.

## Updates

RebornUpdateAgent checks and stages updates independently of Electron or Qt. The in-app update control shows the launched version and update state. **Install and Restart** appears only after an update is ready. Active outputs must be stopped before replacement.

## Troubleshooting

- No K-OS source on Linux: connect K-OS to PipeWire first, then refresh RebornBroadcaster's audio sources.
- No complete mix on Windows: select the VoiceMeeter B2/program output, not only the hardware microphone.
- Radio immediately recovers: verify host, source port, TLS, proxy path, mountpoint, username, and source password.
- Port 443 fails without TLS: enable TLS.
- OBS is installed but offline: enable its WebSocket server and verify host, port, and password.
- Dashboard says core is starting: wait for confirmation rather than repeatedly pressing Start Core.
- Recording is silent: verify the selected source meter before starting and confirm K-OS Stream Out is active when K-OS supplies the mix.

This guide is bundled with the application and works without internet access.
