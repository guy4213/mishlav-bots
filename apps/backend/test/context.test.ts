import { join } from "node:path";
import { findRepoRoot } from "@mishlav/shared";
import { describe, expect, it } from "vitest";
import { buildCustomerContext, currentDatetimeHe } from "../src/context";
import { loadKnowledge, type KnowledgeBase, type StudyDay } from "../src/knowledge";
import { AUTH, FIXED_NOW, testServer } from "./helpers";

const kb = loadKnowledge(join(findRepoRoot(__dirname), "config", "knowledge"));

describe("customer context (facts only)", () => {
  it("hotel day: format, only date, and the other topics with their format", () => {
    const text = buildCustomerContext(kb, "payroll-2026-12-22-hotel", FIXED_NOW);
    expect(text).toContain('"סגירת שנת מס בשכר" – יום פרונטלי במלון, 22.12.2026');
    expect(text).toContain("זה המועד היחיד של יום העיון הזה כרגע");
    expect(text).toContain("בקטלוג יש עוד שני ימי עיון בנושאים אחרים, שניהם בזום");
  });

  it("unknown day: one sentence over the catalogue", () => {
    const text = buildCustomerContext(kb, undefined, FIXED_NOW);
    expect(text).toMatch(/^לא ידוע באיזה יום עיון הלקוח התעניין\. בקטלוג 3 ימי עיון: /);
    expect(text).toContain("סגירת שנת מס בשכר – פרונטלי במלון, 22.12.2026");
  });

  it("uses the series: other dates in the same format vs the same day in the other format", () => {
    const d = (id: string, format: StudyDay["format"], date: string, series: string): StudyDay => ({
      id, title: `נושא ${series}`, topic: "t", date, start: "09:00", end: "14:00", format, location: "x",
      price_ils: 1, vat_included: true, open_for_registration: true, series, description: "",
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
    expect(Object.keys(variables).sort()).toEqual(["bot_name", "current_datetime", "customer_context", "first_name", "interested_day_id"]);
    expect(variables).toMatchObject({ first_name: "דנה", bot_name: "נועה", interested_day_id: "payroll-2026-12-22-hotel" });
    expect(variables.customer_context).toContain("יום פרונטלי במלון");
  });

  it("defaults without a scenario, query overrides, unknown scenario 404, needs the secret", async () => {
    const { app } = await testServer();
    const plain = (await app.inject({ method: "GET", url: "/test/context", headers: AUTH })).json().variables;
    expect(plain).toMatchObject({ first_name: "דנה", interested_day_id: "לא ידוע" });
    expect(plain.customer_context).toMatch(/^לא ידוע באיזה יום עיון/);

    const over = await app.inject({ method: "GET", url: "/test/context?scenario=S1&first_name=רון&day_id=payroll-2027-01-12-zoom", headers: AUTH });
    expect(over.json().variables).toMatchObject({ first_name: "רון", interested_day_id: "payroll-2027-01-12-zoom" });

    expect((await app.inject({ method: "GET", url: "/test/context?scenario=NOPE", headers: AUTH })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/test/context" })).statusCode).toBe(401);
  });
});
