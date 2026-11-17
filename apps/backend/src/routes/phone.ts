/**
 * The Zadarma phone line inside the tools server: the dashboard dials any number with a scenario and
 * follows the call live. The line itself is started by main.ts after the server listens (it checks the
 * server first); until then, or without ZADARMA_SIP_* in the env, `holder.line` is null.
 */
import { noAnswerRetryTimes, type Settings } from "@mishlav/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { PhoneLine } from "../../../phone/src/line.js";
import { type ContactEvents, dialNumber, firstName } from "../contacts";

export interface PhoneHolder {
  line: PhoneLine | null;
  /** Why there is no line (missing settings, registration failed). */
  reason: string | null;
}

const DialRequest = z
  .strictObject({
    number: z.string().trim().min(6).max(30).optional(),
    /** a contact in Supabase (its gold_record_id): its phone, name, day and gender; the call updates that contact */
    contact_id: z.string().trim().min(1).max(64).optional(),
    scenario: z.string().trim().max(20).optional(),
    name: z.string().trim().max(40).optional(),
    day: z.string().trim().max(100).optional(),
  })
  .refine((v) => v.number || v.contact_id, { message: "number or contact_id" });

export interface PhoneRouteDeps {
  /** Supabase contacts (none: dial numbers only) */
  contacts?: ContactEvents;
  settings: Settings;
}

export async function registerPhoneRoutes(app: FastifyInstance, holder: PhoneHolder, deps: PhoneRouteDeps): Promise<void> {
  // the contacts to dial from the dashboard
  app.get("/test/contacts", async (_req, reply) => {
    if (!deps.contacts) return { ok: true, available: false, contacts: [] };
    try {
      return { ok: true, available: true, contacts: await deps.contacts.store.list() };
    } catch (err) {
      return reply.code(502).send({ ok: false, error: "supabase_error", message_he: (err as Error).message });
    }
  });

  // status + the call log since `since` (a seq number), for the dashboard's live view
  app.get("/test/phone", async (req) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const line = holder.line;
    if (!line) return { ok: true, available: false, reason: holder.reason, status: null, log: [] };
    const since = Number(q.since ?? 0) || 0;
    return { ok: true, available: true, reason: null, status: line.status(), log: line.recent.filter((l) => l.seq > since) };
  });

  app.post("/test/phone/call", async (req, reply) => {
    const parsed = DialRequest.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ ok: false, error: "invalid_params", details: z.prettifyError(parsed.error) });
    if (!holder.line) {
      return reply.code(409).send({ ok: false, error: "no_phone_line", message_he: `קו הטלפון לא פעיל: ${holder.reason ?? "לא ידוע"}` });
    }
    const { number, contact_id, ...opts } = parsed.data;
    const line = holder.line;
    let contact = null;
    if (contact_id) {
      if (!deps.contacts) return reply.code(409).send({ ok: false, error: "no_contacts", message_he: "Supabase לא מחובר (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)" });
      try {
        contact = await deps.contacts.store.get(contact_id);
      } catch (err) {
        return reply.code(502).send({ ok: false, error: "supabase_error", message_he: (err as Error).message });
      }
      if (!contact) return reply.code(404).send({ ok: false, error: "unknown_contact", message_he: "אין איש קשר כזה" });
      if (contact.bot_state?.bot_status === "do_not_call") {
        return reply.code(409).send({ ok: false, error: "do_not_call", message_he: "ביקש לא להתקשר אליו – לא מחייגים" });
      }
    }
    // the contact's phone in use (phone / phone2 / phone3 after a wrong number), as +972...
    const toDial = number ?? (contact && dialNumber(contact));
    if (!toDial) return reply.code(409).send({ ok: false, error: "no_phone", message_he: "לאיש הקשר אין מספר טלפון תקין" });
    // the line's 'ended' can come right after dial() returns: catch it from now on
    const ended = new Map<string, number>();
    const onEnded = (e: { call_id: string }) => ended.set(e.call_id, Date.now());
    if (contact) line.on("ended", onEnded);
    try {
      const r = await line.dial(toDial, {
        ...opts,
        ...(contact && {
          name: opts.name ?? firstName(contact.full_name) ?? undefined,
          day: opts.day ?? contact.bot_state?.interested_day_id ?? undefined,
          gender: contact.bot_state?.customer_gender ?? undefined,
        }),
      });
      if (contact && deps.contacts) trackContactCall(line, deps, r.call_id, contact.gold_record_id, ended, onEnded);
      return { ok: true, ...r, ...(contact && { contact_id: contact.gold_record_id }) };
    } catch (err) {
      if (contact) line.off("ended", onEnded);
      return reply.code(409).send({ ok: false, error: "dial_failed", message_he: (err as Error).message });
    }
  });

  app.post("/test/phone/hangup", async () => ({ ok: true, hung_up: (await holder.line?.hangup()) ?? false }));
}

/**
 * The contact's record follows the call: linked now (before the bot can run a tool - the callee hasn't answered),
 * closed when the line says the call ended (answered or not). Tool events in between go through the same queue.
 */
function trackContactCall(
  line: PhoneLine,
  deps: PhoneRouteDeps,
  callId: string,
  goldRecordId: string,
  ended: Map<string, number>,
  onEnded: (e: { call_id: string }) => void,
) {
  const events = deps.contacts!;
  const startedAt = Date.now();
  const { dialing, business_hours } = deps.settings;
  const limits = { noAnswerStreakMax: dialing.no_answer_streak_max, maxTotalCalls: dialing.max_total_calls };
  const finish = (at: number) => {
    line.off("ended", onEnded);
    line.off("ended", waitEnd);
    // the next call for each streak this call can make; SQL picks by the contact's new streak
    const nextCallAt = noAnswerRetryTimes(new Date(at), business_hours, dialing);
    void events.run(callId, "call ended", (s) => s.callEnded(callId, (at - startedAt) / 1000, nextCallAt, limits));
  };
  const waitEnd = (e: { call_id: string }) => {
    if (e.call_id === callId) finish(Date.now());
  };
  void events.run(callId, "call started", (s) => s.callStarted(callId, goldRecordId));
  const already = ended.get(callId);
  if (already) finish(already);
  else line.on("ended", waitEnd);
}
