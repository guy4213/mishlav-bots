/**
 * One scoring pass over the logs — shared by `npm run score` and the dashboard, so both always agree.
 */
import { PROVIDER_NAMES, PROVIDERS, type Provider, type Settings } from "@mishlav/shared";
import type { LoadedLogs } from "./data";
import type { Scenario } from "./scenarios";
import {
  decide,
  evaluateProvider,
  evaluateSession,
  type Decision,
  type ManualInputs,
  type ProviderResult,
  type SessionResult,
} from "./scoring";

export interface ReportInput {
  logs: LoadedLogs;
  scenarios: Scenario[];
  manual: ManualInputs;
  settings: Settings;
  /** Only these providers (default: all). */
  providers?: string[];
  includeSim?: boolean;
  /** For the warnings list only. */
  manualFileGiven: boolean;
  logDir: string;
}

export interface Report {
  results: SessionResult[];
  providerResults: Map<Provider, ProviderResult>;
  decision: Decision;
  warnings: string[];
  csv: string;
  summary: string;
}

const round = (n: number | null) => (n === null ? "" : String(Math.round(n)));
const yesNo = (b: boolean | null) => (b === null ? "?" : b ? "yes" : "no");
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toolsSummary(r: SessionResult): string {
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

export function buildReport(input: ReportInput): Report {
  const { logs, scenarios, manual, settings } = input;
  const byId = new Map(scenarios.map((s) => [s.id, s]));
  const core = scenarios.filter((s) => s.core);
  const filter = input.providers?.map((p) => p.toUpperCase());

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
      settings,
    }),
  );

  // ---- results.csv
  const header = [
    "session_id", "provider", "scenario", "scenario_name", "core", "actor", "started_at", "tools",
    "expected_outcome", "inferred_outcome", "outcome_source", "understanding", "failure_reasons",
    "language_switch", "phone_correct", "behavior_ok", "avg_latency_ms", "max_latency_ms",
    "avg_provider_ms", "duration_sec", "cost_usd", "discarded", "notes",
  ];
  const rows = results.map((r) => [
    r.session.session_id, r.session.provider, r.session.scenario, r.scenario?.name ?? "", r.scenario?.core ?? "",
    r.session.actor ?? "", r.session.started_at, toolsSummary(r), r.expected, r.inferred, r.outcomeSource,
    r.understanding, r.reasons.join("; "), yesNo(r.languageSwitch), r.phone, yesNo(r.behaviorOk),
    round(mean(r.latencies)), round(r.latencies.length ? Math.max(...r.latencies) : null),
    round(mean(r.providerMs)), r.durationSec ?? "", r.costUsd ?? "", r.discarded ? "yes" : "", r.notes,
  ]);
  const csv = "﻿" + [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";

  // ---- provider evaluation + decision
  const considered = PROVIDERS.filter((p) => p !== "SIM" || input.includeSim).filter((p) =>
    filter ? filter.includes(p) : true,
  );
  const providerResults = new Map<Provider, ProviderResult>();
  for (const p of considered) {
    if (p === "SIM" && !results.some((r) => r.session.provider === p)) continue;
    providerResults.set(p, evaluateProvider(p, results, core, manual, settings));
  }
  const settingsForDecision: Settings = input.includeSim
    ? {
        ...settings,
        testing: {
          ...settings.testing,
          scoring: {
            ...settings.testing.scoring,
            provider_priority: [...settings.testing.scoring.provider_priority, "SIM" as const],
          },
        },
      }
    : settings;
  const decision = decide(providerResults, settingsForDecision);

  // ---- warnings
  const warnings: string[] = [];
  const unassigned = logs.toolCalls.filter((c) => c.session_id === null).length;
  if (unassigned) warnings.push(`${unassigned} tool call(s) arrived with no active session (not scored)`);
  if (logs.authFailures) warnings.push(`${logs.authFailures} request(s) rejected by auth — check the provider's secret header`);
  if (logs.skippedLines) warnings.push(`${logs.skippedLines} unreadable log line(s) skipped`);
  if (!input.manualFileGiven) warnings.push("no manual inputs file: language, voice, S4/S6 manual checks stay PENDING");

  // ---- summary.md
  const s = settings.testing.scoring;
  const lines: string[] = [];
  lines.push("# Provider test results", "", `Generated ${new Date().toISOString()} from \`${input.logDir}\``, "");
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
  if (warnings.length) {
    lines.push("", "## Warnings", "");
    for (const w of warnings) lines.push(`- ${w}`);
  }
  const summary = lines.join("\n") + "\n";

  return { results, providerResults, decision, warnings, csv, summary };
}
