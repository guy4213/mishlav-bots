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
}

export function phoneEnv(env: NodeJS.ProcessEnv, root: string): PhoneEnv;
export function missingPhoneEnv(env: PhoneEnv): string[];

export class PhoneLine extends EventEmitter {
  constructor(opts: { root: string; env: PhoneEnv; answer?: boolean; record?: boolean; incoming?: CallOptions });
  recent: PhoneLogLine[];
  log(text: string, callId?: string | null): void;
  status(): PhoneStatus;
  start(): Promise<void>;
  stop(): Promise<void>;
  hangup(): Promise<boolean>;
  dial(number: string, opts?: CallOptions): Promise<{ call_id: string }>;
}
