"""Per-turn response time: end of customer speech -> first bot audio (spec 3.5 criterion 4).

Driven by the session's user/agent state events, so it works the same for a realtime model (C) and a
pipeline (B). `provider_ms` is the model's own time-to-first-token when the plugin reports it.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any


@dataclass
class LatencyTracker:
    clock: Any = time.monotonic
    turns: list[dict[str, float | int]] = field(default_factory=list)
    _user_stopped_at: float | None = None
    _pending_provider_ms: float | None = None

    def user_state(self, new_state: str) -> None:
        if new_state == "speaking":
            self._user_stopped_at = None
        elif new_state == "listening" and self._user_stopped_at is None:
            self._user_stopped_at = self.clock()

    def provider_time(self, ms: float) -> None:
        if ms >= 0:
            self._pending_provider_ms = ms

    def agent_state(self, new_state: str) -> None:
        if new_state != "speaking" or self._user_stopped_at is None:
            return
        turn: dict[str, float | int] = {
            "turn": len(self.turns) + 1,
            "latency_ms": round((self.clock() - self._user_stopped_at) * 1000),
        }
        if self._pending_provider_ms is not None:
            turn["provider_ms"] = round(self._pending_provider_ms)
        self.turns.append(turn)
        self._user_stopped_at = None
        self._pending_provider_ms = None
