/**
 * One command for provider testing:  npm run lab
 *
 * Starts the tools server (unless one is already running) and, depending on the keys in .env:
 *   - provider C: the LiveKit voice worker with Gemini Live (agent mishlav-c)
 *   - provider B: the same worker with Soniox + LLM + ElevenLabs TTS (agent mishlav-b)
 *   - provider A: an ngrok tunnel to the tools server + re-sync of the ElevenLabs agent's tool URLs
 * then opens the dashboard in the browser. Ctrl+C stops everything.
 *
 *   npm run lab -- --no-worker     no LiveKit workers (B/C)
 *   npm run lab -- --no-tunnel     no ngrok / ElevenLabs sync (A)
 *   npm run lab -- --no-open       don't open the browser
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { elevenKey, syncAgent } from "./lib/elevenlabs";
import { scriptEnv } from "./lib/env";
import { openTunnel, type Tunnel } from "./lib/tunnel";

const { values } = parseArgs({
  options: {
    "no-worker": { type: "boolean", default: false },
    "no-tunnel": { type: "boolean", default: false },
    "no-open": { type: "boolean", default: false },
  },
});

const env = scriptEnv();
const children: ChildProcess[] = [];
let tunnel: Tunnel | null = null;
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
  tunnel?.close().catch(() => {});
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

  const e = process.env;
  const livekit = e.LIVEKIT_URL && e.LIVEKIT_API_KEY && e.LIVEKIT_API_SECRET;
  const workerDir = join(env.root, "apps", "voice-worker");
  if (values["no-worker"]) {
    console.log("[lab] --no-worker: voice workers not started");
  } else if (!livekit) {
    console.log("[lab] LiveKit keys missing in .env -> voice workers (B, C) not started (the dashboard shows what is missing)");
  } else {
    if (!e.GOOGLE_API_KEY) console.log("[lab] warning: GOOGLE_API_KEY is empty — provider C will fail to talk to Gemini");
    run("bot-C", "uv run agent.py dev --log-level info", workerDir, { VOICE_PROVIDER: "gemini", AGENT_NAME: e.AGENT_NAME ?? "mishlav-c" });
    const bKeys = e.SONIOX_API_KEY && elevenKey() && e.GOOGLE_API_KEY;
    if (bKeys) {
      // its own health port: two `dev` workers on one machine
      run("bot-B", "uv run agent.py dev --log-level info", workerDir, {
        VOICE_PROVIDER: "soniox_eleven",
        AGENT_NAME: e.AGENT_NAME_B ?? "mishlav-b",
        WORKER_PORT: e.WORKER_PORT_B ?? "8082",
      });
    } else {
      console.log("[lab] provider B not started (needs SONIOX_API_KEY + ElevenLabs key + GOOGLE_API_KEY)");
    }
  }

  // provider A: ElevenLabs calls our tools from the internet -> tunnel + point the agent's tools at it
  const key = elevenKey();
  if (values["no-tunnel"]) {
    console.log("[lab] --no-tunnel: provider A (ElevenLabs) not connected");
  } else if (key) {
    try {
      tunnel = await openTunnel(Number(new URL(env.baseUrl).port || 8787));
      console.log(`[lab] tunnel: ${tunnel.url} -> ${env.baseUrl}`);
      const state = await syncAgent({ root: env.root, key, toolsUrl: tunnel.url, secret: env.secret, log: (m) => console.log(`[eleven] ${m}`) });
      console.log(`[lab] ElevenLabs agent ${state.agent_id} ready (provider A)`);
    } catch (err) {
      console.log(`[lab] provider A not ready: ${err instanceof Error ? err.message : err}`);
    }
  }

  const url = `${env.baseUrl}/dashboard#k=${encodeURIComponent(env.secret)}`;
  console.log(`\n[lab] dashboard: ${env.baseUrl}/dashboard   (Ctrl+C to stop everything)\n`);
  if (!values["no-open"]) openBrowser(url);

  await new Promise<void>((resolve) => {
    // keep the process (and the tunnel) alive even when there are no child processes to wait on
    const keepAlive = setInterval(() => {}, 60_000);
    const stop = () => { clearInterval(keepAlive); resolve(); };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
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
