# mishlav-bots

Hebrew outbound voice bot for Mishlav College study days. **Current stage: Part 1 — provider test
infrastructure.**

- [docs/SPEC_MACRO.md](docs/SPEC_MACRO.md) — what and why
- [docs/TECHNICAL_SPEC.md](docs/TECHNICAL_SPEC.md) — how
- [docs/TASKS.md](docs/TASKS.md) — roadmap and tasks

> **Windows PowerShell:** `npm run x -- --flag` drops `--flag` (PowerShell eats the `--`).
> Use `npm.cmd run x -- --flag`, or run from Git Bash.

## Provider testing — the easy way

```bash
npm run lab      # starts the tools server + the voice bot, opens the dashboard in the browser
```

The dashboard (Hebrew) walks through each test: pick provider + scenario → what to say and what the bot
must do → talk to the bot from the browser mic (or call the LiveKit number) while watching its tool
calls and transcript live → a short form after the call → progress, the 5 criteria and the decision.
Answers are saved to `tests/results/manual-inputs.yaml`.

What `npm run lab` starts depends on the keys in `.env`:

| Provider | Needs | What runs | Channels |
|---|---|---|---|
| C — LiveKit + Gemini Live | `LIVEKIT_*`, `GOOGLE_API_KEY` | voice worker, agent `mishlav-c` | browser, phone |
| A — ElevenLabs Agents | `ELEVENLABS_API_KEY` (or `elevenLabsAgentsKey`), ngrok authtoken | ngrok tunnel + `eleven:sync` (agent created/updated from the repo, tools → tunnel) | browser |
| B — LiveKit + Soniox + ElevenLabs | `LIVEKIT_*`, `SONIOX_API_KEY`, ElevenLabs key, `GOOGLE_API_KEY` | second worker, agent `mishlav-b` | browser, phone |

```bash
npm run eleven:sync -- --url https://<ngrok-host>   # create/update the A agent by hand (lab does this)
npm run eleven:text -- --scenario S1                 # text-only A conversation: agent + tools smoke test
```

## Setup

```bash
npm install
cp .env.example .env        # then set TOOLS_SECRET (>= 16 random chars)
npm test                    # unit + end-to-end tests
npm run tools:export        # writes config/tools.json (tool JSON Schemas for the providers)
```

## Run the tools server

```bash
npm run dev                 # http://127.0.0.1:8787, logs in ./logs
npm run dev:tunnel          # same + ngrok tunnel (token from NGROK_AUTHTOKEN or `ngrok config add-authtoken`)
# or, without the in-process tunnel: ngrok http 127.0.0.1:8787
```

Every request except `GET /healthz` needs `X-Tools-Secret: <TOOLS_SECRET>`.
Point each provider's 5 tools at `https://<ngrok-host>/tools/<tool>` (see `config/tools.json`) and also
send `X-Provider: A|B|C` and `X-Call-Id`.

## Testing a provider (Part 3)

```bash
npm run session -- start --provider C --scenario S1 --actor female   # prints the actor script (C = Gemini Live, tested first)
#   ... make the call ...
npm run session -- calls     # what the bot called, right now
npm run session -- end
```

Repeat for S1–S6 per provider, in order C → A → B (A and B only if C does not pass). Then fill `tests/results/manual-inputs.yaml` (copy the `.example`):
language switches, manual checks, latencies the provider doesn't post, cost/min, blind voice scores.

```bash
npm run score -- --manual tests/results/manual-inputs.yaml
```

Writes `results/results.csv` (one row per call) and `results/summary.md` (pass criteria per provider +
decision).

## Smoke test (no provider needed)

```bash
npm run simulate -- --all --with-metrics       # replays each scenario's ideal tool calls as provider SIM
npm run score -- --include-sim                 # SIM is excluded from the decision unless asked
npm run simulate -- --core --base-url https://<ngrok-host>   # verify the tunnel + secret end-to-end
```

## Layout

| Path | What |
|------|------|
| `apps/backend` | Tools server (Fastify). Mock answers now, real Tools API in Part 4 |
| `apps/voice-worker` | Python LiveKit agent: provider C (Gemini Live, tested first), later B — see its README |
| `packages/shared` | Outcome enum, tool schemas, settings schema, time zone + business hours |
| `config/settings.yaml` | Business hours, holidays, retry rules, outcome mapping, pass thresholds |
| `config/prompt.md` | The agent prompt (Hebrew), same for every provider |
| `config/knowledge/` | Study-day knowledge base (placeholders marked `TODO(mishlav)`) |
| `tests/scenarios/` | 6 core scenarios + 8 adversarial, with expected tool calls |
| `scripts/` | `session`, `simulate`, `score-calls`, `export-tools` |
