/**
 * Text-only conversation with the provider-A agent (no microphone, no audio cost) — a quick smoke test
 * that the agent, its Hebrew prompt and the tool webhooks (via the tunnel) work.
 *
 *   npm run eleven:text -- --scenario S1 --say "הלו" --say "כמה זה עולה?" --say "תשלחי לי קישור"
 *
 * Needs `npm run lab` running (tools server + tunnel + synced agent). Prompt variables come from the
 * tools server's /test/context for the scenario, exactly like a dashboard call.
 */
import { parseArgs } from "node:util";
import { agentId, eleven, elevenKey } from "./lib/elevenlabs";
import { api, scriptEnv } from "./lib/env";

const { values } = parseArgs({
  options: { scenario: { type: "string", default: "S1" }, say: { type: "string", multiple: true } },
});
const env = scriptEnv();

async function main() {
  const key = elevenKey();
  const agent = agentId(env.root);
  if (!key || !agent) throw new Error("no ElevenLabs key/agent — run `npm run lab` first");
  const turns = values.say?.length ? values.say : ["הלו", "כן, יש לי דקה. כמה זה עולה?", "אוקיי, תשלחי לי קישור בבקשה."];
  const ctx = await api<{ variables: Record<string, string> }>(env, "GET", `/test/context?scenario=${encodeURIComponent(values.scenario!)}`);
  const { signed_url } = await eleven<{ signed_url: string }>(key, "GET", `/v1/convai/conversation/get-signed-url?agent_id=${agent}`);

  const ws = new WebSocket(signed_url);
  let i = 0;
  const next = () => {
    if (i >= turns.length) return false;
    const text = turns[i++]!;
    console.log(`אתה:  ${text}`);
    ws.send(JSON.stringify({ type: "user_message", text }));
    return true;
  };
  await new Promise<void>((resolve) => {
    let idle: NodeJS.Timeout | undefined;
    const done = () => { clearTimeout(idle); resolve(); };
    const armIdle = () => { clearTimeout(idle); idle = setTimeout(() => (next() ? armIdle() : done()), 12_000); };
    ws.onopen = () =>
      ws.send(JSON.stringify({
        type: "conversation_initiation_client_data",
        conversation_config_override: { conversation: { text_only: true } },
        dynamic_variables: ctx.json.variables,
      }));
    ws.onmessage = (ev) => {
      const e = JSON.parse(String(ev.data));
      if (e.type === "ping") ws.send(JSON.stringify({ type: "pong", event_id: e.ping_event.event_id }));
      else if (e.type === "conversation_initiation_metadata") {
        console.log(`(conversation ${e.conversation_initiation_metadata_event.conversation_id})`);
        next(); armIdle();
      } else if (e.type === "agent_response") {
        console.log(`הבוט: ${e.agent_response_event.agent_response}`);
        setTimeout(() => { if (!next()) armIdle(); else armIdle(); }, 400);
      } else if (e.type === "agent_tool_response") {
        const r = e.agent_tool_response;
        console.log(`       [${r.tool_name}${r.is_error ? " ✗ שגיאה" : " ✓"}]`);
        if (r.tool_name === "end_call") setTimeout(done, 1500);
      }
    };
    ws.onerror = () => done();
    ws.onclose = () => done();
  });
  ws.close();
}

main().catch((err) => {
  console.error(`[eleven] ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
});
