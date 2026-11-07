import { performance } from "node:perf_hooks";
import { buildToolInputSchemas, TOOL_NAMES, type ToolCallLogEntry, type ToolName } from "@mishlav/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { z } from "zod";
import type { JsonlFile } from "../jsonl";
import { redactDeep } from "../redact";
import type { SessionStore } from "../sessions";
import { toolHandlers, type ToolContext, type ToolResponse } from "../tools/handlers";

export interface ToolRouteDeps extends ToolContext {
  toolLog: JsonlFile;
  sessions: SessionStore;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim().length > 0 ? v.trim().slice(0, 200) : null);

function callMeta(req: FastifyRequest) {
  const q = (req.query ?? {}) as Record<string, unknown>;
  return {
    call_id: str(req.headers["x-call-id"]) ?? str(q.call_id),
    provider: str(req.headers["x-provider"]) ?? str(q.provider),
  };
}

export async function registerToolRoutes(app: FastifyInstance, deps: ToolRouteDeps): Promise<void> {
  const schemas = buildToolInputSchemas({ captureDictatedDetails: deps.settings.testing.capture_dictated_details });

  for (const tool of TOOL_NAMES) {
    app.post(`/tools/${tool}`, async (req) => {
      const started = performance.now();
      const body = req.body ?? {};
      const parsed = (schemas[tool] as z.ZodType).safeParse(body);

      let response: ToolResponse;
      if (!parsed.success) {
        response = {
          ok: false,
          error: "invalid_params",
          message_he: "הפרמטרים לא תקינים. בדקי את שמות השדות והערכים המותרים.",
          issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        };
      } else {
        try {
          response = (toolHandlers[tool] as (i: unknown, c: ToolContext) => ToolResponse)(parsed.data, deps);
        } catch (err) {
          req.log.error({ err, tool }, "tool handler failed");
          response = { ok: false, error: "internal_error", message_he: "תקלה זמנית. הציעי שנציג יחזור." };
        }
      }

      logToolCall(deps, req, tool, body, response, performance.now() - started);
      return response;
    });
  }
}

function logToolCall(
  deps: ToolRouteDeps,
  req: FastifyRequest,
  tool: ToolName,
  rawParams: unknown,
  response: ToolResponse,
  durationMs: number,
): void {
  const meta = callMeta(req);
  const session = deps.sessions.current();
  const { value: params, count } = redactDeep(rawParams);
  const entry: ToolCallLogEntry = {
    type: "tool_call",
    ts: deps.now().toISOString(),
    session_id: session?.session_id ?? null,
    scenario: session?.scenario ?? null,
    provider: meta.provider ?? session?.provider ?? null,
    call_id: meta.call_id,
    tool,
    params,
    redactions: count,
    ok: response.ok,
    ...(response.ok ? {} : { error: response.error }),
    response,
    duration_ms: Math.round(durationMs * 100) / 100,
  };
  deps.toolLog.append(entry);
  req.log.info({ tool, ok: response.ok, session: entry.session_id, call_id: entry.call_id }, "tool call");
}
