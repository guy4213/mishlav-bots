import { join } from "node:path";
import { findRepoRoot } from "@mishlav/shared";
import { describe, expect, it } from "vitest";
import { loadKnowledge } from "../src/knowledge";
import { toolHandlers, type ToolContext } from "../src/tools/handlers";
import { type LinkTemplateValues, linkTemplateValues, TexterWhatsApp, type WhatsAppSender, whatsappSenderFromEnv } from "../src/whatsapp";
import { testConfig } from "./helpers";

const root = findRepoRoot(__dirname);
const kb = loadKnowledge(join(root, "config", "knowledge"), join(root, "tests", "fixtures", "days"));
const PREFIX = "https://example.com/mishlav/purchase/";
const zoom = kb.days.get("2027-02-21-zoom")!;
const hotel = kb.days.get("2027-05-17-hotel")!;

describe("the WhatsApp template's values", () => {
  it("{{1}} first name, {{2}} the topic, {{3}} dates · Zoom/place · hours · price; the button gets the end of the link", () => {
    expect(linkTemplateValues(zoom, "גיא", PREFIX)).toEqual({
      body: ["גיא", "דיני עבודה ומס הכנסה", `21–22.2.2027 · בזום · ${zoom.start}–${zoom.end} בכל מפגש · 370 ₪ כולל מע"מ`],
      buttonPayload: "2027-02-21-zoom",
    });
    const h = linkTemplateValues(hotel, null, PREFIX)!;
    expect(h.body[0]).toBe("שלום"); // no name: "היי שלום, תודה על השיחה!"
    expect(h.body[2]).toBe(`17.5.2027 · מלון דן פנורמה, תל אביב · ${hotel.start}–${hotel.end} · 790 ₪ כולל מע"מ`);
    expect(linkTemplateValues(zoom, "x", "https://other.example/")).toBeNull(); // the button's prefix must match
  });

  it("no line breaks or tabs in a value (WhatsApp refuses them)", () => {
    expect(linkTemplateValues({ ...zoom, title: "שורה\nשנייה\tו  רווחים" }, "גיא", PREFIX)!.body[1]).toBe("שורה שנייה ו רווחים");
  });
});

describe("Texter", () => {
  const values: LinkTemplateValues = { body: ["גיא", "דיני עבודה", "21–22.2.2027"], buttonPayload: "slug-2021-07-26/" };

  it("sends the approved template: name, language, body values, the URL button's payload, bearer token", async () => {
    const sent: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      sent.push({ url, init });
      return new Response(JSON.stringify({ success: true, messageId: "m1", text: "..." }));
    }) as unknown as typeof fetch;
    const t = new TexterWhatsApp({ project: "mishlav", token: "tok", template: "mishlav_purchase_link", language: "he", fetchImpl, log: () => {} });
    expect(await t.sendLink("+972534271418", values)).toEqual({ ok: true, provider: "texter", sent: true });
    expect(sent[0]!.url).toBe("https://mishlav.texterchat.com/server/api/v2/whatsapp/templates/send");
    expect((sent[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(JSON.parse(sent[0]!.init.body as string)).toEqual({
      templateName: "mishlav_purchase_link",
      to: "+972534271418",
      language: "he",
      body: ["גיא", "דיני עבודה", "21–22.2.2027"],
      buttons: [{ type: "url", payload: "slug-2021-07-26/" }],
    });
  });

  it("HTTP 200 with success:false (e.g. unsubscribed) is a failure; so is an HTTP error", async () => {
    const reply = (r: Response) => (async () => r) as unknown as typeof fetch;
    const opts = { project: "p", token: "t", template: "x", language: "he", log: () => {} };
    const skipped = new TexterWhatsApp({ ...opts, fetchImpl: reply(new Response(JSON.stringify({ success: false, error: "Recipient unsubscribed" }))) });
    expect(await skipped.sendLink("+972501234567", values)).toEqual({ ok: false, provider: "texter", error: "Recipient unsubscribed" });
    const bad = new TexterWhatsApp({ ...opts, fetchImpl: reply(new Response(JSON.stringify({ error: 'Template "x" not found' }), { status: 400 })) });
    expect(await bad.sendLink("+972501234567", values)).toMatchObject({ ok: false, error: 'Template "x" not found' });
  });

  it("from the environment: project + token (a full address is fine); otherwise log only - never an SMS", () => {
    const tpl = { template: "mishlav_purchase_link", language: "he" };
    expect(whatsappSenderFromEnv({}, tpl).live).toBe(false); // log only: nothing is sent
    expect(whatsappSenderFromEnv({ TEXTER_PROJECT: "mishlav" }, tpl).live).toBe(false);
    const t = whatsappSenderFromEnv({ TEXTER_PROJECT: "https://mishlav.texterchat.com/", TEXTER_API_TOKEN: "t" }, tpl) as TexterWhatsApp;
    expect(t.url).toBe("https://mishlav.texterchat.com/server/api/v2/whatsapp/templates/send");
  });
});

describe("send_purchase_link on WhatsApp", () => {
  class FakeWa implements WhatsAppSender {
    readonly provider = "fake-wa";
    readonly live = true;
    sent: [string, LinkTemplateValues][] = [];
    fail = false;
    async sendLink(to: string, v: LinkTemplateValues) {
      this.sent.push([to, v]);
      return this.fail ? { ok: false as const, provider: this.provider, error: "down" } : { ok: true as const, provider: this.provider, sent: true };
    }
  }
  const ctx = (wa: FakeWa, extra: Partial<ToolContext> = {}): ToolContext => {
    const settings = testConfig().settings;
    settings.whatsapp = { template: "mishlav_purchase_link", language: "he", url_prefix: PREFIX };
    return { knowledge: kb, settings, now: () => new Date("2026-11-26T10:00:00Z"), whatsapp: wa, recipient: "+972534271418", recipientName: "גיא", ...extra };
  };

  it("sends the template with the day's details and link, and the bot says it went on WhatsApp", async () => {
    const wa = new FakeWa();
    const r = await toolHandlers.send_purchase_link({ day_id: "2027-02-21-zoom" }, ctx(wa));
    expect(r).toMatchObject({ ok: true, status: "sent", whatsapp: { provider: "fake-wa" }, say_he: "הקישור נשלח עכשיו בוואטסאפ. יום נעים, להתראות." });
    expect(wa.sent[0]![0]).toBe("+972534271418");
    expect(wa.sent[0]![1]).toMatchObject({ body: ["גיא", "דיני עבודה ומס הכנסה", expect.stringContaining("בזום")], buttonPayload: "2027-02-21-zoom" });
  });

  it("no number, a failure, or a link the button can't take: not sent, and the bot offers a rep", async () => {
    const wa = new FakeWa();
    expect(await toolHandlers.send_purchase_link({ day_id: "2027-02-21-zoom" }, ctx(wa, { recipient: null }))).toMatchObject({ ok: false, error: "no_phone" });
    wa.fail = true;
    expect(await toolHandlers.send_purchase_link({ day_id: "2027-02-21-zoom" }, ctx(wa))).toMatchObject({ ok: false, error: "whatsapp_failed" });
    const other = ctx(new FakeWa());
    other.settings.whatsapp!.url_prefix = "https://other.example/";
    expect(await toolHandlers.send_purchase_link({ day_id: "2027-02-21-zoom" }, other)).toMatchObject({ ok: false, error: "link_not_in_template" });
  });
});
