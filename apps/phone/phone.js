// The Mishlav bot on a Zadarma phone line (SIP), with Gemini Live as the voice.
//
//   npm run phone                         wait for calls to the Zadarma number; the bot answers
//   npm run phone -- call 0501234567      the bot calls that number (costs Zadarma balance), then exits
//   options: --scenario S1  --name דנה  --day <day_id>  --model <id>  --voice <name>  --record
//
// Needs the tools server (`npm run dev`, another terminal). The tools server can also run the line itself
// (it does when ZADARMA_SIP_* are set): then call from the dashboard instead, and don't run this too.
// Per call, the same inputs as provider C's worker: prompt variables from GET /test/context, config/prompt.md
// + the knowledge base, the 5 tools from config/tools.json (POST to the tools server with X-Provider: C and
// X-Call-Id), transcript to logs/transcripts/, the call log to logs/phone.jsonl, latency to /test/metrics.
// .env: GOOGLE_API_KEY, TOOLS_SECRET, ZADARMA_SIP_SERVER / ZADARMA_SIP_LOGIN / ZADARMA_SIP_PASSWORD
// (a line on Zadarma's cloud PBX registers as an extension: login like 660895-100, server pbx.zadarma.com).
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { missingPhoneEnv, PhoneLine, phoneEnv } from './src/line.js';
import { findRepoRoot } from './src/mishlav.js';

const ROOT = findRepoRoot();
// Repo-root .env first, then the worker's (GOOGLE_API_KEY may live there); existing values are kept.
for (const file of [join(ROOT, '.env'), join(ROOT, 'apps', 'voice-worker', '.env')]) {
  try {
    process.loadEnvFile(file);
  } catch {}
}

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    model: { type: 'string' },
    voice: { type: 'string' },
    scenario: { type: 'string', short: 's' },
    name: { type: 'string' },
    day: { type: 'string' },
    record: { type: 'boolean', default: false },
  },
});
const [command, target] = positionals;
if (command && command !== 'call') {
  console.error(`unknown command: ${command} (none = answer calls, or: call <number>)`);
  process.exit(1);
}

const env = phoneEnv(process.env, ROOT);
if (opt.model) env.model = opt.model;
if (opt.voice) env.voice = opt.voice;
const missing = missingPhoneEnv(env);
if (missing.length) {
  console.error(`missing in .env: ${missing.join(', ')}`);
  process.exit(1);
}

const time = () => new Date().toLocaleTimeString('he-IL', { hour12: false, timeZone: 'Asia/Jerusalem' });
const line = new PhoneLine({
  root: ROOT,
  env,
  answer: !command,
  record: opt.record,
  incoming: { scenario: opt.scenario, name: opt.name, day: opt.day },
});
line.on('log', ({ text }) => console.log(`[${time()}] ${text}`));

let shuttingDown = false;
async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[${time()}] unregistering from Zadarma…`);
  await line.stop();
  process.exit(code);
}
process.on('SIGINT', () => shutdown(0));

try {
  await line.start();
} catch (err) {
  console.error(`❌ ${err.message}`);
  process.exit(1);
}

if (command === 'call') {
  line.once('ended', ({ reason }) => shutdown(/connect|prepare|Gemini/.test(reason ?? '') ? 1 : 0));
  try {
    await line.dial(target ?? '', { scenario: opt.scenario, name: opt.name, day: opt.day });
  } catch (err) {
    console.error(`❌ ${err.message}`);
    await shutdown(1);
  }
}
