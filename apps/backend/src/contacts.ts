/**
 * The contacts in Supabase (supabase/migrations): who the bot calls, and how each call updates them.
 *
 * `contacts` is an exact copy of the Gold export (Gold's 16 columns, nothing of ours). The bot writes its results
 * into Gold's own fields (notes "[הערת הבוט] ..." lines, status); what it needs for dialing is in `bot_state`.
 *
 * Which record, when:
 *   1. dial a contact  -> callStarted(call_id, gold_record_id): calls row links the call to the contact (in_call)
 *   2. every tool      -> toolEvent(call_id, ...): Gold notes/status, bot_state, rep task of THAT contact
 *   3. the call ends   -> callEnded(call_id, ...): no result -> queued for a retry; after the last try: closed, or
 *                         a rep when the customer answered before (settings.yaml dialing, packages/shared/src/retry.ts)
 * The decisions live in SQL (bot_call_started / bot_tool_event / bot_call_ended), one transaction each. A call
 * that is not a contact's (a scenario test) has no calls row, so it changes nothing.
 * Gold pulls what the bot changed with goldChanges() (GET /api/gold/changes).
 */
import type { AiUsage, Settings } from "@mishlav/shared";
import type { Gender } from "./gender";
import type { LogStore, StoredLogLine } from "./serverlog";
import { StudyDayExists, type StudyDayRow, type StudyDayStore, type StudyDayWrite } from "./study-days";
import { type DashboardUser, type UserStore, UserExists } from "./users";
import type { TranscriptLine } from "./transcripts";

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
  /** every call ever */
  attempts: number;
  /** no-result calls in a row (0 after the customer answered, or a wrong number moved to the next phone) */
  no_answer_streak: number;
  /** the customer answered at least once */
  ever_answered: boolean;
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

/** Where a call came from: the automatic dialer, or a test from the dashboard (calls.origin). */
export type CallOrigin = "dialer" | "manual";

/**
 * A call's own details in calls: the number it was on and who the bot talked to (a test call has no contact), and
 * at a test call's end how long it was and whether someone answered (a contact's call: bot_call_ended does that).
 */
export interface CallInfo {
  /** +972...: the number dialed, or the caller's on an incoming call */
  number?: string | null;
  /** the name the bot was given, on a call without a contact */
  contact_name?: string | null;
  direction?: "in" | "out";
  scenario?: string | null;
  duration_sec?: number;
  answered?: boolean;
}

/** The dialer's on/off switch (table dialer_control): it survives restarts and deploys. */
export interface DialerControl {
  enabled: boolean;
  changed_at: string;
  reason: string | null;
}

/** A contact in the dialing queue (bot_next_due). */
export interface QueuedContact {
  gold_record_id: string;
  bot_status: string;
  next_call_at: string | null;
}

/** What the automatic dialer (dialer.ts) reads and writes, besides the contacts themselves. */
export interface DialerStore {
  get(goldRecordId: string): Promise<ContactRecord | null>;
  dialerControl(): Promise<DialerControl>;
  setDialer(enabled: boolean, reason: string | null): Promise<DialerControl>;
  /**
   * The next contact to dial at `now` (callbacks, then retries, then new), skipping `skip`; only contacts whose
   * requested course is in `courses` (settings dialing.requested_courses; empty = everyone).
   */
  nextDue(now: Date, skip: string[], courses?: string[]): Promise<QueuedContact | null>;
  /** The first contact whose time comes after `now` (for the dashboard, when nothing is due). */
  nextScheduled(now: Date, courses?: string[]): Promise<QueuedContact | null>;
  /** No valid phone: out of the queue as a wrong number. Returns the contact's status after it. */
  markNoPhone(goldRecordId: string): Promise<string | null>;
  /** How many calls of this origin started since `since`. */
  callsSince(since: Date, origin: CallOrigin): Promise<number>;
}

/** When the bot stops calling a contact (settings.yaml dialing). */
export interface CallLimits {
  noAnswerStreakMax: number;
  maxTotalCalls: number;
}

export interface ContactStore {
  list(): Promise<ContactRecord[]>;
  get(goldRecordId: string): Promise<ContactRecord | null>;
  callStarted(callId: string, goldRecordId: string, origin?: CallOrigin): Promise<void>;
  toolEvent(callId: string, tool: string, params: unknown, result: unknown): Promise<string | null>;
  /** nextCallAt[i] = the next call if this one makes a no-answer streak of i + 1 (noAnswerRetryTimes). */
  callEnded(callId: string, durationSec: number, nextCallAt: Date[], limits: CallLimits): Promise<string | null>;
  /** The contacts the bot changed after `since` (none: everything it ever changed). */
  goldChanges(since?: string): Promise<GoldChanges>;
  /** The phone a contact's call is on (as written in Gold; null: not a contact's call, or no phone). */
  callNumber(callId: string): Promise<string | null>;
  /** Stores the call's transcript (calls.transcript) so it outlives the server's disk. Card numbers already removed. */
  saveTranscript?(callId: string, lines: TranscriptLine[]): Promise<void>;
  /** Uploads the call's recording (an MP3 on this server's disk) to Storage and links it (calls.recording_path). */
  saveRecording?(callId: string, file: string): Promise<void>;
  /** Stores the call's Gemini tokens and their cost (calls.ai_usage / ai_cost_usd). */
  saveUsage?(callId: string, usage: AiUsage, costUsd: number | null): Promise<void>;
  /** A test call without a contact (a typed number, "שיחה אליי", an incoming call): a calls row of its own. */
  testCallStarted?(callId: string, info: CallInfo): Promise<void>;
  /** The call's number, name, direction, scenario; a test call's length and whether someone answered. */
  saveCallInfo?(callId: string, info: CallInfo): Promise<void>;
  /** The voice the team picked in the dashboard for every call (dialer_control.voice); null: PHONE_VOICE. */
  botVoice?(): Promise<string | null>;
  setBotVoice?(voice: string | null): Promise<void>;
}

/** One row of calls (the list leaves the transcript out). */
export interface CallRow {
  call_id: string;
  /** null: a test call without a contact (a typed number, "שיחה אליי", an incoming call) */
  gold_record_id: string | null;
  started_at: string;
  duration_sec: number | null;
  outcome: string | null;
  reason: string | null;
  summary: string | null;
  answered: boolean;
  origin: CallOrigin;
  /** what the call's Gemini tokens cost (USD), when the bot ran */
  ai_cost_usd?: number | null;
  /** its recording in Storage (bucket "recordings"), when it was recorded */
  recording_path?: string | null;
  /** the number the call was on (+972...); null on calls from before it was kept */
  number?: string | null;
  /** who the bot talked to on a call without a contact */
  contact_name?: string | null;
  direction?: "in" | "out";
  scenario?: string | null;
  /** the contact's name (contacts.full_name) */
  full_name: string | null;
}

/** A task the bot left for a rep (request_human, or unreachable after it answered once). */
export interface RepTask {
  id: string;
  gold_record_id: string;
  call_id: string | null;
  reason: string;
  callback_at: string | null;
  note: string | null;
  done: boolean;
  created_at: string;
}

/** A rep task with who to call: the name, and the phone the bot used (bot_state.phone_index) as written in Gold. */
export interface RepTaskRow extends RepTask {
  full_name: string | null;
  phone: string | null;
}

/** dashboard_summary(): today's dialer calls, the contacts' funnel and the queue (supabase/migrations). */
export interface DashboardSummary {
  day_start: string;
  today: { total: number; answered: number; no_result: number; outcomes: Record<string, number>; manual_total: number };
  funnel: { new: number; in_queue: number; handled: number; closed: number };
  by_status: Record<string, number>;
  contacts_total: number;
  due_now: number;
  open_rep_tasks: number;
  next_due: { gold_record_id: string; full_name: string | null; bot_status: string; next_call_at: string | null }[];
}

/** What the management dashboard reads (routes/admin.ts), besides the contacts list. */
export interface AdminStore {
  /** a link to play the call's recording, valid for an hour (null: not recorded) */
  recordingUrl?(callId: string): Promise<string | null>;
  /** deletes recordings of calls before `before`; returns how many */
  pruneRecordings?(before: Date): Promise<number>;
  /** dayStart: midnight in the business time zone */
  summary(dayStart: Date): Promise<DashboardSummary>;
  /** the contact's calls, newest first */
  contactCalls(goldRecordId: string): Promise<CallRow[]>;
  /** all the contact's rep tasks (done ones too), newest first */
  contactRepTasks(goldRecordId: string): Promise<RepTask[]>;
  /** calls newest first; origin null = both */
  calls(limit: number, origin: CallOrigin | null): Promise<CallRow[]>;
  call(callId: string): Promise<(CallRow & { transcript: TranscriptLine[] | null }) | null>;
  /** open tasks (or all), by callback time (as soon as possible first) */
  repTasks(openOnly: boolean): Promise<RepTaskRow[]>;
  /** marks a task done; null when there is no such task */
  repTaskDone(id: string): Promise<RepTask | null>;
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
const CALL_FIELDS =
  "call_id,gold_record_id,started_at,duration_sec,outcome,reason,summary,answered,origin,ai_cost_usd,recording_path,number,contact_name,direction,scenario";
const TASK_FIELDS = "id,gold_record_id,call_id,reason,callback_at,note,done,created_at";
type Embedded<T> = T | T[] | null;
const one = <T>(v: Embedded<T> | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));

/** A calls row with its contact embedded (PostgREST) -> CallRow. */
function callRow(r: Omit<CallRow, "full_name"> & { contacts?: Embedded<{ full_name: string | null }> }): CallRow {
  const { contacts, ...call } = r;
  return { ...call, full_name: one(contacts)?.full_name ?? null };
}

export class SupabaseContacts implements ContactStore, DialerStore, AdminStore, LogStore, StudyDayStore, UserStore {
  private readonly base: string;
  constructor(
    url: string,
    private readonly serviceKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 5000,
  ) {
    this.base = `${url.replace(/\/+$/, "")}/rest/v1`;
  }

  private async req<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const res = await this.fetchImpl(this.base + path, {
      method,
      headers: {
        apikey: this.serviceKey,
        authorization: `Bearer ${this.serviceKey}`,
        "content-type": "application/json",
        accept: "application/json",
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`Supabase ${method} ${path.split("?")[0]}: HTTP ${res.status} ${text.slice(0, 200)}`);
      throw Object.assign(err, { status: res.status });
    }
    return (text ? JSON.parse(text) : null) as T;
  }

  // ---- the server log (serverlog.ts): kept 14 days so a deploy doesn't wipe it

  async appendLogs(lines: StoredLogLine[]) {
    await this.req("POST", "/server_logs", lines, { prefer: "return=minimal" });
  }

  logHistory({ excludeBoot, callId, limit }: { excludeBoot: string; callId?: string; limit: number }) {
    const q = [
      "select=boot,seq,ts,kind,call_id,text",
      `boot=neq.${encodeURIComponent(excludeBoot)}`,
      ...(callId ? [`call_id=eq.${encodeURIComponent(callId)}`] : []),
      "order=ts.desc,id.desc",
      `limit=${Math.max(1, Math.min(limit, 5000))}`,
    ];
    return this.req<StoredLogLine[]>("GET", `/server_logs?${q.join("&")}`);
  }

  async pruneLogs(before: Date) {
    await this.req("DELETE", `/server_logs?ts=lt.${encodeURIComponent(before.toISOString())}`, undefined, { prefer: "return=minimal" });
  }

  async list() {
    const rows = await this.req<ContactRecord[]>("GET", `/contacts?select=${FIELDS}&order=gold_record_id.asc&limit=500`);
    return rows.map(normalise);
  }

  async get(goldRecordId: string) {
    const rows = await this.req<ContactRecord[]>("GET", `/contacts?select=${FIELDS}&gold_record_id=eq.${encodeURIComponent(goldRecordId)}`);
    return rows[0] ? normalise(rows[0]) : null;
  }

  async callStarted(callId: string, goldRecordId: string, origin: CallOrigin = "manual") {
    await this.req("POST", "/rpc/bot_call_started", { p_call_id: callId, p_gold_record_id: goldRecordId, p_origin: origin });
  }

  toolEvent(callId: string, tool: string, params: unknown, result: unknown) {
    return this.req<string | null>("POST", "/rpc/bot_tool_event", { p_call_id: callId, p_tool: tool, p_params: params ?? {}, p_result: result });
  }

  callEnded(callId: string, durationSec: number, nextCallAt: Date[], limits: CallLimits) {
    return this.req<string | null>("POST", "/rpc/bot_call_ended", {
      p_call_id: callId,
      p_duration_sec: Math.round(durationSec),
      p_next_call_at: nextCallAt.map((t) => t.toISOString()),
      p_no_answer_streak_max: limits.noAnswerStreakMax,
      p_max_total_calls: limits.maxTotalCalls,
    });
  }

  goldChanges(since?: string) {
    return this.req<GoldChanges>("POST", "/rpc/gold_changes", { p_since: since ?? null });
  }

  callNumber(callId: string) {
    return this.req<string | null>("POST", "/rpc/bot_call_number", { p_call_id: callId });
  }

  // ---- call recordings: Supabase Storage, private bucket "recordings" (only this service role reads it)

  private get storage() {
    return this.base.replace(/\/rest\/v1$/, "/storage/v1");
  }

  private async storageReq(method: string, path: string, body?: string | Uint8Array, headers: Record<string, string> = {}, timeoutMs = 60000) {
    const res = await this.fetchImpl(this.storage + path, {
      method,
      headers: { apikey: this.serviceKey, authorization: `Bearer ${this.serviceKey}`, ...headers },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Supabase Storage ${method} ${path.split("?")[0]}: HTTP ${res.status} ${text.slice(0, 200)}`);
    return text ? (JSON.parse(text) as unknown) : null;
  }

  async saveRecording(callId: string, file: string) {
    const { readFile, unlink } = await import("node:fs/promises");
    const ext = file.endsWith(".mp3") ? "mp3" : "wav"; // MP3; WAV only if encoding failed
    const path = `${callId}.${ext}`;
    await this.storageReq("POST", `/object/recordings/${encodeURIComponent(path)}`, await readFile(file), {
      "content-type": ext === "mp3" ? "audio/mpeg" : "audio/wav",
      "x-upsert": "true",
    });
    await this.req("PATCH", `/calls?call_id=eq.${encodeURIComponent(callId)}`, { recording_path: path });
    await unlink(file).catch(() => {}); // kept in Storage now: the server's disk is small
  }

  /** A link to play the recording, valid for an hour (null: not recorded). */
  async recordingUrl(callId: string): Promise<string | null> {
    const rows = await this.req<{ recording_path: string | null }[]>(
      "GET",
      `/calls?select=recording_path&call_id=eq.${encodeURIComponent(callId)}`,
    );
    const path = rows[0]?.recording_path;
    if (!path) return null;
    const r = (await this.storageReq("POST", `/object/sign/recordings/${encodeURIComponent(path)}`, JSON.stringify({ expiresIn: 3600 }), {
      "content-type": "application/json",
    })) as { signedURL?: string } | null;
    return r?.signedURL ? `${this.storage}${r.signedURL.startsWith("/") ? "" : "/"}${r.signedURL}` : null;
  }

  /** Deletes recordings older than `before` (retention), and unlinks them from their calls. Returns how many. */
  async pruneRecordings(before: Date): Promise<number> {
    const rows = await this.req<{ call_id: string; recording_path: string }[]>(
      "GET",
      `/calls?select=call_id,recording_path&recording_path=not.is.null&started_at=lt.${encodeURIComponent(before.toISOString())}&limit=500`,
    );
    if (!rows.length) return 0;
    await this.storageReq("DELETE", "/object/recordings", JSON.stringify({ prefixes: rows.map((r) => r.recording_path) }), {
      "content-type": "application/json",
    });
    const ids = rows.map((r) => `"${r.call_id.replace(/"/g, "")}"`).join(",");
    await this.req("PATCH", `/calls?call_id=in.(${encodeURIComponent(ids)})`, { recording_path: null });
    return rows.length;
  }

  async saveUsage(callId: string, usage: AiUsage, costUsd: number | null) {
    await this.req("PATCH", `/calls?call_id=eq.${encodeURIComponent(callId)}`, { ai_usage: usage, ai_cost_usd: costUsd });
  }

  async saveTranscript(callId: string, lines: TranscriptLine[]) {
    await this.req("PATCH", `/calls?call_id=eq.${encodeURIComponent(callId)}`, { transcript: lines });
  }

  async testCallStarted(callId: string, info: CallInfo) {
    await this.req("POST", "/calls", { call_id: callId, origin: "manual", ...info }, { prefer: "return=minimal" });
  }

  async saveCallInfo(callId: string, info: CallInfo) {
    await this.req("PATCH", `/calls?call_id=eq.${encodeURIComponent(callId)}`, info);
  }

  // ---- the management dashboard (AdminStore)
  summary(dayStart: Date) {
    return this.req<DashboardSummary>("POST", "/rpc/dashboard_summary", { p_day_start: dayStart.toISOString() });
  }

  async contactCalls(goldRecordId: string) {
    const rows = await this.req<Omit<CallRow, "full_name">[]>(
      "GET",
      `/calls?select=${CALL_FIELDS}&gold_record_id=eq.${encodeURIComponent(goldRecordId)}&order=started_at.desc&limit=200`,
    );
    return rows.map((r) => ({ ...r, full_name: null }));
  }

  contactRepTasks(goldRecordId: string) {
    return this.req<RepTask[]>(
      "GET",
      `/rep_tasks?select=${TASK_FIELDS}&gold_record_id=eq.${encodeURIComponent(goldRecordId)}&order=created_at.desc`,
    );
  }

  async calls(limit: number, origin: CallOrigin | null) {
    const rows = await this.req<Parameters<typeof callRow>[0][]>(
      "GET",
      `/calls?select=${CALL_FIELDS},contacts(full_name)${origin ? `&origin=eq.${origin}` : ""}&order=started_at.desc&limit=${limit}`,
    );
    return rows.map(callRow);
  }

  async call(callId: string) {
    const rows = await this.req<(Parameters<typeof callRow>[0] & { transcript: TranscriptLine[] | null })[]>(
      "GET",
      `/calls?select=${CALL_FIELDS},transcript,contacts(full_name)&call_id=eq.${encodeURIComponent(callId)}`,
    );
    return rows[0] ? { ...callRow(rows[0]), transcript: rows[0].transcript ?? null } : null;
  }

  async repTasks(openOnly: boolean) {
    type Row = RepTask & {
      contacts: Embedded<Pick<Contact, "full_name" | "phone" | "phone2" | "phone3"> & { bot_state: Embedded<{ phone_index: number }> }>;
    };
    const rows = await this.req<Row[]>(
      "GET",
      `/rep_tasks?select=${TASK_FIELDS},contacts(full_name,phone,phone2,phone3,bot_state(phone_index))` +
        `${openOnly ? "&done=eq.false" : ""}&order=callback_at.asc.nullsfirst,created_at.asc&limit=500`,
    );
    return rows.map(({ contacts, ...task }) => {
      const c = one(contacts);
      const phones = [c?.phone, c?.phone2, c?.phone3];
      const used = phones[(one(c?.bot_state)?.phone_index ?? 1) - 1] ?? null;
      return { ...task, full_name: c?.full_name ?? null, phone: used || c?.phone || null };
    });
  }

  async repTaskDone(id: string) {
    const rows = await this.req<RepTask[]>(
      "PATCH",
      `/rep_tasks?id=eq.${encodeURIComponent(id)}&select=${TASK_FIELDS}`,
      { done: true },
      { prefer: "return=representation" },
    );
    return rows[0] ?? null;
  }

  async dialerControl() {
    const rows = await this.req<DialerControl[]>("GET", "/dialer_control?select=enabled,changed_at,reason");
    if (!rows[0]) throw new Error("dialer_control has no row (supabase/migrations)");
    return rows[0];
  }

  async botVoice() {
    const rows = await this.req<{ voice: string | null }[]>("GET", "/dialer_control?select=voice");
    return rows[0]?.voice ?? null;
  }

  async setBotVoice(voice: string | null) {
    await this.req("PATCH", "/dialer_control?id=eq.true", { voice });
  }

  // ---- the study days (study-days.ts): the dashboard edits them, the bot reads them every minute

  studyDays() {
    return this.req<StudyDayRow[]>("GET", "/study_days?select=*&order=date.asc,id.asc");
  }

  async createStudyDay(row: StudyDayWrite & { id: string }) {
    try {
      const rows = await this.req<StudyDayRow[]>("POST", "/study_days", row, { prefer: "return=representation" });
      return rows[0]!;
    } catch (err) {
      if ((err as { status?: number }).status === 409) throw new StudyDayExists(row.id);
      throw err;
    }
  }

  async updateStudyDay(id: string, row: StudyDayWrite) {
    const rows = await this.req<StudyDayRow[]>(
      "PATCH",
      `/study_days?id=eq.${encodeURIComponent(id)}`,
      { ...row, updated_at: new Date().toISOString() },
      { prefer: "return=representation" },
    );
    return rows[0] ?? null;
  }

  async setStudyDayArchived(id: string, archived: boolean) {
    const at = new Date().toISOString();
    const rows = await this.req<StudyDayRow[]>(
      "PATCH",
      `/study_days?id=eq.${encodeURIComponent(id)}`,
      { archived_at: archived ? at : null, updated_at: at },
      { prefer: "return=representation" },
    );
    return rows[0] ?? null;
  }

  // ---- the dashboard's logins (users.ts)
  dashboardUsers() {
    return this.req<DashboardUser[]>("GET", "/dashboard_users?select=*&order=created_at.asc");
  }

  async createDashboardUser(row: Pick<DashboardUser, "phone" | "name" | "role" | "password_hash">) {
    try {
      const rows = await this.req<DashboardUser[]>("POST", "/dashboard_users", row, { prefer: "return=representation" });
      return rows[0]!;
    } catch (err) {
      if ((err as { status?: number }).status === 409) throw new UserExists(row.phone);
      throw err;
    }
  }

  async updateDashboardUser(id: string, patch: Partial<DashboardUser>) {
    const rows = await this.req<DashboardUser[]>("PATCH", `/dashboard_users?id=eq.${encodeURIComponent(id)}`, patch, {
      prefer: "return=representation",
    });
    return rows[0] ?? null;
  }

  setDialer(enabled: boolean, reason: string | null) {
    return this.req<DialerControl>("POST", "/rpc/dialer_set", { p_enabled: enabled, p_reason: reason });
  }

  async nextDue(now: Date, skip: string[], courses: string[] = []) {
    const rows = await this.req<QueuedContact[]>("POST", "/rpc/bot_next_due_for", {
      p_now: now.toISOString(),
      p_skip: skip,
      p_courses: courses.length ? courses : null,
    });
    return rows[0] ?? null;
  }

  async nextScheduled(now: Date, courses: string[] = []) {
    // only the courses the dialer calls: the contact's requested_course through the join (contacts!inner)
    const byCourse = courses.length
      ? `,contacts!inner(requested_course)&contacts.requested_course=in.(${courses.map((c) => encodeURIComponent(`"${c}"`)).join(",")})`
      : "";
    const rows = await this.req<(QueuedContact & { contacts?: unknown })[]>(
      "GET",
      `/bot_state?select=gold_record_id,bot_status,next_call_at${byCourse}&bot_status=in.(new,queued,callback)` +
        `&next_call_at=gt.${encodeURIComponent(now.toISOString())}&order=next_call_at.asc,gold_record_id.asc&limit=1`,
    );
    const row = rows[0];
    return row ? { gold_record_id: row.gold_record_id, bot_status: row.bot_status, next_call_at: row.next_call_at } : null;
  }

  markNoPhone(goldRecordId: string) {
    return this.req<string | null>("POST", "/rpc/bot_mark_no_phone", { p_gold_record_id: goldRecordId });
  }

  async callsSince(since: Date, origin: CallOrigin) {
    const rows = await this.req<unknown[]>(
      "GET",
      `/calls?select=call_id&origin=eq.${origin}&started_at=gte.${encodeURIComponent(since.toISOString())}`,
    );
    return rows.length;
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
export function contactStoreFromEnv(env: NodeJS.ProcessEnv): SupabaseContacts | undefined {
  const url = env.SUPABASE_URL?.trim();
  const key = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  return url && key ? new SupabaseContacts(url, key) : undefined;
}
