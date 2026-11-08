import { MetricsInput, SessionStartInput, ToolCallLogEntry, type MetricsLogEntry } from "@mishlav/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { loadScenarios } from "../../../../scripts/lib/scenarios";
import { buildCallVariables } from "../context";
import type { JsonlFile } from "../jsonl";
import type { KnowledgeBase } from "../knowledge";
import type { SessionStore } from "../sessions";

export interface TestRouteDeps {
  sessions: SessionStore;
  toolLog: JsonlFile;
  metricsLog: JsonlFile;
  now: () => Date;
  knowledge: KnowledgeBase;
  /** tests/scenarios — read per request so edits to a scenario apply without a restart. */
  scenariosDir: string;
  /** BOT_NAME (default נועה). */
  botName?: string;
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

  /**
   * Prompt variables for one call — the same for every provider (C worker, A dynamic variables, B).
   * ?scenario=S1 uses that scenario's `context:` block; without it, the active session's scenario.
   * ?first_name= / ?day_id= override.
   */
  app.get("/test/context", async (req, reply) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const scenarioId = q.scenario ?? deps.sessions.current()?.scenario;
    let ctx: Record<string, unknown> = {};
    if (scenarioId) {
      const sc = loadScenarios(deps.scenariosDir).find((s) => s.id === scenarioId);
      if (!sc) return reply.code(404).send({ ok: false, error: "unknown_scenario", scenario: scenarioId });
      ctx = (sc.context ?? {}) as Record<string, unknown>;
    }
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
    const variables = buildCallVariables(
      deps.knowledge,
      {
        first_name: str(q.first_name) ?? str(ctx.first_name),
        interested_day_id: str(q.day_id) ?? str(ctx.interested_day_id),
        bot_name: deps.botName,
      },
      deps.now(),
    );
    return { ok: true, scenario: scenarioId ?? null, variables };
  });
}
