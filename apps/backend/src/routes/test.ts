import { MetricsInput, SessionStartInput, ToolCallLogEntry, type MetricsLogEntry } from "@mishlav/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { JsonlFile } from "../jsonl";
import type { SessionStore } from "../sessions";

export interface TestRouteDeps {
  sessions: SessionStore;
  toolLog: JsonlFile;
  metricsLog: JsonlFile;
  now: () => Date;
}

const badRequest = (error: z.ZodError) => ({ ok: false, error: "invalid_params", details: z.prettifyError(error) });

/** Test-session plumbing used during Part 3 calls. */
export async function registerTestRoutes(app: FastifyInstance, deps: TestRouteDeps): Promise<void> {
  app.post("/test/session", async (req, reply) => {
    const parsed = SessionStartInput.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send(badRequest(parsed.error));
    return { ok: true, session: deps.sessions.start(parsed.data) };
  });

  app.post("/test/session/end", async () => ({ ok: true, ended: deps.sessions.end() }));

  app.get("/test/session", async () => ({ ok: true, session: deps.sessions.current() }));

  app.post("/test/metrics", async (req, reply) => {
    const parsed = MetricsInput.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send(badRequest(parsed.error));
    const entry: MetricsLogEntry = {
      type: "metrics",
      ts: deps.now().toISOString(),
      ...parsed.data,
      session_id: parsed.data.session_id ?? deps.sessions.current()?.session_id ?? null,
    };
    deps.metricsLog.append(entry);
    return { ok: true, session_id: entry.session_id };
  });

  app.get("/test/calls", async (req) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const sessionId = q.session_id ?? deps.sessions.current()?.session_id ?? null;
    const calls = deps.toolLog
      .readAll()
      .map((l) => ToolCallLogEntry.safeParse(l))
      .filter((r) => r.success)
      .map((r) => r.data)
      .filter((e) => e.session_id === sessionId)
      .map(({ ts, tool, params, ok, error, response, call_id, provider }) => ({
        ts,
        tool,
        params,
        ok,
        error,
        response,
        call_id,
        provider,
      }));
    return { ok: true, session_id: sessionId, count: calls.length, calls };
  });
}
