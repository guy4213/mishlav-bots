"""The 5 tools as LiveKit function tools, built from config/tools.json.

Every call goes to the tools server, which validates, logs and answers (Part 1). The worker adds no
logic of its own except hanging up after `end_call`.
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
) -> list[RawFunctionTool]:
    return [_make_tool(d, client, on_tool) for d in definitions]


def _make_tool(
    definition: dict[str, Any],
    client: ToolsClient,
    on_tool: Callable[[str, dict[str, Any], dict[str, Any]], None] | None,
) -> RawFunctionTool:
    name = definition["name"]

    async def handler(raw_arguments: dict[str, object], context: RunContext) -> str | None:
        params = dict(raw_arguments or {})
        response = await client.call_tool(name, params)
        log.info("tool %s(%s) -> %s", name, json.dumps(params, ensure_ascii=False), response.get("ok"))
        if on_tool:
            on_tool(name, params, response)

        if name == "end_call" and response.get("ok"):
            # The prompt has the bot say goodbye before end_call (or nothing, on voicemail).
            # Hang up as soon as that goodbye has played. Not after the whole turn: Gemini replies to
            # the tool result anyway (once in English: "The call ended successfully...").
            asyncio.ensure_future(_hangup(context))
            return None
        return json.dumps(response, ensure_ascii=False)

    return function_tool(handler, raw_schema=raw_schema(definition))


async def _hangup(context: RunContext) -> None:
    try:
        await context.wait_for_playout()  # the words spoken before end_call
    except Exception:
        log.exception("end_call: wait_for_playout failed; hanging up anyway")
    # Mute whatever the model says after the tool result, then drop the line.
    try:
        context.session.output.set_audio_enabled(False)
    except Exception:
        pass
    await asyncio.sleep(HANGUP_GRACE_S)
    log.info("end_call: closing the session (room is deleted on close -> phone line drops)")
    context.session.shutdown()


