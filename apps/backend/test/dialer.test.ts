import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  type CallInfo,
  type CallOrigin,
  ContactEvents,
  type ContactRecord,
  type ContactStore,
  type DialerControl,
  type DialerStore,
  type QueuedContact,
} from "../src/contacts";
import { Dialer, FAILURE_WAIT_MS, parseOnlyNumbers } from "../src/dialer";
import { buildServer } from "../src/server";
import { AUTH, FIXED_NOW, testConfig } from "./helpers";
import { mayCall } from "../src/access";

const settings = testConfig().settings;

function contact(id: string, phone: string | null, bot_status = "new", next_call_at: string | null = null): ContactRecord {
  return {
    gold_record_id: id,
    national_id: null,
    company: null,
    full_name: `לקוח ${id}`,
    email: null,
    phone,
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
      bot_status,
      attempts: 0,
      no_answer_streak: 0,
      ever_answered: false,
      next_call_at,
      callback_at: null,
      last_call_at: null,
      last_outcome: null,
      interested_day_id: null,
      customer_gender: null,
      phone_index: 1,
      gold_changed_at: null,
    },
  };
}

const RANK: Record<string, number> = { callback: 0, queued: 1, new: 2 };

/** Supabase in memory: the switch, the queue (same order as bot_next_due) and the call records. */
class FakeDb implements ContactStore, DialerStore {
  control: DialerControl = { enabled: false, changed_at: "2026-11-08T00:00:00Z", reason: "כבוי עד ההפעלה הראשונה מהדשבורד" };
  contacts = new Map<string, ContactRecord>();
  calls: { call_id: string; id: string; origin?: CallOrigin; number?: string }[] = [];
  marked: string[] = [];
  failControl = false;
  constructor(...cs: ContactRecord[]) {
    for (const c of cs) this.contacts.set(c.gold_record_id, c);
  }
  private setStatus(id: string, bot_status: string, next_call_at: string | null = null) {
    const c = this.contacts.get(id)!;
    this.contacts.set(id, { ...c, bot_state: { ...c.bot_state!, bot_status, next_call_at } });
  }
  async list() {
    return [...this.contacts.values()];
  }
  async get(id: string) {
    return this.contacts.get(id) ?? null;
  }
  async callStarted(callId: string, id: string, origin?: CallOrigin) {
    this.calls.push({ call_id: callId, id, origin });
    this.setStatus(id, "in_call");
  }
  async toolEvent() {
    return null;
  }
  async callEnded(callId: string) {
    const id = this.calls.find((c) => c.call_id === callId)!.id;
    this.setStatus(id, "queued", "2026-11-09T08:00:00Z"); // tomorrow: not due again today
    return "queued";
  }
  async goldChanges() {
    return { until: "", contacts: [] };
  }
  async dialerControl() {
    if (this.failControl) throw new Error("Supabase down");
    return { ...this.control };
  }
  async setDialer(enabled: boolean, reason: string | null) {
    this.control = { ...this.control, enabled, reason, changed_at: new Date().toISOString() };
    return { ...this.control };
  }
  async setDailyLimit(limit: number | null) {
    this.control = { ...this.control, daily_limit: limit };
  }
  courses: string[][] = [];
  async nextDue(now: Date, skip: string[], courses: string[] = []): Promise<QueuedContact | null> {
    this.courses.push(courses);
    const due = [...this.contacts.values()]
      .map((c) => ({ gold_record_id: c.gold_record_id, bot_status: c.bot_state!.bot_status, next_call_at: c.bot_state!.next_call_at }))
      .filter((q) => q.bot_status in RANK && (!q.next_call_at || new Date(q.next_call_at) <= now) && !skip.includes(q.gold_record_id))
      .sort(
        (a, b) =>
          RANK[a.bot_status]! - RANK[b.bot_status]! ||
          (a.next_call_at ?? "9").localeCompare(b.next_call_at ?? "9") ||
          a.gold_record_id.localeCompare(b.gold_record_id),
      );
    return due[0] ?? null;
  }
  async nextScheduled() {
    return null;
  }
  async callNumber() {
    return null;
  }
  async markNoPhone(id: string) {
    this.marked.push(id);
    this.setStatus(id, "wrong_number");
    return "wrong_number";
  }
  async saveCallInfo(callId: string, info: CallInfo) {
    const call = this.calls.find((c) => c.call_id === callId);
    if (call && info.number) call.number = info.number;
  }
  async usePhone(id: string, index: number) {
    const c = this.contacts.get(id)!;
    this.contacts.set(id, { ...c, bot_state: { ...c.bot_state!, phone_index: index } });
  }
  duplicates: string[] = [];
  async markDuplicate(id: string, number: string) {
    const other = this.calls.find((c) => c.number === number && c.id !== id)?.id ?? null;
    if (other) {
      this.duplicates.push(id);
      this.setStatus(id, "duplicate");
    }
    return other;
  }
  async callsSince(_since: Date, origin: CallOrigin) {
    return this.calls.filter((c) => c.origin === origin).length;
  }
}

/** The phone line: one call at a time; 'ended' when the test says so. */
class FakeLine extends EventEmitter {
  dialed: string[] = [];
  hangups = 0;
  registered = true;
  failDial: string | null = null;
  private current: string | null = null;
  private n = 0;
  async dial(number: string) {
    if (this.failDial) throw new Error(this.failDial);
    if (this.current) throw new Error("a call is already running on the line");
    this.dialed.push(number);
    this.current = `call-${++this.n}`;
    return { call_id: this.current };
  }
  end() {
    const id = this.current!;
    this.current = null;
    this.emit("ended", { call_id: id, reason: "bye" });
  }
  async hangup() {
    this.hangups++;
    return true;
  }
  status() {
    return { registered: this.registered, busy: !!this.current, error: null };
  }
  numberFor() {
    return null;
  }
}

function setup(db: FakeDb, opts: { now?: Date; only?: string } = {}) {
  const line = new FakeLine();
  const phone = { line: line as never, reason: null };
  let now = opts.now ?? FIXED_NOW; // Sunday 10:00, Israel: within business hours
  const make = () =>
    new Dialer({
      store: db,
      events: new ContactEvents(db, () => {}),
      phone,
      settings,
      now: () => now,
      onlyNumbers: parseOnlyNumbers(opts.only),
      log: () => {},
    });
  return { line, dialer: make(), make, setNow: (t: Date) => (now = t) };
}

const flush = () => new Promise((r) => setTimeout(r, 20));

describe("dialer", () => {
  it("starts off; once started, the switch is in the database and a new instance (restart) keeps dialing", async () => {
    const db = new FakeDb(contact("a", "053-1111112"), contact("b", "053-2222223"));
    const { line, dialer, make } = setup(db);
    expect(await dialer.tick()).toBe(settings.dialing.tick_s * 1000);
    expect(dialer.status()).toMatchObject({ state: "stopped", enabled: false });
    expect(line.dialed).toEqual([]);

    await dialer.start("בדיקה");
    expect(db.control).toMatchObject({ enabled: true, reason: "בדיקה" });

    const restarted = make(); // a deploy: a new process reads the switch from the database
    const t = restarted.tick();
    await flush();
    expect(line.dialed).toEqual(["+972531111112"]);
    expect(restarted.status()).toMatchObject({ state: "in_call", enabled: true, current_call: { call_id: "call-1", gold_record_id: "a" } });
    expect(db.calls[0]).toMatchObject({ id: "a", origin: "dialer" });
    line.end();
    expect(await t).toBe(settings.dialing.pause_between_calls_s * 1000);
    expect(restarted.status()).toMatchObject({ state: "running", current_call: null, calls_today: 1 });
  });

  it("the pilot's daily limit: after that many calls today, no more until tomorrow", async () => {
    const db = new FakeDb(contact("a", "053-1111112"), contact("b", "053-2222223"), contact("c", "053-3333334"));
    const { line, dialer } = setup(db);
    await dialer.start();
    await dialer.setDailyLimit(2);
    for (let i = 0; i < 2; i++) {
      const t = dialer.tick();
      await flush();
      line.end();
      await t;
    }
    expect(line.dialed).toHaveLength(2);
    await dialer.tick();
    expect(line.dialed).toHaveLength(2); // the third waits for tomorrow
    expect(dialer.status()).toMatchObject({ state: "daily_limit", calls_today: 2, daily_limit: 2 });
    await dialer.setDailyLimit(null); // no limit: it goes on
    const t = dialer.tick();
    await flush();
    line.end();
    await t;
    expect(line.dialed).toHaveLength(3);
  });

  it("stopped: no call", async () => {
    const db = new FakeDb(contact("a", "053-1111112"));
    const { line, dialer } = setup(db);
    await dialer.start();
    await dialer.stop("הפסקה");
    await dialer.tick();
    expect(line.dialed).toEqual([]);
    expect(dialer.status()).toMatchObject({ state: "stopped", enabled: false, reason: "הפסקה" });
  });

  it("outside business hours: no call", async () => {
    const db = new FakeDb(contact("a", "053-1111112"));
    const { line, dialer } = setup(db, { now: new Date("2026-11-13T08:00:00Z") }); // Friday
    await dialer.start();
    await dialer.tick();
    expect(line.dialed).toEqual([]);
    expect(dialer.status().state).toBe("outside_hours");
    expect(dialer.status().next_due).toEqual({ gold_record_id: "a", next_call_at: null });
  });

  it("a due callback goes before a retry and a new contact; a callback not yet due waits", async () => {
    const db = new FakeDb(
      contact("a-new", "053-1111112"),
      contact("b-queued", "053-2222223", "queued", "2026-11-08T07:00:00Z"),
      contact("c-callback", "053-3333334", "callback", "2026-11-08T07:30:00Z"),
      contact("d-later", "053-4444445", "callback", "2026-11-08T12:00:00Z"),
    );
    const { line, dialer } = setup(db);
    await dialer.start();
    for (let i = 0; i < 3; i++) {
      const t = dialer.tick();
      await flush();
      line.end();
      await t;
    }
    expect(line.dialed).toEqual(["+972533333334", "+972532222223", "+972531111112"]);
    expect(await dialer.tick()).toBe(settings.dialing.tick_s * 1000);
    expect(dialer.status().state).toBe("queue_empty");
  });

  it("asks the queue only for the requested courses in settings (Mishlav: only יום עיון חשבונאות)", async () => {
    const db = new FakeDb(contact("a", "053-1111112"));
    const { line, dialer } = setup(db);
    await dialer.start();
    const t = dialer.tick();
    await flush();
    line.end();
    await t;
    expect(db.courses[0]).toEqual(["יום עיון חשבונאות"]);
  });

  it("one call at a time: the next call only after the line says the call ended", async () => {
    const db = new FakeDb(contact("a", "053-1111112"), contact("b", "053-2222223"));
    const { line, dialer } = setup(db);
    await dialer.start();
    let done = false;
    const t = dialer.tick().then((wait) => {
      done = true;
      return wait;
    });
    await flush();
    expect(done).toBe(false);
    expect(line.dialed).toHaveLength(1);
    line.end();
    expect(await t).toBe(5000);
    const t2 = dialer.tick();
    await flush();
    expect(line.dialed).toEqual(["+972531111112", "+972532222223"]);
    line.end();
    await t2;
  });

  it("a contact without a valid phone is marked wrong_number and doesn't block the queue", async () => {
    const db = new FakeDb(contact("a", null), contact("b", "053-2222223"));
    const { line, dialer } = setup(db);
    await dialer.start();
    expect(await dialer.tick()).toBe(0); // straight to the next one
    expect(db.marked).toEqual(["a"]);
    expect(line.dialed).toEqual([]);
    const t = dialer.tick();
    await flush();
    expect(line.dialed).toEqual(["+972532222223"]);
    line.end();
    await t;
  });

  it("a placeholder or empty phone 1 moves on to the next valid phone, kept in bot_state (Gold: 050-0000000)", async () => {
    const fake = { ...contact("a", "050-0000000"), phone2: "053-0000000", phone3: "03-9061186" };
    const empty = { ...contact("b", null), phone2: "050-9218288" };
    const db = new FakeDb(fake, empty);
    const { line, dialer } = setup(db);
    await dialer.start();
    for (const [id, number] of [["a", "+97239061186"], ["b", "+972509218288"]] as const) {
      const t = dialer.tick();
      await flush();
      expect(line.dialed.at(-1)).toBe(number);
      expect(db.contacts.get(id)!.bot_state!.phone_index).toBe(id === "a" ? 3 : 2); // the SMS and the reps follow it
      line.end();
      await t;
    }
    expect(db.marked).toEqual([]);
  });

  it("only placeholder phones: marked as no phone, never dialed", async () => {
    const db = new FakeDb({ ...contact("a", "052-1234567"), phone2: "03-5555555" });
    const { line, dialer } = setup(db);
    await dialer.start();
    expect(await dialer.tick()).toBe(0);
    expect(db.marked).toEqual(["a"]);
    expect(line.dialed).toEqual([]);
  });

  it("one call per number: a contact whose number was already called on another is closed as duplicate", async () => {
    const db = new FakeDb(contact("a", "052-2246774"), contact("b", "0522246774"), contact("c", "053-2222223"));
    const { line, dialer } = setup(db);
    await dialer.start();
    const t = dialer.tick();
    await flush();
    expect(line.dialed).toEqual(["+972522246774"]); // a
    line.end();
    await t;
    expect(await dialer.tick()).toBe(0); // b: the same number, already called on a
    expect(db.duplicates).toEqual(["b"]);
    expect(db.contacts.get("b")!.bot_state!.bot_status).toBe("duplicate");
    const t2 = dialer.tick();
    await flush();
    expect(line.dialed).toEqual(["+972522246774", "+972532222223"]); // c, not b
    line.end();
    await t2;
  });

  it("DIALER_ONLY_NUMBERS: other numbers are skipped (not dialed, not changed) without blocking the queue", async () => {
    const db = new FakeDb(contact("a", "053-1111112"), contact("b", "054-2222223"), contact("c", "053-3333334"));
    const { line, dialer } = setup(db, { only: "+972 54-222-2223, nonsense" });
    expect(dialer.status().only_numbers).toBe(true);
    await dialer.start();
    expect(await dialer.tick()).toBe(0); // a: skipped
    const t = dialer.tick();
    await flush();
    expect(line.dialed).toEqual(["+972542222223"]);
    line.end();
    await t;
    expect(await dialer.tick()).toBe(0); // c: skipped
    await dialer.tick();
    expect(dialer.status().state).toBe("queue_empty");
    expect(line.dialed).toEqual(["+972542222223"]);
    expect(db.contacts.get("a")!.bot_state!.bot_status).toBe("new");
    expect(db.marked).toEqual([]);
  });

  it("three system failures in a row turn it off in the database, with the reason", async () => {
    const db = new FakeDb(contact("a", "053-1111112"));
    const { line, dialer } = setup(db);
    await dialer.start();
    line.failDial = "could not prepare the bot: Gemini down";
    expect(await dialer.tick()).toBe(FAILURE_WAIT_MS);
    expect(dialer.status()).toMatchObject({ state: "error", failures: 1, enabled: true });
    expect(await dialer.tick()).toBe(FAILURE_WAIT_MS);
    expect(db.control.enabled).toBe(true);
    expect(await dialer.tick()).toBe(FAILURE_WAIT_MS);
    expect(db.control.enabled).toBe(false);
    expect(db.control.reason).toContain("3 תקלות ברצף");
    expect(db.control.reason).toContain("Gemini down");
    expect(dialer.status()).toMatchObject({ state: "stopped", enabled: false, last_error: { message: "could not prepare the bot: Gemini down" } });
    line.failDial = null;
    await dialer.tick();
    expect(line.dialed).toEqual([]); // stays off until someone starts it
  });

  it("Supabase down counts as a failure; a good tick in between starts the count over", async () => {
    const db = new FakeDb();
    const { dialer } = setup(db);
    await dialer.start();
    db.failControl = true;
    await dialer.tick();
    await dialer.tick();
    db.failControl = false;
    await dialer.tick(); // queue empty: fine
    expect(dialer.status().failures).toBe(0);
    expect(db.control.enabled).toBe(true);
  });

  it("the line not registered yet (it retries by itself): waits, not counted as a failure", async () => {
    const db = new FakeDb(contact("a", "053-1111112"));
    const { line, dialer } = setup(db);
    await dialer.start();
    line.registered = false;
    for (let i = 0; i < 4; i++) await dialer.tick();
    expect(line.dialed).toEqual([]);
    expect(dialer.status()).toMatchObject({ state: "error", failures: 0, enabled: true });
  });

  it("stop during a call: the call is not hung up, and no new call after it", async () => {
    const db = new FakeDb(contact("a", "053-1111112"), contact("b", "053-2222223"));
    const { line, dialer } = setup(db);
    await dialer.start();
    const t = dialer.tick();
    await flush();
    await dialer.stop();
    expect(line.hangups).toBe(0);
    expect(dialer.status()).toMatchObject({ state: "in_call", enabled: false, current_call: { gold_record_id: "a" } });
    line.end();
    await t;
    expect(dialer.status().state).toBe("stopped");
    await dialer.tick();
    expect(line.dialed).toEqual(["+972531111112"]);
  });

  it("the loop runs ticks until shutdown, and start() wakes it", async () => {
    const db = new FakeDb(contact("a", "053-1111112"));
    const { line, dialer } = setup(db);
    dialer.run();
    await flush();
    expect(line.dialed).toEqual([]);
    await dialer.start(); // wakes the loop instead of waiting tick_s
    await flush();
    expect(line.dialed).toEqual(["+972531111112"]);
    await dialer.stop();
    line.end();
    dialer.shutdown();
  });

  it("parseOnlyNumbers normalises, ignores junk, and an all-junk list dials nobody", () => {
    expect(parseOnlyNumbers(undefined)).toBeNull();
    expect(parseOnlyNumbers(" ")).toBeNull();
    expect([...parseOnlyNumbers("053-1111112, +972541112222")!]).toEqual(["+972531111112", "+972541112222"]);
    expect(parseOnlyNumbers("abc")!.size).toBe(0);
  });
});

describe("dialer routes (/api/admin/dialer)", () => {
  async function server(withDialer = true) {
    const db = new FakeDb(contact("a", "053-1111112"));
    const app = await buildServer(testConfig(), {
      now: () => FIXED_NOW,
      logger: false,
      env: {},
      contacts: db,
      ...(withDialer && { dialer: { store: db } }),
    });
    return { app, db };
  }

  it("status, start and stop (with a reason), behind the tools secret", async () => {
    const { app, db } = await server();
    expect((await app.inject({ method: "GET", url: "/api/admin/dialer" })).statusCode).toBe(401);
    const get = await app.inject({ method: "GET", url: "/api/admin/dialer", headers: AUTH });
    expect(get.json()).toMatchObject({ ok: true, available: true, dialer: { state: "stopped", calls_today: 0, current_call: null } });
    const start = await app.inject({ method: "POST", url: "/api/admin/dialer/start", headers: AUTH, payload: {} });
    expect(start.json()).toMatchObject({ ok: true, dialer: { enabled: true, reason: "הופעל מהדשבורד" } });
    expect(db.control.enabled).toBe(true);
    const stop = await app.inject({ method: "POST", url: "/api/admin/dialer/stop", headers: AUTH, payload: { reason: "סוף יום" } });
    expect(stop.json()).toMatchObject({ ok: true, dialer: { enabled: false, reason: "סוף יום", state: "stopped" } });
    const bad = await app.inject({ method: "POST", url: "/api/admin/dialer/stop", headers: AUTH, payload: { why: 1 } });
    expect(bad.statusCode).toBe(400);
    // the pilot's daily limit: admins set it; Mishlav's users may not (access.ts doesn't open the route)
    const limit = await app.inject({ method: "POST", url: "/api/admin/dialer/limit", headers: AUTH, payload: { daily_limit: 20 } });
    expect(limit.json()).toMatchObject({ ok: true, dialer: { daily_limit: 20 } });
    expect(db.control.daily_limit).toBe(20);
    expect((await app.inject({ method: "POST", url: "/api/admin/dialer/limit", headers: AUTH, payload: { daily_limit: 0 } })).statusCode).toBe(400);
    expect(mayCall("mishlav", "POST", "/api/admin/dialer/limit")).toBe(false);
  });

  it("without the dialer (no Supabase): unavailable", async () => {
    const { app } = await server(false);
    const get = await app.inject({ method: "GET", url: "/api/admin/dialer", headers: AUTH });
    expect(get.json()).toEqual({ ok: true, available: false, dialer: null });
    expect((await app.inject({ method: "POST", url: "/api/admin/dialer/start", headers: AUTH, payload: {} })).statusCode).toBe(409);
  });
});
