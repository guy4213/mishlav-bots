/**
 * Score test calls from the tool log (spec 1.5, 3.4, 3.5).
 *
 *   npm run score
 *   npm run score -- --manual tests/results/manual-inputs.yaml [--provider A] [--include-sim] [--out results]
 *
 * Writes results/results.csv (one row per call, UTF-8 BOM for Excel) and results/summary.md
 * (provider criteria + decision), and prints the summary.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { PROVIDER_NAMES, PROVIDERS, type Provider } from "@mishlav/shared";
import { loadLogs, loadManualInputs } from "./lib/data";
import { scriptEnv } from "./lib/env";
import { loadScenarios } from "./lib/scenarios";
import { decide, evaluateProvider, evaluateSession, type ProviderResult, type SessionResult } from "./lib/scoring";

const { values } = parseArgs({
  options: {
    manual: { type: "string", short: "m" },
    provider: { type: "string", short: "p", multiple: true },
    "include-sim": { type: "boolean", default: false },
    out: { type: "string", default: "results" },
    "log-dir": { type: "string" },
  },
});

const round = (n: number | null) => (n === null ? "" : String(Math.round(n)));
const yesNo = (b: boolean | null) => (b === null ? "?" : b ? "yes" : "no");

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toolsSummary(r: SessionResult): string {
  return r.calls
    .map((c) => {
      const p = c.params && typeof c.params === "object" ? (c.params as Record<string, unknown>) : {};
      const args = Object.entries(p)
        .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join(", ");
      return `${c.ok ? "" : "✗"}${c.tool}(${args})`;
    })
    .join(" > ");
}

async function main() {
  const root = scriptEnv().root;
  const abs = (p: string) => (isAbsolute(p) ? p : resolve(root, p));
  const env = scriptEnv({ logDir: values["log-dir"] ? abs(values["log-dir"]) : undefined });
  const scenarios = loadScenarios(env.scenariosDir);
  const byId = new Map(scenarios.map((s) => [s.id, s]));
  const core = scenarios.filter((s) => s.core);
  const manual = loadManualInputs(values.manual ? abs(values.manual) : undefined);
  const logs = loadLogs(env.logDir);

  const filter = values.provider?.map((p) => p.toUpperCase());
  const sessions = logs.sessions
    .filter((s) => (filter ? filter.includes(s.provider) : true))
    .sort((a, b) => a.started_at.localeCompare(b.started_at));

  const results: SessionResult[] = sessions.map((session) =>
    evaluateSession({
      session,
      scenario: byId.get(session.scenario) ?? null,
      calls: logs.toolCalls.filter((c) => c.session_id === session.session_id),
      metrics: logs.metrics.filter((m) => m.session_id === session.session_id),
      manual: manual.sessions[session.session_id],
      settings: env.settings,
    }),
  );

  // ---- results.csv
  const header = [
    "session_id", "provider", "scenario", "scenario_name", "core", "actor", "started_at", "tools",
    "expected_outcome", "inferred_outcome", "outcome_source", "understanding", "failure_reasons",
    "language_switch", "phone_correct", "behavior_ok", "avg_latency_ms", "max_latency_ms",
    "avg_provider_ms", "duration_sec", "cost_usd", "discarded", "notes",
  ];
  const rows = results.map((r) => {
    const lat = r.latencies;
    return [
      r.session.session_id, r.session.provider, r.session.scenario, r.scenario?.name ?? "", r.scenario?.core ?? "",
      r.session.actor ?? "", r.session.started_at, toolsSummary(r), r.expected, r.inferred, r.outcomeSource,
      r.understanding, r.reasons.join("; "), yesNo(r.languageSwitch), r.phone, yesNo(r.behaviorOk),
      round(lat.length ? lat.reduce((a, b) => a + b, 0) / lat.length : null), round(lat.length ? Math.max(...lat) : null),
      round(r.providerMs.length ? r.providerMs.reduce((a, b) => a + b, 0) / r.providerMs.length : null),
      r.durationSec ?? "", r.costUsd ?? "", r.discarded ? "yes" : "", r.notes,
    ];
  });
  const outDir = abs(values.out!);
  mkdirSync(outDir, { recursive: true });
  const csv = "﻿" + [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
  writeFileSync(join(outDir, "results.csv"), csv, "utf8");

  // ---- provider evaluation + decision
  const considered = PROVIDERS.filter((p) => p !== "SIM" || values["include-sim"]).filter((p) =>
    filter ? filter.includes(p) : true,
  );
  const providerResults = new Map<Provider, ProviderResult>();
  for (const p of considered) {
    if (!results.some((r) => r.session.provider === p) && p === "SIM") continue;
    providerResults.set(p, evaluateProvider(p, results, core, manual, env.settings));
  }
  const settingsForDecision = values["include-sim"]
    ? {
        ...env.settings,
        testing: {
          ...env.settings.testing,
          scoring: {
            ...env.settings.testing.scoring,
            provider_priority: [...env.settings.testing.scoring.provider_priority, "SIM" as const],
          },
        },
      }
    : env.settings;
  const decision = decide(providerResults, settingsForDecision);

  // ---- summary.md
  const s = env.settings.testing.scoring;
  const lines: string[] = [];
  lines.push("# Provider test results", "", `Generated ${new Date().toISOString()} from \`${env.logDir}\``, "");
  lines.push(`Pass criteria: understanding in all ${core.length} core scenarios · zero language switches · phone digit-by-digit · avg latency ≤ ${s.max_avg_latency_ms} ms and max ≤ ${s.max_latency_ms} ms · voice ≥ ${s.min_voice_score}`, "");
  lines.push("| Provider | Understanding | Language | Phone | Latency (avg/max) | Voice | Cost/min | Status |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const r of providerResults.values()) {
    const latTxt = r.avgLatency === null ? "" : ` (${round(r.avgLatency)}/${round(r.maxLatency)} ms)`;
    const voiceTxt = r.voiceAvg === null ? "" : ` (${r.voiceAvg.toFixed(2)})`;
    const cost = r.costPerMin === null ? "?" : `$${r.costPerMin}`;
    lines.push(
      `| ${r.provider} — ${PROVIDER_NAMES[r.provider]} | ${r.criteria.understanding} | ${r.criteria.language} | ${r.criteria.phone} | ${r.criteria.latency}${latTxt} | ${r.criteria.voice}${voiceTxt} | ${cost} | **${r.status}** |`,
    );
  }
  lines.push("", `## Decision: ${decision.kind}`, "", decision.message, "");
  for (const n of decision.notes) lines.push(`- ${n}`);
  for (const r of providerResults.values()) {
    if (r.details.length) {
      lines.push("", `### ${r.provider} details`, "");
      for (const d of r.details) lines.push(`- ${d}`);
    }
  }
  lines.push("", "## Calls", "", "| Session | Scenario | Outcome (expected → got) | Understanding | Reasons |", "|---|---|---|---|---|");
  for (const r of results) {
    lines.push(`| ${r.session.session_id} | ${r.session.scenario} | ${r.expected} → ${r.inferred} | ${r.understanding} | ${r.reasons.join("; ")} |`);
  }
  const unassigned = logs.toolCalls.filter((c) => c.session_id === null).length;
  const warnings: string[] = [];
  if (unassigned) warnings.push(`${unassigned} tool call(s) arrived with no active session (not scored)`);
  if (logs.authFailures) warnings.push(`${logs.authFailures} request(s) rejected by auth — check the provider's secret header`);
  if (logs.skippedLines) warnings.push(`${logs.skippedLines} unreadable log line(s) skipped`);
  if (!values.manual) warnings.push("no --manual file: language, voice, S4/S6 manual checks stay PENDING");
  if (warnings.length) {
    lines.push("", "## Warnings", "");
    for (const w of warnings) lines.push(`- ${w}`);
  }
  const summary = lines.join("\n") + "\n";
  writeFileSync(join(outDir, "summary.md"), summary, "utf8");

  console.log(summary);
  console.log(`Wrote ${join(outDir, "results.csv")} (${results.length} calls) and ${join(outDir, "summary.md")}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
