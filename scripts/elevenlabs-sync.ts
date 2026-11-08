/**
 * Create / update the provider-A agent on ElevenLabs from the repo (prompt, knowledge, 5 tools).
 *
 *   npm run eleven:sync -- --url https://<ngrok-host>   tools point at this public tools-server URL
 *   npm run eleven:sync                                  re-sync with the last URL (.elevenlabs.json)
 *
 * `npm run lab` runs this automatically after opening the ngrok tunnel (its URL changes each start).
 */
import { parseArgs } from "node:util";
import { elevenKey, readState, syncAgent } from "./lib/elevenlabs";
import { scriptEnv } from "./lib/env";

const { values } = parseArgs({ options: { url: { type: "string" } } });
const env = scriptEnv();

async function main() {
  const key = elevenKey();
  if (!key) throw new Error("no ElevenLabs key in .env (ELEVENLABS_API_KEY or elevenLabsAgentsKey)");
  if (!env.secret) throw new Error("TOOLS_SECRET is missing in .env");
  const toolsUrl = values.url ?? readState(env.root)?.tools_url;
  if (!toolsUrl) throw new Error("pass --url https://<public tools-server URL> (e.g. the ngrok URL from `npm run dev:tunnel`)");
  if (!/^https:\/\//.test(toolsUrl)) throw new Error("--url must be a public https URL (ElevenLabs calls it from the internet)");
  const state = await syncAgent({ root: env.root, key, toolsUrl, secret: env.secret, log: (m) => console.log(`[eleven] ${m}`) });
  console.log(`[eleven] agent ${state.agent_id} -> tools at ${state.tools_url}`);
}

main().catch((err) => {
  console.error(`[eleven] ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
});
