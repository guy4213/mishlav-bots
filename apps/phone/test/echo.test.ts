import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS module (apps/phone is not type-checked)
import { ECHO_MARGIN, EchoModel } from "../src/echo.js";

/** A seeded random (the same speech every run). */
function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

/** The bot's loudness per 20 ms frame, like speech: syllables, short gaps, and pauses between sentences. */
function speech(frames: number, seed = 1): number[] {
  const r = rng(seed);
  const out: number[] = [];
  while (out.length < frames) {
    const syllable = 5 + Math.floor(r() * 10); // 100-300 ms
    const level = 0.05 + r() * 0.25;
    for (let i = 0; i < syllable; i++) out.push(level * (0.7 + 0.3 * r()));
    const gap = r() < 0.15 ? 25 + Math.floor(r() * 25) : 2 + Math.floor(r() * 6); // a pause, or between syllables
    for (let i = 0; i < gap; i++) out.push(0);
  }
  return out.slice(0, frames);
}

/** Runs the bot's frames and the line's frames (echo = the bot `delay` frames late x gain, + the caller). */
function run(bot: number[], { delay = 20, gain = 1.2, caller = [] as number[], noise = 0.003 } = {}) {
  const echo = new EchoModel();
  const r = rng(7);
  const line: number[] = [];
  const asCaller: boolean[] = []; // each frame, decided when it came (as the call does)
  for (let i = 0; i < bot.length; i++) {
    const t = i * 20;
    echo.addPlayed(t, bot[i]);
    const e = i >= delay ? bot[i - delay]! * gain * (0.85 + 0.3 * r()) : 0;
    const level = Math.sqrt(e * e + (caller[i] ?? 0) ** 2) + noise;
    line.push(level);
    echo.addHeard(t + 5, level); // received a little after the frame was sent
    asCaller.push(level > 0.02 && echo.isCaller(t + 5, level));
  }
  return { echo, line, asCaller };
}

describe("the bot's echo on the line (Bluetooth earbuds, 26.11)", () => {
  it("finds the delay and the gain of the echo", () => {
    for (const delay of [10, 25, 40]) {
      const { echo } = run(speech(500), { delay, gain: 1.2 });
      expect(echo.active).toBe(true);
      expect(Math.abs(echo.delayMs - delay * 20)).toBeLessThanOrEqual(40);
      expect(echo.gain).toBeGreaterThan(1);
      expect(echo.gain).toBeLessThan(1.6);
      expect(echo.tailMs()).toBeGreaterThanOrEqual(delay * 20);
    }
  });

  it("the echo itself never counts as the caller - even louder than the caller's voice", () => {
    const bot = speech(800);
    const { echo, asCaller } = run(bot, { delay: 25, gain: 1.5 });
    const foundAt = 150; // ~3 s (it starts with the bot's first word; on a call the line was already running)
    expect(echo.active).toBe(true);
    // after it was found, no echo frame passes as the caller
    expect(asCaller.slice(foundAt).filter(Boolean).length).toBeLessThan(10); // a stray frame at most
  });

  it("the caller talking clearly louder than the echo does count", () => {
    const bot = speech(800);
    const { echo } = run(bot, { delay: 25, gain: 0.3 });
    const t = 700 * 20 + 5;
    const predicted = echo.predicted(t);
    expect(echo.isCaller(t, Math.max(0.05, predicted * ECHO_MARGIN * 1.2))).toBe(true);
  });

  it("a normal phone (no echo, the caller talks in the bot's pauses): nothing found, nothing changes", () => {
    const bot = speech(800);
    const caller = bot.map((b, i) => (b === 0 && i % 40 < 20 ? 0.08 : 0)); // talks only where the bot is silent
    const { echo } = run(bot, { gain: 0, caller });
    expect(echo.active).toBe(false);
    expect(echo.predicted(10000)).toBe(0);
    expect(echo.isCaller(10000, 0.05)).toBe(true);
    expect(echo.tailMs()).toBe(0);
  });

  it("the caller talking over the echo for a while doesn't lose it", () => {
    const bot = speech(900);
    const caller = bot.map((_, i) => (i > 500 && i < 650 ? 0.12 : 0)); // 3 s over the bot
    const { echo } = run(bot, { delay: 20, gain: 1.2, caller });
    expect(echo.active).toBe(true);
  });
});
