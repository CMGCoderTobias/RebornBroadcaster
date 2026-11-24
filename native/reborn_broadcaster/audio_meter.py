from __future__ import annotations

import re
import subprocess
import sys
import threading
import time
from typing import Any, Callable

from .audio_engine import input_arguments
from .paths import bundled_ffmpeg


LEVEL_PATTERN = re.compile(r"lavfi\.astats\.Overall\.RMS_level=(-?(?:\d+(?:\.\d+)?|inf))")


def _subprocess_options() -> dict[str, int]:
    if sys.platform == "win32":
        return {"creationflags": subprocess.CREATE_NO_WINDOW}
    return {}


class AudioLevelMonitor:
    def __init__(self, notify: Callable[[float], None]) -> None:
        self._notify = notify
        self._process: subprocess.Popen[str] | None = None
        self._generation = 0
        self._lock = threading.Lock()

    def start(self, settings: dict[str, Any]) -> None:
        self.stop()
        source = str(settings.get("audioSourceId") or settings.get("audioSourceName") or "").strip()
        if not source:
            self._notify(-96.0)
            return
        self._generation += 1
        generation = self._generation
        threading.Thread(
            target=self._run,
            args=(dict(settings), generation),
            daemon=True,
            name="audio-level-monitor",
        ).start()

    def stop(self) -> None:
        self._generation += 1
        with self._lock:
            process = self._process
            self._process = None
        if process is not None and process.poll() is None:
            process.terminate()
        self._notify(-96.0)

    def _run(self, settings: dict[str, Any], generation: int) -> None:
        ffmpeg = bundled_ffmpeg()
        if not ffmpeg:
            self._notify(-96.0)
            return
        try:
            command = [
                str(ffmpeg), "-hide_banner", "-nostdin", "-loglevel", "error",
                *input_arguments(settings), "-vn", "-sn", "-dn",
                "-filter:a",
                "astats=metadata=1:reset=1,ametadata=mode=print:key=lavfi.astats.Overall.RMS_level:file=-",
                "-f", "null", "-",
            ]
            process = subprocess.Popen(
                command,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
                **_subprocess_options(),
            )
        except (OSError, ValueError):
            self._notify(-96.0)
            return
        with self._lock:
            if generation != self._generation:
                process.terminate()
                return
            self._process = process
        last_update = 0.0
        if process.stdout is not None:
            for line in process.stdout:
                if generation != self._generation:
                    break
                match = LEVEL_PATTERN.search(line)
                if not match:
                    continue
                value = match.group(1).lower()
                level = -96.0 if value in {"-inf", "inf"} else max(-96.0, min(0.0, float(value)))
                now = time.monotonic()
                if now - last_update >= 0.08:
                    last_update = now
                    self._notify(level)
        with self._lock:
            if self._process is process:
                self._process = None
        if generation == self._generation:
            self._notify(-96.0)
