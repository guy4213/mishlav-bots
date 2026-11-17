import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { type Contact, ContactEvents, type ContactStore, SupabaseContacts } from "../src/contacts";
import { buildServer } from "../src/server";
import { AUTH, FIXED_NOW, testConfig } from "./helpers";

const CONTACT: Contact = {
  id: "11111111-1111-4111-8111-111111111111",
  gold_record_id: "a000000000000001demo",
  full_name: "רועי כהן",
  first_name: "רועי",
  phone: "053-4271418",
  phone_e164: "+972534271418",
  status: "new",
  interested_day_id: null,
  customer_gender: null,
  attempts: 0,
  next_call_at: null,
  callback_at: null,
  last_outcome: null,
};

/** Records what the bot would write to Supabase, in order. */
class FakeStore implements ContactStore {
  log: unknown[][] = [];
  failTools = false;
  contacts = new Map([[CONTACT.id, CONTACT]]);
  async list() {
    return [...this.contacts.values()];
  }
  async get(id: string) {
    return this.contacts.get(id) ?? null;
  }
  async callStarted(callId: string, contactId: string) {
    await new Promise((r) => setTimeout(r, 30)); // slower than the tool calls after it: order must still hold
    this.log.push(["started", callId, contactId]);
  }
  async toolEvent(callId: string, tool: string, params: unknown, result: unknown) {
    if (this.failTools) throw new Error("supabase down");
    this.log.push(["tool", callId, tool, params, (result as { status?: string }).status]);
    return null;
  }
  async callEnded(callId: string, sec: number, retry: number, max: number) {
    this.log.push(["ended", callId, retry, max]);
    return null;
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
  recent = [];
}

async function setup() {
  const store = new FakeStore();
  const line = new FakeLine();
  const config = testConfig();
  const app = await buildServer(config, {
    now: () => FIXED_NOW,
    logger: false,
    contacts: store,
    phone: { line: line as never, reason: null },
  });
  const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method: "POST", url, headers: { ...AUTH, ...headers }, payload: body as object });
  return { app, store, line, post, config };
}

const settle = () => new Promise((r) => setTimeout(r, 80));

describe("Supabase contacts: which record, when", () => {
  it("dialing a contact uses its number, name and gender, and links the call to it", async () => {
    const { store, line, post } = await setup();
    const r = await post("/test/phone/call", { contact_id: CONTACT.id });
    expect(r.json()).toMatchObject({ ok: true, call_id: "call-1", contact_id: CONTACT.id });
    expect(line.dialed).toEqual([["+972534271418", { name: "רועי" }]]);
    await settle();
    expect(store.log).toEqual([["started", "call-1", CONTACT.id]]);
  });

  it("every tool of that call updates the same contact, in order, and the end closes it", async () => {
    const { store, line, post } = await setup();
    await post("/test/phone/call", { contact_id: CONTACT.id });
    // the bot's tools come with the call id (x-call-id), right after the dial - before callStarted finished
    await post("/tools/request_human", { reason: "wants_human" }, { "x-call-id": "call-1" });
    await post("/tools/request_human", { reason: "wants_human", in_minutes: 30 }, { "x-call-id": "call-1" });
    await post("/tools/end_call", { reason: "completed" }, { "x-call-id": "call-1" });
    line.emit("ended", { call_id: "call-1", reason: "local" });
    await settle();
    expect(store.log.map((l) => l.slice(0, 3).concat(l[0] === "tool" ? [l[4]] : []))).toEqual([
      ["started", "call-1", CONTACT.id],
      ["tool", "call-1", "request_human", "waiting_for_time"],
      ["tool", "call-1", "request_human", "handed_to_rep"],
      ["tool", "call-1", "end_call", "ending"],
      ["ended", "call-1", 180], // settings: NO_ANSWER retry 180 min, max 4 attempts
    ]);
    expect(store.log[4]).toEqual(["ended", "call-1", 180, 4]);
  });

  it("a call that is not a contact's (no x-call-id) writes nothing", async () => {
    const { store, post } = await setup();
    await post("/tools/send_purchase_link", { day_id: "payroll-2026-12-08-zoom" });
    await settle();
    expect(store.log).toEqual([]);
  });

  it("Supabase down: the bot still gets its answer, the failure is logged", async () => {
    const { app, store, post, config } = await setup();
    store.failTools = true;
    const r = await post("/tools/send_purchase_link", { day_id: "payroll-2026-12-08-zoom" }, { "x-call-id": "call-9" });
    expect(r.json()).toMatchObject({ ok: true, status: "sent" });
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
    store.contacts.set(CONTACT.id, { ...CONTACT, status: "do_not_call" });
    const r = await post("/test/phone/call", { contact_id: CONTACT.id });
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
  });
});
