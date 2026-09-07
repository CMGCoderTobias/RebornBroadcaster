from __future__ import annotations

import argparse
import asyncio
import signal

from .api_server import CoreApiServer
from .service import BroadcastService


async def run(host: str = "127.0.0.1", port: int = 8010) -> None:
    service = BroadcastService()
    server = CoreApiServer(service, host=host, port=port)
    loop = asyncio.get_running_loop()
    for signal_name in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(signal_name, server.shutdown_requested.set)
        except (NotImplementedError, RuntimeError):
            pass
    await server.start()
    print(f"RebornBroadcaster core listening on {host}:{port}", flush=True)
    try:
        await server.shutdown_requested.wait()
    finally:
        await service.shutdown()
        await server.close()


def main() -> int:
    parser = argparse.ArgumentParser(description="RebornBroadcaster headless broadcast core")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8010)
    arguments = parser.parse_args()
    try:
        asyncio.run(run(arguments.host, arguments.port))
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
