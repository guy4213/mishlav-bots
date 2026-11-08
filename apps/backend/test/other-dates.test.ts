import { describe, expect, it } from "vitest";
import type { KnowledgeBase, StudyDay } from "../src/knowledge";
import { otherDates } from "../src/tools/handlers";

const day = (id: string, format: StudyDay["format"], date: string, series = "year-end", open = true): StudyDay => ({
  id, title: id, topic: "t", date, start: "09:00", end: "14:00", format, location: "x",
  price_ils: format === "zoom" ? 370 : 790, vat_included: true, open_for_registration: open, series, description: "",
});

const kb = (...days: StudyDay[]): KnowledgeBase => ({ days: new Map(days.map((d) => [d.id, d])), general: "" });
const NOW = new Date("2026-11-08T10:00:00Z");

describe("get_day_info: other dates", () => {
  it("other date = same series and same format; other topics are never offered as one", () => {
    const hotel = day("h1", "hotel", "2026-12-22");
    const r = otherDates(hotel, kb(hotel, day("z-other-topic", "zoom", "2026-12-08", "labor-law")), NOW);
    expect(r.other_dates_same_format).toEqual([]);
    expect(r.same_content_other_format).toEqual([]);
  });

  it("lists upcoming open dates of the same day, and the same content in the other format separately", () => {
    const hotel = day("h1", "hotel", "2026-12-22");
    const r = otherDates(
      hotel,
      kb(
        hotel,
        day("h2", "hotel", "2027-02-16"),
        day("h-past", "hotel", "2026-10-01"),
        day("h-closed", "hotel", "2027-03-01", "year-end", false),
        day("z1", "zoom", "2027-01-05"),
      ),
      NOW,
    );
    expect(r.other_dates_same_format.map((d) => d.day_id)).toEqual(["h2"]);
    expect(r.same_content_other_format.map((d) => d.day_id)).toEqual(["z1"]);
  });
});
