import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readJsonl } from "../src/jsonl";
import { AUTH, SECRET, testServer } from "./helpers";

type App = Awaited<ReturnType<typeof testServer>>["app"];
let app: App | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function setup() {
  const s = await testServer();
  app = s.app;
  const toolLog = () => readJsonl(join(s.config.logDir, "tool-calls.jsonl")) as Record<string, any>[];
  const post = (url: string, payload?: unknown, headers: Record<string, string> = AUTH) =>
    s.app.inject({ method: "POST", url, payload: payload as any, headers });
  return { ...s, toolLog, post };
}

describe("auth", () => {
  it("serves /healthz without a secret", async () => {
    const { app } = await setup();
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, days: 3 });
  });

  it("rejects tools without / with a wrong secret and logs the failure", async () => {
    const { post, toolLog } = await setup();
    expect((await post("/tools/end_call", {}, {})).statusCode).toBe(401);
    expect((await post("/tools/end_call", {}, { "x-tools-secret": "nope" })).statusCode).toBe(401);
    expect((await post("/test/session", { provider: "A", scenario: "S1" }, {})).statusCode).toBe(401);
    const failures = toolLog().filter((l) => l.type === "auth_failure");
    expect(failures).toHaveLength(3);
    expect(JSON.stringify(failures)).not.toContain("nope");
  });

  it("accepts Authorization: Bearer", async () => {
    const { post } = await setup();
    const res = await post("/tools/end_call", {}, { authorization: `Bearer ${SECRET}` });
    expect(res.statusCode).toBe(200);
  });
});

describe("tools", () => {
  it("get_day_info returns knowledge, unknown day is an ok:false error", async () => {
    const { post } = await setup();
    const ok = (await post("/tools/get_day_info", { day_id: "payroll-2026-12-22-hotel" })).json();
    expect(ok).toMatchObject({ ok: true, day: { price_ils: 790, format: "hotel", vat_included: true } });
    expect(ok.general).toContain("50%");
    const bad = (await post("/tools/get_day_info", { day_id: "eilat-intl-tax" })).json();
    expect(bad).toMatchObject({ ok: false, error: "unknown_day_id" });
    expect(bad.available_day_ids).toContain("payroll-2026-12-08-zoom");
  });

  it("send_purchase_link refuses extra fields (link to another number)", async () => {
    const { post, toolLog } = await setup();
    const res = (await post("/tools/send_purchase_link", { day_id: "payroll-2026-12-08-zoom", phone: "0501111111" })).json();
    expect(res).toMatchObject({ ok: false, error: "invalid_params" });
    const ok = (await post("/tools/send_purchase_link", { day_id: "payroll-2026-12-08-zoom" })).json();
    expect(ok).toMatchObject({ ok: true, status: "sent", test_mode: true });
    expect(toolLog().map((l) => [l.tool, l.ok])).toEqual([
      ["send_purchase_link", false],
      ["send_purchase_link", true],
    ]);
  });

  it("schedule_callback accepts or proposes an alternative", async () => {
    const { post } = await setup();
    const ok = (await post("/tools/schedule_callback", { requested_time: "2026-11-10T10:00:00" })).json();
    expect(ok).toMatchObject({ ok: true, status: "accepted", scheduled_time: "2026-11-10T10:00:00+02:00" });
    expect(ok.scheduled_time_he).toContain("10:00");
    const alt = (await post("/tools/schedule_callback", { requested_time: "2026-11-13T10:00:00" })).json();
    expect(alt).toMatchObject({ ok: true, status: "alternative", reason: "non_working_day", scheduled_time: "2026-11-15T09:00:00+02:00" });
    const bad = (await post("/tools/schedule_callback", { requested_time: "יום שלישי בעשר" })).json();
    expect(bad).toMatchObject({ ok: false });
  });

  it("request_human returns the fixed answer", async () => {
    const { post } = await setup();
    const res = (await post("/tools/request_human", { reason: "discount_request" })).json();
    expect(res).toEqual({ ok: true, status: "handed_to_rep", message_he: "הועבר לנציג" });
  });

  it("end_call works with an empty JSON body", async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: "POST",
      url: "/tools/end_call",
      headers: { ...AUTH, "content-type": "application/json" },
      payload: "",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, status: "ending" });
  });

  it("malformed JSON is a 400", async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: "POST",
      url: "/tools/end_call",
      headers: { ...AUTH, "content-type": "application/json" },
      payload: "{nope",
    });
    expect(res.statusCode).toBe(400);
  });

  it("redacts card numbers before logging", async () => {
    const { post, toolLog } = await setup();
    await post("/tools/request_human", { reason: "other", name: "כרטיס 4580 1234 5678 9012", phone: "0527384915" });
    const entry = toolLog().at(-1)!;
    expect(entry.redactions).toBe(1);
    expect(JSON.stringify(entry)).not.toContain("4580 1234");
    expect(entry.params.phone).toBe("0527384915");
  });
});

describe("test sessions", () => {
  it("tags tool calls with the active session, call id and provider", async () => {
    const { post, toolLog, app } = await setup();
    const start = (await post("/test/session", { provider: "B", scenario: "S5", actor: "female" })).json();
    expect(start.session.session_id).toBe("B-S5-20261108-080000");
    await post("/tools/end_call", { reason: "do_not_call" }, { ...AUTH, "x-call-id": "room-42" });
    await post("/test/metrics", { turns: [{ latency_ms: 900, provider_ms: 400 }] });
    const calls = (await app.inject({ method: "GET", url: "/test/calls", headers: AUTH })).json();
    expect(calls.count).toBe(1);
    await post("/test/session/end");
    await post("/tools/end_call", {});

    const [inSession, outside] = toolLog();
    expect(inSession).toMatchObject({ session_id: "B-S5-20261108-080000", scenario: "S5", provider: "B", call_id: "room-42" });
    expect(outside).toMatchObject({ session_id: null, provider: null });
  });

  it("rejects an invalid session body", async () => {
    const { post } = await setup();
    expect((await post("/test/session", { provider: "Z", scenario: "S1" })).statusCode).toBe(400);
  });
});
