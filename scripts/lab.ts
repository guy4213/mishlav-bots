/**
 * One command for provider testing:  npm run lab
 *
 * Starts the tools server (unless one is already running), the voice worker (provider C, Gemini Live)
 * when LiveKit keys are present, and opens the dashboard in the browser. Ctrl+C stops everything.
 *
 *   npm run lab -- --no-worker     tools server + dashboard only
 *   npm run lab -- --no-open       don't open the browser
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { scriptEnv } from "./lib/env";

const { values } = parseArgs({
  options: {
    "no-worker": { type: "boolean", default: false },
    "no-open": { type: "boolean", default: false },
  },
});

const env = scriptEnv();
const children: ChildProcess[] = [];
const isWin = process.platform === "win32";

function run(label: string, command: string, cwd: string, extraEnv: Record<string, string> = {}): ChildProcess {
  const child = spawn(command, { cwd, shell: true, env: { ...process.env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
  const prefix = (chunk: Buffer) =>
    chunk
      .toString("utf8")
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .forEach((l) => console.log(`[${label}] ${l}`));
  child.stdout?.on("data", prefix);
  child.stderr?.on("data", prefix);
  child.on("exit", (code) => console.log(`[${label}] exited (${code ?? "signal"})`));
  children.push(child);
  return child;
}

async function healthy(): Promise<boolean> {
  try {
    const r = await fetch(`${env.baseUrl}/healthz`);
    return r.ok;
  } catch {
    return false;
  }
}

async function waitHealthy(timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await healthy()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function openBrowser(url: string) {
  if (isWin) spawn("cmd", ["/c", "start", '""', `"${url}"`], { shell: true, stdio: "ignore", detached: true });
  else spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { stdio: "ignore", detached: true });
}

function stopAll() {
  for (const c of children) {
    if (c.exitCode !== null || !c.pid) continue;
    if (isWin) spawnSync("taskkill", ["/pid", String(c.pid), "/T", "/F"], { stdio: "ignore" });
    else c.kill("SIGTERM");
  }
}

async function main() {
  if (!env.secret) throw new Error("TOOLS_SECRET is missing in .env");

  if (await healthy()) {
    console.log(`[lab] tools server already running at ${env.baseUrl}`);
  } else {
    // warn: keep the lab window readable (the dashboard polls every 1.5s)
    run("server", "npm run start -w @mishlav/backend", env.root, { LOG_LEVEL: process.env.LOG_LEVEL ?? "warn" });
    if (!(await waitHealthy(60_000))) throw new Error("tools server did not start within 60s (see [server] lines above)");
  }

  const livekit = process.env.LIVEKIT_URL && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET;
  if (values["no-worker"]) {
    console.log("[lab] --no-worker: voice worker not started");
  } else if (!livekit) {
    console.log("[lab] LiveKit keys missing in .env -> voice worker not started (the dashboard shows what is missing)");
  } else {
    if (!process.env.GOOGLE_API_KEY) console.log("[lab] warning: GOOGLE_API_KEY is empty — the bot will fail to talk to Gemini");
    run("bot", "uv run agent.py dev --log-level info", join(env.root, "apps", "voice-worker"));
  }

  const url = `${env.baseUrl}/dashboard#k=${encodeURIComponent(env.secret)}`;
  console.log(`\n[lab] dashboard: ${env.baseUrl}/dashboard   (Ctrl+C to stop everything)\n`);
  if (!values["no-open"]) openBrowser(url);

  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => resolve());
    process.on("SIGTERM", () => resolve());
  });
}

main()
  .catch((err) => {
    console.error(`[lab] ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  })
  .finally(() => {
    stopAll();
    setTimeout(() => process.exit(), 300);
  });
