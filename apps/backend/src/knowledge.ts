import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const StudyDayMeta = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string(),
  topic: z.string(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  start: z.string().regex(/^\d{2}:\d{2}$/),
  end: z.string().regex(/^\d{2}:\d{2}$/),
  format: z.enum(["zoom", "hotel"]),
  location: z.string(),
  price_ils: z.number().positive(),
  vat_included: z.boolean(),
  open_for_registration: z.boolean(),
});

export type StudyDay = z.infer<typeof StudyDayMeta> & { description: string };

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
  return { ...meta.data, description: m[2]!.trim() };
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
