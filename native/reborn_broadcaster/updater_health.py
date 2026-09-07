from __future__ import annotations

import json
import os
import subprocess
import threading
from pathlib import Path

from . import __version__


APP_ID = "rebornbroadcaster"


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
    if not requested:
        return None
    root = _agent_root()
    executable = Path(requested).resolve()
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
