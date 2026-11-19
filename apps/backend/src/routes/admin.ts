/**
 * The management API behind TOOLS_SECRET (the dashboard, apps/backend/dashboard).
 *
 *   GET  /api/admin/env                 -> which server this is (production / local), line, Supabase, SMS, Gold key
 *   GET  /api/admin/dialer              -> { ok, available, dialer: DialerStatus | null }
 *   POST /api/admin/dialer/start|stop   {reason?} -> { ok, dialer }   (stop: a call in progress goes on to its end)
 *   GET  /api/admin/summary             -> today's dialer calls, the contacts' funnel, the queue (dashboard_summary)
 *   GET  /api/admin/contacts            -> every contact with bot_state and rep tasks
 *   GET  /api/admin/contacts/:id        -> one contact + all its rep tasks + its calls, newest first
 *   GET  /api/admin/calls?limit=&origin=dialer|manual|all -> calls newest first, with the contact's name
 *   GET  /api/admin/calls/:call_id      -> the call + its transcript (database, else this server's disk) + tool actions
 *   GET  /api/admin/rep-tasks?open=1    -> rep tasks by callback time, with the contact's name and phone
 *   POST /api/admin/rep-tasks/:id/done  -> { ok, task }
 *   GET  /api/admin/logs?since=<seq>    -> this server's live log (the phone line + dialer / tools / errors / SMS / server)
 *   GET  /api/admin/logs/history?call_id=&limit= -> the log of earlier server starts (Supabase server_logs, 14 days)
 * Without Supabase the data routes answer 409 no_supabase; a Supabase failure is 502 supabase_error.
 */
import { fromLocal, type Settings, toLocalParts } from "@mishlav/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { AdminStore, CallOrigin, ContactStore } from "../contacts";
import type { Dialer } from "../dialer";
import type { JsonlFile } from "../jsonl";
import type { ServerLog } from "../serverlog";
import type { SmsSender } from "../sms";
import { CALL_ID, readTranscript } from "../transcripts";
import type { PhoneHolder } from "./phone";
import { toolCallsWhere } from "./test";

export interface AdminRouteDeps {
  /** none without Supabase (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY) */
  dialer?: Dialer;
  contacts?: ContactStore;
  admin?: AdminStore;
  phone?: PhoneHolder;
  serverLog?: ServerLog;
  toolLog?: JsonlFile;
  /** logs/transcripts on this server's disk */
  transcriptsDir?: string;
  settings?: Settings;
  env?: NodeJS.ProcessEnv;
  sms?: SmsSender;
  now?: () => Date;
}

const Reason = z.strictObject({ reason: z.string().trim().max(200).optional() });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RECORD_ID = /^[\w.\-]{1,64}$/;

/** Midnight today in the business time zone (Asia/Jerusalem). */
export function dayStart(now: Date, tz: string): Date {
  const p = toLocalParts(now, tz);
  return fromLocal(p.year, p.month, p.day, 0, 0, tz);
}

export async function registerAdminRoutes(app: FastifyInstance, deps: AdminRouteDeps): Promise<void> {
  const now = deps.now ?? (() => new Date());
  const env = deps.env ?? process.env;
  const unavailable = { ok: false, error: "no_dialer", message_he: "החיוג האוטומטי לא זמין: Supabase לא מחובר" };
  const noSupabase = { ok: false, error: "no_supabase", message_he: "Supabase לא מחובר (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)" };
  const supabaseError = (reply: FastifyReply, err: unknown) =>
    reply.code(502).send({ ok: false, error: "supabase_error", message_he: (err as Error).message });
  const query = (q: unknown) => (q ?? {}) as Record<string, string | undefined>;

  // ---- which server the page is talking to (no secrets: only whether things are set)
  app.get("/api/admin/env", async () => {
    const line = deps.phone?.line ?? null;
    return {
      ok: true,
      env: env.RENDER ? "production" : "local",
      commit: env.RENDER_GIT_COMMIT?.trim().slice(0, 7) || null,
      phone_line: { available: !!line, registered: line?.status().registered ?? false, reason: line ? null : (deps.phone?.reason ?? null) },
      supabase: !!deps.contacts,
      sms_provider: deps.sms?.provider ?? "log",
      gold_api_key_set: !!env.GOLD_API_KEY?.trim(),
      dialer_only_numbers: !!env.DIALER_ONLY_NUMBERS?.trim(),
      timezone: deps.settings?.business_hours.timezone ?? "Asia/Jerusalem",
    };
  });

  // ---- the automatic dialer
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
        return supabaseError(reply, err);
      }
    });
  }

  // ---- overview
  app.get("/api/admin/summary", async (_req, reply) => {
    if (!deps.admin) return reply.code(409).send(noSupabase);
    try {
      const tz = deps.settings?.business_hours.timezone ?? "Asia/Jerusalem";
      return { ok: true, summary: await deps.admin.summary(dayStart(now(), tz)) };
    } catch (err) {
      return supabaseError(reply, err);
    }
  });

  // ---- contacts
  app.get("/api/admin/contacts", async (_req, reply) => {
    if (!deps.contacts) return { ok: true, available: false, contacts: [] };
    try {
      return { ok: true, available: true, contacts: await deps.contacts.list() };
    } catch (err) {
      return supabaseError(reply, err);
    }
  });

  app.get("/api/admin/contacts/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!RECORD_ID.test(id)) return reply.code(400).send({ ok: false, error: "invalid_id" });
    if (!deps.contacts || !deps.admin) return reply.code(409).send(noSupabase);
    try {
      const [contact, rep_tasks, calls] = await Promise.all([
        deps.contacts.get(id),
        deps.admin.contactRepTasks(id),
        deps.admin.contactCalls(id),
      ]);
      if (!contact) return reply.code(404).send({ ok: false, error: "unknown_contact", message_he: "אין איש קשר כזה" });
      return { ok: true, contact: { ...contact, rep_tasks }, calls };
    } catch (err) {
      return supabaseError(reply, err);
    }
  });

  // ---- calls
  app.get("/api/admin/calls", async (req, reply) => {
    if (!deps.admin) return reply.code(409).send(noSupabase);
    const q = query(req.query);
    const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 500);
    const origin: CallOrigin | null = q.origin === "dialer" || q.origin === "manual" ? q.origin : null;
    try {
      return { ok: true, origin: origin ?? "all", calls: await deps.admin.calls(limit, origin) };
    } catch (err) {
      return supabaseError(reply, err);
    }
  });

  app.get("/api/admin/calls/:call_id", async (req, reply) => {
    const { call_id: callId } = req.params as { call_id: string };
    if (!CALL_ID.test(callId)) return reply.code(400).send({ ok: false, error: "invalid_call_id" });
    let call: Awaited<ReturnType<AdminStore["call"]>> = null;
    try {
      call = deps.admin ? await deps.admin.call(callId) : null;
    } catch (err) {
      return supabaseError(reply, err);
    }
    // the database keeps it after a deploy; during the call (and for a scenario test) only this server's disk has it
    const stored = call?.transcript?.length ? call.transcript : null;
    const transcript = stored ?? (deps.transcriptsDir ? readTranscript(deps.transcriptsDir, callId) : []);
    const tools = deps.toolLog ? toolCallsWhere(deps.toolLog, (e) => e.call_id === callId) : [];
    const errors = deps.toolLog
      ? deps.toolLog
          .readAll()
          .filter((l): l is { type: string; ts: string; call_id: string; what: string; error: string } => {
            const o = l as { type?: string; call_id?: string };
            return o?.type === "supabase_error" && o.call_id === callId;
          })
          .map(({ ts, what, error }) => ({ ts, what, error }))
      : [];
    const live = deps.phone?.line?.status().call?.id === callId;
    if (!call && !transcript.length && !tools.length && !live) {
      return reply.code(404).send({ ok: false, error: "unknown_call", message_he: "אין שיחה כזו" });
    }
    const { transcript: _omit, ...row } = call ?? { transcript: null };
    return {
      ok: true,
      call: call ? row : null,
      live,
      transcript,
      transcript_source: stored ? "db" : transcript.length ? "file" : "none",
      tools,
      errors,
    };
  });

  // ---- rep tasks
  app.get("/api/admin/rep-tasks", async (req, reply) => {
    if (!deps.admin) return reply.code(409).send(noSupabase);
    const open = query(req.query).open !== "0";
    try {
      return { ok: true, open, tasks: await deps.admin.repTasks(open) };
    } catch (err) {
      return supabaseError(reply, err);
    }
  });

  app.post("/api/admin/rep-tasks/:id/done", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!UUID.test(id)) return reply.code(400).send({ ok: false, error: "invalid_id" });
    if (!deps.admin) return reply.code(409).send(noSupabase);
    try {
      const task = await deps.admin.repTaskDone(id);
      if (!task) return reply.code(404).send({ ok: false, error: "unknown_task", message_he: "אין משימה כזו" });
      return { ok: true, task };
    } catch (err) {
      return supabaseError(reply, err);
    }
  });

  // ---- this server's live log
  app.get("/api/admin/logs", async (req) => {
    const since = Number(query(req.query).since) || 0;
    const r = deps.serverLog?.since(since) ?? { seq: 0, lines: [] };
    return { ok: true, env: env.RENDER ? "production" : "local", boot: deps.serverLog?.boot ?? null, seq: r.seq, lines: r.lines };
  });

  // ---- the log before this server started (a deploy / restart): kept in Supabase
  app.get("/api/admin/logs/history", async (req, reply) => {
    const q = query(req.query);
    const limit = Math.min(Math.max(Number(q.limit) || 1000, 1), 5000);
    try {
      const lines = (await deps.serverLog?.history({ callId: q.call_id || undefined, limit })) ?? [];
      return { ok: true, lines };
    } catch (err) {
      return supabaseError(reply, err);
    }
  });
}
