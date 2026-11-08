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
from mishlav_worker.speech_monitor import SpeechMonitor
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
    JobProcess,
    MetricsCollectedEvent,
    cli,
    room_io,
)
from livekit.agents.metrics import RealtimeModelMetrics  # noqa: E402
from livekit.plugins import google, silero  # noqa: E402

log = logging.getLogger("mishlav.worker")

VOICE_PROVIDER = os.environ.get("VOICE_PROVIDER", "gemini")
PROVIDER_CODE = {"gemini": "C", "soniox_eleven": "B"}
AGENT_NAME = os.environ.get("AGENT_NAME", "mishlav-b" if VOICE_PROVIDER == "soniox_eleven" else "mishlav-c")
BOT_NAME = os.environ.get("BOT_NAME", "נועה")
DEFAULT_FIRST_NAME = os.environ.get("DEFAULT_FIRST_NAME", "דנה")
TOOLS_BASE_URL = os.environ.get("TOOLS_BASE_URL", "http://127.0.0.1:8787")
# Outbound calls start with the callee's "הלו"; inbound tests mimic that. If nobody speaks within this
# many seconds, the bot opens anyway (0 = open immediately).
OPEN_AFTER_SILENCE_S = float(os.environ.get("OPEN_AFTER_SILENCE_S", "4"))


GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.8-live")


def build_llm() -> google.realtime.RealtimeModel:
    """Provider C: Gemini Live speech-to-speech.

    GEMINI_MODEL=gemini-3.8-live-extended-thinking switches to Google's background-reasoning model
    (A/B test for understanding vs latency). It rejects blocking tools, so tools go NON_BLOCKING, and it
    takes GEMINI_THINKING_LEVEL (low | medium | high, default low). The standard model takes neither.
    """
    extended = "extended-thinking" in GEMINI_MODEL
    behavior = os.environ.get("GEMINI_TOOL_BEHAVIOR", "non_blocking" if extended else "blocking").lower()
    kwargs: dict = {}
    if lang := os.environ.get("GEMINI_LANGUAGE"):
        kwargs["language"] = lang
    if extended:
        if behavior != "non_blocking":
            log.warning("%s needs non-blocking tools: ignoring GEMINI_TOOL_BEHAVIOR=%s", GEMINI_MODEL, behavior)
            behavior = "non_blocking"
        level = os.environ.get("GEMINI_THINKING_LEVEL", "low").upper()
        kwargs["thinking_config"] = types.ThinkingConfig(thinking_level=types.ThinkingLevel(level))
    return google.realtime.RealtimeModel(
        model=GEMINI_MODEL,
        voice=os.environ.get("GEMINI_VOICE", "Kore"),
        temperature=float(os.environ.get("GEMINI_TEMPERATURE", "0.6")),
        tool_behavior=types.Behavior.NON_BLOCKING if behavior == "non_blocking" else types.Behavior.BLOCKING,
        # Live models answer only on v1alpha with an AI Studio key (default v1beta -> HTTP 404)
        api_version=os.environ.get("GEMINI_API_VERSION", "v1alpha"),
        **kwargs,
    )


def build_session(vad) -> AgentSession:
    """C (gemini): one realtime model. B (soniox_eleven): Soniox STT -> Gemini text -> ElevenLabs TTS."""
    if VOICE_PROVIDER == "gemini":
        return AgentSession(llm=build_llm())
    if VOICE_PROVIDER == "soniox_eleven":
        from mishlav_worker.pipeline_b import build_session_b

        return build_session_b(vad)
    raise SystemExit(f"unknown VOICE_PROVIDER={VOICE_PROVIDER!r} (gemini | soniox_eleven)")


def transcript_writer(call_id: str):
    """logs/transcripts/<call_id>.jsonl — for the manual 'did it switch language?' check."""
    path = ROOT / "logs" / "transcripts" / f"{call_id}.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)

    def write(role: str, text: str) -> None:
        line = {"ts": datetime.now(timezone.utc).isoformat(), "role": role, "text": text}
        with path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(line, ensure_ascii=False) + "\n")

    return path, write


def prewarm(proc: JobProcess) -> None:
    # Silero VAD loaded once per process: measurement for every provider (speech_monitor.py),
    # and B's barge-in detection
    proc.userdata["vad"] = silero.VAD.load()


# WORKER_PORT: health/debug port; B and C `dev` workers run side by side (8081 / 8082)
server = AgentServer(host="127.0.0.1", port=int(os.environ.get("WORKER_PORT", "8081")), setup_fnc=prewarm)


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
    # Prompt variables (incl. the customer context) come from the tools server: one source for A, B, C.
    variables = await client.call_context(scenario_id)
    if variables:
        call = CallVars.from_server(variables)
    else:  # server unreachable or older: build locally, without the customer context
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
    session = build_session(ctx.proc.userdata["vad"])

    agent_spoke = asyncio.Event()

    def _caller_started() -> None:
        user_spoke.set()
        tracker.user_state("speaking")

    def _caller_stopped(silence_s: float) -> None:
        tracker.user_state("listening", ended_ago_s=silence_s)

    # Caller speech from a side-channel VAD: Gemini doesn't report it (only on barge-in).
    speech = SpeechMonitor(ctx.proc.userdata["vad"], _caller_started, _caller_stopped)

    @session.on("agent_state_changed")
    def _agent_state(ev: AgentStateChangedEvent) -> None:
        if ev.new_state == "speaking":
            agent_spoke.set()
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
        await speech.aclose()
        await client.post_metrics(
            {
                # The session id read at call start: the tester may end the session before this posts.
                **({"session_id": test_session["session_id"]} if test_session else {}),
                "call_id": call_id,
                "turns": tracker.turns,
                "duration_sec": round(time.monotonic() - started, 1),
                # model in the source so the dashboard history tells standard vs extended-thinking runs apart
                "source": f"livekit-voice-worker/{VOICE_PROVIDER}"
                + (f"/{GEMINI_MODEL}" if VOICE_PROVIDER == "gemini" else ""),
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
    speech.attach(ctx.room)

    # Wait for the callee's "הלו" (the model then opens per the prompt); open anyway after silence.
    if OPEN_AFTER_SILENCE_S > 0:
        try:
            await asyncio.wait_for(user_spoke.wait(), timeout=OPEN_AFTER_SILENCE_S)
            return
        except asyncio.TimeoutError:
            pass
    if user_spoke.is_set() or agent_spoke.is_set():
        return  # the caller spoke or the model already opened: a second opening would repeat itself
    try:
        session.generate_reply(instructions="פתחי את השיחה עכשיו במשפט הפתיחה מהשלב הראשון בזרימת השיחה.")
    except RuntimeError:
        log.warning("call %s: session closed before the opening line (see the error above)", call_id)


if __name__ == "__main__":
    cli.run_app(server)
