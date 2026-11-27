/**
 * Dialing one contact, the same way for the dashboard's "call" button (routes/phone.ts) and the automatic dialer
 * (dialer.ts): load it, never a do-not-call, its phone in use, dial with its name / day / gender, and follow the
 * call so the contact's record is linked now and closed when the line says the call ended (with its transcript
 * stored in calls.transcript, so the dashboard's history survives a deploy).
 */
import { notesForBot, summarizeIfLong } from "./notes";
import { noAnswerRetryTimes, type Settings } from "@mishlav/shared";
import type { CallEnded, CallOptions, PhoneLine } from "../../phone/src/line.js";
import { aiCostUsd } from "./ai-cost";
import { type CallInfo, type CallOrigin, type ContactEvents, type ContactRecord, dialNumber, firstName, toE164 } from "./contacts";
import { readTranscript, transcriptForDb } from "./transcripts";

/** when the line said the call ended, and its Gemini tokens */
type Ended = { at: number; usage?: CallEnded["usage"]; recording?: string };

/** The line's 'ended' events, caught from now on (one can come right after dial() returns). */
interface EndWatch {
  ended: Map<string, Ended>;
  onEnded: (e: CallEnded) => void;
}

function watchEnded(line: PhoneLine): EndWatch {
  const ended = new Map<string, Ended>();
  const onEnded = (e: CallEnded) => ended.set(e.call_id, { at: Date.now(), usage: e.usage, recording: e.recording });
  line.on("ended", onEnded);
  return { ended, onEnded };
}

export interface DialDeps {
  contacts: ContactEvents;
  settings: Settings;
  line: PhoneLine;
  /** where the line writes each call's transcript (logs/transcripts); none: not stored in the database */
  transcriptsDir?: string;
}

export interface DialOptions extends Omit<CallOptions, "gender" | "ringTimeoutMs" | "notes"> {
  origin: CallOrigin;
  /** dial this number instead of the contact's (dashboard tests) */
  number?: string;
  /** false: don't dial this number (the dialer's DIALER_ONLY_NUMBERS) */
  allowNumber?: (number: string) => boolean;
}

export type DialError = "unknown_contact" | "do_not_call" | "no_phone" | "not_allowed" | "supabase_error" | "dial_failed";

export type DialResult =
  | { ok: true; call_id: string; contact: ContactRecord; number: string; ended: Promise<void> }
  | { ok: false; error: DialError; message_he: string };

/** The ring timeout every outgoing call gets (settings.yaml dialing.ring_timeout_s). */
export const ringTimeoutMs = (settings: Settings) => Math.round(settings.dialing.ring_timeout_s * 1000);

export async function dialContact(deps: DialDeps, goldRecordId: string, opts: DialOptions): Promise<DialResult> {
  const { origin, number, allowNumber, ...callOpts } = opts;
  let contact: ContactRecord | null;
  try {
    contact = await deps.contacts.store.get(goldRecordId);
  } catch (err) {
    return { ok: false, error: "supabase_error", message_he: (err as Error).message };
  }
  if (!contact) return { ok: false, error: "unknown_contact", message_he: "אין איש קשר כזה" };
  if (contact.bot_state?.bot_status === "do_not_call") {
    return { ok: false, error: "do_not_call", message_he: "ביקש לא להתקשר אליו – לא מחייגים" };
  }
  // the contact's phone in use (phone / phone2 / phone3 after a wrong number), as +972...
  const toDial = number ?? dialNumber(contact);
  if (!toDial) return { ok: false, error: "no_phone", message_he: "לאיש הקשר אין מספר טלפון תקין" };
  if (allowNumber && !allowNumber(toDial)) {
    return { ok: false, error: "not_allowed", message_he: "המספר לא ברשימת המספרים המותרים (DIALER_ONLY_NUMBERS)" };
  }
  const { line } = deps;
  const watch = watchEnded(line);
  // the voice the team picked in the dashboard (a test call can try another); Supabase down: the line's own
  const voice = callOpts.voice || ((await deps.contacts.store.botVoice?.().catch(() => null)) ?? undefined);
  let callId: string;
  try {
    ({ call_id: callId } = await line.dial(toDial, {
      ...callOpts,
      voice,
      name: callOpts.name ?? firstName(contact.full_name) ?? undefined,
      day: callOpts.day ?? contact.bot_state?.interested_day_id ?? undefined,
      gender: contact.bot_state?.customer_gender ?? undefined,
      notes: notesForBot(contact.notes), // the reps' notes + the bot's summary and lines since (notes.ts)
      ringTimeoutMs: ringTimeoutMs(deps.settings),
    }));
  } catch (err) {
    line.off("ended", watch.onEnded);
    return { ok: false, error: "dial_failed", message_he: (err as Error).message };
  }
  const info: CallInfo = { number: toDial, direction: "out", ...(callOpts.scenario ? { scenario: callOpts.scenario } : {}) };
  const done = trackCall(deps, callId, { goldRecordId: contact.gold_record_id, origin, info }, watch);
  return { ok: true, call_id: callId, contact, number: toDial, ended: done };
}

/** What a test call without a contact keeps: its line, and Supabase (none: the call is only on this server's disk). */
export interface TestCallDeps extends Omit<DialDeps, "contacts"> {
  contacts?: ContactEvents;
}

/**
 * A test call to a number that is no contact (the dashboard's "בדיקות" with a typed number, a team member's
 * "שיחה אליי"): dialed as asked, and kept in calls like a contact's call - number, name, transcript, recording -
 * so it is in the dashboard's history after a deploy too. Nobody's record changes.
 */
export async function dialTestCall(
  deps: TestCallDeps,
  number: string,
  opts: CallOptions,
  who: { contact_name?: string | null } = {},
): Promise<{ call_id: string }> {
  const { line, contacts } = deps;
  const watch = contacts ? watchEnded(line) : null;
  // the voice picked in the dashboard (סקירה → קול הבוט), unless this call tries another: "שיחה אליי" used to ignore
  // it and every self-call had the server's voice, so the voices "sounded the same" (Guy, 25.11)
  const voice = opts.voice || ((await contacts?.store.botVoice?.().catch(() => null)) ?? undefined);
  let callId: string;
  try {
    ({ call_id: callId } = await line.dial(number, { ...opts, voice }));
  } catch (err) {
    if (watch) line.off("ended", watch.onEnded);
    throw err;
  }
  if (contacts && watch) {
    const info: CallInfo = {
      number: toE164(number) ?? number,
      direction: "out",
      contact_name: who.contact_name ?? opts.name ?? null,
      scenario: opts.scenario ?? null,
    };
    void trackCall({ ...deps, contacts }, callId, { info }, watch);
  }
  return { call_id: callId };
}

/** Someone called the line (it answers with the active test session): kept in calls like a test call. */
export function trackIncomingCall(deps: DialDeps, callId: string, number: string, scenario: string | null): Promise<void> {
  const info: CallInfo = { number: toE164(number) ?? (number || null), direction: "in", scenario };
  return trackCall(deps, callId, { info }, watchEnded(deps.line));
}

/**
 * A call's row follows the call: made now (before the bot can run a tool - the callee hasn't answered), closed when
 * the line says the call ended (answered or not), then its transcript, AI cost and recording. A contact's call also
 * updates the contact (bot_call_started / bot_call_ended); tool events in between go through the same queue.
 * Resolves when the call ended and its row was closed (the dialer's queue then sees the result).
 */
function trackCall(
  deps: DialDeps,
  callId: string,
  call: { goldRecordId?: string; origin?: CallOrigin; info: CallInfo },
  { ended, onEnded }: EndWatch,
): Promise<void> {
  const { line, contacts: events } = deps;
  const startedAt = Date.now();
  const { dialing, business_hours } = deps.settings;
  const limits = { noAnswerStreakMax: dialing.no_answer_streak_max, maxTotalCalls: dialing.max_total_calls };
  const goldRecordId = call.goldRecordId;
  return new Promise((resolve) => {
    const finish = ({ at, usage, recording }: Ended) => {
      line.off("ended", onEnded);
      line.off("ended", waitEnd);
      // the line has written the whole transcript by now (it says 'ended' last); none when nobody answered
      const lines = deps.transcriptsDir ? transcriptForDb(readTranscript(deps.transcriptsDir, callId)) : [];
      const durationSec = (at - startedAt) / 1000;
      // a contact's call: the next call for each streak this call can make; SQL picks by the contact's new streak.
      // A test call: how long it was, and whether someone answered (they said something)
      const closed = goldRecordId
        ? events.run(callId, "call ended", (s) =>
            s.callEnded(callId, durationSec, noAnswerRetryTimes(new Date(at), business_hours, dialing), limits),
          )
        : events.run(callId, "call ended", async (s) =>
            s.saveCallInfo?.(callId, { duration_sec: Math.round(durationSec), answered: lines.some((l) => l.role === "user") }),
          );
      if (lines.length) void events.run(callId, "transcript", async (s) => s.saveTranscript?.(callId, lines));
      // what the call cost in Gemini tokens (the price table is in settings.yaml)
      if (usage) void events.run(callId, "ai usage", async (s) => s.saveUsage?.(callId, usage, aiCostUsd(usage, deps.settings)));
      // the recording outlives the server's disk in Supabase Storage (the dashboard plays it from there)
      if (recording) void events.run(callId, "recording", async (s) => s.saveRecording?.(callId, recording));
      // the bot's lines piled up: a summary line is ADDED to the notes (notes.ts), after the call's own updates
      const summarize = events.summarizeNotes;
      if (goldRecordId && summarize) {
        void closed.then(() => events.run(callId, "notes summary", async (s) => summarizeIfLong(s, goldRecordId, summarize)));
      }
      void closed.then(resolve);
    };
    const waitEnd = (e: CallEnded) => {
      if (e.call_id === callId) finish({ at: Date.now(), usage: e.usage, recording: e.recording });
    };
    if (goldRecordId) {
      void events.run(callId, "call started", (s) => s.callStarted(callId, goldRecordId, call.origin));
      void events.run(callId, "call details", async (s) => s.saveCallInfo?.(callId, call.info));
    } else void events.run(callId, "call started", async (s) => s.testCallStarted?.(callId, call.info));
    const already = ended.get(callId);
    if (already) finish(already);
    else line.on("ended", waitEnd);
  });
}
