/**
 * The contacts in Supabase (supabase/migrations): who the bot calls, and how each call updates them.
 *
 * Which record, when:
 *   1. dial a contact  -> callStarted(call_id, contact_id): calls row links the call to the contact (in_call)
 *   2. every tool      -> toolEvent(call_id, ...): status / callback / rep task / "[BOT]" note of THAT contact
 *   3. the call ends   -> callEnded(call_id, ...): no result -> queued for a retry (or closed after the last try)
 * The decisions live in SQL (bot_call_started / bot_tool_event / bot_call_ended), one transaction each. A call
 * that is not a contact's (a scenario test) has no calls row, so it changes nothing.
 */
import type { Gender } from "./gender";

export interface Contact {
  id: string;
  gold_record_id: string;
  full_name: string | null;
  first_name: string | null;
  phone: string | null;
  phone_e164: string | null;
  status: string;
  interested_day_id: string | null;
  customer_gender: Gender | null;
  attempts: number;
  next_call_at: string | null;
  callback_at: string | null;
  last_outcome: string | null;
  // shown in the dashboard before a test call (who the tester plays)
  company?: string | null;
  email?: string | null;
  city?: string | null;
  requested_course?: string | null;
  source?: string | null;
  gold_status?: string | null;
  gold_notes?: string | null;
  bot_notes?: string | null;
  last_call_at?: string | null;
  rep_tasks?: { reason: string; callback_at: string | null; done: boolean; created_at: string }[];
}

export interface ContactStore {
  list(): Promise<Contact[]>;
  get(id: string): Promise<Contact | null>;
  callStarted(callId: string, contactId: string): Promise<void>;
  toolEvent(callId: string, tool: string, params: unknown, result: unknown): Promise<string | null>;
  callEnded(callId: string, durationSec: number, retryMinutes: number, maxAttempts: number): Promise<string | null>;
}

const FIELDS =
  "id,gold_record_id,full_name,first_name,phone,phone_e164,status,interested_day_id,customer_gender,attempts,next_call_at,callback_at,last_outcome," +
  "company,email,city,requested_course,source,gold_status,gold_notes,bot_notes,last_call_at," +
  "rep_tasks(reason,callback_at,done,created_at)";

/** Supabase over its REST API (PostgREST), with the service role key - the only role the tables let in. */
export class SupabaseContacts implements ContactStore {
  private readonly base: string;
  constructor(
    url: string,
    private readonly serviceKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 5000,
  ) {
    this.base = `${url.replace(/\/+$/, "")}/rest/v1`;
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(this.base + path, {
      method,
      headers: {
        apikey: this.serviceKey,
        authorization: `Bearer ${this.serviceKey}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Supabase ${method} ${path.split("?")[0]}: HTTP ${res.status} ${text.slice(0, 200)}`);
    return (text ? JSON.parse(text) : null) as T;
  }

  list() {
    return this.req<Contact[]>("GET", `/contacts?select=${FIELDS}&order=imported_at.asc,gold_record_id.asc&limit=500`);
  }

  async get(id: string) {
    const rows = await this.req<Contact[]>("GET", `/contacts?select=${FIELDS}&id=eq.${encodeURIComponent(id)}`);
    return rows[0] ?? null;
  }

  async callStarted(callId: string, contactId: string) {
    await this.req("POST", "/rpc/bot_call_started", { p_call_id: callId, p_contact_id: contactId });
  }

  toolEvent(callId: string, tool: string, params: unknown, result: unknown) {
    return this.req<string | null>("POST", "/rpc/bot_tool_event", { p_call_id: callId, p_tool: tool, p_params: params ?? {}, p_result: result });
  }

  callEnded(callId: string, durationSec: number, retryMinutes: number, maxAttempts: number) {
    return this.req<string | null>("POST", "/rpc/bot_call_ended", {
      p_call_id: callId,
      p_duration_sec: Math.round(durationSec),
      p_retry_minutes: retryMinutes,
      p_max_attempts: maxAttempts,
    });
  }
}

/**
 * Runs each call's updates one after another, in the order they happened, without holding up the bot's answer.
 * A failure is reported (onError -> the tool log, shown in the dashboard), never thrown at the bot.
 */
export class ContactEvents {
  private readonly chains = new Map<string, Promise<unknown>>();
  constructor(
    readonly store: ContactStore,
    private readonly onError: (callId: string, what: string, err: Error) => void,
  ) {}

  /** Queues `fn` after the call's earlier updates. Resolves when it ran (for tests and the call's end). */
  run(callId: string, what: string, fn: (s: ContactStore) => Promise<unknown>): Promise<void> {
    const prev = this.chains.get(callId) ?? Promise.resolve();
    const next = prev
      .then(() => fn(this.store))
      .then(
        () => undefined,
        (err: Error) => this.onError(callId, what, err),
      );
    this.chains.set(callId, next);
    void next.then(() => {
      if (this.chains.get(callId) === next) this.chains.delete(callId);
    });
    return next;
  }
}

/** From the env: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, else no contacts (scenario tests only). */
export function contactStoreFromEnv(env: NodeJS.ProcessEnv): ContactStore | undefined {
  const url = env.SUPABASE_URL?.trim();
  const key = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  return url && key ? new SupabaseContacts(url, key) : undefined;
}
