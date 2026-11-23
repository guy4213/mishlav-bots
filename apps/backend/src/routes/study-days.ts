/**
 * The study days in the dashboard ("ימי עיון"), behind TOOLS_SECRET like every /api/admin route.
 *
 *   GET  /api/admin/study-days               -> { ok, days: every day (archived too) as the bot sees it, catalog_he }
 *   POST /api/admin/study-days               {day} -> { ok, day }   the id is set here: <date>-<format>
 *   POST /api/admin/study-days/:id           {day} -> { ok, day }   every field is replaced (the id stays)
 *   POST /api/admin/study-days/:id/archive   -> { ok, day }         hidden from the bot (never deleted)
 *   POST /api/admin/study-days/:id/restore   -> { ok, day }
 *
 * After each change the bot's days are read again at once (this server; another one within a minute).
 * Without Supabase: 409 no_supabase. Invalid fields: 400 with message_he naming them.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { buildDayCatalog } from "../context";
import { newDayId, StudyDayInput } from "../knowledge";
import { type LiveKnowledge, rowForDashboard, StudyDayExists, type StudyDayRow, type StudyDayStore, inputToRow } from "../study-days";
import { dayNoteHe } from "../tools/handlers";

export interface StudyDayRouteDeps {
  /** none without Supabase */
  studyDays?: { store: StudyDayStore; live: LiveKnowledge };
  now: () => Date;
}

const DAY_ID = /^[a-z0-9-]{1,100}$/;

/** The form's labels, for the error message. */
const FIELD_HE: Record<string, string> = {
  title: "שם יום העיון",
  topic: "נושא",
  date: "תאריך",
  end_date: "תאריך המפגש השני",
  start: "שעת התחלה",
  end: "שעת סיום",
  format: "זום או מלון",
  series: "אותו תוכן כמו",
  location: "מקום",
  price_ils: "מחיר",
  vat_included: "כולל מע\"מ",
  open_for_registration: "הרשמה פתוחה",
  course_number: "מספר קורס",
  purchase_url: "קישור לרכישה",
  lecturers: "מרצים",
  academic_hours: "שעות אקדמיות",
  description: "סדר יום",
};

function invalid(reply: FastifyReply, error: z.ZodError) {
  const fields = [...new Set(error.issues.map((i) => String(i.path[0] ?? "")))];
  const names = fields.map((f) => FIELD_HE[f] ?? f).filter(Boolean);
  return reply.code(400).send({
    ok: false,
    error: "invalid_params",
    fields,
    message_he: names.length ? `לא תקין: ${names.join(", ")}` : "הנתונים לא תקינים",
    details: z.prettifyError(error),
  });
}

export async function registerStudyDayRoutes(app: FastifyInstance, deps: StudyDayRouteDeps): Promise<void> {
  const noSupabase = { ok: false, error: "no_supabase", message_he: "Supabase לא מחובר: ימי העיון נקראים מקבצי הבדיקה" };
  const supabaseError = (reply: FastifyReply, err: unknown) =>
    reply.code(502).send({ ok: false, error: "supabase_error", message_he: (err as Error).message });

  /** A row as the dashboard shows it: + the bot's Gold note and whether the bot offers it now. */
  const view = (r: StudyDayRow) => {
    const d = rowForDashboard(r);
    const bot = deps.studyDays?.live.days.get(r.id);
    return { ...d, note_he: bot ? dayNoteHe(bot) : null, offered_to_bot: !!bot };
  };

  /** After a change: the bot reads the days again now. A failed read is not the change's failure. */
  const refreshed = async () => {
    try {
      await deps.studyDays!.live.refresh();
      return null;
    } catch (err) {
      return `נשמר, אבל הבוט יראה את השינוי רק בעוד דקה: ${(err as Error).message}`;
    }
  };

  app.get("/api/admin/study-days", async (_req, reply) => {
    if (!deps.studyDays) return reply.code(409).send(noSupabase);
    try {
      const rows = await deps.studyDays.store.studyDays();
      return { ok: true, days: rows.map(view), catalog_he: buildDayCatalog(deps.studyDays.live, deps.now()) };
    } catch (err) {
      return supabaseError(reply, err);
    }
  });

  app.post("/api/admin/study-days", async (req, reply) => {
    if (!deps.studyDays) return reply.code(409).send(noSupabase);
    const parsed = StudyDayInput.safeParse(req.body ?? {});
    if (!parsed.success) return invalid(reply, parsed.error);
    const id = newDayId(parsed.data);
    try {
      const row = await deps.studyDays.store.createStudyDay({ id, ...inputToRow(parsed.data) });
      const warning = await refreshed();
      return { ok: true, day: view(row), warning_he: warning };
    } catch (err) {
      if (err instanceof StudyDayExists) {
        return reply.code(409).send({
          ok: false,
          error: "day_exists",
          message_he: `כבר יש יום עיון ${parsed.data.format === "zoom" ? "בזום" : "במלון"} שמתחיל בתאריך הזה (${id})`,
        });
      }
      return supabaseError(reply, err);
    }
  });

  const byId = (raw: unknown, reply: FastifyReply) => {
    const id = String(raw ?? "");
    if (DAY_ID.test(id)) return id;
    void reply.code(400).send({ ok: false, error: "invalid_id", message_he: "מזהה יום עיון לא תקין" });
    return null;
  };
  const notFound = (reply: FastifyReply, id: string) =>
    reply.code(404).send({ ok: false, error: "not_found", message_he: `אין יום עיון ${id}` });

  app.post("/api/admin/study-days/:id", async (req, reply) => {
    if (!deps.studyDays) return reply.code(409).send(noSupabase);
    const id = byId((req.params as { id?: string }).id, reply);
    if (!id) return reply;
    const parsed = StudyDayInput.safeParse(req.body ?? {});
    if (!parsed.success) return invalid(reply, parsed.error);
    try {
      const row = await deps.studyDays.store.updateStudyDay(id, inputToRow(parsed.data));
      if (!row) return notFound(reply, id);
      const warning = await refreshed();
      return { ok: true, day: view(row), warning_he: warning };
    } catch (err) {
      return supabaseError(reply, err);
    }
  });

  for (const action of ["archive", "restore"] as const) {
    app.post(`/api/admin/study-days/:id/${action}`, async (req, reply) => {
      if (!deps.studyDays) return reply.code(409).send(noSupabase);
      const id = byId((req.params as { id?: string }).id, reply);
      if (!id) return reply;
      try {
        const row = await deps.studyDays.store.setStudyDayArchived(id, action === "archive");
        if (!row) return notFound(reply, id);
        const warning = await refreshed();
        return { ok: true, day: view(row), warning_he: warning };
      } catch (err) {
        return supabaseError(reply, err);
      }
    });
  }
}
