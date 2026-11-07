import {
  daysBetween,
  Outcome,
  parseRequestedTime,
  Provider,
  toLocalParts,
  WEEKDAYS,
  type MetricsLogEntry,
  type Settings,
  type TestSession,
  type ToolCallLogEntry,
} from "@mishlav/shared";
import { z } from "zod";
import type { Matcher, Scenario } from "./scenarios";

// ---------------------------------------------------------------- manual inputs

export const ManualSession = z.strictObject({
  language_switch: z.boolean().optional(),
  behavior_ok: z.boolean().optional(),
  latency_ms: z.array(z.number().nonnegative()).optional(),
  provider_ms: z.array(z.number().nonnegative()).optional(),
  duration_sec: z.number().nonnegative().optional(),
  cost_usd: z.number().nonnegative().optional(),
  outcome_override: Outcome.optional(),
  discard: z.boolean().optional(),
  notes: z.string().optional(),
});
export type ManualSession = z.infer<typeof ManualSession>;

export const ManualInputs = z.strictObject({
  providers: z.partialRecord(Provider, z.strictObject({ cost_per_min_usd: z.number().nonnegative().optional() })).default({}),
  blind_voice: z
    .strictObject({
      map: z.record(z.string(), Provider),
      scores: z.record(z.string(), z.array(z.number().min(1).max(5))),
    })
    .optional(),
  sessions: z.record(z.string(), ManualSession).default({}),
});
export type ManualInputs = z.infer<typeof ManualInputs>;

export const EMPTY_MANUAL: ManualInputs = { providers: {}, sessions: {} };

// ---------------------------------------------------------------- outcome inference

export type InferredOutcome = Outcome | "UNKNOWN";

/** Outcome from ok tool calls: do_not_call wins, else the last decisive call. */
export function inferOutcome(calls: ToolCallLogEntry[], mapping: Settings["outcome_mapping"]): InferredOutcome {
  const ok = calls.filter((c) => c.ok);
  const reasonOf = (c: ToolCallLogEntry) => (c.params as { reason?: string } | null)?.reason;

  if (ok.some((c) => c.tool === "end_call" && reasonOf(c) === "do_not_call")) return "DO_NOT_CALL";

  let outcome: InferredOutcome = "UNKNOWN";
  for (const c of ok) {
    const reason = reasonOf(c);
    if (c.tool === "send_purchase_link") outcome = "LINK_SENT";
    else if (c.tool === "schedule_callback") outcome = "CALLBACK";
    else if (c.tool === "request_human" && reason && reason in mapping.request_human) {
      outcome = mapping.request_human[reason as keyof typeof mapping.request_human];
    } else if (c.tool === "end_call" && reason && reason in mapping.end_call) {
      const mapped = mapping.end_call[reason as keyof typeof mapping.end_call];
      if (mapped) outcome = mapped;
    }
  }
  return outcome;
}

// ---------------------------------------------------------------- matchers

export function normalizePhoneDigits(s: string): string {
  const d = s.replace(/\D/g, "");
  return d.startsWith("972") ? "0" + d.slice(3) : d;
}

export interface MatchContext {
  sessionStart: Date;
  tz: string;
}

export function matchValue(m: Matcher, value: unknown, ctx: MatchContext): { ok: boolean; why?: string } {
  const show = (v: unknown) => (v === undefined ? "missing" : JSON.stringify(v));
  if ("absent" in m) return value === undefined ? { ok: true } : { ok: false, why: `expected absent, got ${show(value)}` };
  if (value === undefined) return { ok: false, why: "missing" };
  if ("equals" in m) return value === m.equals ? { ok: true } : { ok: false, why: `expected ${show(m.equals)}, got ${show(value)}` };
  if ("one_of" in m) return m.one_of.includes(value) ? { ok: true } : { ok: false, why: `expected one of ${show(m.one_of)}, got ${show(value)}` };
  if ("includes" in m) {
    const ok = typeof value === "string" && value.trim().toLowerCase().includes(m.includes.trim().toLowerCase());
    return ok ? { ok } : { ok, why: `expected to include ${show(m.includes)}, got ${show(value)}` };
  }
  if ("digits_equal" in m) {
    const got = typeof value === "string" || typeof value === "number" ? normalizePhoneDigits(String(value)) : "";
    const want = normalizePhoneDigits(m.digits_equal);
    return got === want ? { ok: true } : { ok: false, why: `expected digits ${want}, got ${got || show(value)}` };
  }
  // local_datetime
  const spec = m.local_datetime;
  const t = typeof value === "string" ? parseRequestedTime(value, ctx.tz) : null;
  if (!t) return { ok: false, why: `not a valid date-time: ${show(value)}` };
  const p = toLocalParts(t, ctx.tz);
  const hhmm = `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
  const days = daysBetween(toLocalParts(ctx.sessionStart, ctx.tz), p);
  const problems: string[] = [];
  if (WEEKDAYS[p.weekday] !== spec.weekday) problems.push(`weekday ${WEEKDAYS[p.weekday]} != ${spec.weekday}`);
  if (hhmm !== spec.time) problems.push(`time ${hhmm} != ${spec.time}`);
  if (days < 1 || days > spec.max_days_ahead) problems.push(`${days} days ahead (allowed 1..${spec.max_days_ahead})`);
  return problems.length ? { ok: false, why: `${value}: ${problems.join(", ")}` } : { ok: true };
}

// ---------------------------------------------------------------- session evaluation

export type Tri = "PASS" | "FAIL" | "PENDING";

export interface SessionResult {
  session: TestSession;
  scenario: Scenario | null;
  calls: ToolCallLogEntry[];
  expected: string;
  inferred: InferredOutcome;
  outcomeSource: "log" | "manual";
  understanding: Tri;
  reasons: string[];
  languageSwitch: boolean | null;
  phone: Tri | "N/A";
  behaviorOk: boolean | null;
  latencies: number[];
  providerMs: number[];
  durationSec: number | null;
  costUsd: number | null;
  notes: string;
  discarded: boolean;
}

export interface EvaluateInput {
  session: TestSession;
  scenario: Scenario | null;
  calls: ToolCallLogEntry[];
  metrics: MetricsLogEntry[];
  manual: ManualSession | undefined;
  settings: Settings;
}

const paramsOf = (c: ToolCallLogEntry) => (c.params && typeof c.params === "object" ? (c.params as Record<string, unknown>) : {});

export function evaluateSession(input: EvaluateInput): SessionResult {
  const { session, scenario, calls, metrics, manual, settings } = input;
  const ctx: MatchContext = { sessionStart: new Date(session.started_at), tz: settings.business_hours.timezone };
  const inferredFromLog = inferOutcome(calls, settings.outcome_mapping);
  const inferred = manual?.outcome_override ?? inferredFromLog;
  const reasons: string[] = [];
  let pending = false;
  let phone: Tri | "N/A" = "N/A";

  const latencies = [...metrics.flatMap((m) => m.turns.map((t) => t.latency_ms)), ...(manual?.latency_ms ?? [])];
  const providerMs = [
    ...metrics.flatMap((m) => m.turns.flatMap((t) => (t.provider_ms === undefined ? [] : [t.provider_ms]))),
    ...(manual?.provider_ms ?? []),
  ];
  const durations = metrics.flatMap((m) => (m.duration_sec === undefined ? [] : [m.duration_sec]));
  const costs = metrics.flatMap((m) => (m.cost_usd === undefined ? [] : [m.cost_usd]));

  const base = {
    session,
    scenario,
    calls,
    inferred,
    outcomeSource: manual?.outcome_override ? ("manual" as const) : ("log" as const),
    languageSwitch: manual?.language_switch ?? null,
    behaviorOk: manual?.behavior_ok ?? null,
    latencies,
    providerMs,
    durationSec: manual?.duration_sec ?? (durations.length ? Math.max(...durations) : null),
    costUsd: manual?.cost_usd ?? (costs.length ? costs.reduce((a, b) => a + b, 0) : null),
    notes: manual?.notes ?? "",
    discarded: manual?.discard ?? false,
  };

  if (!scenario) {
    return { ...base, expected: "?", understanding: "FAIL", reasons: [`unknown scenario ${session.scenario}`], phone };
  }
  const exp = scenario.expect;

  // 1. outcome
  const expected = exp.outcome ?? (exp.outcome_one_of ? exp.outcome_one_of.join("|") : "-");
  if (exp.outcome && inferred !== exp.outcome) reasons.push(`outcome ${inferred} != ${exp.outcome}`);
  if (exp.outcome_one_of && !exp.outcome_one_of.includes(inferred as Outcome)) {
    reasons.push(`outcome ${inferred} not in ${exp.outcome_one_of.join("|")}`);
  }

  // 2. required tools
  for (const req of exp.required_tools) {
    let candidates = calls.filter((c) => c.ok && c.tool === req.tool);
    if (req.tool === "schedule_callback") candidates = candidates.slice(-1); // the final agreed time
    const results = candidates.map((c) =>
      Object.entries(req.params).map(([field, m]) => ({ field, m, r: matchValue(m, paramsOf(c)[field], ctx) })),
    );
    const matched = results.some((rs) => rs.every((x) => x.r.ok));
    const phoneMatchers = Object.entries(req.params).filter(([, m]) => "digits_equal" in m);
    if (phoneMatchers.length) {
      phone = results.some((rs) => rs.filter((x) => "digits_equal" in x.m).every((x) => x.r.ok)) ? "PASS" : "FAIL";
    }
    if (!matched) {
      if (candidates.length === 0) reasons.push(`missing ${req.tool}`);
      else {
        const best = results[results.length - 1]!.filter((x) => !x.r.ok).map((x) => `${x.field}: ${x.r.why}`);
        reasons.push(`${req.tool} params wrong (${best.join("; ")})`);
      }
    }
  }

  // 3. forbidden / allowed
  for (const tool of exp.forbidden_tools) {
    if (calls.some((c) => c.tool === tool)) reasons.push(`forbidden tool called: ${tool}`);
  }
  if (exp.allowed_tools) {
    const extra = [...new Set(calls.map((c) => c.tool).filter((t) => !exp.allowed_tools!.includes(t)))];
    if (extra.length) reasons.push(`tools outside allowed list: ${extra.join(", ")}`);
  }

  // 4. safety
  if (exp.no_card_numbers && calls.some((c) => c.redactions > 0)) reasons.push("card number reached a tool");
  if (exp.no_rejected_calls) {
    const rejected = calls.filter((c) => c.error === "invalid_params");
    if (rejected.length) reasons.push(`rejected tool calls: ${rejected.map((c) => c.tool).join(", ")}`);
  }

  // 5. manual checks
  if (exp.manual_checks.length > 0) {
    if (manual?.behavior_ok === false) reasons.push("manual check failed (behavior_ok: false)");
    else if (manual?.behavior_ok === undefined) pending = true;
  }

  const understanding: Tri = reasons.length ? "FAIL" : pending ? "PENDING" : "PASS";
  return { ...base, expected, understanding, reasons, phone };
}

// ---------------------------------------------------------------- provider evaluation

export type ProviderStatus = "PASS" | "FAIL" | "TUNE_LATENCY" | "PENDING";

export interface ProviderResult {
  provider: Provider;
  criteria: { understanding: Tri; language: Tri; phone: Tri; latency: Tri; voice: Tri };
  details: string[];
  avgLatency: number | null;
  maxLatency: number | null;
  avgProviderMs: number | null;
  voiceAvg: number | null;
  costPerMin: number | null;
  status: ProviderStatus;
  sessions: SessionResult[];
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Latest non-discarded session per core scenario. */
export function latestCoreSessions(results: SessionResult[], provider: string): Map<string, SessionResult> {
  const map = new Map<string, SessionResult>();
  const sorted = results
    .filter((r) => r.session.provider === provider && r.scenario?.core && !r.discarded)
    .sort((a, b) => a.session.started_at.localeCompare(b.session.started_at));
  for (const r of sorted) map.set(r.session.scenario, r);
  return map;
}

export function evaluateProvider(
  provider: Provider,
  results: SessionResult[],
  coreScenarios: Scenario[],
  manual: ManualInputs,
  settings: Settings,
): ProviderResult {
  const s = settings.testing.scoring;
  const latest = latestCoreSessions(results, provider);
  const details: string[] = [];
  const used = [...latest.values()];

  // 1. understanding
  let understanding: Tri = "PASS";
  for (const sc of coreScenarios) {
    const r = latest.get(sc.id);
    if (!r) {
      details.push(`${sc.id}: not run`);
      if (understanding === "PASS") understanding = "PENDING";
    } else if (r.understanding === "FAIL") {
      details.push(`${sc.id}: ${r.reasons.join("; ")}`);
      understanding = "FAIL";
    } else if (r.understanding === "PENDING") {
      details.push(`${sc.id}: manual check pending`);
      if (understanding === "PASS") understanding = "PENDING";
    }
  }

  // 2. language
  let language: Tri = used.length ? "PASS" : "PENDING";
  if (used.some((r) => r.languageSwitch === true)) {
    language = "FAIL";
    details.push(`language switch in ${used.filter((r) => r.languageSwitch).map((r) => r.session.scenario).join(", ")}`);
  } else if (used.some((r) => r.languageSwitch === null) || used.length < coreScenarios.length) {
    language = "PENDING";
  }

  // 3. phone (scenarios with a digits_equal matcher)
  const phoneScenarios = coreScenarios.filter((sc) =>
    sc.expect.required_tools.some((t) => Object.values(t.params).some((m) => "digits_equal" in m)),
  );
  let phone: Tri = "PASS";
  for (const sc of phoneScenarios) {
    const r = latest.get(sc.id);
    if (!r) phone = phone === "FAIL" ? "FAIL" : "PENDING";
    else if (r.phone === "FAIL") {
      phone = "FAIL";
      details.push(`${sc.id}: phone digits wrong`);
    }
  }

  // 4. latency
  const lat = used.flatMap((r) => r.latencies);
  const avgLatency = avg(lat);
  const maxLatency = lat.length ? Math.max(...lat) : null;
  let latency: Tri = "PENDING";
  if (avgLatency !== null && maxLatency !== null) {
    latency = avgLatency <= s.max_avg_latency_ms && maxLatency <= s.max_latency_ms ? "PASS" : "FAIL";
    if (latency === "FAIL") details.push(`latency avg ${Math.round(avgLatency)} ms / max ${Math.round(maxLatency)} ms`);
  }

  // 5. voice (blind)
  const bv = manual.blind_voice;
  const scores = bv ? Object.entries(bv.map).filter(([, p]) => p === provider).flatMap(([label]) => bv.scores[label] ?? []) : [];
  const voiceAvg = avg(scores);
  const voice: Tri = voiceAvg === null ? "PENDING" : voiceAvg >= s.min_voice_score ? "PASS" : "FAIL";
  if (voice === "FAIL") details.push(`voice score ${voiceAvg!.toFixed(2)} < ${s.min_voice_score}`);

  const criteria = { understanding, language, phone, latency, voice };
  const nonLatency = [understanding, language, phone, voice];
  let status: ProviderStatus;
  if (nonLatency.includes("FAIL")) status = "FAIL";
  else if (nonLatency.includes("PENDING") || latency === "PENDING") status = "PENDING";
  else if (latency === "FAIL") status = "TUNE_LATENCY";
  else status = "PASS";

  return {
    provider,
    criteria,
    details,
    avgLatency,
    maxLatency,
    avgProviderMs: avg(used.flatMap((r) => r.providerMs)),
    voiceAvg,
    costPerMin: manual.providers[provider]?.cost_per_min_usd ?? null,
    status,
    sessions: used,
  };
}

// ---------------------------------------------------------------- decision

export interface Decision {
  kind: "WINNER" | "TUNE" | "INCOMPLETE" | "STOP";
  winner?: Provider;
  message: string;
  notes: string[];
}

/** Spec 3.5: first passer in priority order (A, C, B); a higher-priority undecided provider blocks. */
export function decide(results: Map<Provider, ProviderResult>, settings: Settings): Decision {
  const { provider_priority: priority, cost_close_pct } = settings.testing.scoring;
  const notes: string[] = [];
  const passers = priority.filter((p) => results.get(p)?.status === "PASS");

  for (const p of priority) {
    const r = results.get(p);
    const status = r?.status ?? "PENDING";
    if (status === "FAIL") continue;
    if (status === "PASS") {
      const cost = r!.costPerMin;
      if (cost === null) notes.push(`cost per minute for ${p} not recorded`);
      for (const other of passers.filter((x) => x !== p)) {
        const oc = results.get(other)!.costPerMin;
        if (cost !== null && oc !== null && oc <= cost * (1 - cost_close_pct / 100)) {
          notes.push(`${other} also passes and is ${Math.round((1 - oc / cost) * 100)}% cheaper per minute — decide by cost if results are close`);
        }
      }
      return { kind: "WINNER", winner: p, message: `Winner: ${p}`, notes };
    }
    const later = passers.filter((x) => priority.indexOf(x) > priority.indexOf(p));
    if (later.length) notes.push(`${later.join(", ")} already pass(es), but ${p} has higher priority`);
    if (status === "TUNE_LATENCY") {
      return { kind: "TUNE", message: `${p} failed only on latency — tune it and re-test before disqualifying`, notes };
    }
    return { kind: "INCOMPLETE", message: `${p} is still pending — complete its calls and manual inputs`, notes };
  }
  return { kind: "STOP", message: "No provider passed — STOP and update Mishlav before continuing", notes };
}
