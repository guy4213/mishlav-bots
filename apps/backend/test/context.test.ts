import { join } from "node:path";
import { findRepoRoot } from "@mishlav/shared";
import { describe, expect, it } from "vitest";
import { buildCallVariables, buildCustomerContext, currentDatetimeHe } from "../src/context";
import { recentNotes } from "../src/dial";
import { loadKnowledge, type KnowledgeBase, type StudyDay } from "../src/knowledge";
import { AUTH, FIXED_NOW, testServer } from "./helpers";

const kb = loadKnowledge(join(findRepoRoot(__dirname), "config", "knowledge"), join(findRepoRoot(__dirname), "tests", "fixtures", "days"));

describe("customer context (facts only)", () => {
  it("hotel day: format, only date, and the other topics with their format", () => {
    const text = buildCustomerContext(kb, "2027-05-17-hotel", FIXED_NOW);
    expect(text).toContain('"דיני עבודה ומס הכנסה" – יום פרונטלי במלון, 17.5.2027');
    expect(text).toContain("זה המועד היחיד של יום העיון הזה כרגע");
    expect(text).toContain("בקטלוג יש עוד 7 ימי עיון בנושאים אחרים: ");
    expect(text).toContain("ביטוח לאומי וביטוח פנסיוני (בזום, 17–18.3.2027)");
  });

  it("unknown day: one sentence over the catalogue", () => {
    const text = buildCustomerContext(kb, undefined, FIXED_NOW);
    expect(text).toMatch(/^לא ידוע באיזה יום עיון הלקוח התעניין\. בקטלוג 8 ימי עיון: /);
    expect(text).toContain("דיני עבודה ומס הכנסה – פרונטלי במלון, 17.5.2027");
    expect(text).toContain("דיני עבודה ומס הכנסה – עיון אחד בשני מפגשים בזום, 21–22.2.2027");
  });

  it("uses the series: other dates in the same format vs the same day in the other format", () => {
    const d = (id: string, format: StudyDay["format"], date: string, series: string): StudyDay => ({
      id, title: `נושא ${series}`, topic: "t", date, start: "09:00", end: "14:00", format, location: "x",
      price_ils: 1, vat_included: true, open_for_registration: true, series, lecturers: [], description: "",
    });
    const days = [d("h1", "hotel", "2026-12-22", "a"), d("h2", "hotel", "2027-02-16", "a"), d("z1", "zoom", "2027-01-05", "a")];
    const k: KnowledgeBase = { days: new Map(days.map((x) => [x.id, x])), general: "" };
    const text = buildCustomerContext(k, "h1", FIXED_NOW);
    expect(text).toContain("ליום העיון הזה יש מועדים נוספים במלון: 16.2.2027");
    expect(text).toContain("אותו יום עיון מתקיים גם בזום ב-5.1.2027");
    expect(text).not.toContain("בקטלוג יש עוד");
  });

  it("formats the current time like the voice worker", () => {
    expect(currentDatetimeHe(FIXED_NOW)).toBe("יום ראשון, 8 בנובמבר 2026, 10:00");
  });
});

describe("GET /test/context", () => {
  it("returns the prompt variables from a scenario's context block", async () => {
    const { app } = await testServer();
    const r = await app.inject({ method: "GET", url: "/test/context?scenario=S1", headers: AUTH });
    expect(r.statusCode).toBe(200);
    const { variables } = r.json();
    expect(Object.keys(variables).sort()).toEqual(["bot_name", "current_datetime", "customer_context", "customer_gender", "day_catalog", "first_name", "interested_day_id"]);
    expect(variables).toMatchObject({ first_name: "דנה", bot_name: "נועה", interested_day_id: "2027-05-17-hotel" });
    expect(variables.customer_context).toContain("יום פרונטלי במלון");
  });

  it("defaults without a scenario, query overrides, unknown scenario 404, needs the secret", async () => {
    const { app } = await testServer();
    const plain = (await app.inject({ method: "GET", url: "/test/context", headers: AUTH })).json().variables;
    expect(plain).toMatchObject({ first_name: "דנה", interested_day_id: "לא ידוע" });
    expect(plain.customer_context).toMatch(/^לא ידוע אם דנה גבר או אישה\. לא ידוע באיזה יום עיון/);

    const over = await app.inject({ method: "GET", url: "/test/context?scenario=S1&first_name=רון&day_id=2027-03-17-zoom", headers: AUTH });
    expect(over.json().variables).toMatchObject({ first_name: "רון", interested_day_id: "2027-03-17-zoom" });

    expect((await app.inject({ method: "GET", url: "/test/context?scenario=NOPE", headers: AUTH })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/test/context" })).statusCode).toBe(401);
  });
});

describe("a follow-up call: the contact's notes reach the bot", () => {
  it("the latest whole lines of the Gold notes, at most ~600 characters", () => {
    expect(recentNotes(null)).toBeUndefined();
    expect(recentNotes("שורה ראשונה\n\n[הערת הבוט] ביקש הנחה · מוכן לשלם 590")).toBe("שורה ראשונה | [הערת הבוט] ביקש הנחה · מוכן לשלם 590");
    const many = Array.from({ length: 40 }, (_, i) => `[הערת הבוט] שיחה מספר ${i} – ביקש שנחזור אליו`).join("\n");
    const kept = recentNotes(many)!;
    expect(kept.length).toBeLessThanOrEqual(650);
    expect(kept.endsWith("שיחה מספר 39 – ביקש שנחזור אליו")).toBe(true); // the newest stays
  });

  it("they end customer_context; without notes nothing is added", () => {
    const kb = loadKnowledge(join(findRepoRoot(__dirname), "config", "knowledge"), join(findRepoRoot(__dirname), "tests", "fixtures", "days"));
    const v = buildCallVariables(kb, { first_name: "גיא", gender: "male", notes: "ביקש הנחה · מוכן לשלם 590" }, FIXED_NOW);
    expect(v.customer_context.endsWith("הערות על הלקוח מהשיחות הקודמות (מגולד, האחרונה בסוף): ביקש הנחה · מוכן לשלם 590")).toBe(true);
    expect(buildCallVariables(kb, { first_name: "גיא" }, FIXED_NOW).customer_context).not.toContain("הערות");
  });
});
