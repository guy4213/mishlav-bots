// One phone call <-> Gemini Live: the caller's audio goes to the bot, the bot's answer plays on the line,
// tool calls go to the tools server. Line handling ported from gemini-live-agent/phone/call-agent.js (tuned on
// real Zadarma calls: quiet-line fix, barge-in hold, silence check); opening and end_call as provider C's worker.
import { EventEmitter } from 'node:events';
import { Downsampler, FRAME_SAMPLES, PHONE_RATE, pcmBuffer, pcmView, rms } from './audio.js';
import { SAY_LINK_SENDING } from './fixed-lines.js';
import { UsageMeter } from './usage.js';

const VOICE_RMS = 0.02; // above this level on the line, the caller is talking (for the silence count)
// The noise filter (denoise.js) only takes away: loud enough as before AND RNNoise hears a person (vad). Cars, a plane,
// wind: vad ~0.01, so they no longer cut the bot. The level stays: the bot's own voice comes back faint on the line
// (echo), and it IS a voice - with a lower level (0.005, v1.10) the bot cut itself off mid-sentence (24.11).
const SPEECH_VAD = 0.5;
// Cutting the bot off: the caller talks straight into the phone, people around them are quieter (Guy, 26.11,
// outdoors: voices in the street stopped the bot again and again). The caller's own level is measured while they
// talk and the bot is silent; to cut in, speech must reach half of it (-6 dB). Before it is known (the opening),
// a fixed level, twice the plain "talking" one.
const BARGE_REL = 0.5;
const BARGE_DEFAULT_RMS = 0.04;
const CALLER_LEVEL_MIN_FRAMES = 25; // 0.5 s of the caller's speech before their level counts
const CALLER_LEVEL_FRAMES = 150; // the last 3 s of it
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
const WORD_GAP_MS = 400; // a shorter pause is still the same sentence ("רגע... רגע" cuts in too)
const ANSWER_MS = 1000; // speech in the last second before the bot finished is sent when it finishes
const ECHO_TAIL_MS = 250; // keep holding a moment after the bot stops being audible
const START_BUFFER = 3 * FRAME_SAMPLES; // 60 ms of audio before playback starts, against network jitter

const CALLER_SPOKE_FRAMES = 5; // 100 ms of voice = the callee said something ("הלו")
const SILENCE_CHECK_MS = 6000; // quiet line this long -> the bot checks the line; the second time it says goodbye
// The callee said "הלו" and the bot hasn't said a word this long after: Gemini missed it (a "הלו" right at pick-up
// is often clipped), so it gets the opening cue. Only before the bot's first word: mid-call it never comes again.
const OPEN_AFTER_CALLER_MS = 800; // + the bot starting to speak: about 1.5 s after the "הלו" (was 2.4 s)
// The opening is made while the phone rings (the warm-up turn) and played the moment the callee answers, instead of
// Gemini making it after the "הלו" (2-3 s of silence, and a "הלו" said just as it started cut it). See _playOpening.
const OPENING_PLAY_LATEST_MS = 4000; // the callee answered: the opening plays by then at the latest
const PLAY_AFTER_HELLO_MS = 300; // the callee's "הלו" ended this long ago: the opening plays
const LONG_HELLO_MS = 1500; // the callee talked this long before the opening: not a "הלו" (a voicemail greeting...)
const OPENING_WAIT_MS = 3000; // no opening audio yet this long after the answer: the opening cue, as before
const SILENCE_GOODBYE_MAX_MS = 9000; // the no-answer goodbye can't run longer than this
// end_call (as the worker's tools.py): the words before it play out; then the reply to its result (the goodbye,
// only if none was said yet) plays, and the line drops.
const END_REPLY_START_MS = 2500; // no reply to the end_call result by then: the goodbye was already said
const HANGUP_GRACE_MS = 600;
// a server update after a tool (notify) waits for the bot's answer to that tool, at most this long
const NOTE_AFTER_TOOL_MS = 4000; // after the last words, so the goodbye isn't clipped
const END_MAX_MS = 15000;
const TURN_MIN_VOICED_FRAMES = 10;
// After an action that ends the call (link sent, callback booked, handed to a rep: `closing: true` in the tool
// answer) the line drops once the closing sentence played and the line is quiet this long - also when the model
// never calls end_call (on real calls it said goodbye and left the line open).
const CLOSE_WAIT_MS = 2000;
// The caller talking this long after the goodbye is a new request ("רגע, עוד שאלה"), not a "תודה, ביי":
// the call goes on.
const CLOSE_CANCEL_MS = 1500;
// Every fixed closing sentence ends with "יום נעים, להתראות." (apps/backend/src/tools/closings.ts): once the bot
// said it since the caller last spoke, the reply to end_call is not played (it repeated the goodbye).
const GOODBYE_WORD = 'להתראות'; // a caller turn for the latency metric: at least 200 ms of voice

// The warm-up turn sent while the phone rings: Gemini reads the instructions now, not on the first "הלו".
// Its reply is never played; a turn that hasn't ended by then stops being a warm-up.
const WARM_UP_MAX_MS = 15000;

// Sent to the bot as text, never shown in the transcript.
export const CUES = {
  // Gemini Live picks the reply language itself, and the warm-up's reply stays in the session as the bot's own
  // turn: a first try ("say nothing") was answered in English and the call went on in English. So it is told the
  // exact Hebrew word to say, and that the call starts from the opening when the callee answers.
  // The warm-up makes the opening itself: it is played to the callee the moment they answer (_playOpening).
  warmUp: '(הודעת מערכת: הטלפון מצלצל והלקוח עוד לא ענה. השיחה כולה בעברית. לומר עכשיו רק את משפט הפתיחה מהשלב הראשון בזרימת השיחה, עד "מה נשמע?", ולעצור שם. לא להפעיל כלים. המשפט יושמע ללקוח ברגע שיענה.)',
  // the opening made while ringing was dropped (the callee talked first): Gemini thinks it said it - it didn't
  openingNotHeard:
    '(הודעת מערכת: משפט הפתיחה שהכנת לא הושמע ללקוח – הוא עוד לא שמע ממך כלום. אם זה משיבון – end_call עם voicemail, בלי לומר כלום. אחרת – לפתוח עכשיו במשפט הפתיחה מהשלב הראשון בזרימת השיחה, כולל ההצגה העצמית, ולהגיב למה שאמר.)',
  open: '(הודעת מערכת: השיחה התחברה והלקוח על הקו, ועוד לא שמע ממך כלום. לפתוח את השיחה עכשיו במשפט הפתיחה מהשלב הראשון בזרימת השיחה.)',
  silence: '(הודעת מערכת: שקט על הקו כבר כמה שניות. הלקוח לא עונה.)',
  hangup: '(הודעת מערכת: אין מענה על הקו. לומר רק את המשפט: "נראה שלא שומעים, נדבר בהזדמנות אחרת. יום נעים, להתראות.")',
  // The caller cut in and we stopped the bot's voice ourselves: Gemini had already made the whole answer and thinks
  // it was all said. On a call (24.11) the cut answer ended with "לשלוח לך קישור?", the caller never heard it, and
  // his "סבבה" to the details was taken as a yes - the link went out unasked. So Gemini is told what was heard.
  // it said it is sending the link but called no tool (saysLinkSent): nothing went
  linkNotSent:
    '(הודעת מערכת: אמרת ללקוח שאת שולחת לו קישור, אבל לא קראת ל-send_purchase_link – שום דבר לא נשלח. לקרוא לו עכשיו, בלי לומר כלום לפני.)',
};

/**
 * The bot told the customer the link is being sent / was sent ("שולחת לך קישור", "הקישור נשלח") - a statement, not
 * the question "לשלוח לך קישור?". Used only when no send_purchase_link was called on the call: then nothing went.
 */
export function saysLinkSent(text) {
  const t = text.replace(/\s+/g, ' ');
  return /(שולחת|שלחתי|נשלח)[^?.!]{0,30}קישור|קישור[^?.!]{0,30}(נשלח|שולחת|שלחתי)/.test(t);
}

/** The answer ends asking whether to send the link ("אפשר לשלוח לך את הקישור?"): it waits for a yes. */
export function asksToSendLink(text) {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t.endsWith('?')) return false;
  const last = t.split(/(?<=[.!?])\s+/).pop() ?? '';
  return /לשלוח|אשלח|קישור/.test(last);
}

/** The words of a cut answer the caller heard: its text in proportion to the audio played, up to a word's end. */
export function heardPart(text, played, total) {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t || total <= 0 || played >= total * 0.95) return t;
  const cut = t.slice(0, Math.floor((t.length * Math.max(0, played)) / total));
  const end = cut.lastIndexOf(' ');
  return end > 0 ? `${cut.slice(0, end)}…` : '';
}

/**
 * Events:
 *  'line' ({ who: 'lead' | 'agent' | 'tool' | 'note', text })   a transcript line
 *  'hangup' (reason)                                           drop the call (end_call, silence, failure)
 */
export class CallAgent extends EventEmitter {
  /**
   * @param {{ live: import('./gemini-live.js').GeminiLive, tools: import('./mishlav.js').ToolsClient,
   *           openAfterSilenceMs?: number, genderReminder?: string | null,
   *           denoiser?: import('./denoise.js').Denoiser | null, linkSending?: () => Int16Array | null }} opts
   * linkSending: the fixed "אני שולחת לך עכשיו את הקישור…" in the bot's voice (fixed-lines.js), null while not ready
   */
  constructor({ live, tools, openAfterSilenceMs = 4000, genderReminder = null, denoiser = null, linkSending = () => null }) {
    super();
    this.linkSending = linkSending;
    this.denoiser = denoiser; // the caller's noise filter (null: by volume, as before)
    // the answer playing now: its words and audio (8 kHz), for what the caller heard when they cut in
    this.playText = '';
    this.turnSamples = 0;
    this.answerDone = true;
    // updates from the server for the bot (notify): sent when it isn't mid-answer (the WhatsApp link's result)
    this.pendingNotes = [];
    this.callerLevels = []; // the caller's speech levels while the bot is silent (callerLevel)
    this.preTalkAt = 0; // the callee's own voice before the opening made while ringing played
    this.toolAnsweredAt = 0;
    this.turnCompletedAt = 0;
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
    // cut in while Gemini was still sending that answer: the rest of it is dropped until its turn ends
    this.droppingCutTurn = false;
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
    this.warming = null; // while the warm-up turn runs: { at, done }
    // the opening made by the warm-up: { frames (8 kHz), text, failed, dropped, played } (_playOpening)
    this.opening = null;
    this.preVoicedMs = 0; // how long the callee talked before the opening played
    this.preHeld = []; // what they said meanwhile (Gemini got silence)
    this.firstAnswerNoted = false;
    this.geminiHeard = false; // Gemini heard the caller (its transcript or its voice detection)
    this._wire();
  }

  /**
   * While the phone rings: one text turn in which Gemini reads the instructions and says the opening. Its audio is
   * kept and played the moment the callee answers (_playOpening); its tool calls are refused. Resolves with
   * { ms, said } (null: skipped, the call is already up).
   */
  warmUp() {
    if (this.rtp || this.ended || this.warming) return Promise.resolve(null);
    this.opening = { frames: [], text: '', failed: false, dropped: false, played: false };
    return new Promise((resolve) => {
      const at = performance.now();
      const timer = setTimeout(() => this._endWarmUp(), WARM_UP_MAX_MS);
      this.warming = {
        at,
        said: '', // what Gemini answered (never played): logged, to see its language
        done: () => {
          clearTimeout(timer);
          resolve({ ms: Math.round(performance.now() - at), said: this._warmSaid.trim() });
        },
      };
      this.live.sendText(CUES.warmUp);
    });
  }

  _endWarmUp() {
    const w = this.warming;
    this._warmSaid = w?.said ?? '';
    this.warming = null;
    const o = this.opening;
    if (o && !o.played) {
      // the opening is ready: Hebrew words and its audio (once it answered "OK" in English: never played)
      o.text = this._warmSaid.trim();
      if (!o.frames.length || !isHebrewOpening(o.text)) o.failed = true;
    }
    w?.done();
  }

  _openingUsable() {
    const o = this.opening;
    return !!o && !o.failed && !o.dropped && !o.played;
  }

  /**
   * The callee answered: the opening made while ringing plays now, Gemini doesn't make it after the "הלו". Gemini
   * already "said" it (its warm-up turn): the "הלו" said before it stays here, and Gemini hears what comes next.
   * If the warm-up is still sending it, the rest streams in as a normal answer.
   */
  _playOpening(now) {
    const o = this.opening;
    o.played = true;
    this.opened = true;
    this.preHeld = [];
    const when = this.callerSpoke
      ? `${Math.round(now - this.lastVoice)}ms after the callee's hello`
      : `${Math.round(now - this.startedAt)}ms after the answer (the callee said nothing)`;
    this.emit('line', { who: 'note', text: `opening made while ringing, played ${when}` });
    const streaming = !!this.warming;
    const said = streaming ? this.warming.said : o.text;
    if (streaming) this._endWarmUp();
    this.turnText = said;
    this.saidSinceLead += said;
    Object.assign(this, { agentSpoke: true, agentTurnActive: streaming, turnHadAudio: streaming, lastAudioAt: now, waitingSince: 0, bargedIn: false });
    for (const f of o.frames) this._play(f);
    o.frames = [];
    if (!streaming) {
      this.answeredSinceLead = true;
      this._logAgent(false);
    }
  }

  /** The opening made while ringing won't play (not ready, or the callee talked at length): as before it. */
  _dropOpening(why) {
    this.opening.dropped = true;
    this.opening.frames = [];
    this.emit('line', { who: 'note', text: `opening made while ringing not played: ${why}` });
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
    if (this.openAfterSilenceMs <= 0 && !this._openingUsable()) this._open();
  }

  end() {
    if (this.ended) return;
    this.ended = true;
    clearInterval(this._watchTimer);
    this.denoiser?.destroy();
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
      if (this.warming) {
        // the warm-up's reply is the opening: kept, played when the callee answers (_playOpening)
        if (this._openingUsable()) this.opening.frames.push(this.down.push(pcmView(buf)));
        return;
      }
      if (this.droppingCutTurn) return; // the rest of the answer the caller cut
      if (this.ended || this.ending?.voicemail || this.ending?.mute) return; // voicemail: the bot says nothing
      if (this._afterGoodbye()) return;
      const now = performance.now();
      if (this.ending) this.ending.replyAudio = true;
      if (this.closing) this.closing.spoke = true;
      this.turnHadAudio = true;
      if (!this.agentTurnActive) {
        this._logLead(); // the bot starts answering: what the caller said so far goes to the transcript
        this.bargedIn = false; // a new answer: a short word doesn't cut it again
      }
      this._answerStarts();
      this.agentTurnActive = true;
      this.agentSpoke = true;
      this.waitingSince = 0;
      this.lastAudioAt = now;
      if (this.hangupState && !this.hangupState.spokeAt) this.hangupState.spokeAt = now;
      this._play(this.down.push(pcmView(buf)));
    });
    a.on('outputTranscript', (text) => {
      if (this.warming) {
        this.warming.said += text; // not the transcript: only the call log, to check its language
        return;
      }
      if (this.droppingCutTurn) return;
      // a reply that isn't played (voicemail, or the goodbye again after end_call) isn't written either: it showed
      // the closing sentence twice in the transcript although the caller heard it once
      if (this.ending?.voicemail || this.ending?.mute) return;
      if (this._afterGoodbye()) return;
      this._answerStarts();
      this.turnText += text;
      this.saidSinceLead += text;
      this.playText += text; // kept after turnComplete: the answer may still be playing when the caller cuts in
    });
    a.on('inputTranscript', (text) => {
      this.leadText += text;
      if (text.trim()) {
        this.geminiHeard = true; // it has the caller's words: it answers them (no opening cue)
        this.callerSpoke = true;
        this._leadSpoke();
      }
    });
    a.on('voiceActivity', (va) => {
      if (va?.type === 'ACTIVITY_START') {
        this.geminiHeard = true;
        this.callerSpoke = true;
        this._leadSpoke();
      }
    });
    a.on('interrupted', () => {
      if (this.warming) return this._endWarmUp(); // the callee answered and spoke: the warm-up is over
      this.droppingCutTurn = false; // Gemini dropped the cut answer itself
      // The caller cut in: stop playing at once
      this._flush();
      this.agentTurnActive = false;
      this.turnHadAudio = false;
      this.answerDone = true;
      this._logAgent(true);
    });
    a.on('turnComplete', () => {
      if (this.warming) return this._endWarmUp();
      this.turnCompletedAt = performance.now();
      if (this.droppingCutTurn) {
        // the end of the answer the caller cut: nothing of it was played, nothing to log
        this.droppingCutTurn = false;
        this.agentTurnActive = false;
        this.turnHadAudio = false;
        this.turnText = '';
        return;
      }
      this.agentTurnActive = false;
      if (this.turnHadAudio) this.answeredSinceLead = true;
      // The fixed goodbye was said without end_call (R2: it said it 4 times - the silence checks asked again):
      // the call is over, hang up once the line is quiet, as after a closing action.
      if (this.turnHadAudio && !this.ending && !this.closing && this.turnText.includes(GOODBYE_WORD)) {
        this.closing = { spoke: true, doneAt: 0, voiced: 0 };
        this.emit('line', { who: 'note', text: 'goodbye said without end_call: hanging up when the line is quiet' });
      }
      // It said the link is on its way, but never called the tool: nothing went (26.11, "שולחת לך קישור עכשיו...
      // משהו נוסף?"). It is told so, once, and calls it now.
      // Not when it ends asking whether to send it ("…קישור מאובטח שאני שולחת בוואטסאפ. אפשר לשלוח לך את הקישור?"): it
      // waits for the answer - the nudge made it send before the customer answered (26.11, 18:01).
      if (this.turnHadAudio && !this.linkToolCalled && !this.linkNudged && saysLinkSent(this.turnText) && !asksToSendLink(this.turnText)) {
        this.linkNudged = true;
        this.emit('line', { who: 'note', text: 'the bot said it sends the link but called no tool: told to send it' });
        this.notify(CUES.linkNotSent);
      }
      this.turnHadAudio = false;
      this.answerDone = true; // it may still be playing; the next words are a new answer
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
    if (calls.some((fc) => fc.name === 'send_purchase_link')) this.linkToolCalled = true;
    if (this.warming) {
      // nothing happens before the callee answers: the tools server never hears of it (and no opening came of it)
      if (this.opening) this.opening.failed = true;
      const output = JSON.stringify({ ok: false, error: 'not_started', message_he: 'השיחה עוד לא התחילה – לא להפעיל כלים.' });
      this.live.sendToolResponse(calls.map((fc) => ({ id: fc.id, name: fc.name, response: { output } })));
      return;
    }
    this.toolsPending++;
    this._logAgent(false); // the words before the tool call come first in the transcript
    if (calls.some((fc) => fc.name === 'send_purchase_link')) this._sayLinkSending();
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
    this.waitingSince = this.toolAnsweredAt = performance.now();
    if (closing && !endCall) this.closing = { spoke: false, doneAt: 0, voiced: 0 };
    if (endCall) {
      const saidGoodbye = this.answeredSinceLead || this.saidSinceLead.includes(GOODBYE_WORD) || !!this.closing?.spoke;
      const mute = !endCall.voicemail && saidGoodbye;
      this.ending = { ...endCall, mute, at: performance.now(), replyAudio: false, quietSince: 0 };
      if (endCall.voicemail) this._flush();
      if (mute) this.emit('line', { who: 'note', text: 'end_call after a full answer: its reply is not played' });
    }
  }

  /**
   * The link is being sent (send_purchase_link, ~3 s): the line plays the fixed "אני שולחת לך עכשיו את הקישור
   * בוואטסאפ, רק רגע." in the bot's voice, so the caller isn't left in silence and the model says nothing of its own
   * (it said the sentence twice and didn't send, 26.11). Not if the bot already said it is sending (then it was told
   * to call the tool after saying so).
   */
  _sayLinkSending() {
    if (saysLinkSent(this.saidSinceLead)) {
      this.emit('line', { who: 'note', text: 'the bot already said it sends the link: no fixed sentence' });
      return;
    }
    const audio = this.linkSending();
    if (!audio?.length) {
      this.emit('line', { who: 'note', text: 'the fixed "sending" sentence is not ready: the caller waits for the tool in silence' });
      return;
    }
    this._answerStarts();
    this.playText += SAY_LINK_SENDING;
    this.saidSinceLead += SAY_LINK_SENDING;
    this.agentSpoke = true;
    this.lastAudioAt = performance.now();
    for (let i = 0; i < audio.length; i += FRAME_SAMPLES) this._play(audio.subarray(i, i + FRAME_SAMPLES));
    this.emit('line', { who: 'agent', text: SAY_LINK_SENDING });
  }

  /**
   * The closing sentence of a closing action played to its end, and the caller said something short ("תודה", "ביי"):
   * Gemini's reply to it is not played and the line drops as usual. It asked "יש משהו נוסף שאוכל לעזור בו?" after
   * "יום נעים, להתראות." (26.11, 18:02). The caller talking CLOSE_CANCEL_MS cancels the closing: then it answers.
   */
  _afterGoodbye() {
    if (!this.closing?.doneAt) return false;
    if (!this.closing.muteNoted) {
      this.closing.muteNoted = true;
      this.emit('line', { who: 'note', text: "after the goodbye: the bot's reply to a short word is not played" });
    }
    return true;
  }

  _open() {
    this.opened = true;
    this._cue(CUES.open);
  }

  /**
   * An update from the server for the bot, e.g. "the WhatsApp link went out - say the goodbye". It waits until the
   * bot isn't answering: after a tool, until the bot's answer to it ended (it was saying "אני שולחת לך עכשיו…") -
   * text sent mid-answer would cut it off. A bot that says nothing after the tool gets it after 4 s anyway.
   */
  notify(text) {
    if (this.ended) return;
    this.pendingNotes.push(text);
    this._flushNotes(performance.now());
  }

  _flushNotes(now) {
    if (!this.pendingNotes.length || this.ended) return;
    if (this.agentTurnActive || this.toolsPending > 0) return;
    const answeredTool = this.turnCompletedAt > this.toolAnsweredAt || now - this.toolAnsweredAt > NOTE_AFTER_TOOL_MS;
    if (!answeredTool) return;
    const note = this.pendingNotes.shift();
    this.emit('line', { who: 'note', text: `server update for the bot: ${note.slice(0, 80)}` });
    this._cue(note);
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
    // the noise filter: a person talking (not cars / a plane), and the audio Gemini gets without the noise
    const clean = this.denoiser?.process(samples);
    const voiced = level > VOICE_RMS && (!clean || clean.vad >= SPEECH_VAD);
    const heard = clean ? clean.samples : samples;
    // the caller's own level: their speech while the bot is silent (cutting in is measured against it)
    if (voiced && !(this.queued > 0 || now < this.audibleUntil)) {
      this.callerLevels.push(level);
      if (this.callerLevels.length > CALLER_LEVEL_FRAMES) this.callerLevels.shift();
    }
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
    this.rec?.lead.push(samples); // the recording keeps what the caller really sounded like
    // noise only (filtered to near silence) or a quiet line: Gemini gets clean silence, so it hears the end of speech
    const frame = (clean ? rms(heard) : level) < SILENCE_RMS ? new Int16Array(samples.length) : heard;

    if (!this.opened && this._openingUsable()) {
      // Before the opening made while ringing plays, Gemini hears silence: it already "said" the opening, so it must
      // not answer the "הלו" by itself. Talking at length isn't a "הלו" (a voicemail greeting, a question): Gemini
      // gets it all, as before this opening existed.
      // Only a voice as loud as the callee's own counts as them talking: Bluetooth earbuds' echo and voices around
      // made a "Hello" count as 1.5 s of talk (26.11, 17:52) and the opening was dropped.
      if (voiced && level >= this._bargeLevel()) {
        this.preVoicedMs += 20;
        this.preTalkAt = now;
      }
      this.preHeld.push(frame);
      if (this.preHeld.length > HOLD_MS / 20) this.preHeld.shift();
      if (this.preVoicedMs < LONG_HELLO_MS) {
        this._toAgent(new Int16Array(samples.length));
        return;
      }
      this._dropOpening(`the callee talked ${this.preVoicedMs}ms first`);
      this.held = this.preHeld;
      this.preHeld = [];
      this._releaseHeld();
      // Gemini made the opening while ringing, so it "said" it - but nobody heard it. Without this it went straight
      // on to "אני מתקשרת בהמשך…" without introducing itself (26.11, 17:52).
      this._cue(CUES.openingNotHeard);
      return;
    }

    const audible = this.queued > 0 || now < this.audibleUntil;
    if (audible && !this.bargedIn) {
      if (!this.holding) Object.assign(this, { holding: true, held: [], seg: null });
      this.held.push(frame);
      if (this.held.length > HOLD_MS / 20) this.held.shift();
      // only speech about as loud as the caller's own cuts in: quieter voices around them don't
      if (this._leadTalking(now, voiced && level >= this._bargeLevel(), level)) {
        this.bargedIn = true;
        this.emit('line', { who: 'note', text: `caller talked ${this._segMs()}ms over the bot (${this._levels()}): bot stopped` });
        this._cutIn();
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

  /**
   * The caller cut in: stop playing now, ourselves. Gemini makes its answer faster than it plays, so it has often
   * finished it already and sends no 'interrupted': waiting for it left seconds of the old answer playing over the
   * caller. If Gemini is still sending it, the rest is dropped until that turn ends.
   */
  _cutIn() {
    const stillSending = this.agentTurnActive;
    // what the caller heard of it: the transcript shows only that
    // Only when it is known AND part of it was heard: the opening made while ringing has no text here, and "heard
    // nothing" made the bot start the opening over and over while the caller said "הלו" (26.11, 17:34). Otherwise
    // nothing is sent and the bot answers what the caller said.
    // No note to Gemini any more (v1.11-v1.28 sent one): it made the bot read it out loud ("(הלקוח קטע אותי. מה הוא
    // אמר?)", 26.11 17:59) and start its sentence over and over. The bot just answers what the caller said. The log
    // still shows what the caller heard.
    const heard = heardPart(this.playText, this.turnSamples - this.queued, this.turnSamples);
    if (heard) {
      if (this.turnText) this.turnText = heard; // still coming: its line is only what was heard
      else this.emit('line', { who: 'note', text: `the caller heard only: «${heard}»` }); // its line is already written
    }
    this.answerDone = true;
    this._flush();
    this._logAgent(true);
    this.turnHadAudio = false;
    if (stillSending) this.droppingCutTurn = true;
    else this.agentTurnActive = false;
  }

  /** Tracks the caller's speech while the bot is audible. True once it is long enough to cut in. */
  _leadTalking(now, voiced, level) {
    const s = this.seg;
    if (s && !s.noted && now - s.last >= ANSWER_MS) {
      s.noted = true;
      this.emit('line', { who: 'note', text: `caller said something short (${this._segMs()}ms, ${this._levels()}) over the bot; bot went on` });
    }
    if (!voiced) return false;
    if (!s || now - s.last > WORD_GAP_MS) this.seg = { start: now, last: now, peak: level, noted: false };
    else Object.assign(s, { last: now, peak: Math.max(s.peak, level) });
    return now - this.seg.start + 20 >= BARGE_MS;
  }

  /** The caller's own level (the typical one of their speech while the bot is silent); null until 0.5 s of it. */
  callerLevel() {
    const l = this.callerLevels;
    if (l.length < CALLER_LEVEL_MIN_FRAMES) return null;
    return [...l].sort((a, b) => a - b)[Math.floor(l.length * 0.6)];
  }

  /** How loud speech over the bot must be to cut it off. */
  _bargeLevel() {
    const c = this.callerLevel();
    return c ? Math.max(VOICE_RMS, c * BARGE_REL) : BARGE_DEFAULT_RMS;
  }

  /** For the log: the segment's peak against the level needed, and the caller's own level. */
  _levels() {
    const c = this.callerLevel();
    return `peak ${(this.seg?.peak ?? 0).toFixed(3)}, needs ${this._bargeLevel().toFixed(3)}, caller ${c ? c.toFixed(3) : '?'}`;
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

  /** The first audio or words of a new answer: what is played of it is counted from here (a cut-in tells Gemini). */
  _answerStarts() {
    if (!this.answerDone) return;
    this.answerDone = false;
    this.playText = '';
    this.turnSamples = 0;
  }

  _play(samples) {
    if (!samples?.length) return;
    this.queue.push(samples);
    this.queued += samples.length;
    this.turnSamples += samples.length;
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
    this._flushNotes(now);

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

    if (!this.opened && this._openingUsable()) {
      // the opening made while ringing: right after the "הלו", or after the short silence if the callee says nothing
      const o = this.opening;
      // after the callee's "הלו" (their own voice, not echo or voices around), or after the short silence; voices
      // around that never stop don't hold it back more than OPENING_PLAY_LATEST_MS
      const talkAt = this.preTalkAt || this.lastVoice;
      const afterHello = now - talkAt >= PLAY_AFTER_HELLO_MS || now - this.startedAt >= OPENING_PLAY_LATEST_MS;
      if (o.frames.length && (this.callerSpoke ? afterHello : now >= this.openAt)) {
        this._playOpening(now);
      } else if (!o.frames.length && now - this.startedAt >= OPENING_WAIT_MS) this._dropOpening('not ready in time');
    }
    if (!this.opened && !this._openingUsable()) {
      // Gemini answers the "הלו" by itself; if it missed it (no word from the bot 1.5 s after the caller stopped), or
      // the callee says nothing (openAt), the opening cue. Once the bot spoke, the opening is never cued again.
      // Gemini heard the caller: it answers by itself (a cue now could make it open twice).
      const geminiBusy = this.agentTurnActive || this.queued > 0 || this.toolsPending > 0;
      if (this.agentSpoke || this.geminiHeard) this.opened = true;
      else if (this.callerSpoke) {
        if (!geminiBusy && now - this.lastVoice >= OPEN_AFTER_CALLER_MS) {
          this.emit('line', { who: 'note', text: 'the caller spoke and the bot stayed silent: opening cue' });
          this._open();
        }
      } else if (now >= this.openAt) this._open();
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

/** The warm-up's words are the opening only if they are Hebrew (it once answered in English). */
export function isHebrewOpening(text) {
  const he = (text.match(/[֐-׿]/g) ?? []).length;
  const en = (text.match(/[A-Za-z]/g) ?? []).length;
  return he >= 10 && he > en * 3;
}
