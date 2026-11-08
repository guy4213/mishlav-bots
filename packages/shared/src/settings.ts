import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { END_CALL_REASONS, Outcome, Provider, REQUEST_HUMAN_REASONS } from "./enums";
import { WEEKDAYS } from "./time";

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "expected HH:MM");
const YMD = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

const RetryRule = z.object({
  after_minutes: z.number().int().positive(),
  counts_as_attempt: z.boolean().default(true),
});

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
    min_lead_minutes: z.number().int().nonnegative().default(15),
    max_days_ahead: z.number().int().positive().default(60),
  }),
  dialing: z.object({
    max_attempts: z.number().int().positive(),
    follow_up_days: z.number().int().positive(),
    max_concurrent_calls: z.number().int().positive(),
    kill_switch: z.boolean().default(false),
    retry: z.partialRecord(Outcome, RetryRule),
    wrong_number_next_phone: z.boolean().default(true),
  }),
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
