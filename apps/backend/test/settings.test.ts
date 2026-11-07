import { join } from "node:path";
import { findRepoRoot, loadSettings } from "@mishlav/shared";
import { describe, expect, it } from "vitest";

/**
 * Guards config/settings.yaml holidays against the Hebrew calendar (Node's ICU), so a typo or a
 * missing year is caught by `npm test` instead of by a callback booked on Yom Kippur.
 */
const settings = loadSettings(join(findRepoRoot(__dirname), "config", "settings.yaml"));
const { holidays, half_days } = settings.business_hours;

const hebrew = new Intl.DateTimeFormat("en-u-ca-hebrew", { day: "numeric", month: "long", timeZone: "UTC" });
const DAY = 86_400_000;

function utc(ymd: string): Date {
  return new Date(`${ymd}T00:00:00Z`);
}
function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function hebrewKey(d: Date): string {
  const p = Object.fromEntries(hebrew.formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.month} ${p.day}`;
}

const YOM_TOV = new Set(["Nisan 15", "Nisan 21", "Sivan 6", "Tishri 1", "Tishri 2", "Tishri 10", "Tishri 15", "Tishri 22"]);

/** Yom HaAtzmaut: 5 Iyar, moved to Thu if it falls on Fri/Sat, to Tue if it falls on Mon. */
function isYomHaAtzmaut(d: Date): boolean {
  const key = hebrewKey(d);
  const wd = d.getUTCDay(); // 0 = Sun
  if (key === "Iyar 5") return wd !== 5 && wd !== 6 && wd !== 1;
  if (key === "Iyar 4" || key === "Iyar 3") {
    // the Thursday before a Fri/Sat 5 Iyar
    const fifth = new Date(d.getTime() + (key === "Iyar 4" ? 1 : 2) * DAY);
    return wd === 4 && (fifth.getUTCDay() === 5 || fifth.getUTCDay() === 6);
  }
  if (key === "Iyar 6") return wd === 2;
  return false;
}

function isHoliday(d: Date): boolean {
  return YOM_TOV.has(hebrewKey(d)) || isYomHaAtzmaut(d);
}

describe("settings.yaml holidays", () => {
  it("lists only real statutory holidays", () => {
    for (const h of holidays) expect(isHoliday(utc(h)), `${h} (${hebrewKey(utc(h))})`).toBe(true);
  });

  it("does not miss a weekday holiday in the covered range", () => {
    expect(holidays.length).toBeGreaterThan(0);
    const listed = new Set(holidays);
    // From today (or the first listed date) to the last listed date.
    const start = Math.min(Date.now(), utc([...holidays].sort()[0]!).getTime());
    const end = utc([...holidays].sort().at(-1)!).getTime();
    const missing: string[] = [];
    for (let t = start - (start % DAY); t <= end; t += DAY) {
      const d = new Date(t);
      const workday = d.getUTCDay() <= 4; // Sun–Thu
      if (workday && isHoliday(d) && !listed.has(ymd(d))) missing.push(`${ymd(d)} (${hebrewKey(d)})`);
    }
    expect(missing).toEqual([]);
  });

  it("covers at least the callback window ahead", () => {
    const last = utc([...holidays].sort().at(-1)!).getTime();
    expect(last - Date.now()).toBeGreaterThan(settings.callback.max_days_ahead * DAY);
  });

  it("half days are holiday eves", () => {
    for (const h of half_days) {
      const next = new Date(utc(h.date).getTime() + DAY);
      expect(isHoliday(next), `${h.date} is not an erev chag`).toBe(true);
    }
  });

  it("every weekday holiday eve has a half day", () => {
    const listed = new Set(half_days.map((h) => h.date));
    const missing = holidays
      .map((h) => new Date(utc(h).getTime() - DAY))
      .filter((eve) => eve.getUTCDay() <= 4 && !isHoliday(eve))
      // Yom HaZikaron (eve of Yom HaAtzmaut) is a working day, not a half day.
      .filter((eve) => !isYomHaAtzmaut(new Date(eve.getTime() + DAY)))
      .map(ymd)
      .filter((eve) => !listed.has(eve));
    expect(missing).toEqual([]);
  });
});
