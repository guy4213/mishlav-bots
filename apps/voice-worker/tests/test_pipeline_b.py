"""Provider B wiring (no network): keys are checked up front and the pipeline uses Hebrew-capable parts."""

import pytest
from livekit.plugins import silero

from mishlav_worker import pipeline_b


def test_b_refuses_to_start_without_its_keys(monkeypatch):
    for k in ("SONIOX_API_KEY", "ELEVENLABS_API_KEY", "elevenLabsAgentsKey", "GOOGLE_API_KEY"):
        monkeypatch.delenv(k, raising=False)
    assert set(pipeline_b.missing_keys()) == {"SONIOX_API_KEY", "ELEVENLABS_API_KEY / elevenLabsAgentsKey", "GOOGLE_API_KEY"}
    with pytest.raises(SystemExit):
        pipeline_b.build_session_b(silero.VAD.load())


def test_b_session_is_soniox_gemini_elevenlabs_in_hebrew(monkeypatch):
    monkeypatch.setenv("SONIOX_API_KEY", "s-test")
    monkeypatch.setenv("elevenLabsAgentsKey", "e-test")
    monkeypatch.setenv("GOOGLE_API_KEY", "g-test")
    monkeypatch.delenv("ELEVENLABS_TTS_MODEL", raising=False)
    session = pipeline_b.build_session_b(silero.VAD.load())
    assert type(session.stt).__module__.startswith("livekit.plugins.soniox")
    assert session.stt._params.language_hints == ["he"]
    assert type(session.llm).__module__.startswith("livekit.plugins.google")
    assert type(session.tts).__module__.startswith("livekit.plugins.elevenlabs")
    assert session.tts._opts.model == "eleven_v4_turbo"  # flash_v2_5 has no Hebrew
