// Fixed sentences played by our code, in the bot's own voice - not left to the model.
//
// "אני שולחת לך עכשיו את הקישור בוואטסאפ, רק רגע." is said while the WhatsApp link is sent (send_purchase_link waits
// ~3 s for Texter, and Gemini can't speak while a tool runs). When the model was asked to say it before calling the
// tool, it said it twice and didn't call (26.11, 16:34) - the prompt said "say it", the tool said "say nothing".
// Now the model only calls the tool, and the line plays this sentence the moment the call comes: always the same
// words, once.
//
// The audio is made once per voice by a short Gemini Live session with the same model and voice as the calls (so it
// is the same voice), checked against the text, and kept in memory for every later call.
import { Downsampler, pcmView } from './audio.js';
import { buildSetup, GeminiLive } from './gemini-live.js';

export const SAY_LINK_SENDING = 'אני שולחת לך עכשיו את הקישור בוואטסאפ, רק רגע.';

const READER = 'את קריינית. בכל הודעה יש משפט אחד בעברית: לומר אותו בקול, מילה במילה, בטון חם, רגוע ושירותי, ולעצור. לא להוסיף שום מילה ולא לענות על המשפט.';
const MAKE_TIMEOUT_MS = 20000;
const TRIES = 3;

/**
 * What it said is the sentence: its key words, and nothing added (the transcript may spell "וואטסאפ" differently or
 * in English, so not letter by letter).
 */
export function saidTheSentence(said) {
  const t = said.replace(/[^א-תA-Za-z]/g, '');
  const len = SAY_LINK_SENDING.replace(/[^א-ת]/g, '').length;
  return ['שולחת', 'קישור', 'רגע'].every((w) => said.includes(w)) && t.length <= len * 1.4;
}

export class FixedLines {
  /**
   * @param {{ apiKey: string, model: string, log?: (text: string) => void,
   *           connect?: (setup: object) => GeminiLive }} opts connect: for tests
   */
  constructor({ apiKey, model, log = () => {}, connect }) {
    this.apiKey = apiKey;
    this.model = model;
    this.log = log;
    this.connect = connect ?? ((setup) => new GeminiLive({ apiKey: this.apiKey, setup }));
    this.ready = new Map(); // voice -> Int16Array (8 kHz)
    this.making = new Map(); // voice -> Promise
  }

  /** The sentence's audio in this voice, or null while it is not ready. */
  linkSending(voice) {
    return this.ready.get(voice) ?? null;
  }

  /** Makes the sentence in this voice (once; again only after a failure). Never throws. */
  prepare(voice) {
    if (this.ready.has(voice)) return Promise.resolve(this.ready.get(voice));
    if (this.making.has(voice)) return this.making.get(voice);
    const p = (async () => {
      for (let i = 1; i <= TRIES; i++) {
        try {
          const audio = await this._make(voice, SAY_LINK_SENDING);
          this.ready.set(voice, audio);
          this.log(`fixed sentence ready (voice ${voice}, ${Math.round(audio.length / 8)}ms)`);
          return audio;
        } catch (err) {
          this.log(`fixed sentence (voice ${voice}) try ${i} failed: ${err.message}`);
        }
      }
      return null;
    })().finally(() => this.making.delete(voice));
    this.making.set(voice, p);
    return p;
  }

  /** One Live session: the sentence in, its audio (8 kHz) out, checked against the text. */
  async _make(voice, text) {
    const live = this.connect(buildSetup({ model: this.model, voice, instructions: READER, tools: [] }));
    const down = new Downsampler();
    const chunks = [];
    let said = '';
    try {
      await live.connect();
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no answer in time')), MAKE_TIMEOUT_MS);
        live.on('audio', (buf) => chunks.push(down.push(pcmView(buf))));
        live.on('outputTranscript', (t) => (said += t));
        live.on('turnComplete', () => {
          clearTimeout(timer);
          resolve();
        });
        live.on('close', () => {
          clearTimeout(timer);
          reject(new Error('the session closed'));
        });
        live.sendText(text);
      });
    } finally {
      live.close();
    }
    if (!saidTheSentence(said)) throw new Error(`it said «${said.trim()}»`);
    const audio = new Int16Array(chunks.reduce((n, c) => n + c.length, 0));
    let o = 0;
    for (const c of chunks) {
      audio.set(c, o);
      o += c.length;
    }
    if (audio.length < 8000) throw new Error('too short');
    return audio;
  }
}
