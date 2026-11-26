import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findRepoRoot, loadSettings } from "@mishlav/shared";
import type { AppConfig } from "../src/config";
import { buildServer } from "../src/server";
import { LogOnlyWhatsApp } from "../src/whatsapp";

export const SECRET = "test-secret-0123456789abcdef";
export const AUTH = { "x-tools-secret": SECRET };

/** Sunday 2026-11-08 10:00 Asia/Jerusalem */
export const FIXED_NOW = new Date("2026-11-08T08:00:00.000Z");

export function testConfig(): AppConfig {
  const repoRoot = findRepoRoot(__dirname);
  const settings = loadSettings(join(repoRoot, "config", "settings.yaml"));
  // the test study days (tests/fixtures/days) link to example.com: the WhatsApp button's prefix follows them
  settings.whatsapp.url_prefix = "https://example.com/mishlav/purchase/";
  return {
    repoRoot,
    port: 0,
    host: "127.0.0.1",
    toolsSecret: SECRET,
    logDir: mkdtempSync(join(tmpdir(), "mishlav-logs-")),
    knowledgeDir: join(repoRoot, "config", "knowledge"),
    offlineDaysDir: join(repoRoot, "tests", "fixtures", "days"),
    settings,
  };
}

export async function testServer(now: () => Date = () => FIXED_NOW) {
  const config = testConfig();
  // never a real WhatsApp from a test, whatever is in the env
  const app = await buildServer(config, { now, logger: false, whatsapp: new LogOnlyWhatsApp(() => {}) });
  return { app, config };
}
