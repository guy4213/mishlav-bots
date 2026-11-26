import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CallLimits, ContactRecord, ContactStore } from "../src/contacts";
import { loadKnowledge } from "../src/knowledge";
import { buildServer } from "../src/server";
import { toolHandlers } from "../src/tools/handlers";
import { type LinkTemplateValues, LogOnlyWhatsApp, type WhatsAppResult, type WhatsAppSender } from "../src/whatsapp";
import { AUTH, FIXED_NOW, testConfig } from "./helpers";

// The purchase link goes ONLY by WhatsApp (Mishlav: never by SMS). Who it goes to comes from the call, never the bot.
const DAY = "2027-02-21-zoom";
const PREFIX = "https://example.com/mishlav/purchase/"; // the test days' links

/** A WhatsApp provider that records what it would send. */
class FakeWa implements WhatsAppSender {
  readonly provider = "fake";
  readonly live = true;
  sent: [string, LinkTemplateValues][] = [];
  fail = false;
  async sendLink(to: string, values: LinkTemplateValues): Promise<WhatsAppResult> {
    this.sent.push([to, values]);
    return this.fail ? { ok: false, provider: this.provider, error: "Recipient unsubscribed" } : { ok: true, provider: this.provider, sent: true };
  }
}

class FakeStore implements ContactStore {
  numbers = new Map<string, string>();
  failNumber = false;
  tools: [string, string, unknown][] = [];
  async list(): Promise<ContactRecord[]> {
    return [];
  }
  async get() {
    return null;
  }
  async callStarted() {}
  async toolEvent(callId: string, tool: string, _params: unknown, result: unknown) {
    this.tools.push([callId, tool, (result as { ok: boolean }).ok]);
    return null;
  }
  async callEnded(_c: string, _s: number, _n: Date[], _l: CallLimits) {
    return null;
  }
  async goldChanges() {
    return { until: "", contacts: [] };
  }
  async callNumber(callId: string) {
    if (this.failNumber) throw new Error("supabase down");
    return this.numbers.get(callId) ?? null;
  }
}

/** The line, with a scenario call "call-line" to +972501234567 on it. */
class FakeLine extends EventEmitter {
  recent = [];
  status() {
    return { registered: true, busy: true };
  }
  numberFor(callId: string) {
    return callId === "call-line" ? "+972501234567" : null;
  }
  nameFor(callId: string) {
    return callId === "call-line" ? "דנה" : null;
  }
}

async function setup(whatsapp: WhatsAppSender = new FakeWa()) {
  const store = new FakeStore();
  const config = testConfig();
  config.settings.whatsapp.url_prefix = PREFIX;
  const app = await buildServer(config, {
    now: () => FIXED_NOW,
    logger: false,
    env: {},
    contacts: store,
    phone: { line: new FakeLine() as never, reason: null },
    whatsapp,
  });
  const send = async (callId?: string) =>
    (
      await app.inject({
        method: "POST",
        url: "/tools/send_purchase_link",
        headers: { ...AUTH, ...(callId && { "x-call-id": callId }) },
        payload: { day_id: DAY },
      })
    ).json();
  const rawLog = () => readFileSync(join(config.logDir, "tool-calls.jsonl"), "utf8");
  return { store, whatsapp, send, rawLog };
}

const settle = () => new Promise((r) => setTimeout(r, 50));

describe("send_purchase_link sends the WhatsApp to the number on the call", () => {
  it("a contact's call: its phone in Supabase (normalised), the template's values, and no full number in the log", async () => {
    const { store, whatsapp, send, rawLog } = await setup();
    store.numbers.set("call-1", "053-4271418");
    const r = await send("call-1");
    expect(r).toMatchObject({ ok: true, status: "sent", day_id: DAY, whatsapp: { sent: true, provider: "fake" }, closing: true });
    expect(r.say_he).toBe("הקישור נשלח עכשיו בוואטסאפ. יום נעים, להתראות.");
    const [to, values] = (whatsapp as FakeWa).sent[0]!;
    expect(to).toBe("+972534271418");
    expect(values).toMatchObject({ body: ["שלום", "דיני עבודה ומס הכנסה", expect.stringContaining("21–22.2.2027")], buttonPayload: DAY });
    expect(r.day_he).toBe("דיני עבודה ומס הכנסה – 21–22.2.2027 · בזום"); // the note in Gold
    await settle();
    expect(store.tools).toEqual([["call-1", "send_purchase_link", true]]); // Gold: "נשלח קישור"
    const log = rawLog();
    expect(log).toContain('"recipient":"+97253***1418"');
    expect(log).not.toMatch(/534271418|4271418/);
  });

  it("a scenario call (no contact): the number the line dialed, and the name it was given", async () => {
    const { whatsapp, send, rawLog } = await setup();
    expect(await send("call-line")).toMatchObject({ ok: true, whatsapp: { sent: true } });
    expect((whatsapp as FakeWa).sent[0]![0]).toBe("+972501234567");
    expect((whatsapp as FakeWa).sent[0]![1].body[0]).toBe("דנה");
    expect(rawLog()).not.toContain("501234567");
  });

  it("Supabase down: falls back to the number on the line", async () => {
    const { store, whatsapp, send } = await setup();
    store.failNumber = true;
    expect(await send("call-line")).toMatchObject({ ok: true });
    expect((whatsapp as FakeWa).sent[0]![0]).toBe("+972501234567");
  });

  it("no number for the call: no_phone, nothing sent, the bot offers a rep", async () => {
    const { whatsapp, send } = await setup();
    for (const callId of ["unknown-call", undefined]) {
      const r = await send(callId);
      expect(r).toMatchObject({ ok: false, error: "no_phone" });
      expect(r.message_he).toContain("נציג");
    }
    expect((whatsapp as FakeWa).sent).toEqual([]);
  });

  it("the bot is answered at once (no silence while Texter works); a failure in the background goes to a rep", async () => {
    const wa = new FakeWa();
    wa.fail = true;
    const { store, send } = await setup(wa);
    store.numbers.set("call-1", "053-4271418");
    const r = await send("call-1");
    expect(r).toMatchObject({ ok: true, status: "sent", closing: true }); // the customer hears "נשלח" right away
    await settle();
    // ...and when Texter refused it: a rep task with a note, so a person sends the link
    expect(store.tools).toEqual([
      ["call-1", "send_purchase_link", true],
      ["call-1", "request_human", true],
    ]);
  });

  it("asked again on the same call (after a cut-in): sent once; the bot is told it went and not to ask again", async () => {
    const { store, whatsapp, send } = await setup();
    store.numbers.set("call-1", "053-4271418");
    await send("call-1");
    const again = await send("call-1");
    expect(again).toMatchObject({ ok: true, status: "already_sent", say_he: "הקישור נשלח עכשיו בוואטסאפ. יום נעים, להתראות." });
    expect(again.message_he).toContain("לא לשאול שוב");
    await settle();
    expect((whatsapp as FakeWa).sent).toHaveLength(1);
    expect(store.tools).toEqual([["call-1", "send_purchase_link", true]]); // Gold: one "נשלח קישור"
  });

  it("Texter not configured: a real customer is never told 'sent' (a rep sends it); a text run without a number goes through", async () => {
    const lines: string[] = [];
    const { store, send } = await setup(new LogOnlyWhatsApp((t) => lines.push(t)));
    store.numbers.set("call-1", "053-4271418");
    const real = await send("call-1");
    expect(real).toMatchObject({ ok: false, error: "whatsapp_not_configured" });
    expect(real.message_he).toContain("נציג");
    expect(await send()).toMatchObject({ ok: true, whatsapp: { sent: false, provider: "log" } });
    expect(lines).toHaveLength(1); // written down, sent to nobody
    expect(lines[0]).toContain("NOT sent");
    expect(lines.join("\n")).not.toContain("4271418");
  });

  it("a day without purchase_url: no_purchase_url, nothing sent", async () => {
    const config = testConfig();
    const knowledge = loadKnowledge(config.knowledgeDir, config.offlineDaysDir);
    knowledge.days.set(DAY, { ...knowledge.days.get(DAY)!, purchase_url: undefined });
    const wa = new FakeWa();
    const r = await toolHandlers.send_purchase_link({ day_id: DAY }, { knowledge, settings: config.settings, now: () => FIXED_NOW, whatsapp: wa, recipient: "+972501234567" });
    expect(r).toMatchObject({ ok: false, error: "no_purchase_url" });
    expect(r.ok === false && r.message_he).toContain("נציג");
    expect(wa.sent).toEqual([]);
  });

  it("every study day has an https purchase_url (placeholders until Mishlav sends the real ones)", () => {
    for (const d of loadKnowledge(testConfig().knowledgeDir, testConfig().offlineDaysDir).days.values()) expect(d.purchase_url).toMatch(/^https:\/\//);
  });
});
