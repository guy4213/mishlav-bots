import { EventEmitter } from "node:events";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  AdminStore,
  CallLimits,
  CallOrigin,
  CallRow,
  CallsQuery,
  ContactRecord,
  ContactsQuery,
  ContactStore,
  DashboardSummary,
  RepTask,
  RepTaskRow,
  RepTasksQuery,
} from "../src/contacts";
import { mayCall } from "../src/access";
import { searchFilter } from "../src/contacts";
import { dayStart } from "../src/routes/admin";
import { buildServer } from "../src/server";
import type { TranscriptLine } from "../src/transcripts";
import { AUTH, FIXED_NOW, SECRET, testConfig } from "./helpers";

const ID = "a000000000000001demo";
const TASK_ID = "6f1c2b9e-1a2b-4c3d-8e9f-0123456789ab";
const DAY = "2027-02-21-zoom";

const CONTACT: ContactRecord = {
  gold_record_id: ID,
  national_id: null,
  company: null,
  full_name: "רועי כהן",
  email: null,
  phone: "053-4271418",
  phone2: null,
  phone3: null,
  notes: null,
  city: null,
  address: null,
  address2: null,
  department: null,
  requested_course: null,
  source: null,
  status: null,
  bot_state: {
    bot_status: "new",
    attempts: 0,
    no_answer_streak: 0,
    ever_answered: false,
    next_call_at: null,
    callback_at: null,
    last_call_at: null,
    last_outcome: null,
    interested_day_id: null,
    customer_gender: null,
    phone_index: 1,
    gold_changed_at: null,
  },
};

const call = (call_id: string, origin: CallOrigin, extra: Partial<CallRow> = {}): CallRow => ({
  call_id,
  gold_record_id: ID,
  started_at: "2026-11-08T07:00:00Z",
  duration_sec: 42,
  outcome: "LINK_SENT",
  reason: null,
  summary: null,
  answered: true,
  origin,
  full_name: "רועי כהן",
  ...extra,
});

const TASK: RepTask = {
  id: TASK_ID,
  gold_record_id: ID,
  call_id: "call-a",
  reason: "wants_human",
  callback_at: null,
  note: "רוצה לדבר עם נציג",
  done: false,
  created_at: "2026-11-08T07:01:00Z",
};

/** Supabase in memory: the contacts and what the dashboard reads. */
class FakeStore implements ContactStore, AdminStore {
  calls_: CallRow[] = [call("call-a", "dialer"), call("call-b", "manual", { outcome: null, answered: false })];
  transcripts = new Map<string, TranscriptLine[]>();
  tasks: RepTask[] = [{ ...TASK }];
  asked: unknown[][] = [];
  failTools = false;
  async list() {
    return [CONTACT];
  }
  async get(id: string) {
    return id === ID ? CONTACT : null;
  }
  async callStarted() {}
  async toolEvent() {
    if (this.failTools) throw new Error("supabase down");
    return null;
  }
  async callEnded(_c: string, _s: number, _n: Date[], _l: CallLimits) {
    return null;
  }
  async goldChanges() {
    return { until: "", contacts: [] };
  }
  async callNumber(callId: string) {
    return callId === "call-a" ? "053-4271418" : null;
  }
  async saveTranscript(callId: string, lines: TranscriptLine[]) {
    this.transcripts.set(callId, lines);
  }
  async contactsPage(query: ContactsQuery) {
    this.asked.push(["page", query]);
    return { contacts: [CONTACT], total: 123 };
  }
  async recentContacts(limit: number) {
    this.asked.push(["recent", limit]);
    return [CONTACT];
  }
  async queue(_now: Date, courses: string[], limit: number) {
    this.asked.push(["queue", courses, limit]);
    return [{ ...CONTACT, due: true }];
  }
  async summary(start: Date, courses?: string[]): Promise<DashboardSummary> {
    this.asked.push(["summary", start.toISOString(), courses]);
    return {
      day_start: start.toISOString(),
      today: { total: 1, answered: 1, no_result: 0, outcomes: { LINK_SENT: 1 }, manual_total: 1 },
      funnel: { new: 9, in_queue: 0, handled: 1, closed: 0 },
      by_status: { new: 9, link_sent: 1 },
      contacts_total: 10,
      due_now: 9,
      open_rep_tasks: 1,
      next_due: [{ gold_record_id: ID, full_name: "רועי כהן", bot_status: "new", next_call_at: null }],
    };
  }
  async contactCalls(id: string) {
    return this.calls_.filter((c) => c.gold_record_id === id);
  }
  async contactRepTasks(id: string) {
    return this.tasks.filter((t) => t.gold_record_id === id);
  }
  async calls(query: CallsQuery) {
    this.asked.push(["calls", query]);
    const calls = this.calls_.filter((c) => !query.origin || c.origin === query.origin);
    return { calls, total: calls.length };
  }
  async call(callId: string) {
    const c = this.calls_.find((x) => x.call_id === callId);
    return c ? { ...c, transcript: this.transcripts.get(callId) ?? null } : null;
  }
  async repTasks({ openOnly }: RepTasksQuery) {
    const tasks: RepTaskRow[] = this.tasks.filter((t) => !openOnly || !t.done).map((t) => ({ ...t, full_name: "רועי כהן", phone: "053-4271418" }));
    return { tasks, total: tasks.length };
  }
  async repTaskDone(id: string) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return null;
    t.done = true;
    return t;
  }
}

/** The phone line: dial() -> call-1, then 'ended'; its log ring (line.recent). */
class FakeLine extends EventEmitter {
  recent: { seq: number; ts: string; call_id: string | null; text: string }[] = [];
  busyWith: string | null = null;
  async dial() {
    return { call_id: "call-1" };
  }
  status() {
    return { registered: true, busy: !!this.busyWith, call: this.busyWith ? { id: this.busyWith } : null };
  }
  numberFor() {
    return null;
  }
  say(text: string, callId: string | null = null) {
    this.recent.push({ seq: this.recent.length + 1, ts: FIXED_NOW.toISOString(), call_id: callId, text });
  }
}

async function setup(env: NodeJS.ProcessEnv = {}, withStore = true) {
  const store = new FakeStore();
  const line = new FakeLine();
  const config = testConfig();
  // no `whatsapp`: the sender comes from `env` ({} = log only, nothing is sent) and its lines reach the live log
  const app = await buildServer(config, {
    now: () => FIXED_NOW,
    logger: false,
    env,
    contacts: withStore ? store : undefined,
    admin: withStore ? store : undefined,
    phone: { line: line as never, reason: null },
  });
  const get = async (url: string) => app.inject({ method: "GET", url, headers: AUTH });
  const post = async (url: string, payload: object = {}, headers: Record<string, string> = {}) =>
    app.inject({ method: "POST", url, headers: { ...AUTH, ...headers }, payload });
  return { app, store, line, config, get, post };
}

const settle = () => new Promise((r) => setTimeout(r, 80));

describe("management API (/api/admin)", () => {
  it("every route needs the secret", async () => {
    const { app } = await setup();
    for (const url of ["/api/admin/env", "/api/admin/summary", "/api/admin/contacts", "/api/admin/calls", "/api/admin/rep-tasks", "/api/admin/logs"]) {
      expect((await app.inject({ method: "GET", url })).statusCode, url).toBe(401);
    }
    expect((await app.inject({ method: "POST", url: `/api/admin/rep-tasks/${TASK_ID}/done` })).statusCode).toBe(401);
  });

  it("env tells production from local, without any secret value", async () => {
    const prodEnv = { RENDER: "true", RENDER_GIT_COMMIT: "abcdef1234567890", GOLD_API_KEY: "gold-key-do-not-show", TOOLS_SECRET: SECRET };
    const prod = await (await setup(prodEnv)).get("/api/admin/env");
    expect(prod.json()).toEqual({
      ok: true,
      env: "production",
      commit: "abcdef1",
      phone_line: { available: true, registered: true, reason: null },
      supabase: true,
      whatsapp_provider: "log",
      gold_api_key_set: true,
      dialer_only_numbers: false,
      timezone: "Asia/Jerusalem",
    });
    expect(prod.body).not.toContain("gold-key-do-not-show");
    expect(prod.body).not.toContain(SECRET);

    const local = (await (await setup({}, false)).get("/api/admin/env")).json();
    expect(local).toMatchObject({ env: "local", commit: null, supabase: false, gold_api_key_set: false });
  });

  it("summary asks for today from midnight in Israel", async () => {
    const { get, store } = await setup();
    const r = await get("/api/admin/summary");
    expect(r.json()).toMatchObject({ ok: true, summary: { funnel: { new: 9, handled: 1 }, open_rep_tasks: 1 } });
    // FIXED_NOW = 10:00 in Israel (UTC+2) -> the day starts at 22:00 UTC the day before
    // only the courses the dialer calls are counted in its queue (settings dialing.requested_courses)
    expect(store.asked).toEqual([["summary", "2026-11-07T22:00:00.000Z", ["יום עיון חשבונאות"]]]);
    expect(dayStart(new Date("2026-07-01T21:30:00Z"), "Asia/Jerusalem").toISOString()).toBe("2026-07-01T21:00:00.000Z"); // summer, UTC+3
  });

  it("without Supabase the data routes say so", async () => {
    const { get } = await setup({}, false);
    expect((await get("/api/admin/summary")).statusCode).toBe(409);
    expect((await get("/api/admin/calls")).json().error).toBe("no_supabase");
    expect((await get("/api/admin/rep-tasks")).statusCode).toBe(409);
    expect((await get("/api/admin/contacts")).json()).toEqual({ ok: true, available: false, view: "all", contacts: [], total: 0 });
  });

  it("contacts: the list, and one contact with its tasks and calls", async () => {
    const { get } = await setup();
    expect((await get("/api/admin/contacts")).json().contacts.map((c: ContactRecord) => c.gold_record_id)).toEqual([ID]);
    const one = (await get(`/api/admin/contacts/${ID}`)).json();
    expect(one.contact).toMatchObject({ gold_record_id: ID, bot_state: { bot_status: "new" }, rep_tasks: [{ id: TASK_ID, note: "רוצה לדבר עם נציג" }] });
    expect(one.calls.map((c: CallRow) => c.call_id)).toEqual(["call-a", "call-b"]);
    expect((await get("/api/admin/contacts/nobody")).statusCode).toBe(404);
    expect((await get("/api/admin/contacts/bad%20id")).statusCode).toBe(400);
  });

  it("contacts' three views: the bot's activity, the dialer's queue (its courses), all - searched and paged in the database", async () => {
    const { get, store } = await setup();
    expect((await get("/api/admin/contacts?view=activity")).json()).toMatchObject({ view: "activity", total: 1 });
    expect((await get("/api/admin/contacts?view=queue")).json()).toMatchObject({ view: "queue", contacts: [{ gold_record_id: ID, due: true }] });
    const all = (await get(`/api/admin/contacts?q=${encodeURIComponent(" רועי ")}&status=new&page=3`)).json();
    expect(all).toMatchObject({ view: "all", total: 123, page: 3, page_size: 50, pages: 3 });
    // a bad status / page is ignored, never sent to the database
    await get("/api/admin/contacts?status=new);drop&page=-2");
    expect(store.asked).toEqual([
      ["recent", 50],
      ["queue", ["יום עיון חשבונאות"], 50],
      ["page", { q: "רועי", status: "new", page: 3, size: 50 }],
      ["page", { q: undefined, status: undefined, page: 1, size: 50 }],
    ]);
  });

  it("the push channel: 'contacts' once for a burst of updates, open to Mishlav's users too", async () => {
    const config = testConfig();
    const store = new FakeStore();
    const app = await buildServer(config, { now: () => FIXED_NOW, logger: false, env: {}, contacts: store, admin: store, phone: { line: new FakeLine() as never, reason: null } });
    await app.listen({ port: 0, host: "127.0.0.1" });
    try {
      const { port } = app.server.address() as { port: number };
      const ctrl = new AbortController();
      const res = await fetch(`http://127.0.0.1:${port}/api/admin/stream`, { headers: AUTH, signal: ctrl.signal });
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const reader = res.body!.getReader();
      let text = "";
      const until = async (s: string) => {
        while (!text.includes(s)) text += new TextDecoder().decode((await reader.read()).value);
      };
      await until("event: hello");
      // a rep task done, twice in a row: one message
      await app.inject({ method: "POST", url: `/api/admin/rep-tasks/${TASK_ID}/done`, headers: AUTH });
      await app.inject({ method: "POST", url: `/api/admin/rep-tasks/${TASK_ID}/done`, headers: AUTH });
      await until("event: contacts");
      await new Promise((r) => setTimeout(r, 400));
      expect(text.split("event: contacts").length - 1).toBe(1);
      ctrl.abort();
    } finally {
      await app.close();
    }
    expect(mayCall("mishlav", "GET", "/api/admin/stream")).toBe(true);
  });

  it("the search: text in the name, email, course...; digits also by the phone's last 7", () => {
    expect(searchFilter("רועי")).toContain('full_name.ilike."*רועי*"');
    expect(searchFilter("0526268866")).toContain('phone.ilike."*6268866*"');
    expect(searchFilter("053").match(/(^|,|\()phone\.ilike/g)).toHaveLength(1); // under 4 digits: the text match only
    expect(searchFilter('a"b')).toContain('full_name.ilike."*a\\"b*"'); // quotes escaped for PostgREST
  });

  it("calls: filtered by origin (dialer = the real work, manual = tests), limit capped", async () => {
    const { get, store } = await setup();
    const ids = async (q: string) => (await get(`/api/admin/calls${q}`)).json().calls.map((c: CallRow) => c.call_id);
    expect(await ids("")).toEqual(["call-a", "call-b"]);
    expect(await ids("?origin=dialer")).toEqual(["call-a"]);
    expect(await ids("?origin=manual")).toEqual(["call-b"]);
    expect(await ids("?origin=all&recorded=1&page=2")).toEqual(["call-a", "call-b"]);
    expect(store.asked).toEqual([
      ["calls", { origin: null, recorded: false, page: 1, size: 50 }],
      ["calls", { origin: "dialer", recorded: false, page: 1, size: 50 }],
      ["calls", { origin: "manual", recorded: false, page: 1, size: 50 }],
      ["calls", { origin: null, recorded: true, page: 2, size: 50 }],
    ]);
    expect((await get("/api/admin/calls?origin=dialer")).json()).toMatchObject({
      origin: "dialer",
      calls: [{ full_name: "רועי כהן", outcome: "LINK_SENT" }],
      total: 1,
      page: 1,
      pages: 1,
    });
  });

  it("one call: the stored transcript first, else this server's file; plus the bot's tool actions", async () => {
    const { get, post, store, config } = await setup();
    const dir = join(config.logDir, "transcripts");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "call-a.jsonl"), `${JSON.stringify({ ts: "t1", role: "user", text: "מהקובץ" })}\n`);
    await post("/tools/get_day_info", { day_id: DAY }, { "x-call-id": "call-a" });

    const fromFile = (await get("/api/admin/calls/call-a")).json();
    expect(fromFile).toMatchObject({ ok: true, live: false, transcript_source: "file", call: { call_id: "call-a", origin: "dialer" } });
    expect(fromFile.call.transcript).toBeUndefined();
    expect(fromFile.transcript).toEqual([{ ts: "t1", role: "user", text: "מהקובץ" }]);
    expect(fromFile.tools).toMatchObject([{ tool: "get_day_info", ok: true, call_id: "call-a" }]);

    store.transcripts.set("call-a", [{ ts: "t0", role: "assistant", text: "מהמסד" }]);
    const fromDb = (await get("/api/admin/calls/call-a")).json();
    expect(fromDb.transcript_source).toBe("db");
    expect(fromDb.transcript[0].text).toBe("מהמסד");

    // a scenario test to a plain number has no calls row, only this server's files
    writeFileSync(join(dir, "phone-x.jsonl"), `${JSON.stringify({ ts: "t", role: "assistant", text: "שלום" })}\n`);
    expect((await get("/api/admin/calls/phone-x")).json()).toMatchObject({ call: null, transcript_source: "file" });
    expect((await get("/api/admin/calls/nothing-here")).statusCode).toBe(404);
    expect((await get("/api/admin/calls/..%2F..%2F.env")).statusCode).toBe(400);
  });

  it("rep tasks: open ones with the contact's name and phone; done", async () => {
    const { get, post } = await setup();
    expect((await get("/api/admin/rep-tasks?open=1")).json()).toMatchObject({
      tasks: [{ id: TASK_ID, full_name: "רועי כהן", phone: "053-4271418" }],
      total: 1,
      pages: 1,
    });
    const done = await post(`/api/admin/rep-tasks/${TASK_ID}/done`);
    expect(done.json()).toMatchObject({ ok: true, task: { id: TASK_ID, done: true } });
    expect((await get("/api/admin/rep-tasks?open=1")).json().tasks).toEqual([]);
    expect((await get("/api/admin/rep-tasks?open=0")).json().tasks).toHaveLength(1);
    expect((await post("/api/admin/rep-tasks/00000000-0000-0000-0000-000000000000/done")).statusCode).toBe(404);
    expect((await post("/api/admin/rep-tasks/not-a-uuid/done")).statusCode).toBe(400);
  });

  it("logs: the line's lines and the server's events in one stream, one sequence, since=", async () => {
    const { get, post, line, store } = await setup();
    line.say("📞 calling +97253***1418…", "call-a");
    await post("/tools/send_purchase_link", { day_id: DAY }, { "x-call-id": "call-a" }); // WhatsApp (log only: not sent) + tool
    store.failTools = true;
    await post("/tools/get_day_info", { day_id: DAY }, { "x-call-id": "call-a" }); // its Supabase update fails
    await settle();
    line.say("call ended", "call-a");

    const all = (await get("/api/admin/logs")).json();
    expect(all.env).toBe("local");
    const kinds = all.lines.map((l: { kind: string }) => l.kind);
    expect(kinds[0]).toBe("line");
    expect(kinds).toEqual(expect.arrayContaining(["whatsapp", "tool", "error"]));
    expect(kinds.at(-1)).toBe("line");
    expect(all.lines.map((l: { seq: number }) => l.seq)).toEqual(all.lines.map((_: unknown, i: number) => i + 1));
    const wa = all.lines.find((l: { kind: string }) => l.kind === "whatsapp");
    expect(wa.text).toContain("+97253***1418"); // masked, never the full number
    expect(JSON.stringify(all)).not.toContain("534271418");
    // (the link itself was not sent - no Texter keys - which is an error line too)
    expect(all.lines.find((l: { kind: string; text: string }) => l.kind === "error" && l.text.includes("supabase down"))).toMatchObject({ call_id: "call-a" });

    const later = (await get(`/api/admin/logs?since=${all.seq}`)).json();
    expect(later.lines).toEqual([]);
    line.say("waiting for calls…");
    const next = (await get(`/api/admin/logs?since=${all.seq}`)).json();
    expect(next.lines).toMatchObject([{ seq: all.seq + 1, kind: "line", text: "waiting for calls…" }]);
  });

  it("a contact call's transcript is stored in the database at its end, card numbers removed", async () => {
    const { post, store, line, config } = await setup();
    expect((await post("/test/phone/call", { contact_id: ID })).json()).toMatchObject({ ok: true, call_id: "call-1" });
    const dir = join(config.logDir, "transcripts");
    mkdirSync(dir, { recursive: true });
    const lines = [
      { ts: "t1", role: "assistant", text: "שלום רועי" },
      { ts: "t2", role: "user", text: "הכרטיס שלי 4580 1234 5678 9012 תוקף 12/28" },
      { ts: "t3", role: "user", text: "והטלפון 0534271418" },
    ];
    writeFileSync(join(dir, "call-1.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    line.emit("ended", { call_id: "call-1", reason: "bye" });
    await settle();
    const saved = store.transcripts.get("call-1")!;
    expect(saved.map((l) => l.role)).toEqual(["assistant", "user", "user"]);
    expect(saved[1]!.text).not.toMatch(/\d{4}[ -]?\d{4}[ -]?\d{4}/);
    expect(saved[1]!.text).toContain("תוקף 12/28");
    expect(saved[2]!.text).toContain("0534271418"); // a phone (10 digits) is not a card
  });
});

describe("dashboard static files", () => {
  it("serves the page and every file in apps/backend/dashboard without a secret, with its content type", async () => {
    const { app, config } = await setup();
    const page = await app.inject({ method: "GET", url: "/dashboard" });
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");
    expect(page.body).toContain('dir="rtl"');
    expect(page.body).not.toContain(SECRET);
    const root = join(config.repoRoot, "apps", "backend", "dashboard");
    const files = [
      ...readdirSync(root).filter((f) => /\.(js|css)$/.test(f)),
      ...readdirSync(join(root, "views")).map((f) => `views/${f}`),
    ];
    expect(files.length).toBeGreaterThan(8);
    for (const f of files) {
      const r = await app.inject({ method: "GET", url: `/dashboard/${f}` });
      expect(r.statusCode, f).toBe(200);
      expect(r.headers["content-type"], f).toContain(f.endsWith(".css") ? "text/css" : "text/javascript");
      expect(r.headers["cache-control"], f).toBe("no-store");
    }
    expect((await app.inject({ method: "GET", url: "/dashboard/nothing.js" })).statusCode).toBe(404);
    for (const url of ["/dashboard/../src/main.ts", "/dashboard/index.html.bak", "/dashboard/views/../../.env", "/dashboard/x/y/z.js"]) {
      expect((await app.inject({ method: "GET", url })).statusCode, url).toBe(401);
    }
  });
});
