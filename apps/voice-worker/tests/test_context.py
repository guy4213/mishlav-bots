from datetime import datetime, timezone

import pytest

from mishlav_worker.context import (
    CallVars,
    build_instructions,
    find_repo_root,
    format_now_he,
    load_tool_definitions,
    render,
    scenario_context,
)
from mishlav_worker.latency import LatencyTracker

ROOT = find_repo_root()


def test_render_substitutes_and_rejects_unknown_variables():
    assert render("שלום {{first_name}}", {"first_name": "דנה"}) == "שלום דנה"
    with pytest.raises(KeyError):
        render("{{nope}}", {})


def test_instructions_have_no_leftover_variables_and_include_knowledge():
    text = build_instructions(ROOT, CallVars(first_name="דנה", bot_name="נועה", current_datetime="x"))
    assert "{{" not in text
    assert "שלום דנה, מדברת נועה ממכללת מישלב" in text
    assert "לא ידוע" in text  # no interested_day_id
    for day in ("payroll-2026-12-08-zoom", "payroll-2026-12-22-hotel", "payroll-2027-01-12-zoom"):
        assert f"`{day}`" in text


def test_customer_context_from_the_server_reaches_the_prompt():
    ctx = 'הלקוח התעניין ביום העיון "סגירת שנת מס בשכר" – יום פרונטלי במלון, 22.12.2026.'
    call = CallVars.from_server(
        {
            "first_name": "דנה",
            "bot_name": "נועה",
            "interested_day_id": "payroll-2026-12-22-hotel",
            "current_datetime": "x",
            "customer_context": ctx,
        }
    )
    text = build_instructions(ROOT, call)
    assert "# הקשר השיחה" in text and ctx in text
    assert "{{" not in text
    # the server sends the display value "לא ידוע" for an unknown day
    assert CallVars.from_server({"first_name": "a", "bot_name": "b", "interested_day_id": "לא ידוע", "current_datetime": "x"}).interested_day_id == ""


def test_format_now_he_is_israel_time():
    # 2026-12-08 08:05 UTC = Tuesday 10:05 in Israel (winter, UTC+2)
    assert format_now_he(datetime(2026, 12, 8, 8, 5, tzinfo=timezone.utc)) == "יום שלישי, 8 בדצמבר 2026, 10:05"
    # summer time, UTC+3
    assert format_now_he(datetime(2027, 6, 1, 7, 0, tzinfo=timezone.utc)).endswith("10:00")


def test_scenario_context():
    assert scenario_context(ROOT, "S1") == {"first_name": "דנה", "interested_day_id": "payroll-2026-12-22-hotel"}
    assert scenario_context(ROOT, "S3") == {"first_name": "מיכל"}
    assert scenario_context(ROOT, "NOPE") == {}
    assert scenario_context(ROOT, None) == {}


def test_tool_definitions_are_the_five_tools():
    names = [t["name"] for t in load_tool_definitions(ROOT)]
    assert names == ["get_day_info", "send_purchase_link", "schedule_callback", "request_human", "end_call"]


def test_latency_tracker():
    now = [0.0]
    t = LatencyTracker(clock=lambda: now[0])
    t.agent_state("speaking")  # greeting: no user turn yet -> not a turn
    t.user_state("speaking")
    now[0] = 1.0
    t.user_state("listening")
    t.provider_time(400)
    now[0] = 1.85
    t.agent_state("speaking")
    t.agent_state("listening")
    t.agent_state("speaking")  # bot keeps talking, no new user turn -> no extra turn
    assert t.turns == [{"turn": 1, "latency_ms": 850, "provider_ms": 400}]


def test_latency_backdates_the_vad_silence_window():
    now = [0.0]
    t = LatencyTracker(clock=lambda: now[0])
    t.user_state("speaking")
    now[0] = 2.55  # VAD reports the end 0.55s after the caller actually stopped (at 2.0)
    t.user_state("listening", ended_ago_s=0.55)
    now[0] = 3.2
    t.agent_state("speaking")
    assert t.turns == [{"turn": 1, "latency_ms": 1200}]
