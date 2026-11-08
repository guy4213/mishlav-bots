"""The 5 tools must convert to Gemini function declarations, and the worker module must import cleanly."""

import asyncio
import importlib
import os
from types import SimpleNamespace

from google.genai import types
from livekit.agents import llm
from livekit.plugins.google.utils import create_tools_config

from mishlav_worker.context import find_repo_root, load_tool_definitions
from mishlav_worker.tools import build_tools

ROOT = find_repo_root()


class FakeClient:
    def __init__(self, response):
        self.response = response
        self.calls = []

    async def call_tool(self, name, params):
        self.calls.append((name, params))
        return self.response


def test_all_five_tools_are_accepted_by_gemini():
    tools = build_tools(load_tool_definitions(ROOT), FakeClient({"ok": True}))
    gemini_tools, _ = create_tools_config(llm.ToolContext(tools), tool_behavior=types.Behavior.BLOCKING)
    decls = {d.name: d for d in gemini_tools[0].function_declarations}
    assert sorted(decls) == sorted(["get_day_info", "send_purchase_link", "schedule_callback", "request_human", "end_call"])
    # the closed day catalogue survives the conversion
    assert "payroll-2026-12-22-hotel" in str(decls["get_day_info"])


def _run(tool, args, ctx):
    return asyncio.run(tool(raw_arguments=args, context=ctx))


def test_tool_posts_to_server_and_returns_json():
    client = FakeClient({"ok": True, "status": "sent"})
    tool = {t.info.name: t for t in build_tools(load_tool_definitions(ROOT), client)}["send_purchase_link"]
    out = _run(tool, {"day_id": "payroll-2026-12-08-zoom"}, ctx=None)
    assert client.calls == [("send_purchase_link", {"day_id": "payroll-2026-12-08-zoom"})]
    assert '"status": "sent"' in out


def test_end_call_returns_no_reply_and_hangs_up_after_the_turn():
    client = FakeClient({"ok": True, "status": "ending"})
    tool = {t.info.name: t for t in build_tools(load_tool_definitions(ROOT), client)}["end_call"]
    callbacks = []
    ctx = SimpleNamespace(speech_handle=SimpleNamespace(add_done_callback=callbacks.append))
    assert _run(tool, {"reason": "voicemail"}, ctx) is None
    assert client.calls == [("end_call", {"reason": "voicemail"})]
    assert len(callbacks) == 1  # hang-up scheduled once the bot's current turn ends


def test_agent_module_imports():
    os.environ.setdefault("GOOGLE_API_KEY", "test-key")
    mod = importlib.import_module("agent")
    assert mod.AGENT_NAME
    assert mod.build_llm() is not None
