/**
 * Per-call prompt variables — the single source for every provider (C worker, A dynamic variables, B).
 *
 * `customer_context` is FACTS ONLY: what this customer showed interest in, and what else exists.
 * No rules. With the facts in view the model can tell "another date" (same day, same format) from
 * "another day" on its own (it once answered "is there another date?" with the Zoom days of other topics).
 */
import { genderFactHe, type Gender } from "./gender";
import { datesHe, type KnowledgeBase, spokenDatesHe, type StudyDay, timeRangeHe } from "./knowledge";

export const TZ = "Asia/Jerusalem";
export const DEFAULT_FIRST_NAME = "דנה";
export const DEFAULT_BOT_NAME = "נועה";

export interface CallVariables {
  first_name: string;
  bot_name: string;
  interested_day_id: string;
  current_datetime: string;
  customer_context: string;
  /** the closed list of study days the bot may offer (from Supabase, so a dashboard change reaches the next call) */
  day_catalog: string;
  /** decided before the call (gender.ts); its fact opens customer_context */
  customer_gender: Gender;
}

export const todayIso = (now: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(now); // YYYY-MM-DD

/**
 * The prompt's catalogue, built so the bot reads an answer instead of searching for one (searching, it once put a
 * topic into a day that doesn't have it, and offered a later day as "the nearest"):
 *   1. the days in two groups, Zoom then the hotel, each by date (the nearest first);
 *   2. by topic: each topic of the titles, with its days in date order and where they are.
 * e.g.
 *   בזום – יום עיון אחד בשני מפגשים (הקרוב ראשון):
 *   - `2027-02-21-zoom` – דיני עבודה ומס הכנסה · 21 ו-22 בפברואר · מעשר בבוקר עד אחת ורבע בצהריים בכל מפגש · 370 ₪ כולל מע"מ
 *   במלון – יום מלא (הקרוב ראשון):
 *   - `2027-05-17-hotel` – דיני עבודה ומס הכנסה · 17 במאי · מתשע בבוקר עד ארבע אחר הצהריים · מלון דן פנורמה, תל אביב · 790 ₪ כולל מע"מ
 *   לפי נושא (הקרוב ראשון):
 *   - ביטוח לאומי: 17 ו-18 במרץ בזום · 21 ו-22 ביוני בזום (רק בזום)
 * Dates and hours as they are said (spokenDatesHe, timeRangeHe): given "13:15" the bot read the digits out.
 * Past days are left out; a day with registration closed is marked. The dates, hours, place and price are here so the
 * bot answers them at once: a tool call on a phone line is a silence (get_day_info is for what isn't here).
 */
export function buildDayCatalog(kb: KnowledgeBase, now: Date): string {
  const today = todayIso(now);
  const days = [...kb.days.values()].filter((d) => d.date >= today).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  if (!days.length) return "אין כרגע ימי עיון בקטלוג.";
  const when = (d: StudyDay) => spokenDatesHe(d, today);
  const line = (d: StudyDay) =>
    [
      `- \`${d.id}\` – ${d.title}`,
      when(d),
      d.end_date ? `${timeRangeHe(d.start, d.end)} בכל מפגש` : timeRangeHe(d.start, d.end),
      ...(d.format === "hotel" && d.location ? [d.location] : []),
      `${d.price_ils} ₪ ${d.vat_included ? "כולל" : "לפני"} מע"מ`,
      // the lecturers here too: asked for them, the bot said "I'm checking", called no tool and made two up
      ...(d.lecturers.length ? [`מרצים: ${d.lecturers.join(", ")}`] : []),
      ...(d.open_for_registration ? [] : ["ההרשמה סגורה"]),
    ].join(" · ");
  const byFormat = CATALOG_GROUPS.flatMap(({ format, heading }) => {
    const group = days.filter((d) => d.format === format);
    return group.length ? [heading, ...group.map(line)] : [];
  });
  const topics = new Map<string, StudyDay[]>();
  for (const d of days) for (const t of topicsOf(d.title)) topics.set(t, [...(topics.get(t) ?? []), d]);
  const byTopic = [...topics].map(([topic, ds]) => {
    const only = new Set(ds.map((d) => d.format)).size === 1 ? ` (רק ${IN_FORMAT_HE[ds[0]!.format]})` : "";
    return `- ${topic}: ${ds.map((d) => `${when(d)} ${IN_FORMAT_HE[d.format]}`).join(" · ")}${only}`;
  });
  return [...byFormat, "לפי נושא (הקרוב ראשון):", ...byTopic].join("\n");
}

/**
 * The topics of a title, as Mishlav write them: "דיני עבודה, מס הכנסה וביטוח פנסיוני" -> דיני עבודה / מס הכנסה /
 * ביטוח פנסיוני (split at the commas and at the "ו" that joins the last one).
 */
export function topicsOf(title: string): string[] {
  return title
    .split(" – ")[0]!
    .split(/,\s*|\s+ו(?=\S)/)
    .map((t) => t.trim())
    .filter(Boolean);
}

const CATALOG_GROUPS: { format: StudyDay["format"]; heading: string }[] = [
  { format: "zoom", heading: "בזום – יום עיון אחד בשני מפגשים (הקרוב ראשון):" },
  { format: "hotel", heading: "במלון – יום מלא (הקרוב ראשון):" },
];

/** "יום פרונטלי במלון" / "יום עיון אחד בשני מפגשים בזום" (a Zoom study day: one study day on two dates) */
const dayFormatHe = (d: StudyDay) =>
  d.format === "hotel" ? "יום פרונטלי במלון" : d.end_date ? "יום עיון אחד בשני מפגשים בזום" : "יום מקוון בזום";
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
  const today = todayIso(now);
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
  input: { first_name?: string; interested_day_id?: string; bot_name?: string; gender?: Gender; notes?: string },
  now: Date,
): CallVariables {
  const dayId = input.interested_day_id && kb.days.has(input.interested_day_id) ? input.interested_day_id : "";
  const firstName = input.first_name || DEFAULT_FIRST_NAME;
  const gender = input.gender ?? "unknown";
  // a follow-up call: the contact's notes in Gold (the bot's lines from earlier calls, the reps' own)
  const notes = input.notes?.trim() ? ` הערות על הלקוח מהשיחות הקודמות (מגולד, האחרונה בסוף): ${input.notes.trim()}` : "";
  return {
    first_name: firstName,
    bot_name: input.bot_name || DEFAULT_BOT_NAME,
    interested_day_id: dayId || "לא ידוע", // display value, as the worker rendered it before
    current_datetime: currentDatetimeHe(now),
    customer_context: `${genderFactHe(firstName, gender)} ${buildCustomerContext(kb, dayId || undefined, now)}${notes}`,
    day_catalog: buildDayCatalog(kb, now),
    customer_gender: gender,
  };
}

