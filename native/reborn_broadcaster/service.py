from __future__ import annotations

import asyncio
import json
import os
from copy import deepcopy
from datetime import UTC, datetime
from typing import Any, Callable
from pathlib import Path

from . import __version__
from .audio_engine import (
    EngineError,
    IcecastAudioEngine,
    RecordingEngine,
    list_audio_sources,
    voicemeeter_source_for_route,
)
from .icecast_control import IcecastControl
from .obs_adapter import ObsController, ObsError, find_obs
from .paths import controller_exit_request_path
from .pipewire_ingress import PipeWireIngress
from .settings import STREAM_DESTINATION_KEYS, SettingsError, SettingsStore


Listener = Callable[[dict[str, Any]], None]


class BroadcastService:
    def __init__(self, store: SettingsStore | None = None) -> None:
        self.store = store or SettingsStore()
        self.settings = self.store.load()
        if not self.settings.get("streamDestinationUpdatedAt"):
            self.settings = self.store.save(
                {"streamDestinationUpdatedAt": self._timestamp()}, merge=True
            )
        self.state: dict[str, Any] = {
            "core": {"status": "ready", "headless": True, "version": __version__, "pid": os.getpid()},
            "outputs": {
                "radio": {"enabled": bool(self.settings["icecastEnabled"]), "status": "stopped", "error": "", "effectiveBitrate": 0},
                "video": {
                    "enabled": bool(self.settings["obsEnabled"]),
                    "provider": "obs",
                    "installed": bool(find_obs(str(self.settings.get("obsExePath", "")))),
                    "connected": False,
                    "status": "disabled" if not self.settings["obsEnabled"] else "stopped",
                    "error": "",
                },
            },
            "recording": {
                "status": "stopped",
                "error": "",
                "path": "",
                "format": "",
                "sizeBytes": 0,
                "coreVersion": __version__,
            },
            "videoRecording": {"status": "stopped", "error": "", "path": ""},
            "listeners": None,
            "listenerStatus": "stopped",
            "listenerError": "",
            "nowPlaying": str(self.settings.get("nowPlaying") or ""),
            "streamDestinationUpdatedAt": str(
                self.settings.get("streamDestinationUpdatedAt") or ""
            ),
            "metadataStatus": "idle",
            "metadataError": "",
            "lastCommand": None,
            "updatedAt": self._timestamp(),
        }
        self._listeners: set[Listener] = set()
        self._activity_sequence = 0
        self._managed_audio_source = ""
        self._managed_audio_source_owner = ""
        self._ingress_retry_task: asyncio.Task[None] | None = None
        self._command_lock = asyncio.Lock()
        self.audio = IcecastAudioEngine(self._engine_state)
        self.recording = RecordingEngine(self._engine_state)
        self.obs = ObsController()
        self.pipewire_ingress = PipeWireIngress()
        self._live_metadata_task: asyncio.Task[None] | None = None
        self._publish_audio_source_state()
        self.icecast = IcecastControl(
            lambda: deepcopy(self.settings),
            lambda: self.state["outputs"]["radio"]["status"] == "live",
            self._icecast_state,
        )

    def start_background_tasks(self) -> None:
        self.icecast.start()
        if self.pipewire_ingress.supported:
            self._ingress_retry_task = asyncio.create_task(
                self._ensure_pipewire_ingress_with_retries(),
                name="pipewire-ingress",
            )

    def subscribe(self, listener: Listener) -> None:
        self._listeners.add(listener)

    def unsubscribe(self, listener: Listener) -> None:
        self._listeners.discard(listener)

    def snapshot(self) -> dict[str, Any]:
        return deepcopy(self.state)

    def _engine_state(self, section: str, patch: dict[str, Any]) -> None:
        target = self.state["outputs"].get(section) if section in self.state["outputs"] else self.state.get(section)
        if isinstance(target, dict):
            target.update(patch)
        self.state["updatedAt"] = self._timestamp()
        snapshot = self.snapshot()
        for listener in tuple(self._listeners):
            listener(snapshot)

    def _icecast_state(self, patch: dict[str, Any]) -> None:
        self.state.update(patch)
        self.state["updatedAt"] = self._timestamp()
        snapshot = self.snapshot()
        for listener in tuple(self._listeners):
            listener(snapshot)

    def record_command_activity(
        self,
        command: str,
        source: str,
        status: str,
        detail: str = "",
    ) -> dict[str, Any]:
        self._activity_sequence += 1
        activity = {
            "sequence": self._activity_sequence,
            "command": command,
            "source": source[:80] or "API client",
            "status": status,
            "detail": detail[:240],
            "at": self._timestamp(),
        }
        self.state["lastCommand"] = activity
        self.state["updatedAt"] = activity["at"]
        snapshot = self.snapshot()
        for listener in tuple(self._listeners):
            listener(snapshot)
        return activity

    async def execute(self, command: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        payload = payload or {}
        requested = command.strip().lower()
        normalized = requested
        normalized = {"close-app": "stop-core", "open-app": "get-state"}.get(normalized, normalized)
        async with self._command_lock:
            if normalized in {"get-state", "request-state", "status"}:
                return {"ok": True, "state": self.snapshot()}
            if normalized == "get-settings":
                return {"ok": True, "settings": deepcopy(self.settings)}
            if normalized == "get-stream-destination":
                return {"ok": True, "destination": self._stream_destination()}
            if normalized == "list-audio-sources":
                await self._ensure_pipewire_ingress()
                return {"ok": True, "audioSources": await asyncio.to_thread(list_audio_sources)}
            if normalized == "select-audio-source":
                route = str(payload.get("route") or "").strip().upper()
                ingress_sink, ingress_source = await self._ensure_pipewire_ingress()
                if self.pipewire_ingress.supported and not ingress_source:
                    raise EngineError("RebornBroadcaster PipeWire input is not ready; retrying")
                if ingress_source:
                    source = ingress_source
                else:
                    sources = await asyncio.to_thread(list_audio_sources)
                    source = voicemeeter_source_for_route(route, sources)
                self._managed_audio_source = source
                self._managed_audio_source_owner = str(payload.get("source") or "API client")
                self._publish_audio_source_state()
                return {
                    "ok": True,
                    "audioSource": source,
                    "route": route,
                    "managed": True,
                    "ingressSink": ingress_sink,
                    "state": self.snapshot(),
                }
            if normalized == "release-audio-source":
                owner = str(payload.get("source") or "API client")
                if not self._managed_audio_source_owner or self._managed_audio_source_owner == owner:
                    self._managed_audio_source = ""
                    self._managed_audio_source_owner = ""
                    self._publish_audio_source_state()
                return {"ok": True, "managed": False, "state": self.snapshot()}
            if normalized == "save-settings":
                return self._save_settings(payload.get("settings", payload), payload.get("merge", True))
            if normalized == "set-stream-destination":
                return self._set_stream_destination(payload)
            if normalized == "export-config":
                return self._export_config(payload)
            if normalized == "import-config":
                return self._import_config(payload)
            if normalized in {"start-stream", "start-radio"}:
                return await self._start_radio()
            if normalized in {"stop-stream", "stop-radio"}:
                await self.audio.stop()
                await self._cancel_live_metadata()
                return {"ok": True, "state": self.snapshot()}
            if normalized == "start-video":
                return await self._start_video()
            if normalized == "stop-video":
                await self._stop_video()
                return {"ok": True, "state": self.snapshot()}
            if normalized == "go-live":
                return await self._go_live()
            if normalized == "stop-live":
                return await self._stop_live()
            if normalized == "start-recording":
                return await self._start_recording()
            if normalized == "stop-recording":
                await self.recording.stop()
                return {"ok": True, "state": self.snapshot()}
            if normalized == "start-video-recording":
                return await self._start_video_recording()
            if normalized == "stop-video-recording":
                await self._stop_video_recording()
                return {"ok": True, "state": self.snapshot()}
            if normalized == "detect-obs":
                return self._detect_obs()
            if normalized == "test-obs":
                return await self._test_obs()
            if normalized in {"update-now-playing", "set-now-playing"}:
                return await self._update_now_playing(payload)
            if normalized == "refresh-listeners":
                await self.icecast.refresh_listeners()
                return {"ok": True, "state": self.snapshot()}
            if normalized in {"update-status", "prepare-update"}:
                return self._update_status()
            if normalized == "shutdown-core":
                update_status = self._update_status()
                if not update_status["safeToInstall"]:
                    active = ", ".join(update_status["blockedBy"])
                    raise RuntimeError(f"Core cannot close while outputs are active: {active}")
                await self.shutdown()
                return {"ok": True, "shutdown": True, "state": self.snapshot()}
            if normalized == "stop-core":
                if requested == "close-app":
                    self._request_controller_exit(str(payload.get("source") or "API client"))
                return {
                    "ok": True,
                    "shutdown": True,
                    "shutdownAccepted": True,
                    "state": self.snapshot(),
                }
            raise ValueError(f"Unknown command: {command}")

    def _request_controller_exit(self, source: str) -> None:
        try:
            destination = controller_exit_request_path()
            destination.parent.mkdir(parents=True, exist_ok=True)
            temporary = destination.with_suffix(".tmp")
            temporary.write_text(
                json.dumps({"source": source[:80], "requestedAt": self._timestamp(), "corePid": os.getpid()}),
                encoding="utf-8",
            )
            temporary.replace(destination)
        except OSError:
            pass

    def _save_settings(self, incoming: Any, merge: bool) -> dict[str, Any]:
        if not isinstance(incoming, dict):
            raise SettingsError("settings must be an object")
        candidate = self.store.normalize({**self.settings, **incoming} if merge else incoming)
        destination_changed = any(
            candidate.get(key) != self.settings.get(key) for key in STREAM_DESTINATION_KEYS
        )
        if destination_changed:
            incoming_at = str(incoming.get("streamDestinationUpdatedAt") or "").strip()
            current_at = str(self.settings.get("streamDestinationUpdatedAt") or "").strip()
            if incoming_at and current_at and incoming_at <= current_at:
                for key in STREAM_DESTINATION_KEYS:
                    candidate[key] = self.settings.get(key)
                candidate["streamDestinationUpdatedAt"] = current_at
            elif not incoming_at:
                candidate["streamDestinationUpdatedAt"] = self._timestamp()
        if candidate["obsEnabled"] and candidate["obsHost"] in {"127.0.0.1", "localhost", "::1"}:
            executable = find_obs(str(candidate.get("obsExePath", "")))
            if not executable:
                raise SettingsError("OBS cannot be enabled because OBS Studio is not installed or could not be found")
            candidate["obsExePath"] = str(executable)
        self.settings = self.store.save(candidate, merge=False)
        radio = self.state["outputs"]["radio"]
        video = self.state["outputs"]["video"]
        radio["enabled"] = self.settings["icecastEnabled"]
        video.update(
            {
                "enabled": self.settings["obsEnabled"],
                "installed": bool(find_obs(str(self.settings.get("obsExePath", "")))),
                "status": video["status"] if self.settings["obsEnabled"] else "disabled",
            }
        )
        self.state["nowPlaying"] = str(self.settings.get("nowPlaying") or "")
        self._publish_audio_source_state()
        self.state["streamDestinationUpdatedAt"] = str(
            self.settings.get("streamDestinationUpdatedAt") or ""
        )
        self._engine_state("radio", {})
        return {"ok": True, "settings": deepcopy(self.settings), "state": self.snapshot()}

    def _stream_destination(self) -> dict[str, Any]:
        return {
            **{key: deepcopy(self.settings.get(key)) for key in STREAM_DESTINATION_KEYS},
            "updatedAt": str(self.settings.get("streamDestinationUpdatedAt") or ""),
        }

    def _set_stream_destination(self, payload: dict[str, Any]) -> dict[str, Any]:
        incoming = payload.get("destination", payload)
        if not isinstance(incoming, dict):
            raise SettingsError("destination must be an object")
        incoming_at = str(incoming.get("updatedAt") or "").strip()
        if not incoming_at:
            raise SettingsError("destination updatedAt is required")
        current_at = str(self.settings.get("streamDestinationUpdatedAt") or "").strip()
        if current_at and incoming_at <= current_at:
            return {
                "ok": True,
                "applied": False,
                "reason": "RebornBroadcaster has an equally recent or newer destination",
                "destination": self._stream_destination(),
            }
        changes = {key: incoming[key] for key in STREAM_DESTINATION_KEYS if key in incoming}
        changes["streamDestinationUpdatedAt"] = incoming_at
        result = self._save_settings(changes, True)
        return {
            **result,
            "applied": True,
            "destination": self._stream_destination(),
        }

    def _export_config(self, payload: dict[str, Any]) -> dict[str, Any]:
        file_path = str(payload.get("filePath") or "").strip()
        if not file_path:
            raise SettingsError("An export file path is required")
        destination = Path(file_path).expanduser().resolve()
        destination.parent.mkdir(parents=True, exist_ok=True)
        exported = deepcopy(self.settings) if payload.get("includeSecrets") else self.store.without_secrets(self.settings)
        destination.write_text(json.dumps(exported, indent=2) + "\n", encoding="utf-8")
        return {"ok": True, "filePath": str(destination)}

    def _import_config(self, payload: dict[str, Any]) -> dict[str, Any]:
        file_path = str(payload.get("filePath") or "").strip()
        if not file_path:
            raise SettingsError("An import file path is required")
        source = Path(file_path).expanduser().resolve()
        try:
            imported = json.loads(source.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise SettingsError(f"Unable to import config: {error}") from error
        if not isinstance(imported, dict):
            raise SettingsError("Imported config must contain a settings object")
        for secret in ("sourcepassword", "obsPassword"):
            if imported.get(secret) == "********":
                imported.pop(secret)
        return self._save_settings(imported, bool(payload.get("merge", True)))

    async def _start_radio(self) -> dict[str, Any]:
        if not self.settings["icecastEnabled"]:
            raise EngineError("Icecast output is disabled")
        try:
            await self.audio.start(self._effective_audio_settings())
            title = str(self.state.get("nowPlaying") or self.settings.get("nowPlaying") or "").strip()
            await self._cancel_live_metadata()
            self._live_metadata_task = asyncio.create_task(
                self._initialize_live_metadata(title), name="icecast-live-metadata"
            )
            return {"ok": True, "state": self.snapshot()}
        except Exception as error:
            self._engine_state("radio", {"status": "error", "error": str(error)})
            raise

    async def _start_video(self) -> dict[str, Any]:
        video = self.state["outputs"]["video"]
        if not self.settings["obsEnabled"]:
            video.update({"status": "disabled", "connected": False})
            return {"ok": False, "skipped": True, "error": "OBS output is disabled"}
        executable = find_obs(str(self.settings.get("obsExePath", "")))
        local = self.settings["obsHost"] in {"127.0.0.1", "localhost", "::1"}
        if local and not executable:
            error = "OBS Studio is not installed or could not be found"
            self._engine_state("video", {"installed": False, "connected": False, "status": "unavailable", "error": error})
            raise ObsError(error)
        self._engine_state("video", {"installed": bool(executable) or not local, "status": "connecting", "error": ""})
        try:
            await self.obs.connect(self.settings, launch_if_needed=bool(self.settings["obsAutoLaunch"]))
            self._engine_state("video", {"connected": True, "status": "starting", "error": ""})
            await self.obs.start_stream()
            self._engine_state("video", {"connected": True, "status": "live", "error": ""})
            return {"ok": True, "state": self.snapshot()}
        except Exception as error:
            await self.obs.close()
            self._engine_state("video", {"connected": False, "status": "error", "error": str(error)})
            raise

    async def _go_live(self) -> dict[str, Any]:
        jobs = []
        names = []
        if self.settings["icecastEnabled"]:
            names.append("radio")
            jobs.append(self._start_radio())
        if self.settings["obsEnabled"]:
            names.append("video")
            jobs.append(self._start_video())
        if not jobs:
            raise EngineError("No broadcast outputs are enabled")
        results = await asyncio.gather(*jobs, return_exceptions=True)
        errors = {name: str(result) for name, result in zip(names, results) if isinstance(result, Exception)}
        succeeded = [name for name, result in zip(names, results) if not isinstance(result, Exception)]
        return {"ok": bool(succeeded), "started": succeeded, "errors": errors, "state": self.snapshot()}

    async def _stop_live(self) -> dict[str, Any]:
        results = await asyncio.gather(self.audio.stop(), self._stop_video(), return_exceptions=True)
        await self._cancel_live_metadata()
        errors = [str(result) for result in results if isinstance(result, Exception)]
        return {"ok": not errors, "errors": errors, "state": self.snapshot()}

    async def _stop_video(self) -> None:
        video = self.state["outputs"]["video"]
        if video["status"] not in {"connecting", "starting", "live", "error"}:
            return
        try:
            await self.obs.stop_stream()
            status = "stopped" if self.settings["obsEnabled"] else "disabled"
            recording_active = self.state["videoRecording"]["status"] in {"starting", "recording"}
            self._engine_state("video", {"connected": recording_active, "status": status, "error": ""})
            if not recording_active:
                await self.obs.close()
        except Exception as error:
            await self.obs.close()
            self._engine_state("video", {"connected": False, "status": "error", "error": str(error)})
            raise

    async def _start_video_recording(self) -> dict[str, Any]:
        if not self.settings["obsEnabled"]:
            raise ObsError("OBS output is disabled")
        try:
            await self.obs.connect(self.settings, launch_if_needed=bool(self.settings["obsAutoLaunch"]))
            self._engine_state("videoRecording", {"status": "starting", "error": ""})
            await self.obs.start_recording()
            status = await self.obs.record_status()
            self._engine_state(
                "videoRecording",
                {"status": "recording", "error": "", "path": str(status.get("outputPath") or "")},
            )
            return {"ok": True, "state": self.snapshot()}
        except Exception as error:
            self._engine_state("videoRecording", {"status": "error", "error": str(error)})
            raise

    async def _stop_video_recording(self) -> None:
        if self.state["videoRecording"]["status"] not in {"starting", "recording", "error"}:
            return
        try:
            await self.obs.stop_recording()
            self._engine_state("videoRecording", {"status": "stopped", "error": ""})
            if self.state["outputs"]["video"]["status"] != "live":
                await self.obs.close()
                self._engine_state("video", {"connected": False})
        except Exception as error:
            self._engine_state("videoRecording", {"status": "error", "error": str(error)})
            raise

    async def _start_recording(self) -> dict[str, Any]:
        try:
            self.settings = self.store.load()
            encoding = str(self.settings.get("encodingType") or "mp3").strip().lower()
            expected_format = {
                "aac": "m4a",
                "m4a": "m4a",
                "opus": "ogg",
                "ogg-opus": "ogg",
                "vorbis": "ogg",
                "ogg": "ogg",
            }.get(encoding, "mp3")
            self._engine_state(
                "recording",
                {
                    "format": expected_format,
                    "sizeBytes": 0,
                    "coreVersion": __version__,
                },
            )
            path = await self.recording.start(self._effective_audio_settings())
            recording = deepcopy(self.state["recording"])
            return {
                "ok": True,
                "path": path,
                "format": recording.get("format"),
                "sizeBytes": recording.get("sizeBytes", 0),
                "coreVersion": __version__,
                "recording": recording,
                "state": self.snapshot(),
            }
        except Exception as error:
            self._engine_state("recording", {"status": "error", "error": str(error)})
            raise

    def _detect_obs(self) -> dict[str, Any]:
        executable = find_obs(str(self.settings.get("obsExePath", "")))
        self._engine_state("video", {"installed": bool(executable)})
        return {"ok": True, "installed": bool(executable), "path": str(executable or ""), "state": self.snapshot()}

    async def _update_now_playing(self, payload: dict[str, Any]) -> dict[str, Any]:
        title = str(payload.get("nowPlaying") or payload.get("title") or payload.get("song") or "").strip()
        if not title:
            raise SettingsError("Now-playing text is required")
        self.settings = self.store.save({**self.settings, "nowPlaying": title}, merge=False)
        self._icecast_state({"nowPlaying": title, "metadataStatus": "waiting", "metadataError": ""})
        if self.state["outputs"]["radio"]["status"] == "live":
            await self.icecast.update_now_playing(title)
        return {"ok": True, "nowPlaying": title, "state": self.snapshot()}

    async def _initialize_live_metadata(self, title: str) -> None:
        if title:
            try:
                await self.icecast.update_now_playing(title)
            except Exception as error:
                self._icecast_state({"metadataStatus": "error", "metadataError": str(error)})
        await self.icecast.refresh_listeners()

    async def _cancel_live_metadata(self) -> None:
        task, self._live_metadata_task = self._live_metadata_task, None
        if task is None or task.done():
            return
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)

    async def _test_obs(self) -> dict[str, Any]:
        executable = find_obs(str(self.settings.get("obsExePath", "")))
        local = self.settings["obsHost"] in {"127.0.0.1", "localhost", "::1"}
        if local and not executable:
            raise ObsError("OBS Studio is not installed or could not be found")
        try:
            await self.obs.connect(self.settings, launch_if_needed=False)
            status = await self.obs.stream_status()
            self._engine_state("video", {"installed": bool(executable) or not local, "connected": True, "status": "live" if status.get("outputActive") else "ready", "error": ""})
        except Exception as error:
            self._engine_state("video", {"installed": bool(executable) or not local, "connected": False, "status": "error", "error": str(error)})
            raise
        finally:
            await self.obs.close()
        self._engine_state("video", {"connected": False, "status": "live" if status.get("outputActive") else "ready"})
        return {"ok": True, "obs": status, "state": self.snapshot()}

    def _update_status(self) -> dict[str, Any]:
        radio_status = self.state["outputs"]["radio"]["status"]
        video_status = self.state["outputs"]["video"]["status"]
        recording_status = self.state["recording"]["status"]
        video_recording_status = self.state["videoRecording"]["status"]
        active_values = {"connecting", "live", "recording", "starting", "recovering", "backing-off"}
        blocked_by = []
        if radio_status in active_values:
            blocked_by.append("radio")
        if video_status in active_values:
            blocked_by.append("video")
        if recording_status in active_values:
            blocked_by.append("recording")
        if video_recording_status in active_values:
            blocked_by.append("video-recording")
        return {
            "ok": not blocked_by,
            "safeToInstall": not blocked_by,
            "blockedBy": blocked_by,
            "state": self.snapshot(),
        }

    async def shutdown(self) -> None:
        if self._ingress_retry_task:
            self._ingress_retry_task.cancel()
            self._ingress_retry_task = None
        await self._cancel_live_metadata()
        await asyncio.gather(
            self.icecast.stop(),
            self.audio.stop(),
            self.recording.stop(),
            return_exceptions=True,
        )
        try:
            await self._stop_video_recording()
        except Exception:
            pass
        try:
            await self._stop_video()
        except Exception:
            pass
        try:
            await self.obs.close()
        except Exception:
            pass
        await asyncio.to_thread(self.pipewire_ingress.close)
        self.state["core"]["status"] = "stopped"

    async def _ensure_pipewire_ingress(self) -> tuple[str, str]:
        if not self.pipewire_ingress.supported:
            return "", ""
        try:
            sink, source = await asyncio.to_thread(self.pipewire_ingress.ensure)
            self.state["pipeWireIngress"] = {
                "status": "ready", "sink": sink, "source": source, "error": "",
            }
            return sink, source
        except Exception as error:
            self.state["pipeWireIngress"] = {
                "status": "retrying", "sink": "", "source": "", "error": str(error),
            }
            return "", ""

    async def _ensure_pipewire_ingress_with_retries(self) -> None:
        delay = 1.0
        while True:
            sink, _source = await self._ensure_pipewire_ingress()
            if sink:
                return
            await asyncio.sleep(delay)
            delay = min(delay * 1.5, 10.0)

    def _effective_audio_settings(self) -> dict[str, Any]:
        settings = deepcopy(self.settings)
        if self._managed_audio_source:
            settings["audioSourceId"] = self._managed_audio_source
            settings["audioSourceName"] = self._managed_audio_source
        return settings

    def _publish_audio_source_state(self) -> None:
        standalone = str(
            self.settings.get("audioSourceId") or self.settings.get("audioSourceName") or ""
        )
        self.state["audioSource"] = standalone
        self.state["managedAudioSource"] = self._managed_audio_source
        self.state["effectiveAudioSource"] = self._managed_audio_source or standalone
        self.state["audioSourceManagedBy"] = self._managed_audio_source_owner
        self.state["updatedAt"] = self._timestamp()

    @staticmethod
    def _timestamp() -> str:
        return datetime.now(UTC).isoformat()
