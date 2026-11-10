/**
 * Text run of every scenario against the same "brain" provider A uses (gemini-3.8-flash), with the
 * Google key from .env: same prompt + knowledge, same 5 tools, same tools server logic. No voice, no
 * ElevenLabs credits (a few cents of Gemini Flash for all scenarios).
 *
 *   npm run text:all                       # every scenario
 *   npm run text:all -- --scenario S2 -s R4  # some
 *   npm run text:all -- --model gemini-3.8-flash
 *
 * What it proves: the bot understands the customer's lines and calls the right tool with the right
 * parameters (the automatic part of the score). It does NOT test voice, barge-in or hang-up timing.
 * ElevenLabs wraps our prompt with a few settings of its own, so behavior is close, not identical.
 *
 * Isolated: an in-process tools server writes to logs/text-runs/<time>/, never to the dashboard logs.
 * Output there: summary.md (the score) and transcripts.md (every conversation, for the manual checks).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadAppConfig, loadDotEnv } from "../apps/backend/src/config";
import { buildServer } from "../apps/backend/src/server";
import { agentPrompt } from "./lib/elevenlabs";
import { api, scriptEnv, type ScriptEnv } from "./lib/env";
import { loadScenarios, type Scenario } from "./lib/scenarios";

const { values } = parseArgs({
  options: {
    scenario: { type: "string", short: "s", multiple: true },
    model: { type: "string" },
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

function render(prompt: string, vars: Record<string, string>): string {
  return prompt.replace(/\{\{\s*([a-zA-Z_]\w*)\s*\}\}/g, (_, k: string) => vars[k] ?? "");
}

/** Latin words in a bot line = a language switch (the prompt says Hebrew only). Tool names don't count. */
function latinWords(text: string, firstName = ""): string[] {
  return [...text.matchAll(/[A-Za-z]{2,}/g)]
    .map((m) => m[0])
    .filter((w) => !/^(zoom|link|ok|ai)$/i.test(w) && w.toLowerCase() !== firstName.toLowerCase()); // the customer's own name is not a switch
}

async function runScenario(
  env: ScriptEnv,
  sc: Scenario,
  ctx: { key: string; model: string; prompt: string; tools: ToolDef[] },
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

  const contents: Content[] = [];
  const lines: Line[] = [];
  const languageSwitches: string[] = [];
  let ended = false;

  for (const said of [OPENING, ...sc.actor_script]) {
    if (ended) break;
    lines.push({ who: "לקוח", text: said });
    contents.push({ role: "user", parts: [{ text: said }] });

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const reply = await gemini(ctx.key, ctx.model, {
        systemInstruction: { parts: [{ text: system }] },
        contents,
        tools: [{ functionDeclarations: ctx.tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters })) }],
        generationConfig: { temperature: 0.6 },
      });
      contents.push({ role: "model", parts: reply.parts }); // as-is: Gemini 3 needs its thought signatures back

      const text = reply.parts.filter((p) => p.text && !p.thought).map((p) => p.text).join(" ").trim();
      if (text) {
        lines.push({ who: "בוט", text });
        const latin = latinWords(text, vars.first_name);
        if (latin.length) languageSwitches.push(`${sc.id}: "${latin.join(" ")}"`);
      }
      const calls = reply.parts.filter((p) => p.functionCall).map((p) => p.functionCall!);
      if (!calls.length) break;

      const responses: Part[] = [];
      for (const fc of calls) {
        const { status, json } = await api<Record<string, unknown>>(env, "POST", `/tools/${fc.name}`, fc.args ?? {}, {
          "x-provider": "SIM",
          "x-call-id": callId,
        });
        lines.push({ who: "כלי", text: `${fc.name}(${JSON.stringify(fc.args ?? {})}) → ${String(json.status ?? json.error ?? status)}` });
        if (fc.name === "end_call" && json.ok) ended = true;
        responses.push({ functionResponse: { name: fc.name, ...(fc.id ? { id: fc.id } : {}), response: json } });
      }
      contents.push({ role: "user", parts: responses });
      if (ended) {
        // ElevenLabs runs the tools first and speaks after their results, and the dashboard keeps the
        // line open until that speech ends: so what the model says now IS heard (provider A).
        const last = await gemini(ctx.key, ctx.model, {
          systemInstruction: { parts: [{ text: system }] },
          contents,
          tools: [{ functionDeclarations: ctx.tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters })) }],
          generationConfig: { temperature: 0.6 },
        });
        const bye = last.parts.filter((p) => p.text && !p.thought).map((p) => p.text).join(" ").trim();
        lines.push({ who: "בוט", text: bye ? `${bye}  _(אחרי end_call)_` : "_(שתיקה – לא נאמרה פרידה)_" });
        break;
      }
    }
  }
  await api(env, "POST", "/test/session/end");
  return { lines, languageSwitches };
}

async function main() {
  const base = scriptEnv();
  const key = process.env.GOOGLE_API_KEY;
  if (!key) throw new Error("GOOGLE_API_KEY is empty (.env)");
  const model = values.model ?? process.env.ELEVENLABS_LLM ?? "gemini-3.8-flash";

  // isolated tools server, in this process
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const runDir = join(base.root, "logs", "text-runs", stamp);
  mkdirSync(runDir, { recursive: true });
  loadDotEnv(base.root);
  const config = loadAppConfig({ ...process.env, LOG_DIR: runDir, PORT: "0" });
  const app = await buildServer(config, { logger: false });
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
        r = await runScenario(env, sc, { key, model, prompt, tools });
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
