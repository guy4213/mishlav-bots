"""One scenario as a text conversation with Gemini Live (provider C's model), for scripts/text-run.ts.

Same instructions (build_instructions), same 5 tools, same model settings as agent.py; the customer's lines
go in as text, the bot's spoken words come back as its audio transcription. Tool calls go to the tools
server given by --base-url (text-run starts an isolated one).

    uv run python live_text.py --base-url http://127.0.0.1:PORT --call-id X --model gemini-3.8-live \
        --vars vars.json --lines lines.json

Prints one JSON object per line: {"who": "bot"|"tool"|"note", "text": ...}.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

import httpx
from dotenv import load_dotenv
from google import genai
from google.genai import types

from mishlav_worker.context import CallVars, build_instructions, find_repo_root, load_tool_definitions
from mishlav_worker.tools import ACTIONS, END_CALL_HELD, _plain_success

ROOT = find_repo_root()
load_dotenv(Path(__file__).with_name(".env"), encoding="utf-8-sig")
load_dotenv(ROOT / ".env", encoding="utf-8-sig")

FIRST_REPLY_S = 40.0  # waiting for the bot to start answering
IDLE_S = float(os.environ.get("LIVE_IDLE_S", "4"))  # quiet this long after a turn -> the bot is done (extended thinks in the background: give it ~15)


def out(who: str, text: str) -> None:
    sys.stdout.write(json.dumps({"who": who, "text": text}, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def live_config(model: str, instructions: str) -> types.LiveConnectConfig:
    extended = "extended-thinking" in model
    decls = [
        types.FunctionDeclaration(
            name=t["name"],
            description=t["description"],
            parameters_json_schema=t["parameters"],
            **({"behavior": types.Behavior.NON_BLOCKING} if extended else {}),
        )
        for t in load_tool_definitions(ROOT)
    ]
    speech = types.SpeechConfig(
        voice_config=types.VoiceConfig(
            prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=os.environ.get("GEMINI_VOICE", "Kore"))
        ),
        **({"language_code": lang} if (lang := os.environ.get("GEMINI_LANGUAGE")) else {}),
    )
    return types.LiveConnectConfig(
        response_modalities=[types.Modality.AUDIO],
        system_instruction=instructions,
        tools=[types.Tool(function_declarations=decls)],
        temperature=float(os.environ.get("GEMINI_TEMPERATURE", "0.6")),
        speech_config=speech,
        output_audio_transcription=types.AudioTranscriptionConfig(),
        **(
            {
                "thinking_config": types.ThinkingConfig(
                    thinking_level=types.ThinkingLevel(os.environ.get("GEMINI_THINKING_LEVEL", "low").upper())
                )
            }
            if extended
            else {}
        ),
    )


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", required=True)
    ap.add_argument("--call-id", required=True)
    ap.add_argument("--model", required=True)
    ap.add_argument("--vars", required=True)
    ap.add_argument("--lines", required=True)
    a = ap.parse_args()

    variables = json.loads(Path(a.vars).read_text(encoding="utf-8"))
    lines: list[str] = json.loads(Path(a.lines).read_text(encoding="utf-8"))
    instructions = build_instructions(ROOT, CallVars.from_server(variables))
    http = httpx.AsyncClient(
        base_url=a.base_url,
        timeout=15,
        headers={"x-tools-secret": os.environ.get("TOOLS_SECRET", ""), "x-provider": "SIM", "x-call-id": a.call_id},
    )
    client = genai.Client(
        api_key=os.environ["GOOGLE_API_KEY"],
        http_options={"api_version": os.environ.get("GEMINI_API_VERSION", "v1alpha")},
    )

    async with client.aio.live.connect(model=a.model, config=live_config(a.model, instructions)) as session:
        queue: asyncio.Queue = asyncio.Queue()

        async def pump() -> None:
            try:
                while True:
                    async for msg in session.receive():
                        await queue.put(msg)
            except Exception as e:  # session closed or failed
                await queue.put(e)

        pump_task = asyncio.create_task(pump())
        ended = False
        voicemail = False
        after_end = 0  # bot lines since end_call
        open_question: str | None = None  # as the worker: an action result the customer still has to answer
        buf: list[str] = []

        def flush() -> None:
            nonlocal after_end
            text = "".join(buf).strip()
            buf.clear()
            if not text:
                return
            if not ended:
                out("bot", text)
                return
            # as the worker (_hangup): the first reply after end_call plays, the rest is muted; voicemail: all muted
            after_end += 1
            heard = not voicemail and after_end == 1
            out("bot", f"{text}  _(אחרי סיום השיחה – {'נשמע' if heard else 'מושתק'})_")

        try:
            for line in lines:
                if ended:
                    break
                out("customer", line)
                await session.send_client_content(
                    turns=types.Content(role="user", parts=[types.Part(text=line)]), turn_complete=True
                )
                answered = False
                while True:
                    try:
                        msg = await asyncio.wait_for(queue.get(), IDLE_S if answered else FIRST_REPLY_S)
                    except asyncio.TimeoutError:
                        break
                    if isinstance(msg, Exception):
                        flush()
                        out("note", f"session closed: {str(msg)[:200]}")
                        return
                    sc = msg.server_content
                    if sc and sc.output_transcription and sc.output_transcription.text:
                        buf.append(sc.output_transcription.text)
                    if msg.tool_call:
                        flush()
                        responses = []
                        for fc in msg.tool_call.function_calls or []:
                            args = dict(fc.args or {})
                            if fc.name == "end_call" and open_question and args.get("reason") != "do_not_call":
                                body = END_CALL_HELD  # the worker holds it the same way (tools.py)
                            else:
                                r = await http.post(f"/tools/{fc.name}", json=args)
                                body = r.json()
                                if fc.name in ACTIONS:
                                    open_question = None if _plain_success(fc.name, body) else fc.name
                            out("tool", f"{fc.name}({json.dumps(args, ensure_ascii=False)}) → {body.get('status') or body.get('error')}")
                            # exactly as LiveKit sends it (livekit/plugins/google/utils.py): the JSON text under "output"
                            responses.append(
                                types.FunctionResponse(id=fc.id, name=fc.name, response={"output": json.dumps(body, ensure_ascii=False)})
                            )
                            if fc.name == "end_call" and body.get("ok"):
                                ended = True
                                voicemail = args.get("reason") == "voicemail"
                        await session.send_tool_response(function_responses=responses)
                    if sc and sc.turn_complete:
                        flush()
                        answered = True
                flush()
        finally:
            pump_task.cancel()
            await http.aclose()


if __name__ == "__main__":
    asyncio.run(main())
