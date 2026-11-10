"""Workarounds for the LiveKit Gemini plugin.

gemini-3.8-live-extended-thinking closes the session (1007 "Function response scheduling is not supported
for this model") on any tool response that carries `scheduling`. The plugin sends SILENT for every tool
output marked reply_required=False, and LiveKit itself marks outputs that way in several places (an
interrupted turn, a silent update, cancel_tool_reply), not only when our tools ask for it. So the fix
sits where the responses are built: never claim SILENT support. Gemini then answers those outputs; the
only one we don't want answered is end_call's, and the worker mutes the line before it.
"""

from __future__ import annotations

import logging

log = logging.getLogger("mishlav.gemini")

_patched = False


def never_send_tool_scheduling() -> None:
    global _patched
    if _patched:
        return
    import livekit.plugins.google.realtime.realtime_api as rt

    original = rt.get_tool_results_for_realtime

    def without_scheduling(*args, **kwargs):
        kwargs["supports_silent_scheduling"] = False
        return original(*args, **kwargs)

    rt.get_tool_results_for_realtime = without_scheduling
    _patched = True
    log.info("tool responses go without `scheduling` (the extended-thinking model rejects it)")
