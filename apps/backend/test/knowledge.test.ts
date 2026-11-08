import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findRepoRoot } from "@mishlav/shared";
import { describe, expect, it } from "vitest";
import { datesHe, loadKnowledge, parseDayFile } from "../src/knowledge";
import { redactText } from "../src/redact";

const root = findRepoRoot(__dirname);

describe("knowledge base", () => {
  const kb = loadKnowledge(join(root, "config", "knowledge"));

  it("loads the study days with the spec prices", () => {
    expect(kb.days.size).toBeGreaterThanOrEqual(2);
    for (const d of kb.days.values()) {
      expect(d.vat_included).toBe(true);
      expect(d.price_ils).toBe(d.format === "zoom" ? 370 : 790);
    }
  });

  it("zoom study days are a pair of days, hotel days are one day", () => {
    for (const d of kb.days.values()) {
      if (d.format === "zoom") expect(d.end_date && d.end_date > d.date, d.id).toBe(true);
      else expect(d.end_date, d.id).toBeUndefined();
    }
    const day = (extra: string) =>
      `---\nid: x\ntitle: t\ntopic: t\ndate: "2026-12-08"\n${extra}start: "09:00"\nend: "14:00"\nformat: zoom\nlocation: z\nprice_ils: 370\nvat_included: true\nopen_for_registration: true\n---\nbody`;
    expect(() => parseDayFile(day(""), "x.md")).toThrow(/end_date/);
    expect(parseDayFile(day('end_date: "2026-12-09"\n'), "x.md").end_date).toBe("2026-12-09");
  });

  it("formats single days and pairs in Hebrew", () => {
    expect(datesHe({ date: "2026-12-22" })).toBe("22.12.2026");
    expect(datesHe({ date: "2026-12-08", end_date: "2026-12-09" })).toBe("8–9.12.2026");
    expect(datesHe({ date: "2026-12-31", end_date: "2027-01-01" })).toBe("31.12.2026–1.1.2027");
  });

  it("prompt catalogue and knowledge days match exactly", () => {
    const prompt = readFileSync(join(root, "config", "prompt.md"), "utf8");
    const block = /<!-- day-catalog:start -->([\s\S]*?)<!-- day-catalog:end -->/.exec(prompt)?.[1] ?? "";
    const ids = [...block.matchAll(/`([a-z0-9-]+)`/g)].map((m) => m[1]).sort();
    expect(ids).toEqual([...kb.days.keys()].sort());
  });

  it("prompt keeps the provider-neutral variables", () => {
    const prompt = readFileSync(join(root, "config", "prompt.md"), "utf8");
    for (const v of ["first_name", "bot_name", "interested_day_id", "current_datetime", "customer_context"]) {
      expect(prompt).toContain(`{{${v}}}`);
    }
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
