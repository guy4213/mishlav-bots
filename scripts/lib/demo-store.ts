/**
 * Invented data for the dashboard demo server (scripts/dashboard-demo.ts): contacts, calls, rep tasks, study days,
 * users and an old log, all made up here (no real customer, no real phone), plus a phone line that pretends to call.
 * Everything is in memory: the demo never reaches Supabase, Zadarma, an SMS provider or any other service.
 */
import { EventEmitter } from "node:events";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
  AdminStore, BotState, CallInfo, CallLimits, CallOrigin, CallRow, ContactRecord, ContactStore, ContactsQuery, CallsQuery,
  DashboardSummary, DialerControl, DialerStore, GoldChanges, QueuedContact, RepTask, RepTasksQuery,
} from "../../apps/backend/src/contacts";
import type { LogStore, StoredLogLine } from "../../apps/backend/src/serverlog";
import { StudyDayExists, type StudyDayRow, type StudyDayStore, type StudyDayWrite } from "../../apps/backend/src/study-days";
import type { TranscriptLine } from "../../apps/backend/src/transcripts";
import { type DashboardUser, hashPassword, type UserStore, UserExists } from "../../apps/backend/src/users";
import { DEMO_PASSWORDS } from "./demo-users";

/** A small seeded random: the same invented data on every start. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
const rand = rng(20261125);
const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
const int = (a: number, b: number) => a + Math.floor(rand() * (b - a + 1));

const FIRST = ["נועה", "יעל", "תמר", "מיכל", "שירה", "רוני", "אורי", "איתי", "דניאל", "עומר", "נדב", "גלעד", "הדר", "ליאת", "שני", "רועי", "אביב", "טל", "ענבל", "יובל"];
const LAST = ["אברהמי", "בן-דוד", "גולן", "דרור", "הלפרין", "ורדי", "זיו", "חיימוביץ", "טל", "ירון", "כרמלי", "לביא", "מזרחי", "נחום", "סלע", "עמית", "פרץ", "צור", "קדם", "רז"];
const CITIES = ["חיפה", "תל אביב", "ירושלים", "באר שבע", "נתניה", "רחובות", "מודיעין", "כפר סבא", "אשדוד", "עפולה"];
const COMPANIES = ["משרד רו\"ח דמו", "חברת הדגמה בע\"מ", "סטודיו נתונים", "", "", ""];
export const DEMO_COURSE = "יום עיון חשבונאות";
const STATUSES = ["new", "new", "new", "queued", "callback", "link_sent", "hot_lead", "not_interested", "no_answer", "voicemail", "do_not_call", "duplicate", "human_followup", "company"];
const OUTCOMES: Record<string, string> = {
  link_sent: "LINK_SENT", hot_lead: "HOT_LEAD", not_interested: "NOT_INTERESTED", callback: "CALLBACK", voicemail: "VOICEMAIL",
  do_not_call: "DO_NOT_CALL", human_followup: "HUMAN_FOLLOWUP", company: "COMPANY", no_answer: "NO_RESULT",
};

const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString();
const dateOnly = (t: number) => iso(t).slice(0, 10);
/** An invented mobile number (+97250..., never a real person's on purpose). */
const phone = (i: number) => `05${int(0, 8)}-${String(5_000_000 + ((i * 7919) % 4_000_000)).padStart(7, "0")}`;
const e164 = (p: string) => `+972${p.replace(/\D/g, "").replace(/^0/, "")}`;

interface CallRec extends CallRow {
  transcript: TranscriptLine[] | null;
}

export class DemoStore implements ContactStore, AdminStore, DialerStore, StudyDayStore, UserStore, LogStore {
  contacts: ContactRecord[] = [];
  calls_: CallRec[] = [];
  tasks: RepTask[] = [];
  days: StudyDayRow[] = [];
  users: DashboardUser[] = [];
  control: DialerControl & { voice: string | null } = { enabled: false, changed_at: iso(Date.now() - 3 * 3600_000), reason: "נעצר מהדשבורד", daily_limit: 40, voice: null };
  private n = 0;

  static async create(): Promise<DemoStore> {
    const s = new DemoStore();
    const now = Date.now();
    for (let i = 1; i <= 137; i++) {
      const status = pick(STATUSES);
      const called = !["new", "queued"].includes(status);
      const last = called ? now - int(1, 20) * 3600_000 - int(0, 8) * DAY : null;
      const bot: BotState = {
        bot_status: status,
        attempts: called ? int(1, 4) : 0,
        no_answer_streak: status === "no_answer" ? int(1, 3) : 0,
        ever_answered: called && status !== "no_answer",
        next_call_at: ["queued", "no_answer"].includes(status) ? iso(now + int(-2, 30) * 3600_000) : null,
        callback_at: status === "callback" ? iso(now + int(-5, 48) * 3600_000) : null,
        last_call_at: last ? iso(last) : null,
        last_outcome: called ? (OUTCOMES[status] ?? null) : null,
        interested_day_id: called && rand() < 0.4 ? "demo-zoom" : null,
        customer_gender: called ? pick(["male", "female"] as const) : null,
        phone_index: rand() < 0.1 ? 2 : 1,
        gold_changed_at: called ? iso((last ?? now) + 60_000) : null,
      };
      const p = phone(i);
      s.contacts.push({
        gold_record_id: `demo${String(i).padStart(4, "0")}`,
        national_id: `0000${String(i).padStart(5, "0")}`,
        company: pick(COMPANIES) || null,
        full_name: `${pick(FIRST)} ${pick(LAST)}`,
        email: `demo${i}@example.invalid`,
        phone: p,
        phone2: rand() < 0.25 ? phone(i + 500) : null,
        phone3: null,
        notes: called ? `פנייה מאתר ההדגמה\n[הערת הבוט] ${new Date(last ?? now).toLocaleDateString("he-IL")}: ${OUTCOMES[status] ?? "שיחה"} (נתון מומצא)` : "פנייה מאתר ההדגמה",
        city: pick(CITIES),
        address: rand() < 0.5 ? `רחוב ההדגמה ${int(1, 90)}` : null,
        address2: null,
        department: null,
        requested_course: rand() < 0.85 ? DEMO_COURSE : "קורס אחר (הדגמה)",
        source: pick(["אתר", "פייסבוק", "המלצה"]),
        status: called ? pick(["בטיפול", "חדש", "לא רלוונטי"]) : null,
        bot_state: bot,
      });
      if (called) {
        const c = s.contacts.at(-1)!;
        const answered = status !== "no_answer" && status !== "voicemail";
        s.calls_.push({
          call_id: `demo-call-${i}`,
          gold_record_id: c.gold_record_id,
          started_at: iso(last!),
          duration_sec: answered ? int(40, 260) : int(5, 30),
          outcome: OUTCOMES[status] ?? null,
          reason: status === "not_interested" ? "not_interested" : null,
          summary: answered ? "סיכום מומצא של השיחה לצורך הדגמה." : null,
          answered,
          origin: rand() < 0.85 ? "dialer" : "manual",
          ai_cost_usd: answered ? Math.round(rand() * 200) / 1000 : null,
          recording_path: answered && rand() < 0.6 ? `demo-call-${i}.mp3` : null,
          number: e164(p),
          contact_name: null,
          direction: "out",
          scenario: null,
          full_name: c.full_name,
          transcript: answered
            ? [
                { ts: iso(last! + 2000), role: "assistant", text: `שלום, מדברים ממשלב לגבי ${DEMO_COURSE}. זה זמן טוב?` },
                { ts: iso(last! + 6000), role: "user", text: "כן, אפשר. (שיחה מומצאת)" },
                { ts: iso(last! + 10_000), role: "assistant", text: "מצוין, אשלח לך קישור לרכישה." },
              ]
            : null,
        });
        if (["human_followup", "hot_lead", "company"].includes(status)) {
          s.tasks.push({
            id: `6f1c2b9e-1a2b-4c3d-8e9f-${String(i).padStart(12, "0")}`,
            gold_record_id: c.gold_record_id,
            call_id: `demo-call-${i}`,
            reason: pick(["wants_human", "pay_via_rep", "company_purchase", "discount_request"]),
            callback_at: rand() < 0.7 ? iso(now + int(-6, 30) * 3600_000) : null,
            note: rand() < 0.5 ? "הערה מומצאת לנציג" : null,
            done: rand() < 0.25,
            created_at: iso(last! + 30_000),
          });
        }
      }
    }
    // two test calls without a contact (a typed number)
    s.calls_.push({
      call_id: "demo-test-1", gold_record_id: null, started_at: iso(now - 26 * 3600_000), duration_sec: 95, outcome: "LINK_SENT", reason: null,
      summary: null, answered: true, origin: "manual", ai_cost_usd: 0.061, recording_path: "demo-test-1.mp3", number: "+972500000101",
      contact_name: "בודק", direction: "out", scenario: "S1", full_name: null,
      transcript: [{ ts: iso(now - 26 * 3600_000 + 2000), role: "assistant", text: "שלום בודק, זו שיחת בדיקה מומצאת." }],
    });
    s.calls_.sort((a, b) => b.started_at.localeCompare(a.started_at));

    const t = (d: number) => dateOnly(now + d * DAY);
    const day = (id: string, extra: Partial<StudyDayRow>): StudyDayRow => ({
      id, title: "יום עיון חשבונאות (הדגמה)", topic: "דיווח כספי ומיסוי", date: t(20), end_date: null, start_time: "09:00", end_time: "16:00",
      format: "hotel", series: null, location: "מלון הדגמה, תל אביב", price_ils: 790, vat_included: true, open_for_registration: true,
      course_number: "D-101", purchase_url: "https://example.invalid/buy/d101", lecturers: ["מרצה הדגמה א", "מרצה הדגמה ב"], academic_hours: 7.5,
      description: "סדר יום מומצא:\n09:00 פתיחה\n12:00 הפסקה", archived_at: null, created_at: iso(now - 30 * DAY), updated_at: iso(now - 2 * DAY), ...extra,
    });
    s.days = [
      day(`${t(12)}-zoom`, { format: "zoom", date: t(12), end_date: t(13), start_time: "10:00", end_time: "13:15", location: "בזום", price_ils: 370, course_number: "D-100" }),
      day(`${t(20)}-hotel`, { series: `${t(12)}-zoom` }),
      day(`${t(45)}-zoom`, { format: "zoom", date: t(45), end_date: t(46), start_time: "10:00", end_time: "13:15", location: "בזום", price_ils: 370, course_number: null, purchase_url: null, open_for_registration: false }),
      day(`${t(-15)}-hotel`, { date: t(-15), title: "יום עיון שעבר (הדגמה)" }),
      day(`${t(70)}-hotel`, { date: t(70), title: "יום עיון בארכיון (הדגמה)", archived_at: iso(now - DAY) }),
    ];

    const at = iso(now - 40 * DAY);
    s.users = [
      { id: "00000000-0000-4000-8000-00000000d001", phone: "+972500000001", name: "אדמין הדגמה", role: "admin", password_hash: await hashPassword(DEMO_PASSWORDS.admin), active: true, password_changed_at: at, last_login_at: iso(now - DAY), created_at: at },
      { id: "00000000-0000-4000-8000-00000000d002", phone: "+972500000002", name: "עובדת משלב (הדגמה)", role: "mishlav", password_hash: await hashPassword(DEMO_PASSWORDS.mishlav), active: true, password_changed_at: at, last_login_at: null, created_at: iso(now - 39 * DAY) },
      { id: "00000000-0000-4000-8000-00000000d003", phone: "+972500000003", name: "משתמש חסום (הדגמה)", role: "mishlav", password_hash: await hashPassword("blocked-demo-1"), active: false, password_changed_at: at, last_login_at: null, created_at: iso(now - 38 * DAY) },
    ];
    return s;
  }

  // ---- ContactStore
  async list() {
    return this.contacts.slice(0, 500);
  }
  async get(id: string) {
    const c = this.contacts.find((x) => x.gold_record_id === id);
    return c ? { ...c, rep_tasks: this.tasks.filter((t) => t.gold_record_id === id) } : null;
  }
  async callStarted(callId: string, goldRecordId: string, origin: CallOrigin = "manual") {
    const c = this.contacts.find((x) => x.gold_record_id === goldRecordId);
    this.calls_.unshift({
      call_id: callId, gold_record_id: goldRecordId, started_at: iso(Date.now()), duration_sec: null, outcome: null, reason: null, summary: null,
      answered: false, origin, ai_cost_usd: null, recording_path: null, number: c?.phone ? e164(c.phone) : null, contact_name: null, direction: "out",
      scenario: null, full_name: c?.full_name ?? null, transcript: null,
    });
    if (c?.bot_state) c.bot_state.bot_status = "in_call";
  }
  async testCallStarted(callId: string, info: CallInfo) {
    this.calls_.unshift({
      call_id: callId, gold_record_id: null, started_at: iso(Date.now()), duration_sec: null, outcome: null, reason: null, summary: null, answered: false,
      origin: "manual", ai_cost_usd: null, recording_path: null, number: info.number ?? null, contact_name: info.contact_name ?? null,
      direction: info.direction ?? "out", scenario: info.scenario ?? null, full_name: null, transcript: null,
    });
  }
  async saveCallInfo(callId: string, info: CallInfo) {
    const c = this.calls_.find((x) => x.call_id === callId);
    if (c) Object.assign(c, info);
  }
  async toolEvent(callId: string, tool: string, params: unknown) {
    const call = this.calls_.find((x) => x.call_id === callId);
    if (!call?.gold_record_id) return null;
    const c = this.contacts.find((x) => x.gold_record_id === call.gold_record_id);
    if (tool === "request_human" && c) {
      const p = params as { reason?: string; note?: string };
      this.tasks.unshift({
        id: `6f1c2b9e-1a2b-4c3d-8e9f-${String(900_000 + ++this.n).padStart(12, "0")}`, gold_record_id: c.gold_record_id, call_id: callId,
        reason: p.reason ?? "other", callback_at: null, note: p.note ?? null, done: false, created_at: iso(Date.now()),
      });
      call.outcome = "HUMAN_FOLLOWUP";
      if (c.bot_state) c.bot_state.bot_status = "human_followup";
    }
    return c?.bot_state?.bot_status ?? null;
  }
  async callEnded(callId: string, durationSec: number, nextCallAt: Date[], _limits: CallLimits) {
    const call = this.calls_.find((x) => x.call_id === callId);
    if (!call) return null;
    call.duration_sec = Math.round(durationSec);
    call.answered = !!call.transcript?.some((l) => l.role === "user") || call.answered;
    const c = this.contacts.find((x) => x.gold_record_id === call.gold_record_id);
    if (c?.bot_state) {
      const b = c.bot_state;
      b.attempts++;
      b.last_call_at = call.started_at;
      b.gold_changed_at = iso(Date.now());
      if (b.bot_status === "in_call") {
        b.bot_status = call.answered ? "link_sent" : "no_answer";
        call.outcome = call.answered ? "LINK_SENT" : null;
        b.next_call_at = call.answered ? null : (nextCallAt[0]?.toISOString() ?? null);
      }
      b.last_outcome = call.outcome;
    }
    return c?.bot_state?.bot_status ?? null;
  }
  async saveTranscript(callId: string, lines: TranscriptLine[]) {
    const c = this.calls_.find((x) => x.call_id === callId);
    if (c) c.transcript = lines;
  }
  async goldChanges(since?: string): Promise<GoldChanges> {
    const changed = this.contacts.filter((c) => c.bot_state?.gold_changed_at && (!since || c.bot_state.gold_changed_at > since));
    return { until: iso(Date.now()), contacts: changed.map(({ bot_state: _b, rep_tasks: _t, ...g }) => g) };
  }
  async callNumber(callId: string) {
    return this.calls_.find((x) => x.call_id === callId)?.number ?? null;
  }
  async botVoice() {
    return this.control.voice;
  }
  async setBotVoice(voice: string | null) {
    this.control.voice = voice;
  }

  // ---- AdminStore
  async recordingUrl(callId: string) {
    const c = this.calls_.find((x) => x.call_id === callId);
    // a link like Supabase's signed one, to nowhere: the demo has no recordings to play
    return c?.recording_path ? `https://demo.invalid/storage/v1/object/sign/recordings/${encodeURIComponent(c.recording_path)}?token=demo` : null;
  }
  async summary(dayStart: Date, courses: string[] = []): Promise<DashboardSummary> {
    const today = this.calls_.filter((c) => c.started_at >= dayStart.toISOString());
    const dialer = today.filter((c) => c.origin === "dialer");
    const outcomes: Record<string, number> = {};
    for (const c of dialer) if (c.outcome) outcomes[c.outcome] = (outcomes[c.outcome] ?? 0) + 1;
    const by_status: Record<string, number> = {};
    for (const c of this.contacts) by_status[c.bot_state!.bot_status] = (by_status[c.bot_state!.bot_status] ?? 0) + 1;
    const n = (...ks: string[]) => ks.reduce((a, k) => a + (by_status[k] ?? 0), 0);
    const due = this.dueList(new Date(), courses);
    return {
      day_start: dayStart.toISOString(),
      today: { total: dialer.length, answered: dialer.filter((c) => c.answered).length, no_result: dialer.filter((c) => !c.outcome).length, outcomes, manual_total: today.length - dialer.length },
      funnel: { new: n("new"), in_queue: n("queued", "callback", "no_answer", "in_call"), handled: n("link_sent", "hot_lead", "human_followup", "company"), closed: n("not_interested", "do_not_call", "duplicate", "voicemail") },
      by_status,
      contacts_total: this.contacts.length,
      due_now: due.length,
      open_rep_tasks: this.tasks.filter((t) => !t.done).length,
      next_due: due.slice(0, 8).map((c) => ({ gold_record_id: c.gold_record_id, full_name: c.full_name, bot_status: c.bot_state!.bot_status, next_call_at: c.bot_state!.callback_at ?? c.bot_state!.next_call_at })),
    };
  }
  private dueList(now: Date, courses: string[]) {
    return this.contacts.filter((c) => {
      const b = c.bot_state!;
      if (!["new", "queued", "callback", "no_answer"].includes(b.bot_status)) return false;
      if (courses.length && !courses.includes(c.requested_course ?? "")) return false;
      const at = b.callback_at ?? b.next_call_at;
      return !at || at <= now.toISOString();
    });
  }
  async contactsPage({ q, status, page, size }: ContactsQuery) {
    const s = q?.toLowerCase();
    const digits = q?.replace(/\D/g, "") ?? "";
    const rows = this.contacts
      .filter((c) => !status || c.bot_state?.bot_status === status)
      .filter(
        (c) =>
          !s ||
          [c.full_name, c.gold_record_id, c.email, c.company, c.city, c.requested_course, c.phone, c.phone2].some((v) => v?.toLowerCase().includes(s)) ||
          (digits.length >= 4 && [c.phone, c.phone2].some((v) => v?.replace(/\D/g, "").includes(digits.slice(-7)))),
      )
      .sort((a, b) => (a.full_name ?? "").localeCompare(b.full_name ?? "", "he") || a.gold_record_id.localeCompare(b.gold_record_id));
    return { contacts: rows.slice((page - 1) * size, page * size).map((c) => this.listRow(c)), total: rows.length };
  }
  /** a list row: only the table's columns (as LIST_FIELDS) */
  private listRow(c: ContactRecord) {
    return {
      gold_record_id: c.gold_record_id, full_name: c.full_name, phone: c.phone, status: c.status, requested_course: c.requested_course, bot_state: c.bot_state,
      rep_tasks: this.tasks.filter((t) => t.gold_record_id === c.gold_record_id).map((t) => ({ done: t.done })),
    } as unknown as ContactRecord;
  }
  async recentContacts(limit: number) {
    const at = (c: ContactRecord) => (c.bot_state?.bot_status === "in_call" ? "9999" : [c.bot_state?.last_call_at ?? "", c.bot_state?.gold_changed_at ?? ""].sort().at(-1)!);
    return this.contacts
      .filter((c) => c.bot_state?.last_call_at || c.bot_state?.gold_changed_at)
      .sort((a, b) => at(b).localeCompare(at(a)))
      .slice(0, limit)
      .map((c) => this.listRow(c));
  }
  async queue(now: Date, courses: string[], limit: number) {
    return this.contacts
      .filter((c) => ["new", "queued", "callback", "no_answer"].includes(c.bot_state!.bot_status) && (!courses.length || courses.includes(c.requested_course ?? "")))
      .sort((a, b) => (a.bot_state!.callback_at ?? a.bot_state!.next_call_at ?? "").localeCompare(b.bot_state!.callback_at ?? b.bot_state!.next_call_at ?? ""))
      .slice(0, limit)
      .map((c) => ({ ...this.listRow(c), due: !(c.bot_state!.callback_at ?? c.bot_state!.next_call_at) || (c.bot_state!.callback_at ?? c.bot_state!.next_call_at)! <= now.toISOString() }));
  }
  async contactCalls(id: string) {
    return this.calls_.filter((c) => c.gold_record_id === id).map(({ transcript: _t, ...c }) => ({ ...c, full_name: null }));
  }
  async contactRepTasks(id: string) {
    return this.tasks.filter((t) => t.gold_record_id === id);
  }
  async calls({ origin, recorded, page, size }: CallsQuery) {
    const rows = this.calls_.filter((c) => (!origin || c.origin === origin) && (!recorded || c.recording_path));
    return { calls: rows.slice((page - 1) * size, page * size).map(({ transcript: _t, ...c }) => c), total: rows.length };
  }
  async call(callId: string) {
    const c = this.calls_.find((x) => x.call_id === callId);
    return c ? { ...c } : null;
  }
  async repTasks({ openOnly, page, size }: RepTasksQuery) {
    const rows = this.tasks
      .filter((t) => !openOnly || !t.done)
      .sort((a, b) => Number(a.done) - Number(b.done) || (a.callback_at ?? "").localeCompare(b.callback_at ?? ""));
    const withWho = rows.map((t) => {
      const c = this.contacts.find((x) => x.gold_record_id === t.gold_record_id);
      return { ...t, full_name: c?.full_name ?? null, phone: c?.phone ?? null };
    });
    return { tasks: withWho.slice((page - 1) * size, page * size), total: rows.length };
  }
  async repTaskDone(id: string) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return null;
    t.done = true;
    return t;
  }

  // ---- DialerStore
  async dialerControl() {
    return { ...this.control };
  }
  async setDialer(enabled: boolean, reason: string | null) {
    Object.assign(this.control, { enabled, reason, changed_at: iso(Date.now()) });
    return { ...this.control };
  }
  async setDailyLimit(limit: number | null) {
    this.control.daily_limit = limit;
  }
  async nextDue(now: Date, skip: string[], courses: string[] = []): Promise<QueuedContact | null> {
    const c = this.dueList(now, courses).find((x) => !skip.includes(x.gold_record_id));
    return c ? { gold_record_id: c.gold_record_id, bot_status: c.bot_state!.bot_status, next_call_at: c.bot_state!.next_call_at } : null;
  }
  async nextScheduled(now: Date, courses: string[] = []): Promise<QueuedContact | null> {
    const c = this.contacts
      .filter((x) => x.bot_state?.next_call_at && x.bot_state.next_call_at > now.toISOString() && (!courses.length || courses.includes(x.requested_course ?? "")))
      .sort((a, b) => a.bot_state!.next_call_at!.localeCompare(b.bot_state!.next_call_at!))[0];
    return c ? { gold_record_id: c.gold_record_id, bot_status: c.bot_state!.bot_status, next_call_at: c.bot_state!.next_call_at } : null;
  }
  async markNoPhone(id: string) {
    const c = this.contacts.find((x) => x.gold_record_id === id);
    if (c?.bot_state) c.bot_state.bot_status = "wrong_number";
    return c?.bot_state?.bot_status ?? null;
  }
  async usePhone(id: string, index: number) {
    const c = this.contacts.find((x) => x.gold_record_id === id);
    if (c?.bot_state) c.bot_state.phone_index = index;
  }
  async markDuplicate() {
    return null;
  }
  async callsSince(since: Date, origin: CallOrigin) {
    return this.calls_.filter((c) => c.origin === origin && c.started_at >= since.toISOString()).length;
  }

  // ---- StudyDayStore
  async studyDays() {
    return [...this.days].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  }
  async createStudyDay(row: StudyDayWrite & { id: string }) {
    if (this.days.some((d) => d.id === row.id)) throw new StudyDayExists(row.id);
    const d: StudyDayRow = { ...row, archived_at: null, created_at: iso(Date.now()), updated_at: iso(Date.now()) };
    this.days.push(d);
    return d;
  }
  async updateStudyDay(id: string, row: StudyDayWrite) {
    const d = this.days.find((x) => x.id === id);
    if (!d) return null;
    Object.assign(d, row, { updated_at: iso(Date.now()) });
    return d;
  }
  async setStudyDayArchived(id: string, archived: boolean) {
    const d = this.days.find((x) => x.id === id);
    if (!d) return null;
    d.archived_at = archived ? iso(Date.now()) : null;
    d.updated_at = iso(Date.now());
    return d;
  }

  // ---- UserStore
  async dashboardUsers() {
    return this.users.map((u) => ({ ...u }));
  }
  async createDashboardUser(row: Pick<DashboardUser, "phone" | "name" | "role" | "password_hash">) {
    if (this.users.some((u) => u.phone === row.phone)) throw new UserExists(row.phone);
    const at = iso(Date.now());
    const u: DashboardUser = { id: `00000000-0000-4000-8000-${String(0xd100 + ++this.n).padStart(12, "0")}`, ...row, active: true, password_changed_at: at, last_login_at: null, created_at: at };
    this.users.push(u);
    return { ...u };
  }
  async updateDashboardUser(id: string, patch: Partial<DashboardUser>) {
    const u = this.users.find((x) => x.id === id);
    if (!u) return null;
    Object.assign(u, patch);
    return { ...u };
  }

  // ---- LogStore: an earlier "server start", to show the faint history lines
  async appendLogs(_lines: StoredLogLine[]) {}
  async logHistory({ limit }: { excludeBoot: string; callId?: string; limit: number }) {
    const t = Date.now() - 2 * 3600_000;
    const kinds = ["server", "dialer", "line", "tool", "sms", "error"] as const;
    return Array.from({ length: Math.min(limit, 30) }, (_, i) => ({
      boot: "demo-earlier-boot",
      seq: i + 1,
      ts: iso(t + i * 60_000),
      kind: kinds[i % kinds.length]!,
      call_id: i % 5 === 0 ? `demo-call-${i + 1}` : null,
      text: i % kinds.length === 2 ? `לקוח: שורה מומצאת ${i + 1}` : `[demo] שורת לוג מומצאת ${i + 1}`,
    }));
  }
  async pruneLogs() {}
}




/**
 * A phone line that pretends: dial() "rings" for 2 s, then writes a short invented conversation into the transcript
 * file (as the real line does), and ends after ~16 s (or at hangup()). Its 'call' and 'ended' events, status() and
 * recent[] look like apps/phone/src/line.js's.
 */
export class DemoLine extends EventEmitter {
  registered = true;
  error: string | null = null;
  call: { id: string; direction: "out" | "in"; number: string; scenario: string | null; started_at: string } | null = null;
  recent: { seq: number; ts: string; call_id: string | null; text: string }[] = [];
  private seq = 0;
  private timers: NodeJS.Timeout[] = [];
  constructor(private readonly transcriptsDir: string) {
    super();
    this.log("✅ registered (demo line: nothing is really dialed)", null);
  }
  log(text: string, callId: string | null = this.call?.id ?? null) {
    this.recent.push({ seq: ++this.seq, ts: iso(Date.now()), call_id: callId, text });
    if (this.recent.length > 500) this.recent.shift();
  }
  status() {
    const c = this.call;
    return {
      registered: this.registered, error: this.error, number: "+972-55-0000000", model: "demo-model", voice: "Kore", busy: !!c,
      call: c && { id: c.id, direction: c.direction, number: c.number.replace(/(\d{3})\d+(\d{2})$/, "$1•••••$2"), scenario: c.scenario, started_at: c.started_at },
    };
  }
  numberFor(callId: string) {
    return this.call?.id === callId ? this.call.number : null;
  }
  async dial(number: string, opts: { scenario?: string; name?: string } = {}) {
    if (this.call) throw new Error("a call is already running on the line");
    const id = `demo-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${++this.seq}`;
    this.call = { id, direction: "out", number, scenario: opts.scenario ?? null, started_at: iso(Date.now()) };
    this.emit("call", this.status());
    this.log(`📞 dialing ${number.slice(0, 6)}… (demo)`, id);
    mkdirSync(this.transcriptsDir, { recursive: true });
    const say = (role: string, text: string) => {
      appendFileSync(join(this.transcriptsDir, `${id}.jsonl`), `${JSON.stringify({ ts: iso(Date.now()), role, text })}\n`);
      this.log(`${role === "user" ? "לקוח" : "בוט"}: ${text}`, id);
    };
    const at = (ms: number, fn: () => void) => this.timers.push(setTimeout(fn, ms));
    at(2000, () => say("assistant", `שלום${opts.name ? ` ${opts.name}` : ""}, מדברים ממשלב (שיחת הדגמה).`));
    at(5000, () => say("user", "שלום, כן. (תשובה מומצאת)"));
    at(8000, () => say("assistant", "רציתי לספר על יום העיון הקרוב."));
    at(11_000, () => say("user", "אשמח לשמוע."));
    at(16_000, () => this.end(id, "completed"));
    return { call_id: id };
  }
  private end(id: string, reason: string) {
    if (this.call?.id !== id) return;
    this.call = null;
    this.log(`📴 ended (${reason})`, id);
    this.emit("ended", { call_id: id, reason });
  }
  async hangup() {
    if (!this.call) return false;
    this.timers.forEach(clearTimeout);
    this.timers = [];
    this.end(this.call.id, "hung up from the dashboard");
    return true;
  }
  async start() {}
  async stop() {
    this.timers.forEach(clearTimeout);
  }
}
