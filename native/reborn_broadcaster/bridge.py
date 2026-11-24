from __future__ import annotations

import ctypes
import json
import os
import re
import socket
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from PySide6.QtCore import QObject, Property, QTimer, Signal, Slot
from PySide6.QtCore import QUrl
from PySide6.QtGui import QDesktopServices

from . import __version__
from .audio_backends import current_audio_backend
from .audio_engine import audio_conversion_plan
from .paths import bundled_ffmpeg, controller_exit_request_path, is_packaged, packaged_executable
from .updater_health import launched_version, read_update_status, request_update_apply, request_update_check


def _read_documentation() -> str:
    candidates = (
        packaged_executable().parent / "docs" / "USER_GUIDE.md",
        Path(__file__).resolve().parents[2] / "docs" / "USER_GUIDE.md",
    )
    for path in candidates:
        try:
            return path.read_text(encoding="utf-8")
        except OSError:
            continue
    return "# Documentation unavailable\n\nThe bundled user guide could not be loaded."


class CoreBridge(QObject):
    connectedChanged = Signal()
    compatibleChanged = Signal()
    startingCoreChanged = Signal()
    busyChanged = Signal()
    stateJsonChanged = Signal()
    settingsJsonChanged = Signal()
    audioSourcesJsonChanged = Signal()
    messageChanged = Signal()
    updateStatusChanged = Signal()
    conversionChanged = Signal()
    exitReady = Signal()
    _resultReady = Signal(object)
    _updateResultReady = Signal(object)
    _conversionResultReady = Signal(object)
    _coreStartupFinished = Signal(int)

    def __init__(self, host: str = "127.0.0.1", port: int = 8010, auto_start: bool = True) -> None:
        super().__init__()
        self.host = host
        self.port = port
        self._connected = False
        self._compatible = False
        self._starting_core = False
        self._core_start_attempt = 0
        self._core_start_grace_until = 0.0
        self._replacing_core = False
        self._replacement_failed_version = ""
        self._busy = False
        self._state_json = "{}"
        self._settings_json = "{}"
        self._audio_sources_json = "[]"
        self._message = "Connecting to broadcast core…"
        self._update_status = {
            "state": "idle",
            "launchedVersion": launched_version(),
            "currentVersion": launched_version(),
            "latestVersion": "",
        }
        self._update_status_json = json.dumps(self._update_status)
        self._update_refresh_running = False
        self._conversion_busy = False
        self._conversion_message = "Choose an existing recording to convert."
        self._conversion_output = ""
        self._conversion_process: subprocess.Popen[str] | None = None
        self._conversion_cancel_requested = False
        self._last_activity_sequence = 0
        self._discard_controller_exit_request()
        self._resultReady.connect(self._accept_result)
        self._updateResultReady.connect(self._accept_update_result)
        self._conversionResultReady.connect(self._accept_conversion_result)
        self._coreStartupFinished.connect(self._finish_core_start)
        if auto_start:
            QTimer.singleShot(0, self.ensureCore)
            QTimer.singleShot(800, self.refreshUpdateStatus)
            self._update_timer = QTimer(self)
            self._update_timer.setInterval(1500)
            self._update_timer.timeout.connect(self.refreshUpdateStatus)
            self._update_timer.start()

    @Property(bool, notify=connectedChanged)
    def connected(self) -> bool:
        return self._connected

    @Property(bool, notify=compatibleChanged)
    def compatible(self) -> bool:
        return self._compatible

    @Property(bool, notify=startingCoreChanged)
    def startingCore(self) -> bool:
        return self._starting_core

    @Property(bool, notify=busyChanged)
    def busy(self) -> bool:
        return self._busy

    @Property(str, notify=stateJsonChanged)
    def stateJson(self) -> str:
        return self._state_json

    @Property(str, notify=settingsJsonChanged)
    def settingsJson(self) -> str:
        return self._settings_json

    @Property(str, notify=audioSourcesJsonChanged)
    def audioSourcesJson(self) -> str:
        return self._audio_sources_json

    @Property(str, constant=True)
    def audioBackendId(self) -> str:
        return current_audio_backend().backend_id

    @Property(str, constant=True)
    def audioBackendName(self) -> str:
        return current_audio_backend().display_name

    @Property(str, notify=messageChanged)
    def message(self) -> str:
        return self._message

    @Property(str, constant=True)
    def documentationMarkdown(self) -> str:
        return _read_documentation()

    @Property(str, notify=updateStatusChanged)
    def updateStatusJson(self) -> str:
        return self._update_status_json

    @Property(bool, notify=stateJsonChanged)
    def activeOutputs(self) -> bool:
        return self._has_active_outputs()

    @Property(bool, notify=conversionChanged)
    def conversionBusy(self) -> bool:
        return self._conversion_busy

    @Property(str, notify=conversionChanged)
    def conversionMessage(self) -> str:
        return self._conversion_message

    @Property(str, notify=conversionChanged)
    def conversionOutput(self) -> str:
        return self._conversion_output

    def _publish_update_status(self, status: dict) -> None:
        status = {
            **status,
            "launchedVersion": str(status.get("launchedVersion") or launched_version()),
        }
        serialized = json.dumps(status)
        if serialized == self._update_status_json:
            return
        self._update_status = status
        self._update_status_json = serialized
        self.updateStatusChanged.emit()

    @Slot()
    def refreshUpdateStatus(self) -> None:
        if self._update_refresh_running:
            return
        self._update_refresh_running = True
        threading.Thread(target=self._update_status_worker, daemon=True, name="update-status").start()

    def _update_status_worker(self) -> None:
        try:
            result = {"operation": "status", "status": read_update_status()}
        except Exception as error:
            result = {"operation": "status", "error": str(error)}
        self._updateResultReady.emit(result)

    @Slot()
    def updateAction(self) -> None:
        operation = "apply" if str(self._update_status.get("state") or "") == "ready" else "check"
        if operation == "apply" and self._has_active_outputs():
            self._set_message("Stop all streams and recordings before installing the ready update")
            return
        if operation == "check":
            self._publish_update_status({**self._update_status, "state": "checking", "error": ""})
        threading.Thread(
            target=self._update_action_worker,
            args=(operation,),
            daemon=True,
            name=f"update-{operation}",
        ).start()

    def _update_action_worker(self, operation: str) -> None:
        try:
            if operation == "apply":
                request_update_apply(os.getpid())
            else:
                request_update_check()
            result = {"operation": operation, "status": read_update_status()}
        except Exception as error:
            result = {"operation": operation, "error": str(error)}
        self._updateResultReady.emit(result)

    @Slot(object)
    def _accept_update_result(self, result: object) -> None:
        self._update_refresh_running = False
        response = result if isinstance(result, dict) else {"error": "Invalid updater response"}
        error = str(response.get("error") or "").strip()
        if error:
            self._publish_update_status({**self._update_status, "state": "error", "error": error})
            return
        status = response.get("status")
        if isinstance(status, dict):
            self._publish_update_status(status)
        if response.get("operation") == "apply":
            self._set_message("Installing the ready update and restarting RebornBroadcaster…")
            self.requestExit()

    @Slot()
    def ensureCore(self) -> None:
        self._replacement_failed_version = ""
        if self._probe():
            self.refresh()
            return
        if self._starting_core:
            return
        self._set_starting_core(True)
        self._set_connected(False)
        self._set_compatible(False)
        self._set_message("Starting broadcast core and waiting for confirmation…")
        self._core_start_grace_until = time.monotonic() + 20.0
        self._core_start_attempt += 1
        attempt = self._core_start_attempt
        QTimer.singleShot(20_000, lambda: self._expire_core_start(attempt))
        threading.Thread(
            target=self._start_core_with_retries,
            args=(attempt,),
            daemon=True,
            name=f"core-startup-{attempt}",
        ).start()

    @Slot()
    def refresh(self) -> None:
        if self._starting_core:
            return
        self._run("get-state", quiet=True)

    @Slot()
    def loadSettings(self) -> None:
        self._run("get-settings", quiet=True)

    @Slot()
    def refreshAudioSources(self) -> None:
        self._run("list-audio-sources", quiet=True)

    @Slot()
    def goLive(self) -> None:
        self._run("go-live")

    @Slot()
    def startRadio(self) -> None:
        self._run("start-stream")

    @Slot()
    def stopRadio(self) -> None:
        self._run("stop-stream")

    @Slot()
    def startVideo(self) -> None:
        self._run("start-video")

    @Slot()
    def stopVideo(self) -> None:
        self._run("stop-video")

    @Slot()
    def stopLive(self) -> None:
        self._run("stop-live")

    @Slot()
    def startRecording(self) -> None:
        self._run("start-recording")

    @Slot()
    def stopRecording(self) -> None:
        self._run("stop-recording")

    @Slot()
    def startVideoRecording(self) -> None:
        self._run("start-video-recording")

    @Slot()
    def stopVideoRecording(self) -> None:
        self._run("stop-video-recording")

    @Slot()
    def detectObs(self) -> None:
        self._run("detect-obs")

    @Slot()
    def testObs(self) -> None:
        self._run("test-obs")

    @Slot(str)
    def updateNowPlaying(self, title: str) -> None:
        self._run("update-now-playing", {"nowPlaying": title})

    @Slot()
    def refreshListeners(self) -> None:
        self._run("refresh-listeners", quiet=True)

    @Slot()
    def requestExit(self) -> None:
        if self._busy:
            return
        self._set_busy(True)
        threading.Thread(target=self._stop_core_worker, args=(True,), daemon=True, name="core-exit").start()

    @Slot()
    def stopCore(self) -> None:
        if self._busy:
            return
        self._set_busy(True)
        threading.Thread(target=self._stop_core_worker, args=(False,), daemon=True, name="core-stop").start()

    @Slot(str)
    def saveSettings(self, settings_json: str) -> None:
        try:
            settings = json.loads(settings_json)
        except json.JSONDecodeError as error:
            self._set_message(f"Invalid settings: {error}")
            return
        self._run("save-settings", {"settings": settings})

    @Slot(str)
    def importConfig(self, file_url: str) -> None:
        self._run("import-config", {"filePath": self._local_path(file_url), "merge": True})

    @Slot(str, bool)
    def exportConfig(self, file_url: str, include_secrets: bool) -> None:
        self._run(
            "export-config",
            {"filePath": self._local_path(file_url), "includeSecrets": include_secrets},
        )

    @Slot(str, result=str)
    def localFilePath(self, file_url: str) -> str:
        return self._local_path(file_url)

    @Slot(str, str, int)
    def convertAudio(self, file_url: str, encoding: str, bitrate: int) -> None:
        if self._conversion_busy:
            return
        if self._has_active_outputs():
            self._conversion_message = "Stop live streams and recordings before converting a file."
            self.conversionChanged.emit()
            return
        source = Path(self._local_path(file_url)).expanduser()
        if not source.is_file():
            self._conversion_message = "Select an existing audio or video file first."
            self.conversionChanged.emit()
            return
        self._conversion_busy = True
        self._conversion_output = ""
        self._conversion_cancel_requested = False
        self._conversion_message = f"Converting {source.name} to {encoding.upper()}…"
        self.conversionChanged.emit()
        threading.Thread(
            target=self._convert_audio_worker,
            args=(source, encoding, bitrate),
            daemon=True,
            name="audio-converter",
        ).start()

    def _convert_audio_worker(self, source: Path, encoding: str, bitrate: int) -> None:
        try:
            ffmpeg = bundled_ffmpeg()
            if not ffmpeg:
                raise RuntimeError("FFmpeg was not found")
            output, codec, output_format = audio_conversion_plan(source, encoding, bitrate)
            if self._conversion_cancel_requested:
                self._conversionResultReady.emit({"cancelled": True})
                return
            process = subprocess.Popen(
                [
                    str(ffmpeg), "-hide_banner", "-nostdin", "-loglevel", "warning",
                    "-i", str(source), "-map", "0:a:0", "-vn", *codec,
                    "-map_metadata", "0", "-f", output_format, str(output),
                ],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                creationflags=(
                    getattr(subprocess, "CREATE_NO_WINDOW", 0)
                    | getattr(subprocess, "BELOW_NORMAL_PRIORITY_CLASS", 0)
                ),
            )
            self._conversion_process = process
            if self._conversion_cancel_requested:
                process.terminate()
            _stdout, stderr = process.communicate()
            if self._conversion_cancel_requested:
                output.unlink(missing_ok=True)
                self._conversionResultReady.emit({"cancelled": True})
                return
            if process.returncode != 0:
                output.unlink(missing_ok=True)
                details = (stderr or "").strip().splitlines()
                raise RuntimeError(details[-1] if details else f"FFmpeg exited with code {process.returncode}")
            self._conversionResultReady.emit({"output": str(output)})
        except Exception as error:
            self._conversionResultReady.emit({"error": str(error)})
        finally:
            self._conversion_process = None

    @Slot()
    def cancelConversion(self) -> None:
        process = self._conversion_process
        if not self._conversion_busy:
            return
        self._conversion_cancel_requested = True
        self._conversion_message = "Cancelling conversion…"
        self.conversionChanged.emit()
        if process is not None and process.poll() is None:
            process.terminate()

    @Slot()
    def openConversionFolder(self) -> None:
        if self._conversion_output:
            QDesktopServices.openUrl(QUrl.fromLocalFile(str(Path(self._conversion_output).parent)))

    @Slot(object)
    def _accept_conversion_result(self, result: object) -> None:
        response = result if isinstance(result, dict) else {"error": "Invalid conversion result"}
        self._conversion_busy = False
        if response.get("cancelled"):
            self._conversion_message = "Conversion cancelled."
        elif response.get("error"):
            self._conversion_message = f"Conversion failed: {response['error']}"
        else:
            self._conversion_output = str(response.get("output") or "")
            self._conversion_message = f"Converted file saved as {Path(self._conversion_output).name}"
        self.conversionChanged.emit()

    def _run(self, command: str, payload: dict[str, Any] | None = None, quiet: bool = False) -> None:
        if self._busy and not quiet:
            return
        if not quiet:
            self._set_busy(True)
        threading.Thread(
            target=self._worker,
            args=(command, payload or {}, quiet),
            daemon=True,
            name=f"core-{command}",
        ).start()

    def _worker(self, command: str, payload: dict[str, Any], quiet: bool) -> None:
        try:
            result = self._request(command, payload)
            result["_quiet"] = quiet
        except Exception as error:
            result = {"type": "error", "error": str(error), "_quiet": quiet}
        self._resultReady.emit(result)

    def _request(self, command: str, payload: dict[str, Any]) -> dict[str, Any]:
        request_id = str(uuid.uuid4())
        request = {
            "id": request_id,
            "type": command,
            "source": "RebornBroadcaster UI",
            "client": {"name": "RebornBroadcaster UI", "version": __version__},
            **payload,
        }
        with socket.create_connection((self.host, self.port), timeout=3) as connection:
            connection.settimeout(8)
            connection.sendall((json.dumps(request) + "\n").encode())
            buffer = b""
            while True:
                chunk = connection.recv(65536)
                if not chunk:
                    raise ConnectionError("Broadcast core closed the connection")
                buffer += chunk
                while b"\n" in buffer:
                    raw, buffer = buffer.split(b"\n", 1)
                    try:
                        response = json.loads(raw)
                    except json.JSONDecodeError:
                        continue
                    if response.get("id") == request_id:
                        return response

    @Slot(object)
    def _accept_result(self, result: object) -> None:
        response = result if isinstance(result, dict) else {"type": "error", "error": "Invalid core response"}
        was_connected = self._connected
        was_compatible = self._compatible
        was_starting = self._starting_core
        quiet = bool(response.pop("_quiet", False))
        core_stopped = bool(response.pop("_core_stopped", False))
        exit_after = bool(response.pop("_exit_after", False))
        if response.get("type") == "error" and self._consume_controller_exit_request():
            self._set_connected(False)
            self._set_compatible(False)
            self._set_busy(False)
            self._set_message("K-os Radio Broadcaster stopped the broadcast core")
            self.exitReady.emit()
            return
        if (
            response.get("type") == "error"
            and quiet
            and time.monotonic() < self._core_start_grace_until
            and self._is_connection_refused(str(response.get("error") or ""))
        ):
            return
        if core_stopped and response.get("type") != "error":
            state = response.get("state")
            if isinstance(state, dict):
                self._state_json = json.dumps(state)
                self.stateJsonChanged.emit()
            self._set_connected(False)
            self._set_compatible(False)
            self._set_message("Broadcast core stopped")
            self._set_busy(False)
            if exit_after:
                self.exitReady.emit()
            return
        self._set_connected(response.get("type") != "error" or "state" in response)
        state = response.get("state")
        if isinstance(state, dict):
            self._core_start_grace_until = 0.0
            self._set_starting_core(False)
            self._state_json = json.dumps(state)
            self.stateJsonChanged.emit()
            activity = state.get("lastCommand")
            if isinstance(activity, dict):
                sequence = int(activity.get("sequence") or 0)
                source = str(activity.get("source") or "API client")
                if sequence > self._last_activity_sequence:
                    self._last_activity_sequence = sequence
                    if source != "RebornBroadcaster UI":
                        command = str(activity.get("command") or "command").replace("-", " ").title()
                        status = str(activity.get("status") or "completed")
                        detail = str(activity.get("detail") or "").strip()
                        note = f"{command} from {source}: {status}"
                        self._set_message(f"{note} — {detail}" if detail else note)
            core_version = str(state.get("core", {}).get("version") or "unknown")
            compatible = core_version == __version__
            self._set_compatible(compatible)
            if compatible and (
                not was_connected
                or not was_compatible
                or was_starting
                or self._message in {"Connecting to broadcast core…", "Broadcast core stopped"}
            ):
                self._set_message(f"Broadcast core {core_version} connected")
            elif not compatible:
                if self._state_has_active_outputs(state):
                    self._set_message(
                        f"Core {core_version} is still running. Stop all outputs to finish updating to {__version__}."
                    )
                elif core_version != self._replacement_failed_version:
                    self._replace_stale_core(core_version)
            if self._settings_json == "{}":
                QTimer.singleShot(0, self.loadSettings)
        settings = response.get("settings")
        if isinstance(settings, dict):
            self._settings_json = json.dumps(settings)
            self.settingsJsonChanged.emit()
        audio_sources = response.get("audioSources")
        if isinstance(audio_sources, list):
            self._audio_sources_json = json.dumps([str(source) for source in audio_sources])
            self.audioSourcesJsonChanged.emit()
        if response.get("type") == "error":
            self._set_message(str(response.get("error") or "Core request failed"))
        elif not quiet:
            errors = response.get("errors")
            if errors:
                if isinstance(errors, dict):
                    details = "; ".join(f"{name}: {error}" for name, error in errors.items())
                elif isinstance(errors, list):
                    details = "; ".join(str(error) for error in errors)
                else:
                    details = str(errors)
                self._set_message(f"Some enabled outputs could not start — {details}")
            else:
                command = response.get("command", "Command")
                radio = response.get("state", {}).get("outputs", {}).get("radio", {})
                if command in {"start-stream", "start-radio", "go-live"} and radio.get("status") in {
                    "connecting", "recovering", "backing-off"
                }:
                    detail = str(radio.get("error") or radio.get("status")).strip()
                    self._set_message(f"Radio is {radio['status']} — {detail}")
                elif command in {"start-stream", "start-radio"} and radio.get("status") == "live":
                    self._set_message("Radio is live")
                else:
                    self._set_message(f"{command.replace('-', ' ').title()} completed")
        if not quiet:
            self._set_busy(False)

    @staticmethod
    def _discard_controller_exit_request() -> None:
        try:
            controller_exit_request_path().unlink(missing_ok=True)
        except OSError:
            pass

    @staticmethod
    def _consume_controller_exit_request() -> bool:
        request_path = controller_exit_request_path()
        try:
            request = json.loads(request_path.read_text(encoding="utf-8"))
            request_path.unlink(missing_ok=True)
            source = str(request.get("source") or "").lower()
            requested = str(request.get("requestedAt") or "")
            return "kosradio" in source.replace("-", "").replace(" ", "") and bool(requested)
        except (OSError, ValueError, json.JSONDecodeError):
            return False

    def _start_core_with_retries(self, attempt: int) -> None:
        try:
            for _ in range(3):
                if not self._probe():
                    self._start_core_process()
                for _ in range(20):
                    if self._probe():
                        self._resultReady.emit(self._request("get-state", {}) | {"_quiet": True})
                        return
                    time.sleep(0.25)
            self._resultReady.emit({"type": "error", "error": "The broadcast core did not start after three attempts", "_quiet": False})
        finally:
            self._coreStartupFinished.emit(attempt)

    @Slot(int)
    def _finish_core_start(self, attempt: int) -> None:
        if attempt != self._core_start_attempt:
            return
        self._set_starting_core(False)

    def _expire_core_start(self, attempt: int) -> None:
        if attempt != self._core_start_attempt or not self._starting_core:
            return
        if self._probe():
            self._set_message("Broadcast core responded; confirming its version and status…")
            self.refresh()
            QTimer.singleShot(3_000, lambda: self._expire_core_confirmation(attempt))
            return
        self._set_starting_core(False)
        self._set_connected(False)
        self._set_compatible(False)
        self._set_message("Broadcast core startup timed out. Select Start Core to retry.")

    def _expire_core_confirmation(self, attempt: int) -> None:
        if attempt != self._core_start_attempt or not self._starting_core:
            return
        self._set_starting_core(False)
        if self._probe():
            self._set_message(
                "Broadcast core is responding but status confirmation timed out. "
                "Select Start Core to retry the status check."
            )
        else:
            self._set_connected(False)
            self._set_compatible(False)
            self._set_message("Broadcast core stopped responding. Select Start Core to retry.")

    def _stop_core_worker(self, exit_after: bool) -> None:
        try:
            if self._probe():
                try:
                    response = self._request("stop-core", {})
                    if response.get("type") == "error":
                        raise RuntimeError(str(response.get("error") or "Core rejected stop-core"))
                except Exception:
                    try:
                        response = self._request("close-app", {})
                        if response.get("type") == "error":
                            raise RuntimeError(str(response.get("error") or "Core rejected close-app"))
                    except Exception:
                        self._force_stop_stale_listener()
                        response = {"type": "result", "ok": True, "shutdown": True}
                for _ in range(40):
                    if not self._probe():
                        break
                    time.sleep(0.25)
                else:
                    self._force_stop_stale_listener()
            else:
                response = {"type": "result", "ok": True, "shutdown": True}
            response.update({"_quiet": False, "_core_stopped": True, "_exit_after": exit_after})
        except Exception as error:
            response = {
                "type": "error",
                "error": f"Unable to stop the broadcast core: {error}",
                "_quiet": False,
                "_exit_after": False,
            }
        self._resultReady.emit(response)

    def _replace_stale_core(self, core_version: str) -> None:
        if self._replacing_core:
            return
        self._replacing_core = True
        self._set_message(f"Replacing idle core {core_version} with {__version__}…")
        threading.Thread(
            target=self._replace_stale_core_worker,
            daemon=True,
            name="core-version-replacement",
        ).start()

    def _replace_stale_core_worker(self) -> None:
        try:
            try:
                self._request("shutdown-core", {})
            except Exception:
                pass
            for _ in range(40):
                if not self._probe():
                    break
                time.sleep(0.25)
            else:
                self._force_stop_stale_listener()
                for _ in range(20):
                    if not self._probe():
                        break
                    time.sleep(0.25)
                else:
                    raise RuntimeError("The old broadcast core did not release port 8010")
            self._start_core_process()
            for _ in range(40):
                if self._probe():
                    response = self._request("get-state", {})
                    response["_quiet"] = True
                    self._replacement_failed_version = ""
                    self._resultReady.emit(response)
                    return
                time.sleep(0.25)
            raise RuntimeError("The updated broadcast core did not start")
        except Exception as error:
            try:
                state = json.loads(self._state_json)
                self._replacement_failed_version = str(state.get("core", {}).get("version") or "unknown")
            except json.JSONDecodeError:
                self._replacement_failed_version = "unknown"
            self._resultReady.emit(
                {
                    "type": "error",
                    "error": f"Unable to replace old core: {error}. Use Reconnect / start core to retry.",
                    "_quiet": False,
                }
            )
        finally:
            self._replacing_core = False

    def _has_active_outputs(self) -> bool:
        try:
            state = json.loads(self._state_json)
        except json.JSONDecodeError:
            return False
        return self._state_has_active_outputs(state)

    @staticmethod
    def _state_has_active_outputs(state: dict[str, Any]) -> bool:
        statuses = [
            state.get("outputs", {}).get("radio", {}).get("status"),
            state.get("outputs", {}).get("video", {}).get("status"),
            state.get("recording", {}).get("status"),
            state.get("videoRecording", {}).get("status"),
        ]
        return any(status in {"connecting", "live", "recording", "starting", "recovering", "backing-off"} for status in statuses)

    def _probe(self) -> bool:
        try:
            with socket.create_connection((self.host, self.port), timeout=0.25) as connection:
                connection.sendall(b"PING\n")
                return connection.recv(32).strip() == b"PONG"
        except OSError:
            return False

    @staticmethod
    def _is_connection_refused(message: str) -> bool:
        normalized = message.lower()
        return any(token in normalized for token in ("errno 111", "10061", "connection refused", "actively refused"))

    def _force_stop_stale_listener(self) -> None:
        if sys.platform != "win32":
            raise RuntimeError("Automatic forced core shutdown is currently available only on Windows")
        process_id = self._listener_process_id()
        if process_id is None:
            raise RuntimeError("Unable to identify the old core process")
        if process_id == os.getpid():
            raise RuntimeError("Refusing to stop the current dashboard process")
        executable = self._process_executable(process_id)
        command_line = self._process_command_line(process_id)
        executable_name = executable.name.lower() if executable else ""
        packaged_core = executable_name == "rebornbroadcaster.exe" and (
            "--core" in command_line.lower().split()
            or executable.resolve() != Path(sys.executable).resolve()
        )
        development_core = executable_name in {"python.exe", "pythonw.exe"} and bool(
            re.search(r"(?:^|\s)-m\s+reborn_broadcaster\.core_main(?:\s|$)", command_line, re.IGNORECASE)
        )
        if not packaged_core and not development_core:
            name = executable.name if executable else "unknown"
            raise RuntimeError(f"Port {self.port} belongs to an unverified process ({name}, PID {process_id})")
        result = subprocess.run(
            ["taskkill", "/PID", str(process_id), "/F"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=10,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            check=False,
        )
        if result.returncode != 0:
            detail = result.stderr.strip() or result.stdout.strip() or "taskkill failed"
            raise RuntimeError(f"Unable to stop verified old core process: {detail}")

    def _listener_process_id(self) -> int | None:
        result = subprocess.run(
            ["netstat", "-ano", "-p", "tcp"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=10,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            check=False,
        )
        if result.returncode != 0:
            return None
        expected_port = str(self.port)
        for line in result.stdout.splitlines():
            parts = line.split()
            if len(parts) < 5 or parts[0].upper() != "TCP" or parts[3].upper() != "LISTENING":
                continue
            if parts[1].rsplit(":", 1)[-1] == expected_port:
                try:
                    return int(parts[4])
                except ValueError:
                    return None
        return None

    @staticmethod
    def _process_executable(process_id: int) -> Path | None:
        process_query_limited_information = 0x1000
        handle = ctypes.windll.kernel32.OpenProcess(
            process_query_limited_information, False, process_id
        )
        if not handle:
            return None
        try:
            buffer = ctypes.create_unicode_buffer(32768)
            size = ctypes.c_ulong(len(buffer))
            if not ctypes.windll.kernel32.QueryFullProcessImageNameW(
                handle, 0, buffer, ctypes.byref(size)
            ):
                return None
            return Path(buffer.value)
        finally:
            ctypes.windll.kernel32.CloseHandle(handle)

    @staticmethod
    def _process_command_line(process_id: int) -> str:
        result = subprocess.run(
            [
                "powershell",
                "-NoProfile",
                "-Command",
                f"(Get-CimInstance Win32_Process -Filter \"ProcessId = {process_id}\").CommandLine",
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=10,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            check=False,
        )
        return result.stdout.strip() if result.returncode == 0 else ""

    @staticmethod
    def _start_core_process() -> None:
        if is_packaged():
            command = [str(packaged_executable()), "--core"]
        else:
            command = [sys.executable, "-m", "reborn_broadcaster.core_main"]
        subprocess.Popen(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            start_new_session=True,
        )

    def _set_connected(self, value: bool) -> None:
        if self._connected != value:
            self._connected = value
            self.connectedChanged.emit()

    def _set_compatible(self, value: bool) -> None:
        if self._compatible != value:
            self._compatible = value
            self.compatibleChanged.emit()

    def _set_starting_core(self, value: bool) -> None:
        if self._starting_core != value:
            self._starting_core = value
            self.startingCoreChanged.emit()

    def _set_busy(self, value: bool) -> None:
        if self._busy != value:
            self._busy = value
            self.busyChanged.emit()

    def _set_message(self, value: str) -> None:
        if self._message != value:
            self._message = value
            self.messageChanged.emit()

    @staticmethod
    def _local_path(value: str) -> str:
        url = QUrl(value)
        return url.toLocalFile() if url.isLocalFile() else value
