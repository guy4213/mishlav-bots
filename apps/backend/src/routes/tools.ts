import { performance } from "node:perf_hooks";
import { buildToolInputSchemas, TOOL_NAMES, type ToolCallLogEntry, type ToolName } from "@mishlav/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { z } from "zod";
import { maskNumber } from "../../../phone/src/numbers.js";
import { type ContactEvents, toE164 } from "../contacts";
import type { JsonlFile } from "../jsonl";
import { redactDeep } from "../redact";
import type { SessionStore } from "../sessions";
import { SAY_LINK_FAILED, SAY_LINK_SENT } from "../tools/closings";
import { toolHandlers, type ToolContext, type ToolResponse } from "../tools/handlers";
import type { PhoneHolder } from "./phone";

export interface ToolRouteDeps extends Omit<ToolContext, "recipient" | "recipientName" | "sentDays" | "onLinkSent" | "onLinkFailed"> {
  toolLog: JsonlFile;
  sessions: SessionStore;
  /** Supabase contacts: every tool of a contact's call updates that contact (by call_id) */
  contacts?: ContactEvents;
  /** the phone line: who a scenario call is on (send_purchase_link's recipient) */
  phone?: PhoneHolder;
  /** after each tool call (the dashboard's live log) */
  onToolCall?: (callId: string | null, tool: ToolName, ok: boolean, error?: string) => void;
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

  // the links sent on each call (no second WhatsApp for the same day on the same call); the last 500 calls
  const sentByCall = new Map<string, Set<string>>();
  const sentDaysFor = (callId: string | null) => {
    if (!callId) return undefined;
    let set = sentByCall.get(callId);
    if (!set) {
      set = new Set();
      sentByCall.set(callId, set);
      if (sentByCall.size > 500) sentByCall.delete(sentByCall.keys().next().value!);
    }
    return set;
  };
  // The WhatsApp goes in the background (the bot said "אני שולחת לך עכשיו…" and waits): Texter's answer is told to the
  // bot on the call (line.notify), which then says the goodbye - "נשלח" only once it really went, else a rep sends it.
  const tellBot = (callId: string | null, text: string) => {
    if (callId) deps.phone?.line?.notify?.(callId, text);
  };
  const linkSent = (callId: string | null, params: () => unknown) => (dayHe: string) => {
    tellBot(callId, `(הודעת מערכת: הקישור נשלח עכשיו ללקוח בוואטסאפ. לומר ללקוח רק את המשפט: "${SAY_LINK_SENT}" – מילה במילה, ולא שום דבר אחר.)`);
    // only now Gold gets "נשלח קישור"
    if (callId && deps.contacts) {
      void deps.contacts.run(callId, "send_purchase_link", (s) =>
        s.toolEvent(callId, "send_purchase_link", params(), { ok: true, status: "sent", day_he: dayHe }),
      );
    }
  };
  const linkFailed = (callId: string | null) => (error: string, dayHe: string) => {
    deps.onToolCall?.(callId, "send_purchase_link", false, `whatsapp_failed: ${error}`);
    tellBot(callId, `(הודעת מערכת: הקישור לא נשלח בגלל תקלה, ונפתחה משימה לנציג. לומר ללקוח רק את המשפט: "${SAY_LINK_FAILED}" – מילה במילה.)`);
    if (!callId || !deps.contacts) return;
    const note = `הקישור בוואטסאפ לא נשלח (${error}) – לשלוח ללקוח את הקישור`;
    void deps.contacts.run(callId, "link failed", (s) =>
      s.toolEvent(callId, "request_human", { reason: "other", note }, { ok: true, status: "handed_to_rep", day_he: dayHe }),
    );
  };

  for (const tool of TOOL_NAMES) {
    app.post(`/tools/${tool}`, async (req) => {
      const started = performance.now();
      const body = req.body ?? {};
      const parsed = (schemas[tool] as z.ZodType).safeParse(body);

      let response: ToolResponse;
      let recipient: string | null = null;
      let recipientName: string | null = null;
      let loggedParams: unknown; // what the log keeps of the call (set below); the link's late "sent" event uses it
      if (!parsed.success) {
        response = {
          ok: false,
          error: "invalid_params",
          message_he: "הפרמטרים לא תקינים. בדקי את שמות השדות והערכים המותרים.",
          issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        };
      } else {
        try {
          // the WhatsApp recipient comes from the call, never from the bot (the schema has no phone)
          if (tool === "send_purchase_link") {
            const callId = callMeta(req).call_id;
            recipient = await recipientFor(deps, callId, req);
            recipientName = callId ? (deps.phone?.line?.nameFor?.(callId) ?? null) : null; // the WhatsApp greeting (a line without it: none)
          }
          const handler = toolHandlers[tool] as (i: unknown, c: ToolContext) => ToolResponse | Promise<ToolResponse>;
          const callId = callMeta(req).call_id;
          response = await handler(parsed.data, {
            ...deps,
            recipient,
            recipientName,
            sentDays: sentDaysFor(callId),
            onLinkSent: linkSent(callId, () => loggedParams),
            onLinkFailed: linkFailed(callId),
          });
        } catch (err) {
          req.log.error({ err, tool }, "tool handler failed");
          response = { ok: false, error: "internal_error", message_he: "תקלה זמנית. להציע שנציג יחזור." };
        }
      }

      const params = logToolCall(deps, req, tool, body, response, performance.now() - started, recipient);
      loggedParams = params;
      const callId = callMeta(req).call_id;
      deps.onToolCall?.(callId, tool, response.ok, response.ok ? undefined : String(response.error));
      // after the answer is ready, not before: the bot never waits for Supabase. A link on its way is written once it
      // went (linkSent); one already sent on this call isn't written again
      const later = response.ok && (response.status === "sending" || response.status === "already_sent");
      if (callId && deps.contacts && !later) void deps.contacts.run(callId, tool, (s) => s.toolEvent(callId, tool, params, response));
      return response;
    });
  }
}

/**
 * Who is on the call: a contact's call -> its phone in Supabase (bot_call_number, the phone in use); otherwise
 * (a scenario call, or Supabase down) -> the number the line dialed for this call. null: neither knows it.
 */
async function recipientFor(deps: ToolRouteDeps, callId: string | null, req: FastifyRequest): Promise<string | null> {
  if (!callId) return null;
  if (deps.contacts) {
    try {
      const n = toE164(await deps.contacts.store.callNumber(callId));
      if (n) return n;
    } catch (err) {
      req.log.warn({ err, call_id: callId }, "could not read the call's phone from Supabase; trying the line");
    }
  }
  return deps.phone?.line?.numberFor(callId) ?? null;
}

function logToolCall(
  deps: ToolRouteDeps,
  req: FastifyRequest,
  tool: ToolName,
  rawParams: unknown,
  response: ToolResponse,
  durationMs: number,
  recipient: string | null,
): unknown {
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
    ...(recipient && { recipient: maskNumber(recipient) }),
    duration_ms: Math.round(durationMs * 100) / 100,
  };
  deps.toolLog.append(entry);
  req.log.info({ tool, ok: response.ok, session: entry.session_id, call_id: entry.call_id }, "tool call");
  return params; // card numbers already masked
}
