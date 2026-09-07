from __future__ import annotations

import asyncio
import codecs
import json
from contextlib import suppress
from typing import Any

from .service import BroadcastService


class CoreApiServer:
    READ_ONLY_COMMANDS = {"get-state", "request-state", "status", "get-settings", "update-status"}

    def __init__(self, service: BroadcastService, host: str = "127.0.0.1", port: int = 8010) -> None:
        self.service = service
        self.host = host
        self.port = port
        self.server: asyncio.Server | None = None
        self.clients: set[asyncio.StreamWriter] = set()
        self.shutdown_requested = asyncio.Event()
        self.service.subscribe(self._state_changed)

    async def start(self) -> None:
        self.server = await asyncio.start_server(self._client_connected, self.host, self.port)
        self.service.start_background_tasks()

    async def serve_forever(self) -> None:
        if not self.server:
            await self.start()
        assert self.server is not None
        async with self.server:
            await self.server.serve_forever()

    async def close(self) -> None:
        self.service.unsubscribe(self._state_changed)
        if self.server:
            self.server.close()
            await self.server.wait_closed()
        for writer in tuple(self.clients):
            writer.close()
            with suppress(Exception):
                await writer.wait_closed()

    async def _client_connected(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        self.clients.add(writer)
        encoding = "utf-8"
        try:
            first = True
            while not reader.at_eof():
                raw = await reader.readline()
                if not raw:
                    break
                ascii_line = raw.decode("ascii", errors="ignore").strip()
                if first and ascii_line.upper().startswith("ENCODING:"):
                    requested = ascii_line.split(":", 1)[1].strip()
                    try:
                        encoding = codecs.lookup(requested).name
                        await self._write(writer, f"Server encoding set to: {encoding}", "ascii")
                    except LookupError:
                        await self._write(writer, "Unsupported encoding; using utf-8", "ascii")
                    first = False
                    continue
                first = False
                line = raw.decode(encoding, errors="replace").strip()
                if line:
                    await self._handle(line, writer, encoding)
        except (ConnectionError, asyncio.CancelledError):
            pass
        finally:
            self.clients.discard(writer)
            writer.close()
            with suppress(Exception):
                await writer.wait_closed()

    async def _handle(self, line: str, writer: asyncio.StreamWriter, encoding: str) -> None:
        if line == "PING":
            await self._write(writer, "PONG", encoding)
            return
        if line.startswith("{"):
            await self._handle_json(line, writer, encoding)
            return
        command, payload = self._legacy_command(line)
        try:
            result = await self.service.execute(command, payload)
            if command == "status":
                state = result["state"]
                radio = state["outputs"]["radio"]["status"]
                recording = state["recording"]["status"]
                response = f"Stream: {'ON' if radio == 'live' else 'OFF'} | Recording: {'ON' if recording == 'recording' else 'OFF'}"
            else:
                response = json.dumps({"type": "result", "command": command, **result}, separators=(",", ":"))
            await self._write(writer, response, encoding)
            if result.get("shutdown"):
                self.shutdown_requested.set()
        except Exception as error:
            await self._write(writer, json.dumps({"type": "error", "command": command, "error": str(error)}), encoding)

    async def _handle_json(self, line: str, writer: asyncio.StreamWriter, encoding: str) -> None:
        request_id: Any = None
        command = ""
        source = "API client"
        try:
            message = json.loads(line)
            if not isinstance(message, dict):
                raise ValueError("JSON request must be an object")
            request_id = message.get("id")
            command = str(message.get("type") or message.get("command") or "")
            if not command:
                raise ValueError("command required")
            client = message.get("client") if isinstance(message.get("client"), dict) else {}
            source = str(message.get("source") or client.get("name") or "API client").strip()
            result = await self.service.execute(command, message)
            if command.strip().lower() not in self.READ_ONLY_COMMANDS:
                activity = self.service.record_command_activity(command, source, "completed")
                result["activity"] = activity
                if isinstance(result.get("state"), dict):
                    result["state"] = self.service.snapshot()
            response = {"type": "result", "id": request_id, "command": command, **result}
        except Exception as error:
            response = {"type": "error", "id": request_id, "command": command, "error": str(error)}
            if command and command.strip().lower() not in self.READ_ONLY_COMMANDS:
                response["activity"] = self.service.record_command_activity(
                    command, source, "failed", str(error)
                )
        await self._write(writer, json.dumps(response, separators=(",", ":")), encoding)
        if response.get("shutdown"):
            self.shutdown_requested.set()

    @staticmethod
    def _legacy_command(line: str) -> tuple[str, dict[str, Any]]:
        if line.startswith("save-settings:"):
            raw = line.split(":", 1)[1].strip()
            return "save-settings", {"settings": json.loads(raw)}
        if line.startswith("update-now-playing:"):
            return "update-now-playing", {"nowPlaying": line.split(":", 1)[1].strip()}
        aliases = {"close-app": "stop-core", "open-app": "get-state"}
        return aliases.get(line, line), {}

    @staticmethod
    async def _write(writer: asyncio.StreamWriter, line: str, encoding: str = "utf-8") -> None:
        writer.write((line + "\n").encode(encoding, errors="replace"))
        await writer.drain()

    def _state_changed(self, state: dict[str, Any]) -> None:
        if not self.clients:
            return
        asyncio.create_task(self._broadcast(state))

    async def _broadcast(self, state: dict[str, Any]) -> None:
        payload = json.dumps({"type": "state", "state": state}, separators=(",", ":"))
        for writer in tuple(self.clients):
            try:
                await self._write(writer, payload)
            except (ConnectionError, RuntimeError):
                self.clients.discard(writer)
