import { z } from "zod";
import { Outcome } from "./enums";

/** Per-turn latency: end of customer speech -> start of bot reply. */
export const TurnMetric = z.object({
  turn: z.number().int().nonnegative().optional(),
  latency_ms: z.number().nonnegative(),
  /** Processing time inside the provider (excludes the network path), when available. */
  provider_ms: z.number().nonnegative().optional(),
});
export type TurnMetric = z.infer<typeof TurnMetric>;

/** Minimal context injected into a call (spec 4.3). No ID numbers, phones or raw notes. */
export const CallContext = z.object({
  first_name: z.string(),
  interested_day_id: z.string().optional(),
  preferred_call_time: z.string().optional(),
  previous_outcomes: z.array(Outcome).default([]),
});
export type CallContext = z.infer<typeof CallContext>;

export const CallResult = z.object({
  callId: z.string(),
  outcome: Outcome,
  reason: z.string().optional(),
  summary: z.string(),
  callbackAt: z.string().optional(),
  durationSec: z.number().nonnegative(),
  turns: z.array(TurnMetric),
});
export type CallResult = z.infer<typeof CallResult>;

/** Production contact (Part 4). Declared now so VoiceProvider can be typed. */
export interface Contact {
  id: string;
  firstName: string;
  phone: string;
}

/** The voice layer behind one interface (spec 4.1). Each branch implements it, plus MockProvider. */
export interface VoiceProvider {
  startCall(contact: Contact, ctx: CallContext): Promise<{ callId: string }>;
  onCallEnded(handler: (r: CallResult) => Promise<void>): void;
}
