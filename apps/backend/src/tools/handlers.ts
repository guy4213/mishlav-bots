import {
  formatHebrew,
  formatLocalIso,
  parseRequestedTime,
  resolveCallback,
  type Settings,
  type ToolInputSchemas,
  type ToolName,
} from "@mishlav/shared";
import type { z } from "zod";
import type { KnowledgeBase, StudyDay } from "../knowledge";

export interface ToolContext {
  knowledge: KnowledgeBase;
  settings: Settings;
  now: () => Date;
}

export type ToolResponse = { ok: true; [k: string]: unknown } | { ok: false; error: string; message_he: string; [k: string]: unknown };

type Input<T extends ToolName> = z.infer<ToolInputSchemas[T]>;

const unknownDay = (kb: KnowledgeBase): ToolResponse => ({
  ok: false,
  error: "unknown_day_id",
  available_day_ids: [...kb.days.keys()],
  message_he: "יום העיון הזה לא קיים. אל תמציאי פרטים – בחרי יום מהקטלוג, או הציעי שנציג יחזור.",
});

const publicDay = (d: StudyDay) => ({
  id: d.id,
  title: d.title,
  topic: d.topic,
  date: d.date,
  start: d.start,
  end: d.end,
  format: d.format,
  location: d.location,
  price_ils: d.price_ils,
  vat_included: d.vat_included,
  open_for_registration: d.open_for_registration,
  description: d.description,
});

/**
 * Test-mode tool implementations (spec 1.4): fixed answers, no side effects.
 * In Part 4 these become the real Tools API (identity via call_id, real SMS, tasks, notifier).
 */
export const toolHandlers: { [T in ToolName]: (input: Input<T>, ctx: ToolContext) => ToolResponse } = {
  get_day_info(input, { knowledge }) {
    const day = knowledge.days.get(input.day_id);
    if (!day) return unknownDay(knowledge);
    return { ok: true, day: publicDay(day), general: knowledge.general };
  },

  send_purchase_link(input, { knowledge }) {
    const day = knowledge.days.get(input.day_id);
    if (!day) return unknownDay(knowledge);
    if (!day.open_for_registration) {
      return {
        ok: false,
        error: "registration_closed",
        message_he: "ההרשמה ליום הזה סגורה. הציעי יום אחר מהקטלוג או נציג.",
      };
    }
    return {
      ok: true,
      status: "sent",
      test_mode: true, // no real SMS in Part 1
      day_id: day.id,
      message_he: "הקישור לרכישה נשלח במסרון למספר שמופיע אצלנו.",
    };
  },

  schedule_callback(input, { settings, now }) {
    const tz = settings.business_hours.timezone;
    const requested = parseRequestedTime(input.requested_time, tz);
    if (!requested) {
      return {
        ok: false,
        error: "invalid_time",
        message_he: "המועד לא בפורמט תקין. שלחי ISO, למשל 2026-11-17T10:00:00.",
      };
    }
    const r = resolveCallback(requested, now(), settings.business_hours, settings.callback);
    if (r.status === "error") {
      return {
        ok: false,
        error: r.error,
        message_he: `אפשר לתאם שיחה חוזרת עד ${settings.callback.max_days_ahead} ימים קדימה. בקשי מועד קרוב יותר.`,
      };
    }
    const scheduled_time = formatLocalIso(r.scheduled, tz);
    const scheduled_time_he = formatHebrew(r.scheduled, tz);
    if (r.status === "accepted") {
      return {
        ok: true,
        status: "accepted",
        requested_time: input.requested_time,
        scheduled_time,
        scheduled_time_he,
        message_he: `נקבעה שיחה חוזרת ל${scheduled_time_he}.`,
      };
    }
    return {
      ok: true,
      status: "alternative",
      reason: r.reason,
      requested_time: input.requested_time,
      scheduled_time,
      scheduled_time_he,
      message_he: `המועד שביקשת מחוץ לשעות הפעילות. המועד הקרוב האפשרי: ${scheduled_time_he}. אם הלקוח מסכים – קראי שוב עם המועד הזה.`,
    };
  },

  request_human() {
    return { ok: true, status: "handed_to_rep", message_he: "הועבר לנציג" };
  },

  end_call() {
    return { ok: true, status: "ending" };
  },
};
