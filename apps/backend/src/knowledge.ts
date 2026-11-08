import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const StudyDayMeta = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    title: z.string(),
    topic: z.string(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    /** Zoom study days are sold as a pair of days (confirmed by Mishlav): `date` = day 1, `end_date` = day 2. */
    end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    start: z.string().regex(/^\d{2}:\d{2}$/),
    end: z.string().regex(/^\d{2}:\d{2}$/),
    format: z.enum(["zoom", "hotel"]),
    /** Same series = the same study day (same content) held on several dates / formats. Defaults to `id`. */
    series: z.string().regex(/^[a-z0-9-]+$/).optional(),
    location: z.string(),
    price_ils: z.number().positive(),
    vat_included: z.boolean(),
    open_for_registration: z.boolean(),
  })
  .superRefine((d, ctx) => {
    if (d.format === "zoom" && !(d.end_date && d.end_date > d.date)) {
      ctx.addIssue({ code: "custom", path: ["end_date"], message: "zoom study day = 2 days: end_date (after date) is required" });
    }
    if (d.format === "hotel" && d.end_date) {
      ctx.addIssue({ code: "custom", path: ["end_date"], message: "hotel study day = 1 day: no end_date" });
    }
  });

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

export interface KnowledgeBase {
  days: Map<string, StudyDay>;
  general: string;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parseDayFile(text: string, file: string): StudyDay {
  const m = FRONTMATTER.exec(text);
  if (!m) throw new Error(`${file}: missing YAML front-matter`);
  const meta = StudyDayMeta.safeParse(parseYaml(m[1]!));
  if (!meta.success) throw new Error(`${file}: invalid front-matter\n${z.prettifyError(meta.error)}`);
  return { ...meta.data, series: meta.data.series ?? meta.data.id, description: m[2]!.trim() };
}

export function loadKnowledge(dir: string): KnowledgeBase {
  const daysDir = join(dir, "days");
  const days = new Map<string, StudyDay>();
  for (const file of readdirSync(daysDir).filter((f) => f.endsWith(".md")).sort()) {
    const day = parseDayFile(readFileSync(join(daysDir, file), "utf8"), file);
    if (days.has(day.id)) throw new Error(`Duplicate study day id: ${day.id}`);
    if (`${day.id}.md` !== file) throw new Error(`${file}: file name must be <id>.md (id is ${day.id})`);
    days.set(day.id, day);
  }
  if (days.size === 0) throw new Error(`No study days in ${daysDir}`);
  const general = readFileSync(join(dir, "general.md"), "utf8").trim();
  return { days, general };
}
