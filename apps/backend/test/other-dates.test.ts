import { describe, expect, it } from "vitest";
import type { KnowledgeBase, StudyDay } from "../src/knowledge";
import { dayNoteHe, otherDates, toolHandlers } from "../src/tools/handlers";

const day = (id: string, format: StudyDay["format"], date: string, series = "year-end", open = true): StudyDay => ({
  id, title: id, topic: "t", date, start: "09:00", end: "14:00", format, location: "x",
  price_ils: format === "zoom" ? 370 : 790, vat_included: true, open_for_registration: open, series, lecturers: [], description: "",
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

describe("the chosen study day", () => {
  const zoom: StudyDay = { ...day("z1", "zoom", "2027-02-21"), end_date: "2027-02-22", start: "10:00", end: "13:15", title: "יום עיון דצמבר" };
  const ctx = { knowledge: kb(zoom), now: () => NOW } as never;

  it("a Zoom day is said as ONE study day in two meetings, with the hours of each", async () => {
    const r = (await toolHandlers.get_day_info({ day_id: "z1" }, ctx)) as unknown as { day: { structure_he: string } };
    expect(r.day.structure_he).toBe("יום עיון אחד שמתקיים בשני מפגשים (21–22.2.2027), מעשר בבוקר עד אחת ורבע בצהריים בכל מפגש. המחיר וההרשמה הם ליום העיון כולו.");
  });

  it("the note in Gold: title, dates, Zoom or in person, and the course number the reps register", () => {
    expect(dayNoteHe({ ...zoom, course_number: "4512" })).toBe("יום עיון דצמבר – 21–22.2.2027 · בזום · מספר קורס 4512");
    expect(dayNoteHe(day("h1", "hotel", "2026-12-22"))).toBe("h1 – 22.12.2026 · פרונטלי");
  });

  it("a hand-off to a rep carries the day the customer chose (an unknown id is left out)", async () => {
    const r = await toolHandlers.request_human({ reason: "pay_via_rep", asap: true, day_id: "z1" }, ctx);
    expect(r).toMatchObject({ ok: true, status: "handed_to_rep", day_he: "יום עיון דצמבר – 21–22.2.2027 · בזום" });
    const none = await toolHandlers.request_human({ reason: "pay_via_rep", asap: true, day_id: "nope" }, ctx);
    expect(none).not.toHaveProperty("day_he");
  });
});
