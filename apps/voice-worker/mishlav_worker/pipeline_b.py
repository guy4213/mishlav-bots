"""Provider B: Soniox STT -> LLM (Gemini text) -> ElevenLabs TTS, orchestrated by LiveKit.

Same worker, prompt, knowledge and tools as C (`VOICE_PROVIDER=soniox_eleven`, agent `mishlav-b`).
Turn-taking: Soniox endpoint detection (it knows when a Hebrew sentence ended); Silero VAD for barge-in.
"""

from __future__ import annotations

import os

from livekit.agents import AgentSession, vad as lk_vad
from livekit.plugins import elevenlabs, google, soniox

# Hebrew-capable ElevenLabs models: eleven_v4_turbo / eleven_v3 (flash_v2_5 and multilingual_v2 have no Hebrew)
DEFAULT_TTS_MODEL = "eleven_v4_turbo"
DEFAULT_VOICE_ID = "EXAVITQu4vr4xnSDxMaL"  # Sarah (premade, female) — same default as provider A
DEFAULT_LLM = "gemini-3.8-flash"

# Domain words for Soniox (improves recognition of names and terms; not a rule for the model)
STT_CONTEXT = "מכללת משלב, מישלב, יום עיון, ימי עיון, חשבי שכר, זום, מלון, פרונטלי, קישור, מסרון, לשכת רואי החשבון, מע\"מ"


def eleven_key() -> str | None:
    return os.environ.get("ELEVENLABS_API_KEY") or os.environ.get("elevenLabsAgentsKey") or None


def missing_keys() -> list[str]:
    need = {
        "SONIOX_API_KEY": os.environ.get("SONIOX_API_KEY"),
        "ELEVENLABS_API_KEY / elevenLabsAgentsKey": eleven_key(),
        "GOOGLE_API_KEY": os.environ.get("GOOGLE_API_KEY"),
    }
    return [k for k, v in need.items() if not v]


def build_session_b(vad: lk_vad.VAD) -> AgentSession:
    if missing := missing_keys():
        raise SystemExit(f"provider B needs {', '.join(missing)} in .env")
    stt = soniox.STT(
        params=soniox.STTOptions(
            model=os.environ.get("SONIOX_MODEL", "stt-rt-v5"),
            language_hints=["he"],
            context=STT_CONTEXT,
            # customers mix in English words ("zoom", "link"); keep Hebrew primary but not strict
            language_hints_strict=False,
        )
    )
    llm = google.LLM(
        model=os.environ.get("B_LLM_MODEL", DEFAULT_LLM),
        api_key=os.environ.get("GOOGLE_API_KEY"),
        temperature=float(os.environ.get("B_LLM_TEMPERATURE", "0.6")),
    )
    tts = elevenlabs.TTS(
        model=os.environ.get("ELEVENLABS_TTS_MODEL", DEFAULT_TTS_MODEL),
        voice_id=os.environ.get("ELEVENLABS_VOICE_ID", DEFAULT_VOICE_ID),
        api_key=eleven_key(),
        language="he",
    )
    return AgentSession(stt=stt, llm=llm, tts=tts, vad=vad, turn_detection="stt")
