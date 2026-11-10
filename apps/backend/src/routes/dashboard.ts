/**
 * Provider-testing dashboard (Part 3): a local web page + the JSON endpoints it uses.
 *
 * - GET /dashboard (+ /dashboard/livekit-client.js) is public: static files, no data. The page sends
 *   TOOLS_SECRET on every API call (it receives it in the URL #hash from `npm run lab`).
 * - Everything under /test/* stays behind the shared secret like the rest of the server.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PROVIDER_NAMES, Provider, type TestSession } from "@mishlav/shared";
import type { FastifyInstance } from "fastify";
import { AccessToken, RoomAgentDispatch, RoomConfiguration } from "livekit-server-sdk";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { loadLogs } from "../../../../scripts/lib/data";
import { buildReport } from "../../../../scripts/lib/report";
import { loadScenarios, type Scenario } from "../../../../scripts/lib/scenarios";
import { EMPTY_MANUAL, ManualInputs, ManualSession, type SessionResult } from "../../../../scripts/lib/scoring";
import type { AppConfig } from "../config";
import type { SessionStore } from "../sessions";
import { elevenStatus, registerElevenLabsRoutes } from "./elevenlabs";

export interface DashboardDeps {
  config: AppConfig;
  sessions: SessionStore;
  now: () => Date;
  env?: NodeJS.ProcessEnv;
  manualInputsPath?: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const PAGE = join(here, "..", "..", "dashboard", "index.html");

function livekitClientPath(repoRoot: string): string {
  const fallback = join(repoRoot, "node_modules", "livekit-client", "dist", "livekit-client.umd.js");
  try {
    const p = createRequire(import.meta.url).resolve("livekit-client");
    return p.endsWith("livekit-client.umd.js") ? p : join(dirname(p), "livekit-client.umd.js");
  } catch {
    return fallback;
  }
}

function elevenClientPath(repoRoot: string): string {
  try {
    const pkg = createRequire(import.meta.url).resolve("@elevenlabs/client/package.json");
    return join(dirname(pkg), "dist", "lib.iife.js");
  } catch {
    return join(repoRoot, "node_modules", "@elevenlabs", "client", "dist", "lib.iife.js");
  }
}

/** LiveKit agent name per provider (must match the worker's AGENT_NAME and the phone dispatch rule). */
export const livekitAgentName = (provider: "B" | "C", env: NodeJS.ProcessEnv) =>
  provider === "B" ? (env.AGENT_NAME_B ?? "mishlav-b") : (env.AGENT_NAME ?? "mishlav-c");

/** Which providers can be tested from the dashboard right now, and why not. */
function providerStatus(env: NodeJS.ProcessEnv, root: string) {
  const livekit = Boolean(env.LIVEKIT_URL && env.LIVEKIT_API_KEY && env.LIVEKIT_API_SECRET);
  const gemini = Boolean(env.GOOGLE_API_KEY || env.GOOGLE_GENAI_USE_VERTEXAI);
  const soniox = Boolean(env.SONIOX_API_KEY);
  const eleven = elevenStatus(root, env);
  const LIVEKIT_KEYS = "מפתחות LiveKit (LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET)";
  const missingFor = (need: [boolean, string][]) => need.filter(([ok]) => !ok).map(([, what]) => what);
  const note = (missing: string[], ready: string) => (missing.length ? `חסר ב-.env: ${missing.join(", ")}` : ready);

  const missC = missingFor([[livekit, LIVEKIT_KEYS], [gemini, "מפתח Gemini (GOOGLE_API_KEY)"]]);
  const missB = missingFor([
    [livekit, LIVEKIT_KEYS],
    [soniox, "מפתח Soniox (SONIOX_API_KEY)"],
    [eleven.key, "מפתח ElevenLabs (elevenLabsAgentsKey)"],
    [gemini, "מפתח Gemini ל-LLM (GOOGLE_API_KEY)"],
  ]);
  const readyA = eleven.key && Boolean(eleven.agent_id);
  const noteA = !eleven.key
    ? "חסר ב-.env: מפתח ElevenLabs (elevenLabsAgentsKey)"
    : !eleven.agent_id
      ? "הסוכן עוד לא נוצר – הפעל דרך npm run lab (יוצר ומעדכן אותו אוטומטית)"
      : `מוכן לבדיקה · הכלים מחוברים דרך ${eleven.tools_url ?? "?"} (מתעדכן בכל הפעלה של npm run lab)`;
  return {
    config: { livekit, gemini, soniox, agentName: livekitAgentName("C", env), agentNameB: livekitAgentName("B", env), elevenlabs: eleven },
    providers: [
      { code: "C", name: PROVIDER_NAMES.C, ready: missC.length === 0, channels: ["browser", "phone"], note: note(missC, "מוכן לבדיקה") },
      { code: "A", name: PROVIDER_NAMES.A, ready: readyA, channels: ["browser"], note: noteA },
      { code: "B", name: PROVIDER_NAMES.B, ready: missB.length === 0, channels: ["browser", "phone"], note: note(missB, "מוכן לבדיקה") },
    ],
  };
}

function scenarioView(s: Scenario) {
  return {
    id: s.id,
    name: s.name,
    core: s.core,
    context: s.context,
    actor_script: s.actor_script,
    guide: s.guide_he ?? null,
    expected_outcome: s.expect.outcome ?? s.expect.outcome_one_of ?? null,
    required_tools: s.expect.required_tools.map((t) => t.tool),
    forbidden_tools: s.expect.forbidden_tools,
    allowed_tools: s.expect.allowed_tools ?? null,
    manual_checks: s.expect.manual_checks,
  };
}

function sessionView(r: SessionResult) {
  const lat = r.latencies;
  return {
    session_id: r.session.session_id,
    provider: r.session.provider,
    scenario: r.session.scenario,
    actor: r.session.actor,
    channel: r.session.notes,
    started_at: r.session.started_at,
    core: r.scenario?.core ?? false,
    expected: r.expected,
    inferred: r.inferred,
    understanding: r.understanding,
    reasons: r.reasons,
    language_switch: r.languageSwitch,
    behavior_ok: r.behaviorOk,
    phone: r.phone,
    avg_latency_ms: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null,
    max_latency_ms: lat.length ? Math.max(...lat) : null,
    turns: lat.length,
    tools: r.calls.map((c) => ({ tool: c.tool, ok: c.ok, params: c.params })),
    discarded: r.discarded,
    notes: r.notes,
  };
}

const ManualSessionUpdate = ManualSession.extend({ session_id: z.string().min(1).max(100) });
const ProviderCostUpdate = z.strictObject({ provider: Provider, cost_per_min_usd: z.number().nonnegative().nullable() });
const VoiceUpdate = z.strictObject({
  map: z.record(z.string().regex(/^[A-Z]$/), Provider),
  scores: z.record(z.string().regex(/^[A-Z]$/), z.array(z.number().min(1).max(5)).max(10)),
});
const TokenRequest = z.strictObject({ provider: Provider.default("C"), scenario: z.string().max(20).optional() });
const CALL_ID = /^[\w+.\-]{1,150}$/;
const TranscriptAppend = z.strictObject({
  call_id: z.string().regex(CALL_ID),
  role: z.enum(["user", "assistant", "event"]), // event: call timeline for debugging (logs/events/), not transcript
  text: z.string().min(1).max(4000),
});

export async function registerDashboardRoutes(app: FastifyInstance, deps: DashboardDeps): Promise<void> {
  const env = deps.env ?? process.env;
  const root = deps.config.repoRoot;
  const scenariosDir = join(root, "tests", "scenarios");
  const manualPath = deps.manualInputsPath ?? join(root, "tests", "results", "manual-inputs.yaml");
  const transcriptsDir = join(deps.config.logDir, "transcripts");
  const eventsDir = join(deps.config.logDir, "events");

  const readManual = (): ManualInputs => {
    if (!existsSync(manualPath)) return EMPTY_MANUAL;
    const parsed = ManualInputs.safeParse(parseYaml(readFileSync(manualPath, "utf8")) ?? {});
    if (!parsed.success) throw Object.assign(new Error(`invalid ${manualPath}: ${z.prettifyError(parsed.error)}`), { statusCode: 500 });
    return parsed.data;
  };
  const writeManual = (m: ManualInputs) => {
    mkdirSync(dirname(manualPath), { recursive: true });
    const header = "# Written by the dashboard (and editable by hand). Used by `npm run score -- --manual ...`.\n";
    writeFileSync(manualPath, header + stringifyYaml(m, { lineWidth: 0 }), "utf8");
  };
  const report = (includeSim: boolean) =>
    buildReport({
      logs: loadLogs(deps.config.logDir),
      scenarios: loadScenarios(scenariosDir),
      manual: readManual(),
      settings: deps.config.settings,
      includeSim,
      manualFileGiven: existsSync(manualPath),
      logDir: deps.config.logDir,
    });

  // ---- static page (public)
  app.get("/dashboard", async (_req, reply) => {
    reply.header("cache-control", "no-store").type("text/html; charset=utf-8");
    return readFileSync(PAGE, "utf8");
  });
  app.get("/dashboard/livekit-client.js", async (_req, reply) => {
    reply.header("cache-control", "public, max-age=3600").type("application/javascript; charset=utf-8");
    return readFileSync(livekitClientPath(root), "utf8");
  });
  app.get("/dashboard/elevenlabs-client.js", async (_req, reply) => {
    reply.header("cache-control", "public, max-age=3600").type("application/javascript; charset=utf-8");
    return readFileSync(elevenClientPath(root), "utf8");
  });

  await registerElevenLabsRoutes(app, { root, env });

  // ---- data
  app.get("/test/overview", async () => {
    const status = providerStatus(env, root);
    return {
      ok: true,
      ...status,
      scenarios: loadScenarios(scenariosDir).map(scenarioView),
      session: deps.sessions.current(),
      scoring: deps.config.settings.testing.scoring,
      manual_file: manualPath,
    };
  });

  app.get("/test/report", async (req) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const r = report(q.include_sim === "1");
    return {
      ok: true,
      sessions: r.results.map(sessionView),
      providers: [...r.providerResults.values()].map((p) => ({
        provider: p.provider,
        name: PROVIDER_NAMES[p.provider],
        status: p.status,
        criteria: p.criteria,
        avg_latency_ms: p.avgLatency === null ? null : Math.round(p.avgLatency),
        max_latency_ms: p.maxLatency,
        voice_avg: p.voiceAvg,
        cost_per_min: p.costPerMin,
        details: p.details,
      })),
      decision: r.decision,
      warnings: r.warnings,
      manual: readManual(),
    };
  });

  app.post("/test/report/write", async () => {
    const r = report(false);
    const out = join(root, "results");
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "results.csv"), r.csv, "utf8");
    writeFileSync(join(out, "summary.md"), r.summary, "utf8");
    return { ok: true, files: [join(out, "results.csv"), join(out, "summary.md")] };
  });

  // ---- manual inputs (merged into tests/results/manual-inputs.yaml)
  app.post("/test/manual/session", async (req, reply) => {
    const parsed = ManualSessionUpdate.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ ok: false, error: "invalid_params", details: z.prettifyError(parsed.error) });
    const { session_id, ...fields } = parsed.data;
    const m = readManual();
    const merged = { ...(m.sessions[session_id] ?? {}), ...fields };
    for (const k of Object.keys(merged) as (keyof typeof merged)[]) if (merged[k] === undefined) delete merged[k];
    m.sessions = { ...m.sessions, [session_id]: merged };
    writeManual(m);
    return { ok: true, session: merged };
  });

  app.post("/test/manual/provider", async (req, reply) => {
    const parsed = ProviderCostUpdate.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ ok: false, error: "invalid_params", details: z.prettifyError(parsed.error) });
    const m = readManual();
    const providers = { ...m.providers };
    if (parsed.data.cost_per_min_usd === null) delete providers[parsed.data.provider];
    else providers[parsed.data.provider] = { cost_per_min_usd: parsed.data.cost_per_min_usd };
    writeManual({ ...m, providers });
    return { ok: true };
  });

  app.post("/test/manual/voice", async (req, reply) => {
    const parsed = VoiceUpdate.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ ok: false, error: "invalid_params", details: z.prettifyError(parsed.error) });
    writeManual({ ...readManual(), blind_voice: parsed.data });
    return { ok: true };
  });

  // ---- transcript written by the voice worker (logs/transcripts/<room>.jsonl)
  app.get("/test/transcript", async (req) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    if (!existsSync(transcriptsDir)) return { ok: true, call_id: null, lines: [] };
    let file: string | null = null;
    if (q.call_id) {
      if (!CALL_ID.test(q.call_id)) return { ok: false, error: "invalid_call_id" };
      const f = join(transcriptsDir, `${q.call_id}.jsonl`);
      file = existsSync(f) ? f : null;
    } else {
      // newest transcript touched since the given time (default: the active session's start)
      const since = Date.parse(q.since ?? deps.sessions.current()?.started_at ?? "") || 0;
      const newest = readdirSync(transcriptsDir)
        .filter((n) => n.endsWith(".jsonl"))
        .map((n) => ({ f: join(transcriptsDir, n), t: statSync(join(transcriptsDir, n)).mtimeMs }))
        .filter((x) => x.t >= since)
        .sort((a, b) => b.t - a.t)[0];
      file = newest?.f ?? null;
    }
    if (!file) return { ok: true, call_id: null, lines: [] };
    const lines = readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as { ts: string; role: string; text: string }];
        } catch {
          return [];
        }
      });
    return { ok: true, call_id: file.split(/[\\/]/).pop()!.replace(/\.jsonl$/, ""), lines };
  });

  // ---- transcript lines sent by the browser (provider A: ElevenLabs runs the call, not our worker)
  app.post("/test/transcript", async (req, reply) => {
    const parsed = TranscriptAppend.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ ok: false, error: "invalid_params", details: z.prettifyError(parsed.error) });
    const dir = parsed.data.role === "event" ? eventsDir : transcriptsDir;
    mkdirSync(dir, { recursive: true });
    const line = { ts: deps.now().toISOString(), role: parsed.data.role, text: parsed.data.text };
    appendFileSync(join(dir, `${parsed.data.call_id}.jsonl`), JSON.stringify(line) + "\n", "utf8");
    return { ok: true };
  });

  // ---- browser call: a LiveKit token for a fresh room that dispatches the voice worker
  app.post("/test/livekit/token", async (req, reply) => {
    const parsed = TokenRequest.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ ok: false, error: "invalid_params", details: z.prettifyError(parsed.error) });
    const status = providerStatus(env, root);
    const p = status.providers.find((x) => x.code === parsed.data.provider);
    if (!p || p.code === "A" || !p.channels.includes("browser")) {
      return reply.code(400).send({ ok: false, error: "no_browser_channel", message_he: "לספק הזה אין שיחה מהדפדפן" });
    }
    if (!status.config.livekit) {
      return reply.code(400).send({ ok: false, error: "livekit_not_configured", message_he: p.note });
    }
    const session: TestSession | null = deps.sessions.current();
    const stamp = deps.now().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
    const room = `web-${parsed.data.provider}-${parsed.data.scenario ?? session?.scenario ?? "free"}-${stamp}`;
    const at = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, { identity: `tester-${stamp}`, name: "Tester", ttl: "1h" });
    at.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true });
    at.roomConfig = new RoomConfiguration({ agents: [new RoomAgentDispatch({ agentName: livekitAgentName(p.code === "B" ? "B" : "C", env) })] });
    return { ok: true, url: env.LIVEKIT_URL, token: await at.toJwt(), room };
  });
}
