from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path


def is_packaged() -> bool:
    program = Path(sys.argv[0]).name.lower() if sys.argv else ""
    return bool(
        getattr(sys, "frozen", False)
        or "__compiled__" in globals()
        or program == "rebornbroadcaster.exe"
        or Path(sys.executable).name.lower() == "rebornbroadcaster.exe"
    )


def packaged_executable() -> Path:
    program = Path(sys.argv[0]).resolve() if sys.argv else Path(sys.executable).resolve()
    return program if program.name.lower() == "rebornbroadcaster.exe" else Path(sys.executable).resolve()


def resource_root() -> Path:
    bundled = getattr(sys, "_MEIPASS", None)
    if bundled:
        return Path(bundled)
    return Path(__file__).resolve().parents[1]


def settings_path() -> Path:
    app_data = Path(os.environ.get("APPDATA", Path.home() / ".config"))
    candidates = (
        app_data / "rebornbroadcaster" / "settings.json",
        app_data / "RebornBroadcaster" / "settings.json",
        app_data / "Reborn Entertainment" / "RebornBroadcaster" / "settings.json",
    )
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return candidates[0]


def bundled_ffmpeg() -> Path | None:
    roots = [resource_root(), resource_root().parent]
    patterns = (
        "ffmpeg.exe",
        "node_modules/ffmpeg-static/ffmpeg.exe",
        "node_modules/ffmpeg-static/ffmpeg",
        "resources/app.asar.unpacked/node_modules/@ffmpeg-installer/win32-x64/ffmpeg.exe",
        "node_modules/@ffmpeg-installer/win32-x64/ffmpeg.exe",
    )
    for root in roots:
        for pattern in patterns:
            candidate = root / pattern
            if candidate.exists():
                return candidate
    system_ffmpeg = shutil.which("ffmpeg")
    return Path(system_ffmpeg) if system_ffmpeg else None
