/**
 * The dashboard on invented data:  npm run dashboard:demo
 *
 * The real server code (buildServer) with in-memory stores (scripts/lib/demo-store.ts) instead of Supabase, a phone
 * line that only pretends, and WhatsApp to the log only - no .env is read, nothing leaves this machine (except the browser
 * fetching the Rubik font from Google Fonts). Listens on 127.0.0.1 only. Both dashboards run on it:
 *   old: http://127.0.0.1:8799/dashboard        new: http://127.0.0.1:8799/dashboard-new
 * Log in with the key printed below (#k=...), or as a user: admin 0500000001 / demo-admin-pass, Mishlav 0500000002 /
 * demo-mishlav-pass. Used for comparing the two dashboards in a browser (scripts/dashboard-compare.ts) - any button,
 * including the ones that write, only changes this memory.
 *
 *   npm run dashboard:demo -- --port 8799
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { findRepoRoot, loadSettings } from "@mishlav/shared";
import type { AppConfig } from "../apps/backend/src/config";
import { buildServer } from "../apps/backend/src/server";
import { LogOnlyWhatsApp } from "../apps/backend/src/whatsapp";
import { DemoLine, DemoStore } from "./lib/demo-store";
import { DEMO_PASSWORDS, DEMO_PHONES } from "./lib/demo-users";

/** Not a real secret: the demo's own key (the real TOOLS_SECRET is never read here). */
export const DEMO_SECRET = "demo-secret-not-real-0123456789";

export async function startDemo(port: number) {
  const repoRoot = findRepoRoot();
  const logDir = mkdtempSync(join(tmpdir(), "mishlav-demo-"));
  const config: AppConfig = {
    repoRoot,
    port,
    host: "127.0.0.1",
    toolsSecret: DEMO_SECRET,
    logDir,
    knowledgeDir: join(repoRoot, "config", "knowledge"),
    offlineDaysDir: join(repoRoot, "tests", "fixtures", "days"),
    settings: loadSettings(join(repoRoot, "config", "settings.yaml")),
  };
  const store = await DemoStore.create();
  const line = new DemoLine(join(logDir, "transcripts"));
  const phone = { line: line as never, reason: null };
  const app = await buildServer(config, {
    logger: { level: "warn" },
    env: { SUPABASE_URL: "https://demo.invalid" }, // nothing from the real environment
    whatsapp: new LogOnlyWhatsApp(() => {}), // nothing is ever sent
    phone,
    contacts: store,
    admin: store,
    dialer: { store, run: true },
    testDialer: { store, run: true },
    logStore: store,
    studyDays: store,
    users: store,
  });
  await app.listen({ port, host: "127.0.0.1" });
  return { app, store, line, url: `http://127.0.0.1:${port}` };
}

const isMain = process.argv[1] && /dashboard-demo\.ts$/.test(process.argv[1].replace(/\\/g, "/"));
if (isMain) {
  const { values } = parseArgs({ options: { port: { type: "string", default: "8799" } } });
  const { url, app } = await startDemo(Number(values.port));
  console.log(`\nDashboard demo (invented data, nothing real):`);
  console.log(`  old: ${url}/dashboard#k=${DEMO_SECRET}`);
  console.log(`  new: ${url}/dashboard-new#k=${DEMO_SECRET}`);
  console.log(`  users: admin ${DEMO_PHONES.admin} / ${DEMO_PASSWORDS.admin} · Mishlav ${DEMO_PHONES.mishlav} / ${DEMO_PASSWORDS.mishlav}\n`);
  const stop = async () => {
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
