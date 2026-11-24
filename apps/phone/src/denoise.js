// Noise filter for the caller's audio: RNNoise (open source, Apache-2.0), run here on the server - no service, no cost.
// On a call in the street (cars, a plane) the line's volume alone said "the caller is talking" and the bot kept
// stopping (24.11.2026). RNNoise tells a human voice from noise (vad 0..1) and removes the noise, so the bot stops
// only for a person, and Gemini doesn't hear words in the noise. Test on 30 s of city traffic: 49 cuts by volume, 0 here.
// People talking near the caller are voices too: no filter can tell them from the caller.
import createRnnoise from '@jitsi/rnnoise-wasm/dist/rnnoise-sync.js';

const UP = 6; // RNNoise works at 48 kHz in 10 ms frames (480 samples); the line is 8 kHz (80 samples per 10 ms)
const IN = 80;

let loading = null;
/** The RNNoise module, loaded once (~15 ms). */
export function loadRnnoise() {
  loading ??= (async () => {
    const m = await createRnnoise();
    await m.ready;
    return m;
  })();
  return loading;
}

/** One call's filter: its own RNNoise state (the model follows the noise of this call). */
export class Denoiser {
  constructor(m) {
    this.m = m;
    this.state = m._rnnoise_create();
    this.inPtr = m._malloc(IN * UP * 4);
    this.outPtr = m._malloc(IN * UP * 4);
    this.up = new Float32Array(IN * UP);
    this.prev = 0;
  }

  /**
   * 20 ms of the caller (160 samples, 8 kHz) -> the same without the noise, and how sure RNNoise is that a person
   * is talking in it (0..1, the higher of its two 10 ms frames).
   */
  process(samples) {
    const { m } = this;
    const out = new Int16Array(samples.length);
    let vad = 0;
    for (let off = 0; off + IN <= samples.length; off += IN) {
      for (let i = 0; i < IN; i++) {
        const x = samples[off + i]; // RNNoise takes 16-bit sample values as floats
        for (let k = 0; k < UP; k++) this.up[i * UP + k] = this.prev + ((x - this.prev) * (k + 1)) / UP;
        this.prev = x;
      }
      m.HEAPF32.set(this.up, this.inPtr >> 2);
      vad = Math.max(vad, m._rnnoise_process_frame(this.state, this.outPtr, this.inPtr));
      const res = m.HEAPF32.subarray(this.outPtr >> 2, (this.outPtr >> 2) + IN * UP);
      for (let i = 0; i < IN; i++) {
        let s = 0;
        for (let k = 0; k < UP; k++) s += res[i * UP + k];
        out[off + i] = Math.max(-32768, Math.min(32767, Math.round(s / UP)));
      }
    }
    return { samples: out, vad };
  }

  destroy() {
    if (!this.state) return;
    this.m._rnnoise_destroy(this.state);
    this.m._free(this.inPtr);
    this.m._free(this.outPtr);
    this.state = 0;
  }
}

/** A filter for a new call; null if RNNoise can't load (the call then works by volume, as before). */
export async function createDenoiser() {
  try {
    return new Denoiser(await loadRnnoise());
  } catch {
    return null;
  }
}
