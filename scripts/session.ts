/**
 * Start / end a test session before / after each Part 3 call.
 *
 *   npm run session -- start --provider A --scenario S1 --actor female [--notes "from street"]
 *   npm run session -- end
 *   npm run session -- status
 *   npm run session -- calls        # tool calls of the active session
 */
import { parseArgs } from "node:util";
import { Provider } from "@mishlav/shared";
import { api, scriptEnv } from "./lib/env";
import { loadScenarios } from "./lib/scenarios";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    provider: { type: "string", short: "p" },
    scenario: { type: "string", short: "s" },
    actor: { type: "string", short: "a" },
    notes: { type: "string" },
    "base-url": { type: "string" },
  },
});

async function main() {
  const env = scriptEnv({ baseUrl: values["base-url"] });
  const cmd = positionals[0] ?? "status";

  if (cmd === "start") {
    const provider = Provider.safeParse(values.provider?.toUpperCase());
    if (!provider.success) throw new Error("--provider must be A, B, C or SIM");
    const scenario = values.scenario?.toUpperCase();
    if (!scenario) throw new Error("--scenario is required (S1..S6, X1..X8)");
    const sc = loadScenarios(env.scenariosDir).find((s) => s.id === scenario);
    if (!sc) throw new Error(`Unknown scenario ${scenario}`);

    const { status, json } = await api<{ session?: { session_id: string } }>(env, "POST", "/test/session", {
      provider: provider.data,
      scenario,
      ...(values.actor ? { actor: values.actor } : {}),
      ...(values.notes ? { notes: values.notes } : {}),
    });
    if (status !== 200) throw new Error(`HTTP ${status}: ${JSON.stringify(json)}`);
    console.log(`Session started: ${json.session?.session_id}`);
    console.log(`\n${sc.id} — ${sc.name}\n${sc.description.trim()}`);
    console.log(`\nContext for the provider: ${JSON.stringify(sc.context)}`);
    console.log("\nActor script:");
    sc.actor_script.forEach((l, i) => console.log(`  ${i + 1}. ${l}`));
    if (sc.expect.manual_checks.length) {
      console.log("\nListen for (manual checks):");
      sc.expect.manual_checks.forEach((c) => console.log(`  - ${c}`));
    }
    console.log("\nWhen the call ends: npm run session -- end");
    return;
  }

  if (cmd === "end") {
    const { json } = await api<{ ended: { session_id: string } | null }>(env, "POST", "/test/session/end");
    console.log(json.ended ? `Session ended: ${json.ended.session_id}` : "No active session.");
    return;
  }

  if (cmd === "status") {
    const { json } = await api<{ session: unknown }>(env, "GET", "/test/session");
    console.log(json.session ? JSON.stringify(json.session, null, 2) : "No active session.");
    return;
  }

  if (cmd === "calls") {
    const { json } = await api(env, "GET", "/test/calls");
    console.log(JSON.stringify(json, null, 2));
    return;
  }

  throw new Error(`Unknown command "${cmd}" (start | end | status | calls)`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
