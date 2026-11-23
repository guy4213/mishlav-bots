// Types for line.js, so the tools server (TypeScript) can run the phone line in-process.
import type { EventEmitter } from "node:events";

export interface PhoneEnv {
  apiKey?: string;
  model: string;
  voice: string;
  temperature: number;
  openAfterSilenceMs: number;
  baseUrl: string;
  secret?: string;
  login?: string;
  password?: string;
  server: string;
  port: number;
  domain?: string;
  number: string;
  displayName?: string;
  logDir: string;
  /** record every call (PHONE_RECORD, default on) */
  record: boolean;
}

export interface PhoneLogLine {
  seq: number;
  ts: string;
  call_id: string | null;
  text: string;
}

export interface PhoneStatus {
  registered: boolean;
  error: string | null;
  number: string;
  model: string;
  voice: string;
  busy: boolean;
  call: { id: string; direction: "in" | "out"; number: string; scenario: string | null; started_at: string } | null;
}

export interface CallOptions {
  scenario?: string;
  name?: string;
  day?: string;
  /** the contact's gender when known (otherwise decided from the name before the call) */
  gender?: "male" | "female" | "unknown";
  /** a Gemini voice for this call (one of PHONE_VOICES), else the line's PHONE_VOICE */
  voice?: string;
  /** no answer by then: cancel (ends like any unanswered call). Outgoing calls only. */
  ringTimeoutMs?: number;
}

export function phoneEnv(env: NodeJS.ProcessEnv, root: string): PhoneEnv;
export function missingPhoneEnv(env: PhoneEnv): string[];

/** Gemini tokens of one call, by modality (TEXT / AUDIO ...), summed over its turns. */
export interface AiUsage {
  model: string;
  input: Record<string, number>;
  output: Record<string, number>;
}

/** 'ended' event: the call is over (answered or not); usage when the bot ran. */
export interface CallEnded {
  call_id: string;
  reason: string;
  usage?: AiUsage;
  /** the call's recording (a WAV file on this server's disk), when it was recorded */
  recording?: string;
}

export class PhoneLine extends EventEmitter {
  constructor(opts: { root: string; env: PhoneEnv; answer?: boolean; record?: boolean; incoming?: CallOptions });
  recent: PhoneLogLine[];
  log(text: string, callId?: string | null): void;
  status(): PhoneStatus;
  start(): Promise<void>;
  stop(): Promise<void>;
  hangup(): Promise<boolean>;
  /** The number of the running call, if it is `callId` (else null). */
  numberFor(callId: string): string | null;
  dial(number: string, opts?: CallOptions): Promise<{ call_id: string }>;
}
