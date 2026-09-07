from __future__ import annotations

import asyncio
import base64
import json
from pathlib import Path
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from . import __version__

SettingsProvider = Callable[[], dict[str, Any]]
StateCallback = Callable[[dict[str, Any]], None]
RadioActive = Callable[[], bool]


def _external_path(settings: dict[str, Any], endpoint: str) -> str:
    proxy_path = str(settings.get("icecastProxyPath") or "").strip().strip("/")
    return "/" + "/".join(part for part in (proxy_path, endpoint.lstrip("/")) if part)


class IcecastControl:
    def __init__(
        self,
        settings_provider: SettingsProvider,
        radio_active: RadioActive,
        notify: StateCallback,
    ) -> None:
        self._settings_provider = settings_provider
        self._radio_active = radio_active
        self._notify = notify
        self._tasks: list[asyncio.Task[None]] = []
        self._last_file_value = ""
        self._was_radio_active = False

    def start(self) -> None:
        if self._tasks:
            return
        self._tasks = [
            asyncio.create_task(self._listener_loop(), name="icecast-listeners"),
            asyncio.create_task(self._file_loop(), name="icecast-now-playing-file"),
        ]

    async def stop(self) -> None:
        if not self._tasks:
            return
        tasks, self._tasks = self._tasks, []
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    async def update_now_playing(self, title: str) -> None:
        value = " ".join(str(title).split()).strip()
        if not value:
            raise ValueError("Now-playing text cannot be empty")
        settings = self._settings_provider()
        await asyncio.to_thread(self._send_metadata, settings, value)
        self._notify({"nowPlaying": value, "metadataStatus": "updated", "metadataError": ""})

    async def refresh_listeners(self) -> None:
        if not self._radio_active():
            self._notify({"listeners": None, "listenerStatus": "stopped", "listenerError": ""})
            return
        settings = self._settings_provider()
        try:
            listeners = await asyncio.to_thread(self._read_listeners, settings)
        except Exception as error:
            self._notify(
                {
                    "listeners": None,
                    "listenerStatus": "unavailable",
                    "listenerError": str(error),
                }
            )
            return
        if listeners is None:
            self._notify(
                {
                    "listeners": None,
                    "listenerStatus": "hidden",
                    "listenerError": "Mount is not exposed by the public Icecast status endpoint",
                }
            )
            return
        self._notify({"listeners": listeners, "listenerStatus": "available", "listenerError": ""})

    async def _listener_loop(self) -> None:
        while True:
            radio_active = self._radio_active()
            if radio_active:
                await self.refresh_listeners()
            elif self._was_radio_active and not radio_active:
                self._notify({"listeners": None, "listenerStatus": "stopped", "listenerError": ""})
            self._was_radio_active = radio_active
            await asyncio.sleep(10 if radio_active else 2)

    async def _file_loop(self) -> None:
        while True:
            settings = self._settings_provider()
            await self._read_now_playing_file(settings)
            await asyncio.sleep(2)

    async def _read_now_playing_file(self, settings: dict[str, Any]) -> None:
        if not settings.get("nowPlayingFileEnabled"):
            self._last_file_value = ""
            return
        configured = str(settings.get("nowPlayingFile") or "").strip()
        if not configured:
            self._notify({"metadataStatus": "file-error", "metadataError": "Select a now-playing text file"})
            return
        try:
            contents = await asyncio.to_thread(Path(configured).expanduser().read_text, encoding="utf-8-sig")
            title = next((line.strip() for line in contents.splitlines() if line.strip()), "")
        except OSError as error:
            self._notify({"metadataStatus": "file-error", "metadataError": str(error)})
            return
        if not title or title == self._last_file_value:
            return
        self._last_file_value = title
        if not self._radio_active():
            self._notify({"nowPlaying": title, "metadataStatus": "waiting", "metadataError": ""})
            return
        try:
            await self.update_now_playing(title)
        except Exception as error:
            self._notify({"metadataStatus": "error", "metadataError": str(error)})

    @staticmethod
    def _send_metadata(settings: dict[str, Any], title: str) -> None:
        scheme = "https" if settings.get("icecastTls") else "http"
        host = str(settings.get("icecastHost") or "").strip()
        port = str(settings.get("icecastPort") or "8000").strip()
        mount = "/" + str(settings.get("mountpoint") or "").strip().lstrip("/")
        query = urlencode({"mode": "updinfo", "mount": mount, "song": title})
        endpoint = _external_path(settings, "admin/metadata")
        request = Request(f"{scheme}://{host}:{port}{endpoint}?{query}")
        username = str(settings.get("username") or "source")
        password = str(settings.get("sourcepassword") or "")
        token = base64.b64encode(f"{username}:{password}".encode()).decode("ascii")
        request.add_header("Authorization", f"Basic {token}")
        request.add_header("User-Agent", f"RebornBroadcaster/{__version__}")
        try:
            with urlopen(request, timeout=5) as response:
                if response.status < 200 or response.status >= 300:
                    raise RuntimeError(f"Icecast metadata update returned HTTP {response.status}")
        except HTTPError as error:
            raise RuntimeError(f"Icecast metadata update returned HTTP {error.code}") from error
        except URLError as error:
            raise RuntimeError(f"Icecast metadata endpoint is unreachable: {error.reason}") from error

    @staticmethod
    def _read_listeners(settings: dict[str, Any]) -> int | None:
        scheme = "https" if settings.get("icecastTls") else "http"
        host = str(settings.get("icecastHost") or "").strip()
        port = str(settings.get("icecastPort") or "8000").strip()
        request = Request(
            f"{scheme}://{host}:{port}{_external_path(settings, 'status-json.xsl')}",
            headers={"User-Agent": f"RebornBroadcaster/{__version__}"},
        )
        try:
            with urlopen(request, timeout=5) as response:
                payload = json.load(response)
        except HTTPError as error:
            raise RuntimeError(f"Icecast status returned HTTP {error.code}") from error
        except URLError as error:
            raise RuntimeError(f"Icecast status endpoint is unreachable: {error.reason}") from error
        sources = payload.get("icestats", {}).get("source", [])
        if isinstance(sources, dict):
            sources = [sources]
        target = "/" + str(settings.get("mountpoint") or "").strip().lstrip("/")
        for source in sources if isinstance(sources, list) else []:
            if not isinstance(source, dict):
                continue
            listen_url = str(source.get("listenurl") or "")
            source_mount = str(source.get("mount") or "")
            if source_mount == target or listen_url.rstrip("/").endswith(target):
                try:
                    return max(0, int(source.get("listeners", 0)))
                except (TypeError, ValueError):
                    return 0
        return None
