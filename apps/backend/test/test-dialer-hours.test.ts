import { join } from "node:path";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { JsonlFile } from "../src/jsonl";
import { loadKnowledge } from "../src/knowledge";
import { registerToolRoutes } from "../src/routes/tools";
import { SessionStore } from "../src/sessions";
import { LogOnlyWhatsApp } from "../src/whatsapp";
import { testConfig } from "./helpers";

// Thursday 2026-11-26 17:30 Israel (15:30 UTC): after business hours (09:00-17:00)
const EVENING = new Date("2026-11-26T15:30:00Z");

async function app(anyHourCall: (id: string | null) => boolean) {
  const config = testConfig();
  const a = Fastify({ logger: false });
  const toolLog = new JsonlFile(join(config.logDir, "tool-calls.jsonl"));
  await registerToolRoutes(a, {
    knowledge: loadKnowledge(config.knowledgeDir, config.offlineDaysDir),
    settings: config.settings,
    now: () => EVENING,
    toolLog,
    sessions: new SessionStore(new JsonlFile(join(config.logDir, "sessions.jsonl")), () => EVENING),
    whatsapp: new LogOnlyWhatsApp(() => {}),
    anyHourCall,
  });
  return (callId: string, body: object) =>
    a.inject({ method: "POST", url: "/tools/schedule_callback", headers: { "x-call-id": callId }, payload: body }).then((r) => r.json());
}

describe("the automatic-dialing test at 17:30 (Guy, 26.11: 'in 10 minutes' was refused as outside business hours)", () => {
  it("a test call: 'in 10 minutes' is booked at any hour", async () => {
    const post = await app((id) => id === "test-call");
    expect(await post("test-call", { in_minutes: 10 })).toMatchObject({ ok: true, status: "accepted", scheduled_time: "2026-11-26T17:40:00+02:00" });
  });

  it("a real call at the same hour: still the next business day (nothing changes for customers)", async () => {
    const post = await app((id) => id === "test-call");
    const r = await post("real-call", { in_minutes: 10 });
    expect(r).toMatchObject({ ok: true, status: "alternative" });
  });
});
