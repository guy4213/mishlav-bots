import { describe, expect, it } from "vitest";
import { needsSummary, notesForBot, type NotesSummarizer, splitNotes, summarizeIfLong, summaryText } from "../src/notes";

const bot = (i: number, text = "ביקש שנחזור אליו מחר בעשר בבוקר, התעניין ביום העיון של מרץ בזום") => `[הערת הבוט] ${i}.11.2026 10:00 – ${text}`;
const REP = "מתעניינת בביטוח לאומי ופנסיה, רק בזום.";

describe("the notes the bot reads (Guy, 26.11: the reps' notes are never touched; Gold is only added to)", () => {
  it("the reps' notes, the latest summary, and the bot's lines after it", () => {
    const notes = [REP, bot(1), bot(2), "[סיכום הבוט] 3.11.2026 – ✓ רוצה מרץ בזום", bot(4, "נשלח קישור"), "נציגה: תתקשרו אחרי החג"].join("\n");
    expect(splitNotes(notes)).toEqual({
      rep: [REP, "נציגה: תתקשרו אחרי החג"],
      summary: "[סיכום הבוט] 3.11.2026 – ✓ רוצה מרץ בזום",
      botSince: [bot(4, "נשלח קישור")],
    });
    expect(notesForBot(notes)).toBe(`${REP} | נציגה: תתקשרו אחרי החג | [סיכום הבוט] 3.11.2026 – ✓ רוצה מרץ בזום | ${bot(4, "נשלח קישור")}`);
    expect(notesForBot(null)).toBeUndefined();
  });

  it("the reps' notes always reach the bot, however many lines the bot wrote", () => {
    const notes = [REP, ...Array.from({ length: 40 }, (_, i) => bot(i))].join("\n");
    const forBot = notesForBot(notes)!;
    expect(forBot.startsWith(REP)).toBe(true); // the old way (the last 600 characters) lost it
    expect(forBot.length).toBeLessThan(1400); // the bot's own lines stay bounded
    expect(forBot.endsWith(bot(39))).toBe(true); // the newest stays
  });

  it("a summary is needed only when the bot's lines since the last one pass the limit", () => {
    expect(needsSummary([REP, bot(1)].join("\n"))).toBe(false);
    expect(needsSummary([REP, ...Array.from({ length: 10 }, (_, i) => bot(i))].join("\n"))).toBe(true);
    expect(needsSummary([...Array.from({ length: 10 }, (_, i) => bot(i)), "[סיכום הבוט] – ✓ x", bot(20)].join("\n"))).toBe(false);
    expect(needsSummary(["x".repeat(5000)].join("\n"))).toBe(false); // a rep's long note is never summed up
  });

  it("the summary is one line of checklist items", () => {
    expect(summaryText(["✓ רוצה מרץ בזום", "נשלח קישור\nלמרץ", "  ", "- ביקש שיחה חוזרת"])).toBe("✓ רוצה מרץ בזום · ✓ נשלח קישור למרץ · ✓ ביקש שיחה חוזרת");
  });
});

describe("summarizeIfLong: at the end of a call, a summary line is ADDED - nothing is deleted", () => {
  const store = (notes: string) => {
    const added: string[] = [];
    return {
      added,
      get: async () => ({ notes }),
      appendBotSummary: async (_id: string, text: string) => void added.push(text),
    };
  };

  it("long: sums up the last summary and the bot's lines since - never the reps' notes", async () => {
    const lines = Array.from({ length: 10 }, (_, i) => bot(i));
    const s = store([REP, "[סיכום הבוט] – ✓ ישן", ...lines].join("\n"));
    const asked: Parameters<NotesSummarizer>[0][] = [];
    const summarize: NotesSummarizer = async (input) => (asked.push(input), ["רוצה מרץ בזום", "ביקש שיחה חוזרת"]);
    expect(await summarizeIfLong(s, "G1", summarize)).toBe("✓ רוצה מרץ בזום · ✓ ביקש שיחה חוזרת");
    expect(asked).toEqual([{ summary: "[סיכום הבוט] – ✓ ישן", lines }]);
    expect(asked[0]!.lines.join()).not.toContain(REP);
    expect(s.added).toEqual(["✓ רוצה מרץ בזום · ✓ ביקש שיחה חוזרת"]);
  });

  it("short: nothing is asked and nothing is added", async () => {
    const s = store([REP, bot(1)].join("\n"));
    let asked = false;
    expect(await summarizeIfLong(s, "G1", async () => ((asked = true), ["x"]))).toBeNull();
    expect(asked).toBe(false);
    expect(s.added).toEqual([]);
  });
});
