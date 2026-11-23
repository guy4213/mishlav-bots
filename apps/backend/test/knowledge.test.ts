import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findRepoRoot } from "@mishlav/shared";
import { describe, expect, it } from "vitest";
import { buildDayCatalog } from "../src/context";
import { datesHe, type KnowledgeBase, loadKnowledge, newDayId, parseDayFile, StudyDayInput } from "../src/knowledge";
import { redactText } from "../src/redact";
import { FIXED_NOW } from "./helpers";

const root = findRepoRoot(__dirname);

describe("knowledge base", () => {
  const kb = loadKnowledge(join(root, "config", "knowledge"), join(root, "tests", "fixtures", "days"));

  it("the fixed days are the yellow page 2027: 6 on Zoom, 2 at the hotel, its prices and hours", () => {
    const days = [...kb.days.values()];
    expect(days.map((d) => d.id).sort()).toEqual([
      "2027-02-21-zoom",
      "2027-03-17-zoom",
      "2027-05-17-hotel",
      "2027-06-21-zoom",
      "2027-07-20-zoom",
      "2027-09-21-zoom",
      "2027-11-21-hotel",
      "2027-12-20-zoom",
    ]);
    for (const d of days) {
      expect(d.vat_included).toBe(true);
      expect(d.price_ils).toBe(d.format === "zoom" ? 370 : 790);
      expect([d.start, d.end]).toEqual(d.format === "zoom" ? ["10:00", "13:15"] : ["09:00", "16:00"]);
      expect(d.academic_hours).toBe(7.5);
      expect(d.lecturers.length).toBeGreaterThan(0);
      expect(d.id).toBe(newDayId(d));
    }
  });

  it("zoom study days are one day in two meetings, hotel days are one day", () => {
    for (const d of kb.days.values()) {
      if (d.format === "zoom") expect(d.end_date && d.end_date > d.date, d.id).toBe(true);
      else expect(d.end_date, d.id).toBeUndefined();
    }
    const day = (extra: string) =>
      `---\nid: x\ntitle: t\ntopic: t\ndate: "2026-12-08"\n${extra}start: "09:00"\nend: "14:00"\nformat: zoom\nlocation: z\nprice_ils: 370\nvat_included: true\nopen_for_registration: true\n---\nbody`;
    expect(() => parseDayFile(day(""), "x.md")).toThrow(/end_date/);
    expect(parseDayFile(day('end_date: "2026-12-09"\n'), "x.md").end_date).toBe("2026-12-09");
  });

  it("the dashboard's form: same rules, unknown fields rejected, the id from date + format", () => {
    const form = {
      title: "דיני עבודה",
      topic: "דיני עבודה",
      date: "2027-02-21",
      end_date: "2027-02-22",
      start: "10:00",
      end: "13:15",
      format: "zoom",
      location: "בזום",
      price_ils: 370,
      vat_included: true,
      open_for_registration: true,
      lecturers: ["מיקי בן דב"],
      academic_hours: 7.5,
    };
    const ok = StudyDayInput.parse(form);
    expect(ok.description).toBe("");
    expect(newDayId(ok)).toBe("2027-02-21-zoom");
    expect(StudyDayInput.safeParse({ ...form, end_date: undefined }).success).toBe(false); // zoom needs 2 meetings
    expect(StudyDayInput.safeParse({ ...form, format: "hotel" }).success).toBe(false); // hotel: one date
    expect(StudyDayInput.safeParse({ ...form, end: "09:00" }).success).toBe(false);
    expect(StudyDayInput.safeParse({ ...form, purchase_url: "http://x.co" }).success).toBe(false); // https only
    expect(StudyDayInput.safeParse({ ...form, id: "x" }).success).toBe(false);
  });

  it("formats single days and pairs in Hebrew", () => {
    expect(datesHe({ date: "2026-12-22" })).toBe("22.12.2026");
    expect(datesHe({ date: "2026-12-08", end_date: "2026-12-09" })).toBe("8–9.12.2026");
    expect(datesHe({ date: "2026-12-31", end_date: "2027-01-01" })).toBe("31.12.2026–1.1.2027");
  });

  it("the prompt's catalogue is built from the days: upcoming only, Zoom then the hotel, each by date, closed ones marked", () => {
    const catalog = buildDayCatalog(kb, FIXED_NOW).split("\n");
    expect(catalog).toHaveLength(10); // 2 headings + 8 days
    expect(catalog[0]).toBe("בזום – יום עיון אחד בשני מפגשים (הקרוב ראשון):");
    expect(catalog[1]).toBe("- `2027-02-21-zoom` – דיני עבודה ומס הכנסה · 21–22.2.2027 · 10:00–13:15 · 370 ₪ כולל מע\"מ");
    expect(catalog[2]).toContain("`2027-03-17-zoom`");
    expect(catalog[7]).toBe("במלון – יום מלא (הקרוב ראשון):");
    expect(catalog[8]).toBe("- `2027-05-17-hotel` – דיני עבודה ומס הכנסה · 17.5.2027 · 09:00–16:00 · מלון דן פנורמה, תל אביב · 790 ₪ כולל מע\"מ");
    expect(catalog[9]).toContain("`2027-11-21-hotel`");

    const first = kb.days.get("2027-02-21-zoom")!;
    const k: KnowledgeBase = {
      days: new Map([
        ["2027-02-21-zoom", { ...first, open_for_registration: false }],
        ["2026-01-01-zoom", { ...first, id: "2026-01-01-zoom", date: "2026-01-01", end_date: "2026-01-02" }],
      ]),
      general: "",
    };
    expect(buildDayCatalog(k, FIXED_NOW)).toBe(
      "בזום – יום עיון אחד בשני מפגשים (הקרוב ראשון):\n" +
        "- `2027-02-21-zoom` – דיני עבודה ומס הכנסה · 21–22.2.2027 · 10:00–13:15 · 370 ₪ כולל מע\"מ · ההרשמה סגורה",
    );
    expect(buildDayCatalog({ days: new Map(), general: "" }, FIXED_NOW)).toBe("אין כרגע ימי עיון בקטלוג.");
  });

  it("prompt keeps the provider-neutral variables, and no hand-written catalogue", () => {
    const prompt = readFileSync(join(root, "config", "prompt.md"), "utf8");
    for (const v of ["first_name", "bot_name", "interested_day_id", "current_datetime", "customer_context", "day_catalog"]) {
      expect(prompt).toContain(`{{${v}}}`);
    }
    expect(prompt).not.toMatch(/`20\d\d-\d\d-\d\d-(zoom|hotel)`/);
  });
});

describe("card redaction", () => {
  it("redacts 13-19 digit runs with or without separators", () => {
    expect(redactText("4580123456789012").count).toBe(1);
    expect(redactText("4580 1234 5678 9012").count).toBe(1);
    expect(redactText("4580-1234-5678-9012").count).toBe(1);
    expect(redactText("378282246310005").count).toBe(1); // 15-digit Amex
  });

  it("keeps phone numbers", () => {
    expect(redactText("0527384915").count).toBe(0);
    expect(redactText("052-738-4915").count).toBe(0);
    expect(redactText("+972527384915").count).toBe(0);
    expect(redactText("0521234567 0547654321").count).toBe(0);
  });
});
