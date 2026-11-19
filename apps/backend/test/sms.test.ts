import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CallLimits, ContactRecord, ContactStore } from "../src/contacts";
import { loadKnowledge } from "../src/knowledge";
import { buildServer } from "../src/server";
import { LogOnlySms, type SmsResult, type SmsSender, smsSenderFromEnv, ZadarmaSms, zadarmaSignature } from "../src/sms";
import { toolHandlers } from "../src/tools/handlers";
import { AUTH, FIXED_NOW, testConfig } from "./helpers";

const DAY = "payroll-2026-12-08-zoom";

describe("Zadarma signature", () => {
  it("sorted params, PHP-style encoding, base64 of the hex HMAC-SHA1 (as Zadarma's official PHP client)", () => {
    const { query, signature } = zadarmaSignature(
      "/v1/sms/send/",
      { sender: "Mishlav", number: "972501234567", message: "משלב: https://example.com/p?a=1&b=2 ~!*'()", format: "json" },
      "test-secret",
    );
    expect(query).toBe(
      "format=json&message=%D7%9E%D7%A9%D7%9C%D7%91%3A+https%3A%2F%2Fexample.com%2Fp%3Fa%3D1%26b%3D2+%7E%21%2A%27%28%29&number=972501234567&sender=Mishlav",
    );
    // base64(hex(hmac_sha1("/v1/sms/send/" + query + md5hex(query), "test-secret")))
    expect(signature).toBe("OTViMTQwZTAyOGFjMzdhNTJmMjBjN2JiMGIzZGE4ZTBmNzYxZGIzNw==");
  });
});

describe("ZadarmaSms", () => {
  function zadarma(reply: () => Response | Promise<Response>, sender?: string) {
    const sent: { url: string; init: RequestInit }[] = [];
    const logs: string[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      sent.push({ url, init });
      return reply();
    }) as unknown as typeof fetch;
    return { sms: new ZadarmaSms({ key: "api-key", secret: "test-secret", sender, fetchImpl, log: (t) => logs.push(t) }), sent, logs };
  }

  it("posts the signed form to /v1/sms/send/ and reports success", async () => {
    const { sms, sent, logs } = zadarma(() => Response.json({ status: "success", messages: 1, denied_numbers: [] }), "Mishlav");
    expect(await sms.send("+972501234567", "קישור")).toEqual({ ok: true, provider: "zadarma", sent: true });
    expect(sent[0]!.url).toBe("https://api.zadarma.com/v1/sms/send/");
    const params = { format: "json", message: "קישור", number: "972501234567", sender: "Mishlav" };
    const { query, signature } = zadarmaSignature("/v1/sms/send/", params, "test-secret");
    expect(sent[0]!.init.body).toBe(query);
    expect((sent[0]!.init.headers as Record<string, string>).authorization).toBe(`api-key:${signature}`);
    expect(logs.join("\n")).not.toContain("501234567"); // masked: +97250***4567
    expect(logs.join("\n")).toContain("+97250***4567");
  });

  it("an error status, a denied number, an HTTP error or no network: not sent", async () => {
    const cases = [
      () => Response.json({ status: "error", message: "Not enough money" }),
      () => Response.json({ status: "success", denied_numbers: [{ number: "972501234567", message: "blocked" }] }),
      () => new Response("bad", { status: 500 }),
      () => {
        throw new Error("ECONNRESET");
      },
    ];
    const errors: string[] = [];
    for (const reply of cases) {
      const r = await zadarma(reply).sms.send("+972501234567", "x");
      expect(r.ok).toBe(false);
      errors.push((r as { error: string }).error);
    }
    expect(errors).toEqual(["Not enough money", "blocked", "HTTP 500", "ECONNRESET"]);
  });

  it("from the env: Zadarma with both keys, otherwise log only", () => {
    expect(smsSenderFromEnv({ ZADARMA_API_KEY: "k", ZADARMA_API_SECRET: "s" }).provider).toBe("zadarma");
    expect(smsSenderFromEnv({ ZADARMA_API_KEY: "k" }).provider).toBe("log");
    expect(smsSenderFromEnv({}).live).toBe(false);
  });
});

/** A provider that records what it would send. */
class FakeSms implements SmsSender {
  readonly provider = "fake";
  readonly live = true;
  sent: [string | null, string][] = [];
  fail = false;
  async send(to: string | null, text: string): Promise<SmsResult> {
    this.sent.push([to, text]);
    return this.fail ? { ok: false, provider: this.provider, error: "Not enough money" } : { ok: true, provider: this.provider, sent: true };
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
}

async function setup(sms: SmsSender = new FakeSms(), tweak?: (c: ReturnType<typeof testConfig>) => void) {
  const store = new FakeStore();
  const config = testConfig();
  tweak?.(config);
  const app = await buildServer(config, {
    now: () => FIXED_NOW,
    logger: false,
    env: {},
    contacts: store,
    phone: { line: new FakeLine() as never, reason: null },
    sms,
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
  return { store, sms, send, rawLog };
}

const settle = () => new Promise((r) => setTimeout(r, 50));

describe("send_purchase_link sends the SMS to the number on the call", () => {
  it("a contact's call: its phone in Supabase (normalised), the template, and no full number in the log", async () => {
    const { store, sms, send, rawLog } = await setup();
    store.numbers.set("call-1", "053-4271418");
    const r = await send("call-1");
    expect(r).toMatchObject({ ok: true, status: "sent", day_id: DAY, sms: { sent: true, provider: "fake" }, closing: true });
    expect(r.test_mode).toBeUndefined();
    const [to, text] = (sms as FakeSms).sent[0]!;
    expect(to).toBe("+972534271418");
    // settings.yaml has the temporary test text (no link: Zadarma refuses links to Israel)
    expect(text).toBe("משלב: תודה על השיחה, הפרטים יישלחו אליך בהמשך.");
    await settle();
    expect(store.tools).toEqual([["call-1", "send_purchase_link", true]]); // Gold: "נשלח קישור"
    const log = rawLog();
    expect(log).toContain('"recipient":"+97253***1418"');
    expect(log).not.toMatch(/534271418|4271418/);
  });

  it("without the temporary test text: the link template, with the day's link", async () => {
    const { store, sms, send } = await setup(new FakeSms(), (c) => {
      c.settings.sms.test_without_link = undefined;
    });
    store.numbers.set("call-1", "053-4271418");
    const r = await send("call-1");
    expect((sms as FakeSms).sent[0]![1]).toBe(`משלב: קישור לרכישת ${r.day_he}: https://example.com/mishlav/purchase/${DAY}`);
  });

  it("a scenario call (no contact): the number the line dialed", async () => {
    const { sms, send, rawLog } = await setup();
    expect(await send("call-line")).toMatchObject({ ok: true, sms: { sent: true } });
    expect((sms as FakeSms).sent[0]![0]).toBe("+972501234567");
    expect(rawLog()).not.toContain("501234567");
  });

  it("Supabase down: falls back to the number on the line", async () => {
    const { store, sms, send } = await setup();
    store.failNumber = true;
    expect(await send("call-line")).toMatchObject({ ok: true });
    expect((sms as FakeSms).sent[0]![0]).toBe("+972501234567");
  });

  it("no number for the call: no_phone, nothing sent, the bot offers a rep", async () => {
    const { sms, send } = await setup();
    for (const callId of ["unknown-call", undefined]) {
      const r = await send(callId);
      expect(r).toMatchObject({ ok: false, error: "no_phone" });
      expect(r.message_he).toContain("נציג");
    }
    expect((sms as FakeSms).sent).toEqual([]);
  });

  it("the provider fails: sms_failed (ok:false, so Gold never gets 'link sent'), the bot offers a rep", async () => {
    const sms = new FakeSms();
    sms.fail = true;
    const { store, send } = await setup(sms);
    store.numbers.set("call-1", "053-4271418");
    const r = await send("call-1");
    expect(r).toMatchObject({ ok: false, error: "sms_failed" });
    expect(r.message_he).toContain("נציג");
    expect(r.closing).toBeUndefined();
    await settle();
    expect(store.tools).toEqual([["call-1", "send_purchase_link", false]]);
  });

  it("log only (no SMS keys): nothing is sent; a test without a number (text run, browser) still goes through", async () => {
    const lines: string[] = [];
    const { store, send } = await setup(new LogOnlySms((t) => lines.push(t)));
    store.numbers.set("call-1", "053-4271418");
    expect(await send("call-1")).toMatchObject({ ok: true, sms: { sent: false, provider: "log" } });
    expect(await send()).toMatchObject({ ok: true, sms: { sent: false, provider: "log" } });
    expect(lines[0]).toContain("+97253***1418");
    expect(lines.join("\n")).not.toContain("4271418");
    expect(lines[1]).toContain("no number");
  });

  it("a day without purchase_url: no_purchase_url, nothing sent", async () => {
    const config = testConfig();
    const knowledge = loadKnowledge(config.knowledgeDir);
    knowledge.days.set(DAY, { ...knowledge.days.get(DAY)!, purchase_url: undefined });
    const sms = new FakeSms();
    const r = await toolHandlers.send_purchase_link({ day_id: DAY }, { knowledge, settings: config.settings, now: () => FIXED_NOW, sms, recipient: "+972501234567" });
    expect(r).toMatchObject({ ok: false, error: "no_purchase_url" });
    expect(r.ok === false && r.message_he).toContain("נציג");
    expect(sms.sent).toEqual([]);
  });

  it("every study day has an https purchase_url (placeholders until Mishlav sends the real ones)", () => {
    for (const d of loadKnowledge(testConfig().knowledgeDir).days.values()) expect(d.purchase_url).toMatch(/^https:\/\//);
  });
});
