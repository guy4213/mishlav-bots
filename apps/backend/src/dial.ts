/**
 * Dialing one contact, the same way for the dashboard's "call" button (routes/phone.ts) and the automatic dialer
 * (dialer.ts): load it, never a do-not-call, its phone in use, dial with its name / day / gender, and follow the
 * call so the contact's record is linked now and closed when the line says the call ended (with its transcript
 * stored in calls.transcript, so the dashboard's history survives a deploy).
 */
import { noAnswerRetryTimes, type Settings } from "@mishlav/shared";
import type { CallEnded, CallOptions, PhoneLine } from "../../phone/src/line.js";
import { aiCostUsd } from "./ai-cost";
import { type CallOrigin, type ContactEvents, type ContactRecord, dialNumber, firstName } from "./contacts";
import { readTranscript, transcriptForDb } from "./transcripts";

/** when the line said the call ended, and its Gemini tokens */
type Ended = { at: number; usage?: CallEnded["usage"]; recording?: string };

export interface DialDeps {
  contacts: ContactEvents;
  settings: Settings;
  line: PhoneLine;
  /** where the line writes each call's transcript (logs/transcripts); none: not stored in the database */
  transcriptsDir?: string;
}

export interface DialOptions extends Omit<CallOptions, "gender" | "ringTimeoutMs"> {
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
  // the line's 'ended' can come right after dial() returns: catch it from now on
  const ended = new Map<string, Ended>();
  const onEnded = (e: CallEnded) => ended.set(e.call_id, { at: Date.now(), usage: e.usage, recording: e.recording });
  line.on("ended", onEnded);
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
      ringTimeoutMs: ringTimeoutMs(deps.settings),
    }));
  } catch (err) {
    line.off("ended", onEnded);
    return { ok: false, error: "dial_failed", message_he: (err as Error).message };
  }
  const done = trackContactCall(deps, callId, contact.gold_record_id, origin, ended, onEnded);
  return { ok: true, call_id: callId, contact, number: toDial, ended: done };
}

/**
 * The contact's record follows the call: linked now (before the bot can run a tool - the callee hasn't answered),
 * closed when the line says the call ended (answered or not). Tool events in between go through the same queue.
 * Resolves when the call ended and its record was closed (the dialer's queue then sees the result).
 */
function trackContactCall(
  deps: DialDeps,
  callId: string,
  goldRecordId: string,
  origin: CallOrigin,
  ended: Map<string, Ended>,
  onEnded: (e: CallEnded) => void,
): Promise<void> {
  const { line, contacts: events } = deps;
  const startedAt = Date.now();
  const { dialing, business_hours } = deps.settings;
  const limits = { noAnswerStreakMax: dialing.no_answer_streak_max, maxTotalCalls: dialing.max_total_calls };
  return new Promise((resolve) => {
    const finish = ({ at, usage, recording }: Ended) => {
      line.off("ended", onEnded);
      line.off("ended", waitEnd);
      // the next call for each streak this call can make; SQL picks by the contact's new streak
      const nextCallAt = noAnswerRetryTimes(new Date(at), business_hours, dialing);
      const closed = events.run(callId, "call ended", (s) => s.callEnded(callId, (at - startedAt) / 1000, nextCallAt, limits));
      // the line has written the whole transcript by now (it says 'ended' last); none when nobody answered
      const lines = deps.transcriptsDir ? transcriptForDb(readTranscript(deps.transcriptsDir, callId)) : [];
      if (lines.length) void events.run(callId, "transcript", async (s) => s.saveTranscript?.(callId, lines));
      // what the call cost in Gemini tokens (the price table is in settings.yaml)
      if (usage) void events.run(callId, "ai usage", async (s) => s.saveUsage?.(callId, usage, aiCostUsd(usage, deps.settings)));
      // the recording outlives the server's disk in Supabase Storage (the dashboard plays it from there)
      if (recording) void events.run(callId, "recording", async (s) => s.saveRecording?.(callId, recording));
      void closed.then(resolve);
    };
    const waitEnd = (e: CallEnded) => {
      if (e.call_id === callId) finish({ at: Date.now(), usage: e.usage, recording: e.recording });
    };
    void events.run(callId, "call started", (s) => s.callStarted(callId, goldRecordId, origin));
    const already = ended.get(callId);
    if (already) finish(already);
    else line.on("ended", waitEnd);
  });
}
