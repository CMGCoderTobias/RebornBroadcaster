from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import shutil
import subprocess
import uuid
from pathlib import Path
from typing import Any


class ObsError(RuntimeError):
    pass


def find_obs(configured_path: str = "") -> Path | None:
    candidates: list[Path] = []
    if configured_path:
        candidates.append(Path(configured_path).expanduser())
    for environment_name in ("ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"):
        root = os.environ.get(environment_name)
        if root:
            candidates.extend(
                [
                    Path(root) / "obs-studio" / "bin" / "64bit" / "obs64.exe",
                    Path(root) / "OBS Studio" / "bin" / "64bit" / "obs64.exe",
                ]
            )
    located = shutil.which("obs64.exe") or shutil.which("obs")
    if located:
        candidates.append(Path(located))
    return next((candidate.resolve() for candidate in candidates if candidate.is_file()), None)


class ObsController:
    def __init__(self) -> None:
        self._socket: Any = None
        self._lock = asyncio.Lock()

    async def connect(self, settings: dict[str, Any], launch_if_needed: bool = False) -> None:
        if self._socket is not None:
            return
        try:
            await self._open(settings)
            return
        except Exception as first_error:
            if not launch_if_needed:
                raise ObsError(f"OBS is not reachable: {first_error}") from first_error
        executable = find_obs(str(settings.get("obsExePath", "")))
        if not executable:
            raise ObsError("OBS Studio is not installed or its executable was not found")
        subprocess.Popen(
            [str(executable)],
            cwd=str(executable.parent),
            creationflags=getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0),
        )
        last_error: Exception | None = None
        for _ in range(20):
            await asyncio.sleep(0.5)
            try:
                await self._open(settings)
                return
            except Exception as error:
                last_error = error
        raise ObsError(f"OBS started but its WebSocket server is not reachable: {last_error}")

    async def _open(self, settings: dict[str, Any]) -> None:
        try:
            import websockets
        except ImportError as error:
            raise ObsError("The websockets package is required for OBS control") from error
        host = str(settings.get("obsHost") or "127.0.0.1")
        port = int(settings.get("obsPort") or 4455)
        socket = await asyncio.wait_for(websockets.connect(f"ws://{host}:{port}"), timeout=3)
        try:
            hello = json.loads(await asyncio.wait_for(socket.recv(), timeout=3))
            if hello.get("op") != 0:
                raise ObsError("OBS sent an invalid WebSocket greeting")
            identify: dict[str, Any] = {"rpcVersion": 1, "eventSubscriptions": 0}
            authentication = hello.get("d", {}).get("authentication")
            if authentication:
                password = str(settings.get("obsPassword") or "")
                if not password:
                    raise ObsError("OBS WebSocket requires a password")
                identify["authentication"] = self._authentication(password, authentication)
            await socket.send(json.dumps({"op": 1, "d": identify}))
            identified = json.loads(await asyncio.wait_for(socket.recv(), timeout=3))
            if identified.get("op") != 2:
                raise ObsError("OBS WebSocket authentication failed")
            self._socket = socket
        except Exception:
            await socket.close()
            raise

    @staticmethod
    def _authentication(password: str, authentication: dict[str, Any]) -> str:
        secret = base64.b64encode(
            hashlib.sha256((password + authentication["salt"]).encode()).digest()
        ).decode()
        return base64.b64encode(
            hashlib.sha256((secret + authentication["challenge"]).encode()).digest()
        ).decode()

    async def request(self, request_type: str, request_data: dict[str, Any] | None = None) -> dict[str, Any]:
        async with self._lock:
            if self._socket is None:
                raise ObsError("OBS is not connected")
            request_id = str(uuid.uuid4())
            await self._socket.send(
                json.dumps(
                    {
                        "op": 6,
                        "d": {
                            "requestType": request_type,
                            "requestId": request_id,
                            "requestData": request_data or {},
                        },
                    }
                )
            )
            while True:
                message = json.loads(await asyncio.wait_for(self._socket.recv(), timeout=5))
                if message.get("op") != 7 or message.get("d", {}).get("requestId") != request_id:
                    continue
                response = message["d"]
                status = response.get("requestStatus", {})
                if not status.get("result"):
                    raise ObsError(status.get("comment") or f"OBS rejected {request_type}")
                return response.get("responseData", {})

    async def stream_status(self) -> dict[str, Any]:
        return await self.request("GetStreamStatus")

    async def start_stream(self) -> None:
        status = await self.stream_status()
        if not status.get("outputActive"):
            await self.request("StartStream")

    async def stop_stream(self) -> None:
        status = await self.stream_status()
        if status.get("outputActive"):
            await self.request("StopStream")

    async def record_status(self) -> dict[str, Any]:
        return await self.request("GetRecordStatus")

    async def start_recording(self) -> None:
        status = await self.record_status()
        if not status.get("outputActive"):
            await self.request("StartRecord")

    async def stop_recording(self) -> None:
        status = await self.record_status()
        if status.get("outputActive"):
            await self.request("StopRecord")

    async def close(self) -> None:
        socket, self._socket = self._socket, None
        if socket is not None:
            await socket.close()
