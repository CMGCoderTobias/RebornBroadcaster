from __future__ import annotations

import json
import os
import subprocess
import threading
from pathlib import Path

from . import __version__


APP_ID = "rebornbroadcaster"
_status_file: Path | None = None


def _agent_root() -> Path:
    configured = os.environ.get("REBORN_UPDATE_AGENT_HOME")
    if configured:
        return Path(configured).expanduser().resolve()
    local_app_data = os.environ.get("LOCALAPPDATA")
    if not local_app_data:
        raise RuntimeError("LOCALAPPDATA is unavailable")
    return (Path(local_app_data) / "Reborn Entertainment" / "UpdateAgent").resolve()


def _trusted_agent() -> Path | None:
    requested = os.environ.get("REBORN_UPDATE_AGENT_EXE")
    root = _agent_root()
    if requested:
        executable = Path(requested).resolve()
    else:
        try:
            active = json.loads((root / "agent-active.json").read_text(encoding="utf-8"))
            executable = (Path(str(active["directory"])) / str(active["executable"])).resolve()
        except (OSError, KeyError, ValueError, json.JSONDecodeError):
            return None
    try:
        executable.relative_to(root)
    except ValueError:
        return None
    return executable if executable.is_file() else None


def report_candidate_health() -> bool:
    if os.environ.get("REBORN_APP_ID") != APP_ID:
        return False
    if os.environ.get("REBORN_APP_VERSION") != __version__:
        return False
    executable = _trusted_agent()
    if executable is None:
        return False

    def worker() -> None:
        result = subprocess.run(
            [str(executable), "health", "--app", APP_ID, "--version", __version__],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=30,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            check=False,
        )
        if result.returncode != 0:
            detail = result.stderr.strip() or result.stdout.strip()
            raise RuntimeError(f"Update health receipt failed: {detail}")
        if result.stdout.strip():
            response = json.loads(result.stdout)
            if response.get("ok") is not True:
                raise RuntimeError("Update agent rejected the health receipt")

    threading.Thread(target=worker, daemon=True, name="update-health").start()
    return True


def launched_version() -> str:
    if os.environ.get("REBORN_APP_ID") == APP_ID:
        return str(os.environ.get("REBORN_APP_VERSION") or __version__)
    return __version__


def _run_agent(executable: Path, arguments: list[str], timeout: int = 30) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [str(executable), *arguments],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=timeout,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        check=False,
    )


def _read_status_file() -> dict | None:
    global _status_file
    configured = os.environ.get("REBORN_UPDATE_STATUS_FILE")
    if configured:
        _status_file = Path(configured).expanduser().resolve()
    if _status_file is None or not _status_file.is_file():
        return None
    try:
        status = json.loads(_status_file.read_text(encoding="utf-8"))
        return status if isinstance(status, dict) else None
    except (OSError, json.JSONDecodeError):
        return None


def _normalize_status(status: dict) -> dict:
    state = str(status.get("state") or status.get("updateState") or "idle")
    return {**status, "state": state, "launchedVersion": launched_version()}


def read_update_status() -> dict:
    global _status_file
    status = _read_status_file()
    if status is None:
        executable = _trusted_agent()
        if executable is None:
            return _normalize_status({"state": "unavailable", "error": "Reborn Update Agent is not installed"})
        result = _run_agent(executable, ["status", "--app", APP_ID])
        if result.returncode != 0:
            return _normalize_status({"state": "error", "error": result.stderr.strip() or result.stdout.strip() or "Update status unavailable"})
        try:
            status = json.loads(result.stdout or "{}")
        except json.JSONDecodeError:
            return _normalize_status({"state": "error", "error": "Update Agent returned invalid status"})
        status_path = status.get("statusFile") if isinstance(status, dict) else None
        if status_path:
            _status_file = Path(str(status_path)).expanduser().resolve()
    if not isinstance(status, dict):
        status = {"state": "error", "error": "Update status unavailable"}
    return _normalize_status(status)


def request_update_check() -> dict:
    executable = _trusted_agent()
    if executable is None:
        raise RuntimeError("Reborn Update Agent is not installed")
    result = _run_agent(executable, ["request-check", "--app", APP_ID])
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip() or "Update check could not be started")
    return json.loads(result.stdout) if result.stdout.strip() else {"ok": True}


def request_update_apply(process_id: int) -> dict:
    executable = _trusted_agent()
    if executable is None:
        raise RuntimeError("Reborn Update Agent is not installed")
    result = _run_agent(executable, ["request-apply", "--app", APP_ID, "--wait-pid", str(process_id)])
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip() or "Update installation could not be started")
    return json.loads(result.stdout) if result.stdout.strip() else {"ok": True}


def check_for_updates_in_background() -> bool:
    executable = _trusted_agent()
    if executable is None:
        return False

    def worker() -> None:
        try:
            request_update_check()
        except (OSError, RuntimeError, subprocess.SubprocessError, json.JSONDecodeError):
            return

    threading.Thread(target=worker, daemon=True, name="update-check").start()
    return True
