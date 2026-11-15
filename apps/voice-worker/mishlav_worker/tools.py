"""The 5 tools as LiveKit function tools, built from config/tools.json.

Every call goes to the tools server, which validates, logs and answers (Part 1). The worker adds no
logic of its own except when to speak about a result and hanging up after `end_call`.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Callable
from typing import Any

from livekit.agents import RunContext, function_tool
from livekit.agents.llm import RawFunctionTool

from .tools_client import ToolsClient

log = logging.getLogger("mishlav.tools")

# Short pause after the bot's last words before the line drops, so the goodbye isn't clipped.
HANGUP_GRACE_S = 0.6
# No words before end_call: wait for the goodbye said in reply to its result (the extended model is slow).
GOODBYE_START_S = 6.0  # no goodbye started by then -> hang up
GOODBYE_QUIET_S = 1.0  # bot quiet this long after speaking -> goodbye over
GOODBYE_MAX_S = 15.0  # hard cap
# Non-blocking: how long end_call waits for tools called alongside it (they answer in milliseconds).
INFLIGHT_WAIT_S = 5.0

# Actions whose result can leave a question open for the customer (an alternative time, an error).
ACTIONS = {"send_purchase_link", "schedule_callback", "request_human"}
# end_call's answer while such a result still waits for the customer
END_CALL_HELD = {"ok": False, "error": "not_finished", "message_he": "השיחה עוד לא הסתיימה – הלקוח עוד לא ענה על מה שהכלי החזיר."}


def raw_schema(tool: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": "function",
        "name": tool["name"],
        "description": tool["description"],
        "parameters": tool["parameters"],
    }


def build_tools(
    definitions: list[dict[str, Any]],
    client: ToolsClient,
    on_tool: Callable[[str, dict[str, Any], dict[str, Any]], None] | None = None,
    non_blocking: bool = False,
) -> list[RawFunctionTool]:
    call = _CallState()
    return [_make_tool(d, client, on_tool, non_blocking, call) for d in definitions]


class _CallState:
    """Shared by the 5 tools of one call."""

    def __init__(self) -> None:
        self.inflight = 0
        self.open_question: str | None = None  # an action result the customer still has to answer


def _plain_success(name: str, response: dict[str, Any]) -> bool:
    return name in ACTIONS and bool(response.get("ok")) and response.get("status") != "alternative"


def _make_tool(
    definition: dict[str, Any],
    client: ToolsClient,
    on_tool: Callable[[str, dict[str, Any], dict[str, Any]], None] | None,
    non_blocking: bool,
    call: _CallState,
) -> RawFunctionTool:
    name = definition["name"]

    async def handler(raw_arguments: dict[str, object], context: RunContext) -> Any:
        params = dict(raw_arguments or {})

        if name == "end_call" and non_blocking:
            # The model often calls an action and end_call together. Let the action answer first:
            # if it brought something new (e.g. "that time is outside hours"), the call isn't over.
            loop = asyncio.get_running_loop()
            deadline = loop.time() + INFLIGHT_WAIT_S
            while call.inflight and loop.time() < deadline:
                await asyncio.sleep(0.02)
            if call.open_question and params.get("reason") != "do_not_call":
                log.info("end_call held: %s is waiting for the customer's answer", call.open_question)
                return json.dumps(END_CALL_HELD, ensure_ascii=False)

        call.inflight += 1
        try:
            response = await client.call_tool(name, params)
        finally:
            call.inflight -= 1
        log.info("tool %s(%s) -> %s", name, json.dumps(params, ensure_ascii=False), response.get("ok"))
        if on_tool:
            on_tool(name, params, response)
        out = json.dumps(response, ensure_ascii=False)

        if name in ACTIONS:
            call.open_question = None if _plain_success(name, response) else name

        if name == "end_call" and response.get("ok"):
            asyncio.ensure_future(_hangup(context, voicemail=params.get("reason") == "voicemail"))
            # Always the plain result (its message asks for the closing sentence if none was said).
            # Never a no-reply result: that is sent as SILENT scheduling, and the extended model closes
            # the session on it (1007 "Function response scheduling is not supported for this model").
            return out
        return out

    return function_tool(handler, raw_schema=raw_schema(definition))


async def _wait_for_goodbye(session) -> bool:
    """The goodbye the model says in reply to the end_call result: wait for it to start, then to end."""
    loop = asyncio.get_running_loop()
    started = loop.time()
    spoke = False
    quiet_since = started
    while loop.time() - started < GOODBYE_MAX_S:
        if getattr(session, "agent_state", None) == "speaking":
            spoke, quiet_since = True, loop.time()
        elif loop.time() - quiet_since >= (GOODBYE_QUIET_S if spoke else GOODBYE_START_S):
            break
        await asyncio.sleep(0.1)
    return spoke


async def _hangup(context: RunContext, voicemail: bool = False) -> None:
    try:
        await context.wait_for_playout()  # the words spoken before end_call
    except Exception:
        log.exception("end_call: wait_for_playout failed; hanging up anyway")
    if not voicemail:
        # Words before end_call are often a filler ("I'm passing it on...", "checking..."), not the goodbye.
        # The end_call result asks for the closing sentence only if none was said: let that reply play.
        spoke = await _wait_for_goodbye(context.session)
        log.info("end_call: reply after the end_call result: %s", spoke)
    # Mute whatever else the model says about the result ("the call has ended"...), then drop the line.
    try:
        context.session.output.set_audio_enabled(False)
    except Exception:
        pass
    await asyncio.sleep(HANGUP_GRACE_S)
    log.info("end_call: closing the session (room is deleted on close -> phone line drops)")
    context.session.shutdown()
