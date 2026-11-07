# voice-worker (branches B and C)

Python LiveKit agent. **Not built yet** — this is Part 3.2 in [docs/TASKS.md](../../docs/TASKS.md).

Plan (see [docs/TECHNICAL_SPEC.md](../../docs/TECHNICAL_SPEC.md) §11):

- One agent based on the LiveKit Voice AI Quickstart, switched by `VOICE_PROVIDER=soniox_eleven | gemini`.
- Loads `config/prompt.md` + `config/knowledge/` and substitutes `{{first_name}}`, `{{bot_name}}`,
  `{{interested_day_id}}`, `{{current_datetime}}`.
- The 5 tools from `config/tools.json` as function tools, each POSTing to the tools server with
  `X-Tools-Secret`, `X-Provider: B|C`, `X-Call-Id: <room name>`.
- Per-turn latency (end of user speech → first bot audio) and provider time posted to `/test/metrics`.
