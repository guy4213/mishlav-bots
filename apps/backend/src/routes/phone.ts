/**
 * The Zadarma phone line inside the tools server: the dashboard dials any number with a scenario and
 * follows the call live. The line itself is started by main.ts after the server listens (it checks the
 * server first); until then, or without ZADARMA_SIP_* in the env, `holder.line` is null.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { PhoneLine } from "../../../phone/src/line.js";

export interface PhoneHolder {
  line: PhoneLine | null;
  /** Why there is no line (missing settings, registration failed). */
  reason: string | null;
}

const DialRequest = z.strictObject({
  number: z.string().trim().min(6).max(30),
  scenario: z.string().trim().max(20).optional(),
  name: z.string().trim().max(40).optional(),
  day: z.string().trim().max(100).optional(),
});

export async function registerPhoneRoutes(app: FastifyInstance, holder: PhoneHolder): Promise<void> {
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
    const { number, ...opts } = parsed.data;
    try {
      const r = await holder.line.dial(number, opts);
      return { ok: true, ...r };
    } catch (err) {
      return reply.code(409).send({ ok: false, error: "dial_failed", message_he: (err as Error).message });
    }
  });

  app.post("/test/phone/hangup", async () => ({ ok: true, hung_up: (await holder.line?.hangup()) ?? false }));
}
