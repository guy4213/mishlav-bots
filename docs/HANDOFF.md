# Handoff: provider testing (Phase 3)

From Guy to Yair, 2026-11-10. Everything below is committed on `main` (`4877c6c`).

## Where we are

We are in **Phase 3, provider testing** (`docs/TASKS.md` §3). The question is which provider handles a Hebrew
sales call best. Guy's impression so far: **provider A (ElevenLabs Agents) sounds the most human** ("almost like
talking to a person"). The work of the last days was making our own logic around it solid: what the bot says,
when it hands off to a rep, and how a call ends.

| Provider | Stack | State |
|---|---|---|
| **A** | ElevenLabs Agents (LLM `gemini-3.8-flash`, TTS `eleven_v4_turbo`) | Works end to end from the dashboard. **The ElevenLabs key in `.env` is out of credits** (see Accounts) |
| **C** | LiveKit + Gemini Live `gemini-3.8-live-extended-thinking`, `GEMINI_LANGUAGE=he-IL` | Works; understands well; talks too much around tool calls (see Known issues) |
| **B** | LiveKit + Soniox + ElevenLabs | Built, never run: needs `SONIOX_API_KEY` |

## Run it

```
npm install
cd apps/voice-worker && uv sync && cd ../..
npm run lab        # tools server + ngrok tunnel + ElevenLabs agent sync + C/B workers
```

Dashboard: http://127.0.0.1:8787/dashboard. Pick a provider and a scenario, call from the browser, then answer
the 👀 lines. **Restart `npm run lab` after any change** to the prompt, the tools or the server: the ElevenLabs
agent is re-synced only at startup.

Keys go in `.env` (see `.env.example`): `TOOLS_SECRET`, `GOOGLE_API_KEY`, `LIVEKIT_*`, the ElevenLabs key,
`GEMINI_MODEL`, `GEMINI_LANGUAGE`, and `SONIOX_API_KEY` for B. Never commit `.env`.

## Tests: run these before telling Guy something works

| Command | What it checks | Cost |
|---|---|---|
| `npm test` (82) + `npm run worker:test` (19) | Server, scoring, hang-up rule, worker | free |
| `npm run text:all [-- -s X6 -s R4]` | **Every scenario as a text conversation** against `gemini-3.8-flash` (A's brain), same prompt + tools, scored like the dashboard. Isolated: writes to `logs/text-runs/<time>/` (`transcripts.md` for the 👀 checks), never to the dashboard logs | cents of Gemini |
| `npm run simulate -- --all` | Replays each scenario's ideal tool calls (logic only, no model) | free |
| Voice call from the dashboard | The real thing: voice, barge-in, hang-up timing | ElevenLabs credits (A) |

`text:all` reproduced every real bug below before it was fixed. Use it first; spend voice credits only on what
text can't show. Last full run: no crashes, every closing said goodbye, voicemail stayed silent. S1 fails only
because the hotel name is a `TODO(mishlav)` placeholder.

## Decisions and why (don't undo these by accident)

1. **Context, not rules.** Guy is firm: no word lists, no dictionaries, no piles of restrictions in the prompt.
   Give the model correct context instead, and enforce hard limits in code. Each call gets a facts-only
   `{{customer_context}}` (`apps/backend/src/context.ts`). Tool descriptions and tool responses must say what
   really happens: `schedule_callback` *notes* a request (there is no calendar), and `request_human` is *not* a live
   transfer. Wrong descriptions caused "updating the calendar" and silent hand-offs.
2. **On ElevenLabs our `end_call` is called `finish_call`** (`scripts/lib/elevenlabs.ts`, `ELEVEN_TOOL_NAME`).
   `end_call` is ElevenLabs' own system tool name. With our tool under that name, ElevenLabs dropped the line
   5 ms after it returned, mid-sentence: disconnect `reason: agent, type: end_call`. The webhook still posts to
   `/tools/end_call`, so logs and scoring are unchanged.
3. **The goodbye is said after the end-call result.** ElevenLabs runs tools first and speaks afterwards. The
   `end_call` response (`END_CALL_SAY_GOODBYE` in `apps/backend/src/tools/handlers.ts`) says: "if the customer
   hasn't heard what happens next and a goodbye, say it now; if you already did, say nothing more". Voicemail
   gets "say nothing". An earlier "say nothing more" in every case produced silent hang-ups. An earlier "just
   say goodbye" produced a second response that cut the first one.
4. **The dashboard hangs up A calls itself** (`elHangupDue` in `apps/backend/dashboard/index.html`, tested in
   `apps/backend/test/hangup-rule.test.ts`). After `finish_call` it waits for the goodbye to start, then for
   2.5 s of continuous silence. ElevenLabs reports short silences mid-sentence. If no goodbye has started after
   8 s it hangs up anyway (voicemail), and 25 s is the hard cap. Every A call writes a timeline (mode changes,
   tools, who disconnected) to `logs/events/<conversation>.jsonl`. **Read that first** when a call "cuts off".
5. **When to hand off to a rep** (prompt, `request_human` line): only when the customer
   - explicitly asks for a person (`wants_human`),
   - asks for a discount (`discount_request`; Guy: reps may sometimes give one, don't lose the lead),
   - pays through the company (`company_purchase`),
   - insists on paying via a rep after hearing about the link (`pay_via_rep`),
   - asks about another course (`course_interest`, new, maps to **HOT_LEAD**),
   - asks a real question with no answer in the knowledge base (`other`).

   **Not** for injection or impersonation attempts (refuse politely, return to the topic, end if they insist).
   Not for paying by phone or reading out a card (explain the link). Not for a study day that doesn't exist
   (say so and offer the real ones; the bot knows the whole catalogue). The goal is less work for reps, not more.
6. **Opening:** "היי {{first_name}}, אני נועה, נציגת הבינה המלאכותית של מכללת מישלב". Written in Hebrew words:
   TTS read "AI" as "איי איי". Answer "how are you?" like a person before the pitch.
7. **Gemini Live specifics** (`apps/voice-worker`):
   - `api_version=v1alpha` (else 404).
   - The extended model needs non-blocking tools and `GEMINI_LANGUAGE=he-IL`. Without it, it "heard" Portuguese.
   - **Never send `scheduling` on a tool response**: the extended model closes the session with 1007. LiveKit
     marks some outputs SILENT on its own. `mishlav_worker/gemini_compat.py` patches that out, with a test.

## Known issues and next steps (in order)

1. **Untested prompt changes.** The latest hand-off and security changes (point 5 above, plus X6) were checked
   in text only for X6. Run `npm run text:all -- -s X1 -s X2 -s X3 -s X4 -s X5 -s X7 -s X8 -s R3 -s R4 -s S3`
   and read `transcripts.md`. Expected: no rep on X1/X2/X3/X7/X8, a rep on X5/R3/R4/S3, R3 scored HOT_LEAD.
2. **Provider A voice round** with a key that has credits: S1–S6, R1–R7, X1–X9. Watch the closings and
   `logs/events/`.
3. **Provider C hang-up vs. goodbye.** In `mishlav_worker/tools.py` C mutes everything after `end_call`, the
   opposite of A. If the model calls `end_call` before saying goodbye, as A's model does, C's goodbye is muted.
   The extended model also says filler lines ("I'm checking...") and sometimes repeats an answer when a tool
   result arrives late. Only matters if C stays in the race.
4. **Dashboard session mix-up.** If a C session is still open when you switch to A, A's tool calls are logged
   under the C session (seen in R7). Close the session ("finished the call") before switching, or make the
   dashboard close it automatically.
5. **Mishlav data.** `config/knowledge/` is still placeholders (`TODO(mishlav)`): hotel name, lecturers,
   agenda, cancellation policy. S1 can't pass until the hotel is known. Don't invent it.
6. **B:** get a Soniox key, then one browser call.
7. **Score and decide** (`docs/TASKS.md` §3.5): manual inputs, `npm run score`, decision in `results/summary.md`.
8. Phone: LiveKit US number + dispatch rule for B/C; Twilio/SIP for A (optional for the decision).

## Accounts and money

- **ElevenLabs:** the key in `.env` is on the free plan and used up: 51 of 10,000 credits left, resets
  2026-12-08. About 1,000 credits ≈ 1 minute of conversation. Guy has a second account with 10,000; swap the key
  and `npm run lab` creates the agent there. **Ask Guy before running any ElevenLabs conversation, voice or
  text.** It spends his credits.
- **Gemini** (Google key): text runs cost cents. The Live API (C) is billed per minute.
- **Recordings and transcripts of real Mishlav calls contain personal data.** Get Mishlav's approval before
  sending them to any external service. `docs/CALL_INSIGHTS.md` has no phone numbers.

## Working with Guy

- Hebrew in conversation; short, simple and transparent. Say what you're doing and why before doing it.
- Don't over-engineer. Don't fix the model with word lists.
- Check yourself before saying it works. Use `text:all`, then the logs. Several "fixed" claims today were
  wrong until the call timeline (`logs/events/`) showed the real cause.
- Commit and push only when he asks.
