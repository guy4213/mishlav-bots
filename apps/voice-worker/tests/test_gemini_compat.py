"""The extended-thinking model closes the session on any tool response with `scheduling` (1007)."""

from livekit.agents import llm


def _silent_output():
    return llm.FunctionCallOutput(name="end_call", call_id="c1", output='{"ok": true}', is_error=False, reply_required=False)


def test_plugin_would_send_silent_scheduling_without_the_patch():
    from livekit.plugins.google.utils import get_tool_results_for_realtime

    res = get_tool_results_for_realtime(llm.ChatContext([_silent_output()]), supports_silent_scheduling=True)
    assert res.function_responses[0].scheduling is not None  # what crashed the calls


def test_patched_plugin_never_sends_scheduling():
    import livekit.plugins.google.realtime.realtime_api as rt
    from mishlav_worker.gemini_compat import never_send_tool_scheduling

    never_send_tool_scheduling()
    res = rt.get_tool_results_for_realtime(llm.ChatContext([_silent_output()]), supports_silent_scheduling=True)
    assert res.function_responses[0].scheduling is None
