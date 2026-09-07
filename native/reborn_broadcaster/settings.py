from __future__ import annotations

import json
import os
import tempfile
from copy import deepcopy
from pathlib import Path
from typing import Any

from .paths import settings_path


DEFAULTS: dict[str, Any] = {
    "schemaVersion": 3,
    "icecastEnabled": True,
    "icecastHost": "",
    "icecastPort": "8000",
    "icecastTls": False,
    "icecastProxyPath": "",
    "icecastLegacySource": False,
    "mountpoint": "stream",
    "username": "source",
    "sourcepassword": "",
    "streamName": "",
    "streamGenre": "",
    "streamDescription": "",
    "streamUrl": "",
    "streamPublic": "0",
    "encodingType": "mp3",
    "audioSourceId": "",
    "audioSourceName": "",
    "bitrate": 128,
    "recordingPath": "",
    "nowPlaying": "",
    "nowPlayingFileEnabled": False,
    "nowPlayingFile": "",
    "adaptiveBackoffEnabled": True,
    "adaptiveMinimumBitrate": 64,
    "adaptiveBackoffRatio": 0.8,
    "obsEnabled": False,
    "obsHost": "127.0.0.1",
    "obsPort": 4455,
    "obsPassword": "",
    "obsExePath": "",
    "obsAutoLaunch": False,
}


class SettingsError(ValueError):
    pass


class SettingsStore:
    def __init__(self, path: Path | None = None) -> None:
        self.path = path or settings_path()

    def load(self) -> dict[str, Any]:
        loaded: dict[str, Any] = {}
        if self.path.exists():
            try:
                value = json.loads(self.path.read_text(encoding="utf-8"))
                if isinstance(value, dict):
                    loaded = value
            except (OSError, json.JSONDecodeError) as error:
                raise SettingsError(f"Unable to read settings: {error}") from error
        return self.normalize(loaded)

    def save(self, incoming: dict[str, Any], merge: bool = True) -> dict[str, Any]:
        current = self.load() if merge else deepcopy(DEFAULTS)
        current.update(incoming)
        normalized = self.normalize(current)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary_name = tempfile.mkstemp(
            prefix="settings-", suffix=".json.tmp", dir=self.path.parent
        )
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as temporary:
                json.dump(normalized, temporary, indent=2)
                temporary.write("\n")
            os.replace(temporary_name, self.path)
        finally:
            if os.path.exists(temporary_name):
                os.unlink(temporary_name)
        return normalized

    @staticmethod
    def normalize(value: dict[str, Any]) -> dict[str, Any]:
        legacy_source_explicit = "icecastLegacySource" in value
        settings = deepcopy(DEFAULTS)
        settings.update(value)
        settings["schemaVersion"] = 3
        settings["mountpoint"] = str(settings.get("mountpoint", "")).strip().lstrip("/")
        settings["icecastProxyPath"] = str(settings.get("icecastProxyPath", "")).strip().strip("/")
        if not legacy_source_explicit:
            settings["icecastLegacySource"] = bool(settings["icecastProxyPath"])
        settings["icecastPort"] = str(settings.get("icecastPort", "8000")).strip()
        settings["obsPort"] = _integer(settings.get("obsPort"), 4455, 1, 65535)
        settings["bitrate"] = _integer(settings.get("bitrate"), 128, 8, 2048)
        settings["adaptiveMinimumBitrate"] = _integer(
            settings.get("adaptiveMinimumBitrate"), 64, 8, settings["bitrate"]
        )
        ratio = _float(settings.get("adaptiveBackoffRatio"), 0.8)
        settings["adaptiveBackoffRatio"] = min(0.95, max(0.5, ratio))
        for key in (
            "icecastEnabled",
            "icecastTls",
            "icecastLegacySource",
            "nowPlayingFileEnabled",
            "adaptiveBackoffEnabled",
            "obsEnabled",
            "obsAutoLaunch",
        ):
            settings[key] = _boolean(settings.get(key))
        settings["streamPublic"] = "1" if str(settings.get("streamPublic")) in {"1", "true", "True"} else "0"
        return settings

    @staticmethod
    def without_secrets(settings: dict[str, Any]) -> dict[str, Any]:
        public = deepcopy(settings)
        for key in ("sourcepassword", "obsPassword"):
            if public.get(key):
                public[key] = "********"
        return public


def _integer(value: Any, fallback: int, minimum: int, maximum: int) -> int:
    try:
        return min(maximum, max(minimum, int(value)))
    except (TypeError, ValueError):
        return fallback


def _float(value: Any, fallback: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return fallback


def _boolean(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes", "on"}
