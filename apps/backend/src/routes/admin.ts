/**
 * The management API behind TOOLS_SECRET (the dashboard). For now: the automatic dialer.
 *   GET  /api/admin/dialer         -> { ok, available, dialer: DialerStatus | null }
 *   POST /api/admin/dialer/start   {reason?} -> { ok, dialer }
 *   POST /api/admin/dialer/stop    {reason?} -> { ok, dialer }   (a call in progress goes on to its end)
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Dialer } from "../dialer";

export interface AdminRouteDeps {
  /** none without Supabase (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY) */
  dialer?: Dialer;
}

const Reason = z.strictObject({ reason: z.string().trim().max(200).optional() });

export async function registerAdminRoutes(app: FastifyInstance, deps: AdminRouteDeps): Promise<void> {
  const unavailable = { ok: false, error: "no_dialer", message_he: "החיוג האוטומטי לא זמין: Supabase לא מחובר" };

  app.get("/api/admin/dialer", async () =>
    deps.dialer ? { ok: true, available: true, dialer: deps.dialer.status() } : { ok: true, available: false, dialer: null },
  );

  for (const action of ["start", "stop"] as const) {
    app.post(`/api/admin/dialer/${action}`, async (req, reply) => {
      if (!deps.dialer) return reply.code(409).send(unavailable);
      const parsed = Reason.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ ok: false, error: "invalid_params", details: z.prettifyError(parsed.error) });
      try {
        return { ok: true, dialer: await deps.dialer[action](parsed.data.reason) };
      } catch (err) {
        return reply.code(502).send({ ok: false, error: "supabase_error", message_he: (err as Error).message });
      }
    });
  }
}
