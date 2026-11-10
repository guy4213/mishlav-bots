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


def test_end_call_hangs_up_right_after_the_goodbye_and_mutes_what_follows(monkeypatch):
    import mishlav_worker.tools as tools_mod

    monkeypatch.setattr(tools_mod, "HANGUP_GRACE_S", 0)
    events = []

    async def wait_for_playout():
        events.append("goodbye played")

    session = SimpleNamespace(
        output=SimpleNamespace(set_audio_enabled=lambda on: events.append(f"audio {on}")),
        shutdown=lambda: events.append("shutdown"),
    )
    ctx = SimpleNamespace(wait_for_playout=wait_for_playout, session=session)
    client = FakeClient({"ok": True, "status": "ending"})
    tool = {t.info.name: t for t in build_tools(load_tool_definitions(ROOT), client)}["end_call"]

    async def scenario():
        out = await tool(raw_arguments={"reason": "voicemail"}, context=ctx)
        for _ in range(5):
            await asyncio.sleep(0)
        return out

    assert asyncio.run(scenario()) is None  # no reply asked of the model
    assert client.calls == [("end_call", {"reason": "voicemail"})]
    assert events == ["goodbye played", "audio False", "shutdown"]


class RoutingClient:
    """Answers per tool, like the tools server."""

    def __init__(self, responses):
        self.responses = responses
        self.calls = []

    async def call_tool(self, name, params):
        self.calls.append((name, params))
        await asyncio.sleep(0.01)
        return self.responses[name]


def _non_blocking_tools(client):
    return {t.info.name: t for t in build_tools(load_tool_definitions(ROOT), client, non_blocking=True)}


def test_non_blocking_results_never_ask_for_silence():
    # A no-reply result is sent as SILENT scheduling, and the extended model closes the session on it
    # (1007 "Function response scheduling is not supported for this model"). Every result must be plain.
    client = RoutingClient(
        {
            "get_day_info": {"ok": True, "day": {}},
            "send_purchase_link": {"ok": True, "status": "sent"},
            "schedule_callback": {"ok": True, "status": "accepted"},
            "request_human": {"ok": True, "status": "handed_to_rep"},
        }
    )
    tools = _non_blocking_tools(client)
    args = {
        "get_day_info": {"day_id": "x"},
        "send_purchase_link": {"day_id": "x"},
        "schedule_callback": {"requested_time": "2026-11-12T09:00:00"},
        "request_human": {"reason": "other"},
    }
    for name, a in args.items():
        assert isinstance(asyncio.run(tools[name](raw_arguments=a, context=None)), str), name


def test_non_blocking_end_call_waits_when_an_action_still_needs_the_customer(monkeypatch):
    import mishlav_worker.tools as tools_mod

    monkeypatch.setattr(tools_mod, "HANGUP_GRACE_S", 0)
    events = []

    async def wait_for_playout():
        events.append("goodbye played")

    session = SimpleNamespace(
        output=SimpleNamespace(set_audio_enabled=lambda on: events.append(f"audio {on}")),
        shutdown=lambda: events.append("shutdown"),
    )
    ctx = SimpleNamespace(wait_for_playout=wait_for_playout, session=session)
    client = RoutingClient(
        {"schedule_callback": {"ok": True, "status": "alternative"}, "end_call": {"ok": True, "status": "ending"}}
    )
    tools = _non_blocking_tools(client)

    async def together():  # the model calls both at once
        return await asyncio.gather(
            tools["schedule_callback"](raw_arguments={"requested_time": "2026-11-12T21:00:00"}, context=ctx),
            tools["end_call"](raw_arguments={"reason": "completed"}, context=ctx),
        )

    _, end = asyncio.run(together())
    assert "not_finished" in end  # the alternative must be offered first
    assert [c[0] for c in client.calls] == ["schedule_callback"] and events == []

    client.responses["schedule_callback"] = {"ok": True, "status": "accepted"}

    async def agreed():
        await tools["schedule_callback"](raw_arguments={"requested_time": "2026-11-12T09:00:00"}, context=ctx)
        out = await tools["end_call"](raw_arguments={"reason": "completed"}, context=ctx)
        for _ in range(5):
            await asyncio.sleep(0)
        return out

    out = asyncio.run(agreed())
    assert isinstance(out, str)  # plain result: SILENT would close the extended session
    assert events == ["goodbye played", "audio False", "shutdown"]
def test_agent_module_imports():
    os.environ.setdefault("GOOGLE_API_KEY", "test-key")
    mod = importlib.import_module("agent")
    assert mod.AGENT_NAME
    assert mod.build_llm() is not None


def test_extended_thinking_model_gets_non_blocking_tools_and_a_thinking_level(monkeypatch):
    os.environ.setdefault("GOOGLE_API_KEY", "test-key")
    mod = importlib.import_module("agent")
    monkeypatch.setattr(mod, "GEMINI_MODEL", "gemini-3.8-live-extended-thinking")
    monkeypatch.setenv("GEMINI_TOOL_BEHAVIOR", "blocking")  # ignored: this model rejects blocking tools
    opts = mod.build_llm()._opts
    assert opts.tool_behavior == types.Behavior.NON_BLOCKING
    assert opts.thinking_config.thinking_level == types.ThinkingLevel.LOW

    monkeypatch.setattr(mod, "GEMINI_MODEL", "gemini-3.8-live")
    monkeypatch.delenv("GEMINI_TOOL_BEHAVIOR")
    opts = mod.build_llm()._opts
    assert opts.tool_behavior == types.Behavior.BLOCKING
    assert not opts.thinking_config  # NOT_GIVEN: the standard model takes no thinking level
