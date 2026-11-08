/**
 * Per-call prompt variables — the single source for every provider (C worker, A dynamic variables, B).
 *
 * `customer_context` is FACTS ONLY: what this customer showed interest in, and what else exists.
 * No rules. With the facts in view the model can tell "another date" (same day, same format) from
 * "another day" on its own (it once answered "is there another date?" with the Zoom days of other topics).
 */
import { datesHe, type KnowledgeBase, type StudyDay } from "./knowledge";

export const TZ = "Asia/Jerusalem";
export const DEFAULT_FIRST_NAME = "דנה";
export const DEFAULT_BOT_NAME = "נועה";

export interface CallVariables {
  first_name: string;
  bot_name: string;
  interested_day_id: string;
  current_datetime: string;
  customer_context: string;
}

/** "יום פרונטלי במלון" / "יומיים מקוונים בזום" (a Zoom study day is a pair of days) */
const dayFormatHe = (d: StudyDay) =>
  d.format === "hotel" ? "יום פרונטלי במלון" : d.end_date ? "יומיים מקוונים בזום" : "יום מקוון בזום";
const IN_FORMAT_HE: Record<StudyDay["format"], string> = { hotel: "במלון", zoom: "בזום" };

/** 2026-12-22 -> 22.12.2026 */
export const dateHe = (iso: string) => datesHe({ date: iso });

/** Topic name without the " – יום עיון במלון" suffix some titles carry. */
const topicName = (d: StudyDay) => d.title.split(" – ")[0]!.trim();

/** e.g. "יום שלישי, 8 בדצמבר 2026, 10:05" — same format as the voice worker's format_now_he. */
export function currentDatetimeHe(now: Date): string {
  const part = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("he-IL", { timeZone: TZ, ...o }).format(now);
  const hm = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
  return `${part({ weekday: "long" })}, ${part({ day: "numeric" })} ב${part({ month: "long" })} ${part({ year: "numeric" })}, ${hm}`;
}

const countHe = (n: number) => (n === 1 ? "יום עיון אחד" : n === 2 ? "שני ימי עיון" : `${n} ימי עיון`);

/** One format for all -> "שניהם בזום: A (8.12.2026), B (12.1.2027)"; mixed -> the format on each item. */
function othersHe(days: StudyDay[]): string {
  const formats = new Set(days.map((d) => d.format));
  if (formats.size === 1) {
    const only = IN_FORMAT_HE[days[0]!.format];
    const all = days.length === 1 ? only : days.length === 2 ? `שניהם ${only}` : `כולם ${only}`;
    return `${all}: ${days.map((d) => `${topicName(d)} (${datesHe(d)})`).join(", ")}`;
  }
  return days.map((d) => `${topicName(d)} (${IN_FORMAT_HE[d.format]}, ${datesHe(d)})`).join(", ");
}

export function buildCustomerContext(kb: KnowledgeBase, interestedDayId: string | undefined, now: Date): string {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(now); // YYYY-MM-DD
  const offered = [...kb.days.values()]
    .filter((d) => d.open_for_registration && d.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date));
  const day = interestedDayId ? kb.days.get(interestedDayId) : undefined;

  if (!day) {
    const items = offered.map((d) => `${topicName(d)} – ${dayFormatHe(d).replace("יום ", "")}, ${datesHe(d)}`);
    return `לא ידוע באיזה יום עיון הלקוח התעניין. בקטלוג ${countHe(offered.length)}: ${items.join("; ")}.`;
  }

  const sentences = [`הלקוח התעניין ביום העיון "${topicName(day)}" – ${dayFormatHe(day)}, ${datesHe(day)}.`];
  if (!day.open_for_registration) sentences.push("ההרשמה ליום הזה סגורה.");

  const sameSeries = offered.filter((d) => d.id !== day.id && d.series === day.series);
  const otherDates = sameSeries.filter((d) => d.format === day.format);
  const otherFormat = sameSeries.filter((d) => d.format !== day.format);
  sentences.push(
    otherDates.length
      ? `ליום העיון הזה יש מועדים נוספים ${IN_FORMAT_HE[day.format]}: ${otherDates.map((d) => datesHe(d)).join(", ")}.`
      : "זה המועד היחיד של יום העיון הזה כרגע.",
  );
  if (otherFormat.length) {
    sentences.push(
      `אותו יום עיון מתקיים גם ${otherFormat.map((d) => `${IN_FORMAT_HE[d.format]} ב-${datesHe(d)}`).join(", ")}.`,
    );
  }

  const otherTopics = offered.filter((d) => d.series !== day.series);
  if (otherTopics.length) {
    sentences.push(
      `בקטלוג יש עוד ${countHe(otherTopics.length)} ${otherTopics.length === 1 ? "בנושא אחר" : "בנושאים אחרים"}${new Set(otherTopics.map((d) => d.format)).size === 1 ? ", " : ": "}${othersHe(otherTopics)}.`,
    );
  }
  return sentences.join(" ");
}

export function buildCallVariables(
  kb: KnowledgeBase,
  input: { first_name?: string; interested_day_id?: string; bot_name?: string },
  now: Date,
): CallVariables {
  const dayId = input.interested_day_id && kb.days.has(input.interested_day_id) ? input.interested_day_id : "";
  return {
    first_name: input.first_name || DEFAULT_FIRST_NAME,
    bot_name: input.bot_name || DEFAULT_BOT_NAME,
    interested_day_id: dayId || "לא ידוע", // display value, as the worker rendered it before
    current_datetime: currentDatetimeHe(now),
    customer_context: buildCustomerContext(kb, dayId || undefined, now),
  };
}

