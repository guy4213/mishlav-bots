/**
 * Smoke test: replay each scenario's ideal tool calls against the tools server (local or via ngrok),
 * exactly as a provider would. Proves auth, routing, logging and scoring end-to-end.
 *
 *   npm run simulate -- --all [--provider SIM] [--with-metrics] [--base-url https://xxx.ngrok-free.app]
 *   npm run simulate -- --scenario S1 --scenario S3
 */
import { parseArgs } from "node:util";
import { Provider } from "@mishlav/shared";
import { api, scriptEnv } from "./lib/env";
import { loadScenarios, renderTemplate } from "./lib/scenarios";

const { values } = parseArgs({
  options: {
    all: { type: "boolean", default: false },
    core: { type: "boolean", default: false },
    scenario: { type: "string", short: "s", multiple: true },
    provider: { type: "string", short: "p", default: "SIM" },
    "with-metrics": { type: "boolean", default: false },
    "base-url": { type: "string" },
  },
});

const rand = (min: number, max: number) => Math.round(min + Math.random() * (max - min));

async function main() {
  const env = scriptEnv({ baseUrl: values["base-url"] });
  const provider = Provider.parse(values.provider?.toUpperCase());
  const all = loadScenarios(env.scenariosDir);
  const wanted = values.scenario?.map((s) => s.toUpperCase());
  const scenarios = values.all
    ? all
    : values.core
      ? all.filter((s) => s.core)
      : all.filter((s) => wanted?.includes(s.id));
  if (scenarios.length === 0) throw new Error("Nothing to run: pass --all, --core or --scenario <id>");

  const tz = env.settings.business_hours.timezone;
  let failures = 0;

  for (const sc of scenarios) {
    const start = await api<{ session: { session_id: string } }>(env, "POST", "/test/session", {
      provider,
      scenario: sc.id,
      actor: "simulator",
    });
    if (start.status !== 200) throw new Error(`session start failed: HTTP ${start.status} ${JSON.stringify(start.json)}`);
    const callId = `sim-${sc.id}-${Date.now()}`;
    console.log(`\n▶ ${sc.id} ${sc.name}  (${start.json.session.session_id})`);

    for (const step of sc.simulate) {
      const params = renderTemplate(step.params, new Date(), tz);
      const { status, json } = await api<{ ok: boolean; error?: string; status?: string }>(
        env,
        "POST",
        `/tools/${step.tool}`,
        params,
        { "x-provider": provider, "x-call-id": callId },
      );
      const mark = status === 200 && json.ok ? "✓" : "✗";
      if (mark === "✗") failures++;
      console.log(`  ${mark} ${step.tool}(${JSON.stringify(params)}) -> ${json.status ?? json.error ?? status}`);
    }

    if (values["with-metrics"]) {
      const turns = Array.from({ length: Math.max(2, sc.simulate.length + 1) }, (_, i) => ({
        turn: i,
        latency_ms: rand(650, 1150),
        provider_ms: rand(300, 650),
      }));
      await api(env, "POST", "/test/metrics", { turns, duration_sec: rand(40, 150), source: "simulate" });
    }
    await api(env, "POST", "/test/session/end");
  }

  console.log(`\nDone: ${scenarios.length} scenario(s), ${failures} failed tool call(s). Next: npm run score`);
  if (failures) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
