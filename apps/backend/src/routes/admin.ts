/**
 * The management API behind TOOLS_SECRET (the dashboard, apps/backend/dashboard).
 *
 *   GET  /api/admin/env                 -> which server this is (production / local), line, Supabase, WhatsApp, Gold key
 *   GET  /api/admin/dialer              -> { ok, available, dialer: DialerStatus | null }
 *   POST /api/admin/dialer/start|stop   {reason?} -> { ok, dialer }   (stop: a call in progress goes on to its end)
 *   GET  /api/admin/summary             -> today's dialer calls, the contacts' funnel, the queue (dashboard_summary)
 *   GET  /api/admin/contacts?view=activity -> what the bot did last (the call in progress first), 50 rows
 *   GET  /api/admin/contacts?view=queue -> the next 50 the dialer will call, in its order (only its courses)
 *   GET  /api/admin/contacts?q=&status=&page= -> all contacts by name, searched in the database, 50 a page
 *   GET  /api/admin/stream              -> Server-Sent Events: "contacts" when a contact changed (re-read the screen)
 *   GET  /api/admin/contacts/:id        -> one contact + all its rep tasks + its calls, newest first
 *   GET  /api/admin/calls?origin=dialer|manual|all&recorded=1&page= -> calls newest first, with the contact's name, 50 a page
 *   GET  /api/admin/calls/:call_id      -> the call + its transcript (database, else this server's disk) + tool actions
 *   GET  /api/admin/calls/:call_id/recording -> { url }: the recording, playable for an hour (404: not recorded)
 *   GET  /api/admin/rep-tasks?open=1&page= -> rep tasks by callback time, with the contact's name and phone, 50 a page
 * Every paged list answers { total, page, page_size, pages } next to its rows.
 *   POST /api/admin/rep-tasks/:id/done  -> { ok, task }
 *   GET  /api/admin/logs?since=<seq>    -> this server's live log (the phone line + dialer / tools / errors / WhatsApp / server)
 *   GET  /api/admin/logs/history?call_id=&limit= -> the log of earlier server starts (Supabase server_logs, 14 days)
 * Without Supabase the data routes answer 409 no_supabase; a Supabase failure is 502 supabase_error.
 */
import { fromLocal, type Settings, toLocalParts } from "@mishlav/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { ServerResponse } from "node:http";
import type { Changes } from "../changes";
import { type AdminStore, type CallOrigin, type ContactStore, toE164 } from "../contacts";
import type { Dialer } from "../dialer";
import type { JsonlFile } from "../jsonl";
import type { KnowledgeBase } from "../knowledge";
import type { ServerLog } from "../serverlog";
import { linkTemplateValues, type WhatsAppSender } from "../whatsapp";
import { DEFAULT_VOICE, PHONE_VOICES, VOICE_HE } from "../../../phone/src/voices.js";
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
  whatsapp?: WhatsAppSender;
  /** the study days (the WhatsApp test sends a real day's link) */
  knowledge?: () => KnowledgeBase | undefined;
  now?: () => Date;
  /** the push channel: contact updates on this server */
  changes?: Changes;
}

/** "כל הלקוחות": rows a page. "פעילות הבוט" / "הבאים בתור": that many rows, no pages. */
export const PAGE_SIZE = 50;
export const VIEW_ROWS = 50;
export const STREAM_PING_MS = 25_000;

/** ?page= -> a page number from 1 (anything else: 1). */
const pageOf = (raw: string | undefined) => Math.max(1, Math.floor(Number(raw) || 1));
/** What every paged list answers with, so the dashboard draws the same pager everywhere. */
const paging = (total: number, page: number) => ({ total, page, page_size: PAGE_SIZE, pages: Math.max(1, Math.ceil(total / PAGE_SIZE)) });

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
      whatsapp_provider: deps.whatsapp?.provider ?? "log",
      gold_api_key_set: !!env.GOLD_API_KEY?.trim(),
      dialer_only_numbers: !!env.DIALER_ONLY_NUMBERS?.trim(),
      timezone: deps.settings?.business_hours.timezone ?? "Asia/Jerusalem",
    };
  });

  // the purchase-link WhatsApp (Texter): the approved template with a real study day, to a number we type
  app.post("/api/admin/whatsapp/test", async (req, reply) => {
    const body = (req.body ?? {}) as { number?: unknown; day_id?: unknown; name?: unknown };
    const to = typeof body.number === "string" ? toE164(body.number) : null;
    if (!to) return reply.code(400).send({ ok: false, error: "invalid_number", message_he: "מספר טלפון לא תקין" });
    if (!deps.whatsapp?.live || !deps.settings?.whatsapp) {
      return reply.code(409).send({ ok: false, error: "no_whatsapp", message_he: "וואטסאפ לא מוגדר בשרת (TEXTER_PROJECT + TEXTER_API_TOKEN ב-Render)" });
    }
    const days = [...(deps.knowledge?.()?.days.values() ?? [])].filter((d) => d.purchase_url).sort((a, b) => a.date.localeCompare(b.date));
    const day = typeof body.day_id === "string" ? days.find((d) => d.id === body.day_id) : days[0];
    if (!day) return reply.code(409).send({ ok: false, error: "no_day", message_he: "אין יום עיון עם קישור רכישה" });
    const values = linkTemplateValues(day, typeof body.name === "string" ? body.name : "גיא", deps.settings.whatsapp.url_prefix);
    if (!values) return reply.code(409).send({ ok: false, error: "link_not_in_template", message_he: "הקישור של היום לא מתחיל בכתובת של הכפתור" });
    const r = await deps.whatsapp.sendLink(to, values);
    return r.ok
      ? { ok: true, provider: r.provider, day_id: day.id, values }
      : reply.code(502).send({ ok: false, provider: r.provider, error: "whatsapp_failed", message_he: r.error });
  });

  // ---- the automatic dialer
  app.get("/api/admin/dialer", async () =>
    deps.dialer ? { ok: true, available: true, dialer: deps.dialer.status() } : { ok: true, available: false, dialer: null },
  );

  // the pilot's daily limit: admins only (access.ts doesn't open it to Mishlav's users)
  const DailyLimit = z.strictObject({ daily_limit: z.number().int().min(1).max(1000).nullable() });
  app.post("/api/admin/dialer/limit", async (req, reply) => {
    if (!deps.dialer) return reply.code(409).send(unavailable);
    const parsed = DailyLimit.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ ok: false, error: "invalid_params", details: z.prettifyError(parsed.error) });
    try {
      return { ok: true, dialer: await deps.dialer.setDailyLimit(parsed.data.daily_limit) };
    } catch (err) {
      return supabaseError(reply, err);
    }
  });

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

  // ---- the bot's voice for every call: the team picks it (kept in Supabase, so a deploy keeps it)
  const serverVoice = () => (PHONE_VOICES.includes(env.PHONE_VOICE ?? "") ? env.PHONE_VOICE! : DEFAULT_VOICE);
  app.get("/api/admin/voice", async (_req, reply) => {
    if (!deps.contacts?.botVoice) return reply.code(409).send(noSupabase);
    try {
      return { ok: true, voice: await deps.contacts.botVoice(), server_voice: serverVoice(), voices: PHONE_VOICES, labels: VOICE_HE };
    } catch (err) {
      return supabaseError(reply, err);
    }
  });
  const VoiceBody = z.strictObject({ voice: z.enum(PHONE_VOICES as [string, ...string[]]).nullable() });
  app.post("/api/admin/voice", async (req, reply) => {
    if (!deps.contacts?.setBotVoice) return reply.code(409).send(noSupabase);
    const parsed = VoiceBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ ok: false, error: "invalid_params", details: z.prettifyError(parsed.error) });
    try {
      await deps.contacts.setBotVoice(parsed.data.voice);
      return { ok: true, voice: parsed.data.voice, server_voice: serverVoice() };
    } catch (err) {
      return supabaseError(reply, err);
    }
  });

  // ---- overview
  app.get("/api/admin/summary", async (_req, reply) => {
    if (!deps.admin) return reply.code(409).send(noSupabase);
    try {
      const tz = deps.settings?.business_hours.timezone ?? "Asia/Jerusalem";
      return { ok: true, summary: await deps.admin.summary(dayStart(now(), tz), deps.settings?.dialing.requested_courses ?? []) };
    } catch (err) {
      return supabaseError(reply, err);
    }
  });

  // ---- contacts: three views, so nobody pages through 5,000 rows to see what the bot does
  app.get("/api/admin/contacts", async (req, reply) => {
    if (!deps.contacts || !deps.admin) return { ok: true, available: false, view: "all", contacts: [], total: 0 };
    const q = query(req.query);
    const view = q.view === "activity" || q.view === "queue" ? q.view : "all";
    try {
      if (view === "activity") {
        const contacts = await deps.admin.recentContacts(VIEW_ROWS);
        return { ok: true, available: true, view, contacts, total: contacts.length };
      }
      if (view === "queue") {
        const contacts = await deps.admin.queue(now(), deps.settings?.dialing.requested_courses ?? [], VIEW_ROWS);
        return { ok: true, available: true, view, contacts, total: contacts.length };
      }
      const page = pageOf(q.page);
      const search = q.q?.trim().slice(0, 100) || undefined;
      const status = q.status && /^[a-z_]{1,32}$/.test(q.status) ? q.status : undefined;
      const { contacts, total } = await deps.admin.contactsPage({ q: search, status, page, size: PAGE_SIZE });
      return { ok: true, available: true, view, contacts, ...paging(total, page) };
    } catch (err) {
      return supabaseError(reply, err);
    }
  });

  // ---- the push channel (Server-Sent Events): "contacts" whenever a contact changed on this server (changes.ts);
  // the page then re-reads what it shows. A comment every 25 s keeps proxies (Render) from closing an idle stream.
  const streams = new Set<ServerResponse>();
  app.get("/api/admin/stream", (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write("retry: 3000\n\nevent: hello\ndata: {}\n\n");
    const off = deps.changes?.subscribe(() => res.write("event: contacts\ndata: {}\n\n")) ?? (() => {});
    const ping = setInterval(() => res.write(": ping\n\n"), STREAM_PING_MS);
    ping.unref?.();
    const close = () => {
      off();
      clearInterval(ping);
      streams.delete(res);
    };
    streams.add(res);
    req.raw.on("close", close);
  });
  // a shutdown (deploy, tests) ends the open streams: the browsers reconnect to the new server by themselves
  app.addHook("onClose", async () => {
    for (const res of streams) res.end();
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
    const origin: CallOrigin | null = q.origin === "dialer" || q.origin === "manual" ? q.origin : null;
    const recorded = q.recorded === "1";
    const page = pageOf(q.page);
    try {
      const { calls, total } = await deps.admin.calls({ origin, recorded, page, size: PAGE_SIZE });
      return { ok: true, origin: origin ?? "all", recorded, calls, ...paging(total, page) };
    } catch (err) {
      return supabaseError(reply, err);
    }
  });

  app.get("/api/admin/calls/:call_id/recording", async (req, reply) => {
    const callId = (req.params as { call_id: string }).call_id;
    if (!deps.admin?.recordingUrl) return reply.code(409).send({ ok: false, error: "no_recordings", message_he: "אין הקלטות בשרת הזה" });
    try {
      const url = await deps.admin.recordingUrl(callId);
      if (!url) return reply.code(404).send({ ok: false, error: "not_recorded", message_he: "לשיחה הזאת אין הקלטה" });
      return { ok: true, url };
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
    const q = query(req.query);
    const open = q.open !== "0";
    const page = pageOf(q.page);
    try {
      const { tasks, total } = await deps.admin.repTasks({ openOnly: open, page, size: PAGE_SIZE });
      return { ok: true, open, tasks, ...paging(total, page) };
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
      deps.changes?.notify();
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
