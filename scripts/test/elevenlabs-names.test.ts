import { describe, expect, it } from "vitest";
import { elevenPrompt, elevenToolName, webhookToolConfig } from "../lib/elevenlabs";

// ElevenLabs' own system tool is "end_call": a tool of ours with that name made ElevenLabs drop the
// line mid-sentence. On ElevenLabs ours is "finish_call", still posting to /tools/end_call.
describe("ElevenLabs tool names", () => {
  it("our end_call is finish_call on ElevenLabs, same server URL", () => {
    const cfg = webhookToolConfig(
      { name: "end_call", description: "d", parameters: { properties: { reason: { type: "string" } }, required: ["reason"] } },
      "https://x.ngrok-free.app",
      "s",
    );
    expect(cfg.name).toBe("finish_call");
    expect(cfg.api_schema.url).toBe("https://x.ngrok-free.app/tools/end_call");
    expect(elevenToolName("request_human")).toBe("request_human");
  });

  it("the prompt the agent sees names finish_call, never end_call", () => {
    const p = elevenPrompt("להיפרד ולקרוא ל-`end_call` (`completed`). משיבון → `end_call` עם `voicemail`.");
    expect(p).not.toContain("end_call");
    expect(p).toContain("`finish_call` (`completed`)");
  });
});
