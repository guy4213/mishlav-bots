import { join } from "node:path";
import { LOG_FILES } from "@mishlav/shared";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { presentedSecret, secretMatches } from "./auth";
import type { AppConfig } from "./config";
import { type AdminStore, ContactEvents, type ContactStore, type DialerStore } from "./contacts";
import { Dialer, parseOnlyNumbers } from "./dialer";
import type { GenderClassifier } from "./gender";
import { JsonlFile } from "./jsonl";
import { loadKnowledge } from "./knowledge";
import { registerAdminRoutes } from "./routes/admin";
import { isDashboardFile, registerDashboardRoutes } from "./routes/dashboard";
import { GOLD_CHANGES_PATH, registerGoldRoutes } from "./routes/gold";
import { type PhoneHolder, registerPhoneRoutes } from "./routes/phone";
import { registerTestRoutes } from "./routes/test";
import { registerToolRoutes } from "./routes/tools";
import { ServerLog } from "./serverlog";
import { SessionStore } from "./sessions";
import { type SmsSender, smsSenderFromEnv } from "./sms";

export interface BuildOptions {
  now?: () => Date;
  logger?: FastifyServerOptions["logger"];
  /** Env used by the dashboard (LiveKit / Gemini keys) and the Gold API (GOLD_API_KEY). Default: process.env. */
  env?: NodeJS.ProcessEnv;
  /** Where the dashboard keeps manual inputs. Default: tests/results/manual-inputs.yaml. */
  manualInputsPath?: string;
  /** The Zadarma line, filled in by main.ts once the server listens (null = no line). */
  phone?: PhoneHolder;
  /** Supabase contacts (main.ts: from SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY). None: scenario tests only. */
  contacts?: ContactStore;
  /** What the management dashboard reads: calls, rep tasks, the summary (main.ts: the same Supabase store). */
  admin?: AdminStore;
  /** Customer gender from the first name before a call (main.ts: Gemini). None: "unknown" (neutral wording). */
  classifyGender?: GenderClassifier;
  /**
   * The automatic dialer (dialer.ts), with `contacts`: its switch and queue in Supabase (main.ts: the same store).
   * run: start its loop when the server is ready (main.ts only; tests drive it through the routes).
   */
  dialer?: { store: DialerStore; run?: boolean };
  /** The purchase-link SMS. Default: from the env (ZADARMA_API_KEY + ZADARMA_API_SECRET), else log only. */
  sms?: SmsSender;
}

/** Paths without TOOLS_SECRET: health check, the dashboard's static files (no data; the page sends the secret),
 * and the Gold API (its own key, routes/gold.ts). */
function isPublic(url: string): boolean {
  const path = url.split("?")[0]!;
  return path === "/healthz" || path === GOLD_CHANGES_PATH || isDashboardFile(path);
}

export async function buildServer(config: AppConfig, opts: BuildOptions = {}): Promise<FastifyInstance> {
  const now = opts.now ?? (() => new Date());
  const knowledge = loadKnowledge(config.knowledgeDir);
  const toolLog = new JsonlFile(join(config.logDir, LOG_FILES.toolCalls));
  const metricsLog = new JsonlFile(join(config.logDir, LOG_FILES.metrics));
  const sessions = new SessionStore(new JsonlFile(join(config.logDir, LOG_FILES.sessions)), now);

  const app = Fastify({
    logger: opts.logger ?? { level: "info" },
    bodyLimit: 64 * 1024,
    trustProxy: true, // behind ngrok
  });

  // Providers sometimes POST an empty body with content-type JSON (e.g. end_call with no params).
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    const text = typeof body === "string" ? body : body.toString("utf8");
    if (text.trim() === "") return done(null, {});
    try {
      done(null, JSON.parse(text));
    } catch {
      const err = new Error("Malformed JSON body") as Error & { statusCode: number };
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  app.get("/healthz", async () => ({
    ok: true,
    service: "mishlav-tools-server",
    mode: "test",
    days: knowledge.days.size,
    session: sessions.current()?.session_id ?? null,
  }));

  // Shared-secret auth on everything except the public paths.
  app.addHook("onRequest", async (req, reply) => {
    if (isPublic(req.url)) return;
    if (!secretMatches(presentedSecret(req), config.toolsSecret)) {
      toolLog.append({ type: "auth_failure", ts: now().toISOString(), path: req.url.split("?")[0], ip: req.ip });
      return reply.code(401).send({ ok: false, error: "unauthorized" });
    }
  });

  const phone = opts.phone ?? { line: null, reason: "not started" };
  const env = opts.env ?? process.env;
  // the dashboard's live log of this server: the phone line + the events below (GET /api/admin/logs)
  const serverLog = new ServerLog(phone, now);
  const transcriptsDir = join(config.logDir, "transcripts");

  // a failed Supabase update is logged next to the tool calls (the dashboard's call view and logs show it)
  const contacts = opts.contacts
    ? new ContactEvents(opts.contacts, (callId, what, err) => {
        toolLog.append({ type: "supabase_error", ts: now().toISOString(), call_id: callId, what, error: err.message });
        serverLog.push("error", `Supabase (${what}): ${err.message}`, callId);
        app.log.error({ err, call_id: callId, what }, "supabase update failed");
      })
    : undefined;
  const dialer =
    contacts && opts.dialer
      ? new Dialer({
          store: opts.dialer.store,
          events: contacts,
          phone,
          settings: config.settings,
          now,
          onlyNumbers: parseOnlyNumbers(env.DIALER_ONLY_NUMBERS, (t) => app.log.warn(t)),
          log: (text, kind) => {
            serverLog.push(kind ?? "dialer", `[dialer] ${text}`);
            app.log.info(`[dialer] ${text}`);
          },
          transcriptsDir,
        })
      : undefined;
  if (dialer && opts.dialer?.run) {
    app.addHook("onReady", async () => dialer.run());
    app.addHook("onClose", async () => dialer.shutdown()); // the loop only: the switch in the database stays
  }
  const sms =
    opts.sms ??
    smsSenderFromEnv(env, (text) => {
      serverLog.push("sms", `[sms] ${text}`); // numbers are masked by the sender
      app.log.info(`[sms] ${text}`);
    });
  await registerToolRoutes(app, {
    knowledge,
    settings: config.settings,
    now,
    toolLog,
    sessions,
    contacts,
    phone,
    sms,
    onToolCall: (callId, tool, ok, error) => serverLog.push(ok ? "tool" : "error", `🔧 ${tool} ${ok ? "✓" : `✗ ${error ?? ""}`}`, callId),
  });
  await registerTestRoutes(app, {
    sessions,
    toolLog,
    metricsLog,
    now,
    knowledge,
    scenariosDir: join(config.repoRoot, "tests", "scenarios"),
    botName: (opts.env ?? process.env).BOT_NAME,
    classifyGender: opts.classifyGender,
  });
  await registerDashboardRoutes(app, { config, sessions, now, env: opts.env, manualInputsPath: opts.manualInputsPath });
  await registerPhoneRoutes(app, phone, { contacts, settings: config.settings, transcriptsDir });
  await registerAdminRoutes(app, {
    dialer,
    contacts: opts.contacts,
    admin: opts.admin,
    phone,
    serverLog,
    toolLog,
    transcriptsDir,
    settings: config.settings,
    env,
    sms,
    now,
  });
  await registerGoldRoutes(app, {
    contacts: opts.contacts,
    settings: config.settings,
    apiKey: (opts.env ?? process.env).GOLD_API_KEY?.trim() || undefined,
  });

  return app;
}
