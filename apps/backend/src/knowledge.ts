/**
 * The study days and the general knowledge the bot answers from.
 *
 * The study days live in Supabase (table study_days, edited from the dashboard: study-days.ts). Without Supabase
 * (tests, text runs) they come from fixed files (tests/fixtures/days/<id>.md: YAML front-matter + a description).
 * Both go through the same zod schema, so a day is valid the same way wherever it comes from.
 * general.md (policies, prices, benefits) stays a file in config/knowledge.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const ID = /^[a-z0-9-]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}:\d{2}$/;

/** The fields Mishlav edits (the dashboard's form), without the id. */
const dayFields = {
  title: z.string().trim().min(1).max(120),
  topic: z.string().trim().min(1).max(200),
  date: z.string().regex(DATE),
  /** A Zoom study day is ONE study day held in two meetings: `date` = the first meeting, `end_date` = the second. */
  end_date: z.string().regex(DATE).optional(),
  start: z.string().regex(TIME),
  end: z.string().regex(TIME),
  format: z.enum(["zoom", "hotel"]),
  /** Same series = the same study day (same content) held on several dates / formats. Defaults to `id`. */
  series: z.string().regex(ID).optional(),
  location: z.string().trim().min(1).max(200),
  price_ils: z.number().positive(),
  vat_included: z.boolean(),
  open_for_registration: z.boolean(),
  /** Mishlav's number for this study day (what the reps register in Gold); goes into the bot's note. */
  course_number: z.union([z.string(), z.number()]).transform(String).optional(),
  /** Sent by SMS (send_purchase_link); the bot never sees or says it. None: the tool answers no_purchase_url. */
  purchase_url: z.url({ protocol: /^https$/ }).optional(),
  lecturers: z.array(z.string().trim().min(1).max(100)).max(10).default([]),
  /** Academic hours for the CPA chamber's yearly requirement (Mishlav's number, not the clock hours). */
  academic_hours: z.number().positive().optional(),
};

type Shape = { date: string; end_date?: string | undefined; start: string; end: string; format: "zoom" | "hotel" };
function dayRules(d: Shape, ctx: z.RefinementCtx) {
  if (d.format === "zoom" && !(d.end_date && d.end_date > d.date)) {
    ctx.addIssue({ code: "custom", path: ["end_date"], message: "zoom study day = one day in 2 meetings: end_date (after date) is required" });
  }
  if (d.format === "hotel" && d.end_date) {
    ctx.addIssue({ code: "custom", path: ["end_date"], message: "hotel study day = 1 day: no end_date" });
  }
  if (d.end <= d.start) ctx.addIssue({ code: "custom", path: ["end"], message: "end must be after start" });
}

export const StudyDayMeta = z.object({ id: z.string().regex(ID), ...dayFields }).superRefine(dayRules);

/** What the dashboard sends to create or update a day (the server sets the id). Unknown fields are rejected. */
export const StudyDayInput = z
  .strictObject({ ...dayFields, description: z.string().max(5000).default("") })
  .superRefine(dayRules);
export type StudyDayInput = z.infer<typeof StudyDayInput>;

/** A new day's id: its first date and format (2027-02-21-zoom). Never changes after it is created. */
export const newDayId = (d: { date: string; format: string }) => `${d.date}-${d.format}`;

/** 2026-12-08 -> 8.12.2026; a pair -> 8–9.12.2026 (or 31.12.2026–1.1.2027 across months). */
export function datesHe(d: { date: string; end_date?: string | undefined }): string {
  const [y1, m1, d1] = d.date.split("-").map(Number);
  if (!d.end_date) return `${d1}.${m1}.${y1}`;
  const [y2, m2, d2] = d.end_date.split("-").map(Number);
  return y1 === y2 && m1 === m2 ? `${d1}–${d2}.${m2}.${y2}` : `${d1}.${m1}.${y1}–${d2}.${m2}.${y2}`;
}

export type StudyDay = z.infer<typeof StudyDayMeta> & { description: string; series: string };

/** How customers say it: "פרונטלי" / "פיזי" / "במלון" vs "בזום" / "אונליין" / "מקוון". */
export const FORMAT_HE: Record<StudyDay["format"], string> = {
  hotel: "פרונטלי – במלון",
  zoom: "מקוון – בזום",
};

/** Read at every use: with Supabase the days are replaced while the server runs (LiveKnowledge, study-days.ts). */
export interface KnowledgeBase {
  readonly days: Map<string, StudyDay>;
  readonly general: string;
}

/** A day from any source -> StudyDay; throws with the source's name on invalid data. */
export function toStudyDay(meta: unknown, description: string, source: string): StudyDay {
  const parsed = StudyDayMeta.safeParse(meta);
  if (!parsed.success) throw new Error(`${source}: invalid study day\n${z.prettifyError(parsed.error)}`);
  return { ...parsed.data, series: parsed.data.series ?? parsed.data.id, description: description.trim() };
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parseDayFile(text: string, file: string): StudyDay {
  const m = FRONTMATTER.exec(text);
  if (!m) throw new Error(`${file}: missing YAML front-matter`);
  return toStudyDay(parseYaml(m[1]!), m[2]!, file);
}

export function loadGeneral(knowledgeDir: string): string {
  return readFileSync(join(knowledgeDir, "general.md"), "utf8").trim();
}

/** The fixed days of a folder (tests/fixtures/days) + general.md: the offline knowledge base. */
export function loadKnowledge(knowledgeDir: string, daysDir: string): KnowledgeBase {
  const days = new Map<string, StudyDay>();
  for (const file of readdirSync(daysDir).filter((f) => f.endsWith(".md")).sort()) {
    const day = parseDayFile(readFileSync(join(daysDir, file), "utf8"), file);
    if (days.has(day.id)) throw new Error(`Duplicate study day id: ${day.id}`);
    if (`${day.id}.md` !== file) throw new Error(`${file}: file name must be <id>.md (id is ${day.id})`);
    days.set(day.id, day);
  }
  if (days.size === 0) throw new Error(`No study days in ${daysDir}`);
  return { days, general: loadGeneral(knowledgeDir) };
}
