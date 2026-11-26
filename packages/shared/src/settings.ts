import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { END_CALL_REASONS, Outcome, Provider, REQUEST_HUMAN_REASONS } from "./enums";
import { WEEKDAYS } from "./time";

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "expected HH:MM");
const YMD = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

/** The next call after a no-result call (packages/shared/src/retry.ts). */
const NoAnswerRetry = z.union([
  z.strictObject({ after_hours: z.number().positive() }),
  z.strictObject({ business_days: z.number().int().positive() }),
]);

export const Settings = z.object({
  business_hours: z.object({
    timezone: z.string().default("Asia/Jerusalem"),
    days: z.array(z.enum(WEEKDAYS)).min(1),
    open: HHMM,
    close: HHMM,
    holidays: z.array(YMD).default([]),
    half_days: z.array(z.object({ date: YMD, close: HHMM })).default([]),
  }),
  callback: z.object({
    min_lead_minutes: z.number().int().nonnegative().default(5),
    max_days_ahead: z.number().int().positive().default(60),
  }),
  dialing: z
    .object({
      no_answer_streak_max: z.number().int().positive(),
      max_total_calls: z.number().int().positive(),
      midday: HHMM,
      no_answer_retry: z.array(NoAnswerRetry).min(1),
      follow_up_days: z.number().int().positive(),
      /** Unused for now: the phone line holds one call at a time (apps/phone/src/line.js), so the dialer does too. */
      max_concurrent_calls: z.number().int().positive(),
      wrong_number_next_phone: z.boolean().default(true),
      /** An unanswered call is cancelled after this long and ends like any no-answer (manual and dialer calls). */
      ring_timeout_s: z.number().positive().default(40),
      /** The dialer (apps/backend/src/dialer.ts): wait after a call ends before the next one. */
      pause_between_calls_s: z.number().nonnegative().default(5),
      /** The dialer looks for work this often (on/off in the database, hours, line, queue). */
      tick_s: z.number().positive().default(10),
      /** The dialer calls only contacts whose "קורס מבוקש" (Gold) is one of these; empty = everyone. */
      requested_courses: z.array(z.string().trim().min(1)).default([]),
    })
    .refine((d) => d.no_answer_retry.length >= d.no_answer_streak_max - 1, {
      message: "no_answer_retry needs an entry for every streak below no_answer_streak_max",
      path: ["no_answer_retry"],
    }),
  /** The purchase-link SMS (send_purchase_link, apps/backend/src/sms.ts). */
  sms: z.object({
    /** {day} = the study day in Hebrew (title + dates), {url} = its purchase_url (Supabase study_days). */
    link_template: z.string().refine((t) => t.includes("{url}"), { message: "link_template needs {url}" }),
    /**
     * TEMPORARY, for tests only: when set, sent instead of link_template, without the link ({day} optional). Zadarma
     * refuses links in SMS to Israel and commercial-looking texts with no approved template; remove it once
     * Mishlav's own SMS provider is connected.
     */
    test_without_link: z.string().optional(),
  }),
  /**
   * The purchase link on WhatsApp (apps/backend/src/whatsapp.ts, Texter): used instead of the SMS when the server has
   * TEXTER_PROJECT + TEXTER_API_TOKEN. The template's URL button is url_prefix + {{1}}; {{1}} = the rest of the link.
   */
  whatsapp: z
    .object({
      template: z.string().regex(/^[a-zA-Z0-9_-]+$/),
      language: z.string().default("he"),
      url_prefix: z.url({ protocol: /^https$/ }),
    })
    .optional(),
  outcome_mapping: z.object({
    request_human: z.record(z.enum(REQUEST_HUMAN_REASONS), Outcome),
    end_call: z.record(z.enum(END_CALL_REASONS), Outcome.nullable()),
  }),
  testing: z.object({
    capture_dictated_details: z.boolean().default(false),
    log_dir: z.string().default("logs"),
    scoring: z.object({
      max_avg_latency_ms: z.number().positive(),
      max_latency_ms: z.number().positive(),
      min_voice_score: z.number().min(1).max(5),
      provider_priority: z.array(Provider).min(1),
      cost_close_pct: z.number().nonnegative(),
    }),
  }),
  /**
   * Gold export header -> `contacts` column (supabase/migrations). "" = the first column, which has no header;
   * record_id_key is its key in what Gold pulls back (GET /api/gold/changes).
   */
  gold_import: z
    .object({
      sheet: z.string().optional(),
      record_id_key: z.string().min(1).default("מזהה"),
      columns: z.record(z.string(), z.string()),
    })
    .default({ record_id_key: "מזהה", columns: {} }),
  /** Call recordings (Supabase Storage "recordings"): deleted after this many days; 0 = kept for good */
  recordings: z.object({ retention_days: z.number().int().nonnegative() }).default({ retention_days: 0 }),
  /** USD per 1M tokens, by modality (TEXT / AUDIO ...): what a call's Gemini tokens cost (calls.ai_cost_usd) */
  pricing: z
    .object({
      gemini_live: z.object({
        input: z.record(z.string(), z.number().nonnegative()),
        output: z.record(z.string(), z.number().nonnegative()),
      }),
    })
    .optional(),
});
export type Settings = z.infer<typeof Settings>;

/** Walk up from `start` until a directory containing config/settings.yaml is found. */
export function findRepoRoot(start: string = process.cwd()): string {
  if (process.env.MISHLAV_ROOT) return resolve(process.env.MISHLAV_ROOT);
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, "config", "settings.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`config/settings.yaml not found above ${start} (set MISHLAV_ROOT)`);
    dir = parent;
  }
}

export function loadSettings(path: string): Settings {
  const raw = parseYaml(readFileSync(path, "utf8"));
  const parsed = Settings.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid ${path}:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

/**
 * Load a .env file into process.env without overriding variables that are already set.
 * Tolerates a UTF-8 BOM and CRLF (Windows editors), which `process.loadEnvFile` does not.
 */
export function loadDotEnvFile(path: string): boolean {
  if (!existsSync(path)) return false;
  const text = readFileSync(path, "utf8").replace(/^﻿/, "");
  for (const [key, value] of Object.entries(parseEnv(text))) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return true;
}
