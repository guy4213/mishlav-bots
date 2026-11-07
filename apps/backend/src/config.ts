import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { findRepoRoot, loadSettings, type Settings } from "@mishlav/shared";

export interface AppConfig {
  repoRoot: string;
  port: number;
  host: string;
  toolsSecret: string;
  logDir: string;
  knowledgeDir: string;
  settings: Settings;
}

/** Load `.env` from the repo root (if present) without overriding real env vars. */
export function loadDotEnv(repoRoot: string): void {
  const file = join(repoRoot, ".env");
  if (existsSync(file)) process.loadEnvFile(file);
}

export function loadAppConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const repoRoot = findRepoRoot();
  loadDotEnv(repoRoot);

  const toolsSecret = env.TOOLS_SECRET ?? "";
  if (toolsSecret.length < 16 || toolsSecret === "change-me-to-a-long-random-string") {
    throw new Error("TOOLS_SECRET must be set (>= 16 chars). Copy .env.example to .env and generate one.");
  }

  const settings = loadSettings(join(repoRoot, "config", "settings.yaml"));
  const logDirRaw = env.LOG_DIR ?? settings.testing.log_dir;

  return {
    repoRoot,
    port: Number(env.PORT ?? 8787),
    host: env.HOST ?? "127.0.0.1",
    toolsSecret,
    logDir: isAbsolute(logDirRaw) ? logDirRaw : resolve(repoRoot, logDirRaw),
    knowledgeDir: join(repoRoot, "config", "knowledge"),
    settings,
  };
}
