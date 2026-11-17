import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readJsonl } from "../src/jsonl";
import { GOODBYE, SAY_END_CALL, SAY_HANDED_TO_REP, SAY_LINK_SENT, timeHe } from "../src/tools/closings";
import { CLOSE_NEXT, END_CALL_SAY_GOODBYE } from "../src/tools/handlers";
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
    // no SMS keys in tests: log only (nothing is sent); the recipient never comes from the bot
    expect(ok).toMatchObject({ ok: true, status: "sent", sms: { sent: false, provider: "log" } });
    expect(ok.test_mode).toBeUndefined();
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

  it("schedule_callback 'in N minutes' uses the server clock, not the model's (R5: the model was 2h off)", async () => {
    const { post } = await setup(); // FIXED_NOW = Sunday 2026-11-08 10:00 Israel
    const r = (await post("/tools/schedule_callback", { in_minutes: 10 })).json();
    expect(r).toMatchObject({ ok: true, status: "accepted", scheduled_time: "2026-11-08T10:10:00+02:00" });
    expect(r.say_he).toBe(`בסדר גמור, נדבר היום בעשר ועשרה בבוקר. ${GOODBYE}`);
    // too soon: said as such, never as "outside business hours"
    const soon = (await post("/tools/schedule_callback", { in_minutes: 2 })).json();
    expect(soon).toMatchObject({ status: "alternative", reason: "too_soon" });
    expect(soon.message_he).toContain("קרוב מדי");
    expect(soon.message_he).not.toContain("שעות הפעילות");
    const both = await post("/tools/schedule_callback", { in_minutes: 10, requested_time: "2026-11-10T10:00:00" });
    expect(both.json()).toMatchObject({ ok: false }); // exactly one of the two
    const none = await post("/tools/schedule_callback", {});
    expect(none.json()).toMatchObject({ ok: false });
  });

  it("times are said in words, minutes kept (the bot said '15:00' for 'three ten')", async () => {
    const { post } = await setup(); // Sunday 2026-11-08 10:00
    const r = (await post("/tools/request_human", { reason: "wants_human", requested_time: "2026-11-08T15:10:00" })).json();
    expect(r.say_he).toBe(`העברתי את הבקשה, נציג יחזור היום בשלוש ועשרה בצהריים. ${GOODBYE}`);
    expect(timeHe(9, 45)).toBe("רבע לעשר בבוקר");
    expect(timeHe(12, 23)).toBe("שתים עשרה ועשרים ושלוש בצהריים");
    expect(timeHe(16, 15)).toBe("ארבע ורבע אחר הצהריים");
  });

  it("request_human returns the fixed answer", async () => {
    const { post } = await setup();
    // no time yet: not noted, no goodbye - the bot asked "when?" and hung up in the same breath (real call)
    const early = (await post("/tools/request_human", { reason: "wants_human" })).json();
    expect(early).toMatchObject({ ok: true, status: "waiting_for_time" });
    expect(early.closing).toBeUndefined();
    expect(early.say_he).toBeUndefined();
    const res = (await post("/tools/request_human", { reason: "discount_request", asap: true })).json();
    expect(res).toMatchObject({ ok: true, status: "handed_to_rep" });
    expect(res).toMatchObject({ closing: true, say_he: SAY_HANDED_TO_REP }); // fixed sentence, no number asked
    // at the time the customer chose (FIXED_NOW = Sunday 2026-11-08 10:00)
    const at = (await post("/tools/request_human", { reason: "wants_human", requested_time: "2026-11-09T10:00:00" })).json();
    expect(at).toMatchObject({ closing: true, scheduled_time: "2026-11-09T10:00:00+02:00" });
    expect(at.say_he).toBe(`העברתי את הבקשה, נציג יחזור מחר בעשר בבוקר. ${GOODBYE}`);
    const soon = (await post("/tools/request_human", { reason: "wants_human", in_minutes: 30 })).json();
    expect(soon.say_he).toBe(`העברתי את הבקשה, נציג יחזור היום בעשר וחצי בבוקר. ${GOODBYE}`);
    // Friday: an alternative to propose first, not a goodbye
    const fri = (await post("/tools/request_human", { reason: "wants_human", requested_time: "2026-11-13T10:00:00" })).json();
    expect(fri).toMatchObject({ status: "alternative", reason: "non_working_day" });
    expect(fri.closing).toBeUndefined();
    const both = (await post("/tools/request_human", { reason: "wants_human", in_minutes: 5, requested_time: "2026-11-09T10:00:00" })).json();
    expect(both).toMatchObject({ ok: false });
    const asapToo = (await post("/tools/request_human", { reason: "wants_human", in_minutes: 5, asap: true })).json();
    expect(asapToo).toMatchObject({ ok: false });
    // an unanswered question goes to a rep, but the call goes on (it once ended S1 before the link)
    const other = (await post("/tools/request_human", { reason: "other" })).json();
    expect(other).toMatchObject({ ok: true, status: "handed_to_rep" });
    expect(other.message_he).toContain("להמשיך בשיחה");
    expect(other.closing).toBeUndefined();
    expect(other.say_he).toBeUndefined();
    expect(other.message_he).not.toContain("end_call");
  });

  it("actions that close the call say the next step is end_call (R1, R3, X7: goodbye, then an open line)", async () => {
    const { post } = await setup();
    const closing = [
      await post("/tools/send_purchase_link", { day_id: "payroll-2026-12-08-zoom" }),
      await post("/tools/request_human", { reason: "company_purchase", asap: true }),
      await post("/tools/schedule_callback", { requested_time: "2026-11-10T10:00:00" }),
    ];
    for (const res of closing) expect(res.json()).toMatchObject({ closing: true, message_he: CLOSE_NEXT });
    expect(closing[0]!.json().say_he).toBe(SAY_LINK_SENT);
    expect(closing[2]!.json().say_he).toBe(`בסדר גמור, נדבר ביום שלישי, 10 בנובמבר, בעשר בבוקר. ${GOODBYE}`);
    for (const res of closing) expect(res.json().say_he).toMatch(/יום נעים, להתראות!$/);
    // nothing to be said aloud about "ending the call" (the bot once told a customer it was ending the call)
    for (const res of closing) expect(res.json().message_he).not.toMatch(/מסיימת|מסתיימת|לסיים את השיחה/);
    const alt = (await post("/tools/schedule_callback", { requested_time: "2026-11-13T10:00:00" })).json();
    expect(alt.message_he).not.toContain("end_call"); // not booked yet: the customer has to agree first
    expect(alt.closing).toBeUndefined();
  });

  it("end_call asks for the closing sentence, except on voicemail", async () => {
    const { post } = await setup();
    const done = (await post("/tools/end_call", { reason: "completed" })).json();
    expect(done).toEqual({ ok: true, status: "ending", say_he: SAY_END_CALL.completed, message_he: END_CALL_SAY_GOODBYE });
    const dnc = (await post("/tools/end_call", { reason: "do_not_call" })).json();
    expect(dnc.say_he).toBe(`בסדר, המספר הוסר מהרשימה. ${GOODBYE}`);
    const vm = (await post("/tools/end_call", { reason: "voicemail" })).json();
    expect(vm.message_he).toContain("לא לומר דבר");
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
    expect(res.json()).toEqual({ ok: true, status: "ending", say_he: SAY_END_CALL.completed, message_he: END_CALL_SAY_GOODBYE });
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

describe("phone line routes", () => {
  it("without a line: status says why, dialing is refused", async () => {
    const { app, post } = await setup();
    const st = (await app.inject({ method: "GET", url: "/test/phone", headers: AUTH })).json();
    expect(st).toMatchObject({ ok: true, available: false, reason: "not started", log: [] });
    const dial = await post("/test/phone/call", { number: "0501234567", scenario: "S1" });
    expect(dial.statusCode).toBe(409);
    expect(dial.json()).toMatchObject({ ok: false, error: "no_phone_line" });
    expect((await post("/test/phone/call", { number: "1" })).statusCode).toBe(400);
  });

  it("/test/calls?call_id= returns one phone call's tools, with or without a session", async () => {
    const { app, post } = await setup();
    await post("/tools/end_call", { reason: "completed" }, { ...AUTH, "x-call-id": "phone-1" });
    await post("/tools/end_call", { reason: "completed" }, { ...AUTH, "x-call-id": "phone-2" });
    const r = (await app.inject({ method: "GET", url: "/test/calls?call_id=phone-2", headers: AUTH })).json();
    expect(r.calls.map((c: { call_id: string }) => c.call_id)).toEqual(["phone-2"]);
  });
});

describe("business hours in the callback answer", () => {
  it("quotes the real hours from settings", async () => {
    const { hoursHe } = await import("../src/tools/handlers");
    expect(hoursHe({ days: ["sun", "mon", "tue", "wed", "thu"], open: "09:00", close: "17:00" })).toBe("א׳–ה׳ 09:00–17:00");
  });
});
