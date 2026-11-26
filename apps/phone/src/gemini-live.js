// Gemini Live over a raw WebSocket (Node's built-in WebSocket), for the phone line.
// Same session shape as gemini-live-agent/agent.js (the setup that works on real Zadarma calls), with the
// Mishlav prompt + knowledge and the 5 Mishlav tools instead of web search.
import { EventEmitter } from 'node:events';

export const DEFAULT_PHONE_MODEL = 'gemini-3.1-flash-live-preview';
import { DEFAULT_VOICE, PHONE_VOICES } from './voices.js';

export { DEFAULT_VOICE, PHONE_VOICES };
export const DEFAULT_SILENCE_MS = 500;
// The caller's speech is transcribed as Hebrew (not by automatic language detection). The reply language
// comes from the prompt: the Live audio models take no speech language code.
export const LANGUAGE = 'he-IL';
// About 25 audio tokens per second each way: 20,000 tokens is a ~5-6 minute call on top of the instructions.
export const CONTEXT_TRIGGER_TOKENS = 20000;
export const CONTEXT_TARGET_TOKENS = 12000;

const LIVE_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

/**
 * Per-model setup (from gemini-live-agent's live-config.js MODELS). 2.5 models: thinking off and the model's
 * own end-of-speech detection (custom VAD settings made them answer after ~5 s).
 */
function modelSetup(model) {
  if (model.startsWith('gemini-2.5-')) return { generation: { thinkingConfig: { thinkingBudget: 0 } }, defaultVad: true };
  return { generation: {}, defaultVad: false };
}

/** config/tools.json entries -> Live API function declarations (JSON Schema, as live_text.py sends them). */
export function functionDeclarations(tools) {
  return tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters }));
}

/** The Live API `setup` message. */
export function buildSetup({
  model = DEFAULT_PHONE_MODEL,
  voice = DEFAULT_VOICE,
  instructions,
  tools,
  temperature = 0.6,
  silenceMs = DEFAULT_SILENCE_MS,
}) {
  if (model.includes('extended-thinking')) {
    throw new Error(`${model} needs non-blocking tools; the phone line supports the standard Live models only`);
  }
  const info = modelSetup(model);
  return {
    model: `models/${model}`,
    generationConfig: {
      responseModalities: ['AUDIO'],
      temperature,
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
      ...info.generation,
    },
    systemInstruction: { parts: [{ text: instructions }] },
    ...(tools?.length && { tools: [{ functionDeclarations: functionDeclarations(tools) }] }),
    // Gemini's end-of-speech detection: once the caller is quiet for silenceMs, the bot answers.
    ...(!info.defaultVad && {
      realtimeInputConfig: {
        automaticActivityDetection: {
          startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH',
          endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH',
          prefixPaddingMs: 20,
          silenceDurationMs: silenceMs,
        },
      },
    }),
    inputAudioTranscription: { languageCodes: [LANGUAGE] },
    outputAudioTranscription: {},
    // Every turn is billed on the whole context: once it passes CONTEXT_TRIGGER_TOKENS, the oldest turns are dropped
    // down to CONTEXT_TARGET_TOKENS (the system instructions always stay). A 2-3 minute call never gets there.
    contextWindowCompression: { triggerTokens: CONTEXT_TRIGGER_TOKENS, slidingWindow: { targetTokens: CONTEXT_TARGET_TOKENS } },
  };
}

/**
 * Events:
 *  'audio' (Buffer pcm16le)          a chunk of the reply (24 kHz)
 *  'inputTranscript' (text)          the caller's words (in pieces)
 *  'outputTranscript' (text)         the bot's words (in pieces)
 *  'interrupted'                     the caller cut in: drop the playback queue
 *  'toolCall' (functionCalls[])      the model calls tools: answer with sendToolResponse
 *  'toolCancel' (ids[])              the model cancelled tool calls (the caller cut in)
 *  'turnComplete'
 *  'voiceActivity' (obj)
 *  'goAway' (timeLeft)
 *  'close' ({ code, reason })        the connection closed (only after it was ready)
 *  'error' (Error)
 */
export class GeminiLive extends EventEmitter {
  #ws = null;
  #ready = false;
  #holdTurnComplete = false; // after a tool call: the turn isn't over until the model answers with the result

  constructor({ apiKey, setup }) {
    super();
    if (!apiKey) throw new Error('GOOGLE_API_KEY is empty (.env)');
    this.apiKey = apiKey;
    this.setup = setup;
  }

  get ready() {
    return this.#ready;
  }

  /** Connects and sends the setup. Resolves on setupComplete. */
  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${LIVE_URL}?key=${encodeURIComponent(this.apiKey)}`);
      ws.binaryType = 'arraybuffer';
      this.#ws = ws;
      const decoder = new TextDecoder();

      ws.addEventListener('open', () => ws.send(JSON.stringify({ setup: this.setup })));
      ws.addEventListener('message', (ev) => {
        let msg;
        try {
          msg = JSON.parse(typeof ev.data === 'string' ? ev.data : decoder.decode(ev.data));
        } catch {
          return;
        }
        if (msg.setupComplete && !this.#ready) {
          this.#ready = true;
          resolve();
          return;
        }
        this.#handle(msg);
      });
      ws.addEventListener('error', (ev) => {
        const err = ev.error instanceof Error ? ev.error : new Error(ev.message || 'WebSocket error');
        if (this.#ready) this.emit('error', err);
        else reject(err);
      });
      ws.addEventListener('close', (ev) => {
        if (!this.#ready) {
          reject(new Error(`Gemini closed the connection (${ev.code})${ev.reason ? `: ${ev.reason}` : ''}`));
          return;
        }
        this.#ready = false;
        this.emit('close', { code: ev.code, reason: ev.reason });
      });
    });
  }

  /** Caller audio: 16-bit little-endian mono PCM. Gemini resamples rates other than 16 kHz (the phone: 8 kHz). */
  sendAudio(pcm, rate) {
    this.#send({ realtimeInput: { audio: { data: Buffer.from(pcm).toString('base64'), mimeType: `audio/pcm;rate=${rate}` } } });
  }

  /** A text message (the bot still answers in voice). */
  sendText(text) {
    this.#send({ realtimeInput: { text } });
  }

  /** [{ id, name, response }] */
  sendToolResponse(functionResponses) {
    if (functionResponses.length) this.#send({ toolResponse: { functionResponses } });
  }

  close() {
    this.#ready = false;
    try {
      this.#ws?.close();
    } catch {}
  }

  #send(obj) {
    if (this.#ready && this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify(obj));
  }

  #handle(msg) {
    if (msg.toolCall) {
      this.#holdTurnComplete = true;
      this.emit('toolCall', msg.toolCall.functionCalls ?? []);
    }
    if (msg.toolCallCancellation) this.emit('toolCancel', msg.toolCallCancellation.ids ?? []);
    const sc = msg.serverContent;
    if (sc) {
      if (sc.inputTranscription?.text) this.emit('inputTranscript', sc.inputTranscription.text);
      if (sc.outputTranscription?.text) this.emit('outputTranscript', sc.outputTranscription.text);
      for (const part of sc.modelTurn?.parts ?? []) {
        if (part.inlineData?.data) {
          this.#holdTurnComplete = false;
          this.emit('audio', Buffer.from(part.inlineData.data, 'base64'));
        }
      }
      if (sc.interrupted) this.emit('interrupted');
      if (sc.turnComplete) {
        // Some models close the turn right after a tool call; the real turn ends after the answer.
        if (this.#holdTurnComplete) this.#holdTurnComplete = false;
        else this.emit('turnComplete');
      }
    }
    if (msg.voiceActivity) this.emit('voiceActivity', msg.voiceActivity);
    if (msg.goAway) this.emit('goAway', msg.goAway.timeLeft);
    if (msg.usageMetadata) this.emit('usage', msg.usageMetadata); // per turn, on the whole context
  }
}
