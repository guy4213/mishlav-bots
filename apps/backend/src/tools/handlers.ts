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
import { datesHe, FORMAT_HE, type KnowledgeBase, type StudyDay } from "../knowledge";

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
  end_date: d.end_date, // zoom = 2 days
  dates_he: datesHe(d),
  start: d.start,
  end: d.end,
  format: d.format,
  format_he: FORMAT_HE[d.format],
  location: d.location,
  price_ils: d.price_ils,
  vat_included: d.vat_included,
  open_for_registration: d.open_for_registration,
  description: d.description,
});

const brief = (d: StudyDay) => ({
  day_id: d.id,
  date: d.date,
  end_date: d.end_date,
  dates_he: datesHe(d),
  start: d.start,
  end: d.end,
  format_he: FORMAT_HE[d.format],
});

/** Facts for "is there another date?": same series (same content) AND same format, open, upcoming. */
export function otherDates(day: StudyDay, kb: KnowledgeBase, now: Date) {
  const today = now.toISOString().slice(0, 10);
  const upcoming = [...kb.days.values()]
    .filter((d) => d.id !== day.id && d.series === day.series && d.open_for_registration && d.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date));
  const sameFormat = upcoming.filter((d) => d.format === day.format);
  const otherFormat = upcoming.filter((d) => d.format !== day.format);
  return {
    other_dates_same_format: sameFormat.map(brief),
    same_content_other_format: otherFormat.map(brief),
  };
}

/**
 * Test-mode tool implementations (spec 1.4): fixed answers, no side effects.
 * In Part 4 these become the real Tools API (identity via call_id, real SMS, tasks, notifier).
 */
export const toolHandlers: { [T in ToolName]: (input: Input<T>, ctx: ToolContext) => ToolResponse } = {
  get_day_info(input, { knowledge, now }) {
    const day = knowledge.days.get(input.day_id);
    if (!day) return unknownDay(knowledge);
    return { ok: true, day: publicDay(day), ...otherDates(day, knowledge, now()), general: knowledge.general };
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
        message_he: `נרשם שנחזור ללקוח ב${scheduled_time_he}.`,
      };
    }
    return {
      ok: true,
      status: "alternative",
      reason: r.reason,
      requested_time: input.requested_time,
      scheduled_time,
      scheduled_time_he,
      message_he: `המועד שביקשת מחוץ לשעות הפעילות (${hoursHe(settings.business_hours)}). המועד הקרוב האפשרי: ${scheduled_time_he}. אם הלקוח מסכים – קראי שוב עם המועד הזה.`,
    };
  },

  request_human() {
    return { ok: true, status: "handed_to_rep", message_he: "נרשם שנציג יחזור ללקוח. עכשיו לומר לו את זה ולהיפרד." };
  },

  // The model often calls the tools first and speaks after their results (ElevenLabs always does), so
  // this answer is where the closing sentence gets said: the customer must never be dropped in silence.
  end_call(input) {
    if (input.reason === "voicemail") return { ok: true, status: "ending", message_he: "משיבון – לא לומר דבר." };
    return { ok: true, status: "ending", message_he: END_CALL_SAY_GOODBYE };
  },
};

/** end_call answer (not voicemail): the line drops after the bot's next sentence. */
export const END_CALL_SAY_GOODBYE =
  "השיחה מסתיימת. אם הלקוח עוד לא שמע ממך מה קורה עכשיו ופרידה – אמרי את זה עכשיו, במשפט אחד. אם כבר אמרת – לא לומר שום דבר נוסף.";

const DAY_HE: Record<string, string> = { sun: "א׳", mon: "ב׳", tue: "ג׳", wed: "ד׳", thu: "ה׳", fri: "ו׳", sat: "שבת" };

/** "א׳–ה׳ 09:00–17:00" from settings, so the bot quotes the real hours instead of guessing them. */
export function hoursHe(bh: { days: readonly string[]; open: string; close: string }): string {
  const d = bh.days.map((x) => DAY_HE[x] ?? x);
  const days = d.length > 2 ? `${d[0]}–${d[d.length - 1]}` : d.join(", ");
  return `${days} ${bh.open}–${bh.close}`;
}
