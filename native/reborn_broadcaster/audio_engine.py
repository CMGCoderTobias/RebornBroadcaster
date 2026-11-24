from __future__ import annotations

import asyncio
import re
import subprocess
import sys
from collections import deque
from datetime import datetime
from pathlib import Path
from typing import Any, Callable
from urllib.parse import quote

from . import __version__
from .audio_backends import AudioBackendError, AudioSource, current_audio_backend
from .paths import bundled_ffmpeg


StateCallback = Callable[[str, dict[str, Any]], None]
SPEED_PATTERN = re.compile(r"^speed=\s*([0-9.]+)x?$")
PROGRESS_PATTERN = re.compile(r"^[a-z_]+=.*$", re.IGNORECASE)


def _subprocess_options() -> dict[str, int]:
    if sys.platform == "win32":
        return {"creationflags": subprocess.CREATE_NO_WINDOW}
    return {}


class EngineError(RuntimeError):
    pass


def list_audio_sources() -> list[str]:
    ffmpeg = bundled_ffmpeg()
    if not ffmpeg:
        raise EngineError("FFmpeg was not found")
    try:
        return [source.source_id for source in current_audio_backend().list_sources(str(ffmpeg))]
    except AudioBackendError as error:
        raise EngineError(str(error)) from error


def voicemeeter_source_for_route(route: str, sources: list[str]) -> str:
    backend = current_audio_backend()
    available = [AudioSource(source, source) for source in sources]
    try:
        return backend.stream_source_for_route(route, available).source_id
    except AudioBackendError as error:
        raise EngineError(str(error)) from error


def _input_arguments(settings: dict[str, Any]) -> list[str]:
    try:
        return current_audio_backend().input_arguments(settings)
    except AudioBackendError as error:
        raise EngineError(str(error)) from error


def input_arguments(settings: dict[str, Any]) -> list[str]:
    return _input_arguments(settings)


def _codec_arguments(settings: dict[str, Any], bitrate: int) -> tuple[list[str], str, str]:
    encoding = str(settings.get("encodingType") or "mp3").lower()
    if encoding in {"aac", "m4a"}:
        return ["-c:a", "aac", "-b:a", f"{bitrate}k"], "adts", "audio/aac"
    if encoding in {"opus", "ogg-opus"}:
        return ["-c:a", "libopus", "-b:a", f"{bitrate}k", "-vbr", "on"], "ogg", "audio/ogg"
    if encoding in {"vorbis", "ogg"}:
        return ["-c:a", "libvorbis", "-b:a", f"{bitrate}k"], "ogg", "audio/ogg"
    return ["-c:a", "libmp3lame", "-b:a", f"{bitrate}k"], "mp3", "audio/mpeg"


def _recording_codec_arguments(settings: dict[str, Any]) -> tuple[list[str], str, str]:
    encoding = str(settings.get("encodingType") or "mp3").lower()
    bitrate = int(settings.get("bitrate") or 128)
    codec, stream_format, _content_type = _codec_arguments(settings, bitrate)
    if encoding in {"aac", "m4a"}:
        return codec, ".m4a", "ipod"
    if stream_format == "ogg":
        return codec, ".ogg", "ogg"
    return codec, ".mp3", "mp3"


def audio_conversion_plan(
    source: Path, encoding: str, bitrate: int
) -> tuple[Path, list[str], str]:
    codec, extension, output_format = _recording_codec_arguments(
        {"encodingType": encoding, "bitrate": bitrate}
    )
    output = source.with_name(f"{source.stem}-converted{extension}")
    sequence = 2
    while output.exists():
        output = source.with_name(f"{source.stem}-converted-{sequence}{extension}")
        sequence += 1
    return output, codec, output_format


class IcecastAudioEngine:
    def __init__(self, notify: StateCallback) -> None:
        self._notify = notify
        self._desired = False
        self._process: asyncio.subprocess.Process | None = None
        self._task: asyncio.Task[None] | None = None
        self._settings: dict[str, Any] = {}
        self._effective_bitrate = 0
        self._error_lines: deque[str] = deque(maxlen=6)

    async def start(self, settings: dict[str, Any]) -> None:
        if self._task and not self._task.done():
            return
        self._validate(settings)
        self._settings = dict(settings)
        self._effective_bitrate = int(settings["bitrate"])
        self._desired = True
        self._task = asyncio.create_task(self._supervise(), name="icecast-audio")
        await asyncio.sleep(0.75)
        if self._task.done():
            error = self._task.exception()
            raise EngineError(str(error) if error else "Audio engine stopped during startup")

    async def stop(self) -> None:
        self._desired = False
        await self._stop_process()
        if self._task:
            try:
                await asyncio.wait_for(self._task, timeout=4)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                self._task.cancel()
            self._task = None
        self._notify("radio", {"status": "stopped", "error": "", "effectiveBitrate": 0})

    async def _supervise(self) -> None:
        retry_delay = 1.0
        while self._desired:
            self._notify(
                "radio",
                {"status": "connecting", "error": "", "effectiveBitrate": self._effective_bitrate},
            )
            command = self._command(self._effective_bitrate)
            self._error_lines.clear()
            try:
                self._process = await asyncio.create_subprocess_exec(
                    *command,
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.PIPE,
                    **_subprocess_options(),
                )
                self._notify(
                    "radio",
                    {"status": "live", "error": "", "effectiveBitrate": self._effective_bitrate},
                )
                should_backoff = await self._monitor(self._process)
                return_code = await self._process.wait()
                self._process = None
                if not self._desired:
                    break
                if should_backoff:
                    self._apply_backoff()
                    retry_delay = 1.0
                else:
                    details = " | ".join(self._error_lines)
                    error = f"FFmpeg exited ({return_code})"
                    if details:
                        error = f"{error}: {details}"
                    self._notify("radio", {"status": "recovering", "error": error})
                    await asyncio.sleep(retry_delay)
                    retry_delay = min(retry_delay * 2, 15)
            except Exception as error:
                self._process = None
                if not self._desired:
                    break
                self._notify("radio", {"status": "recovering", "error": str(error)})
                await asyncio.sleep(retry_delay)
                retry_delay = min(retry_delay * 2, 15)

    async def _monitor(self, process: asyncio.subprocess.Process) -> bool:
        if process.stderr is None:
            return False
        slow_since: float | None = None
        loop = asyncio.get_running_loop()
        while self._desired:
            line = await process.stderr.readline()
            if not line:
                return False
            text = line.decode(errors="replace").strip()
            match = SPEED_PATTERN.match(text)
            if not match:
                if text and not PROGRESS_PATTERN.match(text):
                    self._error_lines.append(text)
                continue
            speed = float(match.group(1))
            if speed < 0.97:
                slow_since = slow_since or loop.time()
                if (
                    self._settings.get("adaptiveBackoffEnabled", True)
                    and loop.time() - slow_since >= 15
                    and self._effective_bitrate > int(self._settings["adaptiveMinimumBitrate"])
                ):
                    self._notify("radio", {"status": "backing-off", "error": "Sustained encoder lag detected"})
                    await self._stop_process()
                    return True
            else:
                slow_since = None
        return False

    def _apply_backoff(self) -> None:
        minimum = int(self._settings["adaptiveMinimumBitrate"])
        ratio = float(self._settings["adaptiveBackoffRatio"])
        self._effective_bitrate = max(minimum, int(self._effective_bitrate * ratio))

    async def _stop_process(self) -> None:
        process = self._process
        if process is None or process.returncode is not None:
            return
        process.terminate()
        try:
            await asyncio.wait_for(process.wait(), timeout=3)
        except asyncio.TimeoutError:
            process.kill()
            await process.wait()

    def _command(self, bitrate: int) -> list[str]:
        ffmpeg = bundled_ffmpeg()
        if not ffmpeg:
            raise EngineError("FFmpeg was not found")
        settings = self._settings
        codec, output_format, content_type = _codec_arguments(settings, bitrate)
        user = quote(str(settings.get("username") or "source"), safe="")
        password = str(settings.get("sourcepassword") or "")
        host = str(settings["icecastHost"]).strip()
        port = str(settings.get("icecastPort") or "8000").strip()
        proxy_path = quote(str(settings.get("icecastProxyPath") or "").strip().strip("/"), safe="/._-")
        mount = quote(str(settings["mountpoint"]).lstrip("/"), safe="/._-")
        external_mount = "/".join(part for part in (proxy_path, mount) if part)
        output = f"icecast://{user}@{host}:{port}/{external_mount}"
        icecast_options = []
        if settings.get("icecastTls"):
            icecast_options.extend(["-tls", "1", "-tls_verify", "1"])
        if settings.get("icecastLegacySource"):
            icecast_options.extend(["-legacy_icecast", "1"])
        for key, value in (
            ("ice_name", settings.get("streamName")),
            ("ice_genre", settings.get("streamGenre")),
            ("ice_description", settings.get("streamDescription")),
            ("ice_url", settings.get("streamUrl")),
            ("ice_public", settings.get("streamPublic")),
        ):
            if value not in (None, ""):
                icecast_options.extend([f"-{key}", str(value)])
        stream_metadata = []
        if settings.get("nowPlaying"):
            stream_metadata.extend(["-metadata", f"title={settings['nowPlaying']}"])
        return [
            str(ffmpeg), "-hide_banner", "-nostdin", "-loglevel", "warning",
            *_input_arguments(settings), *codec, *icecast_options, *stream_metadata,
            "-password", password, "-user_agent", f"RebornBroadcaster/{__version__}",
            "-content_type", content_type, "-f", output_format,
            "-progress", "pipe:2", "-nostats", output,
        ]

    @staticmethod
    def _validate(settings: dict[str, Any]) -> None:
        missing = [name for name in ("icecastHost", "mountpoint", "sourcepassword") if not settings.get(name)]
        if missing:
            raise EngineError(f"Missing Icecast settings: {', '.join(missing)}")
        try:
            port = int(str(settings.get("icecastPort") or "8000").strip())
        except ValueError as error:
            raise EngineError("Icecast connection port must be a number") from error
        if port < 1 or port > 65535:
            raise EngineError("Icecast connection port must be between 1 and 65535")
        if port == 443 and not settings.get("icecastTls"):
            raise EngineError("Port 443 requires TLS. Enable the secure Icecast connection setting.")
        _input_arguments(settings)


class RecordingEngine:
    def __init__(self, notify: StateCallback) -> None:
        self._notify = notify
        self._process: asyncio.subprocess.Process | None = None
        self._monitor_task: asyncio.Task[None] | None = None
        self._error_lines: deque[str] = deque(maxlen=8)
        self._progress_event: asyncio.Event | None = None
        self._stopping = False
        self.output_path = ""

    async def start(self, settings: dict[str, Any]) -> str:
        if self._process and self._process.returncode is None:
            return self.output_path
        ffmpeg = bundled_ffmpeg()
        if not ffmpeg:
            raise EngineError("FFmpeg was not found")
        codec, extension, output_format = _recording_codec_arguments(settings)
        destination = Path(str(settings.get("recordingPath") or Path.home() / "Music" / "RebornBroadcaster"))
        if destination.suffix:
            output = destination.with_suffix(extension)
        else:
            destination.mkdir(parents=True, exist_ok=True)
            output = destination / f"broadcast-{datetime.now():%Y%m%d-%H%M%S}{extension}"
        output.parent.mkdir(parents=True, exist_ok=True)
        self.output_path = str(output)
        self._error_lines.clear()
        self._progress_event = asyncio.Event()
        self._stopping = False
        self._notify(
            "recording",
            {
                "status": "starting",
                "error": "",
                "path": self.output_path,
                "format": extension.lstrip("."),
                "sizeBytes": 0,
            },
        )
        process = await asyncio.create_subprocess_exec(
            str(ffmpeg), "-hide_banner", "-loglevel", "warning",
            *_input_arguments(settings), *codec, "-f", output_format,
            "-progress", "pipe:2", "-nostats", "-y", self.output_path,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE,
            **_subprocess_options(),
        )
        self._process = process
        self._monitor_task = asyncio.create_task(
            self._monitor(process, output), name="audio-recording-monitor"
        )
        for _attempt in range(50):
            if process.returncode is not None:
                break
            if self._progress_event.is_set():
                self._notify(
                    "recording",
                    {
                        "status": "recording",
                        "error": "",
                        "path": self.output_path,
                        "format": extension.lstrip("."),
                        "sizeBytes": self._output_size(output),
                    },
                )
                return self.output_path
            await asyncio.sleep(0.1)

        if process.returncode is None:
            self._stopping = True
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), timeout=3)
            except asyncio.TimeoutError:
                process.kill()
                await process.wait()
        if self._monitor_task:
            await self._monitor_task
        self._process = None
        self._monitor_task = None
        self._remove_empty_output(output)
        details = " | ".join(self._error_lines)
        if details:
            raise EngineError(f"Recording failed to receive audio: {details}")
        raise EngineError(
            "Recording failed to receive audio within 5 seconds. "
            f"Confirm the selected {current_audio_backend().display_name} source is active and not locked by another application."
        )

    async def _monitor(self, process: asyncio.subprocess.Process, output: Path) -> None:
        if process.stderr:
            while True:
                line = await process.stderr.readline()
                if not line:
                    break
                text = line.decode(errors="replace").strip()
                key, separator, value = text.partition("=")
                if separator and key in {"out_time_us", "out_time_ms", "total_size"}:
                    try:
                        if int(value) > 0 and self._progress_event:
                            self._progress_event.set()
                    except ValueError:
                        pass
                if text and not PROGRESS_PATTERN.match(text):
                    self._error_lines.append(text)
        return_code = await process.wait()
        if process is not self._process or self._stopping:
            return
        self._process = None
        details = " | ".join(self._error_lines)
        error = f"FFmpeg recording stopped unexpectedly ({return_code})"
        if details:
            error = f"{error}: {details}"
        self._remove_empty_output(output)
        self._notify(
            "recording",
            {
                "status": "error",
                "error": error,
                "path": self.output_path,
                "sizeBytes": self._output_size(output),
            },
        )

    async def stop(self) -> None:
        process = self._process
        self._stopping = True
        if process and process.returncode is None:
            if process.stdin:
                process.stdin.write(b"q\n")
                await process.stdin.drain()
            try:
                await asyncio.wait_for(process.wait(), timeout=5)
            except asyncio.TimeoutError:
                process.terminate()
                try:
                    await asyncio.wait_for(process.wait(), timeout=3)
                except asyncio.TimeoutError:
                    process.kill()
                    await process.wait()
        if self._monitor_task:
            await self._monitor_task
        output = Path(self.output_path) if self.output_path else None
        size = self._output_size(output) if output else 0
        self._process = None
        self._monitor_task = None
        self._progress_event = None
        self._stopping = False
        if process and size == 0:
            if output:
                self._remove_empty_output(output)
            error = "Recording stopped without receiving any audio; the empty file was removed"
            self._notify(
                "recording",
                {"status": "error", "error": error, "path": self.output_path, "sizeBytes": 0},
            )
            raise EngineError(error)
        self._notify(
            "recording",
            {"status": "stopped", "error": "", "path": self.output_path, "sizeBytes": size},
        )

    @staticmethod
    def _output_size(output: Path) -> int:
        try:
            return output.stat().st_size
        except OSError:
            return 0

    @staticmethod
    def _remove_empty_output(output: Path) -> None:
        try:
            if output.exists() and output.stat().st_size == 0:
                output.unlink()
        except OSError:
            pass
