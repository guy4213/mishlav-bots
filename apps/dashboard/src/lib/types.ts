/**
 * What the server answers, as this page reads it. Written here rather than imported from apps/backend: the backend's
 * types sit in files that import Node modules (and @mishlav/shared's index does too), which a browser bundle can't take.
 * The source of each one is named next to it.
 */

export type Role = "admin" | "mishlav";

/** users.ts PublicUser (never the hash) */
export interface User {
  id: string;
  phone: string;
  name: string;
  role: Role;
  active: boolean;
  password_changed_at: string;
  last_login_at: string | null;
  created_at: string;
}

export interface ServerVersion {
  version: string;
  started_at: string;
  commit: string | null;
}

/** GET /auth/me */
export interface Me {
  ok: true;
  role: Role;
  via: "secret" | "session";
  user: User | null;
  viewing_as: boolean;
  server?: ServerVersion;
}

/** GET /api/admin/env */
export interface Env {
  ok: true;
  env: "production" | "local";
  commit: string | null;
  phone_line: { available: boolean; registered: boolean; reason: string | null };
  supabase: boolean;
  whatsapp_provider: string;
  gold_api_key_set: boolean;
  dialer_only_numbers: boolean;
  timezone: string;
}

/** dialer.ts DialerStatus */
export interface DialerStatus {
  state: string;
  daily_limit: number | null;
  enabled: boolean | null;
  changed_at: string | null;
  reason: string | null;
  current_call: { call_id: string; gold_record_id: string; name: string | null; started_at: string } | null;
  next_due: { gold_record_id: string; next_call_at: string | null } | null;
  calls_today: number;
  last_error: { message: string; at: string } | null;
  failures: number;
  only_numbers: boolean;
  checked_at: string | null;
}

/** apps/phone/src/line.js status() (the number masked) */
export interface LineStatus {
  registered: boolean;
  error: string | null;
  number?: string;
  model?: string;
  voice?: string;
  busy: boolean;
  call: { id: string; direction: "in" | "out"; number: string; scenario: string | null; started_at: string } | null;
}

/** GET /test/phone */
export interface PhoneInfo {
  ok: true;
  available: boolean;
  reason: string | null;
  status: LineStatus | null;
}

/** contacts.ts BotState */
export interface BotState {
  bot_status: string;
  attempts: number;
  no_answer_streak: number;
  ever_answered?: boolean;
  next_call_at: string | null;
  callback_at: string | null;
  last_call_at: string | null;
  last_outcome: string | null;
  interested_day_id?: string | null;
  customer_gender?: string | null;
  phone_index: number;
  gold_changed_at?: string | null;
}

/** contacts.ts ContactRecord (a list row has fewer of Gold's fields: LIST_GOLD) */
export interface Contact {
  gold_record_id: string;
  full_name: string | null;
  phone: string | null;
  status: string | null;
  requested_course?: string | null;
  national_id?: string | null;
  company?: string | null;
  email?: string | null;
  phone2?: string | null;
  phone3?: string | null;
  notes?: string | null;
  city?: string | null;
  address?: string | null;
  address2?: string | null;
  department?: string | null;
  source?: string | null;
  bot_state: BotState | null;
  rep_tasks?: { reason?: string; callback_at?: string | null; done: boolean; created_at?: string; note?: string | null; id?: string }[];
  /** the queue view: its time has come */
  due?: boolean;
}

/** contacts.ts CallRow */
export interface CallRow {
  call_id: string;
  gold_record_id: string | null;
  started_at: string;
  duration_sec: number | null;
  outcome: string | null;
  reason: string | null;
  summary: string | null;
  answered: boolean;
  origin: string;
  ai_cost_usd?: number | null;
  recording_path?: string | null;
  number?: string | null;
  contact_name?: string | null;
  direction?: "in" | "out";
  scenario?: string | null;
  full_name: string | null;
}

export interface TranscriptLine {
  ts: string;
  role: string;
  text: string;
}

/** a tool call as the tool log keeps it (packages/shared ToolCallLogEntry) */
export interface ToolCall {
  ts: string;
  tool: string;
  ok: boolean;
  params?: Record<string, unknown> | null;
  response?: { scheduled_time_he?: string; error?: string } & Record<string, unknown>;
  error?: string | null;
}

/** GET /api/admin/calls/:id */
export interface CallDetail {
  ok: true;
  call: CallRow | null;
  live: boolean;
  transcript: TranscriptLine[];
  transcript_source: "db" | "file" | "none";
  tools: ToolCall[];
  errors: { ts: string; what: string; error: string }[];
}

/** a paged list (routes/admin.ts paging) */
export interface Paged {
  total: number;
  page: number;
  page_size: number;
  pages: number;
}

/** contacts.ts RepTaskRow */
export interface RepTask {
  id: string;
  gold_record_id: string;
  call_id: string | null;
  reason: string;
  callback_at: string | null;
  note: string | null;
  done: boolean;
  created_at: string;
  full_name: string | null;
  phone: string | null;
}

/** contacts.ts DashboardSummary */
export interface Summary {
  day_start: string;
  today: { total: number; answered: number; no_result: number; outcomes: Record<string, number>; manual_total: number };
  funnel: Record<"new" | "in_queue" | "handled" | "closed", number>;
  by_status: Record<string, number>;
  contacts_total: number;
  due_now: number;
  open_rep_tasks: number;
  next_due: { gold_record_id: string; full_name: string | null; bot_status: string; next_call_at: string | null }[];
}

/** study-days.ts StudyDayRow */
export interface StudyDayRow {
  id: string;
  title: string;
  topic: string;
  date: string;
  end_date: string | null;
  start_time: string;
  end_time: string;
  format: "zoom" | "hotel";
  series: string | null;
  location: string;
  price_ils: number | string;
  vat_included: boolean;
  open_for_registration: boolean;
  course_number: string | null;
  purchase_url: string | null;
  lecturers: string[] | null;
  academic_hours: number | string | null;
  description: string;
  archived_at: string | null;
  updated_at?: string;
}

/** routes/study-days.ts view(): rowForDashboard + the bot's view */
export interface StudyDay {
  id: string;
  raw: StudyDayRow;
  dates_he: string;
  format_he: string;
  archived: boolean;
  error: string | null;
  note_he: string | null;
  offered_to_bot: boolean;
}

/** GET /test/overview scenarios (routes/dashboard.ts scenarioView) */
export interface Scenario {
  id: string;
  name: string;
  core: boolean;
  actor_script?: unknown[];
  guide: { title?: string; expect?: string; tips?: string[]; watch?: string[] } | null;
  expected_outcome: string | string[] | null;
  required_tools: string[];
  forbidden_tools: string[];
}

/** serverlog.ts LogLine (old: from the database, an earlier server start) */
export interface LogLine {
  seq: number;
  ts: string;
  kind: string;
  call_id: string | null;
  text: string;
  old?: boolean;
}
