import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server";
import { AUTH, FIXED_NOW, testConfig } from "./helpers";

const LIVEKIT_ENV = {
  LIVEKIT_URL: "wss://example.livekit.cloud",
  LIVEKIT_API_KEY: "APIkey123",
  LIVEKIT_API_SECRET: "secret-secret-secret-secret-secret-secret",
  GOOGLE_API_KEY: "g-key",
};

async function server(env: NodeJS.ProcessEnv = {}) {
  const config = testConfig();
  const manualInputsPath = join(mkdtempSync(join(tmpdir(), "mishlav-manual-")), "manual-inputs.yaml");
  const app = await buildServer(config, { now: () => FIXED_NOW, logger: false, env, manualInputsPath });
  return { app, config, manualInputsPath };
}

describe("dashboard", () => {
  it("serves the page and the LiveKit client without a secret, but no data", async () => {
    const { app } = await server();
    const page = await app.inject({ method: "GET", url: "/dashboard" });
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");
    expect(page.body).toContain('dir="rtl"');
    expect(page.body).not.toContain("test-secret");
    const js = await app.inject({ method: "GET", url: "/dashboard/livekit-client.js" });
    expect(js.statusCode).toBe(200);
    expect(js.body).toContain("LivekitClient");
    for (const url of ["/test/overview", "/test/report", "/dashboard/../test/overview"]) {
      expect((await app.inject({ method: "GET", url })).statusCode, url).toBe(401);
    }
  });

  it("overview lists scenarios with Hebrew guides and reports what is missing", async () => {
    const { app } = await server({});
    const r = await app.inject({ method: "GET", url: "/test/overview", headers: AUTH });
    const body = r.json();
    expect(body.scenarios.filter((s: { core: boolean }) => s.core).map((s: { id: string }) => s.id)).toEqual(["S1", "S2", "S3", "S4", "S5", "S6"]);
    for (const s of body.scenarios) {
      expect(s.guide?.title, s.id).toBeTruthy();
      expect(s.guide.watch.length, `${s.id}: one Hebrew watch item per manual check`).toBe(s.manual_checks.length);
    }
    const c = body.providers.find((p: { code: string }) => p.code === "C");
    expect(c.ready).toBe(false);
    expect(c.note).toContain("LIVEKIT");
    expect(body.config).toMatchObject({ livekit: false, gemini: false, agentName: "mishlav-c" });

    const ready = await (await server(LIVEKIT_ENV)).app.inject({ method: "GET", url: "/test/overview", headers: AUTH });
    expect(ready.json().providers.find((p: { code: string }) => p.code === "C").ready).toBe(true);
  });

  it("issues a LiveKit token that dispatches the voice worker, only when configured", async () => {
    const off = await (await server({})).app.inject({ method: "POST", url: "/test/livekit/token", headers: AUTH, payload: { provider: "C" } });
    expect(off.statusCode).toBe(400);
    expect(off.json().error).toBe("livekit_not_configured");

    const { app } = await server({ ...LIVEKIT_ENV, AGENT_NAME: "mishlav-c" });
    const r = await app.inject({ method: "POST", url: "/test/livekit/token", headers: AUTH, payload: { provider: "C", scenario: "S1" } });
    expect(r.statusCode).toBe(200);
    const { url, token, room } = r.json();
    expect(url).toBe(LIVEKIT_ENV.LIVEKIT_URL);
    expect(room).toMatch(/^web-C-S1-\d{14}$/);
    const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    expect(claims.iss).toBe(LIVEKIT_ENV.LIVEKIT_API_KEY);
    expect(claims.video).toMatchObject({ room, roomJoin: true, canPublish: true });
    expect(JSON.stringify(claims.roomConfig)).toContain("mishlav-c");
  });

  it("saves manual answers into the manual-inputs file and the report picks them up", async () => {
    const { app, manualInputsPath } = await server();
    const start = await app.inject({ method: "POST", url: "/test/session", headers: AUTH, payload: { provider: "C", scenario: "S5", notes: "browser" } });
    const sid = start.json().session.session_id;
    await app.inject({ method: "POST", url: "/tools/end_call", headers: { ...AUTH, "x-provider": "C" }, payload: { reason: "do_not_call" } });
    await app.inject({ method: "POST", url: "/test/session/end", headers: AUTH });

    const save = await app.inject({ method: "POST", url: "/test/manual/session", headers: AUTH, payload: { session_id: sid, language_switch: false, notes: "ok" } });
    expect(save.statusCode).toBe(200);
    await app.inject({ method: "POST", url: "/test/manual/provider", headers: AUTH, payload: { provider: "C", cost_per_min_usd: 0.05 } });
    await app.inject({ method: "POST", url: "/test/manual/voice", headers: AUTH, payload: { map: { Z: "C" }, scores: { Z: [4, 5, 4] } } });

    const file = parseYaml(readFileSync(manualInputsPath, "utf8"));
    expect(file.sessions[sid]).toEqual({ language_switch: false, notes: "ok" });
    expect(file.providers.C.cost_per_min_usd).toBe(0.05);
    expect(file.blind_voice.scores.Z).toEqual([4, 5, 4]);

    const rep = (await app.inject({ method: "GET", url: "/test/report", headers: AUTH })).json();
    const run = rep.sessions.find((s: { session_id: string }) => s.session_id === sid);
    expect(run).toMatchObject({ scenario: "S5", inferred: "DO_NOT_CALL", understanding: "PASS", language_switch: false, channel: "browser" });
    const c = rep.providers.find((p: { provider: string }) => p.provider === "C");
    expect(c.cost_per_min).toBe(0.05);
    expect(c.criteria.voice).toBe("PASS");

    const bad = await app.inject({ method: "POST", url: "/test/manual/session", headers: AUTH, payload: { session_id: sid, language_switch: "maybe" } });
    expect(bad.statusCode).toBe(400);
  });

  it("returns the voice worker transcript for a call", async () => {
    const { app, config } = await server();
    const dir = join(config.logDir, "transcripts");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "web-C-S1-20261108100000.jsonl"), JSON.stringify({ ts: "t", role: "assistant", text: "שלום דנה" }) + "\n");
    const r = await app.inject({ method: "GET", url: "/test/transcript?call_id=web-C-S1-20261108100000", headers: AUTH });
    expect(r.json().lines).toEqual([{ ts: "t", role: "assistant", text: "שלום דנה" }]);
    const latest = await app.inject({ method: "GET", url: "/test/transcript?since=2000-01-01T00:00:00Z", headers: AUTH });
    expect(latest.json().call_id).toBe("web-C-S1-20261108100000");
    const evil = await app.inject({ method: "GET", url: "/test/transcript?call_id=../../.env", headers: AUTH });
    expect(evil.json().error).toBe("invalid_call_id");
  });
});
