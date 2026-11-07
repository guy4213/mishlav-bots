import { z } from "zod";

/** Providers under test. SIM = scripts/simulate.ts (excluded from the decision). */
export const PROVIDERS = ["A", "B", "C", "SIM"] as const;
export const Provider = z.enum(PROVIDERS);
export type Provider = z.infer<typeof Provider>;

export const PROVIDER_NAMES: Record<Provider, string> = {
  A: "ElevenLabs Agents",
  B: "LiveKit + Soniox + ElevenLabs",
  C: "LiveKit + Gemini Live",
  SIM: "Simulation",
};

/** Call outcomes (spec 4.5 / 4.7). closed_max_attempts is a contact status, not an outcome. */
export const OUTCOMES = [
  "LINK_SENT",
  "CALLBACK",
  "HOT_LEAD",
  "COMPANY",
  "HUMAN_FOLLOWUP",
  "NOT_INTERESTED",
  "ALREADY_REGISTERED",
  "DO_NOT_CALL",
  "VOICEMAIL",
  "NO_ANSWER",
  "BUSY",
  "DROPPED",
  "FAILED",
  "WRONG_NUMBER",
] as const;
export const Outcome = z.enum(OUTCOMES);
export type Outcome = z.infer<typeof Outcome>;

/** request_human.reason closed list (spec 4.2). */
export const REQUEST_HUMAN_REASONS = [
  "wants_human",
  "pay_via_rep",
  "company_purchase",
  "discount_request",
  "other",
] as const;
export const RequestHumanReason = z.enum(REQUEST_HUMAN_REASONS);
export type RequestHumanReason = z.infer<typeof RequestHumanReason>;

/** end_call.reason closed list — deviation from the PDF (see docs/TECHNICAL_SPEC.md §9). */
export const END_CALL_REASONS = [
  "completed",
  "not_interested",
  "do_not_call",
  "voicemail",
  "already_registered",
  "wrong_number",
] as const;
export const EndCallReason = z.enum(END_CALL_REASONS);
export type EndCallReason = z.infer<typeof EndCallReason>;

export const TOOL_NAMES = [
  "get_day_info",
  "send_purchase_link",
  "schedule_callback",
  "request_human",
  "end_call",
] as const;
export const ToolName = z.enum(TOOL_NAMES);
export type ToolName = z.infer<typeof ToolName>;
