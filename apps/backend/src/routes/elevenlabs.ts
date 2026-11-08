/**
 * Provider A (ElevenLabs Agents) from the dashboard: a WebRTC conversation token for the browser (the
 * API key stays here) and the post-call details (duration, cost). The agent itself is created and kept
 * in sync by `npm run eleven:sync` / `npm run lab` (scripts/lib/elevenlabs.ts).
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { agentId, conversationDetails, conversationToken, elevenKey, readState } from "../../../../scripts/lib/elevenlabs";

export interface ElevenStatus {
  key: boolean;
  agent_id: string | null;
  tools_url: string | null;
  synced_at: string | null;
}

export function elevenStatus(root: string, env: NodeJS.ProcessEnv): ElevenStatus {
  const state = readState(root);
  return {
    key: Boolean(elevenKey(env)),
    agent_id: agentId(root, env) ?? null,
    tools_url: state?.tools_url ?? null,
    synced_at: state?.synced_at ?? null,
  };
}

const FinishRequest = z.strictObject({ conversation_id: z.string().regex(/^[\w-]{1,100}$/) });

export async function registerElevenLabsRoutes(app: FastifyInstance, deps: { root: string; env: NodeJS.ProcessEnv }) {
  const notReady = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }, message_he: string) =>
    reply.code(400).send({ ok: false, error: "elevenlabs_not_configured", message_he });

  app.post("/test/elevenlabs/token", async (_req, reply) => {
    const key = elevenKey(deps.env);
    const agent = agentId(deps.root, deps.env);
    if (!key) return notReady(reply, "חסר מפתח ElevenLabs ב-.env (elevenLabsAgentsKey)");
    if (!agent) return notReady(reply, "הסוכן עוד לא נוצר – הרץ npm run lab (או npm run eleven:sync)");
    // ElevenLabs reaches our tools only through the tunnel: a dead tunnel = every tool call fails silently
    const toolsUrl = readState(deps.root)?.tools_url;
    if (toolsUrl && !deps.env.ELEVENLABS_SKIP_TUNNEL_CHECK) {
      const alive = await fetch(`${toolsUrl}/healthz`, { signal: AbortSignal.timeout(5000) }).then((r) => r.ok).catch(() => false);
      if (!alive) return notReady(reply, "המנהרה (ngrok) לשרת הכלים לא פעילה, ו-ElevenLabs לא יוכל להפעיל כלים. הפעל מחדש את npm run lab.");
    }
    try {
      return { ok: true, agent_id: agent, token: await conversationToken(key, agent) };
    } catch (err) {
      return reply.code(502).send({ ok: false, error: "elevenlabs_error", message_he: `ElevenLabs: ${(err as Error).message.slice(0, 200)}` });
    }
  });

  /** After the call: duration + cost from ElevenLabs (the details are ready a few seconds after hang-up). */
  app.post("/test/elevenlabs/finish", async (req, reply) => {
    const parsed = FinishRequest.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ ok: false, error: "invalid_params" });
    const key = elevenKey(deps.env);
    if (!key) return notReady(reply, "חסר מפתח ElevenLabs");
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        const d = await conversationDetails(key, parsed.data.conversation_id);
        const done = d.status === "done" || d.status === "failed";
        if (done || Date.now() > deadline) {
          const duration = d.metadata?.call_duration_secs ?? null;
          const cost = d.metadata?.cost_fiat ?? null;
          return {
            ok: true,
            status: d.status,
            duration_sec: duration,
            cost_usd: cost,
            cost_per_min_usd: cost !== null && duration ? Math.round((cost / (duration / 60)) * 10000) / 10000 : null,
          };
        }
      } catch (err) {
        if (Date.now() > deadline) return reply.code(502).send({ ok: false, error: "elevenlabs_error", message_he: (err as Error).message.slice(0, 200) });
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  });
}
