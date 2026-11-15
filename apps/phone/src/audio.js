// Audio conversion between the phone line and Gemini Live.
// Phone line: G.711 (PCMA = A-law, PCMU = μ-law), 8 kHz, 20 ms frames = 160 samples.
// Gemini returns 16-bit PCM at 24 kHz and accepts PCM at any rate (we send it 8 kHz).
// Ported from gemini-live-agent/phone/audio.js (same code, used on real Zadarma calls).

export const PHONE_RATE = 8000;
export const FRAME_SAMPLES = 160; // 20 ms at 8 kHz

/* ---------------- G.711 (after Sun's g711.c) ---------------- */

const SEG_AEND = [0x1f, 0x3f, 0x7f, 0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff];
const SEG_UEND = [0x3f, 0x7f, 0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff, 0x1fff];
const segment = (value, table) => {
  for (let i = 0; i < table.length; i++) if (value <= table[i]) return i;
  return table.length;
};

function linearToAlaw(pcm) {
  let value = pcm >> 3;
  let mask;
  if (value >= 0) mask = 0xd5;
  else {
    mask = 0x55;
    value = -value - 1;
  }
  const seg = segment(value, SEG_AEND);
  if (seg >= 8) return 0x7f ^ mask;
  let aval = seg << 4;
  aval |= seg < 2 ? (value >> 1) & 0x0f : (value >> seg) & 0x0f;
  return aval ^ mask;
}

function alawToLinear(aval) {
  aval ^= 0x55;
  let t = (aval & 0x0f) << 4;
  const seg = (aval & 0x70) >> 4;
  if (seg === 0) t += 8;
  else if (seg === 1) t += 0x108;
  else t = (t + 0x108) << (seg - 1);
  return aval & 0x80 ? t : -t;
}

function linearToUlaw(pcm) {
  let value = pcm >> 2;
  let mask;
  if (value < 0) {
    value = -value;
    mask = 0x7f;
  } else mask = 0xff;
  if (value > 8159) value = 8159;
  value += 0x84 >> 2;
  const seg = segment(value, SEG_UEND);
  if (seg >= 8) return 0x7f ^ mask;
  return ((seg << 4) | ((value >> (seg + 1)) & 0x0f)) ^ mask;
}

function ulawToLinear(uval) {
  uval = ~uval & 0xff;
  let t = ((uval & 0x0f) << 3) + 0x84;
  t <<= (uval & 0x70) >> 4;
  return uval & 0x80 ? 0x84 - t : t - 0x84;
}

// Lookup tables: encode by sample value (65536 entries), decode by byte (256 entries)
const ENCODE = { 8: new Uint8Array(65536), 0: new Uint8Array(65536) };
const DECODE = { 8: new Int16Array(256), 0: new Int16Array(256) };
for (let i = 0; i < 65536; i++) {
  ENCODE[8][i] = linearToAlaw(i - 32768);
  ENCODE[0][i] = linearToUlaw(i - 32768);
}
for (let i = 0; i < 256; i++) {
  DECODE[8][i] = alawToLinear(i);
  DECODE[0][i] = ulawToLinear(i);
}

/** 16-bit PCM -> G.711 bytes. payloadType: 8 = PCMA (A-law), 0 = PCMU (μ-law). */
export function encodeG711(samples, payloadType) {
  const table = ENCODE[payloadType];
  const out = Buffer.allocUnsafe(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = table[samples[i] + 32768];
  return out;
}

/** G.711 bytes -> 16-bit PCM. */
export function decodeG711(bytes, payloadType) {
  const table = DECODE[payloadType];
  const out = new Int16Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = table[bytes[i]];
  return out;
}

/* ---------------- 24 kHz -> 8 kHz ---------------- */

// Low-pass filter (Hamming-windowed sinc) at 3.4 kHz, then keep one sample in three
const TAPS = (() => {
  const n = 31;
  const fc = 3400 / 24000;
  const h = new Float64Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const x = i - (n - 1) / 2;
    const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
    h[i] = sinc * (0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (n - 1)));
    sum += h[i];
  }
  for (let i = 0; i < n; i++) h[i] /= sum;
  return h;
})();

/** Gemini's audio (24 kHz) -> the phone line's rate (8 kHz). Keeps its state between chunks. */
export class Downsampler {
  #history = new Float64Array(TAPS.length);
  #pos = 0; // next write position in the history (ring buffer)
  #phase = 0; // input samples since the last output sample

  /** @param {Int16Array} input 24 kHz @returns {Int16Array} 8 kHz */
  push(input) {
    const out = new Int16Array(Math.ceil((input.length + this.#phase) / 3) + 1);
    let n = 0;
    const len = TAPS.length;
    for (let i = 0; i < input.length; i++) {
      this.#history[this.#pos] = input[i];
      this.#pos = (this.#pos + 1) % len;
      if (++this.#phase === 3) {
        this.#phase = 0;
        let acc = 0;
        for (let k = 0; k < len; k++) acc += TAPS[k] * this.#history[(this.#pos + k) % len];
        out[n++] = Math.max(-32768, Math.min(32767, Math.round(acc)));
      }
    }
    return out.subarray(0, n);
  }

  reset() {
    this.#history.fill(0);
    this.#pos = 0;
    this.#phase = 0;
  }
}

/** Level (RMS) of a chunk, 0..1. */
export function rms(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return samples.length ? Math.sqrt(sum / samples.length) / 32768 : 0;
}

/** PCM Buffer (little-endian) -> Int16Array, without a copy when possible. */
export function pcmView(buf) {
  if (buf.byteOffset % 2 === 0) return new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength >> 1);
  return new Int16Array(Uint8Array.from(buf).buffer, 0, buf.byteLength >> 1);
}

/** Int16Array -> Buffer (little-endian), without a copy. */
export const pcmBuffer = (samples) => Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);

/** 16-bit PCM -> a WAV file (for --record). */
export function wav({ samples, rate, channels }) {
  const data = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * channels * 2, 28);
  h.writeUInt16LE(channels * 2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
