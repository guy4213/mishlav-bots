# phone — the bot on a Zadarma phone line (Gemini Live)

Plain Node (no dependencies beyond the repo's `yaml`, no LiveKit, no Python). It registers as the Zadarma
SIP line, answers calls to the number (or dials out), and connects each call to Gemini Live with **the same
inputs as provider C's worker**: `config/prompt.md` with the call's variables + the knowledge base, and the 5
tools from `config/tools.json`, each POSTed to the tools server (`X-Provider: C`, `X-Call-Id: phone-…`).

```
phone ─► Zadarma number ─► Zadarma PBX (SIP/RTP, UDP) ◄─ apps/phone (dev PC) ─► Gemini Live
                                                             │
                                                             └─► tools server 127.0.0.1:8787 ─► logs/
```

The SIP / RTP / audio code and the line handling come from `gemini-live-agent/phone/` (tuned there on real
calls): quiet-line fix for Gemini's end-of-speech detection, barge-in hold (short words like "כן" don't stop
the bot), line check after silence.

## Run

```bash
npm run dev                          # terminal 1: the tools server
npm run phone                        # terminal 2: wait for calls to the number; the bot answers
npm run phone -- call 0501234567     # the bot calls that number (costs Zadarma balance), then exits
```

PowerShell: `npm.cmd run phone -- call 0501234567 --scenario S1` (plain `npm` drops the `--` flags).

### From the dashboard (and on Render)

When `ZADARMA_SIP_LOGIN` / `ZADARMA_SIP_PASSWORD` are set, the tools server (`npm run dev` / `npm start`)
runs the line itself (`src/line.js`): the dashboard's **📞 חיוג** tab dials any number with a scenario and
shows the call live (transcript, tools, line log); the **בדיקה** tab (provider C, phone) has "הבוט יתקשר
אליי" for a scored run. Everything is kept in files: `logs/phone.jsonl`, `logs/transcripts/`,
`logs/tool-calls.jsonl`. `PHONE_LINE=0` turns it off (e.g. locally while Render holds the extension: only one
program may be registered). Render: see `render.yaml` at the repo root. Its disk is wiped on every deploy,
so the logs there live until the next deploy.

| Option | |
|---|---|
| `--scenario S1` | prompt variables from that scenario's `context:` (default: the active test session's scenario) |
| `--name דנה` / `--day <day_id>` | override `first_name` / `interested_day_id` |
| `--model <id>` | default `PHONE_GEMINI_MODEL` or `gemini-3.1-flash-live-preview` (extended-thinking is not supported: it needs non-blocking tools) |
| `--voice <name>` | default `PHONE_VOICE`, `GEMINI_VOICE` or `Kore` |
| `--record` | also save `logs/recordings/<call>.wav` (left = caller, right = bot). Personal data: keep local |

Test sessions work as with the LiveKit number: `npm run session -- start --provider C --scenario S1`, call,
`npm run session -- calls`, `npm run session -- end`.

## `.env` (repo root)

`GOOGLE_API_KEY`, `TOOLS_SECRET`, and the line: `ZADARMA_SIP_SERVER`, `ZADARMA_SIP_LOGIN`,
`ZADARMA_SIP_PASSWORD` (a line on Zadarma's cloud PBX registers as an extension: login like `660895-100`,
server `pbx.zadarma.com`; incoming calls to the number must reach that extension). Optional:
`ZADARMA_NUMBER` (display), `PHONE_GEMINI_MODEL`, `PHONE_VOICE`, `OPEN_AFTER_SILENCE_S` (default 1.3),
`GEMINI_TEMPERATURE` (0.6), `PHONE_DISPLAY_NAME`, `SIP_DEBUG=1` (log every SIP message).

Only one program should be registered on the extension at a time (e.g. not this and
`gemini-live-agent`'s `npm run phone` together), or incoming calls may reach the other one.

## Per call

1. Prompt variables from `GET /test/context` (scenario / `--name` / `--day`), prompt + knowledge rendered
   like `mishlav_worker/context.py` (`src/mishlav.js`).
2. Gemini connects while the phone rings. The bot waits for the callee's "הלו" (Gemini answers it by
   itself), or opens after `OPEN_AFTER_SILENCE_S` with a cue.
3. Tools: POST to the tools server; the result goes back as `{"output": "<json>"}` (as LiveKit sends it).
4. `end_call`: the words before it play out, then the reply to its result (the goodbye, only if none was
   said), then the line drops. If a whole bot turn already ended since the caller last spoke, that reply is
   not played (3.1 Flash said the goodbye twice in a test). `voicemail`: nothing is played, the line drops.
5. Quiet line: after 6 s the bot is told the line is silent (it checks the line); after another 6 s it is
   told to say goodbye, and the line drops. Hard limit 15 minutes.
6. Transcript: `logs/transcripts/<call>.jsonl`. Per-turn latency (end of caller voice on the line -> first
   bot audio on the line) goes to `/test/metrics` with source `zadarma-phone/<model>`.

## Tests

`npm test` runs `apps/phone/test/` with the rest (G.711, SIP parsing, digest, prompt rendering, Live setup,
the call logic against a fake Gemini session).
