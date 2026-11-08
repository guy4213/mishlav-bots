import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { addDays, dateKey, Outcome, toLocalParts, ToolName, WEEKDAYS } from "@mishlav/shared";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const Matcher = z.union([
  z.strictObject({ equals: z.unknown() }),
  z.strictObject({ one_of: z.array(z.unknown()).min(1) }),
  z.strictObject({ includes: z.string().min(1) }),
  z.strictObject({ digits_equal: z.string().min(1) }),
  z.strictObject({
    local_datetime: z.strictObject({
      weekday: z.enum(WEEKDAYS),
      time: z.string().regex(/^\d{2}:\d{2}$/),
      max_days_ahead: z.number().int().positive().default(14),
    }),
  }),
  z.strictObject({ absent: z.literal(true) }),
]);
export type Matcher = z.infer<typeof Matcher>;

export const ToolExpectation = z.strictObject({
  tool: ToolName,
  params: z.record(z.string(), Matcher).default({}),
});
export type ToolExpectation = z.infer<typeof ToolExpectation>;

export const Scenario = z.strictObject({
  id: z.string().regex(/^[A-Z]\d+$/),
  name: z.string(),
  core: z.boolean(),
  description: z.string(),
  context: z
    .strictObject({
      first_name: z.string(),
      interested_day_id: z.string().optional(),
    })
    .default({ first_name: "דנה" }),
  actor_script: z.array(z.string()).min(1),
  expect: z.strictObject({
    outcome: Outcome.optional(),
    outcome_one_of: z.array(Outcome).min(1).optional(),
    required_tools: z.array(ToolExpectation).default([]),
    forbidden_tools: z.array(ToolName).default([]),
    allowed_tools: z.array(ToolName).optional(),
    no_card_numbers: z.boolean().default(true),
    no_rejected_calls: z.boolean().default(false),
    manual_checks: z.array(z.string()).default([]),
  }),
  /** Plain-Hebrew instructions for the tester (dashboard). `watch` = Hebrew of `expect.manual_checks`, same order. */
  guide_he: z
    .strictObject({
      title: z.string().min(1),
      expect: z.string().min(1),
      tips: z.array(z.string()).default([]),
      watch: z.array(z.string()).default([]),
    })
    .optional(),
  simulate: z
    .array(z.strictObject({ tool: ToolName, params: z.record(z.string(), z.unknown()).default({}) }))
    .default([]),
});
export type Scenario = z.infer<typeof Scenario>;

function yamlFiles(dir: string): string[] {
  return readdirSync(dir)
    .flatMap((name) => {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) return yamlFiles(p);
      return /\.ya?ml$/.test(name) ? [p] : [];
    })
    .sort();
}

export function loadScenarios(dir: string): Scenario[] {
  const out: Scenario[] = [];
  const seen = new Set<string>();
  for (const file of yamlFiles(dir)) {
    const parsed = Scenario.safeParse(parseYaml(readFileSync(file, "utf8")));
    if (!parsed.success) throw new Error(`${file}:\n${z.prettifyError(parsed.error)}`);
    if (seen.has(parsed.data.id)) throw new Error(`${file}: duplicate scenario id ${parsed.data.id}`);
    seen.add(parsed.data.id);
    out.push(parsed.data);
  }
  return out.sort((a, b) => Number(b.core) - Number(a.core) || a.id.localeCompare(b.id, "en", { numeric: true }));
}

/** Template values for `simulate` params, e.g. "{{next_weekday:tue}}T10:00:00". */
export function renderTemplate(value: unknown, now: Date, tz: string): unknown {
  if (typeof value === "string") {
    return value.replace(/\{\{\s*([a-z_]+)(?::([a-z]+))?\s*\}\}/g, (whole, name: string, arg?: string) => {
      const today = toLocalParts(now, tz);
      if (name === "today") return dateKey(today);
      if (name === "next_weekday" && arg) {
        const target = WEEKDAYS.indexOf(arg as (typeof WEEKDAYS)[number]);
        if (target < 0) return whole;
        const delta = ((target - today.weekday + 7) % 7) || 7; // strictly after today
        return dateKey(addDays(today, delta));
      }
      return whole;
    });
  }
  if (Array.isArray(value)) return value.map((v) => renderTemplate(v, now, tz));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renderTemplate(v, now, tz)]));
  }
  return value;
}
