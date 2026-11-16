import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS module (apps/phone is not type-checked)
import { decodeG711, Downsampler, encodeG711, FRAME_SAMPLES } from "../src/audio.js";
// @ts-expect-error plain JS module
import { CallAgent, CUES } from "../src/call-agent.js";
// @ts-expect-error plain JS module
import { buildSetup, DEFAULT_PHONE_MODEL } from "../src/gemini-live.js";
// @ts-expect-error plain JS module
import { buildInstructions, findRepoRoot, knowledgeAppendix, loadToolDefinitions, render } from "../src/mishlav.js";
// @ts-expect-error plain JS module
import { dialable, maskNumber } from "../src/numbers.js";
// @ts-expect-error plain JS module
import { buildSdp, digestResponse, parseSdp, parseSip, pickCodec } from "../src/sip.js";

const ROOT = findRepoRoot();
const VARS = {
  first_name: "דנה",
  bot_name: "נועה",
  interested_day_id: "payroll-2026-12-22-hotel",
  current_datetime: "יום ראשון, 15 בנובמבר 2026, 10:00",
  customer_context: "הלקוח התעניין ביום העיון \"סגירת שנת מס בשכר\".",
};

describe("audio", () => {
  it("G.711 round trip keeps the signal (A-law and μ-law)", () => {
    const pcm = new Int16Array(FRAME_SAMPLES).map((_, i) => Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 8000)));
    for (const pt of [8, 0]) {
      const back = decodeG711(encodeG711(pcm, pt), pt);
      for (let i = 0; i < pcm.length; i++) expect(Math.abs(back[i] - pcm[i])).toBeLessThan(300);
    }
  });

  it("24 kHz -> 8 kHz gives a third of the samples", () => {
    const down = new Downsampler();
    expect(down.push(new Int16Array(2400)).length).toBe(800);
  });
});

describe("numbers", () => {
  it("dials in international format with +", () => {
    expect(dialable("050-123-4567")).toBe("+972501234567");
    expect(dialable("+972 0501234567")).toBe("+972501234567");
    expect(dialable("00972501234567")).toBe("+972501234567");
    expect(() => dialable("abc")).toThrow();
  });

  it("masks the middle of a number for the console", () => {
    expect(maskNumber("+972501234567")).toBe("+97250***4567");
  });
});

describe("sip", () => {
  it("parses a response with compact and list headers", () => {
    const raw = [
      "SIP/2.0 200 OK",
      "v: SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bKabc;received=1.2.3.4;rport=4000",
      "Contact: <sip:a@1.2.3.4:4000>;expires=120, <sip:b@5.6.7.8>",
      "CSeq: 2 REGISTER",
      "Content-Length: 0",
      "",
      "",
    ].join("\r\n");
    const msg = parseSip(Buffer.from(raw));
    expect(msg.status).toBe(200);
    expect(msg.headers.get("via")[0]).toContain("received=1.2.3.4");
    expect(msg.headers.get("contact")).toHaveLength(2);
  });

  it("SDP round trip and codec choice", () => {
    const sdp = parseSdp(buildSdp({ ip: "1.2.3.4", port: 40002, payloadTypes: [0] }));
    expect(sdp).toEqual({ ip: "1.2.3.4", port: 40002, payloads: [0, 101] });
    expect(pickCodec([101, 0, 8])).toBe(0);
    expect(pickCodec([101])).toBeNull();
  });

  it("digest response (RFC 2617 example)", () => {
    const r = digestResponse({
      user: "Mufasa",
      password: "Circle Of Life",
      realm: "testrealm@host.com",
      nonce: "dcd98b7102dd2f0e8b11d0f600bfb0c093",
      method: "GET",
      uri: "/dir/index.html",
      qop: "auth",
      nc: "00000001",
      cnonce: "0a4f113b",
    });
    expect(r).toBe("6629fae49393a05397450978507c4ef1");
  });
});

describe("mishlav prompt", () => {
  it("renders every variable and appends the knowledge base", () => {
    const text = buildInstructions(ROOT, VARS);
    expect(text).not.toMatch(/\{\{/);
    expect(text).toContain("את נועה, נציגה טלפונית של מכללת מישלב");
    expect(text).toContain("היי דנה");
    expect(text).toContain("# מאגר ידע");
    expect(text).not.toContain("\r");
  });

  it("knowledge block matches the worker's format (Python-style values, day facts)", () => {
    const k = knowledgeAppendix(ROOT);
    expect(k).toContain("## day_id `payroll-2026-12-22-hotel`");
    expect(k).toMatch(/open_for_registration: True, פורמט: פרונטלי – במלון, series: /);
    expect(k).toContain("price_ils: 790");
  });

  it("an unknown variable is an error", () => {
    expect(() => render("{{nope}}", {})).toThrow(/nope/);
  });
});

describe("Gemini Live setup", () => {
  it("default model, the 5 tools as JSON Schema, Hebrew transcription", () => {
    const tools = loadToolDefinitions(ROOT);
    const setup = buildSetup({ instructions: "x", tools });
    expect(DEFAULT_PHONE_MODEL).toBe("gemini-3.1-flash-live-preview");
    expect(setup.model).toBe("models/gemini-3.1-flash-live-preview");
    const decls = setup.tools[0].functionDeclarations;
    expect(decls.map((d: { name: string }) => d.name)).toEqual(
      JSON.parse(readFileSync(join(ROOT, "config", "tools.json"), "utf8")).tools.map((t: { name: string }) => t.name),
    );
    expect(decls[0].parametersJsonSchema.type).toBe("object");
    expect(setup.inputAudioTranscription.languageCodes).toEqual(["he-IL"]);
  });

  it("refuses the extended-thinking model (needs non-blocking tools)", () => {
    expect(() => buildSetup({ model: "gemini-3.8-live-extended-thinking", instructions: "x", tools: [] })).toThrow();
  });
});

/** A fake Gemini session and tools server, to drive the call logic without the network. */
class FakeLive extends EventEmitter {
  ready = true;
  sent: string[] = [];
  toolResponses: unknown[] = [];
  connect = async () => {};
  sendText = (t: string) => this.sent.push(t);
  sendAudio = () => {};
  sendToolResponse = (r: unknown[]) => this.toolResponses.push(...r);
  close = () => {};
}

class FakeRtp extends EventEmitter {
  nextFrame: () => Int16Array | null = () => null;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("call agent", () => {
  it("opens with the cue when the callee stays silent", async () => {
    const live = new FakeLive();
    const agent = new CallAgent({ live, tools: { callTool: async () => ({ ok: true }) }, openAfterSilenceMs: 100 });
    agent.start(new FakeRtp());
    await wait(250);
    expect(live.sent).toEqual([CUES.open]);
    agent.end();
  });

  it("does not open when the callee said hello first", async () => {
    const live = new FakeLive();
    const agent = new CallAgent({ live, tools: { callTool: async () => ({ ok: true }) }, openAfterSilenceMs: 100 });
    agent.start(new FakeRtp());
    live.emit("inputTranscript", "הלו");
    await wait(250);
    expect(live.sent).toEqual([]);
    agent.end();
  });

  it("end_call: the tool result goes back as JSON text and the line drops after the goodbye", async () => {
    const live = new FakeLive();
    const calls: string[] = [];
    const tools = {
      callTool: async (name: string) => {
        calls.push(name);
        return { ok: true, status: "ending", message_he: "..." };
      },
    };
    const agent = new CallAgent({ live, tools, openAfterSilenceMs: 0 });
    const reasons: string[] = [];
    agent.on("hangup", (r: string) => reasons.push(r));
    const rtp = new FakeRtp();
    agent.start(rtp);
    live.emit("toolCall", [{ id: "1", name: "end_call", args: { reason: "completed" } }]);
    await wait(10);
    expect(calls).toEqual(["end_call"]);
    expect(live.toolResponses).toEqual([{ id: "1", name: "end_call", response: { output: JSON.stringify({ ok: true, status: "ending", message_he: "..." }) } }]);
    // the goodbye after the result: 0.3 s of audio at 24 kHz, played out frame by frame
    live.emit("audio", Buffer.alloc(24000 * 0.3 * 2, 1));
    live.emit("turnComplete");
    const player = setInterval(() => rtp.nextFrame(), 20);
    await wait(300);
    expect(reasons).toEqual([]); // still playing / grace
    await wait(1200);
    clearInterval(player);
    expect(reasons).toEqual(["end_call"]);
    agent.end();
  });

  it("end_call after a whole answer (the goodbye) since the caller spoke: its reply is not played", async () => {
    const live = new FakeLive();
    const agent = new CallAgent({ live, tools: { callTool: async () => ({ ok: true, status: "ending" }) }, openAfterSilenceMs: 0 });
    const reasons: string[] = [];
    agent.on("hangup", (r: string) => reasons.push(r));
    const rtp = new FakeRtp();
    agent.start(rtp);
    live.emit("inputTranscript", "לא מתאים לי, ביי");
    live.emit("audio", Buffer.alloc(4800, 1)); // the goodbye
    live.emit("turnComplete");
    while (rtp.nextFrame()); // played out
    live.emit("toolCall", [{ id: "1", name: "end_call", args: { reason: "not_interested" } }]);
    await wait(10);
    live.emit("audio", Buffer.alloc(4800, 1)); // the goodbye again: muted
    expect(agent.queued).toBe(0);
    await wait(1200);
    expect(reasons).toEqual(["end_call"]);
    agent.end();
  });

  it("end_call in the same turn as the words before it: the reply still plays", async () => {
    const live = new FakeLive();
    const agent = new CallAgent({ live, tools: { callTool: async () => ({ ok: true, status: "ending" }) }, openAfterSilenceMs: 0 });
    agent.start(new FakeRtp());
    live.emit("inputTranscript", "תעבירי אותי לנציג");
    live.emit("audio", Buffer.alloc(4800, 1)); // "אני מעבירה את הבקשה..." (no turnComplete yet)
    live.emit("toolCall", [{ id: "1", name: "end_call", args: { reason: "completed" } }]);
    await wait(10);
    const before = agent.queued;
    live.emit("audio", Buffer.alloc(4800, 1)); // the goodbye
    expect(agent.queued).toBeGreaterThan(before);
    agent.end();
  });

  it("a closing action hangs up after the goodbye even without end_call (S1-S3: 'יום טוב' and an open line)", async () => {
    const live = new FakeLive();
    const agent = new CallAgent({ live, tools: { callTool: async () => ({ ok: true, status: "sent", closing: true }) }, openAfterSilenceMs: 0 });
    const reasons: string[] = [];
    agent.on("hangup", (r: string) => reasons.push(r));
    const rtp = new FakeRtp();
    agent.start(rtp);
    live.emit("toolCall", [{ id: "1", name: "send_purchase_link", args: { day_id: "x" } }]);
    await wait(10);
    live.emit("audio", Buffer.alloc(4800, 1)); // "הקישור נשלח עכשיו במסרון. יום נעים, להתראות!"
    live.emit("turnComplete");
    while (rtp.nextFrame()); // played out
    await wait(1000);
    expect(reasons).toEqual([]); // the customer still has a moment to say something
    await wait(1300);
    expect(reasons).toEqual(["closing"]);
    agent.end();
  });

  it("a closing action: the call goes on when the caller has more to say", async () => {
    const live = new FakeLive();
    const agent = new CallAgent({ live, tools: { callTool: async () => ({ ok: true, closing: true }) }, openAfterSilenceMs: 0 });
    const reasons: string[] = [];
    agent.on("hangup", (r: string) => reasons.push(r));
    const rtp = new FakeRtp();
    agent.start(rtp);
    live.emit("toolCall", [{ id: "1", name: "send_purchase_link", args: { day_id: "x" } }]);
    await wait(10);
    live.emit("audio", Buffer.alloc(4800, 1));
    live.emit("turnComplete");
    while (rtp.nextFrame());
    await wait(100);
    const voice = new Int16Array(160).fill(3000);
    for (let i = 0; i < 100; i++) rtp.emit("audio", voice); // 2 s: "רגע, עוד שאלה..."
    await wait(2300);
    expect(reasons).toEqual([]);
    agent.end();
  });

  it("end_call right after the fixed goodbye in the same turn: the goodbye is not said twice (English removal call)", async () => {
    const live = new FakeLive();
    const agent = new CallAgent({ live, tools: { callTool: async () => ({ ok: true, status: "ending" }) }, openAfterSilenceMs: 0 });
    agent.start(new FakeRtp());
    live.emit("inputTranscript", "Please remove me from your list");
    live.emit("outputTranscript", "בסדר, המספר הוסר מהרשימה. יום נעים, להתראות!");
    live.emit("audio", Buffer.alloc(4800, 1)); // no turnComplete yet
    live.emit("toolCall", [{ id: "1", name: "end_call", args: { reason: "do_not_call" } }]);
    await wait(10);
    const before = agent.queued;
    live.emit("audio", Buffer.alloc(4800, 1)); // the same sentence again: muted
    expect(agent.queued).toBe(before);
    agent.end();
  });

  it("the fixed goodbye without end_call still hangs up, once (R2: the goodbye 4 times)", async () => {
    const live = new FakeLive();
    const agent = new CallAgent({ live, tools: { callTool: async () => ({ ok: true }) }, openAfterSilenceMs: 0 });
    const reasons: string[] = [];
    agent.on("hangup", (r: string) => reasons.push(r));
    const rtp = new FakeRtp();
    agent.start(rtp);
    live.emit("inputTranscript", "לא תודה, יצאתי לפנסיה");
    live.emit("outputTranscript", "בסדר גמור, יום נעים, להתראות!");
    live.emit("audio", Buffer.alloc(4800, 1));
    live.emit("turnComplete"); // and no end_call
    while (rtp.nextFrame());
    await wait(2300);
    expect(reasons).toEqual(["closing"]);
    expect(live.sent).toEqual([CUES.open]); // no silence check that makes it say goodbye again
    agent.end();
  });

  it("voicemail: hangs up at once and plays nothing", async () => {
    const live = new FakeLive();
    const agent = new CallAgent({ live, tools: { callTool: async () => ({ ok: true, status: "ending" }) }, openAfterSilenceMs: 0 });
    const reasons: string[] = [];
    agent.on("hangup", (r: string) => reasons.push(r));
    agent.start(new FakeRtp());
    live.emit("toolCall", [{ id: "1", name: "end_call", args: { reason: "voicemail" } }]);
    await wait(10);
    live.emit("audio", Buffer.alloc(4800, 1));
    expect(agent.queued).toBe(0);
    await wait(700);
    expect(reasons).toEqual(["voicemail"]);
    agent.end();
  });
});
