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
import { loadLogs, loadManualInputs } from "./lib/data";
import { scriptEnv } from "./lib/env";
import { loadScenarios } from "./lib/scenarios";
import { buildReport } from "./lib/report";

const { values } = parseArgs({
  options: {
    manual: { type: "string", short: "m" },
    provider: { type: "string", short: "p", multiple: true },
    "include-sim": { type: "boolean", default: false },
    out: { type: "string", default: "results" },
    "log-dir": { type: "string" },
  },
});

async function main() {
  const root = scriptEnv().root;
  const abs = (p: string) => (isAbsolute(p) ? p : resolve(root, p));
  const env = scriptEnv({ logDir: values["log-dir"] ? abs(values["log-dir"]) : undefined });
  const report = buildReport({
    logs: loadLogs(env.logDir),
    scenarios: loadScenarios(env.scenariosDir),
    manual: loadManualInputs(values.manual ? abs(values.manual) : undefined),
    settings: env.settings,
    providers: values.provider,
    includeSim: values["include-sim"],
    manualFileGiven: Boolean(values.manual),
    logDir: env.logDir,
  });

  const outDir = abs(values.out!);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "results.csv"), report.csv, "utf8");
  writeFileSync(join(outDir, "summary.md"), report.summary, "utf8");

  console.log(report.summary);
  console.log(`Wrote ${join(outDir, "results.csv")} (${report.results.length} calls) and ${join(outDir, "summary.md")}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
