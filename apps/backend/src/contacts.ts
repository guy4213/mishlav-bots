/**
 * The contacts in Supabase (supabase/migrations): who the bot calls, and how each call updates them.
 *
 * `contacts` is an exact copy of the Gold export (Gold's 16 columns, nothing of ours). The bot writes its results
 * into Gold's own fields (notes "[BOT] ..." lines, status); what it needs for dialing is in `bot_state`.
 *
 * Which record, when:
 *   1. dial a contact  -> callStarted(call_id, gold_record_id): calls row links the call to the contact (in_call)
 *   2. every tool      -> toolEvent(call_id, ...): Gold notes/status, bot_state, rep task of THAT contact
 *   3. the call ends   -> callEnded(call_id, ...): no result -> queued for a retry (or closed after the last try)
 * The decisions live in SQL (bot_call_started / bot_tool_event / bot_call_ended), one transaction each. A call
 * that is not a contact's (a scenario test) has no calls row, so it changes nothing.
 * Gold pulls what the bot changed with goldChanges() (GET /api/gold/changes).
 */
import type { Settings } from "@mishlav/shared";
import type { Gender } from "./gender";

/** Gold's columns, as in the export (settings.yaml gold_import.columns). */
export interface Contact {
  gold_record_id: string;
  national_id: string | null;
  company: string | null;
  full_name: string | null;
  email: string | null;
  phone: string | null;
  phone2: string | null;
  phone3: string | null;
  notes: string | null;
  city: string | null;
  address: string | null;
  address2: string | null;
  department: string | null;
  requested_course: string | null;
  source: string | null;
  status: string | null;
}

/** The bot's side of a contact (internal: Gold never sees it). */
export interface BotState {
  bot_status: string;
  attempts: number;
  next_call_at: string | null;
  callback_at: string | null;
  last_call_at: string | null;
  last_outcome: string | null;
  interested_day_id: string | null;
  customer_gender: Gender | null;
  /** which phone the bot dials: 1 = phone, 2 = phone2, 3 = phone3 */
  phone_index: number;
  gold_changed_at: string | null;
}

/** A contact as the dialer and the dashboard read it. */
export interface ContactRecord extends Contact {
  bot_state: BotState | null;
  rep_tasks?: { reason: string; callback_at: string | null; done: boolean; created_at: string }[];
}

/** What Gold receives: the changed contacts (Gold's columns only) and the `since` for the next pull. */
export interface GoldChanges {
  until: string;
  contacts: Contact[];
}

export interface ContactStore {
  list(): Promise<ContactRecord[]>;
  get(goldRecordId: string): Promise<ContactRecord | null>;
  callStarted(callId: string, goldRecordId: string): Promise<void>;
  toolEvent(callId: string, tool: string, params: unknown, result: unknown): Promise<string | null>;
  callEnded(callId: string, durationSec: number, retryMinutes: number, maxAttempts: number): Promise<string | null>;
  /** The contacts the bot changed after `since` (none: everything it ever changed). */
  goldChanges(since?: string): Promise<GoldChanges>;
}

/** Israeli number as dialed: 053-4271418 / 053 4271418 / 0534271418 / +972-53-... -> +972534271418. */
export function toE164(phone: string | null | undefined): string | null {
  let digits = (phone ?? "").replace(/\D/g, "");
  if (digits.startsWith("972")) digits = digits.slice(3);
  digits = digits.replace(/^0+/, "");
  return digits.length >= 8 && digits.length <= 9 ? `+972${digits}` : null;
}

/** The name the bot calls the customer by: the first word of Gold's full name. */
export function firstName(fullName: string | null | undefined): string | null {
  return fullName?.trim().split(/\s+/)[0] || null;
}

/** The phone the bot dials now (bot_state.phone_index), normalised; null when that phone is empty or invalid. */
export function dialNumber(c: ContactRecord): string | null {
  const phones = [c.phone, c.phone2, c.phone3];
  return toE164(phones[(c.bot_state?.phone_index ?? 1) - 1]);
}

/**
 * Gold's columns under the export's Hebrew headers, in the export's order (gold_import.columns inverted; the
 * first column has no header, so the record id goes under record_id_key).
 */
export function toGoldRecord(c: Contact, gi: Settings["gold_import"]): Record<string, string | null> {
  const row = c as unknown as Record<string, string | null>;
  const out: Record<string, string | null> = {};
  for (const [header, column] of Object.entries(gi.columns)) out[header || gi.record_id_key] = row[column] ?? null;
  return out;
}

const GOLD_FIELDS =
  "gold_record_id,national_id,company,full_name,email,phone,phone2,phone3,notes,city,address,address2,department,requested_course,source,status";
const FIELDS = `${GOLD_FIELDS},bot_state(*),rep_tasks(reason,callback_at,done,created_at)`;

/** PostgREST embeds a one-to-one relation as an object; be safe if it ever comes as a list. */
function normalise(c: ContactRecord): ContactRecord {
  const s = c.bot_state as unknown;
  return { ...c, bot_state: Array.isArray(s) ? ((s[0] as BotState) ?? null) : ((s as BotState) ?? null) };
}

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

  async list() {
    const rows = await this.req<ContactRecord[]>("GET", `/contacts?select=${FIELDS}&order=gold_record_id.asc&limit=500`);
    return rows.map(normalise);
  }

  async get(goldRecordId: string) {
    const rows = await this.req<ContactRecord[]>("GET", `/contacts?select=${FIELDS}&gold_record_id=eq.${encodeURIComponent(goldRecordId)}`);
    return rows[0] ? normalise(rows[0]) : null;
  }

  async callStarted(callId: string, goldRecordId: string) {
    await this.req("POST", "/rpc/bot_call_started", { p_call_id: callId, p_gold_record_id: goldRecordId });
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

  goldChanges(since?: string) {
    return this.req<GoldChanges>("POST", "/rpc/gold_changes", { p_since: since ?? null });
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
