import type { NotesSummarizer } from "../src/notes";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type CallInfo,
  type CallLimits,
  type Contact,
  ContactEvents,
  type ContactRecord,
  type ContactStore,
  firstName,
  SupabaseContacts,
  isPlaceholderPhone,
  toE164,
  toGoldRecord,
} from "../src/contacts";
import { buildServer } from "../src/server";
import { AUTH, FIXED_NOW, testConfig } from "./helpers";

const GOLD: Contact = {
  gold_record_id: "a000000000000001demo",
  national_id: "000012344",
  company: null,
  full_name: "רועי כהן",
  email: "roi.cohen@example.com",
  phone: "053-4271418",
  phone2: "054 1112222",
  phone3: null,
  notes: "ביקש שיחזרו אחרי 16:00",
  city: "תל אביב-יפו",
  address: null,
  address2: null,
  department: "ימי עיון",
  requested_course: "יום עיון חשבונאות",
  source: "אתר מישלב",
  status: null,
};
const CONTACT: ContactRecord = {
  ...GOLD,
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
const ID = CONTACT.gold_record_id;

/** Records what the bot would write to Supabase, in order. */
class FakeStore implements ContactStore {
  log: unknown[][] = [];
  failTools = false;
  contacts = new Map([[ID, CONTACT]]);
  changes: Contact[] = [{ ...GOLD, notes: `${GOLD.notes}\n[הערת הבוט] 08.11.2026 10:00 – נשלח קישור לרכישה: d`, status: "נשלח קישור" }];
  async list() {
    return [...this.contacts.values()];
  }
  async get(id: string) {
    return this.contacts.get(id) ?? null;
  }
  async callStarted(callId: string, goldRecordId: string, origin?: string) {
    await new Promise((r) => setTimeout(r, 30)); // slower than the tool calls after it: order must still hold
    this.log.push(["started", callId, goldRecordId, origin]);
  }
  async toolEvent(callId: string, tool: string, params: unknown, result: unknown) {
    if (this.failTools) throw new Error("supabase down");
    this.log.push(["tool", callId, tool, params, (result as { status?: string }).status]);
    return null;
  }
  async callEnded(callId: string, sec: number, nextCallAt: Date[], limits: CallLimits) {
    this.log.push(["ended", callId, nextCallAt, limits]);
    return null;
  }
  /** the phone of each contact call (bot_call_number) */
  callNumbers = new Map<string, string>();
  failNumber = false;
  async callNumber(callId: string) {
    if (this.failNumber) throw new Error("supabase down");
    return this.callNumbers.get(callId) ?? null;
  }
  recordings: [string, string][] = [];
  voice: string | null = null;
  async botVoice() {
    return this.voice;
  }
  async setBotVoice(voice: string | null) {
    this.voice = voice;
  }
  async saveRecording(callId: string, file: string) {
    this.recordings.push([callId, file]);
  }
  /** summary lines ADDED to a contact's notes (notes.ts) */
  summaries: [string, string][] = [];
  async appendBotSummary(id: string, text: string) {
    this.log.push(["summary", id]);
    this.summaries.push([id, text]);
  }
  /** test calls without a contact (calls rows of their own), and each call's own details */
  testCalls: [string, CallInfo][] = [];
  callInfo: [string, CallInfo][] = [];
  async testCallStarted(callId: string, info: CallInfo) {
    this.testCalls.push([callId, info]);
  }
  async saveCallInfo(callId: string, info: CallInfo) {
    this.callInfo.push([callId, info]);
  }
  async goldChanges(since?: string) {
    this.log.push(["gold", since]);
    return { until: "2026-11-08T08:00:00+00:00", contacts: this.changes };
  }
}

/** The phone line as the tools server sees it: dial() -> call_id, then 'ended'. */
class FakeLine extends EventEmitter {
  dialed: unknown[] = [];
  async dial(number: string, opts: unknown) {
    this.dialed.push([number, opts]);
    return { call_id: "call-1" };
  }
  status() {
    return { registered: true, busy: false };
  }
  /** someone calling the line: call id -> their number */
  callers = new Map<string, string>();
  numberFor(callId: string) {
    if (this.callers.has(callId)) return this.callers.get(callId)!;
    const last = this.dialed.at(-1) as [string, unknown] | undefined;
    return callId === "call-1" ? (last?.[0] ?? null) : null;
  }
  recent = [];
}

async function setup(env: NodeJS.ProcessEnv = {}, summarizeNotes?: NotesSummarizer) {
  const store = new FakeStore();
  const line = new FakeLine();
  const config = testConfig();
  const app = await buildServer(config, {
    now: () => FIXED_NOW,
    logger: false,
    env,
    summarizeNotes,
    contacts: store,
    phone: { line: line as never, reason: null },
  });
  const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method: "POST", url, headers: { ...AUTH, ...headers }, payload: body as object });
  return { app, store, line, post, config };
}

const settle = () => new Promise((r) => setTimeout(r, 80));

describe("Supabase contacts: which record, when", () => {
  it("dialing a contact uses its phone (as +972), first name and gender, and links the call to it", async () => {
    const { store, line, post } = await setup();
    const r = await post("/test/phone/call", { contact_id: ID });
    expect(r.json()).toMatchObject({ ok: true, call_id: "call-1", contact_id: ID });
    // every call rings at most dialing.ring_timeout_s, then ends like a no-answer
    expect(line.dialed).toEqual([["+972534271418", { name: "רועי", notes: "ביקש שיחזרו אחרי 16:00", ringTimeoutMs: 40_000 }]]); // its notes reach the bot
    await settle();
    expect(store.log).toEqual([["started", "call-1", ID, "manual"]]);
  });

  it("after a wrong number it dials the next phone (bot_state.phone_index)", async () => {
    const { store, line, post } = await setup();
    store.contacts.set(ID, { ...CONTACT, bot_state: { ...CONTACT.bot_state!, phone_index: 2 } });
    await post("/test/phone/call", { contact_id: ID });
    expect(line.dialed).toEqual([["+972541112222", { name: "רועי", notes: "ביקש שיחזרו אחרי 16:00", ringTimeoutMs: 40_000 }]]); // its notes reach the bot
  });

  it("every tool of that call updates the same contact, in order, and the end closes it", async () => {
    const { store, line, post } = await setup();
    await post("/test/phone/call", { contact_id: ID });
    // the bot's tools come with the call id (x-call-id), right after the dial - before callStarted finished
    await post("/tools/request_human", { reason: "wants_human" }, { "x-call-id": "call-1" });
    await post("/tools/request_human", { reason: "wants_human", in_minutes: 30 }, { "x-call-id": "call-1" });
    await post("/tools/end_call", { reason: "completed" }, { "x-call-id": "call-1" });
    line.emit("ended", { call_id: "call-1", reason: "local" });
    await settle();
    expect(store.log.map((l) => l.slice(0, 3).concat(l[0] === "tool" ? [l[4]] : []))).toEqual([
      ["started", "call-1", ID],
      ["tool", "call-1", "request_human", "waiting_for_time"],
      ["tool", "call-1", "request_human", "handed_to_rep"],
      ["tool", "call-1", "end_call", "ending"],
      ["ended", "call-1", expect.any(Array)],
    ]);
    // the next call for a streak of 1, 2, 3 (settings: dialing.no_answer_retry) and the two limits
    const [, , nextCallAt, limits] = store.log[4] as [string, string, Date[], CallLimits];
    expect(nextCallAt).toHaveLength(3);
    expect(nextCallAt.every((t) => t.getTime() > Date.now())).toBe(true);
    expect(limits).toEqual({ noAnswerStreakMax: 4, maxTotalCalls: 8 });
  });

  it("the bot's notes piled up: at the call's end a summary line is ADDED (after the call's own updates)", async () => {
    const asked: string[][] = [];
    const { store, line, post } = await setup({}, async ({ lines }) => (asked.push(lines), ["רוצה מרץ בזום", "נשלח קישור"]));
    const many = Array.from({ length: 10 }, (_, i) => `[הערת הבוט] ${i}.11.2026 10:00 – ביקש שנחזור אליו מחר, התעניין במרץ בזום`);
    store.contacts.set(ID, { ...CONTACT, notes: ["ביקש שיחזרו אחרי 16:00", ...many].join("\n") });
    await post("/test/phone/call", { contact_id: ID });
    line.emit("ended", { call_id: "call-1", reason: "local" });
    await settle();
    expect(store.log.map((l) => l[0])).toEqual(["started", "ended", "summary"]);
    expect(store.summaries).toEqual([[ID, "✓ רוצה מרץ בזום · ✓ נשלח קישור"]]);
    expect(asked[0]).toEqual(many); // only the bot's lines - never the rep's note
  });

  it("short notes: no summary", async () => {
    const { store, line, post } = await setup({}, async () => ["x"]);
    await post("/test/phone/call", { contact_id: ID });
    line.emit("ended", { call_id: "call-1", reason: "local" });
    await settle();
    expect(store.summaries).toEqual([]);
  });

  it("a contact's call keeps the number it was on (and its scenario) in calls", async () => {
    const { store, post } = await setup();
    await post("/test/phone/call", { contact_id: ID, scenario: "S2" });
    await settle();
    expect(store.callInfo).toEqual([["call-1", { number: "+972534271418", direction: "out", scenario: "S2" }]]);
    expect(store.testCalls).toEqual([]); // a contact's call is no test row of its own
  });

  it("a test call to a typed number is kept in calls without a contact: number, name, its end and its recording", async () => {
    const { store, line, post, config } = await setup();
    const r = await post("/test/phone/call", { number: "053-4271418", name: "גיא", scenario: "S1" });
    expect(r.json()).toMatchObject({ ok: true, call_id: "call-1" });
    await settle();
    expect(store.testCalls).toEqual([["call-1", { number: "+972534271418", direction: "out", contact_name: "גיא", scenario: "S1" }]]);
    // the line wrote the transcript (someone answered and spoke), then says the call ended with its recording
    mkdirSync(join(config.logDir, "transcripts"), { recursive: true });
    const lines = [{ ts: "t1", role: "assistant", text: "היי גיא" }, { ts: "t2", role: "user", text: "הלו" }];
    writeFileSync(join(config.logDir, "transcripts", "call-1.jsonl"), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
    line.emit("ended", { call_id: "call-1", reason: "remote", recording: "/tmp/logs/recordings/call-1.mp3" });
    await settle();
    expect(store.callInfo).toEqual([["call-1", { duration_sec: expect.any(Number), answered: true }]]);
    expect(store.recordings).toEqual([["call-1", "/tmp/logs/recordings/call-1.mp3"]]);
    expect(store.log).toEqual([]); // nobody's record: no bot_call_started / bot_call_ended
  });

  it("an incoming call is kept too, under the caller's number; nobody answered = not answered", async () => {
    const { store, line } = await setup();
    line.callers.set("in-1", "972541112222");
    // the line's status masks the number; an outgoing call's event makes nothing (its route keeps it)
    line.emit("call", { call: { id: "call-9", direction: "out", number: "053***1418", scenario: null } });
    line.emit("call", { call: { id: "in-1", direction: "in", number: "054***2222", scenario: null } });
    await settle();
    expect(store.testCalls).toEqual([["in-1", { number: "+972541112222", direction: "in", scenario: null }]]);
    line.emit("ended", { call_id: "in-1", reason: "caller hung up" });
    await settle();
    expect(store.callInfo).toEqual([["in-1", { duration_sec: expect.any(Number), answered: false }]]);
  });

  it("the call's recording goes to the store when the call ends; a voice picked for the test reaches the line", async () => {
    const { store, line, post } = await setup();
    await post("/test/phone/call", { contact_id: ID, voice: "Leda" });
    expect((line.dialed[0] as [string, { voice?: string }])[1].voice).toBe("Leda");
    line.emit("ended", { call_id: "call-1", reason: "local", recording: "/tmp/logs/recordings/call-1.wav" });
    await settle();
    expect(store.recordings).toEqual([["call-1", "/tmp/logs/recordings/call-1.wav"]]);
  });

  it("every call uses the voice the team picked in the dashboard; a test call's own voice wins", async () => {
    const { store, line, app, post } = await setup();
    const bad = await app.inject({ method: "POST", url: "/api/admin/voice", headers: AUTH, payload: { voice: "Nobody" } });
    expect(bad.statusCode).toBe(400);
    const set = await app.inject({ method: "POST", url: "/api/admin/voice", headers: AUTH, payload: { voice: "Leda" } });
    expect(set.json()).toMatchObject({ ok: true, voice: "Leda" });
    expect(store.voice).toBe("Leda");
    const got = await app.inject({ method: "GET", url: "/api/admin/voice", headers: AUTH });
    expect(got.json()).toMatchObject({ ok: true, voice: "Leda", server_voice: "Kore" });
    expect(got.json().voices).toContain("Aoede");
    await post("/test/phone/call", { contact_id: ID });
    expect((line.dialed[0] as [string, { voice?: string }])[1].voice).toBe("Leda");
    line.emit("ended", { call_id: "call-1", reason: "local" });
    await settle();
    await post("/test/phone/call", { contact_id: ID, voice: "Zephyr" });
    expect((line.dialed[1] as [string, { voice?: string }])[1].voice).toBe("Zephyr");
  });

  it("test calls without a contact (a typed number, \"שיחה אליי\") use the picked voice too; 13 voices with their words", async () => {
    const { store, line, app, post } = await setup();
    store.voice = "Sulafat";
    await post("/test/phone/call", { number: "053-4271418" });
    expect((line.dialed[0] as [string, { voice?: string }])[1].voice).toBe("Sulafat"); // it used to be the server's
    const got = (await app.inject({ method: "GET", url: "/api/admin/voice", headers: AUTH })).json();
    expect(got.voices).toHaveLength(13);
    expect(got.labels).toMatchObject({ Sulafat: "חם", Erinome: "צלול", Kore: "תקיף" });
    expect(got.voices).not.toContain("Gacrux"); // "mature": the voice was found too old
  });

  it("a call that is not a contact's (no x-call-id) writes nothing", async () => {
    const { store, post } = await setup();
    await post("/tools/send_purchase_link", { day_id: "2027-02-21-zoom" });
    await settle();
    expect(store.log).toEqual([]);
  });

  it("Supabase down: the bot still gets its answer, the failure is logged", async () => {
    const { app, store, post, config } = await setup();
    store.failTools = true;
    const r = await post("/tools/send_purchase_link", { day_id: "2027-02-21-zoom" }, { "x-call-id": "call-9" });
    expect(r.json()).toMatchObject({ ok: true, status: "sent" });
    expect(r.json().day_he).toMatch(/^[^A-Za-z]*[א-ת][^A-Za-z]*$/); // the note on the lead names the day in Hebrew, not its id
    await settle();
    const calls = await app.inject({ method: "GET", url: "/test/calls?call_id=call-9", headers: AUTH });
    expect(calls.json().count).toBe(1); // the tool call itself
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const raw = readFileSync(join(config.logDir, "tool-calls.jsonl"), "utf8");
    expect(raw).toContain('"type":"supabase_error"');
  });

  it("never dials a contact who asked not to be called", async () => {
    const { store, line, post } = await setup();
    store.contacts.set(ID, { ...CONTACT, bot_state: { ...CONTACT.bot_state!, bot_status: "do_not_call" } });
    const r = await post("/test/phone/call", { contact_id: ID });
    expect(r.statusCode).toBe(409);
    expect(line.dialed).toEqual([]);
  });

  it("ContactEvents keeps each call's order even when an update is slow", async () => {
    const seen: string[] = [];
    const ev = new ContactEvents(new FakeStore(), () => {});
    void ev.run("c", "a", async () => { await new Promise((r) => setTimeout(r, 20)); seen.push("a"); });
    await ev.run("c", "b", async () => { seen.push("b"); });
    expect(seen).toEqual(["a", "b"]);
  });

  it("SupabaseContacts calls the SQL functions with the service key", async () => {
    const sent: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      sent.push({ url, init });
      return new Response('"link_sent"', { status: 200 });
    }) as unknown as typeof fetch;
    const s = new SupabaseContacts("https://x.supabase.co/", "service-key", fetchImpl);
    expect(await s.toolEvent("call-1", "send_purchase_link", { day_id: "d" }, { ok: true })).toBe("link_sent");
    expect(sent[0]!.url).toBe("https://x.supabase.co/rest/v1/rpc/bot_tool_event");
    expect(JSON.parse(sent[0]!.init.body as string)).toEqual({ p_call_id: "call-1", p_tool: "send_purchase_link", p_params: { day_id: "d" }, p_result: { ok: true } });
    expect((sent[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer service-key");
    await s.callStarted("call-1", ID);
    expect(JSON.parse(sent[1]!.init.body as string)).toEqual({ p_call_id: "call-1", p_gold_record_id: ID, p_origin: "manual" });
    await s.callEnded("call-1", 12.4, [new Date("2026-11-17T13:00:00Z")], { noAnswerStreakMax: 4, maxTotalCalls: 8 });
    expect(sent[2]!.url).toBe("https://x.supabase.co/rest/v1/rpc/bot_call_ended");
    expect(JSON.parse(sent[2]!.init.body as string)).toEqual({
      p_call_id: "call-1",
      p_duration_sec: 12,
      p_next_call_at: ["2026-11-17T13:00:00.000Z"],
      p_no_answer_streak_max: 4,
      p_max_total_calls: 8,
    });
  });

  it("SupabaseContacts for the contacts screen: a counted page, the queue in its order, the latest activity", async () => {
    const urls: string[] = [];
    const row = (id: string, s: Record<string, unknown> = {}) => ({ gold_record_id: id, full_name: id, bot_state: { bot_status: "new", ...s } });
    const fetchImpl = (async (url: string) => {
      urls.push(decodeURIComponent(url));
      const u = decodeURIComponent(url);
      if (u.includes("/rpc/bot_queue")) return Response.json([{ gold_record_id: "b", due: true }, { gold_record_id: "a", due: false }]);
      if (u.includes("/bot_state?") && u.includes("last_call_at=not.is.null"))
        return Response.json([{ gold_record_id: "old", bot_status: "queued", last_call_at: "2026-11-25T08:00:00Z", gold_changed_at: null }]);
      if (u.includes("/bot_state?"))
        return Response.json([{ gold_record_id: "dup", bot_status: "duplicate", last_call_at: null, gold_changed_at: "2026-11-25T09:00:00Z" },
          { gold_record_id: "now", bot_status: "in_call", last_call_at: null, gold_changed_at: "2026-11-25T07:00:00Z" }]);
      if (u.includes("gold_record_id=in.")) return Response.json([row("a"), row("b"), row("old"), row("dup"), row("now")]);
      return new Response(JSON.stringify([row("a")]), { headers: { "content-range": "100-149/5298" } });
    }) as unknown as typeof fetch;
    const s = new SupabaseContacts("https://x.supabase.co", "k", fetchImpl);

    expect(await s.contactsPage({ q: "רועי", status: "new", page: 3, size: 50 })).toMatchObject({ total: 5298, contacts: [{ gold_record_id: "a" }] });
    expect(urls[0]).toContain("bot_state!inner(bot_status,"); // the table's columns only, not the notes
    expect(urls[0]).not.toContain("notes");
    expect(urls[0]).toContain("&bot_state.bot_status=eq.new&or=(full_name.ilike.\"*רועי*\"");
    expect(urls[0]).toContain("&limit=50&offset=100");

    expect((await s.queue(new Date(), ["יום עיון חשבונאות"], 50)).map((c) => [c.gold_record_id, c.due])).toEqual([["b", true], ["a", false]]);
    // the call in progress first, then the newest of a call or a change
    expect((await s.recentContacts(50)).map((c) => c.gold_record_id)).toEqual(["now", "dup", "old"]);
  });

  it("phone and name come from Gold's columns at dial time", () => {
    expect(["053-4271418", "053 4271418", "0534271418", "+972-53-4271418", "972534271418"].map(toE164)).toEqual(Array(5).fill("+972534271418"));
    expect(toE164("03-1234567")).toBe("+97231234567");
    expect([toE164(null), toE164(""), toE164("123")]).toEqual([null, null, null]);
    // the length by kind: mobile / VoIP 9 digits after the 0, landline 8 (real Gold rows)
    expect(["077-1234567", "08-6355777"].map(toE164)).toEqual(["+972771234567", "+97286355777"]);
    expect(["05-4344607", "025-2281098", "05444742137", "03-12345678"].map(toE164)).toEqual([null, null, null, null]);
    expect(["+972500000000", "+97235555555", "+972521234567"].map(isPlaceholderPhone)).toEqual([true, true, true]);
    expect(["+972503333312", "+972586577777", "+972534271418"].map(isPlaceholderPhone)).toEqual([false, false, false]);
    expect([firstName("  רועי   כהן "), firstName("דנה"), firstName(null), firstName(" ")]).toEqual(["רועי", "דנה", null, null]);
  });
});

describe("Gold pulls the bot's changes (GET /api/gold/changes)", () => {
  const KEY = "gold-key-0123456789abcdef";
  const get = (app: Awaited<ReturnType<typeof setup>>["app"], url: string, headers: Record<string, string> = {}) =>
    app.inject({ method: "GET", url, headers });

  it("without GOLD_API_KEY configured it refuses everything", async () => {
    const { app, store } = await setup({});
    expect((await get(app, "/api/gold/changes", { "x-api-key": "anything" })).statusCode).toBe(503);
    expect((await get(app, "/api/gold/changes", AUTH)).statusCode).toBe(503);
    expect(store.log).toEqual([]);
  });

  it("a wrong or missing key (or the tools secret) gets nothing", async () => {
    const { app, store } = await setup({ GOLD_API_KEY: KEY });
    expect((await get(app, "/api/gold/changes")).statusCode).toBe(401);
    expect((await get(app, "/api/gold/changes", { "x-api-key": "wrong" })).statusCode).toBe(401);
    expect((await get(app, "/api/gold/changes", AUTH)).statusCode).toBe(401);
    expect(store.log).toEqual([]);
  });

  it("returns only the Excel's 16 columns under its Hebrew headers, and `until` for the next pull", async () => {
    const { app, store, config } = await setup({ GOLD_API_KEY: KEY });
    const r = await get(app, "/api/gold/changes?since=2026-11-07T00:00:00Z", { "x-api-key": KEY });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(store.log).toEqual([["gold", "2026-11-07T00:00:00.000Z"]]);
    expect(body).toMatchObject({ since: "2026-11-07T00:00:00.000Z", until: "2026-11-08T08:00:00+00:00", count: 1 });
    const headers = Object.keys(config.settings.gold_import.columns).map((h) => h || "מזהה");
    expect(headers).toHaveLength(16);
    expect(Object.keys(body.contacts[0])).toEqual(headers);
    expect(body.contacts[0]).toMatchObject({ מזהה: ID, "שם מלא": "רועי כהן", טלפון: "053-4271418", סטטוס: "נשלח קישור" });
    expect(body.contacts[0]["הערות"]).toBe("ביקש שיחזרו אחרי 16:00\n[הערת הבוט] 08.11.2026 10:00 – נשלח קישור לרכישה: d");
  });

  it("no `since`: everything the bot ever changed; a bad `since` is refused", async () => {
    const { app, store } = await setup({ GOLD_API_KEY: KEY });
    expect((await get(app, "/api/gold/changes", { "x-api-key": KEY })).json()).toMatchObject({ since: null, count: 1 });
    expect(store.log).toEqual([["gold", undefined]]);
    expect((await get(app, "/api/gold/changes?since=yesterday", { "x-api-key": KEY })).statusCode).toBe(400);
  });

  it("the dashboard sees the same payload behind the tools secret", async () => {
    const { app } = await setup({ GOLD_API_KEY: KEY });
    const dash = (await get(app, "/test/gold/changes", AUTH)).json();
    const gold = (await get(app, "/api/gold/changes", { "x-api-key": KEY })).json();
    expect(dash).toEqual(gold);
    expect((await get(app, "/test/gold/changes", { "x-api-key": KEY })).statusCode).toBe(401);
  });

  it("toGoldRecord: the record id goes under record_id_key, nothing else is added", () => {
    const gi = { record_id_key: "ID", columns: { "": "gold_record_id", "שם מלא": "full_name" } };
    const extra = { ...GOLD, bot_status: "link_sent" } as unknown as Contact;
    expect(toGoldRecord(extra, gi)).toEqual({ ID: ID, "שם מלא": "רועי כהן" });
  });
});
