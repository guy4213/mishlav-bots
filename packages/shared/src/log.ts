import { z } from "zod";
import { Provider, ToolName } from "./enums";
import { TurnMetric } from "./call";

export const ToolCallLogEntry = z.object({
  type: z.literal("tool_call"),
  ts: z.string(),
  session_id: z.string().nullable(),
  scenario: z.string().nullable(),
  provider: z.string().nullable(),
  call_id: z.string().nullable(),
  tool: ToolName,
  params: z.unknown(),
  redactions: z.number().int().nonnegative(),
  ok: z.boolean(),
  error: z.string().optional(),
  response: z.unknown(),
  duration_ms: z.number(),
});
export type ToolCallLogEntry = z.infer<typeof ToolCallLogEntry>;

export const AuthFailureLogEntry = z.object({
  type: z.literal("auth_failure"),
  ts: z.string(),
  path: z.string(),
  ip: z.string().optional(),
});
export type AuthFailureLogEntry = z.infer<typeof AuthFailureLogEntry>;

export const ToolLogLine = z.discriminatedUnion("type", [ToolCallLogEntry, AuthFailureLogEntry]);
export type ToolLogLine = z.infer<typeof ToolLogLine>;

export const SessionStartInput = z.strictObject({
  provider: Provider,
  scenario: z.string().trim().min(1).max(20),
  actor: z.string().trim().max(50).optional(),
  notes: z.string().max(500).optional(),
});
export type SessionStartInput = z.infer<typeof SessionStartInput>;

export const TestSession = z.object({
  session_id: z.string(),
  provider: Provider,
  scenario: z.string(),
  actor: z.string().nullable(),
  notes: z.string().nullable(),
  started_at: z.string(),
});
export type TestSession = z.infer<typeof TestSession>;

export const SessionLogLine = z.discriminatedUnion("type", [
  TestSession.extend({ type: z.literal("session_start") }),
  z.object({ type: z.literal("session_end"), session_id: z.string(), ended_at: z.string() }),
]);
export type SessionLogLine = z.infer<typeof SessionLogLine>;

export const MetricsInput = z.strictObject({
  session_id: z.string().optional(),
  call_id: z.string().optional(),
  turns: z.array(TurnMetric).default([]),
  duration_sec: z.number().nonnegative().optional(),
  cost_usd: z.number().nonnegative().optional(),
  source: z.string().max(100).optional(),
});
export type MetricsInput = z.infer<typeof MetricsInput>;

export const MetricsLogEntry = z.object({
  type: z.literal("metrics"),
  ts: z.string(),
  session_id: z.string().nullable(),
  call_id: z.string().optional(),
  turns: z.array(TurnMetric),
  duration_sec: z.number().optional(),
  cost_usd: z.number().optional(),
  source: z.string().optional(),
});
export type MetricsLogEntry = z.infer<typeof MetricsLogEntry>;

export const LOG_FILES = {
  toolCalls: "tool-calls.jsonl",
  sessions: "sessions.jsonl",
  metrics: "metrics.jsonl",
} as const;
