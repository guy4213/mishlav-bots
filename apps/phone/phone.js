// The Mishlav bot on a Zadarma phone line (SIP), with Gemini Live as the voice.
//
//   npm run phone                         wait for calls to the Zadarma number; the bot answers
//   npm run phone -- call 0501234567      the bot calls that number (costs Zadarma balance), then exits
//   options: --scenario S1  --name דנה  --day <day_id>  --model <id>  --voice <name>  --record
//
// Needs the tools server (`npm run dev`, another terminal). Per call, the same inputs as provider C's worker:
// prompt variables from GET /test/context (the active test session's scenario, or --scenario / --name / --day),
// config/prompt.md + the knowledge base, the 5 tools from config/tools.json (POST to the tools server with
// X-Provider: C and X-Call-Id), transcript to logs/transcripts/, per-turn latency to /test/metrics.
// .env: GOOGLE_API_KEY, TOOLS_SECRET, ZADARMA_SIP_SERVER / ZADARMA_SIP_LOGIN / ZADARMA_SIP_PASSWORD
// (a line on Zadarma's cloud PBX registers as an extension: login like 660895-100, server pbx.zadarma.com).
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { wav } from './src/audio.js';
import { CallAgent } from './src/call-agent.js';
import { buildSetup, DEFAULT_PHONE_MODEL, DEFAULT_VOICE, GeminiLive } from './src/gemini-live.js';
import { buildInstructions, findRepoRoot, loadToolDefinitions, ToolsClient } from './src/mishlav.js';
import { dialable, maskNumber } from './src/numbers.js';
import { RtpSession } from './src/rtp.js';
import { buildSdp, pickCodec, SipUA } from './src/sip.js';

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

const env = {
  apiKey: process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY,
  model: opt.model || process.env.PHONE_GEMINI_MODEL || DEFAULT_PHONE_MODEL,
  voice: opt.voice || process.env.PHONE_VOICE || process.env.GEMINI_VOICE || DEFAULT_VOICE,
  temperature: Number(process.env.GEMINI_TEMPERATURE ?? 0.6),
  openAfterSilenceMs: 1000 * Number(process.env.OPEN_AFTER_SILENCE_S ?? 4),
  baseUrl: process.env.TOOLS_BASE_URL || 'http://127.0.0.1:8787',
  secret: process.env.TOOLS_SECRET,
  login: process.env.ZADARMA_SIP_LOGIN,
  password: process.env.ZADARMA_SIP_PASSWORD,
  server: process.env.ZADARMA_SIP_SERVER || 'sip.zadarma.com',
  port: Number(process.env.ZADARMA_SIP_PORT) || 5060,
  number: process.env.ZADARMA_NUMBER || '',
  logDir: resolve(ROOT, process.env.LOG_DIR || 'logs'),
};

const time = () => new Date().toLocaleTimeString('he-IL', { hour12: false, timeZone: 'Asia/Jerusalem' });
const log = (text) => console.log(`[${time()}] ${text}`);

const missing = Object.entries({
  GOOGLE_API_KEY: env.apiKey,
  TOOLS_SECRET: env.secret,
  ZADARMA_SIP_LOGIN: env.login,
  ZADARMA_SIP_PASSWORD: env.password,
})
  .filter(([, v]) => !v)
  .map(([k]) => k);
if (missing.length) {
  console.error(`missing in .env: ${missing.join(', ')}`);
  process.exit(1);
}

const toolDefs = loadToolDefinitions(ROOT);
try {
  buildSetup({ model: env.model, voice: env.voice, instructions: '', tools: toolDefs }); // model check
  await new ToolsClient({ baseUrl: env.baseUrl, secret: env.secret }).check();
} catch (err) {
  console.error(`❌ ${err.message}`);
  process.exit(1);
}

/** One call's bot: its own call id, prompt variables, Gemini session and tools client. */
async function prepareCall() {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
  const callId = `phone-${stamp}-${randomBytes(2).toString('hex')}`;
  const tools = new ToolsClient({ baseUrl: env.baseUrl, secret: env.secret, provider: 'C', callId });
  const session = await tools.currentSession();
  if (session && session.provider !== 'C') log(`⚠ the active test session is for provider ${session.provider}, this line is C`);
  const { scenario, variables } = await tools.callContext({ scenario: opt.scenario, firstName: opt.name, dayId: opt.day });
  const setup = buildSetup({
    model: env.model,
    voice: env.voice,
    instructions: buildInstructions(ROOT, variables),
    tools: toolDefs,
    temperature: env.temperature,
  });
  const agent = new CallAgent({ live: new GeminiLive({ apiKey: env.apiKey, setup }), tools, openAfterSilenceMs: env.openAfterSilenceMs });
  log(`call ${callId}: scenario ${scenario ?? '-'}, first_name ${variables.first_name}, day ${variables.interested_day_id}`);
  return { callId, tools, session, agent };
}

/** Runs a call that is already up on the line (SIP + RTP) to its end. Resolves when it ends. */
function runCall({ call, rtp, prep }) {
  const { callId, tools, session, agent } = prep;
  return new Promise((resolveCall) => {
    const transcript = join(env.logDir, 'transcripts', `${callId}.jsonl`);
    mkdirSync(join(env.logDir, 'transcripts'), { recursive: true });
    const startedAt = Date.now();
    const write = (role, text) =>
      appendFileSync(transcript, `${JSON.stringify({ ts: new Date().toISOString(), role, text })}\n`);

    agent.on('line', ({ who, text }) => {
      log(who === 'lead' ? `לקוח: ${text}` : who === 'agent' ? `בוט:  ${text}` : who === 'tool' ? `🔧 ${text}` : `      (${text})`);
      if (who === 'lead') write('user', text);
      else if (who === 'agent') write('assistant', text);
    });
    agent.on('hangup', (reason) => {
      log(`📴 hanging up: ${reason}`);
      call.hangup();
    });
    call.once('ended', async (reason) => {
      agent.end();
      rtp.close();
      const secs = Math.round((Date.now() - startedAt) / 1000);
      const who = reason === 'bye' ? 'the caller hung up' : reason === 'local' ? 'the bot hung up' : reason;
      log(`call ended (${who}) · ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')} · audio: sent ${rtp.sent}, received ${rtp.received} (lost ${rtp.lost}, late ${rtp.late})`);
      const posted = await tools.postMetrics({
        ...(session?.session_id && { session_id: session.session_id }),
        call_id: callId,
        turns: agent.turns,
        duration_sec: secs,
        source: `zadarma-phone/${env.model}`,
      });
      const lat = agent.turns.map((t) => t.latency_ms);
      log(`latency: ${lat.length ? `${lat.length} turns, median ${lat.sort((a, b) => a - b)[Math.floor(lat.length / 2)]}ms` : 'no turns'}${posted ? '' : ' (metrics not posted)'}`);
      const rec = agent.recording();
      if (rec) {
        mkdirSync(join(env.logDir, 'recordings'), { recursive: true });
        const file = join(env.logDir, 'recordings', `${callId}.wav`);
        writeFileSync(file, wav(rec));
        log(`recording: ${file}`);
      }
      log(`transcript: ${transcript}`);
      resolveCall(reason);
    });
    rtp.start();
    agent.start(rtp, { record: opt.record });
  });
}

const ua = new SipUA({
  server: env.server,
  port: env.port,
  user: env.login,
  password: env.password,
  domain: process.env.ZADARMA_SIP_DOMAIN || env.server,
});
ua.on('error', (err) => log(`SIP error: ${err.message}`));

let reg;
try {
  reg = await ua.start();
} catch (err) {
  log(`❌ could not register with Zadarma: ${err.message}`);
  process.exit(1);
}
log(`✅ registered with Zadarma (${env.server})${env.number ? ` · number ${env.number}` : ''} · our address ${reg.publicIp}:${reg.publicPort} · ${env.model} · voice ${env.voice}`);

let shuttingDown = false;
async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('unregistering from Zadarma…');
  await ua.stop().catch(() => {});
  process.exit(code);
}
process.on('SIGINT', () => shutdown(0));

if (command === 'call') {
  /* ---------------- outbound ---------------- */
  let number;
  try {
    number = dialable(target ?? '');
  } catch (err) {
    log(err.message);
    await shutdown(1);
  }
  let prep;
  try {
    prep = await prepareCall();
  } catch (err) {
    log(`❌ ${err.message}`);
    await shutdown(1);
  }
  const rtp = new RtpSession();
  await rtp.open();
  const ready = prep.agent.connect(); // connect to Gemini while the phone rings
  ready.catch(() => {});
  log(`📞 calling ${maskNumber(number)}…`);
  // The callee sees the line's number (CallerID in Zadarma); a display name only if PHONE_DISPLAY_NAME is set
  const call = ua.invite(number, buildSdp({ ip: ua.publicIp, port: rtp.port }), { displayName: process.env.PHONE_DISPLAY_NAME });
  call.on('ringing', (status, sdp) => {
    log(status === 183 ? 'ringing (183)…' : 'ringing…');
    if (sdp?.port) rtp.setRemote(sdp.ip, sdp.port, pickCodec(sdp.payloads) ?? 8);
  });
  let answer;
  try {
    answer = await call.answered;
  } catch (err) {
    log(`❌ the call did not connect: ${err.message}`);
    prep.agent.end();
    rtp.close();
    await shutdown(1);
  }
  try {
    await ready;
  } catch (err) {
    log(`❌ could not connect to Gemini: ${err.message}`);
    await call.hangup();
    prep.agent.end();
    rtp.close();
    await shutdown(1);
  }
  log('✅ answered');
  rtp.setRemote(answer.ip, answer.port, pickCodec(answer.payloads) ?? 8);
  await runCall({ call, rtp, prep });
  await shutdown(0);
} else if (command) {
  console.error(`unknown command: ${command} (none = answer calls, or: call <number>)`);
  await shutdown(1);
} else {
  /* ---------------- inbound ---------------- */
  log(`waiting for calls${env.number ? ` to ${env.number}` : ''}. Ctrl+C to stop`);
  ua.on('incoming', async (call) => {
    log(`📞 incoming call from ${maskNumber(call.number)}`);
    const codec = pickCodec(call.remoteSdp.payloads);
    if (codec == null || !call.remoteSdp.port) {
      log('❌ the other side offered no codec we support (PCMA/PCMU)');
      call.reject(488, 'Not Acceptable Here');
      return;
    }
    call.ringing();
    const rtp = new RtpSession();
    let prep;
    try {
      prep = await prepareCall();
      await Promise.all([prep.agent.connect(), rtp.open()]); // connect to Gemini while the phone rings
    } catch (err) {
      log(`❌ could not start the bot: ${err.message}`);
      call.reject(503, 'Service Unavailable');
      prep?.agent.end();
      rtp.close();
      return;
    }
    if (call.state === 'ended') {
      log('the caller hung up before we answered');
      prep.agent.end();
      rtp.close();
      return;
    }
    call.answer(buildSdp({ ip: ua.publicIp, port: rtp.port, payloadTypes: [codec] }));
    rtp.setRemote(call.remoteSdp.ip, call.remoteSdp.port, codec);
    await runCall({ call, rtp, prep });
    log(`waiting for calls${env.number ? ` to ${env.number}` : ''}…`);
  });
}
