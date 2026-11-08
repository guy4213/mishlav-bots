"""Side-channel VAD on the caller's audio — for measurement only.

Gemini Live does its own turn detection server-side and the plugin reports caller speech only on a
barge-in, so the session's `user_state` never changes in a normal turn. That left latency empty and
the "wait for the callee's hello" timer blind. This listens to the caller's audio track with a local
Silero VAD and reports start / end of speech. It is NOT given to the AgentSession, so it doesn't
change how the bot takes turns or gets interrupted (a fair test of the provider's own behaviour).
"""

from __future__ import annotations

import asyncio
import logging
from typing import Callable

from livekit import rtc
from livekit.agents import vad as lk_vad

log = logging.getLogger("mishlav.speech")


class SpeechMonitor:
    def __init__(
        self,
        vad: lk_vad.VAD,
        on_start: Callable[[], None],
        on_end: Callable[[float], None],
    ) -> None:
        """`on_end(silence_s)`: speech ended `silence_s` seconds ago (the VAD waits that long to be sure)."""
        self._vad = vad
        self._on_start = on_start
        self._on_end = on_end
        self._tasks: dict[str, asyncio.Task[None]] = {}

    def attach(self, room: rtc.Room) -> None:
        for p in room.remote_participants.values():
            if p.kind == rtc.ParticipantKind.PARTICIPANT_KIND_AGENT:
                continue
            for pub in p.track_publications.values():
                if pub.track is not None and pub.kind == rtc.TrackKind.KIND_AUDIO:
                    self._watch(pub.track)

        @room.on("track_subscribed")
        def _subscribed(track: rtc.Track, _pub: rtc.RemoteTrackPublication, p: rtc.RemoteParticipant) -> None:
            if track.kind == rtc.TrackKind.KIND_AUDIO and p.kind != rtc.ParticipantKind.PARTICIPANT_KIND_AGENT:
                self._watch(track)

    def _watch(self, track: rtc.Track) -> None:
        if track.sid in self._tasks:
            return
        self._tasks[track.sid] = asyncio.create_task(self._run(track))

    async def _run(self, track: rtc.Track) -> None:
        audio = rtc.AudioStream(track, sample_rate=16000, num_channels=1)
        stream = self._vad.stream()

        async def pump() -> None:
            async for ev in audio:
                stream.push_frame(ev.frame)

        pump_task = asyncio.create_task(pump())
        try:
            async for ev in stream:
                if ev.type == lk_vad.VADEventType.START_OF_SPEECH:
                    self._on_start()
                elif ev.type == lk_vad.VADEventType.END_OF_SPEECH:
                    self._on_end(ev.silence_duration)
        except asyncio.CancelledError:
            raise
        except Exception:  # measurement must never break the call
            log.exception("speech monitor stopped")
        finally:
            pump_task.cancel()
            await stream.aclose()
            await audio.aclose()

    async def aclose(self) -> None:
        for t in self._tasks.values():
            t.cancel()
        await asyncio.gather(*self._tasks.values(), return_exceptions=True)
        self._tasks.clear()
