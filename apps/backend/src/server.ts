import { join } from "node:path";
import { LOG_FILES } from "@mishlav/shared";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { mayCall } from "./access";
import { presentedSecret, secretMatches } from "./auth";
import type { AppConfig } from "./config";
import { type AdminStore, ContactEvents, type ContactStore, type DialerStore } from "./contacts";
import { Dialer, parseOnlyNumbers } from "./dialer";
import type { GenderClassifier } from "./gender";
import { JsonlFile } from "./jsonl";
import { type KnowledgeBase, loadGeneral, loadKnowledge } from "./knowledge";
import { registerAdminRoutes } from "./routes/admin";
import { registerAuthRoutes } from "./routes/auth";
import { isDashboardFile, registerDashboardRoutes } from "./routes/dashboard";
import { GOLD_CHANGES_PATH, registerGoldRoutes } from "./routes/gold";
import { type PhoneHolder, registerPhoneRoutes } from "./routes/phone";
import { registerStudyDayRoutes } from "./routes/study-days";
import { registerTestRoutes } from "./routes/test";
import { registerToolRoutes } from "./routes/tools";
import { type LogStore, pinoText, ServerLog, tapConsole } from "./serverlog";
import { SessionStore } from "./sessions";
import { type SmsSender, smsSenderFromEnv } from "./sms";
import { LiveKnowledge, type StudyDayStore } from "./study-days";
import { publicUser, type UserStore, Users } from "./users";

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
  /** Where the dashboard's log is kept, so a deploy doesn't wipe it (main.ts: Supabase server_logs). */
  logStore?: LogStore;
  /**
   * The study days in Supabase (main.ts: the same store): the bot reads them at start and every minute, the dashboard
   * edits them. None: the fixed days of config.offlineDaysDir (tests, text runs).
   */
  studyDays?: StudyDayStore;
  /** Who may log in to the dashboard (main.ts: the same Supabase store). None: TOOLS_SECRET only. */
  users?: UserStore;
  /** main.ts only: the process's console output goes into the dashboard's log too */
  tapConsole?: boolean;
}

/** Paths without a login: health check, the dashboard's static files (no data), logging in / out, and the Gold API
 * (its own key, routes/gold.ts). */
function isPublic(url: string): boolean {
  const path = url.split("?")[0]!;
  return path === "/healthz" || path === GOLD_CHANGES_PATH || path === "/auth/login" || path === "/auth/logout" || isDashboardFile(path);
}

export async function buildServer(config: AppConfig, opts: BuildOptions = {}): Promise<FastifyInstance> {
  const now = opts.now ?? (() => new Date());
  const toolLog = new JsonlFile(join(config.logDir, LOG_FILES.toolCalls));
  const metricsLog = new JsonlFile(join(config.logDir, LOG_FILES.metrics));
  const sessions = new SessionStore(new JsonlFile(join(config.logDir, LOG_FILES.sessions)), now);

  // the server's own warnings and errors (Fastify / pino, every request's logger included) go into the dashboard's
  // log as well; serverLog is created below, after the app
  const tap: { log: ServerLog | null } = { log: null };
  const baseLogger = opts.logger ?? { level: "info" };
  const logger =
    baseLogger && typeof baseLogger === "object"
      ? {
          ...baseLogger,
          hooks: {
            logMethod(this: unknown, args: unknown[], method: (...a: unknown[]) => void, level: number) {
              const first = args[0] as { inLog?: boolean } | undefined;
              if (level >= 40 && tap.log && !(first && typeof first === "object" && first.inLog)) {
                tap.log.push(level >= 50 ? "error" : "server", pinoText(args));
              }
              return method.apply(this, args);
            },
          },
        }
      : baseLogger;
  const app = Fastify({
    logger,
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

  let knowledge: KnowledgeBase = { days: new Map(), general: "" }; // set below, before the server listens
  let liveDays: LiveKnowledge | undefined;
  app.get("/healthz", async () => ({
    ok: true,
    service: "mishlav-tools-server",
    mode: "test",
    days: knowledge.days.size,
    days_source: liveDays ? "supabase" : "files",
    session: sessions.current()?.session_id ?? null,
  }));

  // Everything but the public paths needs TOOLS_SECRET (the bot, the worker, scripts, `npm run lab`: all of it) or a
  // logged-in dashboard user, who may call what their role allows (access.ts).
  const users = opts.users ? new Users(opts.users, config.toolsSecret) : undefined;
  app.decorateRequest("principal", null);
  app.addHook("onRequest", async (req, reply) => {
    if (isPublic(req.url)) return;
    const path = req.url.split("?")[0]!;
    if (secretMatches(presentedSecret(req), config.toolsSecret)) {
      req.principal = { role: "admin", via: "secret", user: null };
      return;
    }
    let user = null;
    try {
      user = users ? await users.fromRequest(req) : null;
    } catch {
      return reply.code(503).send({ ok: false, error: "users_unavailable", message_he: "לא ניתן לבדוק את הכניסה כרגע (Supabase). נסה שוב בעוד דקה." });
    }
    if (!user) {
      toolLog.append({ type: "auth_failure", ts: now().toISOString(), path, ip: req.ip });
      return reply.code(401).send({ ok: false, error: "unauthorized" });
    }
    if (!mayCall(user.role, req.method, path)) {
      return reply.code(403).send({ ok: false, error: "forbidden", message_he: "אין לך הרשאה לפעולה הזו" });
    }
    req.principal = { role: user.role, via: "session", user: publicUser(user) };
  });

  const phone = opts.phone ?? { line: null, reason: "not started" };
  const env = opts.env ?? process.env;
  // the dashboard's live log of this server: the phone line + the events below (GET /api/admin/logs)
  const serverLog = new ServerLog(phone, now, undefined, opts.logStore);
  tap.log = serverLog;
  if (opts.tapConsole) {
    const untap = tapConsole(serverLog);
    app.addHook("onClose", async () => untap());
  }
  serverLog.start();

  // the study days: Supabase (refreshed every minute and after each dashboard change), else the fixed files.
  // A server that can't read them at start doesn't start (Render then keeps the previous deploy running).
  if (opts.studyDays) {
    const live = new LiveKnowledge(opts.studyDays, loadGeneral(config.knowledgeDir), (kind, text) => serverLog.push(kind, text));
    try {
      await live.refresh();
    } catch (err) {
      throw new Error(
        `could not read the study days from Supabase (is migration 20261124000000_study_days applied?): ${(err as Error).message}`,
      );
    }
    live.start();
    app.addHook("onClose", async () => live.stop());
    liveDays = live;
    knowledge = live;
  } else {
    knowledge = loadKnowledge(config.knowledgeDir, config.offlineDaysDir);
  }
  // recordings older than settings.recordings.retention_days are deleted: at start, then every 12 h (0: kept for good)
  const admin = opts.admin;
  if (admin?.pruneRecordings && config.settings.recordings.retention_days > 0) {
    const prune = () => {
      const before = new Date(now().getTime() - config.settings.recordings.retention_days * 86400000);
      admin.pruneRecordings!(before)
        .then((n) => n && serverLog.push("server", `deleted ${n} recordings older than ${config.settings.recordings.retention_days} days`))
        .catch((err) => serverLog.push("error", `could not delete old recordings: ${(err as Error).message}`));
    };
    const timer = setInterval(prune, 12 * 3600 * 1000);
    timer.unref();
    app.addHook("onReady", async () => prune());
    app.addHook("onClose", async () => clearInterval(timer));
  }
  app.addHook("onClose", async () => serverLog.stop()); // what is left goes to the store
  const transcriptsDir = join(config.logDir, "transcripts");

  // a failed Supabase update is logged next to the tool calls (the dashboard's call view and logs show it)
  const contacts = opts.contacts
    ? new ContactEvents(opts.contacts, (callId, what, err) => {
        toolLog.append({ type: "supabase_error", ts: now().toISOString(), call_id: callId, what, error: err.message });
        serverLog.push("error", `Supabase (${what}): ${err.message}`, callId);
        app.log.error({ err, call_id: callId, what, inLog: true }, "supabase update failed"); // already in the log above
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
    settings: config.settings,
  });
  await registerDashboardRoutes(app, { config, sessions, now, env: opts.env, manualInputsPath: opts.manualInputsPath });
  await registerPhoneRoutes(app, phone, { contacts, settings: config.settings, transcriptsDir, knowledge: () => knowledge, now });
  await registerAuthRoutes(app, { users, now, log: (text) => serverLog.push("server", text) });
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
  await registerStudyDayRoutes(app, { studyDays: opts.studyDays && liveDays && { store: opts.studyDays, live: liveDays }, now });
  await registerGoldRoutes(app, {
    contacts: opts.contacts,
    settings: config.settings,
    apiKey: (opts.env ?? process.env).GOLD_API_KEY?.trim() || undefined,
  });

  return app;
}
