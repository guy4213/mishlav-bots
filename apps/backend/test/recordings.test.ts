import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS module (apps/phone is not type-checked)
import { mixToMono } from "../../phone/src/audio.js";
import { phoneEnv } from "../../phone/src/line.js";
import { SupabaseContacts } from "../src/contacts";
import { buildServer } from "../src/server";
import { AUTH, testConfig } from "./helpers";

describe("call recordings", () => {
  it("the line records every call unless PHONE_RECORD=0", () => {
    expect(phoneEnv({}, "/x").record).toBe(true);
    expect(phoneEnv({ PHONE_RECORD: "0" }, "/x").record).toBe(false);
  });

  it("stereo (caller | bot) becomes one channel with both voices", () => {
    const m = mixToMono({ samples: new Int16Array([100, 0, 0, 200, 30000, 30000]), rate: 8000, channels: 2 });
    expect([...m.samples]).toEqual([100, 200, 32767]);
    expect(m.channels).toBe(1);
  });

  it("Storage: upload to the private bucket, link the call, then an hour-long signed link to play it", async () => {
    const sent: { url: string; method: string; body?: unknown }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      sent.push({ url, method: init.method!, body: init.body });
      if (url.includes("/object/sign/")) return new Response(JSON.stringify({ signedURL: "/object/sign/recordings/call-1.wav?token=t" }));
      if (url.includes("select=recording_path")) return new Response(JSON.stringify([{ recording_path: "call-1.wav" }]));
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    const s = new SupabaseContacts("https://x.supabase.co", "service-key", fetchImpl);
    const file = join(mkdtempSync(join(tmpdir(), "rec-")), "call-1.wav");
    writeFileSync(file, Buffer.from("RIFF"));
    await s.saveRecording("call-1", file);
    expect(sent[0]).toMatchObject({ url: "https://x.supabase.co/storage/v1/object/recordings/call-1.wav", method: "POST" });
    expect(sent[1]).toMatchObject({ url: "https://x.supabase.co/rest/v1/calls?call_id=eq.call-1", method: "PATCH", body: JSON.stringify({ recording_path: "call-1.wav" }) });
    expect(await s.recordingUrl("call-1")).toBe("https://x.supabase.co/storage/v1/object/sign/recordings/call-1.wav?token=t");
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
