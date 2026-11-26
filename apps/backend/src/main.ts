import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { type AppConfig, loadAppConfig } from "./config";
import { contactStoreFromEnv } from "./contacts";
import { geminiGenderClassifier } from "./gender";
import { startKeepAlive } from "./keepalive";
import type { PhoneHolder } from "./routes/phone";
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

/**
 * The Zadarma line in this process (dashboard "call" button), when ZADARMA_SIP_* are set and PHONE_LINE
 * isn't 0. Only one program may be registered on the extension: set PHONE_LINE=0 where another one runs.
 * A failed registration is retried every minute; the reason shows on the dashboard meanwhile.
 */
async function startPhoneLine(config: AppConfig, holder: PhoneHolder): Promise<void> {
  if (process.env.PHONE_LINE === "0") {
    holder.reason = "PHONE_LINE=0";
    return;
  }
  const { PhoneLine, phoneEnv, missingPhoneEnv } = await import("../../phone/src/line.js");
  const env = phoneEnv({ ...process.env, PORT: String(config.port), LOG_DIR: config.logDir }, config.repoRoot);
  const missing = missingPhoneEnv(env);
  if (missing.length) {
    holder.reason = `חסר במשתני הסביבה: ${missing.join(", ")}`;
    return;
  }
  const line = new PhoneLine({ root: config.repoRoot, env });
  line.on("log", ({ text }) => console.log(`[phone] ${text}`));
  holder.onLine?.(line); // incoming calls are kept in the call history (routes/phone.ts)
  const attempt = async () => {
    try {
      await line.start();
      holder.line = line;
      holder.reason = null;
    } catch (err) {
      holder.reason = `${(err as Error).message} (מנסה שוב בעוד דקה)`;
      console.warn(`[phone] ${holder.reason}`);
      setTimeout(attempt, 60_000).unref();
    }
  };
  holder.reason = "נרשם בזדארמה...";
  await attempt();
}

async function main() {
  const config = loadAppConfig();
  const phone: PhoneHolder = { line: null, reason: "starting" };
  const googleKey = process.env.GOOGLE_API_KEY;
  const contacts = contactStoreFromEnv(process.env);
  const app = await buildServer(config, {
    logger: { level: process.env.LOG_LEVEL ?? "info" },
    phone,
    // the customer's gender from the first name, once before each call (no key: neutral wording)
    classifyGender: googleKey ? geminiGenderClassifier({ apiKey: googleKey }) : undefined,
    // the contacts the bot calls and updates (none without SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)
    contacts,
    // what the management dashboard reads (calls, rep tasks, the day's summary): the same Supabase
    admin: contacts,
    // the automatic dialer: on/off in Supabase (starts off; the dashboard turns it on); its loop runs from now on
    dialer: contacts && { store: contacts, run: true },
    // the automatic-dialing test (admins, dashboard): off after every start, the TEST- contacts only
    testDialer: contacts && { store: contacts, run: true },
    // the dashboard's log: kept in Supabase (14 days) and fed by the server's own output too
    logStore: contacts,
    // the study days the bot offers: Supabase study_days, edited in the dashboard
    studyDays: contacts,
    // who may log in to the dashboard (Supabase dashboard_users); TOOLS_SECRET keeps working
    users: contacts,
    tapConsole: true,
  });
  await app.listen({ port: config.port, host: config.host });
  // in the background: registration takes a few seconds and must not hold the server (or Render's port check)
  startPhoneLine(config, phone).catch((err) => {
    phone.reason = (err as Error).message;
    console.warn(`[phone] ${phone.reason}`);
  });

  const local = `http://127.0.0.1:${config.port}`;
  const publicUrl = process.argv.includes("--tunnel") ? await openTunnel(config.port) : null;
  const base = publicUrl ?? local;

  console.log("\nMishlav tools server (test mode)");
  console.log(`  local:   ${local}`);
  if (publicUrl) console.log(`  public:  ${publicUrl}`);
  console.log(`  logs:    ${config.logDir}`);
  console.log(`  capture_dictated_details: ${config.settings.testing.capture_dictated_details}`);
  console.log(`  supabase: ${process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY ? `contacts at ${process.env.SUPABASE_URL}` : "off (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set)"}`);
  console.log(`  tools:   ${base}/tools/{get_day_info,send_purchase_link,schedule_callback,request_human,end_call}`);
  console.log("  auth:    header X-Tools-Secret: <TOOLS_SECRET>");
  console.log(`  gold:    ${base}/api/gold/changes?since=<ISO> ${process.env.GOLD_API_KEY ? "(header X-Api-Key: <GOLD_API_KEY>)" : "off (GOLD_API_KEY not set)"}`);
  console.log(`  dashboard: ${base}/dashboard`);
  console.log(`  phone:   ${phone.line ? "Zadarma line registered" : (phone.reason ?? "off")}`);
  // Render's free plan sleeps after 15 min without a visitor: the server knocks on its own address every 10 min
  const keepAlive = startKeepAlive(process.env);
  console.log(`  awake:   ${keepAlive ? `keep-alive every 10 min (${keepAlive.url})` : "no keep-alive (not on Render; KEEPALIVE_URL to set one)"}`);
  const only = process.env.DIALER_ONLY_NUMBERS?.trim() ? " · only DIALER_ONLY_NUMBERS" : "";
  console.log(`  dialer:  ${contacts ? `on/off from the dashboard (${base}/api/admin/dialer)${only}` : "off (no Supabase)"}\n`);

  const shutdown = async () => {
    await app.close(); // ends the dialer's loop first (its switch in Supabase stays as it is)
    await phone.line?.stop(); // unregister, so incoming calls don't ring a dead address
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
