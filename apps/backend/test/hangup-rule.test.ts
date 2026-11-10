import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findRepoRoot } from "@mishlav/shared";
import { describe, expect, it } from "vitest";

// The rule lives in the dashboard page (provider A hangs up from the browser); test that exact code.
const html = readFileSync(join(findRepoRoot(__dirname), "apps", "backend", "dashboard", "index.html"), "utf8");
const src = /\/\/ hangup-rule:start([\s\S]*?)\/\/ hangup-rule:end/.exec(html)?.[1] ?? "";
type Mode = "speaking" | "listening";
const elHangupDue = new Function(`${src}; return elHangupDue;`)() as (a: {
  now: number; t0: number; spoke: boolean; mode: Mode; modeAt: number;
}) => boolean;

/** Replays mode changes (ms after end_call) and returns when the line would drop. */
function hangupAt(changes: [number, Mode][], startMode: Mode = "listening"): number {
  let mode = startMode, modeAt = 0, spoke = startMode === "speaking";
  for (let now = 0; now <= 30000; now += 100) {
    for (const [at, m] of changes) if (at === now) { mode = m; modeAt = now; if (m === "speaking") spoke = true; }
    if (elHangupDue({ now, t0: 0, spoke, mode, modeAt })) return now;
  }
  return -1;
}

describe("provider A hang-up after end_call", () => {
  it("R4: goodbye starts after end_call and pauses mid-sentence - waits for its real end", () => {
    // end_call at 0; "אין בעיה, אני מעבירה..." from 600 to 2600, a 400ms gap, "...יום נפלא!" to 4500
    const at = hangupAt([[600, "speaking"], [2600, "listening"], [3000, "speaking"], [4500, "listening"]]);
    expect(at).toBe(7000); // 2.5s after the goodbye ended, not in the gap
  });

  it("goodbye already playing when end_call arrives", () => {
    expect(hangupAt([[1200, "listening"]], "speaking")).toBe(3700);
  });

  it("no goodbye (voicemail) - hangs up after 8s", () => {
    expect(hangupAt([])).toBe(8000);
  });

  it("never stuck: hard cap", () => {
    expect(hangupAt([[100, "speaking"]])).toBe(25000);
  });
});

describe("provider A: goodbye said after the end_call result (tools first, then speech)", () => {
  it("R4 at 20:04: request_human + end_call with no words, goodbye ~5s later - it is heard in full", () => {
    expect(hangupAt([[5200, "speaking"], [8400, "listening"]])).toBe(10900);
  });
});

describe("provider A: a 2s pause between two parts of the closing", () => {
  it("18:17 call: sentence, ~2s while the model answers the end_call result, then more speech - none of it is cut", () => {
    // sentence 0-4500, pause 2000 (LLM round after end_call), "להתראות" 6500-7300
    expect(hangupAt([[4500, "listening"], [6500, "speaking"], [7300, "listening"]], "speaking")).toBe(9800);
  });
});
