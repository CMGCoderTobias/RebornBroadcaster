from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from typing import Any


DSHOW_AUDIO_PATTERN = re.compile(r'^\[dshow[^]]*\]\s+"(.+)"\s+\(audio\)$')


class AudioBackendError(RuntimeError):
    pass


@dataclass(frozen=True)
class AudioSource:
    source_id: str
    display_name: str


class AudioBackend:
    backend_id = "unknown"
    display_name = "System audio"

    def list_sources(self, ffmpeg: str) -> list[AudioSource]:
        raise NotImplementedError

    def input_arguments(self, settings: dict[str, Any]) -> list[str]:
        raise NotImplementedError

    def stream_source_for_route(self, route: str, sources: list[AudioSource]) -> AudioSource:
        raise AudioBackendError(
            f"{self.display_name} does not provide an automatic source for route {route or '(empty)'}"
        )


class DirectShowBackend(AudioBackend):
    backend_id = "directshow"
    display_name = "Windows audio"

    def list_sources(self, ffmpeg: str) -> list[AudioSource]:
        try:
            result = subprocess.run(
                [ffmpeg, "-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=8,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            raise AudioBackendError(f"Unable to discover Windows audio sources: {error}") from error
        sources: list[AudioSource] = []
        for line in result.stderr.splitlines():
            match = DSHOW_AUDIO_PATTERN.match(line.strip())
            if match and all(source.source_id != match.group(1) for source in sources):
                sources.append(AudioSource(match.group(1), match.group(1)))
        return sources

    def input_arguments(self, settings: dict[str, Any]) -> list[str]:
        source = str(settings.get("audioSourceName") or settings.get("audioSourceId") or "").strip()
        if not source:
            raise AudioBackendError("Select an audio source before starting")
        return ["-f", "dshow", "-i", f"audio={source}"]

    def stream_source_for_route(self, route: str, sources: list[AudioSource]) -> AudioSource:
        normalized_route = route.strip().upper()
        patterns = {
            "B1": ("voicemeeter out b1", "voicemeeter output"),
            "B2": ("voicemeeter out b2", "voicemeeter aux output"),
            "B3": ("voicemeeter out b3", "voicemeeter vaio3 output"),
        }
        for pattern in patterns.get(normalized_route, ()):
            for source in sources:
                normalized = source.display_name.casefold()
                if pattern not in normalized:
                    continue
                if normalized_route == "B1" and pattern == "voicemeeter output" and any(
                    value in normalized for value in ("aux", "vaio3")
                ):
                    continue
                return source
        expected = {
            "B1": "VoiceMeeter Output",
            "B2": "VoiceMeeter Aux Output",
            "B3": "VoiceMeeter VAIO3 Output",
        }.get(normalized_route)
        if expected:
            raise AudioBackendError(f"{expected} was not found in the available Windows audio sources")
        raise AudioBackendError(f"VoiceMeeter route {normalized_route or '(empty)'} is not supported")


class PipeWireBackend(AudioBackend):
    backend_id = "pipewire"
    display_name = "PipeWire"

    def list_sources(self, ffmpeg: str) -> list[AudioSource]:
        del ffmpeg
        pactl = shutil.which("pactl")
        if not pactl:
            raise AudioBackendError(
                "PipeWire source discovery requires pactl and the PipeWire PulseAudio compatibility service"
            )
        try:
            result = subprocess.run(
                [pactl, "--format=json", "list", "sources"],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=8,
                check=True,
            )
            payload = json.loads(result.stdout)
        except (OSError, subprocess.TimeoutExpired, subprocess.CalledProcessError, json.JSONDecodeError) as error:
            raise AudioBackendError(f"Unable to discover PipeWire audio sources: {error}") from error
        sources: list[AudioSource] = []
        for item in payload if isinstance(payload, list) else []:
            if not isinstance(item, dict):
                continue
            source_id = str(item.get("name") or "").strip()
            if not source_id:
                continue
            description = str(item.get("description") or source_id).strip()
            sources.append(AudioSource(source_id, description))
        return sources

    def input_arguments(self, settings: dict[str, Any]) -> list[str]:
        source = str(settings.get("audioSourceId") or settings.get("audioSourceName") or "default").strip()
        return ["-f", "pulse", "-i", source or "default"]

    def stream_source_for_route(self, route: str, sources: list[AudioSource]) -> AudioSource:
        normalized_route = route.strip().upper()
        names = {
            "B1": ("kos.meeting.monitor", "kos_meeting_out.monitor"),
            "B2": ("kos.stream.monitor", "kos_stream_out.monitor"),
            "B3": ("kos.aux.monitor", "kos_aux_out.monitor"),
        }
        for expected in names.get(normalized_route, ()):
            for source in sources:
                if expected in source.source_id.casefold():
                    return source
        raise AudioBackendError(
            f"KOS PipeWire route {normalized_route or '(empty)'} is unavailable. "
            "Start KOS and create its virtual audio graph before starting RebornBroadcaster outputs."
        )


class AvFoundationBackend(AudioBackend):
    backend_id = "avfoundation"
    display_name = "macOS audio"

    def list_sources(self, ffmpeg: str) -> list[AudioSource]:
        del ffmpeg
        return []

    def input_arguments(self, settings: dict[str, Any]) -> list[str]:
        source = str(settings.get("audioSourceId") or settings.get("audioSourceName") or ":0").strip()
        return ["-f", "avfoundation", "-i", source or ":0"]


def current_audio_backend() -> AudioBackend:
    if sys.platform == "win32":
        return DirectShowBackend()
    if sys.platform.startswith("linux"):
        return PipeWireBackend()
    if sys.platform == "darwin":
        return AvFoundationBackend()
    raise AudioBackendError(f"Audio capture is not supported on {sys.platform}")
