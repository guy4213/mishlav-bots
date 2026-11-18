import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS module (apps/phone is not type-checked)
import { UsageMeter, usageLine } from "../../phone/src/usage.js";
import { aiCostUsd } from "../src/ai-cost";
import { testConfig } from "./helpers";

const settings = testConfig().settings;

describe("AI cost of a call", () => {
  it("sums the Live API's per-turn usage by modality", () => {
    const m = new UsageMeter();
    // turn 1, then turn 2: each turn reports the whole context again (that is what Google bills)
    m.add({ promptTokenCount: 6300, promptTokensDetails: [{ modality: "TEXT", tokenCount: 6000 }, { modality: "AUDIO", tokenCount: 300 }], responseTokenCount: 250, responseTokensDetails: [{ modality: "AUDIO", tokenCount: 250 }] });
    m.add({ promptTokenCount: 6850, promptTokensDetails: [{ modality: "TEXT", tokenCount: 6000 }, { modality: "AUDIO", tokenCount: 850 }], responseTokenCount: 300, responseTokensDetails: [{ modality: "AUDIO", tokenCount: 300 }] });
    m.add({ promptTokenCount: 40 }); // no breakdown: counted as text
    expect(m.snapshot()).toEqual({ input: { TEXT: 12040, AUDIO: 1150 }, output: { AUDIO: 550 }, messages: 3 });
    expect(usageLine(m.snapshot())).toBe("in 13,190 (text 12,040, audio 1,150) · out 550 (audio 550)");
  });

  it("prices tokens by the table in settings.yaml", () => {
    // 1M text in = $0.75, 1M audio in = $3, 1M audio out = $12
    expect(aiCostUsd({ model: "m", input: { TEXT: 1e6, AUDIO: 1e6 }, output: { AUDIO: 1e6 } }, settings)).toBe(15.75);
    expect(aiCostUsd({ model: "m", input: { TEXT: 60000, AUDIO: 23000 }, output: { AUDIO: 1200 } }, settings)).toBe(0.1284);
  });

  it("a modality without a price is never free: it costs the side's top price", () => {
    expect(aiCostUsd({ model: "m", input: { NEW: 1e6 }, output: {} }, settings)).toBe(3);
  });

  it("no price table: no cost", () => {
    expect(aiCostUsd({ model: "m", input: { TEXT: 1 }, output: {} }, { ...settings, pricing: undefined })).toBeNull();
  });
});
