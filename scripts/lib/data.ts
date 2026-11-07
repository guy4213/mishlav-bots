import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  LOG_FILES,
  MetricsLogEntry,
  SessionLogLine,
  ToolCallLogEntry,
  type TestSession,
} from "@mishlav/shared";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { readJsonl } from "../../apps/backend/src/jsonl";
import { EMPTY_MANUAL, ManualInputs } from "./scoring";

export interface LoadedLogs {
  sessions: (TestSession & { ended_at: string | null })[];
  toolCalls: ToolCallLogEntry[];
  metrics: MetricsLogEntry[];
  authFailures: number;
  skippedLines: number;
}

export function loadLogs(logDir: string): LoadedLogs {
  let skipped = 0;
  const parseAll = <T>(file: string, schema: z.ZodType<T>): T[] =>
    readJsonl(join(logDir, file)).flatMap((line) => {
      const r = schema.safeParse(line);
      if (!r.success) skipped++;
      return r.success ? [r.data] : [];
    });

  const sessionLines = parseAll(LOG_FILES.sessions, SessionLogLine);
  const byId = new Map<string, TestSession & { ended_at: string | null }>();
  for (const l of sessionLines) {
    if (l.type === "session_start") {
      const { type: _t, ...s } = l;
      byId.set(l.session_id, { ...s, ended_at: null });
    } else {
      const s = byId.get(l.session_id);
      if (s) s.ended_at = l.ended_at;
    }
  }

  const rawTool = readJsonl(join(logDir, LOG_FILES.toolCalls));
  const authFailures = rawTool.filter((l) => (l as { type?: string })?.type === "auth_failure").length;
  const toolCalls = rawTool.flatMap((line) => {
    if ((line as { type?: string })?.type !== "tool_call") return [];
    const r = ToolCallLogEntry.safeParse(line);
    if (!r.success) skipped++;
    return r.success ? [r.data] : [];
  });

  return {
    sessions: [...byId.values()],
    toolCalls,
    metrics: parseAll(LOG_FILES.metrics, MetricsLogEntry),
    authFailures,
    skippedLines: skipped,
  };
}

export function loadManualInputs(path: string | undefined): ManualInputs {
  if (!path) return EMPTY_MANUAL;
  if (!existsSync(path)) throw new Error(`Manual inputs file not found: ${path}`);
  const raw = parseYaml(readFileSync(path, "utf8")) ?? {};
  const parsed = ManualInputs.safeParse(raw);
  if (!parsed.success) throw new Error(`Invalid ${path}:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}
