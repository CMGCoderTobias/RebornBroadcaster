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

from . import __version__
from .paths import controller_exit_request_path, is_packaged, packaged_executable
from .updater_health import launched_version, read_update_status, request_update_apply, request_update_check


class CoreBridge(QObject):
    connectedChanged = Signal()
    compatibleChanged = Signal()
    busyChanged = Signal()
    stateJsonChanged = Signal()
    settingsJsonChanged = Signal()
    messageChanged = Signal()
    updateStatusChanged = Signal()
    exitReady = Signal()
    _resultReady = Signal(object)
    _updateResultReady = Signal(object)

    def __init__(self, host: str = "127.0.0.1", port: int = 8010, auto_start: bool = True) -> None:
        super().__init__()
        self.host = host
        self.port = port
        self._connected = False
        self._compatible = False
        self._starting_core = False
        self._replacing_core = False
        self._replacement_failed_version = ""
        self._busy = False
        self._state_json = "{}"
        self._settings_json = "{}"
        self._message = "Connecting to broadcast core…"
        self._update_status = {
            "state": "idle",
            "launchedVersion": launched_version(),
            "currentVersion": launched_version(),
            "latestVersion": "",
        }
        self._update_status_json = json.dumps(self._update_status)
        self._update_refresh_running = False
        self._last_activity_sequence = 0
        self._discard_controller_exit_request()
        self._resultReady.connect(self._accept_result)
        self._updateResultReady.connect(self._accept_update_result)
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

    @Property(bool, notify=busyChanged)
    def busy(self) -> bool:
        return self._busy

    @Property(str, notify=stateJsonChanged)
    def stateJson(self) -> str:
        return self._state_json

    @Property(str, notify=settingsJsonChanged)
    def settingsJson(self) -> str:
        return self._settings_json

    @Property(str, notify=messageChanged)
    def message(self) -> str:
        return self._message

    @Property(str, notify=updateStatusChanged)
    def updateStatusJson(self) -> str:
        return self._update_status_json

    @Property(bool, notify=stateJsonChanged)
    def activeOutputs(self) -> bool:
        return self._has_active_outputs()

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
        self._starting_core = True
        threading.Thread(target=self._start_core_with_retries, daemon=True, name="core-startup").start()

    @Slot()
    def refresh(self) -> None:
        self._run("get-state", quiet=True)

    @Slot()
    def loadSettings(self) -> None:
        self._run("get-settings", quiet=True)

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
            if not compatible:
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

    def _start_core_with_retries(self) -> None:
        try:
            for _ in range(3):
                if not self._probe():
                    self._start_core_process()
                for _ in range(20):
                    if self._probe():
                        self._resultReady.emit(self._request("get-state", {}) | {"_quiet": True})
                        return
                    time.sleep(0.25)
            self._resultReady.emit({"type": "error", "error": "The broadcast core did not start after three attempts", "_quiet": True})
        finally:
            self._starting_core = False

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
