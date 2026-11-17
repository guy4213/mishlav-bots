/**
 * Text run of every scenario against the same "brain" provider A uses (gemini-3.8-flash), with the
 * Google key from .env: same prompt + knowledge, same 5 tools, same tools server logic. No voice, no
 * ElevenLabs credits (a few cents of Gemini Flash for all scenarios).
 *
 *   npm run text:all                       # every scenario
 *   npm run text:all -- --scenario S2 -s R4  # some
 *   npm run text:all -- --model gemini-3.8-flash
 *   npm run text:all -- --engine openai     # logic check on gpt-5.6-terra (OPENAI_API_KEY)
 *
 * What it proves: the bot understands the customer's lines and calls the right tool with the right
 * parameters (the automatic part of the score). It does NOT test voice, barge-in or hang-up timing.
 * ElevenLabs wraps our prompt with a few settings of its own, so behavior is close, not identical.
 *
 * Isolated: an in-process tools server writes to logs/text-runs/<time>/, never to the dashboard logs.
 * Output there: summary.md (the score) and transcripts.md (every conversation, for the manual checks).
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadAppConfig, loadDotEnv } from "../apps/backend/src/config";
import { geminiGenderClassifier } from "../apps/backend/src/gender";
import { buildServer } from "../apps/backend/src/server";
import { LogOnlySms } from "../apps/backend/src/sms";
import { agentPrompt } from "./lib/elevenlabs";
import { api, scriptEnv, type ScriptEnv } from "./lib/env";
import { loadScenarios, type Scenario } from "./lib/scenarios";

const { values } = parseArgs({
  options: {
    scenario: { type: "string", short: "s", multiple: true },
    model: { type: "string" },
    // flash = provider A's brain (REST) · live / live-extended = provider C's Gemini Live models (via apps/voice-worker/live_text.py)
    // openai = a logic check with an OpenAI model (default gpt-5.6-terra, OPENAI_API_KEY): not one of the providers
    engine: { type: "string", default: "flash" },
  },
});

const GEMINI = "https://generativelanguage.googleapis.com/v1beta";
const MAX_TOOL_ROUNDS = 6; // tool calls the bot may chain inside one turn
const OPENING = "הלו"; // the callee picks up; the bot waits for it, like the real call

type Part = Record<string, unknown> & {
  text?: string;
  thought?: boolean;
  functionCall?: { name: string; args?: Record<string, unknown>; id?: string };
};
type Content = { role: "user" | "model"; parts: Part[] };

interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

interface Line {
  who: "לקוח" | "בוט" | "כלי";
  text: string;
}

async function gemini(key: string, model: string, body: unknown): Promise<Content> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${GEMINI}/models/${model}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const json = (await res.json()) as { candidates?: { content?: Content }[] };
      const c = json.candidates?.[0]?.content;
      return { role: "model", parts: c?.parts ?? [] };
    }
    const text = await res.text();
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await new Promise((r) => setTimeout(r, 2000 * attempt));
      continue;
    }
    throw new Error(`Gemini ${model}: HTTP ${res.status} ${text.slice(0, 300)}`);
  }
}

/** "(interrupt while the bot reads the details) רגע רגע..." -> the words only: the direction is for the human actor. */
const spoken = (line: string) => line.replace(/^\s*\([^)]*\)\s*/, "");

type ToolCall = { name: string; args: Record<string, unknown>; id?: string };
type ToolResult = { call: ToolCall; json: Record<string, unknown> };

/** The model side of a text conversation; the scenario loop (tools, closing) is the same for every engine. */
interface Brain {
  user(text: string): void;
  step(): Promise<{ text: string; calls: ToolCall[] }>;
  results(results: ToolResult[]): void;
}

function geminiBrain(key: string, model: string, system: string, tools: ToolDef[]): Brain {
  const contents: Content[] = [];
  const functionDeclarations = tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters }));
  return {
    user: (text) => void contents.push({ role: "user", parts: [{ text }] }),
    async step() {
      const reply = await gemini(key, model, {
        systemInstruction: { parts: [{ text: system }] },
        contents,
        tools: [{ functionDeclarations }],
        generationConfig: { temperature: 0.6 },
      });
      contents.push({ role: "model", parts: reply.parts }); // as-is: Gemini 3 needs its thought signatures back
      return {
        text: reply.parts.filter((p) => p.text && !p.thought).map((p) => p.text).join(" ").trim(),
        calls: reply.parts.filter((p) => p.functionCall).map(({ functionCall: fc }) => ({ name: fc!.name, args: fc!.args ?? {}, id: fc!.id })),
      };
    },
    results(results) {
      const parts = results.map(({ call, json }) => ({ functionResponse: { name: call.name, ...(call.id ? { id: call.id } : {}), response: json } }));
      contents.push({ role: "user", parts });
    },
  };
}

// Responses API: the reasoning models take function tools only here (not in chat/completions)
const OPENAI = "https://api.openai.com/v1/responses";
type OpenAIItem = { type: string; name?: string; arguments?: string; call_id?: string; content?: { type: string; text?: string }[] };

/** Logic check with an OpenAI model: same prompt, same tools, same tools server - only the brain differs. */
function openaiBrain(key: string, model: string, system: string, tools: ToolDef[]): Brain {
  let pending: Record<string, unknown>[] = []; // new input since the last response (the rest is kept by previous_response_id)
  let previous: string | undefined;
  const fns = tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters, strict: false }));
  return {
    user: (text) => void pending.push({ role: "user", content: text }),
    async step() {
      for (let attempt = 1; ; attempt++) {
        const res = await fetch(OPENAI, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body: JSON.stringify({ model, instructions: system, input: pending, tools: fns, previous_response_id: previous }),
        });
        if (!res.ok) {
          const err = await res.text();
          if ((res.status === 429 || res.status >= 500) && attempt < 4) {
            await new Promise((r) => setTimeout(r, 2000 * attempt));
            continue;
          }
          throw new Error(`OpenAI ${model}: HTTP ${res.status} ${err.slice(0, 300)}`);
        }
        const r = (await res.json()) as { id: string; output: OpenAIItem[] };
        previous = r.id;
        pending = [];
        return {
          text: r.output
            .filter((o) => o.type === "message")
            .flatMap((o) => o.content ?? [])
            .map((c) => (c.type === "output_text" ? (c.text ?? "") : ""))
            .join(" ")
            .trim(),
          calls: r.output
            .filter((o) => o.type === "function_call")
            .map((o) => ({ name: o.name!, args: JSON.parse(o.arguments || "{}"), id: o.call_id })),
        };
      }
    },
    results(results) {
      for (const { call, json } of results) pending.push({ type: "function_call_output", call_id: call.id, output: JSON.stringify(json) });
    },
  };
}

function render(prompt: string, vars: Record<string, string>): string {
  return prompt.replace(/\{\{\s*([a-zA-Z_]\w*)\s*\}\}/g, (_, k: string) => vars[k] ?? "");
}

/** Latin words in a bot line = a language switch (the prompt says Hebrew only). Tool names don't count. */
function latinWords(text: string, firstName = ""): string[] {
  return [...text.matchAll(/[A-Za-z]{2,}/g)]
    .map((m) => m[0])
    .filter((w) => !/^(zoom|link|ok|ai)$/i.test(w) && w.toLowerCase() !== firstName.toLowerCase()); // the customer's own name is not a switch
}

const LIVE_MODELS: Record<string, string> = {
  live: "gemini-3.8-live",
  "live-extended": "gemini-3.8-live-extended-thinking",
};

/** Provider C's model: the Python worker code talks to Gemini Live; its tools hit our isolated server. */
function runLive(env: ScriptEnv, model: string, callId: string, vars: Record<string, string>, said: string[], dir: string): Promise<Line[]> {
  const varsFile = join(dir, `${callId}.vars.json`);
  const linesFile = join(dir, `${callId}.lines.json`);
  writeFileSync(varsFile, JSON.stringify(vars), "utf8");
  writeFileSync(linesFile, JSON.stringify(said), "utf8");
  const who: Record<string, Line["who"]> = { customer: "לקוח", bot: "בוט", tool: "כלי", note: "כלי" };
  return new Promise((resolve, reject) => {
    // async spawn: the tools server runs in this process and must keep answering the tool calls
    const p = spawn("uv", ["run", "--quiet", "python", "-X", "utf8", "live_text.py", "--base-url", env.baseUrl, "--call-id", callId, "--model", model, "--vars", varsFile, "--lines", linesFile], {
      cwd: join(env.root, "apps", "voice-worker"),
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("error", reject);
    p.on("close", (code) => {
      const lines: Line[] = stdout
        .split(/\r?\n/)
        .filter((l) => l.startsWith("{"))
        .map((l) => {
          const j = JSON.parse(l) as { who: string; text: string };
          return { who: who[j.who] ?? "כלי", text: j.who === "note" ? `⚠️ ${j.text}` : j.text };
        });
      const lastErr = stderr.trim().split(/\r?\n/).pop() ?? "";
      if (code !== 0 && !lines.length) reject(new Error(`live_text.py exit ${code}: ${stderr.slice(-400)}`));
      else resolve(code !== 0 ? [...lines, { who: "כלי", text: `⚠️ exit ${code}: ${lastErr}` }] : lines);
    });
  });
}

async function runScenario(
  env: ScriptEnv,
  sc: Scenario,
  ctx: { key: string; model: string; prompt: string; tools: ToolDef[]; engine: string },
): Promise<{ lines: Line[]; languageSwitches: string[] }> {
  const start = await api<{ session: { session_id: string } }>(env, "POST", "/test/session", {
    provider: "SIM",
    scenario: sc.id,
    actor: "text-run",
    notes: `text ${ctx.model}`,
  });
  if (start.status !== 200) throw new Error(`session start failed: HTTP ${start.status}`);
  const callId = `text-${sc.id}-${Date.now()}`;
  const vars = (await api<{ variables: Record<string, string> }>(env, "GET", `/test/context?scenario=${encodeURIComponent(sc.id)}`)).json
    .variables;
  const system = render(ctx.prompt, { ...vars, interested_day_id: vars.interested_day_id || "לא ידוע" });
  const script = [OPENING, ...sc.actor_script.map(spoken)];
  if (LIVE_MODELS[ctx.engine]) {
    const lines = await runLive(env, LIVE_MODELS[ctx.engine]!, callId, vars, script, env.logDir);
    await api(env, "POST", "/test/session/end");
    const languageSwitches = lines
      .filter((l) => l.who === "בוט" && latinWords(l.text, vars.first_name).length)
      .map((l) => `${sc.id}: "${latinWords(l.text, vars.first_name).join(" ")}"`);
    return { lines, languageSwitches };
  }

  const brain = (ctx.engine === "openai" ? openaiBrain : geminiBrain)(ctx.key, ctx.model, system, ctx.tools);
  const lines: Line[] = [];
  const languageSwitches: string[] = [];
  const botSays = (text: string) => {
    lines.push({ who: "בוט", text });
    const latin = latinWords(text, vars.first_name);
    if (latin.length) languageSwitches.push(`${sc.id}: "${latin.join(" ")}"`);
  };
  let ended = false;

  for (const said of script) {
    if (ended) break;
    lines.push({ who: "לקוח", text: said });
    brain.user(said);

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const { text, calls } = await brain.step();
      if (text) botSays(text);
      if (!calls.length) break;

      const results: ToolResult[] = [];
      for (const call of calls) {
        const { status, json } = await api<Record<string, unknown>>(env, "POST", `/tools/${call.name}`, call.args, {
          "x-provider": "SIM",
          "x-call-id": callId,
        });
        lines.push({ who: "כלי", text: `${call.name}(${JSON.stringify(call.args)}) → ${String(json.status ?? json.error ?? status)}` });
        if (call.name === "end_call" && json.ok) ended = true;
        results.push({ call, json });
      }
      brain.results(results);
      if (ended) {
        // ElevenLabs runs the tools first and speaks after their results, and the dashboard keeps the
        // line open until that speech ends: so what the model says now IS heard (provider A).
        const bye = (await brain.step()).text;
        lines.push({ who: "בוט", text: bye ? `${bye}  _(אחרי סיום השיחה – נשמע)_` : "_(אחרי סיום השיחה: שתיקה)_" });
        break;
      }
    }
  }
  await api(env, "POST", "/test/session/end");
  return { lines, languageSwitches };
}

async function main() {
  const base = scriptEnv();
  const engine = values.engine ?? "flash";
  if (engine !== "flash" && engine !== "openai" && !LIVE_MODELS[engine])
    throw new Error(`--engine must be flash | openai | ${Object.keys(LIVE_MODELS).join(" | ")}`);
  const keyName = engine === "openai" ? "OPENAI_API_KEY" : "GOOGLE_API_KEY";
  const key = process.env[keyName];
  if (!key) throw new Error(`${keyName} is empty (.env)`);
  const model =
    LIVE_MODELS[engine] ?? values.model ?? (engine === "openai" ? "gpt-5.6-terra" : (process.env.ELEVENLABS_LLM ?? "gemini-3.8-flash"));

  // isolated tools server, in this process
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const runDir = join(base.root, "logs", "text-runs", stamp);
  mkdirSync(runDir, { recursive: true });
  loadDotEnv(base.root);
  const config = loadAppConfig({ ...process.env, LOG_DIR: runDir, PORT: "0" });
  const googleKey = process.env.GOOGLE_API_KEY;
  const app = await buildServer(config, {
    logger: false,
    sms: new LogOnlySms(() => {}), // a text run never sends an SMS, even with Zadarma keys in .env
    classifyGender: googleKey ? geminiGenderClassifier({ apiKey: googleKey }) : undefined,
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const addr = app.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const env: ScriptEnv = { ...base, logDir: runDir, baseUrl: `http://127.0.0.1:${port}` };

  const prompt = agentPrompt(base.root);
  const tools = (JSON.parse(readFileSync(join(base.root, "config", "tools.json"), "utf8")) as { tools: ToolDef[] }).tools;
  const wanted = values.scenario?.map((s) => s.toUpperCase());
  const scenarios = loadScenarios(base.scenariosDir).filter((s) => !wanted || wanted.includes(s.id));
  if (!scenarios.length) throw new Error(`no scenario matches ${wanted?.join(", ")}`);

  console.log(`text run: ${scenarios.length} scenario(s) on ${model} -> ${runDir}\n`);
  const md: string[] = [`# Text run – ${model}`, "", `${new Date().toISOString()} · same prompt and tools as provider A`, ""];
  const switches: string[] = [];
  try {
    for (const sc of scenarios) {
      process.stdout.write(`▶ ${sc.id} ${sc.name} ... `);
      let r: Awaited<ReturnType<typeof runScenario>>;
      try {
        r = await runScenario(env, sc, { key, model, prompt, tools, engine });
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        console.log(`ERROR ${why}`);
        md.push(`## ${sc.id} · ERROR`, "", why, "");
        await api(env, "POST", "/test/session/end").catch(() => {});
        continue;
      }
      switches.push(...r.languageSwitches);
      const toolsUsed = r.lines.filter((l) => l.who === "כלי").map((l) => l.text.split("(")[0]);
      console.log(toolsUsed.join(", ") || "(no tools)");
      md.push(`## ${sc.id} · ${sc.guide_he?.title ?? sc.name}`, "");
      if (sc.guide_he?.watch?.length) md.push(...sc.guide_he.watch.map((w) => `- 👀 ${w}`), "");
      md.push(...r.lines.map((l) => `**${l.who}:** ${l.text}  `), "");
    }
  } finally {
    await app.close();
  }
  if (switches.length) md.push("## English in bot lines", "", ...switches.map((s) => `- ${s}`), "");
  writeFileSync(join(runDir, "transcripts.md"), md.join("\n"), "utf8");

  // the same scoring as the dashboard, on the isolated logs
  const score = spawnSync(
    process.execPath,
    [join(base.root, "node_modules", "tsx", "dist", "cli.mjs"), join(base.root, "scripts", "score-calls.ts"), "--include-sim", "--provider", "SIM", "--out", runDir],
    { cwd: base.root, env: { ...process.env, LOG_DIR: runDir }, encoding: "utf8" },
  );
  const calls = /## Calls[\s\S]*?(?=\n## )/.exec(score.stdout)?.[0] ?? score.stdout + score.stderr;
  console.log(`\n${calls}`);
  if (switches.length) console.log(`\nEnglish in bot lines:\n${switches.map((s) => `  - ${s}`).join("\n")}`);
  console.log(`\nTranscripts (for the 👀 checks): ${join(runDir, "transcripts.md")}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
