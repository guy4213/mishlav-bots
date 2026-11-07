# Mishlav Study-Day Bot — Macro Spec

> Source: `mishlav_study_day_bot_spec_v5.pdf` (v5, 07.11.2026, GY Software).
> This document is the high-level "what and why". The "how" is in [TECHNICAL_SPEC.md](TECHNICAL_SPEC.md); the "when and who" is in [TASKS.md](TASKS.md).

## 1. Goal

An outbound Hebrew voice bot for **Mishlav College** that calls leads who showed interest in the
**study days for payroll accountants** (ימי עיון לחשבי שכר). The bot:

- opens the call, finds the relevant study day, answers questions from a fixed knowledge base only,
- sends a purchase link, schedules a callback, or hands off to a human rep,
- never takes payment, never gives discounts, never invents information,
- writes a structured outcome back to the college's CRM (Gold) through our backend.

## 2. Main risk and sequencing

**Biggest risk: no provider understands Hebrew well enough over the phone.**
So we test that first, on a small, cheap infrastructure — not after building the whole system.

| # | Part | Depends on | Est. hours |
|---|------|-----------|-----------|
| 1 | **Test infrastructure** (shared by all providers) | — | ~5 |
| 2 | The three candidate providers (description only) | — | — |
| 3 | **Provider testing**: setup + 18 calls → **provider decision** | Part 1 | ~10 |
| 4a | **Shared production build** (4.1–4.9) — starts in parallel with Part 3, provider-independent | Part 1 (tools server) | ~43 |
| 4b | **Winning branch**: A / B / C | Part 3 decision | ~15 / 21 / 19 |
| | **Total by winning branch** | | **A ~73 · B ~79 · C ~77** |

## 3. Part 1 — Test infrastructure

A minimal test bot built from three pieces. Pieces 1 and 2 are **identical for every provider**;
only piece 3 changes. That keeps the comparison fair.

| # | Piece | What it is |
|---|-------|-----------|
| 1 | `prompt.md` + `knowledge/` | What the bot knows and how it talks |
| 2 | Tools server (Node/TS) | 5 endpoints, fixed answers + log of every call |
| 3 | Provider connection | Each provider connects to pieces 1 and 2 |

**Nothing here is thrown away.** The prompt and knowledge base are the production ones, and the
tools server grows into the real Tools API (4.1).

The five tools:

| Tool | Input | Test-mode answer |
|------|-------|-----------------|
| `get_day_info` | `day_id` | Day details from the knowledge base |
| `send_purchase_link` | `day_id` | "sent" (no real SMS) |
| `schedule_callback` | requested time | The time, or an alternative if outside business hours |
| `request_human` | `reason` (closed list) | "handed to a rep" |
| `end_call` | — | — |

The server runs locally, is exposed to providers through **ngrok**, and is protected with a
**shared secret header** from day one.

A **results sheet** has one row per call (provider, scenario, actor, tools invoked + params, correct
outcome?, language switch?, phone correct digit-by-digit?, avg/max response time, provider processing
time, call cost). A `score-calls` script fills most columns automatically from the tool log.

## 4. Part 2 — The candidate providers

| | A: ElevenLabs Agents | B: LiveKit + Soniox + ElevenLabs | C: LiveKit + Gemini Live |
|---|---|---|---|
| Shape | Full platform: STT (Scribe), LLM, TTS (v4 Turbo), telephony | Soniox STT → LLM → ElevenLabs TTS, orchestrated by LiveKit | One speech-to-speech model, orchestrated by LiveKit |
| Strong | Fastest to stand up; best-proven Hebrew voice | Strongest proof of Hebrew STT (Israeli companies in production); every part swappable | Low latency, natural flow, built-in interruption and tools |
| Weak | No production proof of Hebrew phone STT in Israel; single-vendor lock-in | More moving parts; latency adds up across 3 stages | Reports of v3.8 not recognising "כן" and switching language; language lock only via prompt; no voice cloning |
| Accounts | ElevenLabs, Twilio | LiveKit Cloud, Soniox, ElevenLabs (own key), LLM key | LiveKit Cloud (Google key optional via LiveKit Inference) |
| Our own voice code | None | Python `voice-worker` | Python `voice-worker` |

**What LiveKit does:** Soniox and Gemini are only models — they don't answer phones. LiveKit bridges
them to the phone call: SIP in/out, audio streaming, end-of-turn detection, interruption, and calling
our tools. ElevenLabs Agents has all of this built in, so branch A has no LiveKit.

## 5. Part 3 — How each provider is tested

**Setup**
- **A (~2h):** agent in the ElevenLabs dashboard with `prompt.md` + knowledge; 5 tools as webhooks to
  the ngrok URL; Twilio number connected; team mobiles verified; **bot calls the team** (outbound).
  *Check first:* Twilio trial ≈ 75 min and verified numbers only; ElevenLabs' Twilio integration likely
  needs a paid Twilio account (tens of dollars).
- **B + C (~4h):** one Python LiveKit agent (Voice AI Quickstart) with a switch
  `VOICE_PROVIDER=soniox_eleven | gemini`; same prompt, same 5 tools → same tools server; LiveKit's free
  US number; **team calls the bot** (inbound only for now). *Note:* calling a US number may cost money;
  the Build plan includes 50 free inbound minutes.

**Scenarios (6 per provider, 18 total).** Two team members (male + female) play the customer, some
calls from a mobile outside the office.

| # | Scenario | Expected |
|---|----------|----------|
| 1 | Wants to register: "yes", asks price and location, asks for link | `LINK_SENT` |
| 2 | Busy: "call me back next Tuesday at ten" | `CALLBACK` at the right time |
| 3 | Phone and name: asks for a rep, dictates number and name | `HOT_LEAD` with correct details |
| 4 | Interruption and noise: street noise, interrupts, talks fast | Bot stops and continues correctly |
| 5 | Removal with English: "יש לי zoom עכשיו, ותורידי אותי מהרשימה" | `DO_NOT_CALL`, no switch to English |
| 6 | Voicemail | `VOICEMAIL`, hang up without a message |

Plus adversarial scripts (4.8): prompt injection in Hebrew and English, fishing for another customer's
data, "send the link to a different number", discount request, non-existent study day, reading out a
credit card (and verifying it's not stored), impersonation.

**What we measure**
- **Understanding:** the right tool with the right parameters — **from the tool log, not the
  transcript** (so Gemini's speech-to-speech is judged fairly).
- **Language:** Hebrew throughout.
- **Response time:** end of customer speech → start of reply; separately, provider processing time
  (so a provider isn't disqualified for the US network path).
- **Voice:** 1–5 from three blind listeners (10-second clips labelled X/Y/Z).
- **Cost per minute:** including telephony and LLM, from each provider's dashboard.

**Pass criteria (all required)**
1. Correct understanding in all 6 scenarios.
2. Zero language switches.
3. Phone number correct digit-by-digit.
4. Average response time ≤ 1.2 s and no single response > 2 s.
5. Average voice score ≥ 4.

**Decision rule.** Whoever passes all criteria. If several pass: **A, then C, then B** (by maintenance
simplicity); cost per minute decides when results are close. Failed only on latency → tune first, then
disqualify. **No provider passed → stop and update Mishlav before continuing.**

## 6. Part 4 — Production build

### 6.1 Shared by every branch (4.1–4.9)

| Component | Purpose |
|-----------|---------|
| **Importer** | Ingest the Gold Excel export: validation, phone normalisation, dedup, LLM extraction of fields from notes, load to Supabase. Column mapping in config. |
| **Supabase** | Source of truth: contacts, dial queue, call attempts, results, block list, import/export, audit log. Separate projects for dev / test / prod. |
| **Dialer** | Picks contacts by dialing rules, atomic locking, up to 20 concurrent calls (subject to provider quotas, with backoff). Checks the block list and stores `call_id → contact_id` before each dial. |
| **Tools API** | The Part 1 tools server with real logic instead of fixed answers. |
| **Export Feed** | All results changed since Gold's last pull, protected by API key. |
| **Notifier** | Instant alert to a rep on a hot lead (WhatsApp or email). |
| **VoiceProvider interface** | The voice layer behind one interface; each branch implements it, plus a `MockProvider` for tests. |
| **Deployment** | Render (Frankfurt): web service for Tools API + Export, background worker for the Dialer. No static IP needed. |

**Agent architecture.** The conversation is a *bounded ReAct loop* run by the provider; everything
around it is plain code with no LLM. Not Plan-then-Execute (can't plan a conversation, adds latency),
not multi-agent. "Bounded" = 5 tools, one tool call per turn, no tool that can do damage.
**Two boundaries:** the prompt decides what the bot *says* (can be bypassed); tools and code decide what
it *can do* (cannot be bypassed). Every critical prohibition is also enforced in code.
**The model proposes, the backend decides.** No tool takes a phone, price, URL or `contact_id`. No DB
or Gold write tool. No discount or payment tool.

**Security and data.** Identity resolved server-side via `call_id → contact_id`; minimal `CallContext`
(first name, study day, extracted fields, previous outcomes from a closed list — no ID number, phones,
raw notes, other customers); raw Gold notes never reach the bot (separate LLM extraction at import);
bot notes prefixed `[BOT]` and skipped on import; endpoint auth by secret or provider signature +
active-call check; Supabase service key server-only, RLS everywhere; any 13–19 digit run deleted before
storing transcript/summary; post-call `CallResult` validated against closed lists and legal dates;
max call duration set in the agent.

**Conversation flow (4.5).** Opening → which day (by interest, or topic + Zoom/hotel; never read all
dates) → details from knowledge → questions (knowledge only; unknown → `request_human`) → interest check
("send you a registration link?") → **one** persuasion attempt (50% of ICPA requirement; 300 ₪ benefit
for a course with 2+ days) → close: buys alone → `LINK_SENT`; rep for payment → `HOT_LEAD`; company
pays → `COMPANY`. "Link sent" is the end for the bot; Gold gets "purchase link sent" (not "registered"),
and a rep follow-up opens in 3 days.

**Business rules (4.6).** Payment: link only; stop a customer reading a card; never confirm
registration. Discounts: never; any request → `request_human(discount_request)` + hot lead.
Information: knowledge base only; otherwise "a rep will get back to you".

**Outcomes and retries (4.7).**

| Call again | When |
|-----------|------|
| `NO_ANSWER` / `BUSY` / `VOICEMAIL` | In 3 hours; after end of day → next business morning |
| `DROPPED` | In 1 hour, counts as an attempt |
| `CALLBACK` | At the requested time, within business hours |
| `FAILED` | In 15 minutes, does not count as an attempt |
| `WRONG_NUMBER` | Phone 2, then phone 3, otherwise close |

| Don't call again | Why |
|-----------------|-----|
| `LINK_SENT` | Bot done; rep follow-up in 3 days |
| `HOT_LEAD` / `COMPANY` / `HUMAN_FOLLOWUP` | Handed to a rep |
| `NOT_INTERESTED` | After one persuasion attempt |
| `ALREADY_REGISTERED` | Closed |
| `DO_NOT_CALL` | Permanent block by phone, checked before every dial, synced to Gold |
| `closed_max_attempts` | After 4 attempts |
| Closed / "not interested" in Gold, or missing from the new file | Never enters the queue |

Test defaults (in `settings.yaml`, to be approved by Mishlav): 3 h between attempts · 4 attempts ·
follow-up after 3 days · Sun–Thu 09:00–17:00 · no Fri/Sat/holidays · `Asia/Jerusalem` incl. DST ·
kill switch stops new dials, active calls finish normally.

**Testing and monitoring (4.8).** dev/test/prod (dev+test dial team numbers only); unit
(retry rules, hours, normalisation, dedup, idempotency, locks, block list, tool + extraction
validation); integration (Importer → Supabase → Dialer → MockProvider → results → Export, incl.
delays, drops, voicemail); load (20 concurrent, no double dial, no stuck record); automated text tests
per commit (branch-specific); 6 real calls before every deploy and finally through Voice Center from the
college number; adversarial scripts; structured logs per `callId`, `/healthz` per service, alerts on
latency or failure-rate anomalies.

**Not built (4.4):** planner, multi-agent, real-time LLM-as-judge, RAG/vector DB for several study
days, policy engine, human approval per action, automatic provider failover (only stop dialing when the
provider is down).

### 6.2 Branches

| | A — ElevenLabs Agents | B — LiveKit + Soniox + ElevenLabs | C — LiveKit + Gemini Live |
|---|---|---|---|
| Call path | Dialer → ElevenLabs outbound API (CallContext as dynamic vars) → Voice Center SIP trunk → tools as webhooks → post-call webhook | Dialer → LiveKit SIP participant via Voice Center outbound trunk → `voice-worker` joins room with CallContext → tools as worker functions → worker posts `CallResult` | Same as B |
| We build | `ElevenLabsAgentsProvider`, agent-as-code via ElevenLabs CLI, voicemail (AMD/prompt), Voice Center SIP, built-in agent tests per commit | `LiveKitProvider`, production `voice-worker` (Soniox STT w/ Hebrew hints, LLM, ElevenLabs TTS, turn detection, interruption), post-call LLM extraction, own voicemail detection, text tests | Same `LiveKitProvider` + `voice-worker` with Gemini `RealtimeModel`; Hebrew lock via prompt + dedicated language-switch text test + production monitoring |
| Hours | 15 | 21 | 19 |

## 7. Work split

- **Guy:** Part 1, Part 3, and the winning branch (voice).
- **Yair:** shared Part 4.1–4.9 (the system), in parallel with provider testing, against `MockProvider`.
- **Together:** testing, Voice Center connection, pilot.

## 8. Open items with Mishlav (not blocking)

- Sample Gold Excel file — columns, activity ID, what's in the notes.
- How Gold pulls results.
- Link channel: SMS or WhatsApp.
- Approve 4.7 defaults, and that the list is permitted for marketing outreach.
- Call recording yes/no (if yes — announcement at the opening).
- Real study-day materials for the knowledge base (currently placeholders).

## 9. Deviations from the PDF (agreed)

| Item | PDF | This repo | Why |
|------|-----|-----------|-----|
| `end_call` | No parameters | Optional `reason` from a closed list | Scenarios 5–6 (`DO_NOT_CALL`, `VOICEMAIL`) must be scored from the log, not the transcript |
| `request_human` | `reason` only | + test-only `name`, `phone`, enabled by `testing.capture_dictated_details` | Scenario 3 checks the dictated phone digit-by-digit; disabled in production per 4.2 |
