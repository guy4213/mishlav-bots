import { join, resolve } from "node:path";
import { findRepoRoot, loadDotEnvFile, loadSettings, type Settings } from "@mishlav/shared";

export interface ScriptEnv {
  root: string;
  settings: Settings;
  logDir: string;
  scenariosDir: string;
  baseUrl: string;
  secret: string | undefined;
}

export function scriptEnv(overrides: { baseUrl?: string; logDir?: string } = {}): ScriptEnv {
  const root = findRepoRoot();
  loadDotEnvFile(join(root, ".env"));
  const settings = loadSettings(join(root, "config", "settings.yaml"));
  return {
    root,
    settings,
    logDir: overrides.logDir ?? resolve(root, process.env.LOG_DIR ?? settings.testing.log_dir),
    scenariosDir: join(root, "tests", "scenarios"),
    baseUrl: (overrides.baseUrl ?? process.env.TOOLS_BASE_URL ?? "http://127.0.0.1:8787").replace(/\/+$/, ""),
    secret: process.env.TOOLS_SECRET,
  };
}

/** Authenticated JSON request to the tools server. */
export async function api<T = unknown>(
  env: ScriptEnv,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: T }> {
  if (!env.secret) throw new Error("TOOLS_SECRET is not set (.env)");
  let res: Response;
  try {
    res = await fetch(env.baseUrl + path, {
      method,
      headers: {
        "x-tools-secret": env.secret,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        "ngrok-skip-browser-warning": "1",
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(`Cannot reach ${env.baseUrl} — is the server running? (npm run dev) [${(err as Error).message}]`);
  }
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json: json as T };
}
