// The Zadarma line as one object: registers, answers incoming calls, dials out, and runs each call on Gemini
// Live with the Mishlav prompt + tools. Used by the CLI (phone.js) and by the tools server (the dashboard's
// "call" button). One call at a time. Every line of the call log goes to logs/phone.jsonl and to 'log' events.
import { EventEmitter } from 'node:events';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { wav } from './audio.js';
import { CallAgent } from './call-agent.js';
import { buildSetup, DEFAULT_PHONE_MODEL, DEFAULT_VOICE, GeminiLive } from './gemini-live.js';
import { buildInstructions, loadToolDefinitions, ToolsClient } from './mishlav.js';
import { dialable, maskNumber } from './numbers.js';
import { usageLine } from './usage.js';

// The customer's gender, decided before the call (GET /test/context): shown in the call log, and repeated in
// every tool answer so the bot doesn't drift mid-call (it switched between "לְךָ" and "לָךְ" with "רועי").
const GENDER_HE = { male: 'גבר', female: 'אישה', unknown: 'מגדר לא ידוע' };
const GENDER_REMINDER = {
  male: 'הלקוח גבר – לפנות אליו בלשון זכר (אַתָּה, לְךָ, אֵלֶיךָ).',
  female: 'הלקוחה אישה – לפנות אליה בלשון נקבה (אַתְּ, לָךְ, אֵלַיִךְ).',
  unknown: null,
};
import { RtpSession } from './rtp.js';
import { buildSdp, pickCodec, SipUA } from './sip.js';

const RECENT = 400; // log lines kept in memory for the dashboard

/** Line settings from the environment (.env already loaded). */
export function phoneEnv(env = process.env, root) {
  return {
    apiKey: env.GOOGLE_API_KEY || env.GEMINI_API_KEY,
    model: env.PHONE_GEMINI_MODEL || DEFAULT_PHONE_MODEL,
    voice: env.PHONE_VOICE || env.GEMINI_VOICE || DEFAULT_VOICE,
    temperature: Number(env.GEMINI_TEMPERATURE ?? 0.6),
    openAfterSilenceMs: 1000 * Number(env.OPEN_AFTER_SILENCE_S ?? 4),
    baseUrl: env.TOOLS_BASE_URL || `http://127.0.0.1:${env.PORT || 8787}`,
    secret: env.TOOLS_SECRET,
    login: env.ZADARMA_SIP_LOGIN,
    password: env.ZADARMA_SIP_PASSWORD,
    server: env.ZADARMA_SIP_SERVER || 'sip.zadarma.com',
    port: Number(env.ZADARMA_SIP_PORT) || 5060,
    domain: env.ZADARMA_SIP_DOMAIN,
    number: env.ZADARMA_NUMBER || '',
    displayName: env.PHONE_DISPLAY_NAME,
    logDir: resolve(root, env.LOG_DIR || 'logs'),
  };
}

/** Names of the settings the line can't run without. */
export function missingPhoneEnv(e) {
  return Object.entries({
    GOOGLE_API_KEY: e.apiKey,
    TOOLS_SECRET: e.secret,
    ZADARMA_SIP_LOGIN: e.login,
    ZADARMA_SIP_PASSWORD: e.password,
  })
    .filter(([, v]) => !v)
    .map(([k]) => k);
}

/**
 * Events: 'log' ({ seq, ts, call_id, text }), 'call' (status() when a call starts), 'ended' ({ call_id, reason }).
 */
export class PhoneLine extends EventEmitter {
  constructor({ root, env, answer = true, record = false, incoming = {} }) {
    super();
    this.root = root;
    this.env = env;
    this.answer = answer; // answer incoming calls
    this.record = record;
    this.incoming = incoming; // scenario / name / day for incoming calls (default: the active test session)
    this.ua = null;
    this.registered = false;
    this.error = null;
    this.call = null; // the running call: { id, direction, number, scenario, started_at, sip }
    this.recent = [];
    this.usage = new Map(); // call_id -> Gemini tokens, until the call's 'ended'
    this.seq = 0;
    this.toolDefs = loadToolDefinitions(root);
    mkdirSync(env.logDir, { recursive: true });
    this.logFile = join(env.logDir, 'phone.jsonl');
  }

  log(text, callId = this.call?.id ?? null) {
    const line = { seq: ++this.seq, ts: new Date().toISOString(), call_id: callId, text };
    this.recent.push(line);
    if (this.recent.length > RECENT) this.recent.shift();
    try {
      appendFileSync(this.logFile, `${JSON.stringify(line)}\n`);
    } catch {}
    this.emit('log', line);
  }

  status() {
    const c = this.call;
    return {
      registered: this.registered,
      error: this.error,
      number: this.env.number,
      model: this.env.model,
      voice: this.env.voice,
      busy: Boolean(c),
      call: c && { id: c.id, direction: c.direction, number: maskNumber(c.number), scenario: c.scenario, started_at: c.started_at },
    };
  }

  /** Model check, tools server check, then register with Zadarma (and answer calls, if `answer`). */
  async start() {
    const e = this.env;
    buildSetup({ model: e.model, voice: e.voice, instructions: '', tools: this.toolDefs }); // throws on a bad model
    await new ToolsClient({ baseUrl: e.baseUrl, secret: e.secret }).check();
    this.ua = new SipUA({ server: e.server, port: e.port, user: e.login, password: e.password, domain: e.domain || e.server });
    this.ua.on('error', (err) => this.log(`SIP error: ${err.message}`));
    try {
      const reg = await this.ua.start();
      this.registered = true;
      this.error = null;
      this.log(`✅ registered with Zadarma (${e.server})${e.number ? ` · number ${e.number}` : ''} · our address ${reg.publicIp}:${reg.publicPort} · ${e.model} · voice ${e.voice}`, null);
    } catch (err) {
      this.error = `could not register with Zadarma: ${err.message}`;
      this.log(`❌ ${this.error}`, null);
      await this.ua.stop().catch(() => {}); // free the socket: the caller may retry with a new one
      this.ua = null;
      throw new Error(this.error);
    }
    if (this.answer) {
      this.ua.on('incoming', (call) => this._incoming(call).catch((err) => this.log(`❌ ${err.message}`)));
      this.log(`waiting for calls${e.number ? ` to ${e.number}` : ''}`, null);
    }
  }

  async stop() {
    if (this.call?.sip) await this.call.sip.hangup().catch(() => {});
    if (this.ua) await this.ua.stop().catch(() => {});
    this.registered = false;
  }

  /** The number of the call on the line now, if it is `callId` (the purchase-link SMS of a scenario call). */
  numberFor(callId) {
    return this.call && this.call.id === callId ? this.call.number : null;
  }

  /** Hang up the running call (from the dashboard). */
  async hangup() {
    if (!this.call?.sip) return false;
    this.log('📴 hung up from the dashboard');
    await this.call.sip.hangup().catch(() => {});
    return true;
  }

  /**
   * Dial out. Resolves with { call_id } once the call is placed (ringing), not when it ends: listen to
   * 'ended' for that. Throws on a bad number, a busy line, or a bot that can't be prepared.
   * ringTimeoutMs: no answer by then -> the call is cancelled and ends like any unanswered call.
   */
  async dial(rawNumber, { scenario, name, day, gender, ringTimeoutMs } = {}) {
    if (!this.registered) throw new Error(this.error || 'the line is not registered with Zadarma');
    if (this.call) throw new Error('a call is already running on the line');
    const number = dialable(rawNumber);
    const callId = newCallId();
    this.call = { id: callId, direction: 'out', number, scenario: scenario ?? null, started_at: new Date().toISOString(), sip: null };
    let prep;
    try {
      prep = await this._prepare(callId, { scenario, name, day, gender });
    } catch (err) {
      this._finish(callId, `could not prepare the bot: ${err.message}`);
      throw err;
    }
    this.call.scenario = prep.scenario;
    this.emit('call', this.status());
    this._dialOut(number, prep, ringTimeoutMs).catch((err) => {
      this.log(`❌ ${err.message}`, callId);
      this._finish(callId, err.message);
    });
    return { call_id: callId };
  }

  async _dialOut(number, prep, ringTimeoutMs) {
    const rtp = new RtpSession();
    await rtp.open();
    const ready = prep.agent.connect(); // connect to Gemini while the phone rings
    ready.catch(() => {});
    this.log(`📞 calling ${maskNumber(number)}…`, prep.callId);
    // The callee sees the line's number (CallerID in Zadarma); a display name only if PHONE_DISPLAY_NAME is set
    const call = this.ua.invite(number, buildSdp({ ip: this.ua.publicIp, port: rtp.port }), { displayName: this.env.displayName });
    if (this.call?.id === prep.callId) this.call.sip = call;
    call.on('ringing', (status, sdp) => {
      this.log(status === 183 ? 'ringing (183)…' : 'ringing…', prep.callId);
      if (sdp?.port) rtp.setRemote(sdp.ip, sdp.port, pickCodec(sdp.payloads) ?? 8);
    });
    // Without it an unanswered INVITE waits for the SIP transaction (3 minutes): cancel it, as a hangup would
    let rangOut = false;
    const ringTimer =
      ringTimeoutMs > 0 &&
      setTimeout(() => {
        rangOut = true;
        this.log(`no answer after ${Math.round(ringTimeoutMs / 1000)}s: cancelling`, prep.callId);
        call.hangup().catch(() => {});
      }, ringTimeoutMs);
    let answer;
    try {
      answer = await call.answered;
    } catch (err) {
      prep.agent.end();
      rtp.close();
      throw new Error(rangOut ? `no answer (${Math.round(ringTimeoutMs / 1000)}s)` : `the call did not connect: ${err.message}`);
    } finally {
      clearTimeout(ringTimer);
    }
    try {
      await ready;
    } catch (err) {
      await call.hangup();
      prep.agent.end();
      rtp.close();
      throw new Error(`could not connect to Gemini: ${err.message}`);
    }
    this.log('✅ answered', prep.callId);
    rtp.setRemote(answer.ip, answer.port, pickCodec(answer.payloads) ?? 8);
    const reason = await this._run({ call, rtp, prep });
    this._finish(prep.callId, reason);
  }

  async _incoming(call) {
    if (this.call) {
      this.log(`📞 incoming call from ${maskNumber(call.number)} while busy: rejected`, null);
      call.reject(486, 'Busy Here');
      return;
    }
    const callId = newCallId();
    this.call = { id: callId, direction: 'in', number: call.number, scenario: null, started_at: new Date().toISOString(), sip: call };
    this.log(`📞 incoming call from ${maskNumber(call.number)}`, callId);
    const codec = pickCodec(call.remoteSdp.payloads);
    if (codec == null || !call.remoteSdp.port) {
      this.log('❌ the other side offered no codec we support (PCMA/PCMU)', callId);
      call.reject(488, 'Not Acceptable Here');
      this._finish(callId, 'no codec');
      return;
    }
    call.ringing();
    const rtp = new RtpSession();
    let prep;
    try {
      prep = await this._prepare(callId, this.incoming);
      this.call.scenario = prep.scenario;
      await Promise.all([prep.agent.connect(), rtp.open()]); // connect to Gemini while the phone rings
    } catch (err) {
      this.log(`❌ could not start the bot: ${err.message}`, callId);
      call.reject(503, 'Service Unavailable');
      prep?.agent.end();
      rtp.close();
      this._finish(callId, err.message);
      return;
    }
    if (call.state === 'ended') {
      this.log('the caller hung up before we answered', callId);
      prep.agent.end();
      rtp.close();
      this._finish(callId, 'caller hung up before answer');
      return;
    }
    this.emit('call', this.status());
    call.answer(buildSdp({ ip: this.ua.publicIp, port: rtp.port, payloadTypes: [codec] }));
    rtp.setRemote(call.remoteSdp.ip, call.remoteSdp.port, codec);
    const reason = await this._run({ call, rtp, prep });
    this._finish(callId, reason);
    this.log(`waiting for calls${this.env.number ? ` to ${this.env.number}` : ''}…`, null);
  }

  _finish(callId, reason) {
    const usage = this.usage.get(callId);
    this.usage.delete(callId);
    if (this.call?.id === callId) this.call = null;
    this.emit('ended', { call_id: callId, reason, ...(usage?.messages && { usage: { model: this.env.model, input: usage.input, output: usage.output } }) });
  }

  /** One call's bot: prompt variables, Gemini session and tools client. */
  async _prepare(callId, { scenario, name, day, gender }) {
    const e = this.env;
    const tools = new ToolsClient({ baseUrl: e.baseUrl, secret: e.secret, provider: 'C', callId });
    const session = await tools.currentSession();
    if (session && session.provider !== 'C') this.log(`⚠ the active test session is for provider ${session.provider}, this line is C`, callId);
    const ctx = await tools.callContext({ scenario, firstName: name, dayId: day, gender });
    const setup = buildSetup({
      model: e.model,
      voice: e.voice,
      instructions: buildInstructions(this.root, ctx.variables),
      tools: this.toolDefs,
      temperature: e.temperature,
    });
    const customerGender = ctx.variables.customer_gender ?? 'unknown'; // as decided for this call
    const agent = new CallAgent({
      live: new GeminiLive({ apiKey: e.apiKey, setup }),
      tools,
      openAfterSilenceMs: e.openAfterSilenceMs,
      genderReminder: GENDER_REMINDER[customerGender],
    });
    this.log(`call ${callId}: scenario ${ctx.scenario ?? '-'}, first_name ${ctx.variables.first_name} (${GENDER_HE[customerGender] ?? customerGender}), day ${ctx.variables.interested_day_id}`, callId);
    return { callId, tools, session, agent, scenario: ctx.scenario };
  }

  /** Runs a call that is already up on the line (SIP + RTP) to its end. Resolves with the end reason. */
  _run({ call, rtp, prep }) {
    const { callId, tools, session, agent } = prep;
    const logDir = this.env.logDir;
    return new Promise((resolveCall) => {
      const transcript = join(logDir, 'transcripts', `${callId}.jsonl`);
      mkdirSync(join(logDir, 'transcripts'), { recursive: true });
      const startedAt = Date.now();
      const write = (role, text) =>
        appendFileSync(transcript, `${JSON.stringify({ ts: new Date().toISOString(), role, text })}\n`);

      agent.on('line', ({ who, text }) => {
        this.log(who === 'lead' ? `לקוח: ${text}` : who === 'agent' ? `בוט:  ${text}` : who === 'tool' ? `🔧 ${text}` : `      (${text})`, callId);
        if (who === 'lead') write('user', text);
        else if (who === 'agent') write('assistant', text);
      });
      agent.on('hangup', (reason) => {
        this.log(`📴 hanging up: ${reason}`, callId);
        call.hangup();
      });
      call.once('ended', async (reason) => {
        agent.end();
        rtp.close();
        const secs = Math.round((Date.now() - startedAt) / 1000);
        const who = reason === 'bye' ? 'the caller hung up' : reason === 'local' ? 'the bot hung up' : reason;
        this.log(`call ended (${who}) · ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')} · audio: sent ${rtp.sent}, received ${rtp.received} (lost ${rtp.lost}, late ${rtp.late})`, callId);
        const usage = agent.usage.snapshot();
        this.usage.set(callId, usage); // goes out with 'ended' (the contact's call row keeps it)
        if (usage.messages) this.log(`AI tokens: ${usageLine(usage)}`, callId);
        const posted = await tools.postMetrics({
          ...(session?.session_id && { session_id: session.session_id }),
          call_id: callId,
          turns: agent.turns,
          duration_sec: secs,
          source: `zadarma-phone/${this.env.model}`,
          ...(usage.messages && { ai_usage: { model: this.env.model, input: usage.input, output: usage.output } }),
        });
        const lat = agent.turns.map((t) => t.latency_ms);
        this.log(`latency: ${lat.length ? `${lat.length} turns, median ${lat.sort((a, b) => a - b)[Math.floor(lat.length / 2)]}ms` : 'no turns'}${posted ? '' : ' (metrics not posted)'}`, callId);
        const rec = agent.recording();
        if (rec) {
          mkdirSync(join(logDir, 'recordings'), { recursive: true });
          const file = join(logDir, 'recordings', `${callId}.wav`);
          writeFileSync(file, wav(rec));
          this.log(`recording: ${file}`, callId);
        }
        this.log(`transcript: ${transcript}`, callId);
        resolveCall(who);
      });
      rtp.start();
      agent.start(rtp, { record: this.record });
    });
  }
}

function newCallId() {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
  return `phone-${stamp}-${randomBytes(2).toString('hex')}`;
}
