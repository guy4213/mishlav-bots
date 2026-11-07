# voice-worker (provider C first, then B)

Python LiveKit agent. **Not built yet** — this is task 3.1 (provider C, Gemini Live — tested first) in [docs/TASKS.md](../../docs/TASKS.md).

Plan (see [docs/TECHNICAL_SPEC.md](../../docs/TECHNICAL_SPEC.md) §11):

- One agent based on the LiveKit Voice AI Quickstart, switched by `VOICE_PROVIDER=gemini | soniox_eleven` (default `gemini`, model `gemini-3.8-live`).
- Loads `config/prompt.md` + `config/knowledge/` and substitutes `{{first_name}}`, `{{bot_name}}`,
  `{{interested_day_id}}`, `{{current_datetime}}`.
- The 5 tools from `config/tools.json` as function tools, each POSTing to the tools server with
  `X-Tools-Secret`, `X-Provider: C|B`, `X-Call-Id: <room name>`.
- Per-turn latency (end of user speech → first bot audio) and provider time posted to `/test/metrics`.
