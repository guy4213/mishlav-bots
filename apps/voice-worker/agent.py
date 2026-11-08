"""Mishlav study-day bot — LiveKit voice worker. Provider C (Gemini Live) first; B later via VOICE_PROVIDER.

Run (from apps/voice-worker):
  uv run agent.py console   # talk to the bot through the PC microphone, no phone, no LiveKit number
  uv run agent.py dev       # connect to LiveKit Cloud and answer phone calls (inbound test)

Per call: reads the active test session from the tools server (`npm run session -- start ...`) to get the
scenario's first_name / interested_day_id, builds the Hebrew prompt + knowledge, and exposes the 5 tools,
each of which POSTs to the tools server. When the call ends, per-turn latency goes to /test/metrics.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

from mishlav_worker.context import (
    CallVars,
    build_instructions,
    find_repo_root,
    format_now_he,
    load_tool_definitions,
    scenario_context,
)
from mishlav_worker.latency import LatencyTracker
from mishlav_worker.tools import build_tools
from mishlav_worker.tools_client import ToolsClient

ROOT = find_repo_root(Path(__file__))
# utf-8-sig: tolerate a BOM from Windows editors. Worker .env first, then the repo-root .env (no override).
load_dotenv(Path(__file__).with_name(".env"), encoding="utf-8-sig")
load_dotenv(ROOT / ".env", encoding="utf-8-sig")

from google.genai import types  # noqa: E402  (after env is loaded)
from livekit.agents import (  # noqa: E402
    Agent,
    AgentServer,
    AgentSession,
    AgentStateChangedEvent,
    ConversationItemAddedEvent,
    JobContext,
    MetricsCollectedEvent,
    UserStateChangedEvent,
    cli,
    room_io,
)
from livekit.agents.metrics import RealtimeModelMetrics  # noqa: E402
from livekit.plugins import google  # noqa: E402

log = logging.getLogger("mishlav.worker")

VOICE_PROVIDER = os.environ.get("VOICE_PROVIDER", "gemini")
PROVIDER_CODE = {"gemini": "C", "soniox_eleven": "B"}
AGENT_NAME = os.environ.get("AGENT_NAME", "mishlav-c")
BOT_NAME = os.environ.get("BOT_NAME", "נועה")
DEFAULT_FIRST_NAME = os.environ.get("DEFAULT_FIRST_NAME", "דנה")
TOOLS_BASE_URL = os.environ.get("TOOLS_BASE_URL", "http://127.0.0.1:8787")
# Outbound calls start with the callee's "הלו"; inbound tests mimic that. If nobody speaks within this
# many seconds, the bot opens anyway (0 = open immediately).
OPEN_AFTER_SILENCE_S = float(os.environ.get("OPEN_AFTER_SILENCE_S", "4"))


def build_llm() -> google.realtime.RealtimeModel:
    if VOICE_PROVIDER != "gemini":
        raise SystemExit(f"VOICE_PROVIDER={VOICE_PROVIDER!r} is not built yet (provider B comes after C)")
    behavior = os.environ.get("GEMINI_TOOL_BEHAVIOR", "blocking").lower()
    kwargs: dict = {}
    if lang := os.environ.get("GEMINI_LANGUAGE"):
        kwargs["language"] = lang
    return google.realtime.RealtimeModel(
        model=os.environ.get("GEMINI_MODEL", "gemini-3.8-live"),
        voice=os.environ.get("GEMINI_VOICE", "Kore"),
        temperature=float(os.environ.get("GEMINI_TEMPERATURE", "0.6")),
        tool_behavior=types.Behavior.NON_BLOCKING if behavior == "non_blocking" else types.Behavior.BLOCKING,
        **kwargs,
    )


def transcript_writer(call_id: str):
    """logs/transcripts/<call_id>.jsonl — for the manual 'did it switch language?' check."""
    path = ROOT / "logs" / "transcripts" / f"{call_id}.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)

    def write(role: str, text: str) -> None:
        line = {"ts": datetime.now(timezone.utc).isoformat(), "role": role, "text": text}
        with path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(line, ensure_ascii=False) + "\n")

    return path, write


server = AgentServer(host="127.0.0.1")


@server.rtc_session(agent_name=AGENT_NAME)
async def entrypoint(ctx: JobContext) -> None:
    provider = PROVIDER_CODE.get(VOICE_PROVIDER, "C")
    call_id = ctx.room.name
    secret = os.environ.get("TOOLS_SECRET", "")
    client = ToolsClient(TOOLS_BASE_URL, secret, provider=provider, call_id=call_id)

    test_session = await client.current_session()
    if test_session is None:
        log.warning("no active test session — tool calls will not be tagged with a scenario")
    elif test_session.get("provider") != provider:
        log.warning("active test session is for provider %s, this worker is %s", test_session.get("provider"), provider)
    scenario_id = (test_session or {}).get("scenario")
    sc = scenario_context(ROOT, scenario_id)
    call = CallVars(
        first_name=sc.get("first_name", DEFAULT_FIRST_NAME),
        bot_name=BOT_NAME,
        interested_day_id=sc.get("interested_day_id", ""),
        current_datetime=format_now_he(datetime.now(timezone.utc)),
    )
    log.info("call %s: provider %s, scenario %s, first_name %s", call_id, provider, scenario_id, call.first_name)

    transcript_path, write_line = transcript_writer(call_id)
    tracker = LatencyTracker()
    started = time.monotonic()
    user_spoke = asyncio.Event()

    agent = Agent(
        instructions=build_instructions(ROOT, call),
        tools=build_tools(load_tool_definitions(ROOT), client),
    )
    session = AgentSession(llm=build_llm())

    @session.on("user_state_changed")
    def _user_state(ev: UserStateChangedEvent) -> None:
        if ev.new_state == "speaking":
            user_spoke.set()
        tracker.user_state(ev.new_state)

    @session.on("agent_state_changed")
    def _agent_state(ev: AgentStateChangedEvent) -> None:
        tracker.agent_state(ev.new_state)

    @session.on("metrics_collected")
    def _metrics(ev: MetricsCollectedEvent) -> None:
        m = ev.metrics
        if isinstance(m, RealtimeModelMetrics) and m.ttft >= 0:
            tracker.provider_time(m.ttft * 1000)

    @session.on("conversation_item_added")
    def _item(ev: ConversationItemAddedEvent) -> None:
        role = getattr(ev.item, "role", None)
        text = getattr(ev.item, "text_content", None)
        if role in ("user", "assistant") and text:
            write_line(role, text)

    async def report() -> None:
        await client.post_metrics(
            {
                # The session id read at call start: the tester may end the session before this posts.
                **({"session_id": test_session["session_id"]} if test_session else {}),
                "call_id": call_id,
                "turns": tracker.turns,
                "duration_sec": round(time.monotonic() - started, 1),
                "source": f"livekit-voice-worker/{VOICE_PROVIDER}",
            }
        )
        await client.aclose()
        log.info("call %s done: %d turns, transcript %s", call_id, len(tracker.turns), transcript_path)

    ctx.add_shutdown_callback(report)

    await session.start(
        agent=agent,
        room=ctx.room,
        # Deleting the room on close drops the phone line (used by end_call).
        room_options=room_io.RoomOptions(delete_room_on_close=True),
    )

    # Wait for the callee's "הלו" (the model then opens per the prompt); open anyway after silence.
    if OPEN_AFTER_SILENCE_S > 0:
        try:
            await asyncio.wait_for(user_spoke.wait(), timeout=OPEN_AFTER_SILENCE_S)
            return
        except asyncio.TimeoutError:
            pass
    session.generate_reply(instructions="פתחי את השיחה עכשיו במשפט הפתיחה מהשלב הראשון בזרימת השיחה.")


if __name__ == "__main__":
    cli.run_app(server)
