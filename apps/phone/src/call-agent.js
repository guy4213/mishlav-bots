// One phone call <-> Gemini Live: the caller's audio goes to the bot, the bot's answer plays on the line,
// tool calls go to the tools server. Line handling ported from gemini-live-agent/phone/call-agent.js (tuned on
// real Zadarma calls: quiet-line fix, barge-in hold, silence check); opening and end_call as provider C's worker.
import { EventEmitter } from 'node:events';
import { Downsampler, FRAME_SAMPLES, PHONE_RATE, pcmBuffer, pcmView, rms } from './audio.js';
import { UsageMeter } from './usage.js';

const VOICE_RMS = 0.02; // above this level on the line, the caller is talking (for the silence count)
// Silence on a real phone line is very faint noise (samples of ±8, about -72 dB) and Gemini's end-of-speech
// detection thinks the caller is still talking: on a real call it detected the end only after 14 s and the bot
// never answered. Such a frame is sent as clean silence, and the end of speech is detected at once.
const SILENCE_RMS = 0.002;
const MAX_CALL_MS = 15 * 60 * 1000;
// Barge-in: while the bot is audible, the caller's audio is held aside (Gemini gets silence). On real calls
// every short word ("כן", "מעולה") stopped the bot mid-sentence; now only real speech cuts in, and what was
// held is sent with it so the start of the sentence isn't lost. What the caller said right at the end of the
// bot's sentence is sent when the bot finishes: it is probably the answer. Length = continuous speech
// (short gaps between words don't break it).
const HOLD_MS = 2000; // the last 2 s the caller said are kept, and sent when they cut in
const BARGE_MS = 600; // 600 ms of continuous speech cuts the bot off (a lone "מעולה" is ~0.5 s)
const WORD_GAP_MS = 250; // a shorter pause is still the same sentence
const ANSWER_MS = 1000; // speech in the last second before the bot finished is sent when it finishes
const ECHO_TAIL_MS = 250; // keep holding a moment after the bot stops being audible
const START_BUFFER = 3 * FRAME_SAMPLES; // 60 ms of audio before playback starts, against network jitter

const CALLER_SPOKE_FRAMES = 5; // 100 ms of voice = the callee said something ("הלו")
const SILENCE_CHECK_MS = 6000; // quiet line this long -> the bot checks the line; the second time it says goodbye
const SILENCE_GOODBYE_MAX_MS = 9000; // the no-answer goodbye can't run longer than this
// end_call (as the worker's tools.py): the words before it play out; then the reply to its result (the goodbye,
// only if none was said yet) plays, and the line drops.
const END_REPLY_START_MS = 2500; // no reply to the end_call result by then: the goodbye was already said
const HANGUP_GRACE_MS = 600; // after the last words, so the goodbye isn't clipped
const END_MAX_MS = 15000;
const TURN_MIN_VOICED_FRAMES = 10;
// After an action that ends the call (link sent, callback booked, handed to a rep: `closing: true` in the tool
// answer) the line drops once the closing sentence played and the line is quiet this long - also when the model
// never calls end_call (on real calls it said goodbye and left the line open).
const CLOSE_WAIT_MS = 2000;
// The caller talking this long after the goodbye is a new request ("רגע, עוד שאלה"), not a "תודה, ביי":
// the call goes on.
const CLOSE_CANCEL_MS = 1500;
// Every fixed closing sentence ends with "יום נעים, להתראות!" (apps/backend/src/tools/closings.ts): once the bot
// said it since the caller last spoke, the reply to end_call is not played (it repeated the goodbye).
const GOODBYE_WORD = 'להתראות'; // a caller turn for the latency metric: at least 200 ms of voice

// Sent to the bot as text, never shown in the transcript.
export const CUES = {
  open: '(הודעת מערכת: השיחה התחברה והלקוח על הקו, אבל עוד לא אמר כלום. לפתוח את השיחה עכשיו במשפט הפתיחה מהשלב הראשון בזרימת השיחה.)',
  silence: '(הודעת מערכת: שקט על הקו כבר כמה שניות. הלקוח לא עונה.)',
  hangup: '(הודעת מערכת: אין מענה על הקו. לומר רק את המשפט: "נראה שלא שומעים, נדבר בהזדמנות אחרת. יום נעים, להתראות!")',
};

/**
 * Events:
 *  'line' ({ who: 'lead' | 'agent' | 'tool' | 'note', text })   a transcript line
 *  'hangup' (reason)                                           drop the call (end_call, silence, failure)
 */
export class CallAgent extends EventEmitter {
  /**
   * @param {{ live: import('./gemini-live.js').GeminiLive, tools: import('./mishlav.js').ToolsClient,
   *           openAfterSilenceMs?: number, genderReminder?: string | null }} opts
   */
  constructor({ live, tools, openAfterSilenceMs = 4000, genderReminder = null }) {
    super();
    this.genderReminder = genderReminder; // added to every tool answer the bot gets (not logged by the server)
    this.usage = new UsageMeter(); // Gemini tokens of this call (what it cost)
    this.live = live;
    this.tools = tools;
    this.openAfterSilenceMs = openAfterSilenceMs;
    this.down = new Downsampler();
    this.queue = []; // bot audio waiting to play (8 kHz)
    this.queueOffset = 0;
    this.queued = 0;
    this.playing = false;
    this.inFrames = [];
    this.held = []; // what the caller said while the bot was audible (20 ms frames)
    this.holding = false;
    this.seg = null; // the caller's current speech while the bot is audible: { start, last, peak, noted }
    this.bargedIn = false; // the caller cut in: until the next answer, the caller reaches Gemini at once
    this.audibleUntil = 0;
    this.agentTurnActive = false;
    this.turnText = '';
    this.leadText = '';
    this.waitingSince = 0; // a cue or tool result was sent and the bot hasn't started answering
    this.lastVoice = 0;
    this.lastAudioAt = 0; // last audio chunk from Gemini
    this.voicedRun = 0;
    this.quietSince = 0;
    this.silenceChecks = 0;
    this.hangupState = null; // no answer on the line: { at, spokeAt }
    this.ending = null; // after end_call: { voicemail, mute, at, replyAudio, quietSince }
    // A whole bot turn ended since the caller last spoke: the caller already heard the answer (e.g. the goodbye
    // before an end_call that the silence check prompted). Then the reply to the end_call result is not played:
    // in a test the model said the goodbye again. Words in the same turn as end_call (a filler) don't count.
    this.answeredSinceLead = false;
    this.saidSinceLead = ''; // the bot's words since the caller last spoke
    this.closing = null; // after a closing action: { spoke, doneAt, voiced }
    this.callerVoiceAt = 0; // last time the caller really talked (100 ms of voice)
    this.turnHadAudio = false;
    this.opened = false;
    this.callerSpoke = false;
    this.agentSpoke = false;
    this.toolsPending = 0;
    this.cancelled = new Set();
    this.turns = []; // latency per turn, for /test/metrics
    this.botEndedAt = 0;
    this.leadVoicedFrames = 0;
    this.ended = false;
    this.rec = null; // recording: { lead: [], agent: [] }
    // No "read the instructions while ringing" turn: tried once (Nov 2026), Gemini answered it in English and
    // went on in English, skipping the opening. The instructions are sent at connect; the bot opens on "הלו".
    this.firstAnswerNoted = false;
    this._wire();
  }

  /** Connects to Gemini (before the call is answered, so the bot is ready at once). */
  connect() {
    return this.live.connect();
  }

  /** The call is up: wire the audio. The bot waits for the callee's "הלו", or opens after a short silence. */
  start(rtp, { record = false } = {}) {
    this.rtp = rtp;
    if (record) this.rec = { lead: [], agent: [] };
    rtp.nextFrame = () => this._nextFrame();
    rtp.on('audio', (samples) => this._fromLead(samples));
    this.startedAt = this.quietSince = performance.now();
    this.openAt = this.startedAt + Math.max(0, this.openAfterSilenceMs);
    this._watchTimer = setInterval(() => this._watch(), 50);
    if (this.openAfterSilenceMs <= 0) this._open();
  }

  end() {
    if (this.ended) return;
    this.ended = true;
    clearInterval(this._watchTimer);
    this._logLead();
    this._logAgent(false);
    this.live.close();
  }

  /** The call's recording: left channel = the caller, right channel = the bot (8 kHz). */
  recording() {
    if (!this.rec) return null;
    const join = (frames) => {
      const out = new Int16Array(frames.reduce((n, f) => n + f.length, 0));
      let o = 0;
      for (const f of frames) out.set(f, (o += f.length) - f.length);
      return out;
    };
    const lead = join(this.rec.lead);
    const agent = join(this.rec.agent);
    const n = Math.max(lead.length, agent.length);
    const stereo = new Int16Array(n * 2);
    for (let i = 0; i < n; i++) {
      stereo[2 * i] = lead[i] ?? 0;
      stereo[2 * i + 1] = agent[i] ?? 0;
    }
    return { samples: stereo, rate: PHONE_RATE, channels: 2 };
  }

  /* ---------------- Gemini ---------------- */

  _wire() {
    const a = this.live;
    a.on('audio', (buf) => {
      if (this.ended || this.ending?.voicemail || this.ending?.mute) return; // voicemail: the bot says nothing
      const now = performance.now();
      if (this.ending) this.ending.replyAudio = true;
      if (this.closing) this.closing.spoke = true;
      this.turnHadAudio = true;
      if (!this.agentTurnActive) {
        this._logLead(); // the bot starts answering: what the caller said so far goes to the transcript
        this.bargedIn = false; // a new answer: a short word doesn't cut it again
      }
      this.agentTurnActive = true;
      this.agentSpoke = true;
      this.waitingSince = 0;
      this.lastAudioAt = now;
      if (this.hangupState && !this.hangupState.spokeAt) this.hangupState.spokeAt = now;
      this._play(this.down.push(pcmView(buf)));
    });
    a.on('outputTranscript', (text) => {
      this.turnText += text;
      this.saidSinceLead += text;
    });
    a.on('inputTranscript', (text) => {
      this.leadText += text;
      if (text.trim()) {
        this.callerSpoke = true;
        this._leadSpoke();
      }
    });
    a.on('voiceActivity', (va) => {
      if (va?.type === 'ACTIVITY_START') {
        this.callerSpoke = true;
        this._leadSpoke();
      }
    });
    a.on('interrupted', () => {
      // The caller cut in: stop playing at once
      this._flush();
      this.agentTurnActive = false;
      this.turnHadAudio = false;
      this._logAgent(true);
    });
    a.on('turnComplete', () => {
      this.agentTurnActive = false;
      if (this.turnHadAudio) this.answeredSinceLead = true;
      // The fixed goodbye was said without end_call (R2: it said it 4 times - the silence checks asked again):
      // the call is over, hang up once the line is quiet, as after a closing action.
      if (this.turnHadAudio && !this.ending && !this.closing && this.turnText.includes(GOODBYE_WORD)) {
        this.closing = { spoke: true, doneAt: 0, voiced: 0 };
        this.emit('line', { who: 'note', text: 'goodbye said without end_call: hanging up when the line is quiet' });
      }
      this.turnHadAudio = false;
      this._logAgent(false);
    });
    a.on('toolCall', (calls) => this._onToolCall(calls));
    a.on('usage', (md) => this.usage.add(md));
    a.on('toolCancel', (ids) => ids.forEach((id) => this.cancelled.add(id)));
    a.on('goAway', (timeLeft) => this.emit('line', { who: 'note', text: `Gemini goAway (${timeLeft ?? '?'})` }));
    a.on('close', ({ code, reason }) => {
      if (this.ended) return;
      this.emit('line', { who: 'note', text: `Gemini closed the connection (${code}${reason ? `: ${reason}` : ''})` });
      this._hangup('gemini-closed');
    });
    a.on('error', (err) => this.emit('line', { who: 'note', text: `Gemini error: ${err.message}` }));
  }

  /** The tools run on the tools server (validation, logging, answers); the result goes back to the model. */
  async _onToolCall(calls) {
    this.toolsPending++;
    this._logAgent(false); // the words before the tool call come first in the transcript
    const responses = [];
    let endCall = null;
    let closing = false;
    try {
      for (const fc of calls) {
        const args = fc.args ?? {};
        const body = await this.tools.callTool(fc.name, args);
        const result = body.status ?? (body.ok ? 'ok' : body.error);
        this.emit('line', { who: 'tool', text: `${fc.name}(${JSON.stringify(args)}) → ${result}` });
        if (this.cancelled.has(fc.id)) continue;
        // As LiveKit sends it (livekit/plugins/google/utils.py): the JSON text under "output"
        const forBot = this.genderReminder && body && typeof body === 'object' ? { ...body, customer_gender_he: this.genderReminder } : body;
        responses.push({ id: fc.id, name: fc.name, response: { output: JSON.stringify(forBot) } });
        if (fc.name === 'end_call' && body.ok) endCall = { voicemail: args.reason === 'voicemail' };
        if (body.ok && body.closing) closing = true;
      }
    } finally {
      this.toolsPending--;
    }
    if (this.ended) return;
    this.live.sendToolResponse(responses);
    this.waitingSince = performance.now();
    if (closing && !endCall) this.closing = { spoke: false, doneAt: 0, voiced: 0 };
    if (endCall) {
      const saidGoodbye = this.answeredSinceLead || this.saidSinceLead.includes(GOODBYE_WORD) || !!this.closing?.spoke;
      const mute = !endCall.voicemail && saidGoodbye;
      this.ending = { ...endCall, mute, at: performance.now(), replyAudio: false, quietSince: 0 };
      if (endCall.voicemail) this._flush();
      if (mute) this.emit('line', { who: 'note', text: 'end_call after a full answer: its reply is not played' });
    }
  }

  _open() {
    this.opened = true;
    this._cue(CUES.open);
  }

  _cue(text) {
    this.waitingSince = this.quietSince = performance.now();
    this.live.sendText(text);
  }

  _leadSpoke() {
    this.answeredSinceLead = false;
    this.saidSinceLead = '';
    this.quietSince = performance.now();
    this.silenceChecks = 0;
    this.hangupState = null;
    this.waitingSince = 0;
  }

  /* ---------------- Audio ---------------- */

  /** 20 ms of the caller: sent to Gemini (40 ms per message), or held aside while the bot is audible. */
  _fromLead(samples) {
    if (this.ended) return;
    const now = performance.now();
    const level = rms(samples);
    const voiced = level > VOICE_RMS;
    if (voiced) {
      this.lastVoice = now;
      this.leadVoicedFrames++;
      if (++this.voicedRun >= CALLER_SPOKE_FRAMES) {
        this.callerSpoke = true;
        this.answeredSinceLead = false;
        this.saidSinceLead = '';
        this.callerVoiceAt = now;
      }
      if (this.closing?.doneAt && (this.closing.voiced += 20) >= CLOSE_CANCEL_MS) {
        this.closing = null;
        this.emit('line', { who: 'note', text: 'the caller went on talking after the goodbye: the call goes on' });
      }
    } else this.voicedRun = 0;
    this.rec?.lead.push(samples);
    const frame = level < SILENCE_RMS ? new Int16Array(samples.length) : samples;

    const audible = this.queued > 0 || now < this.audibleUntil;
    if (audible && !this.bargedIn) {
      if (!this.holding) Object.assign(this, { holding: true, held: [], seg: null });
      this.held.push(frame);
      if (this.held.length > HOLD_MS / 20) this.held.shift();
      if (this._leadTalking(now, voiced, level)) {
        this.bargedIn = true;
        this.emit('line', { who: 'note', text: `caller talked ${this._segMs()}ms over the bot: bot stopped` });
        this._releaseHeld();
        return;
      }
      this._toAgent(new Int16Array(samples.length));
      return;
    }
    if (this.holding) {
      // The bot finished: what the caller said in the last second is probably the answer
      if (this.seg && now - this.seg.last < ANSWER_MS) this._releaseHeld();
      Object.assign(this, { holding: false, held: [], seg: null });
    }
    this._toAgent(frame);
  }

  /** Tracks the caller's speech while the bot is audible. True once it is long enough to cut in. */
  _leadTalking(now, voiced, level) {
    const s = this.seg;
    if (s && !s.noted && now - s.last >= ANSWER_MS) {
      s.noted = true;
      this.emit('line', { who: 'note', text: `caller said something short (${this._segMs()}ms) over the bot; bot went on` });
    }
    if (!voiced) return false;
    if (!s || now - s.last > WORD_GAP_MS) this.seg = { start: now, last: now, peak: level, noted: false };
    else Object.assign(s, { last: now, peak: Math.max(s.peak, level) });
    return now - this.seg.start + 20 >= BARGE_MS;
  }

  _segMs() {
    return Math.round(this.seg.last - this.seg.start + 20);
  }

  /** Sends what was held aside. */
  _releaseHeld() {
    const held = this.held;
    this.held = [];
    if (!held.length) return;
    this._flushToAgent();
    for (const frame of held) this.inFrames.push(frame);
    this._flushToAgent();
  }

  _toAgent(frame) {
    this.inFrames.push(frame);
    if (this.inFrames.length >= 2) this._flushToAgent();
  }

  _flushToAgent() {
    if (!this.inFrames.length) return;
    const pcm = new Int16Array(this.inFrames.reduce((n, f) => n + f.length, 0));
    let o = 0;
    for (const f of this.inFrames) {
      pcm.set(f, o);
      o += f.length;
    }
    this.inFrames = [];
    if (this.live.ready) this.live.sendAudio(pcmBuffer(pcm), PHONE_RATE);
  }

  _play(samples) {
    if (!samples?.length) return;
    this.queue.push(samples);
    this.queued += samples.length;
  }

  _flush() {
    if (this.playing) this.botEndedAt = performance.now();
    this.queue = [];
    this.queueOffset = 0;
    this.queued = 0;
    this.playing = false;
    this.down.reset();
  }

  /** A caller turn ended and the bot's answer starts playing now: one latency sample. */
  _botStarts(now) {
    const answered = this.leadVoicedFrames >= TURN_MIN_VOICED_FRAMES && this.lastVoice > this.botEndedAt;
    if (!this.firstAnswerNoted) {
      // the start of the call: how long the callee waited for the bot's first words
      this.firstAnswerNoted = true;
      const text = answered
        ? `first answer: ${Math.round(now - this.lastVoice)}ms after the caller stopped`
        : `bot opened ${Math.round(now - this.startedAt)}ms after the call was answered (the caller said nothing)`;
      this.emit('line', { who: 'note', text });
    }
    if (answered) {
      const ms = Math.round(now - this.lastVoice);
      if (ms < 15000) this.turns.push({ turn: this.turns.length + 1, latency_ms: ms });
    }
    this.leadVoicedFrames = 0;
  }

  /** The next frame to play on the line (160 samples), or null for silence. */
  _nextFrame() {
    let frame = null;
    if (this.queued && (this.playing || this.queued >= START_BUFFER || !this.agentTurnActive)) {
      if (!this.playing) this._botStarts(performance.now());
      this.playing = true;
      frame = new Int16Array(FRAME_SAMPLES);
      let n = 0;
      while (n < FRAME_SAMPLES && this.queue.length) {
        const head = this.queue[0];
        const take = Math.min(FRAME_SAMPLES - n, head.length - this.queueOffset);
        frame.set(head.subarray(this.queueOffset, this.queueOffset + take), n);
        n += take;
        this.queueOffset += take;
        if (this.queueOffset >= head.length) {
          this.queue.shift();
          this.queueOffset = 0;
        }
      }
      this.queued -= n;
      this.audibleUntil = performance.now() + ECHO_TAIL_MS;
    } else if (!this.queued && this.playing) {
      this.playing = false;
      this.botEndedAt = performance.now();
      this.leadVoicedFrames = 0;
    }
    this.rec?.agent.push(frame ?? new Int16Array(FRAME_SAMPLES));
    return frame;
  }

  /* ---------------- The line ---------------- */

  /** Every 50 ms: the opening, end_call, and the quiet line (check the line, then goodbye and hang up). */
  _watch() {
    if (this.ended) return;
    const now = performance.now();
    if (now - this.startedAt > MAX_CALL_MS) return this._hangup('max-duration');

    const e = this.ending;
    if (e) {
      if (now - e.at > END_MAX_MS) return this._hangup('end_call');
      if (this.queued > 0 || now - this.lastAudioAt < 400) {
        e.quietSince = 0;
        return;
      }
      e.quietSince ||= now;
      const replyOver = e.voicemail || e.mute || e.replyAudio || now - e.at >= END_REPLY_START_MS;
      if (replyOver && now - e.quietSince >= (e.voicemail ? 200 : HANGUP_GRACE_MS)) {
        this._hangup(e.voicemail ? 'voicemail' : 'end_call');
      }
      return;
    }

    const c = this.closing;
    if (c?.spoke) {
      if (this.queued > 0 || this.agentTurnActive || this.toolsPending > 0) c.doneAt = 0;
      else {
        c.doneAt ||= now;
        if (now - Math.max(c.doneAt, this.callerVoiceAt) >= CLOSE_WAIT_MS) return this._hangup('closing');
      }
    }

    if (!this.opened) {
      if (this.callerSpoke || this.agentSpoke) this.opened = true; // Gemini answers the "הלו" by itself
      else if (now >= this.openAt) this._open();
    }

    const speaking = this.queued > 0 || this.agentTurnActive;
    const waiting = this.toolsPending > 0 || (this.waitingSince && now - this.waitingSince < 15000);
    if (now - this.lastVoice < 300 || speaking || waiting || !this.opened) this.quietSince = now;

    const h = this.hangupState;
    if (h) {
      if (h.spokeAt && now - h.spokeAt > SILENCE_GOODBYE_MAX_MS) return this._hangup('silence');
      if (speaking) return; // wait for the goodbye to finish playing
      if (h.spokeAt ? now - this.quietSince >= HANGUP_GRACE_MS : now - h.at >= 6000) this._hangup('silence');
      return;
    }
    if (now - this.quietSince < SILENCE_CHECK_MS) return;
    if (this.silenceChecks++ === 0) this._cue(CUES.silence);
    else {
      this._cue(CUES.hangup);
      this.hangupState = { at: now, spokeAt: 0 };
    }
  }

  _hangup(reason) {
    if (this._hangupSent) return;
    this._hangupSent = true;
    this.emit('hangup', reason);
  }

  /* ---------------- Transcript ---------------- */

  _logLead() {
    const text = this.leadText.replace(/\s+/g, ' ').trim();
    this.leadText = '';
    if (text) this.emit('line', { who: 'lead', text });
  }

  _logAgent(interrupted) {
    const text = this.turnText.replace(/\s+/g, ' ').trim();
    this.turnText = '';
    if (text) this.emit('line', { who: 'agent', text: interrupted ? `${text} — נקטע` : text });
  }
}
