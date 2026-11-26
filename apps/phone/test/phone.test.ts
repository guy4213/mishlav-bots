import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS module (apps/phone is not type-checked)
import { decodeG711, Downsampler, encodeG711, FRAME_SAMPLES } from "../src/audio.js";
// @ts-expect-error plain JS module
import { CallAgent, CUES, heardPart, isHebrewOpening, saysLinkSent } from "../src/call-agent.js";
// @ts-expect-error plain JS module
import { createDenoiser } from "../src/denoise.js";
// @ts-expect-error plain JS module
import { FixedLines, SAY_LINK_SENDING, saidTheSentence } from "../src/fixed-lines.js";
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
  interested_day_id: "2027-05-17-hotel",
  current_datetime: "יום ראשון, 15 בנובמבר 2026, 10:00",
  customer_context: "הלקוח התעניין ביום העיון \"דיני עבודה ומס הכנסה\".",
  day_catalog: "- `2027-05-17-hotel` – דיני עבודה ומס הכנסה · מלון · 17.5.2027 · 09:00–16:00",
};

describe("modules load", () => {
  // line.js is not imported by the other tests: a syntax error there (a duplicate `gender`) took the line down
  it("every phone module loads (line.js too)", async () => {
    for (const m of ["line", "call-agent", "gemini-live", "mishlav", "sip", "rtp", "audio", "numbers"]) {
      await expect(import(`../src/${m}.js`)).resolves.toBeTruthy();
    }
  });
});

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
    expect(text).toContain("נועה – נציגה טלפונית של מכללת מישלב");
    expect(text).toContain("היי דנה");
    expect(text).toContain("# מאגר ידע");
    expect(text).not.toContain("\r");
  });

  it("knowledge block: the general knowledge only, without our TODO notes (days come from get_day_info)", () => {
    const k = knowledgeAppendix(ROOT);
    expect(k).toContain("מבנה ימי העיון");
    expect(k).not.toContain("## day_id"); // every turn bills the whole prompt: no copy of what the tool returns
    expect(k).not.toContain("TODO"); // notes for us, some with unconfirmed prices
    expect(k).not.toMatch(/\n{3,}/);
    // the day ids are in the prompt: the closed catalogue the server sends (day_catalog)
    expect(buildInstructions(ROOT, VARS)).toContain("`2027-05-17-hotel`");
  });

  it("long calls: the context is trimmed before it grows (every turn is billed on all of it)", () => {
    const setup = buildSetup({ instructions: "x", tools: [] });
    expect(setup.contextWindowCompression).toEqual({ triggerTokens: 20000, slidingWindow: { targetTokens: 12000 } });
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
    live.emit("outputTranscript", "בסדר גמור, יום נעים, להתראות!"); // ...and not written (it showed twice)
    expect(agent.queued).toBe(0);
    expect(agent.turnText).toBe("");
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
    live.emit("audio", Buffer.alloc(4800, 1)); // "הקישור נשלח עכשיו בוואטסאפ. יום נעים, להתראות."
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

  it("a server update (the WhatsApp link went out) waits until the bot finished answering the tool, then reaches it", async () => {
    const live = new FakeLive();
    const agent = new CallAgent({ live, tools: { callTool: async () => ({ ok: true, status: "sending" }) }, openAfterSilenceMs: 60_000 });
    agent.start(new FakeRtp());
    live.emit("toolCall", [{ id: "1", name: "send_purchase_link", args: { day_id: "d" } }]);
    await wait(10);
    live.emit("outputTranscript", "אני שולחת לך עכשיו את הקישור בוואטסאפ, רק רגע.");
    live.emit("audio", Buffer.alloc(4800, 1)); // the bot is saying it
    agent.notify("(הודעת מערכת: הקישור נשלח)");
    await wait(80);
    expect(live.sent).toEqual([]); // not mid-sentence: that would cut it off
    live.emit("turnComplete");
    await wait(80);
    expect(live.sent).toEqual(["(הודעת מערכת: הקישור נשלח)"]);
    agent.end();
  });

  it("it says it sends the link but calls no tool (26.11): it is told nothing went, once", async () => {
    const live = new FakeLive();
    const agent = new CallAgent({ live, tools: { callTool: async () => ({ ok: true }) }, openAfterSilenceMs: 60_000 });
    agent.start(new FakeRtp());
    const say = (text: string) => {
      live.emit("outputTranscript", text);
      live.emit("audio", Buffer.alloc(4800, 1));
      live.emit("turnComplete");
    };
    say("מעולה, שולחת לך קישור עכשיו. משהו נוסף שאוכל לעזור בו?");
    await wait(80);
    expect(live.sent).toEqual([CUES.linkNotSent]);
    say("שולחת לך קישור עכשיו."); // once is enough
    await wait(80);
    expect(live.sent).toHaveLength(1);
    agent.end();
  });

  it("no nudge when the tool was called, or for the question 'לשלוח לך קישור?'", async () => {
    expect(saysLinkSent("לשלוח לך קישור להרשמה?")).toBe(false);
    expect(saysLinkSent("רוצה שאשלח לך קישור?")).toBe(false);
    expect(saysLinkSent("הקישור נשלח אליך בוואטסאפ.")).toBe(true);
    const live = new FakeLive();
    const agent = new CallAgent({ live, tools: { callTool: async () => ({ ok: true, status: "sending" }) }, openAfterSilenceMs: 60_000 });
    agent.start(new FakeRtp());
    live.emit("toolCall", [{ id: "1", name: "send_purchase_link", args: { day_id: "d" } }]);
    await wait(10);
    live.emit("outputTranscript", "אני שולחת לך עכשיו את הקישור בוואטסאפ, רק רגע.");
    live.emit("audio", Buffer.alloc(4800, 1));
    live.emit("turnComplete");
    await wait(80);
    expect(live.sent).toEqual([]);
    agent.end();
  });

  describe("the fixed 'sending' sentence (the bot said it twice and didn't send, 26.11 16:34)", () => {
    const clip = new Int16Array(8000 * 3).fill(2000); // 3 s in the bot's voice (fixed-lines.js)
    const linkCall = [{ id: "1", name: "send_purchase_link", args: { day_id: "d" } }];

    it("the tool is called: the line plays the sentence at once, while the link is sent, and writes it once", async () => {
      const live = new FakeLive();
      let release = () => {};
      const sending = new Promise<void>((r) => (release = r)); // Texter takes its time
      const tools = { callTool: async () => (await sending, { ok: true, status: "sent", closing: true, say_he: "הקישור נשלח אליך בוואטסאפ. יום נעים, להתראות." }) };
      const agent = new CallAgent({ live, tools, openAfterSilenceMs: 60_000, linkSending: () => clip });
      agent.start(new FakeRtp());
      const lines: { who: string; text: string }[] = [];
      agent.on("line", (l: { who: string; text: string }) => lines.push(l));
      live.emit("toolCall", linkCall);
      await wait(10);
      expect(agent.queued).toBe(clip.length); // playing while the tool runs
      expect(live.toolResponses).toEqual([]);
      expect(lines.filter((l) => l.who === "agent").map((l) => l.text)).toEqual(["אני שולחת לך עכשיו את הקישור בוואטסאפ, רק רגע."]);
      release();
      await wait(10);
      expect(live.toolResponses).toHaveLength(1); // then the result: the bot says "נשלח" after the sentence
      expect(live.sent).toEqual([]); // no nudge: the tool was called
      agent.end();
    });

    it("the bot already said it is sending (then was told to call the tool): not said again", async () => {
      const live = new FakeLive();
      const agent = new CallAgent({ live, tools: { callTool: async () => ({ ok: true, status: "sent" }) }, openAfterSilenceMs: 60_000, linkSending: () => clip });
      agent.start(new FakeRtp());
      live.emit("outputTranscript", "אני שולחת לך עכשיו את הקישור בוואטסאפ, רק רגע.");
      live.emit("audio", Buffer.alloc(4800, 1));
      live.emit("turnComplete");
      const before = agent.queued;
      live.emit("toolCall", linkCall);
      await wait(10);
      expect(agent.queued).toBe(before);
      agent.end();
    });

    it("its words before the tool that aren't 'sending' (\"מעולה.\"): the sentence still plays", async () => {
      const live = new FakeLive();
      const agent = new CallAgent({ live, tools: { callTool: async () => ({ ok: true, status: "sent" }) }, openAfterSilenceMs: 60_000, linkSending: () => clip });
      agent.start(new FakeRtp());
      live.emit("outputTranscript", "מעולה.");
      live.emit("audio", Buffer.alloc(4800, 1));
      const before = agent.queued;
      live.emit("toolCall", linkCall);
      await wait(10);
      expect(agent.queued).toBe(before + clip.length);
      agent.end();
    });

    it("not ready (a new voice, the first call after a restart): the tool still runs, the log says so", async () => {
      const live = new FakeLive();
      const agent = new CallAgent({ live, tools: { callTool: async () => ({ ok: true, status: "sent" }) }, openAfterSilenceMs: 60_000 });
      agent.start(new FakeRtp());
      const lines: { who: string; text: string }[] = [];
      agent.on("line", (l: { who: string; text: string }) => lines.push(l));
      live.emit("toolCall", linkCall);
      await wait(10);
      expect(live.toolResponses).toHaveLength(1);
      expect(lines.some((l) => l.who === "note" && l.text.includes("not ready"))).toBe(true);
      agent.end();
    });

    it("other tools play nothing", async () => {
      const live = new FakeLive();
      const agent = new CallAgent({ live, tools: { callTool: async () => ({ ok: true }) }, openAfterSilenceMs: 60_000, linkSending: () => clip });
      agent.start(new FakeRtp());
      live.emit("toolCall", [{ id: "1", name: "request_human", args: {} }]);
      await wait(10);
      expect(agent.queued).toBe(0);
      agent.end();
    });
  });

  describe("FixedLines: the sentence made once per voice, in that voice", () => {
    /** A Live session that says `said` (its transcript) with 2 s of audio. */
    const fakeSession = (said: string, made: string[]) => () => {
      const s = new FakeLive();
      s.sendText = (t: string) => {
        made.push(t);
        setTimeout(() => {
          s.emit("outputTranscript", said);
          s.emit("audio", Buffer.alloc(24000 * 2 * 2, 1));
          s.emit("turnComplete");
        }, 5);
        return 0;
      };
      return s;
    };

    it("made once, kept for every later call; a call asking meanwhile shares it", async () => {
      const made: string[] = [];
      const lines = new FixedLines({ apiKey: "k", model: "m", connect: fakeSession(SAY_LINK_SENDING, made) });
      expect(lines.linkSending("Kore")).toBeNull();
      const [a, b] = await Promise.all([lines.prepare("Kore"), lines.prepare("Kore")]);
      expect(a).toBe(b);
      expect(a.length).toBe(16000); // 2 s at 8 kHz
      expect(lines.linkSending("Kore")).toBe(a);
      await lines.prepare("Kore");
      expect(made).toEqual([SAY_LINK_SENDING]);
    });

    it("it said something else: not used (tried again, then nothing - the call goes on without it)", async () => {
      const made: string[] = [];
      const lines = new FixedLines({ apiKey: "k", model: "m", connect: fakeSession("בטח! אני שולחת לך את הקישור ועוד הרבה מילים נוספות שלא ביקשנו בכלל, רק רגע אחד קטן", made) });
      expect(await lines.prepare("Puck")).toBeNull();
      expect(made).toHaveLength(3);
      expect(lines.linkSending("Puck")).toBeNull();
    });

    it("the transcript may spell it differently: still the sentence", () => {
      expect(saidTheSentence("אני שולחת לך עכשיו את הקישור ב-WhatsApp, רק רגע.")).toBe(true);
      expect(saidTheSentence("אני שולחת לך עכשיו את הקישור בווטסאפ רק רגע")).toBe(true);
      expect(saidTheSentence("בסדר.")).toBe(false);
    });
  });

  it("every tool answer reminds the bot of the customer's gender", async () => {
    const live = new FakeLive();
    const agent = new CallAgent({ live, tools: { callTool: async () => ({ ok: true }) }, openAfterSilenceMs: 0, genderReminder: "הלקוח גבר" });
    agent.start(new FakeRtp());
    live.emit("toolCall", [{ id: "1", name: "get_day_info", args: { day_id: "x" } }]);
    await wait(10);
    expect(live.toolResponses).toEqual([{ id: "1", name: "get_day_info", response: { output: JSON.stringify({ ok: true, customer_gender_he: "הלקוח גבר" }) } }]);
    agent.end();
  });

  describe("the opening made while ringing", () => {
    const OPENING = "היי גיא, כאן נועה, נציגת הבינה המלאכותית של מכללת מישלב. מה נשמע?";
    const voice = new Int16Array(160).fill(3000);
    const setup = async (openAfterSilenceMs = 2500) => {
      const live = new FakeLive();
      const heard: Buffer[] = [];
      live.sendAudio = ((b: Buffer) => heard.push(b)) as never;
      const agent = new CallAgent({ live, tools: { callTool: async () => ({ ok: true }) }, openAfterSilenceMs });
      const lines: string[] = [];
      agent.on("line", (l: { who: string; text: string }) => lines.push(`${l.who}: ${l.text}`));
      const warmed = agent.warmUp();
      live.emit("audio", Buffer.alloc(24000 * 2, 1)); // 0.5 s of the opening, at 24 kHz
      live.emit("outputTranscript", OPENING);
      live.emit("turnComplete");
      await warmed;
      const rtp = new FakeRtp();
      agent.start(rtp);
      const callerHeard = () => heard.some((b) => b.some((x) => x !== 0));
      return { live, agent, rtp, lines, callerHeard };
    };

    it("plays 0.3 s after the callee's 'הלו' - Gemini doesn't make it then, and doesn't hear the 'הלו'", async () => {
      const { live, agent, rtp, lines, callerHeard } = await setup();
      for (let i = 0; i < 20; i++) rtp.emit("audio", voice); // 0.4 s of "הלו"
      await wait(100);
      expect(agent.queued).toBe(0); // the callee may still be talking
      await wait(400);
      expect(agent.queued).toBeGreaterThan(0); // the opening is playing
      expect(live.sent).toEqual([CUES.warmUp]); // no opening cue: Gemini isn't asked to make it again
      expect(callerHeard()).toBe(false);
      expect(lines).toContain(`agent: ${OPENING}`);
      expect(lines.some((l) => l.includes("opening made while ringing, played"))).toBe(true);
      agent.end();
    });

    it("the callee says nothing: it plays after the short silence", async () => {
      const { live, agent } = await setup(100);
      await wait(250);
      expect(agent.queued).toBeGreaterThan(0);
      expect(live.sent).toEqual([CUES.warmUp]);
      agent.end();
    });

    it("the callee talks at length first (a voicemail greeting): Gemini hears it all, the opening isn't played", async () => {
      const { agent, rtp, lines, callerHeard, live } = await setup();
      for (let i = 0; i < 85; i++) {
        rtp.emit("audio", voice); // 1.7 s of talk (85 frames of 20 ms), with no pause the opening would wait for
        await wait(5);
      }
      expect(callerHeard()).toBe(true);
      expect(agent.queued).toBe(0);
      expect(lines.some((l) => l.includes("opening made while ringing not played"))).toBe(true);
      // it "said" the opening while ringing, but nobody heard it: told so, it opens with the introduction (26.11)
      expect(live.sent.at(-1)).toBe(CUES.openingNotHeard);
      agent.end();
    });

    it("earbuds: a quiet voice before the opening (echo, people around) doesn't count as the callee talking", async () => {
      const { agent, rtp, lines } = await setup();
      const quiet = new Int16Array(160).fill(Math.round(0.03 * 32768)); // over the plain level, under 0.04
      for (let i = 0; i < 85; i++) {
        rtp.emit("audio", quiet);
        await wait(5);
      }
      expect(lines.some((l) => l.includes("opening made while ringing not played"))).toBe(false);
      agent.end();
    });

    it("only a Hebrew opening is played (it once answered in English)", () => {
      expect(isHebrewOpening(OPENING)).toBe(true);
      expect(isHebrewOpening("OK, I'm ready.")).toBe(false);
      expect(isHebrewOpening("בסדר")).toBe(false);
    });
  });

  it("a warm-up that calls a tool: refused, never played - the opening cue as before", async () => {
    const live = new FakeLive();
    const calls: string[] = [];
    const agent = new CallAgent({ live, tools: { callTool: async (n: string) => (calls.push(n), { ok: true }) }, openAfterSilenceMs: 2500 });
    const warmed = agent.warmUp();
    expect(live.sent).toEqual([CUES.warmUp]);
    // its reply: audio, words and even a tool call - all dropped
    live.emit("audio", Buffer.alloc(4800, 1));
    live.emit("outputTranscript", "אוקיי");
    live.emit("toolCall", [{ id: "w1", name: "get_day_info", args: { day_id: "x" } }]);
    await wait(10);
    expect(agent.queued).toBe(0);
    expect(calls).toEqual([]); // the tools server never hears of it
    expect(JSON.parse((live.toolResponses[0] as { response: { output: string } }).response.output)).toMatchObject({ ok: false, error: "not_started" });
    live.emit("turnComplete");
    expect(await warmed).toMatchObject({ said: "אוקיי" }); // logged, to check its language
    expect(CUES.warmUp).toContain("בעברית");
    expect(agent.turnText).toBe("");
    expect(agent.answeredSinceLead).toBe(false);
    // the call is up: the next answer plays as usual
    agent.start(new FakeRtp());
    live.emit("audio", Buffer.alloc(4800, 1));
    expect(agent.queued).toBeGreaterThan(0);
    agent.end();
  });

  it("warm-up: the callee answering and speaking ends it (interrupted)", async () => {
    const live = new FakeLive();
    const agent = new CallAgent({ live, tools: { callTool: async () => ({ ok: true }) }, openAfterSilenceMs: 2500 });
    const warmed = agent.warmUp();
    agent.start(new FakeRtp());
    live.emit("interrupted");
    expect(await warmed).toMatchObject({ said: "" });
    live.emit("audio", Buffer.alloc(4800, 1)); // the answer to "הלו"
    expect(agent.queued).toBeGreaterThan(0);
    expect(await agent.warmUp()).toBeNull(); // the call is up: no second warm-up
    agent.end();
  });

  it("the bot opens after 1.3 s of silence by default (about 2 s with the bot starting to speak)", async () => {
    // @ts-expect-error plain JS module
    const { phoneEnv } = await import("../src/line.js");
    expect(phoneEnv({}, ROOT).openAfterSilenceMs).toBe(1300);
    expect(phoneEnv({ OPEN_AFTER_SILENCE_S: "3" }, ROOT).openAfterSilenceMs).toBe(3000);
  });

  describe("a \"הלו\" right at pick-up", () => {
    const hello = (rtp: FakeRtp) => {
      const voice = new Int16Array(160).fill(3000);
      for (let i = 0; i < 20; i++) rtp.emit("audio", voice); // 0.4 s of "הלו"
    };

    it("Gemini missed it (no transcript, no answer): the opening cue 0.8 s after the caller stopped", async () => {
      const live = new FakeLive();
      const agent = new CallAgent({ live, tools: { callTool: async () => ({ ok: true }) }, openAfterSilenceMs: 2500 });
      const rtp = new FakeRtp();
      agent.start(rtp);
      hello(rtp);
      await wait(500);
      expect(live.sent).toEqual([]);
      await wait(600);
      expect(live.sent).toEqual([CUES.open]);
      await wait(300);
      expect(live.sent).toEqual([CUES.open]); // once
      agent.end();
    });

    it("Gemini heard it: no cue, it answers by itself", async () => {
      const live = new FakeLive();
      const agent = new CallAgent({ live, tools: { callTool: async () => ({ ok: true }) }, openAfterSilenceMs: 2500 });
      const rtp = new FakeRtp();
      agent.start(rtp);
      hello(rtp);
      live.emit("inputTranscript", "הלו");
      await wait(2000); // even a slow answer
      expect(live.sent).toEqual([]);
      agent.end();
    });

    it("mid-call the opening is never cued, even when the bot doesn't answer", async () => {
      const live = new FakeLive();
      const agent = new CallAgent({ live, tools: { callTool: async () => ({ ok: true }) }, openAfterSilenceMs: 2500 });
      const rtp = new FakeRtp();
      agent.start(rtp);
      live.emit("audio", Buffer.alloc(4800, 1)); // the bot already spoke (the opening)
      live.emit("turnComplete");
      while (rtp.nextFrame());
      await wait(100);
      hello(rtp); // the caller answers, Gemini misses it
      await wait(2000);
      expect(live.sent).not.toContain(CUES.open);
      agent.end();
    });
  });

  describe("the caller cuts in by talking", () => {
    const voice = new Int16Array(160).fill(3000);
    const quiet = new Int16Array(160);
    // 20 ms frames at line pace: the cut-in is measured in real time
    const frames = async (rtp: FakeRtp, f: Int16Array, ms: number) => {
      const end = performance.now() + ms;
      while (performance.now() < end) {
        rtp.emit("audio", f);
        await wait(20);
      }
    };
    const talk = (rtp: FakeRtp, ms: number) => frames(rtp, voice, ms);
    const pause = (rtp: FakeRtp, ms: number) => frames(rtp, quiet, ms);
    const longAnswer = () => Buffer.alloc(24000 * 3 * 2, 1); // 3 s of the bot, at 24 kHz

    it("Gemini already sent the whole answer: the bot stops at once (no 'interrupted' comes)", async () => {
      const live = new FakeLive();
      const agent = new CallAgent({ live, tools: { callTool: async () => ({ ok: true }) }, openAfterSilenceMs: 0 });
      const rtp = new FakeRtp();
      agent.start(rtp);
      live.emit("audio", longAnswer());
      live.emit("turnComplete");
      rtp.nextFrame();
      expect(agent.queued).toBeGreaterThan(0);
      await talk(rtp, 700);
      expect(agent.queued).toBe(0);
      agent.end();
    });

    it("Gemini still sending: the rest of that answer is dropped, the next one plays", async () => {
      const live = new FakeLive();
      const agent = new CallAgent({ live, tools: { callTool: async () => ({ ok: true }) }, openAfterSilenceMs: 0 });
      const rtp = new FakeRtp();
      agent.start(rtp);
      live.emit("audio", longAnswer());
      rtp.nextFrame();
      await talk(rtp, 700);
      expect(agent.queued).toBe(0);
      live.emit("audio", longAnswer()); // more of the cut answer
      expect(agent.queued).toBe(0);
      live.emit("turnComplete"); // its end
      live.emit("audio", Buffer.alloc(4800, 1)); // the answer to what the caller said
      expect(agent.queued).toBeGreaterThan(0);
      agent.end();
    });

    it("a cut-in sends Gemini nothing (it read the note out loud, 26.11); the log shows what the caller heard", async () => {
      const live = new FakeLive();
      const agent = new CallAgent({ live, tools: { callTool: async () => ({ ok: true }) }, openAfterSilenceMs: 0 });
      const rtp = new FakeRtp();
      agent.start(rtp);
      const lines: { who: string; text: string }[] = [];
      agent.on("line", (l: { who: string; text: string }) => lines.push(l));
      const text = "היום עיון במלון הוא ב-21 בנובמבר, מתשע בבוקר עד ארבע. המחיר 790 שקלים. לשלוח לך קישור להרשמה?";
      live.emit("outputTranscript", text);
      live.emit("audio", Buffer.alloc(24000 * 6 * 2, 1)); // 6 s
      live.emit("turnComplete");
      for (let i = 0; i < 100; i++) rtp.nextFrame(); // 2 s of it played
      await talk(rtp, 700);
      expect(agent.queued).toBe(0);
      expect(live.sent.filter((t) => t.includes("קטע"))).toEqual([]); // no cut-in note: the bot just answers the caller
      expect(lines.some((l) => l.who === "note" && l.text.startsWith("the caller heard only: «היום עיון במלון"))).toBe(true); // the log too
      agent.end();
    });

    it("cut with nothing known or nothing heard (the opening made while ringing): no note - the bot answers the caller", async () => {
      const live = new FakeLive();
      const agent = new CallAgent({ live, tools: { callTool: async () => ({ ok: true }) }, openAfterSilenceMs: 0 });
      const rtp = new FakeRtp();
      agent.start(rtp);
      live.sent.length = 0;
      live.emit("audio", longAnswer()); // no transcript for it (as the opening): what was heard is unknown
      live.emit("turnComplete");
      rtp.nextFrame();
      await talk(rtp, 700);
      expect(agent.queued).toBe(0); // cut
      expect(live.sent).toEqual([]); // no "he heard nothing" - that restarted the opening again and again
      agent.end();
    });

    it("only a voice about as loud as the caller's own cuts in (Bluetooth echo, people around: 26.11)", async () => {
      const live = new FakeLive();
      const agent = new CallAgent({ live, tools: { callTool: async () => ({ ok: true }) }, openAfterSilenceMs: 60_000 });
      const rtp = new FakeRtp();
      agent.start(rtp);
      const lines: string[] = [];
      agent.on("line", (l: { text: string }) => lines.push(l.text));
      const at = (rms: number) => new Int16Array(160).fill(Math.round(rms * 32768));
      await frames(rtp, at(0.1), 800); // the caller answers, the bot silent: their level is 0.1
      expect(agent.callerLevel()).toBeCloseTo(0.1, 2);
      live.emit("audio", longAnswer());
      live.emit("turnComplete");
      rtp.nextFrame();
      await frames(rtp, at(0.035), 900); // a quieter voice (echo / someone near): over 0.02, under half of 0.1
      expect(agent.queued).toBeGreaterThan(0); // the bot goes on
      await frames(rtp, at(0.09), 700); // the caller themself
      expect(agent.queued).toBe(0);
      expect(lines.some((t) => /bot stopped/.test(t) && /caller 0\.10/.test(t))).toBe(true); // the levels are in the log
      agent.end();
    });

    it("before the caller's level is known (the opening): a voice must be twice the plain talking level", async () => {
      const live = new FakeLive();
      const agent = new CallAgent({ live, tools: { callTool: async () => ({ ok: true }) }, openAfterSilenceMs: 60_000 });
      const rtp = new FakeRtp();
      agent.start(rtp);
      const at = (rms: number) => new Int16Array(160).fill(Math.round(rms * 32768));
      live.emit("audio", longAnswer());
      live.emit("turnComplete");
      rtp.nextFrame();
      await frames(rtp, at(0.03), 900);
      expect(agent.queued).toBeGreaterThan(0);
      await frames(rtp, at(0.06), 700);
      expect(agent.queued).toBe(0);
      agent.end();
    });

    it("heardPart: the share of the text that was played, cut at a word", () => {
      expect(heardPart("אחת שתיים שלוש ארבע", 60, 100)).toBe("אחת שתיים…"); // a half-said word is left out
      expect(heardPart("אחת שתיים", 99, 100)).toBe("אחת שתיים");
      expect(heardPart("אחת שתיים", 0, 100)).toBe("");
    });

    it("a short word (\"כן\") doesn't cut the bot; words with short pauses between them do", async () => {
      const live = new FakeLive();
      const agent = new CallAgent({ live, tools: { callTool: async () => ({ ok: true }) }, openAfterSilenceMs: 0 });
      const rtp = new FakeRtp();
      agent.start(rtp);
      live.emit("audio", longAnswer());
      live.emit("turnComplete");
      rtp.nextFrame();
      await talk(rtp, 300); // "כן"
      expect(agent.queued).toBeGreaterThan(0);
      await pause(rtp, 1000);
      await talk(rtp, 300); // "רגע"
      await pause(rtp, 300);
      await talk(rtp, 300); // "רגע"
      expect(agent.queued).toBe(0);
      agent.end();
    });
  });

  describe("street noise (the noise filter, RNNoise)", () => {
    // a person talking (synthetic speech, 8 kHz) and car-like rumble (brown noise), as 20 ms frames
    const pcm = readFileSync(join(__dirname, "fixtures", "speech-8k.pcm"));
    const speech = new Int16Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.length - (pcm.length % 2)));
    const rumble = (ms: number, amp = 1200) => {
      let b = 0;
      return Int16Array.from({ length: (8000 * ms) / 1000 }, () => (b = (b + (Math.random() * 2 - 1) * amp) * 0.995));
    };
    const play = async (rtp: FakeRtp, audio: Int16Array, ms: number) => {
      for (let i = 0; i * 160 < (8000 * ms) / 1000 && (i + 1) * 160 <= audio.length; i++) {
        rtp.emit("audio", audio.subarray(i * 160, (i + 1) * 160));
        await wait(20);
      }
    };
    const rms = (a: Int16Array) => Math.sqrt(a.reduce((e, x) => e + (x / 32768) ** 2, 0) / a.length);
    const longAnswer = () => Buffer.alloc(24000 * 4 * 2, 1); // 4 s of the bot, at 24 kHz

    it("tells a person from noise, and takes the noise out", async () => {
      const d = await createDenoiser();
      const frames = (a: Int16Array) => Array.from({ length: Math.floor(a.length / 160) }, (_, i) => d.process(a.subarray(i * 160, (i + 1) * 160)));
      const noise = rumble(3000);
      expect(rms(noise)).toBeGreaterThan(0.02); // loud: by volume alone this is "talking"
      const n = frames(noise).slice(50); // after it learned the noise (1 s)
      expect(Math.max(...n.map((f) => f.vad))).toBeLessThan(0.5);
      expect(rms(Int16Array.from(n.flatMap((f) => [...f.samples])))).toBeLessThan(rms(noise) / 4);
      const s = frames(speech);
      expect(s.filter((f) => f.vad >= 0.5).length / s.length).toBeGreaterThan(0.4); // speech with its pauses
      d.destroy();
    });

    it("loud street noise over the bot doesn't stop it; a person talking does", async () => {
      const live = new FakeLive();
      const agent = new CallAgent({
        live, tools: { callTool: async () => ({ ok: true }) }, openAfterSilenceMs: 0, denoiser: await createDenoiser(),
      });
      const rtp = new FakeRtp();
      agent.start(rtp);
      live.emit("audio", longAnswer());
      live.emit("turnComplete");
      rtp.nextFrame();
      await play(rtp, rumble(1500), 1500);
      expect(agent.queued).toBeGreaterThan(0); // the bot goes on
      await play(rtp, speech, 1500);
      expect(agent.queued).toBe(0); // the caller cut in
      agent.end();
    });

    it("the bot's own voice coming back faint on the line (echo) doesn't stop it, with the filter too", async () => {
      const live = new FakeLive();
      const agent = new CallAgent({
        live, tools: { callTool: async () => ({ ok: true }) }, openAfterSilenceMs: 0, denoiser: await createDenoiser(),
      });
      const rtp = new FakeRtp();
      agent.start(rtp);
      live.emit("audio", longAnswer());
      live.emit("turnComplete");
      rtp.nextFrame();
      const k = 0.012 / rms(speech); // a voice, but at echo level (below the caller-talking level)
      await play(rtp, Int16Array.from(speech, (x) => x * k), 1500);
      expect(agent.queued).toBeGreaterThan(0);
      agent.end();
    });

    it("without the filter (PHONE_DENOISE=0) the same noise stopped the bot", async () => {
      const live = new FakeLive();
      const agent = new CallAgent({ live, tools: { callTool: async () => ({ ok: true }) }, openAfterSilenceMs: 0 });
      const rtp = new FakeRtp();
      agent.start(rtp);
      live.emit("audio", longAnswer());
      live.emit("turnComplete");
      rtp.nextFrame();
      await play(rtp, rumble(1500), 1500);
      expect(agent.queued).toBe(0);
      agent.end();
    });
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

describe("phone line: ring timeout", () => {
  it("an unanswered call is cancelled after ringTimeoutMs and ends like a no-answer", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    // @ts-expect-error plain JS module
    const { PhoneLine } = await import("../src/line.js");
    const line = new PhoneLine({ root: ROOT, env: { logDir: mkdtempSync(join(tmpdir(), "phone-")), number: "" } });
    // a SIP call that rings until it is cancelled (hangup on a ringing outgoing call = CANCEL -> 487)
    const sip = Object.assign(new EventEmitter(), { hangups: 0, answered: null as unknown as Promise<unknown>, hangup: async () => {} });
    let reject!: (e: Error) => void;
    sip.answered = new Promise((_, r) => (reject = r));
    sip.answered.catch(() => {});
    sip.hangup = async () => {
      sip.hangups++;
      reject(new Error("487 Request Terminated"));
    };
    line.registered = true;
    line.ua = { publicIp: "127.0.0.1", invite: () => sip };
    line._prepare = async (callId: string) => ({ callId, agent: { connect: async () => {}, end: () => {} }, scenario: null });

    const ended = new Promise<{ call_id: string; reason: string }>((r) => line.once("ended", r));
    const started = Date.now();
    const { call_id } = await line.dial("050-1234567", { ringTimeoutMs: 60 });
    expect(line.numberFor(call_id)).toBe("+972501234567");
    expect(line.numberFor("another-call")).toBeNull();
    const e = await ended;
    expect(e).toEqual({ call_id, reason: "no answer (0s)" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    expect(sip.hangups).toBe(1);
    expect(line.call).toBeNull();
    expect(line.numberFor(call_id)).toBeNull();
    expect(line.recent.map((l: { text: string }) => l.text)).toContain("no answer after 0s: cancelling");
  });
});
