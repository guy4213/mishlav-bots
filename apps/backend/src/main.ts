import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { loadAppConfig } from "./config";
import { buildServer } from "./server";

/** NGROK_AUTHTOKEN, else the token saved by `ngrok config add-authtoken` (v2 or v3 config). */
function ngrokAuthtoken(): string | undefined {
  if (process.env.NGROK_AUTHTOKEN) return process.env.NGROK_AUTHTOKEN;
  const candidates = [
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "ngrok", "ngrok.yml"),
    join(homedir(), ".config", "ngrok", "ngrok.yml"),
    join(homedir(), "Library", "Application Support", "ngrok", "ngrok.yml"),
    join(homedir(), ".ngrok2", "ngrok.yml"),
  ].filter((p): p is string => !!p);
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      const cfg = parseYaml(readFileSync(file, "utf8")) as { authtoken?: string; agent?: { authtoken?: string } };
      const token = cfg?.agent?.authtoken ?? cfg?.authtoken;
      if (token) return token;
    } catch {
      // unreadable config: fall through
    }
  }
  return undefined;
}

async function openTunnel(port: number): Promise<string | null> {
  const authtoken = ngrokAuthtoken();
  if (!authtoken) {
    console.warn(
      "--tunnel: no ngrok authtoken (set NGROK_AUTHTOKEN or run `ngrok config add-authtoken`). " +
        "Or run `ngrok http 127.0.0.1:%d` in another terminal.",
      port,
    );
    return null;
  }
  try {
    const ngrok = await import("@ngrok/ngrok");
    const listener = await ngrok.forward({ addr: `127.0.0.1:${port}`, authtoken });
    return listener.url();
  } catch (err) {
    console.warn("--tunnel: could not start @ngrok/ngrok (%s). Use the ngrok CLI instead.", (err as Error).message);
    return null;
  }
}

async function main() {
  const config = loadAppConfig();
  const app = await buildServer(config, { logger: { level: process.env.LOG_LEVEL ?? "info" } });
  await app.listen({ port: config.port, host: config.host });

  const local = `http://127.0.0.1:${config.port}`;
  const publicUrl = process.argv.includes("--tunnel") ? await openTunnel(config.port) : null;
  const base = publicUrl ?? local;

  console.log("\nMishlav tools server (test mode)");
  console.log(`  local:   ${local}`);
  if (publicUrl) console.log(`  public:  ${publicUrl}`);
  console.log(`  logs:    ${config.logDir}`);
  console.log(`  capture_dictated_details: ${config.settings.testing.capture_dictated_details}`);
  console.log(`  tools:   ${base}/tools/{get_day_info,send_purchase_link,schedule_callback,request_human,end_call}`);
  console.log("  auth:    header X-Tools-Secret: <TOOLS_SECRET>\n");

  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
