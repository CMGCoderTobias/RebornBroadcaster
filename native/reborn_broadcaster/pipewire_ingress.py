from __future__ import annotations

import json
import shutil
import subprocess
import sys
import threading


class PipeWireIngress:
    sink_name = "reborn.broadcaster_input"
    source_name = f"{sink_name}.monitor"

    def __init__(self) -> None:
        self._module_id = ""
        self._lock = threading.Lock()

    @property
    def supported(self) -> bool:
        return sys.platform.startswith("linux") and bool(shutil.which("pactl"))

    def ensure(self) -> tuple[str, str]:
        if not self.supported:
            return "", ""
        with self._lock:
            if self._sink_exists():
                self._module_id = self._module_id or self._find_module_id()
                return self.sink_name, self.source_name
            result = subprocess.run(
                [
                    shutil.which("pactl") or "pactl",
                    "load-module",
                    "module-null-sink",
                    f"sink_name={self.sink_name}",
                    "sink_properties=device.description=RebornBroadcaster_Input",
                    "rate=48000",
                    "channels=2",
                ],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=8,
                check=True,
            )
            self._module_id = result.stdout.strip()
            if not self._module_id or not self._sink_exists():
                raise RuntimeError("PipeWire did not create the RebornBroadcaster input")
            return self.sink_name, self.source_name

    def close(self) -> None:
        with self._lock:
            module_id = self._module_id
            self._module_id = ""
        if module_id and self.supported:
            subprocess.run(
                [shutil.which("pactl") or "pactl", "unload-module", module_id],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=8,
                check=False,
            )

    def _sink_exists(self) -> bool:
        result = subprocess.run(
            [shutil.which("pactl") or "pactl", "--format=json", "list", "sinks"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=8,
            check=True,
        )
        payload = json.loads(result.stdout)
        return any(
            isinstance(item, dict) and str(item.get("name") or "") == self.sink_name
            for item in payload if isinstance(payload, list)
        )

    def _find_module_id(self) -> str:
        result = subprocess.run(
            [shutil.which("pactl") or "pactl", "list", "short", "modules"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=8,
            check=True,
        )
        marker = f"sink_name={self.sink_name}"
        for line in result.stdout.splitlines():
            fields = line.split("\t", 3)
            if len(fields) >= 3 and marker in fields[2]:
                return fields[0]
        return ""
