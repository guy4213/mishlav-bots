import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findRepoRoot, formatLocalIso, fromLocal, loadSettings, noAnswerRetryTimes } from "../src";

// the real settings: business hours, holidays, half days and the retry list as they are in config/settings.yaml
const settings = loadSettings(join(findRepoRoot(__dirname), "config", "settings.yaml"));
const bh = settings.business_hours;
const TZ = bh.timezone;
const local = (y: number, m: number, d: number, h: number, mi = 0) => fromLocal(y, m, d, h, mi, TZ);
const retries = (failedAt: Date) => noAnswerRetryTimes(failedAt, bh, settings.dialing).map((t) => formatLocalIso(t, TZ));

describe("no-answer retry schedule (streak 1, 2, 3)", () => {
  it("settings: 5 h the same day, then next business day, then two business days, other half", () => {
    expect(settings.dialing.no_answer_retry).toEqual([{ after_hours: 5 }, { business_days: 1 }, { business_days: 2 }]);
    expect(settings.dialing).toMatchObject({ no_answer_streak_max: 4, max_total_calls: 8, midday: "13:00" });
  });

  it("a morning failure: same day 5 h later, then the afternoons of the next business days", () => {
    expect(retries(local(2026, 11, 17, 10))).toEqual([ // Tuesday 10:00
      "2026-11-17T15:00:00+02:00",
      "2026-11-18T13:00:00+02:00",
      "2026-11-19T13:00:00+02:00",
    ]);
  });

  it("an afternoon failure: 5 h falls after closing -> next morning; then the mornings", () => {
    expect(retries(local(2026, 11, 17, 14))).toEqual([ // Tuesday 14:00 -> 19:00 is closed
      "2026-11-18T09:00:00+02:00",
      "2026-11-18T09:00:00+02:00",
      "2026-11-19T09:00:00+02:00",
    ]);
  });

  it("late in the day, and late in the morning (5 h lands on closing time)", () => {
    expect(retries(local(2026, 11, 17, 16, 30))[0]).toBe("2026-11-18T09:00:00+02:00");
    expect(retries(local(2026, 11, 17, 12, 1))).toEqual([ // still morning: 17:01 is closed
      "2026-11-18T09:00:00+02:00",
      "2026-11-18T13:00:00+02:00",
      "2026-11-19T13:00:00+02:00",
    ]);
  });

  it("Thursday -> Sunday (no Friday / Saturday)", () => {
    expect(retries(local(2026, 11, 19, 10))).toEqual([
      "2026-11-19T15:00:00+02:00",
      "2026-11-22T13:00:00+02:00",
      "2026-11-23T13:00:00+02:00",
    ]);
    expect(retries(local(2026, 11, 19, 15))).toEqual([
      "2026-11-22T09:00:00+02:00",
      "2026-11-22T09:00:00+02:00",
      "2026-11-23T09:00:00+02:00",
    ]);
  });

  it("before Pesach: the erev-chag half day has no afternoon, the holiday is skipped", () => {
    // Tue 20.4.2027 morning; Wed 21.4 closes at 13:00 (half day), Thu 22.4 is Pesach
    expect(retries(local(2027, 4, 20, 10))).toEqual([
      "2027-04-20T15:00:00+03:00",
      "2027-04-25T09:00:00+03:00", // the half day's afternoon -> the next business day's morning
      "2027-04-25T13:00:00+03:00", // 2 business days = Wed 21, Sun 25
    ]);
    // a failure on the half day itself: 16:00 is closed, Thursday is the holiday
    expect(retries(local(2027, 4, 21, 11))).toEqual([
      "2027-04-25T09:00:00+03:00",
      "2027-04-25T13:00:00+03:00",
      "2027-04-26T13:00:00+03:00",
    ]);
  });

  it("across the switch to summer time (Fri 26.3.2027)", () => {
    expect(retries(local(2027, 3, 25, 15))).toEqual([
      "2027-03-28T09:00:00+03:00",
      "2027-03-28T09:00:00+03:00",
      "2027-03-29T09:00:00+03:00",
    ]);
  });

  it("a call outside business hours (dialed by hand at night) -> the next opening", () => {
    expect(retries(local(2026, 11, 17, 21))[0]).toBe("2026-11-18T09:00:00+02:00");
  });
});
