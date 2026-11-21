# Linux port status

Windows remains supported while Linux is developed from the same Git repository.

## Implemented

- Qt/QML remains the shared interface.
- `audio_backends.py` selects DirectShow on Windows and PipeWire on Linux.
- Linux capture uses FFmpeg's PulseAudio input through `pipewire-pulse`.
- Linux source discovery uses `pactl --format=json list sources`.
- KOS monitor contracts are `kos.meeting.monitor`, `kos.stream.monitor`, and `kos.aux.monitor`.

## Linux validation

Install Python 3.11+, FFmpeg, PipeWire, WirePlumber, `pipewire-pulse`, `pactl`, `wpctl`, and `pw-link`. Build and test streaming, recording, conversion, OBS, tray, and headless operation before publishing `linux-x64` through Reborn Publisher.
