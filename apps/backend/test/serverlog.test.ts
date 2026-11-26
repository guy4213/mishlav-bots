import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server";
import { type LogStore, pinoText, ServerLog, type StoredLogLine, tapConsole } from "../src/serverlog";
import { AUTH, FIXED_NOW, testConfig } from "./helpers";
import type { LinkTemplateValues, WhatsAppSender } from "../src/whatsapp";

class FakeStore implements LogStore {
  saved: StoredLogLine[] = [];
  down = false;
  pruned: Date[] = [];
  async appendLogs(lines: StoredLogLine[]) {
    if (this.down) throw new Error("supabase down");
    this.saved.push(...lines);
  }
  async logHistory({ excludeBoot, callId, limit }: { excludeBoot: string; callId?: string; limit: number }) {
    return this.saved.filter((l) => l.boot !== excludeBoot && (!callId || l.call_id === callId)).slice(-limit).reverse();
  }
  async pruneLogs(before: Date) {
    this.pruned.push(before);
  }
}

const noPhone = { line: null, reason: null };

describe("the dashboard's log, kept", () => {
  it("every line goes to the store with its boot, the phone line's too", async () => {
    const store = new FakeStore();
    const recent = [{ seq: 1, ts: "2026-11-19T10:00:00.000Z", call_id: "c1", text: "לקוח: הלו" }];
    const log = new ServerLog({ line: { recent } as never, reason: null }, undefined, undefined, store);
    log.push("tool", "🔧 get_day_info ✓", "c1");
    await log.flush();
    expect(store.saved.map((l) => [l.kind, l.text, l.boot === log.boot])).toEqual([
      ["line", "לקוח: הלו", true],
      ["tool", "🔧 get_day_info ✓", true],
    ]);
    await log.flush(); // nothing twice
    expect(store.saved).toHaveLength(2);
  });

  it("the store down: the live log goes on, the lines are saved once it is back", async () => {
    const store = new FakeStore();
    const log = new ServerLog(noPhone, undefined, undefined, store);
    store.down = true;
    log.push("dialer", "[dialer] calling");
    await log.flush();
    expect(log.since(0).lines).toHaveLength(1);
    expect(store.saved).toHaveLength(0);
    store.down = false;
    await log.flush();
    expect(store.saved.map((l) => l.text)).toEqual(["[dialer] calling"]);
  });

  it("history: the lines of earlier boots, oldest first; this boot's stay in memory", async () => {
    const store = new FakeStore();
    const before = new ServerLog(noPhone, undefined, undefined, store);
    before.push("tool", "a", "c1");
    before.push("tool", "b", "c2");
    await before.flush();
    const after = new ServerLog(noPhone, undefined, undefined, store);
    after.push("tool", "c", "c3");
    await after.flush();
    expect((await after.history()).map((l) => l.text)).toEqual(["a", "b"]);
    expect((await after.history({ callId: "c2" })).map((l) => l.text)).toEqual(["b"]);
  });

  it("old lines are deleted after 14 days", async () => {
    const store = new FakeStore();
    const now = new Date("2026-11-19T10:00:00Z");
    const log = new ServerLog(noPhone, () => now, undefined, store);
    log.start();
    await log.stop();
    expect(store.pruned[0]?.toISOString()).toBe("2026-11-05T10:00:00.000Z");
  });

  it("the server's console output is in the log (not the phone line's own lines twice)", () => {
    const log = new ServerLog(noPhone);
    const out: string[] = [];
    const con = { log: (...a: unknown[]) => out.push(a.join(" ")), info: (..._a: unknown[]) => {}, warn: (..._a: unknown[]) => {}, error: (..._a: unknown[]) => {} };
    const untap = tapConsole(log, con);
    con.log("  supabase: contacts at %s", "https://x.supabase.co");
    con.log("[phone] לקוח: הלו");
    con.error("boom");
    untap();
    con.log("after");
    expect(log.since(0).lines.map((l) => [l.kind, l.text])).toEqual([
      ["server", "supabase: contacts at https://x.supabase.co"],
      ["error", "boom"],
    ]);
    expect(out).toContain("after"); // the console still prints
  });

  it("pino calls become one line", () => {
    expect(pinoText([{ err: new Error("timeout") }, "supabase update failed"])).toBe("supabase update failed: timeout");
    expect(pinoText(["listening on %s", "8787"])).toBe("listening on 8787");
  });

  it("the server's warnings and errors reach the dashboard's log; the history route reads the store", async () => {
    const store = new FakeStore();
    store.saved.push({ boot: "old-boot", seq: 1, ts: "2026-11-18T09:00:00.000Z", kind: "line", call_id: "c0", text: "בוט: היי" });
    const app = await buildServer(testConfig(), { logger: { level: "warn" }, logStore: store });
    app.log.warn("the dialer is off");
    app.log.info("not this one");
    const live = (await app.inject({ method: "GET", url: "/api/admin/logs?since=0", headers: AUTH })).json();
    expect(live.lines.map((l: { kind: string; text: string }) => [l.kind, l.text])).toEqual([["server", "the dialer is off"]]);
    expect(live.boot).toBeTruthy();
    const hist = (await app.inject({ method: "GET", url: "/api/admin/logs/history", headers: AUTH })).json();
    expect(hist.lines.map((l: { text: string }) => l.text)).toEqual(["בוט: היי"]);
    await app.close();
  });
});

describe("test WhatsApp from the dashboard (the purchase link goes only by WhatsApp)", () => {
  const sender = (result: { ok: boolean; error?: string }, live = true) => {
    const sent: [string, LinkTemplateValues][] = [];
    const whatsapp: WhatsAppSender = {
      provider: live ? "texter" : "log",
      live,
      sendLink: async (to, values) => {
        sent.push([to, values]);
        return result.ok ? { ok: true, provider: "texter", sent: true } : { ok: false, provider: "texter", error: result.error ?? "x" };
      },
    };
    return { sent, whatsapp };
  };

  it("sends the template with the closest day that has a link, to the number in international format", async () => {
    const s = sender({ ok: true });
    const config = testConfig();
    config.settings.whatsapp.url_prefix = "https://example.com/mishlav/purchase/"; // the test days' links
    const app = await buildServer(config, { logger: false, whatsapp: s.whatsapp, now: () => FIXED_NOW });
    const r = await app.inject({ method: "POST", url: "/api/admin/whatsapp/test", headers: AUTH, payload: { number: "053-4271418" } });
    expect(r.json()).toMatchObject({ ok: true, provider: "texter" });
    expect(s.sent[0]![0]).toBe("+972534271418");
    expect(s.sent[0]![1].body).toHaveLength(3);
  });

  it("a refusal comes back with its reason; a bad number is refused; without Texter: not configured", async () => {
    const s = sender({ ok: false, error: "Recipient unsubscribed" });
    const config = testConfig();
    config.settings.whatsapp.url_prefix = "https://example.com/mishlav/purchase/";
    const app = await buildServer(config, { logger: false, whatsapp: s.whatsapp, now: () => FIXED_NOW });
    const r = await app.inject({ method: "POST", url: "/api/admin/whatsapp/test", headers: AUTH, payload: { number: "053-4271418" } });
    expect(r.statusCode).toBe(502);
    expect(r.json().message_he).toBe("Recipient unsubscribed");
    const bad = await app.inject({ method: "POST", url: "/api/admin/whatsapp/test", headers: AUTH, payload: { number: "abc" } });
    expect(bad.statusCode).toBe(400);
    const off = await buildServer(config, { logger: false, whatsapp: sender({ ok: true }, false).whatsapp });
    expect((await off.inject({ method: "POST", url: "/api/admin/whatsapp/test", headers: AUTH, payload: { number: "053-4271418" } })).statusCode).toBe(409);
  });
});
