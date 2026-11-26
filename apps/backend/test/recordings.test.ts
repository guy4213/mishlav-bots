import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS module (apps/phone is not type-checked)
import { mixToMono, mp3, wav } from "../../phone/src/audio.js";
import { phoneEnv } from "../../phone/src/line.js";
import { SupabaseContacts } from "../src/contacts";
import { buildServer } from "../src/server";
import { AUTH, testConfig } from "./helpers";

describe("call recordings", () => {
  it("the line records every call unless PHONE_RECORD=0", () => {
    expect(phoneEnv({}, "/x").record).toBe(true);
    expect(phoneEnv({ PHONE_RECORD: "0" }, "/x").record).toBe(false);
    expect(phoneEnv({}, "/x").denoise).toBe(true); // the noise filter is on unless PHONE_DENOISE=0
    expect(phoneEnv({ PHONE_DENOISE: "0" }, "/x").denoise).toBe(false);
  });

  it("stereo (caller | bot) becomes one channel with both voices", () => {
    const m = mixToMono({ samples: new Int16Array([100, 0, 0, 200, 30000, 30000]), rate: 8000, channels: 2 });
    expect([...m.samples]).toEqual([100, 200, 32767]);
    expect(m.channels).toBe(1);
  });

  it("recordings are MP3: a 2-minute call is ~8x smaller than the WAV", () => {
    const rate = 8000;
    const samples = new Int16Array(rate * 120);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.round(8000 * Math.sin((2 * Math.PI * 300 * i) / rate));
    const m: Buffer = mp3({ samples, rate });
    const w: Buffer = wav({ samples, rate, channels: 1 });
    expect(m[0]).toBe(0xff); // an MP3 frame header
    expect(m.length).toBeLessThan(w.length / 6);
    expect(m.length).toBeGreaterThan(150_000); // 16 kbps x 120 s = 240 KB: the whole call is there
  });

  it("Storage: upload to the private bucket, link the call, then an hour-long signed link to play it", async () => {
    const sent: { url: string; method: string; body?: unknown; type?: string }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      sent.push({ url, method: init.method!, body: init.body, type: (init.headers as Record<string, string>)?.["content-type"] });
      if (url.includes("/object/sign/")) return new Response(JSON.stringify({ signedURL: "/object/sign/recordings/call-1.mp3?token=t" }));
      if (url.includes("select=recording_path")) return new Response(JSON.stringify([{ recording_path: "call-1.mp3" }]));
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    const s = new SupabaseContacts("https://x.supabase.co", "service-key", fetchImpl);
    const file = join(mkdtempSync(join(tmpdir(), "rec-")), "call-1.mp3");
    writeFileSync(file, Buffer.from([0xff, 0xf3]));
    await s.saveRecording("call-1", file);
    expect(sent[0]).toMatchObject({ url: "https://x.supabase.co/storage/v1/object/recordings/call-1.mp3", method: "POST", type: "audio/mpeg" });
    expect(sent[1]).toMatchObject({ url: "https://x.supabase.co/rest/v1/calls?call_id=eq.call-1", method: "PATCH", body: JSON.stringify({ recording_path: "call-1.mp3" }) });
    expect(await s.recordingUrl("call-1")).toBe("https://x.supabase.co/storage/v1/object/sign/recordings/call-1.mp3?token=t");
  });

  it("a test call without a contact is a calls row of its own; the list brings each call's number and name", async () => {
    const sent: { url: string; method: string; body?: unknown }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      sent.push({ url, method: init.method!, body: init.body });
      if (init.method === "GET") return new Response(JSON.stringify([{ call_id: "call-1", gold_record_id: null, number: "+972534271418", contact_name: "גיא", contacts: null }]));
      return new Response("", { status: 201 });
    }) as unknown as typeof fetch;
    const s = new SupabaseContacts("https://x.supabase.co", "service-key", fetchImpl);
    await s.testCallStarted("call-1", { number: "+972534271418", direction: "out", contact_name: "גיא", scenario: null });
    expect(sent[0]).toMatchObject({ url: "https://x.supabase.co/rest/v1/calls", method: "POST" });
    expect(JSON.parse(String(sent[0]!.body))).toEqual({ call_id: "call-1", origin: "manual", number: "+972534271418", direction: "out", contact_name: "גיא", scenario: null });
    await s.saveCallInfo("call-1", { duration_sec: 42, answered: true });
    expect(sent[1]).toMatchObject({ url: "https://x.supabase.co/rest/v1/calls?call_id=eq.call-1", method: "PATCH", body: JSON.stringify({ duration_sec: 42, answered: true }) });
    const [row] = (await s.calls({ origin: null, recorded: true, page: 2, size: 50 })).calls;
    expect(decodeURIComponent(sent[2]!.url)).toContain("recording_path,number,contact_name,direction,scenario,contacts(full_name)");
    expect(sent[2]!.url).toContain("&recording_path=not.is.null&order=started_at.desc&limit=50&offset=50");
    expect(row).toMatchObject({ call_id: "call-1", gold_record_id: null, number: "+972534271418", contact_name: "גיא", full_name: null });
  });

  it("kept for good by default (retention_days 0); a number deletes older ones", async () => {
    const calls: Date[] = [];
    const admin = { pruneRecordings: async (before: Date) => (calls.push(before), 0) };
    const keep = await buildServer(testConfig(), { logger: false, admin: admin as never });
    await keep.ready();
    expect(calls).toEqual([]);
    await keep.close();
    const config = testConfig();
    config.settings.recordings.retention_days = 30;
    const prune = await buildServer(config, { logger: false, admin: admin as never });
    await prune.ready();
    expect(calls).toHaveLength(1);
    await prune.close();
  });

  it("the dashboard route: the link, or 404 when the call wasn't recorded", async () => {
    const admin = { recordingUrl: async (id: string) => (id === "call-1" ? "https://x/signed" : null) };
    const app = await buildServer(testConfig(), { logger: false, admin: admin as never });
    const ok = await app.inject({ method: "GET", url: "/api/admin/calls/call-1/recording", headers: AUTH });
    expect(ok.json()).toEqual({ ok: true, url: "https://x/signed" });
    const none = await app.inject({ method: "GET", url: "/api/admin/calls/call-2/recording", headers: AUTH });
    expect(none.statusCode).toBe(404);
  });
});

describe("the dialer's queue in Supabase", () => {
  it("only the requested courses: the list goes to bot_next_due and filters the next scheduled one", async () => {
    const sent: { url: string; body?: unknown }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      sent.push({ url, body: init.body });
      return new Response(JSON.stringify([{ gold_record_id: "a", bot_status: "new", next_call_at: null, contacts: { requested_course: "x" } }]));
    }) as unknown as typeof fetch;
    const s = new SupabaseContacts("https://x.supabase.co", "k", fetchImpl);
    await s.nextDue(new Date("2026-11-23T10:00:00Z"), [], ["יום עיון חשבונאות"]);
    expect(JSON.parse(sent[0]!.body as string)).toMatchObject({ p_courses: ["יום עיון חשבונאות"] });
    await s.nextDue(new Date("2026-11-23T10:00:00Z"), []);
    expect(JSON.parse(sent[1]!.body as string)).toMatchObject({ p_courses: null });
    const next = await s.nextScheduled(new Date("2026-11-23T10:00:00Z"), ["יום עיון חשבונאות"]);
    expect(decodeURIComponent(sent[2]!.url)).toContain('contacts!inner(requested_course)&contacts.requested_course=in.("יום עיון חשבונאות")');
    expect(next).toEqual({ gold_record_id: "a", bot_status: "new", next_call_at: null });
  });
});
