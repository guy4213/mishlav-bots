/**
 * Provider A (ElevenLabs Agents) — shared by `npm run eleven:sync`, `npm run lab` and the dashboard routes.
 *
 * The agent is kept as code: prompt + knowledge come from the repo (the same text the LiveKit worker
 * uses for B/C), the 5 tools from config/tools.json as webhooks to our tools server. Its ids live in
 * `.elevenlabs.json` at the repo root (git-ignored), so a re-sync updates instead of duplicating.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const ELEVEN_API = "https://api.elevenlabs.io";

/** Defaults (override in .env). eleven_v4_turbo is the Agents model that supports Hebrew; flash_v2_5 doesn't. */
export const ELEVEN_DEFAULTS = {
  llm: "gemini-3.8-flash",
  ttsModel: "eleven_v4_turbo",
  voiceId: "EXAVITQu4vr4xnSDxMaL", // Sarah (premade, female)
  language: "he",
};

/** Client events the browser needs (transcript, tool results for hang-up, speaking/listening mode). */
const CLIENT_EVENTS = [
  "conversation_initiation_metadata",
  "ping",
  "audio",
  "interruption",
  "user_transcript",
  "agent_response",
  "agent_response_correction",
  "agent_tool_response",
  "vad_score",
];

export interface ElevenState {
  agent_id: string;
  tool_ids: Record<string, string>;
  tools_url: string;
  synced_at: string;
}

export const elevenKey = (env: NodeJS.ProcessEnv = process.env): string | undefined =>
  env.ELEVENLABS_API_KEY || env.elevenLabsAgentsKey || undefined;

export const statePath = (root: string) => join(root, ".elevenlabs.json");

export function readState(root: string): ElevenState | null {
  try {
    return existsSync(statePath(root)) ? (JSON.parse(readFileSync(statePath(root), "utf8")) as ElevenState) : null;
  } catch {
    return null;
  }
}

/** ELEVENLABS_AGENT_ID in .env wins over the state file. */
export function agentId(root: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.ELEVENLABS_AGENT_ID || readState(root)?.agent_id || undefined;
}

export async function eleven<T = unknown>(key: string, method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${ELEVEN_API}${path}`, {
    method,
    headers: { "xi-api-key": key, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`ElevenLabs ${method} ${path} -> HTTP ${r.status}: ${text.slice(0, 600)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

// ---------------------------------------------------------------- prompt

/**
 * The agent prompt = config/prompt.md + the knowledge appendix, rendered by the voice worker's own
 * Python code (single source with B/C). `{{vars}}` stay as ElevenLabs dynamic variables.
 */
export function agentPrompt(root: string): string {
  const code = [
    "import sys",
    "from mishlav_worker.context import find_repo_root, knowledge_appendix",
    "root = find_repo_root()",
    "sys.stdout.reconfigure(encoding='utf-8')",
    "print((root / 'config' / 'prompt.md').read_text(encoding='utf-8') + '\\n\\n' + knowledge_appendix(root))",
  ].join("\n");
  const r = spawnSync("uv", ["run", "--quiet", "python", "-X", "utf8", "-c", code], {
    cwd: join(root, "apps", "voice-worker"),
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (r.status !== 0 || !r.stdout.trim()) {
    throw new Error(`could not render the prompt via the voice worker (uv): ${r.stderr || r.error?.message || "no output"}`);
  }
  return r.stdout.trim();
}

/** Every `{{var}}` in the prompt (ElevenLabs requires a value or a placeholder for each). */
export function promptVariables(prompt: string): string[] {
  return [...new Set([...prompt.matchAll(/\{\{\s*([a-zA-Z_][\w]*)\s*\}\}/g)].map((m) => m[1]!))].filter(
    (v) => !v.startsWith("system__"),
  );
}

const PLACEHOLDERS: Record<string, string> = {
  first_name: "דנה",
  bot_name: "נועה",
  interested_day_id: "לא ידוע",
  current_datetime: "",
  customer_context: "",
};

// ---------------------------------------------------------------- tools

interface ToolDef {
  name: string;
  description: string;
  parameters: { properties: Record<string, { type?: string; description?: string; enum?: string[] }>; required?: string[] };
}

export function loadToolDefs(root: string): ToolDef[] {
  return (JSON.parse(readFileSync(join(root, "config", "tools.json"), "utf8")) as { tools: ToolDef[] }).tools;
}

/** Our JSON Schema → ElevenLabs' flat body schema (type + description [+ enum]); length limits are enforced by our server. */
export function webhookToolConfig(def: ToolDef, toolsUrl: string, secret: string) {
  const properties = Object.fromEntries(
    Object.entries(def.parameters.properties).map(([k, p]) => [
      k,
      { type: p.type ?? "string", description: p.description ?? k, ...(p.enum ? { enum: p.enum } : {}) },
    ]),
  );
  return {
    type: "webhook",
    name: def.name,
    description: def.description,
    response_timeout_secs: 20,
    api_schema: {
      url: `${toolsUrl.replace(/\/+$/, "")}/tools/${def.name}`,
      method: "POST",
      request_headers: {
        "X-Tools-Secret": secret,
        "X-Provider": "A",
        "X-Call-Id": { variable_name: "system__conversation_id" },
      },
      request_body_schema: { type: "object", properties, required: def.parameters.required ?? [] },
    },
  };
}

// ---------------------------------------------------------------- sync

export interface SyncOptions {
  root: string;
  key: string;
  toolsUrl: string;
  secret: string;
  env?: NodeJS.ProcessEnv;
  log?: (msg: string) => void;
}

/** Create or update the 5 webhook tools and the agent. Returns the saved state. */
export async function syncAgent(o: SyncOptions): Promise<ElevenState> {
  const env = o.env ?? process.env;
  const log = o.log ?? (() => {});
  const prev = readState(o.root);
  const toolIds: Record<string, string> = { ...(prev?.tool_ids ?? {}) };
  // render first: a prompt error must not leave half-synced tools behind
  const prompt = agentPrompt(o.root);
  const vars = promptVariables(prompt);
  const save = (agent_id: string) => {
    const state: ElevenState = { agent_id, tool_ids: toolIds, tools_url: o.toolsUrl, synced_at: new Date().toISOString() };
    writeFileSync(statePath(o.root), JSON.stringify(state, null, 2) + "\n", "utf8");
    return state;
  };

  for (const def of loadToolDefs(o.root)) {
    const tool_config = webhookToolConfig(def, o.toolsUrl, o.secret);
    const id = toolIds[def.name];
    if (id) {
      try {
        await eleven(o.key, "PATCH", `/v1/convai/tools/${id}`, { tool_config });
        log(`tool ${def.name}: updated`);
        continue;
      } catch (err) {
        log(`tool ${def.name}: update failed (${(err as Error).message.slice(0, 120)}) -> creating a new one`);
      }
    }
    const created = await eleven<{ id: string }>(o.key, "POST", "/v1/convai/tools", { tool_config });
    toolIds[def.name] = created.id;
    save(prev?.agent_id ?? "");
    log(`tool ${def.name}: created`);
  }

  const body = {
    name: "Mishlav study-day bot (test, provider A)",
    tags: ["mishlav", "test"],
    conversation_config: {
      agent: {
        // empty: the agent waits for the callee's "הלו", like the C worker; the prompt has the opening line
        first_message: "",
        language: env.ELEVENLABS_LANGUAGE || ELEVEN_DEFAULTS.language,
        dynamic_variables: { dynamic_variable_placeholders: Object.fromEntries(vars.map((v) => [v, PLACEHOLDERS[v] ?? ""])) },
        prompt: {
          prompt,
          llm: env.ELEVENLABS_LLM || ELEVEN_DEFAULTS.llm,
          temperature: Number(env.ELEVENLABS_TEMPERATURE ?? 0.6),
          tool_ids: Object.values(toolIds),
        },
      },
      tts: {
        model_id: env.ELEVENLABS_TTS_MODEL || ELEVEN_DEFAULTS.ttsModel,
        voice_id: env.ELEVENLABS_VOICE_ID || ELEVEN_DEFAULTS.voiceId,
      },
      conversation: { client_events: CLIENT_EVENTS, max_duration_seconds: 600 },
    },
    // text-only sessions (scripts/elevenlabs-text.ts smoke test; later the text tests per commit)
    platform_settings: { overrides: { conversation_config_override: { conversation: { text_only: true } } } },
  };

  const existing = env.ELEVENLABS_AGENT_ID || prev?.agent_id || undefined;
  let id = existing;
  if (existing) {
    try {
      await eleven(o.key, "PATCH", `/v1/convai/agents/${existing}`, body);
      log(`agent ${existing}: updated`);
    } catch (err) {
      if (!/HTTP 404/.test((err as Error).message)) throw err;
      id = undefined;
    }
  }
  if (!id) {
    id = (await eleven<{ agent_id: string }>(o.key, "POST", "/v1/convai/agents/create", body)).agent_id;
    log(`agent ${id}: created`);
  }

  return save(id);
}

/** WebRTC conversation token for the browser (the API key never leaves the server). */
export async function conversationToken(key: string, agent: string): Promise<string> {
  const r = await eleven<{ token: string }>(key, "GET", `/v1/convai/conversation/token?agent_id=${encodeURIComponent(agent)}`);
  return r.token;
}

export interface ConversationDetails {
  status: string;
  metadata?: { call_duration_secs?: number; cost?: number | null; cost_fiat?: number | null };
  transcript?: { role: string; message?: string | null; time_in_call_secs: number }[];
}

export const conversationDetails = (key: string, id: string) =>
  eleven<ConversationDetails>(key, "GET", `/v1/convai/conversations/${encodeURIComponent(id)}`);
