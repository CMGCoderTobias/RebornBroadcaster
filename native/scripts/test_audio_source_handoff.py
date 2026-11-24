from __future__ import annotations

import asyncio
import tempfile
from pathlib import Path

from reborn_broadcaster import service as service_module
from reborn_broadcaster.service import BroadcastService
from reborn_broadcaster.settings import SettingsStore


async def main() -> None:
    with tempfile.TemporaryDirectory() as directory:
        store = SettingsStore(Path(directory) / "settings.json")
        store.save(
            {
                "audioSourceId": "standalone-source",
                "audioSourceName": "standalone-source",
            },
            merge=True,
        )
        service_module.list_audio_sources = lambda: ["standalone-source", "kos.stream.monitor"]
        service_module.voicemeeter_source_for_route = (
            lambda route, sources: "kos.stream.monitor" if route == "B2" else sources[0]
        )
        service = BroadcastService(store)
        selected = await service.execute(
            "select-audio-source",
            {"route": "B2", "source": "KosRadioBroadcaster"},
        )
        assert selected["audioSource"] == "kos.stream.monitor"
        assert service.settings["audioSourceId"] == "standalone-source"
        assert service.snapshot()["effectiveAudioSource"] == "kos.stream.monitor"
        await service.execute(
            "release-audio-source",
            {"source": "KosRadioBroadcaster"},
        )
        assert service.snapshot()["effectiveAudioSource"] == "standalone-source"
        assert store.load()["audioSourceId"] == "standalone-source"


if __name__ == "__main__":
    asyncio.run(main())
