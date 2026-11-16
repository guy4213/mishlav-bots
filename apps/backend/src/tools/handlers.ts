import {
  type ClosedReason,
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
import { SAY_END_CALL, SAY_HANDED_TO_REP, SAY_LINK_SENT, sayCallback, sayHandedToRepAt, whenHe } from "./closings";

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
  message_he: "יום העיון הזה לא קיים. לא להמציא פרטים – לבחור יום מהקטלוג, או להציע שנציג יחזור.",
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
        message_he: "ההרשמה ליום הזה סגורה. להציע יום אחר מהקטלוג או נציג.",
      };
    }
    return {
      ok: true,
      status: "sent",
      test_mode: true, // no real SMS in Part 1
      day_id: day.id,
      ...closing(SAY_LINK_SENT),
    };
  },

  schedule_callback(input, ctx) {
    const t = resolveTime(input, ctx);
    if (!t.ok) return t.response;
    return { ok: true, status: "accepted", ...t.fields, ...closing(sayCallback(t.scheduled, ctx.now(), tz(ctx))) };
  },

  // The rep calls back the number on file, at the time the customer chose (none = as soon as possible).
  // Nothing else to ask (the bot once invented a "which department?" question). Part 4: a note on the lead.
  request_human(input, ctx) {
    if (input.reason === "other") {
      // an open question: the rep answers it later, the call itself goes on (flow step 4)
      return {
        ok: true,
        status: "handed_to_rep",
        message_he: "נרשם שנציג יחזור ללקוח עם תשובה לשאלה הזו. לומר לו את זה ולהמשיך בשיחה – השאלה לא סוגרת את השיחה.",
      };
    }
    if (input.asap) return { ok: true, status: "handed_to_rep", ...closing(SAY_HANDED_TO_REP) };
    if (input.requested_time === undefined && input.in_minutes === undefined) {
      // no time yet: on a real call the bot asked "when?" and handed off in the same breath, then hung up
      return {
        ok: true,
        status: "waiting_for_time",
        message_he:
          "עוד לא נרשם. קודם לשאול את הלקוח מתי נוח שהנציג יחזור ולחכות לתשובה שלו. אם כבר שאלת – לא לומר כלום עכשיו, רק לחכות. " +
          "אחרי שענה – לקרוא שוב עם המועד, או עם asap אם אמר שלא משנה לו.",
      };
    }
    const t = resolveTime(input, ctx);
    if (!t.ok) return t.response;
    return { ok: true, status: "handed_to_rep", ...t.fields, ...closing(sayHandedToRepAt(t.scheduled, ctx.now(), tz(ctx))) };
  },

  // The model often calls the tools first and speaks after their results (ElevenLabs always does), so
  // this answer is where the closing sentence gets said: the customer must never be dropped in silence.
  end_call(input) {
    if (input.reason === "voicemail") return { ok: true, status: "ending", message_he: "משיבון – לא לומר דבר." };
    return { ok: true, status: "ending", say_he: SAY_END_CALL[input.reason ?? "completed"], message_he: END_CALL_SAY_GOODBYE };
  },
};

const tz = (ctx: ToolContext) => ctx.settings.business_hours.timezone;

/**
 * The customer's callback time (schedule_callback, request_human): accepted -> the booked time; otherwise the
 * whole tool answer (invalid, too far, or an alternative to propose - with the real reason).
 */
function resolveTime(
  input: { requested_time?: string; in_minutes?: number },
  ctx: ToolContext,
): { ok: true; scheduled: Date; fields: Record<string, string> } | { ok: false; response: ToolResponse } {
  const { settings, now } = ctx;
  const zone = tz(ctx);
  const requested =
    input.in_minutes !== undefined
      ? new Date(now().getTime() + input.in_minutes * 60_000) // our clock, not the model's
      : parseRequestedTime(input.requested_time ?? "", zone);
  if (!requested) {
    return {
      ok: false,
      response: { ok: false, error: "invalid_time", message_he: "המועד לא בפורמט תקין. לשלוח ISO, למשל 2026-11-17T10:00:00." },
    };
  }
  const r = resolveCallback(requested, now(), settings.business_hours, settings.callback);
  if (r.status === "error") {
    return {
      ok: false,
      response: {
        ok: false,
        error: r.error,
        message_he: `אפשר לתאם שיחה חוזרת עד ${settings.callback.max_days_ahead} ימים קדימה. לבקש מועד קרוב יותר.`,
      },
    };
  }
  const fields = {
    requested_time: input.requested_time ?? formatLocalIso(requested, zone),
    scheduled_time: formatLocalIso(r.scheduled, zone),
    scheduled_time_he: formatHebrew(r.scheduled, zone),
  };
  if (r.status === "accepted") return { ok: true, scheduled: r.scheduled, fields };
  return {
    ok: false,
    response: {
      ok: true,
      status: "alternative",
      reason: r.reason,
      ...fields,
      // the real reason: "in 10 minutes" at 12:13 was once refused as "outside business hours"
      message_he: `${ALTERNATIVE_WHY[r.reason](hoursHe(settings.business_hours))} המועד הקרוב האפשרי: ${whenHe(r.scheduled, now(), zone)}. להציע אותו ללקוח, ואם מסכים – לקרוא שוב עם המועד הזה.`,
    },
  };
}

/**
 * After an action that closes the call: the fixed closing sentence (say_he) and the next step. `closing: true`
 * tells the phone line to hang up after that sentence even if end_call never comes (it often didn't).
 * The words here are instructions only - nothing in them is meant to be said ("I'm ending the call" was).
 */
export const CLOSE_NEXT =
  "לומר ללקוח את המשפט שב-say_he, מילה במילה, בלי להוסיף ובלי לשנות, ולקרוא ל-end_call (completed) באותה תשובה. אם הלקוח מבקש עוד משהו – לענות לו.";

const closing = (say_he: string) => ({ closing: true, say_he, message_he: CLOSE_NEXT });

/** end_call answer (not voicemail): the line drops after the bot's next sentence. */
export const END_CALL_SAY_GOODBYE =
  "אם מאז הדברים האחרונים של הלקוח עוד לא נפרדת ממנו – לומר עכשיו את המשפט שב-say_he, מילה במילה, ולא שום דבר אחר. אם כבר נפרדת – לא לומר כלום.";

/** Why the requested callback time was moved (the bot repeats it to the customer). */
const ALTERNATIVE_WHY: Record<"in_past" | "too_soon" | ClosedReason, (hours: string) => string> = {
  in_past: () => "המועד שביקש כבר עבר.",
  too_soon: () => "המועד קרוב מדי.",
  outside_business_hours: (h) => `המועד מחוץ לשעות הפעילות (${h}).`,
  non_working_day: (h) => `באותו יום אין פעילות (שעות הפעילות: ${h}).`,
  holiday: () => "באותו יום חג ואין פעילות.",
};

const DAY_HE: Record<string, string> = { sun: "א׳", mon: "ב׳", tue: "ג׳", wed: "ד׳", thu: "ה׳", fri: "ו׳", sat: "שבת" };

/** "א׳–ה׳ 09:00–17:00" from settings, so the bot quotes the real hours instead of guessing them. */
export function hoursHe(bh: { days: readonly string[]; open: string; close: string }): string {
  const d = bh.days.map((x) => DAY_HE[x] ?? x);
  const days = d.length > 2 ? `${d[0]}–${d[d.length - 1]}` : d.join(", ");
  return `${days} ${bh.open}–${bh.close}`;
}
