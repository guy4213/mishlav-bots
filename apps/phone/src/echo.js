// The bot's own voice coming back on the line (echo), told apart from the caller.
//
// On a phone with Bluetooth earbuds the phone's own echo cancelling fails: the bot's words came back at 0.28-0.36
// while the caller talks at 0.04-0.1 (26.11, 15:53 and 15:59) - louder than the caller, so no fixed level tells
// them apart. The bot cut itself off again and again, and the echo that came back after it stopped (half a second
// later, after the old fixed 250 ms) reached Gemini as the caller's words ("Hello.", "네, 감사합니다.").
//
// But the echo is the bot's own voice, late by a fixed delay and scaled by a fixed gain. So we compare: every 20 ms
// we know how loud the bot was (played) and how loud the line is (heard). From the last seconds we find the delay
// at which the line's loudness follows the bot's (correlation), and the gain at that delay. Then for every frame:
//   predicted echo = gain x the bot's loudness one delay ago;
//   the caller is talking only if the line is clearly louder than that (ECHO_MARGIN);
//   the bot is "still audible" (its echo is still coming) until one delay after its last word.
// No echo on the line (a normal phone): no correlation is found and nothing changes.

const FRAME_MS = 20;
const HISTORY_FRAMES = 400; // 8 s kept
const WINDOW_FRAMES = 300; // the last 6 s are compared
const MAX_DELAY_FRAMES = 60; // echo up to 1.2 s late (network + Bluetooth both ways)
const MIN_BOT_FRAMES = 20; // at least 0.4 s of the bot talking (at that delay) before anything is decided
// the bot talked this long in all: an echo up to MAX_DELAY_FRAMES late would have been found by now
const CHECKED_BOT_FRAMES = MIN_BOT_FRAMES + MAX_DELAY_FRAMES;
const MIN_HEARD_FRAMES = 60; // and 1.2 s of the line
const BOT_VOICE = 0.01; // a bot frame louder than this is the bot talking
const MIN_CORRELATION = 0.6; // the line follows the bot this closely: it is its echo
// a found echo is dropped only when the line clearly stopped following the bot (the caller talking over the bot
// for a while lowers the correlation, and the echo is still there)
const LOST_CORRELATION = 0.3;
// the echo's gain: a high share of line/bot (the echo's loud moments count, so it never passes as the caller)
const GAIN_PERCENTILE = 0.8;
const UPDATE_MS = 200; // the opening must not be cut by its own echo: decided within ~1 s of the bot talking
// the caller talks over the echo only when the line is this much louder than the echo predicted (x2 = +6 dB)
export const ECHO_MARGIN = 2;
const SPREAD_FRAMES = 2; // the echo's loudness is taken as the bot's highest within ±40 ms (timing jitter)
const TAIL_EXTRA_MS = 200; // the echo's own tail after the bot's last word arrived

export class EchoModel {
  constructor() {
    this.played = []; // the bot's level per 20 ms frame sent, oldest first: { t, level }
    this.heard = []; // the line's level per 20 ms frame received: { t, level }
    this.delayMs = 0;
    this.gain = 0;
    this.correlation = 0;
    this.active = false; // an echo was found
    this.lastUpdate = 0;
    this.found = null; // the first time it was found (for the log): { delayMs, gain, correlation }
    // the line was checked for an echo at least once (enough of the bot to compare): until then the caller's
    // talking over the bot can't be told from its echo (call-agent.js waits longer before cutting the bot)
    this.checked = false;
    this.botFrames = 0; // the bot's frames with voice, in all
    // a new delay is taken only when two checks in a row agree on it (with little data a chance match once found
    // 180 ms for an echo 420 ms late)
    this.candidate = null; // { lag, times }
    this.changes = 0; // how many times the delay was set (for the log)
  }

  /** One frame sent to the caller (level 0: silence). */
  addPlayed(t, level) {
    if (level > BOT_VOICE) this.botFrames++;
    this.played.push({ t, level });
    if (this.played.length > HISTORY_FRAMES) this.played.shift();
  }

  /** One frame received from the caller. */
  addHeard(t, level) {
    this.heard.push({ t, level });
    if (this.heard.length > HISTORY_FRAMES) this.heard.shift();
    if (t - this.lastUpdate >= UPDATE_MS) {
      this.lastUpdate = t;
      this.update();
    }
  }

  /** The index of the frame sent nearest to time t (-1: none near it). */
  _nearest(t) {
    const p = this.played;
    if (!p.length || t < p[0].t - FRAME_MS || t > p[p.length - 1].t + FRAME_MS) return -1;
    // frames are sent every 20 ms: binary search for the nearest
    let lo = 0;
    let hi = p.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (p[mid].t < t) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0 && Math.abs(p[lo - 1].t - t) < Math.abs(p[lo].t - t)) lo--;
    return lo;
  }

  /** The bot's level in the frame sent nearest to t (for the correlation). */
  botLevelExact(t) {
    const i = this._nearest(t);
    return i < 0 ? 0 : this.played[i].level;
  }

  /** The bot's level around t: the highest within ±SPREAD_FRAMES (timing jitter). */
  botLevelAt(t) {
    const i = this._nearest(t);
    if (i < 0) return 0;
    const p = this.played;
    let max = 0;
    for (let j = Math.max(0, i - SPREAD_FRAMES); j <= Math.min(p.length - 1, i + SPREAD_FRAMES); j++) max = Math.max(max, p[j].level);
    return max;
  }

  /** The echo expected on the line at time t (0: no echo known). */
  predicted(t) {
    if (!this.active) return 0;
    return this.gain * this.botLevelAt(t - this.delayMs);
  }

  /** How long after the bot's last frame its echo may still come. */
  tailMs() {
    return this.active ? this.delayMs + TAIL_EXTRA_MS : 0;
  }

  /** Is this level on the line the caller, not (only) the bot's echo? */
  isCaller(t, level) {
    return level >= ECHO_MARGIN * this.predicted(t);
  }

  /** Finds the delay at which the line follows the bot, and the gain there, from the last seconds. */
  update() {
    const heard = this.heard.slice(-WINDOW_FRAMES);
    if (heard.length < MIN_HEARD_FRAMES) return;
    let best = { r: 0, lag: 0 };
    let compared = false;
    const x = heard.map((h) => Math.sqrt(h.level)); // the line (square root: loud peaks don't decide alone)
    for (let lag = 0; lag <= MAX_DELAY_FRAMES; lag++) {
      const y = heard.map((h) => Math.sqrt(this.botLevelExact(h.t - lag * FRAME_MS)));
      const botFrames = y.filter((v) => v * v > BOT_VOICE).length;
      if (botFrames < MIN_BOT_FRAMES) continue;
      compared = true;
      const r = correlation(x, y);
      if (r > best.r) best = { r, lag };
    }
    if (!compared) return;
    if (this.botFrames >= CHECKED_BOT_FRAMES) this.checked = true;
    if (best.r < MIN_CORRELATION) {
      // no echo now (or it went away): keep a found echo only while the bot is quiet - nothing to compare then
      const botTalked = heard.filter((h) => this.botLevelExact(h.t - this.delayMs) > BOT_VOICE).length >= MIN_BOT_FRAMES;
      if (botTalked && best.r < LOST_CORRELATION) this.active = false;
      this.correlation = best.r;
      return;
    }
    const near = (a, b) => Math.abs(a - b) <= SPREAD_FRAMES;
    const known = this.active && near(best.lag, this.delayMs / FRAME_MS);
    if (!known) {
      this.candidate = this.candidate && near(this.candidate.lag, best.lag) ? { lag: best.lag, times: this.candidate.times + 1 } : { lag: best.lag, times: 1 };
      if (this.candidate.times < 2) return;
    }
    const delayMs = best.lag * FRAME_MS;
    // the gain: the line against the bot at that delay, where the bot talked (GAIN_PERCENTILE: the echo's loud
    // moments are covered; the caller talking over the bot now and then only raises the top few)
    const ratios = heard
      .map((h) => ({ line: h.level, bot: this.botLevelExact(h.t - delayMs) }))
      .filter((v) => v.bot > BOT_VOICE)
      .map((v) => v.line / v.bot)
      .sort((a, b) => a - b);
    const gain = ratios[Math.floor(ratios.length * GAIN_PERCENTILE)] ?? 0;
    if (!(gain > 0)) return;
    if (!known) this.changes++;
    this.delayMs = delayMs;
    this.gain = gain;
    this.correlation = best.r;
    this.active = true;
    this.checked = true;
    if (!this.found) this.found = { delayMs, gain, correlation: best.r };
  }

  /** For the call log. */
  describe() {
    if (!this.found) return null;
    return `echo of the bot on the line: ${this.delayMs}ms late, gain ${this.gain.toFixed(2)} (correlation ${this.correlation.toFixed(2)})`;
  }
}

function correlation(x, y) {
  const n = x.length;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += x[i];
    my += y[i];
  }
  mx /= n;
  my /= n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const a = x[i] - mx;
    const b = y[i] - my;
    sxy += a * b;
    sxx += a * a;
    syy += b * b;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
}
