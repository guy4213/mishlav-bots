import { join } from "node:path";
import { LOG_FILES } from "@mishlav/shared";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { presentedSecret, secretMatches } from "./auth";
import type { AppConfig } from "./config";
import { JsonlFile } from "./jsonl";
import { loadKnowledge } from "./knowledge";
import { registerTestRoutes } from "./routes/test";
import { registerToolRoutes } from "./routes/tools";
import { SessionStore } from "./sessions";

export interface BuildOptions {
  now?: () => Date;
  logger?: FastifyServerOptions["logger"];
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

  // Shared-secret auth on everything except /healthz.
  app.addHook("onRequest", async (req, reply) => {
    if (req.url === "/healthz" || req.url.startsWith("/healthz?")) return;
    if (!secretMatches(presentedSecret(req), config.toolsSecret)) {
      toolLog.append({ type: "auth_failure", ts: now().toISOString(), path: req.url.split("?")[0], ip: req.ip });
      return reply.code(401).send({ ok: false, error: "unauthorized" });
    }
  });

  await registerToolRoutes(app, { knowledge, settings: config.settings, now, toolLog, sessions });
  await registerTestRoutes(app, { sessions, toolLog, metricsLog, now });

  return app;
}
