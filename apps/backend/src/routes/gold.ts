/**
 * What Gold pulls once a day: the contacts the bot changed since the last pull, with only Gold's own columns under
 * the export's Hebrew headers (settings.yaml gold_import). Nothing internal (bot_state, calls, rep_tasks).
 *
 * - GET /api/gold/changes?since=<ISO time>  header X-Api-Key: GOLD_API_KEY (not TOOLS_SECRET). Without a configured
 *   key it refuses everything. No `since`: everything the bot ever changed. Pass the answer's `until` as the next
 *   `since`.
 * - GET /test/gold/changes?since=           the same answer for the dashboard ("what Gold will receive"), behind
 *   TOOLS_SECRET like every /test/* route.
 */
import type { Settings } from "@mishlav/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { secretMatches } from "../auth";
import { type ContactStore, toGoldRecord } from "../contacts";

export interface GoldRouteDeps {
  contacts?: ContactStore;
  settings: Settings;
  /** GOLD_API_KEY (none: /api/gold/changes refuses everything) */
  apiKey?: string;
}

/** The path Gold calls with its own key: the server's TOOLS_SECRET check skips it. */
export const GOLD_CHANGES_PATH = "/api/gold/changes";

export async function registerGoldRoutes(app: FastifyInstance, deps: GoldRouteDeps): Promise<void> {
  const changes = async (req: FastifyRequest, reply: FastifyReply) => {
    const raw = ((req.query ?? {}) as Record<string, string | undefined>).since?.trim();
    const since = raw ? new Date(raw) : undefined;
    if (since && Number.isNaN(since.getTime())) {
      return reply.code(400).send({ ok: false, error: "invalid_since", message: "since must be an ISO 8601 date-time" });
    }
    if (!deps.contacts) return reply.code(503).send({ ok: false, error: "no_contacts", message_he: "Supabase לא מחובר" });
    try {
      const r = await deps.contacts.goldChanges(since?.toISOString());
      return {
        since: since?.toISOString() ?? null,
        until: r.until,
        count: r.contacts.length,
        contacts: r.contacts.map((c) => toGoldRecord(c, deps.settings.gold_import)),
      };
    } catch (err) {
      req.log.error({ err }, "gold changes failed");
      return reply.code(502).send({ ok: false, error: "supabase_error", message_he: "תקלה בקריאה מ-Supabase" });
    }
  };

  app.get(GOLD_CHANGES_PATH, async (req, reply) => {
    if (!deps.apiKey) return reply.code(503).send({ ok: false, error: "gold_api_not_configured" });
    const key = req.headers["x-api-key"];
    if (!secretMatches(typeof key === "string" ? key : undefined, deps.apiKey)) {
      req.log.warn({ ip: req.ip }, "gold api: bad key");
      return reply.code(401).send({ ok: false, error: "unauthorized" });
    }
    return changes(req, reply);
  });

  app.get("/test/gold/changes", changes);
}
