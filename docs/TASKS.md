# Mishlav Study-Day Bot — Roadmap & Tasks

> Owners: **G** = Guy (voice/providers), **Y** = Yair (system), **G+Y** = together.
> Hours are the PDF estimates. Status: `[x]` done · `[ ]` open · `[~]` partly done / placeholder.

## Milestones

| # | Milestone | Exit criterion | Depends on |
|---|-----------|---------------|-----------|
| M1 | Test infra ready | Tools server + log + scoring running locally, reachable through ngrok with secret | — |
| M2 | Provider C set up | C (Gemini Live) completes one test call end-to-end against the tools server (A, B only if C fails) | M1 |
| M3 | **Provider decision** | C's 6 calls scored (+ A, B if needed); summary shows a winner (or STOP → Mishlav) | M2 |
| M4 | Shared system ready | Importer → Supabase → Dialer → MockProvider → Export passes integration + load tests | M1 (parallel to M2–M3) |
| M5 | Winning branch integrated | Real provider replaces MockProvider; text tests green per commit | M3, M4 |
| M6 | Pilot | 6 real calls via Voice Center from the college number; Mishlav approves defaults | M5 |

```
M1 ──► M2 ──► M3 ──┐
  └──────► M4 ─────┴──► M5 ──► M6
```

---

## Phase 1 — Test infrastructure (~5h, G) → M1

- [x] **1.1 Repo & structure** (~1h) — npm workspaces, `apps/backend`, `packages/shared`, `config/`, `tests/`, `scripts/`, tsconfig, vitest, `.env.example`, README.
- [~] **1.2 Prompt & knowledge** (~2h) — only the real materials are open (blocked on Mishlav)
  - [x] `config/prompt.md` — flow 4.5, rules 4.6, boundaries 4.2, Hebrew lock, voicemail/card rules
  - [~] `config/knowledge/` — 3 study days + `general.md` (placeholders, `TODO(mishlav)`)
  - [ ] Replace placeholders with real Mishlav materials (dates, hours, location, lecturers, cancellation policy)
- [x] **1.3 Tools server with log** (~1h)
  - [x] 5 endpoints with fixed answers, strict schemas, `ok:false` errors
  - [x] Business-hours logic for `schedule_callback` (Sun–Thu 09–17, holidays, DST)
  - [x] Shared-secret auth, `auth_failure` logging
  - [x] JSONL tool log, card-number redaction
  - [x] Test sessions (`/test/session`) + metrics ingestion (`/test/metrics`)
- [x] **1.4 ngrok** (~1h) — `npm run dev:tunnel` (in-process; token from `NGROK_AUTHTOKEN` or ngrok's `ngrok.yml`) or `ngrok http 127.0.0.1:8787`
  - [x] Verified through the tunnel: `/healthz` 200, missing/wrong secret 401 (+ `auth_failure` logged), `simulate --all` 14/14 with 0 failed calls
  - Note: free ngrok gives a new URL on every start → update the provider webhooks each session (or reserve a static domain)
- [x] **1.5 Scenarios & scoring**
  - [x] 6 core scenarios + 8 adversarial, with expectations and ideal tool calls
  - [x] `score-calls` → `results/results.csv` + `results/summary.md` + decision
  - [x] `simulate` smoke test, `session` CLI, `tools:export`
- [x] **1.6 Verify holiday list** in `settings.yaml` against the Hebrew calendar — dates correct; added missing Erev Shvi'i shel Pesach half day (2027-04-27); `apps/backend/test/settings.test.ts` now guards the list
  - [ ] By Aug 2027: add the 5788 holidays (Pesach 2028 on); the test fails from 2027-08-24, when the list stops covering the 60-day callback window
  - [ ] With Mishlav: half-day close time (13:00 test default) and Chol HaMoed calling

## Phase 3 — Provider testing (~10h, G) → M2, M3

> **Order changed by team decision: C → A → B** (PDF: A, B+C). Gemini Live goes first and has top
> priority in the decision (`provider_priority: [C, A, B]`). If C passes all 5 criteria it wins and
> 3.2 / 3.3 are skipped (optional: run them anyway to compare cost).

### 3.1 Provider C — LiveKit + Gemini Live, FIRST (~3h)
- [ ] Accounts: LiveKit Cloud (URL, API key + secret), Gemini API key (AI Studio) → `apps/voice-worker/.env` (Python via `uv` — done)
- [x] Dashboard: `npm run lab` → step-by-step tests, browser-mic calls via LiveKit, live tool calls + transcript, manual form, progress + decision (verified: worker registers with LiveKit, dashboard token dispatches it)
- [ ] Fill `GOOGLE_API_KEY` in `.env`, then a first browser call from the dashboard
- [x] `apps/voice-worker`: Python agent (LiveKit Agents 1.8.11) with Gemini `RealtimeModel` — model `gemini-3.8-live` (confirm exact id against the Gemini API model list at setup); switch `VOICE_PROVIDER=gemini | soniox_eleven` so B reuses it
- [x] Load `config/prompt.md` + knowledge, substitute variables (first_name / day from the active scenario); Hebrew lock via prompt; transcript to `logs/transcripts/`
- [x] 5 function tools (from `config/tools.json`) → POST to tools server with secret, `X-Provider: C`, `X-Call-Id: <room>`; `end_call` hangs up — verified live against the tools server
- [x] Post per-turn metrics (end-of-user-speech → first audio, Gemini TTFA as provider time) to `/test/metrics`
- [ ] Rent LiveKit US number + dispatch rule → agent `mishlav-c` (inbound only; Build plan = 50 free inbound min). No ngrok needed for C
- [ ] One inbound test call → check `GET /test/calls`
- [ ] Run S1–S6 (see 3.4) → score → decide on C before moving on

### 3.2 Provider A — ElevenLabs Agents (~2h) — only if C does not pass
- [ ] Check Twilio plan first: trial ≈ 75 min + verified numbers only; ElevenLabs integration likely needs paid Twilio → upgrade if needed
- [ ] Create agent, paste `config/prompt.md`, upload `config/knowledge/`
- [ ] Define the 5 tools as webhooks → `https://<ngrok>/tools/<name>` with headers `X-Tools-Secret` (secret), `X-Provider: A`, `X-Call-Id: {{system__conversation_id}}`; params from `config/tools.json`
- [ ] Dynamic variables: `first_name`, `bot_name`, `interested_day_id`, `current_datetime`
- [ ] Connect Twilio number; verify team mobiles
- [ ] One outbound test call → check `GET /test/calls`

### 3.3 Provider B — LiveKit + Soniox + ElevenLabs (~1h on top of 3.1) — only if C and A do not pass
- [ ] Soniox + ElevenLabs + LLM keys; `VOICE_PROVIDER=soniox_eleven` in the same worker, `X-Provider: B`
- [ ] One inbound test call on the same LiveKit number

### 3.4 Run the calls (~2h; 6 per provider, in order C → A → B)
- [ ] Before each call: `npm run session -- start --provider <A|B|C> --scenario <S1..S6> --actor <male|female>`
- [ ] Run S1–S6 per provider in order C → A → B; mix male/female actors; some from a mobile outside the office
- [ ] After each call: `npm run session -- end`; save a 10-second clip per provider (label X/Y/Z, blind)
- [ ] Optional: adversarial X1–X8 on the leading provider(s)

### 3.5 Score and decide (~2h)
- [ ] Fill `tests/results/manual-inputs.yaml`: language switches, `behavior_ok`, latencies (A: from dashboard), cost/min, blind voice scores (3 listeners)
- [ ] `npm run score -- --manual tests/results/manual-inputs.yaml`
- [ ] Failed only on latency → tune (turn detection, region, model) and re-run that provider
- [ ] Decision recorded in `results/summary.md`; **no passer → stop and update Mishlav**

## Phase 4 — Shared production build (~43h, Y, parallel from M1) → M4

- [ ] **Supabase** (3h) — schema, migrations, RLS, dev/test/prod projects
- [ ] **Importer** (7h) — Gold Excel ingest, column mapping in config, validation, phone normalisation, dedup, LLM note extraction (`do_not_call, needs_human, interested_day_id, preferred_call_time`), skip `[BOT]` notes, can be disabled when notes are empty
- [ ] **Dialer** (9h) — queue, atomic claim, ≤ 20 concurrent + backoff, block-list check, `call_id → contact_id`, retry rules 4.7, hours + holidays, max attempts, kill switch, dev/test dial team numbers only
- [ ] **Tools API real** (6h) — evolve `apps/backend`: identity from `call_id`, real link sending, task/hot-lead creation, `CallResult` validation, card deletion, active-call check, disable `capture_dictated_details`
- [ ] **Export Feed** (4h) — changed-since endpoint, API key
- [ ] **Notifier** (3h) — WhatsApp/email on hot lead
- [ ] **MockProvider** (2h) — implements `VoiceProvider` with scripted outcomes, delays, drops, voicemail
- [ ] **Tests** (7h) — unit (rules, hours, normalisation, dedup, idempotency, locks, block list, validation), integration (Importer → … → Export), load (20 concurrent, no double dial, no stuck record)
- [ ] **Deploy** (2h) — Render Frankfurt (web + background worker), structured logs per `callId`, `/healthz`, alerts, kill switch

## Phase 5 — Winning branch (G) → M5

### Branch A — ElevenLabs Agents (15h)
- [ ] `ElevenLabsAgentsProvider` + post-call webhook with signature verification (4h)
- [ ] Prompt, tools, extraction fields tuning; agent-as-code via ElevenLabs CLI push/pull (6h)
- [ ] Voicemail (AMD / prompt) + text tests per commit via ElevenLabs agent tests (2h)
- [ ] Voice Center SIP trunk → ElevenLabs, test from the college number (3h)

### Branch B — LiveKit + Soniox + ElevenLabs (21h)
- [ ] `LiveKitProvider` + production `voice-worker` (6h)
- [ ] Post-call LLM extraction → `CallResult` (2h)
- [ ] Prompt, tools, latency tuning across 3 stages (6h)
- [ ] Own voicemail detection (2h) · text tests (2h)
- [ ] Voice Center outbound trunk + deploy to LiveKit Cloud (3h)

### Branch C — LiveKit + Gemini Live (19h)
- [ ] `LiveKitProvider` + `voice-worker` with Gemini `RealtimeModel` (5h)
- [ ] Post-call extraction (2h) · prompt, tools, Hebrew lock (5h)
- [ ] Voicemail (2h) · text tests incl. language-switch test (2h)
- [ ] Voice Center outbound trunk + deploy (3h)

## Phase 6 — Pilot (G+Y) → M6
- [ ] 6 scenarios as real calls before every deploy
- [ ] Final run via Voice Center from the college number
- [ ] Adversarial scripts on the production stack
- [ ] Mishlav sign-off on 4.7 defaults

## Open with Mishlav (non-blocking)
- [ ] Sample Gold Excel (columns, activity id, notes content)
- [ ] How Gold pulls results
- [ ] Link channel: SMS or WhatsApp
- [ ] Approve 4.7 defaults; confirm list is permitted for marketing outreach
- [ ] Call recording yes/no (if yes → opening announcement)
- [ ] Real study-day materials for the knowledge base
