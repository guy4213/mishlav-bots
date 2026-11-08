# voice-worker — provider C (Gemini Live), later B

Python LiveKit agent for task 3.1 in [docs/TASKS.md](../../docs/TASKS.md). Gemini Live is tested first.

LiveKit is the telephony bridge: it owns the phone number, answers the call, streams audio between the
caller and this worker, detects end of turn / interruptions, and runs our tools. Gemini Live is the
speech-to-speech model. The worker runs **on the dev machine** and connects *out* to LiveKit Cloud, so
it reaches the tools server on `127.0.0.1` directly — **no ngrok needed for provider C**.

```
phone ─► LiveKit number ─► LiveKit Cloud ◄─ this worker (dev PC) ─► Gemini Live
                                                │
                                                └─► tools server 127.0.0.1:8787 ─► logs/
```

## What it does per call

1. Reads the active test session from the tools server (`npm run session -- start --provider C ...`)
   and takes `first_name` / `interested_day_id` from that scenario's `context:`.
2. Builds the instructions: `config/prompt.md` with variables substituted + the whole knowledge base.
3. Exposes the 5 tools from `config/tools.json`; each POSTs to the tools server with `X-Tools-Secret`,
   `X-Provider: C`, `X-Call-Id: <LiveKit room name>`. `end_call` hangs up after the bot's last words.
4. Waits for the callee's "הלו" (like a real outbound call), or opens after `OPEN_AFTER_SILENCE_S`.
5. Measures each turn (end of customer speech → first bot audio; Gemini time-to-first-audio as
   `provider_ms`) and posts it to `/test/metrics` when the call ends.
6. Writes the transcript to `logs/transcripts/<room>.jsonl` (for the manual language-switch check).

## Setup (once)

1. `uv` is required (Python 3.12 is installed by uv). From this folder: `uv sync`.
2. **LiveKit Cloud** (free Build plan): create a project → *Settings → API keys* → URL, key, secret.
3. **Gemini API key**: https://aistudio.google.com → *Get API key*.
4. `cp .env.example .env` and fill in `LIVEKIT_*` and `GOOGLE_API_KEY`. `TOOLS_SECRET` is read from the
   repo-root `.env`.
5. **Phone number** (LiveKit Cloud → *Telephony → Phone numbers*): buy a US number, then create a
   **dispatch rule** for it that dispatches agent **`mishlav-c`** (= `AGENT_NAME`), individual room per
   call. Inbound only for now; the Build plan includes 50 free inbound minutes. Calling a US number
   from Israel is an international call on your phone plan.

## Run

Terminal 1 (repo root): `npm run dev` — the tools server.

Terminal 2:

```bash
npm run worker:console   # talk to the bot through the PC mic/speakers — no phone, no number needed
npm run worker:dev       # connect to LiveKit and answer calls to the LiveKit number
```

(or from this folder: `uv run agent.py console` / `uv run agent.py dev`)

Per test call (repo root, PowerShell: `npm.cmd`):

```bash
npm.cmd run session -- start --provider C --scenario S1 --actor female   # prints the actor script
#   call the LiveKit number, say "הלו", play the script
npm.cmd run session -- calls   # what the bot did
npm.cmd run session -- end
```

## Settings (`.env`)

| Var | Default | |
|-----|---------|--|
| `GEMINI_MODEL` | `gemini-3.8-live` | Also `gemini-3.1-flash-live-preview`, `gemini-3.8-live-extended-thinking` |
| `GEMINI_VOICE` | `Kore` | Gemini prebuilt voice; choose by listening |
| `GEMINI_TOOL_BEHAVIOR` | `blocking` | Model waits for the tool result before speaking (3.8 defaults to non-blocking) |
| `GEMINI_TEMPERATURE` | `0.6` | |
| `GEMINI_LANGUAGE` | — | Optional BCP-47 code (e.g. `he-IL`) if the Live API accepts it — a Hebrew-lock tuning knob |
| `BOT_NAME` | `נועה` | `{{bot_name}}` in the prompt |
| `AGENT_NAME` | `mishlav-c` | Must match the dispatch rule |
| `OPEN_AFTER_SILENCE_S` | `4` | Open the call if the callee is silent this long (`0` = immediately) |
| `TOOLS_BASE_URL` | `http://127.0.0.1:8787` | |

Tuning knobs if latency or noise fail: model, `GEMINI_TOOL_BEHAVIOR`, LiveKit noise cancellation
(`livekit-plugins-noise-cancellation`, BVCTelephony), turn detection.

## Tests

```bash
uv run pytest   # prompt/knowledge rendering, scenario context, latency tracker, Gemini tool schemas, end_call
```
