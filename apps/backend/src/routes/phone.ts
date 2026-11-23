/**
 * The Zadarma phone line inside the tools server: the dashboard dials any number with a scenario and
 * follows the call live. The line itself is started by main.ts after the server listens (it checks the
 * server first); until then, or without ZADARMA_SIP_* in the env, `holder.line` is null.
 *
 * Mishlav's users (access.ts) don't get /test/phone/call: their test call is /api/me/test-call, to the phone they
 * logged in with and nowhere else, as the customer of the study day they pick, under their own first name.
 *   GET  /api/me/test-call   -> { phone, line: {available, reason, busy}, days: [{id, label}] }
 *   POST /api/me/test-call   {day_id?} -> { call_id }
 *   POST /api/me/hangup      -> only a call they placed
 */
import type { Settings } from "@mishlav/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { PhoneLine } from "../../../phone/src/line.js";
import { isAdmin } from "../access";
import { todayIso } from "../context";
import { type ContactEvents, firstName } from "../contacts";
import { type DialError, dialContact, ringTimeoutMs } from "../dial";
import { datesHe, FORMAT_HE, type KnowledgeBase } from "../knowledge";

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
    /** a Gemini voice for this test call (the line checks it is one of PHONE_VOICES) */
    voice: z.string().trim().max(30).optional(),
  })
  .refine((v) => v.number || v.contact_id, { message: "number or contact_id" });

export interface PhoneRouteDeps {
  /** Supabase contacts (none: dial numbers only) */
  contacts?: ContactEvents;
  settings: Settings;
  /** logs/transcripts: a contact call's transcript is stored in Supabase at its end */
  transcriptsDir?: string;
  /** the study days a test call can be about (Mishlav's own test call) */
  knowledge?: () => KnowledgeBase;
  now?: () => Date;
}

const SelfDial = z.strictObject({ day_id: z.string().trim().max(100).optional() });

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
    // the line's log is ours (numbers, SIP details); Mishlav's users get its state only
    const log = isAdmin(req.principal) ? line.recent.filter((l) => l.seq > since) : [];
    return { ok: true, available: true, reason: null, status: line.status(), log };
  });

  // ---- a test call to the logged-in user's own phone (Mishlav's people; admins can use it too)
  const mine = new Map<string, string>(); // call_id -> the user who placed it (for their hangup)
  const now = deps.now ?? (() => new Date());
  const upcomingDays = () => {
    const kb = deps.knowledge?.();
    if (!kb) return [];
    const today = todayIso(now());
    return [...kb.days.values()]
      .filter((d) => (d.end_date ?? d.date) >= today)
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((d) => ({ id: d.id, label: `${d.title} · ${FORMAT_HE[d.format]} · ${datesHe(d)}` }));
  };
  app.get("/api/me/test-call", async (req, reply) => {
    const user = req.principal?.user;
    if (!user) return reply.code(409).send({ ok: false, error: "not_a_user", message_he: "שיחה אליי זמינה רק למשתמש מחובר" });
    const line = holder.line;
    return {
      ok: true,
      phone: user.phone.replace(/^\+972/, "0"),
      line: { available: !!line, reason: line ? null : holder.reason, busy: !!line?.status().busy },
      days: upcomingDays(),
    };
  });
  app.post("/api/me/test-call", async (req, reply) => {
    const user = req.principal?.user;
    if (!user) return reply.code(409).send({ ok: false, error: "not_a_user", message_he: "שיחה אליי זמינה רק למשתמש מחובר" });
    const parsed = SelfDial.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ ok: false, error: "invalid_params", details: z.prettifyError(parsed.error) });
    const day = parsed.data.day_id;
    if (day && !upcomingDays().some((d) => d.id === day)) {
      return reply.code(400).send({ ok: false, error: "unknown_day_id", message_he: "אין יום עיון כזה" });
    }
    if (!holder.line) {
      return reply.code(409).send({ ok: false, error: "no_phone_line", message_he: `קו הטלפון לא פעיל: ${holder.reason ?? "לא ידוע"}` });
    }
    try {
      const r = await holder.line.dial(user.phone, {
        name: firstName(user.name) ?? undefined,
        ...(day ? { day } : {}),
        ringTimeoutMs: ringTimeoutMs(deps.settings),
      });
      mine.set(r.call_id, user.id);
      if (mine.size > 200) mine.delete(mine.keys().next().value!);
      return { ok: true, call_id: r.call_id };
    } catch (err) {
      return reply.code(409).send({ ok: false, error: "dial_failed", message_he: (err as Error).message });
    }
  });
  app.post("/api/me/hangup", async (req) => {
    const current = holder.line?.status().call?.id;
    const own = current && (isAdmin(req.principal) || mine.get(current) === req.principal?.user?.id);
    return { ok: true, hung_up: own ? ((await holder.line?.hangup()) ?? false) : false };
  });

  app.post("/test/phone/call", async (req, reply) => {
    const parsed = DialRequest.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ ok: false, error: "invalid_params", details: z.prettifyError(parsed.error) });
    if (!holder.line) {
      return reply.code(409).send({ ok: false, error: "no_phone_line", message_he: `קו הטלפון לא פעיל: ${holder.reason ?? "לא ידוע"}` });
    }
    const { number, contact_id, ...opts } = parsed.data;
    const line = holder.line;
    if (contact_id) {
      if (!deps.contacts) return reply.code(409).send({ ok: false, error: "no_contacts", message_he: "Supabase לא מחובר (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)" });
      const r = await dialContact({ contacts: deps.contacts, settings: deps.settings, line, transcriptsDir: deps.transcriptsDir }, contact_id, { ...opts, number, origin: "manual" });
      if (!r.ok) return reply.code(DIAL_ERROR_CODE[r.error]).send(r);
      return { ok: true, call_id: r.call_id, contact_id: r.contact.gold_record_id };
    }
    try {
      return { ok: true, ...(await line.dial(number!, { ...opts, ringTimeoutMs: ringTimeoutMs(deps.settings) })) };
    } catch (err) {
      return reply.code(409).send({ ok: false, error: "dial_failed", message_he: (err as Error).message });
    }
  });

  app.post("/test/phone/hangup", async () => ({ ok: true, hung_up: (await holder.line?.hangup()) ?? false }));
}

const DIAL_ERROR_CODE: Record<DialError, number> = {
  unknown_contact: 404,
  supabase_error: 502,
  do_not_call: 409,
  no_phone: 409,
  not_allowed: 409,
  dial_failed: 409,
};
