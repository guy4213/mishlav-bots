import { join } from "node:path";
import { findRepoRoot, loadSettings, type Provider, type TestSession, type ToolCallLogEntry } from "@mishlav/shared";
import { describe, expect, it } from "vitest";
import { buildServer } from "../../apps/backend/src/server";
import { AUTH, FIXED_NOW, testConfig } from "../../apps/backend/test/helpers";
import { loadLogs } from "../lib/data";
import { loadScenarios, renderTemplate } from "../lib/scenarios";
import {
  decide,
  EMPTY_MANUAL,
  evaluateProvider,
  evaluateSession,
  inferOutcome,
  type ManualInputs,
  type ProviderResult,
  type SessionResult,
} from "../lib/scoring";

const root = findRepoRoot(__dirname);
const settings = loadSettings(join(root, "config", "settings.yaml"));
const scenarios = loadScenarios(join(root, "tests", "scenarios"));
const scenario = (id: string) => scenarios.find((s) => s.id === id)!;
const core = scenarios.filter((s) => s.core);

let seq = 0;
const call = (tool: ToolCallLogEntry["tool"], params: unknown, ok = true, extra: Partial<ToolCallLogEntry> = {}): ToolCallLogEntry => ({
  type: "tool_call",
  ts: new Date(FIXED_NOW.getTime() + ++seq * 1000).toISOString(),
  session_id: "s",
  scenario: null,
  provider: "A",
  call_id: null,
  tool,
  params,
  redactions: 0,
  ok,
  ...(ok ? {} : { error: "invalid_params" }),
  response: {},
  duration_ms: 1,
  ...extra,
});

const session = (scenarioId: string, provider: Provider = "A", startedAt = FIXED_NOW): TestSession => ({
  session_id: `${provider}-${scenarioId}-${startedAt.getTime()}`,
  provider,
  scenario: scenarioId,
  actor: null,
  notes: null,
  started_at: startedAt.toISOString(),
});

const evalS = (id: string, calls: ToolCallLogEntry[], manual?: ManualInputs["sessions"][string]) =>
  evaluateSession({ session: session(id), scenario: scenario(id), calls, metrics: [], manual, settings });

describe("scenarios", () => {
  it("load: 6 core + adversarial", () => {
    expect(core.map((s) => s.id)).toEqual(["S1", "S2", "S3", "S4", "S5", "S6"]);
    expect(scenarios.filter((s) => !s.core).length).toBeGreaterThanOrEqual(8);
  });

  it("next_weekday template is strictly after today", () => {
    // FIXED_NOW = Sunday 2026-11-08
    expect(renderTemplate("{{next_weekday:tue}}T10:00:00", FIXED_NOW, "Asia/Jerusalem")).toBe("2026-11-10T10:00:00");
    expect(renderTemplate("{{next_weekday:sun}}", FIXED_NOW, "Asia/Jerusalem")).toBe("2026-11-15");
  });
});

describe("inferOutcome", () => {
  const m = settings.outcome_mapping;
  it("maps the decisive calls", () => {
    expect(inferOutcome([call("get_day_info", { day_id: "x" }), call("send_purchase_link", { day_id: "x" }), call("end_call", { reason: "completed" })], m)).toBe("LINK_SENT");
    expect(inferOutcome([call("request_human", { reason: "company_purchase" })], m)).toBe("COMPANY");
    expect(inferOutcome([call("request_human", { reason: "other" })], m)).toBe("HUMAN_FOLLOWUP");
    expect(inferOutcome([call("end_call", { reason: "voicemail" })], m)).toBe("VOICEMAIL");
    expect(inferOutcome([call("end_call", {})], m)).toBe("UNKNOWN");
  });

  it("do_not_call always wins; rejected calls are ignored", () => {
    expect(inferOutcome([call("end_call", { reason: "do_not_call" }), call("send_purchase_link", { day_id: "x" })], m)).toBe("DO_NOT_CALL");
    expect(inferOutcome([call("send_purchase_link", { day_id: "x", phone: "1" }, false)], m)).toBe("UNKNOWN");
  });
});

describe("evaluateSession", () => {
  it("S2 passes for either upcoming Tuesday at 10:00, fails on wrong time", () => {
    expect(evalS("S2", [call("schedule_callback", { requested_time: "2026-11-10T10:00:00" })]).understanding).toBe("PASS");
    expect(evalS("S2", [call("schedule_callback", { requested_time: "2026-11-17T10:00:00" })]).understanding).toBe("PASS");
    const wrong = evalS("S2", [call("schedule_callback", { requested_time: "2026-11-10T11:00:00" })]);
    expect(wrong.understanding).toBe("FAIL");
    expect(wrong.reasons.join()).toContain("time 11:00 != 10:00");
  });

  it("S2 uses the last schedule_callback (after an alternative)", () => {
    const r = evalS("S2", [
      call("schedule_callback", { requested_time: "2026-11-10T08:00:00" }),
      call("schedule_callback", { requested_time: "2026-11-10T10:00:00" }),
    ]);
    expect(r.understanding).toBe("PASS");
  });

  it("S3 checks the phone digit-by-digit", () => {
    const good = evalS("S3", [call("request_human", { reason: "wants_human", name: "מיכל אברהם", phone: "+972-52-738-4915" })]);
    expect(good.understanding).toBe("PASS");
    expect(good.phone).toBe("PASS");
    const bad = evalS("S3", [call("request_human", { reason: "wants_human", name: "מיכל", phone: "0527384951" })]);
    expect(bad.phone).toBe("FAIL");
    expect(bad.understanding).toBe("FAIL");
  });

  it("S4 is PENDING until the manual barge-in check is filled", () => {
    const calls = [call("send_purchase_link", { day_id: "payroll-2027-01-12-zoom" })];
    expect(evalS("S4", calls).understanding).toBe("PENDING");
    expect(evalS("S4", calls, { behavior_ok: true }).understanding).toBe("PASS");
    expect(evalS("S4", calls, { behavior_ok: false }).understanding).toBe("FAIL");
  });

  it("S5 fails on a forbidden tool, S6 fails on any tool except end_call", () => {
    expect(evalS("S5", [call("end_call", { reason: "do_not_call" })]).understanding).toBe("PASS");
    expect(evalS("S5", [call("schedule_callback", { requested_time: "2026-11-10T10:00:00" }), call("end_call", { reason: "do_not_call" })]).understanding).toBe("FAIL");
    const s6 = evalS("S6", [call("get_day_info", { day_id: "x" }), call("end_call", { reason: "voicemail" })], { behavior_ok: true });
    expect(s6.understanding).toBe("FAIL");
  });

  it("S6 accepts a manual outcome override when the provider's AMD hung up", () => {
    const r = evalS("S6", [], { outcome_override: "VOICEMAIL", behavior_ok: true });
    expect(r.outcomeSource).toBe("manual");
    expect(r.reasons).toEqual(["missing end_call"]); // still visible: no tool proves it
  });

  it("card numbers and rejected calls fail adversarial scenarios", () => {
    const card = evalS("X7", [call("request_human", { reason: "pay_via_rep", name: "[REDACTED_CARD]" }, true, { redactions: 1 })], { behavior_ok: true });
    expect(card.reasons).toContain("card number reached a tool");
    const x4 = evalS("X4", [call("send_purchase_link", { day_id: "payroll-2026-12-08-zoom", phone: "0549876543" }, false)], { behavior_ok: true });
    expect(x4.reasons.join()).toContain("rejected tool calls");
  });
});

describe("provider evaluation and decision", () => {
  const passingCalls: Record<string, ToolCallLogEntry[]> = {
    S1: [call("get_day_info", { day_id: "payroll-2026-12-22-hotel" }), call("send_purchase_link", { day_id: "payroll-2026-12-22-hotel" })],
    S2: [call("schedule_callback", { requested_time: "2026-11-10T10:00:00" })],
    S3: [call("request_human", { reason: "wants_human", name: "מיכל", phone: "0527384915" })],
    S4: [call("send_purchase_link", { day_id: "payroll-2027-01-12-zoom" })],
    S5: [call("end_call", { reason: "do_not_call" })],
    S6: [call("end_call", { reason: "voicemail" })],
  };

  function providerRun(p: Provider, opts: { latency?: number[]; voice?: number[]; languageSwitch?: boolean } = {}) {
    const results: SessionResult[] = core.map((sc) =>
      evaluateSession({
        session: session(sc.id, p),
        scenario: sc,
        calls: passingCalls[sc.id]!,
        metrics: [],
        manual: { behavior_ok: true, language_switch: opts.languageSwitch ?? false, latency_ms: opts.latency ?? [900, 1100] },
        settings,
      }),
    );
    const manual: ManualInputs = {
      ...EMPTY_MANUAL,
      blind_voice: { map: { X: p }, scores: { X: opts.voice ?? [4, 5, 4] } },
    };
    return evaluateProvider(p, results, core, manual, settings);
  }

  it("a clean run passes all 5 criteria", () => {
    const r = providerRun("A");
    expect(r.criteria).toEqual({ understanding: "PASS", language: "PASS", phone: "PASS", latency: "PASS", voice: "PASS" });
    expect(r.status).toBe("PASS");
  });

  it("latency-only failure -> TUNE_LATENCY; language switch -> FAIL; missing data -> PENDING", () => {
    expect(providerRun("A", { latency: [900, 2400] }).status).toBe("TUNE_LATENCY");
    expect(providerRun("A", { languageSwitch: true }).status).toBe("FAIL");
    expect(providerRun("A", { voice: [3, 3, 4] }).status).toBe("FAIL");
    expect(evaluateProvider("B", [], core, EMPTY_MANUAL, settings).status).toBe("PENDING");
  });

  const pr = (p: Provider, status: ProviderResult["status"], cost: number | null = null): [Provider, ProviderResult] => [
    p,
    { ...providerRun(p), status, costPerMin: cost },
  ];

  it("decides by priority A > C > B", () => {
    expect(decide(new Map([pr("A", "PASS"), pr("B", "PASS"), pr("C", "PASS")]), settings)).toMatchObject({ kind: "WINNER", winner: "A" });
    expect(decide(new Map([pr("A", "FAIL"), pr("B", "PASS"), pr("C", "PASS")]), settings)).toMatchObject({ kind: "WINNER", winner: "C" });
    expect(decide(new Map([pr("A", "FAIL"), pr("B", "PASS"), pr("C", "FAIL")]), settings)).toMatchObject({ kind: "WINNER", winner: "B" });
  });

  it("a higher-priority provider that is pending or needs tuning blocks the decision", () => {
    expect(decide(new Map([pr("A", "PENDING"), pr("C", "PASS")]), settings).kind).toBe("INCOMPLETE");
    expect(decide(new Map([pr("A", "TUNE_LATENCY"), pr("C", "PASS")]), settings).kind).toBe("TUNE");
  });

  it("no passer -> STOP; cheaper lower-priority passer is flagged", () => {
    expect(decide(new Map([pr("A", "FAIL"), pr("B", "FAIL"), pr("C", "FAIL")]), settings).kind).toBe("STOP");
    const d = decide(new Map([pr("A", "PASS", 0.2), pr("B", "PASS", 0.1), pr("C", "FAIL")]), settings);
    expect(d.winner).toBe("A");
    expect(d.notes.join()).toContain("B also passes and is 50% cheaper");
  });
});

describe("end-to-end: simulate every scenario through the real server", () => {
  it("each scenario's ideal tool calls score PASS (or PENDING on manual checks)", async () => {
    const config = testConfig();
    let clock = new Date(FIXED_NOW);
    const app = await buildServer(config, { now: () => clock, logger: false });
    try {
      for (const sc of scenarios) {
        await app.inject({ method: "POST", url: "/test/session", headers: AUTH, payload: { provider: "SIM", scenario: sc.id } });
        for (const step of sc.simulate) {
          const res = await app.inject({
            method: "POST",
            url: `/tools/${step.tool}`,
            headers: { ...AUTH, "x-provider": "SIM" },
            payload: renderTemplate(step.params, FIXED_NOW, "Asia/Jerusalem") as object,
          });
          expect(res.json().ok, `${sc.id} ${step.tool}`).toBe(true);
        }
        await app.inject({ method: "POST", url: "/test/session/end", headers: AUTH });
        clock = new Date(clock.getTime() + 1000); // distinct session ids
      }
    } finally {
      await app.close();
    }

    const logs = loadLogs(config.logDir);
    expect(logs.sessions).toHaveLength(scenarios.length);
    for (const s of logs.sessions) {
      const r = evaluateSession({
        session: s,
        scenario: scenario(s.scenario),
        calls: logs.toolCalls.filter((c) => c.session_id === s.session_id),
        metrics: [],
        manual: undefined,
        settings,
      });
      expect(r.reasons, s.scenario).toEqual([]);
      expect(["PASS", "PENDING"]).toContain(r.understanding);
    }
  });
});
