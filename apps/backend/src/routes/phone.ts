/**
 * The Zadarma phone line inside the tools server: the dashboard dials any number with a scenario and
 * follows the call live. The line itself is started by main.ts after the server listens (it checks the
 * server first); until then, or without ZADARMA_SIP_* in the env, `holder.line` is null.
 */
import type { Settings } from "@mishlav/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { PhoneLine } from "../../../phone/src/line.js";
import type { ContactEvents } from "../contacts";
import { type DialError, dialContact, ringTimeoutMs } from "../dial";

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
    if (contact_id) {
      if (!deps.contacts) return reply.code(409).send({ ok: false, error: "no_contacts", message_he: "Supabase לא מחובר (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)" });
      const r = await dialContact({ contacts: deps.contacts, settings: deps.settings, line }, contact_id, { ...opts, number, origin: "manual" });
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
