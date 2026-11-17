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
- [x] Accounts: LiveKit Cloud (URL, API key + secret), Gemini API key (AI Studio) → `apps/voice-worker/.env` (Python via `uv` — done)
- [x] Dashboard: `npm run lab` → step-by-step tests, browser-mic calls via LiveKit, live tool calls + transcript, manual form, progress + decision (verified: worker registers with LiveKit, dashboard token dispatches it)
- [x] Fill `GOOGLE_API_KEY` in `.env`, then a first browser call from the dashboard (Live API needs `api_version=v1alpha`)
- [x] `apps/voice-worker`: Python agent (LiveKit Agents 1.8.11) with Gemini `RealtimeModel` — model `gemini-3.8-live` (confirm exact id against the Gemini API model list at setup); switch `VOICE_PROVIDER=gemini | soniox_eleven` so B reuses it
- [x] Load `config/prompt.md` + knowledge, substitute variables (first_name / day from the active scenario); Hebrew lock via prompt; transcript to `logs/transcripts/`
- [x] 5 function tools (from `config/tools.json`) → POST to tools server with secret, `X-Provider: C`, `X-Call-Id: <room>`; `end_call` hangs up — verified live against the tools server
- [x] Post per-turn metrics (end-of-user-speech → first audio, Gemini TTFA as provider time) to `/test/metrics`
- [ ] Rent LiveKit US number + dispatch rule → agent `mishlav-c` (inbound only; Build plan = 50 free inbound min). No ngrok needed for C
- [x] Israeli number without LiveKit: `apps/phone` (`npm run phone`) — Zadarma SIP line (+972555172508) ↔ Gemini Live `gemini-3.1-flash-live-preview`, same prompt/knowledge/tools, inbound + outbound; SIP code from `gemini-live-agent`. Verified: registration, and a text-driven call against real Gemini + tools server (opening, `get_day_info`, `end_call`)
- [ ] First real call on the Zadarma number → read `logs/transcripts/`, `logs/tool-calls.jsonl`
- [ ] One inbound test call → check `GET /test/calls`
- [~] Run S1–S6 (see 3.4) → score → decide on C before moving on — first browser round done: all tool calls right; S2/S3/S6 to redo by the script; fixes after round 1: latency measurement (side-channel VAD), double opening, English line after hang-up, "other date" prompt rule + X9

### 3.2 Provider A — ElevenLabs Agents (~2h) — set up in parallel to C (team request)
- [x] Agent as code: `npm run eleven:sync` creates/updates the agent from the repo (prompt + knowledge rendered by the worker's own code, Hebrew `he`, LLM `gemini-3.8-flash`, TTS `eleven_v4_turbo` — the Agents model with Hebrew), ids in `.elevenlabs.json` (git-ignored)
- [x] 5 webhook tools from `config/tools.json` → `<tunnel>/tools/<name>` with `X-Tools-Secret`, `X-Provider: A`, `X-Call-Id: {{system__conversation_id}}`; `npm run lab` opens the ngrok tunnel and re-points the tools on every start
- [x] Dynamic variables from `GET /test/context` (`first_name`, `bot_name`, `interested_day_id`, `current_datetime`, `customer_context`)
- [x] Dashboard: browser call via `@elevenlabs/client` (WebRTC token from the server), transcript, latency measured in the browser (end of mic speech → agent speaking), duration + cost from the ElevenLabs API, hang-up after `end_call`
- [x] Verified: text conversation (`npm run eleven:text`) through the tunnel — Hebrew, tools logged with `X-Provider: A` + conversation id
- [ ] First browser voice call from the dashboard; then S1–S6
- [ ] Phone (optional for the decision): Twilio number or SIP → ElevenLabs; trial ≈ 75 min + verified numbers only

### 3.3 Provider B — LiveKit + Soniox + ElevenLabs (~1h on top of 3.1) — built, waiting for a Soniox key
- [x] Same worker, `VOICE_PROVIDER=soniox_eleven` (`mishlav_worker/pipeline_b.py`): Soniox `stt-rt-v5` (Hebrew hint + domain context, endpoint detection as turn detection) → `gemini-3.8-flash` → ElevenLabs `eleven_v4_turbo`; Silero VAD for barge-in; agent `mishlav-b`, `X-Provider: B`; `npm run lab` starts it next to C (port 8082)
- [ ] `SONIOX_API_KEY` in `.env` (https://console.soniox.com), then a first browser call
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

- [ ] **Supabase** (3h) — schema, migrations, RLS, dev/test/prod projects. Started: project `mishlav-bots` (org "g", eu-central-1, ref otimdvfajyywwkkwccyz), `supabase/migrations`: `contacts` = exact copy of the Gold export (16 columns, nothing of ours), internal `bot_state` (bot status, attempts, `no_answer_streak`, `ever_answered`, next dial, `phone_index`, `gold_changed_at`), `calls`, `rep_tasks`, all keyed by `gold_record_id`; RLS on, service role only. `supabase/seed.sql` = 10 fake students (all phones = Guy's test number)
- [ ] **Importer** (7h) — Gold Excel ingest, column mapping in config (done: `gold_import` in settings.yaml; `scripts/gold-sample-to-sql.py` is a stop-gap), validation, phone normalisation, dedup, LLM note extraction (`do_not_call, needs_human, interested_day_id, preferred_call_time`), skip `[הערת הבוט]` notes (older ones: `[BOT]`), can be disabled when notes are empty
- [ ] **Dialer** (9h) — queue, atomic claim, ≤ 20 concurrent + backoff, block-list check, `call_id → contact_id`, retry rules 4.7, hours + holidays, max attempts, kill switch, dev/test dial team numbers only. Done: what each call leaves in `bot_state` (migration `20261117030000_no_answer_streak`): after a no-result call the next dial follows `dialing.no_answer_retry` (5 h same day → next business day → 2 business days, other half of the day; **proposal, to confirm with Mishlav**), stop at 4 in a row without a result or 8 calls in all → closed (never answered) or a rep task `unreachable` (answered once). The dialer picks `bot_status in (new, queued, callback)` with `next_call_at` null or passed. (the old 4-argument `bot_call_ended` was dropped after the deploy: 20261117050000_drop_old_call_ended.sql). Done (one call at a time, the line's limit): `apps/backend/src/dialer.ts` + migration `20261118000000_dialer` - on/off in Supabase (`dialer_control`, starts off, survives deploys; replaces `kill_switch`), `bot_next_due` (callback → queued → new), no valid phone → `bot_mark_no_phone` (wrong_number), `DIALER_ONLY_NUMBERS` for tests, ring timeout `dialing.ring_timeout_s`, 3 system failures in a row → off with the reason, `calls.origin` dialer/manual, routes `GET /api/admin/dialer`, `POST /api/admin/dialer/start|stop`. Left: concurrency (needs more than one line)
- [ ] **Tools API real** (6h) — evolve `apps/backend`: identity from `call_id` (done for Supabase contacts: `apps/backend/src/contacts.ts` + SQL `bot_call_started` / `bot_tool_event` / `bot_call_ended` write the result into Gold's own fields - a `[הערת הבוט]` line (Hebrew only) appended to "הערות" and the "סטטוס" text from `gold_status_text()` (temporary texts until Mishlav sends their list) - plus bot_state, rep_tasks; wrong number moves to phone 2 / phone 3), real link sending (done: `apps/backend/src/sms.ts`, Zadarma for tests / log only without keys, recipient from the call; left: Mishlav's provider + registered sender, real `purchase_url`s), task/hot-lead creation, `request_human` adds a note on the existing lead ("a rep should call back", with the reason; the phone is on file, never asked), `CallResult` validation, card deletion, active-call check (`capture_dictated_details` already off)
- [ ] **Export Feed** (4h) — changed-since endpoint, API key. Done: `GET /api/gold/changes?since=` with `X-Api-Key: GOLD_API_KEY` (only the Excel's 16 columns under its Hebrew headers + `until`; dashboard: "מה גולד יקבל"). Left: Gold's side of the daily pull, Mishlav's real status list
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
